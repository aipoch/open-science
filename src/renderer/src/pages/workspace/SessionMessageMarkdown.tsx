/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { SessionMessageLink } from '@/components/streamdown/SessionMessageLink'
import { memo, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Components } from 'streamdown'

import { ArtifactPreview } from './artifact-preview'
import {
  getArtifactName,
  getArtifactPreviewFormat,
  isPendingArtifactPublication
} from './artifact-preview-utils'
import { createPreviewResourceKey } from './previews/preview-resource-key'
import { useManagedPreviewResource } from './previews/useManagedPreviewResource'
import { useNearViewport } from './previews/useNearViewport'
import {
  normalizeSessionArtifactReferences,
  resolveMessageArtifactReference,
  type MessageArtifact
} from './session-message-artifact-reference'

type SessionMessageMarkdownProps = {
  content: string
  isAnimating?: boolean
  artifacts: MessageArtifact[]
  onPreviewArtifact: (artifact: MessageArtifact) => void
  onPreviewArtifactModal: (artifact: MessageArtifact) => void
}

type SessionArtifactImageProps = {
  children?: ReactNode
  node?: unknown
  artifact_ref?: string
  alt_text?: string
}

type SessionMessageLinkComponentProps = ComponentProps<'a'> & {
  node?: unknown
  'data-incomplete'?: boolean
}

type CachedImageGeometry = { naturalWidth: number; aspectRatio: number }

// Rendered-geometry cache keyed like the preview resource (path + size + mtime), so an in-place
// file replacement invalidates itself. Lets the alt-text placeholder reserve the loaded image's
// exact footprint: when the transcript window recycles a far-offscreen message, the remounted
// placeholder matches the image height instead of collapsing back to ~100px and shifting the
// scroll position.
const imageGeometryCache = new Map<string, CachedImageGeometry>()
const IMAGE_GEOMETRY_CACHE_LIMIT = 200

const cacheImageGeometry = (
  requestKey: string,
  naturalWidth: number,
  naturalHeight: number
): void => {
  if (naturalWidth <= 0 || naturalHeight <= 0) return
  imageGeometryCache.delete(requestKey)
  imageGeometryCache.set(requestKey, {
    naturalWidth,
    aspectRatio: naturalWidth / naturalHeight
  })
  if (imageGeometryCache.size <= IMAGE_GEOMETRY_CACHE_LIMIT) return
  const oldestKey = imageGeometryCache.keys().next().value
  if (oldestKey !== undefined) imageGeometryCache.delete(oldestKey)
}

