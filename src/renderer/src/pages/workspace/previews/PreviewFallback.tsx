import { ErrorNotice } from '@/components/error-notice'
import { FileWarning, FileX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import type { PreviewFileFormat, PreviewFileSource } from '@/stores/preview-workbench-store'

import { LocalFileFallbackAction } from '../LocalFileHeaderActions'
import { ManagedFileDownloadButton } from '../ManagedFileDownloadButton'
import { getFileExtension } from '../preview-support'
import {
  FILE_MISSING_MESSAGE_KEY,
  FILE_OUTSIDE_STORAGE_MESSAGE_KEY,
  isMissingFileError,
  isOutsideStorageError
} from './preview-errors'
import { usePreviewRuntime } from './preview-runtime-context'

type PreviewFormatPresentation = {
  badge: string
  loadingTitleKey: (typeof FORMAT_LOADING_TITLE_KEYS)[PreviewFileFormat]
}

// Catalog keys, not text: the loading title is resolved per render so a language switch relabels it.
const FORMAT_LOADING_TITLE_KEYS = {
  code: 'Preparing code file',
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
  tiff: 'Preparing image',
  unknown: 'Preparing preview',
  word: 'Preparing document'
} as const satisfies Record<PreviewFileFormat, string>

const FORMAT_BADGES: Record<PreviewFileFormat, string> = {
  code: 'CODE',
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
  tiff: 'TIFF',
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
    loadingTitleKey: FORMAT_LOADING_TITLE_KEYS[format ?? 'unknown']
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
  const { t } = useTranslation()
  const runtime = usePreviewRuntime()
  const presentation = getFormatPresentation(runtime?.item.format, runtime?.item.name)
  const loadingTitle = title ?? t(presentation.loadingTitleKey)
  const loadingDescription = description ?? runtime?.item.name

  if (compact) {
    return (
      <div
        data-preview-status="compact-loading"
        className="flex size-full items-center justify-center"
        role="status"
        aria-label={t('Rendering preview')}
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
            <div className="mt-0.5 truncate text-[10px] text-text-100" title={loadingDescription}>
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
  title,
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
  const { t } = useTranslation()
  const runtime = usePreviewRuntime()
  // Defaulted here rather than in the signature so the fallback follows the active language.
  const cardTitle = title ?? t('Preview unavailable')

  return (
    <div
      data-preview-status="error"
      className="flex size-full items-center justify-center px-6 py-8"
    >
      <ErrorNotice
        role="alert"
        className="w-full max-w-md"
        icon={Icon}
        title={cardTitle}
        description={message}
        primaryButton={
          retryable && runtime ? { label: t('Retry'), onClick: runtime.retry } : undefined
        }
      >
        {action}
        <span className="sr-only">{name}</span>
      </ErrorNotice>
    </div>
  )
}

const getPreviewFailureMessage = (error: unknown, t: TFunction): string | undefined => {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/Animated image preview exceeds/.test(message)) {
    return t(
      'This animated image is too large to preview safely. Download the original to view it.'
    )
  }
  const pixelLimit = /Image preview exceeds the ([\d,]+)-pixel limit/.exec(message)
  if (pixelLimit) {
    return t(
      'This image exceeds the preview limit of {{limit}} pixels. Download the original to view it.',
      {
        limit: pixelLimit[1]
      }
    )
  }
  if (/Image preview source exceeds the 50 MiB limit/.test(message)) {
    return t('This image exceeds the 50 MiB limit for resizing. Download the original to view it.')
  }
  if (/Image preview capacity is busy/.test(message)) {
    return t('Image preview memory or processing capacity is busy. Close other previews and retry.')
  }
  if (/Could not read image preview dimensions safely/.test(message)) {
    return t(
      'The image dimensions could not be read safely. The file may be damaged or use an unsupported format.'
    )
  }
  if (/Image preview could not be decoded or resized|Image preview output exceeds/.test(message)) {
    return t(
      'The image could not be decoded or resized within the preview safety limits. Download the original to view it.'
    )
  }
  if (/(?:Image preview|Managed preview file|Verified Reviewer artifact) changed/i.test(message)) {
    return t(
      'The file changed while its preview was being prepared. Retry to load the latest version.'
    )
  }
  if (/Image preview request failed with status/.test(message)) {
    return t('The preview resource could not be loaded. Retry to request it again.')
  }
  if (/EACCES|EPERM|permission denied/i.test(message)) {
    return t('Permission to read this file was denied. Check its access permissions and retry.')
  }
  return undefined
}

// IPC preserves error messages, but not custom error properties. Only translate recognized
// failures; arbitrary exception messages can contain private filesystem paths.
export const PreviewErrorCard = (props: {
  name: string
  error?: unknown
  fallbackMessage: string
  retryable?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { name, error, fallbackMessage } = props
  const missing = isMissingFileError(error)
  const outside = !missing && isOutsideStorageError(error)
  const unavailable = missing || outside

  const message = missing
    ? `${t(FILE_MISSING_MESSAGE_KEY)} ${t('Restore the file or reconnect its drive before retrying. You can close this preview and continue working.')}`
    : outside
      ? `${t(FILE_OUTSIDE_STORAGE_MESSAGE_KEY)} ${t('Open the file from your current storage location, or close this preview and continue working.')}`
      : (getPreviewFailureMessage(error, t) ?? fallbackMessage)

  return (
    <PreviewFallbackCard
      icon={unavailable ? FileX : FileWarning}
      name={name}
      title={t(unavailable ? 'File unavailable' : 'Preview unavailable')}
      message={message}
      retryable={props.retryable ?? !outside}
    />
  )
}

export const PreviewUnsupportedContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  fileId,
  versionId
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  fileId?: string
  versionId?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
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
          <div className="text-[12px] font-medium text-text-000">{t('Preview unavailable')}</div>
          <p className="mt-0.5 text-[10px] leading-4 text-text-100">
            {t("This file type isn't supported for preview")}
          </p>
          {source === 'local' ? (
            <LocalFileFallbackAction path={path} className="mt-3" />
          ) : (
            <ManagedFileDownloadButton
              source={source}
              path={path}
              projectId={projectId}
              fileId={fileId}
              versionId={versionId}
              versionNumber={runtime?.downloadVersionContext?.versionNumber}
              latestVersionId={runtime?.downloadVersionContext?.latestVersionId}
              latestVersionNumber={runtime?.downloadVersionContext?.latestVersionNumber}
              suggestedName={name}
              appearance="primary"
              wrapperClassName="mt-3"
            />
          )}
          <span className="sr-only">{name}</span>
        </div>
      </div>
    </div>
  )
}
