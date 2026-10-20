import { open } from 'node:fs/promises'
import { MANAGED_PREVIEW_LOAD_ERROR } from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'

// Render self-contained HTML while denying network access, navigation, forms, and embedded objects.
const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: data:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

type FetchManagedFile = (filePath: string, request: Request) => Promise<Response>
type ManagedPreviewProtocolOptions = {
  isResourceAllowed?: (resourceId: string) => boolean
}

// Notify the parent explicitly because iframe load events do not reliably expose protocol failures.
const createLoadErrorResponse = (): Response =>
  new Response(
    `<!doctype html><script>parent.postMessage(${JSON.stringify(MANAGED_PREVIEW_LOAD_ERROR)}, '*')</script>`,
    {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    }
  )

const parseRange = (
  rangeHeader: string | null,
  size: number
): { start: number; end: number } | undefined => {
  if (!rangeHeader) return size > 0 ? { start: 0, end: size - 1 } : undefined
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) throw new Error('Managed preview range is invalid.')
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new Error('Managed preview suffix range is invalid.')
    }
    return size > 0 ? { start: Math.max(0, size - suffixLength), end: size - 1 } : undefined
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  const end = Math.min(requestedEnd, size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    throw new Error('Managed preview range is outside the file.')
  }
  return { start, end }
}

// Streams only the admitted byte range from the already-verified FileHandle.
const createStrictFileResponse = async (
  resource: Extract<
    Awaited<ReturnType<ManagedPreviewResources['resolveProtocolResource']>>,
    {
      fileHandle: unknown
    }
  >,
  request: Request
): Promise<Response> => {
  let closed = false
  let onAbort: (() => void) | undefined
  const closeHandle = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (onAbort) request.signal.removeEventListener('abort', onAbort)
    await resource.fileHandle.close()
  }
  let canceled = false
  let reading: Promise<void> | undefined
  const cancelReading = async (): Promise<void> => {
    canceled = true
    // Cancellation can arrive while an asynchronous read still owns the handle.
    try {
      await reading
    } finally {
      await closeHandle()
    }
  }

  try {
    const rangeHeader = request.headers.get('range')
    const range = parseRange(rangeHeader, resource.size)
    const isPartial = rangeHeader !== null && range !== undefined
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'content-length': String(range ? range.end - range.start + 1 : 0)
    })
    if (isPartial && range) {
      headers.set('content-range', `bytes ${range.start}-${range.end}/${resource.size}`)
    }

    if (request.method === 'HEAD' || !range) {
      await resource.verifyUnchanged()
      await closeHandle()
      return new Response(null, { status: isPartial ? 206 : 200, headers })
    }

    let position = range.start
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // An abandoned response may never be consumed or receive a stream cancel callback.
        onAbort = () => {
          controller.error(
            request.signal.reason ?? new DOMException('Preview read aborted', 'AbortError')
          )
          void cancelReading().catch(() => undefined)
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) onAbort()
      },
      pull: (controller) => {
        reading = (async () => {
          try {
            if (request.signal.aborted) {
              throw request.signal.reason ?? new DOMException('Preview read aborted', 'AbortError')
            }
            const length = Math.min(64 * 1024, range.end - position + 1)
            const buffer = new Uint8Array(length)
            let chunkOffset = 0
            while (chunkOffset < length) {
              const { bytesRead } = await resource.fileHandle.read(
                buffer,
                chunkOffset,
                length - chunkOffset,
                position + chunkOffset
              )
              if (canceled) return
              if (bytesRead === 0) {
                throw new Error('Managed preview file changed during streaming.')
              }
              chunkOffset += bytesRead
            }

            position += chunkOffset
            const complete = position > range.end
            if (complete) await resource.verifyUnchanged()
            if (canceled) return
            controller.enqueue(buffer)
            if (complete) {
              await closeHandle()
              controller.close()
            }
          } catch (error) {
            await closeHandle().catch(() => undefined)
            if (!canceled) controller.error(error)
          }
        })()
        return reading
      },
      cancel: cancelReading
    })
    return new Response(body, { status: isPartial ? 206 : 200, headers })
  } catch (error) {
    await cancelReading().catch(() => undefined)
    throw error
  }
}

// Builds a streaming protocol handler without exposing filesystem paths to the renderer.
const createManagedPreviewProtocolHandler = (
  resources: ManagedPreviewResources,
  fetchFile: FetchManagedFile = fetchManagedFile,
  options: ManagedPreviewProtocolOptions = {}
): ((request: Request) => Promise<Response>) => {
  return async (request) => {
    let fileResponse: Response | undefined
    try {
      const url = new URL(request.url)
      if (options.isResourceAllowed && !options.isResourceAllowed(url.hostname)) {
        throw new Error('Managed preview resource is not assigned to this session.')
      }
      const resource = await resources.resolveProtocolResource(url.hostname)
      fileResponse =
        'fileHandle' in resource
          ? await createStrictFileResponse(resource, request)
          : await fetchFile(resource.filePath, request)
      const headers = new Headers(fileResponse.headers)

      // Preserve the streaming body and byte-range status while enforcing app-owned headers.
      headers.set('content-type', resource.mimeType)
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
      headers.set('access-control-allow-origin', '*')
      if (resource.mimeType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html') {
        headers.set('content-security-policy', HTML_PREVIEW_CSP)
      }

      return new Response(fileResponse.body, {
        status: fileResponse.status,
        statusText: fileResponse.statusText,
        headers
      })
    } catch {
      // Header/response construction can fail after the resource stream has been opened.
      await fileResponse?.body?.cancel().catch(() => undefined)
      return createLoadErrorResponse()
    }
  }
}

// Node and Electron use the same verified-handle streaming and range implementation.
// Path-based resources have already been admitted by the resource owner; open once and keep
// that handle for the entire response instead of reopening by path for each chunk.
const fetchManagedFile: FetchManagedFile = async (filePath, request) => {
  const fileHandle = await open(filePath, 'r')
  try {
    const stat = await fileHandle.stat()
    if (!stat.isFile()) throw new Error('Managed preview resource is not a regular file.')
    return await createStrictFileResponse(
      {
        fileHandle,
        size: stat.size,
        mimeType: 'application/octet-stream',
        verifyUnchanged: async () => {
          const current = await fileHandle.stat()
          if (
            current.size !== stat.size ||
            current.mtimeMs !== stat.mtimeMs ||
            current.ctimeMs !== stat.ctimeMs
          )
            throw new Error('Managed preview file changed while streaming.')
        }
      },
      request
    )
  } catch (error) {
    await fileHandle.close().catch(() => undefined)
    throw error
  }
}

export { createManagedPreviewProtocolHandler, createLoadErrorResponse }
export type { FetchManagedFile, ManagedPreviewProtocolOptions }
