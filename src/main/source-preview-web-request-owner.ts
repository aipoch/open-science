import type { OnHeadersReceivedListenerDetails, Session } from 'electron'

import type { SourcePreviewEmbedPolicy } from './source-preview-embed-policy'
import type { SourcePreviewLoadMonitor } from './source-preview-load-monitor'

type SourcePreviewWebRequestOwner = {
  loadMonitor: Pick<SourcePreviewLoadMonitor, 'finishNavigation'>
  embedPolicy: Pick<SourcePreviewEmbedPolicy, 'rewriteResponseHeaders'>
}

type SourcePreviewWebRequestDispatcher = {
  ownersByWebContentsId: Map<number, SourcePreviewWebRequestOwner>
}

const dispatchersBySession = new WeakMap<Session, SourcePreviewWebRequestDispatcher>()

const getHttpStatusText = (statusLine: string): string =>
  statusLine.match(/^HTTP\/\S+\s+\d{3}(?:\s+(.*))?$/u)?.[1] ?? ''

const dispatchResponseHeaders = (
  dispatcher: SourcePreviewWebRequestDispatcher,
  details: OnHeadersReceivedListenerDetails,
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void
): void => {
  const owner =
    details.webContentsId === undefined
      ? undefined
      : dispatcher.ownersByWebContentsId.get(details.webContentsId)
  if (!owner) {
    callback({})
    return
  }

  if (details.resourceType === 'subFrame' && details.statusCode >= 400) {
    owner.loadMonitor.finishNavigation(
      details.frame ?? null,
      details.url,
      details.statusCode,
      getHttpStatusText(details.statusLine)
    )
  }
  const responseHeaders = owner.embedPolicy.rewriteResponseHeaders(details)
  callback(responseHeaders ? { responseHeaders } : {})
}

const registerSourcePreviewWebRequestOwner = (
  session: Session,
  webContentsId: number,
  loadMonitor: Pick<SourcePreviewLoadMonitor, 'finishNavigation'>,
  embedPolicy: Pick<SourcePreviewEmbedPolicy, 'rewriteResponseHeaders'>
): (() => void) => {
  let dispatcher = dispatchersBySession.get(session)
  if (!dispatcher) {
    dispatcher = { ownersByWebContentsId: new Map() }
    dispatchersBySession.set(session, dispatcher)
    const registeredDispatcher = dispatcher
    session.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (details, callback) => {
      dispatchResponseHeaders(registeredDispatcher, details, callback)
    })
  }

  const owner = { loadMonitor, embedPolicy }
  dispatcher.ownersByWebContentsId.set(webContentsId, owner)

  return () => {
    if (dispatcher.ownersByWebContentsId.get(webContentsId) !== owner) return
    dispatcher.ownersByWebContentsId.delete(webContentsId)
    if (dispatcher.ownersByWebContentsId.size > 0) return

    session.webRequest.onHeadersReceived(null)
    dispatchersBySession.delete(session)
  }
}

export { registerSourcePreviewWebRequestOwner }
