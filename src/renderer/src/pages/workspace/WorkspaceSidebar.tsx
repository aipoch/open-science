import {
  ChevronDown,
  ChevronLeft,
  Download,
  Files,
  MoreVertical,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Toolbox,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { cn } from '@/lib/utils'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { sessionWaitReasonLabelKeys } from '@/lib/session-wait-reason-labels'
import type { ChatSession, SessionStatus } from '@/stores/session-store'
import { NotificationBell } from '@/components/NotificationBell'
import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenuTarget
} from '@/components/action-menu'

import { projectPresentedSessionActionability } from './session-wait-reason'
import { HighlightedText } from './composer/HighlightedText'
import { fuzzyScore } from './composer/fuzzy-match'
import {
  SessionHoverPreview,
  SessionHoverPreviewProvider,
  SessionTitleMarquee,
  type SessionPreviewRequest
} from './SessionHoverPreview'
import {
  SESSION_ACTION_CATALOG,
  SESSION_ACTION_RECIPE,
  createSessionActionBindings,
  type SessionActionId,
  type SessionActionInvocation
} from './session-action-menu'

type WorkspaceSidebarProps = {
  projectName: string
  otherProjects?: ReadonlyArray<{
    id: string
    name: string
    description: string
  }>
  onOpenProject?: (projectId: string) => void
  starNudgeKey?: string
  sessions: ChatSession[]
  credentialPendingSessionIds?: ReadonlySet<string>
  activeSessionId: string | undefined
  canCreateConversation: boolean
  canMutateConversations: boolean
  canDeleteConversations: boolean
  onGoHome: () => void
  onNewConversation: () => void
  isFilesOpen: boolean
  onOpenFiles: () => void
  onOpenSession: (sessionId: string) => void
  onPreviewSession?: SessionPreviewRequest
  onRenameSession: (session: ChatSession) => void
  // Desktop hover card: renames a session from the inline title editor. Absent or
  // `canMutateConversations === false` keeps the hover card title read-only.
  onRenameSessionTitle?: (
    session: ChatSession,
    title: string,
    expectedTitle: string
  ) => Promise<boolean> | void
  canDownloadArtifacts: boolean
  onDownloadArtifacts: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onExportSession?: (session: ChatSession) => void
  onTogglePin: (session: ChatSession) => void
  canArchiveSession?: (session: ChatSession) => boolean
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
  onOpenSettings: () => void
  onOpenProjectSettings: () => void
  onNewProject: () => void
  // Either absent renders the menu item disabled (the page disables it only for an authoritatively
  // complete empty project or while a download is already running; an unknown or incomplete index
  // stays clickable so the click path can repair the index).
  canDownloadProjectArtifacts?: boolean
  onDownloadProjectArtifacts?: () => void
  // Desktop only: rendered in the header row right after the project menu. Hidden while the
  // sidebar is collapsed — the panel layout mounts its floating fallback then, keeping a single
  // workspace-sidebar-toggle instance mounted at a time.
  sidebarToggle?: {
    state: 'open' | 'collapsed'
    onToggle: () => void
  }
  // The layout shares one ref between this header instance and the floating collapsed fallback.
  sidebarToggleButtonRef?: React.Ref<HTMLButtonElement>
  mobileMode?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
}

type WorkspaceSidebarViewProps = WorkspaceSidebarProps & {
  now: number
  showSessionShortcuts?: boolean
  openSessionActionsId?: string | null
  onSessionActionsOpenChange?: (sessionId: string, open: boolean) => void
  showAllProjects?: boolean
  onShowAllProjectsChange?: (showAllProjects: boolean) => void
  projectQuery?: string
  onProjectQueryChange?: (query: string) => void
  projectMatches?: ProjectMenuMatch[]
  onProjectMenuOpenChange?: (open: boolean) => void
}

// Maps each session status to the left-side indicator dot using emitted theme colors.
const sessionStatusDotClassName: Record<SessionStatus, string> = {
  idle: 'border border-text-100 bg-transparent',
  running: 'bg-session-running ring-2 ring-session-running/20',
  'waiting-for-user': 'bg-session-waiting ring-2 ring-session-waiting/25',
  'waiting-permission': 'bg-session-waiting ring-2 ring-session-waiting/25',
  'waiting-plan-approval': 'bg-session-waiting ring-2 ring-session-waiting/25',
  error: 'bg-destructive'
}

