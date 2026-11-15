import { MessageSquare, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import type { ChatSession } from '@/stores/session-store'

// Search summaries without hydrating conversation histories. Callers own target eligibility.
export function ConversationPicker({
  sessions,
  currentSessionId,
  onSelect
}: {
  sessions: readonly Pick<ChatSession, 'id' | 'title' | 'number' | 'updatedAt'>[]
  currentSessionId?: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const number = /^#?\d+$/.test(needle) ? needle.replace(/^#/, '') : undefined
    return sessions
      .filter((session) =>
        number !== undefined
          ? String(session.number ?? '').startsWith(number)
          : session.title.toLocaleLowerCase().includes(needle)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query])
  const visible = matches.slice(0, limit)
  const safeIndex = Math.min(activeIndex, visible.length - 1)
  const activeId = safeIndex >= 0 ? `${listId}-${visible[safeIndex].id}` : undefined
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  return (
    <>
      <div className="relative m-2 shrink-0">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
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
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (safeIndex >= 0) onSelect(visible[safeIndex].id)
            }
          }}
        />
      </div>
      <div className="px-3 pb-1 text-[11px] text-muted-foreground">{t('Current project')}</div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('Conversations')}
        className="min-h-0 max-h-60 shrink overflow-y-auto px-1"
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
              <div className="mt-0.5 flex gap-2 text-[11px] text-muted-foreground">
                {session.number && <span>#{session.number}</span>}
                <span>{formatDate(session.updatedAt, 'date')}</span>
              </div>
            </div>
            {session.id === currentSessionId && (
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
          type="button"
          variant="ghost"
          size="xs"
          className="mx-2 my-1"
          onClick={() => setLimit(limit + 10)}
        >
          {t('Load more')}
        </Button>
      )}
    </>
  )
}
