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

import { formatRelativeTime } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { useSettingsStore } from '@/stores/settings-store'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { NotificationBell } from '@/components/NotificationBell'
import { ThemePreferenceMenu } from '@/components/ThemeControls'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { APP } from '../../../../shared/app-config'
import type { Project } from '../../../../shared/projects'
import type { EnvironmentCheckItem, EnvironmentCheckResult } from '../../../../shared/settings'
import { getEnvironmentRepairPanel } from '../settings/settings-navigation'

import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjectFormDialog } from './ProjectFormDialog'

const RECENT_SESSION_LIMIT = 5

type ProjectSummary = {
  project: Project
  sessionCount: number
  runningCount: number
  needsYouCount: number
  lastActivityAt: number
}

type HomeSessionActivity = 'running' | 'needs-you' | 'completed'

type HomeSessionUpdate = {
  session: ChatSession
  activity: HomeSessionActivity
  activityTimestamp: number
}

type ProjectFormState = { mode: 'create' } | { mode: 'edit'; projectId: string }

type HomePageProps = {
  canDeleteProjects: boolean
  hasCompleteSessionCatalog: boolean
  onOpenGlobalSearch: () => void
}

// Optional warnings (currently Python and reduced key protection) never create a Home alert. Only a
// failed check that blocks the core flow asks an existing user to revisit environment setup.
const getRequiredEnvironmentFailures = (
  environment: EnvironmentCheckResult | undefined
): EnvironmentCheckItem[] => environment?.checks.filter((check) => check.status === 'failed') ?? []

const getHomeSessionActivity = (session: ChatSession): HomeSessionActivity | undefined => {
  if (session.status === 'running') return 'running'
  if (
    session.status === 'waiting-for-user' ||
    session.status === 'waiting-permission' ||
    session.status === 'waiting-plan-approval'
  ) {
    return 'needs-you'
  }
  return undefined
}

const sectionHeadingClassName =
  'mb-3 flex items-center gap-2 text-[17px] font-medium leading-6 text-text-000'

const listCardClassName = 'rounded-2xl bg-bg-000 p-1.5 shadow-card'

const rowClassName =
  'group flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-bg-300 sm:px-3'

const rowActionClassName =
  'shrink-0 rounded p-0.5 text-text-300 opacity-100 transition-[opacity,color,background-color] duration-150 ease-out hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 data-[state=open]:opacity-100'

