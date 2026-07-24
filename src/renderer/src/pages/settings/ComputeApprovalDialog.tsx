import { useState } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'

// A modal approval card for a pending compute call_command. The card cannot be dismissed without
// a decision — the call is held open in main until the user responds (or a 5-minute timeout fires).
//
// Three scope buttons (design.md §6, no Global):
//   Once             — approve this call only; card shown every time
//   This conversation — approve for (provider, operation) for the rest of this session
//   This project      — approve for (provider, operation) for all future calls in this project
export function ComputeApprovalDialog(): React.JSX.Element | null {
  const request = useComputeStore((state) => state.pendingApprovals[0])
  const respondApproval = useComputeStore((state) => state.respondApproval)
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const deny = (): void => void respondApproval(dialogRequest.id, 'deny')
  const approveOnce = (): void => void respondApproval(dialogRequest.id, 'once')
  const approveConversation = (): void => void respondApproval(dialogRequest.id, 'conversation')
  const approveProject = (): void => void respondApproval(dialogRequest.id, 'project')

  const isLongCommand = dialogRequest.command_preview !== dialogRequest.command_full
  const showFull = expandedRequestId === dialogRequest.id

  return (
    <Dialog.Root open={Boolean(request)}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] w-[min(480px,calc(100vw-2rem))] overscroll-contain'
          )}
        >
          <div className="flex items-start gap-3">
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

          <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
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

          <div className={cn(dialogFooterClassName, 'mt-4 flex-wrap')}>
            <Button type="button" variant="destructive" onClick={deny}>
              Deny
            </Button>
            <Button type="button" variant="outline" onClick={approveOnce}>
              Once
            </Button>
            <Button type="button" variant="outline" onClick={approveConversation}>
              This conversation
            </Button>
            <Button type="button" onClick={approveProject}>
              This project
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
