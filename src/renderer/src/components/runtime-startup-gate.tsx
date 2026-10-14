import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { RuntimeDiagnostics } from './runtime-diagnostics'
import type { RuntimeStartupState } from '../../../shared/runtime-startup'

export const RuntimeStartupGate = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const api = window.api.runtimeStartup
  const [state, setState] = useState<RuntimeStartupState>({ phase: 'idle' })
  const [initialized, setInitialized] = useState(!api)
  const [attempt, setAttempt] = useState(0)
  const [confirmation, setConfirmation] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const revision = useRef(0)
  useEffect(() => {
    if (!api) return
    let mounted = true
    const observed = revision.current
    const unsubscribe = api.onStateChanged((next) => {
      if (mounted) {
        revision.current++
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
  if (!initialized)
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-6">
        {failed ? (
          <ErrorNotice
            fullPage
            title={t("Open-Science couldn't start")}
            description={t('The app could not be checked. Try again.')}
            primaryButton={{
              label: t('Check again'),
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
  const legacy = issue.reason === 'legacy-host'
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
  const checking = state.phase === 'recovering' || (pending && !stopping)
  const title = stopping
    ? t('Stopping the service…')
    : checking
      ? t('Checking…')
      : legacyService
        ? t('An older service is still running')
        : legacy
          ? t('Quit the older app first')
          : recovery
            ? t("Open-Science couldn't start")
            : t('Service version mismatch')
  const description = stopping
    ? t('Closing the older version and checking whether the app can open. Please wait.')
    : checking
      ? t('Checking whether the app can safely continue. Please wait.')
      : legacyService
        ? t(
            'Open-Science needs to close the older version before opening your projects. Finish any work in other Open-Science windows before continuing.'
          )
        : legacy
          ? t(
              'An older Open-Science app is using this data. Finish your work and quit that app from its own application menu, then reopen this app. It cannot be stopped here.'
            )
          : recovery
            ? t(
                'The previous session has not passed safety checks. Check again before opening the app. Interrupted tasks will not restart automatically.'
              )
            : t(
                'The running version differs from this app. Finish any work in other Open-Science windows, then stop the service to continue.'
              )
  return (
    <main
      className="flex min-h-svh items-center justify-center bg-background px-6 py-8"
      data-runtime-startup-state={
        state.phase === 'stopping' ? 'S26' : recovery ? 'S18' : legacy ? 'S19' : 'S16'
      }
    >
      <div className="w-full max-w-lg">
        <ErrorNotice
          fullPage
          icon={busy ? LoaderCircle : AlertTriangle}
          iconClassName={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
          tone="amber"
          title={title}
          description={description}
          secondaryButton={
            busy || legacy
              ? undefined
              : legacyService
                ? {
                    label: t('Check again'),
                    variant: 'ghost',
                    disabled: busy,
                    onClick: () => {
                      if (api) void perform(api.recover)
                    }
                  }
                : {
                    label: t('Quit', { context: 'verb', ns: 'common' }),
                    variant: 'ghost',
                    disabled: busy,
                    onClick: () => void api?.quit()
                  }
          }
          primaryButton={
            busy
              ? undefined
              : {
                  label: legacy
                    ? t('Quit', { context: 'verb', ns: 'common' })
                    : recovery
                      ? t('Check and reopen app')
                      : t('Stop service and continue'),
                  disabled: legacy ? false : recovery ? !issue.canRecover : !issue.canStop,
                  onClick: () => {
                    if (legacy) void api?.quit()
                    else if (recovery && api) void perform(api.recover)
                    else setConfirmation(true)
                  }
                }
          }
        >
          {failed || (legacyService && state.phase === 'blocked' && issue.diagnostics) ? (
            <p role="status" className="mt-3 text-sm">
              {legacyService
                ? t(
                    'The service could not be stopped or checked. Try again, or save diagnostics for help.'
                  )
                : t('The app could not be checked. Try again.')}
            </p>
          ) : null}
          <RuntimeDiagnostics text={issue.diagnostics ?? JSON.stringify(issue, null, 2)} />
        </ErrorNotice>
        <ConfirmActionDialog
          testId="runtime-startup-confirmation-S17"
          open={confirmation}
          title={t('Stop the old service?')}
          description={
            legacyService
              ? t(
                  'Running tasks will be interrupted and other connections will close. Unsaved work may be lost. After the older version exits, this app will open your saved projects using its current settings. Custom command-line options will not be kept.'
                )
              : t(
                  'Stopping interrupts its tasks and disconnects other clients. Not all work is confirmed saved. This Desktop will run the service with the preserved settings and data locations, and quitting Desktop will stop it. The old service will not restart automatically.'
                )
          }
          cancelLabel={t('Cancel')}
          confirmLabel={t('Stop service')}
          onCancel={() => setConfirmation(false)}
          onConfirm={() => {
            setConfirmation(false)
            if (api && issue.canStop) void perform(api.stopAndContinue)
          }}
        />
      </div>
    </main>
  )
}
