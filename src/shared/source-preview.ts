const SOURCE_PREVIEW_FRAME_NAME = 'open-science-source-preview'
const SOURCE_PREVIEW_LOAD_STATE_CHANNEL = 'source-preview:load-state'
const SOURCE_PREVIEW_RELEASE_CHANNEL = 'source-preview:release'

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
  SOURCE_PREVIEW_LOAD_STATE_CHANNEL,
  SOURCE_PREVIEW_RELEASE_CHANNEL,
  parseHttpsSourceUrl
}
export type { SourcePreviewLoadState }
