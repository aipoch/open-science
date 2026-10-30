import { useEffect, useRef, useState } from 'react'
import { Unplug, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import {
  useDesktopRuntimeRecoveryStore,
  waitForDesktopSessionRecovery,
  refreshDesktopRecoveryReaders
} from '@/stores/desktop-runtime-recovery-store'
import { useUpdateStore } from '@/stores/update-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { flushComposerDrafts } from '@/pages/workspace/composer-draft-storage'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { Button } from '@/components/ui/button'
import { desktopRecoveryNeedsAppRestart } from '../../../shared/desktop-runtime-recovery'

/** Keeps the application mounted: recovery must never discard editors or composer drafts. */
export function DesktopRuntimeRecovery({
  saveDiagnostics
}: {
  saveDiagnostics: (text: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useDesktopRuntimeRecoveryStore()
  const updating = useUpdateStore((store) => store.status.state === 'applying')
  const previousFocus = useRef<HTMLElement | null>(null)
  const beforeRecovery = useRef(new Map<string, string | undefined>())
  const announcedGeneration = useRef<string | undefined>(undefined)
  const [interrupted, setInterrupted] = useState<{ id: string; projectId: string }[]>([])
  const [diagnosticResult, setDiagnosticResult] = useState<'downloaded' | 'failed' | undefined>()
  const reconnectPending = useRef(false)
  const [reconnectingService, setReconnectingService] = useState(false)
  const restartPending = useRef(false)
  const [restartingApp, setRestartingApp] = useState(false)
  const [restartBlocked, setRestartBlocked] = useState(false)
  const reconnectService = async (): Promise<void> => {
    if (reconnectPending.current || restartPending.current) return
    reconnectPending.current = true
    setReconnectingService(true)
    try {
      await window.api.desktopRuntime?.reconnect()
    } catch {
      // The recovery notice stays open; a failed IPC request must leave Retry available.
    } finally {
      reconnectPending.current = false
      setReconnectingService(false)
    }
  }
  const restartApplication = async (): Promise<void> => {
    if (restartPending.current || reconnectPending.current) return
    restartPending.current = true
    setRestartingApp(true)
    setRestartBlocked(false)
    let restarting = false
    try {
      restarting = (await window.api.desktopRuntime?.restartApp()) === 'restarting'
      if (!restarting) setRestartBlocked(true)
    } catch {
      setRestartBlocked(true)
    } finally {
      if (!restarting) {
        restartPending.current = false
        setRestartingApp(false)
      }
    }
  }
  useEffect(() => {
    const api = window.api.desktopRuntime
    if (!api) return
    let live = true
    const apply = (next: typeof state): void => {
      if (!live) return
      if (
        restartPending.current &&
        useDesktopRuntimeRecoveryStore.getState().closing &&
        !next.closing
      ) {
        restartPending.current = false
        setRestartingApp(false)
      }
      if (
        next.phase !== 'connected' &&
        useDesktopRuntimeRecoveryStore.getState().phase === 'connected'
      ) {
        // Recovery subscribers can disable the composer and blur it before the dialog mounts.
        previousFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        beforeRecovery.current = new Map(
          useSessionStore
            .getState()
            .sessions.map((session) => [session.id, session.resumeRecovery?.promptMessageId])
        )
      }
      if (next.phase !== 'connected') flushComposerDrafts()
      useDesktopRuntimeRecoveryStore.setState(next)
    }
    let receivedEvent = false
    const remove = api.onStateChanged((next) => {
      receivedEvent = true
      apply(next)
    })
    void api
      .getState()
      .then((next) => {
        if (!receivedEvent) apply(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      remove()
    }
  }, [])
  useEffect(() => {
    if (state.phase !== 'reconciling') return
    let live = true
    void Promise.all([
      waitForDesktopSessionRecovery(state.epoch),
      refreshDesktopRecoveryReaders(),
      useProjectStore
        .getState()
        .loadProjects()
        .then(() => {
          if (useProjectStore.getState().loadError) throw new Error('Project refresh failed.')
        }),
      useSettingsStore
        .getState()
        .load({ force: true })
        .then((loaded) => {
          if (!loaded) throw new Error('Settings refresh failed.')
        }),
      useSessionJobStore.getState().hydrateForRecovery()
    ]).then(
      () => {
        if (live) void window.api.desktopRuntime?.reconciled(state.epoch, true)
      },
      () => {
        if (live) void window.api.desktopRuntime?.reconciled(state.epoch, false)
      }
    )
    return () => {
      live = false
    }
  }, [state.epoch, state.phase])
  useEffect(() => {
    if (state.phase !== 'connected') return
    if (state.restartedGeneration && announcedGeneration.current !== state.restartedGeneration) {
      announcedGeneration.current = state.restartedGeneration
      // Only synchronized, durable app-restart recovery records prove interruption. A new
      // process or a failed request alone cannot distinguish interruption from completed work.
      setInterrupted(
        useSessionStore
          .getState()
          .sessions.filter(
            (session) =>
              session.resumeRecovery?.cause === 'app-restart' &&
              (!beforeRecovery.current.has(session.id) ||
                beforeRecovery.current.get(session.id) !== session.resumeRecovery.promptMessageId)
          )
          .map(({ id, projectId }) => ({ id, projectId }))
      )
    }
    // Restore only a focus lost to disabling a service control. Do not override user navigation.
    if (document.activeElement === document.body && previousFocus.current?.isConnected)
      previousFocus.current.focus()
    previousFocus.current = null
  }, [state.phase, state.restartedGeneration])
  if (state.closing && updating) return null
  if (
    state.phase === 'connected' &&
    !state.shutdownProgress &&
    !interrupted.length &&
    !diagnosticResult
  )
    return null
  const busy = state.phase === 'reconnecting' || state.phase === 'reconciling'
  const connected = state.phase === 'connected'
  const needsAppRestart = desktopRecoveryNeedsAppRestart(state)
  const title = state.shutdownProgress
    ? t('Closing Open-Science…')
    : connected
      ? interrupted.length
        ? t('Local service restarted')
        : t('Diagnostics')
      : state.startupFailure
        ? t('Local service could not restart')
        : state.reason === 'crash-limit'
          ? t('Local service keeps stopping')
          : state.reason === 'recovery-timeout'
            ? t('Unable to restore the local service connection')
            : state.reason === 'service-stopped'
              ? t('Local service stopped')
              : busy && state.reason === 'process-exited'
                ? t('Restarting local service…')
                : busy
                  ? t('Restoring local service connection…')
                  : t('Local service connection lost')
  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-[min(520px,calc(100vw-2rem))] rounded-lg border bg-background p-4 shadow-lg"
      data-testid="local-service-recovery"
    >
      <ErrorNotice
        inline
        icon={busy || state.shutdownProgress ? LoaderCircle : Unplug}
        iconClassName={
          busy || state.shutdownProgress ? 'animate-spin motion-reduce:animate-none' : undefined
        }
        tone={
          state.reason === 'crash-limit' || state.reason === 'recovery-timeout' ? 'red' : 'amber'
        }
        role="status"
        title={title}
        description={
          state.shutdownProgress
            ? t('Saving changes and closing the app…')
            : connected
              ? interrupted.length
                ? t('Some tasks were interrupted. Open them to resume.')
                : undefined
              : needsAppRestart
                ? t(
                    'The app checks that your work is saved before restarting. Unsaved attachments can block the restart.'
                  )
                : state.reason === 'crash-limit'
                  ? t(
                      'Automatic recovery has paused. Your drafts, projects and saved records are kept. You can retry now.'
                    )
                  : state.reason === 'service-stopped'
                    ? t(
                        'Your windows and drafts are kept. The local service will not restart automatically. Reconnect to check task status.'
                      )
                    : t(
                        'Your local drafts remain open. Submitted operations may have completed; they will not be retried.'
                      )
        }
        dismissButton={
          connected && !state.shutdownProgress
            ? {
                label: t('Dismiss'),
                onClick: () => {
                  setInterrupted([])
                  setDiagnosticResult(undefined)
                }
              }
            : undefined
        }
        secondaryButton={
          !connected && !state.shutdownProgress
            ? {
                label: t('Quit', { context: 'verb', ns: 'common' }),
                onClick: () => {
                  void window.api.desktopRuntime?.quit()
                }
              }
            : undefined
        }
        primaryButton={
          connected && interrupted.length && !state.shutdownProgress
            ? {
                label: t('View task'),
                onClick: () => {
                  const session = interrupted[0]!
                  useNavigationStore.getState().openSession(session.projectId, session.id, 'user')
                }
              }
            : !connected && !busy && !state.shutdownProgress
              ? {
                  label: t('Retry'),
                  loading: reconnectingService,
                  disabled: restartingApp,
                  onClick: () => {
                    void reconnectService()
                  }
                }
              : undefined
        }
      >
        {needsAppRestart && !busy && !state.shutdownProgress ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={restartingApp || reconnectingService}
            aria-busy={restartingApp || undefined}
            onClick={() => {
              void restartApplication()
            }}
          >
            {restartingApp ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {t('Restart Open-Science')}
          </Button>
        ) : null}
        {needsAppRestart && restartBlocked ? (
          <p role="alert" className="mt-2 text-sm">
            {t('Open-Science could not restart. Save or copy your work, then try again.')}
          </p>
        ) : null}
        {!connected && !state.shutdownProgress ? (
          <details className="mt-3 text-sm">
            <summary>{t('Diagnostics')}</summary>
            <pre className="my-2 max-h-36 overflow-auto whitespace-pre-wrap break-all text-xs">
              {state.diagnostics ??
                JSON.stringify(
                  { phase: state.phase, reason: state.reason, epoch: state.epoch },
                  null,
                  2
                )}
            </pre>
            <Button
              variant="outline"
              onClick={() => {
                try {
                  saveDiagnostics(state.diagnostics ?? JSON.stringify(state, null, 2))
                  setDiagnosticResult('downloaded')
                } catch {
                  setDiagnosticResult('failed')
                }
              }}
            >
              {t('Save diagnostics')}
            </Button>
          </details>
        ) : null}
        {diagnosticResult ? (
          <p className="mt-2 text-sm">
            {diagnosticResult === 'downloaded'
              ? t('Diagnostics download started.')
              : t('Could not save diagnostics.')}
          </p>
        ) : null}
      </ErrorNotice>
    </div>
  )
}
