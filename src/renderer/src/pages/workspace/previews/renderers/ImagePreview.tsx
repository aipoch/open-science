import { ImageOff } from 'lucide-react'
import { useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'

export const PreviewImageContent = ({
  path,
  name,
  source = 'artifact',
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const requestKey = JSON.stringify([source, path, mimeType ?? null, size ?? null, mtimeMs ?? null])
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  // A decode failure disables the hook, which releases the protocol capability immediately.
  const state = useManagedPreviewResource({ path, source, mimeType, size, mtimeMs }, !hasFailed)

  if (state.status === 'loading') return <PreviewLoadingContent />

  // Acquisition errors preserve the upstream missing/outside-storage distinction.
  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        path={path}
        name={name}
        source={source}
        error={state.error}
        fallbackMessage="Image couldn't be loaded for preview"
      />
    )
  }

  if (state.status === 'idle' || hasFailed) {
    return (
      <PreviewFallbackCard
        icon={ImageOff}
        path={path}
        name={name}
        source={source}
        message="Image couldn't be loaded for preview"
      />
    )
  }

  return (
    <div className="flex size-full items-center justify-center overflow-auto p-4">
      <img
        src={state.resource.url}
        alt={name}
        className="max-h-full max-w-full object-contain"
        draggable={false}
        onError={() => setFailedRequestKey(requestKey)}
      />
    </div>
  )
}

export const ImagePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewImageContent
    path={item.path}
    name={item.name}
    source={item.source}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
