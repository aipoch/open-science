import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import type { TextAnnotation } from '../../../../../shared/annotations'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { parseUploadVersionReference } from '../../../../../shared/uploads'

// These values, rather than the surrounding preview projection's object identity, own
// annotation matching, reveal subscriptions and observer callbacks.
type AnnotationPreviewItem = Pick<
  PreviewFileItem,
  | 'id'
  | 'projectId'
  | 'path'
  | 'name'
  | 'source'
  | 'managedFileId'
  | 'selectedVersionId'
  | 'sessionId'
>

const projectFileVersionId = (
  item: AnnotationPreviewItem,
  annotationVersionId?: string
): string | undefined =>
  annotationVersionId ??
  item.selectedVersionId ??
  (item.source === 'upload'
    ? parseUploadVersionReference(item.path)?.versionId
    : parseArtifactVersionLocator(item.path)?.versionId)

const projectFileSource = (
  item: AnnotationPreviewItem,
  pageNumber?: number,
  annotationVersionId?: string,
  annotationVersionPending = false
): TextAnnotation['source'] | undefined => {
  if (!item.projectId || pageNumber !== undefined) return undefined
  const versionId = projectFileVersionId(item, annotationVersionId)
  // Managed annotations stay unavailable until inspection confirms the exact visible Version.
  if (item.managedFileId && (annotationVersionPending || !versionId)) return undefined
  return {
    kind: 'project-file',
    projectId: item.projectId,
    path: item.path,
    name: item.name,
    ...(item.managedFileId
      ? {
          fileSource: item.source === 'upload' ? ('upload' as const) : ('artifact' as const),
          sourceFileId: item.managedFileId
        }
      : {}),
    ...(versionId ? { versionId } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {})
  }
}

type ProjectFileSourceStatus =
  | { ok: true; source: TextAnnotation['source'] }
  | {
      ok: false
      reason: 'version-pending' | 'version-unresolved'
      source: TextAnnotation['source'] | undefined
    }

// Classifies why a managed preview item cannot produce a saveable source, so the
// surface can explain it instead of offering a save that fail-closed validation
// will reject with a generic error. Raw (unmanaged) files always resolve here;
// their authorization is still enforced by the main-process gates.
//
// The session comparison mirrors BookmarkService.validateNewSource exactly: a
// project-file source whose sessionId differs from the requesting scope is
// rejected there, so flagging it here can never block a save that would succeed.
const projectFileSourceStatus = (
  item: AnnotationPreviewItem,
  pageNumber?: number,
  annotationVersionId?: string,
  annotationVersionPending = false,
  scopeSessionId?: string
): ProjectFileSourceStatus => {
  // The returned source keeps the exact projectFileSource value (possibly a stale
  // but well-formed identity) so the editor still opens: blocking is expressed
  // only through ok/reason, and fail-closed IPC validation stays authoritative.
  const source = projectFileSource(item, pageNumber, annotationVersionId, annotationVersionPending)
  if (item.managedFileId && annotationVersionPending)
    return { ok: false, reason: 'version-pending', source }
  if (!source) return { ok: false, reason: 'version-unresolved', source }
  if (scopeSessionId && item.sessionId !== scopeSessionId)
    return { ok: false, reason: 'version-unresolved', source }
  return { ok: true, source }
}

export type { AnnotationPreviewItem, ProjectFileSourceStatus }
export { projectFileSource, projectFileSourceStatus, projectFileVersionId }
