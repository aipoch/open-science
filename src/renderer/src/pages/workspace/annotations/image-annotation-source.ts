import type { ImagePointAnnotation } from '../../../../../shared/annotations'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { parseUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

type ImagePointAnnotationSource = ImagePointAnnotation['source']

const SUPPORTED_STATIC_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])
const STATIC_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif'
}

const staticImageMimeType = (name: string, mimeType?: string): string | undefined => {
  const essence = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (essence && essence !== 'application/octet-stream' && essence !== 'binary/octet-stream') {
    return SUPPORTED_STATIC_IMAGE_MIME.has(essence) ? essence : undefined
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return STATIC_IMAGE_MIME_BY_EXTENSION[extension]
}

// This is deliberately fail-closed and version-locator based. Ticket 05 can re-run the same
// resolver before send and add an async readability check without changing the annotation model.
const imagePointAnnotationSourceForPreview = (
  item: PreviewFileItem
): ImagePointAnnotationSource | undefined => {
  const mimeType = staticImageMimeType(item.name, item.mimeType)
  if (!mimeType || item.format !== 'image') return undefined

  if (item.source === 'upload') {
    const identity = parseUploadVersionReference(item.path)
    const projectId = identity?.projectId
    const sessionId = identity?.sessionId
    if (
      !identity ||
      !projectId ||
      !sessionId ||
      projectId !== item.projectId ||
      sessionId !== item.sessionId
    ) {
      return undefined
    }
    return {
      kind: 'upload-version',
      projectId,
      sessionId,
      versionId: identity.versionId,
      name: item.name,
      path: item.path,
      mimeType
    }
  }

  if (item.source && item.source !== 'artifact') return undefined
  const identity = parseArtifactVersionLocator(item.path)
  if (
    !identity ||
    identity.projectId !== item.projectId ||
    identity.appSessionId !== item.sessionId ||
    identity.artifactId !== item.artifactId ||
    identity.versionId !== item.selectedVersionId
  ) {
    return undefined
  }
  return {
    kind: 'artifact-version',
    projectId: identity.projectId,
    sessionId: identity.appSessionId,
    versionId: identity.versionId,
    name: item.name,
    path: item.path,
    mimeType
  }
}

export { imagePointAnnotationSourceForPreview, staticImageMimeType }
export type { ImagePointAnnotationSource }