// Status label keys, resolved per component instance via useTranslation. `as const` keeps them as
// literals so t() stays compile-time checked against the English catalog.
const sessionStatusLabelKeys = {
  idle: 'Idle',
  running: 'Running',
  ...sessionWaitReasonLabelKeys,
  error: 'Error'
} as const satisfies Record<SessionStatus, string>

const ACTIVE_SESSION_GRACE_MS = 15 * 60_000
const EMPTY_CREDENTIAL_SESSION_IDS = new Set<string>()
const INITIAL_PROJECT_MENU_LIMIT = 5
const FIRST_PROJECT_MENU_DESTINATION_SELECTOR = '[data-project-id], [data-project-new]'
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

const getPresentedSessionStatus = (
  session: ChatSession,
  credentialPendingSessionIds: ReadonlySet<string>
): SessionStatus =>
  projectPresentedSessionActionability(session, {
    credentialPending: credentialPendingSessionIds.has(session.id)
  }).presentedStatus

const isLiveSession = (
  session: ChatSession,
  credentialPendingSessionIds: ReadonlySet<string>
): boolean => {
  const activity = projectPresentedSessionActionability(session, {
    credentialPending: credentialPendingSessionIds.has(session.id)
  }).activity
  return activity === 'running' || activity === 'waiting'
}

// The label is English source text that travels to the header as data, so it is translated where it
// is read rather than here. Keeping the union closed means a section added upstream fails typecheck
// until its text is added, instead of silently rendering untranslated.
type SidebarSessionSection = {
  label: 'Pinned' | 'Active' | 'Today' | 'Yesterday' | 'This week' | 'Older'
  items: ChatSession[]
}

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const getSessionSections = (
  sessions: ChatSession[],
  now: number,
  credentialPendingSessionIds: ReadonlySet<string>
): SidebarSessionSection[] => {
  const todayStartedAt = startOfLocalDay(now)
  const yesterday = new Date(todayStartedAt)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStartedAt = yesterday.getTime()
  const week = new Date(todayStartedAt)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const weekStartedAt = week.getTime()

  const pinned: ChatSession[] = []
  const active: ChatSession[] = []
  const today: ChatSession[] = []
  const yesterdaySessions: ChatSession[] = []
  const thisWeek: ChatSession[] = []
  const older: ChatSession[] = []

  sessions.forEach((session) => {
    if (session.pinned) {
      pinned.push(session)
    } else if (
      isLiveSession(session, credentialPendingSessionIds) ||
      (session.status === 'idle' && now - session.updatedAt < ACTIVE_SESSION_GRACE_MS)
    ) {
      active.push(session)
    } else if (session.updatedAt >= todayStartedAt) {
      today.push(session)
    } else if (session.updatedAt >= yesterdayStartedAt) {
      yesterdaySessions.push(session)
    } else if (session.updatedAt >= weekStartedAt) {
      thisWeek.push(session)
    } else {
      older.push(session)
    }
  })

  const sections: SidebarSessionSection[] = [
    { label: 'Pinned', items: pinned },
    { label: 'Active', items: active },
    { label: 'Today', items: today },
    { label: 'Yesterday', items: yesterdaySessions },
    { label: 'This week', items: thisWeek },
    { label: 'Older', items: older }
  ]
  return sections.filter((section) => section.items.length > 0)
}

const getNextSessionSectionRefreshAt = (sessions: ChatSession[], now: number): number => {
  const tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)

  return sessions.reduce((nextRefreshAt, session) => {
    if (session.pinned || session.status !== 'idle') return nextRefreshAt
    const activeUntil = session.updatedAt + ACTIVE_SESSION_GRACE_MS
    return activeUntil > now ? Math.min(nextRefreshAt, activeUntil) : nextRefreshAt
  }, tomorrow.getTime())
}

const sidebarInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

const sessionRowClassName = cn(
  'group relative mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300',
  sidebarInteractiveTransitionClassName
)

const sessionRowActionClassName =
  'absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-text-100 opacity-0 transition-[opacity,color,background-color] duration-200 ease-out hover:!opacity-100 hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100'

const SESSION_ACTION_TARGET_PREFIX = 'session:'
const sessionActionDangerClassName =
  'text-danger-000 data-[highlighted]:bg-danger-900 data-[highlighted]:text-danger-000'
// Shared icon wrapper inside each project menu item row.
const sessionMenuIconClassName = 'flex size-4 shrink-0 items-center justify-center'

