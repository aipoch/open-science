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

const isAllowedExternalNavigation = (
  url: string,
  referrerUrl: string,
  currentUrl: string
): boolean =>
  // Only the trusted top-level app may hand an allowlisted URL to the operating system.
  isAllowedExternalUrl(url) && isAllowedMainFrameNavigation(referrerUrl, currentUrl)

export { isAllowedExternalNavigation, isAllowedExternalUrl, isAllowedFrameNavigation }
