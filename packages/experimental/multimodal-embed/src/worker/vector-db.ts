/**
 * SQLite WAL Vector Store (Fase 2).
 * Uses native node:sqlite with WAL mode for zero-dependency non-blocking persistence.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/worker/vector-db
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { cosineSimilarity } from './embedder.ts'
import type { MemoryItem } from '../types.ts'

interface MemoryRow {
  id: string
  category: MemoryItem['category']
  content: string
  vector: Buffer
  metadata?: string | null
  created_at: number
}

export class VectorDatabase {
  private db: DatabaseSync

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      try {
        mkdirSync(dirname(dbPath), { recursive: true })
      } catch {
        // Ignored if directory already exists
      }
    }

    this.db = new DatabaseSync(dbPath)
    this.initSchema()
  }

  private initSchema(): void {
    // Enable WAL mode (Write-Ahead Logging) so reads never block writes
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA synchronous = NORMAL;')
    } catch {
      // WAL might not apply in :memory: databases
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multimodal_memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON multimodal_memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON multimodal_memories(created_at);
    `)
  }

  save(
    id: string,
    category: MemoryItem['category'],
    content: string,
    vector: Float32Array,
    metadata?: Record<string, unknown>,
    createdAt = Date.now(),
  ): void {
    const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
    const metadataJson = metadata ? JSON.stringify(metadata) : null

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO multimodal_memories (id, category, content, vector, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    insert.run(id, category, content, vectorBuffer, metadataJson, createdAt)
  }

  search(
    queryVector: Float32Array,
    limit = 5,
    threshold = 0.5,
    category?: MemoryItem['category'] | MemoryItem['category'][],
  ): MemoryItem[] {
    let rows: unknown[]
    if (Array.isArray(category) && category.length > 0) {
      const placeholders = category.map(() => '?').join(', ')
      const query = this.db.prepare(
        `SELECT id, category, content, vector, metadata, created_at FROM multimodal_memories WHERE category IN (${placeholders})`,
      )
      rows = query.all(...category)
    } else if (typeof category === 'string') {
      const query = this.db.prepare(
        'SELECT id, category, content, vector, metadata, created_at FROM multimodal_memories WHERE category = ?',
      )
      rows = query.all(category)
    } else {
      const query = this.db.prepare(
        'SELECT id, category, content, vector, metadata, created_at FROM multimodal_memories',
      )
      rows = query.all()
    }
    const results: MemoryItem[] = []

    for (const row of rows as unknown as MemoryRow[]) {
      const blob = row.vector
      const vector = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
      const score = cosineSimilarity(queryVector, vector)

      if (score >= threshold) {
        let metadata: Record<string, unknown> | undefined
        if (row.metadata) {
          try {
            metadata = JSON.parse(row.metadata) as Record<string, unknown>
          } catch {
            metadata = undefined
          }
        }

        const item: MemoryItem = {
          id: row.id,
          category: row.category,
          content: row.content,
          score,
          metadata,
          createdAt: row.created_at,
        }
        results.push(item)
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM multimodal_memories').get() as { count: number }
    return row.count
  }

  close(): void {
    this.db.close()
  }
}
