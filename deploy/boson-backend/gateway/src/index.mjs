/**
 * Boson Studio - Backend Auth, Multi-Platform Access, Wallet & Token-Metering Gateway
 * Menghubungkan client Boson Studio, Aethel Studio, CLI, dan Extension dengan
 * Supabase Self-Hosted dan Upstream LLM (DeepSeek, Claude, dll.) secara aman dan terukur.
 */

import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { randomUUID, createHash } from 'node:crypto'
import { calculateDynamicCost, calculateDynamicCostWithDetails, getLivePricingSummary, startPeriodicPricingSync } from './pricingSync.mjs'
import { GOOGLE_AUTH_CONFIG, verifyAndProvisionGoogleUser, renderGoogleCallbackHtml } from './googleAuthIntegration.mjs'
import { XENDIT_CONFIG, createXenditInvoice, processXenditPaymentWebhook, renderSandboxCheckoutHtml, IDR_RATE } from './xenditIntegration.mjs'
import { renderAdminTierDashboardHtml } from './adminTierView.mjs'
import { registerPgMetaRoutes } from './pgMetaBridge.mjs'
import { registerStorageRoutes } from './storageBridge.mjs'
import { registerMcpRoutes } from './mcpBridge.mjs'
import { registerLensRoutes, recordGatewayInference, recordTraceFromOtlp } from './lensBridge.mjs'
import { syncTierBudgetsToLiteLLM, syncUserTierToLiteLLM, recordUserSpendToLiteLLM, recordTokenSpendToLiteLLM, validateLiteLLMToken, getUserSpendAndBudgetFromLiteLLM } from './budgetSync.mjs'

const app = express()
app.set('trust proxy', 1)

export const PLATFORM_NAME = process.env.PLATFORM_NAME || process.env.BRAND_NAME || 'Boson Studio'

// 0. Healthcheck & Liveness Endpoint
app.get(['/health', '/api/health', '/status'], (_req, res) => {
  res.json({
    status: 'healthy',
    service: `${PLATFORM_NAME} Unified LLM Gateway`,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  })
})

// 1. HTTP Security Headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

// 2. Strict CORS Policy Whitelist
const defaultAllowedOrigins = [
  'http://localhost:3080',
  'http://127.0.0.1:3080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5001',
  'http://127.0.0.1:5001',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8088',
  'http://127.0.0.1:8088',
  'http://localhost:4201',
  'http://127.0.0.1:4201',
]

const customOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
const allowedOrigins = new Set([...defaultAllowedOrigins, ...customOrigins])

app.use(cors({
  origin: (origin, callback) => {
    // Non-browser clients (cURL, CLI, Mobile, VSCode Extension, Desktop Electron)
    if (!origin) return callback(null, true)
    if (allowedOrigins.has(origin)) {
      return callback(null, true)
    }
    // Jika dalam development, izinkan localhost atau localho.st dengan port apapun
    if (process.env.NODE_ENV !== 'production' && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:') || origin.includes('.localho.st'))) {
      return callback(null, true)
    }
    return callback(new Error(`CORS Error: Origin '${origin}' ditolak oleh kebijakan keamanan Boson Studio.`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'apikey',
    'x-dsh-auth-token',
    'x-boson-platform-id',
    'x-boson-app-id',
    'x-app-id',
    'x-platform-id',
    'x-callback-token',
    'anthropic-version',
    'anthropic-beta',
    'Prefer',
    'x-lens-contract',
    'x-lens-internal',
    'idempotency-key',
    'session',
    'x-api-key',
  ],
}))

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    console.log(`[HTTP ${req.method}] ${req.originalUrl || req.url} -> ${res.statusCode} (${Date.now() - start}ms) [Auth: ${Boolean(req.headers['authorization'] || req.headers['x-dsh-auth-token'])}]`)
  })
  next()
})

// 2b. Supabase Studio Postgres-Meta Bridge (Query, Policies, Types, Publications, Tables, etc.)
registerPgMetaRoutes(app)

// 2c. Supabase Studio Storage Bridge (Buckets & Objects API)
registerStorageRoutes(app)

// 2d. Supabase Studio MCP Bridge (Streamable HTTP Model Context Protocol)
registerMcpRoutes(app)

// 2e. LiteLLM Lens Agent Tracing & Observability Bridge
registerLensRoutes(app)

// 3. Lightweight In-Memory Rate Limiter
function createRateLimiter({ windowMs = 60 * 1000, max = 120, message = 'Terlalu banyak permintaan. Silakan coba lagi nanti.' }) {
  const ipBuckets = new Map()

  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next()

    // Mode API Gateway / Manual Key: bypass rate limiter untuk user dengan API key manual
    if (req.user?.auth_type === 'api_key') return next()
    const authHeader = req.headers['authorization'] || ''
    const rawToken = req.headers['x-dsh-auth-token'] || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '')
    if (rawToken.startsWith('sk_aethel_') || rawToken.startsWith('sk_boson_')) {
      return next()
    }

    const rawIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'
    const ip = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1'
    const now = Date.now()
    const windowStart = now - windowMs

    let timestamps = ipBuckets.get(ip) || []
    timestamps = timestamps.filter(t => t > windowStart)

    if (timestamps.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
      return res.status(429).json({
        error: {
          code: 'rate_limit_exceeded',
          message,
        },
      })
    }

    timestamps.push(now)
    ipBuckets.set(ip, timestamps)

    if (ipBuckets.size > 5000) {
      for (const [key, list] of ipBuckets.entries()) {
        if (list.length === 0 || list[list.length - 1] < windowStart) {
          ipBuckets.delete(key)
        }
      }
    }

    next()
  }
}

const authRateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Terlalu banyak percobaan autentikasi. Silakan tunggu 1 menit.' })
const billingRateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Terlalu banyak permintaan billing. Silakan tunggu 1 menit.' })
const inferenceRateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 600, message: 'Rate limit inferensi tercapai. Silakan coba beberapa saat lagi.' })

// ─────────────────────────────────────────────────────────────
// KONFIGURASI ENVIRONMENT
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://rest:3000'
const GOTRUE_URL = process.env.GOTRUE_URL || 'http://boson-auth:9999'
const SUPABASE_AUTH_URL = GOTRUE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_UPSTREAM = process.env.DEEPSEEK_UPSTREAM || 'https://api.deepseek.com'
const PLATFORM_PUBLIC_URL = process.env.PLATFORM_PUBLIC_URL || 'http://localhost:8080'
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || 'http://localhost:3000'

// Reverse Proxy ke PostgREST (/rest/v1) - Dilindungi Gatekeeper Autentikasi
app.use('/rest/v1', async (req, res) => {
  try {
    const apikey = req.headers['apikey']
    const authHeader = req.headers['authorization']
    // Tolak request unauthenticated secara langsung sebelum mencapai database engine
    if (!apikey && !authHeader) {
      return res.status(401).json({
        code: 'unauthorized',
        message: 'Akses ke PostgREST diblokir. Diperlukan header apikey atau Authorization yang valid.',
      })
    }

    const targetUrl = `${POSTGREST_URL}${req.url}`
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (lower !== 'host' && lower !== 'content-length') {
        headers[lower] = value
      }
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    if (hasBody && !headers['content-type']) {
      headers['content-type'] = 'application/json'
    }
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    })
    res.status(upstream.status)
    upstream.headers.forEach((val, key) => {
      if (key !== 'content-encoding' && key !== 'content-length' && key !== 'transfer-encoding') {
        res.setHeader(key, val)
      }
    })
    const body = await upstream.text()
    res.end(body)
  } catch (err) {
    if (!res.headersSent) {
      res.removeHeader('content-type')
      res.status(500).json({ error: err.message })
    }
  }
})

// Reverse Proxy ke GoTrue (/auth/v1)
app.use('/auth/v1', async (req, res) => {
  try {
    const targetUrl = `${GOTRUE_URL}${req.url}`
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (lower !== 'host' && lower !== 'content-length') {
        headers[lower] = value
      }
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    if (hasBody && !headers['content-type']) {
      headers['content-type'] = 'application/json'
    }
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    })
    res.status(upstream.status)
    upstream.headers.forEach((val, key) => {
      if (key !== 'content-encoding' && key !== 'content-length' && key !== 'transfer-encoding') {
        res.setHeader(key, val)
      }
    })
    const body = await upstream.text()
    res.end(body)
  } catch (err) {
    if (!res.headersSent) {
      res.removeHeader('content-type')
      res.status(500).json({ error: err.message })
    }
  }
})

// Inisialisasi Supabase Admin Client melalui internal proxy (127.0.0.1:PORT)
const supabase = createClient(`http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY)

// Helper GoTrue Auth Client via HTTP
async function authSignUp(email, password, fullName) {
  const res = await fetch(`${SUPABASE_AUTH_URL}/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || email.split('@')[0] },
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.msg || data.message || 'Gagal mendaftar')
  return data
}

async function authSignIn(email, password) {
  const res = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.msg || data.error_description || 'Email atau kata sandi tidak valid')
  return data
}

