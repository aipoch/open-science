import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { createPreviewResourceKey } from '../preview-resource-key'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
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
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
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
    managedFileId,
    selectedVersionId,
    mimeType,
    size,
    mtimeMs
  })
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  // A decode failure disables the hook, which releases the protocol capability immediately.
  const state = useManagedPreviewResource(
    {
      projectId,
      sessionId,
      managedFileId,
      selectedVersionId,
      path,
      source,
      mimeType,
      size,
      mtimeMs
    },
    !hasFailed
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
      <ZoomableImage
        url={state.resource.url}
        name={name}
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
    projectId={item.projectId}
    sessionId={item.sessionId}
    managedFileId={item.managedFileId}
    selectedVersionId={item.selectedVersionId}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
