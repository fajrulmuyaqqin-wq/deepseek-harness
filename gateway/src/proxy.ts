/**
 * Upstream LLM Proxy untuk Boson Gateway.
 *
 * Mengalirkan (streaming) request OpenAI-compatible dari client Boson Studio ke upstream OpenRouter/LiteLLM.
 * Melakukan pre-flight balance check dan pasca-streaming token deduction.
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DoubleBucketLedger } from './ledger.ts'
import { PricingEngine } from './pricing.ts'

export interface ProxyConfig {
  upstreamBaseUrl: string // e.g. "https://openrouter.ai/api/v1" atau "http://127.0.0.1:4000/v1"
  upstreamApiKey: string
  defaultMarkupPercent?: number
}

export class LlmProxyHandler {
  private ledger: DoubleBucketLedger
  private pricing: PricingEngine
  private config: ProxyConfig

  constructor(ledger: DoubleBucketLedger, pricing: PricingEngine, config: ProxyConfig) {
    this.ledger = ledger
    this.pricing = pricing
    this.config = config
  }

  /**
   * Tangani request /v1/chat/completions.
   */
  public async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Ekstrak dan Verifikasi Virtual Key Tenant dari Header Authorization
    const authHeader = req.headers.authorization
    const tenantApiKey = authHeader?.replace(/^Bearer\s+/i, '').trim()

    if (!tenantApiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '401 Unauthorized: Authorization Bearer Key diperlukan.' }))
      return
    }

    const tenant = this.ledger.findTenantByApiKey(tenantApiKey)
    if (!tenant) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '401 Unauthorized: Virtual Key tidak terdaftar.' }))
      return
    }

    // 2. Pre-flight Balance Check
    const balance = this.ledger.getBalance(tenant.tenantId)
    if (!balance || balance.totalAvailableUsd <= 0.0005) {
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error:
            balance?.planType === 'subscription'
              ? '402 Payment Required: Kuota bulanan langganan Anda telah habis. Reset pada periode berikutnya.'
              : '402 Payment Required: Saldo deposit habis atau telah melewati masa aktif (hangus). Silakan top-up.',
          code: 'QUOTA_EXCEEDED',
          tenantId: tenant.tenantId,
          balance: balance,
        }),
      )
      return
    }

    // 3. Baca Body Request
    const rawBody = await this.readRequestBody(req)
    let bodyJson: any
    try {
      bodyJson = JSON.parse(rawBody)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }))
      return
    }

    const model = bodyJson.model ?? 'deepseek-v3'
    const isStream = bodyJson.stream ?? false

    // Pastikan upstream mengembalikan usage jika streaming (OpenRouter stream_options)
    if (isStream && !bodyJson.stream_options) {
      bodyJson.stream_options = { include_usage: true }
    }

    // 4. Forward ke Upstream (OpenRouter / LiteLLM) dengan Master Key yang Disimpan di Server
    const upstreamUrl = `${this.config.upstreamBaseUrl}/chat/completions`
    let upstreamRes: Response
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.upstreamApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://boson.studio',
          'X-Title': 'Boson Studio',
        },
        body: JSON.stringify(bodyJson),
      })
    } catch (err: any) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `502 Bad Gateway: Upstream gagal dihubungi (${err.message})` }))
      return
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
      res.end(errText)
      return
    }

    // 5. Streaming Response Handling
    if (isStream && upstreamRes.body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const reader = upstreamRes.body.getReader()
      const decoder = new TextDecoder()
      let promptTokens = 0
      let completionTokens = 0
      let actualCostReported: number | null = null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunkStr = decoder.decode(value, { stream: true })
          res.write(chunkStr)

          // Parse SSE lines untuk mendeteksi object usage
          const lines = chunkStr.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const parsed = JSON.parse(line.slice(6))
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens ?? promptTokens
                  completionTokens = parsed.usage.completion_tokens ?? completionTokens
                  if (typeof parsed.usage.cost === 'number') {
                    actualCostReported = parsed.usage.cost
                  }
                }
              } catch {
                // Abaikan parsing fragment tak lengkap
              }
            }
          }
        }
      } finally {
        res.end()

        // 6. Pasca-Streaming: Hitung dan Potong Saldo
        // Fallback perkiraan token jika upstream tidak mengirim usage chunk
        if (promptTokens === 0) promptTokens = 500
        if (completionTokens === 0) completionTokens = 150

        const actualCost =
          actualCostReported ??
          this.pricing.calculateActualCost(model, promptTokens, completionTokens)

        this.ledger.deduct(
          tenant.tenantId,
          model,
          promptTokens,
          completionTokens,
          actualCost,
          this.config.defaultMarkupPercent ?? 30,
        )
      }
    } else {
      // Non-streaming handling
      const responseData = await upstreamRes.json()
      const usage = responseData.usage ?? {}
      const promptTokens = usage.prompt_tokens ?? 500
      const completionTokens = usage.completion_tokens ?? 150
      const actualCost =
        usage.cost ?? this.pricing.calculateActualCost(model, promptTokens, completionTokens)

      this.ledger.deduct(
        tenant.tenantId,
        model,
        promptTokens,
        completionTokens,
        actualCost,
        this.config.defaultMarkupPercent ?? 30,
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseData))
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => resolve(body))
      req.on('error', err => reject(err))
    })
  }
}
