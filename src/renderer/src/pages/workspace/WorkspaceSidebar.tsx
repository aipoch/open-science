import { useNavigationStore } from '@/stores/navigation-store'
import { showSessionReplay, loadSessionDiscussionContext } from './workspace-session-actions'
import { openResearchDiscussion, openResearchWorkspace } from './workspace-discussion-navigation'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { useSessionStore } from '@/stores/session-store'
import { sameResearch } from './research-draft-identity'
import {
  buildResearchNavigation,
  importedResearchSource,
  visibleResearchNavigationRows,
  type ResearchNavigationRow,
  type ResearchNavigationGroup
} from './research-navigation-model'
import { ResearchMembershipDialog } from './ResearchMembershipDialog'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { SessionPackageImportMenu } from '@/components/SessionPackageImportMenu'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Download,
  Files,
  Cpu,
  Lock,
  MoreVertical,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Toolbox,
  X
} from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'

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
  importProjectId?: string
  projectName: string
  otherProjects?: ReadonlyArray<{
    id: string
    name: string
    description: string
  }>
  onOpenProject?: (projectId: string) => void
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
  isLibraryOpen?: boolean
  onOpenLiterature?: () => void
  isComputeOpen?: boolean
  onOpenCompute?: () => void
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
  onCheckArtifacts?: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onExportSession?: (session: ChatSession) => void
  onForkSession?: (session: ChatSession) => Promise<void>
  onExportPackage?: (session: ChatSession) => Promise<void>
  onExportDiagnostics?: (session: ChatSession) => void
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
  onViewReplay?: (session: ChatSession) => void
  onDiscussSession?: (session: ChatSession) => Promise<void>
  onViewOriginalRecord?: (session: ChatSession) => void
  onAssignResearch?: (session: ChatSession) => void
  onRemoveResearch?: (session: ChatSession) => Promise<void>
  researchGroups?: ResearchNavigationGroup[]
  ordinarySections?: SidebarSessionSection[]
  visibleRows?: ResearchNavigationRow[]
  collapsedResearch?: ReadonlySet<string>
  onToggleResearch?: (key: string) => void
  onOpenResearch?: (source: ResearchMembership, newDiscussion?: boolean) => void
  activeDraftResearch?: ResearchMembership
  researchNavigationFailed?: boolean
  onDismissResearchError?: () => void
  rowActions?: SessionRowCallbacks
  now: number
  packageBusy?: boolean
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

type SessionRowCallbacks = Pick<
  WorkspaceSidebarViewProps,
  | 'onOpenSession'
  | 'onPreviewSession'
  | 'onRenameSession'
  | 'onRenameSessionTitle'
  | 'onDownloadArtifacts'
  | 'onCheckArtifacts'
  | 'onViewNotebook'
  | 'onViewReplay'
  | 'onDiscussSession'
  | 'onViewOriginalRecord'
  | 'onAssignResearch'
  | 'onRemoveResearch'
  | 'onExportSession'
  | 'onForkSession'
  | 'onExportPackage'
  | 'onExportDiagnostics'
  | 'onTogglePin'
  | 'onArchiveSession'
  | 'onDeleteSession'
  | 'onSessionActionsOpenChange'
>

const sessionRowCallbacks = ({
  onOpenSession,
  onPreviewSession,
  onRenameSession,
  onRenameSessionTitle,
  onDownloadArtifacts,
  onCheckArtifacts,
  onViewNotebook,
  onViewReplay,
  onDiscussSession,
  onViewOriginalRecord,
  onAssignResearch,
  onRemoveResearch,
  onExportSession,
  onForkSession,
  onExportPackage,
  onExportDiagnostics,
  onTogglePin,
  onArchiveSession,
  onDeleteSession,
  onSessionActionsOpenChange
}: WorkspaceSidebarViewProps): SessionRowCallbacks => ({
  onOpenSession,
  onPreviewSession,
  onRenameSession,
  onRenameSessionTitle,
  onDownloadArtifacts,
  onCheckArtifacts,
  onViewNotebook,
  onViewReplay,
  onDiscussSession,
  onViewOriginalRecord,
  onAssignResearch,
  onRemoveResearch,
  onExportSession,
  onForkSession,
  onExportPackage,
  onExportDiagnostics,
  onTogglePin,
  onArchiveSession,
  onDeleteSession,
  onSessionActionsOpenChange
})

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
): SessionStatus => {
  const projection = projectPresentedSessionActionability(session, {
    credentialPending: credentialPendingSessionIds.has(session.id)
  })
  return projection.activity === 'inactive' && projection.attention
    ? 'error'
    : projection.presentedStatus
}

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

