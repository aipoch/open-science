import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
  listboxId?: string
  onActiveOptionIdChange?: (optionId: string | undefined) => void
  onSelect: (session: PickedSession) => void
  onClose: () => void
}

type SessionRow = PickedSession & {
  projectId: string
  projectName: string
  updatedAt: number
  positions: number[]
}

// Suggests active Sessions across active Projects. Current-Project rows sort first; picking a row
// snapshots only global Session identity plus its current title into the composer.
export const SessionMentionPopup = ({
  query,
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

    return sessions
      .filter(
        (session) =>
          session.id !== selectedSessionId &&
          !session.isPending &&
          session.archivedAt === undefined &&
          activeProjects.has(session.projectId)
      )
      .map((session) => {
        const titleMatch = needle ? fuzzyScore(needle, session.title) : undefined
        const projectName = activeProjects.get(session.projectId) ?? ''
        const projectMatch = needle
          ? projectName.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
          : true
        if (needle && !titleMatch && !projectMatch) return null
        return {
          type: 'session' as const,
          sessionId: session.id,
          title: session.title,
          projectId: session.projectId,
          projectName,
          updatedAt: session.updatedAt,
          positions: titleMatch?.positions ?? [],
          score: titleMatch?.score ?? Number.NEGATIVE_INFINITY
        }
      })
      .filter((row): row is SessionRow & { score: number } => row !== null)
      .sort((left, right) => {
        const leftCurrent = left.projectId === activeProjectId ? 1 : 0
        const rightCurrent = right.projectId === activeProjectId ? 1 : 0
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
  }, [matches, onClose, onSelect, safeIndex])

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 flex max-h-[min(55vh,24rem)] min-w-[320px] max-w-[440px] flex-col overflow-hidden rounded-xl border-0.5 border-border-200 bg-bg-000 p-1.5 shadow-[0_4px_16px_hsl(var(--always-black)/10%)]">
      <div className="shrink-0 px-2 py-1 text-xs font-medium text-text-300">{t('Sessions')}</div>
      <ul
        id={resolvedListboxId}
        role="listbox"
        aria-label={t('Sessions')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
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
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-300">
                  <span className="truncate">{session.projectName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{formatDate(session.updatedAt, 'timestamp')}</span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-1 -mx-1.5 -mb-1.5 flex shrink-0 items-center gap-3 border-t border-border-300 px-3.5 pt-1.5 pb-2 text-[11px] text-text-400 select-none">
        <span>
          <span className="text-text-300">↑↓</span> {t('navigate')}
        </span>
        <span>
          <span className="text-text-300">Enter / Tab</span> {t('select')}
        </span>
        <span>
          <span className="text-text-300">Esc</span> {t('close')}
        </span>
      </div>
    </div>
  )
}