async function authGetUser(token) {
  const res = await fetch(`${SUPABASE_AUTH_URL}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  })
  if (!res.ok) return null
  return await res.json()
}

// ─────────────────────────────────────────────────────────────
// PRICING ENGINE: DYNAMIC LIVE SYNC & FAIR MARGIN (WHOLESALE + 15%)
// ─────────────────────────────────────────────────────────────
function calculateCost(model, promptTokens, completionTokens) {
  return calculateDynamicCost(model, promptTokens, completionTokens)
}

// Helper: Format Envelope JSON standar DeepSeek Harness
function envelopeOk(res, data = {}) {
  return res.json({
    code: 0,
    msg: 'ok',
    data: {
      biz_code: 0,
      biz_msg: 'ok',
      biz_data: data,
    },
  })
}

function envelopeFail(res, status = 401, code = 40003, msg = 'Unauthorized') {
  return res.status(status).json({ code, msg })
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: DUAL AUTH & UNIVERSAL SESSION RESOLUTION
// ─────────────────────────────────────────────────────────────
function extractAuthToken(req) {
  let token = req.headers['x-dsh-auth-token'] || req.headers['x-api-key'] || req.headers['session']
  const authHeader = req.headers['authorization']
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim()
  }
  if (!token && req.headers?.cookie) {
    try {
      const cookies = Object.fromEntries(
        req.headers.cookie
          .split(';')
          .map(c => c.trim().split('='))
          .filter(parts => parts.length >= 2)
          .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('='))])
      )
      token = cookies['craft_signed_session'] || cookies['signed_session'] || cookies['sb-access-token'] || null
    } catch {
      // ignore malformed cookie
    }
  }
  return token || null
}

async function resolveUserFromToken(token, req = null) {
  if (!token) return { user: null, error: 'Missing auth token or API key' }

  try {
    // 0. Dukungan Studio Local Token (OpenDesign / Aethel Studio Local Runner)
    if (token === 'studio-local-token') {
      const forwarded = req?.headers?.['x-forwarded-for']
      const directIp = req?.socket?.remoteAddress || req?.ip || ''
      const clientIp = typeof forwarded === 'string' && forwarded.trim()
        ? forwarded.split(',')[0].trim()
        : (typeof directIp === 'string' ? directIp.replace(/^::ffff:/, '').trim() : '')

      const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost'
      const isPrivateSubnet = clientIp.startsWith('172.') || clientIp.startsWith('10.') || clientIp.startsWith('192.168.') || clientIp.startsWith('fc00:') || clientIp.startsWith('fe80:')

      if (!isLoopback && !isPrivateSubnet && process.env.ALLOW_STUDIO_LOCAL_TOKEN !== 'true') {
        return { user: null, error: 'Akses studio-local-token hanya diizinkan untuk lingkungan runtime lokal/desktop.' }
      }

      const { data: fundedWallet } = await supabase
        .from('wallets')
        .select('user_id, bonus_balance, normal_balance, subscription_balance')
        .or('bonus_balance.gt.0,normal_balance.gt.0,subscription_balance.gt.0')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const userId = fundedWallet?.user_id || '9a1f1387-91d5-44cb-8028-8b88acd4631b'
      const { data: profile } = await supabase.from('profiles').select('email').eq('id', userId).maybeSingle()
      const email = profile?.email || 'mohfajrulmutaqin@gmail.com'

      return {
        user: {
          id: userId,
          email,
          auth_type: 'studio_local',
          allowed_platforms: ['*'],
        },
      }
    }

    // 0b. Master Admin Token (LITELLM_MASTER_KEY atau sk-admin)
    const masterAdminKey = process.env.LITELLM_MASTER_KEY || 'sk-admin'
    if (token === masterAdminKey || token === 'sk-admin') {
      return {
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          email: 'admin@boson.local',
          auth_type: 'master_admin',
          allowed_platforms: ['*'],
        },
      }
    }

    // 0c. Virtual API Key dari LiteLLM
    if (token.startsWith('sk-')) {
      const litellmKey = await validateLiteLLMToken(token)
      if (litellmKey) {
        if (!litellmKey.valid) {
          return { user: null, error: litellmKey.message }
        }

        let targetUserId = null
        let targetUserEmail = null

        const metaUser = litellmKey.metadata?.boson_user_id || litellmKey.metadata?.user_id
        if (metaUser) {
          const { data: p } = await supabase.from('profiles').select('id, email').eq('id', metaUser).maybeSingle()
          if (p) {
            targetUserId = p.id
            targetUserEmail = p.email
          }
        }

        if (!targetUserId && litellmKey.user_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(litellmKey.user_id)) {
          const { data: p } = await supabase.from('profiles').select('id, email').eq('id', litellmKey.user_id).maybeSingle()
          if (p) {
            targetUserId = p.id
            targetUserEmail = p.email
          }
        }

        if (!targetUserId && litellmKey.user_id && litellmKey.user_id.includes('@')) {
          const { data: p } = await supabase.from('profiles').select('id, email').eq('email', litellmKey.user_id).maybeSingle()
          if (p) {
            targetUserId = p.id
            targetUserEmail = p.email
          }
        }

        if (!targetUserId) {
          const { data: fundedWallet } = await supabase
            .from('wallets')
            .select('user_id, profiles(id, email)')
            .or('bonus_balance.gt.0,normal_balance.gt.0,subscription_balance.gt.0')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (fundedWallet?.profiles) {
            targetUserId = fundedWallet.profiles.id
            targetUserEmail = fundedWallet.profiles.email
          } else {
            const { data: defProfile } = await supabase.from('profiles').select('id, email').limit(1).maybeSingle()
            if (defProfile) {
              targetUserId = defProfile.id
              targetUserEmail = defProfile.email
            }
          }
        }

        if (!targetUserId) {
          return { user: null, error: 'Tidak ditemukan profil pengguna Boson yang terhubung dengan Virtual Key ini' }
        }

        return {
          user: {
            id: targetUserId,
            email: targetUserEmail,
            auth_type: 'litellm_virtual_key',
            key_name: litellmKey.key_name || litellmKey.key_alias || 'LiteLLM Virtual Key',
            key_hash: litellmKey.token,
            key_type: litellmKey.key_type || 'virtual_key',
            agent_id: litellmKey.agent_id || null,
            team_id: litellmKey.team_id || null,
            allowed_models: litellmKey.models && litellmKey.models.length > 0 ? litellmKey.models : null,
            allowed_platforms: ['*'],
            target_app_id: '*',
          },
        }
      }
    }

    // 1. Personal API Key (Format: sk_boson_... atau sk_aethel_...)
    if (token.startsWith('sk_boson_') || token.startsWith('sk_aethel_')) {
      const keyHash = createHash('sha256').update(token).digest('hex')
      const { data: apiKeyRecord, error: keyErr } = await supabase
        .from('api_keys')
        .select('*, profiles(*)')
        .eq('key_hash', keyHash)
        .eq('is_revoked', false)
        .maybeSingle()

      if (keyErr || !apiKeyRecord) {
        return { user: null, error: 'Invalid or revoked API key' }
      }

      supabase.from('api_keys').update({ last_used_at: new Date() }).eq('id', apiKeyRecord.id).then()

      return {
        user: {
          id: apiKeyRecord.user_id,
          email: apiKeyRecord.profiles?.email,
          auth_type: 'api_key',
          allowed_platforms: apiKeyRecord.allowed_platforms || ['*'],
          target_app_id: apiKeyRecord.target_app_id || '*',
        },
      }
    }

    // 2. Cek apakah ini sesi JWT Supabase
    const user = await authGetUser(token)
    if (user && user.id) {
      return {
        user: { id: user.id, email: user.email, auth_type: 'jwt', allowed_platforms: ['*'] },
      }
    }

    // 3. Fallback: Cek pkce_sessions yang aktif
    const { data: session } = await supabase
      .from('pkce_sessions')
      .select('user_id, profiles(email)')
      .eq('auth_code', token)
      .in('status', ['approved', 'exchanged'])
      .maybeSingle()

    if (session && session.user_id) {
      return {
        user: { id: session.user_id, email: session.profiles?.email || 'user@boson.id', auth_type: 'pkce', allowed_platforms: ['*'] },
      }
    }

    return { user: null, error: 'Invalid or expired session token' }
  } catch (err) {
    console.error('resolveUserFromToken error:', err)
    return { user: null, error: 'Auth verification error' }
  }
}

async function authenticateUser(req, res, next) {
  const token = extractAuthToken(req)
  if (!token) return envelopeFail(res, 401, 40003, 'Missing auth token or API key')

  try {
    const { user, error } = await resolveUserFromToken(token, req)
    if (!user) return envelopeFail(res, 401, 40003, error || 'Unauthorized')
    req.user = user
    return next()
  } catch (err) {
    console.error('Auth verification error:', err)
    return envelopeFail(res, 401, 40003, 'Auth verification error')
  }
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: VERIFIKASI PLATFORM (OWNER ALLOWLIST ENFORCEMENT)
// ─────────────────────────────────────────────────────────────
async function verifyPlatform(req, res, next) {
  // Ambil ID platform / app dari header X-App-Id, X-Aethel-Platform-Id, X-Boson-Platform-Id, dll
  let rawPlatform = req.headers['x-app-id']
    || req.headers['x-aethel-app-id']
    || req.headers['x-aethel-platform-id']
    || req.headers['x-boson-app-id']
    || req.headers['x-boson-platform-id']
    || req.headers['x-platform-id']
    || req.query?.app_id
    || 'aethel-studio'

  if (rawPlatform === 'boson-desktop' || rawPlatform === 'aethel-desktop' || rawPlatform === 'aethel-studio') {
    rawPlatform = 'boson-studio'
  }
  const platformId = String(rawPlatform).trim()

  try {
    const { data: platform, error } = await supabase
      .from('allowed_platforms')
      .select('*')
      .eq('id', platformId)
      .eq('is_active', true)
      .single()

    if (error || !platform) {
      return res.status(403).json({
        error: {
          code: 'platform_forbidden',
          message: `Akses dari platform/aplikasi '${platformId}' belum diizinkan oleh administrator.`,
        },
      })
    }

    // Cek scoping jika menggunakan Personal API Key
    if (req.user?.auth_type === 'api_key') {
      const allowed = req.user.allowed_platforms || ['*']
      const targetApp = req.user.target_app_id || '*'
      const isAllowedPlatform = allowed.includes('*') || allowed.includes(platformId)
      const isAllowedTargetApp = targetApp === '*' || targetApp === platformId

      if (!isAllowedPlatform || !isAllowedTargetApp) {
        return res.status(403).json({
          error: {
            code: 'key_platform_mismatch',
            message: `API Key ini tidak diizinkan untuk digunakan pada platform/aplikasi '${platformId}'.`,
          },
        })
      }
    }

    req.platform = platform
    req.app_id = platformId
    next()
  } catch (err) {
    console.error('Platform verification error:', err)
    return res.status(500).json({ error: 'Failed to verify platform' })
  }
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE / HELPER: VERIFIKASI TIER & ZERO-COST FREE ACCESS
// ─────────────────────────────────────────────────────────────
const syncedTierUsers = new Set()

async function verifyTierAndModelAccess(userId, requestedModel, userAuth = null) {
  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  const userTier = wallet?.tier || 'free'

  // Sinkronkan budget user ke LiteLLM secara otomatis jika belum tersinkron
  if (userId && !syncedTierUsers.has(`${userId}:${userTier}`)) {
    syncedTierUsers.add(`${userId}:${userTier}`)
    syncUserTierToLiteLLM(userId, userTier).catch(err => console.warn('[BudgetSync] User sync error:', err.message))
  }
  const bonus = Number(wallet?.bonus_balance ?? 0)
  const subs = Number(wallet?.subscription_balance ?? 0)
  const normal = Number(wallet?.normal_balance ?? (wallet ? 0 : 2.00))
  const totalBalance = bonus + subs + normal

  // Hanya Studio Local token lingkungan internal yang diberikan akses unmetered
  if (userAuth?.auth_type === 'studio_local' || userAuth?.unmetered === true) {
    return {
      allowed: true,
      userTier: 'studio_local_unmetered',
      tierRule: {
        id: 'studio_local',
        name: 'Studio Local Direct',
        allowed_models: ['*'],
        zero_cost_models: ['*'],
        max_concurrent_streams: 100,
        max_rpm: 10000,
      },
      isZeroCost: true,
      wallet,
      bonus,
      subs,
      normal,
      totalBalance,
    }
  }

  // Ambil aturan tier dari database secara dinamis (dapat diubah owner kapan saja)
  const { data: tierRule } = await supabase
    .from('tier_rules')
    .select('*')
    .eq('id', userTier)
    .eq('is_active', true)
    .maybeSingle()

  const activeRule = tierRule || {
    id: 'free',
    name: 'Free Community Tier',
    allowed_models: ['deepseek-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'llama-3.3-70b-free'],
    zero_cost_models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'llama-3.3-70b-free'],
    max_concurrent_streams: 2,
    max_rpm: 15,
  }

  // 1a. Cek apakah Virtual Key memiliki batasan model tersendiri (LiteLLM models scoping)
  if (userAuth?.allowed_models && Array.isArray(userAuth.allowed_models) && userAuth.allowed_models.length > 0) {
    const isKeyModelAllowed = userAuth.allowed_models.includes('*') || userAuth.allowed_models.includes(requestedModel)
    if (!isKeyModelAllowed) {
      return {
        allowed: false,
        reason: 'key_model_restricted',
        message: `Model '${requestedModel}' tidak diizinkan untuk Virtual Key (${userAuth.key_name || 'LiteLLM Key'}). Model yang diizinkan untuk key ini: ${userAuth.allowed_models.join(', ')}.`,
      }
    }
  }

  // 1b. Cek apakah model diizinkan untuk tier pengguna ini
  const allowedList = activeRule.allowed_models || []
  const isAllowed = allowedList.includes('*') || allowedList.includes(requestedModel)

  if (!isAllowed) {
    const { data: allTiers } = await supabase
      .from('tier_rules')
      .select('id, name, price_usd, allowed_models')
      .eq('is_active', true)
      .order('price_usd', { ascending: true })

    const minTier = (allTiers || []).find(t => 
      t.allowed_models?.includes('*') || t.allowed_models?.includes(requestedModel)
    )

    return {
      allowed: false,
      reason: 'tier_upgrade_required',
      current_tier: userTier,
      required_tier: minTier?.id || 'pro',
      required_tier_name: minTier?.name || 'Paket Pro',
      message: `Model '${requestedModel}' memerlukan paket ${minTier?.name || 'Pro'} atau lebih tinggi. Paket akun Anda saat ini: ${userTier.toUpperCase()}.`,
      upgrade_url: `${PLATFORM_PUBLIC_URL}/billing`,
    }
  }

  // 2. Cek apakah model ini digratiskan (Zero-Cost Model)
  const zeroCostList = activeRule.zero_cost_models || []
  const isZeroCost = zeroCostList.includes('*') || zeroCostList.includes(requestedModel)

  // 3. Cek saldo jika BUKAN model gratis
  const MINIMUM_BALANCE_REQUIRED = 0.0005
  if (!isZeroCost && totalBalance < MINIMUM_BALANCE_REQUIRED) {
    return {
      allowed: false,
      reason: 'insufficient_balance',
      current_balance: totalBalance,
      required_minimum: MINIMUM_BALANCE_REQUIRED,
      message: `Saldo Universal Wallet Anda ($${totalBalance.toFixed(4)}) tidak mencukupi untuk menggunakan model berbayar '${requestedModel}'. Silakan top up saldo atau gunakan model gratis (${zeroCostList.join(', ')}).`,
      upgrade_url: `${PLATFORM_PUBLIC_URL}/billing`,
    }
  }

  // 3b. Cek batas pengeluaran kustom (custom_max_budget) & LiteLLM budget
  if (wallet?.custom_max_budget !== null && wallet?.custom_max_budget !== undefined && Number(wallet.custom_max_budget) > 0) {
    const maxBudget = Number(wallet.custom_max_budget)
    const litellmInfo = await getUserSpendAndBudgetFromLiteLLM(userId)
    const currentSpend = Number(litellmInfo?.spend || 0)
    if (currentSpend >= maxBudget) {
      return {
        allowed: false,
        reason: 'budget_exceeded',
        current_spend: currentSpend,
        max_budget: maxBudget,
        message: `Batas pengeluaran maksimal kustom ($${maxBudget.toFixed(2)}) telah tercapai. Total pengeluaran saat ini: $${currentSpend.toFixed(4)}. Silakan tingkatkan batas budget di tab Deposit atau tunggu periode reset.`,
        upgrade_url: `${PLATFORM_PUBLIC_URL}/billing`,
      }
    }
  }

  return {
    allowed: true,
    userTier,
    tierRule: activeRule,
    isZeroCost,
    wallet,
    bonus,
    subs,
    normal,
    totalBalance,
  }
}

// ─────────────────────────────────────────────────────────────
// 1. OAUTH2 PKCE FLOW (Untuk Boson Studio & Aethel Web)
// ─────────────────────────────────────────────────────────────

app.post('/auth-api/v0/dsh/auth_init', async (req, res) => {
  const { code_challenge, code_challenge_method = 'S256', redirect_uri, state } = req.body
  const authorize_id = randomUUID()
  const expires_at = new Date(Date.now() + 10 * 60 * 1000)

  const { error } = await supabase.from('pkce_sessions').insert({
    authorize_id,
    code_challenge,
    code_challenge_method,
    redirect_uri,
    state,
    status: 'pending',
    expires_at,
  })

  if (error) {
    console.error('Failed to create PKCE session:', error)
    return envelopeFail(res, 500, 50000, error.message)
  }

  return envelopeOk(res, {
    authorize_url: `${PLATFORM_PUBLIC_URL}/dsh/authorize?auth_id=${authorize_id}`,
    authorize_id,
    expires_in: 600,
  })
})

// ─────────────────────────────────────────────────────────────
// 1b. UNIFIED ARTCRAFT & BOSON FRONTEND API CONTRACT (JSON)
// ─────────────────────────────────────────────────────────────

app.get('/v1/session', async (req, res) => {
  const token = extractAuthToken(req)
  if (!token) {
    return res.json({ success: true, logged_in: false, data: { loggedIn: false } })
  }
  const { user } = await resolveUserFromToken(token, req)
  if (!user || !user.id) {
    return res.json({ success: true, logged_in: false, data: { loggedIn: false } })
  }
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle()

  const username = profile?.full_name || profile?.email?.split('@')[0] || 'User'
  const displayName = profile?.full_name || username
  const emailGravatarHash = createHash('md5').update(String(profile?.email || user.email || '').trim().toLowerCase()).digest('hex')

  const userInfo = {
    user_token: user.id,
    username,
    display_name: displayName,
    email_address: profile?.email || user.email,
    email_gravatar_hash: emailGravatarHash,
    core_info: {
      default_avatar: { color_index: 0, image_index: 0 },
      display_name: displayName,
      gravatar_hash: emailGravatarHash,
      user_token: user.id,
      username,
    },
    can_access_studio: true,
    maybe_feature_flags: ['studio', 'omni_gen', 'video_gen'],
    can_use_tts: true,
    can_use_w2l: true,
    can_delete_own_tts_results: true,
    can_delete_own_w2l_results: true,
    can_delete_own_account: true,
    can_upload_tts_models: true,
    can_upload_w2l_templates: true,
    can_delete_own_tts_models: true,
    can_delete_own_w2l_templates: true,
    can_approve_w2l_templates: false,
    can_edit_other_users_profiles: false,
    can_edit_other_users_tts_models: false,
    can_edit_other_users_w2l_templates: false,
    can_delete_other_users_tts_models: false,
    can_delete_other_users_tts_results: false,
    can_delete_other_users_w2l_templates: false,
    can_delete_other_users_w2l_results: false,
    can_ban_users: false,
    can_delete_users: false,
    onboarding: {
      email_not_set: false,
      email_not_confirmed: false,
      password_not_set: false,
      username_not_customized: false,
    },
  }

  const walletInfo = wallet ? {
    balance_usd: (Number(wallet.normal_balance || 0) + Number(wallet.bonus_balance || 0) + Number(wallet.subscription_balance || 0)).toFixed(2),
    normal_balance: Number(wallet.normal_balance || 0).toFixed(2),
    bonus_balance: Number(wallet.bonus_balance || 0).toFixed(2),
    subscription_balance: Number(wallet.subscription_balance || 0).toFixed(2),
    tier: wallet.tier || 'free',
  } : null

  return res.json({
    success: true,
    logged_in: true,
    user: userInfo,
    wallet: walletInfo,
    data: {
      loggedIn: true,
      user: userInfo,
      wallet: walletInfo,
      onboarding: userInfo.onboarding,
    },
  })
})

app.post('/v1/login', authRateLimiter, async (req, res) => {
  const { username_or_email, password } = req.body || {}
  if (!username_or_email || !password) {
    return res.status(400).json({ success: false, error_message: 'Username/email dan kata sandi wajib diisi' })
  }

  let email = String(username_or_email).trim()
  if (!email.includes('@')) {
    const { data: p } = await supabase
      .from('profiles')
      .select('email')
      .ilike('full_name', email)
      .maybeSingle()
    if (p?.email) {
      email = p.email
    }
  }

  try {
    const authData = await authSignIn(email, password)
    const token = authData.access_token
    if (!token) {
      return res.status(401).json({ success: false, error_message: 'Gagal membuat sesi login' })
    }

    res.cookie('craft_signed_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    })

    return res.json({
      success: true,
      signed_session: token,
      user: {
        id: authData.user?.id,
        email: authData.user?.email,
      },
    })
  } catch (err) {
    return res.status(401).json({
      success: false,
      error_message: err.message || 'Email atau kata sandi tidak valid',
    })
  }
})

app.post('/v1/create_account', authRateLimiter, async (req, res) => {
  const { username, password, password_confirmation } = req.body || {}
  const email_address = req.body?.email_address || req.body?.email
  if (!email_address || !password) {
    return res.status(400).json({ success: false, error_message: 'Email dan kata sandi wajib diisi' })
  }
  if (password_confirmation && password !== password_confirmation) {
    return res.status(400).json({ success: false, error_message: 'Konfirmasi kata sandi tidak cocok' })
  }

  try {
    const signupData = await authSignUp(email_address.trim(), password, username?.trim())
    let token = null
    try {
      const authData = await authSignIn(email_address.trim(), password)
      token = authData.access_token
    } catch {
      // login otomatis fallback
    }

    if (token) {
      res.cookie('craft_signed_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      })
    }

    return res.json({
      success: true,
      signed_session: token,
      user: {
        id: signupData.id || signupData.user?.id,
        email: email_address,
      },
    })
  } catch (err) {
    return res.status(400).json({
      success: false,
      error_message: err.message || 'Gagal mendaftar akun baru',
    })
  }
})

app.post(['/v1/logout', '/auth-api/v0/users/logout'], (req, res) => {
  res.clearCookie('craft_signed_session', { path: '/' })
  return res.json({ success: true, message: 'Logged out successfully' })
})

app.get('/v1/billing/active_subscriptions', async (req, res) => {
  const token = extractAuthToken(req)
  if (!token) {
    return res.json({ success: true, active_subscriptions: [] })
  }
  const { user } = await resolveUserFromToken(token, req)
  if (!user || !user.id) {
    return res.json({ success: true, active_subscriptions: [] })
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan_tier, status')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: wallet } = await supabase
    .from('wallets')
    .select('tier')
    .eq('user_id', user.id)
    .maybeSingle()

  const activeTier = sub?.plan_tier || (wallet?.tier && wallet.tier !== 'free' ? wallet.tier : null)
  if (!activeTier) {
    return res.json({ success: true, active_subscriptions: [] })
  }

  return res.json({
    success: true,
    active_subscriptions: [
      {
        namespace: 'craft',
        product_slug: activeTier,
      },
    ],
  })
})

app.post([
  '/v1/stripe_artcraft/checkout/subscription',
  '/v1/stripe_artcraft/user_signup_subscription_checkout',
  '/v1/stripe_artcraft/checkout/credits_pack',
], async (req, res) => {
  const plan = req.body?.plan || 'artcraft_pro'
  const cadence = req.body?.cadence || 'monthly'
  const creditsPack = req.body?.credits_pack
  let amountUSD = 35.00

  if (creditsPack) {
    if (creditsPack === 'artcraft_1000') amountUSD = 10.00
    else if (creditsPack === 'artcraft_2500') amountUSD = 25.00
    else if (creditsPack === 'artcraft_5000') amountUSD = 50.00
    else if (creditsPack === 'artcraft_10000') amountUSD = 100.00
    else {
      const match = String(creditsPack).match(/(\d+)/)
      amountUSD = match ? parseFloat(match[1]) / 100 : 25.00
    }
  } else if (plan === 'artcraft_basic' || plan === 'basic' || plan === 'starter') {
    amountUSD = cadence === 'yearly' ? 96.00 : 10.00
  } else if (plan === 'artcraft_pro' || plan === 'pro') {
    amountUSD = cadence === 'yearly' ? 336.00 : 35.00
  } else if (plan === 'artcraft_max' || plan === 'max' || plan === 'teams') {
    amountUSD = cadence === 'yearly' ? 576.00 : 60.00
  } else if (plan === 'studio') {
    amountUSD = 99.00
  }

  const externalId = `checkout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const redirectUrl = `${FRONTEND_PUBLIC_URL}/pricing?status=success&order=${externalId}`
  const checkoutUrl = `${PLATFORM_PUBLIC_URL}/v1/xendit/sandbox-checkout?external_id=${encodeURIComponent(externalId)}&amount=${Math.round(amountUSD * 16000)}&redirect_url=${encodeURIComponent(redirectUrl)}`

  return res.json({
    success: true,
    stripe_checkout_redirect_url: checkoutUrl,
    checkoutUrl,
  })
})

app.post([
  '/v1/stripe_artcraft/portal/manage_plan',
  '/v1/stripe_artcraft/portal/switch_plan',
], (req, res) => {
  return res.json({
    success: true,
    stripe_portal_url: `${FRONTEND_PUBLIC_URL}/pricing`,
    portalUrl: `${FRONTEND_PUBLIC_URL}/pricing`,
  })
})

app.post('/v1/web_referrals/record', (_req, res) => {
  return res.json({ success: true })
})

// Multi-Modal Omnigen & Job Polling Simulation & Upstream Proxy
const omniGenJobs = new Map()
const STORYTELLER_UPSTREAM = process.env.STORYTELLER_UPSTREAM || 'http://172.17.0.1:12345'

