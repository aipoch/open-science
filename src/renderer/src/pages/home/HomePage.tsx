/* Hallmark · macrostructure: operational-home-dashboard · genre: modern-minimal · tone: quiet/technical · anchor: teal
 * pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: pass (40–41) · icons: pass (30)
 * slop: pass (42–49) · mobile: pass (34, 49, 50–57)
 */
import {
  Archive,
  Check,
  CircleAlert,
  Clock,
  GalleryVerticalEnd,
  LoaderCircle,
  MoreVertical,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { relativeTimeParts, type RelativeTimeUnit } from '@/lib/format-relative-time'
import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { LanguagePreferenceMenu } from '@/components/LanguageControls'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { NotificationBell } from '@/components/NotificationBell'
import { ProjectDeletionCleanupNotice } from '@/components/ProjectDeletionCleanupNotice'
import { ThemePreferenceMenu } from '@/components/ThemeControls'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { sessionWaitReasonLabelKeys } from '@/lib/session-wait-reason-labels'
import { APP } from '../../../../shared/app-config'
import { earliestCurrentDelegatedAttemptStartedAt } from '../../../../shared/delegated-work-projection'
import type { Project } from '../../../../shared/projects'
import type { EnvironmentCheckItem, EnvironmentCheckResult } from '../../../../shared/settings'
import { getEnvironmentRepairPanel } from '../settings/settings-navigation'
import {
  isSessionWaitReason,
  projectPresentedSessionActionability,
  type SessionWaitReason
} from '../workspace/session-wait-reason'

import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjectFormDialog } from './ProjectFormDialog'

const RECENT_SESSION_LIMIT = 5

// Compact labels for dense rows ("3d"), unlike the verbose wording in global search ("3 days ago").
// The unit is a runtime value, so it maps to its English text rather than being interpolated into a
// key. Every entry carries the 'ago' context: Chinese needs "3 天前" here, where the file browser's
// bare-age column says "3 天" for the same unit.
const COMPACT_ELAPSED = {
  minute: '{{count}}m',
  hour: '{{count}}h',
  day: '{{count}}d',
  week: '{{count}}w',
  month: '{{count}}mo',
  year: '{{count}}y'
} as const satisfies Record<Exclude<RelativeTimeUnit, 'now'>, string>

type ProjectSummary = {
  project: Project
  sessionCount: number
  runningCount: number
  waitingCount: number
  lastActivityAt: number
}

type HomeSessionActivity = 'running' | 'completed' | SessionWaitReason

const homeSessionWaitAriaLabelKeys = {
  'waiting-for-user': 'Open session {{title}}, waiting for your answer',
  'waiting-permission': 'Open session {{title}}, waiting for permission',
  'waiting-plan-approval': 'Open session {{title}}, waiting for plan approval'
} as const satisfies Record<SessionWaitReason, string>

type HomeSessionUpdate = {
  session: ChatSession
  activity: HomeSessionActivity
  activityTimestamp: number
}

type HomePageProps = {
  canDeleteProjects: boolean
  hasCompleteSessionCatalog: boolean
  catalogRecovery?: SessionCatalogRecovery
  onOpenGlobalSearch: () => void
}

const INCOMPLETE_PROJECT_SESSION_CATALOG_ERROR =
  'Cannot archive a Project while its Session catalog is incomplete.'

// Optional warnings (currently Python and reduced key protection) never create a Home alert. Only a
// failed check that blocks the core flow asks an existing user to revisit environment setup.
const getRequiredEnvironmentFailures = (
  environment: EnvironmentCheckResult | undefined
): EnvironmentCheckItem[] => environment?.checks.filter((check) => check.status === 'failed') ?? []

const getHomeSessionActivity = (
  session: ChatSession,
  hasNonTerminalCompute: boolean,
  credentialPending: boolean
): HomeSessionActivity | undefined => {
  const actionability = projectPresentedSessionActionability(session, { credentialPending })
  if (actionability.waitReason) return actionability.waitReason
  if (actionability.activity === 'running' || hasNonTerminalCompute) return 'running'
  return undefined
}

const getRunningActivityTimestamp = (session: ChatSession, computeStartedAt?: number): number => {
  const candidates = [
    session.status === 'running' ? session.activeRun?.startedAt : undefined,
    earliestCurrentDelegatedAttemptStartedAt(session),
    computeStartedAt
  ].filter((value): value is number => value !== undefined)
  return candidates.length > 0
    ? Math.min(...candidates)
    : (session.presentedActivityAt ?? session.updatedAt)
}

