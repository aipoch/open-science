import { CircleHelp, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { uninstallDisabledHint } from './runtime-uninstall-hint'

type RuntimeUninstallControlProps = {
  // Framework name woven into the explainer copy ("Claude", "OpenCode").
  label: string
  // Manual-removal command shown in the not-managed hint (e.g. `npm uninstall -g <pkg>`).
  uninstallCommand: string
  // Whether this runtime is the app-managed install (the only case an in-app uninstall can run).
  managed: boolean
  // Whether this runtime backs the active agent framework (can't be removed out from under sessions).
  active: boolean
  isUninstalling: boolean
  isDetecting: boolean
  onUninstall: () => void
}

// Destructive Uninstall action for a detected runtime, always shown so every card carries the button.
// Enabled only for a non-active app-managed install; otherwise greyed out. When the disabled state has a
// standing reason (not app-managed, or the active framework), an adjacent `?` icon explains it on hover —
// the tooltip hangs off the icon, not the button, because a disabled button doesn't fire hover events.
const RuntimeUninstallControl = ({
  label,
  uninstallCommand,
  managed,
  active,
  isUninstalling,
  isDetecting,
  onUninstall
}: RuntimeUninstallControlProps): React.JSX.Element => {
  const disabled = !managed || active || isUninstalling || isDetecting

  // Only the two standing reasons get an explainer; a transient busy state (uninstalling/detecting)
  // greys the button without a `?`.
  const hint = uninstallDisabledHint(label, uninstallCommand, { managed, active })

  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={onUninstall}
        disabled={disabled}
      >
        <Trash2 aria-hidden="true" />
        Uninstall
      </Button>
      {hint ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Why can't ${label} be uninstalled?`}
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <CircleHelp className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs leading-relaxed">{hint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  )
}

export { RuntimeUninstallControl }
