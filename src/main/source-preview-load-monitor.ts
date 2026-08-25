import type { SourcePreviewLoadState } from '../shared/source-preview'

type SourcePreviewFrame = {
  readonly frameTreeNodeId: number
  readonly processId?: number
  readonly routingId?: number
}

type SourcePreviewFrameIdentity =
  SourcePreviewFrame | { readonly processId: number; readonly routingId: number }

type SourcePreviewLoadMonitor = {
  registerRoot: (frame: SourcePreviewFrame, sourceUrl: string) => void
  startNavigation: (
    frame: SourcePreviewFrameIdentity | null,
    currentUrl: string,
    isSameDocument: boolean
  ) => void
  finishNavigation: (
    frame: SourcePreviewFrameIdentity | null,
    currentUrl: string,
    httpStatusCode: number,
    httpStatusText: string
  ) => void
  failNavigation: (
    frame: SourcePreviewFrameIdentity | null,
    currentUrl: string,
    errorCode: number,
    errorDescription: string
  ) => void
}

type TrackedSourceRoot = {
  sourceUrl: string
  currentUrl: string
  navigationId: number
}

const BLOCKED_ERROR_CODES = new Set([-27, -20])
const ABORTED_ERROR_CODE = -3

const classifyLoadFailure = (
  errorCode: number
): Extract<SourcePreviewLoadState, { phase: 'failed' }>['failure'] => {
  if (BLOCKED_ERROR_CODES.has(errorCode)) return 'blocked'
  if (errorCode <= -200 && errorCode > -300) return 'certificate'
  return 'network'
}

// Observes the existing iframe lifecycle only. It never creates or owns a native WebContentsView,
// so renderer overlays remain ordinary DOM layers above the remote page.
const createSourcePreviewLoadMonitor = (
  publish: (state: SourcePreviewLoadState) => void
): SourcePreviewLoadMonitor => {
  const roots = new Map<number, TrackedSourceRoot>()
  const rootIdsByRoutingIdentity = new Map<string, number>()
  let nextNavigationId = 0

  const getRoutingIdentity = (frame: SourcePreviewFrameIdentity): string | undefined =>
    frame.processId === undefined || frame.routingId === undefined
      ? undefined
      : `${frame.processId}:${frame.routingId}`

  const rememberRoutingIdentity = (
    frame: SourcePreviewFrameIdentity,
    frameTreeNodeId: number
  ): void => {
    const routingIdentity = getRoutingIdentity(frame)
    if (routingIdentity) rootIdsByRoutingIdentity.set(routingIdentity, frameTreeNodeId)
  }

  const getActiveRoot = (
    frame: SourcePreviewFrameIdentity | null
  ): TrackedSourceRoot | undefined => {
    if (!frame) return undefined
    const frameTreeNodeId =
      'frameTreeNodeId' in frame
        ? frame.frameTreeNodeId
        : rootIdsByRoutingIdentity.get(getRoutingIdentity(frame) ?? '')
    if (frameTreeNodeId === undefined) return undefined
    const root = roots.get(frameTreeNodeId)
    return root
  }

  return {
    registerRoot: (frame, sourceUrl) => {
      const root = {
        sourceUrl,
        currentUrl: sourceUrl,
        navigationId: ++nextNavigationId
      }
      roots.set(frame.frameTreeNodeId, root)
      rememberRoutingIdentity(frame, frame.frameTreeNodeId)
      publish({
        navigationId: root.navigationId,
        sourceUrl,
        currentUrl: sourceUrl,
        phase: 'loading'
      })
    },
    startNavigation: (frame, currentUrl, isSameDocument) => {
      if (!frame || isSameDocument) return
      const frameTreeNodeId =
        'frameTreeNodeId' in frame
          ? frame.frameTreeNodeId
          : rootIdsByRoutingIdentity.get(getRoutingIdentity(frame) ?? '')
      if (frameTreeNodeId === undefined) return
      const root = roots.get(frameTreeNodeId)
      if (!root) return

      rememberRoutingIdentity(frame, frameTreeNodeId)
      if (root.currentUrl === currentUrl) return
      root.currentUrl = currentUrl
      root.navigationId = ++nextNavigationId
      publish({
        navigationId: root.navigationId,
        sourceUrl: root.sourceUrl,
        currentUrl,
        phase: 'loading'
      })
    },
    finishNavigation: (frame, currentUrl, httpStatusCode, httpStatusText) => {
      const root = getActiveRoot(frame)
      if (!root) return

      if (httpStatusCode >= 400) {
        publish({
          navigationId: root.navigationId,
          sourceUrl: root.sourceUrl,
          currentUrl,
          phase: 'failed',
          failure: 'http',
          httpStatusCode,
          httpStatusText
        })
        return
      }

      publish({
        navigationId: root.navigationId,
        sourceUrl: root.sourceUrl,
        currentUrl,
        phase: 'loaded',
        httpStatusCode,
        httpStatusText
      })
    },
    failNavigation: (frame, currentUrl, errorCode, errorDescription) => {
      // Chromium reports ERR_ABORTED for superseded redirects and window.stop(); treating it as a
      // terminal failure would flash a false error before the replacement navigation starts.
      if (errorCode === ABORTED_ERROR_CODE) return
      const root = getActiveRoot(frame)
      if (!root) return

      publish({
        navigationId: root.navigationId,
        sourceUrl: root.sourceUrl,
        currentUrl,
        phase: 'failed',
        failure: classifyLoadFailure(errorCode),
        errorCode,
        errorDescription
      })
    }
  }
}

export { createSourcePreviewLoadMonitor }
export type { SourcePreviewLoadMonitor }