const sectionHeadingClassName =
  'mb-3 flex items-center gap-2 text-[17px] font-medium leading-6 text-text-000'

const listCardClassName = 'rounded-2xl bg-bg-000 p-1.5 shadow-card'

const rowClassName =
  'group flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-bg-300 sm:px-3'

const rowActionClassName =
  'shrink-0 rounded p-0.5 text-text-300 opacity-100 transition-[opacity,color,background-color] duration-150 ease-out hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 data-[state=open]:opacity-100'

const withSessionDescriptionTooltip = (
  description: string | undefined,
  trigger: React.JSX.Element
): React.JSX.Element => {
  const displayDescription = description?.trim()
  if (!displayDescription) return trigger

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent className="max-w-80 px-3 py-2 leading-5">
          {displayDescription}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Landing screen: pick a project or jump back into a recent session.
const HomePage = ({
  canDeleteProjects,
  hasCompleteSessionCatalog,
  catalogRecovery,
  onOpenGlobalSearch
}: HomePageProps): React.JSX.Element => {
  const { t } = useTranslation()
  const projects = useProjectStore((state) => state.projects)
  const loadError = useProjectStore((state) => state.loadError)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const updateProject = useProjectStore((state) => state.updateProject)
  const updateProjectArchive = useProjectStore((state) => state.updateProjectArchive)
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const sessions = useSessionStore((state) => state.sessions)
  const computeJobsById = useSessionJobStore((state) => state.nonTerminalJobsById)
  const notificationItems = useNotificationInboxStore((state) => state.items)
  const markSessionCompletionsRead = useNotificationInboxStore(
    (state) => state.markSessionCompletionsRead
  )
  const enqueueProjectArchive = useArchiveUndoStore((state) => state.enqueueProject)
  const openProject = useNavigationStore((state) => state.openProject)
  const openSession = useNavigationStore((state) => state.openSession)
  const pendingProjectCreation = useNavigationStore((state) => state.pendingProjectCreation)
  const consumeProjectCreation = useNavigationStore((state) => state.consumeProjectCreation)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)
  const pendingCredentialRequests = useSettingsStore((state) => state.pendingCredentialRequests)
  const requiredEnvironmentFailures = getRequiredEnvironmentFailures(environmentCheck)
  const environmentRepairPanel = getEnvironmentRepairPanel(requiredEnvironmentFailures)

  const {
    openCreateDialog,
    openEditDialog,
    dialogProps: projectFormDialogProps
  } = useProjectFormDialog()

  const [projectToDelete, setProjectToDelete] = useState<Project | undefined>(undefined)
  const [isDeletingProject, setIsDeletingProject] = useState(false)
  const [deleteProjectError, setDeleteProjectError] = useState<string | undefined>(undefined)
  const [archivingProjectIds, setArchivingProjectIds] = useState<Set<string>>(() => new Set())
  const [pinningProjectIds, setPinningProjectIds] = useState<Set<string>>(() => new Set())
  const [projectActionError, setProjectActionError] = useState<string | undefined>(undefined)
  const [isRetryingProjects, setIsRetryingProjects] = useState(false)
  const [artifactCounts, setArtifactCounts] = useState<Map<string, number>>(() => new Map())
  const [markingReadSessionIds, setMarkingReadSessionIds] = useState<Set<string>>(() => new Set())
  const [markReadErrorSessionIds, setMarkReadErrorSessionIds] = useState<Set<string>>(
    () => new Set()
  )
  const effectiveCatalogRecovery: SessionCatalogRecovery =
    catalogRecovery ??
    (hasCompleteSessionCatalog ? { kind: 'ready' } : { kind: 'repairable', reason: 'session-scan' })

  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === undefined),
    [projects]
  )
  const activeProjectIds = useMemo(
    () => new Set(activeProjects.map((project) => project.id)),
    [activeProjects]
  )

  // Non-pending sessions only; pending ones have no durable project yet.
  const persistedSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !session.isPending &&
          session.archivedAt === undefined &&
          activeProjectIds.has(session.projectId)
      ),
    [activeProjectIds, sessions]
  )

  const unreadCompletedBySession = useMemo(() => {
    const completedBySession = new Map<string, number>()

    for (const item of notificationItems) {
      if (item.kind !== 'task.completed' || item.readAt !== undefined || !item.sessionId) continue
      completedBySession.set(
        item.sessionId,
        Math.max(completedBySession.get(item.sessionId) ?? 0, item.createdAt)
      )
    }

    return completedBySession
  }, [notificationItems])

  const activeComputeStartedAtBySession = useMemo(() => {
    const startedAtBySession = new Map<string, number>()

    for (const job of computeJobsById.values()) {
      if (job.status !== 'queued' && job.status !== 'submitted' && job.status !== 'running')
        continue
      const startedAt = job.started_at ?? job.created_at
      startedAtBySession.set(
        job.session_id,
        Math.min(startedAtBySession.get(job.session_id) ?? startedAt, startedAt)
      )
    }

    return startedAtBySession
  }, [computeJobsById])

  const credentialPendingSessionIds = useMemo(
    () =>
      new Set(
        pendingCredentialRequests.flatMap((request) =>
          request.sessionId ? [request.sessionId] : []
        )
      ),
    [pendingCredentialRequests]
  )

  const sessionUpdates = useMemo<HomeSessionUpdate[]>(() => {
    const updates = persistedSessions.flatMap<HomeSessionUpdate>((session) => {
      const computeStartedAt = activeComputeStartedAtBySession.get(session.id)
      const activity = getHomeSessionActivity(
        session,
        computeStartedAt !== undefined,
        credentialPendingSessionIds.has(session.id)
      )

      if (activity) {
        return [
          {
            session,
            activity,
            activityTimestamp: isSessionWaitReason(activity)
              ? session.updatedAt
              : getRunningActivityTimestamp(session, computeStartedAt)
          }
        ]
      }

      const completed = unreadCompletedBySession.get(session.id)
      return session.status === 'idle' && completed !== undefined
        ? [
            {
              session,
              activity: 'completed',
              activityTimestamp: completed
            }
          ]
        : []
    })

    return updates.sort(
      (left, right) =>
        (isSessionWaitReason(left.activity) ? 0 : left.activity === 'running' ? 1 : 2) -
          (isSessionWaitReason(right.activity) ? 0 : right.activity === 'running' ? 1 : 2) ||
        right.activityTimestamp - left.activityTimestamp
    )
  }, [
    activeComputeStartedAtBySession,
    credentialPendingSessionIds,
    persistedSessions,
    unreadCompletedBySession
  ])

  const activeSessionCounts = useMemo(
    () => ({
      running: sessionUpdates.filter(({ activity }) => activity === 'running').length,
      waiting: sessionUpdates.filter(({ activity }) => isSessionWaitReason(activity)).length
    }),
    [sessionUpdates]
  )
  const projectNames = useMemo(
    () => new Map(activeProjects.map((project) => [project.id, project.name])),
    [activeProjects]
  )

  // Per-project session and activity counts, ordered by most recent activity.
  const projectSummaries = useMemo<ProjectSummary[]>(() => {
    const summaries = activeProjects.map((project) => {
      const projectSessions = persistedSessions.filter(
        (session) => session.projectId === project.id
      )
      const lastActivityAt = projectSessions.reduce(
        (latest, session) => Math.max(latest, session.updatedAt),
        project.updatedAt
      )

      return {
        project,
        sessionCount: projectSessions.length,
        runningCount: projectSessions.filter(
          (session) =>
            getHomeSessionActivity(
              session,
              activeComputeStartedAtBySession.has(session.id),
              credentialPendingSessionIds.has(session.id)
            ) === 'running'
        ).length,
        waitingCount: projectSessions.filter((session) => {
          const activity = getHomeSessionActivity(
            session,
            activeComputeStartedAtBySession.has(session.id),
            credentialPendingSessionIds.has(session.id)
          )
          return activity !== undefined && isSessionWaitReason(activity)
        }).length,
        lastActivityAt
      }
    })

    return summaries.sort(
      (left, right) =>
        Number(Boolean(right.project.pinned)) - Number(Boolean(left.project.pinned)) ||
        right.lastActivityAt - left.lastActivityAt
    )
  }, [
    activeComputeStartedAtBySession,
    activeProjects,
    credentialPendingSessionIds,
    persistedSessions
  ])

  const recentSessions = useMemo(
    () =>
      [...persistedSessions]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, RECENT_SESSION_LIMIT),
    [persistedSessions]
  )

  const showArtifactCounts = hasCompleteSessionCatalog && recentSessions.length === 0

  useEffect(() => {
    let cancelled = false
    const activeProjectIds = new Set(activeProjects.map((project) => project.id))
    const requestVersions = new Map<string, number>()

    if (!showArtifactCounts) return

    const refreshArtifactCount = async (projectId: string): Promise<void> => {
      const requestVersion = (requestVersions.get(projectId) ?? 0) + 1
      requestVersions.set(projectId, requestVersion)

      let artifactCount: number | undefined
      try {
        const overview = await window.api.projectFiles.getOverview({ projectId })
        if (overview.isIndexComplete) artifactCount = overview.artifactCount
      } catch {
        // An unavailable or incomplete index is not authoritative, so omit its count.
      }

      if (cancelled || requestVersions.get(projectId) !== requestVersion) return
      setArtifactCounts((current) => {
        const next = new Map(current)
        if (artifactCount === undefined) next.delete(projectId)
        else next.set(projectId, artifactCount)
        return next
      })
    }

    for (const project of activeProjects) void refreshArtifactCount(project.id)

    const removeChangedListener = window.api.projectFiles.onChanged((event) => {
      if (activeProjectIds.has(event.projectId)) void refreshArtifactCount(event.projectId)
    })

    return () => {
      cancelled = true
      removeChangedListener()
    }
  }, [activeProjects, showArtifactCounts])

  const deleteTargetSessionCount = useMemo(
    () =>
      projectToDelete
        ? persistedSessions.filter((session) => session.projectId === projectToDelete.id).length
        : 0,
    [persistedSessions, projectToDelete]
  )

  useEffect(() => {
    if (!pendingProjectCreation) return
    queueMicrotask(() => {
      openCreateDialog()
      consumeProjectCreation()
    })
  }, [consumeProjectCreation, openCreateDialog, pendingProjectCreation])

  const retryProjectLoad = (): void => {
    if (isRetryingProjects) return

    setIsRetryingProjects(true)
    void loadProjects().finally(() => setIsRetryingProjects(false))
  }

  const openDeleteDialog = (project: Project): void => {
    if (!canDeleteProjects) return

    setDeleteProjectError(undefined)
    setProjectToDelete(project)
  }

  const closeDeleteDialog = (): void => {
    if (isDeletingProject) return

    setProjectToDelete(undefined)
    setDeleteProjectError(undefined)
  }

  const canArchiveProject = (project: Project): boolean =>
    hasCompleteSessionCatalog &&
    canDeleteProjects &&
    project.archivedAt === undefined &&
    !sessions.some(
      (session) =>
        session.projectId === project.id &&
        getHomeSessionActivity(
          session,
          activeComputeStartedAtBySession.has(session.id),
          credentialPendingSessionIds.has(session.id)
        ) !== undefined
    )

  const archiveUnavailableReason = (project: Project): string | undefined => {
    if (!canDeleteProjects) return t('Retry project recovery before archiving.')
    if (!hasCompleteSessionCatalog) {
      if (effectiveCatalogRecovery.kind === 'damaged-authority') {
        return t(
          'Project archive is unavailable because a damaged conversation cannot be verified.'
        )
      }
      if (effectiveCatalogRecovery.kind === 'unsupported-version') {
        return t('Update Open Science before archiving this project.')
      }
      return t('Repair the project index before archiving.')
    }
    if (!canArchiveProject(project)) {
      return t('Finish or stop active sessions before archiving this project.')
    }
    return undefined
  }

  const archiveProject = (project: Project): void => {
    if (!canArchiveProject(project) || archivingProjectIds.has(project.id)) return

    setArchivingProjectIds((current) => new Set(current).add(project.id))
    setProjectActionError(undefined)
    void updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
      .then((archived) => enqueueProjectArchive(archived))
      .catch((error: unknown) =>
        setProjectActionError(
          error instanceof Error && error.message.includes(INCOMPLETE_PROJECT_SESSION_CATALOG_ERROR)
            ? t('Repair the project index before archiving.')
            : error instanceof Error
              ? error.message
              : t('Could not archive project.')
        )
      )
      .finally(() => {
        setArchivingProjectIds((current) => {
          const next = new Set(current)
          next.delete(project.id)
          return next
        })
      })
  }

  const dismissCompletedSession = async (sessionId: string): Promise<void> => {
    if (markingReadSessionIds.has(sessionId)) return

    setMarkingReadSessionIds((current) => new Set(current).add(sessionId))
    setMarkReadErrorSessionIds((current) => {
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
    try {
      await markSessionCompletionsRead([sessionId])
    } catch {
      setMarkReadErrorSessionIds((current) => new Set(current).add(sessionId))
    } finally {
      setMarkingReadSessionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
    }
  }

  const toggleProjectPin = (project: Project): void => {
    if (pinningProjectIds.has(project.id)) return

    setPinningProjectIds((current) => new Set(current).add(project.id))
    setProjectActionError(undefined)
    void updateProject({
      id: project.id,
      pinned: !project.pinned,
      expectedUpdatedAt: project.updatedAt
    })
      .catch((error: unknown) =>
        setProjectActionError(
          error instanceof Error ? error.message : t('Could not update project pin.')
        )
      )
      .finally(() => {
        setPinningProjectIds((current) => {
          const next = new Set(current)
          next.delete(project.id)
          return next
        })
      })
  }

  // Main coordinates durable project/session/index cleanup; renderer state changes only after it succeeds.
  const confirmDeleteProject = (): void => {
    if (!canDeleteProjects || !projectToDelete || isDeletingProject) return

    const projectId = projectToDelete.id

    // Deletion is an explicit user takeover even though it does not immediately navigate. Advance
    // the navigation revision before the async mutation so deferred startup intents cannot reopen a
    // conversation after the post-delete view has settled.
    useNavigationStore.getState().recordUserNavigation()
    setIsDeletingProject(true)
    setDeleteProjectError(undefined)

    void deleteProject(projectId)
      .then(() => {
        useSessionStore.getState().removeSessionsForProject(projectId)
        setProjectToDelete(undefined)
      })
      .catch((error: unknown) => {
        // Durable deletion failed; keep the target and in-memory sessions visible so the user can
        // inspect the failure and retry or cancel explicitly.
        console.warn('Project deletion failed', error)
        setDeleteProjectError(t('Could not delete the project. Please try again.'))
      })
      .finally(() => {
        setIsDeletingProject(false)
      })
  }

  // The bucket comes from a pure helper; the wording is per-locale ("3d" vs "3 天前").
  const relativeTime = (timestamp: number): string => {
    const { unit, count } = relativeTimeParts(timestamp)
    return unit === 'now' ? t('now') : t(COMPACT_ELAPSED[unit], { count, context: 'ago' })
  }

  return (
    <main className="h-svh overflow-y-auto bg-bg-10 text-text-000">
      <div className="mx-auto max-w-[1080px] px-4 py-5 pb-12 sm:px-8 sm:py-7 sm:pb-16">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <a
                href={APP.links.website}
                target="_blank"
                rel="noreferrer"
                className="font-serif text-[26px] font-medium leading-none tracking-[-0.02em] text-text-000 transition-colors duration-150 ease-out hover:text-text-100"
              >
                Open Science
              </a>
              {hasCompleteSessionCatalog &&
              (activeSessionCounts.waiting > 0 || activeSessionCounts.running > 0) ? (
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {activeSessionCounts.waiting > 0 ? (
                    <span className="text-session-waiting">
                      {t('{{count}} waiting on you', { count: activeSessionCounts.waiting })}
                    </span>
                  ) : null}
                  {activeSessionCounts.waiting > 0 && activeSessionCounts.running > 0 ? (
                    <span className="text-text-300" aria-hidden="true">
                      ·
                    </span>
                  ) : null}
                  {activeSessionCounts.running > 0 ? (
                    <span className="text-session-running">
                      {t('{{count}} running', { count: activeSessionCounts.running })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{t('Beta')}</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
            {requiredEnvironmentFailures.length > 0 && environmentRepairPanel ? (
              <button
                type="button"
                onClick={() => openSettingsToPanel(environmentRepairPanel)}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-danger-000/35 bg-danger-900 px-2.5 text-xs font-medium text-danger-000 transition-colors duration-150 ease-out hover:border-danger-000/55 hover:bg-danger-900/80"
                aria-label={t('Open environment repair')}
              >
                <CircleAlert className="size-3.5" strokeWidth={2} aria-hidden="true" />
                <span className="hidden sm:inline">
                  {requiredEnvironmentFailures.length === 1
                    ? t('{{label}} needs attention', {
                        label: requiredEnvironmentFailures[0].label
                      })
                    : t('{{count}} environment items need attention', {
                        count: requiredEnvironmentFailures.length
                      })}
                </span>
                <span className="sm:hidden">{t('Environment')}</span>
              </button>
            ) : null}
            <NetworkStatusIndicator variant="pill" />
            <span className="hidden sm:inline-flex">
              <GitHubStarBadge variant="home" />
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 rounded-lg text-text-300"
              onClick={onOpenGlobalSearch}
              aria-label={t('Search')}
              title={t('Search (Cmd/Ctrl+K)')}
            >
              <Search className="size-4" strokeWidth={2} aria-hidden="true" />
            </Button>
            <LanguagePreferenceMenu />
            <ThemePreferenceMenu />
            <NotificationBell />
            <button
              type="button"
              aria-label={t('Model settings')}
              onClick={openSettings}
              className="inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000"
            >
              <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <UpdateCapsule />
            {/* Account button hidden for now; restore when the account flow lands. */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 rounded-md px-3 text-xs"
              onClick={openCreateDialog}
              aria-label={t('New project')}
            >
              <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
              <span className="hidden sm:inline">{t('New project')}</span>
            </Button>
          </div>
        </header>

        {sessionUpdates.length > 0 ? (
          <section className="mt-8 sm:mt-10" aria-label={t('Session updates')}>
            <div className="grid grid-cols-1 gap-3 py-1 md:grid-cols-2">
              {sessionUpdates.map(({ session, activity, activityTimestamp }) => {
                const waitReason = isSessionWaitReason(activity) ? activity : undefined
                const waiting = waitReason !== undefined
                const completed = activity === 'completed'
                // A finished session reads "just now" rather than the bare bucket, so the two cases
                // stay separate keys instead of being assembled from a translated fragment.
                const isJustNow = relativeTimeParts(activityTimestamp).unit === 'now'
                const relativeActivityTime = relativeTime(activityTimestamp)
                const markingRead = markingReadSessionIds.has(session.id)
                const markReadFailed = markReadErrorSessionIds.has(session.id)

                return (
                  <div key={session.id} className="home-session-card group relative min-w-0">
                    {withSessionDescriptionTooltip(
                      session.description,
                      <button
                        type="button"
                        // Fixed height sized to the tallest content (status row + title +
                        // two-line description, ~154px); cards without a description keep the
                        // height and mt-auto sinks the project line.
                        className="flex h-[156px] w-full min-w-0 cursor-pointer flex-col rounded-2xl bg-bg-000 pb-3 px-[18px] pt-4 text-left shadow-card transition-colors duration-150 ease-out hover:bg-bg-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-bg-300 motion-reduce:transition-none"
                        onClick={() => openSession(session.projectId, session.id, 'user')}
                        aria-label={
                          waitReason
                            ? t(homeSessionWaitAriaLabelKeys[waitReason], { title: session.title })
                            : completed
                              ? t('Open session {{title}}, completed', { title: session.title })
                              : t('Open session {{title}}, running', { title: session.title })
                        }
                      >
                        {/* Status leads the card — the Home grid answers "what needs me" at a glance. */}
                        <span className="flex w-full items-center justify-between gap-3">
                          <span
                            className={cn(
                              'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                              waiting
                                ? 'bg-session-waiting/10 text-session-waiting'
                                : completed
                                  ? 'bg-success-000/10 text-success-000'
                                  : 'bg-session-running/10 text-session-running'
                            )}
                          >
                            {completed ? (
                              <Check className="size-3" strokeWidth={2} aria-hidden="true" />
                            ) : waiting ? (
                              <span
                                className="size-1.5 rounded-full bg-session-waiting motion-safe:animate-pulse"
                                aria-hidden="true"
                              />
                            ) : (
                              <LoaderCircle
                                className="size-3.5 animate-spin motion-reduce:animate-none"
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                            )}
                            {t(
                              waitReason
                                ? sessionWaitReasonLabelKeys[waitReason]
                                : completed
                                  ? 'Completed'
                                  : 'Running'
                            )}
                          </span>
                          {/* Flush right on every card — a reserved dismiss gap leaves the time
                              floating left of where a long truncated title ends. */}
                          <span className="shrink-0 text-xs text-text-100">
                            {completed
                              ? isJustNow
                                ? t('just now')
                                : relativeActivityTime
                              : waiting
                                ? t('waiting {{time}}', { time: relativeActivityTime })
                                : t('running {{time}}', { time: relativeActivityTime })}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'mt-2.5 min-w-0 max-w-full truncate text-base font-semibold text-text-000',
                            !waiting && !completed && 'home-session-title-running'
                          )}
                        >
                          {session.title}
                        </span>
                        {session.description?.trim() ? (
                          <span
                            data-testid="session-description-preview"
                            className="mt-1.5 line-clamp-2 break-words text-xs leading-[1.4] text-text-300"
                          >
                            {session.description.trim()}
                          </span>
                        ) : null}
                        <span className="mt-auto w-full truncate pt-3 text-xs text-text-100">
                          {projectNames.get(session.projectId) ?? t('Unknown project')}
                        </span>
                      </button>
                    )}
                    {completed ? (
                      <button
                        type="button"
                        className={cn(
                          "home-session-dismiss absolute top-3 right-3 inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-300 transition-[opacity,color,background-color] duration-150 ease-out before:absolute before:-inset-1 before:content-[''] hover:bg-bg-300 hover:text-text-000 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-bg-400 disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none",
                          markReadFailed && 'text-danger-000'
                        )}
                        onClick={() => void dismissCompletedSession(session.id)}
                        disabled={markingRead}
                        aria-busy={markingRead}
                        aria-label={
                          markReadFailed
                            ? t('Retry marking completed session {{title}} as read', {
                                title: session.title
                              })
                            : t('Mark completed session {{title}} as read', {
                                title: session.title
                              })
                        }
                        title={markReadFailed ? t('Could not mark as read. Try again.') : undefined}
                      >
                        {markingRead ? (
                          <LoaderCircle
                            className="size-4 animate-spin motion-reduce:animate-none"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        ) : (
                          <X className="size-4" strokeWidth={2} aria-hidden="true" />
                        )}
                        {markReadFailed ? (
                          <span className="sr-only" role="alert">
                            {t('Could not mark this completed session as read. Try again.')}
                          </span>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        <div
          className={cn(
            'grid grid-cols-1 gap-7 sm:gap-8 lg:grid-cols-2',
            sessionUpdates.length > 0 ? 'mt-8' : 'mt-8 sm:mt-10'
          )}
        >
          <section className="min-w-0" aria-label={t('Projects')}>
            <h2 className={sectionHeadingClassName}>
              <GalleryVerticalEnd
                className="size-4 text-text-100"
                strokeWidth={2}
                aria-hidden="true"
              />
              {t('Projects')}
            </h2>
            {projectActionError ? (
              <div
                className="mb-3 rounded-2xl border border-danger-000/30 px-4 py-3 text-sm text-danger-000"
                role="alert"
              >
                {projectActionError}
              </div>
            ) : null}
            <ProjectDeletionCleanupNotice className="mb-3 rounded-2xl px-4 py-3" />
            {loadError ? (
              <div
                className="rounded-2xl border border-danger-000/30 px-4 py-6 text-center text-sm text-danger-000"
                role="alert"
              >
                <p>{t('Open Science could not load projects. Retry to continue.')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={isRetryingProjects}
                  onClick={retryProjectLoad}
                >
                  {isRetryingProjects ? t('Retrying...') : t('Retry')}
                </Button>
              </div>
            ) : projectSummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-muted-foreground">
                {t('No projects yet. Create one to get started.')}
              </div>
            ) : (
              <div className={listCardClassName}>
                {projectSummaries.map(
                  ({ project, sessionCount, runningCount, waitingCount, lastActivityAt }) => (
                    <div
                      key={project.id}
                      className={rowClassName}
                      title={project.description || project.name}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                        onClick={() => openProject(project.id, 'user')}
                      >
                        <span className="min-w-0 truncate font-semibold text-text-000">
                          {project.name}
                        </span>
                        {project.pinned ? (
                          <>
                            <Star
                              className="size-4 shrink-0 fill-current text-session-waiting"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                            <span className="sr-only">{t('Pinned project')}</span>
                          </>
                        ) : null}
                        {project.isExample ? (
                          <span className="shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-[10px] font-medium text-text-100">
                            {t('Example')}
                          </span>
                        ) : null}
                        {hasCompleteSessionCatalog && waitingCount > 0 ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-session-waiting"
                            aria-label={t('{{count}} waiting on you', { count: waitingCount })}
                          >
                            <span
                              className="size-1.5 rounded-full bg-session-waiting motion-safe:animate-pulse"
                              aria-hidden="true"
                            />
                            <span aria-hidden="true">{waitingCount}</span>
                          </span>
                        ) : null}
                        {hasCompleteSessionCatalog && runningCount > 0 ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-session-running"
                            aria-label={t('{{count}} running', { count: runningCount })}
                          >
                            <LoaderCircle
                              className="size-3 animate-spin motion-reduce:animate-none"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                            <span aria-hidden="true">{runningCount}</span>
                          </span>
                        ) : null}
                      </button>
                      <span className="hidden shrink-0 text-xs text-text-100 sm:inline">
                        {hasCompleteSessionCatalog
                          ? t('{{count}} sessions', {
                              defaultValue_one: '{{count}} session',
                              count: sessionCount
                            })
                          : t('Session count unavailable')}
                      </span>
                      {showArtifactCounts && artifactCounts.has(project.id) ? (
                        <span className="hidden shrink-0 tabular-nums text-xs text-text-100 sm:inline">
                          {t('{{count}} artifacts', {
                            defaultValue_one: '{{count}} artifact',
                            count: artifactCounts.get(project.id)
                          })}
                        </span>
                      ) : null}
                      <span className="hidden w-8 shrink-0 text-right text-xs text-text-000 sm:inline">
                        {relativeTime(lastActivityAt)}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={rowActionClassName}
                            aria-label={t('Open actions for {{name}}', { name: project.name })}
                          >
                            <MoreVertical className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          aria-label={t('Project actions')}
                          className="w-max min-w-0"
                          align="end"
                          sideOffset={6}
                        >
                          <DropdownMenuItem
                            className="gap-2"
                            disabled={pinningProjectIds.has(project.id)}
                            onSelect={() => toggleProjectPin(project)}
                          >
                            <Star
                              className={cn('size-4', project.pinned && 'fill-current')}
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                            {t(project.pinned ? 'Unpin project' : 'Pin project')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2"
                            onSelect={() => openEditDialog(project)}
                          >
                            <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                            {t('Settings')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2"
                            disabled={
                              !canArchiveProject(project) || archivingProjectIds.has(project.id)
                            }
                            title={archiveUnavailableReason(project)}
                            onSelect={() => archiveProject(project)}
                          >
                            <Archive className="size-4" strokeWidth={2} aria-hidden="true" />
                            {/* The verb. Bare 'Archive' is the noun (a .zip) in the file browser. */}
                            {archivingProjectIds.has(project.id)
                              ? t('Archiving…')
                              : t('Archive', { context: 'verb' })}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="gap-2 text-danger-000 data-[highlighted]:bg-danger-900 data-[highlighted]:text-danger-000"
                            disabled={!canDeleteProjects}
                            title={
                              canDeleteProjects
                                ? undefined
                                : t('Retry project recovery before deleting projects.')
                            }
                            onSelect={() => openDeleteDialog(project)}
                          >
                            <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                            {t('Delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                )}
              </div>
            )}
          </section>

          <section className="min-w-0" aria-label={t('Recent sessions')}>
            <h2 className={sectionHeadingClassName}>
              <Clock className="size-4 text-text-100" strokeWidth={2} aria-hidden="true" />
              {t('Recent sessions')}
            </h2>
            {recentSessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-muted-foreground">
                {t('Sessions you start will appear here.')}
              </div>
            ) : (
              <div className={listCardClassName}>
                {recentSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={cn(rowClassName, 'cursor-pointer items-start')}
                    onClick={() => openSession(session.projectId, session.id, 'user')}
                    title={session.title}
                  >
                    <span
                      className="mt-1 inline-flex size-3 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <span className="size-[7px] rounded-full border border-text-100" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-text-000">
                        {session.title}
                      </span>
                      <span className="truncate text-xs text-text-100">
                        {projectNames.get(session.projectId) ?? t('Unknown project')}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-text-000">
                      {relativeTime(session.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <ProjectFormDialog {...projectFormDialogProps} />

      <DeleteProjectDialog
        project={projectToDelete}
        sessionCount={deleteTargetSessionCount}
        hasCompleteSessionCatalog={hasCompleteSessionCatalog}
        canDelete={canDeleteProjects}
        isDeleting={isDeletingProject}
        error={deleteProjectError}
        onCancel={closeDeleteDialog}
        onConfirmDelete={confirmDeleteProject}
      />
    </main>
  )
}

export { HomePage }
