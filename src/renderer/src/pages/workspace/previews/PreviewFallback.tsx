import { File, FileWarning, FileX, FolderOpen, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import {
  FILE_MISSING_MESSAGE,
  FILE_OUTSIDE_STORAGE_MESSAGE,
  isMissingFileError,
  isOutsideStorageError
} from './preview-errors'

const openFileExternally = async (path: string): Promise<void> => {
  try {
    await window.api.artifacts.openFile({ path })
  } catch (error) {
    console.error('Failed to open artifact file', error)
  }
}

const OpenExternallyButton = ({
  path,
  source
}: {
  path: string
  source: PreviewFileSource
}): React.JSX.Element | null => {
  if (source === 'upload') return null

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void openFileExternally(path)
      }}
    >
      <FolderOpen aria-hidden />
      Open externally
    </Button>
  )
}

export const PreviewLoadingContent = (): React.JSX.Element => (
  <div className="flex size-full items-center justify-center">
    <Loader2 className="size-5 animate-spin text-text-300" aria-hidden />
  </div>
)

export const PreviewFallbackCard = ({
  icon: Icon,
  path,
  name,
  source = 'artifact',
  message
}: {
  icon: LucideIcon
  path: string
  name: string
  source?: PreviewFileSource
  message: string
}): React.JSX.Element => (
  <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
    <Icon className="size-8 text-text-300" aria-hidden />
    <div className="max-w-full truncate text-[13px] text-text-000" title={name}>
      {name}
    </div>
    <p className="text-[12px] text-text-300">{message}</p>
    <OpenExternallyButton path={path} source={source} />
  </div>
)

// Error fallback that distinguishes an unavailable file from a genuine render/parse failure. A
// missing file (deleted/moved) and an outside-storage file (stale/cross-root path) both read as
// unavailable and get the FileX icon, but with different copy — deleted vs "not in current
// storage". Everything else keeps the renderer's type-specific message.
export const PreviewErrorCard = ({
  path,
  name,
  source = 'artifact',
  error,
  fallbackMessage
}: {
  path: string
  name: string
  source?: PreviewFileSource
  error?: unknown
  fallbackMessage: string
}): React.JSX.Element => {
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
      path={path}
      name={name}
      source={source}
      message={message}
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
}): React.JSX.Element => (
  <PreviewFallbackCard
    icon={File}
    path={path}
    name={name}
    source={source}
    message="This file type isn't supported for preview"
  />
)
