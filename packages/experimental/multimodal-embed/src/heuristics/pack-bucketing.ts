/**
 * Dynamic Tool Domain Pack Bucketing Engine (Cache Shielding).
 * Dynamically clusters tools into domain packs (both well-known and auto-discovered
 * MCP/plugin namespaces) so pruning happens at the pack level, shielding the
 * LLM Prompt Prefix KV-Cache from flapping across turns.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/heuristics/pack-bucketing
 */

export interface PackDefinition {
  readonly id: string
  readonly name: string
  readonly tools: ReadonlySet<string>
  readonly isAlwaysActive?: boolean
}

// Default base domain packs for standard harness tools
const BASE_CORE_TOOLS = [
  'manage_memory',
  'search_memory',
  'save_rule',
  'save_lesson',
  'activate_tool',
  'create_goal',
  'update_goal',
  'get_goal',
  'job_list',
  'job_output',
  'ask_user_question',
]

const BASE_DEV_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'lsp',
  'todo_write',
  'present',
]

const BASE_WEB_TOOLS = [
  'web_search',
  'web_fetch',
  'read_mcp_resource',
  'list_mcp_resources',
  'list_mcp_resource_templates',
]

const BASE_TEAM_TOOLS = [
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'team_task_create',
  'team_task_list',
  'team_task_update',
  'team_task_get',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'workflow',
]

/**
 * Engine that dynamically discovers, groups, and resolves tool domain packs.
 */
export class DynamicPackBucketingEngine {
  private readonly staticPackMap = new Map<string, Set<string>>()
  private readonly toolToPackMap = new Map<string, string>()

  constructor(
    userCustomPacks: Record<string, string[]> = {},
    additionalCoreTools: readonly string[] = [],
  ) {
    // 1. Initialize well-known base packs
    this.registerPack('core', [...BASE_CORE_TOOLS, ...additionalCoreTools])
    this.registerPack('dev', BASE_DEV_TOOLS)
    this.registerPack('web', BASE_WEB_TOOLS)
    this.registerPack('team', BASE_TEAM_TOOLS)

    // 2. Overlay user-configured packs
    for (const [packId, toolList] of Object.entries(userCustomPacks)) {
      this.registerPack(packId, toolList)
    }
  }

  private registerPack(packId: string, tools: readonly string[]): void {
    let pack = this.staticPackMap.get(packId)
    if (!pack) {
      pack = new Set<string>()
      this.staticPackMap.set(packId, pack)
    }
    for (const t of tools) {
      pack.add(t)
      this.toolToPackMap.set(t, packId)
    }
  }

  /**
   * Dynamically resolves the pack ID for a tool name.
   * If not statically mapped, auto-clusters by namespace (e.g., mcp__<server>__* or <plugin>__*).
   *
   * @param toolName The name of the tool.
   * @returns The resolved or dynamically synthesized pack ID.
   */
  resolvePackId(toolName: string): string {
    const existing = this.toolToPackMap.get(toolName)
    if (existing) {
      return existing
    }

    // Dynamic discovery: detect MCP server namespace (e.g., mcp__blender__generate_3d -> mcp:blender)
    const mcpMatch = toolName.match(/^mcp__([a-z0-9_-]+?)__/i)
    if (mcpMatch && mcpMatch[1]) {
      const dynamicPackId = `mcp:${mcpMatch[1]}`
      this.registerPack(dynamicPackId, [toolName])
      return dynamicPackId
    }

    // Dynamic discovery: detect plugin namespace (e.g., plugin__sql__query -> plugin:sql)
    const pluginMatch = toolName.match(/^plugin__([a-z0-9_-]+?)__/i)
    if (pluginMatch && pluginMatch[1]) {
      const dynamicPackId = `plugin:${pluginMatch[1]}`
      this.registerPack(dynamicPackId, [toolName])
      return dynamicPackId
    }

    // Dynamic discovery: detect generic double-underscore prefix namespace
    const genericMatch = toolName.match(/^([a-z0-9_-]+?)__/i)
    if (genericMatch && genericMatch[1]) {
      const dynamicPackId = `plugin:${genericMatch[1]}`
      this.registerPack(dynamicPackId, [toolName])
      return dynamicPackId
    }

    // Fallback: assign to isolated singleton pack so distinct tools don't drag each other
    const soloPackId = `solo:${toolName}`
    this.registerPack(soloPackId, [toolName])
    return soloPackId
  }

  /**
   * Clusters a list of tools into their respective dynamic packs.
   *
   * @param tools List of tool schemas with a `name` property.
   * @returns Map of packId to the tools belonging to that pack.
   */
  clusterTools<T extends { name: string }>(tools: readonly T[]): Map<string, T[]> {
    const clusters = new Map<string, T[]>()

    for (const tool of tools) {
      const packId = this.resolvePackId(tool.name)
      let list = clusters.get(packId)
      if (!list) {
        list = []
        clusters.set(packId, list)
      }
      list.push(tool)
    }

    return clusters
  }

  /**
   * Resolves which tool packs should be activated given scored/candidate tools and active domains.
   * Admitting any tool within a pack admits the ENTIRE pack in deterministic order, preserving prefix cache.
   *
   * @param allTools All registered tools in assembly.
   * @param qualifyingToolNames Tool names that crossed admission threshold or were explicitly activated.
   * @param matchedDomains Domains flagged by high-precision heuristics (e.g., 'dev', 'web').
   * @returns Array of tool schemas from all admitted packs, deterministically sorted.
   */
  resolveAdmittedTools<T extends { name: string }>(
    allTools: readonly T[],
    qualifyingToolNames: ReadonlySet<string>,
    matchedDomains: ReadonlySet<string>,
  ): T[] {
    const clusters = this.clusterTools(allTools)
    const activePackIds = new Set<string>()

    // Core pack is always active
    activePackIds.add('core')

    // Activate packs matching heuristic domains
    for (const domain of matchedDomains) {
      if (clusters.has(domain)) {
        activePackIds.add(domain)
      }
    }

    // Activate packs containing any qualifying tool
    for (const toolName of qualifyingToolNames) {
      const packId = this.resolvePackId(toolName)
      activePackIds.add(packId)
    }

    // Collect tools from all active packs
    const admitted: T[] = []
    const seen = new Set<string>()

    // Maintain deterministic pack order: core -> dev -> web -> team -> dynamic MCP/plugins -> misc
    const sortedPackIds = Array.from(activePackIds).sort((a, b) => {
      const priority: Record<string, number> = { core: 0, dev: 1, web: 2, team: 3 }
      const pa = priority[a] ?? 10
      const pb = priority[b] ?? 10
      if (pa !== pb) return pa - pb
      return a.localeCompare(b)
    })

    for (const packId of sortedPackIds) {
      const packTools = clusters.get(packId) ?? []
      // Sort tools alphabetically within pack to guarantee prefix token stability
      const sortedTools = [...packTools].sort((a, b) => a.name.localeCompare(b.name))
      for (const tool of sortedTools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name)
          admitted.push(tool)
        }
      }
    }

    return admitted
  }
}
