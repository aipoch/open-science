import { useEffect, useState } from 'react'

import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { isUnavailableFileError } from './preview-errors'

export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024

export type PreviewFileContentLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; preview: ArtifactPreviewResult }

type PreviewFileContentInternalState = PreviewFileContentLoadState & {
  requestKey: string
}

type UsePreviewFileContentRequest = {
  path: string
  source?: PreviewFileSource
  maxBytes?: number
  encoding?: 'utf8' | 'base64'
}

// Centralizes artifact/upload preview reads so each renderer only handles parsing and display.
export const usePreviewFileContent = ({
  path,
  source = 'artifact',
  maxBytes = PREVIEW_TEXT_MAX_BYTES,
  encoding = 'utf8'
}: UsePreviewFileContentRequest): PreviewFileContentLoadState => {
  const requestKey = `${source}:${encoding}:${maxBytes}:${path}`
  const [state, setState] = useState<PreviewFileContentInternalState>({
    status: 'loading',
    requestKey
  })

  useEffect(() => {
    let canceled = false
    const readPreview =
      source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

    void readPreview({ path, maxBytes, encoding })
      .then((preview) => {
        if (!canceled) setState({ status: 'ready', preview, requestKey })
      })
      .catch((error) => {
        // Unavailable files (missing / outside storage) surface as a handled preview state; only
        // log genuine read failures to avoid console noise for deleted/relocated files.
        if (!isUnavailableFileError(error)) console.error('Failed to read file preview', error)
        if (!canceled) setState({ status: 'error', error, requestKey })
      })

    return () => {
      canceled = true
    }
  }, [encoding, maxBytes, path, requestKey, source])

  if (state.requestKey !== requestKey) return { status: 'loading' }

  return state
}
