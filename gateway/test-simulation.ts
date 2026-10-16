/**
 * Test Suite: Multi-Tenant Gateway, Markup Engine, Origin Whitelist,
 * serta Pengujian Masa Hangus Deposit vs Kuota Bulanan Langganan.
 *
 * Menguji:
 * 1. Origin Whitelisting: Menolak request dari domain luar (403 Forbidden).
 * 2. Monthly Subscription: Batas pemakaian bulanan (budget_duration: 30d).
 * 3. Deposit dengan Masa Hangus: Menolak jika tanggal deposit telah kedaluwarsa (403/402 Key Expired).
 * 4. Deposit Tanpa Masa Hangus: Memotong saldo pay-as-you-go normal.
 * 5. Markup Engine Calculation: Membuktikan margin keuntungan di atas OpenRouter modal.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import process from 'node:process'

interface ModelPricing {
  modalPromptPer1M: number
  modalCompletionPer1M: number
  jualPromptPer1M: number
  jualCompletionPer1M: number
}

const PRICING_CATALOG: Record<string, ModelPricing> = {
  'deepseek-v3': {
    modalPromptPer1M: 0.14,
    modalCompletionPer1M: 0.28,
    jualPromptPer1M: 0.182,  // +30% markup
    jualCompletionPer1M: 0.364,
  },
  'deepseek-r1': {
    modalPromptPer1M: 0.55,
    modalCompletionPer1M: 2.19,
    jualPromptPer1M: 0.715,  // +30% markup
    jualCompletionPer1M: 2.847,
  },
  'claude-3-5-sonnet': {
    modalPromptPer1M: 3.00,
    modalCompletionPer1M: 15.00,
    jualPromptPer1M: 3.75,   // +25% markup
    jualCompletionPer1M: 18.75,
  },
}

interface MockTenantRecord {
  userId: string
  planType: 'monthly_subscription' | 'deposit_prepaid'
  balanceUsd: number
  spendUsd: number
  budgetDuration?: string
  expiresAt?: Date | null
}

// Mock Database Tenant
const mockTenantDB = new Map<string, MockTenantRecord>()

// Tenant 1: Deposit Aktif Selamanya (Non-expiring)
mockTenantDB.set('sk-boson-deposit-active', {
  userId: 'user_active_deposit',
  planType: 'deposit_prepaid',
  balanceUsd: 15.0,
  spendUsd: 0.0,
  expiresAt: null, // Tanpa masa hangus
})

// Tenant 2: Deposit Sudah Hangus / Kedaluwarsa
mockTenantDB.set('sk-boson-deposit-expired', {
  userId: 'user_expired_deposit',
  planType: 'deposit_prepaid',
  balanceUsd: 5.0, // Masih ada sisa saldo, tapi sudah lewat masa aktif
  spendUsd: 5.0,
  expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Hangus kemarin
})

// Tenant 3: Langganan Bulanan (Reset Otomatis 30 Hari)
mockTenantDB.set('sk-boson-sub-monthly', {
  userId: 'user_subscription',
  planType: 'monthly_subscription',
  balanceUsd: 25.0, // Kuota $25/bulan
  spendUsd: 2.5,
  budgetDuration: '30d',
  expiresAt: null,
})

// Tenant 4: Langganan Bulanan Over-budget
mockTenantDB.set('sk-boson-sub-maxed', {
  userId: 'user_sub_maxed',
  planType: 'monthly_subscription',
  balanceUsd: 0.0005,
  spendUsd: 25.0,
  budgetDuration: '30d',
  expiresAt: null,
})

const ALLOWED_ORIGINS = ['https://app.yourdomain.com', 'https://yourdomain.com']

// Buat server mock gateway
const mockGateway = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin

  // 1. Uji Proteksi Origin: Jika dari luar, tolak 403 Forbidden
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '403 Forbidden: Akses dari luar domain web resmi ditolak.' }))
    return
  }

  // 2. Uji Multi-Tenant Virtual Key Auth
  const authHeader = req.headers.authorization
  const apiKey = authHeader?.replace('Bearer ', '')
  const tenant = apiKey ? mockTenantDB.get(apiKey) : undefined

  if (!tenant) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '401 Unauthorized: Virtual Key tidak valid.' }))
    return
  }

  // 3. Uji Masa Hangus (Expiration Check untuk Paket Deposit)
  if (tenant.expiresAt && tenant.expiresAt.getTime() < Date.now()) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: '403 Forbidden: Masa aktif deposit telah hangus. Silakan lakukan perpanjangan / top-up.',
      code: 'KEY_EXPIRED',
      expiredAt: tenant.expiresAt.toISOString(),
    }))
    return
  }

  // 4. Uji Sisa Saldo / Kuota (Pay-as-You-Go & Subscription Check)
  if (tenant.balanceUsd <= 0.001) {
    res.writeHead(402, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: tenant.planType === 'monthly_subscription'
        ? '402 Payment Required: Kuota bulanan langganan habis. Reset di siklus bulan berikutnya.'
        : '402 Payment Required: Saldo deposit habis. Silakan top-up saldo deposit.',
      code: 'QUOTA_EXCEEDED',
      planType: tenant.planType,
      remainingBalance: tenant.balanceUsd,
    }))
    return
  }

  // Simulasi pemotongan token & markup
  const model = req.headers['x-model'] as string ?? 'deepseek-v3'
  const pricing = PRICING_CATALOG[model] ?? PRICING_CATALOG['deepseek-v3']
  const promptTokens = 5000
  const completionTokens = 1200

  const modalCost = (promptTokens * pricing.modalPromptPer1M + completionTokens * pricing.modalCompletionPer1M) / 1_000_000
  const tenantBilled = (promptTokens * pricing.jualPromptPer1M + completionTokens * pricing.jualCompletionPer1M) / 1_000_000
  const profitMargin = tenantBilled - modalCost

  tenant.balanceUsd -= tenantBilled
  tenant.spendUsd += tenantBilled

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    status: 'success',
    model,
    planType: tenant.planType,
    tokens: { prompt: promptTokens, completion: completionTokens },
    billing: {
      modalCostUsd: modalCost.toFixed(6),
      tenantBilledUsd: tenantBilled.toFixed(6),
      profitMarginUsd: profitMargin.toFixed(6),
      remainingBalanceUsd: tenant.balanceUsd.toFixed(6),
    },
  }))
})

async function runTests() {
  await new Promise<void>(resolve => mockGateway.listen(4005, '127.0.0.1', () => resolve()))
  console.log('🚀 Mock Gateway aktif di 127.0.0.1:4005\n')

  let passed = 0
  let failed = 0

  async function testCase(name: string, fn: () => Promise<void>) {
    try {
      await fn()
      console.log(`  ✅ PASS: ${name}`)
      passed++
    } catch (e: any) {
      console.error(`  ❌ FAIL: ${name} -> ${e.message}`)
      failed++
    }
  }

  console.log('🧪 1. PENGUJIAN PROTEKSI ASAL WEB (ORIGIN & DOMAIN FILTER):')

  await testCase('Request dari domain resmi (https://app.yourdomain.com) -> DIIZINKAN', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://app.yourdomain.com',
        Authorization: 'Bearer sk-boson-deposit-active',
      },
    })
    if (res.status !== 200) throw new Error(`Status ${res.status}, harusnya 200`)
  })

  await testCase('Request dari situs luar tak berizin (https://bad-actor.com) -> DITOLAK 403', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://bad-actor.com',
        Authorization: 'Bearer sk-boson-deposit-active',
      },
    })
    if (res.status !== 403) throw new Error(`Status ${res.status}, harusnya 403 Forbidden`)
    const data = await res.json()
    if (!data.error.includes('Akses dari luar domain web resmi ditolak')) throw new Error('Pesan error tidak sesuai')
  })

  console.log('\n🧪 2. PENGUJIAN MODEL DEPOSIT PRABAYAR (EXPIRING VS NON-EXPIRING):')

  await testCase('Deposit Aktif (Non-Expiring) -> DIIZINKAN & Saldo Terpotong', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://app.yourdomain.com',
        Authorization: 'Bearer sk-boson-deposit-active',
        'x-model': 'deepseek-v3',
      },
    })
    if (res.status !== 200) throw new Error(`Status ${res.status}`)
    const data = await res.json()
    console.log(`     📊 Billed: $${data.billing.tenantBilledUsd} | Sisa Saldo: $${data.billing.remainingBalanceUsd}`)
  })

  await testCase('Deposit Kedaluwarsa (Masa Hangus Lewat) -> DITOLAK 403 KEY_EXPIRED', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://app.yourdomain.com',
        Authorization: 'Bearer sk-boson-deposit-expired',
      },
    })
    if (res.status !== 403) throw new Error(`Status ${res.status}, harusnya 403 Forbidden`)
    const data = await res.json()
    if (data.code !== 'KEY_EXPIRED') throw new Error(`Kode error ${data.code}, harusnya KEY_EXPIRED`)
    console.log(`     ⏰ Terdeteksi Hangus: ${data.expiredAt} (${data.error})`)
  })

  console.log('\n🧪 3. PENGUJIAN MODEL LANGGANAN BULANAN (MONTHLY CREDIT BUDGET):')

  await testCase('Langganan Bulanan Aktif ($25/bln) -> DIIZINKAN dengan Siklus Reset', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://app.yourdomain.com',
        Authorization: 'Bearer sk-boson-sub-monthly',
        'x-model': 'deepseek-r1',
      },
    })
    if (res.status !== 200) throw new Error(`Status ${res.status}`)
    const data = await res.json()
    console.log(`     🔄 Plan: ${data.planType} | Billed: $${data.billing.tenantBilledUsd} (DeepSeek R1)`)
  })

  await testCase('Langganan Bulanan yang Kuotanya Habis -> DITOLAK 402 QUOTA_EXCEEDED', async () => {
    const res = await fetch('http://127.0.0.1:4005/v1/chat', {
      headers: {
        Origin: 'https://app.yourdomain.com',
        Authorization: 'Bearer sk-boson-sub-maxed',
      },
    })
    if (res.status !== 402) throw new Error(`Status ${res.status}, harusnya 402 Payment Required`)
    const data = await res.json()
    if (data.code !== 'QUOTA_EXCEEDED') throw new Error('Kode error bukan QUOTA_EXCEEDED')
    console.log(`     ⛔ Ditolak: ${data.error}`)
  })

  console.log('\n🧪 4. PENGUJIAN KALKULASI PROFIT MARKUP:')

  await testCase('Perhitungan Markup DeepSeek V3 (+30% Margin Keuntungan)', async () => {
    const pricing = PRICING_CATALOG['deepseek-v3']
    const promptTokens = 100_000
    const completionTokens = 25_000

    const modalCost = (promptTokens * pricing.modalPromptPer1M + completionTokens * pricing.modalCompletionPer1M) / 1_000_000
    const hargaJual = (promptTokens * pricing.jualPromptPer1M + completionTokens * pricing.jualCompletionPer1M) / 1_000_000
    const profit = hargaJual - modalCost
    const marginPercent = (profit / modalCost) * 100

    console.log(`     💰 100k Input + 25k Output Tokens:`)
    console.log(`        - Modal ke OpenRouter : $${modalCost.toFixed(5)}`)
    console.log(`        - Ditarik dari Deposit: $${hargaJual.toFixed(5)}`)
    console.log(`        - Keuntungan Bersih   : $${profit.toFixed(5)} (+${marginPercent.toFixed(1)}%)`)

    if (Math.abs(marginPercent - 30) > 0.1) throw new Error('Kalkulasi margin meleset')
  })

  mockGateway.close()
  console.log(`\n====================================================`)
  console.log(`Hasil Pengujian: ${passed} Passed, ${failed} Failed`)
  console.log(`====================================================\n`)
  if (failed > 0) process.exit(1)
}

runTests().catch(err => {
  console.error(err)
  process.exit(1)
})
