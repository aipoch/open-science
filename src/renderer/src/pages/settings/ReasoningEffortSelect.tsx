import { useTranslation } from 'react-i18next'

import { useSettingsStore } from '@/stores/settings-store'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../../../shared/provider-reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'

// Segmented effort selector: the highlight block slides to the picked level. Fixed-width segments
// keep the thumb math exact. Mirrored on ToolPermissionControl's radiogroup pattern. The new level
// applies to open sessions live where the framework allows it (Claude Code, Codex), otherwise on
// the next reconnect (opencode).
const ReasoningEffortSelect = (): React.JSX.Element => {
  const { t } = useTranslation()
  const reasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const setReasoningEffort = useSettingsStore((state) => state.setReasoningEffort)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const providers = useSettingsStore((state) => state.providers)
  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
  const effectiveModel = resolveProviderEffectiveModel(activeProvider, activeModel)
  const profile = resolveProviderReasoningEffortProfile(activeProvider, effectiveModel)
  const control = resolveReasoningEffortControl(reasoningEffort, profile)
  // Only 'Default' is translated. The rest of the ladder (Low / Medium / High / XHigh / Max) comes from
  // resolveReasoningEffortControl and is the literal effort value sent on the wire, so it reads the same
  // in every locale — and src/shared has no i18n access by design.
  const options = [
    { value: undefined, label: t('Default'), intent: 'default' as const },
    ...control.options
  ]
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) =>
      reasoningEffort === 'default'
        ? option.intent === 'default'
        : option.value === control.selectedValue
    )
  )

  return (
    <SettingsSegmentedControl
      value={options[selectedIndex].intent}
      options={options.map((option) => ({ value: option.intent, label: option.label }))}
      onValueChange={(intent) => void setReasoningEffort(intent)}
      ariaLabel={t('Reasoning effort')}
    />
  )
}

export { ReasoningEffortSelect }
