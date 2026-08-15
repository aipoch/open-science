import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

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
import { cn } from '@/lib/utils'
import {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope
} from '@/pages/workspace/PermissionScopeConfirmationDialog'
import { useSettingsStore } from '@/stores/settings-store'

// A modal approval card for an un-trusted connector call. A connector tool sends data to an external
// service, so a call that isn't pre-allowed or skip-approved is held until the user decides here.
// Requests are answered one at a time (oldest first); the card can't be dismissed without a decision.
export function ConnectorApprovalDialog({
  active = true,
  blockedSessionIds
}: {
  active?: boolean
  blockedSessionIds?: ReadonlySet<string>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const request = useSettingsStore((state) =>
    state.pendingApprovals.find(
      (candidate) => !candidate.sessionId || !blockedSessionIds?.has(candidate.sessionId)
    )
  )
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const respondApproval = useSettingsStore((state) => state.respondApproval)
  const [pendingBroadScope, setPendingBroadScope] = useState<BroadPermissionScope>()
  const [responding, setResponding] = useState(false)
  const [responseErrorRequestId, setResponseErrorRequestId] = useState<string>()

  if (!request) return null
  const availableScopes = request.availableScopes ?? ['once']

  const displayName =
    connectors.find((c) => c.id === request.connector)?.displayName ??
    customServers.find((s) => s.name === request.connector)?.name ??
    request.connector

  const submitResponse = (decision: 'once' | 'session' | 'project' | 'global' | 'deny'): void => {
    if (responding) return
    const requestId = request.id
    setResponding(true)
    setResponseErrorRequestId(undefined)
    void respondApproval(requestId, decision)
      .catch(() => setResponseErrorRequestId(requestId))
      .finally(() => setResponding(false))
  }
  const allow = (scope: 'once' | 'session' | 'project' | 'global'): void => {
    if (scope === 'project' || scope === 'global') {
      setPendingBroadScope(scope)
      return
    }
    submitResponse(scope)
  }
  const confirmBroadScope = (): void => {
    if (!pendingBroadScope) return
    const scope = pendingBroadScope
    setPendingBroadScope(undefined)
    submitResponse(scope)
  }
  const deny = (): void => submitResponse('deny')

  return (
    <Dialog.Root open={active}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          aria-busy={responding}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] w-[min(440px,calc(100vw-2rem))] overscroll-contain p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'items-start justify-start')}>
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>
                {t('Allow external request?')}
              </Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
              >
                {t(
                  'The agent wants to call a connector tool that sends data to an external service. Approve only if you trust this connector with the current request.'
                )}
              </Dialog.Description>
            </div>
          </div>

          <div className={dialogBodyClassName}>
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{t('Connector')}</span>
                <span className="min-w-0 truncate font-medium text-foreground">{displayName}</span>
              </div>
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{t('Tool')}</span>
                <span className="min-w-0 truncate font-mono text-foreground">{request.method}</span>
              </div>
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{t('Args')}</span>
                <span className="min-w-0 break-all font-mono text-muted-foreground">
                  {request.argsPreview}
                </span>
              </div>
            </div>
            {responseErrorRequestId === request.id ? (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{t('Could not submit this approval. Try again.')}</span>
              </div>
            ) : null}
          </div>

          <div className={cn(dialogFooterClassName, 'flex-wrap')}>
            <Button type="button" variant="destructive" disabled={responding} onClick={deny}>
              {t('Deny')}
            </Button>
            {availableScopes.includes('session') ? (
              <Button
                type="button"
                variant="outline"
                disabled={responding}
                onClick={() => allow('session')}
              >
                {t('This session')}
              </Button>
            ) : null}
            {availableScopes.includes('project') ? (
              <Button
                type="button"
                variant="outline"
                disabled={responding}
                onClick={() => allow('project')}
              >
                {t('This project')}
              </Button>
            ) : null}
            {availableScopes.includes('global') ? (
              <Button
                type="button"
                variant="outline"
                disabled={responding}
                onClick={() => allow('global')}
              >
                {t('Global')}
              </Button>
            ) : null}
            <Button type="button" disabled={responding} onClick={() => allow('once')}>
              {t('Allow once')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <PermissionScopeConfirmationDialog
        confirmation={
          active && pendingBroadScope
            ? {
                scope: pendingBroadScope,
                subject: `${displayName} ${request.method}`,
                codeExecution: false
              }
            : undefined
        }
        onCancel={() => setPendingBroadScope(undefined)}
        onConfirm={confirmBroadScope}
      />
    </Dialog.Root>
  )
}
