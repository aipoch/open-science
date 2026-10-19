import { redactSensitiveText } from '@aipoch/diagnostics'
import { useNavigationStore } from '@/stores/navigation-store'
import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Download, LoaderCircle } from 'lucide-react'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useUpdateStore } from '@/stores/update-store'
import { DownloadProgressLine } from './DownloadProgressLine'
import { UpdateReleaseNotes } from './UpdateReleaseNotes'
import { ExternalTextLink } from './ExternalTextLink'
import { APP } from '../../../shared/app-config'
import { formatBytes } from '../../../shared/update'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import { runtimeUpdateCopy } from './runtime-update-copy'
import { progressStates, recoveryStates, runtimeUpdateState } from './runtime-update-view'

export const RuntimeUpdateDialog = ({ active = true }: { active?: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  const { status, isDialogOpen, apply, cancel, recheck, recover, download, check } =
    useUpdateStore()
  const [legacyToken, setLegacyToken] = useState<string>()
  const [forceConfirmation, setForceConfirmation] = useState(false)
  const forceIntent = useRef(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [dismissedCliToken, setDismissedCliToken] = useState<string>()
  const [requestPending, setRequestPending] = useState(false)
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
        }
      }),
    []
  )
  const pendingRef = useRef(false)
  const cancelRef = useRef(false)
  const id = runtimeUpdateState(status)
  const recovery = recoveryStates.has(id)
  const progress = progressStates.has(id)
  const downloading = status.state === 'downloading'
  const checking =
    status.state === 'checking' &&
    !status.reason &&
    !status.recovery &&
    !status.cliConfirmation &&
    !status.legacyShellRecovery
  const needsDownload =
    (status.state === 'available' ||
      status.state === 'downloading' ||
      (status.state === 'error' && Boolean(status.latest))) &&
    !status.reason &&
    !status.recovery &&
    !status.cliConfirmation
  const checkFailed =
    status.state === 'error' &&
    !status.latest &&
    !status.reason &&
    !status.recovery &&
    !status.cliConfirmation &&
    !status.legacyShellRecovery
  const busy =
    checking || requestPending || status.state === 'applying' || id === 'S25' || id === 'S29'
  const cli = status.cliConfirmation
  const cliOpen = Boolean(cli && cli.token !== dismissedCliToken)
  const legacyOpen = Boolean(legacyToken && legacyToken === status.legacyShellRecovery?.token)
  const confirming = cliOpen || forceConfirmation || legacyOpen
  const completed = ['S15', 'S27', 'S28'].includes(id)
  useEffect(() => {
    if (!isDialogOpen || completed) forceIntent.current = false
  }, [isDialogOpen, completed])
  const copy = runtimeUpdateCopy(id, t, status.recovery?.detail === 'occupancy-unknown')
  const canCancel =
    !['S23', 'S24', 'S25'].includes(id) &&
    (status.recovery?.canCancel ?? (needsDownload || checkFailed || checking || !busy))
  const blocked = Boolean(status.reason && status.reason !== 'user-cancelled' && id !== 'S10')
  const legacyRecords = Boolean(status.legacyShellRecovery && !recovery && !progress)
  const open = active && (isDialogOpen || recovery || progress)
  const standardFlow =
    !confirming && !blocked && !recovery && !legacyRecords && !status.error && !checkFailed
  const StatusIcon = busy ? LoaderCircle : downloading || needsDownload ? Download : Check
  const statusTitle = checking
    ? t('Checking for updates…')
    : needsDownload
      ? downloading
        ? t('Downloading…')
        : t('Update available')
      : copy.title
  const statusDescription = checking
    ? undefined
    : needsDownload
      ? downloading
        ? t('You can cancel the download at any time.')
        : t('Review what’s new, then download the update.')
      : id === 'S23'
        ? t('Cannot cancel; the app will reopen automatically.')
        : status.state === 'applying'
          ? t('Please wait for the app to close and reopen.')
          : id === 'S01'
            ? t('Ready to restart; running tasks will be checked.')
            : copy.description
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
  const cancelConfirmation = (): void => {
    setForceConfirmation(false)
    setLegacyToken(undefined)
    if (cliOpen && cli) {
      setDismissedCliToken(cli.token)
      cancelUpdate()
    }
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
            'z-[60] flex max-h-[calc(100svh-2rem)] w-[min(600px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (confirming) {
              cancelConfirmation()
              return
            }
            if (!recovery) cancelUpdate()
          }}
        >
          <div className={`${dialogHeaderClassName} flex-wrap gap-y-1`}>
            <Dialog.Title className={dialogTitleClassName}>
              {confirming ? t('Update Open-Science now?') : t('Update')}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground tabular-nums">
              {status.latest
                ? t('v{{current}} → v{{latest}}', {
                    current: status.current,
                    latest: status.latest
                  })
                : status.current}
            </Dialog.Description>
          </div>
          {standardFlow ? (
            <section
              data-testid="update-status"
              className="shrink-0 border-b border-border px-5 py-5"
            >
              <div className="flex items-start gap-3" role="status" aria-atomic="true">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <StatusIcon
                    aria-hidden="true"
                    className={`size-5 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
                  />
                </span>
                <div className="min-w-0 space-y-1">
                  <h3 className="text-base font-semibold leading-6">{statusTitle}</h3>
                  {statusDescription ? (
                    <p className="text-xs leading-5 text-muted-foreground">{statusDescription}</p>
                  ) : null}
                </div>
              </div>
              {downloading ? (
                <div className="mt-3">
                  <DownloadProgressLine
                    progress={
                      status.downloadProgress ?? {
                        phase: 'downloading',
                        transferred: status.downloadedBytes ?? 0,
                        total: status.totalBytes,
                        percent: status.progress ?? 0,
                        bytesPerSecond: 0,
                        attempt: 0
                      }
                    }
                  />
                </div>
              ) : null}
            </section>
          ) : null}
          <div
            data-testid="update-scroll-body"
            className={`${dialogBodyClassName} min-h-0 overflow-y-auto overscroll-contain ${standardFlow ? 'max-h-80' : ''}`}
          >
            {confirming ? (
              <section
                data-runtime-update-state={
                  cliOpen ? (cli?.source === 'this-installation' ? 'S03' : 'S02') : undefined
                }
                data-testid={forceConfirmation ? 'runtime-force-confirmation-S05' : undefined}
                className="space-y-3 text-sm"
              >
                <p>
                  {legacyOpen
                    ? t(
                        'Open-Science cannot verify whether commands from an earlier session are still running. If they are, their results may be lost during the update. Back up the old launch records and retry?'
                      )
                    : t(
                        'Updating will interrupt running tasks. Unsaved work may be lost. Interrupted tasks will not restart automatically.'
                      )}
                </p>
                {cliOpen ? (
                  <>
                    <p>
                      {t(
                        'Other connections will close. After updating, closing this app will also stop background work. Your settings and data locations will be kept.'
                      )}
                    </p>
                    {cli?.source === 'another-installation' ? (
                      <p>
                        {t(
                          'Your separate installation will not be updated. Check data compatibility before using it again.'
                        )}
                      </p>
                    ) : null}
                    <RuntimeDiagnostics
                      text={redactSensitiveText(
                        JSON.stringify(
                          {
                            source: cli?.source,
                            entryPath: cli?.entryPath,
                            pid: cli?.pid,
                            port: cli?.port
                          },
                          null,
                          2
                        )
                      )}
                    />
                  </>
                ) : null}
              </section>
            ) : (
              <>
                {!standardFlow && !needsDownload && !checkFailed ? (
                  <ErrorNotice
                    role={blocked || recovery ? 'alert' : 'status'}
                    level={recovery ? 'warning' : blocked ? 'warning' : 'info'}
                    icon={busy ? LoaderCircle : AlertTriangle}
                    iconClassName={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
                    title={
                      legacyRecords
                        ? t('Old Shell launch records are blocking this update.')
                        : copy.title
                    }
                    description={
                      legacyRecords
                        ? t(
                            'Open-Science cannot verify whether commands from an earlier session are still running. If they are, their results may be lost during the update. Back up the old launch records and retry?'
                          )
                        : copy.description
                    }
                  />
                ) : null}
                {status.error || checkFailed ? (
                  <ErrorNotice
                    className="mt-3"
                    role="alert"
                    level="warning"
                    title={checkFailed ? t('Update failed') : undefined}
                    description={
                      (needsDownload || checkFailed) && status.error
                        ? redactSensitiveText(status.error)
                        : t('The operation could not be completed. Try again.')
                    }
                  >
                    {needsDownload || checkFailed ? (
                      <ExternalTextLink href={APP.update.downloadPage} className="mt-1 text-xs">
                        {t('Download manually')}
                      </ExternalTextLink>
                    ) : null}
                  </ErrorNotice>
                ) : null}
                {recoveryAttempted && recovery && !busy && !status.error ? (
                  <p role="status" className="mt-3 text-sm">
                    {t('The app is not ready yet. Try again after completing the action above.')}
                  </p>
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
                {blocked || recovery || status.error ? (
                  <RuntimeDiagnostics text={diagnostics} />
                ) : null}
                {id === 'S04' && status.canForce === true ? (
                  <details className="mt-4 text-sm">
                    <summary>{t('More options')}</summary>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setForceConfirmation(true)}
                    >
                      {t('Force update…')}
                    </Button>
                  </details>
                ) : null}
                {!recovery && !checkFailed && !checking ? (
                  <UpdateReleaseNotes status={status} />
                ) : null}
              </>
            )}
          </div>
          {downloading && !standardFlow ? (
            <div className="shrink-0 px-5 pb-5">
              <DownloadProgressLine
                progress={
                  status.downloadProgress ?? {
                    phase: 'downloading',
                    transferred: status.downloadedBytes ?? 0,
                    total: status.totalBytes,
                    percent: status.progress ?? 0,
                    bytesPerSecond: 0,
                    attempt: 0
                  }
                }
              />
            </div>
          ) : null}
          {confirming ? (
            <div className={`${dialogFooterClassName} shrink-0`}>
              <Button variant="ghost" onClick={cancelConfirmation}>
                {t('Cancel')}
              </Button>
              <Button
                onClick={() => {
                  if (cliOpen && cli) {
                    setDismissedCliToken(cli.token)
                    const force = forceIntent.current
                    forceIntent.current = false
                    void request(() => apply({ force, cliConsentToken: cli.token }))
                  } else if (legacyOpen && legacyToken) {
                    const token = legacyToken
                    setLegacyToken(undefined)
                    void request(() => apply({ legacyShellRecoveryToken: token }))
                  } else if (forceConfirmation) {
                    setForceConfirmation(false)
                    forceIntent.current = true
                    void request(async () => {
                      await apply({ force: true })
                      if (!useUpdateStore.getState().status.cliConfirmation)
                        forceIntent.current = false
                    })
                  }
                }}
              >
                {t('Update')}
              </Button>
            </div>
          ) : !busy || canCancel ? (
            <div className={`${dialogFooterClassName} shrink-0 flex-wrap [&_button]:min-h-10`}>
              {recovery && !busy ? (
                <>
                  {status.recovery?.canRecover ? (
                    <Button variant="ghost" onClick={quit}>
                      {t('Quit', { context: 'verb', ns: 'common' })}
                    </Button>
                  ) : null}
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (!status.recovery?.canRecover) {
                        quit()
                        return
                      }
                      setRecoveryAttempted(true)
                      void request(recover)
                    }}
                  >
                    {!status.recovery?.canRecover
                      ? t('Quit', { context: 'verb', ns: 'common' })
                      : t('Retry')}
                  </Button>
                </>
              ) : (
                <>
                  {canCancel && !recovery ? (
                    <Button variant="ghost" disabled={cancelPending} onClick={cancelUpdate}>
                      {t('Cancel')}
                    </Button>
                  ) : null}
                  {!progress && !recovery && !checking && id !== 'S29' ? (
                    <Button
                      disabled={busy || downloading}
                      onClick={() => {
                        if (checkFailed) void request(check)
                        else if (needsDownload) void request(download)
                        else if (status.legacyShellRecovery)
                          setLegacyToken(status.legacyShellRecovery.token)
                        else if (blocked && !cli) void request(recheck)
                        else void request(() => apply())
                      }}
                    >
                      {needsDownload
                        ? downloading || requestPending
                          ? t('Downloading {{percent}}%', { percent: status.progress ?? 0 })
                          : status.totalBytes
                            ? t('Download update ({{size}})', {
                                size: formatBytes(status.totalBytes)
                              })
                            : t('Download update')
                        : busy
                          ? t('Checking…')
                          : status.legacyShellRecovery
                            ? t('Continue')
                            : checkFailed || (blocked && !cli)
                              ? t('Retry')
                              : t('Restart to update')}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : standardFlow ? (
            <div className={`${dialogFooterClassName} shrink-0 [&_button]:min-h-10`}>
              <Button disabled>{copy.title}</Button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
