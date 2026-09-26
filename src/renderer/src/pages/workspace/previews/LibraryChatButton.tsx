import { ChevronDown, MessageSquare, Plus, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSessionStore } from '@/stores/session-store'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import type { LiteratureReference } from '../../../../../shared/session-persistence'
import { useLibraryReferenceActions } from './library-reference-actions'

// Mount the session subscription only while the picker is open. Summaries are already loaded by
// the workspace; bounded rendering never hydrates message histories just to choose a destination.
function ConversationPicker({
  onSelect
}: {
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const actions = useLibraryReferenceActions()
  const sessions = useSessionStore((state) => state.sessions)
  const formatDate = useDateTimeFormat()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const number = /^#?\d+$/.test(needle) ? needle.replace(/^#/, '') : undefined
    return sessions
      .filter(
        (session) =>
          session.projectId === actions?.projectId &&
          !session.isPending &&
          !session.packageOrigin &&
          session.archivedAt === undefined &&
          session.status !== 'waiting-plan-approval' &&
          (number !== undefined
            ? String(session.number ?? '').startsWith(number)
            : session.title.toLocaleLowerCase().includes(needle))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, actions?.projectId, query])
  const visible = matches.slice(0, limit)
  const safeIndex = Math.min(activeIndex, visible.length - 1)
  const activeId = safeIndex >= 0 ? `${listId}-${visible[safeIndex].id}` : undefined
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  return (
    <>
      <div className="relative m-2">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          autoFocus
          role="combobox"
          aria-label={t('Search conversations')}
          placeholder={t('Search by title or #number')}
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeId}
          className="h-8 pl-8 text-xs"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setLimit(10)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (visible.length)
                setActiveIndex(
                  (safeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) %
                    visible.length
                )
            } else if (event.key === 'Enter' && safeIndex >= 0) {
              event.preventDefault()
              onSelect(visible[safeIndex].id)
            }
          }}
        />
      </div>
      <div className="px-3 pb-1 text-[11px] text-muted-foreground">{t('Current project')}</div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('Conversations')}
        className="max-h-60 overflow-y-auto px-1"
      >
        {visible.map((session, index) => (
          <div
            key={session.id}
            id={`${listId}-${session.id}`}
            role="option"
            aria-selected={index === safeIndex}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 aria-selected:bg-bg-200"
            onPointerMove={() => setActiveIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(session.id)}
          >
            <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{session.title}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {session.number ? `#${session.number} · ` : ''}
                {formatDate(session.updatedAt, 'date')}
              </div>
            </div>
            {session.id === actions?.currentSessionId && (
              <span className="text-[11px] text-muted-foreground">{t('Current')}</span>
            )}
          </div>
        ))}
      </div>
      {matches.length === 0 && (
        <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
          {t('No matching conversations')}
        </p>
      )}
      {matches.length > limit && (
        <Button
          variant="ghost"
          size="xs"
          className="mx-2 my-1"
          onClick={() => setLimit(limit + 10)}
        >
          {t('Load more')}
        </Button>
      )}
      <div className="mt-1 border-t border-border p-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => onSelect(null)}
        >
          <Plus aria-hidden="true" />
          {t('New conversation')}
        </Button>
      </div>
      <p className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        {t('Added to the draft. You choose when to send.')}
      </p>
    </>
  )
}

export function LibraryChatButton({
  references
}: {
  references: readonly LiteratureReference[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const actions = useLibraryReferenceActions()
  const [open, setOpen] = useState(false)
  const selected = useRef(false)
  const add = (sessionId: string | null): void => {
    if (!actions || !references.length) return
    selected.current = true
    setOpen(false)
    actions.add(references, sessionId)
  }
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border bg-background">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="rounded-r-none"
            disabled={!actions?.canAddToCurrent || !references.length}
            onClick={() => add(actions?.currentSessionId ?? null)}
          >
            {t('Add to chat')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('Add references to the current conversation draft')}</TooltipContent>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={(value) => {
          selected.current = false
          setOpen(value)
        }}
      >
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="rounded-l-none border-l border-border px-1.5"
                disabled={!actions || !references.length}
                aria-label={t('Choose another conversation')}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('Choose another conversation')}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          aria-label={t('Choose another conversation')}
          className="z-[130] w-80 max-w-[calc(100vw-2rem)] border border-border bg-popover p-0 text-popover-foreground shadow-menu"
          onCloseAutoFocus={(event) => {
            if (selected.current) event.preventDefault()
          }}
        >
          {open && <ConversationPicker onSelect={add} />}
        </PopoverContent>
      </Popover>
    </div>
  )
}
