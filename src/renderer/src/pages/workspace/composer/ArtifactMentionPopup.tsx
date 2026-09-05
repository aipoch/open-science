import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ProjectFileItem } from '../../../../../shared/project-files'

import { ExtensionPreservingFileName } from '../ExtensionPreservingFileName'
import { getExtensionPreservingFileNameParts } from '../extension-preserving-file-name'

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

// Popup that suggests project artifacts for the composer's `@` mention trigger. Like the skill popup
// the composer keeps caret focus, so this listens for navigation keys on document while mounted.
type ArtifactMentionPopupProps = {
  query: string
  listboxId?: string
  onActiveOptionIdChange?: (optionId: string | undefined) => void
  onSelect: (ref: PickedArtifact) => void
  onClose: () => void
}

// One suggestion row: a picked artifact plus the display size and its section tag. `positions` holds
// the fuzzy-match indices into `name` to highlight (empty when the query is empty).
type ArtifactRow = PickedArtifact & {
  projectId: string
  size?: number
  tag: 'upload' | 'output'
  positions?: number[]
}

// Catalog keys for the section headers, ordered as they render.
const SECTION_UPLOADS_KEY = 'User uploads'
const SECTION_ARTIFACTS_KEY = 'Other artifacts'

export const ArtifactMentionPopup = ({
  query,
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
    state: 'loaded' | 'error'
  }>({ files: [], state: 'loaded' })

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
  }, [activeProjectId])

  // ManagedFile supplies a logical file identity. The consumer resolves its current DB head when the
  // turn starts; only an explicit history action may attach an immutable Version id.
  const rows = useMemo<ArtifactRow[]>(
    () =>
      projectFiles.projectId === activeProjectId
        ? projectFiles.files.map((file) => ({
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
        : [],
    [activeProjectId, projectFiles]
  )
  const loadState =
    !activeProjectId || projectFiles.projectId === activeProjectId ? projectFiles.state : 'loading'

  // Fuzzy-match the query against each filename, ranked best-first. Ranking happens within each section
  // so uploads still render before outputs — the flat highlight index depends on that order. Empty
  // query shows every artifact untouched.
  const matches = useMemo<ArtifactRow[]>(() => {
    const needle = query.trim()
    if (needle.length === 0) return rows

    const rankSection = (tag: ArtifactRow['tag']): ArtifactRow[] =>
      rows
        .filter((row) => row.tag === tag)
        .map((row) => ({ row, match: fuzzyScore(needle, row.name) }))
        .filter((entry): entry is { row: ArtifactRow; match: FuzzyMatch } => entry.match !== null)
        .sort((a, b) => b.match.score - a.match.score)
        .map(({ row, match }) => ({ ...row, positions: match.positions }))

    return [...rankSection('upload'), ...rankSection('output')]
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
      const revision = ++selectionRevisionRef.current
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
          path: row.path,
          source: row.source,
          mimeType: head.contentType ?? row.mimeType,
          versionId: head.id
        })
      } catch {
        if (revision !== selectionRevisionRef.current) return
        setSelectionError(t('Could not resolve file version.'))
      }
    },
    [onSelect, t]
  )

  useEffect(
    () => () => {
      selectionRevisionRef.current += 1
    },
    []
  )

  // Handle navigation keys at the document level while mounted, since focus stays in the editor.
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
  }, [matches, safeIndex, selectRow, onClose])

  // Split the flat match list back into its two sections, preserving the flat highlight index.
  const uploadMatches = matches.filter((row) => row.tag === 'upload')
  const artifactMatches = matches.filter((row) => row.tag === 'output')

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
        key={`${row.source}:${row.id}`}
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
        <ArtifactFileIcon
          name={row.name}
          mimeType={row.mimeType}
          path={row.path}
          source={row.source}
        />
        <span className="flex min-w-0 flex-1 font-medium">
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
        {size ? <span className="text-xs text-text-300 shrink-0">{size}</span> : null}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground shrink-0">
          {row.tag === 'upload' ? t('upload') : t('output')}
        </span>
      </li>
    )
  }

  return (
    <div className="absolute bottom-full left-0 mb-1 z-50 bg-bg-000 border-0.5 border-border-200 rounded-xl shadow-[0_4px_16px_hsl(var(--always-black)/10%)] p-1.5 min-w-[320px] max-w-[440px] max-h-[min(45vh,18rem)] overflow-hidden">
      {selectionError ? (
        <div role="alert" className="px-2 py-1.5 text-sm text-danger-000">
          {selectionError}
        </div>
      ) : null}
      {matches.length === 0 ? (
        <div
          role={loadState === 'error' ? 'alert' : 'status'}
          aria-live={loadState === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
          className="px-2 py-1.5 text-sm text-text-300"
        >
          {loadState === 'loading'
            ? t('Loading project files…')
            : loadState === 'error'
              ? t('Could not load project files')
              : t('No artifacts yet')}
        </div>
      ) : null}
      <ul
        id={resolvedListboxId}
        role="listbox"
        aria-label={t('Artifact suggestions')}
        className="overflow-y-auto max-h-[min(45vh,18rem)]"
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
      </ul>
      <div className="mt-1 -mx-1.5 -mb-1.5 px-3.5 pt-1.5 pb-2 border-t border-border-300 flex items-center gap-3 text-[11px] text-text-400 select-none">
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
