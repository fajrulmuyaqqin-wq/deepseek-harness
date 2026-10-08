/**
 * Unified manage_memory tool with action-based sub-tools (CRUD).
 * Consolidates save, delete, search, and list operations into a single cohesive tool schema
 * to minimize token footprint and eliminate tool ambiguity.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/manage-memory
 */

import type { MultimodalEmbedService, MemoryCategory } from '../types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isDuplicateRule } from '../directive-sniffer.ts'

export interface ManageMemoryResult {
  readonly ok: boolean
  readonly action: 'save' | 'delete' | 'search' | 'list'
  readonly id?: string | undefined
  readonly category?: string | undefined
  readonly count?: number | undefined
  readonly deletedCount?: number | undefined
  readonly deletedIds?: readonly string[] | undefined
  readonly message: string
  readonly results?: ReadonlyArray<{
    readonly id: string
    readonly category: string
    readonly content: string
    readonly score?: number | undefined
    readonly createdAt: number
  }> | undefined
}

export function createManageMemoryTool(service: MultimodalEmbedService) {
  return defineTool({
    name: 'manage_memory',
    description: 'Kelola memori jangka panjang agent secara terpadu: simpan pelajaran/aturan baru, hapus/lupakan ingatan usang, cari memori semantik, atau tampilkan daftar aturan/pelajaran aktif.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['save', 'delete', 'search', 'list'],
        description: 'Operasi memori: "save" (simpan), "delete" (hapus/lupakan), "search" (cari kemiripan semantik), "list" (tampilkan daftar)',
      },
      category: {
        type: 'string',
        enum: ['rule', 'lesson', 'summary', 'code', 'asset', 'catalog_tool', 'catalog_skill'],
        description: 'Kategori memori: "rule" (aturan operasional), "lesson" (solusi bug/arsitektur), "summary" (checkpoint), dll.',
      },
      content: {
        type: 'string',
        description: 'Isi teks aturan, pelajaran, atau solusi yang ingin disimpan (wajib jika action: "save")',
      },
      query: {
        type: 'string',
        description: 'Teks pencarian semantik (jika action: "search") atau kata kunci ingatan yang ingin dihapus (jika action: "delete")',
      },
      id: {
        type: 'string',
        description: 'ID spesifik memori yang ingin dihapus (jika action: "delete" dan ID diketahui)',
      },
      scope: {
        type: 'string',
        enum: ['project', 'workflow', 'user_preference'],
        description: 'Cakupan aturan (jika action: "save" dan category: "rule", default: "workflow")',
      },
      limit: {
        type: 'number',
        description: 'Jumlah hasil maksimal yang dikembalikan (untuk action "search" atau "list", default: 5)',
      },
      threshold: {
        type: 'number',
        description: 'Skor ambang batas kemiripan vektor 0.0 - 1.0 (hanya untuk action "search", default: 0.5)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const val = value as ManageMemoryResult
        if (val.action === 'save') {
          return [{
            type: 'text',
            text: `✅ **[MEMORI TERSIMPAN]**\nKategori: \`${val.category ?? 'lesson'}\`\n${val.message}\n> ID: \`${val.id ?? 'unknown'}\``,
          }]
        }
        if (val.action === 'delete') {
          return [{
            type: 'text',
            text: `🗑️ **[PENGHAPUSAN MEMORI]**\n${val.message}${val.deletedCount ? ` (${val.deletedCount} entri dihapus)` : ''}`,
          }]
        }
        if (val.action === 'search') {
          const items = val.results ?? []
          if (items.length === 0) {
            return [{ type: 'text', text: '🔍 **[PENCARIAN MEMORI]**\nTidak ditemukan memori yang cocok dengan kueri tersebut.' }]
          }
          const formatted = items.map(
            (item, idx) => `${idx + 1}. [${item.category.toUpperCase()}]${item.score !== undefined ? ` (Skor: ${(item.score * 100).toFixed(1)}%)` : ''}\n${item.content}`,
          ).join('\n\n')
          return [{ type: 'text', text: `🔍 **[HASIL PENCARIAN MEMORI]** (${items.length} hasil):\n\n${formatted}` }]
        }
        if (val.action === 'list') {
          const items = val.results ?? []
          if (items.length === 0) {
            return [{ type: 'text', text: `📋 **[DAFTAR MEMORI: ${(val.category ?? 'RULE').toUpperCase()}]**\nBelum ada entri tersimpan untuk kategori ini.` }]
          }
          const formatted = items.map(
            (item, idx) => `${idx + 1}. [ID: \`${item.id}\`] ${item.content}`,
          ).join('\n\n')
          return [{ type: 'text', text: `📋 **[DAFTAR MEMORI: ${(val.category ?? 'RULE').toUpperCase()}]** (${items.length} entri):\n\n${formatted}` }]
        }
        return [{ type: 'text', text: val.message }]
      },
    },
    async execute(args, exec) {
      const action = args.action

      // --- 1. ACTION: SAVE ---
      if (action === 'save') {
        const rawContent = args.content?.trim()
        if (!rawContent || rawContent.length === 0) {
          return {
            ok: false,
            action: 'save',
            message: 'Parameter "content" wajib diisi untuk operasi save.',
          }
        }

        const category: MemoryCategory = (args.category as MemoryCategory) ?? 'lesson'

        if (category === 'rule') {
          const scope = args.scope ?? 'workflow'
          const existingRules = await service.getEntriesByCategory('rule', 50).catch(() => [])
          for (const existing of existingRules) {
            if (isDuplicateRule([existing], rawContent)) {
              return {
                ok: true,
                action: 'save',
                id: existing.id,
                category: 'rule',
                message: `Aturan sudah ada sebelumnya (deduplicated): "${rawContent}"`,
              }
            }
          }

          const content = `[${scope.toUpperCase()}] ${rawContent}`
          const id = await service.saveEntry('rule', content, {
            scope,
            rawRule: rawContent,
          })
          return {
            ok: true,
            action: 'save',
            id,
            category: 'rule',
            message: `Aturan [${scope}] berhasil disimpan: "${rawContent}"`,
          }
        }

        // Other categories: lesson, summary, code, asset
        const existingEntries = await service.getEntriesByCategory(category, 50).catch(() => [])
        const normalizedInput = rawContent.toLowerCase().trim()
        for (const existing of existingEntries) {
          if (existing.content.toLowerCase().trim() === normalizedInput) {
            return {
              ok: true,
              action: 'save',
              id: existing.id,
              category,
              message: `Pelajaran/memori sudah ada sebelumnya (deduplicated): "${rawContent}"`,
            }
          }
        }

        const id = await service.saveEntry(category, rawContent, {
          createdAt: Date.now(),
        })
        return {
          ok: true,
          action: 'save',
          id,
          category,
          message: `Memori [${category}] berhasil disimpan.`,
        }
      }

      // --- 2. ACTION: DELETE ---
      if (action === 'delete') {
        if (args.id) {
          const ok = await service.deleteEntry(args.id)
          return {
            ok,
            action: 'delete',
            deletedCount: ok ? 1 : 0,
            deletedIds: ok ? [args.id] : [],
            message: ok
              ? `Memori dengan ID "${args.id}" berhasil dihapus.`
              : `Memori dengan ID "${args.id}" tidak ditemukan.`,
          }
        }

        if (args.query && args.query.trim().length > 0) {
          const cat = args.category as MemoryCategory | undefined
          const res = await service.deleteEntriesByQuery(args.query.trim(), cat)
          return {
            ok: res.deletedCount > 0,
            action: 'delete',
            deletedCount: res.deletedCount,
            deletedIds: res.deletedIds,
            message: res.deletedCount > 0
              ? `Berhasil menghapus ${res.deletedCount} memori yang cocok dengan kueri "${args.query}".`
              : `Tidak ditemukan memori yang cocok dengan "${args.query}" untuk dihapus.`,
          }
        }

        return {
          ok: false,
          action: 'delete',
          message: 'Tentukan "id" atau "query" teks kata kunci memori yang ingin dihapus.',
        }
      }

      // --- 3. ACTION: SEARCH ---
      if (action === 'search') {
        const queryText = args.query?.trim()
        if (!queryText || queryText.length === 0) {
          return {
            ok: false,
            action: 'search',
            message: 'Parameter "query" wajib diisi untuk operasi search.',
          }
        }

        const vector = await service.embedText(queryText, exec.signal)
        const cat = args.category as MemoryCategory | undefined
        const matches = await service.searchSimilar(
          vector,
          args.limit ?? 5,
          args.threshold,
          cat,
        )

        return {
          ok: true,
          action: 'search',
          count: matches.length,
          results: matches.map(m => ({
            id: m.id,
            category: m.category,
            content: m.content,
            score: Math.round(m.score * 1000) / 1000,
            createdAt: m.createdAt,
          })),
          message: `Ditemukan ${matches.length} memori relevan.`,
        }
      }

      // --- 4. ACTION: LIST ---
      const category: MemoryCategory = (args.category as MemoryCategory) ?? 'rule'
      const entries = await service.getEntriesByCategory(category, args.limit ?? 10)
      return {
        ok: true,
        action: 'list',
        category,
        count: entries.length,
        results: entries.map(e => ({
          id: e.id,
          category: e.category,
          content: e.content,
          createdAt: e.createdAt,
        })),
        message: `Ditemukan ${entries.length} entri memori untuk kategori "${category}".`,
      }
    },
  })
}
