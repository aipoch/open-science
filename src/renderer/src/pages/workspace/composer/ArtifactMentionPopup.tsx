import { useEffect, useId, useMemo, useState } from 'react'

import { formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'

import { ArtifactFileIcon } from './artifact-file-icon'
import { buildProjectFileLibrary } from '../project-files-library'

// The reference passed back to the composer when an artifact row is picked.
export type PickedArtifact = {
  id: string
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
  onSelect: (ref: PickedArtifact) => void
  onClose: () => void
}

// One suggestion row: a picked artifact plus the display size and its section tag.
type ArtifactRow = PickedArtifact & {
  size?: number
  tag: 'upload' | 'output'
}

// Human-readable section headers, ordered as they render.
const SECTION_UPLOADS = 'User uploads'
const SECTION_ARTIFACTS = 'Other artifacts'

export const ArtifactMentionPopup = ({
  query,
  onSelect,
  onClose
}: ArtifactMentionPopupProps): React.JSX.Element | null => {
  const sessions = useSessionStore((state) => state.sessions)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const listboxId = useId()

  // Derive the project's artifact library the same way the Files panel does: uploads then outputs.
  const rows = useMemo<ArtifactRow[]>(() => {
    const projectSessions = sessions.filter((session) => session.projectId === activeProjectId)
    const library = buildProjectFileLibrary(projectSessions)

    const uploadRows: ArtifactRow[] = library.uploadFiles.map((file) => ({
      id: file.id,
      name: file.name,
      path: file.attachment.path,
      source: 'upload',
      mimeType: file.attachment.mimeType,
      size: file.size,
      tag: 'upload'
    }))

    const artifactRows: ArtifactRow[] = library.artifactGroups.flatMap((group) =>
      group.files.map((file) => ({
        id: file.id,
        name: file.name,
        path: file.artifact.path,
        source: 'artifact',
        mimeType: file.artifact.mimeType,
        size: file.size,
        tag: 'output'
      }))
    )

    return [...uploadRows, ...artifactRows]
  }, [sessions, activeProjectId])

  // Case-insensitive filename match; empty query shows every artifact.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return rows
    return rows.filter((row) => row.name.toLowerCase().includes(needle))
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

  // Handle navigation keys at the document level while mounted, since focus stays in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (matches.length > 0) setActiveIndex((safeIndex - 1 + matches.length) % matches.length)
      } else if (event.key === 'Enter') {
        const active = matches[safeIndex]
        if (active) {
          event.preventDefault()
          onSelect(toPicked(active))
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [matches, safeIndex, onSelect, onClose])

  // Split the flat match list back into its two sections, preserving the flat highlight index.
  const uploadMatches = matches.filter((row) => row.tag === 'upload')
  const artifactMatches = matches.filter((row) => row.tag === 'output')

  const renderRow = (row: ArtifactRow, index: number): React.JSX.Element => {
    const isActive = index === safeIndex
    const size = formatByteSize(row.size)
    return (
      <li
        key={`${row.source}:${row.id}`}
        id={`${listboxId}-option-${index}`}
        role="option"
        aria-selected={isActive}
        onMouseEnter={() => setActiveIndex(index)}
        // Keep the editor focused/caret intact so the mention stays open long enough for the click.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(toPicked(row))}
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
        <span className="flex-1 min-w-0 truncate font-medium">{row.name}</span>
        {size ? <span className="text-xs text-text-300 shrink-0">{size}</span> : null}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground shrink-0">
          {row.tag}
        </span>
      </li>
    )
  }

  return (
    <div className="absolute bottom-full left-0 mb-1 z-50 bg-bg-000 border-0.5 border-border-200 rounded-xl shadow-[0_4px_16px_hsl(var(--always-black)/10%)] p-1.5 min-w-[320px] max-w-[440px] max-h-[min(45vh,18rem)] overflow-hidden">
      {matches.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-text-300">No artifacts yet</div>
      ) : (
        <ul
          id={`${listboxId}-listbox`}
          role="listbox"
          aria-label="Artifact suggestions"
          className="overflow-y-auto max-h-[min(45vh,18rem)]"
        >
          {uploadMatches.length > 0 ? (
            <>
              <li
                aria-hidden="true"
                className="px-2 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-400 select-none"
              >
                {SECTION_UPLOADS}
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
                {SECTION_ARTIFACTS}
              </li>
              {artifactMatches.map((row, index) => renderRow(row, uploadMatches.length + index))}
            </>
          ) : null}
        </ul>
      )}
      <div className="mt-1 -mx-1.5 -mb-1.5 px-3.5 pt-1.5 pb-2 border-t border-border-300 flex items-center gap-3 text-[11px] text-text-400 select-none">
        <span>
          <span className="text-text-300">↑↓</span> navigate
        </span>
        <span>
          <span className="text-text-300">Enter</span> select
        </span>
        <span>
          <span className="text-text-300">Esc</span> close
        </span>
      </div>
    </div>
  )
}

// Narrow a row down to the reference shape handed back to the composer.
const toPicked = (row: ArtifactRow): PickedArtifact => ({
  id: row.id,
  name: row.name,
  path: row.path,
  source: row.source,
  mimeType: row.mimeType,
  versionId: row.versionId
})
