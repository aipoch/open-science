import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
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

// Maps a session id to its human title from the store, falling back to the id when unknown.
const resolveTitle = (sessionId: string): string => {
  const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)
  return session?.title?.trim() || sessionId
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
  const title = isQuitVariant ? 'Quit Open Science?' : 'Minimize or quit?'

  return (
    <Dialog.Root open onOpenChange={(open) => (!open ? reply('cancel') : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog">
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          {request.sessions.length > 0 ? (
            <>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                Still running:
              </Dialog.Description>
              <ul className="mt-3 space-y-1 text-xs">
                {request.sessions.map((session) => (
                  <li
                    key={`${session.kind}:${session.sessionId}`}
                    className="rounded-lg border border-border bg-muted/40 p-2 text-foreground"
                  >
                    {session.projectName} — {resolveTitle(session.sessionId)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            {isQuitVariant ? (
              <>
                <Button type="button" variant="ghost" onClick={() => reply('cancel')}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => reply('quit')}>
                  Quit
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => reply('minimize')}>
                  Minimize to tray
                </Button>
                <Button type="button" onClick={() => reply('quit')}>
                  Quit
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