const SessionActionDropdown = ({
  session,
  mobileMode,
  onOpenChange
}: {
  session: ChatSession
  mobileMode: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { entries, execute, renderLabel } = useActionMenuTarget<SessionActionId>()

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(sessionRowActionClassName, mobileMode && 'opacity-100')}
          aria-label={t('Open actions for {{title}}', { title: session.title })}
        >
          <span className="flex size-3.5 items-center justify-center" aria-hidden="true">
            <MoreVertical className="size-3.5" strokeWidth={2} />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={t('Session actions')}
        className={cn('min-w-[9rem]', mobileMode && 'z-[80]')}
        side="right"
        align="start"
        sideOffset={6}
      >
        <ActionMenuItems
          entries={entries}
          onSelect={(actionId) => void execute(actionId)}
          compact={false}
          dangerClassName={sessionActionDangerClassName}
          renderLabel={renderLabel}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const handleProjectMenuActionKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'ArrowDown') return
  const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]')
  const actions = Array.from(
    menu?.querySelectorAll<HTMLElement>('[data-project-menu-action]:not([data-disabled])') ?? []
  )
  const search = menu?.querySelector<HTMLInputElement>('[data-project-search]')
  if (actions.at(-1) !== event.currentTarget || !search) return

  // Search is outside Radix's item collection, so bridge the visual order explicitly.
  event.preventDefault()
  event.stopPropagation()
  search.focus()
}

type ProjectMenuMatch = {
  project: NonNullable<WorkspaceSidebarProps['otherProjects']>[number]
  description: string
  titlePositions: number[]
  descriptionPositions: number[]
}

