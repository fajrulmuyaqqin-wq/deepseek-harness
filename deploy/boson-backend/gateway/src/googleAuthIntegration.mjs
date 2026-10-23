// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: GOOGLE OAUTH 2.0 INTEGRATION
// Menggunakan Kredensial Resmi dari Services AI_SAAS:
// - Google Client ID: 41454207765-igj2vl7sce0n9gbbjfm98ovb8p2okefs.apps.googleusercontent.com
// - Registered Callback: http://localhost:5001/v1/auth/google/callback (dan http://127.0.0.1:8088/v1/auth/google/callback)
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'

export const GOOGLE_AUTH_CONFIG = {
  clientId: process.env.GOOGLE_CLIENT_ID || '41454207765-igj2vl7sce0n9gbbjfm98ovb8p2okefs.apps.googleusercontent.com',
}

/**
 * Handle Verifikasi Google ID Token atau Access Token dan Provisioning Akun
 */
export async function verifyAndProvisionGoogleUser({ idToken, accessToken, supabase, authSignUp }) {
  let email = ''
  let displayName = ''
  let googleId = ''
  let avatarUrl = ''

  // 1. Verifikasi ID Token via endpoint resmi Google (atau mock untuk test suite)
  if (idToken && idToken.startsWith('mock_google_')) {
    const isProduction = process.env.NODE_ENV === 'production'
    const allowTestMocks = process.env.ALLOW_TEST_MOCKS === 'true' || process.env.NODE_ENV === 'test'
    if (isProduction && !allowTestMocks) {
      throw new Error('Google SSO Error: Mock authentication is strictly forbidden in production mode.')
    }
    email = idToken.includes('@') ? idToken.replace('mock_google_', '') : `google_${Date.now()}@gmail.com`
    displayName = 'Google SSO User'
    googleId = 'mock_gid_' + Date.now()
    avatarUrl = 'https://lh3.googleusercontent.com/a/default'
  } else if (idToken) {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}))
      throw new Error(`Google ID Token tidak valid: ${errJson.error_description || res.statusText}`)
    }
    const payload = await res.json()
    email = payload.email
    displayName = payload.name || payload.given_name || email?.split('@')[0]
    googleId = payload.sub
    avatarUrl = payload.picture || ''
  } else if (accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      throw new Error(`Google Access Token tidak valid: ${res.statusText}`)
    }
    const payload = await res.json()
    email = payload.email
    displayName = payload.name || payload.given_name || email?.split('@')[0]
    googleId = payload.sub
    avatarUrl = payload.picture || ''
  } else {
    throw new Error('Google token (idToken atau accessToken) wajib disertakan.')
  }

  const cleanEmail = (email || '').toLowerCase().trim()
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Email akun Google tidak valid.')
  }

  // 2. Cek apakah user sudah terdaftar di Supabase profiles
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', cleanEmail)
    .maybeSingle()

  let userId = existingProfile?.id
  let isNewUser = false

  if (!userId) {
    // Registrasi User Baru
    isNewUser = true

    if (authSignUp) {
      try {
        const authData = await authSignUp(cleanEmail, randomUUID(), displayName)
        userId = authData.id || authData.user?.id
      } catch (err) {
        console.warn('[Google SSO] authSignUp error, attempting direct lookup:', err.message)
      }
    }

    if (!userId) {
      const { data: p } = await supabase.from('profiles').select('*').eq('email', cleanEmail).maybeSingle()
      userId = p?.id
    }

    if (!userId) {
      userId = randomUUID()
      await supabase.from('profiles').insert({
        id: userId,
        email: cleanEmail,
        full_name: displayName,
        avatar_url: avatarUrl,
        tier: 'free',
        created_at: new Date(),
        updated_at: new Date(),
      })
    } else if (avatarUrl) {
      await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', userId)
    }

    // Pastikan Dompet terisi otomatis $2.00 Welcome Bonus Credit
    const { data: existingW } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle()
    if (!existingW) {
      await supabase.from('wallets').insert({
        user_id: userId,
        currency: 'USD',
        normal_balance: 0.00,
        subscription_balance: 0.00,
        bonus_balance: 2.00, // Otomatis $2 Welcome Bonus
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    console.log(`[Google SSO] Berhasil mendaftarkan user baru: ${cleanEmail} (Diberi $2.00 Welcome Bonus)`)
  } else {
    // Update data profil terbaru
    await supabase.from('profiles').update({
      full_name: displayName,
      avatar_url: avatarUrl,
      updated_at: new Date(),
    }).eq('id', userId)
    console.log(`[Google SSO] Login sukses untuk user terdaftar: ${cleanEmail}`)
  }

  // 3. Buat sesi otentikasi aktif (PKCE auth_code) agar langsung bisa call API
  const authCode = randomUUID()
  const authorizeId = randomUUID()
  await supabase.from('pkce_sessions').insert({
    authorize_id: authorizeId,
    user_id: userId,
    auth_code: authCode,
    status: 'exchanged',
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 hari
  })

  // Dapatkan saldo dompet terkini
  let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).single()
  if (!wallet) {
    wallet = {
      user_id: userId,
      currency: 'USD',
      normal_balance: 0.00,
      subscription_balance: 0.00,
      bonus_balance: 2.00,
    }
  }

  return {
    success: true,
    is_new_user: isNewUser,
    token: authCode,
    user: {
      id: userId,
      email: cleanEmail,
      name: displayName,
      avatar_url: avatarUrl,
      tier: existingProfile?.tier || 'free',
    },
    wallet,
  }
}

/**
 * Render HTML Callback Google OAuth untuk popup browser
 */
export function renderGoogleCallbackHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Menyelesaikan Login Google - Boson Studio</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 32px 24px; text-align: center; max-width: 360px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .spinner { width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 16px; margin: 0 0 8px; color: #f1f5f9; }
    p { font-size: 13px; color: #94a3b8; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spin"></div>
    <h2 id="title">Menghubungkan Akun Google...</h2>
    <p id="desc">Memvalidasi tanda tangan kriptografi token.</p>
  </div>

  <script>
    (function() {
      const hash = window.location.hash.substring(1);
      const hashParams = new URLSearchParams(hash);
      const queryParams = new URLSearchParams(window.location.search);

      const idToken = hashParams.get('id_token') || queryParams.get('id_token');
      const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
      const authError = hashParams.get('error') || queryParams.get('error');
      let returnOrigin = '';
      let sessionId = '';

      try {
        const stateParam = hashParams.get('state') || queryParams.get('state');
        if (stateParam) {
          const parsed = JSON.parse(atob(stateParam.replace(/-/g, '+').replace(/_/g, '/')));
          returnOrigin = parsed.returnOrigin || '';
          sessionId = parsed.sessionId || '';
        }
      } catch {}

      if (authError) {
        document.getElementById('spin').style.display = 'none';
        document.getElementById('title').innerText = 'Otorisasi Dibatalkan';
        document.getElementById('desc').innerText = authError;
        return;
      }

      if (!idToken && !accessToken) {
        document.getElementById('spin').style.display = 'none';
        document.getElementById('title').innerText = 'Token Tidak Ditemukan';
        document.getElementById('desc').innerText = 'Google tidak mengembalikan credential token.';
        return;
      }

      // Kirim token ke endpoint Boson Gateway
      fetch('/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, accessToken, sessionId })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          document.getElementById('spin').style.display = 'none';
          document.getElementById('title').innerText = 'Login Berhasil! 🎉';
          document.getElementById('desc').innerText = 'Selamat datang, ' + (data.user?.name || data.user?.email) + '. Anda dapat menutup tab ini.';

          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', payload: data }, '*');
            setTimeout(() => window.close(), 1000);
          } else {
            setTimeout(() => {
              try { window.close(); } catch(e){}
            }, 2500);
          }
        } else {
          document.getElementById('spin').style.display = 'none';
          document.getElementById('title').innerText = 'Verifikasi Gagal';
          document.getElementById('desc').innerText = data.error || 'Autentikasi ditolak oleh server.';
        }
      })
      .catch(err => {
        document.getElementById('spin').style.display = 'none';
        document.getElementById('title').innerText = 'Koneksi Terputus';
        document.getElementById('desc').innerText = err.message;
      });
    })();
  </script>
</body>
</html>`
}
