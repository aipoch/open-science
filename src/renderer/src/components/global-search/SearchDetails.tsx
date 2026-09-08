import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, File, LoaderCircle, MessageCircle } from 'lucide-react'
import { formatBytes } from '../../../../shared/update'
import { resolveLocaleFromTags } from '../../../../shared/locale'
import { formatDateTime, formatRelativeTime } from '@/lib/format-datetime'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SearchFilePreview } from './SearchFilePreview'
import { SearchDetailHeader } from './SearchDetailHeader'
import { ArtifactPreview } from '@/pages/workspace/artifact-preview'
import { ExtensionPreservingFileName } from '@/pages/workspace/ExtensionPreservingFileName'
import {
  createProjectFilePreviewArtifact,
  useProjectFilePreviewReader,
  useProjectFilePreviews
} from '@/pages/workspace/project-files-preview-owner'
import { ErrorNotice } from '@/components/error-notice'
import { FilePreviewDialog } from '@/pages/workspace/FilePreviewDialog'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { LiteratureItemView } from '../../../../shared/literature'
import type { Project } from '../../../../shared/projects'
import { STANDALONE_UPLOAD_SESSION_ID } from '../../../../shared/uploads'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import {
  filePreviewItem,
  literaturePreviewItem,
  resultId,
  fileFormatLabel,
  type SearchResult,
  type SearchSession
} from './search-result'
import { SearchHighlight } from './SearchHighlight'
import { SearchContentHighlight } from './SearchContentHighlight'

type Props = {
  result: SearchResult
  query: string
  projects: Project[]
  sessions: SearchSession[]
  onOpen: (result: SearchResult) => void
  onLocateFile: (file: ProjectFileItem) => void
  onNavigate: () => void
  onCollapse: () => void
}

