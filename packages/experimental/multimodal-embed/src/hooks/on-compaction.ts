/**
 * Symbiotic Compaction Listener & Knowledge Harvester (Tier 2 Macro Consolidation).
 * Listens to durable session events ('compaction/summary') to automatically preserve pruned knowledge
 * into the long-term vector store:
 * 1. Full episodic checkpoint as category 'summary'.
 * 2. Distilled bugfixes and technical insights from "## Errors and Fixes" as category 'lesson'.
 * 3. Distilled architectural and operational constraints from "## Critical Context" as category 'rule'.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/hooks/on-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MultimodalEmbedService, MemoryItem } from '../types.ts'
import type { MultimodalEmbedConfig } from '../config.ts'
import { isDuplicateRule, normalizeRuleText } from '../directive-sniffer.ts'

export interface DistilledItem {
  category: 'lesson' | 'rule'
  topic: string
  content: string
  metadata: Record<string, unknown>
}

/**
 * Extracts individual bullet items (including multi-line continuations) from a markdown section.
 *
 * @param sectionText - The body text under a markdown heading.
 * @returns Array of trimmed bullet item texts.
 */
export function extractBulletItems(sectionText: string): string[] {
  const lines = sectionText.split('\n')
  const bullets: string[] = []
  let currentBullet = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^[-*]\s+/.test(trimmed)) {
      if (currentBullet.length > 0) {
        bullets.push(currentBullet.trim())
      }
      currentBullet = trimmed.replace(/^[-*]\s+/, '')
    } else if (currentBullet.length > 0 && trimmed.length > 0 && !trimmed.startsWith('#')) {
      currentBullet += ` ${trimmed}`
    }
  }

  if (currentBullet.length > 0) {
    bullets.push(currentBullet.trim())
  }

  return bullets.filter(b => b.length > 10 && !/^\(?none\)?$/i.test(b))
}

/**
 * Distills structured lessons and rules from a structured compacted summary string.
 *
 * @param summaryText - Full markdown summary produced by compaction summarizer.
 * @param compactionId - Optional compaction identifier for traceability.
 * @returns List of distilled lessons and operational rules.
 */
