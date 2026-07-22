import { useState } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
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
  const [showFull, setShowFull] = useState(false)

  if (!request) return null

  const deny = (): void => void respondApproval(request.id, 'deny')
  const approveOnce = (): void => void respondApproval(request.id, 'once')
  const approveConversation = (): void => void respondApproval(request.id, 'conversation')
  const approveProject = (): void => void respondApproval(request.id, 'project')

  const isLongCommand = request.command_preview !== request.command_full

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overscroll-contain rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-foreground">
                Allow remote command?
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground [text-wrap:pretty]">
                Remote commands run as your account on the host and are not sandboxed. Approve only
                if you trust this command.
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Host</span>
              <span className="min-w-0 truncate font-medium text-foreground">
                {request.provider_name}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Intent</span>
              <span className="min-w-0 break-words text-foreground">{request.intent}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Command</span>
              <div className="min-w-0 flex-1">
                <span className="break-all font-mono text-muted-foreground">
                  {showFull ? request.command_full : request.command_preview}
                </span>
                {isLongCommand && (
                  <button
                    type="button"
                    onClick={() => setShowFull((v) => !v)}
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
            {request.inputs_summary && (
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">Inputs</span>
                <span className="min-w-0 break-words text-foreground">
                  {request.inputs_summary}
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
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
