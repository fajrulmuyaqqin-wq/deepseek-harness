/**
 * The Codex subagent page's staged form over the `subagent-codex` settings
 * namespace.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormShell,
  type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the Codex provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const CODEX_NS = 'subagent-codex'

/** The codex fields this page edits. */
export interface CodexSettings {
  /** Path to the Unix domain socket. */
  socketPath?: string
  /** Host for TCP socket connection. */
  socketHost?: string
  /** Port for TCP socket connection. */
  socketPort?: number
  /** Non-interactive permission mode. */
  permissionMode?: 'never' | 'approve-for-me' | 'dangerously-bypass-approvals-and-sandbox'
  /** Specific model override. */
  model?: string
  /** Custom engine binary path. */
  binaryPath?: string
}

/** What the codex settings page renders. */
export interface CodexCardState extends SettingsFormShell {
  socketPath: SettingsFieldState
  socketHost: SettingsFieldState
  socketPort: SettingsFieldState
  permissionMode: SettingsFieldState
  model: SettingsFieldState
  binaryPath: SettingsFieldState
}

/** The registration-side face the codex page's slot entry injects. */
export interface CodexCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useCodexCard. */
    codexCard: SnapshotStore<CodexCardState>
  }
}

/** Bridges the `subagent-codex` scope onto the settings page. */
export class CodexCardController {
  private readonly form: SettingsFormModel<CodexSettings>
  private readonly store: SnapshotStore<CodexCardState>

  constructor(
    scope: SettingsFormScope<CodexSettings>,
  ) {
    this.form = new SettingsFormModel(
      scope,
      [
        settingsTextField('socketPath'),
        settingsTextField('socketHost'),
        settingsNumberField('socketPort'),
        settingsTextField('permissionMode'),
        settingsTextField('model'),
        settingsTextField('binaryPath'),
      ],
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CodexCardState {
    return {
      ...this.form.shell(),
      socketPath: this.form.field('socketPath'),
      socketHost: this.form.field('socketHost'),
      socketPort: this.form.field('socketPort'),
      permissionMode: this.form.field('permissionMode'),
      model: this.form.field('model'),
      binaryPath: this.form.field('binaryPath'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): CodexCardFace {
    return {
      hooks: {
        codexCard: this.store,
      },
      ...this.form.actions(),
    }
  }

  dispose(): void {
    this.form.dispose()
  }
}
