import { useEffect, useState } from 'react'
import type { SourceLinkMetadata } from '../../../../shared/source-preview'

export function SourceLinkSummary({
  url,
  allowed,
  hostname
}: {
  url: string
  allowed: boolean
  hostname: string
}): React.JSX.Element | null {
  const [metadata, setMetadata] = useState<SourceLinkMetadata>({})
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => {
    if (!allowed) return
    let current = true
    void window.api?.settings?.getSourceLinkMetadata?.(url).then(
      (result) => {
        if (current) setMetadata(result)
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [allowed, url])
  const title = allowed && metadata.title !== hostname && metadata.title
  const description = allowed && metadata.description
  const image = allowed && !imageFailed && metadata.image
  if (!image && !title && !description) return null
  return (
    <div className="border-t border-border-300">
      {image && (
        <img
          src={image}
          alt=""
          className="block max-h-44 w-full object-cover"
          onError={() => setImageFailed(true)}
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
  )
}
