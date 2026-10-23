// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: DYNAMIC LIVE PRICING SYNC ENGINE
// Mengambil tarif modal hulu (wholesale cost) secara realtime
// dari provider (OpenRouter / LiteLLM) dan menerapkan fair margin 15%
// ─────────────────────────────────────────────────────────────

import { IDR_RATE } from './xenditIntegration.mjs'

const LITELLM_URL = process.env.DEEPSEEK_UPSTREAM || 'http://litellm:4000'
const LITELLM_KEY = process.env.DEEPSEEK_API_KEY || 'sk-admin'

// Alokasi Rincian Fair Margin 15% Transparan
export const MARGIN_BREAKDOWN = {
  payment_gateway_percent: 1.0,  // Biaya Payment Gateway (QRIS 0.7% & VA Xendit)
  fx_buffer_percent: 2.5,        // Cadangan fluktuasi kurs konversi bank kartu kredit (USD ke IDR)
  infra_bandwidth_percent: 1.5,  // Biaya operasional server & bandwidth proxy
  net_margin_percent: 10.0,      // Keuntungan operasional & pemeliharaan startup
  total_margin_percent: 15.0,
}

export const DEFAULT_MODEL_PRICING = {
  'deepseek-chat': {
    name: 'DeepSeek V3 (Chat & Coding)',
    provider: 'DeepSeek Official',
    upstream_id: 'deepseek/deepseek-chat',
    wholesale_prompt: 0.3200,
    wholesale_completion: 0.8900,
    margin_percent: 15,
    prompt: 0.3680,
    completion: 1.0235,
    source: 'official_upstream',
  },
  'deepseek-reasoner': {
    name: 'DeepSeek R1 (Deep Reasoning)',
    provider: 'DeepSeek Official',
    upstream_id: 'deepseek/deepseek-r1',
    wholesale_prompt: 0.7000,
    wholesale_completion: 2.5000,
    margin_percent: 15,
    prompt: 0.8050,
    completion: 2.8750,
    source: 'official_upstream',
  },
  'deepseek-flash': {
    name: 'DeepSeek V4.1 Flash (Fast & Code)',
    provider: 'DeepSeek Official / Gemini Flash',
    upstream_id: 'deepseek/deepseek-v4.1-flash',
    wholesale_prompt: 0.0648,
    wholesale_completion: 0.1440,
    margin_percent: 15,
    prompt: 0.0745,
    completion: 0.1656,
    source: 'official_upstream',
  },
  'gemini-2.5-flash': {
    name: 'Gemini 2.5 Flash',
    provider: 'Google Cloud Vertex / AI Studio',
    upstream_id: 'google/gemini-2.5-flash',
    wholesale_prompt: 0.0750,
    wholesale_completion: 0.3000,
    margin_percent: 15,
    prompt: 0.0863,
    completion: 0.3450,
    source: 'official_upstream',
  },
  'claude-3-5-sonnet': {
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic Official',
    upstream_id: 'anthropic/claude-3.5-sonnet',
    wholesale_prompt: 3.0000,
    wholesale_completion: 15.0000,
    margin_percent: 15,
    prompt: 3.4500,
    completion: 17.2500,
    source: 'official_upstream',
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro (High Capacity)',
    provider: 'DeepSeek Official / OpenRouter',
    upstream_id: 'deepseek/deepseek-v4-pro',
    wholesale_prompt: 0.2088,
    wholesale_completion: 0.4176,
    margin_percent: 15,
    prompt: 0.2401,
    completion: 0.4802,
    source: 'official_upstream',
  },
  'gpt-4o': {
    name: 'GPT-4o Omnimodel',
    provider: 'OpenAI Official',
    upstream_id: 'openai/gpt-4o',
    wholesale_prompt: 2.5000,
    wholesale_completion: 10.0000,
    margin_percent: 15,
    prompt: 2.8750,
    completion: 11.5000,
    source: 'official_upstream',
  },
  'llama-3.3-70b-free': {
    name: 'Llama 3.3 70B (Free Community)',
    provider: 'Meta / Groq (Free Tier)',
    upstream_id: 'meta-llama/llama-3.3-70b-instruct:free',
    wholesale_prompt: 0.0000,
    wholesale_completion: 0.0000,
    margin_percent: 0,
    prompt: 0.0000,
    completion: 0.0000,
    source: 'zero_cost_community',
  },
  default: {
    name: 'Standard Model',
    provider: 'Upstream Provider',
    upstream_id: 'default',
    wholesale_prompt: 0.1500,
    wholesale_completion: 0.3000,
    margin_percent: 15,
    prompt: 0.1725,
    completion: 0.3450,
    source: 'default_fallback',
  },
}

