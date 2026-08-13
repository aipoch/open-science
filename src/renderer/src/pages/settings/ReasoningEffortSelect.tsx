import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../../../shared/provider-reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'

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
  // The slide is a click affordance: enable it only after the user interacts, so the thumb never
  // sweeps across on first paint when the persisted level loads.
  const [interactive, setInteractive] = useState(false)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) =>
      reasoningEffort === 'default'
        ? option.intent === 'default'
        : option.value === control.selectedValue
    )
  )

  return (
    <div
      role="radiogroup"
      aria-label={t('Reasoning effort')}
      className="relative grid w-fit rounded-lg bg-muted p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, 4rem)` }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0.5 left-0.5 w-16 rounded-md bg-card shadow-sm',
          interactive && 'transition-transform duration-150 motion-reduce:transition-none'
        )}
        style={{ transform: `translateX(${selectedIndex * 100}%)` }}
      />
      {options.map((option) => (
        <button
          key={option.intent}
          type="button"
          role="radio"
          aria-checked={options[selectedIndex] === option}
          onClick={() => {
            setInteractive(true)
            void setReasoningEffort(option.intent)
          }}
          className={cn(
            'relative z-10 flex h-7 w-16 items-center justify-center rounded-md text-xs font-medium transition-colors motion-reduce:transition-none',
            options[selectedIndex] === option
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export { ReasoningEffortSelect }
