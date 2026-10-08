/**
 * Zero-Latency Lexical & Heuristic Intent Matcher.
 * Detects deterministic CLI, filesystem, web, memory, media, and orchestration cues
 * to provide high-precision score boosts (Δ_heur) without neural inference overhead.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/heuristics/intent-matcher
 */

export interface IntentMatchResult {
  readonly boosts: ReadonlyMap<string, number>
  readonly matchedDomains: ReadonlySet<string>
}

// Pre-compiled fast lexical regex matchers
const CLI_PATTERN = new RegExp(
  [
    '\\b(git|pnpm|npm|yarn|cargo|make|bash|curl|docker|cat|chmod|chown|node|python|kill|ps|grep|ls|find)\\b',
    '```(?:bash|sh|zsh|shell)',
    '--[a-z0-9-]+',
    '\\b(?:jalankan|eksekusi|perintah|terminal|command|run)\\b',
  ].join('|'),
  'i',
)

const FS_PATTERN = new RegExp(
  [
    '(?:[\\w.-]+[/\\\\][\\w.-]+\\.(?:ts|js|json|md|py|rs|yml|yaml|css|html|txt)\\b)',
    '\\b(?:baca file|edit file|buat file|tulis file|baca berkas|struktur direktori|folder|path)\\b',
  ].join('|'),
  'i',
)

const WEB_PATTERN = /https?:\/\/[^\s]+|\b(?:browsing|cari di web|search web|fetch url|unduh|download url|situs|halaman web)\b/i
const MEMORY_PATTERN = /\b(?:ingat|aturan|catat ke memori|lupakan|hapus aturan|hapus memori|save rule|save lesson|ingatan|preferensi)\b/i
const MEDIA_3D_PATTERN = /\b(?:blender|3d|render|mesh|obj|fbx|gltf|tekstur|scene 3d)\b|\.(?:blend|png|jpe?g|webp|wav|mp3)\b/i
const TEAM_PATTERN = /\b(?:subagent|sub-agent|delegasikan|delegasi|spawn teammate|rekan satu tim|task tim|tim bersama|koordinasi)\b/i

/**
 * Extracts lexical cues and produces deterministic score boosts for tool candidates.
 *
 * @param text The incoming user intent or prompt text.
 * @param defaultBoost The score boost to apply for matched tool categories (default: 0.40).
 * @returns Map of tool name to boost amount, and the set of matched domain keys.
 */
export function extractLexicalBoosts(text: string, defaultBoost = 0.40): IntentMatchResult {
  const boosts = new Map<string, number>()
  const matchedDomains = new Set<string>()

  if (!text || text.trim().length === 0) {
    return { boosts, matchedDomains }
  }

  // 1. CLI & Terminal Domain
  if (CLI_PATTERN.test(text)) {
    matchedDomains.add('dev')
    boosts.set('bash', defaultBoost)
    boosts.set('job_list', defaultBoost * 0.5)
    boosts.set('job_output', defaultBoost * 0.5)
  }

  // 2. Filesystem & Code Domain
  if (FS_PATTERN.test(text)) {
    matchedDomains.add('dev')
    boosts.set('read', defaultBoost)
    boosts.set('write', defaultBoost)
    boosts.set('edit', defaultBoost)
    boosts.set('glob', defaultBoost)
    boosts.set('grep', defaultBoost)
    boosts.set('lsp', defaultBoost * 0.8)
  }

  // 3. Web & Network Domain
  if (WEB_PATTERN.test(text)) {
    matchedDomains.add('web')
    boosts.set('web_search', defaultBoost)
    boosts.set('web_fetch', defaultBoost)
    boosts.set('read_mcp_resource', defaultBoost * 0.5)
    boosts.set('list_mcp_resources', defaultBoost * 0.5)
  }

  // 4. Memory & Directives Domain
  if (MEMORY_PATTERN.test(text)) {
    matchedDomains.add('core')
    boosts.set('manage_memory', defaultBoost)
    boosts.set('save_rule', defaultBoost)
    boosts.set('save_lesson', defaultBoost)
    boosts.set('search_memory', defaultBoost)
  }

  // 5. Media & 3D (Blender) Domain
  if (MEDIA_3D_PATTERN.test(text)) {
    matchedDomains.add('media_3d')
    boosts.set('inspect_multimodal', defaultBoost)
    boosts.set('read_image', defaultBoost)
  }

  // 6. Team & Subagent Orchestration Domain
  if (TEAM_PATTERN.test(text)) {
    matchedDomains.add('team')
    boosts.set('subagent', defaultBoost)
    boosts.set('subagent_fork', defaultBoost)
    boosts.set('spawn_teammate', defaultBoost)
    boosts.set('send_message', defaultBoost)
    boosts.set('team_task_create', defaultBoost)
    boosts.set('team_task_list', defaultBoost)
  }

  return { boosts, matchedDomains }
}
