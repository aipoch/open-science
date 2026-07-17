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

// Builds a streaming protocol handler without exposing filesystem paths to the renderer.
const createManagedPreviewProtocolHandler = (
  resources: ManagedPreviewResources,
  fetchFile: FetchManagedFile = defaultFetchManagedFile
): ((request: Request) => Promise<Response>) => {
  return async (request) => {
    try {
      const url = new URL(request.url)
      const resource = resources.resolveProtocolResource(url.hostname)
      const fileResponse = await fetchFile(resource.filePath, request)
      const headers = new Headers(fileResponse.headers)

      // Preserve the streaming body and byte-range status while enforcing app-owned headers.
      headers.set('content-type', resource.mimeType)
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
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

const registerManagedPreviewProtocol = (resources: ManagedPreviewResources): void => {
  protocol.handle(PREVIEW_SCHEME, createManagedPreviewProtocolHandler(resources))
}

export { createManagedPreviewProtocolHandler, registerManagedPreviewProtocol }
export type { FetchManagedFile }
