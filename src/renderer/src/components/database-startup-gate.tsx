import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleArrowUp,
  Cpu,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldX,
  Unplug,
  type LucideIcon
} from 'lucide-react'

import { ErrorNotice, type ErrorNoticeTone } from '@/components/error-notice'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { openStartupIssueDraft } from '@/lib/startup-issue'
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
type BlockedGuidance = {
  tone: ErrorNoticeTone
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
    how: "If you keep a backup of your data folder, restore it. Otherwise create an issue below with the error code — don't delete the database yourself."
  },
  database_validation_failed: {
    tone: 'red',
    icon: ShieldAlert,
    why: "Part of the stored data doesn't match the structure this version requires — usually left behind by an interrupted update.",
    how: "Make sure you're on the latest version and relaunch. If it persists, create an issue below with the error code."
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
    openStartupIssueDraft(state.error)
  }

  if (state.phase !== 'blocked') {
    return (
      <main
        role="status"
        className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground"
      >
        <section className="flex w-full max-w-md flex-col items-center text-center">
          <div className="flex flex-col items-center gap-14">
            <OpenScienceLogoLoader />
            <div className="flex flex-col items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {state.phase === 'migrating'
                  ? t('Updating database…')
                  : state.phase === 'starting'
                    ? t('Starting Open Science…')
                    : t('Checking database…')}
              </span>
              {state.phase === 'migrating' || state.phase === 'starting' ? (
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

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background px-6"
      aria-live="polite"
    >
      <ErrorNotice
        icon={guidance?.icon}
        tone={guidance?.tone}
        title={t("Open Science couldn't start")}
        description={t(error.message)}
        errorCode={error.migrationId ? `${error.code} · ${error.migrationId}` : error.code}
        help={
          guidance
            ? {
                whyLabel: t('Why this happened'),
                why: t(guidance.why),
                howLabel: t('How to fix'),
                how: t(guidance.how)
              }
            : undefined
        }
        issueLink={{
          label: t('Still stuck? Create an issue for help'),
          tooltip: t(
            'Opens GitHub with a pre-filled issue: the error code, app version, and error stack. Personal paths are redacted (your home folder becomes ~). Please review before submitting — you can delete the stack section if you prefer.'
          ),
          onClick: openIssueDraft
        }}
        secondaryButton={{
          label: t('Quit', { context: 'verb', ns: 'common' }),
          onClick: () => void databaseStartup?.quit()
        }}
        primaryButton={
          error.retryable
            ? {
                label: retrying ? t('Retrying…') : t('Retry'),
                onClick: retry,
                loading: retrying
              }
            : undefined
        }
      />
    </main>
  )
}

export { DatabaseStartupGate }
