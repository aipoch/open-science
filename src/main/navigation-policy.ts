const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const PREVIEW_PROTOCOL = 'open-science-preview:'

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

const isAllowedFrameNavigation = (url: string, isMainFrame: boolean, currentUrl = ''): boolean =>
  isMainFrame
    ? isAllowedMainFrameNavigation(url, currentUrl)
    : getProtocol(url) === PREVIEW_PROTOCOL

// Decides whether a window-open request (target="_blank" / window.open) may be handed to the OS. It
// gates on the protocol allowlist alone, deliberately NOT on the initiating referrer: app links use
// rel="noreferrer" and the packaged app runs on a file:// origin (which Chromium strips from
// cross-origin referrers), so the referrer is reliably empty for legitimate main-frame links. Nothing
// is lost by dropping it — the only non-app frame is the HTML preview iframe, which is sandboxed with
// "allow-scripts" but NOT "allow-popups", so it cannot reach setWindowOpenHandler at all. In-frame
// navigations are confined separately by isAllowedFrameNavigation.
const isAllowedExternalNavigation = (url: string): boolean => isAllowedExternalUrl(url)

export { isAllowedExternalNavigation, isAllowedExternalUrl, isAllowedFrameNavigation }
