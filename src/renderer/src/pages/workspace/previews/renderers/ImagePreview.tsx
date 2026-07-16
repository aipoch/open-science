import { ImageOff } from 'lucide-react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import {
  PREVIEW_PANEL_IMAGE_MAX_BYTES,
  getFileExtension,
  getImageMimeTypeForExtension
} from '../../preview-support'
import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

export const PreviewImageContent = ({
  path,
  name,
  source = 'artifact'
}: {
  path: string
  name: string
  source?: PreviewFileSource
}): React.JSX.Element => {
  const state = usePreviewFileContent({
    path,
    source,
    maxBytes: PREVIEW_PANEL_IMAGE_MAX_BYTES,
    encoding: 'base64'
  })

  if (state.status === 'loading') return <PreviewLoadingContent />

  // A read failure is either a missing file (badged "no longer available") or a genuine error;
  // PreviewErrorCard picks the message. Non-error cases (too large / unparseable) keep their copy.
  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        path={path}
        name={name}
        source={source}
        error={state.error}
        fallbackMessage="File is too large or couldn't be parsed for preview"
      />
    )
  }

  const mimeType = getImageMimeTypeForExtension(getFileExtension(name))

  if (state.preview.truncated || state.preview.encoding !== 'base64' || !mimeType) {
    return (
      <PreviewFallbackCard
        icon={ImageOff}
        path={path}
        name={name}
        source={source}
        message="File is too large or couldn't be parsed for preview"
      />
    )
  }

  return (
    <div className="flex size-full items-center justify-center overflow-auto p-4">
      <img
        src={`data:${mimeType};base64,${state.preview.content}`}
        alt={name}
        className="max-h-full max-w-full object-contain"
        draggable={false}
      />
    </div>
  )
}

export const ImagePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewImageContent path={item.path} name={item.name} source={item.source} />
)