export function distillCompactedSummary(summaryText: string, compactionId?: string): DistilledItem[] {
  const items: DistilledItem[] = []

  // 1. Errors and Fixes -> Category 'lesson'
  const errorsMatch = summaryText.match(/##\s+Errors and Fixes\s*\n([\s\S]*?)(?=\n##\s+|$)/i)
  if (errorsMatch?.[1]) {
    const errorBullets = extractBulletItems(errorsMatch[1])
    for (const bullet of errorBullets) {
      items.push({
        category: 'lesson',
        topic: 'Compacted Error & Fix',
        content: `[COMPACTED BUGFIX]\n${bullet}`,
        metadata: {
          category: 'lesson',
          topic: 'Compacted Error & Fix',
          compactionId,
          autoDistilled: true,
          distilledAt: Date.now(),
        },
      })
    }
  }

  // 2. Key Technical Concepts -> Category 'lesson'
  const conceptsMatch = summaryText.match(/##\s+Key Technical Concepts\s*\n([\s\S]*?)(?=\n##\s+|$)/i)
  if (conceptsMatch?.[1]) {
    const conceptBullets = extractBulletItems(conceptsMatch[1])
    for (const bullet of conceptBullets) {
      if (bullet.length >= 20) {
        items.push({
          category: 'lesson',
          topic: 'Key Technical Concept',
          content: `[TECHNICAL CONCEPT]\n${bullet}`,
          metadata: {
            category: 'lesson',
            topic: 'Key Technical Concept',
            compactionId,
            autoDistilled: true,
            distilledAt: Date.now(),
          },
        })
      }
    }
  }

  // 3. Critical Context -> Category 'rule' (if constraint) or 'lesson' (if architecture decision)
  const contextMatch = summaryText.match(/##\s+Critical Context\s*\n([\s\S]*?)(?=\n##\s+|$)/i)
  if (contextMatch?.[1]) {
    const contextBullets = extractBulletItems(contextMatch[1])
    for (const bullet of contextBullets) {
      const isDirective = /\b(?:constraint|rule|preference|always|never|must|branch|target|dilarang|jangan|wajib|selalu)\b/i.test(bullet)
      if (isDirective) {
        items.push({
          category: 'rule',
          topic: 'Operational Constraint',
          content: `[PROJECT] ${bullet}`,
          metadata: {
            scope: 'project',
            rawRule: bullet,
            compactionId,
            autoDistilled: true,
            distilledAt: Date.now(),
          },
        })
      } else if (bullet.length >= 25) {
        items.push({
          category: 'lesson',
          topic: 'Decision & Context',
          content: `[DECISION & CONTEXT]\n${bullet}`,
          metadata: {
            category: 'lesson',
            topic: 'Decision & Context',
            compactionId,
            autoDistilled: true,
            distilledAt: Date.now(),
          },
        })
      }
    }
  }

  return items
}

/**
 * Checks whether a candidate lesson is duplicate against existing lessons in store.
 *
 * @param existingLessons - Active list of lessons from vector DB.
 * @param content - Candidate lesson content.
 * @returns True if already present.
 */
function isDuplicateLesson(existingLessons: MemoryItem[], content: string): boolean {
  const normCandidate = normalizeRuleText(content)
  for (const item of existingLessons) {
    const normItem = normalizeRuleText(item.content)
    if (normItem === normCandidate) return true
    if (normItem.length > 25 && normCandidate.length > 25) {
      if (normItem.includes(normCandidate) || normCandidate.includes(normItem)) {
        return true
      }
    }
  }
  return false
}

export function registerCompactionListener(
  ctx: Context,
  service: MultimodalEmbedService,
  config: MultimodalEmbedConfig,
): void {
  if (!config.autoCaptureCompacted) return

  ctx.on('session/event', async (_session: Session, event: SessionEvent): Promise<void> => {
    try {
      const rawEvent = event as {
        type: string
        data?: {
          summary?: Array<{ type?: string; text?: string }>
          compactionId?: string
          shadowedTokenCount?: number
          shadowedSeqs?: unknown[]
        }
      }
      if (rawEvent.type === 'compaction/summary') {
        const data = rawEvent.data
        if (!data || !data.summary) return

        // Extract summary text blocks
        const summaryText = data.summary
          .filter((block): block is { text: string } => typeof block.text === 'string' && block.text.trim().length > 0)
          .map(block => block.text)
          .join('\n\n')

        if (summaryText.length === 0) return

        // 1. Episodic checkpoint preservation
        const id = await service.saveEntry('summary', summaryText, {
          compactionId: data.compactionId,
          shadowedTokenCount: data.shadowedTokenCount,
          shadowedSeqsCount: data.shadowedSeqs?.length ?? 0,
        })

        ctx.logger.info(
          `multimodal-embed: captured compacted summary into vector store (id: ${id}, ~${data.shadowedTokenCount ?? 0} tokens saved)`,
        )

        // 2. Knowledge Harvester (Tier 2 Macro Consolidation)
        if (config.autoDistillLessonsFromCompaction) {
          const distilledItems = distillCompactedSummary(summaryText, data.compactionId)
          if (distilledItems.length > 0) {
            const existingRules = await service.getEntriesByCategory('rule', 50).catch(() => [] as MemoryItem[])
            const existingLessons = await service.getEntriesByCategory('lesson', 50).catch(() => [] as MemoryItem[])

            let distilledLessonsCount = 0
            let distilledRulesCount = 0

            for (const item of distilledItems) {
              if (item.category === 'rule') {
                const raw = (item.metadata.rawRule as string | undefined) ?? item.content
                if (!isDuplicateRule(existingRules, raw)) {
                  await service.saveEntry('rule', item.content, item.metadata)
                  existingRules.push({
                    id: `rule_temp_${Date.now()}`,
                    category: 'rule',
                    content: item.content,
                    score: 1.0,
                    metadata: item.metadata,
                    createdAt: Date.now(),
                  })
                  distilledRulesCount += 1
                }
              } else {
                if (!isDuplicateLesson(existingLessons, item.content)) {
                  await service.saveEntry('lesson', item.content, item.metadata)
                  existingLessons.push({
                    id: `lesson_temp_${Date.now()}`,
                    category: 'lesson',
                    content: item.content,
                    score: 1.0,
                    metadata: item.metadata,
                    createdAt: Date.now(),
                  })
                  distilledLessonsCount += 1
                }
              }
            }

            if (distilledLessonsCount > 0 || distilledRulesCount > 0) {
              ctx.logger.info(
                `multimodal-embed: auto-distilled from compaction: ${distilledLessonsCount} lesson(s), ${distilledRulesCount} rule(s)`,
              )
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.logger.warn(`multimodal-embed compaction capture error: ${msg}`)
    }
  })
}
