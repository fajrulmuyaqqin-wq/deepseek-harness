// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: LITELLM BUDGET & TIER SYNCHRONIZATION ENGINE
// Menghubungkan paket langganan (tier_rules) di Database & Gateway
// secara otomatis ke sistem LiteLLM Budgets (/budget & /customer)
// ─────────────────────────────────────────────────────────────

import pg from 'pg'
import { createHash } from 'crypto'

const litellmDbPool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'bosonsecretpassword',
  database: 'litellm',
  max: 5,
})
litellmDbPool.on('error', err => console.warn('[BudgetSync litellmDbPool error]:', err.message))

const LITELLM_URL = process.env.DEEPSEEK_UPSTREAM || 'http://litellm:4000'
const LITELLM_KEY = process.env.DEEPSEEK_API_KEY || 'sk-admin'

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LITELLM_KEY}`,
  }
}

// Fallback tier budget definitions jika database belum selesai di-load
export const DEFAULT_TIER_BUDGETS = {
  free: {
    budget_id: 'tier_free',
    name: 'Free Community Tier',
    max_budget: 0.50,
    budget_duration: '30d',
    rpm_limit: 20,
    max_parallel_requests: 3,
    allowed_models: ['deepseek-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'llama-3.3-70b-free', 'deepseek-chat'],
  },
  lite: {
    budget_id: 'tier_lite',
    name: 'Developer Lite',
    max_budget: 5.00,
    budget_duration: '30d',
    rpm_limit: 30,
    max_parallel_requests: 5,
    allowed_models: ['deepseek-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gpt-4o-mini', 'llama-3.3-70b-free'],
  },
  plus: {
    budget_id: 'tier_plus',
    name: 'Creator Plus',
    max_budget: 10.00,
    budget_duration: '30d',
    rpm_limit: 60,
    max_parallel_requests: 10,
    allowed_models: ['deepseek-flash', 'deepseek-chat', 'gemini-2.5-flash', 'gpt-4o-mini', 'claude-3-5-haiku', 'llama-3.3-70b-free'],
  },
  pro: {
    budget_id: 'tier_pro',
    name: 'Agentic Pro',
    max_budget: 20.00,
    budget_duration: '30d',
    rpm_limit: 120,
    max_parallel_requests: 15,
    allowed_models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner', 'claude-3-5-sonnet', 'gpt-4o', 'gemini-2.5-flash', 'llama-3.3-70b-free'],
  },
  max: {
    budget_id: 'tier_max',
    name: 'Power Max',
    max_budget: 35.00,
    budget_duration: '30d',
    rpm_limit: 300,
    max_parallel_requests: 25,
    allowed_models: [], // Kosong = izinkan semua model
  },
  enterprise: {
    budget_id: 'tier_enterprise',
    name: 'Custom Enterprise',
    max_budget: 100.00,
    budget_duration: '30d',
    rpm_limit: 1000,
    max_parallel_requests: 100,
    allowed_models: [], // Kosong = izinkan semua model
  },
  pay_as_you_go: {
    budget_id: 'tier_pay_as_you_go',
    name: 'Pay-As-You-Go',
    max_budget: 100.00,
    budget_duration: '30d',
    rpm_limit: 150,
    max_parallel_requests: 20,
    allowed_models: [], // Kosong = izinkan semua model
  },
  deposit: {
    budget_id: 'tier_deposit',
    name: 'Mode Deposit Bebas',
    max_budget: 250.00,
    budget_duration: '30d',
    rpm_limit: 200,
    max_parallel_requests: 25,
    allowed_models: [], // Kosong = izinkan semua model
  },
  pay_as_you_go_direct: {
    budget_id: 'pay_as_you_go',
    name: 'Pay-As-You-Go (Direct)',
    max_budget: 100.00,
    budget_duration: '30d',
    rpm_limit: 150,
    max_parallel_requests: 20,
    allowed_models: [],
  },
  mode_deposit_direct: {
    budget_id: 'mode_deposit',
    name: 'Mode Deposit (Direct)',
    max_budget: 250.00,
    budget_duration: '30d',
    rpm_limit: 200,
    max_parallel_requests: 25,
    allowed_models: [],
  },
}

/**
 * Sinkronisasi seluruh Tier dari database PostgreSQL ke LiteLLM Budgets (/budget/new atau /budget/update)
 */
export async function syncTierBudgetsToLiteLLM(supabase) {
  try {
    console.log('[BudgetSync] Memulai sinkronisasi Tier Budgets ke LiteLLM...')

    // 1. Ambil daftar budget yang saat ini ada di LiteLLM
    let existingBudgets = []
    try {
      const listRes = await fetch(`${LITELLM_URL}/budget/list`, {
        headers: getAuthHeaders(),
      })
      if (listRes.ok) {
        existingBudgets = await listRes.json()
      }
    } catch (err) {
      console.warn('[BudgetSync] Gagal fetch /budget/list:', err.message)
    }

    const existingBudgetIds = new Set((existingBudgets || []).map(b => b.budget_id))

    // 2. Ambil data tiers dari PostgreSQL (tier_rules) jika supabase tersedia
    let tiersToSync = []
    if (supabase) {
      const { data: dbTiers } = await supabase
        .from('tier_rules')
        .select('*')
        .eq('is_active', true)
      if (dbTiers && dbTiers.length > 0) {
        tiersToSync = dbTiers.map(t => {
          const rawModels = t.allowed_models || []
          const allowedModels = rawModels.includes('*') ? [] : rawModels
          const price = Number(t.price_usd || 0)
          let maxBudget = price > 0 ? Number((price * 1.25).toFixed(2)) : 0.50
          if (t.id === 'pay_as_you_go') maxBudget = 100.00
          if (t.id === 'deposit') maxBudget = 250.00

          return {
            budget_id: `tier_${t.id.toLowerCase()}`,
            name: t.name,
            max_budget: maxBudget,
            budget_duration: '30d',
            rpm_limit: t.max_rpm || 30,
            max_parallel_requests: t.max_concurrent_streams || 5,
            allowed_models: allowedModels,
          }
        })
      }
    }

    // Pastikan standalone pay_as_you_go dan mode_deposit selalu ikut tersinkron
    tiersToSync.push(DEFAULT_TIER_BUDGETS.pay_as_you_go_direct)
    tiersToSync.push(DEFAULT_TIER_BUDGETS.mode_deposit_direct)

    // Jika tidak ada di DB, gunakan fallback DEFAULT_TIER_BUDGETS
    if (tiersToSync.length === 0) {
      tiersToSync = Object.values(DEFAULT_TIER_BUDGETS)
    }

    // 3. Buat atau perbarui setiap tier di LiteLLM
    for (const tier of tiersToSync) {
      const existingObj = (existingBudgets || []).find(b => b.budget_id === tier.budget_id)
      const exists = Boolean(existingObj)
      const endpoint = exists ? `${LITELLM_URL}/budget/update` : `${LITELLM_URL}/budget/new`

      // Pertahankan max_budget jika user/owner telah mengaturnya di LiteLLM UI
      const finalMaxBudget = (exists && existingObj?.max_budget !== null && existingObj?.max_budget !== undefined)
        ? Number(existingObj.max_budget)
        : tier.max_budget

      const payload = {
        budget_id: tier.budget_id,
        max_budget: finalMaxBudget,
        budget_duration: tier.budget_duration,
        rpm_limit: tier.rpm_limit,
        max_parallel_requests: tier.max_parallel_requests,
        allowed_models: tier.allowed_models,
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
        })

        if (res.ok) {
          console.log(`[BudgetSync]  ${exists ? 'Updated' : 'Created'} budget '${tier.budget_id}' ($${finalMaxBudget}/30d, RPM: ${tier.rpm_limit})`)
        } else {
          const errText = await res.text()
          console.warn(`[BudgetSync] Gagal update/create budget '${tier.budget_id}': ${errText}`)
        }
      } catch (err) {
        console.warn(`[BudgetSync] Error request '${tier.budget_id}': ${err.message}`)
      }
    }

    console.log(`[BudgetSync] Selesai sinkronisasi ${tiersToSync.length} tier budgets ke LiteLLM.`)
    return { success: true, count: tiersToSync.length }
  } catch (err) {
    console.error('[BudgetSync] Fatal error syncTierBudgetsToLiteLLM:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Sinkronisasi User ke Budget LiteLLM (/customer/new atau /customer/update)
 * Dipanggil saat:
 * 1. User pertama kali register / chat
 * 2. User upgrade langganan (Xendit)
 * 3. Admin mengubah tier user
 */
export async function syncUserTierToLiteLLM(userId, tierName = 'free', customMaxBudget = null) {
  if (!userId) return

  const budgetId = `tier_${tierName.toLowerCase()}`
  try {
    // 1. Cek apakah customer sudah ada di LiteLLM
    const checkRes = await fetch(`${LITELLM_URL}/customer/info?end_user_id=${encodeURIComponent(userId)}`, {
      headers: getAuthHeaders(),
    })

    const exists = checkRes.status === 200
    const endpoint = exists ? `${LITELLM_URL}/customer/update` : `${LITELLM_URL}/customer/new`

    const payload = {
      user_id: userId,
    }
    if (customMaxBudget !== null && customMaxBudget !== undefined && Number(customMaxBudget) > 0) {
      payload.max_budget = Number(customMaxBudget)
    } else {
      payload.budget_id = budgetId
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      console.log(`[BudgetSync]  User ${userId} berhasil di-assign ke budget '${budgetId}' di LiteLLM (Custom Max: ${customMaxBudget || 'none'})`)
    } else {
      const errTxt = await res.text()
      console.warn(`[BudgetSync] Gagal sinkron user ${userId} ke ${budgetId}: ${errTxt}`)
    }
  } catch (err) {
    console.warn(`[BudgetSync] Error syncUserTierToLiteLLM for ${userId}:`, err.message)
  }
}

/**
 * Tambah kuota / saldo ke budget user di LiteLLM saat user melakukan Deposit Pay-As-You-Go
 */
export async function syncUserDepositToLiteLLM(userId, additionalUsd) {
  if (!userId || !additionalUsd) return

  try {
    const checkRes = await fetch(`${LITELLM_URL}/customer/info?end_user_id=${encodeURIComponent(userId)}`, {
      headers: getAuthHeaders(),
    })

    if (checkRes.ok) {
      const data = await checkRes.json()
      const currentMax = Number(data?.litellm_budget_table?.max_budget || 0)
      const newMax = Number((currentMax + Number(additionalUsd)).toFixed(2))

      await fetch(`${LITELLM_URL}/customer/update`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          user_id: userId,
          max_budget: newMax,
        }),
      })
      console.log(`[BudgetSync]  User ${userId} deposit +$${additionalUsd} synced to LiteLLM (New Max: $${newMax})`)
    }
  } catch (err) {
    console.warn(`[BudgetSync] Error syncUserDepositToLiteLLM for ${userId}:`, err.message)
  }
}

/**
 * Catat dan update akumulasi pengeluaran (spend) user di LiteLLM_EndUserTable
 */
export async function recordUserSpendToLiteLLM(userId, costUsd) {
  if (!userId || !costUsd || costUsd <= 0) return
  try {
    const res = await litellmDbPool.query(
      `UPDATE "LiteLLM_EndUserTable" SET spend = spend + $1 WHERE user_id = $2 RETURNING spend, budget_id`,
      [Number(costUsd), userId]
    )
    if (res.rowCount > 0) {
      console.log(`[BudgetSync] LiteLLM customer spend updated for user ${userId}: +$${costUsd} (Total: $${res.rows[0].spend})`)
    }
  } catch (err) {
    console.warn(`[BudgetSync] Warning recordUserSpendToLiteLLM for ${userId}:`, err.message)
  }
}

/**
 * Dapatkan informasi pengeluaran realtime dan batas budget user dari LiteLLM
 */
export async function getUserSpendAndBudgetFromLiteLLM(userId) {
  if (!userId) return null
  try {
    const res = await litellmDbPool.query(
      `SELECT u.user_id, u.spend, u.budget_id, u.blocked, b.max_budget, b.rpm_limit, b.max_parallel_requests
       FROM "LiteLLM_EndUserTable" u
       LEFT JOIN "LiteLLM_BudgetTable" b ON u.budget_id = b.budget_id
       WHERE u.user_id = $1`,
      [userId]
    )
    if (res.rows.length > 0) {
      return res.rows[0]
    }
  } catch (err) {
    console.warn(`[BudgetSync] Warning getUserSpendAndBudgetFromLiteLLM for ${userId}:`, err.message)
  }
  return null
}

/**
 * Validasi virtual API key dari LiteLLM (table LiteLLM_VerificationToken).
 * Mendukung key bertipe You, Service Account, Another User, dan Agent.
 * @param {string} rawToken Key mentah berformat sk-...
 * @returns {Promise<Object|null>} Metadata token jika valid, atau null / error
 */
export async function validateLiteLLMToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null
  try {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const res = await litellmDbPool.query(
      `SELECT token, key_name, key_alias, spend, total_spend, expires, models,
              user_id, team_id, blocked, max_budget, agent_id, key_type, metadata
       FROM "LiteLLM_VerificationToken"
       WHERE token = $1`,
      [tokenHash]
    )

    if (res.rows.length === 0) return null

    const tokenRow = res.rows[0]

    // 1. Cek apakah key diblokir
    if (tokenRow.blocked) {
      return { valid: false, reason: 'blocked', message: 'LiteLLM Virtual Key is blocked by administrator' }
    }

    // 2. Cek apakah key sudah kedaluwarsa (expires)
    if (tokenRow.expires && new Date(tokenRow.expires) < new Date()) {
      return { valid: false, reason: 'expired', message: 'LiteLLM Virtual Key has expired' }
    }

    // 3. Cek batas maksimal pengeluaran key (max_budget)
    if (tokenRow.max_budget !== null && tokenRow.max_budget !== undefined) {
      const currentSpend = Number(tokenRow.spend || 0)
      const maxBudget = Number(tokenRow.max_budget)
      if (maxBudget > 0 && currentSpend >= maxBudget) {
        return {
          valid: false,
          reason: 'budget_exceeded',
          message: `LiteLLM Virtual Key budget exceeded (Spent: $${currentSpend.toFixed(4)}, Max: $${maxBudget.toFixed(2)})`,
          max_budget: maxBudget,
          spend: currentSpend,
        }
      }
    }

    return {
      valid: true,
      token: tokenHash,
      key_name: tokenRow.key_name,
      key_alias: tokenRow.key_alias,
      user_id: tokenRow.user_id,
      team_id: tokenRow.team_id,
      agent_id: tokenRow.agent_id,
      key_type: tokenRow.key_type || 'virtual_key',
      models: tokenRow.models || [],
      max_budget: tokenRow.max_budget,
      spend: tokenRow.spend,
      metadata: tokenRow.metadata || {},
    }
  } catch (err) {
    console.warn('[BudgetSync] validateLiteLLMToken error:', err.message)
    return null
  }
}

/**
 * Catat dan update akumulasi pengeluaran virtual token di LiteLLM_VerificationToken
 * @param {string} tokenHash Hash SHA-256 dari virtual key
 * @param {number} costUsd Biaya dalam USD yang harus ditambahkan ke spend key
 */
export async function recordTokenSpendToLiteLLM(tokenHash, costUsd) {
  if (!tokenHash || !costUsd || costUsd <= 0) return
  try {
    const res = await litellmDbPool.query(
      `UPDATE "LiteLLM_VerificationToken"
       SET spend = spend + $1, total_spend = total_spend + $1, last_active = NOW()
       WHERE token = $2
       RETURNING spend, total_spend`,
      [Number(costUsd), tokenHash]
    )
    if (res.rowCount > 0) {
      console.log(`[BudgetSync] LiteLLM key spend updated for ${tokenHash.slice(0, 8)}...: +$${costUsd} (Spend: $${res.rows[0].spend})`)
    }
  } catch (err) {
    console.warn(`[BudgetSync] Warning recordTokenSpendToLiteLLM:`, err.message)
  }
}

export { litellmDbPool }
