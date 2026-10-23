// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: MCP BRIDGE FOR ANTIGRAVITY & AI CLIENTS
// Menghubungkan client AI (Antigravity, Cursor, Claude Code) ke
// Streamable HTTP MCP Server bawaan Supabase Studio.
// Endpoint: /mcp dan /api/mcp
// ─────────────────────────────────────────────────────────────

import http from 'node:http'

export function registerMcpRoutes(app) {
  console.log('[mcpBridge] Registering Supabase MCP proxy routes...')

  const studioHost = process.env.STUDIO_HOST || 'studio'
  const studioPort = parseInt(process.env.STUDIO_INTERNAL_PORT || '3000', 10)

  app.all(['/mcp', '/api/mcp'], (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // Di lingkungan offline, fitur 'docs' mencoba mengambil dokumentasi dari internet (fetch failed).
    // Bersihkan 'docs' agar database, debugging, dan development tools tetap berjalan optimal.
    const rawFeatures = url.searchParams.get('features')
    if (rawFeatures) {
      const featureList = rawFeatures
        .split(',')
        .map(f => f.trim().toLowerCase())
        .filter(f => f !== 'docs')
      if (featureList.length > 0) {
        url.searchParams.set('features', featureList.join(','))
      } else {
        url.searchParams.delete('features')
      }
    }

    const targetPath = `/api/mcp${url.search}`

    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection

    // Pastikan Streamable HTTP MCP menerima content types yang diperlukan
    if (!headers.accept) {
      headers.accept = 'application/json, text/event-stream'
    } else if (!headers.accept.includes('text/event-stream')) {
      headers.accept = `${headers.accept}, text/event-stream`
    }

    const proxyReq = http.request(
      {
        hostname: studioHost,
        port: studioPort,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )

    proxyReq.on('error', (err) => {
      console.error('[mcpBridge Error]:', err.message)
      if (!res.headersSent) {
        res.status(502).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `MCP Gateway proxy error: ${err.message}`,
          },
          id: req.body?.id || null,
        })
      }
    })

    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      proxyReq.setHeader('content-length', Buffer.byteLength(bodyData))
      proxyReq.write(bodyData)
      proxyReq.end()
    } else {
      req.pipe(proxyReq)
    }
  })
}
