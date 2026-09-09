import { useEffect, useRef, useState } from 'react'
import { usePreviewResourceGeneration } from './usePreviewResourceGeneration'

import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'
import type { ManagedPreviewResource } from '../../../../../shared/preview-resources'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createManagedPreviewRequest } from './preview-file-reader'
import { isManagedFilePublicationPendingError, isUnavailableFileError } from './preview-errors'

export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const PUBLICATION_RETRY_DELAY_MS = 200
const PUBLICATION_RETRY_LIMIT = 4

type PreviewPagination = {
  pageNumber: number
  pageKey?: string
  startingLineNumber?: number
  startsMidLine?: boolean
  endsMidLine?: boolean
  byteStart?: number
  byteEnd?: number
  showLastLines?: boolean
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
  // Per-page read budget; never an admission limit for the complete file.
  maxBytes?: number
  maxFileBytes?: number
  encoding?: 'utf8' | 'base64'
}

type PreviewResourceOwner = { resource?: ManagedPreviewResource }

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
  },
  owner?: PreviewResourceOwner
): Promise<ArtifactPreviewResult> => {
  const previewRequest = createManagedPreviewRequest({ ...request, maxBytes: request.maxFileBytes })
  let resource = owner?.resource
  for (let attempt = 0; !resource; attempt += 1) {
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
    if (owner) owner.resource = resource

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
    // Keep CRLF together, using the same bounded lookahead as UTF-8 completion.
    if (
      request.encoding === 'utf8' &&
      bytes[contentBytesRead - 1] === 13 &&
      bytes[contentBytesRead] === 10
    ) {
      contentBytesRead += 1
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
  } catch (error) {
    // A failed sequence cannot navigate further; retry starts from a fresh resource.
    // Aborting an obsolete page must not revoke the resource used by its successor.
    if (!request.signal.aborted && owner?.resource === resource) owner.resource = undefined
    throw error
  } finally {
    // Path reads and acquisitions that completed after cancellation still release per page.
    if (owner?.resource !== resource) {
      await window.api.previewResources.release({ resourceId: resource.id }).catch(() => undefined)
    }
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
  maxFileBytes,
  encoding = 'utf8'
}: UsePreviewFileContentRequest): PreviewFileContentLoadState => {
  const generation = usePreviewResourceGeneration()
  const fileKey = JSON.stringify([
    generation,
    projectId ?? null,
    sessionId ?? null,
    source,
    managedFileId ?? null,
    selectedVersionId ?? null,
    encoding,
    maxBytes,
    maxFileBytes,
    path
  ])
  // Retain locations, not previous page contents, for the pinned resource sequence.
  const firstPage = { offset: 0, startingLineNumber: 1, startsMidLine: false }
  const [pageState, setPageState] = useState<{
    fileKey: string
    pages: (typeof firstPage)[]
    index: number
    showLastLines: boolean
  }>({ fileKey, pages: [firstPage], index: 0, showLastLines: false })
  const activePageState =
    pageState.fileKey === fileKey
      ? pageState
      : { fileKey, pages: [firstPage], index: 0, showLastLines: false }
  if (pageState.fileKey !== fileKey) setPageState(activePageState)
  const page = activePageState.pages[activePageState.index] ?? firstPage
  const offset = page.offset
  const requestKey = `${fileKey}:${offset}`
  const [state, setState] = useState<PreviewFileContentInternalState>({
    status: 'loading',
    requestKey
  })

  const resourceOwnerRef = useRef<PreviewResourceOwner>({})
  useEffect(() => {
    const owner: PreviewResourceOwner = {}
    resourceOwnerRef.current = owner
    return () => {
      // The capability pins one immutable version across forward and backward page reads.
      // Identity changes and refresh/remount boundaries start a new pagination sequence.
      if (owner.resource) {
        void window.api.previewResources
          .release({ resourceId: owner.resource.id })
          .catch(() => undefined)
      }
    }
  }, [fileKey])

  useEffect(() => {
    let canceled = false
    const abortController = new AbortController()

    void readManagedPreviewPage(
      {
        projectId,
        sessionId,
        source,
        path,
        ...(managedFileId ? { managedFileId } : {}),
        ...(selectedVersionId ? { selectedVersionId } : {}),
        maxBytes,
        maxFileBytes,
        encoding,
        offset,
        signal: abortController.signal
      },
      source === 'artifact' || source === 'upload' ? resourceOwnerRef.current : undefined
    )
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
    maxFileBytes,
    offset,
    path,
    projectId,
    requestKey,
    selectedVersionId,
    sessionId,
    source
  ])

  if (state.requestKey !== requestKey) {
    // Remember pending identities too, so returning to a file cannot revive its old page.
    setState({ status: 'loading', requestKey })
    return { status: 'loading' }
  }

  if (state.status !== 'ready') return state

  const previousPage = (): void => {
    setPageState((current) => {
      const active = current.fileKey === fileKey ? current : activePageState
      return { ...active, index: Math.max(0, active.index - 1), showLastLines: true }
    })
  }
  const nextPage = (): void => {
    if (state.preview.nextOffset === undefined) return

    setPageState((current) => {
      const active = current.fileKey === fileKey ? current : activePageState
      // Discard forward history when navigation continues from an earlier page.
      const pages = active.pages.slice(0, active.index + 1)
      pages.push({
        offset: state.preview.nextOffset as number,
        startingLineNumber:
          page.startingLineNumber +
          (encoding === 'utf8' ? (state.preview.content.match(/\n/g)?.length ?? 0) : 0),
        startsMidLine: encoding === 'utf8' && !state.preview.content.endsWith('\n')
      })
      return { fileKey, pages, index: active.index + 1, showLastLines: false }
    })
  }

  return {
    ...state,
    pagination: {
      pageNumber: activePageState.index + 1,
      pageKey: requestKey,
      startingLineNumber: page.startingLineNumber,
      startsMidLine: page.startsMidLine,
      endsMidLine:
        encoding === 'utf8' && state.preview.truncated && !state.preview.content.endsWith('\n'),
      byteStart: offset,
      byteEnd: state.preview.nextOffset ?? state.preview.size,
      showLastLines: activePageState.showLastLines,
      hasPrevious: activePageState.index > 0,
      hasNext: state.preview.nextOffset !== undefined,
      previousPage,
      nextPage
    }
  }
}

export type { PreviewPagination }
