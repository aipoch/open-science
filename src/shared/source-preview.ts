const SOURCE_PREVIEW_FRAME_NAME = 'open-science-source-preview'

const parseHttpsSourceUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined

    return url
  } catch {
    return undefined
  }
}

export { SOURCE_PREVIEW_FRAME_NAME, parseHttpsSourceUrl }
