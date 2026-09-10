import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  AtSign,
  BookOpenText,
  File,
  Folder,
  LoaderCircle,
  Grid2X2,
  MessageCircle,
  Search,
  Upload,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { findSearchMatches, searchTitleRank, type SearchSort } from '../../../../shared/search-text'
import { resolveLocaleFromTags } from '../../../../shared/locale'
import { formatBytes } from '../../../../shared/update'
import { formatRelativeTime } from '@/lib/format-datetime'
import { searchSessionTitles } from './global-search-catalog'
import { SearchDetails } from './SearchDetails'
import { SearchResultFilters } from './SearchResultFilters'
import { ErrorNotice } from '@/components/error-notice'
import { useSearchSummaryCounts } from './use-search-summary-counts'
import { useRecentSearches } from './use-recent-searches'
import { SearchHighlight } from './SearchHighlight'
import {
  emptySearchPage,
  hasMoreSearchResults,
  isRemoteCategory,
  useSearchResults,
  type SearchPage
} from './use-search-results'
import {
  filePreviewItem,
  resultId,
  resultTitle,
  SEARCH_CATEGORIES,
  SEARCH_GROUP_ORDER,
  messageTitle,
  fileFormatLabel,
  type SearchCategory,
  type SearchResult,
  type SearchSession
} from './search-result'
import './global-search.css'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isSessionPersistenceReady: boolean
}
const icons = {
  messages: MessageCircle,
  sessions: MessageCircle,
  projects: Folder,
  uploads: Upload,
  generated: File,
  library: BookOpenText
}
const initialCounts = (): Record<'projects' | 'sessions', number> => ({
  projects: 10,
  sessions: 10
})

const updateStickyHeadings = (viewport: HTMLDivElement | null): void => {
  if (!viewport) return
  const top = viewport.getBoundingClientRect().top
  // Compare the group's natural position so a header at rest at the top has no shadow.
  const headings = [...viewport.querySelectorAll<HTMLElement>('.search-group-heading')].map(
    (heading) => ({
      heading,
      stuck:
        heading.parentElement!.getBoundingClientRect().top < top &&
        heading.getBoundingClientRect().bottom > top
    })
  )
  for (const { heading, stuck } of headings) heading.dataset.stuck = String(stuck)
}

