/**
 * Double-Bucket Ledger untuk Boson Gateway.
 *
 * Menyelesaikan Bug #3 & #4 dari Audit:
 * 1. Memisahkan 'subscription_quota' (reset 30 hari) dari 'deposit_balance' (top-up cadangan).
 * 2. Saat reset 30 hari tiba, kuota bulanan kembali ke limit dasar, TETAPI saldo deposit TIDAK hilang!
 * 3. Saat deposit hangus, hanya deposit yang tidak bisa dipakai; kuota langganan TETAP aktif!
 * 4. Prioritas pemotongan: Kuota langganan dipakai lebih dulu, baru saldo deposit.
 * 5. Pencatatan transaksi audit append-only yang immutable.
 */

import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import type { TenantRecord, TenantBalanceView, BillingTransaction, PlanType } from './types.ts'

export class DoubleBucketLedger {
  private db: DatabaseSync

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath)
    this.initTables()
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        api_key TEXT UNIQUE NOT NULL,
        plan_type TEXT NOT NULL,
        subscription_quota_usd REAL DEFAULT 0,
        subscription_spent_usd REAL DEFAULT 0,
        subscription_cycle_start TEXT NOT NULL,
        subscription_cycle_days INTEGER DEFAULT 30,
        deposit_balance_usd REAL DEFAULT 0,
        deposit_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        actual_cost_usd REAL NOT NULL,
        billed_cost_usd REAL NOT NULL,
        profit_usd REAL NOT NULL,
        deducted_subscription_usd REAL NOT NULL,
        deducted_deposit_usd REAL NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY(tenant_id) REFERENCES tenants(tenant_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);
      CREATE INDEX IF NOT EXISTS idx_transactions_tenant ON transactions(tenant_id);
    `)
  }

  /**
   * Helper untuk membuat API Key unik yang aman secara kriptografis.
   */
  public generateApiKey(prefix: string = 'sk-boson'): string {
    return `${prefix}-${crypto.randomBytes(24).toString('hex')}`
  }

  /**
   * Daftarkan atau perbarui Langganan Bulanan (Subscription Bucket).
   * TIDAK mengganggu saldo deposit yang sudah ada sebelumnya.
   */
  public setSubscription(
    tenantId: string,
    monthlyQuotaUsd: number,
    cycleDays: number = 30,
    customApiKey?: string,
  ): TenantRecord {
    const now = new Date().toISOString()
    const existing = this.getTenantRaw(tenantId)

    if (existing) {
      // Perbarui kuota bulanan tanpa menghapus deposit balance
      const newPlanType: PlanType = existing.depositBalanceUsd > 0 ? 'hybrid' : 'subscription'
      this.db
        .prepare(`
          UPDATE tenants
          SET subscription_quota_usd = ?,
              subscription_cycle_days = ?,
              plan_type = ?,
              updated_at = ?
          WHERE tenant_id = ?
        `)
        .run(monthlyQuotaUsd, cycleDays, newPlanType, now, tenantId)

      return this.getTenantRaw(tenantId)!
    } else {
      // Buat tenant baru
      const apiKey = customApiKey ?? this.generateApiKey()
      this.db
        .prepare(`
          INSERT INTO tenants (
            tenant_id, api_key, plan_type,
            subscription_quota_usd, subscription_spent_usd,
            subscription_cycle_start, subscription_cycle_days,
            deposit_balance_usd, deposit_expires_at,
            created_at, updated_at
          ) VALUES (?, ?, 'subscription', ?, 0, ?, ?, 0, NULL, ?, ?)
        `)
        .run(tenantId, apiKey, monthlyQuotaUsd, now, cycleDays, now, now)

      return this.getTenantRaw(tenantId)!
    }
  }

  /**
   * Tambahkan Saldo Deposit (Deposit Bucket) dengan opsi masa hangus.
   * TIDAK mereset atau menaikkan kuota langganan bulanan permanen.
   */
  public addDeposit(
    tenantId: string,
    depositAmountUsd: number,
    durationDays?: number | null,
    customApiKey?: string,
  ): TenantRecord {
    const now = new Date()
    const nowIso = now.toISOString()
    const existing = this.getTenantRaw(tenantId)

    let expiresAtIso: string | null = null
    if (durationDays && durationDays > 0) {
      const expDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000)
      expiresAtIso = expDate.toISOString()
    }

    if (existing) {
      const newDeposit = existing.depositBalanceUsd + depositAmountUsd
      const newPlanType: PlanType = existing.subscriptionQuotaUsd > 0 ? 'hybrid' : 'deposit'

      // Jika sebelumnya punya masa hangus dan sekarang ditambah durasi baru: perpanjang
      let finalExpires = expiresAtIso ?? existing.depositExpiresAt
      if (durationDays && existing.depositExpiresAt) {
        const currentExp = new Date(existing.depositExpiresAt).getTime()
        const newExp = now.getTime() + durationDays * 24 * 60 * 60 * 1000
        finalExpires = new Date(Math.max(currentExp, newExp)).toISOString()
      }

      this.db
        .prepare(`
          UPDATE tenants
          SET deposit_balance_usd = ?,
              deposit_expires_at = ?,
              plan_type = ?,
              updated_at = ?
          WHERE tenant_id = ?
        `)
        .run(newDeposit, finalExpires, newPlanType, nowIso, tenantId)

      return this.getTenantRaw(tenantId)!
    } else {
      const apiKey = customApiKey ?? this.generateApiKey()
      this.db
        .prepare(`
          INSERT INTO tenants (
            tenant_id, api_key, plan_type,
            subscription_quota_usd, subscription_spent_usd,
            subscription_cycle_start, subscription_cycle_days,
            deposit_balance_usd, deposit_expires_at,
            created_at, updated_at
          ) VALUES (?, ?, 'deposit', 0, 0, ?, 30, ?, ?, ?, ?)
        `)
        .run(tenantId, apiKey, nowIso, depositAmountUsd, expiresAtIso, nowIso, nowIso)

      return this.getTenantRaw(tenantId)!
    }
  }

  /**
   * Mengambil saldo tenant yang sudah dihitung status reset bulanan dan masa hangusnya.
   */
  public getBalance(tenantId: string): TenantBalanceView | null {
    const tenant = this.getTenantRaw(tenantId)
    if (!tenant) return null

    const now = Date.now()
    let spent = tenant.subscriptionSpentUsd
    let cycleStart = new Date(tenant.subscriptionCycleStart).getTime()
    const cycleMs = tenant.subscriptionCycleDays * 24 * 60 * 60 * 1000

    // 1. Cek Siklus Bulanan: Jika sudah lewat 30 hari, reset subscription spent!
    // Saldo deposit_balance_usd TETAP AMAN dan TIDAK TERSENTUH.
    if (tenant.subscriptionQuotaUsd > 0 && now >= cycleStart + cycleMs) {
      const cyclesPassed = Math.floor((now - cycleStart) / cycleMs)
      const newCycleStart = new Date(cycleStart + cyclesPassed * cycleMs).toISOString()
      spent = 0

      this.db
        .prepare(`
          UPDATE tenants
          SET subscription_spent_usd = 0,
              subscription_cycle_start = ?,
              updated_at = ?
          WHERE tenant_id = ?
        `)
        .run(newCycleStart, new Date().toISOString(), tenantId)

      cycleStart = new Date(newCycleStart).getTime()
    }

    const nextReset = new Date(cycleStart + cycleMs).toISOString()
    const subRemaining = Math.max(0, tenant.subscriptionQuotaUsd - spent)

    // 2. Cek Masa Hangus Deposit
    let depositRemaining = tenant.depositBalanceUsd
    let isDepositExpired = false
    if (tenant.depositExpiresAt) {
      const expiryTime = new Date(tenant.depositExpiresAt).getTime()
      if (now > expiryTime) {
        isDepositExpired = true
        depositRemaining = 0 // Tidak dapat dipakai lagi karena hangus
      }
    }

    const totalAvailable = subRemaining + depositRemaining

    return {
      tenantId: tenant.tenantId,
      planType: tenant.planType,
      subscriptionAllowanceUsd: tenant.subscriptionQuotaUsd,
      subscriptionSpentUsd: spent,
      subscriptionRemainingUsd: subRemaining,
      subscriptionCycleStart: new Date(cycleStart).toISOString(),
      subscriptionNextReset: nextReset,
      depositBalanceUsd: tenant.depositBalanceUsd,
      depositExpiresAt: tenant.depositExpiresAt,
      depositIsExpired: isDepositExpired,
      totalAvailableUsd: totalAvailable,
    }
  }

  /**
   * Potong Saldo secara Atomic (Priority: Subscription -> Deposit).
   */
  public deduct(
    tenantId: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    actualCostUsd: number,
    markupPercent: number = 30,
  ): { success: boolean; transaction?: BillingTransaction; error?: string } {
    const balance = this.getBalance(tenantId)
    if (!balance) return { success: false, error: 'Tenant tidak ditemukan' }

    const billedCost = actualCostUsd * (1 + markupPercent / 100)
    if (balance.totalAvailableUsd < billedCost) {
      return {
        success: false,
        error: `Saldo tidak mencukupi. Butuh: $${billedCost.toFixed(6)}, Tersedia: $${balance.totalAvailableUsd.toFixed(6)}`,
      }
    }

    let subDeduct = 0
    let depDeduct = 0
    let source: 'subscription' | 'deposit' | 'split' = 'subscription'

    if (balance.subscriptionRemainingUsd >= billedCost) {
      // 1. Seluruhnya dicover oleh Subscription Quota
      subDeduct = billedCost
      source = 'subscription'
    } else if (balance.subscriptionRemainingUsd > 0) {
      // 2. Split: Habiskan sisa Subscription Quota, sisanya dari Deposit
      subDeduct = balance.subscriptionRemainingUsd
      depDeduct = billedCost - subDeduct
      source = 'split'
    } else {
      // 3. Seluruhnya dari Deposit
      depDeduct = billedCost
      source = 'deposit'
    }

    const txId = `tx_${crypto.randomBytes(16).toString('hex')}`
    const nowIso = new Date().toISOString()
    const profit = billedCost - actualCostUsd

    // Update Atomic ke SQLite
    this.db.exec('BEGIN TRANSACTION')
    try {
      if (subDeduct > 0) {
        this.db
          .prepare(`
            UPDATE tenants
            SET subscription_spent_usd = subscription_spent_usd + ?,
                updated_at = ?
            WHERE tenant_id = ?
          `)
          .run(subDeduct, nowIso, tenantId)
      }

      if (depDeduct > 0) {
        this.db
          .prepare(`
            UPDATE tenants
            SET deposit_balance_usd = deposit_balance_usd - ?,
                updated_at = ?
            WHERE tenant_id = ?
          `)
          .run(depDeduct, nowIso, tenantId)
      }

      this.db
        .prepare(`
          INSERT INTO transactions (
            id, tenant_id, timestamp, model,
            prompt_tokens, completion_tokens,
            actual_cost_usd, billed_cost_usd, profit_usd,
            deducted_subscription_usd, deducted_deposit_usd,
            source, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')
        `)
        .run(
          txId,
          tenantId,
          nowIso,
          model,
          promptTokens,
          completionTokens,
          actualCostUsd,
          billedCost,
          profit,
          subDeduct,
          depDeduct,
          source,
        )

      this.db.exec('COMMIT')
    } catch (e: any) {
      this.db.exec('ROLLBACK')
      return { success: false, error: e.message }
    }

    const tx: BillingTransaction = {
      id: txId,
      tenantId,
      timestamp: nowIso,
      model,
      promptTokens,
      completionTokens,
      actualCostUsd,
      billedCostUsd: billedCost,
      profitUsd: profit,
      deductedSubscriptionUsd: subDeduct,
      deductedDepositUsd: depDeduct,
      source,
      status: 'success',
    }

    return { success: true, transaction: tx }
  }

  /**
   * Cari tenant berdasarkan Virtual API Key (yang dikirim client).
   */
  public findTenantByApiKey(apiKey: string): TenantRecord | null {
    const row: any = this.db.prepare('SELECT * FROM tenants WHERE api_key = ?').get(apiKey)
    if (!row) return null
    return this.mapRowToTenant(row)
  }

  public getTenantRaw(tenantId: string): TenantRecord | null {
    const row: any = this.db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(tenantId)
    if (!row) return null
    return this.mapRowToTenant(row)
  }

  public listTenants(): TenantRecord[] {
    const rows: any[] = this.db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all()
    return rows.map(r => this.mapRowToTenant(r))
  }

  public listTransactions(tenantId?: string, limit: number = 50): BillingTransaction[] {
    let query = 'SELECT * FROM transactions'
    const params: any[] = []
    if (tenantId) {
      query += ' WHERE tenant_id = ?'
      params.push(tenantId)
    }
    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(limit)

    const rows: any[] = this.db.prepare(query).all(...params)
    return rows.map((r: any) => ({
      id: r.id,
      tenantId: r.tenant_id,
      timestamp: r.timestamp,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      actualCostUsd: r.actual_cost_usd,
      billedCostUsd: r.billed_cost_usd,
      profitUsd: r.profit_usd,
      deductedSubscriptionUsd: r.deducted_subscription_usd,
      deductedDepositUsd: r.deducted_deposit_usd,
      source: r.source,
      status: r.status,
    }))
  }

  private mapRowToTenant(r: any): TenantRecord {
    return {
      tenantId: r.tenant_id,
      apiKey: r.api_key,
      planType: r.plan_type,
      subscriptionQuotaUsd: r.subscription_quota_usd,
      subscriptionSpentUsd: r.subscription_spent_usd,
      subscriptionCycleStart: r.subscription_cycle_start,
      subscriptionCycleDays: r.subscription_cycle_days,
      depositBalanceUsd: r.deposit_balance_usd,
      depositExpiresAt: r.deposit_expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  public close() {
    this.db.close()
  }
}
