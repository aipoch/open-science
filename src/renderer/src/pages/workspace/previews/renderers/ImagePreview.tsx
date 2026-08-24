import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { createPreviewResourceKey } from '../preview-resource-key'
import type { PreviewFileRendererProps } from '../preview-types'
import { useCachedPreviewImage } from '../useCachedPreviewImage'
import { ZoomablePreview } from './ZoomablePreview'

const ZoomableImage = ({
  url,
  name,
  onError
}: {
  url: string
  name: string
  onError: () => void
}): React.JSX.Element => {
  return (
    <ZoomablePreview>
      <img
        src={url}
        alt={name}
        className="size-full object-contain"
        draggable={false}
        onError={onError}
      />
    </ZoomablePreview>
  )
}

export const PreviewImageContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    mimeType,
    size,
    mtimeMs
  })
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  // A decode failure disables the hook, which releases the protocol capability immediately.
  const state = useCachedPreviewImage(
    { projectId, sessionId, path, source, mimeType, size, mtimeMs },
    !hasFailed,
    hasFailed
  )

  if (state.status === 'loading') return <PreviewLoadingContent />

  // Acquisition errors preserve the upstream missing/outside-storage distinction.
  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        name={name}
        error={state.error}
        fallbackMessage={t("Image couldn't be loaded for preview")}
      />
    )
  }

  if (state.status === 'idle' || hasFailed) {
    return (
      <PreviewFallbackCard
        icon={ImageOff}
        name={name}
        message={t("Image couldn't be loaded for preview")}
        retryable
      />
    )
  }

  return (
    <div className="relative size-full overflow-hidden p-4">
      <ZoomableImage url={state.url} name={name} onError={() => setFailedRequestKey(requestKey)} />
    </div>
  )
}

export const ImagePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewImageContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
