import { useState } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope
} from '@/pages/workspace/PermissionScopeConfirmationDialog'
import { useComputeStore } from '@/stores/compute-store'

// A modal approval card for a pending compute call_command. The card cannot be dismissed without
// a decision — the call is held open in main until the user responds (or a 5-minute timeout fires).
//
// Four approval scopes; Broker persists Session/Project/Global and the compute adapter receives a
// one-call allow decision only after that write succeeds.
//   Once             — approve this call only; card shown every time
//   This session      — approve for (provider, operation) for this persisted session
//   This project      — approve for (provider, operation) for all future calls in this project
//   Always            — approve for (provider, operation) across projects
export function ComputeApprovalDialog({
  active = true,
  blockedSessionIds
}: {
  active?: boolean
  blockedSessionIds?: ReadonlySet<string>
}): React.JSX.Element | null {
  const request = useComputeStore((state) =>
    state.pendingApprovals.find(
      (candidate) => !candidate.session_id || !blockedSessionIds?.has(candidate.session_id)
    )
  )
  const respondApproval = useComputeStore((state) => state.respondApproval)
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)
  const [pendingBroadScope, setPendingBroadScope] = useState<BroadPermissionScope>()

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const deny = (): void => void respondApproval(dialogRequest.id, 'deny')
  const approveOnce = (): void => void respondApproval(dialogRequest.id, 'once')
  const approveSession = (): void => void respondApproval(dialogRequest.id, 'conversation')
  const confirmBroadScope = (): void => {
    if (!pendingBroadScope) return
    const scope = pendingBroadScope
    setPendingBroadScope(undefined)
    void respondApproval(dialogRequest.id, scope)
  }

  const isLongCommand = dialogRequest.command_preview !== dialogRequest.command_full
  const showFull = expandedRequestId === dialogRequest.id

  return (
    <Dialog.Root open={active && Boolean(request)}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] w-[min(480px,calc(100vw-2rem))] overscroll-contain p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'items-start justify-start')}>
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>Allow remote command?</Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
              >
                Remote commands run as your account on the host and are not sandboxed. Approve only
                if you trust this command.
              </Dialog.Description>
            </div>
          </div>

          <div className={dialogBodyClassName}>
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">Host</span>
                <span className="min-w-0 truncate font-medium text-foreground">
                  {dialogRequest.provider_name}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">Intent</span>
                <span className="min-w-0 break-words text-foreground">{dialogRequest.intent}</span>
              </div>
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">Command</span>
                <div className="min-w-0 flex-1">
                  <span className="break-all font-mono text-muted-foreground">
                    {showFull ? dialogRequest.command_full : dialogRequest.command_preview}
                  </span>
                  {isLongCommand && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRequestId((id) =>
                          id === dialogRequest.id ? null : dialogRequest.id
                        )
                      }
                      className="mt-1 flex items-center gap-0.5 text-xs text-primary hover:underline"
                      aria-expanded={showFull}
                    >
                      {showFull ? (
                        <>
                          <ChevronUp className="size-3" aria-hidden="true" /> Show less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="size-3" aria-hidden="true" /> Show full command
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
              {dialogRequest.inputs_summary && (
                <div className="flex gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">Inputs</span>
                  <span className="min-w-0 break-words text-foreground">
                    {dialogRequest.inputs_summary}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className={cn(dialogFooterClassName, 'flex-wrap')}>
            <Button type="button" variant="destructive" onClick={deny}>
              Deny
            </Button>
            <Button type="button" variant="outline" onClick={approveOnce}>
              Once
            </Button>
            <Button type="button" variant="outline" onClick={approveSession}>
              This session
            </Button>
            <Button type="button" variant="outline" onClick={() => setPendingBroadScope('project')}>
              This project
            </Button>
            <Button type="button" onClick={() => setPendingBroadScope('global')}>
              Always
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <PermissionScopeConfirmationDialog
        confirmation={
          active && pendingBroadScope
            ? {
                scope: pendingBroadScope,
                subject: `remote commands on ${dialogRequest.provider_name}`,
                codeExecution: true
              }
            : undefined
        }
        onCancel={() => setPendingBroadScope(undefined)}
        onConfirm={confirmBroadScope}
      />
    </Dialog.Root>
  )
}
