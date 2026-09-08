import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpenText, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ProjectFileItem } from '../../../../../shared/project-files'
import type {
  LiteratureReference,
  LiteratureScopeReference
} from '../../../../../shared/session-persistence'

import { ExtensionPreservingFileName } from '../ExtensionPreservingFileName'
import { getExtensionPreservingFileNameParts } from '../extension-preserving-file-name'
import {
  searchLiteratureCollectionMentionOptions,
  searchLiteratureMentionOptions
} from '../literature-pdf-options'

import { ArtifactFileIcon } from './artifact-file-icon'
import { fuzzyScore, type FuzzyMatch } from './fuzzy-match'
import { HighlightedText } from './HighlightedText'
import { loadAllProjectFiles } from './load-project-files'

// The reference passed back to the composer when an artifact row is picked.
export type PickedArtifact = {
  id: string
  sourceFileId: string
  name: string
  path: string
  source: 'upload' | 'artifact'
  mimeType?: string
  versionId?: string
}
export type PickedMention = PickedArtifact | LiteratureReference | LiteratureScopeReference

// Popup that suggests project files and Literature PDFs for the composer's `@` mention trigger.
// Like the skill popup the composer keeps caret focus, so this listens for navigation keys on
// document while mounted.
type ArtifactMentionPopupProps = {
  query: string
  selectionKey?: object | null
  composingRef?: React.RefObject<boolean>
  listboxId?: string
  onActiveOptionIdChange?: (optionId: string | undefined) => void
  onSelect: (ref: PickedMention) => void
  onClose: () => void
}

// One suggestion row: a picked artifact plus the display size and its section tag. `positions` holds
// the fuzzy-match indices into `name` to highlight (empty when the query is empty).
type ArtifactRow = {
  id: string
  name: string
  path?: string
  source?: PickedArtifact['source'] | 'literature'
  projectId?: string
  sourceFileId?: string
  picked?: LiteratureReference | LiteratureScopeReference
  mimeType?: string
  size?: number
  tag: 'upload' | 'output' | 'library-scope' | 'collection-scope' | 'library'
  iconName?: string
  description?: string
  positions?: number[]
}

type LiteratureResult = {
  projectId?: string
  query: string
  rows: ArtifactRow[]
  state: 'loading' | 'loaded' | 'error'
}

// Catalog keys for the section headers, ordered as they render.
const SECTION_UPLOADS_KEY = 'User uploads'
const SECTION_ARTIFACTS_KEY = 'Other artifacts'
const SECTION_LIBRARY_KEY = 'Library'

