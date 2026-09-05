import {
  PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL,
  isAllowedPreviewContextMenuFrameUrl,
  isPreviewContextMenuRequest,
  type PreviewContextMenuRequest
} from '../shared/preview-context-menu'

export type PreviewContextMenuFrame = Readonly<{
  url: string
  parent: PreviewContextMenuFrame | null
  detached: boolean
  isDestroyed: () => boolean
  executeJavaScript: (code: string) => Promise<unknown>
}>

export type PreviewContextMenuParams = Readonly<{
  x: number
  y: number
  frame: PreviewContextMenuFrame | null
  isEditable: boolean
  formControlType: string
}>

type PreviewContextMenuListener = (event: unknown, params: PreviewContextMenuParams) => void

const PREVIEW_CONTEXT_MENU_PASSTHROUGH_SELECTOR = '[data-preview-context-menu-passthrough]'

const hasSamePreviewFrameIdentity = (initialFrameUrl: string, currentFrameUrl: string): boolean => {
  try {
    const initial = new URL(initialFrameUrl)
    const current = new URL(currentFrameUrl)
    // Managed HTML may navigate within one resource capability; Office sessions stay exact.
    if (initial.protocol === 'open-science-preview:') {
      return current.protocol === initial.protocol && current.hostname === initial.hostname
    }
    return currentFrameUrl === initialFrameUrl
  } catch {
    return false
  }
}

const hasExplicitContextMenuPassthrough = async (
  mainFrame: PreviewContextMenuFrame,
  frame: PreviewContextMenuFrame,
  params: PreviewContextMenuParams,
  frameUrl: string
): Promise<boolean> => {
  let frameLeft = 0
  let frameTop = 0
  try {
    const requestedFrameUrl = new URL(frameUrl)
    const matchResourceIdentity = requestedFrameUrl.protocol === 'open-science-preview:'
    const frameBounds = await mainFrame.executeJavaScript(`(() => {
      const frame = Array.from(document.querySelectorAll('iframe')).find(
        (candidate) => {
          try {
            const candidateUrl = new URL(candidate.src)
            return ${JSON.stringify(matchResourceIdentity)}
              ? candidateUrl.protocol === ${JSON.stringify(requestedFrameUrl.protocol)} &&
                  candidateUrl.hostname === ${JSON.stringify(requestedFrameUrl.hostname)}
              : candidate.src === ${JSON.stringify(frameUrl)}
          } catch {
            return false
          }
        }
      )
      if (!frame) return null
      const bounds = frame.getBoundingClientRect()
      return { left: bounds.left, top: bounds.top }
    })()`)
    if (
      typeof frameBounds === 'object' &&
      frameBounds !== null &&
      'left' in frameBounds &&
      typeof frameBounds.left === 'number' &&
      Number.isFinite(frameBounds.left) &&
      'top' in frameBounds &&
      typeof frameBounds.top === 'number' &&
      Number.isFinite(frameBounds.top)
    ) {
      frameLeft = frameBounds.left
      frameTop = frameBounds.top
    }
  } catch {
    // The child query below still has hover and raw-coordinate fallbacks.
  }

  const code = `(() => {
    const hovered = document.querySelectorAll(':hover')
    const targets = [
      document.elementFromPoint(${JSON.stringify(params.x - frameLeft)}, ${JSON.stringify(params.y - frameTop)}),
      document.elementFromPoint(${JSON.stringify(params.x)}, ${JSON.stringify(params.y)}),
      hovered.item(hovered.length - 1)
    ]
    return targets.some(
      (target) => target instanceof Element && target.closest(${JSON.stringify(PREVIEW_CONTEXT_MENU_PASSTHROUGH_SELECTOR)}) !== null
    )
  })()`
  try {
    return (await frame.executeJavaScript(code)) === true
  } catch {
    // A detached, navigating, or unresponsive frame must not cause the app menu to replace its own.
    return true
  }
}

export type PreviewContextMenuWebContents = Readonly<{
  mainFrame: PreviewContextMenuFrame
  getZoomFactor: () => number
  send: (channel: string, payload: PreviewContextMenuRequest) => void
  on: (event: 'context-menu', listener: PreviewContextMenuListener) => void
  removeListener: (event: 'context-menu', listener: PreviewContextMenuListener) => void
}>

const normalizeContextMenuParams = (
  params: PreviewContextMenuParams,
  zoomFactor: number
): PreviewContextMenuParams => {
  // Electron reports root-view DIPs, while the fixed renderer anchor consumes CSS pixels.
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return {
    x: params.x / scale,
    y: params.y / scale,
    frame: params.frame,
    isEditable: params.isEditable,
    formControlType: params.formControlType
  }
}

export const createPreviewContextMenuRequest = (
  mainFrame: PreviewContextMenuFrame,
  params: PreviewContextMenuParams
): PreviewContextMenuRequest | null => {
  const frame = params.frame
  if (!frame || frame === mainFrame || params.isEditable || params.formControlType !== 'none') {
    return null
  }

  try {
    if (
      frame.isDestroyed() ||
      frame.detached ||
      frame.parent === null ||
      !isAllowedPreviewContextMenuFrameUrl(frame.url)
    ) {
      return null
    }

    const request: PreviewContextMenuRequest = {
      x: params.x,
      y: params.y,
      frameUrl: frame.url
    }
    return isPreviewContextMenuRequest(request) ? request : null
  } catch {
    // WebFrameMain access may throw if the frame detaches between the event and inspection.
    return null
  }
}

export const installPreviewContextMenuBridge = (
  webContents: PreviewContextMenuWebContents
): (() => void) => {
  let disposed = false
  let requestGeneration = 0
  const listener: PreviewContextMenuListener = (_event, params) => {
    const generation = ++requestGeneration
    let mainFrame: PreviewContextMenuFrame
    let normalizedParams: PreviewContextMenuParams
    let initialRequest: PreviewContextMenuRequest | null
    try {
      mainFrame = webContents.mainFrame
      normalizedParams = normalizeContextMenuParams(params, webContents.getZoomFactor())
      initialRequest = createPreviewContextMenuRequest(mainFrame, normalizedParams)
    } catch {
      return
    }
    const frame = normalizedParams.frame
    if (!initialRequest || !frame) return

    void hasExplicitContextMenuPassthrough(
      mainFrame,
      frame,
      normalizedParams,
      initialRequest.frameUrl
    ).then((passthrough) => {
      if (disposed || generation !== requestGeneration || passthrough) return

      try {
        const request = createPreviewContextMenuRequest(webContents.mainFrame, normalizedParams)
        if (request && hasSamePreviewFrameIdentity(initialRequest.frameUrl, request.frameUrl)) {
          webContents.send(PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, request)
        }
      } catch {
        // The window or child frame may disappear while the target query is in flight.
      }
    })
  }
  webContents.on('context-menu', listener)
  return () => {
    disposed = true
    webContents.removeListener('context-menu', listener)
  }
}