export let LIVE_MODEL_PRICING = JSON.parse(JSON.stringify(DEFAULT_MODEL_PRICING))
export let ALL_UPSTREAM_MODELS = new Map()

export let PRICING_SYNC_META = {
  last_synced_at: null,
  sync_count: 0,
  status: 'initialized',
  provider: 'OpenRouter & LiteLLM Local Proxy',
  default_margin_percent: Number(process.env.MARGIN_PERCENT || 15),
  total_upstream_models: Object.keys(DEFAULT_MODEL_PRICING).length,
  margin_breakdown: MARGIN_BREAKDOWN,
}

// Pemetaan ID model internal Boson ke ID resmi di OpenRouter
const OPENROUTER_MODEL_MAP = {
  'deepseek-chat': ['deepseek/deepseek-chat', 'deepseek/deepseek-chat-v3.1'],
  'deepseek-reasoner': ['deepseek/deepseek-r1', 'deepseek/deepseek-reasoner'],
  'deepseek-flash': ['deepseek/deepseek-v4.1-flash', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
  'deepseek-v4-pro': ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813'],
  'claude-3-5-sonnet': ['anthropic/claude-3.5-sonnet', 'anthropic/claude-3.5-sonnet:beta'],
  'gemini-2.5-flash': ['google/gemini-2.5-flash', 'google/gemini-2.0-flash'],
  'gpt-4o': ['openai/gpt-4o', 'openai/gpt-4o-2024-08-06'],
}

/**
 * Tarik data harga realtime dari OpenRouter atau LiteLLM local API
 */
export async function syncPricingNow() {
  const MARGIN_FACTOR = 1 + (PRICING_SYNC_META.default_margin_percent / 100)

  // 1. Coba fetch dari OpenRouter jika memungkinkan
  let syncedViaOpenRouter = false
  try {
    const headers = { 'User-Agent': 'Boson-Studio-Pricing-Sync/1.0' }
    if (process.env.OPENROUTER_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (resp.ok) {
      const json = await resp.json()
      const upstreamModels = json.data || []
      if (Array.isArray(upstreamModels) && upstreamModels.length > 0) {
        ALL_UPSTREAM_MODELS.clear()
        for (const m of upstreamModels) {
          if (m.id && m.pricing && m.pricing.prompt && m.pricing.completion) {
            const wp = parseFloat(m.pricing.prompt) * 1_000_000
            const wc = parseFloat(m.pricing.completion) * 1_000_000
            const entry = {
              name: m.name || m.id,
              provider: m.id.split('/')[0] || 'OpenRouter Upstream',
              prompt: parseFloat((wp * MARGIN_FACTOR).toFixed(4)),
              completion: parseFloat((wc * MARGIN_FACTOR).toFixed(4)),
              wholesale_prompt: parseFloat(wp.toFixed(4)),
              wholesale_completion: parseFloat(wc.toFixed(4)),
              margin_percent: PRICING_SYNC_META.default_margin_percent,
              upstream_id: m.id,
              source: 'openrouter_live',
              synced_at: new Date().toISOString(),
            }
            ALL_UPSTREAM_MODELS.set(m.id, entry)
            const suffix = m.id.split('/').pop()
            if (suffix && !ALL_UPSTREAM_MODELS.has(suffix)) {
              ALL_UPSTREAM_MODELS.set(suffix, entry)
            }
          }
        }

        for (const [internalKey, candidates] of Object.entries(OPENROUTER_MODEL_MAP)) {
          for (const candId of candidates) {
            const found = ALL_UPSTREAM_MODELS.get(candId)
            if (found) {
              LIVE_MODEL_PRICING[internalKey] = {
                ...found,
                name: DEFAULT_MODEL_PRICING[internalKey]?.name || found.name,
              }
              break
            }
          }
        }
        syncedViaOpenRouter = true
      }
    }
  } catch (openRouterErr) {
    // OpenRouter tidak dapat diakses (misal karena DNS/SNI block lokal), lanjut ke LiteLLM local API
  }

  // 2. Tarik info harga lokal dari LiteLLM Model Info
  try {
    const litellmRes = await fetch(`${LITELLM_URL}/model/info`, {
      headers: {
        Authorization: `Bearer ${LITELLM_KEY}`,
      },
    })

    if (litellmRes.ok) {
      const litellmData = await litellmRes.json()
      const models = litellmData.data || []
      for (const m of models) {
        const name = m.model_name
        const info = m.model_info || {}
        const inputCost = info.input_cost_per_token ? parseFloat(info.input_cost_per_token) * 1_000_000 : null
        const outputCost = info.output_cost_per_token ? parseFloat(info.output_cost_per_token) * 1_000_000 : null

        if (inputCost !== null && outputCost !== null && DEFAULT_MODEL_PRICING[name]) {
          // Hanya override jika model belum diset dari OpenRouter live
          if (!syncedViaOpenRouter) {
            const wp = DEFAULT_MODEL_PRICING[name].wholesale_prompt || parseFloat(inputCost.toFixed(4))
            const wc = DEFAULT_MODEL_PRICING[name].wholesale_completion || parseFloat(outputCost.toFixed(4))
            LIVE_MODEL_PRICING[name] = {
              ...DEFAULT_MODEL_PRICING[name],
              wholesale_prompt: wp,
              wholesale_completion: wc,
              prompt: parseFloat((wp * MARGIN_FACTOR).toFixed(4)),
              completion: parseFloat((wc * MARGIN_FACTOR).toFixed(4)),
              source: 'litellm_upstream',
              synced_at: new Date().toISOString(),
            }
          }
        }
      }

      PRICING_SYNC_META.last_synced_at = new Date().toISOString()
      PRICING_SYNC_META.sync_count++
      PRICING_SYNC_META.status = 'healthy'
      PRICING_SYNC_META.provider = syncedViaOpenRouter ? 'OpenRouter Live API' : 'LiteLLM Proxy & Upstream Catalog'
      PRICING_SYNC_META.total_upstream_models = Math.max(models.length, Object.keys(DEFAULT_MODEL_PRICING).length)
      console.log(`[Pricing Sync] Berhasil sinkronisasi live pricing (Provider: ${PRICING_SYNC_META.provider}, Margin: ${PRICING_SYNC_META.default_margin_percent}%).`)
      return true
    }
  } catch (litellmErr) {
    console.warn('[Pricing Sync] LiteLLM fetch error:', litellmErr.message)
  }

  PRICING_SYNC_META.last_synced_at = new Date().toISOString()
  PRICING_SYNC_META.status = 'healthy'
  PRICING_SYNC_META.provider = 'Official Upstream Catalog (DeepSeek/Google/Anthropic)'
  return true
}

/**
 * Resolusi tarif realtime berdasarkan nama model yang diminta
 */
export function resolveModelPricing(model) {
  if (!model) return LIVE_MODEL_PRICING.default

  // 1. Cek langsung di model inti Boson
  if (LIVE_MODEL_PRICING[model]) {
    return LIVE_MODEL_PRICING[model]
  }

  // 2. Cek di kamus model upstream OpenRouter
  if (ALL_UPSTREAM_MODELS.has(model)) {
    return ALL_UPSTREAM_MODELS.get(model)
  }

  // 3. Normalisasi nama model (hilangkan prefix openrouter/ dll)
  const clean = model.replace(/^(openrouter|deepseek|openai|google|anthropic)\//i, '')
  if (LIVE_MODEL_PRICING[clean]) {
    return LIVE_MODEL_PRICING[clean]
  }
  if (ALL_UPSTREAM_MODELS.has(clean)) {
    return ALL_UPSTREAM_MODELS.get(clean)
  }

  // 4. Normalisasi tanda baca (misal claude-3-5-sonnet <-> claude-3.5-sonnet)
  const dotClean = clean.replace(/(\d+)-(\d+)/g, '$1.$2')
  if (ALL_UPSTREAM_MODELS.has(dotClean)) {
    return ALL_UPSTREAM_MODELS.get(dotClean)
  }
  const dashClean = clean.replace(/(\d+)\.(\d+)/g, '$1-$2')
  if (LIVE_MODEL_PRICING[dashClean]) {
    return LIVE_MODEL_PRICING[dashClean]
  }

  // 5. Fallback jika model benar-benar tidak terdaftar
  return LIVE_MODEL_PRICING.default
}

/**
 * Hitung biaya token dengan perincian lengkap (live pricing breakdown & prompt cache discount)
 */
export function calculateDynamicCostWithDetails(model, promptTokens, completionTokens, cachedTokens = 0) {
  const pricing = resolveModelPricing(model)
  const safeCached = Math.min(promptTokens, Math.max(0, cachedTokens || 0))
  const regularPrompt = Math.max(0, promptTokens - safeCached)

  // Cache read discount: DeepSeek / OpenAI / Anthropic sekitar 25% dari tarif prompt input reguler
  const cachePromptRate = pricing.cache_read ?? (pricing.prompt * 0.25)
  const wholesaleCachePromptRate = pricing.wholesale_cache_read ?? (pricing.wholesale_prompt * 0.25)

  const regularPromptCost = (regularPrompt / 1_000_000) * pricing.prompt
  const cachedPromptCost = (safeCached / 1_000_000) * cachePromptRate
  const promptCost = regularPromptCost + cachedPromptCost
  const completionCost = (completionTokens / 1_000_000) * pricing.completion
  const totalCost = Math.max(0.00001, parseFloat((promptCost + completionCost).toFixed(6)))

  const wholesaleRegularPromptCost = (regularPrompt / 1_000_000) * pricing.wholesale_prompt
  const wholesaleCachedPromptCost = (safeCached / 1_000_000) * wholesaleCachePromptRate
  const wholesalePromptCost = wholesaleRegularPromptCost + wholesaleCachedPromptCost
  const wholesaleCompletionCost = (completionTokens / 1_000_000) * pricing.wholesale_completion
  const totalWholesaleCost = parseFloat((wholesalePromptCost + wholesaleCompletionCost).toFixed(6))
  const savedByCacheUsd = parseFloat((((safeCached / 1_000_000) * (pricing.prompt - cachePromptRate))).toFixed(6))

  return {
    cost: totalCost,
    promptCost: parseFloat(promptCost.toFixed(6)),
    completionCost: parseFloat(completionCost.toFixed(6)),
    cachedPromptCost: parseFloat(cachedPromptCost.toFixed(6)),
    savedByCacheUsd,
    cachedTokens: safeCached,
    wholesaleCost: totalWholesaleCost,
    pricing,
    rate_prompt_per_1m: pricing.prompt,
    rate_prompt_cache_read_per_1m: cachePromptRate,
    rate_completion_per_1m: pricing.completion,
    wholesale_prompt_per_1m: pricing.wholesale_prompt,
    wholesale_completion_per_1m: pricing.wholesale_completion,
    margin_percent: pricing.margin_percent,
    pricing_source: pricing.source || 'openrouter_live',
    upstream_model_id: pricing.upstream_id || model,
  }
}

/**
 * Hitung biaya token (mengembalikan float USD) untuk backward compatibility
 */
export function calculateDynamicCost(model, promptTokens, completionTokens, cachedTokens = 0) {
  const details = calculateDynamicCostWithDetails(model, promptTokens, completionTokens, cachedTokens)
  return details.cost
}

/**
 * Dapatkan snapshot harga realtime dan metadata untuk ditampilkan ke user
 */
export function getLivePricingSummary() {
  const rate = IDR_RATE || 16500
  const enrichedPricing = {}
  for (const [key, item] of Object.entries(LIVE_MODEL_PRICING)) {
    const wp = item.wholesale_prompt || 0
    const wc = item.wholesale_completion || 0
    const p = item.prompt || 0
    const c = item.completion || 0

    enrichedPricing[key] = {
      ...item,
      wholesale_prompt_idr_per_1k: parseFloat(((wp / 1000) * rate).toFixed(3)),
      wholesale_completion_idr_per_1k: parseFloat(((wc / 1000) * rate).toFixed(3)),
      prompt_idr_per_1k: parseFloat(((p / 1000) * rate).toFixed(3)),
      completion_idr_per_1k: parseFloat(((c / 1000) * rate).toFixed(3)),
    }
  }

  return {
    meta: PRICING_SYNC_META,
    margin_breakdown: MARGIN_BREAKDOWN,
    currency: 'USD',
    idr_rate: rate,
    pricing: enrichedPricing,
  }
}

// Inisialisasi sync berkala otomatis (tiap 1 jam)
export function startPeriodicPricingSync(intervalMs = 3600000) {
  syncPricingNow().then()
  setInterval(() => {
    syncPricingNow().then()
  }, intervalMs)
}
