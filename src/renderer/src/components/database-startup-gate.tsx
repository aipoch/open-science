import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleArrowUp,
  CircleQuestionMark,
  Cpu,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldX,
  Unplug,
  type LucideIcon
} from 'lucide-react'

import logo from '@/assets/logo.png'
import logoDark from '@/assets/logo-dark.png'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { buildStartupIssueUrl } from '@/lib/startup-issue'
import type {
  DatabaseStartupErrorCode,
  DatabaseStartupState
} from '../../../shared/database-startup'

type DatabaseStartupGateProps = { children: ReactNode }

const UNAVAILABLE_STARTUP_MESSAGE = 'Open Science could not finish checking its database.'

const unavailableStartupState: DatabaseStartupState = {
  phase: 'blocked',
  error: {
    code: 'database_startup_unavailable',
    message: UNAVAILABLE_STARTUP_MESSAGE,
    retryable: true
  }
}

const applyUnavailableStartupFallback = (current: DatabaseStartupState): DatabaseStartupState =>
  current.phase === 'checking' ? unavailableStartupState : current

const restoreUnavailableUnlessReady = (current: DatabaseStartupState): DatabaseStartupState =>
  current.phase === 'ready' ? current : unavailableStartupState

// Per-error-code presentation: semantic tone, icon, and the self-help guidance block. Copy lives
// here as English source text; the catalogs translate it by exact-match key (see AGENTS.md i18n).
// teal = update the app, amber = transient / retryable, red = data or installation integrity.
type BlockedTone = 'teal' | 'amber' | 'red'

type BlockedGuidance = {
  tone: BlockedTone
  icon: LucideIcon
  why: string
  how: string
}

const BLOCKED_GUIDANCE: Partial<Record<DatabaseStartupErrorCode, BlockedGuidance>> = {
  database_newer_than_app: {
    tone: 'teal',
    icon: CircleArrowUp,
    why: "This data folder was last written by a newer release. Older builds can't safely read its newer format.",
    how: 'Update Open Science to the latest version, then relaunch. Your data is intact and will open in the newer version.'
  },
  database_history_invalid: {
    tone: 'red',
    icon: ShieldX,
    why: "The database's migration record doesn't match this app — the file may have been copied from another installation or modified outside the app.",
    how: "If you keep a backup of your data folder, restore it. Otherwise create an issue below — don't delete the database yourself."
  },
  database_validation_failed: {
    tone: 'red',
    icon: ShieldAlert,
    why: "Part of the stored data doesn't match the structure this version requires — usually left behind by an interrupted update.",
    how: "Make sure you're on the latest version and relaunch. If it persists, create an issue below."
  },
  database_runtime_unavailable: {
    tone: 'red',
    icon: Cpu,
    why: 'The database engine bundled with this app failed to load — the installation is usually incomplete or damaged.',
    how: "Reinstall Open Science. Your data folder is stored separately and won't be touched."
  },
  database_open_failed: {
    tone: 'amber',
    icon: Lock,
    why: "The database file couldn't be opened — it's often locked by another copy of the app, a full disk, or a read-only location.",
    how: 'Quit other copies of Open Science, check free disk space and folder permissions, then retry.'
  },
  database_migration_failed: {
    tone: 'amber',
    icon: RefreshCw,
    why: 'A database update was interrupted — usually by a full disk, a locked file, or a permissions issue. Your existing data was not reset.',
    how: 'Free up disk space and close other copies of the app, then retry — the update resumes safely from where it stopped.'
  },
  database_startup_unavailable: {
    tone: 'amber',
    icon: Unplug,
    why: "The background service that owns the database didn't respond in time — this is usually transient.",
    how: 'Retry. If it keeps happening, fully quit Open Science and start it again.'
  }
}

const TONE_CLASSES: Record<BlockedTone, string> = {
  teal: 'bg-[oklch(0.93_0.03_195)] text-[oklch(0.47_0.105_184)] dark:bg-[oklch(0.32_0.05_200)] dark:text-[oklch(0.72_0.1_184)]',
  amber:
    'bg-[oklch(0.94_0.045_85)] text-[oklch(0.52_0.11_65)] dark:bg-[oklch(0.32_0.05_75)] dark:text-[oklch(0.78_0.11_75)]',
  red: 'bg-[oklch(0.94_0.03_25)] text-[oklch(0.55_0.19_25)] dark:bg-[oklch(0.32_0.06_25)] dark:text-[oklch(0.72_0.16_25)]'
}

