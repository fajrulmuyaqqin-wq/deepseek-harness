import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { CodexCardFace } from './codex-card-controller.ts'
import css from './CodexCard.module.css'

/** Props the renderer binds for the codex settings page. */
export type CodexCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.codex'>
  & InjectFace<CodexCardFace>

/**
 * Render the codex subagent one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function CodexCard(props: CodexCardProps) {
  const { t } = props
  const [showAdvanced, setShowAdvanced] = useState(false)
  const state = props.useCodexCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.banner}>
        <span className={css.indicator} />
        <div className={css.bannerContent}>
          <span className={css.bannerTitle}>{t('engineStatusTitle')}</span>
          <span className={css.bannerDesc}>{t('engineStatusDesc')}</span>
        </div>
      </div>

      <SettingsValueField
        id="plugin-config-codex-model"
        label={t('model')}
        hint={t('modelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.model}
        onEdit={(text) => { props.edit('model', text) }}
        onReset={() => { props.resetField('model') }}
      />
      <SettingsValueField
        id="plugin-config-codex-permission-mode"
        label={t('permissionMode')}
        hint={t('permissionModeHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalid')}
        disabled={disabled}
        {...state.permissionMode}
        onEdit={(text) => { props.edit('permissionMode', text) }}
        onReset={() => { props.resetField('permissionMode') }}
      />

      <div className={css.toggleContainer}>
        <button
          type="button"
          className={css.toggleButton}
          onClick={() => setShowAdvanced(prev => !prev)}
        >
          {showAdvanced ? t('hideAdvanced') : t('showAdvanced')}
        </button>
      </div>

      {showAdvanced && (
        <div className={css.advancedSection}>
          <SettingsValueField
            id="plugin-config-codex-socket-path"
            label={t('socketPath')}
            hint={t('socketPathHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            disabled={disabled}
            {...state.socketPath}
            onEdit={(text) => { props.edit('socketPath', text) }}
            onReset={() => { props.resetField('socketPath') }}
          />
          <SettingsValueField
            id="plugin-config-codex-socket-host"
            label={t('socketHost')}
            hint={t('socketHostHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            disabled={disabled}
            {...state.socketHost}
            onEdit={(text) => { props.edit('socketHost', text) }}
            onReset={() => { props.resetField('socketHost') }}
          />
          <SettingsValueField
            id="plugin-config-codex-socket-port"
            label={t('socketPort')}
            hint={t('socketPortHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            numeric
            disabled={disabled}
            {...state.socketPort}
            onEdit={(text) => { props.edit('socketPort', text) }}
            onReset={() => { props.resetField('socketPort') }}
          />
          <SettingsValueField
            id="plugin-config-codex-binary-path"
            label={t('binaryPath')}
            hint={t('binaryPathHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            disabled={disabled}
            {...state.binaryPath}
            onEdit={(text) => { props.edit('binaryPath', text) }}
            onReset={() => { props.resetField('binaryPath') }}
          />
        </div>
      )}
    </SettingsForm>
  )
}
