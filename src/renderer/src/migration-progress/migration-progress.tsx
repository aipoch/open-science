import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import './migration-progress.css'
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
      case 'counting':
        return t('Counting files and folders…')
      case 'counted':
        return t('Preparing migration…')
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
  const overall = state.overall
  const percentage =
    overall &&
    Number.isFinite(overall.completed) &&
    Number.isFinite(overall.total) &&
    overall.total > 0 &&
    overall.completed >= 0 &&
    overall.completed <= overall.total
      ? Math.min(
          state.phase === 'completed' ? 100 : 99,
          Math.floor((overall.completed / overall.total) * 100)
        )
      : undefined
  return (
    <main className="migration-progress-page min-h-svh bg-background px-6 py-9 text-foreground">
      <section className="mx-auto flex w-full max-w-[484px] flex-col items-center text-center">
        <div className="migration-progress-logo" aria-hidden="true">
          <OpenScienceLogoLoader />
        </div>
        <h1 className="mt-4 text-xl font-medium">{t('Upgrading local data')}</h1>
        <div className="mt-7 w-full">
          <div className="flex min-h-6 items-start justify-between gap-4 text-sm">
            <p role="status" className="text-left text-muted-foreground">
              {phase}
            </p>
            {percentage !== undefined ? (
              <span className="shrink-0 tabular-nums">{`${percentage}%`}</span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={t('Overall migration progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full rounded-full bg-status-success-accent-foreground dark:bg-status-success-dark-foreground ${percentage === undefined ? 'migration-progress-indeterminate' : ''}`}
              style={percentage === undefined ? undefined : { width: `${percentage}%` }}
            />
          </div>
          <div className="mt-3 flex min-h-5 items-start justify-between gap-4 text-xs tabular-nums text-muted-foreground">
            <p className="text-left">
              {state.completed !== undefined
                ? state.total === undefined
                  ? t('Items checked: {{completed}}', { completed: state.completed })
                  : t('Items checked: {{completed}} / {{total}}', {
                      completed: state.completed,
                      total: state.total
                    })
                : null}
            </p>
            <p className="shrink-0">
              {t('Elapsed: {{time}}', {
                time: `${Math.floor(Math.max(0, now - state.startedAt) / 60000)}:${String(Math.floor(Math.max(0, now - state.startedAt) / 1000) % 60).padStart(2, '0')}`
              })}
            </p>
          </div>
        </div>
        <ErrorNotice
          className="mt-6 border-status-warning-foreground/30 bg-status-warning-surface/45 dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface/25"
          icon={TriangleAlert}
          tone="amber"
          title={t('Add model keys again after migration')}
          description={t(
            'Configuration migration invalidates encrypted keys. Add your model keys again after migration finishes.'
          )}
        />
        <div className="mt-5 flex w-full flex-col gap-3 text-left text-xs leading-5 text-muted-foreground">
          {state.path ? <p className="[overflow-wrap:anywhere]">{state.path}</p> : null}
          {now - state.updatedAt >= 10000 ? (
            <p role="status">{t('Waiting for the current operation to report progress…')}</p>
          ) : null}
        </div>
        <p className="mt-6 text-xs leading-5 text-muted-foreground">
          {t('Keep Open-Science open while this finishes.')}
        </p>
      </section>
    </main>
  )
}
