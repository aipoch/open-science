import type { TFunction } from 'i18next'

import {
  imageAnnotationSourceIsFixed,
  imageVersionKey,
  type Annotation,
  type ImagePointAnnotation
} from '../../../../../shared/annotations'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import type { AcquireManagedPreviewRequest } from '../../../../../shared/preview-resources'
import { parseUploadVersionReference } from '../../../../../shared/uploads'

type PreviewResourceValidationApi = Pick<Window['api']['previewResources'], 'acquire' | 'release'>

const IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE =
  'An annotated image is no longer available. Restore access to its fixed version or remove the annotation, then try again.'

const imageAnnotationSourceError = (
  error: string | null | undefined
): typeof IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE | undefined => {
  const message = error?.trim()
  return message === IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE ||
    message?.endsWith(`Error: ${IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE}`)
    ? IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE
    : undefined
}

const localizeImageAnnotationSourceError = (
  error: string | null | undefined,
  t: TFunction
): string | undefined => {
  const key = imageAnnotationSourceError(error)
  return key ? t(key) : undefined
}

const acquireRequest = (source: ImagePointAnnotation['source']): AcquireManagedPreviewRequest => {
  if (source.kind === 'artifact-version') {
    const identity = parseArtifactVersionLocator(source.path)
    if (!identity) throw new Error(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE)
    return {
      source: 'artifact',
      projectId: source.projectId,
      fileId: identity.artifactId,
      versionId: source.versionId,
      mimeType: source.mimeType
    }
  }

  const identity = parseUploadVersionReference(source.path)
  if (!identity?.fileId) throw new Error(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE)
  return {
    source: 'upload',
    projectId: source.projectId,
    fileId: identity.fileId,
    versionId: source.versionId,
    mimeType: source.mimeType
  }
}

// Acquiring the exact immutable locator exercises the same main-process scope, existence, and
// permission checks used when the prompt later resolves the file reference. Capabilities are
// released immediately: this is a send admission check, not a second preview owner.
const validateImageAnnotationSourcesBeforeSend = async (
  annotations: readonly Annotation[],
  resources?: PreviewResourceValidationApi
): Promise<void> => {
  const checked = new Set<string>()
  for (const annotation of annotations) {
    if (annotation.kind !== 'image-point') continue
    const key = imageVersionKey(annotation.source)
    if (checked.has(key)) continue
    checked.add(key)
    if (!imageAnnotationSourceIsFixed(annotation.source)) {
      throw new Error(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE)
    }
    const previewResources = resources ?? window.api.previewResources
    let resourceId: string | undefined
    try {
      const resource = await previewResources.acquire(acquireRequest(annotation.source))
      resourceId = resource.id
    } catch {
      throw new Error(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE)
    } finally {
      if (resourceId) await previewResources.release({ resourceId }).catch(() => undefined)
    }
  }
}

export {
  IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE,
  imageAnnotationSourceError,
  localizeImageAnnotationSourceError,
  validateImageAnnotationSourcesBeforeSend
}
