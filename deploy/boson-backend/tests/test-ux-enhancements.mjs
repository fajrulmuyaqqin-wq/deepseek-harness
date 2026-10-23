import assert from 'node:assert'

const BASE_URL = 'http://127.0.0.1:8088'

console.log('\n=============================================================')
console.log('🎨 PENGUJIAN FITUR UX ENHANCEMENTS (BANNER & DAILY CHART)')
console.log('=============================================================\n')

async function runTest() {
  // 1. Registrasi user baru untuk pengujian
  const email = `ux_tester_${Date.now()}@boson.id`
  const password = 'PasswordSuperAman123!'
  
  // PKCE init
  const initResp = await fetch(`${BASE_URL}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'ux_challenge',
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'ux_state',
    }),
  })
  const initData = await initResp.json()
  const auth_id = initData.data?.biz_data?.authorize_id || initData.data?.authorize_id

  // Sign up
  const signupResp = await fetch(`${BASE_URL}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, auth_id, full_name: 'UX Tester' }),
  })
  const signupData = await signupResp.json()
  assert.ok(signupResp.status === 200 && signupData.redirect_uri, 'Signup harus berhasil')

  // Exchange
  const exResp = await fetch(`${BASE_URL}/auth-api/v0/dsh/auth_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize_id: auth_id }),
  })
  const exData = await exResp.json()
  const token = exData.data?.biz_data?.token || exData.data?.token
  const user_id = exData.data?.biz_data?.user?.id || exData.data?.user?.id
  assert.ok(token, 'Token harus tersedia')

  console.log('1. User Pengujian Berhasil Dibuat:')
  console.log(`   User ID : ${user_id}`)
  console.log(`   Email   : ${email}`)

  // 2. Uji Low-Balance Check pada Quota Endpoint saat Saldo Cukup ($2.00)
  console.log('\n2. Menguji /v1/quota saat Saldo Awal ($2.00)...')
  const quotaResp1 = await fetch(`${BASE_URL}/v1/quota`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const quotaData1 = await quotaResp1.json()
  console.log('   Total Balance :', quotaData1.total_balance)
  console.log('   Is Low Balance:', quotaData1.is_low_balance)
  console.log('   Warning       :', quotaData1.warning)
  assert.strictEqual(quotaData1.is_low_balance, false, 'Saldo $2.00 tidak boleh low_balance')
  assert.strictEqual(quotaData1.warning, null, 'Warning harus null saat saldo cukup')

  // 3. Simulasikan saldo mendekati habis ($0.05)
  console.log('\n3. Menguji /v1/quota saat Saldo Kritis ($0.05)...')
  const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.X8pryYLvFZpZR7kBcnIgtC6uW6R-Oq4cDFqWitKRHN4'
  const patchResp = await fetch(`${BASE_URL}/rest/v1/wallets?user_id=eq.${user_id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ bonus_balance: 0.05, normal_balance: 0, subscription_balance: 0 }),
  })
  assert.ok(patchResp.ok, 'Patch wallet harus berhasil')

  const quotaResp2 = await fetch(`${BASE_URL}/v1/quota`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const quotaData2 = await quotaResp2.json()
  console.log('   Total Balance :', quotaData2.total_balance)
  console.log('   Is Low Balance:', quotaData2.is_low_balance)
  console.log('   Warning       :', quotaData2.warning)
  console.log('   Recommended   :', quotaData2.recommended_action)
  assert.strictEqual(quotaData2.is_low_balance, true, 'Saldo $0.05 harus memicu is_low_balance = true')
  assert.strictEqual(quotaData2.warning, 'low_balance', 'Warning harus low_balance')
  assert.strictEqual(quotaData2.recommended_action, 'top_up', 'Rekomendasi harus top_up')

  // 4. Lakukan 1 inferensi agar masuk ke usage_ledger
  console.log('\n4. Menjalankan 1 Turn Inferensi untuk Mengisi Data Ledger...')
  const chatResp = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-platform-id': 'boson-desktop',
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Halo dari visual chart test!' }],
      max_tokens: 30,
    }),
  })
  assert.strictEqual(chatResp.status, 200, 'Inferensi harus berhasil')
  console.log('   ✅ Turn inferensi berhasil diproses dan dicatat di usage_ledger.')

  // 5. Uji Endpoint Agregasi Pengeluaran Harian (/api/v0/billing/daily-usage)
  console.log('\n5. Menguji Endpoint Visual Daily Usage (/api/v0/billing/daily-usage)...')
  const usageResp = await fetch(`${BASE_URL}/api/v0/billing/daily-usage?days=7`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.strictEqual(usageResp.status, 200, 'Endpoint daily-usage harus merespons 200 OK')
  const usageData = await usageResp.json()

  console.log('   Total Hari       :', usageData.days)
  console.log('   Total Cost (USD) :', usageData.total_cost_usd)
  console.log('   Total Tokens     :', usageData.total_tokens)
  console.log('   Total Turns      :', usageData.total_turns)
  console.log('   Data Points      :', usageData.series.length)

  assert.strictEqual(usageData.days, 7, 'Jumlah hari harus 7')
  assert.ok(usageData.series.length === 7, 'Series harus mencakup 7 tanggal berurutan')
  assert.ok(Number(usageData.total_cost_usd) > 0, 'Total cost harus lebih dari 0 setelah inferensi')
  assert.ok(Number(usageData.total_tokens) > 0, 'Total tokens harus lebih dari 0')
  assert.ok(usageData.total_turns >= 1, 'Total turns minimal 1')

  const todayItem = usageData.series[usageData.series.length - 1]
  console.log('   Titik Hari Ini   :', todayItem)
  assert.ok(todayItem.turn_count >= 1, 'Hari ini harus memiliki turn_count >= 1')
  assert.ok(todayItem.models.includes('deepseek-flash'), 'Model harus mencatat deepseek-flash')

  // 6. Verifikasi Render HTML Portal Billing
  console.log('\n6. Memvalidasi Komponen UX pada Portal Billing (/billing)...')
  const portalResp = await fetch(`${BASE_URL}/billing`)
  const html = await portalResp.text()

  assert.ok(html.includes('id="lowBalanceBanner"'), 'HTML harus memiliki id="lowBalanceBanner"')
  assert.ok(html.includes('id="barChartContainer"'), 'HTML harus memiliki id="barChartContainer"')
  assert.ok(html.includes('id="metricTotalCost"'), 'HTML harus memiliki id="metricTotalCost"')
  assert.ok(html.includes('id="metricTotalTokens"'), 'HTML harus memiliki id="metricTotalTokens"')
  assert.ok(html.includes('setChartMetricMode'), 'HTML harus memiliki handler switch mode chart')
  assert.ok(html.includes('setChartRange'), 'HTML harus memiliki handler switch rentang hari')

  console.log('   ✅ Banner Notifikasi Saldo Rendah terverifikasi di template HTML.')
  console.log('   ✅ Bar Chart Container & Metric Cards terverifikasi di template HTML.')
  console.log('   ✅ Mode Switcher (Cost vs Token) & Range Switcher (7/14/30 hari) terverifikasi.')

  console.log('\n=============================================================')
  console.log('🎉 SELURUH PENGUJIAN FITUR UX BERHASIL 100% PASS!')
  console.log('=============================================================\n')
}

runTest().catch(err => {
  console.error('\n❌ TEST GAGAL:', err)
  process.exit(1)
})
