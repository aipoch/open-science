import { File, FolderOpen, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

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
