import { Dialog } from 'radix-ui'
import { Check, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { resolveActiveSessionDisplay, truncateLabel } from '@/lib/active-session-display'
import { cn } from '@/lib/utils'
import type {
  ActiveSessionInfo,
  MigrationOutcome,
  MigrationPhase,
  MigrationProgress
} from '../../../../shared/storage'

type Stage = 'detecting' | 'confirm' | 'migrating' | 'done' | 'committing' | 'error'

type StorageMigrationModalProps = {
  targetPath: string
  onClose: () => void
}

const PHASE_LABELS: Record<MigrationPhase, string> = {
  scan: 'Scanning files…',
  copy: 'Copying files…',
  verify: 'Verifying…',
  delete: 'Cleaning up…'
}

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

// Drives the data-root move end to end: detects running sessions, confirms the interrupt+restart
// with the user when any are found, runs the migration with live progress, and routes the outcome
// (moved / cancelled / switchover failed / failed) to matching UI. Mounted only while a move is in
// flight, so unmount always means "tear down the progress subscription".
const StorageMigrationModal = ({
  targetPath,
  onClose
}: StorageMigrationModalProps): React.JSX.Element => {
  const [stage, setStage] = useState<Stage>('detecting')
  const [active, setActive] = useState<ActiveSessionInfo[]>([])
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [outcome, setOutcome] = useState<MigrationOutcome | null>(null)
  // Discarding the copied-but-uncommitted new root can be slow (it deletes the whole copy), so the
  // done stage shows a loading state and awaits it instead of firing-and-forgetting.
  const [isDiscarding, setIsDiscarding] = useState(false)
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

  // Detect running sessions once on open; skip straight to migrating when nothing is running.
  // A rejected call would otherwise strand the modal on "Checking…" forever, since it's
  // non-dismissable until a stage transition happens.
  useEffect(() => {
    void window.api.storage
      .detectActive()
      .then((sessions) => {
        if (!mountedRef.current) return
        if (sessions.length > 0) {
          setActive(sessions)
          setStage('confirm')
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
  }, [])

  // Runs the move once we enter the migrating stage: subscribe to progress and call migrate,
  // routing its outcome to done / cancelled (close, no error) / error.
  useEffect(() => {
    if (stage !== 'migrating') return undefined

    const unsubscribe = window.api.storage.onProgress((update) => {
      if (mountedRef.current) setProgress(update)
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
    void window.api.storage
      .discardMigratedCopy(targetPath)
      .catch(() => {})
      .finally(() => onCloseRef.current())
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

  // switchoverFailed is a success-with-caveat (the data DID move; only the auto-restart didn't), so
  // the error stage renders it in a calmer, non-destructive tone than an outright failure.
  const isSwitchover = Boolean(outcome && 'switchoverFailed' in outcome)

  return (
    <Dialog.Root open>
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
                Checking for running sessions…
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                One moment.
              </Dialog.Description>
            </>
          ) : null}

          {stage === 'confirm' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">Move app data?</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                Starting this move will interrupt the running sessions below and restart the app.
              </Dialog.Description>
              <ul className="mt-3 max-h-40 space-y-1 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
                {active.map((session) => (
                  <li key={`${session.kind}-${session.projectId}-${session.sessionId}`}>
                    {describeSession(session)}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={startMigration}>
                  Interrupt and move
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'migrating' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">Moving app data…</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {progress ? PHASE_LABELS[progress.phase] : 'Preparing…'}
              </Dialog.Description>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-300">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-150 ease-out"
                  style={{ width: `${percent}%` }}
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
              <p
                className="mt-2 text-xs tabular-nums text-muted-foreground"
                aria-label="Elapsed time"
              >
                Elapsed {formatElapsed(elapsedMs)}
              </p>
              <p
                role="alert"
                className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                Don&apos;t quit Open Science or turn off your computer until this finishes.
              </p>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'done' ? (
            <>
              <div className="flex items-start gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                >
                  <Check className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm font-semibold text-foreground">
                    Data copied
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Restart to switch to the new location. Nothing is changed until you do — choose
                    Keep current location to stay where you are and discard the copy.
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDiscarding}
                  onClick={handleKeepCurrent}
                >
                  {isDiscarding ? 'Discarding…' : 'Keep current location'}
                </Button>
                <Button type="button" disabled={isDiscarding} onClick={handleRestart}>
                  <RefreshCw aria-hidden="true" />
                  Restart now
                </Button>
              </div>
            </>
          ) : null}

          {stage === 'committing' ? (
            <>
              <Dialog.Title className="text-sm font-semibold">Switching over…</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                Finishing up and restarting. This can take a moment — please don&apos;t quit.
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
                    {isSwitchover ? 'Data moved — please restart' : 'Move failed'}
                  </Dialog.Title>
                  <Dialog.Description
                    className="mt-1 text-xs leading-relaxed text-muted-foreground"
                    role="alert"
                  >
                    {ipcError
                      ? 'Something went wrong. Please close and try again.'
                      : outcome && !outcome.ok
                        ? outcome.error
                        : null}
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
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
