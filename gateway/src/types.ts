/**
 * Tipe data untuk sistem Boson Gateway Backend & Double-Bucket Ledger.
 */

export type PlanType = 'subscription' | 'deposit' | 'hybrid'

export interface TenantRecord {
  tenantId: string
  apiKey: string
  planType: PlanType
  subscriptionQuotaUsd: number
  subscriptionSpentUsd: number
  subscriptionCycleStart: string
  subscriptionCycleDays: number
  depositBalanceUsd: number
  depositExpiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TenantBalanceView {
  tenantId: string
  planType: PlanType
  subscriptionAllowanceUsd: number
  subscriptionSpentUsd: number
  subscriptionRemainingUsd: number
  subscriptionCycleStart: string
  subscriptionNextReset: string
  depositBalanceUsd: number
  depositExpiresAt: string | null
  depositIsExpired: boolean
  totalAvailableUsd: number
}

export interface BillingTransaction {
  id: string
  tenantId: string
  timestamp: string
  model: string
  promptTokens: number
  completionTokens: number
  actualCostUsd: number
  billedCostUsd: number
  profitUsd: number
  deductedSubscriptionUsd: number
  deductedDepositUsd: number
  source: 'subscription' | 'deposit' | 'split'
  status: 'success' | 'failed' | 'refunded'
}

export interface ModelPricing {
  modalPromptPer1M: number
  modalCompletionPer1M: number
  defaultMarkupPercent: number
}