const SessionArtifactImage = ({
  artifact,
  alt,
  onPreview
}: {
  artifact: MessageArtifact
  alt?: string
  onPreview: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const name = getArtifactName(artifact)
  const previewFormat = getArtifactPreviewFormat(artifact)
  const isTiff = previewFormat === 'tiff'
  const publicationPending = isPendingArtifactPublication(artifact)
  const request = {
    path: artifact.path,
    projectId: artifact.resolvedProjectId,
    sessionId: artifact.resolvedSessionId,
    managedFileId: artifact.artifactId,
    source: 'artifact' as const,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs
  }
  const requestKey = createPreviewResourceKey(request)
  const [failedRequestKey, setFailedRequestKey] = useState<string>()
  const [setElement, isNearViewport] = useNearViewport<HTMLButtonElement | HTMLSpanElement>()
  // Latch the first approach: the loaded <img> is much taller than the alt-text placeholder, so
  // releasing the resource when the image leaves the viewport collapses its height, the scroll
  // anchoring compensation then pushes it back inside the observer margin, and the two fight each
  // other in a per-frame jitter loop at the viewport edge. Once acquired, keep the resource.
  const [hasBeenNearViewport, setHasBeenNearViewport] = useState(false)
  if (isNearViewport && !hasBeenNearViewport) {
    setHasBeenNearViewport(true)
  }
  const hasFailed = failedRequestKey === requestKey
  const resourceState = useManagedPreviewResource(
    request,
    !publicationPending && !isTiff && hasBeenNearViewport && !hasFailed
  )
  const accessibleAlt = alt || t('Preview of {{name}}', { name })
  const hasError = hasFailed || resourceState.status === 'error'

  // Header-probed dimensions seed the cache so future placeholders lock the exact height from the
  // first frame, even when this instance's <img> never decodes (lazy loading keeps offscreen
  // images undecoded until the window recycles them). Seeding only fills a missing entry: a
  // measured onLoad value wins because it reflects EXIF orientation as actually displayed.
  const readyResource = resourceState.status === 'ready' ? resourceState.resource : undefined
  const metadataWidth = readyResource?.width
  const metadataHeight = readyResource?.height
  useEffect(() => {
    if (metadataWidth && metadataHeight && !imageGeometryCache.has(requestKey)) {
      cacheImageGeometry(requestKey, metadataWidth, metadataHeight)
    }
  }, [metadataWidth, metadataHeight, requestKey])

  if (publicationPending) {
    return (
      <span ref={setElement} data-session-artifact-image-status="" data-state="loading">
        {accessibleAlt}
      </span>
    )
  }

  if (isTiff) {
    return (
      <button
        ref={setElement}
        type="button"
        data-session-artifact-image=""
        aria-label={t('Preview {{name}}', { name })}
        onClick={onPreview}
      >
        <span data-session-artifact-tiff-preview="">
          <ArtifactPreview
            artifact={artifact}
            projectId={artifact.resolvedProjectId}
            sessionId={artifact.resolvedSessionId}
            managedFileId={artifact.artifactId}
            isVisible={isNearViewport}
          />
        </span>
      </button>
    )
  }

  if (resourceState.status !== 'ready') {
    const cachedGeometry = imageGeometryCache.get(requestKey)
    return (
      <span
        ref={setElement}
        data-session-artifact-image-status=""
        data-state={hasError ? 'error' : 'loading'}
        style={
          cachedGeometry
            ? {
                // Mirror the loaded <img> geometry (natural width capped by max-w-full) so the
                // placeholder reserves the same height and remounts stay scroll-neutral. Hidden
                // overflow keeps the alt text inside tiny locked boxes (e.g. a 32px icon).
                width: `${cachedGeometry.naturalWidth}px`,
                maxWidth: '100%',
                aspectRatio: String(cachedGeometry.aspectRatio),
                overflow: 'hidden'
              }
            : undefined
        }
      >
        {accessibleAlt}
      </span>
    )
  }

  // Explicit width/height let the browser reserve the exact box before (and while) the image
  // decodes; the stylesheet keeps height:auto so max-w-full scaling never distorts the ratio.
  // The cache (measured, or metadata-seeded by the effect above) wins over raw metadata.
  const cachedGeometry = imageGeometryCache.get(requestKey)
  const imgDimensions = cachedGeometry
    ? {
        width: cachedGeometry.naturalWidth,
        height: Math.round(cachedGeometry.naturalWidth / cachedGeometry.aspectRatio)
      }
    : metadataWidth && metadataHeight
      ? { width: metadataWidth, height: metadataHeight }
      : undefined

  return (
    <button
      ref={setElement}
      type="button"
      data-session-artifact-image=""
      aria-label={t('Preview {{name}}', { name })}
      onClick={onPreview}
    >
      <img
        src={resourceState.resource.url}
        alt={accessibleAlt}
        loading="lazy"
        decoding="async"
        draggable={false}
        {...(imgDimensions ? { width: imgDimensions.width, height: imgDimensions.height } : {})}
        onLoad={(event) =>
          cacheImageGeometry(
            requestKey,
            event.currentTarget.naturalWidth,
            event.currentTarget.naturalHeight
          )
        }
        onError={() => setFailedRequestKey(requestKey)}
      />
    </button>
  )
}

const SessionMessageMarkdown = memo(
  ({
    content,
    isAnimating = false,
    artifacts,
    onPreviewArtifact,
    onPreviewArtifactModal
  }: SessionMessageMarkdownProps): React.JSX.Element => {
    const normalizedContent = useMemo(
      () => normalizeSessionArtifactReferences(content, artifacts),
      [artifacts, content]
    )
    const components = useMemo<Components>(
      () => ({
        a: ({
          href,
          className,
          title,
          children,
          'data-incomplete': dataIncomplete
        }: SessionMessageLinkComponentProps) => {
          const artifact = resolveMessageArtifactReference(href, artifacts)
          if (!artifact || artifact.kind !== 'managed-file') {
            return (
              <SessionMessageLink
                href={href}
                className={className}
                title={title}
                data-incomplete={dataIncomplete}
              >
                {children}
              </SessionMessageLink>
            )
          }

          return (
            <button
              type="button"
              className={className}
              disabled={isPendingArtifactPublication(artifact)}
              data-incomplete={dataIncomplete}
              data-session-message-link=""
              data-session-artifact-link=""
              data-streamdown="link"
              onClick={() => onPreviewArtifact(artifact)}
            >
              {children}
            </button>
          )
        },
        'session-artifact-image': ({
          artifact_ref: artifactRef,
          alt_text: alt
        }: SessionArtifactImageProps) => {
          const artifact = resolveMessageArtifactReference(
            artifactRef ? `{{artifact:${artifactRef}}}` : undefined,
            artifacts
          )
          if (
            !artifact ||
            artifact.kind !== 'managed-file' ||
            // The acquire path requires a logical identity (project + managed file id); artifacts
            // persisted before editable versions may lack it, so degrade to the alt text instead
            // of letting the request builder throw inside the effect.
            !artifact.resolvedProjectId ||
            !artifact.artifactId ||
            !['image', 'tiff'].includes(getArtifactPreviewFormat(artifact))
          ) {
            return <>{alt}</>
          }

          return (
            <SessionArtifactImage
              artifact={artifact}
              alt={alt}
              onPreview={() => onPreviewArtifactModal(artifact)}
            />
          )
        }
      }),
      [artifacts, onPreviewArtifact, onPreviewArtifactModal]
    )

    return (
      <PresentedAgentMarkdown
        content={normalizedContent}
        isAnimating={isAnimating}
        sessionLinks
        components={components}
      />
    )
  }
)

SessionMessageMarkdown.displayName = 'SessionMessageMarkdown'

export { SessionMessageMarkdown }
