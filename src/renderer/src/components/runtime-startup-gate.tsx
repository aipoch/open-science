import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import { saveRuntimeDiagnostics } from './save-runtime-diagnostics'
import type { RuntimeStartupState } from '../../../shared/runtime-startup'

const STALLED_AFTER_MS = 30_000
const FORCED_STOP_AFTER_MS = 8_000

// The timer only fires for the exact state it was armed for; any new state changes the key.
const useElapsed = (active: boolean, key: string, delayMs: number): boolean => {
  const [elapsedKey, setElapsedKey] = useState<string>()
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => setElapsedKey(key), delayMs)
    return () => clearTimeout(timer)
  }, [active, key, delayMs])
  return active && elapsedKey === key
}

export const RuntimeStartupGate = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const api = window.api.runtimeStartup
  const [state, setState] = useState<RuntimeStartupState>({ phase: 'idle' })
  const [initialized, setInitialized] = useState(!api)
  const [attempt, setAttempt] = useState(0)
  const [confirmation, setConfirmation] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sequence, setSequence] = useState(0)
  const revision = useRef(0)
  useEffect(() => {
    if (!api) return
    let mounted = true
    const observed = revision.current
    const unsubscribe = api.onStateChanged((next) => {
      if (mounted) {
        revision.current++
        setSequence((value) => value + 1)
        setState(next)
        setInitialized(true)
      }
    })
    void api
      .getState()
      .then((next) => {
        if (mounted && observed === revision.current) {
          setState(next)
          setInitialized(true)
        }
      })
      .catch(() => {
        if (mounted) setFailed(true)
      })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [api, attempt])
  const busyPhase = state.phase === 'stopping' || state.phase === 'recovering'
  const waitKey = `${state.phase}:${sequence}:${pending}`
  const stalled = useElapsed(busyPhase || pending, waitKey, STALLED_AFTER_MS)
  const forced = useElapsed(
    state.phase === 'stopping' && state.issue.reason === 'legacy-service',
    waitKey,
    FORCED_STOP_AFTER_MS
  )
  if (!initialized)
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-6">
        {failed ? (
          <ErrorNotice
            fullPage
            title={t("Open-Science couldn't start")}
            description={t('The app could not be checked. Try again.')}
            primaryButton={{
              label: t('Retry'),
              onClick: () => {
                setFailed(false)
                setAttempt((value) => value + 1)
              }
            }}
            secondaryButton={{
              label: t('Quit', { context: 'verb', ns: 'common' }),
              onClick: () => void api?.quit()
            }}
          />
        ) : (
          <OpenScienceLogoLoader />
        )}
      </main>
    )
  if (state.phase === 'idle' || state.phase === 'ready') return <>{children}</>
  const issue = state.issue
  const busy = pending || state.phase === 'stopping' || state.phase === 'recovering'
  const legacyService = issue.reason === 'legacy-service'
  const recovery = issue.reason === 'startup-recovery-required'
  const perform = async (action: () => Promise<RuntimeStartupState>): Promise<void> => {
    if (busy) return
    const observed = revision.current
    setPending(true)
    setFailed(false)
    try {
      const next = await action()
      if (observed === revision.current) setState(next)
    } catch {
      setState((current) =>
        current.phase === 'stopping' || current.phase === 'recovering'
          ? { phase: 'blocked', issue: current.issue }
          : current
      )
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  const stopping = state.phase === 'stopping'
  const failure =
    legacyService &&
    !busy &&
    (failed || (state.phase === 'blocked' && issue.diagnostics !== undefined))
  const canProceed = issue.canRecover || (!recovery && issue.canStop)
  const retryOnly = recovery || !issue.canStop
  const checking = state.phase === 'recovering' || (pending && !stopping)
  const diagnosticsText = issue.diagnostics ?? JSON.stringify(issue, null, 2)
  const tryAgain = (): void => {
    if (!api) return
    if (busy) {
      void api
        .recover()
        .then((next) => {
          setSequence((value) => value + 1)
          setState(next)
        })
        .catch(() => {})
    } else void perform(issue.canStop && legacyService ? api.stopAndContinue : api.recover)
  }
  const quit = t('Quit', { context: 'verb', ns: 'common' })
  const title =
    busy && stalled
      ? t('This is taking longer than expected')
      : stopping && legacyService
        ? forced
          ? t('Still closing the older version…')
          : t('Closing the older version…')
        : stopping
          ? t('Stopping the service…')
          : checking
            ? t('Checking…')
            : failure
              ? t("We couldn't close the older version")
              : legacyService
                ? t('An older version is still running')
                : recovery
                  ? t("Open-Science couldn't start")
                  : t('Service version mismatch')
  const description =
    busy && stalled
      ? t('Open-Science is still working on it. You can wait, try again, or save a report.')
      : stopping && legacyService
        ? forced
          ? t('It is taking longer than usual. Open-Science is closing it for you. Please wait.')
          : t('This usually takes a few seconds. Please wait.')
        : stopping
          ? t('Closing the older version and checking whether the app can open. Please wait.')
          : checking
            ? t('Checking whether the app can safely continue. Please wait.')
            : failure
              ? t('Your projects are safe. Try again, or save a report so we can help.')
              : legacyService
                ? t(
                    'Open-Science needs to close it before opening your projects. Finish any work in other Open-Science windows first.'
                  )
                : recovery
                  ? t(
                      'The previous session has not passed safety checks. Check again before opening the app. Interrupted tasks will not restart automatically.'
                    )
                  : t(
                      'The running version differs from this app. Finish any work in other Open-Science windows, then stop the service to continue.'
                    )
  const fallback = busy && stalled
  const actionable = !busy || fallback
  const stopNow = legacyService && issue.canStop
  return (
    <main
      className="flex min-h-svh items-center justify-center bg-background px-6 py-8"
      data-runtime-startup-state={
        state.phase === 'stopping' ? 'S26' : recovery ? 'S18' : legacyService ? 'S20' : 'S16'
      }
    >
      <div
        className="w-full max-w-lg"
        data-testid={confirmation ? 'runtime-startup-confirmation-S17' : undefined}
      >
        <ErrorNotice
          fullPage
          icon={busy ? LoaderCircle : AlertTriangle}
          iconClassName={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
          tone="amber"
          title={confirmation ? t('Continue opening Open-Science?') : title}
          description={
            confirmation
              ? t(
                  'Running tasks will stop and other connections will close. Unsaved work may be lost. Your settings and data locations will be kept. Closing this app will then stop background work.'
                )
              : description
          }
          secondaryButton={
            confirmation
              ? { label: t('Cancel'), variant: 'ghost', onClick: () => setConfirmation(false) }
              : !actionable || (!canProceed && !fallback)
                ? undefined
                : { label: quit, variant: 'ghost', onClick: () => void api?.quit() }
          }
          primaryButton={
            !actionable
              ? undefined
              : fallback || failure
                ? { label: t('Try again'), disabled: false, onClick: tryAgain }
                : {
                    label: !canProceed
                      ? quit
                      : stopNow
                        ? t('Close it and continue')
                        : retryOnly
                          ? t('Retry')
                          : t('Continue'),
                    disabled: false,
                    onClick: () => {
                      if (confirmation) {
                        setConfirmation(false)
                        if (api && issue.canStop) void perform(api.stopAndContinue)
                      } else if (!canProceed) void api?.quit()
                      else if (stopNow && api) void perform(api.stopAndContinue)
                      else if (retryOnly && api) void perform(api.recover)
                      else setConfirmation(true)
                    }
                  }
          }
        >
          {!confirmation &&
          !failure &&
          (failed || (state.phase === 'blocked' && issue.diagnostics)) ? (
            <p role="status" className="mt-3 text-sm">
              {t('The app could not be checked. Try again.')}
            </p>
          ) : null}
          {(fallback || failure) && !confirmation ? (
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => saveRuntimeDiagnostics(diagnosticsText)}
            >
              {t('Save diagnostics')}
            </Button>
          ) : null}
          <RuntimeDiagnostics text={diagnosticsText} />
        </ErrorNotice>
      </div>
    </main>
  )
}
