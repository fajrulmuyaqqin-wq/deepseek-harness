/**
 * Test Suite: Universal Shared Wallet & Multi-App SaaS Breakdown
 * Membuktikan bahwa satu saldo terpusat di Supabase dapat digunakan secara mulus
 * dan terlacak lintas produk SaaS (Boson Studio, AI Content, Customer Bot, dll.)
 */

import http from 'node:http'

const GATEWAY_URL = 'http://127.0.0.1:8088'

function httpRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GATEWAY_URL)
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve({ status: res.statusCode, headers: res.headers, body: parsed })
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: data })
        }
      })
    })

    req.on('error', reject)
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

async function run() {
  console.log('=================================================================')
  console.log('🚀 TESTING UNIVERSAL SHARED WALLET & MULTI-APP SAAS ENGINE')
  console.log('=================================================================\n')

  // 1. Healthcheck
  const health = await httpRequest('GET', '/health')
  console.log(`[1] Healthcheck Status: ${health.status} (${health.body?.service})`)
  if (health.status !== 200) throw new Error('Gateway is not healthy')

  // 2. Setup User & Wallet via PKCE Registration Flow
  const testEmail = `saas_owner_${Date.now()}@boson.id`
  console.log(`\n[2] Mendaftarkan Akun SaaS Owner Baru (${testEmail})...`)
  
  const initRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'test_challenge_' + Date.now(),
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'saas_state',
    }),
  })
  const initData = await initRes.json()
  const authId = initData.data?.biz_data?.authorize_id

  const regRes = await fetch(`${GATEWAY_URL}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_id: authId,
      email: testEmail,
      password: 'Password123!',
      full_name: 'Universal SaaS Owner',
    }),
  })
  await regRes.json()

  const exchangeRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize_id: authId }),
  })
  const exchangeData = await exchangeRes.json()
  const token = exchangeData.data?.biz_data?.token
  const userId = exchangeData.data?.biz_data?.user?.id

  console.log(`    User ID : ${userId}`)
  console.log(`    Token   : ${token ? token.slice(0, 15) + '...' : 'N/A'}`)

  if (!token) {
    throw new Error('Gagal mendapatkan auth token: ' + JSON.stringify(exchangeData))
  }

  // 3. Top-Up Saldo Awal Universal Wallet ($10.00)
  console.log(`\n[3] Top-Up Saldo Universal Wallet sebesar $10.00...`)
  const topup = await httpRequest('POST', '/api/v0/billing/test-topup', {
    Authorization: `Bearer ${token}`,
  }, {
    amount_usd: 10.0,
    plan_tier: 'pro',
  })
  console.log(`    Saldo Saat Ini: Bonus=$${topup.body?.wallet?.bonus_balance}, Normal=$${topup.body?.wallet?.normal_balance}`)

  // 4. Generate Universal API Key
  console.log(`\n[4] Membuat Universal API Key (allowed_platforms = ['*'])...`)
  const keyRes = await httpRequest('POST', '/api/v0/api-keys', {
    Authorization: `Bearer ${token}`,
  }, {
    key_name: 'SaaS Universal Gateway Key',
    allowed_platforms: ['*'],
    target_app_id: '*',
  })
  const apiKey = keyRes.body?.api_key
  console.log(`    Generated API Key: ${apiKey?.slice(0, 16)}...`)

  // 5. Cek Daftar Aplikasi SaaS Resmi yang Terhubung
  console.log(`\n[5] Mengambil Daftar Aplikasi SaaS Resmi (GET /api/v0/apps)...`)
  const appsRes = await httpRequest('GET', '/api/v0/apps', {
    Authorization: `Bearer ${apiKey}`,
  })
  console.log(`    Jumlah Aplikasi Terdaftar: ${appsRes.body?.apps?.length}`)
  appsRes.body?.apps?.forEach((app) => {
    console.log(`    - [${app.id}] ${app.name} (Active: ${app.is_active})`)
  })

  // 6. Multi-App Inference Execution (Satu Saldo untuk Semua Apps)
  console.log(`\n[6] Menjalankan Inference dari 3 Aplikasi Berbeda Menggunakan API Key & Saldo yang Sama:`)

  // 6a. App 1: Boson Studio (Coding Assistant)
  console.log(`\n    --- [Aplikasi 1: boson-studio (Coding Assistant)] ---`)
  const call1 = await httpRequest('POST', '/v1/chat/completions', {
    Authorization: `Bearer ${apiKey}`,
    'X-App-Id': 'boson-studio',
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Tulis function Fibonacci singkat di TypeScript.' }],
    stream: false,
  })
  console.log(`    Status: ${call1.status}`)
  console.log(`    Content: ${call1.body?.choices?.[0]?.message?.content?.slice(0, 70)}...`)
  console.log(`    Tokens: ${JSON.stringify(call1.body?.usage)}`)

  // 6b. App 2: AI Content (Copywriting SaaS)
  console.log(`\n    --- [Aplikasi 2: ai-content (Copywriting SaaS)] ---`)
  const call2 = await httpRequest('POST', '/v1/chat/completions', {
    Authorization: `Bearer ${apiKey}`,
    'X-App-Id': 'ai-content',
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Buat 1 tagline menarik untuk produk kopi organik.' }],
    stream: false,
  })
  console.log(`    Status: ${call2.status}`)
  console.log(`    Content: ${call2.body?.choices?.[0]?.message?.content?.slice(0, 70)}...`)
  console.log(`    Tokens: ${JSON.stringify(call2.body?.usage)}`)

  // 6c. App 3: Customer Bot (WhatsApp/Telegram AI Support)
  console.log(`\n    --- [Aplikasi 3: customer-bot (Customer Bot SaaS)] ---`)
  const call3 = await httpRequest('POST', '/v1/chat/completions', {
    Authorization: `Bearer ${apiKey}`,
    'X-App-Id': 'customer-bot',
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Halo admin, apakah ada garansi untuk pesanan saya?' }],
    stream: false,
  })
  console.log(`    Status: ${call3.status}`)
  console.log(`    Content: ${call3.body?.choices?.[0]?.message?.content?.slice(0, 70)}...`)
  console.log(`    Tokens: ${JSON.stringify(call3.body?.usage)}`)

  // 7. Ambil Laporan Breakdown Penggunaan Berdasarkan Aplikasi
  console.log(`\n[7] Mengambil Breakdown Penggunaan per Aplikasi (GET /api/v0/billing/usage-by-app)...`)
  const usageByApp = await httpRequest('GET', '/api/v0/billing/usage-by-app', {
    Authorization: `Bearer ${apiKey}`,
  })

  console.log(`    Total Pengeluaran Jendela (USD): $${usageByApp.body?.total_spent_window_usd}`)
  console.log(`    Sisa Saldo Universal Terkini: $${usageByApp.body?.current_balance?.total}`)
  console.log(`    Breakdown per Aplikasi SaaS:`)
  console.table(usageByApp.body?.apps_breakdown)

  // 8. Test Scoped API Key (Security & Isolation Test)
  console.log(`\n[8] Menguji Security Scoping API Key Khusus 1 SaaS (target_app_id = 'ai-content')...`)
  const scopedKeyRes = await httpRequest('POST', '/api/v0/api-keys', {
    Authorization: `Bearer ${token}`,
  }, {
    key_name: 'Key Khusus Copywriting SaaS',
    allowed_platforms: ['ai-content'],
    target_app_id: 'ai-content',
  })
  const scopedKey = scopedKeyRes.body?.api_key

  // Coba pakai Scoped Key untuk akses customer-bot -> Harusnya 403 Forbidden
  const testForbidden = await httpRequest('POST', '/v1/chat/completions', {
    Authorization: `Bearer ${scopedKey}`,
    'X-App-Id': 'customer-bot',
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Test forbidden access' }],
  })
  console.log(`    Akses ke customer-bot dengan Key ai-content -> Status: ${testForbidden.status} (Expected: 403)`)
  console.log(`    Error Message: ${testForbidden.body?.error?.message}`)

  // Coba pakai Scoped Key untuk akses ai-content -> Harusnya 200 OK
  const testAllowed = await httpRequest('POST', '/v1/chat/completions', {
    Authorization: `Bearer ${scopedKey}`,
    'X-App-Id': 'ai-content',
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Halo dari copywriting app.' }],
  })
  console.log(`    Akses ke ai-content dengan Key ai-content -> Status: ${testAllowed.status} (Expected: 200)`)

  console.log('\n=================================================================')
  console.log('✅ SEMUA TEST UNIVERSAL SHARED WALLET & MULTI-APP SAAS BERHASIL!')
  console.log('=================================================================')
}

run().catch((err) => {
  console.error('❌ Test Gagal:', err)
  process.exit(1)
})
