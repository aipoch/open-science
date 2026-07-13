import { ShieldAlert } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { useSettingsStore } from '@/stores/settings-store'

// A modal approval card for an un-trusted connector call. A connector tool sends data to an external
// service, so a call that isn't pre-allowed or skip-approved is held until the user decides here.
// Requests are answered one at a time (oldest first); the card can't be dismissed without a decision.
export function ConnectorApprovalDialog(): React.JSX.Element | null {
  const request = useSettingsStore((state) => state.pendingApprovals[0])
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const respondApproval = useSettingsStore((state) => state.respondApproval)
  const setConnectorAutoAllow = useSettingsStore((state) => state.setConnectorAutoAllow)

  if (!request) return null

  const displayName =
    connectors.find((c) => c.id === request.connector)?.displayName ??
    customServers.find((s) => s.name === request.connector)?.name ??
    request.connector

  const allowOnce = (): void => void respondApproval(request.id, 'allow')
  const deny = (): void => void respondApproval(request.id, 'deny')
  // Pre-trust the whole connector ("Skip approvals"), then allow this call.
  const allowAlways = (): void => {
    void setConnectorAutoAllow(request.connector, true).finally(
      () => void respondApproval(request.id, 'allow')
    )
  }

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-foreground">
                Allow external request?
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground [text-wrap:pretty]">
                Claude wants to call a connector tool that sends data to an external service.
                Approve only if you trust this connector with the current request.
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Connector</span>
              <span className="min-w-0 truncate font-medium text-foreground">{displayName}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Tool</span>
              <span className="min-w-0 truncate font-mono text-foreground">{request.method}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Args</span>
              <span className="min-w-0 break-all font-mono text-muted-foreground">
                {request.argsPreview}
              </span>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={deny}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-muted"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={allowAlways}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted"
            >
              Always allow
            </button>
            <button
              type="button"
              onClick={allowOnce}
              className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Allow once
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