// Models proxy: forwards requests for image/video/audio/mesh models to Storyteller backend
app.get(['/v1/omni_gen/models', '/v1/omni_gen/models/:category'], async (req, res) => {
  try {
    const upstreamRes = await fetch(`${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(3000),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch (err) {
    console.warn(`[OmniGen] Failed to fetch upstream models (${req.url}): ${err.message}`)
  }

  // Fallback if upstream is down or starting up
  return res.json({
    success: true,
    models: [
      {
        model: 'flux_1_dev',
        model_creator: 'black_forest_labs',
        full_name: 'Flux 1 Dev',
        text_prompt_supported: true,
        image_refs_supported: true,
        aspect_ratio_options: ['square', 'wide_sixteen_by_nine', 'tall_nine_by_sixteen'],
        aspect_ratio_default: 'square',
      },
      {
        model: 'nano_banana',
        model_creator: 'artcraft',
        full_name: 'Nano Banana',
        text_prompt_supported: true,
        image_refs_supported: false,
        aspect_ratio_options: ['square'],
        aspect_ratio_default: 'square',
      }
    ],
    providers: [{ provider: 'artcraft', models: [{ model: 'flux_1_dev' }, { model: 'nano_banana' }] }]
  })
})

// OmniGen cost estimation proxy
app.post(['/v1/omni_gen/cost', '/v1/omni_gen/cost/:category'], async (req, res) => {
  const category = req.params.category || 'image'
  try {
    const upstreamRes = await fetch(`${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(3000),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch (err) {
    console.warn(`[OmniGen] Cost estimate upstream warning (${category}): ${err.message}`)
  }

  return res.json({
    success: true,
    cost_in_credits: 4,
    cost_in_usd_cents: 4,
    is_free: false,
    is_unlimited: false,
    is_rate_limited: false,
    has_watermark: false,
    failures_are_refunded: null,
  })
})

app.post(['/v1/omni_gen/generate/video', '/v1/omni_gen/generate/image', '/v1/omni_gen/generate/audio', '/v1/omni_gen/generate/mesh', '/v1/omni_gen/generate/splat'], async (req, res) => {
  try {
    const upstreamRes = await fetch(`${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(3000),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch {
    // Upstream offline fallback
  }

  const pathParts = (req.originalUrl || req.url).split('?')[0].split('/')
  const category = pathParts[pathParts.length - 1] || 'image'
  const jobToken = `job_${Date.now()}_${randomUUID().slice(0, 8)}`
  omniGenJobs.set(jobToken, {
    jobToken,
    createdAt: Date.now(),
    model: req.body?.model || (category === 'video' ? 'wan-2.1-t2v-14b' : 'nano_banana'),
    prompt: req.body?.prompt || '',
    category,
  })

  return res.json({
    success: true,
    inference_job_token: jobToken,
    jobToken,
  })
})

app.get(['/v1/jobs/session', '/v1/jobs/batch'], async (req, res) => {
  try {
    const upstreamRes = await fetch(`${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`, {
      headers: {
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
        ...(req.headers['session'] ? { Session: req.headers['session'] } : {}),
      },
      signal: AbortSignal.timeout(1500),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      if (data && data.success && Array.isArray(data.jobs) && data.jobs.length > 0) {
        return res.json(data)
      }
    }
  } catch {
    // Upstream fallback
  }

  const jobsList = Array.from(omniGenJobs.values()).map(j => {
    const isCompleted = Date.now() - j.createdAt > 3500
    const category = j.category || (j.model?.includes('video') || j.model?.includes('wan') || j.model?.includes('kling') ? 'video' : 'image')
    const cdnUrl = j.resultUrl || (category === 'video' ? '/videos/features/WorldLabs_Demo_2.webm' : '/images/placeholder.webp')

    return {
      job_token: j.jobToken,
      created_at: new Date(j.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
      request: {
        inference_category: category,
        maybe_model_title: j.model || (category === 'video' ? 'Wan 2.1' : 'Nano Banana'),
        maybe_model_token: j.model || (category === 'video' ? 'wan-2.1-t2v-14b' : 'nano_banana'),
        maybe_model_type: j.model || (category === 'video' ? 'wan-2.1-t2v-14b' : 'nano_banana'),
        maybe_prompt_token: null,
        maybe_raw_inference_text: j.prompt || '',
        maybe_style_name: '',
      },
      status: {
        attempt_count: 1,
        maybe_assigned_cluster: 'cluster-1',
        maybe_assigned_worker: 'worker-1',
        maybe_extra_status_description: isCompleted ? '' : 'Generating neural output...',
        maybe_failure_category: '',
        maybe_failure_category_updated: null,
        maybe_failure_message: null,
        maybe_first_started_at: new Date(j.createdAt).toISOString(),
        requires_keepalive: false,
        progress_percentage: isCompleted ? 100 : 50,
        status: isCompleted ? 'complete_success' : 'pending',
      },
      maybe_result: isCompleted ? {
        entity_token: j.jobToken,
        entity_type: category,
        maybe_successfully_completed_at: new Date().toISOString(),
        media_links: {
          cdn_url: cdnUrl,
        },
      } : null,
      state: {
        status: { status: isCompleted ? 'complete_success' : 'pending' },
        maybe_result: isCompleted ? {
          media_links: { cdn_url: cdnUrl }
        } : null
      }
    }
  })

  return res.json({
    success: true,
    jobs: jobsList,
    job_states: jobsList.map(j => j.state),
  })
})

app.get('/v1/jobs/job/:jobToken', async (req, res) => {
  const { jobToken } = req.params
  try {
    const upstreamRes = await fetch(`${STORYTELLER_UPSTREAM}/v1/jobs/job/${jobToken}`, {
      signal: AbortSignal.timeout(1500),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch {
    // Upstream offline fallback
  }

  const job = omniGenJobs.get(jobToken)
  const elapsed = job ? (Date.now() - job.createdAt) : 10000
  if (elapsed < 3500) {
    return res.json({
      success: true,
      state: {
        status: { status: 'pending', maybe_extra_status_description: 'Generating neural frames...' },
      },
    })
  }

  return res.json({
    success: true,
    state: {
      status: { status: 'complete_success' },
      maybe_result: {
        media_links: {
          cdn_url: '/videos/features/WorldLabs_Demo_2.webm',
        },
      },
    },
  })
})

// Unified Credits Endpoint (ArtCraft webapp balance & wallet sync)
app.get(['/v1/credits/namespace/:namespace', '/v1/credits/namespace', '/v1/credits'], async (req, res) => {
  const token = extractAuthToken(req)
  let wallet = null
  if (token) {
    try {
      const { user } = await resolveUserFromToken(token, req)
      if (user?.id) {
        const { data } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle()
        wallet = data
      }
    } catch {
      // Continue with default wallet
    }
  }

  const freeCredits = Math.round(Number(wallet?.bonus_balance || 1.0) * 100)
  const monthlyCredits = Math.round(Number(wallet?.subscription_balance || 0) * 100)
  const bankedCredits = Math.round(Number(wallet?.normal_balance || 0) * 100)
  const sumTotalCredits = freeCredits + monthlyCredits + bankedCredits

  return res.json({
    success: true,
    free_credits: freeCredits,
    monthly_credits: monthlyCredits,
    banked_credits: bankedCredits,
    sum_total_credits: sumTotalCredits,
  })
})

// Unified Media Files Endpoints
app.get([
  '/v1/media_files/list/user/:username',
  '/v1/media_files/list_v2/user/:username',
  '/v1/media_files/list',
  '/v1/media_files/list_featured',
  '/v1/media_files/mesh/list',
  '/v1/media_files/splat/list',
  '/v1/media_files/search_featured',
  '/v1/media_files/search_session',
], async (req, res) => {
  try {
    const upstreamUrl = `${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`
    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
      },
      signal: AbortSignal.timeout(3000),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch (err) {
    console.warn(`[MediaFiles Proxy Error]: ${err.message}`)
  }

  return res.json({
    success: true,
    results: [],
    pagination: {
      current_page: 1,
      page_size: Number(req.query?.page_size) || 40,
      total_items: 0,
      total_pages: 0,
      current: 0,
      has_more: false,
    },
  })
})

app.all(['/v1/media_files/*', '/v1/media_files'], async (req, res) => {
  try {
    const upstreamUrl = `${STORYTELLER_UPSTREAM}${req.originalUrl || req.url}`
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(3000),
    })
    if (upstreamRes.ok) {
      const data = await upstreamRes.json()
      return res.json(data)
    }
  } catch (err) {
    console.warn(`[MediaFiles General Proxy Error]: ${err.message}`)
  }
  return res.json({ success: true, results: [] })
})

app.get(['/login', '/dsh/authorize'], async (req, res) => {
  const auth_id = req.query.auth_id || req.query.authorize_id
  if (!auth_id) return res.redirect(302, `${FRONTEND_PUBLIC_URL}/pricing`)

  res.send(`
    <!doctype html>
    <html lang="id">
      <head>
        <meta charset="utf-8">
        <title>${PLATFORM_NAME} - Autentikasi Akun</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { box-sizing: border-box; }
          body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
          .card { background: #161e2e; padding: 2.25rem; border-radius: 14px; width: 100%; max-width: 400px; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.6); border: 1px solid #1f293d; }
          .logo { text-align: center; font-size: 1.6rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem; }
          .subtitle { text-align: center; color: #94a3b8; font-size: 0.875rem; margin-bottom: 1.5rem; }
          .tabs { display: flex; border-bottom: 1px solid #2d3748; margin-bottom: 1.25rem; }
          .tab { flex: 1; text-align: center; padding: 0.6rem 0; cursor: pointer; color: #94a3b8; font-weight: 600; border-bottom: 2px solid transparent; transition: all 0.2s; }
          .tab.active { color: #38bdf8; border-bottom: 2px solid #38bdf8; }
          label { display: block; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 0.25rem; }
          input { width: 100%; padding: 0.75rem; margin-bottom: 1rem; border-radius: 8px; border: 1px solid #2d3748; background: #0b0f19; color: white; font-size: 0.95rem; }
          input:focus { outline: none; border-color: #38bdf8; }
          button { width: 100%; padding: 0.85rem; border-radius: 8px; border: none; background: #2563eb; color: white; font-weight: 600; font-size: 1rem; cursor: pointer; transition: background 0.15s; }
          button:hover { background: #1d4ed8; }
          .notice { font-size: 0.8rem; color: #38bdf8; margin-top: 0.75rem; text-align: center; background: rgba(56, 189, 248, 0.1); padding: 0.5rem; border-radius: 6px; }
          .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; display: none; background: rgba(239, 68, 68, 0.1); padding: 0.6rem; border-radius: 6px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">${PLATFORM_NAME}</div>
          <div class="subtitle">Unified AI Coding Assistant & Gateway</div>
          <div class="tabs">
            <div id="tabLogin" class="tab active" onclick="switchTab('login')">Masuk</div>
            <div id="tabRegister" class="tab" onclick="switchTab('register')">Daftar Akun Baru</div>
          </div>
          <div id="error" class="error"></div>
          
          <form id="authForm">
            <div id="nameGroup" style="display: none;">
              <label>Nama Lengkap</label>
              <input type="text" id="fullName" placeholder="John Doe">
            </div>
            <label>Email</label>
            <input type="email" id="email" required placeholder="nama@email.com">
            <label>Kata Sandi</label>
            <input type="password" id="password" required placeholder="••••••••">
            <button type="submit" id="submitBtn">Masuk ke ${PLATFORM_NAME}</button>
            <div id="bonusNotice" class="notice" style="display: none;">
              ✨ Pendaftaran baru otomatis mendapatkan <strong>$2.00 Welcome Balance</strong> gratis!
            </div>
          </form>
        </div>
        <script>
          let currentMode = 'login';
          function switchTab(mode) {
            currentMode = mode;
            document.getElementById('error').style.display = 'none';
            if (mode === 'login') {
              document.getElementById('tabLogin').classList.add('active');
              document.getElementById('tabRegister').classList.remove('active');
              document.getElementById('nameGroup').style.display = 'none';
              document.getElementById('bonusNotice').style.display = 'none';
              document.getElementById('submitBtn').textContent = 'Masuk ke ' + ${JSON.stringify(PLATFORM_NAME)};
            } else {
              document.getElementById('tabRegister').classList.add('active');
              document.getElementById('tabLogin').classList.remove('active');
              document.getElementById('nameGroup').style.display = 'block';
              document.getElementById('bonusNotice').style.display = 'block';
              document.getElementById('submitBtn').textContent = 'Daftar Akun ' + ${JSON.stringify(PLATFORM_NAME)};
            }
          }
          }

          document.getElementById('authForm').onsubmit = async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const fullName = document.getElementById('fullName').value.trim();
            const errDiv = document.getElementById('error');
            const submitBtn = document.getElementById('submitBtn');
            errDiv.style.display = 'none';
            submitBtn.disabled = true;

            const endpoint = currentMode === 'login' ? '/api/v0/auth/submit-login' : '/api/v0/auth/submit-register';
            try {
              const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_id: '${auth_id}', email, password, full_name: fullName })
              });
              const data = await resp.json();
              if (resp.ok && data.redirect_uri) {
                window.location.href = data.redirect_uri;
              } else {
                errDiv.textContent = data.msg || 'Terjadi kesalahan saat memproses otentikasi.';
                errDiv.style.display = 'block';
                submitBtn.disabled = false;
              }
            } catch (err) {
              errDiv.textContent = 'Gagal menghubungi server backend.';
              errDiv.style.display = 'block';
              submitBtn.disabled = false;
            }
          };
        </script>
      </body>
    </html>
  `)
})

app.post('/api/v0/auth/submit-login', authRateLimiter, async (req, res) => {
  const { auth_id, email, password } = req.body
  let authData
  try {
    authData = await authSignIn(email, password)
  } catch (err) {
    return res.status(401).json({ msg: err.message || 'Email atau kata sandi tidak valid' })
  }

  const userId = authData.user?.id
  if (!userId) {
    return res.status(401).json({ msg: 'Gagal mendapatkan data akun pengguna' })
  }

  const auth_code = randomUUID()
  const { data: session, error } = await supabase
    .from('pkce_sessions')
    .update({ user_id: userId, auth_code, status: 'approved' })
    .eq('authorize_id', auth_id)
    .select()
    .single()

  if (error || !session) {
    return res.status(400).json({ msg: 'Sesi login tidak valid atau telah kedaluwarsa' })
  }

  const stateParam = session.state || auth_id
  const redirect = session.redirect_uri
    ? `${session.redirect_uri}?code=${encodeURIComponent(auth_code)}&state=${encodeURIComponent(stateParam)}`
    : `${PLATFORM_PUBLIC_URL}/login-success`

  res.json({ redirect_uri: redirect })
})

app.post('/api/v0/auth/submit-register', authRateLimiter, async (req, res) => {
  const { auth_id, email, password, full_name } = req.body
  let authData
  try {
    authData = await authSignUp(email, password, full_name)
  } catch (err) {
    return res.status(400).json({ msg: err.message || 'Gagal mendaftarkan akun baru' })
  }

  const userId = authData.id || authData.user?.id
  if (!userId) {
    return res.status(400).json({ msg: 'Gagal membuat akun pengguna' })
  }

  const auth_code = randomUUID()
  const { data: session, error } = await supabase
    .from('pkce_sessions')
    .update({ user_id: userId, auth_code, status: 'approved' })
    .eq('authorize_id', auth_id)
    .select()
    .single()

  if (error || !session) {
    return res.status(400).json({ msg: 'Sesi registrasi tidak valid atau telah kedaluwarsa' })
  }

  const stateParam = session.state || auth_id
  const redirect = session.redirect_uri
    ? `${session.redirect_uri}?code=${encodeURIComponent(auth_code)}&state=${encodeURIComponent(stateParam)}`
    : `${PLATFORM_PUBLIC_URL}/login-success`

  res.json({ redirect_uri: redirect })
})

app.get(['/login-success', '/dsh/authorized'], (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="id">
      <head>
        <meta charset="utf-8">
        <title>${PLATFORM_NAME} - Berhasil Masuk</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .card { background: #161e2e; padding: 2.5rem; border-radius: 14px; text-align: center; max-width: 420px; border: 1px solid #1f293d; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          .icon { font-size: 3rem; margin-bottom: 1rem; color: #38bdf8; }
          h2 { margin: 0 0 0.5rem; font-size: 1.4rem; color: #38bdf8; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
          .badge { display: inline-block; background: rgba(56, 189, 248, 0.15); color: #38bdf8; padding: 0.4rem 0.8rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <div class="badge">Autentikasi Sukses</div>
          <h2>Selamat Datang di ${PLATFORM_NAME}</h2>
          <p>Akun Anda telah berhasil terhubung. Anda dapat menutup tab ini dan kembali ke aplikasi ${PLATFORM_NAME}.</p>
        </div>
      </body>
    </html>
  `)
})

app.post('/auth-api/v0/dsh/auth_exchange', async (req, res) => {
  const { code, authorize_id, code_verifier } = req.body
  let query = supabase.from('pkce_sessions').select('*, profiles(*)')
  if (code) {
    query = query.eq('auth_code', code)
  } else if (authorize_id) {
    query = query.eq('authorize_id', authorize_id)
  } else {
    return envelopeFail(res, 400, 40003, 'Missing code or authorize_id')
  }

  const { data: session, error } = await query.single()
  if (error || !session || (session.status !== 'approved' && session.status !== 'exchanged')) {
    return envelopeFail(res, 400, 40003, 'Invalid session or not approved')
  }

  // Verifikasi PKCE code_challenge jika verifier dikirim
  if (code_verifier && session.code_challenge) {
    const computedChallenge = createHash('sha256').update(code_verifier).digest('base64url')
    if (computedChallenge !== session.code_challenge) {
      return envelopeFail(res, 400, 40003, 'Invalid code_verifier')
    }
  }

  const token = session.auth_code
  await supabase.from('pkce_sessions').update({ status: 'exchanged' }).eq('authorize_id', session.authorize_id)

  const profile = session.profiles || {}
  return envelopeOk(res, {
    token,
    authorized_url: `${PLATFORM_PUBLIC_URL}/dsh/authorized`,
    user: {
      id: session.user_id,
      email: profile.email || 'user@boson.id',
      id_profile: {
        name: profile.full_name || 'Boson User',
        picture: profile.avatar_url || null,
      },
    },
  })
})

app.post('/auth-api/v0/dsh/auth_cancel', async (req, res) => {
  const { authorize_id } = req.body
  if (authorize_id) {
    await supabase.from('pkce_sessions').update({ status: 'cancelled' }).eq('authorize_id', authorize_id)
  }
  return envelopeOk(res, {})
})

// ─────────────────────────────────────────────────────────────
// 2. WALLET, PROFILE & BILLING API
// ─────────────────────────────────────────────────────────────

app.get('/auth-api/v0/users/current', authenticateUser, async (req, res) => {
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single()

  return envelopeOk(res, {
    id: req.user.id,
    email: req.user.email,
    id_profile: {
      name: profile?.full_name || req.user.email?.split('@')[0],
      picture: profile?.avatar_url || null,
    },
    tier: profile?.tier || 'free',
  })
})

app.get('/api/v0/users/get_user_summary', authenticateUser, async (req, res) => {
  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', req.user.id).single()
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single()

  // Normal balance mencakup saldo deposit + kuota subscription bulanan
  const deposit_balance = Number(wallet?.normal_balance || 0)
  const subs_balance = Number(wallet?.subscription_balance || 0)
  const normal_total = (deposit_balance + subs_balance).toFixed(2)
  const bonus_balance = Number(wallet?.bonus_balance || 0).toFixed(2)

  return envelopeOk(res, {
    normal_wallets: [{ currency: wallet?.currency || 'USD', balance: normal_total }],
    bonus_wallets: [{ currency: wallet?.currency || 'USD', balance: bonus_balance }],
    deposit_balance: deposit_balance.toFixed(2),
    subscription_balance: subs_balance.toFixed(2),
    profile: {
      email: req.user.email,
      name: profile?.full_name || req.user.email?.split('@')[0],
      tier: profile?.tier || 'pro',
    },
  })
})

app.get(['/billing', '/billing/deposit', '/pay', '/top_up', '/usage', '/portal', '/dashboard', '/account', '/keys', '/api-keys'], (req, res) => {
  const path = (req.path || '').toLowerCase()
  if (path.includes('keys') || path.includes('api-keys')) {
    return res.redirect(302, `${FRONTEND_PUBLIC_URL}/pricing#keys`)
  }
  if (path.includes('deposit') || path.includes('pay') || path.includes('top_up')) {
    return res.redirect(302, `${FRONTEND_PUBLIC_URL}/pricing#credits`)
  }
  return res.redirect(302, `${FRONTEND_PUBLIC_URL}/pricing`)
})

app.get(['/admin', '/admin/tiers', '/admin/dashboard', '/tiers/admin'], (_req, res) => {
  res.send(renderAdminTierDashboardHtml(PLATFORM_PUBLIC_URL))
})

app.get(['/v1/pricing', '/api/v0/pricing', '/api/v0/pricing/live'], (req, res) => {
  res.json(getLivePricingSummary())
})

app.get(['/v1/quota', '/api/v0/quota', '/api/v1/wallet/balance'], authenticateUser, async (req, res) => {
  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', req.user.id).single()
  const deposit = Number(wallet?.normal_balance || 0)
  const subs = Number(wallet?.subscription_balance || 0)
  const bonus = Number(wallet?.bonus_balance || 0)
  const total = deposit + subs + bonus
  const isLowBalance = total > 0 && total < 0.20
  const isDepleted = total <= 0

  return res.json({
    success: true,
    total_balance: total,
    deposit_balance: deposit,
    subscription_balance: subs,
    bonus_balance: bonus,
    balanceUsd: total.toFixed(2),
    tier: wallet?.tier || 'free',
    custom_max_budget: wallet?.custom_max_budget !== null && wallet?.custom_max_budget !== undefined ? Number(wallet.custom_max_budget) : null,
    currency: 'USD',
    is_low_balance: isLowBalance,
    is_depleted: isDepleted,
    low_balance_threshold: 0.20,
    warning: isLowBalance ? 'low_balance' : (isDepleted ? 'balance_depleted' : null),
    recommended_action: (isLowBalance || isDepleted) ? 'top_up' : null,
  })
})

// Endpoint untuk setting max budget personal oleh pengguna (User Spending Limit)
app.post(['/api/v0/wallet/max-budget', '/v1/wallet/max-budget'], authenticateUser, async (req, res) => {
  const userId = req.user.id
  const rawBudget = req.body?.max_budget
  const maxBudget = (rawBudget === null || rawBudget === undefined || rawBudget === '') ? null : Number(rawBudget)

  if (maxBudget !== null && (isNaN(maxBudget) || maxBudget < 0)) {
    return res.status(400).json({ success: false, message: 'Nilai max budget tidak valid. Masukkan angka positif atau kosongkan.' })
  }

  const { data: wallet, error } = await supabase
    .from('wallets')
    .update({
      custom_max_budget: maxBudget,
      updated_at: new Date(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    return res.status(500).json({ success: false, message: 'Gagal menyimpan max budget ke database: ' + error.message })
  }

  // Sinkronkan ke LiteLLM Customer Record
  const currentTier = wallet?.tier || 'pay_as_you_go'
  await syncUserTierToLiteLLM(userId, currentTier, maxBudget)

  return res.json({
    success: true,
    message: maxBudget ? `Batas pengeluaran maksimal berhasil diset ke $${maxBudget.toFixed(2)}.` : 'Batas pengeluaran kustom dinonaktifkan (mengikuti limit tier).',
    custom_max_budget: maxBudget,
    tier: currentTier,
  })
})

app.get(['/api/v0/wallet/max-budget', '/v1/wallet/max-budget'], authenticateUser, async (req, res) => {
  const userId = req.user.id
  const { data: wallet } = await supabase
    .from('wallets')
    .select('tier, custom_max_budget, normal_balance, subscription_balance')
    .eq('user_id', userId)
    .maybeSingle()

  return res.json({
    success: true,
    tier: wallet?.tier || 'free',
    custom_max_budget: wallet?.custom_max_budget !== null && wallet?.custom_max_budget !== undefined ? Number(wallet.custom_max_budget) : null,
    current_balance: Number(wallet?.normal_balance || 0) + Number(wallet?.subscription_balance || 0),
  })
})

app.get('/api/v0/users/get_unnotified_bonuses', authenticateUser, async (req, res) => {
  return envelopeOk(res, [])
})

app.post('/api/v0/users/ack_bonus_notified', authenticateUser, async (req, res) => {
  return envelopeOk(res, {})
})

app.post('/auth-api/v0/users/logout', authenticateUser, async (req, res) => {
  return envelopeOk(res, {})
})

// ─────────────────────────────────────────────────────────────
// OPENDESIGN EXTENSIONS: WORKSPACE DIRECTORY & TOUCHPOINTS COMPATIBILITY
// ─────────────────────────────────────────────────────────────

app.get(['/api/v1/workspaces', '/v1/workspaces'], authenticateUser, async (req, res) => {
  const userId = req.user?.id || 'personal'
  const email = req.user?.email || 'user@boson.id'
  const prefix = email.split('@')[0]
  const workspaceName = `${prefix}'s Workspace`
  return res.json({
    items: [
      {
        workspaceId: `ws-${userId}`,
        workspaceName,
        workspaceType: 'personal',
        workspaceMemberId: `mem-${userId}`,
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
    ],
  })
})

app.get('/api/v1/touchpoints/runtime/production', (req, res) => {
  return res.status(204).end()
})

app.get(['/api/v1/touchpoints/runtime/test-deployments', '/api/v1/touchpoints/test-deployments'], (req, res) => {
  return res.json({ deployments: [] })
})

app.get('/api/v1/touchpoints/runtime/test', (req, res) => {
  return res.status(204).end()
})

app.post('/api/v1/touchpoints/runtime/events', (req, res) => {
  return res.json({ ok: true })
})

app.all('/api/v1/collab/*', (req, res) => {
  return res.json({ ok: true, events: [] })
})

// Message Center Inbox (AMR / OpenDesign)
app.get(['/api/v1/message-center/messages', '/v1/message-center/messages'], (_req, res) => {
  return res.json({
    messages: [],
    nextCursor: null,
    unreadCount: 0,
  })
})

app.post(['/api/v1/message-center/messages/:id/read', '/v1/message-center/messages/:id/read'], (_req, res) => {
  return res.json({ success: true })
})

app.post(['/api/v1/message-center/read-all', '/v1/message-center/read-all'], (_req, res) => {
  return res.json({ success: true })
})

app.get(['/api/v1/workspaces/:workspaceId/billing/snapshot', '/v1/workspaces/:workspaceId/billing/snapshot'], authenticateUser, async (req, res) => {
  const userId = req.user?.id || '9a1f1387-91d5-44cb-8028-8b88acd4631b'
  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  const normalBalance = wallet ? parseFloat(wallet.balance || 0) : 2.00
  const bonusBalance = wallet ? parseFloat(wallet.bonus_balance || 0) : 0.00
  const totalBalance = normalBalance + bonusBalance
  const totalCredits = Math.round(totalBalance * 100)

  return res.json({
    workspaceId: req.params.workspaceId,
    balanceUsd: totalBalance.toFixed(2),
    creditsPerUsd: 100,
    balances: {
      subscriptionCredits: '0',
      rechargeCredits: String(totalCredits),
      totalAvailableCredits: String(totalCredits),
    },
    subscriptionCreditsUsd: '0.00',
    rechargeCreditsUsd: totalBalance.toFixed(2),
    totalAvailableCreditsUsd: totalBalance.toFixed(2),
    membershipTier: 'free',
    billingInterval: 'month',
    subscriptionStatus: 'inactive',
    subscriptionEntitlementStatus: 'none',
    subscriptionCancelAtPeriodEnd: false,
    subscriptionCurrentPeriodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
    subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
    pendingSubscriptionChange: null,
    firstMonthIntroEligible: false,
    availableActions: ['recharge', 'upgrade'],
    totalRechargedUsd: totalBalance.toFixed(2),
    totalConsumedUsd: '0.00',
    todayConsumedUsd: '0.00',
    rechargeCount: 1,
    usageCount: 0,
    updatedAt: new Date().toISOString(),
  })
})

app.get(['/api/v1/workspaces/:workspaceId/wallet/balance', '/v1/workspaces/:workspaceId/wallet/balance'], authenticateUser, async (req, res) => {
  const userId = req.user?.id || '9a1f1387-91d5-44cb-8028-8b88acd4631b'
  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  const normalBalance = wallet ? parseFloat(wallet.balance || 0) : 2.00
  const bonusBalance = wallet ? parseFloat(wallet.bonus_balance || 0) : 0.00
  const totalBalance = normalBalance + bonusBalance
  const totalCredits = Math.round(totalBalance * 100)

  return res.json({
    balanceUsd: totalBalance.toFixed(2),
    creditsPerUsd: 100,
    balances: {
      subscriptionCredits: '0',
      rechargeCredits: String(totalCredits),
      totalAvailableCredits: String(totalCredits),
    },
    subscriptionCreditsUsd: '0.00',
    rechargeCreditsUsd: totalBalance.toFixed(2),
    totalAvailableCreditsUsd: totalBalance.toFixed(2),
    totalRechargedUsd: totalBalance.toFixed(2),
    totalConsumedUsd: '0.00',
  })
})

app.get([
  '/api/v1/workspaces/:workspaceId/billing/preflight',
  '/v1/workspaces/:workspaceId/billing/preflight',
  '/api/v1/workspaces/:workspaceId/billing/funding-check',
  '/v1/workspaces/:workspaceId/billing/funding-check',
], authenticateUser, async (req, res) => {
  const workspaceId = req.params.workspaceId || 'ws-default'
  const modelId = typeof req.query.model === 'string'
    ? req.query.model.trim() || null
    : (typeof req.query.modelId === 'string' ? req.query.modelId.trim() || null : null)
  const userId = req.user?.id || '9a1f1387-91d5-44cb-8028-8b88acd4631b'

  const { data: wallet } = await supabase
    .from('wallets')
    .select('normal_balance, bonus_balance, subscription_balance')
    .eq('user_id', userId)
    .maybeSingle()

  const normal = parseFloat(wallet?.normal_balance || 0)
  const bonus = parseFloat(wallet?.bonus_balance || 0)
  const subs = parseFloat(wallet?.subscription_balance || 0)
  const totalBalance = normal + bonus + subs
  const nowIso = new Date().toISOString()

  return res.json({
    schemaVersion: 1,
    workspaceId,
    workspaceMemberId: `member-${userId}`,
    modelId: modelId || null,
    generatedAt: nowIso,
    balanceUsd: totalBalance.toFixed(2),
    modelCovered: true,
    funding: 'gateway',
    fundingCheck: totalBalance > 0 ? 'available' : 'insufficient',
    codingPlan: {
      workspaceId,
      generatedAt: nowIso,
      eligible: false,
      tier: null,
      windows: [],
    },
    ok: true,
    allowed: true,
    sufficientBalance: totalBalance > 0,
    action: 'proceed',
  })
})

app.all(['/api/v1/open-design/*', '/v1/open-design/*', '/api/v1/analytics/*', '/v1/analytics/*'], (_req, res) => {
  return res.json({ ok: true })
})


// ─────────────────────────────────────────────────────────────
// 3. PERSONAL ACCESS TOKEN / API KEYS MANAGEMENT (OMNIPRESENT)
// ─────────────────────────────────────────────────────────────

app.post(['/api/v0/api-keys', '/api/v1/api_keys', '/api/v1/api-keys', '/v1/api_keys', '/v1/api-keys'], authenticateUser, async (req, res) => {
  const { key_name = 'Default Key', allowed_platforms = ['*'], target_app_id = '*' } = req.body
  const rawKey = `sk_boson_${randomUUID().replace(/-/g, '')}`
  const key_prefix = rawKey.slice(0, 15)
  const key_hash = createHash('sha256').update(rawKey).digest('hex')

  const { data, error } = await supabase.from('api_keys').insert({
    user_id: req.user.id,
    key_name,
    key_prefix,
    key_hash,
    allowed_platforms,
    target_app_id,
  }).select('id, key_name, key_prefix, allowed_platforms, target_app_id, created_at').single()

  if (error) return res.status(500).json({ success: false, error: error.message })

  return res.json({
    success: true,
    message: 'API Key berhasil dibuat. Simpan kunci ini sekarang, karena tidak akan ditampilkan lagi.',
    api_key: rawKey,
    apiKey: rawKey,
    id: data?.id,
    keyDetails: data,
  })
})

app.get(['/api/v0/api-keys', '/api/v1/api_keys', '/api/v1/api-keys', '/v1/api_keys', '/v1/api-keys'], authenticateUser, async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_name, key_prefix, allowed_platforms, target_app_id, last_used_at, is_revoked, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ success: false, error: error.message })
  return res.json({ success: true, keys: data })
})

app.delete(['/api/v0/api-keys/:id', '/api/v1/api_keys/:id', '/api/v1/api-keys/:id', '/v1/api_keys/:id', '/v1/api-keys/:id'], authenticateUser, async (req, res) => {
  const { error } = await supabase
    .from('api_keys')
    .update({ is_revoked: true })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) return res.status(500).json({ success: false, error: error.message })
  return res.json({ success: true, message: 'API Key berhasil dicabut' })
})

// ─────────────────────────────────────────────────────────────
// 4. DEPOSIT, SUBSCRIPTION & BILLING ENGINE (PAY-AS-YOU-GO & SUBS)
// ─────────────────────────────────────────────────────────────

// 4a. Daftar Paket & Perbandingan Harga Kompetitif
app.get('/api/v0/billing/plans', async (_req, res) => {
  return res.json({
    plans: [
      {
        id: 'payg',
        name: 'Pay-As-You-Go (Deposit Bebas)',
        price_usd: 0,
        billing_cycle: 'one-time',
        description: 'Bayar murni sesuai token yang dipakai tanpa komitmen bulanan.',
        features: [
          'Tanpa biaya bulanan / komitmen rutin',
          'Minimal deposit mulai Rp25.000 (~$1.50)',
          'Saldo TIDAK PERNAH HANGUS (Never Expires)',
          'Tarif transparan: Wholesale API + fair margin ~15-20%',
          'Akses penuh semua model (DeepSeek V3, R1, Gemini, Claude)',
        ],
      },
      {
        id: 'starter',
        name: 'Developer Starter',
        price_usd: 9.99,
        price_idr: Math.round(9.99 * IDR_RATE),
        billing_cycle: 'monthly',
        token_pool_usd: 12.00,
        description: '50% lebih hemat dari Claude Pro & ChatGPT Plus ($20/bln).',
        features: [
          'Kredit kuota bulanan senilai $12.00 (nilai ekstra 20%)',
          'Dukungan model fast & coding (DeepSeek V3, Gemini 2.5 Flash)',
          'Dukungan model reasoning (DeepSeek R1)',
          'Anti-Lockout: Jika kuota habis, otomatis beralih ke saldo deposit tanpa macet',
          'Rollover kuota aktif hingga 1 bulan berikutnya',
        ],
      },
      {
        id: 'pro',
        name: 'Agentic Pro (Paling Populer)',
        price_usd: 14.99,
        price_idr: Math.round(14.99 * IDR_RATE),
        billing_cycle: 'monthly',
        token_pool_usd: 18.00,
        recommended: true,
        description: '25% lebih hemat dari Claude Pro dengan fleksibilitas multi-model penuh.',
        features: [
          'Kredit kuota bulanan senilai $18.00 (nilai ekstra 20%)',
          'Multi-Model Bebas: DeepSeek V3, R1, Claude 3.5 Sonnet, GPT-4o, Gemini 2.5 Flash',
          'Multi-Agent Swarm, Terminal tools, & Workspace coding tanpa batas',
          'Prioritas antrean eksekusi token di gateway',
          'Hybrid Safety Net: Tidak pernah terkena limit 5 jam seperti Claude Pro',
          'Rollover kuota aktif hingga 1 bulan berikutnya',
        ],
      },
    ],
    comparison_competitors: [
      {
        provider: 'Claude Pro (Anthropic)',
        price: '$20.00 / bulan (~Rp320.000)',
        limitations: 'Hard limit 5 jam (sering mentok saat coding intensif), lockout total sampai jendela reset, tanpa opsi pay-as-you-go top-up saat terhenti.',
        agentic_support: 'Web artifact & chat saja; tidak terhubung ke terminal lokal atau multi-agent swarm.',
      },
      {
        provider: 'ChatGPT Plus (OpenAI)',
        price: '$20.00 / bulan (~Rp320.000)',
        limitations: 'Batas 40-80 pesan per 3 jam untuk GPT-4o, model o1/o3-mini dibatasi ketat per minggu.',
        agentic_support: 'Bukan dedicated coding agent untuk workspace proyek utuh.',
      },
      {
        provider: 'Google Gemini Advanced',
        price: '$20.00 / bulan (~Rp320.000)',
        limitations: 'Terikat ekosistem Google Workspace, web chat umum, bukan dev environment.',
        agentic_support: 'Tidak memiliki native terminal execution atau editor workspace.',
      },
      {
        provider: 'Boson Studio (Solusi Anda)',
        price: 'Mulai $9.99 - $14.99 / bulan (atau Deposit Pay-As-You-Go bebas)',
        limitations: 'Zero-Lockout! Tidak ada jendela kaku 5 jam, bebas lanjut pakai deposit kapan saja.',
        agentic_support: 'Full Agentic: Terminal shell, editor workspace, Git diff, browser tool, subagent.',
      },
    ],
  })
})

// 4b. Buat Transaksi Deposit (Pay-As-You-Go via Xendit QRIS / VA)
app.post('/api/v0/billing/create-deposit', authenticateUser, billingRateLimiter, async (req, res) => {
  const { amount_usd = 5.0, gateway = 'xendit' } = req.body
  const numUSD = parseFloat(amount_usd) || 5.0

  try {
    const invoice = await createXenditInvoice({
      userId: req.user.id,
      email: req.user.email,
      plan: 'deposit',
      amountUSD: numUSD,
      type: 'deposit',
      platformPublicUrl: PLATFORM_PUBLIC_URL,
    })

    await supabase.from('transactions').upsert({
      id: invoice.external_id,
      user_id: req.user.id,
      type: 'deposit',
      amount: numUSD,
      currency: 'USD',
      payment_gateway: gateway,
      status: 'pending',
      metadata: {
        invoice_id: invoice.invoice_id,
        amount_idr: invoice.amount_idr,
        requested_at: new Date().toISOString(),
      },
    })

    return res.json({
      transaction_id: invoice.external_id,
      invoice_id: invoice.invoice_id,
      amount: numUSD,
      amount_idr: invoice.amount_idr,
      payment_url: invoice.invoice_url,
    })
  } catch (err) {
    console.error('Failed to create deposit invoice:', err)
    return res.status(500).json({ error: err.message })
  }
})

// 4c. Buat Transaksi Berlangganan (Subscription via Xendit)
app.post('/api/v0/billing/subscribe', authenticateUser, billingRateLimiter, async (req, res) => {
  const { plan_tier = 'pro', gateway = 'xendit' } = req.body
  const planPrices = { starter: 9.99, pro: 14.99 }
  const planPools = { starter: 12.00, pro: 18.00 }

  const amount_usd = planPrices[plan_tier] || 14.99
  const monthly_token_pool = planPools[plan_tier] || 18.00

  try {
    const invoice = await createXenditInvoice({
      userId: req.user.id,
      email: req.user.email,
      plan: plan_tier,
      amountUSD: amount_usd,
      type: 'subscription',
      platformPublicUrl: PLATFORM_PUBLIC_URL,
    })

    await supabase.from('transactions').upsert({
      id: invoice.external_id,
      user_id: req.user.id,
      type: 'subscription',
      amount: amount_usd,
      currency: 'USD',
      payment_gateway: gateway,
      status: 'pending',
      metadata: {
        invoice_id: invoice.invoice_id,
        plan_tier,
        monthly_token_pool,
        amount_idr: invoice.amount_idr,
        requested_at: new Date().toISOString(),
      },
    })

    return res.json({
      transaction_id: invoice.external_id,
      invoice_id: invoice.invoice_id,
      plan_tier,
      amount_usd,
      amount_idr: invoice.amount_idr,
      monthly_token_pool,
      payment_url: invoice.invoice_url,
    })
  } catch (err) {
    console.error('Failed to create subscription invoice:', err)
    return res.status(500).json({ error: err.message })
  }
})

// 4d. Dedicated Xendit & Gateway Webhook Endpoints
app.post(['/v1/xendit/webhook', '/api/xendit/webhook', '/v1/webhook/xendit', '/api/v0/billing/webhook'], async (req, res) => {
  try {
    const callbackToken = req.headers['x-callback-token']
    const result = await processXenditPaymentWebhook(req.body, callbackToken, supabase)
    return res.json(result)
  } catch (err) {
    console.error('[Xendit Webhook Error]:', err.message)
    return res.status(400).json({ success: false, error: err.message })
  }
})

// 4e. Xendit Create Invoice API (Compatible dengan AI_SAAS)
app.post(['/v1/xendit/invoice', '/api/xendit/invoice', '/v1/xendit/create-invoice'], async (req, res) => {
  try {
    let authUser = null
    const authHeader = req.headers['authorization'] || req.headers['x-dsh-auth-token']
    if (authHeader) {
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim()
      if (token.startsWith('sk_boson_') || token.startsWith('sk_aethel_')) {
        const keyHash = createHash('sha256').update(token).digest('hex')
        const { data: k } = await supabase.from('api_keys').select('*, profiles(*)').eq('key_hash', keyHash).single()
        if (k) authUser = { id: k.user_id, email: k.profiles?.email }
      } else {
        const { data: s } = await supabase.from('pkce_sessions').select('user_id, profiles(email)').eq('auth_code', token).single()
        if (s) authUser = { id: s.user_id, email: s.profiles?.email }
      }
    }

    const payload = req.body || {}
    const userId = authUser?.id || payload.userId || payload.user_id || payload.uid
    const email = authUser?.email || payload.email || payload.payerEmail

    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID wajib disertakan.' })
    }

    const plan = payload.plan || 'pro'
    const amountUSD = parseFloat(payload.amountUSD || payload.amount_usd || (plan === 'starter' ? 9.99 : 14.99))
    const type = payload.type || (payload.topupUSD ? 'deposit' : 'subscription')

    const invoice = await createXenditInvoice({
      userId,
      email,
      plan,
      amountUSD,
      type,
      platformPublicUrl: PLATFORM_PUBLIC_URL,
    })

    await supabase.from('transactions').insert({
      user_id: userId,
      type,
      amount: amountUSD,
      currency: 'USD',
      payment_gateway: 'xendit',
      gateway_reference: invoice.external_id,
      status: 'pending',
      metadata: {
        invoice_id: invoice.invoice_id,
        external_id: invoice.external_id,
        plan,
        amount_idr: invoice.amount_idr,
        created_at: new Date().toISOString(),
      },
    })

    return res.json(invoice)
  } catch (err) {
    console.error('[Xendit Create Invoice Error]:', err.message)
    return res.status(500).json({ success: false, error: err.message })
  }
})

// 4f. Interactive Sandbox Checkout Simulator
app.get('/v1/xendit/sandbox-checkout', (req, res) => {
  const externalId = req.query.external_id || 'xendit_demo_order'
  const amount = req.query.amount || '240000'
  const redirectUrl = req.query.redirect_url || `${PLATFORM_PUBLIC_URL}/billing`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderSandboxCheckoutHtml({
    externalId,
    amount,
    redirectUrl,
    webhookToken: XENDIT_CONFIG.webhookToken,
  }))
})

// 4g. Status Transaksi & Invoice Xendit
app.get(['/v1/xendit/status', '/v1/xendit/invoice/:id'], async (req, res) => {
  const id = req.params.id || req.query.id || req.query.external_id
  if (!id) return res.status(400).json({ error: 'Missing id or external_id' })

  const { data: tx } = await supabase.from('transactions').select('*').or(`id.eq.${id},metadata->>invoice_id.eq.${id}`).single()
  if (!tx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' })
  return res.json({ success: true, transaction: tx })
})

// 4h. Paket Langganan Xendit dalam Kurs IDR
app.get(['/v1/xendit/plans', '/api/xendit/plans'], (_req, res) => {
  return res.json({
    success: true,
    currency: 'IDR',
    plans: {
      starter: { idr: Math.round(9.99 * IDR_RATE), usd: 9.99, name: 'Starter Plan', monthlyQuotaUSD: 12.00 },
      pro: { idr: Math.round(14.99 * IDR_RATE), usd: 14.99, name: 'Pro Plan', monthlyQuotaUSD: 18.00 },
    },
    depositRatePerUSD: IDR_RATE,
  })
})

// ─────────────────────────────────────────────────────────────
// GOOGLE OAUTH 2.0 SINGLE SIGN-ON (COMPATIBLE DENGAN AI_SAAS)
// ─────────────────────────────────────────────────────────────

app.get(['/v1/auth/google/popup', '/auth/google/popup'], (req, res) => {
  const customRedirect = req.query.redirect_uri
  const returnOrigin = req.query.origin || ''
  const sessionId = req.query.session_id || req.query.sessionId || ''

  let redirectUri = customRedirect || process.env.GOOGLE_REDIRECT_URI
  if (!redirectUri) {
    const host = req.headers.host || ''
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
      const port = host.includes(':') ? host.split(':')[1] : '5001'
      redirectUri = `http://localhost:${port}/v1/auth/google/callback`
    } else {
      const protocol = req.headers['x-forwarded-proto'] || 'http'
      redirectUri = `${protocol}://${host}/v1/auth/google/callback`
    }
  }

  const googleClientId = GOOGLE_AUTH_CONFIG.clientId
  const stateData = Buffer.from(JSON.stringify({ returnOrigin, sessionId })).toString('base64url')

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(googleClientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=token%20id_token` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    `&prompt=select_account` +
    `&state=${stateData}` +
    `&nonce=boson_${Date.now()}`

  res.redirect(googleAuthUrl)
})

app.get(['/v1/auth/google/callback', '/auth/google/callback'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderGoogleCallbackHtml())
})

app.post(['/v1/auth/google', '/auth/google'], authRateLimiter, async (req, res) => {
  const { idToken, accessToken, sessionId, email, name, googleId, avatarUrl } = req.body
  try {
    const result = await verifyAndProvisionGoogleUser({
      idToken,
      accessToken,
      email,
      name,
      googleId,
      avatarUrl,
      supabase,
      authSignUp,
    })

    if (sessionId && result.success) {
      if (!global._oauthSessions) global._oauthSessions = new Map()
      global._oauthSessions.set(sessionId, {
        data: result,
        expiresAt: Date.now() + 10 * 60 * 1000,
      })
    }

    return res.json(result)
  } catch (err) {
    console.error('[Google SSO Auth Error]:', err.message)
    return res.status(400).json({ success: false, error: err.message })
  }
})

app.get(['/v1/auth/google/session/:sessionId', '/auth/google/session/:sessionId'], (req, res) => {
  const { sessionId } = req.params
  if (!global._oauthSessions) global._oauthSessions = new Map()
  const session = global._oauthSessions.get(sessionId)
  if (session && session.expiresAt > Date.now()) {
    global._oauthSessions.delete(sessionId)
    return res.json(session.data)
  }
  return res.status(404).json({ success: false, message: 'Session tidak ditemukan atau kedaluwarsa.' })
})

// 4e. Instant Testing Helper (Untuk Simulasi Top Up & Subs di Masa Dev/Staging)
app.post('/api/v0/billing/test-topup', authenticateUser, async (req, res) => {
  if (req.body.tier || req.body.bonus_balance !== undefined || req.body.subscription_balance !== undefined || req.body.normal_balance !== undefined) {
    const updatePayload = { updated_at: new Date() }
    if (req.body.tier) updatePayload.tier = req.body.tier
    if (req.body.bonus_balance !== undefined) updatePayload.bonus_balance = Number(req.body.bonus_balance)
    if (req.body.subscription_balance !== undefined) updatePayload.subscription_balance = Number(req.body.subscription_balance)
    if (req.body.normal_balance !== undefined) updatePayload.normal_balance = Number(req.body.normal_balance)

    await supabase.from('wallets').update(updatePayload).eq('user_id', req.user.id)
    if (req.body.tier) {
      await syncUserTierToLiteLLM(req.user.id, req.body.tier)
    }
    const { data: updatedWallet } = await supabase.from('wallets').select('*').eq('user_id', req.user.id).single()
    return res.json({ success: true, message: 'Wallet balance updated for testing', wallet: updatedWallet })
  }

  const { amount_usd = 5.0, type = 'deposit', plan_tier = 'pro' } = req.body
  const transactionId = randomUUID()

  const monthlyPool = plan_tier === 'starter' ? 12.00 : 18.00
  await supabase.from('transactions').insert({
    id: transactionId,
    user_id: req.user.id,
    type,
    amount: amount_usd,
    currency: 'USD',
    payment_gateway: 'simulation',
    status: 'pending',
    metadata: { plan_tier, monthly_token_pool: monthlyPool },
  })

  // Langsung trigger webhook internal untuk menyelesaikan simulasi
  const fakeReq = { body: { transaction_id: transactionId, status: 'success' } }
  let webhookResult = null
  await new Promise((resolve) => {
    const fakeRes = { json: (data) => { webhookResult = data; resolve(data) } }
    app._router.handle({ method: 'POST', url: '/api/v0/billing/webhook', headers: {}, body: fakeReq.body }, fakeRes, resolve)
  })

  const { data: updatedWallet } = await supabase.from('wallets').select('*').eq('user_id', req.user.id).single()
  return res.json({
    success: true,
    message: `Simulasi ${type} berhasil ditambahkan!`,
    wallet: updatedWallet,
  })
})

// 4f. Riwayat Pemotongan Token Realtime (Usage Ledger)
app.get('/api/v0/billing/usage-history', authenticateUser, async (req, res) => {
  const { data: logs, error } = await supabase
    .from('usage_ledger')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ logs: logs || [] })
})

// 4f-2. Agregasi Pengeluaran Harian & Riwayat Token Visual
app.get(['/api/v0/billing/daily-usage', '/api/v1/billing/daily-usage'], authenticateUser, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '14', 10), 1), 60)
  try {
    const { data, error } = await supabase.rpc('get_user_daily_usage', {
      p_user_id: req.user.id,
      p_days: days,
    })
    if (error) {
      console.error('get_user_daily_usage error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.json({
      success: true,
      ...data,
    })
  } catch (err) {
    console.error('daily-usage catch error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// 4f-3. Agregasi Pengeluaran Berdasarkan SaaS Apps (Multi-App Universal Wallet Breakdown)
app.get(['/api/v0/billing/usage-by-app', '/api/v1/billing/usage-by-app'], authenticateUser, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365)
  try {
    const { data, error } = await supabase.rpc('get_user_usage_by_app', {
      p_user_id: req.user.id,
      p_days: days,
    })
    if (error) {
      console.error('[Usage By App] RPC error:', error)
      return res.status(500).json({ error: error.message })
    }
    return res.json({
      success: true,
      ...data,
    })
  } catch (err) {
    console.error('[Usage By App] Catch error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// 4f-4. Daftar SaaS Apps yang Terhubung & Didukung
app.get(['/api/v0/apps', '/api/v1/apps'], authenticateUser, async (_req, res) => {
  try {
    const { data: apps, error } = await supabase
      .from('allowed_platforms')
      .select('id, name, allowed_models, max_concurrent_streams, is_active, created_at')
      .eq('is_active', true)
      .order('id', { ascending: true })

    if (error) {
      return res.status(500).json({ error: error.message })
    }
    return res.json({
      success: true,
      apps: apps || [],
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// 4f-5. Registrasi / Pendaftaran Aplikasi SaaS Baru Secara Dinamis
app.post(['/api/v0/apps', '/api/v1/apps'], authenticateUser, async (req, res) => {
  const {
    id,
    name,
    allowed_models = ['*'],
    max_concurrent_streams = 5,
    is_active = true,
  } = req.body

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Field "id" (slug aplikasi, e.g. "my-saas-app") wajib diisi.' })
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Field "name" (nama aplikasi) wajib diisi.' })
  }

  const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')

  try {
    const { data: newApp, error } = await supabase
      .from('allowed_platforms')
      .upsert({
        id: cleanId,
        name: name.trim(),
        allowed_models: Array.isArray(allowed_models) ? allowed_models : ['*'],
        max_concurrent_streams: Number(max_concurrent_streams) || 5,
        is_active: Boolean(is_active),
      })
      .select('*')
      .single()

    if (error) {
      console.error('[Apps Register] Error:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(201).json({
      success: true,
      message: `Aplikasi '${cleanId}' berhasil didaftarkan ke ekosistem Universal Wallet.`,
      app: newApp,
    })
  } catch (err) {
    console.error('[Apps Register] Catch error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// 4f-6. Mengambil Daftar Aturan Tier Langganan & Model Gratis (GET /api/v0/tiers)
app.get(['/api/v0/tiers', '/api/v1/tiers'], authenticateUser, async (_req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('tier_rules')
      .select('*')
      .order('price_usd', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })
    return res.json({
      success: true,
      tiers: tiers || [],
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// 4f-7. Mengubah / Mengatur Model & Aturan Tier Secara Dinamis (PUT /api/v0/tiers/:id)
app.put(['/api/v0/tiers/:id', '/api/v1/tiers/:id'], authenticateUser, async (req, res) => {
  const tierId = req.params.id
  const {
    name,
    price_usd,
    allowed_models,
    zero_cost_models,
    max_concurrent_streams,
    max_rpm,
    is_active,
    description,
  } = req.body

  const updateData = { updated_at: new Date().toISOString() }
  if (name !== undefined) updateData.name = name
  if (price_usd !== undefined) updateData.price_usd = Number(price_usd)
  if (allowed_models !== undefined) updateData.allowed_models = Array.isArray(allowed_models) ? allowed_models : ['*']
  if (zero_cost_models !== undefined) updateData.zero_cost_models = Array.isArray(zero_cost_models) ? zero_cost_models : []
  if (max_concurrent_streams !== undefined) updateData.max_concurrent_streams = Number(max_concurrent_streams)
  if (max_rpm !== undefined) updateData.max_rpm = Number(max_rpm)
  if (is_active !== undefined) updateData.is_active = Boolean(is_active)
  if (description !== undefined) updateData.description = description

  try {
    const { data: updatedTier, error } = await supabase
      .from('tier_rules')
      .update(updateData)
      .eq('id', tierId)
      .select('*')
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // Sinkronkan perubahan tier ke LiteLLM Budgets secara otomatis
    syncTierBudgetsToLiteLLM(supabase).catch(err => console.warn('[BudgetSync] Background sync error:', err.message))

    return res.json({
      success: true,
      message: `Konfigurasi tier '${tierId}' berhasil diperbarui secara dinamis.`,
      tier: updatedTier,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// 4f-8. Menambah Tier Baru Secara Dinamis (POST /api/v0/tiers)
app.post(['/api/v0/tiers', '/api/v1/tiers'], authenticateUser, async (req, res) => {
  const {
    id,
    name,
    price_usd = 0.00,
    allowed_models = ['*'],
    zero_cost_models = [],
    max_concurrent_streams = 5,
    max_rpm = 60,
    is_active = true,
    description = '',
  } = req.body

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Field "id" (slug tier, misal "starter", "team") wajib diisi.' })
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Field "name" (nama paket) wajib diisi.' })
  }

  const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')

  try {
    const { data: newTier, error } = await supabase
      .from('tier_rules')
      .upsert({
        id: cleanId,
        name: name.trim(),
        price_usd: Number(price_usd) || 0.00,
        allowed_models: Array.isArray(allowed_models) ? allowed_models : ['*'],
        zero_cost_models: Array.isArray(zero_cost_models) ? zero_cost_models : [],
        max_concurrent_streams: Number(max_concurrent_streams) || 5,
        max_rpm: Number(max_rpm) || 60,
        is_active: Boolean(is_active),
        description,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // Sinkronkan tier baru ke LiteLLM Budgets secara otomatis
    syncTierBudgetsToLiteLLM(supabase).catch(err => console.warn('[BudgetSync] Background sync error:', err.message))

    return res.status(201).json({
      success: true,
      message: `Tier '${cleanId}' berhasil didaftarkan dan tersinkronisasi.`,
      tier: newTier,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// 4g. AMR / Vela Billing Summary API (/api/v1/billing/summary)
app.get(['/api/v1/billing/summary', '/v1/billing/summary', '/billing/summary'], authenticateUser, async (req, res) => {
  const userId = req.user.id
  try {
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).single()
    const bonus = Number(wallet?.bonus_balance || 0)
    const subs = Number(wallet?.subscription_balance || 0)
    const normal = Number(wallet?.normal_balance || 0)
    const total = bonus + subs + normal
    const balanceUsdStr = total.toFixed(2)
    const tier = subs > 0 ? 'pro' : 'free'

    const totalCreditsInt = Math.round(total * 100)
    const subsCreditsInt = Math.round(subs * 100)
    const normalCreditsInt = Math.round((normal + bonus) * 100)

    const summaryData = {
      balanceUsd: balanceUsdStr,
      creditsPerUsd: 100,
      balances: {
        subscriptionCredits: subsCreditsInt.toString(),
        rechargeCredits: normalCreditsInt.toString(),
        totalAvailableCredits: totalCreditsInt.toString(),
        subscriptionCreditsUsd: subs.toFixed(2),
        rechargeCreditsUsd: (normal + bonus).toFixed(2),
        balanceUsd: balanceUsdStr,
        totalAvailableCreditsUsd: balanceUsdStr,
      },
      subscriptionCreditsUsd: subs.toFixed(2),
      rechargeCreditsUsd: (normal + bonus).toFixed(2),
      totalAvailableCreditsUsd: balanceUsdStr,
      membershipTier: tier,
      billingInterval: 'month',
      subscriptionStatus: subs > 0 ? 'active' : 'inactive',
      subscriptionEntitlementStatus: subs > 0 ? 'active' : 'none',
      subscriptionCancelAtPeriodEnd: false,
      subscriptionCurrentPeriodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      firstMonthIntroEligible: false,
      availableActions: ['recharge', 'upgrade'],
      totalRechargedUsd: (normal + subs + bonus).toFixed(2),
      totalConsumedUsd: '0.00',
      todayConsumedUsd: '0.00',
      rechargeCount: 1,
      usageCount: 0,
      updatedAt: new Date().toISOString(),
      // Backward compatibility fields
      subscriptionCredits: subsCreditsInt.toString(),
      rechargeCredits: normalCreditsInt.toString(),
      totalAvailableCredits: totalCreditsInt.toString(),
      walletBalance: Number(total.toFixed(4)),
    }

    return res.json({
      code: 0,
      msg: 'ok',
      data: summaryData,
      ...summaryData,
    })
  } catch (err) {
    console.error('[Billing Summary] Error:', err)
    return res.status(500).json({ error: 'Failed to fetch billing summary' })
  }
})

// 4h. AMR / Vela Billing Recoveries Fallback
app.all(['/api/v1/billing/recoveries*', '/v1/billing/recoveries*'], authenticateUser, async (_req, res) => {
  return res.json({
    code: 0,
    msg: 'ok',
    data: {
      status: 'active',
      recoveries: [],
    },
  })
})


// ─────────────────────────────────────────────────────────────
// 5. INFERENCE PROXY DENGAN PRE-FLIGHT CHECK & STREAMING METERING
// ─────────────────────────────────────────────────────────────

app.get(['/models', '/v1/models', '/api/v0/models', '/api/v1/models', '/v1/api/models'], async (_req, res) => {
  const models = [
    {
      id: 'deepseek-chat',
      object: 'model',
      owned_by: 'boson',
      name: 'DeepSeek V3 (Chat)',
      created: 1700000000,
      context_window: 64000,
      max_output_tokens: 8192,
      input_modalities: ['text'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'leading-only',
        },
      },
    },
    {
      id: 'deepseek-flash',
      object: 'model',
      owned_by: 'boson',
      name: 'DeepSeek V4.1 Flash',
      created: 1700000000,
      context_window: 1000000,
      max_output_tokens: 256000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'in-history',
        },
      },
    },
    {
      id: 'deepseek-v4-pro',
      object: 'model',
      owned_by: 'boson',
      name: 'DeepSeek V4 Pro',
      created: 1700000000,
      context_window: 1000000,
      max_output_tokens: 256000,
      input_modalities: ['text'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'leading-only',
        },
      },
    },
    {
      id: 'deepseek-reasoner',
      object: 'model',
      owned_by: 'boson',
      name: 'DeepSeek R1 (Reasoning)',
      created: 1700000000,
      context_window: 64000,
      max_output_tokens: 8192,
      input_modalities: ['text'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'leading-only',
        },
      },
    },
    {
      id: 'claude-3-5-sonnet',
      object: 'model',
      owned_by: 'boson',
      name: 'Claude 3.5 Sonnet (Anthropic)',
      created: 1700000000,
      context_window: 200000,
      max_output_tokens: 8192,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'leading-only',
        },
      },
    },
    {
      id: 'gpt-4o',
      object: 'model',
      owned_by: 'boson',
      name: 'GPT-4o (OpenAI)',
      created: 1700000000,
      context_window: 128000,
      max_output_tokens: 4096,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'leading-only',
        },
      },
    },
    {
      id: 'gemini-2.5-flash',
      object: 'model',
      owned_by: 'boson',
      name: 'Gemini 2.5 Flash (Google)',
      created: 1700000000,
      context_window: 1000000,
      max_output_tokens: 8192,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'in-history',
        },
      },
    },
    {
      id: 'gemini-2.0-flash',
      object: 'model',
      owned_by: 'boson',
      name: 'Gemini 2.0 Flash (Google)',
      created: 1700000000,
      context_window: 1000000,
      max_output_tokens: 8192,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'in-history',
        },
      },
    },
    {
      id: 'llama-3.3-70b-free',
      object: 'model',
      owned_by: 'boson',
      name: 'Llama 3.3 70B (Free Community)',
      created: 1700000000,
      context_window: 128000,
      max_output_tokens: 8192,
      input_modalities: ['text'],
      output_modalities: ['text'],
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'in-history',
        },
      },
    },
  ]

  res.json({
    object: 'list',
    data: models,
  })
})

// 4b. PUBLIC AI MODEL HUB PROXY (LITELLM INTEGRATION)
app.get(['/public/model_hub', '/public/v1/model_hub', '/public/model_hub/info', '/api/v0/hub', '/v1/hub'], async (req, res) => {
  try {
    const upstreamPath = req.originalUrl || req.url
    const upstreamUrl = `${DEEPSEEK_UPSTREAM}${upstreamPath.startsWith('/public') ? upstreamPath : '/public/model_hub'}`
    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY || 'sk-admin'}`
      }
    })
    const data = await upstreamRes.json()
    res.status(upstreamRes.status).json(data)
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghubungkan ke AI Model Hub', details: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// 4c. FILES API (DEEPSEEK HARNESS MULTIMODAL COMPATIBILITY)
// ─────────────────────────────────────────────────────────────
const fileStore = new Map()

function inlineStoredFiles(messages, store) {
  if (!Array.isArray(messages)) return messages
  return messages.map(msg => {
    if (!Array.isArray(msg?.content)) return msg
    const newContent = msg.content.map(block => {
      if (block && block.type === 'image' && block.source?.type === 'file' && block.source?.file_id) {
        const stored = store.get(block.source.file_id)
        if (stored) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: stored.mime_type,
              data: stored.base64,
            },
          }
        }
      }
      return block
    })
    return { ...msg, content: newContent }
  })
}

// Upload file (DeepSeek Files API: POST /v1/files)
app.post(['/v1/files', '/files'], authenticateUser, async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBuffer = Buffer.concat(chunks)

    const fakeResp = new Response(rawBuffer, {
      headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
    })
    const formData = await fakeResp.formData()
    const file = formData.get('file')
    const expiresAfterSec = Number(formData.get('expires_after[seconds]') || 86400)

    if (!file || typeof file === 'string') {
      return res.status(400).json({ error: { message: 'Missing file payload', type: 'invalid_request_error' } })
    }

    const fileBytes = Buffer.from(await file.arrayBuffer())
    const fileId = `file_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const mimeType = file.type || 'image/png'
    const nowIso = new Date().toISOString()

    const fileObj = {
      id: fileId,
      type: 'file',
      size_bytes: fileBytes.length,
      created_at: nowIso,
      filename: file.name || `${fileId}.png`,
      mime_type: mimeType,
      expires_at: Math.floor(Date.now() / 1000) + expiresAfterSec,
      buffer: fileBytes,
      base64: fileBytes.toString('base64'),
    }

    fileStore.set(fileId, fileObj)

    if (fileStore.size > 200) {
      const oldestKey = fileStore.keys().next().value
      fileStore.delete(oldestKey)
    }

    res.json({
      id: fileObj.id,
      type: fileObj.type,
      size_bytes: fileObj.size_bytes,
      created_at: fileObj.created_at,
      filename: fileObj.filename,
      mime_type: fileObj.mime_type,
    })
  } catch (err) {
    console.error('[Files API] Upload error:', err)
    res.status(500).json({ error: { message: 'Failed to process file upload', type: 'api_error' } })
  }
})

// List files (DeepSeek Files API: GET /v1/files)
app.get(['/v1/files', '/files'], authenticateUser, (req, res) => {
  const list = []
  for (const f of fileStore.values()) {
    list.push({
      id: f.id,
      type: f.type,
      size_bytes: f.size_bytes,
      created_at: f.created_at,
      filename: f.filename,
      mime_type: f.mime_type,
    })
  }
  res.json({
    data: list,
    first_id: list[0]?.id,
    last_id: list.at(-1)?.id,
    has_more: false,
  })
})

// Retrieve file (DeepSeek Files API: GET /v1/files/:file_id)
app.get(['/v1/files/:file_id', '/files/:file_id'], authenticateUser, (req, res) => {
  const f = fileStore.get(req.params.file_id)
  if (!f) return res.status(404).json({ error: { message: 'File not found', type: 'invalid_request_error' } })
  res.json({
    id: f.id,
    type: f.type,
    size_bytes: f.size_bytes,
    created_at: f.created_at,
    filename: f.filename,
    mime_type: f.mime_type,
  })
})

// Delete file (DeepSeek Files API: DELETE /v1/files/:file_id)
app.delete(['/v1/files/:file_id', '/files/:file_id'], authenticateUser, (req, res) => {
  fileStore.delete(req.params.file_id)
  res.json({
    id: req.params.file_id,
    type: 'file_deleted',
  })
})

// 5a. ANTHROPIC MESSAGES API (Digunakan native oleh DeepSeek Harness & Boson Studio)
app.post(['/v1/messages', '/messages'], authenticateUser, verifyPlatform, inferenceRateLimiter, async (req, res) => {
  const userId = req.user.id
  const platformId = req.platform?.id || 'boson-desktop'
  const requestedModel = req.body.model || 'deepseek-flash'

  // 1. PRE-FLIGHT CHECK: TIER & MODEL ACCESS (ZERO-COST FREE SUPPORT)
  const access = await verifyTierAndModelAccess(userId, requestedModel, req.user)
  if (!access.allowed) {
    if (access.reason === 'key_model_restricted') {
      return res.status(403).json({
        type: 'error',
        error: {
          type: 'permission_error',
          code: 'model_not_allowed',
          message: access.message,
        },
      })
    }
    if (access.reason === 'tier_upgrade_required') {
      return res.status(403).json({
        error: {
          code: 'tier_upgrade_required',
          status: 403,
          message: access.message,
          current_tier: access.current_tier,
          required_tier: access.required_tier,
          upgrade_url: access.upgrade_url,
        },
      })
    }
    return res.status(402).json({
      error: {
        code: 'insufficient_quota',
        status: 402,
        message: access.message,
        upgrade_url: access.upgrade_url,
      },
    })
  }

  const bonus = access.bonus
  const subs = access.subs
  const normal = access.normal
  const totalBalance = access.totalBalance

  // 2. FORWARD KE UPSTREAM
  try {
    const upstreamBase = DEEPSEEK_UPSTREAM.replace(/\/+$/, '')
    const upstreamEndpoint = (upstreamBase.includes('litellm') || upstreamBase.includes('openrouter') || upstreamBase.includes('/anthropic'))
      ? `${upstreamBase}/v1/messages`
      : `${upstreamBase}/anthropic/v1/messages`

    const headers = {
      'Content-Type': 'application/json',
      Accept: req.headers['accept'] || 'text/event-stream',
    }
    if (DEEPSEEK_API_KEY) {
      headers['Authorization'] = `Bearer ${DEEPSEEK_API_KEY}`
      headers['x-api-key'] = DEEPSEEK_API_KEY
    }
    if (req.headers['anthropic-version']) {
      headers['anthropic-version'] = req.headers['anthropic-version']
    }
    if (req.headers['anthropic-beta']) {
      headers['anthropic-beta'] = req.headers['anthropic-beta']
    }

    const traceId = req.headers['x-boson-trace-id'] || req.headers['x-aethel-trace-id'] || req.headers['x-trace-id'] || req.headers['traceparent'] || randomUUID().replace(/-/g, '')
    headers['X-Boson-Trace-Id'] = traceId
    headers['X-Aethel-Trace-Id'] = traceId
    headers['X-Boson-Platform-Id'] = platformId
    headers['X-Aethel-Platform-Id'] = platformId

    const forwardedBody = {
      ...req.body,
      ...(req.body.messages ? { messages: inlineStoredFiles(req.body.messages, fileStore) } : {}),
      metadata: {
        ...(req.body?.metadata || {}),
        user_id: userId,
        user_email: req.user?.email,
        platform_id: platformId,
        trace_id: traceId,
      },
    }

    const isMockRequested = req.headers['x-mock-dummy'] === 'true' || 
                            req.headers['x-mock'] === 'true' || 
                            req.query.mock === 'true' || 
                            req.query.dummy === 'true' || 
                            req.body?.mock === true ||
                            process.env.MOCK_LLM_DUMMY === 'true'

    let promptTokens = 0
    let completionTokens = 0
    let cachedTokens = 0
    let reasoningTokens = 0
    let estimatedTokens = 0
    let isMockExecution = false
    let streamAborted = false
    let clientDisconnected = false

    if (isMockRequested) {
      isMockExecution = true
      promptTokens = parseInt(req.headers['x-mock-prompt-tokens'] || req.body?.mock_prompt_tokens || '150')
      completionTokens = parseInt(req.headers['x-mock-completion-tokens'] || req.body?.mock_completion_tokens || '350')
      cachedTokens = parseInt(req.headers['x-mock-cached-tokens'] || req.body?.mock_cached_tokens || '80')
      reasoningTokens = parseInt(req.headers['x-mock-reasoning-tokens'] || req.body?.mock_reasoning_tokens || '100')

      res.setHeader('Content-Type', 'application/json')
      res.setHeader('X-Boson-Platform-Verified', platformId)
      res.setHeader('X-Boson-Trace-Id', traceId)
      res.setHeader('X-Boson-Mock-Mode', 'true')
      res.json({
        id: `msg_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Halo! Ini adalah respons simulasi Anthropic format dari Boson Gateway untuk pengujian kalkulasi token input (${promptTokens}, ${cachedTokens} cached) dan output (${completionTokens}, ${reasoningTokens} reasoning) pada tier ${access.userTier}.`,
          },
        ],
        model: requestedModel,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          cache_read_input_tokens: cachedTokens,
          cache_creation_input_tokens: 0,
        },
      })
    } else {
      let upstreamRes
      try {
        upstreamRes = await fetch(upstreamEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(forwardedBody),
        })
      } catch (netErr) {
        console.warn('[Gateway Messages Upstream Fetch Error]:', netErr.message)
      }

      if (!upstreamRes || !upstreamRes.ok) {
        const canFallbackMock = process.env.MOCK_LLM_FALLBACK !== 'false' || !process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'sk-admin'
        if (canFallbackMock) {
          console.log(`[Gateway Mock Fallback /messages] Upstream tidak terhubung (${upstreamRes?.status || 'Network Error'}), beralih ke Mock Mode.`)
          isMockExecution = true
          promptTokens = 150
          completionTokens = 350
          cachedTokens = 80
          reasoningTokens = 100

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('X-Boson-Platform-Verified', platformId)
          res.setHeader('X-Boson-Trace-Id', traceId)
          res.setHeader('X-Boson-Mock-Fallback', 'true')
          res.json({
            id: `msg_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Respons simulasi otomatis (Mock Fallback) karena upstream Anthropic LLM belum terhubung. Input: ${promptTokens} (cached: ${cachedTokens}), Output: ${completionTokens} (reasoning: ${reasoningTokens}), Tier: ${access.userTier}.`,
              },
            ],
            model: requestedModel,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
              cache_read_input_tokens: cachedTokens,
              cache_creation_input_tokens: 0,
            },
          })
        } else {
          const errText = upstreamRes ? await upstreamRes.text() : 'Upstream connection error'
          res.setHeader('Content-Type', upstreamRes?.headers.get('content-type') || 'application/json')
          return res.status(upstreamRes?.status || 502).send(errText)
        }
      } else {
        res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Boson-Platform-Verified', platformId)
        res.setHeader('X-Aethel-Platform-Verified', platformId)
        res.setHeader('X-Boson-Trace-Id', traceId)
        res.setHeader('X-Aethel-Trace-Id', traceId)

        const reader = upstreamRes.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        res.on('close', () => {
          if (!res.writableEnded) {
            clientDisconnected = true
            try { reader.cancel() } catch {}
          }
        })

        while (true) {
          if (clientDisconnected || res.writableEnded) break
          const { done, value } = await reader.read()
          if (done) break

          estimatedTokens += Math.ceil(value.byteLength / 4)
          const currentCost = access.isZeroCost ? 0 : calculateCost(requestedModel, promptTokens, completionTokens || estimatedTokens)
          if (!access.isZeroCost && totalBalance - currentCost < -0.05) {
            streamAborted = true
            reader.cancel()
            break
          }

          // Cek usage dari SSE delta
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.message?.usage?.input_tokens) {
                  promptTokens = data.message.usage.input_tokens
                }
                if (data.message?.usage?.cache_read_input_tokens) {
                  cachedTokens = data.message.usage.cache_read_input_tokens
                }
                if (data.usage?.output_tokens) {
                  completionTokens = data.usage.output_tokens
                }
              } catch {}
            }
          }

          res.write(value)
        }

        // Tangani sisa buffer jika response raw JSON (non-streaming) atau chunk terakhir
        if (buffer.trim()) {
          try {
            const raw = buffer.startsWith('data: ') ? buffer.slice(6) : buffer
            const parsed = JSON.parse(raw)
            if (parsed.usage?.input_tokens) promptTokens = parsed.usage.input_tokens
            if (parsed.usage?.output_tokens) completionTokens = parsed.usage.output_tokens
            if (parsed.usage?.cache_read_input_tokens) cachedTokens = parsed.usage.cache_read_input_tokens
            if (parsed.usage?.prompt_tokens) promptTokens = parsed.usage.prompt_tokens
            if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens
            if (parsed.message?.usage?.input_tokens) promptTokens = parsed.message.usage.input_tokens
            if (parsed.message?.usage?.output_tokens) completionTokens = parsed.message.usage.output_tokens
            if (parsed.message?.usage?.cache_read_input_tokens) cachedTokens = parsed.message.usage.cache_read_input_tokens
          } catch {}
        }

        if (streamAborted) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'quota_exceeded', message: 'Quota exhausted during generation.' } })}\n\n`)
          res.end()
        } else {
          res.end()
        }
      }
    }

    // 3. ATOMIC DEBIT BERDASARKAN LIVE PRICING (PostgreSQL Concurrency-Safe Stored Procedure)
    const finalPrompt = promptTokens || Math.ceil(estimatedTokens * 0.4)
    const finalCompletion = completionTokens || Math.ceil(estimatedTokens * 0.6)
    const finalCached = cachedTokens || 0
    const costDetails = calculateDynamicCostWithDetails(requestedModel, finalPrompt, finalCompletion, finalCached)
    const finalCost = access.isZeroCost ? 0.0 : costDetails.cost

    const debitMetadata = {
      rate_prompt_per_1m: costDetails.rate_prompt_per_1m,
      rate_prompt_cache_read_per_1m: costDetails.rate_prompt_cache_read_per_1m,
      rate_completion_per_1m: costDetails.rate_completion_per_1m,
      wholesale_prompt_per_1m: costDetails.wholesale_prompt_per_1m,
      wholesale_completion_per_1m: costDetails.wholesale_completion_per_1m,
      wholesale_cost_usd: costDetails.wholesaleCost,
      margin_percent: costDetails.margin_percent,
      pricing_source: costDetails.pricing_source,
      upstream_model_id: costDetails.upstream_model_id,
      cached_tokens: finalCached,
      prompt_tokens_details: { cached_tokens: finalCached },
      reasoning_tokens: reasoningTokens || 0,
      completion_tokens_details: { reasoning_tokens: reasoningTokens || 0 },
      saved_by_cache_usd: costDetails.savedByCacheUsd || 0,
      zero_cost: access.isZeroCost,
      tier: access.userTier,
      auth_type: req.user?.auth_type,
      key_name: req.user?.key_name,
      agent_id: req.user?.agent_id,
      key_type: req.user?.key_type,
      is_mock_simulation: isMockExecution,
      applied_at: new Date().toISOString(),
    }

    try {
      const { data: rpcResult, error: rpcError } = await supabase.rpc('atomic_debit_wallet', {
        p_user_id: userId,
        p_cost: finalCost,
        p_model: requestedModel,
        p_platform_id: platformId,
        p_prompt_tokens: finalPrompt,
        p_completion_tokens: finalCompletion,
        p_metadata: debitMetadata,
      })

      if (rpcError) throw rpcError
      console.log(`[Atomic Debit] User ${userId}: Model=${requestedModel}, Tokens=${finalPrompt}+${finalCompletion}=${finalPrompt+finalCompletion} (cached: ${finalCached}), Cost=$${finalCost} (Deducted: ${rpcResult?.deducted_from})`)

      // Sinkronkan akumulasi pengeluaran ke LiteLLM
      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    } catch (dbErr) {
      console.warn('[Fallback Debit] RPC failed in messages, using fallback update:', dbErr.message)
      let remainingCost = finalCost
      let newBonus = bonus
      let newSubs = subs
      let newNormal = normal
      let deductedFrom = 'normal'

      if (newBonus > 0) {
        const deduct = Math.min(newBonus, remainingCost)
        newBonus -= deduct
        remainingCost -= deduct
        deductedFrom = 'bonus'
      }

      if (remainingCost > 0 && newSubs > 0) {
        const deduct = Math.min(newSubs, remainingCost)
        newSubs -= deduct
        remainingCost -= deduct
        deductedFrom = 'subscription'
      }

      if (remainingCost > 0) {
        newNormal = Math.max(0, newNormal - remainingCost)
        deductedFrom = 'normal'
      }

      await supabase.from('wallets').update({
        bonus_balance: newBonus,
        subscription_balance: newSubs,
        normal_balance: newNormal,
      }).eq('user_id', userId)

      await supabase.from('usage_ledger').insert({
        user_id: userId,
        platform_id: platformId,
        app_id: platformId,
        model: requestedModel,
        prompt_tokens: finalPrompt,
        completion_tokens: finalCompletion,
        total_tokens: finalPrompt + finalCompletion,
        cost_usd: finalCost,
        deducted_from: deductedFrom,
        metadata: debitMetadata,
      })
      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    }
  } catch (err) {
    console.error('Messages inference error:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Messages proxy error' })
  }
})