const DatabaseStartupGate = ({ children }: DatabaseStartupGateProps): React.JSX.Element => {
  const { t } = useTranslation()
  const databaseStartup = (window.api as Partial<Window['api']> | undefined)?.databaseStartup
  const [state, setState] = useState<DatabaseStartupState>(
    databaseStartup ? { phase: 'checking' } : { phase: 'ready' }
  )
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (!databaseStartup) return
    let disposed = false
    let receivedEvent = false
    const unsubscribe = databaseStartup.onStateChanged((next) => {
      receivedEvent = true
      if (!disposed) setState(next)
    })
    void databaseStartup
      .getState()
      .then((current) => {
        if (!disposed && !receivedEvent) setState(current)
      })
      .catch(() => {
        if (!disposed && !receivedEvent) setState(applyUnavailableStartupFallback)
      })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [databaseStartup])

  if (state.phase === 'ready') return <>{children}</>

  const retry = (): void => {
    if (!databaseStartup) return
    setRetrying(true)
    void databaseStartup
      .retry()
      .then(setState)
      .catch(() => {
        setState(restoreUnavailableUnlessReady)
      })
      .finally(() => setRetrying(false))
  }

  const openIssueDraft = (): void => {
    if (state.phase !== 'blocked') return
    window.open(buildStartupIssueUrl(state.error), '_blank', 'noreferrer')
  }

  if (state.phase !== 'blocked') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-background px-6"
        aria-live="polite"
      >
        <section className="flex w-full max-w-md flex-col items-center text-center">
          <div className="flex flex-col items-center gap-14">
            <OpenScienceLogoLoader />
            <div className="flex flex-col items-center gap-4">
              <h1 className="text-base font-medium text-foreground">
                {state.phase === 'migrating' ? t('Updating database…') : t('Checking database…')}
              </h1>
              {state.phase === 'migrating' ? (
                <p className="text-sm text-muted-foreground">
                  {t('Keep Open Science open while this finishes.')}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </main>
    )
  }

  const { error } = state
  const guidance = BLOCKED_GUIDANCE[error.code]
  const GuidanceIcon = guidance?.icon

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background px-6"
      aria-live="polite"
    >
      <section className="flex w-full max-w-md flex-col items-center gap-5">
        <img src={logo} alt={t('Open Science')} className="mb-1 h-auto w-1/2 dark:hidden" />
        <img
          src={logoDark}
          alt={t('Open Science')}
          className="mb-1 hidden h-auto w-1/2 dark:block"
        />

        <div className="flex w-full items-start gap-4">
          {GuidanceIcon && guidance ? (
            <div
              className={`flex size-11 shrink-0 items-center justify-center rounded-full ${TONE_CLASSES[guidance.tone]}`}
            >
              <GuidanceIcon className="size-5" strokeWidth={1.8} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 pt-0.5">
            <h1 className="text-lg font-semibold text-foreground">
              {t("Open Science couldn't start")}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">{t(error.message)}</p>
          </div>
        </div>

        <p className="w-full rounded-lg bg-muted px-3.5 py-2.5 text-center font-mono text-xs text-muted-foreground">
          {error.code}
          {error.migrationId ? ` · ${error.migrationId}` : ''}
        </p>

        {guidance ? (
          <div className="flex w-full flex-col gap-3.5 rounded-2xl bg-[#f1f0eb] p-5 dark:bg-[#24231e]">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t('Why this happened')}
              </p>
              <p className="text-[13px] leading-6 text-foreground/90">{t(guidance.why)}</p>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t('How to fix')}
              </p>
              <p className="text-[13px] leading-6 text-foreground/90">{t(guidance.how)}</p>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => void databaseStartup?.quit()}>
            {t('Quit')}
          </Button>
          {error.retryable ? (
            <Button onClick={retry} disabled={retrying}>
              {retrying ? t('Retrying…') : t('Retry')}
            </Button>
          ) : null}
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
                onClick={openIssueDraft}
              >
                <CircleQuestionMark className="size-3.5" />
                {t('Still stuck? Create an issue for help')}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {t(
                'Opens GitHub with a pre-filled issue: the error code, app version, and error stack. Personal paths are redacted (your home folder becomes ~). Please review before submitting — you can delete the stack section if you prefer.'
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </section>
    </main>
  )
}

export { DatabaseStartupGate }
