import { AlertDialog } from 'radix-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { resolveActiveSessionDisplay, truncateLabel } from '@/lib/active-session-display'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { hasDelegatedActiveSession, type ActiveSessionInfo } from '../../../shared/storage'
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

// Subscribes to main's close/quit confirmation requests, lists running work (enriching each
// session's title from the session store), and replies with the user's choice. Mounted once at
// the app root. The web build omits the close-confirm bridge entirely (close-to-tray is desktop
// only), so every call into window.api.window here must tolerate that absence. onOpenChange also
// feeds unread visibility projection, preventing a covered conversation from being acknowledged.
export const CloseConfirmModal = ({
  active = true,
  onOpenChange
}: {
  active?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [request, setRequest] = useState<ActiveRequest | undefined>(undefined)
  const [remember, setRemember] = useState(true)

  useEffect(() => {
    const windowApi = window.api.window
    if (!windowApi.onCloseConfirmRequest) return undefined
    return windowApi.onCloseConfirmRequest((payload: CloseConfirmRequest) => {
      windowApi.sendCloseConfirmResponse?.({ requestId: payload.requestId, ack: true })
      setRemember(true)
      setRequest(payload)
      onOpenChange?.(true)
    })
  }, [onOpenChange])

  const reply = (choice: CloseConfirmChoice): void => {
    if (request) {
      window.api.window.sendCloseConfirmResponse?.({
        requestId: request.requestId,
        choice,
        ...(request.variant === 'close-to-tray' ? { remember } : {})
      })
    }
    setRequest(undefined)
    onOpenChange?.(false)
  }

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const isQuitVariant = dialogRequest.variant === 'quit'
  const isPersistenceFailure = dialogRequest.variant === 'persistence-failed'
  const hasSessions = dialogRequest.sessions.length > 0
  const hasDelegatedWork = hasDelegatedActiveSession(dialogRequest.sessions)
  const title = isPersistenceFailure
    ? t('Saving is not finished', { ns: 'common' })
    : t(
        hasDelegatedWork
          ? 'Subagents are still running'
          : isQuitVariant
            ? 'Quit Open Science?'
            : 'Minimize or quit?'
      )
  const description = isPersistenceFailure
    ? t(
        'Open Science could not confirm that all recent changes were saved. Retry saving, or force quit and risk losing recent changes.',
        { ns: 'common' }
      )
    : t(
        hasDelegatedWork
          ? 'Return to the listed tasks and stop their subagents before quitting Open Science.'
          : isQuitVariant
            ? 'Work is still running and will be interrupted if you quit.'
            : 'This app can keep running in the tray, or you can quit.'
      )

  return (
    <AlertDialog.Root
      open={active && Boolean(request)}
      onOpenChange={(open) => {
        if (!open) reply('cancel')
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <AlertDialog.Content
          className={dialogPanelClassName('z-[60] w-[min(420px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>{title}</AlertDialog.Title>
          </div>

          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {description}
            </AlertDialog.Description>
            {hasSessions ? (
              <ul className="mt-3 space-y-1 text-xs">
                {dialogRequest.sessions.map((session) => {
                  const row = resolveActiveSessionDisplay(session)
                  // Clicking a row cancels the close and jumps to that session so the user can check on
                  // it. Only navigable when we resolved its project (openSession needs the project id).
                  const openThisSession = (): void => {
                    if (!row.projectId) return
                    useNavigationStore
                      .getState()
                      .openSession(row.projectId, session.sessionId, 'user', () => reply('cancel'))
                  }
                  return (
                    // title lives on the li, not the button: a disabled button dispatches no hover
                    // events, so a button-level tooltip would be dead exactly on truncated unresolved rows.
                    <li
                      key={`${session.kind}:${session.sessionId}`}
                      title={t('{{project}} — {{title}}', {
                        project: row.project,
                        title: row.title
                      })}
                    >
                      <button
                        type="button"
                        onClick={openThisSession}
                        disabled={!row.projectId}
                        className="block w-full truncate rounded-lg border border-border bg-muted/40 p-2 text-left text-foreground enabled:cursor-pointer enabled:hover:bg-muted disabled:cursor-default"
                      >
                        {t('{{project}} — {{title}}', {
                          project: truncateLabel(row.project),
                          title: truncateLabel(row.title)
                        })}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {!isQuitVariant && !isPersistenceFailure ? (
              <label className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span>{t("Don't ask again")}</span>
              </label>
            ) : null}
          </div>

          <div className={dialogFooterClassName}>
            {isPersistenceFailure ? (
              <>
                <AlertDialog.Cancel asChild>
                  <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                    {t('Stay', { ns: 'common' })}
                  </Button>
                </AlertDialog.Cancel>
                <Button type="button" onClick={() => reply('retry')}>
                  {t('Retry saving', { ns: 'common' })}
                </Button>
                <Button type="button" variant="destructive" onClick={() => reply('force-quit')}>
                  {t('Force quit', { ns: 'common' })}
                </Button>
              </>
            ) : hasDelegatedWork && isQuitVariant ? (
              <AlertDialog.Cancel asChild>
                <Button type="button">{t('Return to tasks')}</Button>
              </AlertDialog.Cancel>
            ) : isQuitVariant ? (
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
            ) : (
              <Button type="button" variant="ghost" onClick={() => reply('minimize')}>
                {t('Minimize to tray')}
              </Button>
            )}
            {!hasDelegatedWork && !isPersistenceFailure ? (
              <Button type="button" onClick={() => reply('quit')}>
                {t('Quit', { context: 'verb', ns: 'common' })}
              </Button>
            ) : null}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