export const GlobalSearchDialog = ({
  open,
  onOpenChange,
  isSessionPersistenceReady
}: Props): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    updateStickyHeadings(listRef.current)
  })
  const [query, setQuery] = useState('')
  const { recentSearches, rememberSearch } = useRecentSearches()
  const [category, setCategory] = useState<SearchCategory | 'all'>('all')
  const [currentProjectOnly, setCurrentProjectOnly] = useState(false)
  const [sort, setSort] = useState<SearchSort>('relevance')
  const [days, setDays] = useState(0)
  const [dateReference, setDateReference] = useState(Date.now)
  const [subtype, setSubtype] = useState('all')
  const updatedAfter = days ? dateReference - days * 86_400_000 : undefined
  const [counts, setCounts] = useState(initialCounts)
  const [selected, setSelected] = useState<SearchResult>()
  const [retained, setRetained] = useState<SearchResult>()
  const [activeId, setActiveId] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const actionVersion = useRef(0)
  const allProjects = useProjectStore((state) => state.projects)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const view = useNavigationStore((state) => state.view)
  const restrictToProject = currentProjectOnly && view === 'workspace' && !!activeProjectId
  // Transcript stream chunks do not affect search metadata or restart its requests.
  const sessionMetadata = useSessionStore(
    useShallow((state) =>
      state.sessions.map((session) =>
        JSON.stringify({
          id: session.id,
          projectId: session.projectId,
          title: session.title,
          number: session.number,
          updatedAt: session.updatedAt,
          archivedAt: session.archivedAt,
          isPending: session.isPending,
          artifactCount: session.artifactCount ?? session.artifacts?.length ?? 0,
          activeMessageCount:
            session.contentLoaded === false
              ? (session.activeMessageCount ?? 0)
              : session.messages.length
        })
      )
    )
  )
  const projects = useMemo(
    () => allProjects.filter((item) => item.archivedAt === undefined),
    [allProjects]
  )
  const projectNames = useMemo(
    () => new Map(projects.map((item) => [item.id, item.name])),
    [projects]
  )
  const allMetadata = useMemo(
    () =>
      sessionMetadata.map((item) => JSON.parse(item) as SearchSession & { archivedAt?: number }),
    [sessionMetadata]
  )
  const sessions = useMemo(
    () =>
      allMetadata.filter(
        (item) =>
          item.archivedAt === undefined && !item.isPending && projectNames.has(item.projectId)
      ),
    [allMetadata, projectNames]
  )
  const scopedProjects = restrictToProject
    ? projects.filter((item) => item.id === activeProjectId)
    : projects
  const scopedSessions = restrictToProject
    ? sessions.filter((item) => item.projectId === activeProjectId)
    : sessions
  const scopeKey = JSON.stringify({
    category,
    projectIds: scopedProjects.map((item) => item.id).sort(),
    excludedSessionIds: allMetadata
      .filter((item) => item.archivedAt !== undefined || item.isPending)
      .map((item) => item.id)
      .sort(),
    ...(restrictToProject ? { projectId: activeProjectId } : {}),
    updatedAfter,
    sort,
    ...(category === 'messages' && subtype !== 'all' ? { role: subtype } : {}),
    ...((category === 'uploads' || category === 'generated') && subtype !== 'all'
      ? { format: subtype }
      : {}),
    ...(category === 'library' && subtype !== 'all' ? { entryKind: subtype } : {})
  })
  const { pages, load } = useSearchResults(open, isSessionPersistenceReady, query.trim(), scopeKey)
  const labels = {
    all: t('All'),
    messages: t('Messages'),
    sessions: t('Sessions'),
    projects: t('Projects'),
    uploads: t('Uploaded files'),
    generated: t('Generated files'),
    library: t('Library')
  }

  const matchedProjects = scopedProjects
    .filter((item) => updatedAfter === undefined || item.updatedAt >= updatedAfter)
    .filter(
      (item) =>
        !query.trim() || findSearchMatches(`${item.name}\n${item.description}`, query).length > 0
    )
    .sort(
      (a, b) =>
        (sort === 'relevance'
          ? searchTitleRank(b.name, query) - searchTitleRank(a.name, query)
          : 0) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
    )
  const sessionMatches = searchSessionTitles({
    sessions: scopedSessions.filter(
      (item) => updatedAfter === undefined || item.updatedAt >= updatedAfter
    ),
    query,
    sort
  })
  const sessionItems = sessionMatches
    .slice(0, counts.sessions)
    .map((item) => ({ kind: 'sessions' as const, item }))
  const groups: Record<SearchCategory, SearchPage> = {
    ...pages,
    projects: {
      ...emptySearchPage(),
      totalCount: matchedProjects.length,
      items: matchedProjects.slice(0, counts.projects).map((item) => ({ kind: 'projects', item }))
    },
    sessions: {
      ...emptySearchPage(),
      totalCount: sessionMatches.length,
      items: sessionItems
    }
  }
  const shownCategories: readonly SearchCategory[] =
    category === 'all' ? SEARCH_GROUP_ORDER : [category]
  const rows = shownCategories.flatMap((key) => groups[key].items)
  const anyLoading = shownCategories.some((key) => groups[key].loading)
  const anyError = shownCategories.some((key) => groups[key].error || groups[key].incomplete)
  const total = shownCategories.reduce((sum, key) => sum + groups[key].totalCount, 0)
  const summaryCounts = useSearchSummaryCounts(open, rows)
  const selectedId = selected ? resultId(selected) : undefined
  const collapse = useCallback(() => {
    setSelected(undefined)
    inputRef.current?.focus()
  }, [])
  const select = useCallback((result: SearchResult, fromPointer = false) => {
    setSelected(result)
    setRetained(result)
    setActiveId(resultId(result))
    setActionError(undefined)
    if (fromPointer && window.matchMedia?.('(max-width: 740px)').matches)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>('.search-detail-back')
          ?.focus({ preventScroll: true })
      )
  }, [])
  const resetSelection = (): void => {
    setSelected(undefined)
    setActiveId(undefined)
    setActionError(undefined)
    setCounts(initialCounts())
    if (listRef.current) listRef.current.scrollTop = 0
  }
  useLayoutEffect(() => {
    const version = actionVersion
    version.current++
    return () => {
      version.current++
    }
  }, [open, query, scopeKey])
  if (
    selected &&
    selected.kind !== 'library' &&
    !projectNames.has(selected.kind === 'projects' ? selected.item.id : selected.item.projectId)
  )
    setSelected(undefined)
  useEffect(() => {
    if (selected) return
    const timer = window.setTimeout(() => setRetained(undefined), 240)
    return () => window.clearTimeout(timer)
  }, [selected])

  const close = (): void => {
    actionVersion.current++
    onOpenChange(false)
  }
  const openResult = (result: SearchResult): void => {
    rememberSearch(query)
    const nav = useNavigationStore.getState()
    if (result.kind === 'uploads' || result.kind === 'generated') {
      const show = (): void => {
        usePreviewWorkbenchStore.getState().openFileDialog(filePreviewItem(result.item))
        close()
      }
      if (nav.activeProjectId !== result.item.projectId || nav.view !== 'workspace')
        nav.openProject(result.item.projectId, 'user', show)
      else show()
    } else if (result.kind === 'projects') nav.openProject(result.item.id, 'user', close)
    else if (result.kind === 'sessions' || result.kind === 'messages') {
      const sessionId = result.kind === 'sessions' ? result.item.id : result.item.sessionId
      if (
        !sessions.some((item) => item.id === sessionId && item.projectId === result.item.projectId)
      ) {
        setActionError(t('This session is no longer available.'))
        return
      }
      nav.openSession(result.item.projectId, sessionId, 'user', () => {
        if (result.kind === 'messages')
          useSearchMessageFocusStore.getState().request({
            projectId: result.item.projectId,
            sessionId,
            messageId: result.item.messageId,
            navigationRevision: useNavigationStore.getState().userNavigationRevision
          })
        close()
      })
    } else {
      if ('item' in result.item) {
        nav.openLiteratureItem(result.item.id, 'user')
        close()
      } else if (nav.openCollectionLiterature(result.item.id, 'user')) close()
    }
  }
  const canMention = (file: ProjectFileItem): boolean => {
    const nav = useNavigationStore.getState()
    const session = useSessionStore
      .getState()
      .sessions.find((item) => item.id === useSessionStore.getState().selectedSessionId)
    return (
      nav.view === 'workspace' &&
      nav.activeProjectId === file.projectId &&
      session?.projectId === file.projectId &&
      nav.artifactMentionAvailability?.projectId === file.projectId &&
      nav.artifactMentionAvailability.canMention
    )
  }
  const locateFile = async (file: ProjectFileItem): Promise<void> => {
    const version = ++actionVersion.current
    const navigationRevision = useNavigationStore.getState().userNavigationRevision
    setActionError(undefined)
    try {
      let messageId = file.messageId
      // Upload catalog rows have no message owner; resolve the attachment by immutable identity.
      if (!messageId) {
        const session = await window.api.sessions.loadOne({
          projectId: file.projectId,
          sessionId: file.sessionId
        })
        messageId = session?.messages.find((message) =>
          file.source === 'upload'
            ? message.uploads?.some(
                (attachment) =>
                  attachment.id === file.sourceFileId &&
                  (!attachment.versionId || attachment.versionId === file.sourceVersionId)
              )
            : message.artifactIds?.includes(file.sourceFileId)
        )?.id
      }
      if (
        actionVersion.current !== version ||
        useNavigationStore.getState().userNavigationRevision !== navigationRevision
      )
        return
      if (!messageId) {
        setActionError(t('The source message is no longer available.'))
        return
      }
      const targetMessageId = messageId
      const nav = useNavigationStore.getState()
      nav.openSession(file.projectId, file.sessionId, 'user', () => {
        useSearchMessageFocusStore.getState().request({
          projectId: file.projectId,
          sessionId: file.sessionId,
          messageId: targetMessageId,
          navigationRevision: useNavigationStore.getState().userNavigationRevision
        })
        close()
      })
    } catch {
      if (actionVersion.current === version)
        setActionError(t('The source message is no longer available.'))
    }
  }
  const mention = async (file: ProjectFileItem): Promise<void> => {
    if (!canMention(file)) return
    const version = ++actionVersion.current
    setActionError(undefined)
    try {
      const response = await window.api.managedFileVersions.inspect({
        source: file.source,
        projectId: file.projectId,
        fileId: file.sourceFileId
      })
      if (actionVersion.current !== version || !canMention(file)) return
      if (!response.ok) {
        setActionError(t('Could not resolve file version.'))
        return
      }
      const head =
        response.value.headVersion ??
        response.value.versions.find((item) => item.id === response.value.headVersionId)
      if (!head) {
        setActionError(t('The current file version is unavailable.'))
        return
      }
      useNavigationStore.getState().requestArtifactMention({
        ...file,
        sourceVersionId: head.id,
        checksum: head.checksum,
        sessionId: response.value.sessionId,
        name: response.value.displayName,
        mimeType: head.contentType ?? file.mimeType,
        size: head.sizeBytes,
        sortAtMs: Date.parse(head.createdAt)
      })
      close()
    } catch {
      if (actionVersion.current === version) setActionError(t('Could not resolve file version.'))
    }
  }
  const loadMore = useCallback(
    (key: SearchCategory) => {
      if (isRemoteCategory(key)) void load(key, true)
      else setCounts((current) => ({ ...current, [key]: current[key] + 10 }))
    },
    [load]
  )
  const filteredPage = category === 'all' ? undefined : groups[category]
  useEffect(() => {
    if (
      category === 'all' ||
      !filteredPage ||
      filteredPage.loading ||
      filteredPage.error ||
      !hasMoreSearchResults(category, filteredPage) ||
      typeof IntersectionObserver === 'undefined'
    )
      return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore(category)
      },
      { root: listRef.current, rootMargin: '0px 0px 80px' }
    )
    if (loadMoreRef.current) observer.observe(loadMoreRef.current)
    return () => observer.disconnect()
  }, [category, filteredPage, loadMore])
  const scrollMore = (): void => {
    const viewport = listRef.current
    updateStickyHeadings(viewport)
    if (
      category !== 'all' &&
      viewport &&
      viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 80 &&
      !groups[category].loading &&
      !groups[category].error &&
      hasMoreSearchResults(category, groups[category])
    )
      loadMore(category)
  }
  const subtitle = (result: SearchResult): string => {
    const fileCount = summaryCounts[resultId(result)]
    const fileSummary =
      typeof fileCount === 'number'
        ? t('{{count}} files', { count: fileCount, defaultValue_one: '{{count}} file' })
        : fileCount === null
          ? undefined
          : t('Loading…')
    if (result.kind === 'projects')
      return [
        t('{{count}} sessions', {
          count: sessions.filter((session) => session.projectId === result.item.id).length,
          defaultValue_one: '{{count}} session'
        }),
        fileSummary,
        formatRelativeTime(result.item.updatedAt, locale)
      ]
        .filter(Boolean)
        .join(' · ')
    if (result.kind === 'library')
      return 'item' in result.item
        ? [
            result.item.item.creators
              .map((creator) =>
                creator.nameMode === 'organization'
                  ? creator.literalName
                  : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
              )
              .join(', '),
            result.item.item.issuedYear,
            result.item.item.containerTitle
          ]
            .filter(Boolean)
            .join(' · ')
        : t('{{count}} items', { count: result.item.itemCount, defaultValue_one: '{{count}} item' })
    const project = projectNames.get(result.item.projectId) ?? ''
    return result.kind === 'messages'
      ? `${project} · #${result.item.sessionNumber} · ${result.item.role === 'user' ? t('You') : t('Agent')}`
      : result.kind === 'sessions'
        ? [
            project,
            `#${result.item.number}`,
            t('{{count}} messages', {
              count: result.item.activeMessageCount,
              defaultValue_one: '{{count}} message'
            }),
            fileSummary
          ]
            .filter(Boolean)
            .join(' · ')
        : [
            project,
            (() => {
              const session = sessions.find((session) => session.id === result.item.sessionId)
              return session ? `#${session.number}` : result.item.originSession?.title
            })(),
            formatBytes(result.item.size),
            formatRelativeTime(result.item.sortAtMs, locale)
          ]
            .filter(Boolean)
            .join(' · ')
  }
  const keyboard = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if ((event.key === 'Home' || event.key === 'End') && query) return
      event.preventDefault()
      const current = rows.findIndex((row) => resultId(row) === activeId)
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      const row = rows[next]
      if (row) {
        select(row)
        requestAnimationFrame(() =>
          document
            .getElementById(`${listboxId}-${resultId(row)}`)
            ?.scrollIntoView({ block: 'nearest' })
        )
      }
    } else if (event.key === 'Enter') {
      const row = rows.find((item) => resultId(item) === activeId)
      if (!row) return
      event.preventDefault()
      if (event.shiftKey) {
        if ((row.kind === 'uploads' || row.kind === 'generated') && canMention(row.item))
          void mention(row.item)
        else openResult(row)
      } else openResult(row)
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        actionVersion.current++
        onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={(event) => {
            // The file preview is a sibling portal, so its menu dismissal also reaches search.
            if (document.querySelector('[data-slot="file-preview-dialog"][data-state="open"]'))
              event.preventDefault()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            setCategory('all')
            resetSelection()
            inputRef.current?.focus()
          }}
          className={dialogPanelClassName('global-search-dialog flex flex-col p-0')}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              event.nativeEvent.isComposing ||
              !(event.target instanceof Node) ||
              !event.currentTarget.contains(event.target)
            )
              return
            event.preventDefault()
            event.stopPropagation()
            if (selected) collapse()
            else close()
          }}
        >
          <Dialog.Title className="sr-only">{t('Global search')}</Dialog.Title>
          <header className="shrink-0">
            <div className="global-search-searchbar">
              <Search className="size-5 shrink-0 text-muted-foreground" />
              <div className="global-search-input-field">
                <Input
                  ref={inputRef}
                  role="combobox"
                  aria-label={t('Global search')}
                  aria-expanded
                  aria-controls={listboxId}
                  aria-activedescendant={activeId ? `${listboxId}-${activeId}` : undefined}
                  autoComplete="off"
                  placeholder={t('Search messages, projects, files and Library…')}
                  value={query}
                  onChange={(event) => {
                    actionVersion.current++
                    setQuery(event.target.value)
                    resetSelection()
                  }}
                  onKeyDown={keyboard}
                  className="min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
                {query && (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t('Clear search')}
                    title={t('Clear search')}
                    className="rounded-full bg-bg-200 px-3 text-xs text-muted-foreground hover:bg-bg-300 hover:text-foreground"
                    onClick={() => {
                      setQuery('')
                      resetSelection()
                      inputRef.current?.focus()
                    }}
                  >
                    {t('Clear')}
                  </Button>
                )}
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t('Close')} className="size-7">
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </div>
            <div className="global-search-chips" aria-label={t('Search categories')}>
              {(['all', ...SEARCH_CATEGORIES] as const).map((key) => {
                const Icon = key === 'all' ? Grid2X2 : icons[key]
                const count =
                  key === 'all'
                    ? SEARCH_CATEGORIES.reduce(
                        (sum, category) => sum + groups[category].totalCount,
                        0
                      )
                    : groups[key].totalCount
                return (
                  <button
                    type="button"
                    key={key}
                    data-category={key}
                    aria-pressed={category === key}
                    onClick={() => {
                      setCategory(key)
                      setSubtype('all')
                      resetSelection()
                    }}
                    className="search-category-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon aria-hidden="true" />
                    {labels[key]}
                    {query.trim() && (
                      <small>
                        {(
                          key === 'all'
                            ? SEARCH_CATEGORIES.some(
                                (category) => groups[category].loading || groups[category].error
                              )
                            : groups[key].loading || groups[key].error
                        )
                          ? '…'
                          : count}
                      </small>
                    )}
                  </button>
                )
              })}
            </div>
          </header>
          <div className="global-search-body min-h-0 flex-1" data-expanded={!!selected}>
            <section
              className="global-search-list-pane min-h-0 min-w-0 flex flex-col"
              aria-label={t('Search results')}
            >
              <SearchResultFilters
                category={category}
                scope={restrictToProject ? 'current' : 'all'}
                canScopeToProject={view === 'workspace' && !!activeProjectId}
                sort={sort}
                days={days}
                subtype={subtype}
                onScope={(value) => {
                  setCurrentProjectOnly(value === 'current')
                  resetSelection()
                }}
                onSort={(value) => {
                  setSort(value)
                  resetSelection()
                }}
                onDays={(value) => {
                  setDays(value)
                  setDateReference(Date.now())
                  resetSelection()
                }}
                onSubtype={(value) => {
                  setSubtype(value)
                  resetSelection()
                }}
              />
              <div
                className="global-search-list min-h-0 flex-1 overflow-auto"
                ref={listRef}
                onScroll={scrollMore}
                onWheel={scrollMore}
              >
                {!query.trim() && recentSearches.length > 0 && (
                  <div className="search-recent-queries" aria-label={t('Recent searches')}>
                    {recentSearches.map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setQuery(value)
                          resetSelection()
                          inputRef.current?.focus()
                        }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
                <div id={listboxId} role="listbox" aria-label={t('Search results')}>
                  {shownCategories.map((key) => {
                    const group = groups[key]
                    if (!group.items.length && !group.loading && !group.error && !group.incomplete)
                      return null
                    return (
                      <div
                        key={key}
                        role="group"
                        aria-labelledby={`${listboxId}-group-${key}`}
                        data-search-group={key}
                      >
                        <div
                          id={`${listboxId}-group-${key}`}
                          className="search-group-heading sticky top-0 z-10"
                        >
                          <span>{labels[key]}</span>
                          <span className="tabular-nums opacity-70">{group.totalCount}</span>
                        </div>
                        <div>
                          {group.items.map((result) => {
                            const id = resultId(result)
                            const Icon =
                              result.kind === 'library' && !('item' in result.item)
                                ? Folder
                                : icons[key]
                            const text = resultTitle(result)
                            const hit =
                              result.kind === 'messages'
                                ? findSearchMatches(text, query)[0]
                                : undefined
                            const display =
                              result.kind === 'messages'
                                ? text
                                    .slice(
                                      Math.max(0, (hit?.start ?? 0) - 55),
                                      (hit?.end ?? 0) + 180
                                    )
                                    .replace(/\s+/g, ' ')
                                : text
                            return (
                              <div
                                key={id}
                                id={`${listboxId}-${id}`}
                                role="option"
                                aria-selected={selectedId === id}
                                tabIndex={-1}
                                onClick={() => select(result, true)}
                                onDoubleClick={() => openResult(result)}
                                className={cn(
                                  'search-result-row group cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-ring'
                                )}
                              >
                                <span
                                  className="search-result-icon"
                                  role="img"
                                  aria-label={
                                    result.kind === 'library' && !('item' in result.item)
                                      ? t('Collection')
                                      : labels[key]
                                  }
                                  data-file={
                                    result.kind === 'uploads' || result.kind === 'generated'
                                  }
                                >
                                  {result.kind === 'uploads' || result.kind === 'generated' ? (
                                    <span>{fileFormatLabel(result.item)}</span>
                                  ) : (
                                    <Icon
                                      className="size-4"
                                      data-testid={
                                        key === 'sessions'
                                          ? 'global-search-session-icon'
                                          : undefined
                                      }
                                    />
                                  )}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div
                                    className="search-result-title"
                                    title={
                                      result.kind === 'messages' ? messageTitle(result.item) : text
                                    }
                                  >
                                    <SearchHighlight
                                      text={
                                        result.kind === 'messages'
                                          ? messageTitle(result.item)
                                          : text
                                      }
                                      query={query}
                                    />
                                  </div>
                                  {result.kind === 'messages' && (
                                    <div className="search-result-excerpt">
                                      <SearchHighlight text={display} query={query} />
                                    </div>
                                  )}
                                  <div className="search-result-meta">
                                    <span className="truncate" title={subtitle(result)}>
                                      {subtitle(result)}
                                    </span>
                                  </div>
                                </div>
                                {(result.kind === 'uploads' || result.kind === 'generated') &&
                                  canMention(result.item) && (
                                    <button
                                      type="button"
                                      tabIndex={-1}
                                      aria-label={t('Mention {{name}}', { name: result.item.name })}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void mention(result.item)
                                      }}
                                      className="rounded p-1 text-muted-foreground opacity-0 hover:bg-bg-300 group-hover:opacity-100 focus:opacity-100"
                                    >
                                      <AtSign className="size-3.5" />
                                    </button>
                                  )}
                              </div>
                            )
                          })}
                        </div>
                        {group.loading && (
                          <div role="status" className="flex justify-center py-3">
                            <LoaderCircle
                              className="size-4 animate-spin text-muted-foreground"
                              aria-label={t('Loading…')}
                            />
                          </div>
                        )}
                        {group.error && (
                          <div className="search-result-notice">
                            <ErrorNotice
                              tone="amber"
                              title={t('Could not load search results.')}
                              secondaryButton={{
                                label: t('Retry'),
                                onClick: () => {
                                  if (isRemoteCategory(key)) void load(key, group.items.length > 0)
                                }
                              }}
                            />
                          </div>
                        )}
                        {group.incomplete &&
                          !group.loading &&
                          !hasMoreSearchResults(key, group) && (
                            <p className="px-2 py-1 text-xs text-muted-foreground">
                              {t('Some results are unavailable.')}
                            </p>
                          )}
                        {!group.loading &&
                          !group.error &&
                          hasMoreSearchResults(key, group) &&
                          category === 'all' && (
                            <button
                              className="search-show-more mx-auto focus-visible:ring-2 focus-visible:ring-ring"
                              type="button"
                              onClick={() => loadMore(key)}
                            >
                              <span>{t('Load more')}</span>
                              <span className="tabular-nums">
                                {group.items.length}/{group.totalCount}
                              </span>
                            </button>
                          )}
                      </div>
                    )
                  })}
                </div>
                {category !== 'all' && rows.length > 0 && !anyError && (
                  <div className="search-page-count tabular-nums">
                    {rows.length}/{total}
                  </div>
                )}
                <div ref={loadMoreRef} aria-hidden="true" className="h-px" />
                {!isSessionPersistenceReady || anyLoading
                  ? null
                  : !anyError &&
                    rows.length === 0 && (
                      <div className="search-empty-state">
                        <Search aria-hidden="true" />
                        <h3>{t('No results found')}</h3>
                        <p>{t('Try another keyword or broaden the search scope.')}</p>
                        <button
                          onClick={() => {
                            setCurrentProjectOnly(false)
                            setCategory('all')
                            setDays(0)
                            setSubtype('all')
                            resetSelection()
                          }}
                        >
                          {t('Clear filters')}
                        </button>
                      </div>
                    )}
              </div>
            </section>
            <aside
              data-testid="global-search-detail"
              data-open={!!selected}
              aria-hidden={!selected}
              inert={!selected}
              className="global-search-detail h-full"
            >
              <div className="global-search-detail-surface">
                {retained && (
                  <SearchDetails
                    result={retained}
                    query={query}
                    projects={projects}
                    sessions={sessions}
                    onOpen={openResult}
                    onLocateFile={(file) => void locateFile(file)}
                    onNavigate={close}
                    onCollapse={collapse}
                  />
                )}
              </div>
            </aside>
          </div>
          <footer data-testid="global-search-footer" className="global-search-footer">
            {actionError ? (
              <span role="alert">{actionError}</span>
            ) : (
              <button
                type="button"
                className="flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                  const nav = useNavigationStore.getState()
                  if (view === 'workspace' && activeProjectId)
                    nav.openProject(activeProjectId, 'user', () => {
                      useSessionStore.getState().clearSelection()
                      close()
                    })
                  else {
                    nav.requestProjectCreation()
                    close()
                  }
                }}
              >
                {view === 'workspace' && activeProjectId ? t('New session') : t('New project')}
                <ArrowUpRight className="size-3" />
              </button>
            )}
            <span>{restrictToProject ? t('Current project') : t('All projects and Library')}</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
