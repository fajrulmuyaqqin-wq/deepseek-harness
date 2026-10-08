/**
 * Directive & Project Rule Sniffer (Tier 1 Real-Time Consolidation).
 * Analyzes incoming user messages in real time for explicit operational constraints,
 * directives, and project rules, persisting them into vector memory without blocking turns.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/directive-sniffer
 */

import type { MultimodalEmbedService, MemoryItem } from './types.ts'

export interface DirectiveCandidate {
  readonly rule: string
  readonly scope: 'project' | 'workflow' | 'user_preference'
}

export interface DirectiveSnifferLogger {
  info(msg: string): void
  warn(msg: string): void
  debug?(msg: string): void
}

/**
 * Normalizes text for similarity and deduplication comparison.
 *
 * @param text - The raw rule or candidate text.
 * @returns Cleaned lowercase text without redundant whitespace or punctuation.
 */
export function normalizeRuleText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extracts a candidate directive from user input text if explicit directive patterns match.
 *
 * @param text - Raw message text from user.
 * @returns Extracted candidate directive and scope, or undefined if not a directive.
 */
export function extractDirectiveCandidate(text: string): DirectiveCandidate | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 10 || trimmed.length > 350) return undefined

  // Gatekeeper 1: Reject questions
  if (trimmed.endsWith('?')) return undefined
  if (/^(?:apa(?:kah)?|kenapa|mengapa|bagaimana|gimana|why|how|what|is\s+it|can\s+we|could\s+you)\b/i.test(trimmed)) {
    return undefined
  }

  // Gatekeeper 2: Reject ephemeral commands and single-turn task executions
  const ephemeralRegex = new RegExp(
    '^(?:baca|edit|buka|cek|periksa|jalankan|run|read|open|inspect|test)' +
    '\\s+(?:file|berkas|folder|perintah|command|pnpm|npm|git status|git diff)\\b',
    'i',
  )
  if (ephemeralRegex.test(trimmed)) {
    return undefined
  }
  if (/^(?:lanjut|continue|ok|oke|yes|ya|sip|done|proceed)\b/i.test(trimmed)) {
    return undefined
  }

  let ruleContent: string | undefined

  // Pattern 1: Explicit labels (e.g., "aturan kita: ...", "rule: ...", "directives: ...")
  const labelMatch = trimmed.match(/(?:^|\n)\s*(?:aturan(?:\s+(?:kita|proyek|kerja))?|rules?|directives?)\s*[:=]\s*(.+)/i)
  if (labelMatch?.[1]) {
    ruleContent = labelMatch[1].trim()
  }

  // Pattern 2: Reminder directives (e.g., "ingat ya, ...", "remember to ...", "catat bahwa ...")
  if (!ruleContent) {
    const reminderMatch = trimmed.match(/(?:^|\n)\s*(?:ingat(?:kan)?(?: ya)?|catat|remember|note that)\s*[:,\s]+(?:bahwa\s+)?(.+)/i)
    if (reminderMatch?.[1]) {
      ruleContent = reminderMatch[1].trim()
    }
  }

  // Pattern 3: Negative constraints (e.g., "jangan pernah push ke master", "never push to master", "dilarang ...")
  if (!ruleContent) {
    const negativeMatch = trimmed.match(/(?:^|\n)\s*(?:jangan(?:\s+pernah)?|never|dilarang)\s+(.+)/i)
    if (negativeMatch?.[1]) {
      ruleContent = `Jangan ${negativeMatch[1].trim()}`
    }
  }

  // Pattern 4: Strict positive obligations (e.g., "selalu gunakan development", "always use development", "wajib jalankan ...")
  if (!ruleContent) {
    const positiveMatch = trimmed.match(/(?:^|\n)\s*(?:selalu|always|wajib|must)\s+(.+)/i)
    if (positiveMatch?.[1]) {
      ruleContent = `Selalu ${positiveMatch[1].trim()}`
    }
  }

  // Pattern 5: Target branch declarations (e.g., "target branch selalu development", "target branch ke development")
  if (!ruleContent) {
    const branchMatch = trimmed.match(/(?:^|\n)\s*(?:target\s+(?:git\s+)?branch\s+(?:selalu|adalah|ke|harus)\s+.+)/i)
    if (branchMatch?.[0]) {
      ruleContent = branchMatch[0].trim()
    }
  }

  if (!ruleContent || ruleContent.length < 8) return undefined

  // Scope detection
  const lowerRule = ruleContent.toLowerCase()
  let scope: DirectiveCandidate['scope'] = 'user_preference'

  if (/\b(?:lint|oxlint|tsc|test|build|clean|newline|trailing|gate|typecheck|format|schemastery|cordis|patch)\b/.test(lowerRule)) {
    scope = 'project'
  } else if (/\b(?:git|branch|commit|push|merge|pr|pull\s+request|rebase|master|main|development)\b/.test(lowerRule)) {
    scope = 'workflow'
  }

  return {
    rule: ruleContent,
    scope,
  }
}

/**
 * Checks whether a candidate rule is already recorded in the active rules list.
 *
 * @param existingRules - Current list of active rules from vector DB.
 * @param candidate - Candidate rule text.
 * @returns True if candidate is duplicate or functionally identical.
 */
