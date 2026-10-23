/**
 * Boson Studio - End-to-End Monetization & Use Cases Audit Suite (Standalone)
 * Menguji seluruh use case secara tuntas dengan native fetch:
 * 1. User Baru & Welcome Bonus ($2.00)
 * 2. Langganan Bulanan (Subscription Pro Mode)
 * 3. Deposit Pay-As-You-Go (QRIS / VA Xendit)
 * 4. Hybrid Zero-Lockout Architecture
 * 5. Personal API Key (sk_boson_...)
 * 6. Edge Case Insufficient Balance (HTTP 402)
 * 7. Verifikasi Kredensial & Alamat Resmi Xendit & Google OAuth (Sinkron AI_SAAS)
 */

const GATEWAY_URL_8088 = process.env.GATEWAY_URL || 'http://127.0.0.1:8088'
const GATEWAY_URL_5001 = 'http://127.0.0.1:5001'
const REST_URL = 'http://127.0.0.1:8088/rest/v1'
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.X8pryYLvFZpZR7kBcnIgtC6uW6R-Oq4cDFqWitKRHN4'

const restHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callMessages({ token, model = 'deepseek-flash', content = 'Halo Boson Studio!', maxRetries = 5 }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${GATEWAY_URL_8088}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 15,
        messages: [{ role: 'user', content }],
      }),
    })
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
      console.log(`   ⏳ [Upstream rate-limit/transient error (${res.status}), retry ${attempt}/${maxRetries} in 3.5s...]`)
      await sleep(3500)
      continue
    }
    return res
  }
}

