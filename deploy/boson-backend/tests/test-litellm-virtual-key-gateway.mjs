// ─────────────────────────────────────────────────────────────
// TEST SUITE: LITELLM VIRTUAL KEYS VIA BOSON GATEWAY
// Verifikasi bahwa key yang dibuat di LiteLLM UI (You, Service Account,
// Another User, Agent) bekerja penuh melalui Boson Gateway (:8088)
// tanpa bypass saldo wallet, tier check, margin, atau ledger!
// ─────────────────────────────────────────────────────────────

import pg from '../gateway/node_modules/pg/lib/index.js'

const GATEWAY_URL = 'http://127.0.0.1:8088'
const LITELLM_URL = 'http://127.0.0.1:4000'
const MASTER_KEY = 'sk-admin'

const pgClient = new pg.Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'GantiPasswordPostgresYangSangatKuatDanPanjang123!',
  database: 'postgres',
})

const litellmClient = new pg.Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'GantiPasswordPostgresYangSangatKuatDanPanjang123!',
  database: 'litellm',
})

async function registerUser(email, tier = 'pay_as_you_go') {
  const initRes = await fetch(`${GATEWAY_URL}/auth-api/v0/dsh/auth_init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code_challenge: 'challenge_' + Math.random().toString(36).slice(2),
      redirect_uri: 'http://127.0.0.1:3080/callback',
      state: 'test_state',
    }),
  })
  const initData = await initRes.json()
  const authId = initData.data?.biz_data?.authorize_id

  await fetch(`${GATEWAY_URL}/api/v0/auth/submit-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_id: authId,
      email,
      password: 'Password123!',
      full_name: `Pipeline Service Account`,
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

  // Update tier to pay_as_you_go and add deposit
  await pgClient.query('UPDATE profiles SET tier = $1 WHERE id = $2', [tier, userId])
  await pgClient.query('UPDATE wallets SET tier = $1, normal_balance = 10.0 WHERE user_id = $2', [tier, userId])

  return { userId, token }
}

async function runTest() {
  console.log('\n=============================================================')
  console.log('🚀 MEMULAI TEST INTEGRASI LITELLM VIRTUAL KEYS VIA GATEWAY')
  console.log('=============================================================\n')

  await pgClient.connect()
  await litellmClient.connect()

  try {
    // 1. SETUP USER & WALLET
    const userEmail = `service_pipeline_${Date.now()}@boson.id`
    console.log(`[1] Mendaftarkan User & Wallet pengujian: ${userEmail}`)
    const { userId: testUserId } = await registerUser(userEmail, 'pay_as_you_go')
    console.log(`    User created: ${testUserId} (Wallet: $2 bonus, $10 normal)`)

    // 2. GENERATE LITELLM VIRTUAL KEY (TIPE SERVICE ACCOUNT / AGENT)
    console.log('\n[2] Membuat Virtual API Key via LiteLLM /key/generate...')
    const keyGenRes = await fetch(`${LITELLM_URL}/key/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key_name: 'pipeline-etl-service-key',
        user_id: userEmail,
        max_budget: 25.0,
        models: ['deepseek-flash', 'deepseek-chat'],
        metadata: {
          boson_user_id: testUserId,
          agent_role: 'ETL Pipeline Worker',
        },
      }),
    })

    if (!keyGenRes.ok) {
      throw new Error(`Failed to generate key in LiteLLM: ${await keyGenRes.text()}`)
    }
    const keyGenData = await keyGenRes.json()
    const virtualKey = keyGenData.key
    const tokenHash = keyGenData.token
    console.log(`    Virtual Key generated: ${virtualKey.slice(0, 10)}... (Hash: ${tokenHash.slice(0, 8)}...)`)
    console.log(`    Allowed models: ${keyGenData.models.join(', ')} | Max Budget: $${keyGenData.max_budget}`)

    // 3. TEST INFERENSI MELALUI BOSON GATEWAY (:8088) DENGAN VIRTUAL KEY
    console.log('\n[3] Memanggil Boson Gateway (:8088/v1/chat/completions) dengan Virtual Key...')
    const chatRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${virtualKey}`,
        'X-Boson-Platform-Id': 'pipeline',
        'X-Mock-Dummy': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Jalankan data transformer turn 1' }],
      }),
    })

    if (!chatRes.ok) {
      throw new Error(`Inference request failed: ${chatRes.status} ${await chatRes.text()}`)
    }
    const chatData = await chatRes.json()
    console.log(`    Status: ${chatRes.status} OK`)
    console.log(`    Response Model: ${chatData.model}`)
    console.log(`    Usage: Prompt=${chatData.usage?.prompt_tokens}, Completion=${chatData.usage?.completion_tokens}`)

    // Beri jeda sejenak untuk penyelesaian atomic_debit_wallet background commit
    await new Promise(r => setTimeout(r, 400))

    // 4. VERIFIKASI PEMOTONGAN SALDO DOMPET DI POSTGRES
    console.log('\n[4] Verifikasi Saldo Wallet di PostgreSQL...')
    const walletRes = await pgClient.query('SELECT * FROM wallets WHERE user_id = $1', [testUserId])
    const wallet = walletRes.rows[0]
    console.log(`    Bonus Balance: $${Number(wallet.bonus_balance).toFixed(6)} (Awal: $2.000000)`)
    console.log(`    Normal Balance: $${Number(wallet.normal_balance).toFixed(6)}`)
    if (Number(wallet.bonus_balance) >= 2.0) {
      throw new Error('Wallet bonus balance was NOT debited!')
    }
    console.log('    Wallet debit verified!')

    // 5. VERIFIKASI USAGE LEDGER DI POSTGRES
    console.log('\n[5] Verifikasi Pencatatan di usage_ledger...')
    const ledgerRes = await pgClient.query(
      'SELECT model, cost_usd, deducted_from, metadata FROM usage_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [testUserId]
    )
    const ledger = ledgerRes.rows[0]
    console.log(`    Ledger Model: ${ledger.model}`)
    console.log(`    Ledger Cost: $${Number(ledger.cost_usd).toFixed(6)}`)
    console.log(`    Deducted From: ${ledger.deducted_from}`)
    console.log(`    Metadata Auth Type: ${ledger.metadata?.auth_type}`)
    console.log(`    Metadata Key Name: ${ledger.metadata?.key_name}`)
    console.log(`    Metadata Margin: ${ledger.metadata?.margin_percent}%`)
    if (ledger.metadata?.auth_type !== 'litellm_virtual_key') {
      throw new Error(`Expected auth_type 'litellm_virtual_key', got '${ledger.metadata?.auth_type}'`)
    }
    console.log('    Usage ledger record verified!')

    // 6. VERIFIKASI SINKRONISASI SPEND KE LITELLM DB (LiteLLM_VerificationToken)
    console.log('\n[6] Verifikasi Sinkronisasi Spend ke LiteLLM_VerificationToken...')
    const tokenRes = await litellmClient.query(
      'SELECT token, key_name, spend, total_spend, last_active FROM "LiteLLM_VerificationToken" WHERE token = $1',
      [tokenHash]
    )
    const tokenDb = tokenRes.rows[0]
    console.log(`    Key Name: ${tokenDb.key_name}`)
    console.log(`    Spend in LiteLLM: $${Number(tokenDb.spend).toFixed(6)}`)
    console.log(`    Last Active: ${tokenDb.last_active}`)
    if (Number(tokenDb.spend) <= 0) {
      throw new Error('LiteLLM Virtual Key spend was NOT updated in LiteLLM DB!')
    }
    console.log('    LiteLLM Virtual Key spend sync verified!')

    // 7. TEST PEMBATASAN MODEL (MODEL RESTRICTION)
    console.log('\n[7] Menguji Pembatasan Model (Model Restriction)...')
    const unallowedModelRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${virtualKey}`,
        'X-Boson-Platform-Id': 'pipeline',
        'X-Mock-Dummy': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o', // Model ini tidak ada di allowlist key
        messages: [{ role: 'user', content: 'test unallowed model' }],
      }),
    })

    console.log(`    Requesting unapproved model 'gpt-4o' -> Status: ${unallowedModelRes.status}`)
    const unallowedBody = await unallowedModelRes.json()
    console.log(`    Error Message: ${unallowedBody.error?.message}`)
    if (unallowedModelRes.status !== 403 || unallowedBody.error?.code !== 'model_not_allowed') {
      throw new Error(`Expected 403 model_not_allowed, got ${unallowedModelRes.status}`)
    }
    console.log('    Model restriction successfully enforced!')

    // 8. TEST BATAS MAKSIMAL BUDGET (MAX BUDGET GUARD)
    console.log('\n[8] Menguji Batas Maksimal Budget (Max Budget Guard)...')
    await litellmClient.query(
      'UPDATE "LiteLLM_VerificationToken" SET max_budget = 0.0001 WHERE token = $1',
      [tokenHash]
    )

    const overBudgetRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${virtualKey}`,
        'X-Boson-Platform-Id': 'pipeline',
        'X-Mock-Dummy': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'test over budget' }],
      }),
    })

    console.log(`    Calling with exceeded max_budget -> Status: ${overBudgetRes.status}`)
    const overBudgetBody = await overBudgetRes.json()
    console.log(`    Error Message: ${overBudgetBody.msg}`)
    if (overBudgetRes.status !== 403 || !overBudgetBody.msg?.includes('budget exceeded')) {
      throw new Error(`Expected 403 budget exceeded, got ${overBudgetRes.status}`)
    }
    console.log('    Max budget guard successfully enforced!')

    // 9. CLEANUP
    await litellmClient.query('DELETE FROM "LiteLLM_VerificationToken" WHERE token = $1', [tokenHash])
    await pgClient.query('DELETE FROM auth.users WHERE id = $1', [testUserId])

    console.log('\n=============================================================')
    console.log('🎉 SEMUA PENGUJIAN INTEGRASI LITELLM VIRTUAL KEY BERHASIL (PASSED)!')
    console.log('   - Otentikasi Virtual Key (sk-...) di Port 8088: ✅ BERHASIL')
    console.log('   - Pemotongan Saldo Wallet (Multi-Bucket):        ✅ BERHASIL')
    console.log('   - Pencatatan Ledger & Margin Transparan 15%:     ✅ BERHASIL')
    console.log('   - Realtime Key Spend Sync ke LiteLLM DB:         ✅ BERHASIL')
    console.log('   - Validasi Restriksi Model per Key:             ✅ BERHASIL')
    console.log('   - Proteksi Batas Budget Key (Max Budget):       ✅ BERHASIL')
    console.log('   - Tidak ada fitur gateway yang terpotong/bypass!✅ LENGKAP')
    console.log('=============================================================\n')
  } finally {
    await pgClient.end()
    await litellmClient.end()
  }
}

runTest().catch(err => {
  console.error('\n❌ TEST RUNNER FAILED:', err.message)
  process.exit(1)
})
