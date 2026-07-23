import { AlertTriangle } from 'lucide-react'

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
    ? 'This model is not supported over the Codex Chat Completions bridge. Pick another model for a Codex session.'
    : incompatibilityReason(
        { apiEndpoints: active.apiEndpoints, type: active.type, name: active.name },
        frameworkName,
        frameworkEndpoints
      )

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="font-medium">
          {modelUnsupportedByBridge
            ? 'Model not supported over the Codex bridge'
            : `Active model isn't compatible with ${frameworkName}`}
        </p>
        <p className="text-amber-700/90 dark:text-amber-400/80">
          {reason}{' '}
          {!modelUnsupportedByBridge
            ? "Pick a compatible model below, or switch the agent framework above — otherwise conversations on this framework won't start."
            : null}
        </p>
      </div>
    </div>
  )
}

export { ModelFrameworkCompatibilityAlert }
