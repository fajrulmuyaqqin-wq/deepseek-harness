/**
 * Unit & Integration Test Suite untuk Boson Gateway Backend:
 * Menguji Double-Bucket Ledger, Pemisahan Langganan vs Deposit, Masa Hangus,
 * Prioritas Pemotongan Saldo, dan Audit Log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DoubleBucketLedger } from '../src/ledger.ts'
import { PricingEngine } from '../src/pricing.ts'
import { createBosonGatewayServer } from '../src/server.ts'

describe('DoubleBucketLedger', () => {
  let ledger: DoubleBucketLedger

  beforeEach(() => {
    ledger = new DoubleBucketLedger(':memory:')
  })

  afterEach(() => {
    ledger.close()
  })

  it('1. Reset siklus bulanan mereset kuota langganan TETAPI menjaga saldo deposit', () => {
    // 1. Daftarkan langganan bulanan $20/bln
    ledger.setSubscription('tenant_test_1', 20.0, 30)

    // 2. Tambah deposit topup $15 (tanpa masa hangus)
    ledger.addDeposit('tenant_test_1', 15.0)

    let balance = ledger.getBalance('tenant_test_1')!
    expect(balance.planType).toBe('hybrid')
    expect(balance.subscriptionAllowanceUsd).toBe(20.0)
    expect(balance.subscriptionRemainingUsd).toBe(20.0)
    expect(balance.depositBalanceUsd).toBe(15.0)
    expect(balance.totalAvailableUsd).toBe(35.0)

    // 3. Pakai $18 dari kuota langganan
    const deductRes = ledger.deduct('tenant_test_1', 'deepseek-v3', 1000, 500, 13.846, 30) // billed = 18.0
    expect(deductRes.success).toBe(true)
    expect(deductRes.transaction?.source).toBe('subscription')

    balance = ledger.getBalance('tenant_test_1')!
    expect(balance.subscriptionRemainingUsd).toBeCloseTo(2.0, 2)
    expect(balance.depositBalanceUsd).toBe(15.0)
    expect(balance.totalAvailableUsd).toBeCloseTo(17.0, 2)

    // 4. Simulasi waktu berjalan 31 hari ke depan (melewati siklus 30 hari)
    const pastDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    // Update langsung cycle_start ke masa lalu
    ;(ledger as any).db
      .prepare('UPDATE tenants SET subscription_cycle_start = ? WHERE tenant_id = ?')
      .run(pastDate, 'tenant_test_1')

    // 5. Cek saldo sekarang: Kuota langganan harus reset kembali ke $20 PENUH,
    // dan saldo deposit HARUS TETAP $15 (tidak terhapus dan tidak tertumpuk permanen)!
    const resetBalance = ledger.getBalance('tenant_test_1')!
    expect(resetBalance.subscriptionSpentUsd).toBe(0)
    expect(resetBalance.subscriptionRemainingUsd).toBe(20.0)
    expect(resetBalance.depositBalanceUsd).toBe(15.0)
    expect(resetBalance.totalAvailableUsd).toBe(35.0)
  })

  it('2. Deposit dengan masa hangus kedaluwarsa tanpa merusak kuota langganan', () => {
    ledger.setSubscription('tenant_test_2', 10.0, 30)

    // Tambah deposit $25 dengan masa hangus 30 hari
    ledger.addDeposit('tenant_test_2', 25.0, 30)

    let balance = ledger.getBalance('tenant_test_2')!
    expect(balance.depositIsExpired).toBe(false)
    expect(balance.totalAvailableUsd).toBe(35.0)

    // Simulasi masa hangus lewat (disetel kemarin)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    ;(ledger as any).db
      .prepare('UPDATE tenants SET deposit_expires_at = ? WHERE tenant_id = ?')
      .run(yesterday, 'tenant_test_2')

    const expiredBalance = ledger.getBalance('tenant_test_2')!
    expect(expiredBalance.depositIsExpired).toBe(true)
    // Deposit yang hangus tidak boleh bisa dipakai:
    expect(expiredBalance.totalAvailableUsd).toBe(10.0) // Hanya tersisa kuota langganan $10
  })

  it('3. Prioritas pemotongan saldo: Langganan -> Split -> Deposit', () => {
    ledger.setSubscription('tenant_test_3', 10.0)
    ledger.addDeposit('tenant_test_3', 15.0)

    // Turn A: Butuh $6 -> 100% dari Subscription
    const resA = ledger.deduct('tenant_test_3', 'deepseek-v3', 1000, 500, 4.61538, 30) // billed = 6.0
    expect(resA.success).toBe(true)
    expect(resA.transaction?.source).toBe('subscription')
    expect(resA.transaction?.deductedSubscriptionUsd).toBeCloseTo(6.0, 2)
    expect(resA.transaction?.deductedDepositUsd).toBe(0)

    // Turn B: Butuh $7 -> Split: $4 sisa Subscription + $3 dari Deposit
    const resB = ledger.deduct('tenant_test_3', 'deepseek-v3', 1000, 500, 5.38461, 30) // billed = 7.0
    expect(resB.success).toBe(true)
    expect(resB.transaction?.source).toBe('split')
    expect(resB.transaction?.deductedSubscriptionUsd).toBeCloseTo(4.0, 2)
    expect(resB.transaction?.deductedDepositUsd).toBeCloseTo(3.0, 2)

    // Turn C: Butuh $10 -> 100% dari Deposit (sisa deposit sebelumnya $12 -> jadi $2)
    const resC = ledger.deduct('tenant_test_3', 'deepseek-v3', 1000, 500, 7.6923, 30) // billed = 10.0
    expect(resC.success).toBe(true)
    expect(resC.transaction?.source).toBe('deposit')
    expect(resC.transaction?.deductedDepositUsd).toBeCloseTo(10.0, 2)

    // Turn D: Butuh $5 -> Saldo hanya sisa $2 -> GAGAL 402
    const resD = ledger.deduct('tenant_test_3', 'deepseek-v3', 1000, 500, 3.846, 30) // billed = 5.0
    expect(resD.success).toBe(false)
    expect(resD.error).toContain('Saldo tidak mencukupi')
  })

  it('4. Audit log mencatat histori transaksi dan profit margin dengan presisi', () => {
    ledger.addDeposit('tenant_audit', 50.0)

    ledger.deduct('tenant_audit', 'deepseek-v3', 5000, 1000, 1.0, 30) // modal $1.0, jual $1.3, profit $0.3
    const txs = ledger.listTransactions('tenant_audit')

    expect(txs.length).toBe(1)
    expect(txs[0].actualCostUsd).toBe(1.0)
    expect(txs[0].billedCostUsd).toBe(1.3)
    expect(txs[0].profitUsd).toBeCloseTo(0.3, 4)
    expect(txs[0].status).toBe('success')
  })
})

describe('BosonGatewayServer Endpoints', () => {
  let instance: ReturnType<typeof createBosonGatewayServer>
  let baseUrl: string
  const MASTER_KEY = 'sk-test-master-admin-key'

  beforeEach(async () => {
    instance = createBosonGatewayServer({
      port: 0, // Port dinamis (ephemeral)
      host: '127.0.0.1',
      dbPath: ':memory:',
      masterKey: MASTER_KEY,
      allowedOrigins: ['https://app.yourdomain.com'],
    })
    await instance.listen()
    baseUrl = `http://127.0.0.1:${instance.getPort()}`
  })

  afterEach(async () => {
    await instance.close()
  })

  it('GET /health mengembalikan 200 healthy', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('healthy')
  })

  it('Proteksi Origin menolak domain asing dengan 403', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://attacker-domain.com' },
    })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toContain('Origin domain tidak diizinkan')
  })

  it('Admin API memerlukan Master Key yang valid', async () => {
    // 1. Tanpa auth -> 401
    const unauthRes = await fetch(`${baseUrl}/api/admin/tenants`)
    expect(unauthRes.status).toBe(401)

    // 2. Auth salah -> 401
    const wrongAuthRes = await fetch(`${baseUrl}/api/admin/tenants`, {
      headers: { Authorization: 'Bearer wrong-key' },
    })
    expect(wrongAuthRes.status).toBe(401)

    // 3. Auth benar -> 200
    const authRes = await fetch(`${baseUrl}/api/admin/tenants`, {
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    })
    expect(authRes.status).toBe(200)
  })

  it('Alur Admin: Daftarkan tenant via REST API dan cek saldo', async () => {
    // 1. Admin buat langganan $25
    const createRes = await fetch(`${baseUrl}/api/admin/tenants/subscription`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MASTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'user_rest_1',
        monthlyQuotaUsd: 25.0,
      }),
    })
    expect(createRes.status).toBe(200)
    const createJson = await createRes.json()
    const apiKey = createJson.tenant.apiKey
    expect(apiKey).toBeDefined()

    // 2. Tenant cek saldo sendiri menggunakan Virtual Key mereka
    const balanceRes = await fetch(`${baseUrl}/api/tenant/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(balanceRes.status).toBe(200)
    const balanceJson = await balanceRes.json()
    expect(balanceJson.balance.subscriptionAllowanceUsd).toBe(25.0)
    expect(balanceJson.balance.totalAvailableUsd).toBe(25.0)
  })
})
