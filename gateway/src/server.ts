/**
 * Server Utama Boson Gateway (BFF + Double-Bucket Ledger).
 *
 * Mengontrol autentikasi, routing model, proteksi CORS, dan manajemen tenant.
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import process from 'node:process'
import { DoubleBucketLedger } from './ledger.ts'
import { PricingEngine } from './pricing.ts'
import { LlmProxyHandler } from './proxy.ts'

export interface ServerOptions {
  port?: number
  host?: string
  dbPath?: string
  upstreamBaseUrl?: string
  upstreamApiKey?: string
  masterKey?: string
  allowedOrigins?: string[]
}

export function createBosonGatewayServer(options: ServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '4000', 10)
  const host = options.host ?? '127.0.0.1'
  const masterKey = options.masterKey ?? process.env.LITELLM_MASTER_KEY ?? 'sk-boson-master-admin-key'
  const upstreamApiKey = options.upstreamApiKey ?? process.env.OPENROUTER_API_KEY ?? ''
  const upstreamBaseUrl = options.upstreamBaseUrl ?? process.env.UPSTREAM_BASE_URL ?? 'https://openrouter.ai/api/v1'
  const allowedOrigins = options.allowedOrigins ?? [
    'https://yourdomain.com',
    'https://app.yourdomain.com',
    'http://localhost:3080',
    'http://127.0.0.1:3080',
  ]

  const ledger = new DoubleBucketLedger(options.dbPath ?? './gateway.db')
  const pricing = new PricingEngine()
  const proxy = new LlmProxyHandler(ledger, pricing, {
    upstreamBaseUrl,
    upstreamApiKey,
    defaultMarkupPercent: 30,
  })

  function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin
    if (origin) {
      const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*')
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      } else {
        // Asal tak diizinkan
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '403 Forbidden: Origin domain tidak diizinkan.' }))
        return false
      }
    } else {
      // Request non-browser (Desktop / CLI / Internal)
      res.setHeader('Access-Control-Allow-Origin', '*')
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-model, x-title')
    return true
  }

  function verifyAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers.authorization
    const token = authHeader?.replace(/^Bearer\s+/i, '').trim()
    if (!token || token !== masterKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '401 Unauthorized: Master Key admin tidak valid.' }))
      return false
    }
    return true
  }

  async function parseJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => {
        data += chunk
      })
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    if (!setCorsHeaders(req, res)) return

    // Tangani preflight OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    try {
      // 0. Root API Info & Web Dashboard Handler
      if (pathname === '/' && req.method === 'GET') {
        const accept = req.headers.accept ?? ''
        if (accept.includes('text/html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boson Studio • API Gateway & Ledger</title>
  <style>
    :root {
      --bg: #090a0f;
      --card: #12141f;
      --border: #22263d;
      --accent: #6366f1;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --success: #10b981;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .container {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 36px;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      margin-bottom: 16px;
    }
    .badge .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      letter-spacing: -0.02em;
    }
    p {
      color: var(--muted);
      line-height: 1.6;
      margin: 0 0 24px 0;
      font-size: 14px;
    }
    .action-btn {
      display: inline-block;
      width: 100%;
      text-align: center;
      background: var(--accent);
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 24px;
      box-sizing: border-box;
      transition: opacity 0.2s;
    }
    .action-btn:hover {
      opacity: 0.9;
    }
    .endpoints {
      border-top: 1px solid var(--border);
      padding-top: 20px;
    }
    .endpoint-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      font-size: 13px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .endpoint-method {
      font-family: monospace;
      font-weight: 700;
      color: var(--accent);
    }
    .endpoint-path {
      font-family: monospace;
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <span class="dot"></span> Gateway Online (Port 4000)
    </div>
    <h1>Boson Studio API Gateway</h1>
    <p>Ini adalah layanan backend <b>LLM Proxy & Double-Bucket Ledger</b>. Aplikasi antarmuka pengguna (Web Studio) berjalan di port <b>3080</b>.</p>

    <a href="http://127.0.0.1:3080" class="action-btn">🚀 Buka Boson Studio Web App (Port 3080)</a>

    <div class="endpoints">
      <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 8px;">Daftar Endpoint API:</div>
      <div class="endpoint-row">
        <span class="endpoint-method">POST</span>
        <span class="endpoint-path">/v1/chat/completions</span>
      </div>
      <div class="endpoint-row">
        <span class="endpoint-method">GET</span>
        <span class="endpoint-path">/v1/models</span>
      </div>
      <div class="endpoint-row">
        <span class="endpoint-method">GET</span>
        <span class="endpoint-path">/api/tenant/balance</span>
      </div>
      <div class="endpoint-row">
        <span class="endpoint-method">GET</span>
        <span class="endpoint-path">/health</span>
      </div>
    </div>
  </div>
</body>
</html>`)
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            name: 'Boson Studio API Gateway',
            status: 'online',
            port: 4000,
            endpoints: {
              chat: '/v1/chat/completions',
              models: '/v1/models',
              balance: '/api/tenant/balance',
              health: '/health',
            },
            webAppUrl: 'http://127.0.0.1:3080',
          }),
        )
        return
      }

      if (pathname === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204)
        res.end()
        return
      }

      // 1. Health Check
      if (pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', service: 'boson-gateway', timestamp: new Date().toISOString() }))
        return
      }

      // 2. Chat Completions (LLM Proxy)
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        await proxy.handleChatCompletions(req, res)
        return
      }

      // 3. Models List
      if (pathname === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'deepseek-v3', object: 'model', owned_by: 'boson' },
              { id: 'deepseek-r1', object: 'model', owned_by: 'boson' },
              { id: 'claude-3-5-sonnet', object: 'model', owned_by: 'boson' },
              { id: 'gpt-4o', object: 'model', owned_by: 'boson' },
            ],
          }),
        )
        return
      }

      // 4. Cek Saldo Tenant Sendiri
      if (pathname === '/api/tenant/balance' && req.method === 'GET') {
        const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
        if (!auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Authorization header diperlukan' }))
          return
        }
        const tenant = ledger.findTenantByApiKey(auth)
        if (!tenant) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Tenant tidak ditemukan' }))
          return
        }
        const balance = ledger.getBalance(tenant.tenantId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', balance }))
        return
      }

      // 5. Admin: Daftarkan Langganan Bulanan
      if (pathname === '/api/admin/tenants/subscription' && req.method === 'POST') {
        if (!verifyAdminAuth(req, res)) return
        const body = await parseJsonBody(req)
        if (!body.tenantId || typeof body.monthlyQuotaUsd !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'tenantId dan monthlyQuotaUsd diperlukan' }))
          return
        }
        const tenant = ledger.setSubscription(body.tenantId, body.monthlyQuotaUsd, body.cycleDays ?? 30, body.apiKey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', tenant }))
        return
      }

      // 6. Admin: Tambah Saldo Deposit (Bisa dengan Masa Hangus)
      if (pathname === '/api/admin/tenants/deposit' && req.method === 'POST') {
        if (!verifyAdminAuth(req, res)) return
        const body = await parseJsonBody(req)
        if (!body.tenantId || typeof body.depositAmountUsd !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'tenantId dan depositAmountUsd diperlukan' }))
          return
        }
        const tenant = ledger.addDeposit(body.tenantId, body.depositAmountUsd, body.durationDays, body.apiKey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', tenant }))
        return
      }

      // 7. Admin: Daftar Seluruh Tenant
      if (pathname === '/api/admin/tenants' && req.method === 'GET') {
        if (!verifyAdminAuth(req, res)) return
        const tenants = ledger.listTenants()
        const balances = tenants.map(t => ledger.getBalance(t.tenantId))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', tenants: balances }))
        return
      }

      // 8. Admin: Audit Log Transaksi & Profit
      if (pathname === '/api/admin/audit-log' && req.method === 'GET') {
        if (!verifyAdminAuth(req, res)) return
        const tenantId = url.searchParams.get('tenantId') ?? undefined
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
        const txs = ledger.listTransactions(tenantId, limit)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'success', count: txs.length, transactions: txs }))
        return
      }

      // 404 Route Not Found
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }))
    } catch (e: any) {
      console.error('GATEWAY SERVER ERROR:', e)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Internal Server Error: ${e.message}` }))
    }
  })

  return {
    server,
    ledger,
    pricing,
    proxy,
    getPort: () => {
      const addr = server.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
    listen: () =>
      new Promise<void>(resolve => {
        server.listen(port, host, () => {
          const addr = server.address()
          const boundPort = typeof addr === 'object' && addr ? addr.port : port
          console.log(`🚀 Boson Gateway Server aktif di http://${host}:${boundPort}`)
          resolve()
        })
      }),
    close: () =>
      new Promise<void>(resolve => {
        ledger.close()
        if (typeof (server as any).closeAllConnections === 'function') {
          (server as any).closeAllConnections()
        }
        server.close(() => resolve())
      }),
  }
}

// Jalankan langsung jika dipanggil dari CLI
if (process.argv[1]?.endsWith('server.ts')) {
  const instance = createBosonGatewayServer()
  instance.listen()
}
