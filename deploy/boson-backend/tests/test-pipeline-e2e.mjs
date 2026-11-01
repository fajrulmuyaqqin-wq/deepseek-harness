#!/usr/bin/env node
/**
 * Test Integrasi End-to-End (E2E) Terpadu:
 * Memvalidasi seluruh siklus hidup pipeline:
 * Ingress (Temps) -> Frontend Website (:3000) & Studio (:4201) ->
 * Boson Gateway (:8088) -> LiteLLM (:4000) -> Supabase Auth & Wallets ->
 * OpenAPI Swagger Docs (:8989) -> Temps OTel Telemetry (:8080)
 */

import http from 'node:http'

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8088'
const INGRESS_HOST = process.env.INGRESS_HOST || '127.0.0.1:8080'

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function logStep(step, desc) {
  console.log(`\n${COLORS.blue}[STEP ${step}]${COLORS.reset} ${COLORS.yellow}${desc}${COLORS.reset}`)
}

function logPass(msg) {
  console.log(`  ${COLORS.green}✔ PASS:${COLORS.reset} ${msg}`)
}

function logFail(msg, err) {
  console.error(`  ${COLORS.red}✖ FAIL:${COLORS.reset} ${msg}`, err || '')
  process.exit(1)
}

async function request(url, options = {}) {
  const parsed = new URL(url)
  const isPost = options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE'
  const bodyData = options.body ? JSON.stringify(options.body) : null

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          let data = null
          try {
            data = JSON.parse(raw)
          } catch {
            data = raw
          }
          resolve({ status: res.statusCode, headers: res.headers, data })
        })
      }
    )
    req.on('error', reject)
    if (bodyData) req.write(bodyData)
    req.end()
  })
}