const sidebarInteractiveTransitionClassName = 'transition-none'

const sessionRowClassName = cn(
  'group relative mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300',
  sidebarInteractiveTransitionClassName
)

const sessionRowActionClassName =
  'absolute right-1.5 top-1/2 z-10 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-text-100 opacity-0 transition-opacity duration-200 ease-out hover:!opacity-100 hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100'

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

type SessionRowProps = {
  t: ReturnType<typeof useTranslation>['t']
  session: ChatSession
  sectionLabel: string
  isActive: boolean
  imported: boolean
  shortcutNumber?: number
  presentedStatus: SessionStatus
  archiveAvailable: boolean
  mobileMode: boolean
  isMac: boolean
  showSessionShortcuts: boolean
  previewSuppressed: boolean
  canMutateConversations: boolean
  canDeleteConversations: boolean
  canDownloadArtifacts: boolean
  packageBusy: boolean
  canPreviewSession: boolean
  canRenameTitle: boolean
  canCheckArtifacts: boolean
  canExportSession: boolean
  canForkSession: boolean
  canExportPackage: boolean
  canExportDiagnostics: boolean
  canArchiveAction: boolean
  canAssignResearch?: boolean
  actions: SessionRowCallbacks
  researchToggle?: {
    expanded: boolean
    onToggle: () => void
    activityStatus?: SessionStatus
  }
  onOpenResearch?: () => void
}

