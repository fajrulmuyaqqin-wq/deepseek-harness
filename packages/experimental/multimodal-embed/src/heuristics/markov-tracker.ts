/**
 * Markov Tool Transition Tracker.
 * Models temporal workflow continuity by boosting tools that empirically
 * follow recent tool invocations (e.g., edit -> bash, bash -> read/grep).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/heuristics/markov-tracker
 */

export interface MarkovTransitionRule {
  readonly triggerTools: readonly string[]
  readonly followUpBoosts: Readonly<Record<string, number>>
}

// Empirical transition rules from typical agentic workflows
const DEFAULT_TRANSITIONS: readonly MarkovTransitionRule[] = [
  // 1. After code modifications, test execution or diagnostics are expected
  {
    triggerTools: ['edit', 'write'],
    followUpBoosts: {
      bash: 0.35,
      read: 0.20,
      glob: 0.15,
      grep: 0.15,
    },
  },
  // 2. After bash command execution, inspecting logs or reading files is expected
  {
    triggerTools: ['bash'],
    followUpBoosts: {
      read: 0.25,
      grep: 0.25,
      edit: 0.20,
      bash: 0.20,
      job_output: 0.30,
    },
  },
  // 3. After searching or locating files, inspection or modification follows
  {
    triggerTools: ['glob', 'grep'],
    followUpBoosts: {
      read: 0.30,
      edit: 0.25,
      grep: 0.20,
    },
  },
  // 4. After memory retrieval, storing new findings or rules follows
  {
    triggerTools: ['search_memory'],
    followUpBoosts: {
      save_rule: 0.30,
      save_lesson: 0.30,
      manage_memory: 0.30,
    },
  },
  // 5. After delegation to subagents, communication or status checks follow
  {
    triggerTools: ['subagent', 'subagent_fork', 'spawn_teammate'],
    followUpBoosts: {
      send_message: 0.30,
      team_task_list: 0.25,
      team_task_update: 0.25,
    },
  },
]

interface SessionMarkovState {
  readonly activeBoosts: Map<string, number>
  turnCount: number
}

/**
 * Manages Markov tool transition state across turns per session.
 */
export class MarkovTransitionTracker {
  private readonly states = new Map<string, SessionMarkovState>()

  /**
   * Records tools executed in the finished turn and calculates transition boosts for the next turn.
   *
   * @param sessionId The unique ID of the session.
   * @param executedTools The set of tools executed during the turn.
   * @param globalWeight Global multiplier for Markov bias (default: 1.0).
   */
  recordTurnEnd(sessionId: string, executedTools: ReadonlySet<string>, globalWeight = 1.0): void {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { activeBoosts: new Map(), turnCount: 0 }
      this.states.set(sessionId, state)
    }

    state.turnCount++

    // 1. Decay existing boosts by 50%
    for (const [tool, score] of state.activeBoosts.entries()) {
      const decayed = score * 0.5
      if (decayed < 0.05) {
        state.activeBoosts.delete(tool)
      } else {
        state.activeBoosts.set(tool, decayed)
      }
    }

    // 2. Apply new transition rules for executed tools
    for (const rule of DEFAULT_TRANSITIONS) {
      const matches = rule.triggerTools.some(t => executedTools.has(t))
      if (matches) {
        for (const [targetTool, boost] of Object.entries(rule.followUpBoosts)) {
          const weightedBoost = boost * globalWeight
          const current = state.activeBoosts.get(targetTool) ?? 0
          // Keep maximum rather than summing uncapped
          state.activeBoosts.set(targetTool, Math.max(current, weightedBoost))
        }
      }
    }
  }

  /**
   * Retrieves the current Markov transition boosts for a given session.
   *
   * @param sessionId The unique ID of the session.
   * @returns Readonly map of tool names to Markov boost amounts.
   */
  getBoosts(sessionId: string): ReadonlyMap<string, number> {
    const state = this.states.get(sessionId)
    return state?.activeBoosts ?? new Map()
  }

  /**
   * Clears state for a closed session to prevent memory leaks.
   */
  clearSession(sessionId: string): void {
    this.states.delete(sessionId)
  }
}
