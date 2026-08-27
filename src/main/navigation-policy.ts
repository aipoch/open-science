import { OFFICE_PREVIEW_RUNTIME_SCHEME } from './office-preview/office-preview-runtime-protocol'
import { SOURCE_PREVIEW_FRAME_NAME } from '../shared/source-preview'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const ALLOWED_PREVIEW_PROTOCOLS = new Set([
  'open-science-preview:',
  `${OFFICE_PREVIEW_RUNTIME_SCHEME}:`
])

type NavigationFrame = {
  readonly frameTreeNodeId: number
  readonly name: string
  readonly url: string
  readonly parent: NavigationFrame | null
}

type FrameNavigationGuard = {
  (url: string, isMainFrame: boolean, currentUrl?: string, frame?: NavigationFrame | null): boolean
  releaseSource: (sourceUrl: string) => void
  clearAll: () => void
}

type SourcePreviewRootListener = (frame: NavigationFrame, sourceUrl: string) => void

const getProtocol = (url: string): string | undefined => {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}

const isAllowedExternalUrl = (url: string): boolean => {
  const protocol = getProtocol(url)
  return protocol !== undefined && ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)
}

const isAllowedMainFrameNavigation = (url: string, currentUrl: string): boolean => {
  try {
    const target = new URL(url)
    const current = new URL(currentUrl)

    // file: has an opaque origin, so compare the exact app entry path instead of its origin.
    if (current.protocol === 'file:') {
      return (
        target.protocol === 'file:' &&
        target.hostname === current.hostname &&
        target.pathname === current.pathname
      )
    }

    return target.origin === current.origin
  } catch {
    return false
  }
}

const isAllowedSourceDescendantNavigation = (url: string): boolean => {
  try {
    const target = new URL(url)
    if (target.protocol === 'https:') return true
    if (target.protocol === 'about:') {
      return target.pathname === 'blank' || target.pathname === 'srcdoc'
    }
    return target.protocol === 'blob:' && new URL(target.origin).protocol === 'https:'
  } catch {
    return false
  }
}

const createFrameNavigationGuard = (
  mainFrame: NavigationFrame,
  onSourcePreviewRoot?: SourcePreviewRootListener
): FrameNavigationGuard => {
  const sourceUrlsByRootFrameId = new Map<number, string>()

  const releaseSource = (sourceUrl: string): void => {
    for (const [frameTreeNodeId, trackedSourceUrl] of sourceUrlsByRootFrameId) {
      if (trackedSourceUrl === sourceUrl) sourceUrlsByRootFrameId.delete(frameTreeNodeId)
    }
  }

  const guard = ((url, isMainFrame, currentUrl = '', frame): boolean => {
    if (isMainFrame) return isAllowedMainFrameNavigation(url, currentUrl)

    const protocol = getProtocol(url)
    if (frame) {
      for (let ancestor: NavigationFrame | null = frame; ancestor; ancestor = ancestor.parent) {
        if (!sourceUrlsByRootFrameId.has(ancestor.frameTreeNodeId)) continue
        return ancestor.frameTreeNodeId === frame.frameTreeNodeId
          ? protocol === 'https:'
          : isAllowedSourceDescendantNavigation(url)
      }
    }
    if (protocol !== undefined && ALLOWED_PREVIEW_PROTOCOLS.has(protocol)) return true
    if (protocol !== 'https:' || !frame) return false

    // Only the trusted renderer can create this named direct child while it is still blank.
    // Once admitted, Electron's browser-global frame-tree node ID survives wrapper replacement,
    // window.name changes, and redirects without giving scriptable names any authority.
    const isNewSourceRoot =
      frame.name === SOURCE_PREVIEW_FRAME_NAME &&
      frame.parent?.frameTreeNodeId === mainFrame.frameTreeNodeId &&
      (frame.url === '' || frame.url === 'about:blank')
    if (!isNewSourceRoot) return false

    releaseSource(url)
    sourceUrlsByRootFrameId.set(frame.frameTreeNodeId, url)
    onSourcePreviewRoot?.(frame, url)
    return true
  }) as FrameNavigationGuard
  guard.releaseSource = releaseSource
  guard.clearAll = () => sourceUrlsByRootFrameId.clear()
  return guard
}

// Decides whether a window-open request (target="_blank" / window.open) may be handed to the OS. It
// gates on the protocol allowlist alone, deliberately NOT on the initiating referrer: app links use
// rel="noreferrer" and the packaged app runs on a file:// origin (which Chromium strips from
// cross-origin referrers), so the referrer is reliably empty for legitimate main-frame links.
// Source-preview popups reach this handler, but are denied in-app and only allowlisted protocols are
// handed to the OS. In-frame navigations remain confined by the source-preview frame registry.
const isAllowedExternalNavigation = (url: string): boolean => isAllowedExternalUrl(url)

export { createFrameNavigationGuard, isAllowedExternalNavigation, isAllowedExternalUrl }
export type { FrameNavigationGuard }
