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

export const WELL_KNOWN_PACK_DESCRIPTIONS: Record<string, string> = {
  core: 'Fundamental baseline operations (memory, user questions, tool activation)',
  dev: 'Software development, filesystem operations (read/write/edit), terminal bash, and LSP diagnostics',
  web: 'Internet research, web search, web page fetching, and online documentation',
  team: 'Subagent orchestration, parallel agent delegation, and inter-agent communication',
  goal: 'Long-running session goals, objectives, and progress tracking',
  plan: 'Plan mode review and presentation tools',
}

export interface DetailedPackResolution<T> {
  readonly admittedTools: T[]
  readonly activePackIds: ReadonlySet<string>
  readonly dormantPackIds: ReadonlySet<string>
  readonly clusters: Map<string, T[]>
  readonly guidancePrompt: string
}

// Default base domain packs for standard harness tools
const BASE_CORE_TOOLS = [
  'manage_memory',
  'search_memory',
  'save_rule',
  'save_lesson',
  'activate_tool',
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
  'skill',
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

const BASE_GOAL_TOOLS = [
  'create_goal',
  'update_goal',
  'get_goal',
]

const BASE_PLAN_TOOLS = [
  'exit_plan_mode',
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
    this.registerPack('goal', BASE_GOAL_TOOLS)
    this.registerPack('plan', BASE_PLAN_TOOLS)

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
   * Generates a concise, deterministic system prompt section guiding the LLM on tool packs,
   * active vs dormant domains, and how to activate dormant tools via `activate_tool`.
   *
   * @param activePackIds The set of pack IDs currently active.
   * @param clusters All clusters of tools across packs.
   * @returns Formatted markdown prose guidance for the system prompt.
   */
  generatePackGuidance<T extends { name: string }>(
    activePackIds: ReadonlySet<string>,
    clusters: Map<string, T[]>,
  ): string {
    const activeList: string[] = []
    const dormantList: string[] = []

    // Sorted list of all known pack IDs
    const allPackIds = Array.from(clusters.keys()).sort((a, b) => {
      const priority: Record<string, number> = { core: 0, dev: 1, web: 2, team: 3, goal: 4 }
      const pa = priority[a] ?? 10
      const pb = priority[b] ?? 10
      if (pa !== pb) return pa - pb
      return a.localeCompare(b)
    })

    for (const packId of allPackIds) {
      const tools = clusters.get(packId) ?? []
      const toolNames = tools.map(t => t.name)
      const sampleToolsStr = toolNames.length <= 4
        ? toolNames.map(n => `\`${n}\``).join(', ')
        : `${toolNames.slice(0, 3).map(n => `\`${n}\``).join(', ')}, +${toolNames.length - 3} more`

      let desc = WELL_KNOWN_PACK_DESCRIPTIONS[packId]
      if (!desc) {
        if (packId.startsWith('mcp:')) {
          desc = `Specialized external tools from MCP server '${packId.slice(4)}'`
        } else if (packId.startsWith('plugin:')) {
          desc = `Plugin tools for namespace '${packId.slice(7)}'`
        } else {
          desc = `Domain capability pack '${packId}'`
        }
      }

      if (activePackIds.has(packId)) {
        activeList.push(`- **\`${packId}\`** (Active - ${sampleToolsStr}): ${desc}`)
      } else {
        dormantList.push(`- **\`${packId}\`** (${sampleToolsStr}): ${desc}`)
      }
    }

    const lines: string[] = [
      '## Tool Domain Packs & Capability Guidance',
      'Available tools are organized into domain packs to maintain focus and stability:',
      '### Active Packs (Ready to use in this turn):',
      ...(activeList.length > 0 ? activeList : ['- *(None)*']),
    ]

    if (dormantList.length > 0) {
      lines.push(
        '',
        '### Dormant Packs (Available on-demand):',
        ...dormantList,
        '',
        '> **Decision Guidance:** If your task requires tools from a dormant pack (e.g. web search or subagents), call `activate_tool({ tools: ["<tool_name>"] })` or clearly express your intent. The capability router will automatically activate the relevant pack for subsequent turns.',
      )
    }

    return lines.join('\n')
  }

  /**
   * Detailed resolution returning both admitted tools and LLM guidance text.
   * Admitting any tool within a pack admits the ENTIRE pack in deterministic order, preserving prefix cache.
   *
   * @param allTools All registered tools in assembly.
   * @param qualifyingToolNames Tool names that crossed admission threshold or were explicitly activated.
   * @param matchedDomains Domains flagged by high-precision heuristics (e.g., 'dev', 'web').
   * @returns Detailed resolution including admitted tools, active and dormant pack IDs, and guidance prompt.
   */
  resolveAdmittedToolsDetailed<T extends { name: string }>(
    allTools: readonly T[],
    qualifyingToolNames: ReadonlySet<string>,
    matchedDomains: ReadonlySet<string>,
  ): DetailedPackResolution<T> {
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

    // Determine dormant pack IDs
    const dormantPackIds = new Set<string>()
    for (const packId of clusters.keys()) {
      if (!activePackIds.has(packId)) {
        dormantPackIds.add(packId)
      }
    }

    // Collect tools from all active packs
    const admitted: T[] = []
    const seen = new Set<string>()

    // Maintain deterministic pack order: core -> dev -> web -> team -> dynamic MCP/plugins -> misc
    const sortedPackIds = Array.from(activePackIds).sort((a, b) => {
      const priority: Record<string, number> = { core: 0, dev: 1, web: 2, team: 3, goal: 4, plan: 5 }
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

    const guidancePrompt = this.generatePackGuidance(activePackIds, clusters)

    return {
      admittedTools: admitted,
      activePackIds,
      dormantPackIds,
      clusters,
      guidancePrompt,
    }
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
    return this.resolveAdmittedToolsDetailed(allTools, qualifyingToolNames, matchedDomains).admittedTools
  }
}
