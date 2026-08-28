import {
  Archive,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  Download,
  Files,
  MoreVertical,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Toolbox,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { cn } from '@/lib/utils'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { sessionWaitReasonLabelKeys } from '@/lib/session-wait-reason-labels'
import type { ChatSession, SessionStatus } from '@/stores/session-store'
import { NotificationBell } from '@/components/NotificationBell'

import { projectPresentedSessionActionability } from './session-wait-reason'
import {
  SessionHoverPreview,
  SessionHoverPreviewProvider,
  SessionTitleMarquee,
  type SessionPreviewRequest
} from './SessionHoverPreview'

type WorkspaceSidebarProps = {
  projectName: string
  starNudgeKey?: string
  sessions: ChatSession[]
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
  onRenameSessionTitle?: (session: ChatSession, title: string) => void
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
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

const getPresentedSessionStatus = (session: ChatSession): SessionStatus =>
  projectPresentedSessionActionability(session).presentedStatus

const isLiveSession = (session: ChatSession): boolean => {
  const activity = projectPresentedSessionActionability(session).activity
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

const getSessionSections = (sessions: ChatSession[], now: number): SidebarSessionSection[] => {
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
      isLiveSession(session) ||
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

// Shared icon wrapper inside each menu item row.
const sessionMenuIconClassName = 'flex size-4 shrink-0 items-center justify-center'

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebarView = ({
  projectName,
  starNudgeKey,
  sessions,
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
  onSessionActionsOpenChange
}: WorkspaceSidebarViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const sections = getSessionSections(sessions, now)
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
            <DropdownMenu>
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
                className={cn('min-w-[11rem]', mobileMode && 'z-[80]')}
                side="bottom"
                align="start"
                sideOffset={6}
              >
                <DropdownMenuItem className="gap-2" onSelect={() => onOpenProjectSettings()}>
                  <span className={sessionMenuIconClassName}>
                    <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {t('Project settings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  disabled={!canDownloadProjectArtifacts || !onDownloadProjectArtifacts}
                  onSelect={() => onDownloadProjectArtifacts?.()}
                >
                  <span className={sessionMenuIconClassName}>
                    <Download className="size-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {t('Download artifacts…')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2" onSelect={() => onNewProject()}>
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
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {sections.map((section) => (
                <div key={section.label}>
                  <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                    {t(section.label)}
                  </div>
                  {section.items.map((session) => {
                    const isActive = session.id === activeSessionId
                    const shortcutNumber = shortcutNumberBySessionId.get(session.id)
                    const presentedStatus = getPresentedSessionStatus(session)
                    const isExportDisabled =
                      (session.activeMessageCount ?? session.messages.length) === 0 ||
                      presentedStatus === 'running' ||
                      presentedStatus === 'waiting-for-user' ||
                      presentedStatus === 'waiting-permission' ||
                      presentedStatus === 'waiting-plan-approval'
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
                      <div
                        key={session.id}
                        className={cn(sessionRowClassName, isActive && 'bg-bg-300 text-text-000')}
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

                          <DropdownMenu
                            onOpenChange={(menuOpen) => {
                              onSessionActionsOpenChange?.(session.id, menuOpen)
                            }}
                          >
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className={cn(
                                  sessionRowActionClassName,
                                  mobileMode && 'opacity-100'
                                )}
                                aria-label={t('Open actions for {{title}}', {
                                  title: session.title
                                })}
                              >
                                <span
                                  className="flex size-3.5 items-center justify-center"
                                  aria-hidden="true"
                                >
                                  <MoreVertical className="size-3.5" strokeWidth={2} />
                                </span>
                              </button>
                            </DropdownMenuTrigger>
                            {/* Session action menu: uses shadcn default light-surface tokens. */}
                            <DropdownMenuContent
                              aria-label={t('Session actions')}
                              className={cn('min-w-[9rem]', mobileMode && 'z-[80]')}
                              side="right"
                              align="start"
                              sideOffset={6}
                            >
                              {/* Pin / Unpin toggles the conversation into or out of the pinned section. */}
                              <DropdownMenuItem
                                className="gap-2"
                                disabled={!canMutateConversations}
                                onSelect={() => onTogglePin(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  {session.pinned ? (
                                    <PinOff className="size-4" strokeWidth={2} aria-hidden="true" />
                                  ) : (
                                    <Pin className="size-4" strokeWidth={2} aria-hidden="true" />
                                  )}
                                </span>
                                {session.pinned ? t('Unpin') : t('Pin')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2"
                                disabled={!canMutateConversations}
                                onSelect={() => onRenameSession(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Pencil className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                {t('Edit…')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {canDownloadArtifacts ? (
                                <DropdownMenuItem
                                  className="gap-2"
                                  onSelect={() => onDownloadArtifacts(session)}
                                >
                                  <span className={sessionMenuIconClassName}>
                                    <Download
                                      className="size-4"
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  </span>
                                  {t('Download all artifacts')}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => onViewNotebook(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <BookOpen className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                {t('View notebook')}
                              </DropdownMenuItem>
                              {onExportSession ? (
                                <DropdownMenuItem
                                  className="gap-2"
                                  disabled={isExportDisabled}
                                  onSelect={() => onExportSession(session)}
                                >
                                  <span className={sessionMenuIconClassName}>
                                    <Download
                                      className="size-4"
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  </span>
                                  {t('Export conversation…')}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                className="gap-2"
                                disabled={!canArchiveSession?.(session)}
                                onSelect={() => onArchiveSession?.(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Archive className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                {/* The verb. Bare 'Archive' is the noun (a .zip) in the file browser. */}
                                {t('Archive', { context: 'verb' })}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {/* Delete uses the project's danger token pair for light surfaces. */}
                              <DropdownMenuItem
                                className="gap-2 text-danger-000 data-[highlighted]:bg-danger-900 data-[highlighted]:text-danger-000"
                                disabled={!canDeleteConversations}
                                onSelect={() => onDeleteSession(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                {t('Delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
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
                            ? (title) => onRenameSessionTitle(session, title)
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
  const { onOpenSession, sessions } = props
  const [now, setNow] = useState(Date.now)
  const [showSessionShortcuts, setShowSessionShortcuts] = useState(false)
  const [openSessionActionsId, setOpenSessionActionsId] = useState<string | null>(null)
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

      const session = getSessionSections(sessions, now)
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
  }, [isMac, now, onOpenSession, sessions])

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
    />
  )
}

export { WorkspaceSidebar }
export { WorkspaceSidebarView }