// REST Database Helpers
const db = {
  async selectOne(table, query) {
    const res = await fetch(`${REST_URL}/${table}?${query}`, { headers: restHeaders })
    if (!res.ok) throw new Error(`DB Select error on ${table}: ${await res.text()}`)
    const list = await res.json()
    return list[0] || null
  },
  async selectList(table, query) {
    const res = await fetch(`${REST_URL}/${table}?${query}`, { headers: restHeaders })
    if (!res.ok) throw new Error(`DB SelectList error on ${table}: ${await res.text()}`)
    return await res.json()
  },
  async update(table, query, data) {
    const res = await fetch(`${REST_URL}/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...restHeaders, Prefer: 'return=representation' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`DB Update error on ${table}: ${await res.text()}`)
    return await res.json()
  },
}

// Kredensial Resmi Sinkron AI_SAAS
const OFFICIAL_CREDENTIALS = {
  googleClientId: '41454207765-igj2vl7sce0n9gbbjfm98ovb8p2okefs.apps.googleusercontent.com',
  xenditSecretKeyPrefix: 'xnd_development_',
  xenditWebhookToken: 'HDmeJZjzpTJkJ1t2YmHiTOohL4lblqJbZQblm7SvOzzHO5Ar',
}

let testPassed = 0
let testFailed = 0

function assert(condition, message) {
  if (!condition) {
    testFailed++
    console.error(`❌ [FAIL] ${message}`)
    throw new Error(message)
  }
  testPassed++
  console.log(`✅ [PASS] ${message}`)
}

async function runAudit() {
  console.log('\n=============================================================')
  console.log('🚀 MEMULAI AUDIT END-TO-END MONETISASI BOSON STUDIO')
  console.log('=============================================================\n')

  const testEmail = `audit_user_${Date.now()}@boson.id`
  const testPassword = 'PasswordSangatKuat123!'
  const testFullName = 'Audit Automated Tester'
  let testUserId = null
  let testToken = null

  // ─────────────────────────────────────────────────────────────
  // USE CASE 1: REGISTRASI USER BARU & WELCOME BONUS ($2.00)
  // ─────────────────────────────────────────────────────────────
  console.log('--- [USE CASE 1]: Pendaftaran User Baru & Welcome Bonus ---')
  
  // 1a. Inisiasi Sesi PKCE
  const initRes = await fetch(`${GATEWAY_URL_8088}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'audit_challenge',
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'audit_state'
    })
  })
  const initData = await initRes.json()
  const authId = initData.data?.biz_data?.authorize_id || initData.data?.authorize_id
  assert(initRes.status === 200 && authId, `1.1 Berhasil inisiasi PKCE Session (authId: ${authId})`)

  // 1b. Registrasi User Baru
  const regRes = await fetch(`${GATEWAY_URL_8088}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_id: authId,
      email: testEmail,
      password: testPassword,
      full_name: testFullName
    })
  })
  const regData = await regRes.json()
  assert(regRes.status === 200 && regData.redirect_uri, '1.2 Berhasil registrasi akun pengguna baru')

  // 1c. Exchange PKCE Token
  const exchangeRes = await fetch(`${GATEWAY_URL_8088}/auth-api/v0/dsh/auth_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize_id: authId })
  })
  const exchangeData = await exchangeRes.json()
  testToken = exchangeData.data?.biz_data?.token || exchangeData.data?.token
  testUserId = exchangeData.data?.biz_data?.user?.id || exchangeData.data?.user?.id
  assert(exchangeRes.status === 200 && testToken, `1.3 Berhasil exchange token sesi PKCE (UserId: ${testUserId})`)

  // 1d. Verifikasi Profil & Welcome Bonus di Database
  const profile = await db.selectOne('profiles', `id=eq.${testUserId}`)
  assert(profile && profile.tier === 'free', '1.4 Profil tersimpan dengan tier "free"')

  const wallet = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(wallet && Number(wallet.bonus_balance) === 2.00, '1.5 Dompet terisi otomatis $2.00 Welcome Bonus')
  assert(Number(wallet.normal_balance) === 0.00, '1.6 Normal balance awal = $0.00')
  assert(Number(wallet.subscription_balance) === 0.00, '1.7 Subscription balance awal = $0.00')

  // 1e. Panggil API Model Menggunakan Saldo Welcome Bonus
  const msgRes1 = await callMessages({ token: testToken, content: 'Halo Boson Studio!' })
  let msgRes1Text = ''
  if (msgRes1.status !== 200) {
    msgRes1Text = await msgRes1.text()
  }
  assert(msgRes1.status === 200, `1.8 Sukses memanggil /v1/messages dengan token user baru (Status: ${msgRes1.status}, Err: ${msgRes1Text})`)
  await sleep(1000)

  // 1f. Verifikasi Pemotongan Saldo Bonus & Catatan Usage Ledger
  const walletAfter1 = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(Number(walletAfter1.bonus_balance) < 2.00, `1.9 Saldo bonus terpotong: $${walletAfter1.bonus_balance} < $2.00`)

  const logs1 = await db.selectList('usage_ledger', `user_id=eq.${testUserId}&order=created_at.desc&limit=1`)
  assert(logs1 && logs1.length > 0, '1.10 Usage ledger mencatat transaksi inference')
  assert(logs1[0].deducted_from === 'bonus', '1.11 Pemotongan tercatat dari "bonus"')
  assert(logs1[0].metadata?.margin_percent === 15, '1.12 Ledger memuat live pricing metadata dengan fair margin 15%')

  // ─────────────────────────────────────────────────────────────
  // USE CASE 2: LANGGANAN BULANAN (SUBSCRIPTION PRO MODE)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 2]: Langganan Bulanan (Subscription Mode) ---')

  // 2a. Buat Invoice Langganan Pro via Xendit
  const subInvoiceRes = await fetch(`${GATEWAY_URL_8088}/api/v0/billing/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`
    },
    body: JSON.stringify({ plan_tier: 'pro', gateway: 'xendit' })
  })
  const subInvoiceData = await subInvoiceRes.json()
  assert(subInvoiceRes.status === 200 && subInvoiceData.transaction_id, '2.1 Berhasil membuat invoice langganan Pro ($14.99)')
  assert(subInvoiceData.monthly_token_pool === 18.00, '2.2 Token pool langganan Pro = $18.00')

  // 2b. Simulasi Pembayaran / Settlement via Xendit Webhook
  const subWebhookRes = await fetch(`${GATEWAY_URL_8088}/v1/xendit/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-callback-token': OFFICIAL_CREDENTIALS.xenditWebhookToken
    },
    body: JSON.stringify({
      id: `inv_sub_${Date.now()}`,
      external_id: subInvoiceData.transaction_id,
      status: 'PAID',
      amount: subInvoiceData.amount_idr,
      paid_amount: subInvoiceData.amount_idr,
      payment_method: 'QRIS',
      paid_at: new Date().toISOString()
    })
  })
  const subWebhookData = await subWebhookRes.json()
  assert(subWebhookRes.status === 200 && subWebhookData.success, '2.3 Webhook settlement Xendit berhasil diverifikasi & diproses')

  // 2c. Verifikasi Database: Profil naik ke Pro & Dompet mendapat Kuota $18.00
  const profileAfterSub = await db.selectOne('profiles', `id=eq.${testUserId}`)
  assert(profileAfterSub.tier === 'pro', '2.4 Tier profil pengguna berhasil naik ke "pro"')

  const walletAfterSub = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(Number(walletAfterSub.subscription_balance) >= 18.00, `2.5 Saldo kuota subscription masuk: $${walletAfterSub.subscription_balance}`)

  // Kosongkan sisa bonus_balance agar inferensi berikutnya membuktikan pemotongan dari subscription_balance
  await db.update('wallets', `user_id=eq.${testUserId}`, { bonus_balance: 0.00 })

  // 2d. Panggil API Model Menggunakan Kuota Subscription
  const msgRes2 = await callMessages({ token: testToken, content: 'Tes langganan pro Boson' })
  let msgRes2Text = ''
  if (msgRes2.status !== 200) {
    msgRes2Text = await msgRes2.text()
  }
  assert(msgRes2.status === 200, `2.6 Panggilan API sukses dengan akun langganan Pro (Status: ${msgRes2.status}, Err: ${msgRes2Text})`)
  await sleep(1000)

  // 2e. Verifikasi Pemotongan dari Subscription Balance
  const walletAfter2 = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(Number(walletAfter2.subscription_balance) < 18.00, `2.7 Kuota subscription berkurang: $${walletAfter2.subscription_balance} < $18.00`)

  const logs2 = await db.selectList('usage_ledger', `user_id=eq.${testUserId}&order=created_at.desc&limit=1`)
  assert(logs2[0].deducted_from === 'subscription', '2.8 Usage ledger mencatat pemotongan dari "subscription"')

  // ─────────────────────────────────────────────────────────────
  // USE CASE 3: DEPOSIT PAY-AS-YOU-GO (TOP UP SALDO BEBAS)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 3]: Deposit Pay-As-You-Go Mode ---')

  // 3a. Buat Invoice Deposit $5.00 via Xendit
  const depInvoiceRes = await fetch(`${GATEWAY_URL_8088}/api/v0/billing/create-deposit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`
    },
    body: JSON.stringify({ amount_usd: 5.0, gateway: 'xendit' })
  })
  const depInvoiceData = await depInvoiceRes.json()
  assert(depInvoiceRes.status === 200 && depInvoiceData.transaction_id, '3.1 Berhasil membuat invoice deposit $5.00')

  // 3b. Settlement Webhook Xendit
  const depWebhookRes = await fetch(`${GATEWAY_URL_8088}/v1/xendit/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-callback-token': OFFICIAL_CREDENTIALS.xenditWebhookToken
    },
    body: JSON.stringify({
      id: `inv_dep_${Date.now()}`,
      external_id: depInvoiceData.transaction_id,
      status: 'PAID',
      amount: depInvoiceData.amount_idr,
      paid_amount: depInvoiceData.amount_idr,
      payment_method: 'BCA_VA',
      paid_at: new Date().toISOString()
    })
  })
  const depWebhookData = await depWebhookRes.json()
  assert(depWebhookRes.status === 200 && depWebhookData.success, '3.2 Webhook deposit Xendit berhasil diproses')

  // 3c. Verifikasi Saldo Normal Balance di Dompet
  const walletAfterDep = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(Number(walletAfterDep.normal_balance) >= 5.00, `3.3 Normal balance bertambah: $${walletAfterDep.normal_balance}`)

  // ─────────────────────────────────────────────────────────────
  // USE CASE 4: HYBRID ZERO-LOCKOUT ARCHITECTURE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 4]: Hybrid Zero-Lockout Architecture ---')
  console.log('Simulasi kondisi: Kuota subscription habis ($0.00), namun user memiliki saldo deposit ($5.00)')

  // 4a. Set subscription balance = 0 dan pastikan normal balance > 0
  await db.update('wallets', `user_id=eq.${testUserId}`, {
    bonus_balance: 0.00,
    subscription_balance: 0.00,
    normal_balance: 5.00
  })

  // 4b. Panggil API Model
  const msgRes4 = await callMessages({ token: testToken, content: 'Zero lockout test' })
  let msgRes4Text = ''
  if (msgRes4.status !== 200) {
    msgRes4Text = await msgRes4.text()
  }
  assert(msgRes4.status === 200, `4.1 API call berhasil tanpa lockout (Status: ${msgRes4.status}, Err: ${msgRes4Text})`)
  await sleep(1000)

  // 4c. Verifikasi otomatis terdebit dari normal balance
  const walletAfter4 = await db.selectOne('wallets', `user_id=eq.${testUserId}`)
  assert(Number(walletAfter4.subscription_balance) === 0.00, '4.2 Subscription balance tetap $0.00')
  assert(Number(walletAfter4.normal_balance) < 5.00, `4.3 Normal balance otomatis terpotong: $${walletAfter4.normal_balance} < $5.00`)

  const logs4 = await db.selectList('usage_ledger', `user_id=eq.${testUserId}&order=created_at.desc&limit=1`)
  assert(logs4[0].deducted_from === 'normal', '4.4 Usage ledger mencatat transisi otomatis ke "normal"')

  // ─────────────────────────────────────────────────────────────
  // USE CASE 5: PERSONAL API KEY (sk_boson_...) MULTI-PLATFORM
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 5]: Personal API Key (sk_boson_...) Flow ---')

  // 5a. Buat Personal API Key
  const apiKeyRes = await fetch(`${GATEWAY_URL_8088}/api/v0/api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`
    },
    body: JSON.stringify({ key_name: 'Audit CLI & Cursor Key', allowed_platforms: ['*'] })
  })
  const apiKeyData = await apiKeyRes.json()
  const rawKey = apiKeyData.api_key || apiKeyData.apiKey
  assert(apiKeyRes.status === 200 && rawKey?.startsWith('sk_boson_'), '5.1 API Key berhasil di-generate dengan format sk_boson_...')
  const personalApiKey = rawKey

  // 5b. Panggil API Menggunakan Personal API Key
  const msgRes5 = await callMessages({ token: personalApiKey, content: 'Call via sk_boson_ key' })
  let msgRes5Text = ''
  if (msgRes5.status !== 200) {
    msgRes5Text = await msgRes5.text()
  }
  assert(msgRes5.status === 200, `5.2 Autentikasi dan eksekusi API berhasil dengan Bearer sk_boson_... (Status: ${msgRes5.status}, Err: ${msgRes5Text})`)
  await sleep(1000)

  // 5c. Verifikasi update timestamp last_used_at pada API Key
  const keyId = apiKeyData.id || apiKeyData.keyDetails?.id
  const keyRecord = await db.selectOne('api_keys', `id=eq.${keyId}`)
  assert(keyRecord && keyRecord.last_used_at !== null, '5.3 Kolom last_used_at pada API Key berhasil diperbarui')

  // ─────────────────────────────────────────────────────────────
  // USE CASE 6: EDGE CASE SALDO HABIS (HTTP 402 PAYMENT REQUIRED)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 6]: Edge Case Saldo Habis (HTTP 402) ---')

  // 6a. Kosongkan seluruh saldo
  await db.update('wallets', `user_id=eq.${testUserId}`, {
    bonus_balance: 0.00,
    subscription_balance: 0.00,
    normal_balance: 0.00
  })

  // 6b. Panggil API saat saldo $0.00
  const msgRes6 = await fetch(`${GATEWAY_URL_8088}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 15,
      messages: [{ role: 'user', content: 'Harus 402' }]
    })
  })
  assert(msgRes6.status === 402, `6.1 Gateway merespons 402 Payment Required saat saldo $0.00 (Status: ${msgRes6.status})`)
  
  const errBody6 = await msgRes6.json()
  assert(errBody6.error?.code === 'insufficient_quota', '6.2 Error code bernilai "insufficient_quota"')
  assert(errBody6.error?.details?.top_up_url, '6.3 Error details menyediakan link top_up_url yang valid')

  // ─────────────────────────────────────────────────────────────
  // USE CASE 7: AUDIT INTEGRITAS KREDENSIAL & ENDPOINT RESMI
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- [USE CASE 7]: Verifikasi Kredensial & Endpoint Resmi (Google & Xendit) ---')

  // 7a. Verifikasi Endpoint Google OAuth di Port 5001 dan Port 8088
  const googlePopupRes5001 = await fetch(`${GATEWAY_URL_5001}/v1/auth/google/popup`, { redirect: 'manual' })
  assert(googlePopupRes5001.status === 302, '7.1 Endpoint Google OAuth Popup di port 5001 merespons HTTP 302 Redirect')
  const loc5001 = googlePopupRes5001.headers.get('location') || ''
  assert(loc5001.includes(encodeURIComponent(OFFICIAL_CREDENTIALS.googleClientId)), '7.2 Redirect URL memuat Google Client ID resmi dari AI_SAAS')

  const googleCallbackRes5001 = await fetch(`${GATEWAY_URL_5001}/v1/auth/google/callback`)
  const htmlCallback = await googleCallbackRes5001.text()
  assert(googleCallbackRes5001.status === 200 && htmlCallback.includes('Menyelesaikan Login Google'), '7.3 Endpoint Callback Google OAuth di port 5001 menyajikan halaman otentikasi')

  // 7b. Verifikasi Endpoint Xendit di Port 5001 dan Port 8088
  const xenditPlansRes = await fetch(`${GATEWAY_URL_5001}/v1/xendit/plans`)
  const xenditPlans = await xenditPlansRes.json()
  assert(xenditPlans.success && xenditPlans.plans?.pro?.usd === 14.99, '7.4 Endpoint /v1/xendit/plans menyajikan tarif langganan resmi dalam IDR/USD')

  const xenditCheckoutRes = await fetch(`${GATEWAY_URL_5001}/v1/xendit/sandbox-checkout`)
  const xenditCheckoutHtml = await xenditCheckoutRes.text()
  assert(xenditCheckoutRes.status === 200 && xenditCheckoutHtml.includes('Xendit Payment Gateway'), '7.5 Endpoint /v1/xendit/sandbox-checkout menyajikan simulator pembayaran QRIS')

  // 7c. Verifikasi Validasi Keamanan Webhook Token Xendit
  const invalidWebhookRes = await fetch(`${GATEWAY_URL_8088}/v1/xendit/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-callback-token': 'token_palsu_yang_salah'
    },
    body: JSON.stringify({ external_id: 'test' })
  })
  assert(invalidWebhookRes.status === 400, '7.6 Webhook Xendit menolak callback dengan token palsu (HTTP 400)')

  // 7d. Verifikasi Sinkronisasi Live Pricing OpenRouter (942 model)
  const pricingRes = await fetch(`${GATEWAY_URL_8088}/v1/pricing`)
  const pricingData = await pricingRes.json()
  assert(pricingData.meta?.status === 'healthy', '7.7 Sinkronisasi Live Pricing berstatus healthy')
  assert(pricingData.meta?.total_upstream_models >= 900, `7.8 Terindeks ${pricingData.meta?.total_upstream_models} model upstream aktif`)

  // 7e. Verifikasi Otomatisasi Google SSO Provisioning & Welcome Bonus ($2.00)
  const testSsoEmail = `google_sso_${Date.now()}@boson.id`
  const testSessionId = `sess_audit_${Date.now()}`
  const ssoRes = await fetch(`${GATEWAY_URL_5001}/v1/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken: `mock_google_${testSsoEmail}`,
      sessionId: testSessionId,
    })
  })
  const ssoData = await ssoRes.json()
  assert(ssoRes.status === 200 && ssoData.success, '7.9 Endpoint /v1/auth/google berhasil memverifikasi & mendaftarkan akun SSO')
  assert(ssoData.is_new_user === true, '7.10 Google SSO mengidentifikasi akun baru secara otomatis')
  assert(Number(ssoData.wallet?.bonus_balance) === 2.00, '7.11 Akun Google SSO baru otomatis diberikan $2.00 Welcome Bonus')

  // 7f. Verifikasi Polling Session Desktop/CLI (/v1/auth/google/session/:sessionId)
  const sessionPollRes = await fetch(`${GATEWAY_URL_5001}/v1/auth/google/session/${testSessionId}`)
  const sessionPollData = await sessionPollRes.json()
  assert(sessionPollRes.status === 200 && sessionPollData.token, '7.12 Endpoint polling session Google OAuth (/v1/auth/google/session/:sessionId) sukses mengembalikan token')

  console.log('\n=============================================================')
  console.log(`🎉 SELURUH AUDIT USE CASE SELESAI DENGAN SUKSES!`)
  console.log(`Total Pengujian Lolos : ${testPassed}`)
  console.log(`Total Pengujian Gagal : ${testFailed}`)
  console.log('=============================================================\n')
}

runAudit().catch(err => {
  console.error('\n💥 AUDIT DIHENTIKAN KARENA ERROR:', err)
  process.exit(1)
})
