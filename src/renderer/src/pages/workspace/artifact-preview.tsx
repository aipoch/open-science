import type { ChatSession } from '@/stores/session-store'
import { File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText } from 'lucide-react'
import { parse } from 'papaparse'

import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import { getArtifactExtension, getArtifactName, isImageArtifact } from './artifact-preview-utils'
import { getImageMimeTypeForExtension } from './preview-support'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type ArtifactIconKind = 'archive' | 'code' | 'file' | 'image' | 'spreadsheet' | 'text'

const FASTA_COLORS: Record<string, string> = {
  A: '#2166AC',
  C: '#B2182B',
  D: '#EF8A62',
  E: '#EF8A62',
  F: '#2166AC',
  G: '#D1E5F0',
  H: '#67A9CF',
  I: '#2166AC',
  K: '#B2182B',
  L: '#2166AC',
  M: '#2166AC',
  N: '#FDDBC7',
  P: '#D1E5F0',
  Q: '#FDDBC7',
  R: '#B2182B',
  S: '#D1E5F0',
  T: '#D1E5F0',
  V: '#2166AC',
  W: '#2166AC',
  Y: '#67A9CF',
  '-': '#F2F2F2'
}

const TEXT_SKELETON_EXTENSIONS = new Set(['iqtree', 'nwk', 'state', 'tree', 'treefile'])

const getArtifactExtensionLabel = (artifact: MessageArtifact): string =>
  getArtifactExtension(artifact).toUpperCase().slice(0, 6)

// Prefers the artifact's own mime type over guessing from the extension when one is present.
const getImageMimeType = (artifact: MessageArtifact): string => {
  if (artifact.mimeType?.startsWith('image/')) return artifact.mimeType

  return getImageMimeTypeForExtension(getArtifactExtension(artifact))
}

const isCsvArtifact = (artifact: MessageArtifact): boolean => {
  const extension = getArtifactExtension(artifact)
  const mimeType = artifact.mimeType ?? ''

  return extension === 'csv' || extension === 'tsv' || mimeType.includes('csv')
}

const isFastaArtifact = (artifact: MessageArtifact): boolean =>
  ['fa', 'faa', 'fasta', 'fna'].includes(getArtifactExtension(artifact))

const isTextSkeletonArtifact = (artifact: MessageArtifact): boolean =>
  TEXT_SKELETON_EXTENSIONS.has(getArtifactExtension(artifact))

const getArtifactIconKind = (artifact: MessageArtifact): ArtifactIconKind => {
  const mimeType = artifact.mimeType ?? ''
  const extension = getArtifactExtension(artifact)

  if (isImageArtifact(artifact)) return 'image'
  if (mimeType.includes('spreadsheet') || ['csv', 'tsv', 'xls', 'xlsx'].includes(extension)) {
    return 'spreadsheet'
  }
  if (
    mimeType.includes('html') ||
    mimeType.includes('json') ||
    ['css', 'html', 'js', 'json', 'md', 'pdb', 'svg', 'ts', 'tsx', 'xml'].includes(extension)
  ) {
    return 'code'
  }
  if (['7z', 'gz', 'rar', 'tar', 'zip'].includes(extension)) return 'archive'
  if (mimeType.startsWith('text/') || ['pdf', 'txt'].includes(extension)) return 'text'

  return 'file'
}

const ArtifactFileIcon = ({
  className,
  kind
}: {
  className: string
  kind: ArtifactIconKind
}): React.JSX.Element => {
  if (kind === 'archive') return <FileArchive className={className} aria-hidden />
  if (kind === 'code') return <FileCode2 className={className} aria-hidden />
  if (kind === 'image') return <FileImage className={className} aria-hidden />
  if (kind === 'spreadsheet') return <FileSpreadsheet className={className} aria-hidden />
  if (kind === 'text') return <FileText className={className} aria-hidden />

  return <File className={className} aria-hidden />
}

const getPreviewLines = (content: string, maxLines: number): string[] =>
  content
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)

const getPreviewText = (content: string, maxLines: number): string =>
  getPreviewLines(content, maxLines)
    .map((line) => line.trim())
    .join('\n')

const getCsvPreview = (
  artifact: MessageArtifact,
  preview: ArtifactPreviewResult
): { columns: string[]; hiddenColumnCount: number; rowCountLabel: string } => {
  const delimiter = getArtifactExtension(artifact) === 'tsv' ? '\t' : undefined
  const parsed = parse<string[]>(preview.content, {
    delimiter,
    skipEmptyLines: true
  })
  const rows = parsed.data.filter((row): row is string[] => Array.isArray(row))
  const columns = (rows[0] ?? []).map((column) => column.trim()).filter(Boolean)
  const visibleColumnCount = 5
  const dataRows = Math.max(0, rows.length - 1)

  return {
    columns: columns.slice(0, visibleColumnCount),
    hiddenColumnCount: Math.max(0, columns.length - visibleColumnCount),
    rowCountLabel: `${dataRows}${preview.truncated ? '+' : ''} rows · ${columns.length} columns`
  }
}

const CsvPreview = ({
  artifact,
  preview
}: {
  artifact: MessageArtifact
  preview: ArtifactPreviewResult
}): React.JSX.Element => {
  const csvPreview = getCsvPreview(artifact, preview)

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-000 p-2 text-text-000">
      <div className="shrink-0 pb-1 text-[10px] font-medium text-text-300">
        {csvPreview.rowCountLabel}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {csvPreview.columns.map((column) => (
          <div key={column} className="flex items-center gap-1.5 text-[11px]">
            <span className="w-6 shrink-0 font-mono text-[9px] text-text-300">abc</span>
            <span className="truncate text-text-100">{column}</span>
          </div>
        ))}
        {csvPreview.hiddenColumnCount > 0 ? (
          <div className="pl-[30px] text-[10px] text-text-300">
            +{csvPreview.hiddenColumnCount} more
          </div>
        ) : null}
      </div>
    </div>
  )
}

