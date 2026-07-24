import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  OFFICE_PREVIEW_RUNTIME_HOST,
  OFFICE_PREVIEW_RUNTIME_ORIGIN,
  OFFICE_PREVIEW_RUNTIME_SCHEME
} from '../../shared/office-preview'

const OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG = {
  scheme: OFFICE_PREVIEW_RUNTIME_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
} as const

const createOfficePreviewRuntimeCsp = (devServerUrl?: string): string => {
  const developmentOrigins: string[] = []
  let frameAncestor = 'file:'
  if (devServerUrl) {
    const httpOrigin = new URL(devServerUrl).origin
    const websocketOrigin = new URL(httpOrigin)
    websocketOrigin.protocol = websocketOrigin.protocol === 'https:' ? 'wss:' : 'ws:'
    developmentOrigins.push(httpOrigin, websocketOrigin.origin)
    frameAncestor = httpOrigin
  }

  return [
    "default-src 'self'",
    `script-src 'self'${devServerUrl ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: open-science-preview:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    ['connect-src open-science-preview:', ...developmentOrigins].join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestor}`
  ].join('; ')
}

type FetchOfficePreviewRuntime = (targetUrl: string, request: Request) => Promise<Response>

type OfficePreviewRuntimeProtocolOptions = {
  runtimeHtmlPath: string
  devServerUrl?: string
  fetchRuntime: FetchOfficePreviewRuntime
}

type OfficePreviewRuntimeProtocolRegistrar = {
  handle: (scheme: string, handler: (request: Request) => Promise<Response>) => void
}

const createOfficePreviewRuntimeUrl = (sessionId: string): string => {
  const url = new URL('/office-preview.html', OFFICE_PREVIEW_RUNTIME_ORIGIN)
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

// Maps only runtime-owned paths; arbitrary filesystem paths never cross this protocol boundary.
const resolveOfficePreviewRuntimeTarget = (
  requestUrl: URL,
  options: OfficePreviewRuntimeProtocolOptions
): string => {
  if (options.devServerUrl) {
    const targetUrl = new URL(requestUrl.pathname, `${options.devServerUrl}/`)
    targetUrl.search = requestUrl.search
    return targetUrl.toString()
  }

  const runtimeRoot = dirname(options.runtimeHtmlPath)
  const decodedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
  const targetPath = resolve(runtimeRoot, decodedPath)
  const relativePath = relative(runtimeRoot, targetPath)
  if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith(`..`)) {
    if (targetPath !== options.runtimeHtmlPath) {
      throw new Error('Office preview runtime path is outside the renderer bundle.')
    }
  }
  return pathToFileURL(targetPath).toString()
}

const createOfficePreviewRuntimeProtocolHandler = (
  options: OfficePreviewRuntimeProtocolOptions
): ((request: Request) => Promise<Response>) => {
  return async (request) => {
    try {
      const url = new URL(request.url)
      if (
        url.protocol !== `${OFFICE_PREVIEW_RUNTIME_SCHEME}:` ||
        url.hostname !== OFFICE_PREVIEW_RUNTIME_HOST ||
        (request.method !== 'GET' && request.method !== 'HEAD')
      ) {
        throw new Error('Office preview runtime request is not allowed.')
      }

      const targetUrl = resolveOfficePreviewRuntimeTarget(url, options)
      const upstream = await options.fetchRuntime(targetUrl, request)
      const headers = new Headers(upstream.headers)
      headers.set('cache-control', 'no-store')
      headers.set('x-content-type-options', 'nosniff')
      if (url.pathname.endsWith('.html')) {
        headers.set('content-security-policy', createOfficePreviewRuntimeCsp(options.devServerUrl))
      }

      if (request.method === 'HEAD') {
        return new Response(null, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        })
      }

      // Runtime assets are small, trusted application files. Materializing them here avoids
      // forwarding stale transfer headers across Electron's custom-protocol response boundary.
      const body = await upstream.arrayBuffer()
      headers.delete('content-encoding')
      headers.delete('transfer-encoding')
      headers.set('content-length', String(body.byteLength))

      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers
      })
    } catch (error) {
      const failedUrl = new URL(request.url)
      console.warn('[office-preview] runtime asset request failed', {
        method: request.method,
        resource: failedUrl.pathname.endsWith('.html') ? 'document' : 'asset',
        error
      })
      return new Response('Office preview runtime is unavailable.', {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      })
    }
  }
}

const registerOfficePreviewRuntimeProtocol = (
  options: OfficePreviewRuntimeProtocolOptions,
  targetProtocol: OfficePreviewRuntimeProtocolRegistrar
): void => {
  targetProtocol.handle(
    OFFICE_PREVIEW_RUNTIME_SCHEME,
    createOfficePreviewRuntimeProtocolHandler(options)
  )
}

export {
  createOfficePreviewRuntimeProtocolHandler,
  createOfficePreviewRuntimeUrl,
  OFFICE_PREVIEW_RUNTIME_HOST,
  OFFICE_PREVIEW_RUNTIME_ORIGIN,
  OFFICE_PREVIEW_RUNTIME_SCHEME,
  OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG,
  registerOfficePreviewRuntimeProtocol
}
export type {
  FetchOfficePreviewRuntime,
  OfficePreviewRuntimeProtocolOptions,
  OfficePreviewRuntimeProtocolRegistrar
}