export const SearchDetails = ({
  result,
  query,
  projects,
  sessions,
  onOpen,
  onLocateFile,
  onNavigate,
  onCollapse
}: Props): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const contentRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState('content')
  const [previewDialog, setPreviewDialog] = useState<PreviewFileItem>()
  const [files, setFiles] = useState<ProjectFileItem[]>([])
  const previewReader = useProjectFilePreviewReader()
  const visibleFiles = useMemo(
    () => (tab === 'files' || (tab === 'content' && result.kind === 'sessions') ? files : []),
    [files, tab, result.kind]
  )
  const filePreviews = useProjectFilePreviews(visibleFiles, previewReader)
  const [fileCount, setFileCount] = useState<number>()
  const [fileCountUnavailable, setFileCountUnavailable] = useState(false)
  const [papers, setPapers] = useState<LiteratureItemView[]>([])
  const [hasMoreRecentItems, setHasMoreRecentItems] = useState(false)
  const [collectionNames, setCollectionNames] = useState<string>()
  const [completeMessage, setCompleteMessage] = useState<string>()
  const initialStatus =
    result.kind === 'sessions' ||
    (result.kind === 'messages' && result.item.contentTruncated) ||
    (result.kind === 'library' && !('item' in result.item))
      ? 'loading'
      : 'idle'
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>(initialStatus)
  const identity = resultId(result)
  const [loadedIdentity, setLoadedIdentity] = useState(identity)
  if (loadedIdentity !== identity) {
    setLoadedIdentity(identity)
    setTab('content')
    setFiles([])
    setPapers([])
    setHasMoreRecentItems(false)
    setCollectionNames(undefined)
    setCompleteMessage(undefined)
    setFileCount(undefined)
    setFileCountUnavailable(false)
    setStatus(initialStatus)
  }
  const projectId =
    'projectId' in result.item
      ? result.item.projectId
      : result.kind === 'projects'
        ? result.item.id
        : undefined
  const project = projects.find((item) => item.id === projectId)
  const sessionId = 'sessionId' in result.item ? result.item.sessionId : undefined
  const session = sessions.find((item) => item.id === sessionId && item.projectId === projectId)
  const preview =
    result.kind === 'generated' || result.kind === 'uploads'
      ? filePreviewItem(result.item)
      : result.kind === 'library' && 'item' in result.item
        ? literaturePreviewItem(result.item)
        : undefined
  const isCollection = result.kind === 'library' && !('item' in result.item)
  const recentSessions =
    result.kind === 'projects'
      ? sessions
          .filter((item) => item.projectId === result.item.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : []
  useLayoutEffect(() => {
    if (contentRef.current && result.kind !== 'messages') contentRef.current.scrollTop = 0
  }, [identity, tab, result.kind])

  useEffect(() => {
    let active = true
    if (result.kind === 'messages' && result.item.contentTruncated) {
      // Search pages carry bounded excerpts. Hydrate only the selected Message, and discard a
      // delayed read when the selection changes so it cannot replace another result's preview.
      void window.api.sessions
        .loadOne({ projectId: result.item.projectId, sessionId: result.item.sessionId })
        .then((transcript) => {
          if (!active) return
          const message =
            transcript?.archivedAt === undefined
              ? transcript?.messages.find(
                  (message) =>
                    message.id === result.item.messageId && !isHiddenControlMessage(message)
                )
              : undefined
          if (!message) {
            setStatus('error')
            return
          }
          setCompleteMessage(message.content)
          setStatus('idle')
        })
        .catch(() => {
          if (active) setStatus('error')
        })
    } else if (result.kind === 'projects') {
      void window.api.projectFiles
        .getOverview({ projectId: result.item.id })
        .then((overview) => {
          if (active) {
            setFileCount(overview.totalCount)
            setFileCountUnavailable(!overview.isIndexComplete)
          }
        })
        .catch(() => {
          if (active) setFileCountUnavailable(true)
        })
      void window.api.projectFiles
        .searchArtifacts({
          primaryProjectIds: [result.item.id],
          otherProjectIds: [],
          source: 'all',
          sort: 'recent',
          primaryLimit: 10,
          otherLimit: 0
        })
        .then((page) => {
          if (active) {
            setFiles(page.primary.items)
            setHasMoreRecentItems(page.primary.totalCount > 10)
          }
        })
        .catch(() => {
          if (active) setFiles([])
        })
    } else if (result.kind === 'sessions') {
      void window.api.projectFiles
        .searchArtifacts({
          primaryProjectIds: [result.item.projectId],
          otherProjectIds: [],
          source: 'all',
          sessionId: result.item.id,
          primaryLimit: 10,
          otherLimit: 0
        })
        .then((page) => {
          if (active) {
            setFiles(page.primary.items)
            setHasMoreRecentItems(page.primary.totalCount > 10)
            setFileCount(page.primary.totalCount)
            setFileCountUnavailable(!page.isIndexComplete)
            setStatus('idle')
          }
        })
        .catch(() => {
          if (active) {
            setStatus('error')
            setFileCountUnavailable(true)
          }
        })
    } else if (result.kind === 'library' && 'item' in result.item) {
      const itemId = result.item.id
      async function loadCollections(): Promise<void> {
        try {
          const names: string[] = []
          let offset: number | undefined
          do {
            const page = await window.api.literature.search({
              scope: 'collections',
              itemId,
              limit: 100,
              offset
            })
            if (!active) return
            for (const entry of page.entries) if ('name' in entry) names.push(entry.name)
            offset = page.nextOffset
          } while (offset !== undefined)
          setCollectionNames(names.join(', ') || t('None'))
        } catch {
          if (active) setCollectionNames(t('Some results are unavailable.'))
        }
      }
      void loadCollections()
    } else if (result.kind === 'library' && !('item' in result.item)) {
      void window.api.literature
        .search({
          scope: 'library',
          collectionId: result.item.id,
          limit: 10,
          sortBy: 'updated',
          sortDirection: 'desc'
        })
        .then((page) => {
          if (active) {
            setPapers(page.entries.filter((item): item is LiteratureItemView => 'item' in item))
            setHasMoreRecentItems(page.nextOffset !== undefined || (page.totalCount ?? 0) > 10)
            setStatus('idle')
          }
        })
        .catch(() => {
          if (active) setStatus('error')
        })
    }
    return () => {
      active = false
    }
    // Result identity changes reset tabs and related content without remounting the outer pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  const tabs =
    result.kind === 'messages'
      ? []
      : [
          {
            id: 'content',
            label:
              result.kind === 'projects'
                ? t('Recent sessions')
                : result.kind === 'sessions'
                  ? t('Recent files')
                  : result.kind === 'library'
                    ? isCollection
                      ? t('Recent literature')
                      : t('Abstract')
                    : t('Content preview')
          },
          ...(result.kind === 'projects' ? [{ id: 'files', label: t('Recent files') }] : []),
          {
            id: 'details',
            label:
              result.kind === 'uploads' || result.kind === 'generated'
                ? t('File information')
                : t('Details')
          },
          ...(result.kind === 'library' && preview ? [{ id: 'preview', label: t('Preview') }] : [])
        ]
  const openPreview = (): void => {
    if (preview) setPreviewDialog(preview)
    else onOpen(result)
  }
  const isLibraryPreview = result.kind === 'library' && tab === 'preview' && !!preview
  const openLabel = isLibraryPreview
    ? t('Open file')
    : result.kind === 'messages'
      ? t('Jump to message')
      : result.kind === 'projects'
        ? t('Open project')
        : result.kind === 'sessions'
          ? t('Open session')
          : result.kind === 'library'
            ? isCollection
              ? t('Open collection')
              : t('Open literature')
            : t('Open full screen preview')
  // Match artifact tiles while keeping preview and source navigation owned by the search panel.
  const renderFiles = (): React.JSX.Element => (
    <div className="search-recent-file-grid">
      {files.map((file) => (
        <div key={file.id} className="search-recent-file relative">
          <button
            type="button"
            className="search-recent-file-open"
            title={file.name}
            onClick={() => setPreviewDialog(filePreviewItem(file))}
          >
            <div className="search-recent-file-thumb">
              <ArtifactPreview
                projectId={file.projectId}
                sessionId={file.sessionId}
                source={file.source === 'upload' ? 'upload' : undefined}
                managedFileId={file.sourceFileId}
                selectedVersionId={file.sourceVersionId}
                artifact={createProjectFilePreviewArtifact(file)}
                preview={filePreviews.get(file.id)}
              />
            </div>
            <div className="search-recent-file-info">
              <ExtensionPreservingFileName name={file.name} className="search-recent-file-name" />
              <div className="search-recent-file-meta">
                {fileFormatLabel(file)}
                {' · '}
                {formatBytes(file.size)}
              </div>
            </div>
          </button>
          {renderLocateFile(file)}
        </div>
      ))}
    </div>
  )
  // Preview and source navigation are separate controls so opening a file retains the search.
  const renderLocateFile = (file: ProjectFileItem, compact = true): React.JSX.Element | null => {
    if (file.sessionId === STANDALONE_UPLOAD_SESSION_ID) return null
    if (file.originSession && file.originSession.state !== 'active') return null
    if (!compact)
      return (
        <Button size="sm" variant="secondary" onClick={() => onLocateFile(file)}>
          {t('Jump to message')}
          <ArrowUpRight className="ml-1 size-3.5" />
        </Button>
      )
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="search-file-locate size-6"
              aria-label={t('View in context for {{title}}', { title: file.name })}
              onClick={() => onLocateFile(file)}
            >
              <ArrowUpRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('Jump to message')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  const details = (): React.JSX.Element => {
    switch (result.kind) {
      case 'messages':
        return <></>
      case 'projects':
        return (
          <div className="space-y-5">
            <div>
              <p className="text-xs text-muted-foreground">{t('Description')}</p>
              <p className="search-detail-abstract">
                <SearchHighlight
                  text={result.item.description || t('No description')}
                  query={query}
                />
              </p>
            </div>
            {result.item.agentContext && (
              <div>
                <p className="mb-2 text-xs text-muted-foreground">{t('Agent Context')}</p>
                <AgentMarkdown content={result.item.agentContext} />
              </div>
            )}
          </div>
        )
      case 'sessions':
        return (
          <dl className="search-details-metadata">
            <dt>{t('Project')}</dt>
            <dd>{project?.name}</dd>
            <dt>{t('Session')}</dt>
            <dd>{result.item.title}</dd>
            <dt>{t('Updated')}</dt>
            <dd>{formatDateTime(result.item.updatedAt, locale, 'dateTime')}</dd>
          </dl>
        )
      case 'uploads':
      case 'generated':
        return (
          <dl className="search-details-metadata">
            <dt>{t('File name')}</dt>
            <dd>{result.item.name}</dd>
            <dt>{t('File size')}</dt>
            <dd>{formatBytes(result.item.size)}</dd>
            <dt>{t('Type')}</dt>
            <dd>{fileFormatLabel(result.item)}</dd>
            <dt>{t('Project')}</dt>
            <dd>{project?.name}</dd>
            <dt>{t('Session')}</dt>
            <dd>
              {result.item.sessionId === STANDALONE_UPLOAD_SESSION_ID
                ? t('Local computer')
                : (session?.title ?? result.item.originSession?.title)}
            </dd>
            <dt>{t('Source')}</dt>
            <dd>{result.kind === 'uploads' ? t('Uploaded files') : t('Generated files')}</dd>
            <dt>{t('Updated')}</dt>
            <dd>{formatDateTime(result.item.sortAtMs, locale, 'dateTime')}</dd>
          </dl>
        )
      case 'library':
        return 'item' in result.item ? (
          <dl className="search-details-metadata">
            <dt>{t('Title')}</dt>
            <dd>{result.item.item.title}</dd>
            <dt>{t('Authors')}</dt>
            <dd>
              {result.item.item.creators
                .map((creator) =>
                  creator.nameMode === 'organization'
                    ? creator.literalName
                    : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
                )
                .join(', ')}
            </dd>
            <dt>{t('Year')}</dt>
            <dd>{result.item.item.issuedText}</dd>
            <dt>{t('Journal')}</dt>
            <dd>{result.item.item.containerTitle}</dd>
            <dt>{t('Projects')}</dt>
            <dd>
              {projects
                .filter(
                  (project) =>
                    'projectIds' in result.item && result.item.projectIds.includes(project.id)
                )
                .map((project) => project.name)
                .join(', ') || t('None')}
            </dd>
            <dt>{t('Collections')}</dt>
            <dd>{collectionNames ?? t('Loading…')}</dd>
            <dt>{t('Full text')}</dt>
            <dd>{preview ? t('PDF available') : t('No PDF')}</dd>
            {result.item.item.identifiers.map((identifier) => (
              <div className="contents" key={identifier.scheme}>
                <dt>{identifier.scheme}</dt>
                <dd>{identifier.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="search-detail-abstract">
            <SearchHighlight text={result.item.description || t('No description')} query={query} />
          </p>
        )
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col pt-[5px]">
      <SearchDetailHeader
        result={result}
        projects={projects}
        sessions={sessions}
        fileCount={fileCount}
        fileCountUnavailable={fileCountUnavailable}
        onCollapse={onCollapse}
      />
      {tabs.length > 0 && (
        <div
          role="tablist"
          aria-label={t('Details')}
          className="search-detail-tabs"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = tabs.findIndex((item) => item.id === tab)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            setTab(tabs[next]!.id)
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              id={`search-detail-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls="search-detail-tabpanel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              className="transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div
        ref={contentRef}
        className="search-detail-content min-h-0 flex-1 overflow-auto"
        role={tabs.length ? 'tabpanel' : undefined}
        id="search-detail-tabpanel"
        aria-labelledby={tabs.length ? `search-detail-tab-${tab}` : undefined}
      >
        {result.kind === 'messages' ? (
          (!result.item.contentTruncated || completeMessage !== undefined) && (
            <SearchContentHighlight query={query} className="search-message-content">
              <AgentMarkdown
                content={result.item.contentTruncated ? completeMessage! : result.item.content}
              />
            </SearchContentHighlight>
          )
        ) : tab === 'details' ? (
          details()
        ) : tab === 'preview' ||
          (preview && (result.kind === 'uploads' || result.kind === 'generated')) ? (
          preview && (
            <SearchFilePreview
              key={preview.id}
              item={preview}
              query={query}
              contentMatch={
                result.kind === 'uploads' || result.kind === 'generated'
                  ? result.item.contentMatch
                  : undefined
              }
              onOpen={openPreview}
            />
          )
        ) : result.kind === 'projects' && tab === 'content' ? (
          <div>
            {recentSessions.slice(0, 10).map((item) => (
              <button
                key={item.id}
                className="search-recent-session focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpen({ kind: 'sessions', item })}
              >
                <MessageCircle aria-hidden="true" />
                <span className="search-recent-session-text">
                  <strong>{item.title}</strong>
                  <small>
                    #{item.number}
                    {' · '}
                    {formatRelativeTime(item.updatedAt, locale)}
                  </small>
                </span>
                <ArrowUpRight aria-hidden="true" className="search-recent-arrow" />
              </button>
            ))}
            {recentSessions.length === 0 && (
              <p className="search-recent-empty">{t('No recent content')}</p>
            )}
            {recentSessions.length > 10 && (
              <p className="search-recent-limit">{t('Only the 10 most recent items are shown')}</p>
            )}
          </div>
        ) : result.kind === 'sessions' || (result.kind === 'projects' && tab === 'files') ? (
          <>
            {renderFiles()}
            {hasMoreRecentItems && (
              <p className="search-recent-limit">{t('Only the 10 most recent items are shown')}</p>
            )}
          </>
        ) : result.kind === 'library' && 'item' in result.item ? (
          <p className="search-detail-abstract">
            <SearchHighlight
              text={result.item.item.abstract || t('No abstract available')}
              query={query}
            />
          </p>
        ) : (
          <div>
            {papers.map((item) => (
              <button
                key={item.id}
                onClick={() => onOpen({ kind: 'library', item })}
                className="search-recent-literature focus-visible:ring-2 focus-visible:ring-ring"
              >
                <File className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="line-clamp-2">{item.item.title}</span>
                <ArrowUpRight aria-hidden="true" className="search-recent-arrow" />
              </button>
            ))}
            {hasMoreRecentItems && (
              <p className="search-recent-limit">{t('Only the 10 most recent items are shown')}</p>
            )}
          </div>
        )}
        {tab === 'content' && status === 'loading' && (
          <div role="status" className="flex justify-center py-8">
            <LoaderCircle className="size-5 animate-spin" aria-label={t('Loading…')} />
          </div>
        )}
        {tab === 'content' && status === 'error' && (
          <ErrorNotice
            title={
              result.kind === 'messages'
                ? t('The source message is no longer available.')
                : t('Could not load recent content.')
            }
          />
        )}
        {tab === 'content' &&
          status === 'idle' &&
          ((result.kind === 'sessions' && files.length === 0) ||
            (isCollection && papers.length === 0)) && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('No recent content')}
            </p>
          )}
      </div>
      <footer className="search-detail-actions">
        {(result.kind === 'uploads' || result.kind === 'generated') &&
          renderLocateFile(result.item, false)}
        <Button
          size="sm"
          className="search-detail-open"
          onClick={() =>
            isLibraryPreview || result.kind === 'uploads' || result.kind === 'generated'
              ? openPreview()
              : onOpen(result)
          }
        >
          {openLabel}
          <ArrowUpRight className="ml-1 size-3.5" />
        </Button>
      </footer>
      <FilePreviewDialog
        item={previewDialog}
        allowReadingContext={false}
        onClose={() => setPreviewDialog(undefined)}
        onViewInContextNavigate={() => {
          setPreviewDialog(undefined)
          onNavigate()
        }}
      />
    </div>
  )
}