// Landing screen: pick a project or jump back into a recent session.
const HomePage = ({
  canDeleteProjects,
  hasCompleteSessionCatalog,
  onOpenGlobalSearch
}: HomePageProps): React.JSX.Element => {
  const projects = useProjectStore((state) => state.projects)
  const loadError = useProjectStore((state) => state.loadError)
  const createProject = useProjectStore((state) => state.createProject)
  const updateProject = useProjectStore((state) => state.updateProject)
  const updateProjectArchive = useProjectStore((state) => state.updateProjectArchive)
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const sessions = useSessionStore((state) => state.sessions)
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
  const requiredEnvironmentFailures = getRequiredEnvironmentFailures(environmentCheck)
  const environmentRepairPanel = getEnvironmentRepairPanel(requiredEnvironmentFailures)

  const [formState, setFormState] = useState<ProjectFormState | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [projectToDelete, setProjectToDelete] = useState<Project | undefined>(undefined)
  const [isDeletingProject, setIsDeletingProject] = useState(false)
  const [deleteProjectError, setDeleteProjectError] = useState<string | undefined>(undefined)
  const [archivingProjectIds, setArchivingProjectIds] = useState<Set<string>>(() => new Set())
  const [pinningProjectIds, setPinningProjectIds] = useState<Set<string>>(() => new Set())
  const [projectActionError, setProjectActionError] = useState<string | undefined>(undefined)
  const [artifactCounts, setArtifactCounts] = useState<Map<string, number>>(() => new Map())
  const [markingReadSessionIds, setMarkingReadSessionIds] = useState<Set<string>>(() => new Set())
  const [markReadErrorSessionIds, setMarkReadErrorSessionIds] = useState<Set<string>>(
    () => new Set()
  )

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

  const sessionUpdates = useMemo<HomeSessionUpdate[]>(() => {
    const updates = persistedSessions.flatMap<HomeSessionUpdate>((session) => {
      const activity = getHomeSessionActivity(session)

      if (activity) {
        return [
          {
            session,
            activity,
            activityTimestamp:
              activity === 'needs-you'
                ? session.updatedAt
                : (session.activeRun?.startedAt ?? session.updatedAt)
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

    const activityOrder: HomeSessionActivity[] = ['needs-you', 'running', 'completed']
    return updates.sort(
      (left, right) =>
        activityOrder.indexOf(left.activity) - activityOrder.indexOf(right.activity) ||
        right.activityTimestamp - left.activityTimestamp
    )
  }, [persistedSessions, unreadCompletedBySession])

  const activeSessionCounts = useMemo(
    () => ({
      running: sessionUpdates.filter(({ activity }) => activity === 'running').length,
      needsYou: sessionUpdates.filter(({ activity }) => activity === 'needs-you').length
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
          (session) => getHomeSessionActivity(session) === 'running'
        ).length,
        needsYouCount: projectSessions.filter(
          (session) => getHomeSessionActivity(session) === 'needs-you'
        ).length,
        lastActivityAt
      }
    })

    return summaries.sort(
      (left, right) =>
        Number(Boolean(right.project.pinned)) - Number(Boolean(left.project.pinned)) ||
        right.lastActivityAt - left.lastActivityAt
    )
  }, [activeProjects, persistedSessions])

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

  const openCreateDialog = (): void => {
    setFormState({ mode: 'create' })
    setNameDraft('')
    setDescriptionDraft('')
    setFormError(undefined)
  }

  useEffect(() => {
    if (!pendingProjectCreation) return
    queueMicrotask(() => {
      setFormState({ mode: 'create' })
      setNameDraft('')
      setDescriptionDraft('')
      setFormError(undefined)
      consumeProjectCreation()
    })
  }, [consumeProjectCreation, pendingProjectCreation])

  const openEditDialog = (project: Project): void => {
    setFormState({ mode: 'edit', projectId: project.id })
    setNameDraft(project.name)
    setDescriptionDraft(project.description)
    setFormError(undefined)
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
        (session.status === 'running' ||
          session.status === 'waiting-for-user' ||
          session.status === 'waiting-permission' ||
          session.status === 'waiting-plan-approval')
    )

  const archiveProject = (project: Project): void => {
    if (!canArchiveProject(project) || archivingProjectIds.has(project.id)) return

    setArchivingProjectIds((current) => new Set(current).add(project.id))
    setProjectActionError(undefined)
    void updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
      .then((archived) => enqueueProjectArchive(archived))
      .catch((error: unknown) =>
        setProjectActionError(error instanceof Error ? error.message : 'Could not archive project.')
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
    void updateProject({ id: project.id, pinned: !project.pinned })
      .catch((error: unknown) =>
        setProjectActionError(
          error instanceof Error ? error.message : 'Could not update project pin.'
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

  const closeFormDialog = (): void => {
    if (isSubmitting) return

    setFormState(null)
  }

  // Creates or renames a project. On create, navigate into the new (empty) workspace. Failures keep the
  // dialog open with an inline message instead of an unhandled rejection.
  const confirmForm = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const name = nameDraft.trim()

    if (!formState || !name || isSubmitting) return

    const description = descriptionDraft.trim()
    const isCreate = formState.mode === 'create'

    setIsSubmitting(true)
    setFormError(undefined)

    const request = isCreate
      ? createProject({ name, description })
      : updateProject({ id: formState.projectId, name, description })

    void request
      .then((project) => {
        if (!project) return

        setFormState(null)

        if (isCreate) openProject(project.id, 'user')
      })
      .catch((error: unknown) => {
        setFormError(error instanceof Error ? error.message : 'Could not save project.')
      })
      .finally(() => {
        setIsSubmitting(false)
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
        setDeleteProjectError(
          error instanceof Error ? error.message : 'Could not delete the project. Please try again.'
        )
      })
      .finally(() => {
        setIsDeletingProject(false)
      })
  }

  const formTitle = formState?.mode === 'edit' ? 'Project Settings' : 'New project'
  const formDescription =
    formState?.mode === 'edit'
      ? 'Update this project’s name and description.'
      : 'Group related sessions under a project. You can rename it later.'
  const formSubmitLabel = formState?.mode === 'edit' ? 'Save' : 'Create project'

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
              (activeSessionCounts.needsYou > 0 || activeSessionCounts.running > 0) ? (
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {activeSessionCounts.needsYou > 0 ? (
                    <span className="text-session-waiting">
                      {activeSessionCounts.needsYou} waiting on you
                    </span>
                  ) : null}
                  {activeSessionCounts.needsYou > 0 && activeSessionCounts.running > 0 ? (
                    <span className="text-text-300" aria-hidden="true">
                      ·
                    </span>
                  ) : null}
                  {activeSessionCounts.running > 0 ? (
                    <span className="text-session-running">
                      {activeSessionCounts.running} running
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">Beta</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
            <UpdateCapsule />
            {requiredEnvironmentFailures.length > 0 && environmentRepairPanel ? (
              <button
                type="button"
                onClick={() => openSettingsToPanel(environmentRepairPanel)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-000/35 bg-danger-900 px-2.5 text-xs font-medium text-danger-000 transition-colors duration-150 ease-out hover:border-danger-000/55 hover:bg-danger-900/80"
                aria-label="Open environment repair"
              >
                <CircleAlert className="size-3.5" strokeWidth={2} aria-hidden="true" />
                <span className="hidden sm:inline">
                  {requiredEnvironmentFailures.length === 1
                    ? `${requiredEnvironmentFailures[0].label} needs attention`
                    : `${requiredEnvironmentFailures.length} environment items need attention`}
                </span>
                <span className="sm:hidden">Environment</span>
              </button>
            ) : null}
            <NetworkStatusIndicator variant="pill" />
            <span className="hidden sm:inline-flex">
              <GitHubStarBadge />
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 rounded-lg text-text-300"
              onClick={onOpenGlobalSearch}
              aria-label="Search"
              title="Search (Cmd/Ctrl+K)"
            >
              <Search className="size-4" strokeWidth={2} aria-hidden="true" />
            </Button>
            <ThemePreferenceMenu />
            <NotificationBell />
            <button
              type="button"
              aria-label="Model settings"
              onClick={openSettings}
              className="inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000"
            >
              <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            {/* Account button hidden for now; restore when the account flow lands. */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 rounded-md px-3 text-xs"
              onClick={openCreateDialog}
            >
              <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
              <span className="hidden sm:inline">New project</span>
            </Button>
          </div>
        </header>

        {sessionUpdates.length > 0 ? (
          <section className="mt-8 sm:mt-10" aria-label="Session updates">
            <div className="grid grid-cols-1 gap-3 py-1 md:grid-cols-2">
              {sessionUpdates.map(({ session, activity, activityTimestamp }) => {
                const needsYou = activity === 'needs-you'
                const completed = activity === 'completed'
                const relativeActivityTime = formatRelativeTime(activityTimestamp)
                const markingRead = markingReadSessionIds.has(session.id)
                const markReadFailed = markReadErrorSessionIds.has(session.id)

                return (
                  <div key={session.id} className="home-session-card group relative min-w-0">
                    <button
                      type="button"
                      className="flex min-h-36 w-full min-w-0 cursor-pointer flex-col rounded-2xl bg-bg-000 p-5 text-left shadow-card transition-colors duration-150 ease-out hover:bg-bg-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-bg-300 motion-reduce:transition-none"
                      onClick={() => openSession(session.projectId, session.id, 'user')}
                      aria-label={`Open session ${session.title}, ${needsYou ? 'needs you' : completed ? 'completed' : 'running'}`}
                    >
                      <span
                        className={cn(
                          'min-w-0 max-w-full truncate text-base font-semibold text-text-000',
                          completed && 'pr-10',
                          !needsYou && !completed && 'home-session-title-running'
                        )}
                      >
                        {session.title}
                      </span>
                      <span className="mt-1 truncate text-xs text-text-100">
                        {projectNames.get(session.projectId) ?? 'Unknown project'}
                      </span>
                      <span className="mt-auto flex w-full items-end justify-between gap-3 pt-6">
                        <span
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                            needsYou
                              ? 'bg-session-waiting/10 text-session-waiting'
                              : completed
                                ? 'bg-success-000/10 text-success-000'
                                : 'bg-session-running/10 text-session-running'
                          )}
                        >
                          {completed ? (
                            <Check className="size-3" strokeWidth={2} aria-hidden="true" />
                          ) : needsYou ? (
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
                          {needsYou ? 'Needs you' : completed ? 'Completed' : 'Running'}
                        </span>
                        <span className="shrink-0 text-xs text-text-100">
                          {completed
                            ? relativeActivityTime === 'now'
                              ? 'just now'
                              : relativeActivityTime
                            : `${needsYou ? 'waiting' : 'running'} ${relativeActivityTime}`}
                        </span>
                      </span>
                    </button>
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
                        aria-label={`${markReadFailed ? 'Retry marking' : 'Mark'} completed session ${session.title} as read`}
                        title={markReadFailed ? 'Could not mark as read. Try again.' : undefined}
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
                            Could not mark this completed session as read. Try again.
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
          <section className="min-w-0" aria-label="Projects">
            <h2 className={sectionHeadingClassName}>
              <GalleryVerticalEnd
                className="size-4 text-text-100"
                strokeWidth={2}
                aria-hidden="true"
              />
              Projects
            </h2>
            {projectActionError ? (
              <div
                className="mb-3 rounded-2xl border border-danger-000/30 px-4 py-3 text-sm text-danger-000"
                role="alert"
              >
                {projectActionError}
              </div>
            ) : null}
            {loadError ? (
              <div
                className="rounded-2xl border border-danger-000/30 px-4 py-6 text-center text-sm text-danger-000"
                role="alert"
              >
                Could not load projects: {loadError}
              </div>
            ) : projectSummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-muted-foreground">
                No projects yet. Create one to get started.
              </div>
            ) : (
              <div className={listCardClassName}>
                {projectSummaries.map(
                  ({ project, sessionCount, runningCount, needsYouCount, lastActivityAt }) => (
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
                            <span className="sr-only">Pinned project</span>
                          </>
                        ) : null}
                        {project.isExample ? (
                          <span className="shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-[10px] font-medium text-text-100">
                            Example
                          </span>
                        ) : null}
                        {hasCompleteSessionCatalog && needsYouCount > 0 ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-session-waiting"
                            aria-label={`${needsYouCount} waiting on you`}
                          >
                            <span
                              className="size-1.5 rounded-full bg-session-waiting motion-safe:animate-pulse"
                              aria-hidden="true"
                            />
                            <span aria-hidden="true">{needsYouCount}</span>
                          </span>
                        ) : null}
                        {hasCompleteSessionCatalog && runningCount > 0 ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-session-running"
                            aria-label={`${runningCount} running`}
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
                          ? `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`
                          : 'Session count unavailable'}
                      </span>
                      {showArtifactCounts && artifactCounts.has(project.id) ? (
                        <span className="hidden shrink-0 tabular-nums text-xs text-text-100 sm:inline">
                          {artifactCounts.get(project.id)}{' '}
                          {artifactCounts.get(project.id) === 1 ? 'artifact' : 'artifacts'}
                        </span>
                      ) : null}
                      <span className="hidden w-8 shrink-0 text-right text-xs text-text-000 sm:inline">
                        {formatRelativeTime(lastActivityAt)}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={rowActionClassName}
                            aria-label={`Open actions for ${project.name}`}
                          >
                            <MoreVertical className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          aria-label="Project actions"
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
                            {project.pinned ? 'Unpin project' : 'Pin project'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2"
                            onSelect={() => openEditDialog(project)}
                          >
                            <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                            Settings
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2"
                            disabled={
                              !canArchiveProject(project) || archivingProjectIds.has(project.id)
                            }
                            onSelect={() => archiveProject(project)}
                          >
                            <Archive className="size-4" strokeWidth={2} aria-hidden="true" />
                            {archivingProjectIds.has(project.id) ? 'Archiving…' : 'Archive'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="gap-2 text-danger-000 data-[highlighted]:bg-danger-900 data-[highlighted]:text-danger-000"
                            disabled={!canDeleteProjects}
                            onSelect={() => openDeleteDialog(project)}
                          >
                            <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                )}
              </div>
            )}
          </section>

          <section className="min-w-0" aria-label="Recent sessions">
            <h2 className={sectionHeadingClassName}>
              <Clock className="size-4 text-text-100" strokeWidth={2} aria-hidden="true" />
              Recent sessions
            </h2>
            {recentSessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border-200/70 px-4 py-10 text-center text-sm text-muted-foreground">
                Sessions you start will appear here.
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
                        {projectNames.get(session.projectId) ?? 'Unknown project'}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-text-000">
                      {formatRelativeTime(session.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <ProjectFormDialog
        open={formState !== null}
        title={formTitle}
        description={formDescription}
        submitLabel={formSubmitLabel}
        nameDraft={nameDraft}
        descriptionDraft={descriptionDraft}
        isSubmitting={isSubmitting}
        error={formError}
        onNameChange={setNameDraft}
        onDescriptionChange={setDescriptionDraft}
        onCancel={closeFormDialog}
        onConfirm={confirmForm}
      />

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
