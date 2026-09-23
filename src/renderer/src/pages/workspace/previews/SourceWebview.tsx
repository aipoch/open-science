import { useContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type {
  WebviewTag,
  DidStartNavigationEvent,
  DidFrameNavigateEvent,
  DidNavigateInPageEvent,
  DidFailLoadEvent
} from 'electron'
import {
  SOURCE_PREVIEW_PARTITION,
  type SourcePreviewLoadState
} from '../../../../../shared/source-preview'
import { PreviewActionMenuAdapterContext } from '../preview-actions/preview-action-adapter-context'

// A connected custom element can still be waiting for Electron's asynchronous guest attachment.
const getGuestId = (guest: WebviewTag): number | undefined => {
  try {
    return guest.getWebContentsId()
  } catch {
    return undefined
  }
}

// Own one connected guest for the lifetime of a source tab. React never writes its src on updates;
// StrictMode's effect replay only replaces subscriptions, not the DOM node or browsing context.
export const SourceWebview = ({
  sourceUrl,
  title,
  webviewRef,
  onState
}: {
  sourceUrl: string
  title: string
  webviewRef: RefObject<WebviewTag | null>
  onState: (state: SourcePreviewLoadState) => void
}): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapter = useContext(PreviewActionMenuAdapterContext)
  useLayoutEffect(() => {
    const host = hostRef.current!
    const guest = webviewRef.current ?? (document.createElement('webview') as WebviewTag)
    webviewRef.current = guest
    let navigationId = 0
    let lastState: SourcePreviewLoadState = {
      sourceUrl,
      currentUrl: sourceUrl,
      navigationId,
      phase: 'loading'
    }
    const publish = (state: SourcePreviewLoadState): void => {
      lastState = state
      onState(state)
    }
    const start = (event: DidStartNavigationEvent): void => {
      if (event.isMainFrame && !event.isInPlace)
        publish({
          sourceUrl,
          currentUrl: event.url,
          navigationId: ++navigationId,
          phase: 'loading'
        })
    }
    const navigate = (event: DidFrameNavigateEvent): void => {
      if (!event.isMainFrame) return
      const base = {
        sourceUrl,
        currentUrl: event.url,
        navigationId,
        httpStatusCode: event.httpResponseCode,
        httpStatusText: event.httpStatusText
      }
      publish(
        event.httpResponseCode >= 400
          ? { ...base, phase: 'failed', failure: 'http' }
          : { ...base, phase: 'loaded' }
      )
    }
    const inPage = (event: DidNavigateInPageEvent): void => {
      if (event.isMainFrame) publish({ ...lastState, currentUrl: event.url })
    }
    const fail = (event: DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === -3) return
      publish({
        sourceUrl,
        currentUrl: event.validatedURL || lastState.currentUrl,
        navigationId,
        phase: 'failed',
        failure: [-20, -27, -30].includes(event.errorCode)
          ? 'blocked'
          : event.errorCode <= -200 && event.errorCode > -300
            ? 'certificate'
            : 'network',
        errorCode: event.errorCode,
        errorDescription: event.errorDescription
      })
    }
    const gone = (): void =>
      publish({
        sourceUrl,
        currentUrl: lastState.currentUrl,
        navigationId,
        phase: 'failed',
        failure: 'network'
      })
    guest.addEventListener('did-start-navigation', start)
    guest.addEventListener('did-frame-navigate', navigate)
    guest.addEventListener('did-navigate-in-page', inPage)
    guest.addEventListener('did-fail-load', fail)
    guest.addEventListener('render-process-gone', gone)
    const unsubscribeBlocked = window.api.sourcePreview?.onNavigationBlocked?.((request) => {
      if (
        !guest.isConnected ||
        request.guestId !== getGuestId(guest) ||
        request.navigationId !== navigationId
      )
        return
      publish({
        sourceUrl,
        currentUrl: request.url,
        navigationId,
        phase: 'failed',
        failure: 'blocked'
      })
    })
    if (!guest.hasAttribute('src')) {
      guest.setAttribute('data-source-preview-frame', '')
      guest.setAttribute('data-source-url', sourceUrl)
      guest.setAttribute('class', 'absolute inset-0 flex size-full bg-white')
      guest.setAttribute('partition', SOURCE_PREVIEW_PARTITION)
      guest.setAttribute('src', sourceUrl)
      host.appendChild(guest)
    }
    return () => {
      unsubscribeBlocked?.()
      guest.removeEventListener('did-start-navigation', start)
      guest.removeEventListener('did-frame-navigate', navigate)
      guest.removeEventListener('did-navigate-in-page', inPage)
      guest.removeEventListener('did-fail-load', fail)
      guest.removeEventListener('render-process-gone', gone)
    }
  }, [sourceUrl, webviewRef, onState])
  useEffect(() => {
    webviewRef.current?.setAttribute('title', title)
  }, [title, webviewRef])
  useEffect(
    () =>
      window.api.sourcePreview?.onContextMenu((request) => {
        const guest = webviewRef.current
        if (
          !adapter ||
          !guest?.isConnected ||
          guest.closest('[hidden], [inert]') ||
          guest.getClientRects().length === 0
        )
          return
        // This synchronous API is used only for a user-initiated context menu, never layout or polling.
        if (request.guestId !== getGuestId(guest)) return
        if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) return
        // Electron reports guest/OOPIF context-menu coordinates in the host viewport.
        // Main has already normalized DIP by host zoom; adding the guest offset doubles it.
        adapter.openContextMenu({ x: request.x, y: request.y }, guest)
      }),
    [adapter, webviewRef]
  )
  return <div ref={hostRef} className="absolute inset-0" />
}
