/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * component: command palette · genre: modern-minimal · theme: Open Science tokens
 * structural fingerprint: fixed header / single scroll plane / fixed shortcut footer
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited from the app's verified semantic tokens · slop: pass
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, AtSign, Hash, MessageCircle, Search } from 'lucide-react'
import { Dialog } from 'radix-ui'

import type { ProjectFileItem } from '../../../../shared/project-files'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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

const emptyArtifactState: ArtifactState = {
  items: [],
  totalCount: 0,
  other: [],
  isIndexComplete: true
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not load artifacts.'

const pluralizeTime = (value: number, unit: string): string =>
  `${value} ${unit}${value === 1 ? '' : 's'} ago`

const formatRelativeTime = (timestamp: number): string => {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return pluralizeTime(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return pluralizeTime(hours, 'hour')
  const days = Math.floor(hours / 24)
  return days < 7 ? pluralizeTime(days, 'day') : pluralizeTime(Math.floor(days / 7), 'week')
}

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
    selectedVersionId: artifact.source === 'artifact' ? artifact.sourceVersionId : undefined,
    originSession: artifact.originSession
  })

const artifactToThumbnailItem = (artifact: ProjectFileItem): MessageArtifact => ({
  id: artifact.sourceVersionId ?? artifact.sourceFileId,
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

export const GlobalSearchDialog = ({
  open,
  onOpenChange,
  isSessionPersistenceReady
}: GlobalSearchDialogProps): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement>(null)
  const requestVersionRef = useRef(0)
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [visibleSessionCount, setVisibleSessionCount] = useState(GLOBAL_SEARCH_PAGE_SIZE)
  const [artifacts, setArtifacts] = useState<ArtifactState>(emptyArtifactState)
  const [artifactStatus, setArtifactStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [artifactError, setArtifactError] = useState<string | undefined>()
  const [failedArtifactCursor, setFailedArtifactCursor] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [activeIndex, setActiveIndex] = useState(0)

  const projects = useProjectStore((state) => state.projects)
  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const view = useNavigationStore((state) => state.view)
  const openProject = useNavigationStore((state) => state.openProject)
  const openSession = useNavigationStore((state) => state.openSession)
  const requestArtifactMention = useNavigationStore((state) => state.requestArtifactMention)
  const artifactMentionAvailability = useNavigationStore(
    (state) => state.artifactMentionAvailability
  )
  const openFileDialog = usePreviewWorkbenchStore((state) => state.openFileDialog)

  const primaryProjectId = useMemo(
    () => activeProjectId ?? resolveCustomizeProjectId(projects),
    [activeProjectId, projects]
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
  const sessionMessageCreatedTimes = useMemo(() => {
    const createdTimes = new Map<string, number>()
    for (const session of sessions) {
      const messages = [...(session.conversationGraph?.messages ?? []), ...session.messages]
      for (const message of messages) {
        createdTimes.set(`${session.projectId}:${session.id}:${message.id}`, message.createdAt)
      }
    }
    return createdTimes
  }, [sessions])
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
              updatedAt: session.updatedAt,
              artifactCount: session.artifacts?.length ?? 0,
              isPending: session.isPending
            })),
            projectNames,
            primaryProjectId: primaryProject.id,
            query: trimmedQuery,
            visiblePrimaryCount: visibleSessionCount
          })
        : undefined,
    [isSearchMode, primaryProject, projectNames, sessions, trimmedQuery, visibleSessionCount]
  )
  const recentSessions = useMemo(
    () =>
      primaryProject
        ? getRecentSessions(
            sessions.map((session) => ({
              id: session.id,
              projectId: session.projectId,
              title: session.title,
              updatedAt: session.updatedAt,
              artifactCount: session.artifacts?.length ?? 0,
              isPending: session.isPending
            })),
            primaryProject.id
          ).map((session) => ({
            ...session,
            kind: 'session' as const,
            projectName: primaryProject.name
          }))
        : [],
    [primaryProject, sessions]
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
          primaryLimit: GLOBAL_SEARCH_PAGE_SIZE,
          ...(cursor ? { primaryCursor: cursor } : {}),
          otherLimit: isSearchMode && !cursor ? 1 : 0
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
        setArtifactError(getErrorMessage(error))
        setFailedArtifactCursor(cursor)
      }
    },
    [isSearchMode, otherProjectIds, primaryProject, trimmedQuery]
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
    setArtifactStatus('idle')
    setArtifactError(undefined)
    setFailedArtifactCursor(undefined)
    setActionError(undefined)
    setActiveIndex(0)
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
  const selectableRows = useMemo<SelectableRow[]>(() => {
    if (!primaryProject) return []
    if (!isSearchMode) {
      return [
        ...artifacts.items.map((artifact) => ({ kind: 'artifact' as const, artifact })),
        ...recentSessions.map((session) => ({ kind: 'session' as const, session })),
        { kind: 'new-session' as const }
      ]
    }
    return [
      ...artifacts.items.map((artifact) => ({ kind: 'artifact' as const, artifact })),
      ...(artifactError ? [{ kind: 'retry-artifacts' as const }] : []),
      ...(canLoadMoreArtifacts ? [{ kind: 'more-artifacts' as const }] : []),
      ...(sessionGroups?.primary.map((session) => ({ kind: 'session' as const, session })) ?? []),
      ...(sessionMoreCount > 0 ? [{ kind: 'more-sessions' as const }] : []),
      ...artifacts.other.map((artifact) => ({ kind: 'artifact' as const, artifact })),
      ...(sessionGroups?.other.map((session) => ({ kind: 'session' as const, session })) ?? [])
    ]
  }, [
    canLoadMoreArtifacts,
    artifacts.items,
    artifacts.other,
    artifactError,
    isSearchMode,
    primaryProject,
    recentSessions,
    sessionGroups?.other,
    sessionGroups?.primary,
    sessionMoreCount
  ])

  const activeRowIndex = Math.max(0, Math.min(activeIndex, selectableRows.length - 1))
  const activeRowId = `global-search-option-${activeRowIndex}`

  useEffect(() => {
    if (!open || selectableRows.length === 0) return
    document.getElementById(activeRowId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeRowId, open, selectableRows.length])

  const close = useCallback(() => onOpenChange(false), [onOpenChange])
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
      if (activeProjectId !== artifact.projectId || view !== 'workspace') {
        openProject(artifact.projectId, 'user')
      }
      openFileDialog(artifactToPreviewItem(artifact))
      close()
    },
    [activeProjectId, close, openFileDialog, openProject, view]
  )
  const mentionArtifact = useCallback(
    (artifact: ProjectFileItem): void => {
      if (!canMentionArtifact(artifact)) return
      requestArtifactMention(artifact)
      close()
    },
    [canMentionArtifact, close, requestArtifactMention]
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
          setActionError('This session is no longer available.')
          return
        }
        openSession(row.session.projectId, row.session.id, 'user')
        close()
        return
      }
      if (row.kind === 'artifact') {
        if (action === 'mention' && canMentionArtifact(row.artifact)) {
          mentionArtifact(row.artifact)
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
        openProject(primaryProject.id, 'user')
        useSessionStore.getState().clearSelection()
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
      sessions
    ]
  )

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (selectableRows.length === 0) return
      setActiveIndex((current) => {
        const normalized = Math.max(0, Math.min(current, selectableRows.length - 1))
        return event.key === 'ArrowDown'
          ? (normalized + 1) % selectableRows.length
          : (normalized - 1 + selectableRows.length) % selectableRows.length
      })
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(Math.max(0, selectableRows.length - 1))
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

  const resultCount = isSearchMode
    ? (sessionGroups?.primaryTotalCount ?? 0) +
      artifacts.totalCount +
      (sessionGroups?.other.length ?? 0) +
      artifacts.other.length
    : artifacts.items.length + recentSessions.length + (primaryProject ? 1 : 0)
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
        <MessageCircle className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {session.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {session.projectId !== primaryProject?.id ? `${session.projectName} · ` : ''}
            {session.artifactCount} artifact{session.artifactCount === 1 ? '' : 's'} ·{' '}
            {formatRelativeTime(session.updatedAt)}
          </span>
        </span>
        {active ? (
          <Hash className="size-5 shrink-0 text-foreground" aria-label="Session" />
        ) : (
          <span className="rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
            Session
          </span>
        )}
      </div>
    )
  }

  const renderArtifactRow = (artifact: ProjectFileItem, rowIndex: number): React.JSX.Element => {
    const active = rowIndex === activeRowIndex
    const createdAt = artifact.sourceVersionId
      ? artifact.sortAtMs
      : artifact.messageId
        ? sessionMessageCreatedTimes.get(
            `${artifact.projectId}:${artifact.sessionId}:${artifact.messageId}`
          )
        : undefined
    const isCurrentSessionArtifact = isArtifactMentionTarget(artifact)
    const canMention = canMentionArtifact(artifact)
    return (
      <div
        id={`global-search-option-${rowIndex}`}
        key={`${artifact.projectId}:${artifact.id}:${artifact.sourceVersionId ?? ''}`}
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
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {artifact.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {artifact.projectId !== primaryProject?.id
              ? `${projectNames.get(artifact.projectId) ?? 'Unknown project'} · `
              : ''}
            {artifact.originSession?.title ??
              sessionTitles.get(`${artifact.projectId}:${artifact.sessionId}`) ??
              'Unknown session'}{' '}
            ·{' '}
            {createdAt === undefined ? 'Creation time unavailable' : formatRelativeTime(createdAt)}
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
                        aria-label={`Mention ${artifact.name}`}
                        disabled={!canMention}
                        onClick={(event) => {
                          event.stopPropagation()
                          mentionArtifact(artifact)
                        }}
                      >
                        <AtSign className="size-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {canMention
                      ? `Mention ${artifact.name}`
                      : 'Mention is unavailable while the composer cannot accept another artifact.'}
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
                    aria-label={`Open ${artifact.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      previewArtifact(artifact)
                    }}
                  >
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open {artifact.name}</TooltipContent>
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-testid="global-search-dialog"
          aria-describedby={undefined}
          className={dialogPanelClassName(
            'flex h-[calc(100dvh_-_1rem)] w-[calc(100%_-_1rem)] max-w-[680px] flex-col overflow-hidden p-0 sm:h-[min(760px,calc(100dvh_-_2rem))] sm:w-[calc(100%_-_2rem)]'
          )}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
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
              placeholder="Search this project…"
              maxLength={256}
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-xl text-foreground placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
            />
            {primaryProject ? (
              <span className="max-w-[35%] shrink-0 truncate rounded-lg bg-bg-200 px-3 py-1.5 text-sm font-medium text-muted-foreground">
                {primaryProject.name}
              </span>
            ) : null}
          </div>
          <p className="sr-only" aria-live="polite">
            {resultCount} results
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
                  Create a project to search sessions and artifacts.
                </p>
              ) : !isSearchMode ? (
                <>
                  {artifacts.items.length > 0 ? (
                    <section role="group" aria-label="Recent artifacts">
                      <h2 className={sectionTitleClassName}>Recent artifacts</h2>
                      {artifacts.items.map((artifact) => renderArtifactRow(artifact, nextIndex()))}
                    </section>
                  ) : null}
                  {recentSessions.length > 0 ? (
                    <section role="group" aria-label="Recent sessions">
                      <h2 className={sectionTitleClassName}>Recent sessions</h2>
                      {recentSessions.map((session) => renderSessionRow(session, nextIndex()))}
                    </section>
                  ) : null}
                  <section role="group" aria-label="Commands">
                    <h2 className={sectionTitleClassName}>Commands</h2>
                    <Button
                      id={`global-search-option-${nextIndex()}`}
                      type="button"
                      role="option"
                      aria-selected={activeRowIndex === rowIndex - 1}
                      variant="ghost"
                      disabled={!isSessionPersistenceReady}
                      className={cn(
                        rowClassName,
                        activeRowIndex === rowIndex - 1 && 'bg-bg-200 before:opacity-100',
                        !isSessionPersistenceReady && 'opacity-50'
                      )}
                      onMouseEnter={() => setActiveIndex(rowIndex - 1)}
                      onClick={() => activate({ kind: 'new-session' })}
                    >
                      <MessageCircle className="size-5 text-primary" aria-hidden="true" />
                      <span className="text-sm font-medium">New session</span>
                    </Button>
                  </section>
                </>
              ) : (
                <>
                  {artifacts.items.length || artifactStatus === 'loading' || artifactError ? (
                    <section role="group" aria-label="Artifacts">
                      <h2 className={sectionTitleClassName}>Artifacts</h2>
                      {artifacts.items.map((artifact) => renderArtifactRow(artifact, nextIndex()))}
                      {artifactStatus === 'loading' && artifacts.items.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-muted-foreground">
                          Searching artifacts…
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
                            ? 'Could not load more — retry'
                            : 'Could not load artifacts — retry'}
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
                          +{artifactMoreCount} more matches — show more
                        </Button>
                      ) : null}
                    </section>
                  ) : null}
                  {sessionGroups?.primary.length ? (
                    <section role="group" aria-label="Sessions">
                      <h2 className={sectionTitleClassName}>Sessions</h2>
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
                          +{sessionMoreCount} more matches — show more
                        </Button>
                      ) : null}
                    </section>
                  ) : null}
                  {sessionGroups?.other.length || artifacts.other.length ? (
                    <section role="group" aria-label="Other projects">
                      <h2 className={sectionTitleClassName}>Other projects</h2>
                      {artifacts.other.map((artifact) => renderArtifactRow(artifact, nextIndex()))}
                      {sessionGroups?.other.map((session) =>
                        renderSessionRow(session, nextIndex())
                      )}
                    </section>
                  ) : null}
                  {selectableRows.length === 0 && artifactStatus !== 'loading' ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No sessions or artifacts match “{query}”.
                    </p>
                  ) : null}
                </>
              )}
              {!artifacts.isIndexComplete ? (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  Some artifact results may be missing.
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
              <span>navigate</span>
            </span>
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>↵</kbd>
              <span>open</span>
            </span>
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>⇧↵</kbd>
              <span>mention</span>
            </span>
            <span className={shortcutClassName}>
              <kbd className={keycapClassName}>esc</kbd>
              <span>close</span>
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
