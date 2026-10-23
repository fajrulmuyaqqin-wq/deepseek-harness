/**
 * @deprecated
 * File ini telah di-prune. Tampilan antarmuka billing & customer self-service
 * kini sepenuhnya dilayani oleh ArtCraft Website (Next.js di http://localhost:3000/pricing).
 * Seluruh rute gateway /billing, /keys, /portal otomatis dialihkan (302 Redirect).
 */

export function renderBillingPortalHtml(platformPublicUrl = 'http://localhost:8088') {
  const targetUrl = process.env.FRONTEND_PUBLIC_URL
    ? `${process.env.FRONTEND_PUBLIC_URL}/pricing`
    : 'http://localhost:3000/pricing'

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Redirecting to Customer Portal...</title>
  <meta http-equiv="refresh" content="0; url=${targetUrl}">
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #161e2e; padding: 2rem; border-radius: 12px; border: 1px solid #1f293d; text-align: center; max-width: 420px; }
    a { color: #38bdf8; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <p>Mengalihkan Anda ke Customer Portal resmi...</p>
    <p><a href="${targetUrl}">Klik di sini jika tidak dialihkan secara otomatis &rarr;</a></p>
  </div>
</body>
</html>`
}
