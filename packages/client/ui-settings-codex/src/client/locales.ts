/** Locale bundles for the Codex subagent settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type CodexSettingsLocaleKey =
  | 'title' | 'description'
  | 'socketPath' | 'socketPathHint'
  | 'socketHost' | 'socketHostHint'
  | 'socketPort' | 'socketPortHint'
  | 'permissionMode' | 'permissionModeHint'
  | 'model' | 'modelHint'
  | 'binaryPath' | 'binaryPathHint'
  | 'engineStatusTitle' | 'engineStatusDesc'
  | 'showAdvanced' | 'hideAdvanced'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber' | 'invalid'

/** English copy. */
export const en: Record<CodexSettingsLocaleKey, string> = {
  title: 'Codex Subagent',
  description: 'Configure the OpenAI Codex engine subagent provider and socket connection.',
  engineStatusTitle: 'Built-in Engine Active (Auto-Start)',
  engineStatusDesc: 'The bundled Codex engine runs automatically in the background. No manual socket or port configuration is needed for standard use.',
  showAdvanced: 'Show Advanced / Network Settings ▼',
  hideAdvanced: 'Hide Advanced Settings ▲',
  socketPath: 'Unix Domain Socket Path',
  socketPathHint: 'Path to the codex daemon socket (e.g. /tmp/codex-engine.sock). Leave empty if connecting via TCP.',
  socketHost: 'TCP Host',
  socketHostHint: 'Remote or local TCP host (e.g. 127.0.0.1). Used when socket path is empty.',
  socketPort: 'TCP Port',
  socketPortHint: 'TCP port of the codex daemon (e.g. 4500).',
  permissionMode: 'Permission Mode',
  permissionModeHint: 'Execution permission mode: never, approve-for-me, or dangerously-bypass-approvals-and-sandbox.',
  model: 'Model Override',
  modelHint: 'Specific model to pass to Codex. Leave empty to use the daemon default.',
  binaryPath: 'Engine Binary Path',
  binaryPathHint: 'Custom path to the codex binary. Leave empty to use the built-in bundled binary.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a valid number, or leave blank.',
  invalid: 'Invalid value.',
}

/** Simplified Chinese copy. */
export const zh: Record<CodexSettingsLocaleKey, string> = {
  title: 'Codex 子智能体',
  description: '配置 OpenAI Codex 引擎子智能体提供方及 Socket 连接。',
  engineStatusTitle: '内置引擎已就绪（自动启动）',
  engineStatusDesc: '内置的 Codex 引擎将在后台全自动按需启动，常规使用无需手动配置 Socket 或端口。',
  showAdvanced: '展开高级与网络配置 ▼',
  hideAdvanced: '收起高级配置 ▲',
  socketPath: 'Unix 域 Socket 路径',
  socketPathHint: 'Codex 守护进程 socket 路径（如 /tmp/codex-engine.sock）。使用 TCP 连接时可留空。',
  socketHost: 'TCP 主机地址',
  socketHostHint: '远程或本地 TCP 主机（如 127.0.0.1）。在 socket 路径为空时生效。',
  socketPort: 'TCP 端口',
  socketPortHint: 'Codex 守护进程的 TCP 端口（如 4500）。',
  permissionMode: '权限模式',
  permissionModeHint: '执行权限模式：never、approve-for-me 或 dangerously-bypass-approvals-and-sandbox。',
  model: '指定模型',
  modelHint: '传递给 Codex 的具体模型。留空表示使用守护进程默认设置。',
  binaryPath: '引擎二进制路径',
  binaryPathHint: '自定义 Codex 二进制文件路径。留空则自动使用内置打包的二进制。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填入有效数字，或留空。',
  invalid: '无效的值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: CodexSettingsLocaleKey) => string): SettingsFormLabels {
  return {
    save: t('save'),
    saving: t('saving'),
    saveFailed: t('saveFailed'),
    readOnly: t('readOnly'),
    unavailable: t('unavailable'),
  }
}
