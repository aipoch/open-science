import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { PptSlideAnnotation } from '../../../../../shared/annotation-contract'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-version-locator'
import { parseUploadVersionReference } from '../../../../../shared/uploads'

type PptxAnnotationSource = PptSlideAnnotation['source']

// Fail closed: only an immutable version locator that matches the open item can be annotated.
const pptxAnnotationSourceForPreview = (
  item: PreviewFileItem
): PptxAnnotationSource | undefined => {
  if (!item.name.toLowerCase().endsWith('.pptx')) return undefined

  if (item.source === 'upload') {
    const identity = parseUploadVersionReference(item.path)
    const projectId = identity?.projectId
    const sessionId = identity?.sessionId
    const fileId = identity?.fileId
    if (
      !identity ||
      !projectId ||
      !sessionId ||
      !fileId ||
      projectId !== item.projectId ||
      sessionId !== item.sessionId ||
      fileId !== item.managedFileId
    ) {
      return undefined
    }
    return {
      kind: 'upload-version',
      projectId,
      sessionId,
      versionId: identity.versionId,
      name: item.name,
      path: item.path
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
    path: item.path
  }
}

export { pptxAnnotationSourceForPreview }
export type { PptxAnnotationSource }