const matchProjects = (
  projects: NonNullable<WorkspaceSidebarProps['otherProjects']>,
  query: string
): ProjectMenuMatch[] => {
  const needle = query.trim()
  if (!needle) {
    return projects.map((project) => ({
      project,
      description: project.description.trim(),
      titlePositions: [],
      descriptionPositions: []
    }))
  }

  const titleMatches: ProjectMenuMatch[] = []
  const descriptionMatches: ProjectMenuMatch[] = []
  projects.forEach((project) => {
    const description = project.description.trim()
    const titleMatch = fuzzyScore(needle, project.name)
    const descriptionMatch = description ? fuzzyScore(needle, description) : null
    if (!titleMatch && !descriptionMatch) return

    const match = {
      project,
      description,
      titlePositions: titleMatch?.positions ?? [],
      descriptionPositions: descriptionMatch?.positions ?? []
    }
    // Separate arrays make title priority absolute while preserving the store order within each tier.
    if (titleMatch) titleMatches.push(match)
    else descriptionMatches.push(match)
  })
  return [...titleMatches, ...descriptionMatches]
}

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebarView = ({
  projectName,
  otherProjects = [],
  onOpenProject,
  starNudgeKey,
  sessions,
  credentialPendingSessionIds = EMPTY_CREDENTIAL_SESSION_IDS,
  activeSessionId,
  canCreateConversation,
  canMutateConversations,
  canDeleteConversations,
  onGoHome,
  onNewConversation,
  isFilesOpen,
  onOpenFiles,
  onOpenSession,
  onPreviewSession,
  onRenameSession,
  onRenameSessionTitle,
  canDownloadArtifacts,
  onDownloadArtifacts,
  onViewNotebook,
  onExportSession,
  onTogglePin,
  canArchiveSession,
  onArchiveSession,
  onDeleteSession,
  onOpenSettings,
  onOpenProjectSettings,
  onNewProject,
  canDownloadProjectArtifacts = false,
  onDownloadProjectArtifacts,
  sidebarToggle,
  sidebarToggleButtonRef,
  mobileMode = false,
  isMobileOpen = false,
  onMobileClose,
  now,
  showSessionShortcuts = false,
  openSessionActionsId = null,
  onSessionActionsOpenChange,
  showAllProjects = false,
  onShowAllProjectsChange,
  projectQuery = '',
  onProjectQueryChange,
  projectMatches: providedProjectMatches,
  onProjectMenuOpenChange
}: WorkspaceSidebarViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const sections = getSessionSections(sessions, now, credentialPendingSessionIds)
  const shortcutNumberBySessionId = new Map(
    sections
      .flatMap((section) => section.items)
      .slice(0, 9)
      .map((session, index) => [session.id, index + 1])
  )
  const isMac = window.api?.platform === 'darwin'
  const activeStarNudgeKey = (mobileMode ? isMobileOpen : sidebarToggle?.state !== 'collapsed')
    ? starNudgeKey
    : undefined
  const projectMatches = providedProjectMatches ?? matchProjects(otherProjects, projectQuery)
  const visibleProjectMatches = showAllProjects
    ? projectMatches
    : projectMatches.slice(0, INITIAL_PROJECT_MENU_LIMIT)
  const remainingProjectCount = Math.max(0, projectMatches.length - INITIAL_PROJECT_MENU_LIMIT)

  return (
    <aside
      aria-label={t('Workspace navigation')}
      aria-hidden={mobileMode && !isMobileOpen ? true : undefined}
      inert={mobileMode && !isMobileOpen ? true : undefined}
      data-mobile-open={isMobileOpen ? 'true' : 'false'}
      className={cn(
        mobileMode
          ? 'fixed inset-y-0 left-0 z-[70] flex h-[100dvh] w-[min(86vw,320px)] min-w-0 shrink-0 flex-col bg-bg-10 transition-transform duration-200 ease-out'
          : 'z-10 flex h-full w-full min-w-0 flex-col overflow-hidden',
        mobileMode && (isMobileOpen ? 'translate-x-0' : '-translate-x-full')
      )}
    >
      <div className="m-[0.7px] flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card">
        <div className="px-3 pt-3">
          <div className="flex items-center">
            <button
              type="button"
              onClick={onGoHome}
              aria-label={t('All projects')}
              title={t('All projects')}
              className={cn(
                'grid h-7 w-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-bg-300 hover:text-text-000',
                sidebarInteractiveTransitionClassName
              )}
            >
              <ChevronLeft className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <DropdownMenu onOpenChange={onProjectMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={projectName}
                  className={cn(
                    'flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-left font-serif text-[15px] font-bold tracking-[-0.02em] text-text-000 hover:bg-bg-300 data-[state=open]:bg-bg-300',
                    sidebarInteractiveTransitionClassName
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{projectName}</span>
                  <ChevronDown
                    className="size-3.5 shrink-0 text-text-100"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>
              {/* Project action menu: mirrors the session row menu chrome below. */}
              <DropdownMenuContent
                aria-label={t('Project actions')}
                className={cn(
                  'max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto',
                  mobileMode && 'z-[80]'
                )}
                side="bottom"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                onFocus={(event) => {
                  if (event.target !== event.currentTarget) return
                  const search =
                    event.currentTarget.querySelector<HTMLInputElement>('[data-project-search]')
                  if (!search) return
                  search.focus()
                }}
              >
                <DropdownMenuItem
                  data-project-menu-action
                  className="gap-2"
                  onSelect={() => onOpenProjectSettings()}
                  onKeyDown={handleProjectMenuActionKeyDown}
                >
                  <span className={sessionMenuIconClassName}>
                    <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {t('Project settings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-project-menu-action
                  className="gap-2"
                  disabled={!canDownloadProjectArtifacts || !onDownloadProjectArtifacts}
                  onSelect={() => onDownloadProjectArtifacts?.()}
                  onKeyDown={handleProjectMenuActionKeyDown}
                >
                  <span className={sessionMenuIconClassName}>
                    <Download className="size-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {t('Download artifacts…')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {otherProjects.length > INITIAL_PROJECT_MENU_LIMIT ? (
                  // Keep the input outside the Radix item collection so typing never selects a row.
                  <div className="relative mx-1 mb-1">
                    <Search
                      className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      data-project-search
                      type="search"
                      aria-label={t('Search projects')}
                      placeholder={t('Search projects…')}
                      value={projectQuery}
                      autoComplete="off"
                      className="h-8 pl-7 pr-8 [&::-webkit-search-cancel-button]:hidden"
                      onChange={(event) => onProjectQueryChange?.(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) {
                          event.stopPropagation()
                          return
                        }
                        if (event.key === 'ArrowDown') {
                          event.preventDefault()
                          event.currentTarget
                            .closest<HTMLElement>('[role="menu"]')
                            ?.querySelector<HTMLElement>(FIRST_PROJECT_MENU_DESTINATION_SELECTOR)
                            ?.focus()
                          event.stopPropagation()
                          return
                        }
                        if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
                          event.preventDefault()
                          const actions = Array.from(
                            event.currentTarget
                              .closest<HTMLElement>('[role="menu"]')
                              ?.querySelectorAll<HTMLElement>(
                                '[data-project-menu-action]:not([data-disabled])'
                              ) ?? []
                          )
                          actions.at(-1)?.focus()
                          event.stopPropagation()
                          return
                        }
                        if (event.key === 'Tab') {
                          event.preventDefault()
                          const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]')
                          const nextTarget = projectQuery
                            ? menu?.querySelector<HTMLElement>('[data-project-clear]')
                            : menu?.querySelector<HTMLElement>(
                                FIRST_PROJECT_MENU_DESTINATION_SELECTOR
                              )
                          nextTarget?.focus()
                          event.stopPropagation()
                          return
                        }
                        if (event.key !== 'Escape') event.stopPropagation()
                      }}
                    />
                    {projectQuery ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-project-clear
                        aria-label={t('Clear search')}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-text-100 hover:bg-bg-200 hover:text-text-100"
                        onMouseDown={(event) => event.preventDefault()}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'ArrowUp' ||
                            event.key === 'ArrowLeft' ||
                            (event.key === 'Tab' && event.shiftKey)
                          ) {
                            event.preventDefault()
                            event.currentTarget.parentElement
                              ?.querySelector<HTMLInputElement>('[data-project-search]')
                              ?.focus()
                            event.stopPropagation()
                            return
                          }
                          if (event.key === 'ArrowDown' || event.key === 'Tab') {
                            event.preventDefault()
                            event.currentTarget
                              .closest<HTMLElement>('[role="menu"]')
                              ?.querySelector<HTMLElement>(FIRST_PROJECT_MENU_DESTINATION_SELECTOR)
                              ?.focus()
                            event.stopPropagation()
                            return
                          }
                          if (event.key !== 'Escape') event.stopPropagation()
                        }}
                        onClick={(event) => {
                          // Restore focus before the controlled clear unmounts this keyboard target.
                          event.currentTarget.parentElement
                            ?.querySelector<HTMLInputElement>('[data-project-search]')
                            ?.focus()
                          onProjectQueryChange?.('')
                        }}
                      >
                        <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {projectQuery.trim() && projectMatches.length === 0 ? (
                  <p role="status" className="px-2 py-3 text-center text-sm text-muted-foreground">
                    {t('No matching projects')}
                  </p>
                ) : null}
                {visibleProjectMatches.map(
                  ({ project, description, titlePositions, descriptionPositions }, index) => (
                    <DropdownMenuItem
                      key={project.id}
                      data-project-id={project.id}
                      className="items-start py-2"
                      disabled={!onOpenProject}
                      onSelect={() => onOpenProject?.(project.id)}
                      onKeyDown={(event) => {
                        if (index !== 0 || event.key !== 'ArrowUp') return
                        const search = event.currentTarget
                          .closest<HTMLElement>('[role="menu"]')
                          ?.querySelector<HTMLInputElement>('[data-project-search]')
                        if (!search) return
                        event.preventDefault()
                        event.stopPropagation()
                        search.focus()
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          data-project-title
                          className="truncate font-medium"
                          title={project.name}
                        >
                          <HighlightedText
                            text={project.name}
                            positions={titlePositions}
                            highlightClassName="bg-transparent text-primary"
                          />
                        </span>
                        {description ? (
                          <span
                            data-project-description
                            className="line-clamp-2 break-words text-xs leading-4 text-muted-foreground"
                          >
                            <HighlightedText
                              text={description}
                              positions={descriptionPositions}
                              highlightClassName="bg-transparent text-primary"
                            />
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  )
                )}
                {!showAllProjects && remainingProjectCount > 0 ? (
                  <DropdownMenuItem
                    asChild
                    onSelect={(event) => {
                      event.preventDefault()
                      const menu = (event.currentTarget as HTMLElement).closest<HTMLElement>(
                        '[role="menu"]'
                      )
                      onShowAllProjectsChange?.(true)
                      // The selected control unmounts after expansion; restore focus after that commit.
                      window.setTimeout(() => {
                        menu?.querySelector<HTMLElement>('[data-project-id]')?.focus()
                      }, 0)
                    }}
                  >
                    <button
                      type="button"
                      className="min-h-0! w-fit! gap-1 rounded-sm! bg-transparent! px-2 py-1 text-[11px]! text-muted-foreground! hover:bg-transparent! focus:bg-transparent! focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[highlighted]:bg-transparent! data-[highlighted]:text-foreground!"
                    >
                      <ChevronDown
                        className="size-3.5 shrink-0"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <span>
                        {t('Show remaining {{count}} projects', {
                          count: remainingProjectCount,
                          defaultValue_one: 'Show remaining {{count}} project'
                        })}
                      </span>
                    </button>
                  </DropdownMenuItem>
                ) : null}
                {otherProjects.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  data-project-new
                  className="gap-2"
                  onSelect={() => onNewProject()}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowUp') return
                    const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]')
                    if (menu?.querySelector('[data-project-id]')) return
                    const search = menu?.querySelector<HTMLInputElement>('[data-project-search]')
                    if (!search) return
                    event.preventDefault()
                    event.stopPropagation()
                    search.focus()
                  }}
                >
                  <span className={sessionMenuIconClassName}>
                    <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {t('New project')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {!mobileMode && sidebarToggle && sidebarToggle.state !== 'collapsed' ? (
              <button
                ref={sidebarToggleButtonRef}
                type="button"
                data-testid="workspace-sidebar-toggle"
                className={cn(
                  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-action-panel-toggle hover:bg-bg-300',
                  sidebarInteractiveTransitionClassName
                )}
                aria-label={t('Collapse sidebar panel')}
                aria-expanded={true}
                aria-controls="left-panel"
                aria-keyshortcuts={isMac ? 'Meta+B' : 'Control+B'}
                title={t('Collapse sidebar panel')}
                onClick={sidebarToggle.onToggle}
              >
                <PanelLeft className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
              </button>
            ) : null}
            {mobileMode ? (
              <button
                type="button"
                onClick={onMobileClose}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-bg-300 hover:text-text-000"
                aria-label={t('Close navigation')}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <nav aria-label={t('Sessions')} className="flex min-h-0 flex-1 flex-col">
          {/* New stays disabled until persistence hydration has reconciled restored sessions. */}
          <div className="flex h-9 items-center gap-1 px-2">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                sidebarInteractiveTransitionClassName
              )}
              disabled={!canCreateConversation}
              onClick={onNewConversation}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Plus className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('New')}</span>
            </button>
          </div>
          <div className="flex h-9 items-center gap-1 px-2">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text-000 hover:bg-bg-300',
                sidebarInteractiveTransitionClassName
              )}
              onClick={onOpenSettings}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Toolbox className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('Customize')}</span>
            </button>
          </div>
          <div className="flex h-9 items-center gap-1 px-2">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                isFilesOpen && 'bg-bg-300',
                sidebarInteractiveTransitionClassName
              )}
              disabled={!canCreateConversation}
              aria-controls="right-panel"
              aria-pressed={isFilesOpen}
              onClick={onOpenFiles}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Files className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('Files')}</span>
            </button>
          </div>

          <div className="mx-2 my-1 h-px bg-border-300/15" />

          <SessionHoverPreviewProvider>
            <ActionMenuProvider
              testId="session-context-menu"
              contentClassName={mobileMode ? 'z-[80]' : undefined}
              onOpenChange={(targetId, open) => {
                if (!targetId.startsWith(SESSION_ACTION_TARGET_PREFIX)) return
                onSessionActionsOpenChange?.(
                  targetId.slice(SESSION_ACTION_TARGET_PREFIX.length),
                  open
                )
              }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {sections.map((section) => (
                  <div key={section.label}>
                    <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                      {t(section.label)}
                    </div>
                    {section.items.map((session) => {
                      const isActive = session.id === activeSessionId
                      const shortcutNumber = shortcutNumberBySessionId.get(session.id)
                      const presentedStatus = getPresentedSessionStatus(
                        session,
                        credentialPendingSessionIds
                      )
                      const archiveAvailable = canArchiveSession?.(session) ?? false
                      const sessionActionInvocation: SessionActionInvocation = {
                        session,
                        presentedStatus
                      }
                      const sessionActionBindings = createSessionActionBindings({
                        canMutateConversations,
                        canDeleteConversations,
                        canDownloadArtifacts,
                        canArchiveSession: () => archiveAvailable,
                        onTogglePin,
                        onRenameSession,
                        onDownloadArtifacts,
                        onViewNotebook,
                        onExportSession,
                        onArchiveSession,
                        onDeleteSession
                      })
                      const sessionActionIdentityKey = JSON.stringify([
                        session.id,
                        session.updatedAt,
                        session.pinned ?? false,
                        presentedStatus,
                        session.activeMessageCount ?? session.messages.length,
                        canMutateConversations,
                        canDeleteConversations,
                        canDownloadArtifacts,
                        Boolean(onExportSession),
                        archiveAvailable
                      ])
                      const openSessionButton = (
                        <button
                          type="button"
                          data-slot="session-open-button"
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                          aria-current={isActive ? 'page' : undefined}
                          aria-keyshortcuts={
                            shortcutNumber
                              ? `${isMac ? 'Meta' : 'Control'}+${shortcutNumber}`
                              : undefined
                          }
                          onClick={() => onOpenSession(session.id)}
                        >
                          <span
                            className="inline-flex size-3 shrink-0 items-center justify-center"
                            aria-hidden="true"
                          >
                            <span
                              className={cn(
                                'size-[7px] shrink-0 rounded-full',
                                sessionStatusDotClassName[presentedStatus]
                              )}
                            />
                          </span>
                          <span className="sr-only">
                            {t('Session status: {{status}}', {
                              status: t(sessionStatusLabelKeys[presentedStatus])
                            })}
                          </span>
                          <SessionTitleMarquee
                            title={session.title}
                            className={cn(
                              section.label === 'Active' &&
                                presentedStatus !== 'idle' &&
                                'font-semibold'
                            )}
                          />
                          {showSessionShortcuts && shortcutNumber ? (
                            <kbd
                              aria-hidden="true"
                              className="relative z-[2] mr-5 shrink-0 rounded-full bg-bg-300 px-1.5 py-0.5 font-sans text-[11px] font-medium leading-none tabular-nums text-text-100"
                            >
                              {isMac ? `⌘${shortcutNumber}` : `Ctrl+${shortcutNumber}`}
                            </kbd>
                          ) : null}
                        </button>
                      )

                      // The hover-preview trigger is the whole row, not only the open button: the
                      // card is anchored to the row's top edge and the pointer can cross from
                      // anywhere in the row straight onto the card without hitting a dead zone.
                      const row = (
                        <ActionMenuTarget<SessionActionId, SessionActionInvocation>
                          key={session.id}
                          targetId={`${SESSION_ACTION_TARGET_PREFIX}${session.id}`}
                          identityKey={sessionActionIdentityKey}
                          catalog={SESSION_ACTION_CATALOG}
                          recipe={SESSION_ACTION_RECIPE}
                          bindings={sessionActionBindings}
                          invocation={sessionActionInvocation}
                          compact={false}
                          dangerClassName={sessionActionDangerClassName}
                          renderLabel={(entry, translatedLabel) =>
                            entry.action === 'archive'
                              ? t('Archive', { context: 'verb' })
                              : translatedLabel
                          }
                          asChild
                        >
                          <div
                            data-session-id={session.id}
                            className={cn(
                              sessionRowClassName,
                              isActive && 'bg-bg-300 text-text-000'
                            )}
                            title={mobileMode ? session.title : undefined}
                          >
                            <div className="flex w-full min-w-0 items-center">
                              {openSessionButton}

                              <span
                                aria-hidden="true"
                                className={cn(
                                  'pointer-events-none absolute inset-y-0 right-0 z-[1] w-12 rounded-r-md bg-gradient-to-r from-transparent via-rail-card-bg to-rail-card-bg group-hover:via-bg-300 group-hover:to-bg-300',
                                  isActive && 'via-bg-300 to-bg-300'
                                )}
                              />

                              <SessionActionDropdown
                                session={session}
                                mobileMode={mobileMode}
                                onOpenChange={(menuOpen) =>
                                  onSessionActionsOpenChange?.(session.id, menuOpen)
                                }
                              />
                            </div>
                          </div>
                        </ActionMenuTarget>
                      )

                      return mobileMode ? (
                        row
                      ) : (
                        <SessionHoverPreview
                          key={session.id}
                          session={session}
                          onPreviewRequest={onPreviewSession}
                          canRename={canMutateConversations && onRenameSessionTitle !== undefined}
                          previewSuppressed={openSessionActionsId === session.id}
                          onRenameTitle={
                            onRenameSessionTitle
                              ? (title, expectedTitle) =>
                                  onRenameSessionTitle(session, title, expectedTitle)
                              : undefined
                          }
                        >
                          {row}
                        </SessionHoverPreview>
                      )
                    })}
                  </div>
                ))}
              </div>
            </ActionMenuProvider>
          </SessionHoverPreviewProvider>

          <div className="relative shrink-0 px-2 pt-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0"
            />
            <UpdateCapsule variant="session" className="mb-1.5" />
            <div className="flex items-center gap-1 pb-2">
              <button
                type="button"
                onClick={onOpenSettings}
                className={cn(
                  'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000',
                  sidebarInteractiveTransitionClassName
                )}
                aria-label={t('Settings')}
              >
                <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
              </button>
              <NotificationBell
                side="top"
                align="start"
                className="size-8 rounded-md"
                onOpen={mobileMode ? onMobileClose : undefined}
              />
              <GitHubStarBadge
                key={activeStarNudgeKey}
                variant="workspace"
                nudgeKey={activeStarNudgeKey}
              />
              <NetworkStatusIndicator variant="icon" />
            </div>
          </div>
        </nav>
      </div>
    </aside>
  )
}