// Keep the costly action-menu and hover-preview subtree stable when the page rerenders for a
// draft edit, or when selection moves between two otherwise unchanged Sessions. The full Session
// object is a prop so a stream, status, title, permission, or preview update still refreshes it.
const SessionRow = memo(function SessionRow({
  t,
  session,
  sectionLabel,
  isActive,
  imported,
  shortcutNumber,
  presentedStatus,
  archiveAvailable,
  mobileMode,
  isMac,
  showSessionShortcuts,
  previewSuppressed,
  canMutateConversations,
  canDeleteConversations,
  canDownloadArtifacts,
  packageBusy,
  canPreviewSession,
  canRenameTitle,
  canCheckArtifacts,
  canExportSession,
  canForkSession,
  canExportPackage,
  canExportDiagnostics,
  canArchiveAction,
  canAssignResearch = false,
  actions,
  researchToggle,
  onOpenResearch
}: SessionRowProps): React.JSX.Element {
  const indicatorStatus = researchToggle?.activityStatus ?? presentedStatus
  const sessionActionInvocation: SessionActionInvocation = { session, presentedStatus }
  const sessionActionBindings = createSessionActionBindings({
    canMutateConversations,
    canDeleteConversations,
    canDownloadArtifacts,
    canArchiveSession: () => archiveAvailable,
    onTogglePin: (target) => actions.onTogglePin(target),
    onRenameSession: (target) => actions.onRenameSession(target),
    onDownloadArtifacts: (target) => actions.onDownloadArtifacts(target),
    onCheckArtifacts: canCheckArtifacts
      ? (target) => actions.onCheckArtifacts?.(target)
      : undefined,
    onViewNotebook: (target) => actions.onViewNotebook(target),
    onViewReplay: actions.onViewReplay,
    onDiscussSession: actions.onDiscussSession,
    onViewOriginalRecord: actions.onViewOriginalRecord,
    onAssignResearch: canAssignResearch ? actions.onAssignResearch : undefined,
    onRemoveResearch: actions.onRemoveResearch,
    onExportSession: canExportSession ? (target) => actions.onExportSession?.(target) : undefined,
    onForkSession: canForkSession
      ? async (target) => {
          await actions.onForkSession?.(target)
        }
      : undefined,
    onExportPackage: canExportPackage
      ? async (target) => {
          await actions.onExportPackage?.(target)
        }
      : undefined,
    onExportDiagnostics: canExportDiagnostics
      ? (target) => actions.onExportDiagnostics?.(target)
      : undefined,
    packageBusy,
    onArchiveSession: canArchiveAction ? (target) => actions.onArchiveSession?.(target) : undefined,
    onDeleteSession: (target) => actions.onDeleteSession(target)
  })
  const sessionActionIdentityKey = JSON.stringify([
    session.id,
    session.revision,
    session.updatedAt,
    session.pinned ?? false,
    session.researchMembership,
    session.importedResearch,
    presentedStatus,
    session.status,
    session.runtimeContext?.permission?.state,
    session.runtimeContext?.plan?.approval,
    session.activeMessageCount ?? session.messages.length,
    canMutateConversations,
    canDeleteConversations,
    canDownloadArtifacts,
    canExportSession,
    canForkSession,
    canExportPackage,
    canExportDiagnostics,
    canAssignResearch,
    packageBusy,
    archiveAvailable
  ])
  const openSessionButton = (
    <button
      type="button"
      data-slot="session-open-button"
      title={researchToggle ? t('Imported research') : imported ? t('Read-only') : undefined}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left after:absolute after:inset-0 after:rounded-[inherit]"
      aria-current={isActive ? 'page' : undefined}
      aria-keyshortcuts={
        [
          shortcutNumber ? `${isMac ? 'Meta' : 'Control'}+${shortcutNumber}` : undefined,
          !mobileMode ? 'ArrowRight' : undefined
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      onClick={() => (onOpenResearch ? onOpenResearch() : actions.onOpenSession(session.id))}
    >
      <span
        className="relative inline-flex size-3 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        {researchToggle ? (
          <>
            <BookOpen className="size-3.5" />
            {indicatorStatus !== 'idle' ? (
              <span
                className={cn(
                  'absolute -bottom-1 -right-1 size-[6px] rounded-full',
                  sessionStatusDotClassName[indicatorStatus]
                )}
              />
            ) : null}
          </>
        ) : (
          <span
            className={cn(
              'size-[7px] shrink-0 rounded-full',
              sessionStatusDotClassName[presentedStatus]
            )}
          />
        )}
      </span>
      <span className="sr-only">
        {t('Session status: {{status}}', { status: t(sessionStatusLabelKeys[indicatorStatus]) })}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          sectionLabel === 'Active' && presentedStatus !== 'idle' && 'font-semibold'
        )}
      >
        {session.title}
      </span>
      {showSessionShortcuts && shortcutNumber ? (
        <kbd
          aria-hidden="true"
          className="relative z-[2] mr-5 shrink-0 rounded-full bg-bg-300 px-1.5 py-0.5 font-sans text-[11px] font-medium leading-none tabular-nums text-text-100"
        >
          {isMac ? `⌘${shortcutNumber}` : `Ctrl+${shortcutNumber}`}
        </kbd>
      ) : null}
      {imported && !researchToggle ? (
        <span
          role="img"
          aria-label={t('Read-only')}
          className={cn(
            'relative z-[2] inline-flex size-4 shrink-0 items-center justify-center text-text-200 transition-opacity motion-reduce:transition-none',
            mobileMode ? 'mr-5' : 'group-hover:opacity-0 group-focus-within:opacity-0',
            !mobileMode && previewSuppressed && 'opacity-0'
          )}
        >
          <Lock className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </span>
      ) : null}
    </button>
  )
  const row = (
    <ActionMenuTarget<SessionActionId, SessionActionInvocation>
      targetId={`${SESSION_ACTION_TARGET_PREFIX}${session.id}`}
      identityKey={sessionActionIdentityKey}
      catalog={SESSION_ACTION_CATALOG}
      recipe={SESSION_ACTION_RECIPE}
      bindings={sessionActionBindings}
      invocation={sessionActionInvocation}
      compact={false}
      dangerClassName={sessionActionDangerClassName}
      renderLabel={(entry, translatedLabel) =>
        entry.action === 'archive' ? t('Archive', { context: 'verb' }) : translatedLabel
      }
      asChild
    >
      <div
        data-session-id={session.id}
        className={cn(sessionRowClassName, isActive && 'bg-bg-300 text-text-000')}
        title={mobileMode ? session.title : undefined}
      >
        <div className="flex w-full min-w-0 items-center">
          {researchToggle ? (
            <button
              type="button"
              className="relative z-[2] -ml-1 mr-1 grid size-5 shrink-0 place-items-center rounded hover:bg-bg-400"
              aria-label={researchToggle.expanded ? t('Collapse research') : t('Expand research')}
              aria-expanded={researchToggle.expanded}
              onClick={researchToggle.onToggle}
            >
              {researchToggle.expanded ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
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
            onOpenChange={(open) => actions.onSessionActionsOpenChange?.(session.id, open)}
          />
        </div>
      </div>
    </ActionMenuTarget>
  )

  return mobileMode ? (
    row
  ) : (
    <SessionHoverPreview
      session={session}
      onPreviewRequest={
        canPreviewSession ? (sessionId) => actions.onPreviewSession?.(sessionId) : undefined
      }
      canRename={canMutateConversations && canRenameTitle}
      previewSuppressed={previewSuppressed}
      onRenameTitle={
        canRenameTitle
          ? (title, expectedTitle) => actions.onRenameSessionTitle?.(session, title, expectedTitle)
          : undefined
      }
    >
      {row}
    </SessionHoverPreview>
  )
})

const SessionList = ({
  activeSessionId,
  visible,
  children
}: {
  activeSessionId: string | undefined
  visible: boolean
  children: React.ReactNode
}): React.JSX.Element => {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!visible) return
    listRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeSessionId, visible])
  return (
    <div ref={listRef} className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto py-1">
      {children}
    </div>
  )
}

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebarView = (props: WorkspaceSidebarViewProps): React.JSX.Element => {
  const {
    importProjectId,
    projectName,
    otherProjects = [],
    onOpenProject,
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
    isLibraryOpen = false,
    onOpenLiterature,
    isComputeOpen = false,
    onOpenCompute,
    onPreviewSession,
    onRenameSessionTitle,
    canDownloadArtifacts,
    onCheckArtifacts,
    onExportSession,
    onForkSession,
    onExportPackage,
    onExportDiagnostics,
    packageBusy = false,
    canArchiveSession,
    onArchiveSession,
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
  } = props
  const { t } = useTranslation()
  const rowActions = props.rowActions ?? sessionRowCallbacks(props)
  const fallbackNavigation = buildResearchNavigation(sessions)
  const researchGroups = props.researchGroups ?? fallbackNavigation.research
  const sections =
    props.ordinarySections ??
    getSessionSections(fallbackNavigation.ordinary, now, credentialPendingSessionIds)
  const collapsedResearch = props.collapsedResearch ?? new Set<string>()
  const visibleRows =
    props.visibleRows ??
    visibleResearchNavigationRows(
      researchGroups,
      sections.flatMap((section) => section.items),
      collapsedResearch
    )
  const shortcutNumberBySessionId = new Map(
    visibleRows.slice(0, 9).map((row, index) => [row.session.id, index + 1])
  )
  const isMac = window.api?.platform === 'darwin'
  const projectMatches = providedProjectMatches ?? matchProjects(otherProjects, projectQuery)
  const visibleProjectMatches = showAllProjects
    ? projectMatches
    : projectMatches.slice(0, INITIAL_PROJECT_MENU_LIMIT)
  const remainingProjectCount = Math.max(0, projectMatches.length - INITIAL_PROJECT_MENU_LIMIT)

  const renderSession = (
    session: ChatSession,
    sectionLabel: string,
    group?: ResearchNavigationGroup
  ): React.JSX.Element => {
    const presentedStatus = getPresentedSessionStatus(session, credentialPendingSessionIds)
    const discussionStatuses = group?.discussions.map((discussion) =>
      getPresentedSessionStatus(discussion, credentialPendingSessionIds)
    )
    const researchActivity =
      discussionStatuses?.find((status) => status.startsWith('waiting-')) ??
      discussionStatuses?.find((status) => status === 'running') ??
      discussionStatuses?.find((status) => status === 'error') ??
      'idle'
    const sourceActive = Boolean(
      group && !activeSessionId && sameResearch(props.activeDraftResearch, group.source)
    )
    return (
      <SessionRow
        key={session.id}
        t={t}
        session={session}
        sectionLabel={sectionLabel}
        isActive={session.id === activeSessionId || sourceActive}
        imported={Boolean(importedResearchSource(session))}
        shortcutNumber={shortcutNumberBySessionId.get(session.id)}
        presentedStatus={presentedStatus}
        archiveAvailable={canArchiveSession?.(session) ?? false}
        mobileMode={mobileMode}
        isMac={isMac}
        showSessionShortcuts={showSessionShortcuts}
        previewSuppressed={openSessionActionsId === session.id}
        canMutateConversations={canMutateConversations}
        canDeleteConversations={canDeleteConversations}
        canDownloadArtifacts={canDownloadArtifacts}
        packageBusy={packageBusy}
        canPreviewSession={onPreviewSession !== undefined}
        canRenameTitle={onRenameSessionTitle !== undefined}
        canCheckArtifacts={onCheckArtifacts !== undefined}
        canExportSession={onExportSession !== undefined}
        canForkSession={onForkSession !== undefined}
        canExportPackage={onExportPackage !== undefined}
        canExportDiagnostics={onExportDiagnostics !== undefined}
        canArchiveAction={onArchiveSession !== undefined}
        canAssignResearch={researchGroups.length > 0}
        actions={rowActions}
        researchToggle={
          group
            ? {
                expanded: !collapsedResearch.has(group.key),
                onToggle: () => props.onToggleResearch?.(group.key),
                activityStatus: researchActivity
              }
            : undefined
        }
        onOpenResearch={group ? () => props.onOpenResearch?.(group.source) : undefined}
      />
    )
  }
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
                {importProjectId ? <SessionPackageImportMenu projectId={importProjectId} /> : null}
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
          <div className="flex h-9 items-center gap-1 px-1.5">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
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
          <div className="flex h-9 items-center gap-1 px-1.5">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300',
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
          <div className="flex h-9 items-center gap-1 px-1.5">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
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
          <div className="flex h-9 items-center gap-1 px-1.5">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                isComputeOpen && 'bg-bg-300',
                sidebarInteractiveTransitionClassName
              )}
              disabled={!canCreateConversation || !onOpenCompute}
              aria-controls="right-panel"
              aria-pressed={isComputeOpen}
              onClick={onOpenCompute}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Cpu className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('Compute')}</span>
            </button>
          </div>
          <div className="flex h-9 items-center gap-1 px-1.5">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                isLibraryOpen && 'bg-bg-300',
                sidebarInteractiveTransitionClassName
              )}
              aria-controls="right-panel"
              aria-pressed={isLibraryOpen}
              disabled={!onOpenLiterature}
              onClick={onOpenLiterature}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <BookOpen className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('Library')}</span>
            </button>
          </div>

          <div className="mx-2 my-1 h-px bg-border-300/15" />

          {props.researchNavigationFailed ? (
            <ErrorNotice
              className="mx-2 mb-2"
              title={t('Could not open the research discussion. Please retry.')}
              secondaryButton={{
                label: t('Dismiss'),
                onClick: () => props.onDismissResearchError?.()
              }}
            />
          ) : null}

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
              <SessionList
                activeSessionId={activeSessionId}
                visible={
                  (!mobileMode || isMobileOpen) &&
                  sessions.some((session) => session.id === activeSessionId)
                }
              >
                {researchGroups.length > 0 ? (
                  <section aria-label={t('Imported research')}>
                    <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                      {t('Imported research')}
                    </div>
                    {researchGroups.map((group) => (
                      <div key={group.key} data-research-id={group.session.id} className="mb-1">
                        {renderSession(group.session, 'Research', group)}
                        {!collapsedResearch.has(group.key) ? (
                          <div
                            className="ml-5 border-l border-border-300/30 pl-1"
                            data-research-discussions={group.session.id}
                          >
                            {group.discussions.map((session) => renderSession(session, 'Research'))}
                            <button
                              type="button"
                              className="mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-bg-300 hover:text-text-000 disabled:opacity-50"
                              disabled={!canCreateConversation}
                              onClick={() => props.onOpenResearch?.(group.source, true)}
                            >
                              <Plus className="size-3.5" aria-hidden="true" />
                              {t('New discussion')}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}
                {sections.length > 0 && researchGroups.length > 0 ? (
                  <div className="mx-2 mb-1 mt-4 border-t border-border-300/15 pt-3 text-[11px] font-semibold text-text-100">
                    {t('Conversations')}
                  </div>
                ) : null}
                {sections.map((section) => (
                  <div key={section.label}>
                    <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                      {t(section.label)}
                    </div>
                    {section.items.map((session) => renderSession(session, section.label))}
                  </div>
                ))}
              </SessionList>
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
              <GitHubStarBadge variant="workspace" />
              <NetworkStatusIndicator variant="icon" />
            </div>
          </div>
        </nav>
      </div>
    </aside>
  )
}

const WorkspaceSidebarConnectedView = (props: WorkspaceSidebarViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [assigningSession, setAssigningSession] = useState<ChatSession>()
  if (assigningSession && assigningSession.projectId !== props.importProjectId) {
    setAssigningSession(undefined)
  }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const callbacks: SessionRowCallbacks = {
    ...sessionRowCallbacks(props),
    onViewOriginalRecord: (session) => props.onOpenSession(session.id),
    onAssignResearch: setAssigningSession,
    onRemoveResearch: async (session) => {
      const persisted = await window.api.sessionReplay.setResearchMembership({
        projectId: session.projectId,
        sessionId: session.id,
        expectedRevision: session.revision ?? 0
      })
      if (useSessionStore.getState().sessions.some((row) => row.id === session.id)) {
        useSessionStore.getState().upsertPersistedSession(persisted)
      }
    },
    onViewReplay: (session) => {
      showSessionReplay(
        session.projectId,
        session.id,
        session.title,
        useNavigationStore.getState().activeProjectId ?? session.projectId
      )
    },
    onDiscussSession: async (session) => {
      const navigationRevision = useNavigationStore.getState().explicitNavigationRevision
      const context = await loadSessionDiscussionContext(session.projectId, session.id)
      if (
        !mounted.current ||
        useNavigationStore.getState().explicitNavigationRevision !== navigationRevision
      )
        return
      if (!context) throw new Error(t('No recorded steps are available.'))
      if (!(await openResearchDiscussion(context)))
        throw new Error(t('Could not open the research discussion. Please retry.'))
    }
  }
  const latestCallbacks = useRef(callbacks)
  useLayoutEffect(() => {
    latestCallbacks.current = callbacks
  })
  const rowActions = useMemo<SessionRowCallbacks>(
    () => ({
      onOpenSession: (sessionId) => latestCallbacks.current.onOpenSession(sessionId),
      onPreviewSession: (sessionId) => latestCallbacks.current.onPreviewSession?.(sessionId),
      onRenameSession: (session) => latestCallbacks.current.onRenameSession(session),
      onRenameSessionTitle: (session, title, expectedTitle) =>
        latestCallbacks.current.onRenameSessionTitle?.(session, title, expectedTitle),
      onDownloadArtifacts: (session) => latestCallbacks.current.onDownloadArtifacts(session),
      onCheckArtifacts: (session) => latestCallbacks.current.onCheckArtifacts?.(session),
      onViewNotebook: (session) => latestCallbacks.current.onViewNotebook(session),
      onViewReplay: (session) => latestCallbacks.current.onViewReplay?.(session),
      onDiscussSession: async (session) => {
        await latestCallbacks.current.onDiscussSession?.(session)
      },
      onViewOriginalRecord: (session) => latestCallbacks.current.onViewOriginalRecord?.(session),
      onAssignResearch: (session) => latestCallbacks.current.onAssignResearch?.(session),
      onRemoveResearch: async (session) => {
        await latestCallbacks.current.onRemoveResearch?.(session)
      },
      onExportSession: (session) => latestCallbacks.current.onExportSession?.(session),
      onForkSession: async (session) => {
        await latestCallbacks.current.onForkSession?.(session)
      },
      onExportPackage: async (session) => {
        await latestCallbacks.current.onExportPackage?.(session)
      },
      onExportDiagnostics: (session) => latestCallbacks.current.onExportDiagnostics?.(session),
      onTogglePin: (session) => latestCallbacks.current.onTogglePin(session),
      onArchiveSession: (session) => latestCallbacks.current.onArchiveSession?.(session),
      onDeleteSession: (session) => latestCallbacks.current.onDeleteSession(session),
      onSessionActionsOpenChange: (sessionId, open) =>
        latestCallbacks.current.onSessionActionsOpenChange?.(sessionId, open)
    }),
    []
  )
  return (
    <>
      <WorkspaceSidebarView {...props} rowActions={rowActions} />
      {assigningSession && assigningSession.projectId === props.importProjectId ? (
        <ResearchMembershipDialog
          key={assigningSession.id}
          session={assigningSession}
          research={props.researchGroups ?? buildResearchNavigation(props.sessions).research}
          onClose={() => setAssigningSession(undefined)}
        />
      ) : null}
    </>
  )
}

const WorkspaceSidebar = (props: WorkspaceSidebarProps): React.JSX.Element => {
  const packageBusy = usePackageOperationStore((state) => packageOperationActive(state.operation))
  const {
    credentialPendingSessionIds = EMPTY_CREDENTIAL_SESSION_IDS,
    onOpenSession,
    onMobileClose,
    sessions
  } = props
  const [now, setNow] = useState(Date.now)
  const [showSessionShortcuts, setShowSessionShortcuts] = useState(false)
  const [openSessionActionsId, setOpenSessionActionsId] = useState<string | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const [collapsedResearch, setCollapsedResearch] = useState<ReadonlySet<string>>(() => new Set())
  const [researchNavigationFailed, setResearchNavigationFailed] = useState(false)
  const activeDraftResearch = useResearchWorkspaceStore((state) =>
    props.importProjectId ? state.draftResearchByProject[props.importProjectId] : undefined
  )
  const explicitNavigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  const researchNavigation = useMemo(
    () =>
      buildResearchNavigation(
        getSessionSections(sessions, now, credentialPendingSessionIds).flatMap(
          (section) => section.items
        )
      ),
    [sessions, now, credentialPendingSessionIds]
  )
  const ordinarySections = useMemo(
    () => getSessionSections(researchNavigation.ordinary, now, credentialPendingSessionIds),
    [researchNavigation.ordinary, now, credentialPendingSessionIds]
  )
  const visibleRows = useMemo(
    () =>
      visibleResearchNavigationRows(
        researchNavigation.research,
        ordinarySections.flatMap((section) => section.items),
        collapsedResearch
      ),
    [researchNavigation.research, ordinarySections, collapsedResearch]
  )
  const activeGroupKey = researchNavigation.research.find(
    (group) =>
      group.session.id === props.activeSessionId ||
      group.discussions.some((session) => session.id === props.activeSessionId) ||
      (!props.activeSessionId && sameResearch(group.source, activeDraftResearch))
  )?.key
  // Reopening the selected child through search is still a navigation, even when its id is unchanged.
  const selectionKey = JSON.stringify([
    props.activeSessionId,
    activeGroupKey,
    explicitNavigationRevision
  ])
  const [previousSelectionKey, setPreviousSelectionKey] = useState(selectionKey)
  if (previousSelectionKey !== selectionKey) {
    setPreviousSelectionKey(selectionKey)
    if (activeGroupKey && collapsedResearch.has(activeGroupKey)) {
      const next = new Set(collapsedResearch)
      next.delete(activeGroupKey)
      setCollapsedResearch(next)
    }
  }
  const navigationAbort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => navigationAbort.current?.abort(), [])
  const openResearch = useCallback(
    (source: ResearchMembership, newDiscussion?: boolean): void => {
      navigationAbort.current?.abort()
      const controller = new AbortController()
      navigationAbort.current = controller
      setResearchNavigationFailed(false)
      const navigationRevision = useNavigationStore.getState().explicitNavigationRevision
      void openResearchWorkspace(source, { newDiscussion, signal: controller.signal })
        .then((opened) => {
          if (
            !opened &&
            !controller.signal.aborted &&
            useNavigationStore.getState().explicitNavigationRevision === navigationRevision
          )
            setResearchNavigationFailed(true)
          if (opened && !controller.signal.aborted) onMobileClose?.()
        })
        .catch(() => {
          if (
            !controller.signal.aborted &&
            useNavigationStore.getState().explicitNavigationRevision === navigationRevision
          )
            setResearchNavigationFailed(true)
        })
    },
    [onMobileClose]
  )
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

      const row = visibleRows.at(shortcutNumber - 1)
      if (!row) return

      event.preventDefault()
      if (row.kind === 'research') openResearch(row.source)
      else onOpenSession(row.session.id)
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
  }, [isMac, onOpenSession, openResearch, visibleRows])

  return (
    <WorkspaceSidebarConnectedView
      {...props}
      researchGroups={researchNavigation.research}
      ordinarySections={ordinarySections}
      visibleRows={visibleRows}
      activeDraftResearch={activeDraftResearch}
      collapsedResearch={collapsedResearch}
      onToggleResearch={(key) => {
        setCollapsedResearch((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }}
      onOpenResearch={openResearch}
      researchNavigationFailed={researchNavigationFailed}
      onDismissResearchError={() => setResearchNavigationFailed(false)}
      packageBusy={packageBusy}
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
export { SessionRow }
