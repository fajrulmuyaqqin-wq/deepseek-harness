// ─────────────────────────────────────────────────────────────
// BOSON STUDIO: STORAGE API BRIDGE FOR SUPABASE STUDIO
// Menyediakan REST API kompatibel Supabase Storage (/storage/v1/*):
// - GET /storage/v1/bucket (List Buckets)
// - GET /storage/v1/bucket/:id (Get Bucket)
// - POST /storage/v1/bucket (Create Bucket)
// - PUT /storage/v1/bucket/:id (Update Bucket)
// - DELETE /storage/v1/bucket/:id (Delete Bucket)
// - POST /storage/v1/bucket/:id/empty (Empty Bucket)
// - POST /storage/v1/object/list/:bucket (List Objects)
// ─────────────────────────────────────────────────────────────

import pg from 'pg'

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'GantiPasswordPostgresYangSangatKuatDanPanjang123!',
  database: process.env.DB_NAME || 'postgres',
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on('error', (err) => {
  console.error('[storageBridge Pool Error]:', err.message)
})

export function registerStorageRoutes(app) {
  console.log('[storageBridge] Registering Supabase Storage API routes (/storage/v1/*)...')

  // 1. List all buckets (GET /storage/v1/bucket)
  app.get(['/storage/v1/bucket', '/api/storage/v1/bucket'], async (req, res) => {
    try {
      const { limit, offset, sortColumn = 'created_at', sortOrder = 'desc', search } = req.query
      let query = `
        SELECT 
          id, 
          name, 
          COALESCE(owner::text, '') AS owner, 
          created_at, 
          updated_at, 
          public, 
          file_size_limit, 
          allowed_mime_types 
        FROM storage.buckets
      `
      const params = []
      if (search) {
        params.push(`%${search}%`)
        query += ` WHERE name ILIKE $${params.length}`
      }
      const orderCol = ['id', 'name', 'created_at'].includes(sortColumn) ? sortColumn : 'created_at'
      const orderDir = (sortOrder || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
      query += ` ORDER BY ${orderCol} ${orderDir}`

      if (limit) {
        params.push(parseInt(limit, 10))
        query += ` LIMIT $${params.length}`
      }
      if (offset) {
        params.push(parseInt(offset, 10))
        query += ` OFFSET $${params.length}`
      }

      const result = await pool.query(query, params)
      return res.status(200).json(result.rows || [])
    } catch (err) {
      console.warn('[storageBridge /storage/v1/bucket error]:', err.message)
      return res.status(200).json([])
    }
  })

  // 2. Get bucket by ID (GET /storage/v1/bucket/:id)
  app.get(['/storage/v1/bucket/:id', '/api/storage/v1/bucket/:id'], async (req, res) => {
    try {
      const { id } = req.params
      const result = await pool.query('SELECT * FROM storage.buckets WHERE id = $1;', [id])
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bucket not found', message: 'Bucket not found' })
      }
      return res.status(200).json(result.rows[0])
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  })

  // 3. Create bucket (POST /storage/v1/bucket)
  app.post(['/storage/v1/bucket', '/api/storage/v1/bucket'], async (req, res) => {
    try {
      const { id, name, public: isPublic = false, file_size_limit = null, allowed_mime_types = null } = req.body || {}
      const bucketId = id || name
      if (!bucketId) {
        return res.status(400).json({ error: 'Bucket id or name is required' })
      }
      const result = await pool.query(`
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          public = EXCLUDED.public,
          updated_at = now()
        RETURNING *;
      `, [bucketId, name || bucketId, Boolean(isPublic), file_size_limit, allowed_mime_types])

      return res.status(200).json({ name: result.rows[0].name })
    } catch (err) {
      console.error('[storageBridge createBucket error]:', err.message)
      return res.status(400).json({ error: err.message })
    }
  })

  // 4. Update bucket (PUT /storage/v1/bucket/:id)
  app.put(['/storage/v1/bucket/:id', '/api/storage/v1/bucket/:id'], async (req, res) => {
    try {
      const { id } = req.params
      const { public: isPublic, file_size_limit, allowed_mime_types } = req.body || {}
      await pool.query(`
        UPDATE storage.buckets 
        SET 
          public = COALESCE($2, public),
          file_size_limit = COALESCE($3, file_size_limit),
          allowed_mime_types = COALESCE($4, allowed_mime_types),
          updated_at = now()
        WHERE id = $1;
      `, [id, isPublic, file_size_limit, allowed_mime_types])

      return res.status(200).json({ message: 'Successfully updated' })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  })

  // 5. Delete bucket (DELETE /storage/v1/bucket/:id)
  app.delete(['/storage/v1/bucket/:id', '/api/storage/v1/bucket/:id'], async (req, res) => {
    try {
      const { id } = req.params
      await pool.query('DELETE FROM storage.buckets WHERE id = $1;', [id])
      return res.status(200).json({ message: 'Successfully deleted' })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  })

  // 6. Empty bucket (POST /storage/v1/bucket/:id/empty)
  app.post(['/storage/v1/bucket/:id/empty', '/api/storage/v1/bucket/:id/empty'], async (req, res) => {
    try {
      const { id } = req.params
      await pool.query('DELETE FROM storage.objects WHERE bucket_id = $1;', [id])
      return res.status(200).json({ message: 'Successfully emptied' })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
  })

  // 7. List objects in bucket (POST /storage/v1/object/list/:bucket)
  app.post(['/storage/v1/object/list/:bucket', '/api/storage/v1/object/list/:bucket'], async (req, res) => {
    try {
      const { bucket } = req.params
      const { prefix = '', limit = 100, offset = 0 } = req.body || {}
      const result = await pool.query(`
        SELECT 
          id, 
          name, 
          updated_at, 
          created_at, 
          last_accessed_at, 
          metadata
        FROM storage.objects
        WHERE bucket_id = $1 AND name LIKE $2
        ORDER BY name ASC
        LIMIT $3 OFFSET $4;
      `, [bucket, `${prefix}%`, parseInt(limit, 10), parseInt(offset, 10)])

      return res.status(200).json(result.rows || [])
    } catch (err) {
      return res.status(200).json([])
    }
  })
}
