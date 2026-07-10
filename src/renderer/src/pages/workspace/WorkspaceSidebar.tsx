import { ChevronLeft, Files, MoreVertical, Pencil, Plus, Settings, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'

import { cn } from '@/lib/utils'
import type { ChatSession, SessionStatus } from '@/stores/session-store'

type WorkspaceSidebarProps = {
  projectName: string
  sessions: ChatSession[]
  activeSessionId: string | undefined
  canCreateConversation: boolean
  onGoHome: () => void
  onNewConversation: () => void
  isFilesOpen: boolean
  onOpenFiles: () => void
  onOpenSession: (sessionId: string) => void
  onRenameSession: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
  onOpenSettings: () => void
}

// Maps each session status to the left-side indicator dot using emitted theme colors.
const sessionStatusDotClassName: Record<SessionStatus, string> = {
  idle: 'border border-text-100 bg-transparent',
  running: 'bg-session-running ring-2 ring-session-running/20',
  'waiting-permission': 'bg-session-waiting ring-2 ring-session-waiting/25',
  error: 'bg-destructive'
}

const sessionStatusLabel: Record<SessionStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  'waiting-permission': 'Waiting for permission',
  error: 'Error'
}

const sidebarInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

const sessionRowClassName = cn(
  'group mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300',
  sidebarInteractiveTransitionClassName
)

const sessionRowActionClassName =
  'relative -mr-1 rounded p-0.5 text-text-100 opacity-0 transition-[opacity,color,background-color] duration-200 ease-out hover:!opacity-100 hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100'

const sessionMenuContentClassName =
  'z-modal min-w-[9rem] rounded-xl border-[0.5px] border-border-200 bg-bg-000 p-1.5 shadow-menu'

const sessionMenuItemClassName =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text-100 transition-colors duration-200 ease-out outline-none data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000'

const sessionMenuDangerItemClassName =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-danger-000 transition-colors duration-200 ease-out outline-none data-[highlighted]:bg-danger-900'

const sessionMenuIconClassName = 'flex size-4 shrink-0 items-center justify-center'

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebar = ({
  projectName,
  sessions,
  activeSessionId,
  canCreateConversation,
  onGoHome,
  onNewConversation,
  isFilesOpen,
  onOpenFiles,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onOpenSettings
}: WorkspaceSidebarProps): React.JSX.Element => (
  <aside className="z-10 flex h-full w-[220px] min-w-0 shrink-0 flex-col">
    <div className="m-2 mr-0 flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card">
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onGoHome}
          className={cn(
            'flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-100 hover:bg-bg-300 hover:text-text-000',
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
            <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
              <Plus className="size-3.5" strokeWidth={2} />
            </span>
            <span>New</span>
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
            <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
              <Files className="size-3.5" strokeWidth={2} />
            </span>
            <span>Files</span>
          </button>
        </div>

        <div className="mx-2 my-1 h-px bg-border-300/15" />

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <div>
            <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-text-100">Active</div>
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId

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
                    </button>

                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
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
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          aria-label="Session actions"
                          className={sessionMenuContentClassName}
                          side="right"
                          align="start"
                          sideOffset={6}
                        >
                          <DropdownMenu.Item
                            className={sessionMenuItemClassName}
                            onSelect={() => onRenameSession(session)}
                          >
                            <span className={sessionMenuIconClassName}>
                              <Pencil className="size-4" strokeWidth={2} aria-hidden="true" />
                            </span>
                            Rename…
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border-300" />
                          <DropdownMenu.Item
                            className={sessionMenuDangerItemClassName}
                            onSelect={() => onDeleteSession(session)}
                          >
                            <span className={sessionMenuIconClassName}>
                              <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                            </span>
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="relative flex shrink-0 items-center gap-1 p-2">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0"
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
        </div>
      </nav>
    </div>
  </aside>
)

export { WorkspaceSidebar }
