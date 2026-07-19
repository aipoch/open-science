import { CircleHelp, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
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
  // In-flight operations that lock the button. `isInstalling` is a global flag (one install at a time),
  // so an install of either framework locks both cards' uninstall — matching the selection lock.
  isUninstalling: boolean
  isDetecting: boolean
  isInstalling: boolean
  onUninstall: () => void
}

// Destructive Uninstall action for a detected runtime, always shown so every card carries the button.
// Enabled only for a non-active app-managed install; otherwise greyed out. When the greyed state has a
// standing reason (not app-managed, or the active framework), a trailing `?` icon appears inside the
// button and its tooltip explains why. To keep that tooltip hoverable, the greyed button is only
// aria-disabled (not natively disabled, which would swallow hover events) with its click neutralized; a
// transient busy state (installing/uninstalling/detecting) natively disables it with no `?`.
const RuntimeUninstallControl = ({
  label,
  uninstallCommand,
  managed,
  active,
  isUninstalling,
  isDetecting,
  isInstalling,
  onUninstall
}: RuntimeUninstallControlProps): React.JSX.Element => {
  const busy = isUninstalling || isDetecting || isInstalling
  // Busy takes priority: during detect/uninstall the button is natively disabled with no explainer, even
  // if a standing reason (non-managed / active) also applies — that reason is stale mid-operation.
  const hint = busy ? null : uninstallDisabledHint(label, uninstallCommand, { managed, active })

  const button = (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      // A standing reason keeps the button hoverable via aria-disabled so its tooltip can open; a
      // transient busy state uses the native disabled attribute instead (and shows no `?`).
      aria-disabled={hint ? true : undefined}
      disabled={busy}
      onClick={hint ? undefined : onUninstall}
      className={cn(
        hint && 'cursor-not-allowed opacity-50 hover:bg-destructive/10 dark:hover:bg-destructive/20'
      )}
    >
      <Trash2 aria-hidden="true" />
      Uninstall
      {hint ? <CircleHelp aria-hidden="true" /> : null}
    </Button>
  )

  // No standing reason (actionable, or only transiently busy): a plain button with no explainer.
  if (!hint) return button

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="max-w-xs leading-relaxed">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { RuntimeUninstallControl }
