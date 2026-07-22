import { pathToFileURL } from 'node:url'

import { net, protocol } from 'electron'

import { MANAGED_PREVIEW_LOAD_ERROR } from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'
import { PREVIEW_SCHEME } from './managed-preview-resources'

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
type PreviewProtocolRegistrar = Pick<typeof protocol, 'handle' | 'unhandle'>
type ManagedPreviewProtocolOptions = {
  isResourceAllowed?: (resourceId: string) => boolean
}

// Forward the original request so Chromium range headers and cancellation reach the file stream.
const defaultFetchManagedFile: FetchManagedFile = (filePath, request) =>
  net.fetch(pathToFileURL(filePath).href, {
    headers: request.headers,
    method: request.method,
    signal: request.signal
  })

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
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) throw new Error('Managed preview range is invalid.')

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
  const closeHandle = async (): Promise<void> => {
    if (closed) return
    closed = true
    await resource.fileHandle.close()
  }

  try {
    const rangeHeader = request.headers.get('range')
    const range = parseRange(rangeHeader, resource.size)
    const isPartial = rangeHeader !== null
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
      pull: async (controller) => {
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
            if (bytesRead === 0) {
              throw new Error('Managed preview file changed during streaming.')
            }
            chunkOffset += bytesRead
          }

          position += chunkOffset
          const complete = position > range.end
          if (complete) await resource.verifyUnchanged()
          controller.enqueue(buffer)
          if (complete) {
            await closeHandle()
            controller.close()
          }
        } catch (error) {
          await closeHandle().catch(() => undefined)
          controller.error(error)
        }
      },
      cancel: async () => {
        await closeHandle()
      }
    })
    return new Response(body, { status: isPartial ? 206 : 200, headers })
  } catch (error) {
    await closeHandle()
    throw error
  }
}

// Builds a streaming protocol handler without exposing filesystem paths to the renderer.
const createManagedPreviewProtocolHandler = (
  resources: ManagedPreviewResources,
  fetchFile: FetchManagedFile = defaultFetchManagedFile,
  options: ManagedPreviewProtocolOptions = {}
): ((request: Request) => Promise<Response>) => {
  return async (request) => {
    try {
      const url = new URL(request.url)
      if (options.isResourceAllowed && !options.isResourceAllowed(url.hostname)) {
        throw new Error('Managed preview resource is not assigned to this session.')
      }
      const resource = await resources.resolveProtocolResource(url.hostname)
      const fileResponse =
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
      return createLoadErrorResponse()
    }
  }
}

const registerManagedPreviewProtocol = (
  resources: ManagedPreviewResources,
  targetProtocol: PreviewProtocolRegistrar = protocol,
  options: ManagedPreviewProtocolOptions = {}
): (() => void) => {
  targetProtocol.handle(
    PREVIEW_SCHEME,
    createManagedPreviewProtocolHandler(resources, undefined, options)
  )
  return () => targetProtocol.unhandle(PREVIEW_SCHEME)
}

export { createManagedPreviewProtocolHandler, registerManagedPreviewProtocol }
export type { FetchManagedFile, ManagedPreviewProtocolOptions, PreviewProtocolRegistrar }