const getFastaRows = (content: string): string[] => {
  const rows: string[] = []
  let currentSequence = ''

  for (const line of content.replace(/\0/g, '').split(/\r?\n/)) {
    const trimmedLine = line.trim()

    if (!trimmedLine) continue

    if (trimmedLine.startsWith('>')) {
      if (currentSequence) rows.push(currentSequence)
      currentSequence = ''
      continue
    }

    currentSequence += trimmedLine.replace(/\s/g, '').toUpperCase()
  }

  if (currentSequence) rows.push(currentSequence)

  if (rows.length > 1) return rows.slice(0, 6)

  return rows[0]?.match(/.{1,8}/g)?.slice(0, 6) ?? []
}

const FastaPreview = ({ preview }: { preview: ArtifactPreviewResult }): React.JSX.Element => {
  const rows = getFastaRows(preview.content)
  const fallbackRows = rows.length > 0 ? rows : ['--------']
  const rowCount = fallbackRows.length
  const columnCount = Math.max(...fallbackRows.map((row) => row.length), 1)
  const cellWidth = 40 / columnCount
  const cellHeight = 40 / rowCount

  return (
    <div
      className="size-full overflow-hidden bg-bg-000"
      data-testid="artifact-fasta-preview"
      aria-hidden
    >
      <svg viewBox="0 0 40 40" className="size-full">
        {fallbackRows.flatMap((row, rowIndex) =>
          Array.from(row.padEnd(columnCount, '-')).map((residue, columnIndex) => (
            <rect
              key={`${rowIndex}-${columnIndex}`}
              x={columnIndex * cellWidth + 0.5}
              y={rowIndex * cellHeight + 0.5}
              width={Math.max(cellWidth - 0.8, 1)}
              height={Math.max(cellHeight - 0.8, 1)}
              rx="0.5"
              fill={FASTA_COLORS[residue] ?? '#D1E5F0'}
            />
          ))
        )}
      </svg>
    </div>
  )
}

const getSkeletonWidths = (content: string): number[] => {
  const source = content || 'generated artifact preview'

  return Array.from({ length: 9 }, (_, index) => {
    const charCode = source.charCodeAt(index % source.length) || 37
    return 13 + (charCode % 22)
  })
}

const TextSkeletonPreview = ({
  preview
}: {
  preview: ArtifactPreviewResult
}): React.JSX.Element => (
  <div
    className="size-full overflow-hidden bg-bg-000"
    data-testid="artifact-skeleton-preview"
    aria-hidden
  >
    <svg viewBox="0 0 40 40" className="size-full">
      <rect x="0" y="0" width="40" height="40" rx="2" className="fill-bg-200" />
      <rect x="4" y="3" width="24" height="2.2" rx="0.5" className="fill-text-300" />
      {getSkeletonWidths(preview.content).map((width, index) => (
        <rect
          key={`${width}-${index}`}
          x="4"
          y={6.5 + index * 3.5}
          width={width}
          height="1.5"
          rx="0.5"
          className="fill-text-300/45"
        />
      ))}
    </svg>
  </div>
)

const FileTypePreview = ({ artifact }: { artifact: MessageArtifact }): React.JSX.Element => {
  const iconClassName = 'size-5 text-text-300'

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 bg-bg-200 text-text-300">
      <ArtifactFileIcon className={iconClassName} kind={getArtifactIconKind(artifact)} />
      <span className="text-[10px] font-semibold text-text-100">
        {getArtifactExtensionLabel(artifact)}
      </span>
    </div>
  )
}

export const ArtifactPreview = ({
  artifact,
  preview
}: {
  artifact: MessageArtifact
  preview?: ArtifactPreviewResult
}): React.JSX.Element => {
  const artifactName = getArtifactName(artifact)

  if (isImageArtifact(artifact)) {
    const mimeType = getImageMimeType(artifact)

    if (!preview || preview.encoding !== 'base64' || preview.truncated || !mimeType) {
      return <FileTypePreview artifact={artifact} />
    }

    return (
      <img
        src={`data:${mimeType};base64,${preview.content}`}
        alt={`Preview of ${artifactName}`}
        className="size-full object-cover object-top"
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    )
  }

  if (preview && isCsvArtifact(artifact)) {
    return <CsvPreview artifact={artifact} preview={preview} />
  }

  if (preview && isFastaArtifact(artifact)) {
    return <FastaPreview preview={preview} />
  }

  if (preview && isTextSkeletonArtifact(artifact)) {
    return <TextSkeletonPreview preview={preview} />
  }

  if (preview) {
    const previewText = getPreviewText(preview.content, 4)

    return (
      <div className="size-full overflow-hidden bg-bg-000 px-2 py-1.5">
        {previewText ? (
          <pre className="m-0 line-clamp-4 whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.15] text-text-100">
            {previewText}
          </pre>
        ) : (
          <span className="text-[11px] font-semibold text-text-100">
            {getArtifactExtensionLabel(artifact)}
          </span>
        )}
      </div>
    )
  }

  return <FileTypePreview artifact={artifact} />
}