export function isDuplicateRule(existingRules: MemoryItem[], candidate: string): boolean {
  const normCandidate = normalizeRuleText(candidate)
  for (const existing of existingRules) {
    const raw = typeof existing.metadata?.rawRule === 'string'
      ? existing.metadata.rawRule
      : existing.content
    const normExisting = normalizeRuleText(raw)
    if (normExisting === normCandidate) {
      return true
    }
    // High substring containment check
    if (normExisting.length > 15 && normCandidate.length > 15) {
      if (normExisting.includes(normCandidate) || normCandidate.includes(normExisting)) {
        return true
      }
    }
  }
  return false
}

/**
 * Evaluates user input text and autonomously persists explicit directives if detected and not duplicate.
 *
 * @param service - MultimodalEmbedService instance.
 * @param text - User message text.
 * @param logger - Optional logger for operational observability.
 * @returns Settlement details of auto-capture operation.
 */
export async function autoSniffAndSaveDirective(
  service: MultimodalEmbedService,
  text: string,
  logger?: DirectiveSnifferLogger,
): Promise<{ saved: boolean; rule?: string; scope?: string }> {
  const candidate = extractDirectiveCandidate(text)
  if (!candidate) {
    return { saved: false }
  }

  try {
    const existingRules = await service.getEntriesByCategory('rule', 50)
    if (isDuplicateRule(existingRules, candidate.rule)) {
      logger?.debug?.(`multimodal-embed: skipped duplicate rule: "${candidate.rule}"`)
      return { saved: false, rule: candidate.rule, scope: candidate.scope }
    }

    const content = `[${candidate.scope.toUpperCase()}] ${candidate.rule}`
    await service.saveEntry('rule', content, {
      scope: candidate.scope,
      rawRule: candidate.rule,
      autoCaptured: true,
      capturedAt: Date.now(),
    })

    logger?.info(`multimodal-embed: auto-captured project rule: [${candidate.scope}] "${candidate.rule}"`)
    return { saved: true, rule: candidate.rule, scope: candidate.scope }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger?.warn(`multimodal-embed: failed to auto-capture directive: ${msg}`)
    return { saved: false }
  }
}

export interface RevocationCandidate {
  readonly query: string
  readonly category?: 'rule' | 'lesson' | undefined
}

/**
 * Extracts a candidate revocation/deletion request from user input text.
 *
 * @param text - Raw message text from user.
 * @returns Extracted revocation query and category, or undefined if no revocation pattern matched.
 */
export function extractRevocationCandidate(text: string): RevocationCandidate | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 5 || trimmed.length > 300) return undefined
  if (trimmed.endsWith('?')) return undefined

  // Match Indonesian revocation
  const idRegex = new RegExp(
    '^(?:tolong\\s+|mohon\\s+)?(?:hapus|lupakan|cabut|batalkan)\\s+(?:semua\\s+)?' +
    '(?:aturan|ingatan|rule|lesson|memori)?\\s*(?:tentang|mengenai|soal)?\\s*[:"\' ]?([^"\'\\n]+)["\']?$',
    'i',
  )
  const matchId = idRegex.exec(trimmed)
  if (matchId && matchId[1]) {
    const rawTarget = matchId[1].trim()
    const isRule = /aturan|rule/i.test(trimmed)
    const isLesson = /ingatan|pelajaran|lesson/i.test(trimmed)
    return {
      query: rawTarget,
      category: isRule ? 'rule' : isLesson ? 'lesson' : undefined,
    }
  }

  // Match English revocation
  const enRegex = new RegExp(
    '^(?:please\\s+)?(?:delete|forget|revoke|remove|cancel)\\s+(?:the\\s+)?' +
    '(?:rule|lesson|memory)?\\s*(?:about|regarding)?\\s*[:"\' ]?([^"\'\\n]+)["\']?$',
    'i',
  )
  const matchEn = enRegex.exec(trimmed)
  if (matchEn && matchEn[1]) {
    const rawTarget = matchEn[1].trim()
    const isRule = /rule/i.test(trimmed)
    const isLesson = /lesson|memory/i.test(trimmed)
    return {
      query: rawTarget,
      category: isRule ? 'rule' : isLesson ? 'lesson' : undefined,
    }
  }

  return undefined
}

/**
 * Evaluates user input text and autonomously deletes matching rules/memories when a revocation directive is detected.
 *
 * @param service - MultimodalEmbedService instance.
 * @param text - User message text.
 * @param logger - Optional logger for operational observability.
 * @returns Settlement details of auto-revoke operation.
 */
export async function autoSniffAndRevokeDirective(
  service: MultimodalEmbedService,
  text: string,
  logger?: DirectiveSnifferLogger,
): Promise<{ revoked: boolean; deletedCount: number; query?: string }> {
  const candidate = extractRevocationCandidate(text)
  if (!candidate) return { revoked: false, deletedCount: 0 }

  try {
    const res = await service.deleteEntriesByQuery(candidate.query, candidate.category)
    if (res.deletedCount > 0) {
      logger?.info(`multimodal-embed: auto-revoked ${res.deletedCount} memories matching "${candidate.query}"`)
      return { revoked: true, deletedCount: res.deletedCount, query: candidate.query }
    }
    return { revoked: false, deletedCount: 0, query: candidate.query }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger?.warn(`multimodal-embed: failed to auto-revoke directive: ${msg}`)
    return { revoked: false, deletedCount: 0 }
  }
}
