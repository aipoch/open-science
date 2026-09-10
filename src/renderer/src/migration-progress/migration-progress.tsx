import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { isLocale } from '../../../shared/locale'
import type { MigrationProgressBridge, MigrationProgressState } from './state'

export const MigrationProgress = ({
  bridge
}: {
  bridge: MigrationProgressBridge
}): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<MigrationProgressState>(() => ({
    phase: 'checking',
    startedAt: Date.now(),
    updatedAt: Date.now()
  }))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let received = false
    let disposed = false
    const apply = (next: MigrationProgressState): void => {
      if (disposed) return
      setState(next)
      if (isLocale(next.locale) && i18n.language !== next.locale)
        void i18n.changeLanguage(next.locale)
    }
    const unsubscribe = bridge.subscribe((next) => {
      received = true
      apply(next)
    })
    void bridge
      .getState()
      .then((next) => {
        if (!received) apply(next)
      })
      .catch(() => {
        if (!disposed && !received)
          setState((previous) => ({
            ...previous,
            phase: 'failed',
            error: t('Migration progress is unavailable.')
          }))
      })
    const clock = setInterval(() => setNow(Date.now()), 1000)
    // A paint acknowledgement gates the offline worker, so progress is visible before scanning.
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!disposed) bridge.painted()
      })
    )
    return () => {
      disposed = true
      unsubscribe()
      clearInterval(clock)
      cancelAnimationFrame(frame)
    }
  }, [bridge, i18n, t])

  const phase = (() => {
    switch (state.phase) {
      case 'scanning':
        return t('Scanning local files…')
      case 'copying':
        return t('Copying local files…')
      case 'verifying':
      case 'metadata':
        return t('Verifying files and permissions…')
      case 'references':
      case 'references-prepared':
        return t('Updating saved file references…')
      case 'syncing':
        return t('Saving verified files…')
      case 'root-published':
      case 'source-backed-up':
      case 'target-backed-up':
      case 'before-commit':
        return t('Finishing data migration…')
      case 'completed':
        return t('Starting Open-Science…')
      default:
        return t('Checking local data…')
    }
  })()
  if (state.phase === 'failed')
    return (
      <main
        className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
        aria-live="polite"
      >
        <ErrorNotice
          fullPage
          tone="red"
          title={t('Local data migration could not finish')}
          description={
            state.error === 'migration-worker-disconnected'
              ? t('Migration progress is unavailable.')
              : state.error
          }
          errorCode={state.error === 'migration-worker-disconnected' ? state.error : undefined}
          help={{
            whyLabel: t('Why this happened'),
            why: t('Migration stopped before the application opened its data.'),
            howLabel: t('How to fix'),
            how: t(
              'Keep the migration journal and backups. Close other app and runtime processes, then restart to resume. If the error persists, copy the diagnostics for help.'
            )
          }}
          secondaryButton={{
            label: t('Copy diagnostics'),
            onClick: () => {
              void bridge.copyDiagnostics()
            }
          }}
          primaryButton={{ label: t('Close'), onClick: () => bridge.close() }}
        />
      </main>
    )
  return (
    <main
      role="status"
      className="flex min-h-svh items-center justify-center bg-background px-8 py-6 text-foreground"
    >
      <section className="flex w-full max-w-lg flex-col items-center gap-6 text-center">
        <OpenScienceLogoLoader />
        <div className="flex w-full flex-col items-center gap-3">
          <h1 className="text-lg font-medium">{t('Upgrading local data')}</h1>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {phase}
          </p>
          {state.path ? (
            <p className="w-full break-all text-xs text-muted-foreground">{state.path}</p>
          ) : null}
          {state.completed !== undefined ? (
            <p className="text-sm tabular-nums">
              {state.total === undefined
                ? t('Items checked: {{completed}}', { completed: state.completed })
                : t('Items checked: {{completed}} / {{total}}', {
                    completed: state.completed,
                    total: state.total
                  })}
            </p>
          ) : null}
          <p className="text-xs tabular-nums text-muted-foreground">
            {t('Elapsed: {{time}}', {
              time: `${Math.floor(Math.max(0, now - state.startedAt) / 60000)}:${String(Math.floor(Math.max(0, now - state.startedAt) / 1000) % 60).padStart(2, '0')}`
            })}
          </p>
          {now - state.updatedAt >= 10000 ? (
            <p className="text-xs text-muted-foreground">
              {t('Waiting for the current operation to report progress…')}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {t('Keep Open-Science open while this finishes.')}
          </p>
        </div>
      </section>
    </main>
  )
}
