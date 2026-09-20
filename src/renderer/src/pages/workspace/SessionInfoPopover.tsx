/* Hallmark · component: session information · genre: modern-minimal · theme: existing semantic tokens
 * pre-emit critique: P5 H5 E4 S5 R5 V4
 */
import { useId, useRef, useState } from 'react'
import { ChevronDown, GitBranch, Pencil, Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ChatSession } from '@/stores/session-store'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'

type SessionInfoPopoverProps = {
  onTogglePin?: (session: ChatSession) => void
  session: ChatSession
  sourceSession?: Pick<ChatSession, 'id' | 'title' | 'number'>
  onOpenSession?: (sessionId: string) => void
  onEdit?: (session: ChatSession) => void
}

const SessionInfoPopover = ({
  session,
  sourceSession,
  onOpenSession,
  onEdit,
  onTogglePin
}: SessionInfoPopoverProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const handingOffFocus = useRef(false)
  const headingId = useId()
  const loading = session.contentLoaded === false
  // The store's messages are the selected frame/branch projection, just like the transcript.
  const messages = open
    ? session.messages.filter((message) => !isHiddenControlMessage(message))
    : []
  const number = new Intl.NumberFormat(i18n?.language)
  const dates = new Intl.DateTimeFormat(i18n?.language, { dateStyle: 'medium', timeStyle: 'short' })
  const sourceTitle = sourceSession
    ? `${sourceSession.number !== undefined ? `#${sourceSession.number} · ` : ''}${sourceSession.title}`
    : session.branchSource?.sessionId

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          className="h-auto min-h-8 min-w-0 max-w-[min(100%,20rem)] shrink justify-start gap-2 px-2 py-1 text-[13px] font-semibold text-text-000 transition-none max-md:min-h-11"
          aria-label={t('Session information: {{title}}', { title: session.title })}
        >
          {session.number !== undefined ? (
            <span className="shrink-0 font-normal text-muted-foreground">#{session.number}</span>
          ) : null}
          <span className="truncate" title={session.title}>
            {session.title}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={headingId}
        className="w-[min(360px,calc(100vw-1.5rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-popover p-0 text-sm text-popover-foreground shadow-menu"
        onCloseAutoFocus={(event) => {
          if (handingOffFocus.current) {
            event.preventDefault()
            handingOffFocus.current = false
          }
        }}
      >
        <div className="px-4 pb-3 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <h2
              id={headingId}
              className="min-w-0 flex-1 truncate text-sm font-semibold"
              title={session.title}
            >
              {session.title}
            </h2>
            {session.number !== undefined ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                #{session.number}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="-mr-2 size-8 shrink-0 text-muted-foreground transition-none max-md:size-11"
              aria-label={t(session.pinned ? 'Unpin' : 'Pin')}
              title={t(session.pinned ? 'Unpin' : 'Pin')}
              aria-pressed={session.pinned === true}
              disabled={!onTogglePin || session.isPending}
              onClick={() => onTogglePin?.(session)}
            >
              <Pin
                className={`size-4 ${session.pinned ? 'fill-current text-foreground' : ''}`}
                aria-hidden="true"
              />
            </Button>
          </div>
          {session.description ? (
            <p className="mt-1.5 line-clamp-2 break-words text-sm leading-5 text-muted-foreground">
              {session.description}
            </p>
          ) : null}
        </div>
        {session.branchSource ? (
          <div className="mx-4 flex min-w-0 items-start gap-2 border-t border-border py-3">
            <GitBranch
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-xs text-muted-foreground">{t('Source session')}</p>
              {sourceSession && onOpenSession ? (
                <button
                  type="button"
                  className="block max-w-full truncate rounded-sm text-left text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:opacity-80"
                  title={sourceTitle}
                  onClick={() => {
                    handingOffFocus.current = true
                    setOpen(false)
                    onOpenSession(sourceSession.id)
                  }}
                >
                  {sourceTitle}
                </button>
              ) : (
                <>
                  <p className="truncate text-sm" title={sourceTitle}>
                    {sourceTitle}
                  </p>
                  {!sourceSession ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Source session unavailable')}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}
        <dl className="mx-4 space-y-3 border-t border-border py-3 text-xs">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('Created')}</dt>
            <dd className="text-right tabular-nums">
              <time dateTime={new Date(session.createdAt).toISOString()}>
                {dates.format(session.createdAt)}
              </time>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('Last updated')}</dt>
            <dd className="text-right tabular-nums">
              <time dateTime={new Date(session.updatedAt).toISOString()}>
                {dates.format(session.updatedAt)}
              </time>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('Messages in current branch')}</dt>
            <dd className="text-right tabular-nums">
              {loading ? '—' : number.format(messages.length)}
              {!loading ? (
                <span className="mt-1 block text-muted-foreground">
                  {t('{{total}} from Assistant', {
                    total: number.format(
                      messages.filter((message) => message.role === 'agent').length
                    )
                  })}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('Artifacts')}</dt>
            <dd className="tabular-nums">
              {loading
                ? '—'
                : number.format(new Set(session.artifacts?.map((artifact) => artifact.id)).size)}
            </dd>
          </div>
        </dl>
        {loading ? (
          <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">
            {t('Loading session information…')}
          </p>
        ) : null}
        <div className="border-t border-border p-1.5">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-sm font-normal transition-none max-md:min-h-11"
            disabled={!onEdit || loading || session.isPending}
            onClick={() => {
              // The dialog captures this persistent trigger, not the disappearing card action.
              handingOffFocus.current = true
              triggerRef.current?.focus()
              setOpen(false)
              onEdit?.(session)
            }}
          >
            <Pencil className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('Edit session')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { SessionInfoPopover }