const WorkspaceSidebar = (props: WorkspaceSidebarProps): React.JSX.Element => {
  const {
    credentialPendingSessionIds = EMPTY_CREDENTIAL_SESSION_IDS,
    onOpenSession,
    sessions
  } = props
  const [now, setNow] = useState(Date.now)
  const [showSessionShortcuts, setShowSessionShortcuts] = useState(false)
  const [openSessionActionsId, setOpenSessionActionsId] = useState<string | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const canSearchProjects = (props.otherProjects?.length ?? 0) > INITIAL_PROJECT_MENU_LIMIT
  const effectiveProjectQuery = canSearchProjects ? projectQuery : ''
  if (!canSearchProjects && (projectQuery || showAllProjects)) {
    setProjectQuery('')
    setShowAllProjects(false)
  }
  const projectMatches = useMemo(
    () => matchProjects(props.otherProjects ?? [], effectiveProjectQuery),
    [effectiveProjectQuery, props.otherProjects]
  )
  const nextSectionRefreshAt = getNextSessionSectionRefreshAt(sessions, now)
  const isMac = window.api?.platform === 'darwin'

  // Reclassify recent completions at 15 minutes and date groups at local midnight without waiting
  // for unrelated Session activity to trigger a render.
  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(1, nextSectionRefreshAt - Date.now() + 1)
    )
    return () => window.clearTimeout(timeoutId)
  }, [nextSectionRefreshAt])

  useEffect(() => {
    const primaryModifierKey = isMac ? 'Meta' : 'Control'

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === primaryModifierKey) {
        if (!event.repeat && document.querySelector(OPEN_DIALOG_SELECTOR) === null) {
          setShowSessionShortcuts(true)
        }
        return
      }

      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null
      ) {
        return
      }

      const shortcutNumber = Number(event.key)
      if (!Number.isInteger(shortcutNumber) || shortcutNumber < 1 || shortcutNumber > 9) return

      const session = getSessionSections(sessions, now, credentialPendingSessionIds)
        .flatMap((section) => section.items)
        .at(shortcutNumber - 1)
      if (!session) return

      event.preventDefault()
      onOpenSession(session.id)
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === primaryModifierKey) setShowSessionShortcuts(false)
    }

    const hideSessionShortcuts = (): void => setShowSessionShortcuts(false)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', hideSessionShortcuts)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', hideSessionShortcuts)
    }
  }, [credentialPendingSessionIds, isMac, now, onOpenSession, sessions])

  return (
    <WorkspaceSidebarView
      {...props}
      now={now}
      showSessionShortcuts={showSessionShortcuts}
      openSessionActionsId={openSessionActionsId}
      onSessionActionsOpenChange={(sessionId, open) => {
        setOpenSessionActionsId((current) =>
          open ? sessionId : current === sessionId ? null : current
        )
      }}
      showAllProjects={showAllProjects}
      onShowAllProjectsChange={setShowAllProjects}
      projectQuery={effectiveProjectQuery}
      projectMatches={projectMatches}
      onProjectQueryChange={(query) => {
        setProjectQuery(query)
        setShowAllProjects(false)
      }}
      onProjectMenuOpenChange={(open) => {
        if (!open) {
          setProjectQuery('')
          setShowAllProjects(false)
        }
      }}
    />
  )
}

export { WorkspaceSidebar }
export { WorkspaceSidebarView }
