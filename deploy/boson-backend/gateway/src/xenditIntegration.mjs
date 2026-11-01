// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: XENDIT PAYMENT GATEWAY INTEGRATION
// Menggunakan Kredensial Resmi dari Services AI_SAAS:
// - Secret Key: xnd_development_dzHLcepzxXLU4wkRCcruoro0dz2qCHWcMmlz2W1fZyJKOWEer4KvBgBXcxCGrV
// - Webhook Token: HDmeJZjzpTJkJ1t2YmHiTOohL4lblqJbZQblm7SvOzzHO5Ar
// ─────────────────────────────────────────────────────────────

import { syncUserTierToLiteLLM, syncUserDepositToLiteLLM } from './budgetSync.mjs'

export const XENDIT_CONFIG = {
  secretKey: process.env.XENDIT_SECRET_KEY || 'xnd_development_dzHLcepzxXLU4wkRCcruoro0dz2qCHWcMmlz2W1fZyJKOWEer4KvBgBXcxCGrV',
  publicKey: process.env.XENDIT_PUBLIC_KEY || 'xnd_public_development_DzEPNPX4PbIk7keFwmDXC4obNyjuE3ztNFICV2P0RpRfmSebSXG7HuPxTMyZLSo',
  webhookToken: process.env.XENDIT_WEBHOOK_TOKEN || 'HDmeJZjzpTJkJ1t2YmHiTOohL4lblqJbZQblm7SvOzzHO5Ar',
  apiUrl: process.env.XENDIT_API_URL || 'https://api.xendit.co',
}

// Konversi standar IDR aman (buffer kurs bank & slippage valas): $1 USD ≈ Rp 16.500
export const IDR_RATE = Number(process.env.IDR_RATE || 16500)

/**
 * Buat Invoice Xendit Resmi untuk Subscription atau Deposit Pay-As-You-Go
 */
