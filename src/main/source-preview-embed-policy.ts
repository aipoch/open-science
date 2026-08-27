type SourcePreviewFrame = {
  readonly frameTreeNodeId: number
}

type SourcePreviewResponseDetails = {
  readonly webContentsId?: number
  readonly frame?: SourcePreviewFrame | null
  readonly resourceType: string
  readonly url: string
  readonly statusCode: number
  readonly responseHeaders?: Record<string, string[]>
}

type SourcePreviewEmbedPolicy = {
  registerRoot: (frame: SourcePreviewFrame, sourceUrl: string) => void
  releaseSource: (sourceUrl: string) => void
  clearAll: () => void
  rewriteResponseHeaders: (
    details: SourcePreviewResponseDetails
  ) => Record<string, string[]> | undefined
}

const isHttpsUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

const upgradeHttpUrl = (url: string): string => {
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:') return url
    target.protocol = 'https:'
    return target.toString()
  } catch {
    return url
  }
}

const removeFrameAncestors = (value: string): string | undefined => {
  // Commas separate policies and semicolons separate directives in CSP's serialized grammar.
  const policies = value
    .split(',')
    .map((policy) =>
      policy
        .split(';')
        .map((directive) => directive.trim())
        .filter((directive) => directive.split(/\s+/u, 1)[0]?.toLowerCase() !== 'frame-ancestors')
        .join('; ')
    )
    .filter(Boolean)

  return policies.length > 0 ? policies.join(', ') : undefined
}

const createSourcePreviewEmbedPolicy = (webContentsId: number): SourcePreviewEmbedPolicy => {
  const sourceUrlsByRootFrameId = new Map<number, string>()

  const releaseSource = (sourceUrl: string): void => {
    for (const [frameTreeNodeId, trackedSourceUrl] of sourceUrlsByRootFrameId) {
      if (trackedSourceUrl === sourceUrl) sourceUrlsByRootFrameId.delete(frameTreeNodeId)
    }
  }

  return {
    registerRoot: (frame, sourceUrl) => {
      releaseSource(sourceUrl)
      sourceUrlsByRootFrameId.set(frame.frameTreeNodeId, sourceUrl)
    },
    releaseSource,
    clearAll: () => sourceUrlsByRootFrameId.clear(),
    rewriteResponseHeaders: (details) => {
      if (
        details.webContentsId !== webContentsId ||
        details.resourceType !== 'subFrame' ||
        !details.frame ||
        !sourceUrlsByRootFrameId.has(details.frame.frameTreeNodeId) ||
        !isHttpsUrl(details.url) ||
        !details.responseHeaders
      ) {
        return undefined
      }

      let changed = false
      const responseHeaders: Record<string, string[]> = {}
      for (const [name, values] of Object.entries(details.responseHeaders)) {
        const normalizedName = name.toLowerCase()
        if (
          normalizedName === 'location' &&
          details.statusCode >= 300 &&
          details.statusCode < 400
        ) {
          // Electron applies frame-src before upgrade-insecure-requests to redirect targets. Rewrite
          // only this authenticated HTTPS root's 3xx response so no HTTP request can leave the app.
          responseHeaders[name] = values.map((value) => {
            const rewritten = upgradeHttpUrl(value)
            if (rewritten !== value) changed = true
            return rewritten
          })
          continue
        }
        if (normalizedName === 'x-frame-options') {
          changed = true
          continue
        }
        if (normalizedName !== 'content-security-policy') {
          responseHeaders[name] = [...values]
          continue
        }

        const policies = values.flatMap((value) => {
          const rewritten = removeFrameAncestors(value)
          if (rewritten !== value) changed = true
          return rewritten ? [rewritten] : []
        })
        if (policies.length > 0) responseHeaders[name] = policies
      }

      return changed ? responseHeaders : undefined
    }
  }
}

export { createSourcePreviewEmbedPolicy }
export type { SourcePreviewEmbedPolicy, SourcePreviewResponseDetails }