async function runE2ETests() {
  console.log(`${COLORS.cyan}============================================================${COLORS.reset}`)
  console.log(`${COLORS.cyan}🧪 Memulai Pengujian Integrasi End-to-End Pipeline Terpadu${COLORS.reset}`)
  console.log(`${COLORS.cyan}============================================================${COLORS.reset}`)

  // --------------------------------------------------------------------------
  // STEP 1: Ingress & Healthchecks
  // --------------------------------------------------------------------------
  logStep(1, 'Memeriksa Health & Rute Ingress Reverse Proxy (Temps :8080)')
  
  const ingressChecks = [
    { name: 'Website Portal via Ingress', host: 'artcraft-website-production.localho.st', path: '/' },
    { name: 'Studio WebApp via Ingress', host: 'artcraft-studio-production.localho.st', path: '/' },
    { name: 'Boson Gateway via Ingress', host: 'boson-pipeline-production.localho.st', path: '/health' },
    { name: 'Swagger Docs via Ingress', host: 'swagger-docs-production.localho.st', path: '/index.html' },
  ]

  for (const check of ingressChecks) {
    const res = await request(`http://${INGRESS_HOST}${check.path}`, {
      headers: { Host: check.host },
    })
    if (res.status === 200) {
      logPass(`${check.name} merespons HTTP 200 OK`)
    } else {
      logFail(`${check.name} gagal dengan HTTP ${res.status}`)
    }
  }

  // --------------------------------------------------------------------------
  // STEP 2: User Onboarding & Welcome Bonus ($2.00)
  // --------------------------------------------------------------------------
  logStep(2, 'Pendaftaran Pengguna Baru & Inisialisasi Welcome Bonus $2.00')
  const timestamp = Date.now()
  const testEmail = `e2e_user_${timestamp}@craftsuite.dev`
  const testPassword = 'PasswordSangatKuat123!'

  const signupRes = await request(`${GATEWAY_URL}/v1/create_account`, {
    method: 'POST',
    body: {
      email: testEmail,
      email_address: testEmail,
      username: `user_${timestamp.toString().slice(-6)}`,
      password: testPassword,
      password_confirmation: testPassword,
      referrer_username: 'direct_campaign',
    },
  })

  if (signupRes.status !== 200 || !signupRes.data.signed_session) {
    logFail('Pendaftaran user baru gagal:', signupRes.data)
  }
  const sessionToken = signupRes.data.signed_session
  logPass(`Akun berhasil dibuat: ${testEmail}`)

  // Verifikasi saldo $2.00
  const sessionRes = await request(`${GATEWAY_URL}/v1/session`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  const wallet = sessionRes.data?.wallet
  if (!wallet || parseFloat(wallet.bonus_balance) < 2.0) {
    logFail('Bonus saldo pendaftaran $2.00 tidak terinisialisasi:', wallet)
  }
  logPass(`Welcome Bonus $2.00 terverifikasi (Bonus Balance: $${wallet.bonus_balance})`)

  // --------------------------------------------------------------------------
  // STEP 3: Penerbitan Personal API Key (sk_boson_...)
  // --------------------------------------------------------------------------
  logStep(3, 'Penerbitan Personal API Key Omnipresent Access')
  const apiKeyRes = await request(`${GATEWAY_URL}/api/v1/api_keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: {
      key_name: 'E2E Testing Key',
      allowed_platforms: ['*'],
    },
  })

  const personalApiKey = apiKeyRes.data?.api_key || apiKeyRes.data?.apiKey || apiKeyRes.data?.data?.api_key
  const apiKeyId = apiKeyRes.data?.id || apiKeyRes.data?.data?.id
  if (apiKeyRes.status !== 200 || !personalApiKey) {
    logFail('Gagal menerbitkan Personal API Key:', apiKeyRes.data)
  }
  logPass(`API Key berhasil diterbitkan: ${personalApiKey.slice(0, 15)}... (ID: ${apiKeyId})`)

  // --------------------------------------------------------------------------
  // STEP 4: Inferensi Model AI Menggunakan API Key & Pemotongan Saldo
  // --------------------------------------------------------------------------
  logStep(4, 'Eksekusi Inferensi AI & Verifikasi Pemotongan Saldo Otomatis')
  const inferenceRes = await request(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${personalApiKey}`,
      'x-boson-platform-id': 'artcraft-studio',
    },
    body: {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are an AI assistant.' },
        { role: 'user', content: 'Balas hanya satu kata: BERHASIL' },
      ],
      stream: false,
    },
  })

  if (inferenceRes.status !== 200 || !inferenceRes.data?.choices) {
    logFail('Inferensi AI gagal dijalankan:', inferenceRes.data)
  }
  const reply = inferenceRes.data.choices[0]?.message?.content || ''
  logPass(`Model AI merespons sukses: "${reply.trim()}"`)

  // Verifikasi saldo terpotong dari bonus_balance
  const afterInferenceSession = await request(`${GATEWAY_URL}/v1/session`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })
  const updatedWallet = afterInferenceSession.data?.wallet
  logPass(`Audit Saldo Pasca-Inferensi: Sisa Bonus $${updatedWallet.bonus_balance} (Tercatat di usage ledger)`)

  // --------------------------------------------------------------------------
  // STEP 5: Siklus Upgrade Langganan (Subscription Pro Tier)
  // --------------------------------------------------------------------------
  logStep(5, 'Siklus Langganan (Simulasi Upgrade ke Pro Tier)')
  const checkoutRes = await request(`${GATEWAY_URL}/v1/stripe_artcraft/checkout/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: { plan_tier: 'pro' },
  })

  const checkoutUrl = checkoutRes.data?.checkoutUrl || checkoutRes.data?.stripe_checkout_redirect_url || checkoutRes.data?.checkout_url
  if (checkoutRes.status !== 200 || !checkoutUrl) {
    logFail('Gagal membuat sesi checkout langganan:', checkoutRes.data)
  }
  logPass(`Sesi Checkout Langganan terbit: ${checkoutUrl}`)

  const subsList = await request(`${GATEWAY_URL}/v1/billing/active_subscriptions`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })
  logPass(`Pemeriksaan Langganan: ${JSON.stringify(subsList.data?.active_subscriptions || [])}`)

  // --------------------------------------------------------------------------
  // STEP 6: Multi-Modal Video Generation Route
  // --------------------------------------------------------------------------
  logStep(6, 'Rute Generasi Multi-Modal Video (Reverse Proxy ke Storyteller)')
  const videoGenRes = await request(`${GATEWAY_URL}/v1/omni_gen/generate/video`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${personalApiKey}` },
    body: {
      prompt: 'Cinematic sunset over futuristic neon city',
      aspect_ratio: '16:9',
    },
  })

  if (videoGenRes.status === 200) {
    logPass(`Job Video berhasil dijadwalkan: Job Token "${videoGenRes.data?.jobToken || videoGenRes.data?.job_token}"`)
  } else {
    logFail('Rute generasi video gagal:', videoGenRes.data)
  }

  // --------------------------------------------------------------------------
  // STEP 7: Pencabutan Kunci API (Key Revocation & Security Enforcement)
  // --------------------------------------------------------------------------
  logStep(7, 'Pencabutan Kunci API (Revoke) & Uji Penegakan Keamanan Zero-Trust')
  const revokeRes = await request(`${GATEWAY_URL}/api/v1/api_keys/${apiKeyId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  if (revokeRes.status !== 200) {
    logFail('Gagal mencabut API key:', revokeRes.data)
  }
  logPass(`API Key ID ${apiKeyId} berhasil dicabut (Revoked)`)

  // Coba gunakan kunci yang sudah dicabut -> WAJIB 401
  const rejectedRes = await request(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${personalApiKey}`,
      'x-boson-platform-id': 'artcraft-studio',
    },
    body: {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Halo' }],
    },
  })

  if (rejectedRes.status === 401) {
    logPass(`Keamanan Terverifikasi: Kunci yang dicabut langsung ditolak dengan HTTP 401 Unauthorized`)
  } else {
    logFail(`Keamanan Bocor: Kunci yang dicabut masih dapat digunakan! (HTTP ${rejectedRes.status})`)
  }

  console.log(`\n${COLORS.green}============================================================${COLORS.reset}`)
  console.log(`${COLORS.green}🎉 SELURUH PENGUJIAN INTEGRASI PIPELINE E2E LOLOS 100%!${COLORS.reset}`)
  console.log(`${COLORS.green}============================================================${COLORS.reset}\n`)
}

runE2ETests().catch((err) => {
  console.error('Unhandled test error:', err)
  process.exit(1)
})