export async function createXenditInvoice({ userId, email, plan = 'pro', amountUSD = 14.99, type = 'subscription', platformPublicUrl }) {
  const isSubscription = type === 'subscription'
  const finalUSD = isSubscription ? (plan === 'starter' ? 9.99 : 14.99) : amountUSD
  const amountIDR = Math.round(finalUSD * IDR_RATE)
  const timestamp = Date.now()

  // Format ID Unik: xendit_{userId}_{plan}_{amountUSD}_{timestamp}
  const externalId = `xendit_${userId}_${plan}_${finalUSD}_${timestamp}`
  const description = isSubscription
    ? `Langganan Boson Studio ${plan.toUpperCase()} ($${finalUSD}/bln)`
    : `Deposit Saldo Pay-As-You-Go Boson Studio ($${finalUSD})`

  const successUrl = `${platformPublicUrl}/billing?status=success&external_id=${externalId}`
  const failureUrl = `${platformPublicUrl}/billing?status=failed&external_id=${externalId}`

  let invoiceUrl = `${platformPublicUrl}/v1/xendit/sandbox-checkout?external_id=${externalId}&amount=${amountIDR}&redirect_url=${encodeURIComponent(successUrl)}`
  let invoiceId = `inv_mock_${timestamp}`
  let providerStatus = 'PENDING'

  // Jika Secret Key terkonfigurasi, coba buat Invoice riil di Xendit API
  if (XENDIT_CONFIG.secretKey && XENDIT_CONFIG.secretKey.startsWith('xnd_')) {
    try {
      const basicAuth = Buffer.from(`${XENDIT_CONFIG.secretKey}:`).toString('base64')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)

      const xenditRes = await fetch(`${XENDIT_CONFIG.apiUrl}/v2/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth}`,
        },
        body: JSON.stringify({
          external_id: externalId,
          amount: amountIDR,
          payer_email: email || `${userId}@boson.id`,
          description,
          invoice_duration: 86400, // 24 jam
          currency: 'IDR',
          payment_methods: ['QRIS', 'BCA', 'BNI', 'BRI', 'MANDIRI', 'PERMATA', 'OVO', 'DANA', 'SHOPEEPAY', 'CREDIT_CARD'],
          success_redirect_url: successUrl,
          failure_redirect_url: failureUrl,
          items: [
            {
              name: description,
              quantity: 1,
              price: amountIDR,
              category: isSubscription ? 'AI Subscription' : 'Token Deposit',
            },
          ],
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (xenditRes.ok) {
        const xenditData = await xenditRes.json()
        invoiceId = xenditData.id || invoiceId
        invoiceUrl = xenditData.invoice_url || invoiceUrl
        providerStatus = xenditData.status || providerStatus
        console.log(`[Xendit API] Berhasil membuat Invoice resmi: ${invoiceId} (Rp ${amountIDR.toLocaleString('id-ID')})`)
      } else {
        const errText = await xenditRes.text()
        console.warn(`[Xendit API] Response non-200: ${errText}. Menggunakan fallback sandbox simulator.`)
      }
    } catch (err) {
      console.warn(`[Xendit API] Gagal menghubungi endpoint Xendit (${err.message}). Menggunakan sandbox simulator.`)
    }
  }

  return {
    success: true,
    invoice_id: invoiceId,
    external_id: externalId,
    invoice_url: invoiceUrl,
    amount_idr: amountIDR,
    amount_usd: finalUSD,
    plan,
    type,
    status: providerStatus,
  }
}

/**
 * Verifikasi dan Proses Webhook Pembayaran dari Xendit
 */
export async function processXenditPaymentWebhook(payload, callbackTokenHeader, supabase) {
  // 1. Verifikasi Wajib Token Callback Resmi Xendit
  if (XENDIT_CONFIG.webhookToken) {
    if (!callbackTokenHeader || callbackTokenHeader !== XENDIT_CONFIG.webhookToken) {
      throw new Error('Xendit Webhook Verification Error: Token callback tidak valid atau tidak disertakan')
    }
  }

  const externalId = payload.external_id || payload.order_id || ''
  const status = (payload.status || '').toUpperCase()
  const isPaid = status === 'PAID' || status === 'SETTLED' || status === 'SUCCESS' || payload.transaction_status === 'settlement'

  if (!isPaid) {
    return { success: true, action: 'ignored', status, message: `Status pembayaran ${status} diabaikan.` }
  }

  const txId = payload.id || externalId
  const isValidUuid = (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)

  // 1. Cek apakah transaksi sudah ada di database (Idempotency & Canonical Data Check)
  let existingTx = null
  if (externalId) {
    const { data } = await supabase.from('transactions').select('*').eq('gateway_reference', externalId).maybeSingle()
    if (data) existingTx = data
  }
  if (!existingTx && txId) {
    const { data } = await supabase.from('transactions').select('*').eq('gateway_reference', txId).maybeSingle()
    if (data) existingTx = data
  }
  if (!existingTx && isValidUuid(txId)) {
    const { data } = await supabase.from('transactions').select('*').eq('id', txId).maybeSingle()
    if (data) existingTx = data
  }

  if (existingTx && existingTx.status === 'success') {
    console.log(`[Xendit Webhook] Transaksi ${txId} sudah pernah diproses sebelumnya (Idempotent).`)
    return {
      success: true,
      action: 'already_fulfilled',
      userId: existingTx.user_id,
      transactionId: txId,
      message: 'Transaksi ini telah diproses sebelumnya.',
    }
  }

  // Ambil data kanonikal dari existingTx jika tersedia, atau fallback ke parsing external_id
  let userId = existingTx?.user_id || ''
  let plan = existingTx?.metadata?.plan_tier || existingTx?.metadata?.plan || 'pro'
  let amountUSD = Number(existingTx?.amount) || 14.99
  let isSubscription = existingTx ? (existingTx.type === 'subscription') : true

  if (!userId) {
    const parts = externalId.split('_')
    if (parts.length >= 5) {
      userId = parts[1]
      plan = parts[2]
      amountUSD = parseFloat(parts[3]) || 14.99
      isSubscription = plan === 'starter' || plan === 'pro'
    } else if (payload.user_id) {
      userId = payload.user_id
      plan = payload.plan || 'pro'
      amountUSD = parseFloat(payload.amount_usd) || 14.99
      isSubscription = payload.type === 'subscription'
    }
  }

  if (!userId) {
    throw new Error('Xendit Webhook Error: Gagal mengidentifikasi user_id dari payload atau database')
  }

  // 2. Catat atau perbarui transaksi di database Supabase
  const txRecord = {
    user_id: userId,
    type: isSubscription ? 'subscription' : 'deposit',
    amount: amountUSD,
    currency: 'USD',
    payment_gateway: 'xendit',
    gateway_reference: externalId || txId,
    status: 'success',
    metadata: {
      xendit_payload: payload,
      plan,
      external_id: externalId,
      fulfilled_at: new Date().toISOString(),
    },
  }
  if (existingTx?.id) {
    txRecord.id = existingTx.id
  } else if (isValidUuid(txId)) {
    txRecord.id = txId
  }
  await supabase.from('transactions').upsert(txRecord)

  // 3. Fulfill Saldo ke Dompet User
  let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle()
  if (!wallet) {
    const { data: newW } = await supabase.from('wallets').insert({
      user_id: userId,
      normal_balance: 0,
      subscription_balance: 0,
      bonus_balance: 0,
      currency: 'USD',
      created_at: new Date(),
      updated_at: new Date(),
    }).select().maybeSingle()
    wallet = newW
  }

  if (isSubscription) {
    // Mode Langganan ArtCraft: Alokasi kuota kredit bulanan
    // Basic: 1,000 credits ($10.00)
    // Pro: 3,750 credits ($37.50)
    // Max: 6,600 credits ($66.00)
    let monthlyPool = 37.50
    const lowerPlan = String(plan).toLowerCase()
    if (lowerPlan.includes('basic') || lowerPlan.includes('starter')) {
      monthlyPool = 10.00
    } else if (lowerPlan.includes('max') || lowerPlan.includes('teams') || lowerPlan.includes('studio')) {
      monthlyPool = 66.00
    } else if (lowerPlan.includes('pro')) {
      monthlyPool = 37.50
    }

    const newSubsBalance = Number(wallet?.subscription_balance || 0) + monthlyPool

    await supabase.from('wallets').update({
      subscription_balance: newSubsBalance,
      updated_at: new Date(),
    }).eq('user_id', userId)

    // Catat baris langganan aktif
    await supabase.from('subscriptions').insert({
      user_id: userId,
      plan_tier: plan,
      price_usd: amountUSD,
      monthly_token_pool: monthlyPool,
      status: 'active',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    // Upgrade tier profil pengguna
    await supabase.from('profiles').update({
      tier: plan,
      updated_at: new Date(),
    }).eq('id', userId)

    // Sinkronkan paket tier & kuota user ke LiteLLM Budgets
    await syncUserTierToLiteLLM(userId, plan, newSubsBalance)

    console.log(`[Xendit Fulfillment] User ${userId} sukses berlangganan ${plan.toUpperCase()} (+$${monthlyPool} kuota token)`)
    return {
      success: true,
      action: 'subscription_fulfilled',
      userId,
      tier: plan,
      creditedQuotaUSD: monthlyPool,
      transactionId: txId,
    }
  } else {
    // Mode Deposit Pay-As-You-Go: Tambahkan ke normal_balance (Never Expires)
    const newNormalBalance = Number(wallet?.normal_balance || 0) + amountUSD

    const walletUpdates = {
      normal_balance: newNormalBalance,
      updated_at: new Date(),
    }
    if (!wallet?.tier || wallet?.tier === 'free') {
      walletUpdates.tier = 'pay_as_you_go'
      await syncUserTierToLiteLLM(userId, 'pay_as_you_go')
    }

    await supabase.from('wallets').update(walletUpdates).eq('user_id', userId)

    // Sinkronkan penambahan saldo deposit ke LiteLLM Budgets
    await syncUserDepositToLiteLLM(userId, amountUSD)

    console.log(`[Xendit Fulfillment] User ${userId} sukses top-up deposit +$${amountUSD} (Normal Balance, Tier: ${walletUpdates.tier || wallet?.tier})`)
    return {
      success: true,
      action: 'deposit_fulfilled',
      userId,
      creditedNormalUSD: amountUSD,
      transactionId: txId,
    }
  }
}

/**
 * Render HTML Sandbox Checkout Simulator Xendit
 */
export function renderSandboxCheckoutHtml({ externalId, amount, redirectUrl, webhookToken }) {
  const formattedAmount = Number(amount || 0).toLocaleString('id-ID')
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Xendit Payment Simulator — Boson Studio</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
  <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-2xl">
    <div class="flex items-center justify-between border-b border-slate-700 pb-4 mb-4">
      <div class="flex items-center gap-2">
        <span class="text-2xl">💳</span>
        <h1 class="font-bold text-lg text-white">Xendit Payment Gateway</h1>
      </div>
      <span class="text-xs bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2.5 py-0.5 rounded-full font-semibold">TEST SANDBOX</span>
    </div>

    <div class="space-y-4">
      <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-700/60">
        <div class="text-xs text-slate-400 uppercase font-medium">Order Reference</div>
        <div class="text-sm font-mono font-semibold text-indigo-300 break-all">${externalId || 'xendit_test_order'}</div>
        <div class="mt-3 text-xs text-slate-400 uppercase font-medium">Total Tagihan</div>
        <div class="text-2xl font-black text-emerald-400">Rp ${formattedAmount}</div>
      </div>

      <div class="text-center py-2">
        <div class="text-xs text-slate-400 mb-2">Metode Pembayaran: QRIS, BCA, Mandiri, BRI, OVO, DANA</div>
        <div class="inline-block p-3 bg-white rounded-xl shadow-md">
          <div class="w-44 h-44 bg-slate-100 border border-dashed border-slate-300 rounded flex flex-col items-center justify-center text-slate-600">
            <span class="text-4xl mb-1">📱</span>
            <span class="text-xs font-bold text-slate-800">QRIS STANDAR BI</span>
            <span class="text-[10px] text-slate-500">Scan via Apapun</span>
          </div>
        </div>
      </div>

      <button id="pay-btn" onclick="simulasiBayar()" class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-900/30 transition-all flex items-center justify-center gap-2 cursor-pointer">
        <span>⚡</span> Konfirmasi Bayar (Simulasi QRIS Lunas)
      </button>

      <div id="status-box" class="hidden text-xs text-center p-3 rounded-xl"></div>
    </div>
  </div>

  <script>
    async function simulasiBayar() {
      const btn = document.getElementById('pay-btn');
      const box = document.getElementById('status-box');
      btn.disabled = true;
      btn.innerHTML = '⏳ Menghubungi webhook fulfillment...';

      try {
        const payload = {
          id: 'inv_' + Date.now(),
          external_id: '${externalId}',
          status: 'PAID',
          amount: ${amount},
          paid_amount: ${amount},
          payment_method: 'QRIS',
          payment_channel: 'QRIS_STANDAR',
          paid_at: new Date().toISOString()
        };

        const res = await fetch('/v1/xendit/webhook', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-callback-token': '${webhookToken || ''}'
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        box.className = 'text-xs text-center p-3 rounded-xl ' + (data.success ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-500/30' : 'bg-rose-900/40 text-rose-300 border border-rose-500/30');
        box.style.display = 'block';
        box.innerHTML = data.success ? '🎉 Pembayaran Berhasil!<br><span class="text-[11px] text-slate-400">Kembali ke aplikasi dalam 2 detik...</span>' : '❌ ' + (data.message || data.error || 'Gagal');

        if (data.success) {
          setTimeout(() => {
            window.location.href = '${redirectUrl}';
          }, 2000);
        }
      } catch (err) {
        box.className = 'text-xs text-center p-3 rounded-xl bg-rose-900/40 text-rose-300';
        box.style.display = 'block';
        box.innerText = 'Error: ' + err.message;
        btn.disabled = false;
        btn.innerText = 'Coba Lagi';
      }
    }
  </script>
</body>
</html>`
}
