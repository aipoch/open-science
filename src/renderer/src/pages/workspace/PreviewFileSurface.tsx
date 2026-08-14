import {
  ChevronLeft,
  ChevronRight,
  FileDiff,
  GitBranch,
  Maximize2,
  MoreHorizontal,
  Pencil,
  X
} from 'lucide-react'
import { marked } from 'marked'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import type { ArtifactLineageProvenance } from '../../../../shared/artifact-provenance'
import type {
  ManagedFileVersionDescriptor,
  ManagedFileVersionDiffResult,
  ManagedFileVersionInspectResult
} from '../../../../shared/managed-file-versions'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { LocalFileHeaderActions } from './LocalFileHeaderActions'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import {
  createPreviewFileItemForArtifactVersion,
  createPreviewFileItemForManagedVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { PreviewFileContent } from './previews/PreviewFileContent'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'

type PreviewFileSurfaceProps = {
  item: PreviewFileItem
  contentKey?: string
  renderContent?: boolean
  tooltipClassName?: string
  onClose: () => void
  onOpenFullScreen?: () => void
  onOpenProvenance?: () => void
  onReload?: () => void
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
  leaveGuardScope?: string
  workbenchConnected?: boolean
  onItemChange?: (item: PreviewFileItem) => void
}

type PreviewFileSurfaceHandle = {
  confirmLeave: () => boolean
}

const previewHeaderActionClassName = 'text-text-000 hover:text-text-000'

const PreviewProvenanceButton = ({
  item,
  onOpenProvenance,
  tooltipClassName
}: {
  item: PreviewFileItem
  onOpenProvenance: () => void
  tooltipClassName?: string
}): React.JSX.Element => (
  <TooltipProvider delayDuration={300}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={previewHeaderActionClassName}
          aria-label={`Open Provenance for ${item.title}`}
          onClick={onOpenProvenance}
        >
          <GitBranch aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>Provenance</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

// The optional callback makes the maximize action available only in the compact workbench panel;
// the dialog reuses this header without exposing a nested full-screen action.
const PreviewFileHeader = ({
  item,
  onClose,
  onOpenFullScreen,
  onOpenProvenance,
  onReload,
  provenanceEntry = 'menu',
  tooltipClassName,
  managedControls,
  managedControlsOnly = false
}: Pick<
  PreviewFileSurfaceProps,
  | 'item'
  | 'onClose'
  | 'onOpenFullScreen'
  | 'onOpenProvenance'
  | 'onReload'
  | 'provenanceEntry'
  | 'tooltipClassName'
> & {
  managedControls?: React.ReactNode
  managedControlsOnly?: boolean
}): React.JSX.Element => (
  <header
    data-testid="preview-card-header"
    className={`flex shrink-0 items-center gap-1 border-b border-border-300/50 px-2 ${
      // The local header carries the file path on a second line, so it grows past one row.
      item.source === 'local' ? 'min-h-8 py-0.5' : 'h-8'
    }`}
  >
    {!managedControlsOnly && onOpenProvenance && provenanceEntry === 'leading' ? (
      <PreviewProvenanceButton
        item={item}
        onOpenProvenance={onOpenProvenance}
        tooltipClassName={tooltipClassName}
      />
    ) : null}
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 text-[12px] font-medium text-text-000">
            <ExtensionPreservingFileName name={item.name} className="flex-1" />
            {item.source === 'local' ? (
              <span
                data-testid="local-file-path"
                className="flex min-w-0 items-center gap-1 text-[10px] font-normal leading-tight text-text-100"
              >
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-px">This computer</span>
                <span className="truncate">{item.path}</span>
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent className={tooltipClassName}>
          {item.source === 'local' ? item.path : item.title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    {/* A local file has no managed provenance or origin Session, so it takes the reload/copy/open
        actions in place of the whole managed action row. */}
    {item.source === 'local' ? (
      <LocalFileHeaderActions
        path={item.path}
        name={item.name}
        onReload={onReload}
        tooltipClassName={tooltipClassName}
      />
    ) : (
      <>
        {managedControls}
        {!managedControlsOnly ? (
          <>
            {onOpenProvenance && provenanceEntry === 'trailing' ? (
              <PreviewProvenanceButton
                item={item}
                onOpenProvenance={onOpenProvenance}
                tooltipClassName={tooltipClassName}
              />
            ) : null}
            <ManagedFileDownloadButton
              source={item.source ?? 'artifact'}
              path={item.path}
              {...(item.projectId && item.managedFileId
                ? {
                    projectId: item.projectId,
                    fileId: item.managedFileId,
                    ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {})
                  }
                : {})}
              suggestedName={item.name}
              tone="strong"
              className="bg-transparent shadow-none"
            />
            {item.originSession?.state === 'deleted' ? (
              <span
                data-testid="deleted-origin-session"
                className="shrink-0 rounded bg-warning-100 px-1.5 py-0.5 text-[10px] text-warning-900"
              >
                Source session deleted
              </span>
            ) : null}
            {onOpenProvenance && provenanceEntry === 'menu' ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={previewHeaderActionClassName}
                    aria-label={`File actions for ${item.title}`}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[70] min-w-36">
                  <DropdownMenuItem onSelect={onOpenProvenance}>
                    <GitBranch className="mr-2 size-4" aria-hidden="true" />
                    Provenance
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        ) : null}
      </>
    )}
    {!managedControlsOnly && onOpenFullScreen ? (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={previewHeaderActionClassName}
              aria-label={`Open full screen preview of ${item.title}`}
              onClick={onOpenFullScreen}
            >
              <Maximize2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {`Open full screen preview of ${item.title}`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : null}
    {!managedControlsOnly ? (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={previewHeaderActionClassName}
              aria-label={`Close preview of ${item.title}`}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {`Close preview of ${item.title}`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : null}
  </header>
)

const ArtifactVersionNavigation = ({
  lineage,
  selectedVersionId,
  onSelect
}: {
  lineage: ArtifactLineageProvenance
  selectedVersionId: string | undefined
  onSelect: (versionId: string) => void
}): React.JSX.Element | null => {
  const selectedIndex = lineage.versions.findIndex(
    (version) => version.versionId === selectedVersionId
  )
  if (selectedIndex < 0) return null

  return (
    <div
      data-testid="artifact-preview-version-navigation"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous Artifact version"
        disabled={selectedIndex <= 0}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex - 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="text-xs font-medium text-text-100">
        v{lineage.versions[selectedIndex]?.versionNumber}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next Artifact version"
        disabled={selectedIndex >= lineage.versions.length - 1}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex + 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
}

const ManagedVersionNavigation = ({
  inspect,
  onSelect
}: {
  inspect: ManagedFileVersionInspectResult
  onSelect: (versionId: string) => void
}): React.JSX.Element => {
  const selectedIndex = inspect.versions.findIndex(
    (version) => version.id === inspect.selectedVersionId
  )
  return (
    <div
      data-testid="managed-preview-version-navigation"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous file version"
        disabled={selectedIndex <= 0}
        onClick={() => {
          const id = inspect.versions[selectedIndex - 1]?.id
          if (id) onSelect(id)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="min-w-8 text-center text-xs font-medium text-text-100">
        v{inspect.versions[selectedIndex]?.versionNumber}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next file version"
        disabled={selectedIndex >= inspect.versions.length - 1}
        onClick={() => {
          const id = inspect.versions[selectedIndex + 1]?.id
          if (id) onSelect(id)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
}

const isSimpleMarkdownText = (content: string): boolean => {
  const trimmed = content.trimStart()
  return !(
    /^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|~~~|\|)/.test(trimmed) ||
    /(?:!\[|\[[^\]]*\]\(|<[^>]+>|`|\*\*|__|~~|\|)/.test(content)
  )
}

const diffLineText = (line: ManagedFileVersionDiffResult['lines'][number]): string =>
  line.segments.map((segment) => segment.text).join('')

type IndexedDiffLine = {
  index: number
  line: ManagedFileVersionDiffResult['lines'][number]
}

type DiffRange = { start: number; end: number }

const isComplexMarkdownToken = (type: string, raw: string): boolean =>
  type !== 'space' &&
  (type !== 'paragraph' || raw.split('\n').some((line) => !isSimpleMarkdownText(line)))

const lineIndexAtOffset = (lineStarts: number[], offset: number): number => {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (lineStarts[middle]! <= offset) low = middle + 1
    else high = middle
  }
  return low - 1
}

const markdownSemanticRanges = (
  entries: IndexedDiffLine[],
  changedKind: 'added' | 'removed'
): DiffRange[] => {
  if (entries.length === 0) return []

  const source = entries.map(({ line }) => diffLineText(line)).join('\n')
  let tokens: ReturnType<typeof marked.lexer>
  try {
    tokens = marked.lexer(source)
  } catch {
    return []
  }

  const lineStarts: number[] = []
  let lineStart = 0
  for (const entry of entries) {
    lineStarts.push(lineStart)
    lineStart += diffLineText(entry.line).length + 1
  }

  const ranges: DiffRange[] = []
  let tokenStart = 0
  for (const token of tokens) {
    const tokenEnd = tokenStart + token.raw.length
    const contentEnd = tokenStart + token.raw.replace(/(?:\r?\n[ \t]*)+$/u, '').length
    if (isComplexMarkdownToken(token.type, token.raw) && contentEnd > tokenStart) {
      const start = lineIndexAtOffset(lineStarts, tokenStart)
      const end = lineIndexAtOffset(lineStarts, contentEnd - 1)
      if (
        start >= 0 &&
        end >= start &&
        entries.slice(start, end + 1).some(({ line }) => line.kind === changedKind)
      ) {
        ranges.push({ start: entries[start]!.index, end: entries[end]!.index })
      }
    }
    tokenStart = tokenEnd
  }
  return ranges
}

const mergeDiffRanges = (ranges: DiffRange[]): DiffRange[] => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: DiffRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

type DiffRenderBlock =
  | { kind: 'line'; line: ManagedFileVersionDiffResult['lines'][number]; index: number }
  | {
      kind: 'markdown'
      changeKind: 'added' | 'removed'
      lines: ManagedFileVersionDiffResult['lines']
      startIndex: number
    }

const toDiffRenderBlocks = (
  result: ManagedFileVersionDiffResult,
  markdown: boolean
): DiffRenderBlock[] => {
  if (markdown) {
    const before = result.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind !== 'added')
    const after = result.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind !== 'removed')
    const complexChangedRanges = result.lines.flatMap((line, index) =>
      line.kind !== 'context' && !isSimpleMarkdownText(diffLineText(line))
        ? [{ start: index, end: index }]
        : []
    )
    const markdownRanges = mergeDiffRanges([
      ...markdownSemanticRanges(before, 'removed'),
      ...markdownSemanticRanges(after, 'added'),
      ...complexChangedRanges
    ])
    if (markdownRanges.length > 0) {
      const blocks: DiffRenderBlock[] = []
      let rangeIndex = 0
      for (let index = 0; index < result.lines.length; index += 1) {
        const range = markdownRanges[rangeIndex]
        if (!range || index < range.start) {
          blocks.push({ kind: 'line', line: result.lines[index]!, index })
          continue
        }
        if (index > range.end) {
          rangeIndex += 1
          index -= 1
          continue
        }
        const lines = result.lines.slice(range.start, range.end + 1)
        const removed = lines.filter((line) => line.kind !== 'added')
        const added = lines.filter((line) => line.kind !== 'removed')
        if (removed.some((line) => line.kind === 'removed')) {
          blocks.push({
            kind: 'markdown',
            changeKind: 'removed',
            lines: removed,
            startIndex: range.start
          })
        }
        if (added.some((line) => line.kind === 'added')) {
          blocks.push({
            kind: 'markdown',
            changeKind: 'added',
            lines: added,
            startIndex: range.start
          })
        }
        index = range.end
        rangeIndex += 1
      }
      return blocks
    }
  }
  const blocks: DiffRenderBlock[] = []
  for (let index = 0; index < result.lines.length; index += 1) {
    const line = result.lines[index]
    if (markdown && line.kind !== 'context') {
      const lines = [line]
      while (index + 1 < result.lines.length && result.lines[index + 1]?.kind === line.kind) {
        lines.push(result.lines[index + 1])
        index += 1
      }
      const startIndex = index - lines.length + 1
      if (
        lines.some(
          (candidate) =>
            !isSimpleMarkdownText(candidate.segments.map((segment) => segment.text).join(''))
        )
      ) {
        blocks.push({ kind: 'markdown', changeKind: line.kind, lines, startIndex })
      } else {
        lines.forEach((candidate, offset) =>
          blocks.push({ kind: 'line', line: candidate, index: startIndex + offset })
        )
      }
      continue
    }
    blocks.push({ kind: 'line', line, index })
  }
  return blocks
}

const DiffContent = ({
  result,
  markdown
}: {
  result: ManagedFileVersionDiffResult
  markdown: boolean
}): React.JSX.Element => (
  <div
    className="min-h-full bg-bg-000 py-2 font-mono text-xs text-text-000"
    role="region"
    aria-label="File version differences"
  >
    {toDiffRenderBlocks(result, markdown).map((block) => {
      if (block.kind === 'markdown') {
        const tone =
          block.changeKind === 'added' ? 'bg-diff-added-surface' : 'bg-diff-removed-surface'
        const markerTone =
          block.changeKind === 'added'
            ? 'text-diff-added-foreground'
            : 'text-diff-removed-foreground'
        const marker = block.changeKind === 'added' ? '+' : '-'
        const content = block.lines
          .map((line) => line.segments.map((segment) => segment.text).join(''))
          .join('\n')
        return (
          <div
            key={`markdown:${block.startIndex}:${block.changeKind}`}
            className={`grid min-h-6 grid-cols-[2rem_3rem_3rem_minmax(0,1fr)] items-start ${tone}`}
            data-diff-kind={block.changeKind}
          >
            <span className={`px-2 text-center ${markerTone}`}>{marker}</span>
            <span className={`text-right ${markerTone}`}>
              {block.changeKind === 'removed' ? block.lines[0]?.oldLineNumber : ''}
            </span>
            <span className={`pr-2 text-right ${markerTone}`}>
              {block.changeKind === 'added' ? block.lines[0]?.newLineNumber : ''}
            </span>
            <div className="min-w-0 font-sans">
              <AgentMarkdown content={content} allowMedia={false} />
            </div>
          </div>
        )
      }
      const { line, index } = block
      const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '
      const tone =
        line.kind === 'added'
          ? 'bg-diff-added-surface'
          : line.kind === 'removed'
            ? 'bg-diff-removed-surface'
            : ''
      const markerTone =
        line.kind === 'added'
          ? 'text-diff-added-foreground'
          : line.kind === 'removed'
            ? 'text-diff-removed-foreground'
            : 'text-text-300'
      return (
        <div
          key={`${index}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}`}
          className={`grid min-h-6 grid-cols-[2rem_3rem_3rem_minmax(0,1fr)] items-start ${tone}`}
          data-diff-kind={line.kind}
        >
          <span
            className={`px-2 text-center ${markerTone}`}
            aria-label={
              line.kind === 'added'
                ? 'Added line'
                : line.kind === 'removed'
                  ? 'Removed line'
                  : 'Unchanged line'
            }
          >
            {marker}
          </span>
          <span className={`text-right ${markerTone}`}>{line.oldLineNumber ?? ''}</span>
          <span className={`pr-2 text-right ${markerTone}`}>{line.newLineNumber ?? ''}</span>
          <pre
            className={`min-w-0 whitespace-pre-wrap break-words ${markdown ? 'font-sans' : 'font-mono'}`}
            {...(markdown && line.kind !== 'context' ? { 'data-diff-inline': 'true' } : {})}
          >
            {line.segments.map((segment, segmentIndex) => (
              <span
                key={segmentIndex}
                data-diff-segment={segment.kind}
                className={
                  segment.kind === 'added'
                    ? 'bg-diff-added-highlight text-text-000'
                    : segment.kind === 'removed'
                      ? 'bg-diff-removed-highlight text-text-000 line-through'
                      : undefined
                }
              >
                {segment.text}
              </span>
            ))}
          </pre>
        </div>
      )
    })}
  </div>
)

// The content slot is shared by both presentations so every supported file type follows the same
// renderer path. Callers can temporarily suppress it while another surface owns the preview.
const PreviewFileSurface = forwardRef<PreviewFileSurfaceHandle, PreviewFileSurfaceProps>(
  (
    {
      item,
      contentKey,
      renderContent = true,
      tooltipClassName,
      onClose,
      onOpenFullScreen,
      provenanceEntry = 'menu',
      leaveGuardScope,
      workbenchConnected = false,
      onItemChange
    },
    ref
  ): React.JSX.Element => {
    const [provenanceTarget, setProvenanceTarget] = useState<string>()
    // Bumping this token remounts the content tree so a local file is re-read from disk.
    const [reloadToken, setReloadToken] = useState(0)
    const [versionOverride, setVersionOverride] = useState<{
      key: string
      item: PreviewFileItem
    }>()
    const [lineageResult, setLineageResult] = useState<{
      key: string
      value?: ArtifactLineageProvenance
    }>()
    const [managedInspectResult, setManagedInspectResult] = useState<{
      key: string
      value: ManagedFileVersionInspectResult
    }>()
    const [managedRefresh, setManagedRefresh] = useState(0)
    const [mode, setMode] = useState<'view' | 'edit' | 'diff'>('view')
    const [draft, setDraft] = useState('')
    const [editBaseline, setEditBaseline] = useState<{
      text: string
      expectedHeadVersionId: string
    }>()
    const [saving, setSaving] = useState(false)
    const [editError, setEditError] = useState<string>()
    const [conflictHead, setConflictHead] = useState<ManagedFileVersionDescriptor>()
    const [diffResult, setDiffResult] = useState<ManagedFileVersionDiffResult>()
    const [diffError, setDiffError] = useState<string>()
    const activeDiffRequestId = useRef<string | undefined>(undefined)
    const saveGenerationRef = useRef(0)
    const acceptedIdentityTransitionRef = useRef<string | undefined>(undefined)
    const activeProjectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
    const storedItem = usePreviewWorkbenchStore((state) =>
      workbenchConnected
        ? state.items.find(
            (candidate) =>
              candidate.type === 'file' &&
              candidate.id === item.id &&
              candidate.projectId === (item.projectId ?? activeProjectId)
          )
        : undefined
    )
    const sourceItem = storedItem?.type === 'file' ? storedItem : item
    const itemIdentityKey = `${sourceItem.projectId ?? ''}:${sourceItem.source ?? 'artifact'}:${sourceItem.id}:${sourceItem.managedFileId ?? ''}:${sourceItem.artifactId ?? ''}:${sourceItem.selectedVersionId ?? ''}:${sourceItem.path}`
    const previewItem = versionOverride?.key === itemIdentityKey ? versionOverride.item : sourceItem
    const projectId = previewItem.projectId ?? activeProjectId
    const surfaceKey = item.id
    const showProvenance = provenanceTarget === surfaceKey
    const lineageKey = `${projectId ?? ''}:${previewItem.sessionId}:${previewItem.artifactId ?? ''}`
    // Finalization increments the owning Session's filesRevision even when this already-open preview
    // remains on an older Version. Include it in the request identity so the version navigator learns
    // about newly finalized Versions without forcing the user's current selection to change.
    const sessionFilesRevision = useSessionStore(
      (state) =>
        state.sessions.find((session) => session.id === previewItem.sessionId)?.filesRevision ?? 0
    )
    // A GENERATED-card click updates selectedVersionId on the stable preview tab. Refetch even when the
    // Artifact identity is unchanged; the cached lineage may predate that immutable Version.
    const lineageRequestKey = `${lineageKey}:${sessionFilesRevision}:${previewItem.selectedVersionId ?? ''}`
    const lineage = lineageResult?.key === lineageKey ? lineageResult.value : undefined
    const exactSelectedVersion = lineage?.versions.find(
      (version) => version.versionId === previewItem.selectedVersionId
    )
    const newestLoadedVersion = lineage?.versions.at(-1)
    const selectionIsNewerThanLoadedLineage =
      typeof previewItem.versionNumber === 'number' &&
      typeof newestLoadedVersion?.versionNumber === 'number' &&
      previewItem.versionNumber > newestLoadedVersion.versionNumber
    const selectedVersion =
      exactSelectedVersion ??
      (lineage && !previewItem.managedFileId && !selectionIsNewerThanLoadedLineage
        ? resolveArtifactVersionDescriptor(lineage, previewItem.selectedVersionId)
        : undefined)
    const selectedVersionId = selectedVersion?.versionId ?? previewItem.selectedVersionId
    const resolvedPreviewItem =
      selectedVersion && projectId
        ? createPreviewFileItemForArtifactVersion({
            item: previewItem,
            version: selectedVersion,
            projectId
          })
        : previewItem
    const managedSource: 'artifact' | 'upload' =
      previewItem.source === 'upload' ? 'upload' : 'artifact'
    const managedIdentity = useMemo(
      () =>
        projectId && previewItem.managedFileId
          ? { source: managedSource, projectId, fileId: previewItem.managedFileId }
          : undefined,
      [managedSource, previewItem.managedFileId, projectId]
    )
    const managedRequestKey = managedIdentity
      ? `${managedIdentity.source}:${managedIdentity.projectId}:${managedIdentity.fileId}:${previewItem.selectedVersionId ?? ''}:${managedRefresh}`
      : undefined
    const managedInspect =
      managedInspectResult && managedInspectResult.key === managedRequestKey
        ? managedInspectResult.value
        : undefined
    const previousManagedInspect =
      managedIdentity &&
      managedInspectResult?.value.source === managedIdentity.source &&
      managedInspectResult.value.projectId === managedIdentity.projectId &&
      managedInspectResult.value.fileId === managedIdentity.fileId
        ? managedInspectResult.value
        : undefined
    const managedNavigationInspect =
      managedInspect ??
      (previousManagedInspect &&
      previewItem.selectedVersionId &&
      previousManagedInspect.versions.some(
        (version) => version.id === previewItem.selectedVersionId
      )
        ? { ...previousManagedInspect, selectedVersionId: previewItem.selectedVersionId }
        : undefined)
    const isDirty = mode === 'edit' && editBaseline !== undefined && draft !== editBaseline.text
    const invalidateSave = (): void => {
      saveGenerationRef.current += 1
      setSaving(false)
    }

    const confirmLeave = useCallback(
      (): boolean => !isDirty || window.confirm('Discard unsaved changes?'),
      [isDirty]
    )
    useImperativeHandle(ref, () => ({ confirmLeave }), [confirmLeave])

    useEffect(
      () =>
        leaveGuardScope ? previewLeaveGuards.register(leaveGuardScope, confirmLeave) : undefined,
      [confirmLeave, leaveGuardScope]
    )

    useEffect(() => {
      if (acceptedIdentityTransitionRef.current === itemIdentityKey) {
        acceptedIdentityTransitionRef.current = undefined
        return
      }
      const generation = ++saveGenerationRef.current
      setMode('view')
      setDraft('')
      setEditBaseline(undefined)
      setEditError(undefined)
      setConflictHead(undefined)
      setSaving(false)
      return () => {
        if (saveGenerationRef.current === generation) saveGenerationRef.current += 1
      }
    }, [itemIdentityKey])

    useEffect(() => {
      let active = true
      const managedFileVersions = window.api.managedFileVersions
      if (
        !managedIdentity ||
        !managedRequestKey ||
        typeof managedFileVersions.inspect !== 'function'
      )
        return
      const leaveDiffMode = (): void => {
        setMode((current) => (current === 'diff' ? 'view' : current))
        setDiffResult(undefined)
        setDiffError(undefined)
      }
      void managedFileVersions
        .inspect({
          ...managedIdentity,
          ...(previewItem.selectedVersionId ? { versionId: previewItem.selectedVersionId } : {})
        })
        .then((result) => {
          if (!active) return
          if (!result.ok) {
            leaveDiffMode()
            return
          }
          setManagedInspectResult({ key: managedRequestKey, value: result.value })
          if (!result.value.canDiff) leaveDiffMode()
        })
        .catch(() => {
          if (active) leaveDiffMode()
        })
      return () => {
        active = false
      }
    }, [managedIdentity, managedRequestKey, previewItem.selectedVersionId])

    useEffect(() => {
      let active = true
      if (!projectId || !previewItem.artifactId || previewItem.source === 'upload') return

      void window.api.artifacts
        .getLineage({
          projectId,
          appSessionId: previewItem.sessionId,
          artifactId: previewItem.artifactId
        })
        .then((value) => {
          if (active) setLineageResult({ key: lineageKey, value })
        })
        .catch(() => undefined)

      return () => {
        active = false
      }
    }, [
      lineageKey,
      lineageRequestKey,
      previewItem.artifactId,
      previewItem.sessionId,
      previewItem.source,
      projectId
    ])

    const applyVersionItem = (nextItem: PreviewFileItem, skipWorkbenchGuard = false): boolean => {
      const nextIdentityKey = `${nextItem.projectId ?? ''}:${nextItem.source ?? 'artifact'}:${nextItem.id}:${nextItem.managedFileId ?? ''}:${nextItem.artifactId ?? ''}:${nextItem.selectedVersionId ?? ''}:${nextItem.path}`
      if (workbenchConnected) {
        acceptedIdentityTransitionRef.current = nextIdentityKey
        if (!usePreviewWorkbenchStore.getState().upsertItem(nextItem, skipWorkbenchGuard)) {
          acceptedIdentityTransitionRef.current = undefined
          return false
        }
      } else {
        if (!skipWorkbenchGuard && !confirmLeave()) return false
        if (onItemChange) acceptedIdentityTransitionRef.current = nextIdentityKey
        onItemChange?.(nextItem)
        // Uncontrolled surfaces own their local selection; controlled Dialogs publish through
        // onItemChange and must not retain an origin-keyed override that can become stale.
        if (!onItemChange) setVersionOverride({ key: itemIdentityKey, item: nextItem })
      }
      return true
    }

    const selectPreviewVersion = (versionId: string): void => {
      if (!lineage || !projectId) return
      const version = lineage.versions.find((candidate) => candidate.versionId === versionId)
      if (!version) return

      applyVersionItem(
        createPreviewFileItemForArtifactVersion({ item: previewItem, version, projectId })
      )
    }

    const selectProvenanceVersion = (nextItem: PreviewFileItem): boolean => {
      if (!applyVersionItem(nextItem)) return false
      invalidateSave()
      if (activeDiffRequestId.current) {
        void window.api.managedFileVersions.cancelDiff({ requestId: activeDiffRequestId.current })
        activeDiffRequestId.current = undefined
      }
      setMode('view')
      setDraft('')
      setEditBaseline(undefined)
      setDiffResult(undefined)
      setDiffError(undefined)
      return true
    }

    const selectManagedVersion = (versionId: string): void => {
      if (!managedNavigationInspect || !projectId) return
      const version = managedNavigationInspect.versions.find(
        (candidate) => candidate.id === versionId
      )
      if (!version) return
      const nextItem = createPreviewFileItemForManagedVersion({
        item: previewItem,
        version,
        projectId,
        sessionId: managedNavigationInspect.sessionId
      })
      if (!applyVersionItem(nextItem)) return
      invalidateSave()
      if (activeDiffRequestId.current) {
        void window.api.managedFileVersions.cancelDiff({ requestId: activeDiffRequestId.current })
        activeDiffRequestId.current = undefined
      }
      setMode(mode === 'diff' && version.basedOnVersionId ? 'diff' : 'view')
      setDiffResult(undefined)
      setDiffError(undefined)
    }

    const beginEdit = (): void => {
      if (!managedInspect?.canEdit || managedInspect.text === undefined) return
      setDraft(managedInspect.text)
      setEditBaseline({
        text: managedInspect.text,
        expectedHeadVersionId: managedInspect.headVersionId
      })
      setEditError(undefined)
      setConflictHead(undefined)
      setMode('edit')
    }

    const saveEdit = async (): Promise<void> => {
      if (
        !managedIdentity ||
        !managedInspect ||
        !editBaseline ||
        draft === editBaseline.text ||
        saving
      )
        return
      setSaving(true)
      setEditError(undefined)
      const saveGeneration = saveGenerationRef.current
      let result
      try {
        result = await window.api.managedFileVersions.saveTextEdit({
          ...managedIdentity,
          basedOnVersionId: managedInspect.selectedVersionId,
          expectedHeadVersionId: editBaseline.expectedHeadVersionId,
          content: draft,
          operationId: crypto.randomUUID()
        })
      } catch {
        if (saveGenerationRef.current !== saveGeneration) return
        setSaving(false)
        setEditError('Changes could not be saved.')
        return
      }
      if (saveGenerationRef.current !== saveGeneration) return
      setSaving(false)
      if (!result.ok) {
        setEditError(result.error.message)
        return
      }
      if (result.value.kind === 'conflict') {
        setConflictHead(result.value.actualHead)
        setEditError('This file has a newer version.')
        return
      }
      setMode('view')
      setEditBaseline(undefined)
      setDraft('')
      if (result.value.kind === 'created' && projectId) {
        applyVersionItem(
          createPreviewFileItemForManagedVersion({
            item: previewItem,
            version: result.value.version,
            projectId,
            sessionId: managedInspect.sessionId
          }),
          true
        )
      }
      setManagedRefresh((value) => value + 1)
    }

    const toggleDiff = (): void => {
      if (!managedIdentity || !managedInspect?.canDiff) return
      if (mode === 'diff') {
        setMode('view')
        setDiffResult(undefined)
        setDiffError(undefined)
        return
      }
      if (!confirmLeave()) return
      invalidateSave()
      setDiffResult(undefined)
      setDiffError(undefined)
      setMode('diff')
    }

    useEffect(() => {
      if (mode !== 'diff' || !managedIdentity || !managedInspect?.canDiff) return
      const requestId = crypto.randomUUID()
      activeDiffRequestId.current = requestId
      void window.api.managedFileVersions
        .diffText({ ...managedIdentity, versionId: managedInspect.selectedVersionId, requestId })
        .then((result) => {
          if (activeDiffRequestId.current !== requestId) return
          activeDiffRequestId.current = undefined
          if (result.ok) setDiffResult(result.value)
          else if (result.error.code !== 'DIFF_CANCELLED') setDiffError(result.error.message)
        })
        .catch(() => {
          if (activeDiffRequestId.current === requestId) setDiffError('Diff could not be loaded.')
        })
      return () => {
        if (activeDiffRequestId.current !== requestId) return
        activeDiffRequestId.current = undefined
        void window.api.managedFileVersions.cancelDiff({ requestId })
      }
    }, [managedIdentity, managedInspect?.canDiff, managedInspect?.selectedVersionId, mode])

    return (
      <div className="flex size-full min-h-0 flex-col overflow-hidden">
        <PreviewFileHeader
          item={resolvedPreviewItem}
          onClose={() => {
            if (workbenchConnected || confirmLeave()) {
              invalidateSave()
              onClose()
            }
          }}
          onOpenFullScreen={onOpenFullScreen}
          onReload={() => setReloadToken((token) => token + 1)}
          provenanceEntry={provenanceEntry}
          onOpenProvenance={
            previewItem.source !== 'upload' && previewItem.artifactId && projectId
              ? () => setProvenanceTarget(surfaceKey)
              : undefined
          }
          tooltipClassName={tooltipClassName}
          managedControlsOnly={mode === 'edit'}
          managedControls={
            managedInspect ? (
              mode === 'edit' ? (
                <div className="flex h-7 shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-text-000 hover:text-text-000"
                    onClick={() => {
                      if (confirmLeave()) {
                        invalidateSave()
                        setMode('view')
                        setDraft('')
                        setEditBaseline(undefined)
                      }
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    aria-label="Save changes"
                    disabled={!isDirty || saving}
                    onClick={() => void saveEdit()}
                  >
                    Save
                  </Button>
                </div>
              ) : (
                <>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className={previewHeaderActionClassName}
                          aria-label={`Edit ${resolvedPreviewItem.name}`}
                          disabled={!managedInspect.canEdit}
                          onClick={beginEdit}
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className={tooltipClassName}>Edit content</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant={mode === 'diff' ? 'default' : 'ghost'}
                          size="icon-xs"
                          className={mode === 'diff' ? undefined : previewHeaderActionClassName}
                          aria-label={
                            mode === 'diff'
                              ? `Stop comparing ${resolvedPreviewItem.name}`
                              : `Compare ${resolvedPreviewItem.name} with its source version`
                          }
                          disabled={!managedInspect.canDiff}
                          onClick={toggleDiff}
                        >
                          <FileDiff aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className={tooltipClassName}>
                        {managedInspect.canDiff
                          ? 'Compare with source version'
                          : 'No source version to compare'}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              )
            ) : undefined
          }
        />
        {!showProvenance && managedNavigationInspect ? (
          <ManagedVersionNavigation
            inspect={managedNavigationInspect}
            onSelect={selectManagedVersion}
          />
        ) : !showProvenance && !managedIdentity && lineage ? (
          <ArtifactVersionNavigation
            lineage={lineage}
            selectedVersionId={selectedVersionId}
            onSelect={selectPreviewVersion}
          />
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-000">
          {showProvenance && projectId ? (
            <ArtifactProvenancePanel
              item={resolvedPreviewItem}
              projectId={projectId}
              onClose={() => setProvenanceTarget(undefined)}
              onVersionChange={selectProvenanceVersion}
            />
          ) : mode === 'edit' ? (
            <div className="flex size-full min-h-0 flex-col">
              <textarea
                autoFocus
                aria-label={`Edit ${resolvedPreviewItem.name} source`}
                className="min-h-0 flex-1 resize-none bg-bg-000 p-4 font-mono text-sm leading-6 text-text-000 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              {editError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between border-t border-border-300 px-3 py-2 text-xs text-destructive"
                >
                  {editError}
                  {conflictHead ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!projectId || !managedInspect) return
                        const nextItem = createPreviewFileItemForManagedVersion({
                          item: previewItem,
                          version: conflictHead,
                          projectId,
                          sessionId: managedInspect.sessionId
                        })
                        if (!applyVersionItem(nextItem)) return
                        invalidateSave()
                        setMode('view')
                        setDraft('')
                        setEditBaseline(undefined)
                      }}
                    >
                      View latest version
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : mode === 'diff' ? (
            diffResult ? (
              <DiffContent
                result={diffResult}
                markdown={resolvedPreviewItem.format === 'markdown'}
              />
            ) : (
              <div className="p-4 text-sm text-text-100">
                {diffError ?? 'Comparing versions...'}
              </div>
            )
          ) : renderContent ? (
            <PreviewFileContent
              key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
              item={resolvedPreviewItem}
            />
          ) : null}
        </div>
      </div>
    )
  }
)

PreviewFileSurface.displayName = 'PreviewFileSurface'

// The pure helper is exported for semantic Markdown diff tests.
// eslint-disable-next-line react-refresh/only-export-components
export { PreviewFileSurface, toDiffRenderBlocks }
export type { PreviewFileSurfaceHandle }
