/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * component: command palette · genre: modern-minimal · theme: Open Science tokens
 * structural fingerprint: fixed header / single scroll plane / fixed shortcut footer
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited from the app's verified semantic tokens · slop: pass
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, AtSign, LoaderCircle, MessageCircle, Search, Zap } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useShallow } from 'zustand/react/shallow'

import type { ProjectFileItem } from '../../../../shared/project-files'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { relativeTimeParts, type RelativeTimeUnit } from '@/lib/format-relative-time'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { cn } from '@/lib/utils'
import { ArtifactPreview } from '@/pages/workspace/artifact-preview'
import { createPreviewFileItem } from '@/pages/workspace/preview-file-item'
import type { MessageArtifact } from '@/pages/workspace/preview-file-item'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

import {
  getNextBatchCount,
  getRecentSessions,
  GLOBAL_SEARCH_PAGE_SIZE,
  OTHER_PROJECT_RESULT_LIMIT,
  searchSessionTitles,
  type SessionSearchResult
} from './global-search-catalog'

type GlobalSearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isSessionPersistenceReady: boolean
}

type ArtifactState = {
  items: ProjectFileItem[]
  totalCount: number
  nextCursor?: string
  other: ProjectFileItem[]
  isIndexComplete: boolean
}

type SelectableRow =
  | { kind: 'session'; session: SessionSearchResult }
  | { kind: 'artifact'; artifact: ProjectFileItem }
  | { kind: 'more-sessions' }
  | { kind: 'more-artifacts' }
  | { kind: 'retry-artifacts' }
  | { kind: 'new-session' }
  | { kind: 'new-project' }

const emptyArtifactState: ArtifactState = {
  items: [],
  totalCount: 0,
  other: [],
  isIndexComplete: true
}

// An IPC rejection carries an English message from the main process, so it is only shown when it
// exists; the fallback is the one the catalog owns.
const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

const artifactToPreviewItem = (
  artifact: ProjectFileItem
): ReturnType<typeof createPreviewFileItem> =>
  createPreviewFileItem({
    id: artifact.id,
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    path: artifact.path,
    name: artifact.name,
    mimeType: artifact.mimeType,
    source: artifact.source === 'upload' ? 'upload' : undefined,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs,
    artifactId: artifact.source === 'artifact' ? artifact.sourceFileId : undefined,
    managedFileId: artifact.sourceFileId,
    originSession: artifact.originSession
  })

const artifactToThumbnailItem = (artifact: ProjectFileItem): MessageArtifact => ({
  id: artifact.sourceVersionId,
  artifactId: artifact.source === 'artifact' ? artifact.sourceFileId : undefined,
  versionId: artifact.sourceVersionId,
  kind: 'managed-file',
  path: artifact.path,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  mtimeMs: artifact.mtimeMs
})

const sectionTitleClassName =
  'sticky top-0 z-10 bg-card px-4 pb-2 pt-3 text-sm font-medium text-muted-foreground'
const rowClassName =
  'relative flex min-h-12 w-full min-w-0 cursor-pointer select-none items-center justify-start gap-3 px-4 text-left outline-none transition-colors duration-150 before:absolute before:left-2 before:h-6 before:w-[3px] before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity before:duration-150 hover:bg-bg-200 active:bg-bg-300 motion-reduce:transition-none motion-reduce:before:transition-none'
const shortcutClassName = 'inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap'
const keycapClassName =
  'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border border-border bg-bg-000 px-1.5 font-mono text-[11px] leading-none text-foreground shadow-sm'

// English source text per bucket, keyed by the unit the pure helper returns. A map rather than an
// interpolated key: the key IS the English, so it can't be computed from `unit` at runtime. The
// `satisfies` clause makes a new RelativeTimeUnit a compile error instead of a missing label.
// `plural` is the English singular, passed as defaultValue_one — English has no catalog, so the
// singular form has to come from the call site.
// Verbose wording ("3 days ago"), unlike the compact labels on the home page: rows here have room,
// and the timestamp is the only recency cue a search hit carries. The unit can't be interpolated into
// the key — a natural-language key has to be a literal — so each bucket names its own English text.
// `other` is the key i18next looks up; `one` supplies the English singular, which is what lets this
// work with no English catalog at all. 'now' is absent because the caller returns early for it.
const ELAPSED_LABELS = {
  minute: { other: '{{count}} minutes ago', one: '{{count}} minute ago' },
  hour: { other: '{{count}} hours ago', one: '{{count}} hour ago' },
  day: { other: '{{count}} days ago', one: '{{count}} day ago' },
  week: { other: '{{count}} weeks ago', one: '{{count}} week ago' },
  month: { other: '{{count}} months ago', one: '{{count}} month ago' },
  year: { other: '{{count}} years ago', one: '{{count}} year ago' }
} as const satisfies Record<Exclude<RelativeTimeUnit, 'now'>, { other: string; one: string }>