export const ArtifactMentionPopup = ({
  query,
  composingRef,
  selectionKey,
  listboxId,
  onActiveOptionIdChange,
  onSelect,
  onClose
}: ArtifactMentionPopupProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const generatedListboxId = useId()
  const resolvedListboxId = listboxId ?? generatedListboxId
  const selectionRevisionRef = useRef(0)
  const [selectionError, setSelectionError] = useState<string>()
  const [projectFiles, setProjectFiles] = useState<{
    projectId?: string
    files: ProjectFileItem[]
    state: 'loading' | 'loaded' | 'error'
  }>({ files: [], state: 'loaded' })
  const [library, setLibrary] = useState<LiteratureResult>({
    query: '',
    rows: [],
    state: 'loading'
  })
  const [collections, setCollections] = useState<LiteratureResult>({
    query: '',
    rows: [],
    state: 'loading'
  })
  const [fileRetry, setFileRetry] = useState(0)
  const [libraryRetry, setLibraryRetry] = useState(0)
  const [collectionRetry, setCollectionRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!activeProjectId) return

    void loadAllProjectFiles(activeProjectId)
      .then((files) => {
        if (!cancelled) setProjectFiles({ projectId: activeProjectId, files, state: 'loaded' })
      })
      .catch(() => {
        if (!cancelled) setProjectFiles({ projectId: activeProjectId, files: [], state: 'error' })
      })

    return () => {
      cancelled = true
    }
  }, [activeProjectId, fileRetry])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void searchLiteratureMentionOptions(query, { projectId: activeProjectId }).then(
        (options) => {
          if (cancelled) return
          setLibrary({
            projectId: activeProjectId,
            query,
            state: 'loaded',
            rows: options.map((option) => ({
              id: option.reference.itemId,
              projectId: activeProjectId,
              name: option.name,
              picked: option.reference,
              source: 'literature',
              tag: 'library',
              iconName: option.iconName,
              description: option.description
            }))
          })
        },
        () => {
          if (!cancelled)
            setLibrary({ projectId: activeProjectId, query, rows: [], state: 'error' })
        }
      )
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [activeProjectId, query, libraryRetry])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void (
        query.trim() ? searchLiteratureCollectionMentionOptions(query) : Promise.resolve([])
      ).then(
        (options) => {
          if (cancelled) return
          setCollections({
            projectId: activeProjectId,
            query,
            state: 'loaded',
            rows: options.map((option) => ({
              id: option.reference.scope === 'collection' ? option.reference.collectionId : '',
              projectId: activeProjectId,
              name: option.name,
              picked: option.reference,
              tag: 'collection-scope'
            }))
          })
        },
        () => {
          if (!cancelled)
            setCollections({ projectId: activeProjectId, query, rows: [], state: 'error' })
        }
      )
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [activeProjectId, query, collectionRetry])

  const libraryState =
    library.query === query && library.projectId === activeProjectId ? library.state : 'loading'
  const collectionState =
    collections.query === query && collections.projectId === activeProjectId
      ? collections.state
      : 'loading'

  // ManagedFile supplies a logical file identity. The consumer resolves its current DB head when the
  // turn starts; only an explicit history action may attach an immutable Version id.
  const rows = useMemo<ArtifactRow[]>(() => {
    const projectRows =
      projectFiles.projectId === activeProjectId
        ? projectFiles.files.map((file): ArtifactRow => ({
            id: file.id,
            sourceFileId: file.sourceFileId,
            projectId: file.projectId,
            name: file.name,
            path: file.path,
            source: file.source,
            mimeType: file.mimeType,
            size: file.size,
            tag: file.source === 'upload' ? ('upload' as const) : ('output' as const)
          }))
        : []
    const libraryScopeRows: ArtifactRow[] = query.trim()
      ? [
          {
            id: 'library',
            projectId: activeProjectId,
            name: t('Library'),
            description: t('References linked to this project.'),
            picked: { type: 'literature-scope', scope: 'project' },
            tag: 'library-scope'
          }
        ]
      : []
    return [
      ...projectRows,
      ...libraryScopeRows,
      ...(collectionState === 'loaded' ? collections.rows : []),
      ...(libraryState === 'loaded' ? library.rows : [])
    ]
  }, [activeProjectId, library, libraryState, collections, collectionState, projectFiles, query, t])
  const loadState =
    !activeProjectId || projectFiles.projectId === activeProjectId ? projectFiles.state : 'loading'

  // Fuzzy-match the query against each filename, ranked best-first. Ranking happens within each section
  // so uploads still render before outputs — the flat highlight index depends on that order. Empty
  // query preserves the incoming order within each section.
  const matches = useMemo<ArtifactRow[]>(() => {
    const needle = query.trim()

    const rankSection = (tag: ArtifactRow['tag']): ArtifactRow[] =>
      needle.length === 0 || tag === 'library'
        ? rows.filter((row) => row.tag === tag)
        : rows
            .filter((row) => row.tag === tag)
            .map((row) => ({ row, match: fuzzyScore(needle, row.name) }))
            .filter(
              (entry): entry is { row: ArtifactRow; match: FuzzyMatch } => entry.match !== null
            )
            .sort((a, b) => b.match.score - a.match.score)
            .map(({ row, match }) => ({ ...row, positions: match.positions }))

    return [
      ...rankSection('upload'),
      ...rankSection('output'),
      ...rankSection('library-scope'),
      ...rankSection('collection-scope'),
      ...rankSection('library')
    ]
  }, [rows, query])

  const [activeIndex, setActiveIndex] = useState(0)

  // Reset the highlight to the top when the query changes (setState-during-render pattern).
  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setActiveIndex(0)
  }

  // Keep the highlight within the current match set even after filtering shrinks it.
  const safeIndex = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1)

  const activeOptionId = matches.length > 0 ? `${resolvedListboxId}-option-${safeIndex}` : undefined

  // Focus remains in the editor, so keep its active-descendant target synchronized and visible.
  useEffect(() => {
    onActiveOptionIdChange?.(activeOptionId)
    return () => onActiveOptionIdChange?.(undefined)
  }, [activeOptionId, onActiveOptionIdChange])

  useEffect(() => {
    if (activeOptionId)
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])

  const selectRow = useCallback(
    async (row: ArtifactRow): Promise<void> => {
      if (row.projectId !== useNavigationStore.getState().activeProjectId || !matches.includes(row))
        return
      const revision = ++selectionRevisionRef.current
      if (
        (row.tag === 'library' || row.tag === 'library-scope' || row.tag === 'collection-scope') &&
        row.picked
      ) {
        onSelect(row.picked)
        return
      }
      if (!row.projectId || !row.sourceFileId || !row.source || row.source === 'literature') {
        setSelectionError(t('Could not resolve file version.'))
        return
      }
      setSelectionError(undefined)
      const inspect = window.api.managedFileVersions?.inspect
      if (!inspect) {
        setSelectionError(t('File version resolution is unavailable.'))
        return
      }
      try {
        const result = await inspect({
          source: row.source,
          projectId: row.projectId,
          fileId: row.sourceFileId
        })
        if (revision !== selectionRevisionRef.current) return
        if (!result.ok) {
          setSelectionError(t('Could not resolve file version.'))
          return
        }
        const head =
          result.value.headVersion ??
          result.value.versions.find((version) => version.id === result.value.headVersionId)
        if (!head) {
          setSelectionError(t('The current file version is unavailable.'))
          return
        }
        onSelect({
          id: row.id,
          sourceFileId: row.sourceFileId,
          name: result.value.displayName,
          path: row.path ?? '',
          source: row.source,
          mimeType: head.contentType ?? row.mimeType,
          versionId: head.id
        })
      } catch {
        if (revision !== selectionRevisionRef.current) return
        setSelectionError(t('Could not resolve file version.'))
      }
    },
    [matches, onSelect, t]
  )

  useLayoutEffect(
    () => () => {
      selectionRevisionRef.current += 1
    },
    [query, selectionKey, activeProjectId]
  )

  // Handle navigation keys at the document level while mounted, since focus stays in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || composingRef?.current) return
      if (
        event.target instanceof Element &&
        event.target.closest('button') &&
        event.key !== 'Escape'
      )
        return
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
        // The popup owns Enter for its entire mounted lifetime. In particular, do not let the editor
        // submit a raw @query while the asynchronous Project Files page is still loading.
        const active = matches[safeIndex]
        if (event.key === 'Enter' || active) event.preventDefault()
        if (active) {
          void selectRow(active)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [matches, safeIndex, selectRow, onClose, composingRef])

  // Split the flat match list back into its sections, preserving the flat highlight index.
  const uploadMatches = matches.filter((row) => row.tag === 'upload')
  const artifactMatches = matches.filter((row) => row.tag === 'output')
  const scopeMatches = matches.filter(
    (row) => row.tag === 'library-scope' || row.tag === 'collection-scope'
  )
  const libraryMatches = matches.filter((row) => row.tag === 'library')

  const renderRow = (row: ArtifactRow, index: number): React.JSX.Element => {
    const isActive = index === safeIndex
    const size = formatByteSize(row.size)
    const parts = getExtensionPreservingFileNameParts(row.name)
    const basenameLength = row.name.length - parts.extension.length
    const tailStart = basenameLength - parts.tail.length
    const visiblePositions = row.positions ?? []
    // Re-map fuzzy-match offsets after the middle is replaced, preserving query highlights.
    const headPositions = visiblePositions.filter((position) => position < parts.head.length)
    const tailPositions = visiblePositions
      .filter((position) => position >= tailStart && position < basenameLength)
      .map((position) => position - tailStart)
    const extensionPositions = visiblePositions
      .filter((position) => position >= basenameLength)
      .map((position) => position - basenameLength)

    return (
      <li
        key={`${row.tag}:${row.id}`}
        id={`${resolvedListboxId}-option-${index}`}
        role="option"
        aria-selected={isActive}
        onMouseEnter={() => setActiveIndex(index)}
        // Keep the editor focused/caret intact so the mention stays open long enough for the click.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void selectRow(row)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-text-100 hover:bg-bg-200 hover:text-text-000 transition-colors cursor-pointer${
          isActive ? ' bg-bg-200 !text-text-000' : ''
        }`}
      >
        {row.tag === 'library-scope' ? (
          <BookOpenText className="size-4 shrink-0 text-text-200" aria-hidden="true" />
        ) : row.tag === 'collection-scope' ? (
          <FolderOpen className="size-4 shrink-0 text-text-200" aria-hidden="true" />
        ) : (
          <ArtifactFileIcon
            name={row.iconName ?? row.name}
            mimeType={row.mimeType}
            path={row.path ?? ''}
            source={row.source ?? 'literature'}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 font-medium">
            {row.positions?.length ? (
              <>
                <span className="min-w-0 shrink truncate">
                  <HighlightedText text={parts.head} positions={headPositions} />
                </span>
                <span className="shrink-0">
                  <HighlightedText text={parts.tail} positions={tailPositions} />
                </span>
                <span className="shrink-0">
                  <HighlightedText text={parts.extension} positions={extensionPositions} />
                </span>
              </>
            ) : (
              <ExtensionPreservingFileName name={row.name} />
            )}
          </span>
          {row.description ? (
            <span className="truncate text-xs text-text-300">{row.description}</span>
          ) : null}
        </span>
        {size ? <span className="text-xs text-text-300 shrink-0">{size}</span> : null}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground shrink-0">
          {row.tag === 'upload'
            ? t('upload')
            : row.tag === 'output'
              ? t('output')
              : row.tag === 'collection-scope'
                ? t('Collections')
                : row.tag === 'library'
                  ? t('Reference')
                  : t('Library')}
        </span>
      </li>
    )
  }

  return (
    <div className="absolute bottom-full left-0 mb-1 z-50 flex flex-col bg-bg-000 border-0.5 border-border-200 rounded-xl shadow-[0_4px_16px_hsl(var(--always-black)/10%)] p-1.5 min-w-[320px] max-w-[440px] max-h-[min(45vh,18rem)] overflow-hidden">
      {selectionError ? (
        <div role="alert" className="px-2 py-1.5 text-sm text-danger-000">
          {selectionError}
        </div>
      ) : null}
      {[
        {
          state: loadState,
          label: t('Could not load project files'),
          retry: () => {
            setProjectFiles({ projectId: activeProjectId, files: [], state: 'loading' })
            setFileRetry((value) => value + 1)
          }
        },
        {
          state: libraryState,
          label: t('Literature could not be loaded.'),
          retry: () => {
            setLibrary({ projectId: activeProjectId, query, rows: [], state: 'loading' })
            setLibraryRetry((value) => value + 1)
          }
        },
        {
          state: collectionState,
          label: t('Collections could not be loaded.'),
          retry: () => {
            setCollections({ projectId: activeProjectId, query, rows: [], state: 'loading' })
            setCollectionRetry((value) => value + 1)
          }
        }
      ]
        .filter(({ state }) => state === 'error')
        .map(({ label, retry }) => (
          <div
            key={label}
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="flex shrink-0 items-center justify-between gap-3 px-2 py-1.5 text-sm text-text-300"
          >
            <span>{label}</span>
            <button
              type="button"
              className="shrink-0 text-primary underline"
              onMouseDown={(event) => event.preventDefault()}
              onClick={retry}
            >
              {t('Retry')}
            </button>
          </div>
        ))}
      {matches.length === 0 && ![loadState, libraryState, collectionState].includes('error') ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="px-2 py-1.5 text-sm text-text-300"
        >
          {loadState === 'loading'
            ? t('Loading project files…')
            : libraryState === 'loading' || collectionState === 'loading'
              ? t('Loading…')
              : t('No artifacts yet')}
        </div>
      ) : null}
      <ul
        id={resolvedListboxId}
        role="listbox"
        aria-label={t('Artifact suggestions')}
        className="min-h-0 overflow-y-auto max-h-[min(45vh,18rem)]"
      >
        {uploadMatches.length > 0 ? (
          <>
            <li
              aria-hidden="true"
              className="px-2 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-400 select-none"
            >
              {t(SECTION_UPLOADS_KEY)}
            </li>
            {uploadMatches.map((row, index) => renderRow(row, index))}
          </>
        ) : null}
        {artifactMatches.length > 0 ? (
          <>
            <li
              aria-hidden="true"
              className="px-2 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-400 select-none"
            >
              {t(SECTION_ARTIFACTS_KEY)}
            </li>
            {artifactMatches.map((row, index) => renderRow(row, uploadMatches.length + index))}
          </>
        ) : null}
        {scopeMatches.length > 0 ? (
          <>
            <li
              aria-hidden="true"
              className="px-2 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-400 select-none"
            >
              {t(SECTION_LIBRARY_KEY)}
            </li>
            {scopeMatches.map((row, index) =>
              renderRow(row, uploadMatches.length + artifactMatches.length + index)
            )}
          </>
        ) : null}
        {libraryMatches.length > 0 ? (
          <>
            <li
              aria-hidden="true"
              className="px-2 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-400 select-none"
            >
              {t('References')}
            </li>
            {libraryMatches.map((row, index) =>
              renderRow(
                row,
                uploadMatches.length + artifactMatches.length + scopeMatches.length + index
              )
            )}
          </>
        ) : null}
      </ul>
      <div className="shrink-0 mt-1 -mx-1.5 -mb-1.5 px-3.5 pt-1.5 pb-2 border-t border-border-300 flex items-center gap-3 text-[11px] text-text-400 select-none">
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
