import {
  Archive,
  BookOpen,
  ChevronLeft,
  Download,
  FileText,
  FileType2,
  Files,
  MoreVertical,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { cn } from '@/lib/utils'
import { GitHubStarBadge } from '@/components/GitHubStarBadge'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import type { ChatSession, SessionStatus } from '@/stores/session-store'
import type { ConversationExportFormat } from '../../../../shared/conversation-export'
import { NotificationBell } from '@/components/NotificationBell'

type WorkspaceSidebarProps = {
  projectName: string
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
  onRenameSession: (session: ChatSession) => void
  canDownloadArtifacts: boolean
  onDownloadArtifacts: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onExportSession?: (session: ChatSession, format: ConversationExportFormat) => void
  onTogglePin: (session: ChatSession) => void
  canArchiveSession?: (session: ChatSession) => boolean
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
  onOpenSettings: () => void
  mobileMode?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
}

type WorkspaceSidebarViewProps = WorkspaceSidebarProps & {
  now: number
  showSessionShortcuts?: boolean
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

const sessionStatusLabel: Record<SessionStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  'waiting-for-user': 'Waiting for your answer',
  'waiting-permission': 'Waiting for permission',
  'waiting-plan-approval': 'Waiting for plan approval',
  error: 'Error'
}

const ACTIVE_SESSION_GRACE_MS = 15 * 60_000
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

const isLiveSessionStatus = (status: SessionStatus): boolean =>
  status === 'running' ||
  status === 'waiting-for-user' ||
  status === 'waiting-permission' ||
  status === 'waiting-plan-approval'

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
      isLiveSessionStatus(session.status) ||
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
  'group mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300',
  sidebarInteractiveTransitionClassName
)

const sessionRowActionClassName =
  'relative -mr-1 rounded p-0.5 text-text-100 opacity-0 transition-[opacity,color,background-color] duration-200 ease-out hover:!opacity-100 hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100'

