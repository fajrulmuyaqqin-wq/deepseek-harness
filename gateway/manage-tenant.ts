/**
 * CLI Tool untuk mengelola Tenant, Langganan Bulanan, dan Deposit dengan Masa Hangus
 * pada Boson Studio Gateway (LiteLLM).
 *
 * Penggunaan:
 *   npx tsx gateway/manage-tenant.ts create-sub <user_id> <monthly_budget_usd> [alias]
 *   npx tsx gateway/manage-tenant.ts create-deposit <user_id> <deposit_usd> [duration e.g. 30d/60d/none] [alias]
 *   npx tsx gateway/manage-tenant.ts topup <key> <additional_budget_usd> [extend_duration e.g. 30d]
 *   npx tsx gateway/manage-tenant.ts balance <key>
 *   npx tsx gateway/manage-tenant.ts list
 */
import process from 'node:process'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000'
const MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? 'sk-boson-master-admin-key'

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const headers = {
    'Authorization': `Bearer ${MASTER_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  }

  const res = await fetch(`${GATEWAY_URL}${path}`, { ...options, headers })
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`Gateway Error (${res.status}): ${errorText}`)
  }
  return res.json()
}

/**
 * 1. Model Langganan / Pay As You Go Bulanan (Monthly Reset Budget)
 * Budget otomatis di-reset tiap 30 hari (budget_duration: "30d").
 */
async function createSubscription(userId: string, monthlyBudgetUsd: number, alias?: string) {
  console.log(`\n⏳ Membuat akun Langganan Bulanan untuk '${userId}' (Budget: $${monthlyBudgetUsd}/bulan)...`)
  const result = await request('/key/generate', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      max_budget: monthlyBudgetUsd,
      budget_duration: '30d',
      key_alias: alias ?? `${userId}-monthly`,
      metadata: {
        plan_type: 'monthly_subscription',
        monthly_allowance: monthlyBudgetUsd,
        createdAt: new Date().toISOString(),
      },
    }),
  })

  console.log('\n✅ Akun Langganan Bulanan Berhasil Dibuat!')
  console.log('----------------------------------------------------')
  console.log(`User ID        : ${result.user_id}`)
  console.log(`Virtual API Key: ${result.key}`)
  console.log(`Tipe Paket     : Langganan Bulanan (Reset Otomatis 30 Hari)`)
  console.log(`Budget Bulanan : $${result.max_budget}/bulan`)
  console.log(`Siklus Reset   : 30 Hari (budget_duration: 30d)`)
  console.log('----------------------------------------------------')
  console.log('💡 Tenant dapat memakai hingga batas budget per bulan. Saldo di-reset tiap awal periode.\n')
}

/**
 * 2. Model Deposit Prabayar dengan Masa Hangus (Expiring / Non-Expiring Deposit)
 * Duration bisa disetel misal "30d", "60d", "90d", atau "none" (tanpa hangus).
 */
async function createDeposit(
  userId: string,
  depositUsd: number,
  durationStr: string = 'none',
  alias?: string,
) {
  const hasExpiry = durationStr && durationStr !== 'none' && durationStr !== 'unlimited'
  console.log(
    `\n⏳ Membuat akun Deposit untuk '${userId}' ($${depositUsd}, Masa Hangus: ${hasExpiry ? durationStr : 'Tanpa Hangus'})...`,
  )

  const payload: any = {
    user_id: userId,
    max_budget: depositUsd,
    key_alias: alias ?? `${userId}-deposit`,
    metadata: {
      plan_type: 'deposit_prepaid',
      deposit_amount: depositUsd,
      has_expiry: hasExpiry,
      createdAt: new Date().toISOString(),
    },
  }

  if (hasExpiry) {
    payload.duration = durationStr // Contoh: "30d", "60d", "90d"
  }

  const result = await request('/key/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  console.log('\n✅ Akun Deposit Berhasil Dibuat!')
  console.log('----------------------------------------------------')
  console.log(`User ID        : ${result.user_id}`)
  console.log(`Virtual API Key: ${result.key}`)
  console.log(`Tipe Paket     : Deposit Prabayar`)
  console.log(`Saldo Deposit  : $${result.max_budget}`)
  console.log(`Masa Hangus    : ${result.expires ? `Hangus pada: ${result.expires}` : 'Tidak Ada Masa Hangus (Selamanya)'}`)
  console.log('----------------------------------------------------')
  console.log('💡 Jika deposit habis atau masa hangus lewat, request otomatis ditolak.\n')
}

/**
 * 3. Top-up Saldo / Tambah Deposit & Opsional Perpanjang Masa Aktif
 */
async function topupTenant(key: string, additionalBudgetUsd: number, extendDuration?: string) {
  console.log(`\n⏳ Mengambil info key '${key.slice(0, 10)}...' sebelum topup...`)
  const infoRes = await request(`/key/info?key=${encodeURIComponent(key)}`, { method: 'GET' })
  const info = infoRes.info ?? infoRes
  const currentBudget = info.max_budget ?? 0
  const newBudget = currentBudget + additionalBudgetUsd

  console.log(`⏳ Menambah budget +$${additionalBudgetUsd} (Total baru: $${newBudget})...`)
  const payload: any = {
    key,
    max_budget: newBudget,
  }

  if (extendDuration && extendDuration !== 'none') {
    payload.duration = extendDuration
  }

  const result = await request('/key/update', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  console.log('\n✅ Top-up Berhasil!')
  console.log('----------------------------------------------------')
  console.log(`Key            : ${key.slice(0, 14)}...`)
  console.log(`Budget Baru    : $${result.max_budget ?? newBudget}`)
  if (result.expires) {
    console.log(`Masa Berlaku   : Diperpanjang hingga ${result.expires}`)
  }
  console.log('----------------------------------------------------\n')
}

/**
 * 4. Cek Status Saldo, Masa Hangus, dan Reset Cycle
 */
async function getBalance(key: string) {
  console.log(`\n⏳ Memeriksa saldo & status key '${key.slice(0, 10)}...'...`)
  const result = await request(`/key/info?key=${encodeURIComponent(key)}`, {
    method: 'GET',
  })

  const info = result.info ?? result
  const maxBudget = info.max_budget ?? 0
  const spend = info.spend ?? 0
  const remaining = Math.max(0, maxBudget - spend)
  const meta = info.metadata ?? {}

  console.log('\n📊 Status Akun & Saldo Tenant:')
  console.log('----------------------------------------------------')
  console.log(`User ID          : ${info.user_id ?? '-'}`)
  console.log(`Key Alias        : ${info.key_alias ?? '-'}`)
  console.log(`Tipe Paket       : ${meta.plan_type === 'monthly_subscription' ? 'Langganan Bulanan (Reset Otomatis)' : 'Deposit Prabayar'}`)
  console.log(`Total Limit      : $${maxBudget.toFixed(4)}`)
  console.log(`Terpakai (Spend) : $${spend.toFixed(4)}`)
  console.log(`Sisa Saldo       : $${remaining.toFixed(4)}`)
  console.log(`Reset Bulanan    : ${info.budget_duration ? `Ya (${info.budget_duration})` : 'Tidak (One-time/Kumulatif)'}`)
  console.log(`Masa Hangus      : ${info.expires ? `Hangus pada: ${info.expires}` : 'Aktif Selamanya (Tidak Ada Masa Hangus)'}`)
  console.log('----------------------------------------------------\n')
}

/**
 * 5. Daftar Semua Tenant
 */
async function listTenants() {
  console.log('\n⏳ Mengambil daftar seluruh tenant...')
  const result = await request('/key/list', {
    method: 'GET',
  })

  console.log('\n📋 Daftar Virtual Keys & Tenant:')
  console.table(
    (result.keys ?? []).map((k: any) => ({
      userId: k.user_id,
      alias: k.key_alias,
      plan: k.metadata?.plan_type ?? (k.budget_duration ? 'subscription' : 'deposit'),
      maxBudget: `$${k.max_budget ?? 0}`,
      spend: `$${(k.spend ?? 0).toFixed(4)}`,
      resetCycle: k.budget_duration ?? 'None',
      expires: k.expires ?? 'Never',
    })),
  )
}

async function main() {
  const [command, arg1, arg2, arg3, arg4] = process.argv.slice(2)

  try {
    switch (command) {
      case 'create-sub':
        if (!arg1 || !arg2) {
          console.error('Penggunaan: manage-tenant.ts create-sub <user_id> <monthly_budget_usd> [alias]')
          process.exit(1)
        }
        await createSubscription(arg1, parseFloat(arg2), arg3)
        break

      case 'create-deposit':
        if (!arg1 || !arg2) {
          console.error(
            'Penggunaan: manage-tenant.ts create-deposit <user_id> <deposit_usd> [duration e.g. 30d/60d/none] [alias]',
          )
          process.exit(1)
        }
        await createDeposit(arg1, parseFloat(arg2), arg3 ?? 'none', arg4)
        break

      case 'create':
        // Alias backward compatibility untuk create-deposit
        if (!arg1 || !arg2) {
          console.error('Penggunaan: manage-tenant.ts create <user_id> <deposit_usd> [alias]')
          process.exit(1)
        }
        await createDeposit(arg1, parseFloat(arg2), 'none', arg3)
        break

      case 'topup':
        if (!arg1 || !arg2) {
          console.error(
            'Penggunaan: manage-tenant.ts topup <key> <additional_budget_usd> [extend_duration e.g. 30d]',
          )
          process.exit(1)
        }
        await topupTenant(arg1, parseFloat(arg2), arg3)
        break

      case 'balance':
        if (!arg1) {
          console.error('Penggunaan: manage-tenant.ts balance <key>')
          process.exit(1)
        }
        await getBalance(arg1)
        break

      case 'list':
        await listTenants()
        break

      default:
        console.log(`
Perintah Tersedia:
  1. Langganan Bulanan (Reset Otomatis 30 Hari, Pay-as-You-Go Monthly):
     npx tsx gateway/manage-tenant.ts create-sub <user_id> <monthly_budget_usd> [alias]

  2. Deposit Prabayar (Bisa dengan Masa Hangus / Expiring, atau Tanpa Hangus):
     npx tsx gateway/manage-tenant.ts create-deposit <user_id> <deposit_usd> [duration e.g. 30d/60d/none] [alias]

  3. Top-up Tambah Saldo & Perpanjang Masa Aktif:
     npx tsx gateway/manage-tenant.ts topup <key> <additional_budget_usd> [extend_duration e.g. 30d]

  4. Cek Status Saldo & Masa Hangus:
     npx tsx gateway/manage-tenant.ts balance <key>

  5. Daftar Semua Tenant:
     npx tsx gateway/manage-tenant.ts list
        `)
        break
    }
  } catch (err: any) {
    console.error('\n❌ Terjadi Kesalahan:', err.message)
    process.exit(1)
  }
}

main()
