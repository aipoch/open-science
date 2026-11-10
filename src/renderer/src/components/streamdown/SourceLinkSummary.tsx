import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SourceLinkMetadata } from '../../../../shared/source-preview'

type CachedSummary = {
  metadata?: SourceLinkMetadata
  artwork?: string
  metadataRequest?: Promise<SourceLinkMetadata>
  imageRequest?: Promise<string | undefined>
}

// Keep only recent previews in renderer memory; each backend image is limited to 1 MiB.
const summaries = new Map<string, CachedSummary>()
const MAX_CACHED_SUMMARIES = 32

// Test-only reset; production consumers import only the component.
// eslint-disable-next-line react-refresh/only-export-components
export const resetSourceLinkSummaryCacheForTests = (): void => summaries.clear()

function loadSummary(url: string): CachedSummary {
  const cached = summaries.get(url)
  if (cached) {
    summaries.delete(url)
    summaries.set(url, cached)
    return cached
  }
  const entry: CachedSummary = {}
  summaries.set(url, entry)
  if (summaries.size > MAX_CACHED_SUMMARIES) {
    const oldest = summaries.keys().next().value
    if (oldest !== undefined) summaries.delete(oldest)
  }
  const discard = (): void => {
    if (summaries.get(url) === entry) summaries.delete(url)
  }
  entry.metadataRequest = (
    window.api?.settings?.getSourceLinkMetadata?.(url) ?? Promise.resolve<SourceLinkMetadata>({})
  )
    .then(
      (metadata) => {
        entry.metadata = metadata
        if (!metadata.title && !metadata.description && !metadata.imageUrl) discard()
        return metadata
      },
      () => {
        discard()
        return {}
      }
    )
    .finally(() => {
      entry.metadataRequest = undefined
    })
  return entry
}

export function SourceLinkSummary({
  url,
  allowed,
  hostname
}: {
  url: string
  allowed: boolean
  hostname: string
}): React.JSX.Element | null {
  const [metadata, setMetadata] = useState<SourceLinkMetadata>(
    () => summaries.get(url)?.metadata ?? {}
  )
  const [artwork, setArtwork] = useState<string | undefined>(() => summaries.get(url)?.artwork)
  const [imageFailed, setImageFailed] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = (): void => setHeight(content.offsetHeight)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(content)
    return () => observer?.disconnect()
  }, [])
  useEffect(() => {
    if (!allowed) return
    let current = true
    const entry = loadSummary(url)
    void (entry.metadataRequest ?? Promise.resolve(entry.metadata ?? {})).then((result) => {
      if (!current) return
      setMetadata(result)
      setArtwork(entry.artwork)
      if (result.imageUrl && !entry.artwork) {
        entry.imageRequest ??= (
          window.api?.settings?.getSourceLinkImage?.(result.imageUrl) ?? Promise.resolve(undefined)
        )
          .then(
            (image) => {
              entry.artwork = image
              return image
            },
            () => undefined
          )
          .finally(() => {
            entry.imageRequest = undefined
          })
        void entry.imageRequest.then((image) => {
          if (current) setArtwork(image)
        })
      }
    })
    return () => {
      current = false
    }
  }, [allowed, url])
  const title = allowed && metadata.title !== hostname && metadata.title
  const description = allowed && metadata.description
  const image = allowed && !imageFailed && artwork
  return (
    <div
      data-source-preview-summary=""
      style={{ height }}
      className="overflow-hidden transition-[height] duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
    >
      <div
        ref={contentRef}
        className={image || title || description ? 'border-t border-border-300' : undefined}
      >
        {image && (
          <img
            src={image}
            alt=""
            className="block max-h-44 w-full object-cover"
            onError={() => {
              setImageFailed(true)
              const entry = summaries.get(url)
              if (entry?.artwork === image) entry.artwork = undefined
            }}
          />
        )}
        {(title || description) && (
          <div className="space-y-1 px-3 py-2.5">
            {title && (
              <div
                data-source-preview-hover-title=""
                className="line-clamp-2 break-words text-sm font-medium text-text-000"
              >
                {title}
              </div>
            )}
            {description && (
              <div className="line-clamp-2 break-words text-xs text-text-200">{description}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
