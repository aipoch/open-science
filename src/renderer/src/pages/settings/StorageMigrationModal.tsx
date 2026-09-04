import { Dialog } from 'radix-ui'
import { Check, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { dialogCancelButtonClassName } from '@/components/ui/dialog-chrome'
import { resolveActiveSessionDisplay, truncateLabel } from '@/lib/active-session-display'
import { cn } from '@/lib/utils'
import {
  hasDelegatedActiveSession,
  type ActiveSessionInfo,
  type DataRootRecoveryStatus,
  type MigrationOutcome,
  type MigrationPhase,
  type MigrationProgress
} from '../../../../shared/storage'

type Stage = 'detecting' | 'confirm' | 'migrating' | 'done' | 'committing' | 'error'

type StorageMigrationModalProps = {
  active?: boolean
  targetPath: string
  recoveryStatus?: DataRootRecoveryStatus
  targetAvailableBytes?: number
  onClose: () => void
}

// Catalog keys, not resolved strings: this constant is evaluated once at import, so translated text
// stored here would pin the language of the first render. Resolution happens in the component.
// `as const` keeps the values literal so t() can still key-check them.
const PHASE_LABEL_KEYS = {
  scan: 'Scanning files…',
  copy: 'Copying files…',
  verify: 'Verifying…',
  delete: 'Cleaning up…'
} as const satisfies Record<MigrationPhase, string>

// One readable line per running session: the human project name + title (resolved from the stores),
// not the raw ids main sends.
const describeSession = (session: ActiveSessionInfo): string => {
  const display = resolveActiveSessionDisplay(session)
  return `${session.kind}: ${truncateLabel(display.project)} / ${truncateLabel(display.title)}`
}

// m:ss elapsed clock for the migrating stage. A running timer (rather than a fabricated ETA) so
// that if a move ever hangs, the user — and a bug report — can say exactly how long it has run.
const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// Uses the same 1000-based display as the Storage panel. The byte total shown here comes from the
// migration scan, which is the authoritative hard-link-aware copy preflight.
const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

// Drives the data-root move end to end: detects running sessions, confirms the interrupt+restart
// with the user when any are found, runs the migration with live progress, and routes the outcome
// (moved / cancelled / switchover failed / failed) to matching UI. Mounted only while a move is in
// flight, so unmount always means "tear down the progress subscription".
const StorageMigrationModal = ({
  active: isPresentationActive = true,
  targetPath,
  recoveryStatus,
  targetAvailableBytes,
  onClose
}: StorageMigrationModalProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const [stage, setStage] = useState<Stage>(recoveryStatus === 'copying' ? 'done' : 'detecting')
  const [active, setActive] = useState<ActiveSessionInfo[]>([])
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [copyRequiredBytes, setCopyRequiredBytes] = useState<number | undefined>()
  const [outcome, setOutcome] = useState<MigrationOutcome | null>(null)
  // Discarding the copied-but-uncommitted new root can be slow (it deletes the whole copy), so the
  // done stage shows a loading state and awaits it instead of firing-and-forgetting.
  const [isDiscarding, setIsDiscarding] = useState(false)
  const [discardError, setDiscardError] = useState<string | null>(null)
  const [cleanupWarning, setCleanupWarning] = useState(false)
  const [ipcError, setIpcError] = useState(false)
  // Elapsed clock: `startedAt` is stamped at each transition into the migrating stage (event
  // handler / async callback, never an effect body), and `now` is ticked every second. Both are
  // state so render reads no refs; elapsedMs is derived below.
  const [now, setNow] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const mountedRef = useRef(true)
  // Ref (not a dependency) so a parent re-render passing a new onClose identity mid-migration
  // can't re-trigger the migrate effect below and fire a second migrate() call.
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Track liveness so async callbacks don't setState after unmount. Reset to true in the setup (not
  // just false in cleanup): under React StrictMode's dev mount→unmount→mount, a cleanup-only version
  // leaves the ref false for the real mount, so every `if (!mountedRef.current) return` bails and the
  // modal stays stuck on "Checking…".
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Detect running sessions once on open; skip straight to migrating when nothing is running. A
  // verified recovery skips the copy and returns to the already-completed decision stage. An
  // incomplete ('copying') recovery has no commit path, so it starts directly at discard-only done.
  // A rejected call would otherwise strand the modal on "Checking…" forever, since it's
  // non-dismissable until a stage transition happens.
  useEffect(() => {
    if (recoveryStatus === 'copying') return
    void window.api.storage
      .detectActive()
      .then((sessions) => {
        if (!mountedRef.current) return
        if (sessions.length > 0) {
          setActive(sessions)
          setStage('confirm')
        } else if (recoveryStatus === 'verified') {
          setStage('done')
        } else {
          setStartedAt(Date.now())
          setStage('migrating')
        }
      })
      .catch(() => {
        if (!mountedRef.current) return
        setIpcError(true)
        setStage('error')
      })
  }, [recoveryStatus])

  // Runs the move once we enter the migrating stage: subscribe to progress and call migrate,
  // routing its outcome to done / cancelled (close, no error) / error.
  useEffect(() => {
    if (stage !== 'migrating') return undefined

    const unsubscribe = window.api.storage.onProgress((update) => {
      if (mountedRef.current) {
        setProgress(update)
        if (update.phase === 'scan') setCopyRequiredBytes(update.totalBytes)
      }
    })

    void window.api.storage
      .migrate(targetPath)
      .then((result) => {
        if (!mountedRef.current) return
        setOutcome(result)
        if (result.ok) {
          setStage('done')
          return
        }
        if ('switchoverFailed' in result) {
          setStage('error')
          return
        }
        if (result.cancelled) {
          onCloseRef.current()
          return
        }
        setStage('error')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setIpcError(true)
        setStage('error')
      })

    return unsubscribe
  }, [stage, targetPath])

  // Tick a 1s clock while migrating (cleared on leave/unmount). `startedAt` is stamped by the
  // transition into this stage, not here, so this effect calls no setState synchronously.
  useEffect(() => {
    if (stage !== 'migrating') return undefined
    const intervalId = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(intervalId)
  }, [stage])

  const startMigration = (): void => {
    if (recoveryStatus === 'verified') {
      setStage('done')
      return
    }
    setStartedAt(Date.now())
    setStage('migrating')
  }
  const handleCancel = (): void => void window.api.storage.cancelMigrate().catch(() => {})

  // "Restart now": commit the copied move (setDataRoot -> delete old -> relaunch). On success the app
  // relaunches, so control never returns here; a returned result means the commit failed, which we
  // surface as the error stage (the copy is intact and the old root is untouched).
  const handleRestart = (): void => {
    setStage('committing')
    void window.api.storage
      .commitAndRelaunch(targetPath)
      .then((result) => {
        if (!mountedRef.current || result.ok) return
        setOutcome(result)
        setStage('error')
      })
      .catch(() => {
        if (!mountedRef.current) return
        setIpcError(true)
        setStage('error')
      })
  }

  // "Keep current location": throw away the copied-but-uncommitted new root and stay put. Nothing
  // was committed, so this is a clean no-op switch back. Await the discard (with a loading state)
  // before closing, so a slow delete of a large copy gives feedback and can't race a re-attempt.
  const handleKeepCurrent = (): void => {
    setIsDiscarding(true)
    setDiscardError(null)
    void window.api.storage
      .discardMigratedCopy(targetPath)
      .then((result) => {
        if (!mountedRef.current) return
        if (!result.ok) {
          setDiscardError(result.error)
          setIsDiscarding(false)
          return
        }
        if (result.cleanupWarning) {
          setCleanupWarning(true)
          setIsDiscarding(false)
          return
        }
        onCloseRef.current()
      })
      .catch(() => {
        if (!mountedRef.current) return
        setDiscardError(t('Something went wrong. Try again.'))
        setIsDiscarding(false)
      })
  }

  // The delete phase reports copiedBytes/totalBytes as 0 (there's nothing left to copy), which
  // would otherwise read as a dip back to 0% right before the move finishes — treat it as 100%.
  const percent =
    progress?.phase === 'delete'
      ? 100
      : progress && progress.totalBytes > 0
        ? Math.round((progress.copiedBytes / progress.totalBytes) * 100)
        : 0

  // Only the 'error' stage is freely closable. Every other stage exits via an explicit button:
  // detecting/confirming/migrating (Cancel), done (Restart now / Keep current location), and
  // committing (no exit — the switch-over is underway and must not be interrupted by a stray click).
  const dismissable = stage === 'error'

  // Derived (not stored) so the ticking effect never resets state synchronously; clamps to 0 before
  // the first tick, when `now` still holds its initial/prior value.
  const elapsedMs = stage === 'migrating' && startedAt !== null ? Math.max(0, now - startedAt) : 0
  const hasDelegatedWork = hasDelegatedActiveSession(active)

  // switchoverFailed is a success-with-caveat (the data DID move; only the auto-restart didn't), so
  // the error stage renders it in a calmer, non-destructive tone than an outright failure.
  const isSwitchover = Boolean(outcome && 'switchoverFailed' in outcome)

  return (
    <Dialog.Root open={isPresentationActive}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          onInteractOutside={(event) => {
            if (!dismissable) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            if (!dismissable) event.preventDefault()
          }}
          className="fixed left-1/2 top-1/2 z-[60] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog"
        >
          {stage === 'detecting' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">
                {t('Checking for running sessions…')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {t('One moment.')}
              </Dialog.Description>
            </>
          ) : null}

          {stage === 'confirm' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">{t('Move app data?')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {hasDelegatedWork
                  ? t(
                      'Subagents are still running. Return to each task below, stop its subagents, then try moving app data again.'
                    )
                  : recoveryStatus === 'verified'
                    ? t(
                        'Finishing this recovered move will interrupt the running sessions below and restart the app.'
                      )
                    : t(
                        'Starting this move will interrupt the running sessions below and restart the app.'
                      )}
              </Dialog.Description>
              <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
                {active.map((session) => (
                  <li key={`${session.kind}-${session.projectId}-${session.sessionId}`}>
                    {describeSession(session)}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant={hasDelegatedWork ? 'outline' : 'ghost'}
                  className={hasDelegatedWork ? undefined : dialogCancelButtonClassName}
                  onClick={onClose}
                >
                  {hasDelegatedWork ? t('Return to tasks') : tCommon('Cancel')}
                </Button>
                {!hasDelegatedWork ? (
                  <Button type="button" onClick={startMigration}>
                    {recoveryStatus === 'verified'
                      ? t('Continue to recovery')
                      : t('Interrupt and move')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          {stage === 'migrating' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">{t('Moving app data…')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {progress ? t(PHASE_LABEL_KEYS[progress.phase]) : t('Preparing…')}
              </Dialog.Description>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-300">
                <div
                  className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">{percent}%</p>
              {progress?.currentPath ? (
                <p
                  className="mt-1 truncate font-mono text-xs text-muted-foreground"
                  title={progress.currentPath}
                >
                  {progress.currentPath}
                </p>
              ) : null}
              {copyRequiredBytes !== undefined ? (
                <div className="mt-2 space-y-0.5 text-xs tabular-nums text-muted-foreground">
                  <p>
                    {t('Copy phase requires {{size}}', { size: formatBytes(copyRequiredBytes) })}
                  </p>
                  {targetAvailableBytes !== undefined ? (
                    <>
                      <p>
                        {t('Available on target disk: {{size}}', {
                          size: formatBytes(targetAvailableBytes)
                        })}
                      </p>
                      {copyRequiredBytes > targetAvailableBytes ? (
                        <p className="text-status-warning-foreground dark:text-status-warning-dark-foreground">
                          {t('The target may not have enough space for the copy.')}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              <p
                className="mt-2 text-xs tabular-nums text-muted-foreground"
                aria-label={t('Elapsed time')}
              >
                {t('Elapsed {{time}}', { time: formatElapsed(elapsedMs) })}
              </p>
              <p
                role="alert"
                className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                {t("Don't quit Open Science or turn off your computer until this finishes.")}
              </p>
              <div className="mt-4 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  onClick={handleCancel}
                >
                  {tCommon('Cancel')}
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'done' && cleanupWarning ? (
            <>
              <div className="flex items-start gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                >
                  <TriangleAlert className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm font-semibold text-foreground">
                    {t('Current location kept')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      "Open Science couldn't remove the unused copy. Normal work has resumed. You can delete the copy later."
                    )}
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <Button type="button" variant="outline" onClick={onClose}>
                  {tCommon('Close')}
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'done' && recoveryStatus === 'copying' && !cleanupWarning ? (
            <>
              <div className="flex items-start gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                >
                  <TriangleAlert className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm font-semibold text-foreground">
                    {t('Incomplete data copy found')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      'Open Science exited before this copy finished. Your current data is untouched. Discard the incomplete copy to use this location again.'
                    )}
                  </Dialog.Description>
                </div>
              </div>
              {discardError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  {discardError}
                </p>
              ) : null}
              <div className="mt-5 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDiscarding}
                  onClick={handleKeepCurrent}
                >
                  {isDiscarding ? t('Discarding…') : t('Discard incomplete copy')}
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'done' && recoveryStatus !== 'copying' && !cleanupWarning ? (
            <>
              <div className="flex items-start gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-status-success-accent/10 text-status-success-accent-foreground dark:text-status-success-dark-foreground"
                  aria-hidden="true"
                >
                  <Check className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm font-semibold text-foreground">
                    {recoveryStatus === 'verified'
                      ? t('Verified data copy found')
                      : t('Data copied')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {recoveryStatus === 'verified'
                      ? t(
                          'A completed copy from an interrupted move is ready. Finish the move to switch locations and restart, or discard the copy to stay where you are.'
                        )
                      : t(
                          'Restart to switch to the new location. Nothing is changed until you do — choose Keep current location to stay where you are and discard the copy.'
                        )}
                  </Dialog.Description>
                </div>
              </div>
              {discardError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  {discardError}
                </p>
              ) : null}
              {discardError ? (
                <div className="mt-5 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isDiscarding}
                    onClick={handleKeepCurrent}
                  >
                    {t('Try again')}
                  </Button>
                </div>
              ) : (
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isDiscarding}
                    onClick={handleKeepCurrent}
                  >
                    {isDiscarding
                      ? t('Discarding…')
                      : recoveryStatus === 'verified'
                        ? t('Discard copy')
                        : t('Keep current location')}
                  </Button>
                  <Button type="button" disabled={isDiscarding} onClick={handleRestart}>
                    <RefreshCw aria-hidden="true" />
                    {recoveryStatus === 'verified' ? t('Finish move') : t('Restart now')}
                  </Button>
                </div>
              )}
            </>
          ) : null}

          {stage === 'committing' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">{t('Switching over…')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {t("Finishing up and restarting. This can take a moment — please don't quit.")}
              </Dialog.Description>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-300">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
              </div>
            </>
          ) : null}

          {stage === 'error' ? (
            <>
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-full',
                    isSwitchover
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-destructive/10 text-destructive'
                  )}
                  aria-hidden="true"
                >
                  {isSwitchover ? (
                    <RefreshCw className="size-[18px]" />
                  ) : (
                    <TriangleAlert className="size-[18px]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm font-semibold text-foreground">
                    {isSwitchover ? t('Data moved — please restart') : t('Move failed')}
                  </Dialog.Title>
                  <Dialog.Description
                    className="mt-1 text-xs leading-relaxed text-muted-foreground"
                    role="alert"
                  >
                    {/* outcome.error is backend-supplied and passes through verbatim. */}
                    {ipcError
                      ? t('Something went wrong. Please close and try again.')
                      : outcome && !outcome.ok
                        ? outcome.error
                        : null}
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <Button type="button" variant="outline" onClick={onClose}>
                  {tCommon('Close')}
                </Button>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { StorageMigrationModal }
