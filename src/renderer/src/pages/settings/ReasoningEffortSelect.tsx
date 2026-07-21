import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { ReasoningEffort } from '../../../../shared/settings'

// Reasoning-effort choices shown in Settings > Model, in display order. 'default' keeps the
// agent's own default (nothing is sent); the concrete levels form a relative scale that each
// agent/model maps onto its closest supported rung.
const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'max', label: 'Max' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]

// The reasoning-effort selector for Settings > Model: how hard the agent thinks per request.
// Changing it reconnects the agent, so subsequent requests run at the new level.
const ReasoningEffortSelect = (): React.JSX.Element => {
  const reasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const setReasoningEffort = useSettingsStore((state) => state.setReasoningEffort)

  return (
    <Select
      value={reasoningEffort}
      onValueChange={(value) => void setReasoningEffort(value as ReasoningEffort)}
    >
      <SelectTrigger aria-label="Reasoning effort">
        <span>
          {REASONING_EFFORT_OPTIONS.find((option) => option.value === reasoningEffort)?.label}
        </span>
      </SelectTrigger>
      <SelectContent>
        {REASONING_EFFORT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export { ReasoningEffortSelect }
