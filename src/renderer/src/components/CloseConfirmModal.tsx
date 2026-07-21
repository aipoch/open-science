import { AlertDialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { ActiveSessionInfo } from '../../../shared/storage'
import type {
  CloseConfirmChoice,
  CloseConfirmRequest,
  CloseConfirmVariant
} from '../../../shared/window-controls'

type ActiveRequest = {
  requestId: string
  variant: CloseConfirmVariant
  sessions: ActiveSessionInfo[]
}

type ResolvedRow = {
  // The owning project's display name (not its id), resolved via the session's projectId.
  project: string
  title: string
  // Present only when the session resolves to a project, so the row can navigate into it.
  projectId?: string
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// Cap each label so one long project name or title can't blow out the row; the button's title
// attribute still carries the full text on hover.
const MAX_LABEL_CHARS = 28
const truncate = (text: string): string =>
  text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : text

// Resolves a running-session row to its display fields. main only knows the session's id + a stored
// project *id*, so the human project NAME and title are looked up here from the renderer stores;
// projectId is returned so the row can open that session. Falls back progressively so a row is never
// blank: project name -> cwd basename -> whatever main sent.
const resolveRow = (info: ActiveSessionInfo): ResolvedRow => {
  const session = useSessionStore.getState().sessions.find((entry) => entry.id === info.sessionId)
  const projectId = session?.projectId
  const projectName = projectId
    ? useProjectStore.getState().projects.find((project) => project.id === projectId)?.name
    : undefined
  const cwdName = session?.cwd ? basename(session.cwd) : undefined
  return {
    project: projectName ?? cwdName ?? info.projectName,
    title: session?.title?.trim() || info.title?.trim() || info.sessionId,
    projectId
  }
}

// Subscribes to main's close/quit confirmation requests, lists running work (enriching each
// session's title from the session store), and replies with the user's choice. Mounted once at
// the app root. The web build omits the close-confirm bridge entirely (close-to-tray is desktop
// only), so every call into window.api.window here must tolerate that absence.
export const CloseConfirmModal = (): React.JSX.Element | null => {
  const [request, setRequest] = useState<ActiveRequest | undefined>(undefined)

  useEffect(() => {
    const windowApi = window.api.window
    if (!windowApi.onCloseConfirmRequest) return undefined
    return windowApi.onCloseConfirmRequest((payload: CloseConfirmRequest) => {
      windowApi.sendCloseConfirmResponse?.({ requestId: payload.requestId, ack: true })
      setRequest(payload)
    })
  }, [])

  const reply = (choice: CloseConfirmChoice): void => {
    if (request) {
      window.api.window.sendCloseConfirmResponse?.({ requestId: request.requestId, choice })
    }
    setRequest(undefined)
  }

  if (!request) return null

  const isQuitVariant = request.variant === 'quit'
  const hasSessions = request.sessions.length > 0
  const title = isQuitVariant ? 'Quit Open Science?' : 'Minimize or quit?'
  const description = isQuitVariant
    ? 'Work is still running and will be interrupted if you quit.'
    : 'This app can keep running in the tray, or you can quit.'

  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) reply('cancel')
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog">
          <AlertDialog.Title className="text-sm font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs text-muted-foreground">
            {description}
          </AlertDialog.Description>
          {hasSessions ? (
            <ul className="mt-3 space-y-1 text-xs">
              {request.sessions.map((session) => {
                const row = resolveRow(session)
                // Clicking a row cancels the close and jumps to that session so the user can check on
                // it. Only navigable when we resolved its project (openSession needs the project id).
                const openThisSession = (): void => {
                  if (!row.projectId) return
                  useNavigationStore.getState().openSession(row.projectId, session.sessionId)
                  reply('cancel')
                }
                return (
                  // title lives on the li, not the button: a disabled button dispatches no hover
                  // events, so a button-level tooltip would be dead exactly on truncated unresolved rows.
                  <li
                    key={`${session.kind}:${session.sessionId}`}
                    title={`${row.project} — ${row.title}`}
                  >
                    <button
                      type="button"
                      onClick={openThisSession}
                      disabled={!row.projectId}
                      className="block w-full truncate rounded-lg border border-border bg-muted/40 p-2 text-left text-foreground enabled:cursor-pointer enabled:hover:bg-muted disabled:cursor-default"
                    >
                      {truncate(row.project)} — {truncate(row.title)}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            {isQuitVariant ? (
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
            ) : (
              <Button type="button" variant="ghost" onClick={() => reply('minimize')}>
                Minimize to tray
              </Button>
            )}
            <Button type="button" onClick={() => reply('quit')}>
              Quit
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
