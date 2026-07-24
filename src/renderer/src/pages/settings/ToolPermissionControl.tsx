import { Ban, CircleCheck, Hand } from 'lucide-react'

import type { ToolPermission } from '../../../../shared/settings'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type ToolPermissionControlProps = {
  value: ToolPermission
  onChange: (next: ToolPermission) => void
  label: string // accessible group label, e.g. "Permission for list_marts"
}

// A 3-segment permission pill: "Always allow / Ask each time / Block". Each segment shows a hover
// tooltip. "Ask each time" (the secure default) requires per-call approval before the tool runs.
export function ToolPermissionControl({
  value,
  onChange,
  label
}: ToolPermissionControlProps): React.JSX.Element {
  const segment = (active: boolean, allow: boolean): string => {
    const base =
      'grid h-6 w-7 place-items-center rounded-md transition-colors motion-reduce:transition-none'
    if (active) {
      return `${base} bg-card shadow-sm ${allow ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`
    }
    return `${base} text-muted-foreground hover:text-foreground`
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={value === 'allow'}
              aria-label="Always allow"
              onClick={() => onChange('allow')}
              className={segment(value === 'allow', true)}
            >
              <CircleCheck className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Always allow</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={value === 'ask'}
              aria-label="Ask each time"
              onClick={() => onChange('ask')}
              className={segment(value === 'ask', false)}
            >
              <Hand className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Ask each time</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={value === 'block'}
              aria-label="Block"
              onClick={() => onChange('block')}
              className={segment(value === 'block', false)}
            >
              <Ban className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>Block</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
