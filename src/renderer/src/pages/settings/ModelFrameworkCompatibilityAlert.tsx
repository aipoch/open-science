import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'

import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { isModelBridgeSupported } from '../../../../shared/provider-registry'
import { incompatibilityReason } from '../workspace/composer-model-picker-utils'

// Settings-time compatibility guard for the Model panel. The active provider must be able to drive the
// selected agent framework (endpoint + provider-type). When the current pair is incompatible, this
// surfaces the same mismatch the spawn path would otherwise raise only when a conversation fails to
// start — so the user can fix it here (switch model or framework) instead of discovering it mid-chat.
// Renders nothing while the pair is compatible or no provider is
// active.
const ModelFrameworkCompatibilityAlert = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  // incompatibilityReason's copy is shared with the composer picker, so it lives in `common`.
  const { t: tCommon } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)

  const active = providers.find((provider) => provider.id === activeProviderId)
  if (!active) return null

  const compatible = isProviderUsableByFramework(
    { apiEndpoints: active.apiEndpoints, type: active.type },
    { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
  )
  const modelUnsupportedByBridge =
    agentFrameworkId === 'codex' && !isModelBridgeSupported(active, activeModel)
  if (compatible && !modelUnsupportedByBridge) return null

  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    agentFrameworkId
  const reason = modelUnsupportedByBridge
    ? t(
        'This model is not supported over the Codex Chat Completions bridge. Pick another model for a Codex session.'
      )
    : incompatibilityReason(
        { apiEndpoints: active.apiEndpoints, type: active.type, name: active.name },
        frameworkName,
        frameworkEndpoints,
        tCommon
      )

  return (
    <ErrorNotice
      role="alert"
      tone="amber"
      title={modelUnsupportedByBridge
        ? t('Model not supported over the Codex bridge')
        : t("Main model isn't compatible with {{framework}}", { framework: frameworkName })}
      description={`${reason} ${!modelUnsupportedByBridge ? t("Pick a compatible model below, or switch the agent framework above — otherwise conversations on this framework won't start.") : ''}`.trim()}
    />
  )
}

export { ModelFrameworkCompatibilityAlert }
