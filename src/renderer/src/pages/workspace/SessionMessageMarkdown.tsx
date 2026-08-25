/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { PresentedAgentMarkdown, SessionMessageLink } from '@/components/streamdown/AgentMarkdown'
import { memo, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Components } from 'streamdown'

import { ArtifactPreview } from './artifact-preview'
import { getArtifactName, getArtifactPreviewFormat } from './artifact-preview-utils'
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
  const request = {
    path: artifact.path,
    projectId: artifact.resolvedProjectId,
    sessionId: artifact.resolvedSessionId,
    source: 'artifact' as const,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs
  }
  const requestKey = createPreviewResourceKey(request)
  const [failedRequestKey, setFailedRequestKey] = useState<string>()
  const [setElement, isNearViewport] = useNearViewport<HTMLButtonElement | HTMLSpanElement>()
  const hasFailed = failedRequestKey === requestKey
  const resourceState = useManagedPreviewResource(request, !isTiff && isNearViewport && !hasFailed)
  const accessibleAlt = alt || t('Preview of {{name}}', { name })
  const hasError = hasFailed || resourceState.status === 'error'

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
            isVisible={isNearViewport}
          />
        </span>
      </button>
    )
  }

  if (resourceState.status !== 'ready') {
    return (
      <span
        ref={setElement}
        data-session-artifact-image-status=""
        data-state={hasError ? 'error' : 'loading'}
      >
        {accessibleAlt}
      </span>
    )
  }

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
          children,
          'data-incomplete': dataIncomplete
        }: SessionMessageLinkComponentProps) => {
          const artifact = resolveMessageArtifactReference(href, artifacts)
          if (!artifact || artifact.kind !== 'managed-file') {
            return (
              <SessionMessageLink
                href={href}
                className={className}
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
