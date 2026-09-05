import { useEffect, useState } from 'react'

import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createManagedPreviewRequest } from './preview-file-reader'
import { isManagedFilePublicationPendingError, isUnavailableFileError } from './preview-errors'

export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const PUBLICATION_RETRY_DELAY_MS = 200
const PUBLICATION_RETRY_LIMIT = 4

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
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  path: string
  source?: PreviewFileSource
  maxBytes?: number
  encoding?: 'utf8' | 'base64'
}

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
  }
  return btoa(binary)
}

const readResponseSize = (response: Response, fallback: number): number => {
  const contentRange = response.headers.get('content-range')
  const match = contentRange?.match(/\/(\d+)$/u)
  if (!match) return fallback

  const size = Number(match[1])
  return Number.isSafeInteger(size) && size >= 0 ? size : fallback
}

const readManagedPreviewPage = async (
  request: UsePreviewFileContentRequest & {
    source: PreviewFileSource
    maxBytes: number
    encoding: 'utf8' | 'base64'
    offset: number
    signal: AbortSignal
  }
): Promise<ArtifactPreviewResult> => {
  const previewRequest = createManagedPreviewRequest(request)
  let resource
  for (let attempt = 0; ; attempt += 1) {
    if (request.signal.aborted) throw request.signal.reason
    try {
      resource = await window.api.previewResources.acquire(previewRequest)
      break
    } catch (error) {
      if (attempt === PUBLICATION_RETRY_LIMIT || !isManagedFilePublicationPendingError(error)) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PUBLICATION_RETRY_DELAY_MS))
    }
  }

  try {
    if (request.signal.aborted) throw request.signal.reason

    const requestedBytes = Number.isFinite(request.maxBytes)
      ? Math.floor(request.maxBytes)
      : PREVIEW_TEXT_MAX_BYTES
    const maxBytes = Math.max(1, Math.min(requestedBytes, MAX_PREVIEW_BYTES))
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      request.offset > resource.size
    ) {
      throw new Error('Invalid managed file preview offset.')
    }

    const readBudget = request.encoding === 'utf8' ? maxBytes + 3 : maxBytes
    const end = Math.min(resource.size, request.offset + readBudget)
    let bytes = new Uint8Array()
    let size = resource.size
    if (end > request.offset) {
      const response = await fetch(resource.url, {
        cache: 'no-store',
        headers: { Range: `bytes=${request.offset}-${end - 1}` },
        signal: request.signal
      })
      if (!response.ok) {
        if (response.status === 404) {
          throw Object.assign(new Error('ENOENT: managed preview file is no longer available.'), {
            code: 'ENOENT'
          })
        }
        throw new Error(`Managed preview request failed with status ${response.status}.`)
      }
      size = readResponseSize(response, resource.size)
      bytes = new Uint8Array(await response.arrayBuffer())
    }

    let contentBytesRead = Math.min(bytes.length, maxBytes)
    if (request.encoding === 'utf8') {
      while (contentBytesRead < bytes.length && (bytes[contentBytesRead] & 0xc0) === 0x80) {
        contentBytesRead += 1
      }
    }
    const contentBytes = bytes.subarray(0, contentBytesRead)
    const nextOffset = request.offset + contentBytesRead

    return {
      content:
        request.encoding === 'utf8'
          ? new TextDecoder().decode(contentBytes)
          : encodeBase64(contentBytes),
      encoding: request.encoding,
      size,
      truncated: size > nextOffset,
      offset: request.offset,
      ...(size > nextOffset ? { nextOffset } : {})
    }
  } finally {
    await window.api.previewResources.release({ resourceId: resource.id }).catch(() => undefined)
  }
}

// Centralizes artifact/upload preview reads so each renderer only handles parsing and display.
export const usePreviewFileContent = ({
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  path,
  source = 'artifact',
  maxBytes = PREVIEW_TEXT_MAX_BYTES,
  encoding = 'utf8'
}: UsePreviewFileContentRequest): PreviewFileContentLoadState => {
  const fileKey = JSON.stringify([
    projectId ?? null,
    sessionId ?? null,
    source,
    managedFileId ?? null,
    selectedVersionId ?? null,
    encoding,
    maxBytes,
    path
  ])
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
    const abortController = new AbortController()

    void readManagedPreviewPage({
      projectId,
      sessionId,
      source,
      path,
      ...(managedFileId ? { managedFileId } : {}),
      ...(selectedVersionId ? { selectedVersionId } : {}),
      maxBytes,
      encoding,
      offset,
      signal: abortController.signal
    })
      .then((preview) => {
        if (!canceled) setState({ status: 'ready', preview, requestKey })
      })
      .catch((error) => {
        if (canceled) return
        // Unavailable files (missing / outside storage) surface as a handled preview state; only
        // log genuine read failures to avoid console noise for deleted/relocated files.
        if (!isUnavailableFileError(error)) console.error('Failed to read file preview', error)
        if (!canceled) setState({ status: 'error', error, requestKey })
      })

    return () => {
      canceled = true
      abortController.abort()
    }
  }, [
    encoding,
    managedFileId,
    maxBytes,
    offset,
    path,
    projectId,
    requestKey,
    selectedVersionId,
    sessionId,
    source
  ])

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
