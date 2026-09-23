const SOURCE_PREVIEW_FRAME_NAME = 'open-science-source-preview'
const SOURCE_PREVIEW_PARTITION = 'persist:open-science-source-preview-v1'
// Retain ordinary origin-scoped storage and let a user gesture request unpartitioned cookies.
const SOURCE_PREVIEW_SANDBOX =
  'allow-same-origin allow-scripts allow-forms allow-storage-access-by-user-activation'
const SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL = 'source-preview:navigation-blocked'
const SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL = 'source-preview:context-menu'

type SourcePreviewNavigationBlocked = { guestId: number; url: string; navigationId: number }
type SourcePreviewContextMenuRequest = { guestId: number; x: number; y: number }

type SourcePreviewLoadBase = {
  navigationId: number
  sourceUrl: string
  currentUrl: string
}

type SourcePreviewLoadState =
  | (SourcePreviewLoadBase & { phase: 'loading' })
  | (SourcePreviewLoadBase & {
      phase: 'loaded'
      httpStatusCode: number
      httpStatusText: string
    })
  | (SourcePreviewLoadBase & {
      phase: 'failed'
      failure: 'blocked' | 'certificate' | 'http' | 'network'
      errorCode?: number
      errorDescription?: string
      httpStatusCode?: number
      httpStatusText?: string
    })

const parseHttpsSourceUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined

    return url
  } catch {
    return undefined
  }
}

export {
  SOURCE_PREVIEW_FRAME_NAME,
  SOURCE_PREVIEW_PARTITION,
  SOURCE_PREVIEW_SANDBOX,
  SOURCE_PREVIEW_CONTEXT_MENU_CHANNEL,
  SOURCE_PREVIEW_NAVIGATION_BLOCKED_CHANNEL,
  parseHttpsSourceUrl
}
export type {
  SourcePreviewLoadState,
  SourcePreviewContextMenuRequest,
  SourcePreviewNavigationBlocked
}