export const GlobalSearchDialog = ({
  open,
  onOpenChange,
  isSessionPersistenceReady
}: GlobalSearchDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const requestVersionRef = useRef(0)
  const keyboardNavigationRef = useRef(false)
  const mentionVersionRef = useRef(0)
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [visibleSessionCount, setVisibleSessionCount] = useState(GLOBAL_SEARCH_PAGE_SIZE)
  const [artifacts, setArtifacts] = useState<ArtifactState>(emptyArtifactState)
  const [artifactStatus, setArtifactStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [artifactError, setArtifactError] = useState<string | undefined>()
  const [failedArtifactCursor, setFailedArtifactCursor] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [activeIndex, setActiveIndex] = useState(0)

  useLayoutEffect(() => {
    if (!open) mentionVersionRef.current += 1
  }, [open])

  useLayoutEffect(
    () => () => {
      mentionVersionRef.current += 1
    },
    []
  )

  const allProjects = useProjectStore((state) => state.projects)
  const allSessions = useSessionStore((state) => state.sessions)
  const archivedSessionIds = useSessionStore(
    useShallow((state) =>
      state.sessions
        .filter((session) => session.archivedAt !== undefined)
        .map((session) => session.id)
        .sort()
    )
  )
  const projects = useMemo(
    () => allProjects.filter((project) => project.archivedAt === undefined),
    [allProjects]
  )
  const activeProjectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session) => session.archivedAt === undefined && activeProjectIds.has(session.projectId)
      ),
    [activeProjectIds, allSessions]
  )
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const view = useNavigationStore((state) => state.view)
  const openProject = useNavigationStore((state) => state.openProject)
  const openSession = useNavigationStore((state) => state.openSession)
  const requestArtifactMention = useNavigationStore((state) => state.requestArtifactMention)
  const requestProjectCreation = useNavigationStore((state) => state.requestProjectCreation)
  const artifactMentionAvailability = useNavigationStore(
    (state) => state.artifactMentionAvailability
  )
  const openFileDialog = usePreviewWorkbenchStore((state) => state.openFileDialog)

  const isProjectScope = view === 'workspace' && activeProjectId !== undefined
  const relativeTime = (timestamp: number): string => {
    const { unit, count } = relativeTimeParts(timestamp)
    if (unit === 'now') return t('just now')
    const { other, one } = ELAPSED_LABELS[unit]
    return t(other, { count, defaultValue_one: one })
  }

  const primaryProjectId = useMemo(
    () => (isProjectScope ? activeProjectId : resolveCustomizeProjectId(projects)),
    [activeProjectId, isProjectScope, projects]
  )
  const primaryProject = useMemo(
    () => projects.find((project) => project.id === primaryProjectId),
    [primaryProjectId, projects]
  )
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )
  const sessionTitles = useMemo(
    () =>
      new Map(
        sessions.map((session) => [`${session.projectId}:${session.id}`, session.title] as const)
      ),
    [sessions]
  )
  const trimmedQuery = query.trim()
  const isSearchMode = trimmedQuery.length > 0
  const otherProjectIds = useMemo(
    () =>
      projects.filter((project) => project.id !== primaryProject?.id).map((project) => project.id),
    [primaryProject?.id, projects]
  )

  const sessionGroups = useMemo(
    () =>
      primaryProject && isSearchMode
        ? searchSessionTitles({
            sessions: sessions.map((session) => ({
              id: session.id,
              projectId: session.projectId,
              title: session.title,
              number: session.number,
              updatedAt: session.updatedAt,
              artifactCount: session.artifacts?.length ?? session.artifactCount ?? 0,
              isPending: session.isPending
            })),
            projectNames,
            primaryProjectId: isProjectScope ? primaryProject.id : undefined,
            query: trimmedQuery,
            visiblePrimaryCount: visibleSessionCount
          })
        : undefined,
    [
      isProjectScope,
      isSearchMode,
      primaryProject,
      projectNames,
      sessions,
      trimmedQuery,
      visibleSessionCount
    ]
  )
  const recentSessions = useMemo(
    () =>
      primaryProject
        ? getRecentSessions(
            sessions.map((session) => ({
              id: session.id,
              projectId: session.projectId,
              title: session.title,
              number: session.number,
              updatedAt: session.updatedAt,
              artifactCount: session.artifacts?.length ?? session.artifactCount ?? 0,
              isPending: session.isPending
            })),
            isProjectScope ? primaryProject.id : undefined
          ).map((session) => ({
            ...session,
            kind: 'session' as const,
            projectName: projectNames.get(session.projectId)
          }))
        : [],
    [isProjectScope, primaryProject, projectNames, sessions]
  )

  const reloadArtifacts = useCallback(
    async (cursor?: string): Promise<void> => {
      if (!primaryProject) {
        setArtifacts(emptyArtifactState)
        return
      }
      const version = ++requestVersionRef.current
      setArtifactStatus('loading')
      setArtifactError(undefined)
      setFailedArtifactCursor(undefined)
      try {
        const result = await window.api.projectFiles.searchArtifacts({
          primaryProjectId: primaryProject.id,
          otherProjectIds,
          ...(trimmedQuery ? { filenameContains: trimmedQuery } : {}),
          ...(archivedSessionIds.length > 0 ? { excludedSessionIds: archivedSessionIds } : {}),
          primaryLimit: GLOBAL_SEARCH_PAGE_SIZE,
          ...(cursor ? { primaryCursor: cursor } : {}),
          otherLimit: !cursor && (!isProjectScope || isSearchMode) ? OTHER_PROJECT_RESULT_LIMIT : 0
        })
        if (version !== requestVersionRef.current) return
        setArtifacts((current) =>
          cursor
            ? {
                items: [...current.items, ...result.primary.items],
                totalCount: result.primary.totalCount,
                nextCursor: result.primary.nextCursor,
                other: current.other,
                isIndexComplete: current.isIndexComplete && result.isIndexComplete
              }
            : {
                items: result.primary.items,
                totalCount: result.primary.totalCount,
                nextCursor: result.primary.nextCursor,
                other: result.other,
                isIndexComplete: result.isIndexComplete
              }
        )
        setArtifactStatus('idle')
        setFailedArtifactCursor(undefined)
      } catch (error) {
        if (version !== requestVersionRef.current) return
        setArtifactStatus('error')
        setArtifactError(getErrorMessage(error, t('Could not load artifacts.')))
        setFailedArtifactCursor(cursor)
      }
    },
    [
      archivedSessionIds,
      isProjectScope,
      isSearchMode,
      otherProjectIds,
      primaryProject,
      t,
      trimmedQuery
    ]
  )

  useEffect(() => {
    // IPC cannot be cancelled. Advance the generation before the debounce so a response for the
    // previous query, Project, or modal lifetime can never overwrite the new result set.
    requestVersionRef.current += 1
    if (!open) return
    if (!isSearchMode) {
      queueMicrotask(() => void reloadArtifacts())
      return
    }
    const timer = window.setTimeout(() => void reloadArtifacts(), 150)
    return () => window.clearTimeout(timer)
  }, [isSearchMode, open, reloadArtifacts, trimmedQuery])

  const handleQueryChange = (nextQuery: string): void => {
    // Clear synchronously with the input event, before the next debounced Artifact request starts.
    requestVersionRef.current += 1
    setQuery(nextQuery)
    setVisibleSessionCount(GLOBAL_SEARCH_PAGE_SIZE)
    setArtifacts(emptyArtifactState)
    setArtifactStatus(nextQuery.trim() ? 'loading' : 'idle')
    setArtifactError(undefined)
    setFailedArtifactCursor(undefined)
    setActionError(undefined)
    setActiveIndex(0)
    keyboardNavigationRef.current = false
  }

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [open])

  const sessionMoreCount = sessionGroups
    ? getNextBatchCount(sessionGroups.primaryTotalCount, sessionGroups.primary.length)
    : 0
  const artifactMoreCount = getNextBatchCount(artifacts.totalCount, artifacts.items.length)
  const canLoadMoreArtifacts =
    artifactError === undefined && artifactMoreCount > 0 && artifacts.nextCursor !== undefined
  const displayedArtifacts = useMemo(
    () =>
      isProjectScope
        ? artifacts.items
        : [...artifacts.items, ...artifacts.other].sort(
            (left, right) => right.sortAtMs - left.sortAtMs
          ),
    [artifacts.items, artifacts.other, isProjectScope]
  )
  const isSearchPending =
    isSearchMode && artifactStatus === 'loading' && displayedArtifacts.length === 0
  const otherRows = useMemo<SelectableRow[]>(() => {
    if (!isProjectScope || !isSearchMode) return []
    return [
      ...artifacts.other.map((artifact) => ({ kind: 'artifact' as const, artifact })),
      ...(sessionGroups?.other.map((session) => ({ kind: 'session' as const, session })) ?? [])
    ]
      .sort((left, right) => {
        const leftTime = left.kind === 'artifact' ? left.artifact.sortAtMs : left.session.updatedAt
        const rightTime =
          right.kind === 'artifact' ? right.artifact.sortAtMs : right.session.updatedAt
        return rightTime - leftTime
      })
      .slice(0, OTHER_PROJECT_RESULT_LIMIT)
  }, [artifacts.other, isProjectScope, isSearchMode, sessionGroups?.other])
  const selectableRows = useMemo<SelectableRow[]>(() => {
    const command = isProjectScope
      ? ({ kind: 'new-session' } as const)
      : ({ kind: 'new-project' } as const)
    if (!primaryProject) return isProjectScope ? [] : [command]
    if (isSearchPending) return [command]
    if (!isSearchMode) {
      return [
        ...displayedArtifacts.map((artifact) => ({ kind: 'artifact' as const, artifact })),
        ...recentSessions.map((session) => ({ kind: 'session' as const, session })),
        command
      ]
    }
    return [
      ...displayedArtifacts.map((artifact) => ({ kind: 'artifact' as const, artifact })),
      ...(artifactError ? [{ kind: 'retry-artifacts' as const }] : []),
      ...(canLoadMoreArtifacts ? [{ kind: 'more-artifacts' as const }] : []),
      ...(sessionGroups?.primary.map((session) => ({ kind: 'session' as const, session })) ?? []),
      ...(sessionMoreCount > 0 ? [{ kind: 'more-sessions' as const }] : []),
      ...otherRows,
      command
    ]
  }, [
    canLoadMoreArtifacts,
    artifactError,
    displayedArtifacts,
    isProjectScope,
    isSearchPending,
    isSearchMode,
    otherRows,
    primaryProject,
    recentSessions,
    sessionGroups?.primary,
    sessionMoreCount
  ])

  const activeRowIndex =
    selectableRows.length === 0 ? -1 : Math.max(0, Math.min(activeIndex, selectableRows.length - 1))
  const activeRowId = `global-search-option-${activeRowIndex}`

  useEffect(() => {
    if (!keyboardNavigationRef.current) return
    keyboardNavigationRef.current = false
    if (!open || selectableRows.length === 0) return
    document.getElementById(activeRowId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeRowId, open, selectableRows.length])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (!nextOpen) mentionVersionRef.current += 1
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )
  const close = useCallback(() => handleOpenChange(false), [handleOpenChange])
  const isArtifactMentionTarget = useCallback(
    (artifact: ProjectFileItem): boolean =>
      view === 'workspace' &&
      activeProjectId === artifact.projectId &&
      sessions.some(
        (session) => session.id === selectedSessionId && session.projectId === artifact.projectId
      ),
    [activeProjectId, selectedSessionId, sessions, view]
  )
  const canMentionArtifact = useCallback(
    (artifact: ProjectFileItem): boolean =>
      isArtifactMentionTarget(artifact) &&
      artifactMentionAvailability?.projectId === artifact.projectId &&
      artifactMentionAvailability.canMention,
    [artifactMentionAvailability, isArtifactMentionTarget]
  )
  const previewArtifact = useCallback(
    (artifact: ProjectFileItem): void => {
      const openPreview = (): void => {
        openFileDialog(artifactToPreviewItem(artifact))
        close()
      }
      if (activeProjectId !== artifact.projectId || view !== 'workspace') {
        openProject(artifact.projectId, 'user', openPreview)
        return
      }
      openPreview()
    },
    [activeProjectId, close, openFileDialog, openProject, view]
  )
  const mentionArtifact = useCallback(
    async (artifact: ProjectFileItem): Promise<void> => {
      if (!canMentionArtifact(artifact)) return
      const requestVersion = ++mentionVersionRef.current
      setActionError(undefined)
      const inspect = window.api.managedFileVersions?.inspect
      if (!inspect) {
        setActionError(t('File version resolution is unavailable.'))
        return
      }
      try {
        const result = await inspect({
          source: artifact.source,
          projectId: artifact.projectId,
          fileId: artifact.sourceFileId
        })
        if (requestVersion !== mentionVersionRef.current) return
        if (!result.ok) {
          setActionError(t('Could not resolve file version.'))
          return
        }
        const head = result.value.versions.find(
          (version) => version.id === result.value.headVersionId
        )
        if (!head) {
          setActionError(t('The current file version is unavailable.'))
          return
        }
        requestArtifactMention({
          ...artifact,
          sourceVersionId: head.id,
          checksum: head.checksum,
          sessionId: result.value.sessionId,
          name: result.value.displayName,
          mimeType: head.contentType ?? artifact.mimeType,
          size: head.sizeBytes,
          sortAtMs: Date.parse(head.createdAt)
        })
        close()
      } catch {
        if (requestVersion !== mentionVersionRef.current) return
        setActionError(t('Could not resolve file version.'))
      }
    },
    [canMentionArtifact, close, requestArtifactMention, t]
  )
  const activate = useCallback(
    (row: SelectableRow | undefined, action?: 'mention' | 'preview'): void => {
      if (!row) return
      if (row.kind === 'session') {
        const isStillAvailable = sessions.some(
          (session) =>
            session.id === row.session.id &&
            session.projectId === row.session.projectId &&
            !session.isPending
        )
        if (!isStillAvailable) {
          setActionError(t('This session is no longer available.'))
          return
        }
        openSession(row.session.projectId, row.session.id, 'user', close)
        return
      }
      if (row.kind === 'artifact') {
        if (action === 'mention' && canMentionArtifact(row.artifact)) {
          void mentionArtifact(row.artifact)
        } else previewArtifact(row.artifact)
        return
      }
      if (row.kind === 'more-sessions') {
        setVisibleSessionCount((count) => count + GLOBAL_SEARCH_PAGE_SIZE)
        return
      }
      if (row.kind === 'more-artifacts' && artifacts.nextCursor) {
        void reloadArtifacts(artifacts.nextCursor)
        return
      }
      if (row.kind === 'retry-artifacts') {
        void reloadArtifacts(failedArtifactCursor)
        return
      }
      if (row.kind === 'new-session' && primaryProject && isSessionPersistenceReady) {
        openProject(primaryProject.id, 'user', () => {
          useSessionStore.getState().clearSelection()
          close()
        })
        return
      }
      if (row.kind === 'new-project') {
        requestProjectCreation()
        close()
      }
    },
    [
      artifacts.nextCursor,
      canMentionArtifact,
      close,
      failedArtifactCursor,
      isSessionPersistenceReady,
      mentionArtifact,
      openProject,
      openSession,
      previewArtifact,
      primaryProject,
      reloadArtifacts,
      requestProjectCreation,
      sessions,
      t
    ]
  )

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (selectableRows.length === 0) return
      setActiveIndex((current) => {
        const normalized = Math.max(0, Math.min(current, selectableRows.length - 1))
        const nextIndex =
          event.key === 'ArrowDown'
            ? (normalized + 1) % selectableRows.length
            : (normalized - 1 + selectableRows.length) % selectableRows.length
        keyboardNavigationRef.current = nextIndex !== current
        return nextIndex
      })
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex((current) => {
        keyboardNavigationRef.current = current !== 0
        return 0
      })
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex((current) => {
        const nextIndex = Math.max(0, selectableRows.length - 1)
        keyboardNavigationRef.current = nextIndex !== current
        return nextIndex
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      activate(selectableRows[activeRowIndex], event.shiftKey ? 'mention' : 'preview')
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const resultCount = isSearchPending
    ? 0
    : isSearchMode
      ? (sessionGroups?.primaryTotalCount ?? 0) +
        (isProjectScope ? artifacts.totalCount + otherRows.length : displayedArtifacts.length)
      : displayedArtifacts.length + recentSessions.length
  const renderSessionRow = (session: SessionSearchResult, rowIndex: number): React.JSX.Element => {
    const active = rowIndex === activeRowIndex
    return (
      <div
        id={`global-search-option-${rowIndex}`}
        key={`${session.projectId}:${session.id}`}
        role="option"
        tabIndex={-1}
        aria-selected={active}
        className={cn(rowClassName, active && 'bg-bg-200 before:opacity-100')}
        onMouseEnter={() => setActiveIndex(rowIndex)}
        onClick={() => activate({ kind: 'session', session })}
      >
        <span
          data-testid="global-search-session-icon"
          className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border-300/50 bg-bg-200 text-primary"
          aria-hidden="true"
        >
          <MessageCircle className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {session.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {!isProjectScope || session.projectId !== primaryProject?.id
              ? `${session.projectName ?? t('Unknown project')} · `
              : ''}
            {t('{{count}} artifacts', {
              defaultValue_one: '{{count}} artifact',
              count: session.artifactCount
            })}{' '}
            · {relativeTime(session.updatedAt)}
          </span>
        </span>
        {session.number !== undefined &&
        Number.isSafeInteger(session.number) &&
        session.number > 0 ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{session.number}
          </span>
        ) : null}
      </div>
    )
  }

  const renderArtifactRow = (artifact: ProjectFileItem, rowIndex: number): React.JSX.Element => {
    const active = rowIndex === activeRowIndex
    const createdAt = artifact.sortAtMs
    const isCurrentSessionArtifact = isArtifactMentionTarget(artifact)
    const canMention = canMentionArtifact(artifact)
    return (
      <div
        id={`global-search-option-${rowIndex}`}
        key={`${artifact.projectId}:${artifact.id}:${artifact.sourceVersionId}`}
        role="option"
        tabIndex={-1}
        aria-selected={active}
        className={cn(rowClassName, active && 'bg-bg-200 before:opacity-100')}
        onMouseEnter={() => setActiveIndex(rowIndex)}
        onClick={() => previewArtifact(artifact)}
      >
        <span
          data-testid="global-search-artifact-thumbnail"
          className="size-10 shrink-0 overflow-hidden rounded-md border border-border-300/50 bg-bg-200"
          aria-hidden="true"
        >
          <ArtifactPreview
            artifact={artifactToThumbnailItem(artifact)}
            source={artifact.source}
            projectId={artifact.projectId}
            sessionId={artifact.sessionId}
            managedFileId={artifact.sourceFileId}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {artifact.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {!isProjectScope || artifact.projectId !== primaryProject?.id
              ? `${projectNames.get(artifact.projectId) ?? t('Unknown project')} · `
              : ''}
            {artifact.originSession?.title ??
              sessionTitles.get(`${artifact.projectId}:${artifact.sessionId}`) ??
              t('Unknown session')}{' '}
            · {createdAt === undefined ? t('Creation time unavailable') : relativeTime(createdAt)}
          </span>
        </span>
        {active ? (
          <TooltipProvider delayDuration={800}>
            <span className="flex shrink-0 items-center gap-1">
              {isCurrentSessionArtifact ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        tabIndex={-1}
                        className="cursor-pointer"
                        aria-label={t('Mention {{name}}', { name: artifact.name })}
                        disabled={!canMention}
                        onClick={(event) => {
                          event.stopPropagation()
                          void mentionArtifact(artifact)
                        }}
                      >
                        <AtSign className="size-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {canMention
                      ? t('Mention {{name}}', { name: artifact.name })
                      : t(
                          'Mention is unavailable while the composer cannot accept another artifact.'
                        )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    className="cursor-pointer"
                    aria-label={t('Open {{name}}', { name: artifact.name })}
                    onClick={(event) => {
                      event.stopPropagation()
                      previewArtifact(artifact)
                    }}
                  >
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Open {{name}}', { name: artifact.name })}</TooltipContent>
              </Tooltip>
            </span>
          </TooltipProvider>
        ) : null}
      </div>
    )
  }

  let rowIndex = 0
  const nextIndex = (): number => rowIndex++

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-testid="global-search-dialog"
          aria-describedby={undefined}
          className={dialogPanelClassName(
            'flex h-[calc(100dvh_-_1rem)] w-[calc(100%_-_1rem)] max-w-[680px] flex-col overflow-hidden p-0 sm:h-[min(760px,calc(100dvh_-_2rem))] sm:w-[calc(100%_-_2rem)]'
          )}
        >
          <Dialog.Title className="sr-only">{t('Command palette')}</Dialog.Title>
          <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onKeyDown={handleInputKeyDown}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={selectableRows.length > 0 ? activeRowId : undefined}
              placeholder={
                isProjectScope ? t('Search this project…') : t('Search sessions and artifacts…')
              }
              maxLength={256}
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-xl text-foreground placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
            />
            {isProjectScope && primaryProject ? (
              <span className="max-w-[35%] shrink-0 truncate rounded-lg bg-bg-200 px-3 py-1.5 text-sm font-medium text-muted-foreground">
                {primaryProject.name}
              </span>
            ) : null}
          </div>
          <p className="sr-only" aria-live="polite">
            {t('{{count}} results', { defaultValue_one: '{{count}} result', count: resultCount })}
          </p>
          {actionError ? (
            <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          <ScrollArea
            data-testid="global-search-results"
            className="min-h-0 flex-1 overscroll-contain"
          >
            <div id={listboxId} role="listbox" className="py-1.5">
              {!primaryProject ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('Create a project to search sessions and artifacts.')}
                </p>
              ) : !isSearchMode ? (
                <>
                  {displayedArtifacts.length > 0 ? (
                    <section role="group" aria-label={t('Recent artifacts')}>
                      <h2 className={sectionTitleClassName}>{t('Recent artifacts')}</h2>
                      {displayedArtifacts.map((artifact) =>
                        renderArtifactRow(artifact, nextIndex())
                      )}
                    </section>
                  ) : null}
                  {recentSessions.length > 0 ? (
                    <section role="group" aria-label={t('Recent sessions')}>
                      <h2 className={sectionTitleClassName}>{t('Recent sessions')}</h2>
                      {recentSessions.map((session) => renderSessionRow(session, nextIndex()))}
                    </section>
                  ) : null}
                </>
              ) : (
                <>
                  {displayedArtifacts.length || artifactStatus === 'loading' || artifactError ? (
                    <section role="group" aria-label={t('Artifacts')}>
                      <h2 className={sectionTitleClassName}>{t('Artifacts')}</h2>
                      {displayedArtifacts.map((artifact) =>
                        renderArtifactRow(artifact, nextIndex())
                      )}
                      {isSearchPending ? (
                        <p
                          role="status"
                          className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"
                        >
                          <LoaderCircle
                            className="size-3.5 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                          {t('Searching…')}
                        </p>
                      ) : null}
                      {artifactError ? (
                        <Button
                          id={`global-search-option-${nextIndex()}`}
                          type="button"
                          role="option"
                          aria-selected={activeRowIndex === rowIndex - 1}
                          variant="ghost"
                          className="h-11 cursor-pointer justify-start px-4 text-sm font-medium text-primary"
                          onMouseEnter={() => setActiveIndex(rowIndex - 1)}
                          onClick={() => void reloadArtifacts(failedArtifactCursor)}
                        >
                          {failedArtifactCursor
                            ? t('Could not load more — retry')
                            : t('Could not load artifacts — retry')}
                        </Button>
                      ) : null}
                      {canLoadMoreArtifacts ? (
                        <Button
                          id={`global-search-option-${nextIndex()}`}
                          type="button"
                          role="option"
                          aria-selected={activeRowIndex === rowIndex - 1}
                          variant="ghost"
                          disabled={artifactStatus === 'loading'}
                          className={cn(
                            'flex h-11 w-full cursor-pointer select-none items-center justify-start px-4 text-left text-sm font-medium text-primary outline-none disabled:cursor-not-allowed disabled:opacity-50',
                            activeRowIndex === rowIndex - 1 && 'bg-bg-200'
                          )}
                          onMouseEnter={() => setActiveIndex(rowIndex - 1)}
                          onClick={() => activate({ kind: 'more-artifacts' })}
                        >
                          {t('+{{count}} more matches — show more', { count: artifactMoreCount })}
                        </Button>
                      ) : null}
                    </section>
                  ) : null}
                  {!isSearchPending && sessionGroups?.primary.length ? (
                    <section role="group" aria-label={t('Sessions')}>
                      <h2 className={sectionTitleClassName}>{t('Sessions')}</h2>
                      {sessionGroups.primary.map((session) =>
                        renderSessionRow(session, nextIndex())
                      )}
                      {sessionMoreCount > 0 ? (
                        <Button
                          id={`global-search-option-${nextIndex()}`}
                          type="button"
                          role="option"
                          aria-selected={activeRowIndex === rowIndex - 1}
                          variant="ghost"
                          className={cn(
                            'flex h-11 w-full cursor-pointer select-none items-center justify-start px-4 text-left text-sm font-medium text-primary outline-none',
                            activeRowIndex === rowIndex - 1 && 'bg-bg-200'
                          )}
                          onMouseEnter={() => setActiveIndex(rowIndex - 1)}
                          onClick={() => activate({ kind: 'more-sessions' })}
                        >
                          {t('+{{count}} more matches — show more', { count: sessionMoreCount })}
                        </Button>
                      ) : null}
                    </section>
                  ) : null}
                  {!isSearchPending && otherRows.length > 0 ? (
                    <section role="group" aria-label={t('Other projects')}>
                      <h2 className={sectionTitleClassName}>{t('Other projects')}</h2>
                      {otherRows.map((row) =>
                        row.kind === 'artifact'
                          ? renderArtifactRow(row.artifact, nextIndex())
                          : row.kind === 'session'
                            ? renderSessionRow(row.session, nextIndex())
                            : null
                      )}
                    </section>
                  ) : null}
                  {displayedArtifacts.length === 0 &&
                  !sessionGroups?.primary.length &&
                  otherRows.length === 0 &&
                  artifactStatus !== 'loading' &&
                  !artifactError ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                      {t('No sessions or artifacts match “{{query}}”.', { query })}
                    </p>
                  ) : null}
                </>
              )}
              {!isProjectScope || primaryProject ? (
                <section role="group" aria-label={t('Commands')}>
                  <h2 className={sectionTitleClassName}>{t('Commands')}</h2>
                  <Button
                    id={`global-search-option-${nextIndex()}`}
                    type="button"
                    role="option"
                    aria-selected={activeRowIndex === rowIndex - 1}
                    variant="ghost"
                    disabled={isProjectScope && !isSessionPersistenceReady}
                    className={cn(
                      rowClassName,
                      activeRowIndex === rowIndex - 1 && 'bg-bg-200 before:opacity-100',
                      isProjectScope && !isSessionPersistenceReady && 'opacity-50'
                    )}
                    onMouseEnter={() => setActiveIndex(rowIndex - 1)}
                    onClick={() =>
                      activate({ kind: isProjectScope ? 'new-session' : 'new-project' })
                    }
                  >
                    <span
                      data-testid="global-search-command-icon"
                      className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border-300/50 bg-bg-200 text-primary"
                      aria-hidden="true"
                    >
                      {isProjectScope ? (
                        <MessageCircle className="size-5" />
                      ) : (
                        <Zap className="size-5" />
                      )}
                    </span>
                    <span className="text-sm font-medium">
                      {isProjectScope ? t('New session') : t('New project')}
                    </span>
                  </Button>
                </section>
              ) : null}
              {!artifacts.isIndexComplete ? (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  {t('Some artifact results may be missing.')}
                </p>
              ) : null}
            </div>
          </ScrollArea>
          <footer
            data-testid="global-search-footer"
            className="grid min-h-14 shrink-0 grid-cols-2 items-center gap-x-4 gap-y-2 border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground sm:flex sm:flex-wrap"
          >
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>↑↓</kbd>
              <span>{t('navigate')}</span>
            </span>
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>↵</kbd>
              <span>{t('open')}</span>
            </span>
            {isProjectScope ? (
              <span className={shortcutClassName}>
                <kbd className={keycapClassName}>⇧↵</kbd>
                <span>{t('mention')}</span>
              </span>
            ) : null}
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>{t('esc')}</kbd>
              <span>{t('close')}</span>
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