// Shared icon wrapper inside each menu item row.
const sessionMenuIconClassName = 'flex size-4 shrink-0 items-center justify-center'

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebarView = ({
  projectName,
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
  onRenameSession,
  canDownloadArtifacts,
  onDownloadArtifacts,
  onViewNotebook,
  onExportSession,
  onTogglePin,
  canArchiveSession,
  onArchiveSession,
  onDeleteSession,
  onOpenSettings,
  mobileMode = false,
  isMobileOpen = false,
  onMobileClose,
  now,
  showSessionShortcuts = false
}: WorkspaceSidebarViewProps): React.JSX.Element => {
  const sections = getSessionSections(sessions, now)
  const shortcutNumberBySessionId = new Map(
    sections
      .flatMap((section) => section.items)
      .slice(0, 9)
      .map((session, index) => [session.id, index + 1])
  )
  const isMac = window.api?.platform === 'darwin'

  return (
    <aside
      aria-label="Workspace navigation"
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
      <div className="m-2 flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card">
        <div className="px-3 pt-3">
          <div className={cn('flex items-start', mobileMode ? 'gap-2' : 'pr-9')}>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={onGoHome}
                className={cn(
                  'flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-bg-300 hover:text-text-000',
                  sidebarInteractiveTransitionClassName
                )}
              >
                <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
                <span>All projects</span>
              </button>
              <div
                className="mt-1.5 truncate px-1.5 font-serif text-[16px] font-bold tracking-[-0.02em] text-text-000"
                title={projectName}
              >
                {projectName}
              </div>
            </div>
            {mobileMode ? (
              <button
                type="button"
                onClick={onMobileClose}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-bg-300 hover:text-text-000"
                aria-label="Close navigation"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <nav aria-label="Sessions" className="flex min-h-0 flex-1 flex-col">
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
              <span>New</span>
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
              <span>Customize</span>
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
              <span>Files</span>
            </button>
          </div>

          <div className="mx-2 my-1 h-px bg-border-300/15" />

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {sections.map((section) => (
              <div key={section.label}>
                <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                  {section.label}
                </div>
                {section.items.map((session) => {
                  const isActive = session.id === activeSessionId
                  const shortcutNumber = shortcutNumberBySessionId.get(session.id)
                  const isExportDisabled =
                    session.messages.length === 0 ||
                    session.status === 'running' ||
                    session.status === 'waiting-for-user' ||
                    session.status === 'waiting-permission'

                  return (
                    <div
                      key={session.id}
                      className={cn(sessionRowClassName, isActive && 'bg-bg-300 text-text-000')}
                      title={session.title}
                    >
                      <div className="flex w-full min-w-0 items-center gap-1.5">
                        <button
                          type="button"
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
                                sessionStatusDotClassName[session.status]
                              )}
                            />
                          </span>
                          <span className="sr-only">
                            Session status: {sessionStatusLabel[session.status]}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          {showSessionShortcuts && shortcutNumber ? (
                            <kbd
                              aria-hidden="true"
                              className="shrink-0 rounded-full bg-bg-300 px-1.5 py-0.5 font-sans text-[11px] font-medium leading-none tabular-nums text-text-100"
                            >
                              {isMac ? `⌘${shortcutNumber}` : `Ctrl+${shortcutNumber}`}
                            </kbd>
                          ) : null}
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className={cn(sessionRowActionClassName, isActive && 'opacity-100')}
                              aria-label={`Open actions for ${session.title}`}
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
                            aria-label="Session actions"
                            className="min-w-[9rem]"
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
                              {session.pinned ? 'Unpin' : 'Pin'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={!canMutateConversations}
                              onSelect={() => onRenameSession(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <Pencil className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              Rename…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {canDownloadArtifacts ? (
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => onDownloadArtifacts(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Download className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                Download all artifacts
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              className="gap-2"
                              onSelect={() => onViewNotebook(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <BookOpen className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              View notebook
                            </DropdownMenuItem>
                            {onExportSession ? (
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger
                                  className="gap-2"
                                  disabled={isExportDisabled}
                                >
                                  <span className={sessionMenuIconClassName}>
                                    <Download
                                      className="size-4"
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  </span>
                                  <span className="flex-1">Export conversation</span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent aria-label="Export conversation formats">
                                  <DropdownMenuItem
                                    className="gap-2"
                                    onSelect={() => onExportSession(session, 'markdown')}
                                  >
                                    <span className={sessionMenuIconClassName}>
                                      <FileText
                                        className="size-4"
                                        strokeWidth={2}
                                        aria-hidden="true"
                                      />
                                    </span>
                                    Markdown
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="gap-2"
                                    onSelect={() => onExportSession(session, 'pdf')}
                                  >
                                    <span className={sessionMenuIconClassName}>
                                      <FileType2
                                        className="size-4"
                                        strokeWidth={2}
                                        aria-hidden="true"
                                      />
                                    </span>
                                    PDF
                                  </DropdownMenuItem>
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            ) : null}
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={!canArchiveSession?.(session)}
                              onSelect={() => onArchiveSession?.(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <Archive className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              Archive
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
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="relative flex shrink-0 items-center gap-1 p-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0"
            />
            <NotificationBell
              side="top"
              align="start"
              className="size-8 rounded-md"
              onOpen={mobileMode ? onMobileClose : undefined}
            />
            <button
              type="button"
              onClick={onOpenSettings}
              className={cn(
                'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000',
                sidebarInteractiveTransitionClassName
              )}
              aria-label="Settings"
            >
              <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <UpdateCapsule />
            <GitHubStarBadge />
            <NetworkStatusIndicator variant="icon" />
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

  return <WorkspaceSidebarView {...props} now={now} showSessionShortcuts={showSessionShortcuts} />
}

export { WorkspaceSidebar }
export { WorkspaceSidebarView }
