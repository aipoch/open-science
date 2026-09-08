import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchX } from 'lucide-react'

import type { SessionReference } from '../../../../../shared/session-persistence'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

import { fuzzyScore } from './fuzzy-match'
import { HighlightedText } from './HighlightedText'

export type PickedSession = SessionReference

type SessionMentionPopupProps = {
  query: string
  composingRef?: React.RefObject<boolean>
  listboxId?: string
  onActiveOptionIdChange?: (optionId: string | undefined) => void
  onSelect: (session: PickedSession) => void
  onClose: () => void
}

type SessionRow = PickedSession & {
  number: number | undefined
  projectId: string
  projectName: string
  updatedAt: number
  positions: number[]
  exactNumberMatch: boolean
  score: number
}

// Suggests active Sessions across active Projects. Exact numeric lookup wins, then current-Project
// rows sort first; picking a row snapshots only global Session identity plus its current title.
export const SessionMentionPopup = ({
  query,
  composingRef,
  listboxId,
  onActiveOptionIdChange,
  onSelect,
  onClose
}: SessionMentionPopupProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const projects = useProjectStore((state) => state.projects)
  const generatedListboxId = useId()
  const resolvedListboxId = listboxId ?? generatedListboxId

  const matches = useMemo<SessionRow[]>(() => {
    const activeProjects = new Map(
      projects
        .filter((project) => project.archivedAt === undefined)
        .map((project) => [project.id, project.name])
    )
    const needle = query.trim()
    const numericNeedle = /^\d+$/.test(needle) ? needle : undefined

    return sessions
      .filter(
        (session) =>
          session.id !== selectedSessionId &&
          !session.isPending &&
          session.archivedAt === undefined &&
          activeProjects.has(session.projectId)
      )
      .map((session) => {
        const projectName = activeProjects.get(session.projectId) ?? ''
        const number =
          session.number !== undefined && Number.isSafeInteger(session.number) && session.number > 0
            ? session.number
            : undefined
        const numberText = number === undefined ? '' : String(number)
        if (numericNeedle && !numberText.startsWith(numericNeedle)) return null

        const titleMatch = needle && !numericNeedle ? fuzzyScore(needle, session.title) : undefined
        const projectMatch = needle
          ? !numericNeedle && projectName.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
          : true
        if (needle && !numericNeedle && !titleMatch && !projectMatch) return null
        return {
          type: 'session' as const,
          sessionId: session.id,
          title: session.title,
          number,
          projectId: session.projectId,
          projectName,
          updatedAt: session.updatedAt,
          positions: titleMatch?.positions ?? [],
          exactNumberMatch: numericNeedle !== undefined && numberText === numericNeedle,
          score: titleMatch?.score ?? Number.NEGATIVE_INFINITY
        }
      })
      .filter((row): row is SessionRow => row !== null)
      .sort((left, right) => {
        if (numericNeedle) {
          const exactMatchOrder = Number(right.exactNumberMatch) - Number(left.exactNumberMatch)
          if (exactMatchOrder !== 0) return exactMatchOrder
        }
        const leftCurrent = left.projectId === activeProjectId ? 1 : 0
        const rightCurrent = right.projectId === activeProjectId ? 1 : 0
        if (numericNeedle) {
          return (
            rightCurrent - leftCurrent ||
            (left.number ?? Number.POSITIVE_INFINITY) -
              (right.number ?? Number.POSITIVE_INFINITY) ||
            right.updatedAt - left.updatedAt
          )
        }
        return (
          rightCurrent - leftCurrent || right.score - left.score || right.updatedAt - left.updatedAt
        )
      })
  }, [activeProjectId, projects, query, selectedSessionId, sessions])

  const [activeIndex, setActiveIndex] = useState(0)
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  const safeIndex = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1)
  const activeOptionId = matches.length > 0 ? `${resolvedListboxId}-option-${safeIndex}` : undefined

  useEffect(() => {
    onActiveOptionIdChange?.(activeOptionId)
    return () => onActiveOptionIdChange?.(undefined)
  }, [activeOptionId, onActiveOptionIdChange])

  useEffect(() => {
    if (activeOptionId)
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || composingRef?.current) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex - 1 + matches.length) % matches.length)
      } else if (
        event.key === 'Enter' ||
        (event.key === 'Tab' &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey)
      ) {
        const active = matches[safeIndex]
        if (event.key === 'Enter' || active) event.preventDefault()
        if (active) onSelect({ type: 'session', sessionId: active.sessionId, title: active.title })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [matches, onClose, onSelect, safeIndex, composingRef])

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 flex max-h-[min(55vh,24rem)] w-max min-w-[min(320px,100%)] max-w-[min(440px,100%)] flex-col overflow-hidden rounded-xl border-0.5 border-border-200 bg-bg-000 p-1.5 shadow-[0_4px_16px_hsl(var(--always-black)/10%)]">
      {matches.length > 0 && (
        <div className="shrink-0 px-2 py-1 text-xs font-medium text-text-300">{t('Sessions')}</div>
      )}
      <ul
        id={resolvedListboxId}
        role="listbox"
        aria-label={t('Sessions')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {matches.length === 0 && (
          <li role="presentation" className="flex min-h-18 items-center gap-3 px-3 py-3.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-200 text-text-100"
            >
              <SearchX className="size-4" />
            </span>
            <div
              role="status"
              className="min-w-0 flex-1 text-sm font-medium leading-5 text-text-000"
            >
              {t('No matching sessions')}
            </div>
          </li>
        )}
        {matches.map((session, index) => {
          const isActive = index === safeIndex
          return (
            <li
              key={session.sessionId}
              id={`${resolvedListboxId}-option-${index}`}
              role="option"
              aria-selected={isActive}
              title={session.title}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                onSelect({ type: 'session', sessionId: session.sessionId, title: session.title })
              }
              className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-text-100 transition-colors hover:bg-bg-200 hover:text-text-000${
                isActive ? ' bg-bg-200 !text-text-000' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  <HighlightedText text={session.title} positions={session.positions} />
                </div>
                <div
                  data-slot="session-mention-meta"
                  className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-300"
                >
                  <span className="shrink-0">{formatDate(session.updatedAt, 'timestamp')}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{session.projectName}</span>
                </div>
              </div>
              {session.number !== undefined && (
                <span
                  data-slot="session-mention-number"
                  className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-accent-foreground tabular-nums"
                >
                  #{session.number}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="mt-1 -mx-1.5 -mb-1.5 flex shrink-0 items-center justify-end gap-3 border-t border-border-200 bg-bg-200/40 px-3 py-1.5 text-[11px] text-text-100 select-none">
        {matches.length > 0 && (
          <>
            <span>
              <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
                ↑↓
              </kbd>{' '}
              {t('navigate')}
            </span>
            <span>
              <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
                Enter / Tab
              </kbd>{' '}
              {t('select')}
            </span>
          </>
        )}
        <span>
          <kbd className="rounded border border-border-200 bg-bg-000 px-1 py-0.5 font-sans text-[10px] font-medium">
            Esc
          </kbd>{' '}
          {t('close')}
        </span>
      </div>
    </div>
  )
}