// Helper konversi OpenAI Responses API ke Chat Completions
// Helper konversi OpenAI Responses API ke Chat Completions
function convertResponsesInputToMessages(input, instructions) {
  const messages = []
  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }
  if (!Array.isArray(input)) return messages

  for (const item of input) {
    if (!item) continue
    const role = item.role || (item.type === 'message' ? item.role : undefined)

    if (role === 'system' || role === 'developer') {
      const content = typeof item.content === 'string' ? item.content : (Array.isArray(item.content) ? item.content.map(p => p.text || '').join('\n') : '')
      messages.push({ role: 'system', content })
    } else if (role === 'user') {
      if (typeof item.content === 'string') {
        messages.push({ role: 'user', content: item.content })
      } else if (Array.isArray(item.content)) {
        // Cek apakah ada konten multi-modal (gambar)
        const hasImage = item.content.some(part => part.type === 'input_image' || part.type === 'image_url')
        if (hasImage) {
          const contentParts = item.content.map((part) => {
            if (part.type === 'input_text' || part.type === 'text') {
              return { type: 'text', text: part.text || '' }
            }
            if (part.type === 'input_image' || part.type === 'image_url') {
              const url = part.image_url?.url || part.image_url || part.url || part.data
              return { type: 'image_url', image_url: { url } }
            }
            return { type: 'text', text: part.text || '' }
          })
          messages.push({ role: 'user', content: contentParts })
        } else {
          const contentText = item.content
            .map((part) => (part.type === 'input_text' ? part.text : (part.text || '')))
            .join('\n')
          messages.push({ role: 'user', content: contentText })
        }
      }
    } else if (role === 'assistant') {
      let content = ''
      if (typeof item.content === 'string') {
        content = item.content
      } else if (Array.isArray(item.content)) {
        content = item.content
          .map((part) => (part.type === 'output_text' ? part.text : (part.text || '')))
          .join('\n')
      }
      messages.push({ role: 'assistant', content })
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
          },
        }],
      })
    } else if (item.type === 'function_call_output' || item.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || item.tool_call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      })
    }
  }
  return messages
}

function convertResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const cleaned = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const fn = t.function || t
    const name = fn.name || t.name
    if (!name || typeof name !== 'string') continue

    cleaned.push({
      type: 'function',
      function: {
        name,
        description: fn.description || t.description || '',
        parameters: (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return cleaned.length > 0 ? cleaned : undefined
}

// 5c. OPENAI RESPONSES API (Untuk Aethel Studio / Vela / OpenCode ACP Agent)
app.post(['/v1/responses', '/responses'], authenticateUser, verifyPlatform, inferenceRateLimiter, async (req, res) => {
  const userId = req.user.id
  const platformId = req.platform?.id || 'boson-desktop'
  const requestedModel = req.body.model || 'deepseek-chat'

  console.log(`[Responses API] Request masuk dari User ${userId} untuk model: ${requestedModel}`)

  // 1. PRE-FLIGHT CHECK: TIER & MODEL ACCESS (ZERO-COST FREE SUPPORT)
  const access = await verifyTierAndModelAccess(userId, requestedModel, req.user)
  if (!access.allowed) {
    if (access.reason === 'key_model_restricted') {
      return res.status(403).json({
        error: {
          code: 'model_not_allowed',
          status: 403,
          message: access.message,
        },
      })
    }
    if (access.reason === 'tier_upgrade_required') {
      return res.status(403).json({
        error: {
          code: 'tier_upgrade_required',
          status: 403,
          message: access.message,
          current_tier: access.current_tier,
          required_tier: access.required_tier,
          upgrade_url: access.upgrade_url,
        },
      })
    }
    return res.status(402).json({
      error: {
        code: 'insufficient_quota',
        status: 402,
        message: access.message,
        upgrade_url: access.upgrade_url,
      },
    })
  }

  const bonus = access.bonus
  const subs = access.subs
  const normal = access.normal
  const totalBalance = access.totalBalance

  // 2. Transformasi Request Payload ke OpenAI Chat Completions Format
  const messages = req.body.messages || convertResponsesInputToMessages(req.body.input, req.body.instructions)
  const tools = convertResponsesTools(req.body.tools)
  const streamMode = req.body.stream !== false

  console.log('[Responses API] Raw tools:', JSON.stringify(req.body.tools))
  console.log('[Responses API] Converted tools:', JSON.stringify(tools))

  const completionPayload = {
    model: requestedModel,
    messages,
    stream: streamMode,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(req.body.tool_choice ? { tool_choice: req.body.tool_choice } : {}),
    ...(req.body.max_output_tokens ? { max_tokens: req.body.max_output_tokens } : {}),
    ...(req.body.temperature !== undefined ? { temperature: req.body.temperature } : {}),
    ...(req.body.top_p !== undefined ? { top_p: req.body.top_p } : {}),
  }

  try {
    const upstreamRes = await fetch(`${DEEPSEEK_UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(completionPayload),
    })

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      console.error('[Responses API] Upstream error:', upstreamRes.status, errText)
      return res.status(upstreamRes.status).send(errText)
    }

    if (!streamMode) {
      const upstreamJson = await upstreamRes.json()
      const choice = upstreamJson.choices?.[0] || {}
      const outputText = choice.message?.content || ''
      const responseId = upstreamJson.id || `resp_${Date.now()}`
      const respObj = {
        id: responseId,
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: outputText,
              },
            ],
          },
        ],
        usage: upstreamJson.usage,
      }
      return res.json(respObj)
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Boson-Platform-Verified', platformId)

    let estimatedTokens = 0
    let currentOutputIndex = 0
    let hasStartedText = false
    let textOutputIndex = 0
    let fullText = ''
    let isFinished = false
    const outputItems = []
    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`
    const responseId = `resp_${Math.random().toString(36).slice(2, 10)}`
    const activeToolCalls = new Map()

    // 1. Emit response.created
    res.write(`data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        model: requestedModel,
        output: [],
      },
    })}\n\n`)

    const decoder = new TextDecoder()
    const reader = upstreamRes.body.getReader()
    let sseBuffer = ''

    function finalizeOutputItems() {
      if (isFinished) return
      isFinished = true

      if (hasStartedText) {
        res.write(`data: ${JSON.stringify({
          type: 'response.output_text.done',
          response_id: responseId,
          item_id: messageId,
          output_index: textOutputIndex,
          content_index: 0,
          text: fullText,
        })}\n\n`)

        res.write(`data: ${JSON.stringify({
          type: 'response.content_part.done',
          response_id: responseId,
          item_id: messageId,
          output_index: textOutputIndex,
          content_index: 0,
          part: {
            type: 'output_text',
            text: fullText,
          },
        })}\n\n`)

        res.write(`data: ${JSON.stringify({
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: textOutputIndex,
          item: {
            id: messageId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: fullText }],
          },
        })}\n\n`)

        outputItems.push({
          id: messageId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: fullText }],
        })
      }

      for (const call of activeToolCalls.values()) {
        res.write(`data: ${JSON.stringify({
          type: 'response.function_call_arguments.done',
          response_id: responseId,
          item_id: call.id,
          output_index: call.outputIndex,
          arguments: call.arguments,
        })}\n\n`)

        res.write(`data: ${JSON.stringify({
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: call.outputIndex,
          item: {
            id: call.id,
            call_id: call.id,
            type: 'function_call',
            status: 'completed',
            name: call.name,
            arguments: call.arguments,
          },
        })}\n\n`)

        outputItems.push({
          id: call.id,
          call_id: call.id,
          type: 'function_call',
          status: 'completed',
          name: call.name,
          arguments: call.arguments,
        })
      }
    }

    let clientDisconnected = false
    const abortHandler = () => {
      if (!res.writableEnded) {
        clientDisconnected = true
        try { reader.cancel() } catch {}
      }
    }
    res.on('close', abortHandler)

    while (true) {
      if (clientDisconnected || res.writableEnded) break
      const { done, value } = await reader.read()
      if (done) break
      estimatedTokens += Math.ceil(value.byteLength / 4)

      // Cek in-flight guard
      const currentCost = access.isZeroCost ? 0 : calculateCost(requestedModel, 0, estimatedTokens)
      if (!access.isZeroCost && totalBalance - currentCost < -0.05) {
        reader.cancel()
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Quota exhausted during generation.' })}\n\n`)
        break
      }

      sseBuffer += decoder.decode(value, { stream: true })
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue
        const dataStr = line.slice(5).trim()
        if (dataStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(dataStr)
          const choice = chunk.choices?.[0]
          if (!choice) continue

          const delta = choice.delta || {}

          // 1. Reasoning / Thinking content
          if (delta.reasoning_content) {
            res.write(`data: ${JSON.stringify({
              type: 'response.reasoning_text.delta',
              response_id: responseId,
              delta: delta.reasoning_content,
            })}\n\n`)
          }

          // 2. Text Content
          if (delta.content) {
            if (!hasStartedText) {
              hasStartedText = true
              textOutputIndex = currentOutputIndex++
              res.write(`data: ${JSON.stringify({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: textOutputIndex,
                item: {
                  id: messageId,
                  type: 'message',
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              })}\n\n`)

              res.write(`data: ${JSON.stringify({
                type: 'response.content_part.added',
                response_id: responseId,
                item_id: messageId,
                output_index: textOutputIndex,
                content_index: 0,
                part: {
                  type: 'output_text',
                  text: '',
                },
              })}\n\n`)
            }

            fullText += delta.content
            res.write(`data: ${JSON.stringify({
              type: 'response.output_text.delta',
              response_id: responseId,
              item_id: messageId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: delta.content,
            })}\n\n`)
          }

          // 3. Tool Calls
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!activeToolCalls.has(idx)) {
                const callId = tc.id || `call_${Math.random().toString(36).slice(2, 10)}`
                const toolName = tc.function?.name || ''
                const toolOutputIndex = currentOutputIndex++
                activeToolCalls.set(idx, {
                  id: callId,
                  name: toolName,
                  arguments: '',
                  outputIndex: toolOutputIndex,
                })
                res.write(`data: ${JSON.stringify({
                  type: 'response.output_item.added',
                  response_id: responseId,
                  output_index: toolOutputIndex,
                  item: {
                    id: callId,
                    call_id: callId,
                    type: 'function_call',
                    status: 'in_progress',
                    name: toolName,
                    arguments: '',
                  },
                })}\n\n`)
              }
              const activeCall = activeToolCalls.get(idx)
              if (tc.function?.name && !activeCall.name) {
                activeCall.name = tc.function.name
              }
              if (tc.function?.arguments) {
                activeCall.arguments += tc.function.arguments
                res.write(`data: ${JSON.stringify({
                  type: 'response.function_call_arguments.delta',
                  response_id: responseId,
                  item_id: activeCall.id,
                  output_index: activeCall.outputIndex,
                  delta: tc.function.arguments,
                })}\n\n`)
              }
            }
          }

          // 4. Finish Reason
          if (choice.finish_reason) {
            finalizeOutputItems()
          }
        } catch {
          // Abaikan fragment json yang belum tuntas
        }
      }
    }

    res.off('close', abortHandler)

    const promptTokens = Math.max(1, Math.ceil(estimatedTokens * 0.4))
    const completionTokens = Math.max(1, Math.ceil(estimatedTokens * 0.6))

    if (!clientDisconnected) {
      // Pastikan output item tertutup jika upstream stream berhenti tanpa finish_reason eksplisit
      finalizeOutputItems()

      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: responseId,
          service_tier: 'default',
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        },
      })}\n\n`)
      res.end()
    }

    // 3. ATOMIC DEBIT
    const costDetails = calculateDynamicCostWithDetails(requestedModel, promptTokens, completionTokens)
    const finalCost = access.isZeroCost ? 0.0 : costDetails.cost

    const debitMetadata = {
      rate_prompt_per_1m: costDetails.rate_prompt_per_1m,
      rate_completion_per_1m: costDetails.rate_completion_per_1m,
      wholesale_prompt_per_1m: costDetails.wholesale_prompt_per_1m,
      wholesale_completion_per_1m: costDetails.wholesale_completion_per_1m,
      margin_percent: costDetails.margin_percent,
      pricing_source: costDetails.pricing_source,
      upstream_model_id: costDetails.upstream_model_id,
      zero_cost: access.isZeroCost,
      tier: access.userTier,
      auth_type: req.user?.auth_type,
      key_name: req.user?.key_name,
      agent_id: req.user?.agent_id,
      key_type: req.user?.key_type,
      applied_at: new Date().toISOString(),
    }

    try {
      const { data: rpcResult, error: rpcError } = await supabase.rpc('atomic_debit_wallet', {
        p_user_id: userId,
        p_cost: finalCost,
        p_model: requestedModel,
        p_platform_id: platformId,
        p_prompt_tokens: promptTokens,
        p_completion_tokens: completionTokens,
        p_metadata: debitMetadata,
      })

      if (rpcError) throw rpcError
      console.log(`[Atomic Debit Responses] User ${userId}: Model=${requestedModel}, Tokens=${promptTokens}+${completionTokens}=${estimatedTokens}, Cost=$${finalCost} (Deducted: ${rpcResult?.deducted_from})`)

      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    } catch (dbErr) {
      console.warn('[Fallback Debit Responses] RPC failed in responses, using fallback update:', dbErr.message)
      let remainingCost = finalCost
      let newBonus = bonus
      let newSubs = subs
      let newNormal = normal
      let deductedFrom = 'normal'

      if (newBonus > 0) {
        const deduct = Math.min(newBonus, remainingCost)
        newBonus -= deduct
        remainingCost -= deduct
        deductedFrom = 'bonus'
      }

      if (remainingCost > 0 && newSubs > 0) {
        const deduct = Math.min(newSubs, remainingCost)
        newSubs -= deduct
        remainingCost -= deduct
        deductedFrom = 'subscription'
      }

      if (remainingCost > 0) {
        newNormal = Math.max(0, newNormal - remainingCost)
        deductedFrom = 'normal'
      }

      await supabase.from('wallets').update({
        bonus_balance: newBonus,
        subscription_balance: newSubs,
        normal_balance: newNormal,
      }).eq('user_id', userId)

      await supabase.from('usage_ledger').insert({
        user_id: userId,
        platform_id: platformId,
        app_id: platformId,
        model: requestedModel,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: estimatedTokens,
        cost_usd: finalCost,
        deducted_from: deductedFrom,
        metadata: debitMetadata,
      })

      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    }
  } catch (err) {
    console.error('[Responses API] Inference error:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Responses proxy error' })
  }
})

// 5b. OPENAI CHAT COMPLETIONS API (Untuk Aethel Studio, CLI, Cursor, Python SDK)
app.post(['/v1/chat/completions', '/chat/completions'], authenticateUser, verifyPlatform, inferenceRateLimiter, async (req, res) => {
  const userId = req.user.id
  const platformId = req.platform?.id || 'boson-desktop'
  const requestedModel = req.body.model || 'deepseek-chat'

  // 1. PRE-FLIGHT CHECK: TIER & MODEL ACCESS (ZERO-COST FREE SUPPORT)
  const access = await verifyTierAndModelAccess(userId, requestedModel, req.user)
  if (!access.allowed) {
    if (access.reason === 'key_model_restricted') {
      return res.status(403).json({
        error: {
          code: 'model_not_allowed',
          status: 403,
          message: access.message,
        },
      })
    }
    if (access.reason === 'tier_upgrade_required') {
      return res.status(403).json({
        error: {
          code: 'tier_upgrade_required',
          status: 403,
          message: access.message,
          current_tier: access.current_tier,
          required_tier: access.required_tier,
          upgrade_url: access.upgrade_url,
        },
      })
    }
    return res.status(402).json({
      error: {
        code: 'insufficient_quota',
        status: 402,
        message: access.message,
        upgrade_url: access.upgrade_url,
      },
    })
  }

  const bonus = access.bonus
  const subs = access.subs
  const normal = access.normal
  const totalBalance = access.totalBalance

  // 2. Teruskan request ke Upstream AI Provider (DeepSeek / LiteLLM) atau Simulasi Mock
  try {
    const requestStart = Date.now()
    const traceId = req.headers['x-boson-trace-id'] || req.headers['x-aethel-trace-id'] || req.headers['x-trace-id'] || req.headers['traceparent'] || randomUUID().replace(/-/g, '')
    const upstreamBody = {
      ...req.body,
      metadata: {
        ...(req.body?.metadata || {}),
        user_id: userId,
        user_email: req.user?.email,
        platform_id: platformId,
        trace_id: traceId,
      },
    }

    if (upstreamBody.stream !== false && !upstreamBody.stream_options) {
      upstreamBody.stream_options = { include_usage: true }
    }

    const isMockRequested = req.headers['x-mock-dummy'] === 'true' || 
                            req.headers['x-mock'] === 'true' || 
                            req.query.mock === 'true' || 
                            req.query.dummy === 'true' || 
                            req.body?.mock === true ||
                            process.env.MOCK_LLM_DUMMY === 'true'

    let estimatedTokens = 0
    let promptTokens = 0
    let completionTokens = 0
    let cachedTokens = 0
    let reasoningTokens = 0
    let isMockExecution = false
    let streamAborted = false
    let clientDisconnected = false

    if (isMockRequested) {
      isMockExecution = true
      promptTokens = parseInt(req.headers['x-mock-prompt-tokens'] || req.body?.mock_prompt_tokens || '150')
      completionTokens = parseInt(req.headers['x-mock-completion-tokens'] || req.body?.mock_completion_tokens || '350')
      cachedTokens = parseInt(req.headers['x-mock-cached-tokens'] || req.body?.mock_cached_tokens || '80')
      reasoningTokens = parseInt(req.headers['x-mock-reasoning-tokens'] || req.body?.mock_reasoning_tokens || '100')

      const isStream = upstreamBody.stream !== false && req.body?.stream === true

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Boson-Platform-Verified', platformId)
        res.setHeader('X-Boson-Trace-Id', traceId)
        res.setHeader('X-Boson-Mock-Mode', 'true')

        const streamId = `chatcmpl-mock-${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const chunk1 = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Halo! ' }, finish_reason: null }],
        }
        const chunk2 = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{
            index: 0,
            delta: { content: `Ini adalah respons simulasi (Mock SSE Stream) untuk kalkulasi token in/out/cached pada tier ${access.userTier}.` },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: { cached_tokens: cachedTokens },
            completion_tokens_details: { reasoning_tokens: reasoningTokens },
          },
        }
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`)
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('X-Boson-Platform-Verified', platformId)
        res.setHeader('X-Boson-Trace-Id', traceId)
        res.setHeader('X-Boson-Mock-Mode', 'true')
        res.json({
          id: `chatcmpl-mock-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `Halo! Ini adalah simulasi respons AI dari Boson Gateway (Mock Mode) untuk verifikasi pemakaian token in (${promptTokens} token, ${cachedTokens} cached), token out (${completionTokens} token, ${reasoningTokens} reasoning) pada tier ${access.userTier}.`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: {
              cached_tokens: cachedTokens,
            },
            completion_tokens_details: {
              reasoning_tokens: reasoningTokens,
            },
          },
        })
      }
    } else {
      let upstreamRes
      try {
        upstreamRes = await fetch(`${DEEPSEEK_UPSTREAM}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            'X-Boson-Trace-Id': traceId,
            'X-Aethel-Trace-Id': traceId,
            'X-Boson-Platform-Id': platformId,
            'X-Aethel-Platform-Id': platformId,
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(15000),
        })
      } catch (netErr) {
        console.warn('[Gateway Upstream Fetch Error]:', netErr.message)
      }

      if (!upstreamRes || !upstreamRes.ok) {
        const canFallbackMock = process.env.MOCK_LLM_FALLBACK !== 'false' || !process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'sk-admin'
        if (canFallbackMock) {
          console.log(`[Gateway Mock Fallback] Upstream tidak terhubung (${upstreamRes?.status || 'Network Error'}), menggunakan Mock Mode untuk pengujian.`)
          isMockExecution = true
          promptTokens = 150
          completionTokens = 350
          cachedTokens = 80
          reasoningTokens = 100

          const isStream = upstreamBody.stream !== false && req.body?.stream === true
          if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')
            res.setHeader('X-Boson-Platform-Verified', platformId)
            res.setHeader('X-Boson-Trace-Id', traceId)
            res.setHeader('X-Boson-Mock-Fallback', 'true')

            const streamId = `chatcmpl-mock-${randomUUID().replace(/-/g, '').slice(0, 12)}`
            res.write(`data: ${JSON.stringify({ id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: 'Halo! ' }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: `Respons simulasi otomatis (Mock Fallback) karena upstream LLM belum terhubung. Token in: ${promptTokens} (cached: ${cachedTokens}), Token out: ${completionTokens} (reasoning: ${reasoningTokens}).` }, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: cachedTokens }, completion_tokens_details: { reasoning_tokens: reasoningTokens } } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('X-Boson-Platform-Verified', platformId)
            res.setHeader('X-Boson-Trace-Id', traceId)
            res.setHeader('X-Boson-Mock-Fallback', 'true')
            res.json({
              id: `chatcmpl-mock-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: `Halo! Ini adalah respons simulasi AI dari Boson Gateway (Mock Fallback) karena upstream belum tersambung. Token in: ${promptTokens} (cached: ${cachedTokens}), Token out: ${completionTokens} (reasoning: ${reasoningTokens}), Tier: ${access.userTier}.`,
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
                prompt_tokens_details: {
                  cached_tokens: cachedTokens,
                },
                completion_tokens_details: {
                  reasoning_tokens: reasoningTokens,
                },
              },
            })
          }
        } else {
          const errText = upstreamRes ? await upstreamRes.text() : 'Upstream connection error'
          return res.status(upstreamRes?.status || 502).send(errText)
        }
      } else {
        res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Boson-Platform-Verified', platformId)
        res.setHeader('X-Aethel-Platform-Verified', platformId)
        res.setHeader('X-Boson-Trace-Id', traceId)
        res.setHeader('X-Aethel-Trace-Id', traceId)

        let buffer = ''
        const decoder = new TextDecoder()
        const reader = upstreamRes.body.getReader()

        res.on('close', () => {
          if (!res.writableEnded) {
            clientDisconnected = true
            try { reader.cancel() } catch {}
          }
        })

        while (true) {
          if (clientDisconnected || res.writableEnded) break
          const { done, value } = await reader.read()
          if (done) break

          estimatedTokens += Math.ceil(value.byteLength / 4)

          const currentCost = access.isZeroCost ? 0 : calculateCost(requestedModel, promptTokens, completionTokens || estimatedTokens)
          if (!access.isZeroCost && totalBalance - currentCost < -0.05) {
            streamAborted = true
            reader.cancel()
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim()
              if (raw && raw !== '[DONE]') {
                try {
                  const data = JSON.parse(raw)
                  if (data.usage) {
                    if (data.usage.prompt_tokens) promptTokens = data.usage.prompt_tokens
                    if (data.usage.completion_tokens) completionTokens = data.usage.completion_tokens
                    if (data.usage.prompt_tokens_details?.cached_tokens) {
                      cachedTokens = data.usage.prompt_tokens_details.cached_tokens
                    }
                    if (data.usage.completion_tokens_details?.reasoning_tokens) {
                      reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens
                    }
                  }
                } catch {}
              }
            }
          }

          res.write(value)
        }

        if (buffer.trim()) {
          try {
            const raw = buffer.startsWith('data: ') ? buffer.slice(6).trim() : buffer.trim()
            if (raw && raw !== '[DONE]') {
              const parsed = JSON.parse(raw)
              if (parsed.usage) {
                if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens
                if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens
                if (parsed.usage.prompt_tokens_details?.cached_tokens) {
                  cachedTokens = parsed.usage.prompt_tokens_details.cached_tokens
                }
                if (parsed.usage.completion_tokens_details?.reasoning_tokens) {
                  reasoningTokens = parsed.usage.completion_tokens_details.reasoning_tokens
                }
              }
            }
          } catch {}
        }

        if (streamAborted) {
          res.write(`data: ${JSON.stringify({ error: { code: 'insufficient_quota', message: 'Quota exhausted during generation.' } })}\n\n`)
          res.end()
        } else {
          res.end()
        }
      }
    }

    // 3. ATOMIC DEBIT BERDASARKAN LIVE PRICING (PostgreSQL Concurrency-Safe Stored Procedure)
    const finalPrompt = promptTokens || Math.ceil(estimatedTokens * 0.4)
    const finalCompletion = completionTokens || Math.ceil(estimatedTokens * 0.6)
    const finalCached = cachedTokens || 0
    const costDetails = calculateDynamicCostWithDetails(requestedModel, finalPrompt, finalCompletion, finalCached)
    const finalCost = access.isZeroCost ? 0.0 : costDetails.cost

    const debitMetadata = {
      rate_prompt_per_1m: costDetails.rate_prompt_per_1m,
      rate_prompt_cache_read_per_1m: costDetails.rate_prompt_cache_read_per_1m,
      rate_completion_per_1m: costDetails.rate_completion_per_1m,
      wholesale_prompt_per_1m: costDetails.wholesale_prompt_per_1m,
      wholesale_completion_per_1m: costDetails.wholesale_completion_per_1m,
      wholesale_cost_usd: costDetails.wholesaleCost,
      margin_percent: costDetails.margin_percent,
      pricing_source: costDetails.pricing_source,
      upstream_model_id: costDetails.upstream_model_id,
      cached_tokens: finalCached,
      prompt_tokens_details: { cached_tokens: finalCached },
      reasoning_tokens: reasoningTokens || 0,
      completion_tokens_details: { reasoning_tokens: reasoningTokens || 0 },
      saved_by_cache_usd: costDetails.savedByCacheUsd || 0,
      zero_cost: access.isZeroCost,
      tier: access.userTier,
      auth_type: req.user?.auth_type,
      key_name: req.user?.key_name,
      agent_id: req.user?.agent_id,
      key_type: req.user?.key_type,
      is_mock_simulation: isMockExecution,
      applied_at: new Date().toISOString(),
    }

    try {
      const { data: rpcResult, error: rpcError } = await supabase.rpc('atomic_debit_wallet', {
        p_user_id: userId,
        p_cost: finalCost,
        p_model: requestedModel,
        p_platform_id: platformId,
        p_prompt_tokens: finalPrompt,
        p_completion_tokens: finalCompletion,
        p_metadata: debitMetadata,
      })

      if (rpcError) throw rpcError
      console.log(`[Atomic Debit] User ${userId}: Model=${requestedModel}, Tokens=${finalPrompt}+${finalCompletion}=${finalPrompt+finalCompletion} (cached: ${finalCached}, reasoning: ${reasoningTokens}), Cost=$${finalCost} (Deducted: ${rpcResult?.deducted_from})`)

      // Sinkronkan akumulasi pengeluaran ke LiteLLM
      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    } catch (dbErr) {
      console.warn('[Fallback Debit] RPC failed in chat completions, using fallback update:', dbErr.message)
      let remainingCost = finalCost
      let newBonus = bonus
      let newSubs = subs
      let newNormal = normal
      let deductedFrom = 'normal'

      if (newBonus > 0) {
        const deduct = Math.min(newBonus, remainingCost)
        newBonus -= deduct
        remainingCost -= deduct
        deductedFrom = 'bonus'
      }

      if (remainingCost > 0 && newSubs > 0) {
        const deduct = Math.min(newSubs, remainingCost)
        newSubs -= deduct
        remainingCost -= deduct
        deductedFrom = 'subscription'
      }

      if (remainingCost > 0) {
        newNormal = Math.max(0, newNormal - remainingCost)
        deductedFrom = 'normal'
      }

      await supabase.from('wallets').update({
        bonus_balance: newBonus,
        subscription_balance: newSubs,
        normal_balance: newNormal,
      }).eq('user_id', userId)

      await supabase.from('usage_ledger').insert({
        user_id: userId,
        platform_id: platformId,
        app_id: platformId,
        model: requestedModel,
        prompt_tokens: finalPrompt,
        completion_tokens: finalCompletion,
        total_tokens: finalPrompt + finalCompletion,
        cost_usd: finalCost,
        deducted_from: deductedFrom,
        metadata: debitMetadata,
      })
      recordUserSpendToLiteLLM(userId, finalCost).catch(e => console.warn('[LiteLLM Spend Sync Warn]:', e.message))
      if (req.user?.key_hash) {
        recordTokenSpendToLiteLLM(req.user.key_hash, finalCost).catch(e => console.warn('[LiteLLM Key Spend Sync Warn]:', e.message))
      }
    }

    // Auto-record Lens trace
    recordGatewayInference({
      traceId,
      platformId,
      model: requestedModel,
      prompt: req.body?.messages?.[req.body?.messages?.length - 1]?.content || 'Chat completion turn',
      promptTokens: promptTokens || 10,
      completionTokens: completionTokens || 20,
      durationMs: Date.now() - requestStart,
      status: 'ok',
    })
  } catch (err) {
    console.error('Inference error:', err)
    if (!res.headersSent) res.status(500).json({ error: 'Inference proxy error' })
  }
})

// 6. OTLP TRACE & OBSERVABILITY INGESTION PROXY (LiteLLM Lens & Aethel / Boson Agent Traces)
app.all(['/v1/traces', '/api/public/otel/v1/traces', '/v1/logs'], async (req, res) => {
  try {
    // Asynchronous non-blocking micro-batch trace ingestion into Boson Trace Store
    if (req.method === 'POST' && req.body) {
      recordTraceFromOtlp(req.body)
    }

    const targetPath = req.path.includes('/logs') ? '/v1/logs' : '/v1/traces'
    const upstreamUrl = `${DEEPSEEK_UPSTREAM}${targetPath}`
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] } : {}),
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    }).catch(() => null)

    if (upstreamRes && upstreamRes.status !== 410) {
      const text = await upstreamRes.text()
      res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json')
      return res.status(upstreamRes.status).send(text)
    }

    // Graceful 200 OK acceptance for background telemetry agents
    return res.status(200).json({ status: 'received', path: req.path })
  } catch (err) {
    return res.status(200).json({ status: 'accepted', error: err.message })
  }
})

// Central Error Handler (Mencegah kebocoran stack trace ke publik)
app.use((err, _req, res, _next) => {
  if (res.headersSent) return
  if (err.message && err.message.includes('CORS Error')) {
    return res.status(403).json({
      error: {
        code: 'cors_forbidden',
        message: err.message,
      },
    })
  }
  console.error('[Unhandled Gateway Error]:', err)
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'internal_server_error',
      message: process.env.NODE_ENV === 'production' ? 'Terjadi kesalahan internal pada server' : (err.message || 'Internal Error'),
    },
  })
})

app.listen(PORT, () => {
  console.log(`[Boson Gateway] Berjalan di port ${PORT} | Public URL: ${PLATFORM_PUBLIC_URL}`)
  startPeriodicPricingSync(3600000)
  syncTierBudgetsToLiteLLM(supabase).catch(err => console.warn('[BudgetSync] Startup sync error:', err.message))
})
