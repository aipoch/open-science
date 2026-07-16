import { useEffect, useState } from 'react'

import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024

type PreviewPagination = {
  pageNumber: number
  hasPrevious: boolean
  hasNext: boolean
  previousPage: () => void
  nextPage: () => void
}

export type PreviewFileContentLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; preview: ArtifactPreviewResult; pagination: PreviewPagination }

type PreviewFileContentInternalState =
  | { requestKey: string; status: 'loading' }
  | { requestKey: string; status: 'error'; error: unknown }
  | { requestKey: string; status: 'ready'; preview: ArtifactPreviewResult }

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
  const fileKey = `${source}:${encoding}:${maxBytes}:${path}`
  // Keep byte offsets, not prior page contents, so only the active page remains in memory.
  const [pageState, setPageState] = useState<{ fileKey: string; offsets: number[]; index: number }>(
    {
      fileKey,
      offsets: [0],
      index: 0
    }
  )
  const activePageState =
    pageState.fileKey === fileKey ? pageState : { fileKey, offsets: [0], index: 0 }
  const offset = activePageState.offsets[activePageState.index] ?? 0
  const requestKey = `${fileKey}:${offset}`
  const [state, setState] = useState<PreviewFileContentInternalState>({
    status: 'loading',
    requestKey
  })

  useEffect(() => {
    let canceled = false
    const readPreview =
      source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

    void readPreview({ path, maxBytes, encoding, offset })
      .then((preview) => {
        if (!canceled) setState({ status: 'ready', preview, requestKey })
      })
      .catch((error) => {
        console.error('Failed to read file preview', error)
        if (!canceled) setState({ status: 'error', error, requestKey })
      })

    return () => {
      canceled = true
    }
  }, [encoding, maxBytes, offset, path, requestKey, source])

  if (state.requestKey !== requestKey) return { status: 'loading' }

  if (state.status !== 'ready') return state

  const previousPage = (): void => {
    setPageState((current) => {
      const active = current.fileKey === fileKey ? current : activePageState
      return { ...active, index: Math.max(0, active.index - 1) }
    })
  }
  const nextPage = (): void => {
    if (state.preview.nextOffset === undefined) return

    setPageState((current) => {
      const active = current.fileKey === fileKey ? current : activePageState
      // Discard forward history when navigation continues from an earlier page.
      const nextOffsets = active.offsets.slice(0, active.index + 1)
      nextOffsets.push(state.preview.nextOffset as number)
      return { fileKey, offsets: nextOffsets, index: active.index + 1 }
    })
  }

  return {
    ...state,
    pagination: {
      pageNumber: activePageState.index + 1,
      hasPrevious: activePageState.index > 0,
      hasNext: state.preview.nextOffset !== undefined,
      previousPage,
      nextPage
    }
  }
}

export type { PreviewPagination }
