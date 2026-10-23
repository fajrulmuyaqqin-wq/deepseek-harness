// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: POSTGRES-META BRIDGE FOR SUPABASE STUDIO
// Menyediakan REST API kompatibel postgres-meta untuk Supabase Studio:
// - POST /query (Menjalankan SQL query langsung via pg.Pool ke db:5432)
// - GET /policies, /types, /publications, /triggers, /extensions, /schemas, /tables
// ─────────────────────────────────────────────────────────────

import pg from 'pg'

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'GantiPasswordPostgresYangSangatKuatDanPanjang123!',
  database: process.env.DB_NAME || 'postgres',
  max: 15,
  idleTimeoutMillis: 30000,
})

pool.on('error', (err) => {
  console.error('[pgMetaBridge Pool Error]:', err.message)
})

export function registerPgMetaRoutes(app) {
  console.log('[pgMetaBridge] Registering postgres-meta emulation routes for Supabase Studio...')

  // 1. Core SQL Query Execution (POST /query)
  app.post(['/query', '/api/query', '/pg/query'], async (req, res) => {
    const { query, parameters } = req.body || {}
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(200).json([])
    }

    try {
      const result = await pool.query(query, Array.isArray(parameters) ? parameters : undefined)
      // Supabase Studio expects an array of rows
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /query SQL warning]:', err.message, '| Query:', (query || '').slice(0, 150))
      return res.status(400).json({
        message: err.message,
        code: err.code || '42000',
        formattedError: err.message,
      })
    }
  })

  // 2. Policies Endpoint (GET /policies)
  app.get(['/policies', '/api/policies', '/pg/policies'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          p.oid AS id,
          p.polname AS name,
          n.nspname AS schema,
          c.relname AS table,
          CASE p.polcmd
            WHEN 'r' THEN 'SELECT'
            WHEN 'a' THEN 'INSERT'
            WHEN 'w' THEN 'UPDATE'
            WHEN 'd' THEN 'DELETE'
            ELSE 'ALL'
          END AS action,
          ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)) AS roles,
          COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS definition,
          COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS "check"
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        ORDER BY n.nspname, c.relname, p.polname;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /policies error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 3. Types Endpoint (GET /types)
  app.get(['/types', '/api/types', '/pg/types'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          t.oid AS id,
          t.typname AS name,
          n.nspname AS schema,
          t.typtype AS type
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, t.typname;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /types error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 4. Publications Endpoint (GET /publications)
  app.get(['/publications', '/api/publications', '/pg/publications'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          oid AS id,
          pubname AS name,
          pubowner AS owner,
          puballtables AS all_tables,
          pubinsert AS "insert",
          pubupdate AS "update",
          pubdelete AS "delete"
        FROM pg_publication;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /publications error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 5. Extensions Endpoint (GET /extensions)
  app.get(['/extensions', '/api/extensions', '/pg/extensions'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          e.oid AS id,
          e.extname AS name,
          n.nspname AS schema,
          e.extversion AS default_version,
          e.extversion AS installed_version,
          COALESCE(c.description, '') AS comment
        FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        LEFT JOIN pg_description c ON c.objoid = e.oid;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /extensions error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 6. Triggers Endpoint (GET /triggers)
  app.get(['/triggers', '/api/triggers', '/pg/triggers'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          t.oid AS id,
          t.tgname AS name,
          n.nspname AS schema,
          c.relname AS table,
          t.tgenabled AS enabled
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[pgMetaBridge /triggers error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 7. Schemas Endpoint (GET /schemas)
  app.get(['/schemas', '/api/schemas', '/pg/schemas'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          schema_name AS name,
          schema_owner AS owner
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schema_name;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      return res.status(200).json([])
    }
  })

  // 8. Tables Endpoint (GET /tables)
  app.get(['/tables', '/api/tables', '/pg/tables'], async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          c.oid AS id,
          c.relname AS name,
          n.nspname AS schema,
          c.reltuples AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, c.relname;
      `)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      return res.status(200).json([])
    }
  })

  // 9. Meta Config & Version
  app.get(['/config', '/version'], (_req, res) => {
    res.json({
      version: '0.84.2',
      status: 'ok',
      service: 'Boson Embedded Postgres-Meta Bridge',
    })
  })
}
