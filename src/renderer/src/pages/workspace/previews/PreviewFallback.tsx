import { FileWarning, FileX, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { PreviewFileFormat, PreviewFileSource } from '@/stores/preview-workbench-store'

import { ManagedFileDownloadButton } from '../ManagedFileDownloadButton'
import { getFileExtension } from '../preview-support'
import {
  FILE_MISSING_MESSAGE,
  FILE_OUTSIDE_STORAGE_MESSAGE,
  isMissingFileError,
  isOutsideStorageError
} from './preview-errors'
import { usePreviewRuntime } from './preview-runtime-context'

type PreviewFormatPresentation = {
  badge: string
  loadingTitle: string
}

const FORMAT_LOADING_TITLES: Record<PreviewFileFormat, string> = {
  csv: 'Preparing data',
  fasta: 'Preparing sequence',
  html: 'Preparing document',
  image: 'Preparing image',
  json: 'Preparing data',
  markdown: 'Preparing document',
  molecule: 'Preparing structure',
  pdb: 'Preparing structure',
  pdf: 'Preparing document',
  presentation: 'Preparing presentation',
  spreadsheet: 'Preparing spreadsheet',
  text: 'Preparing text file',
  unknown: 'Preparing preview',
  word: 'Preparing document'
}

const FORMAT_BADGES: Record<PreviewFileFormat, string> = {
  csv: 'CSV',
  fasta: 'FASTA',
  html: 'HTML',
  image: 'IMG',
  json: 'JSON',
  markdown: 'MD',
  molecule: 'MOL',
  pdb: 'PDB',
  pdf: 'PDF',
  presentation: 'PPTX',
  spreadsheet: 'XLSX',
  text: 'TXT',
  unknown: 'FILE',
  word: 'DOCX'
}

// Keeps status copy format-aware while preferring the exact extension users recognize.
const getFormatPresentation = (
  format: PreviewFileFormat | undefined,
  name: string | undefined
): PreviewFormatPresentation => {
  const extension = name ? getFileExtension(name) : ''
  const badge = extension ? extension.toUpperCase().slice(0, 5) : FORMAT_BADGES[format ?? 'unknown']

  return {
    badge,
    loadingTitle: FORMAT_LOADING_TITLES[format ?? 'unknown']
  }
}

const PreviewActivityDots = (): React.JSX.Element => (
  <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
    {[0, 150, 300].map((delay) => (
      <span
        key={delay}
        data-preview-activity-dot
        className="size-1 animate-pulse rounded-full bg-primary/70 motion-reduce:animate-none"
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
  </span>
)

const PreviewFormatTile = ({ badge }: { badge: string }): React.JSX.Element => (
  <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/15 bg-bg-000 text-[9px] font-semibold text-primary">
    {badge}
  </div>
)

export const PreviewLoadingContent = ({
  compact = false,
  title,
  description
}: {
  compact?: boolean
  title?: string
  description?: string
} = {}): React.JSX.Element => {
  const runtime = usePreviewRuntime()
  const presentation = getFormatPresentation(runtime?.item.format, runtime?.item.name)
  const loadingTitle = title ?? presentation.loadingTitle
  const loadingDescription = description ?? runtime?.item.name

  if (compact) {
    return (
      <div
        data-preview-status="compact-loading"
        className="flex size-full items-center justify-center"
        role="status"
        aria-label="Rendering preview"
      >
        <PreviewActivityDots />
      </div>
    )
  }

  return (
    <div
      data-preview-status="loading"
      className="flex size-full items-center justify-center px-6 py-8"
      role="status"
      aria-live="polite"
    >
      <div className="grid w-full max-w-[19rem] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3">
        <PreviewFormatTile badge={presentation.badge} />
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-text-000">{loadingTitle}</div>
          {loadingDescription ? (
            <div className="mt-0.5 truncate text-[10px] text-text-300" title={loadingDescription}>
              {loadingDescription}
            </div>
          ) : null}
        </div>
        <PreviewActivityDots />
        <div
          data-preview-progress
          className="col-span-full mt-3 h-0.5 overflow-hidden rounded-full bg-bg-400"
          aria-hidden="true"
        >
          <div className="install-progress-indeterminate h-full w-[38%] rounded-full bg-primary/75 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  )
}

export const PreviewFallbackCard = ({
  icon: Icon,
  name,
  title = 'Preview unavailable',
  message,
  retryable = false,
  action
}: {
  icon: LucideIcon
  name: string
  title?: string
  message: string
  retryable?: boolean
  action?: React.ReactNode
}): React.JSX.Element => {
  const runtime = usePreviewRuntime()

  return (
    <div
      data-preview-status="error"
      className="flex size-full items-center justify-center px-6 py-8"
    >
      <div className="grid w-full max-w-[19rem] grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3">
        <div className="grid size-9 place-items-center rounded-lg border border-danger-000/15 bg-danger-900/45 text-danger-000">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 pt-px">
          <div className="text-[12px] font-medium text-text-000">{title}</div>
          <p className="mt-0.5 text-[10px] leading-4 text-text-300">{message}</p>
          {retryable && runtime ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={runtime.retry}
            >
              <RefreshCw aria-hidden />
              Retry
            </Button>
          ) : null}
          {action}
          <span className="sr-only">{name}</span>
        </div>
      </div>
    </div>
  )
}

// Error fallback that distinguishes an unavailable file from a genuine render/parse failure. A
// missing file (deleted/moved) and an outside-storage file (stale/cross-root path) both read as
// unavailable and get the FileX icon, but with different copy — deleted vs "not in current
// storage". Everything else keeps the renderer's type-specific message.
export const PreviewErrorCard = (props: {
  name: string
  error?: unknown
  fallbackMessage: string
}): React.JSX.Element => {
  const { name, error, fallbackMessage } = props
  const missing = isMissingFileError(error)
  const outside = !missing && isOutsideStorageError(error)
  const unavailable = missing || outside

  const message = missing
    ? FILE_MISSING_MESSAGE
    : outside
      ? FILE_OUTSIDE_STORAGE_MESSAGE
      : fallbackMessage

  return (
    <PreviewFallbackCard
      icon={unavailable ? FileX : FileWarning}
      name={name}
      title={unavailable ? 'File unavailable' : 'Preview unavailable'}
      message={message}
      retryable
    />
  )
}

export const PreviewUnsupportedContent = ({
  path,
  name,
  source = 'artifact'
}: {
  path: string
  name: string
  source?: PreviewFileSource
}): React.JSX.Element => {
  const runtime = usePreviewRuntime()
  const presentation = getFormatPresentation(runtime?.item.format ?? 'unknown', name)

  return (
    <div
      data-preview-status="unsupported"
      className="flex size-full items-center justify-center px-6 py-8"
    >
      <div className="grid w-full max-w-[19rem] grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3">
        <PreviewFormatTile badge={presentation.badge} />
        <div className="min-w-0 pt-px">
          <div className="text-[12px] font-medium text-text-000">Preview unavailable</div>
          <p className="mt-0.5 text-[10px] leading-4 text-text-300">
            This file type isn&apos;t supported for preview
          </p>
          <ManagedFileDownloadButton
            source={source}
            path={path}
            suggestedName={name}
            appearance="primary"
            wrapperClassName="mt-3"
          />
          <span className="sr-only">{name}</span>
        </div>
      </div>
    </div>
  )
}
