import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type { ReasoningEffort } from '../../../../shared/settings'

// Reasoning-effort choices shown in Settings > Model, left to right from lightest to strongest.
// 'default' keeps the agent's own default (nothing is sent); the concrete levels form a relative
// scale that each agent/model maps onto its closest supported rung.
const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]

// Segmented effort selector: the highlight block slides to the picked level. Fixed-width segments
// keep the thumb math exact. Mirrored on ToolPermissionControl's radiogroup pattern.
const ReasoningEffortSelect = (): React.JSX.Element => {
  const reasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const setReasoningEffort = useSettingsStore((state) => state.setReasoningEffort)
  const selectedIndex = Math.max(
    0,
    REASONING_EFFORT_OPTIONS.findIndex((option) => option.value === reasoningEffort)
  )

  return (
    <div
      role="radiogroup"
      aria-label="Reasoning effort"
      className="relative grid w-fit grid-cols-5 rounded-lg bg-muted p-0.5"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 w-14 rounded-md bg-card shadow-sm transition-transform duration-150 motion-reduce:transition-none"
        style={{ transform: `translateX(${selectedIndex * 100}%)` }}
      />
      {REASONING_EFFORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={reasoningEffort === option.value}
          onClick={() => void setReasoningEffort(option.value)}
          className={cn(
            'relative z-10 flex h-7 w-14 items-center justify-center rounded-md text-xs font-medium transition-colors motion-reduce:transition-none',
            reasoningEffort === option.value
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
