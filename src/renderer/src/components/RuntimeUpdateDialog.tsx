import { redactSensitiveText } from '@aipoch/diagnostics'
import { useNavigationStore } from '@/stores/navigation-store'
import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useUpdateStore } from '@/stores/update-store'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import { runtimeUpdateCopy } from './runtime-update-copy'
import { progressStates, recoveryStates, runtimeUpdateState } from './runtime-update-view'

export const RuntimeUpdateDialog = ({ active = true }: { active?: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  const { status, isDialogOpen, apply, cancel, recheck, recover } = useUpdateStore()
  const [legacyToken, setLegacyToken] = useState<string>()
  const [forceConfirmation, setForceConfirmation] = useState(false)
  const forceIntent = useRef(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [dismissedCliToken, setDismissedCliToken] = useState<string>()
  const [requestPending, setRequestPending] = useState(false)
  const [recheckAttempted, setRecheckAttempted] = useState(false)
  const [recoveryAttempted, setRecoveryAttempted] = useState(false)
  useEffect(
    () =>
      useUpdateStore.subscribe((next, previous) => {
        if (
          next.isDialogOpen !== previous.isDialogOpen ||
          next.status.outcome ||
          (next.status.state === 'applying' && previous.status.state !== 'applying')
        ) {
          setRecoveryAttempted(false)
          setRecheckAttempted(false)
        }
      }),
    []
  )
  const pendingRef = useRef(false)
  const cancelRef = useRef(false)
  const id = runtimeUpdateState(status)
  const recovery = recoveryStates.has(id)
  const progress = progressStates.has(id)
  const busy = requestPending || status.state === 'applying' || id === 'S25' || id === 'S29'
  const cli = status.cliConfirmation
  const cliOpen = Boolean(cli && cli.token !== dismissedCliToken)
  const completed = ['S15', 'S27', 'S28'].includes(id)
  useEffect(() => {
    if (!isDialogOpen || completed) forceIntent.current = false
  }, [isDialogOpen, completed])
  const copy = runtimeUpdateCopy(
    ['S25', 'S29'].includes(id) && status.recovery
      ? runtimeUpdateState({
          ...status,
          state: 'error',
          recovery: { ...status.recovery, phase: 'preparing' }
        })
      : id,
    t,
    status.recovery?.detail === 'occupancy-unknown'
  )
  const canCancel = !['S23', 'S24', 'S25'].includes(id) && (status.recovery?.canCancel ?? !busy)
  const blocked = Boolean(status.reason && status.reason !== 'user-cancelled' && id !== 'S10')
  const open = active && (isDialogOpen || recovery || progress)
  const request = async (action: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setRequestPending(true)
    try {
      await action()
    } finally {
      pendingRef.current = false
      setRequestPending(false)
    }
  }
  const cancelUpdate = (): void => {
    if (!canCancel || cancelRef.current) return
    cancelRef.current = true
    setCancelPending(true)
    forceIntent.current = false
    void (async () => {
      try {
        await cancel()
        const next = useUpdateStore.getState().status
        // A stopped service cannot expose the workspace until main confirms recovery.
        if (
          !next.recovery ||
          (next.recovery.runtime === 'running' && next.recovery.installation === 'unchanged')
        ) {
          useUpdateStore.setState({ isDialogOpen: false })
        }
      } finally {
        cancelRef.current = false
        setCancelPending(false)
      }
    })()
  }
  const quit = (): void => {
    void window.api.runtimeStartup?.quit()
  }
  const diagnostics = redactSensitiveText(
    [
      status.diagnostics ??
        JSON.stringify(
          {
            reason: status.reason,
            current: status.current,
            target: status.latest,
            recovery: status.recovery,
            blockedBy: status.blockedBy
          },
          null,
          2
        ),
      status.error ? `Operation error: ${status.error}` : undefined
    ]
      .filter(Boolean)
      .join('\n\n')
  )
  if (!active) return <></>
  if (completed) return <></>
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !recovery && !cliOpen && !forceConfirmation) cancelUpdate()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`${dialogOverlayClassName} z-[60]`} />
        <Dialog.Content
          data-testid="runtime-update-dialog"
          data-runtime-update-state={id}
          className={dialogPanelClassName(
            'z-[60] flex max-h-[calc(100svh-2rem)] w-[min(570px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (forceConfirmation || cliOpen || legacyToken) return
            if (!recovery) cancelUpdate()
          }}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {recovery ? t('Recover app') : progress ? copy.title : t('Prepare to install update')}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground tabular-nums">
              {t('v{{current}} → v{{latest}}', {
                current: status.current,
                latest: status.latest ?? status.current
              })}
            </Dialog.Description>
          </div>
          <div className={`${dialogBodyClassName} min-h-0 overflow-y-auto`}>
            <ErrorNotice
              role={blocked || recovery ? 'alert' : 'status'}
              level={recovery ? 'warning' : blocked ? 'warning' : 'info'}
              icon={busy ? LoaderCircle : AlertTriangle}
              title={copy.title}
              description={copy.description}
            />
            {status.error ? (
              <ErrorNotice
                className="mt-3"
                role="alert"
                level="warning"
                description={t(
                  'The operation could not be completed. Review diagnostics and try again.'
                )}
              />
            ) : null}
            {id === 'S25' ? (
              <p role="status" className="mt-3 text-sm">
                {t('Checking whether the app can recover…')}
              </p>
            ) : null}
            {recoveryAttempted && recovery && !busy ? (
              <p role="status" className="mt-3 text-sm">
                {t(
                  'Recovery has not been confirmed. Review the steps below or save diagnostics for help.'
                )}
              </p>
            ) : null}
            {blocked && !recovery && !['S08', 'S32'].includes(id) ? (
              <Button
                variant="outline"
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  setRecheckAttempted(true)
                  void request(recheck)
                }}
              >
                {busy ? t('Checking…') : t('Recheck')}
              </Button>
            ) : null}
            {id === 'S04' && status.blockedTasks?.length ? (
              <ul className="mt-3 space-y-2">
                {status.blockedTasks.map((task) => (
                  <li
                    key={`${task.kind}:${task.sessionId}`}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 break-words">{task.title}</span>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        useNavigationStore
                          .getState()
                          .openSession(task.projectId, task.sessionId, 'user', () =>
                            useUpdateStore.setState({ isDialogOpen: false })
                          )
                      }}
                    >
                      {t('View task')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {status.blockedBy?.length ? (
              <p className="mt-3 text-sm">
                {t('Blocked by')}:{' '}
                {status.blockedBy
                  .map(
                    (blocker) =>
                      ({
                        agent: t('Active tasks'),
                        delegated: t('Subagents'),
                        notebook: t('Notebook'),
                        reviewer: t('Review'),
                        'settings-install': t('Installation')
                      })[blocker]
                  )
                  .join(', ')}
              </p>
            ) : null}
            {blocked || recovery ? (
              <details
                className="mt-4 text-sm"
                open={
                  Boolean(status.error) || recheckAttempted || recoveryAttempted || id === 'S14'
                }
              >
                <summary className="cursor-pointer font-medium">{t('How to fix')}</summary>
                <p className="mt-2 text-muted-foreground">
                  {['S13', 'S14', 'S32'].includes(id)
                    ? t(
                        'Wait for any installer to finish. If it fails, quit Desktop and repair or update through the original installation method. Keep configuration and data folders, then reopen the app to verify the result.'
                      )
                    : copy.description}
                </p>
              </details>
            ) : null}
            {status.legacyShellRecovery && !recovery && !progress ? (
              <ErrorNotice
                className="mt-4"
                level="warning"
                description={t('Old Shell launch records are blocking this update.')}
                primaryButton={{
                  label: t('Back up records and retry'),
                  disabled: busy,
                  onClick: () => setLegacyToken(status.legacyShellRecovery?.token)
                }}
              />
            ) : null}
            <RuntimeDiagnostics text={diagnostics} />
            {id === 'S04' && status.canForce === true ? (
              <details className="mt-4 text-sm">
                <summary>{t('More options')}</summary>
                <Button variant="ghost" disabled={busy} onClick={() => setForceConfirmation(true)}>
                  {t('Force update…')}
                </Button>
              </details>
            ) : null}
          </div>
          <div className={`${dialogFooterClassName} shrink-0 flex-wrap`}>
            {recovery ? (
              <>
                <Button variant="ghost" disabled={busy} onClick={quit}>
                  {t('Quit', { context: 'verb', ns: 'common' })}
                </Button>
                <Button
                  disabled={busy || !status.recovery?.canRecover}
                  onClick={() => {
                    setRecoveryAttempted(true)
                    void request(recover)
                  }}
                >
                  {busy ? t('Recovering…') : t('Recover app')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  disabled={!canCancel || cancelPending}
                  onClick={cancelUpdate}
                >
                  {t('Cancel')}
                </Button>
                {!progress ? (
                  <Button
                    disabled={busy || (blocked && !cli)}
                    onClick={() => {
                      void request(() => apply())
                    }}
                  >
                    {t('Restart to update')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <ConfirmActionDialog
        open={open && cliOpen}
        title={t('Stop the service and update?')}
        description={t(
          'This service currently continues running when Desktop quits. Continuing stops it and disconnects all Web, CLI, and SDK clients.'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Stop server, update, and use Desktop')}
        onCancel={() => {
          if (cli) setDismissedCliToken(cli.token)
          forceIntent.current = false
          void cancel().then(() => {
            const current = useUpdateStore.getState().status
            if (
              !current.recovery ||
              (current.recovery.runtime === 'running' &&
                current.recovery.installation === 'unchanged')
            ) {
              useUpdateStore.setState({
                isDialogOpen: true,
                status: {
                  ...current,
                  outcome: undefined,
                  reason: current.reason === 'user-cancelled' ? undefined : current.reason
                }
              })
            }
          })
        }}
        onConfirm={() => {
          if (!cli) return
          setDismissedCliToken(cli.token)
          const force = forceIntent.current
          forceIntent.current = false
          void request(() => apply({ force, cliConsentToken: cli.token }))
        }}
      >
        {cli ? (
          <section
            className="mt-4 space-y-3 text-sm"
            data-runtime-update-state={cli.source === 'this-installation' ? 'S03' : 'S02'}
          >
            <p>
              {t(
                'The updated Desktop will run this profile with its existing settings and data locations. Quitting Desktop will then stop the service. The original service will not restart automatically.'
              )}
            </p>
            <p>
              {cli.source === 'this-installation'
                ? t(
                    'This service uses this Desktop installation and its program files will be updated.'
                  )
                : t(
                    'The standalone installation stays on its current version. Before using it again, verify that it can read data written by the updated app.'
                  )}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
              <dt>{t('Source')}</dt>
              <dd>{cli.source === 'this-installation' ? t('This app') : cli.entryPath}</dd>
              <dt>{t('PID / port')}</dt>
              <dd>
                {cli.pid} / {cli.port}
              </dd>
            </dl>
          </section>
        ) : null}
      </ConfirmActionDialog>
      <ConfirmActionDialog
        testId="runtime-force-confirmation-S05"
        open={forceConfirmation}
        title={t('Force update?')}
        description={t(
          'Active tasks will be interrupted. Unsaved work may be lost, and interrupted tasks will not restart automatically.'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Force update')}
        destructive
        onCancel={() => setForceConfirmation(false)}
        onConfirm={() => {
          setForceConfirmation(false)
          forceIntent.current = true
          void request(async () => {
            await apply({ force: true })
            if (!useUpdateStore.getState().status.cliConfirmation) forceIntent.current = false
          })
        }}
      >
        {status.blockedTasks?.length ? (
          <ul className="mt-3 space-y-1 text-sm">
            {status.blockedTasks.map((task) => (
              <li key={`${task.kind}:${task.sessionId}`}>{task.title}</li>
            ))}
          </ul>
        ) : null}
      </ConfirmActionDialog>
      <ConfirmActionDialog
        open={Boolean(legacyToken && legacyToken === status.legacyShellRecovery?.token)}
        title={t('Back up records and retry')}
        description={t(
          'Open-Science cannot verify whether commands from an earlier session are still running. If they are, their results may be lost during the update. Back up the old launch records and retry?'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Back up records and retry')}
        destructive
        onCancel={() => setLegacyToken(undefined)}
        onConfirm={() => {
          if (!legacyToken || legacyToken !== status.legacyShellRecovery?.token) return
          const token = legacyToken
          setLegacyToken(undefined)
          void request(() => apply({ legacyShellRecoveryToken: token }))
        }}
      />
    </Dialog.Root>
  )
}
