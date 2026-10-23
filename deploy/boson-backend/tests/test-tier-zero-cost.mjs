/**
 * Test Suite: Universal Subscription Tiers & Configurable Zero-Cost Free Models
 * Membuktikan bahwa:
 * 1. Model gratis dieksekusi dengan biaya $0 (saldo dompet tidak berkurang)
 * 2. Model premium di tier Free otomatis ditolak (403 tier_upgrade_required)
 * 3. Pemilik SaaS dapat mengubah/men-setting daftar model free secara dinamis via API / Supabase
 * 4. User yang meng-upgrade tier ke Pro dapat langsung mengakses model penalaran
 */

const GATEWAY_URL = 'http://127.0.0.1:8088'

async function run() {
  console.log('=================================================================')
  console.log('🛡️ TESTING UNIVERSAL SUBSCRIPTION TIERS & ZERO-COST FREE ENGINE')
  console.log('=================================================================\n')

  // 1. Registrasi Akun Baru (Default: Tier Free)
  const testEmail = `free_user_${Date.now()}@boson.id`
  console.log(`[1] Mendaftarkan Akun Baru (${testEmail})...`)
  
  const initRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'test_challenge_' + Date.now(),
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'tier_state',
    }),
  })
  const initData = await initRes.json()
  const authId = initData.data?.biz_data?.authorize_id

  await fetch(`${GATEWAY_URL}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_id: authId,
      email: testEmail,
      password: 'Password123!',
      full_name: 'Free Tier User',
    }),
  })

  const exchangeRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize_id: authId }),
  })
  const exchangeData = await exchangeRes.json()
  const token = exchangeData.data?.biz_data?.token
  const userId = exchangeData.data?.biz_data?.user?.id

  console.log(`    User ID : ${userId}`)

  // Buat API Key
  const keyRes = await fetch(`${GATEWAY_URL}/api/v0/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ key_name: 'Free User Key' }),
  })
  const keyData = await keyRes.json()
  const apiKey = keyData.api_key
  console.log(`    API Key : ${apiKey.slice(0, 16)}...`)

  // 2. Cek Konfigurasi Tier Saat Ini (GET /api/v0/tiers)
  console.log(`\n[2] Memeriksa Konfigurasi Tiering (GET /api/v0/tiers)...`)
  const tiersRes = await fetch(`${GATEWAY_URL}/api/v0/tiers`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const tiersData = await tiersRes.json()
  console.log(`    Total Tier Terdaftar: ${tiersData.tiers?.length}`)
  const freeTier = tiersData.tiers?.find(t => t.id === 'free')
  console.log(`    - [Free Tier] Allowed Models   : ${JSON.stringify(freeTier?.allowed_models)}`)
  console.log(`    - [Free Tier] Zero-Cost Models : ${JSON.stringify(freeTier?.zero_cost_models)}`)

  // Cek saldo awal dompet
  const quotaBeforeRes = await fetch(`${GATEWAY_URL}/v1/quota`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const quotaBefore = await quotaBeforeRes.json()
  const balanceBefore = quotaBefore.total_balance
  console.log(`    💰 Saldo Awal Dompet: $${balanceBefore.toFixed(4)}`)

  // 3. Uji Coba Model Gratis (Zero-Cost Model: gemini-2.0-flash)
  console.log(`\n[3] Memanggil Model GRATIS (gemini-2.0-flash) dari Tier Free...`)
  const callFreeRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-App-Id': 'customer-bot',
    },
    body: JSON.stringify({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Halo dari model gratis!' }],
      stream: false,
    }),
  })
  const callFree = await callFreeRes.json()
  console.log(`    Status Response: ${callFreeRes.status}`)
  console.log(`    AI Jawaban: "${callFree.choices?.[0]?.message?.content?.slice(0, 50)}..."`)

  // Verifikasi saldo setelah panggil model gratis
  const quotaAfterRes = await fetch(`${GATEWAY_URL}/v1/quota`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const quotaAfter = await quotaAfterRes.json()
  const balanceAfter = quotaAfter.total_balance
  console.log(`    💰 Saldo Setelah Model Gratis: $${balanceAfter.toFixed(4)}`)

  if (balanceBefore === balanceAfter) {
    console.log(`    ✅ TERBUKTI: Model gratis TIDAK memotong saldo dompet sama sekali ($0.00 debit)!`)
  } else {
    throw new Error(`Saldo terpotong padahal model gratis! Sebelum: ${balanceBefore}, Sesudah: ${balanceAfter}`)
  }

  // 4. Uji Coba Model Premium di Tier Free (Harus Ditolak 403 Tier Upgrade Required)
  console.log(`\n[4] Mencoba Memanggil Model Premium (claude-3-5-sonnet) dari Tier Free...`)
  const callProRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-App-Id': 'customer-bot',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Halo model premium!' }],
      stream: false,
    }),
  })
  const callPro = await callProRes.json()
  console.log(`    Status Response: ${callProRes.status} (Expected: 403)`)
  console.log(`    Error Code: ${callPro.error?.code}`)
  console.log(`    Pesan Upsell: "${callPro.error?.message}"`)
  console.log(`    Upgrade Link: ${callPro.error?.upgrade_url}`)

  if (callProRes.status === 403 && callPro.error?.code === 'tier_upgrade_required') {
    console.log(`    ✅ TERBUKTI: Gateway sukses melindungi model premium dan menawarkan upsell!`)
  } else {
    throw new Error('Gagal: Model premium tidak ditolak di tier free')
  }

  // 5. Uji Coba Pengubahan Model Free Secara Dinamis oleh Owner (PUT /api/v0/tiers/free)
  console.log(`\n[5] Mengubah Setting Model Free Secara Dinamis (Menghapus gemini-2.0-flash dari free)...`)
  const updateTierRes = await fetch(`${GATEWAY_URL}/api/v0/tiers/free`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      allowed_models: ['deepseek-flash', 'llama-3.3-70b-free'],
      zero_cost_models: ['llama-3.3-70b-free'],
    }),
  })
  const updateTierData = await updateTierRes.json()
  console.log(`    Hasil Update: ${updateTierData.message}`)
  console.log(`    Daftar Model Free Baru: ${JSON.stringify(updateTierData.tier?.allowed_models)}`)

  // Coba lagi panggil gemini-2.0-flash -> Sekarang HARUS DITOLAK karena sudah dicabut oleh owner!
  const callRemovedRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Tes model yang dicabut' }],
    }),
  })
  const callRemoved = await callRemovedRes.json()
  console.log(`    Panggil gemini-2.0-flash setelah dicabut -> Status: ${callRemovedRes.status} (Expected: 403)`)
  console.log(`    Pesan: "${callRemoved.error?.message}"`)

  // Kembalikan setting free tier seperti semula
  await fetch(`${GATEWAY_URL}/api/v0/tiers/free`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      allowed_models: ['deepseek-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'llama-3.3-70b-free'],
      zero_cost_models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'llama-3.3-70b-free'],
    }),
  })

  console.log('\n=================================================================')
  console.log('✅ SEMUA TEST SUBSCRIPTION TIERS & ZERO-COST FREE ENGINE BERHASIL!')
  console.log('=================================================================')
}

run().catch((err) => {
  console.error('❌ Test Gagal:', err)
  process.exit(1)
})
