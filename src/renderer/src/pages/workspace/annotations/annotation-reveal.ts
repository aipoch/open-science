import {
  resolveManagedProjectFileAnnotationIdentity,
  type Annotation,
  type ManagedProjectFileAnnotationIdentity
} from '../../../../../shared/annotations'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { parseUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

import { createPreviewFileItem } from '../preview-file-item'

// Composer chips cannot reach their source surfaces directly. This module owns
// file-tab activation/reconstruction and publishes one generic reveal request
// that text ranges and image pins can both claim after their surface mounts.
const REVEAL_EVENT = 'annotation-reveal'
const REVEAL_PREPARE_EVENT = 'annotation-reveal-prepare'
const REVEAL_HIGHLIGHT_NAME = 'agent-annotation-reveal'
const REVEAL_DURATION_MS = 1_600
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let revealedRange: Range | undefined
let revealTimer: ReturnType<typeof setTimeout> | undefined
let pendingRevealId: string | undefined
let pendingRevealAnnotation: Annotation | undefined

const fileAnnotationSource = (
  annotation: Annotation
):
  | Extract<Annotation, { kind: 'image-point' | 'pdf' }>['source']
  | Extract<Extract<Annotation, { kind: 'text' }>['source'], { kind: 'project-file' }>
  | undefined => {
  if (annotation.kind !== 'text') return annotation.source
  return annotation.source.kind === 'project-file' ? annotation.source : undefined
}

const publishAnnotationReveal = (annotation: Annotation): void => {
  pendingRevealId = annotation.id
  pendingRevealAnnotation = annotation.kind === 'pdf' ? annotation : undefined
  document.dispatchEvent(new CustomEvent(REVEAL_PREPARE_EVENT, { detail: annotation }))
  document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: annotation.id }))
}

const subscribeAnnotationReveal = (
  listener: (annotationId: string) => boolean | void
): (() => void) => {
  const deliver = (annotationId: string): void => {
    if (!listener(annotationId)) return
    if (pendingRevealId === annotationId) {
      pendingRevealId = undefined
      pendingRevealAnnotation = undefined
    }
  }
  const handler = (event: Event): void => deliver((event as CustomEvent<string>).detail)
  document.addEventListener(REVEAL_EVENT, handler)
  if (pendingRevealId) deliver(pendingRevealId)
  return () => document.removeEventListener(REVEAL_EVENT, handler)
}

const subscribeAnnotationRevealPreparation = (
  listener: (annotation: Annotation) => void
): (() => void) => {
  const handler = (event: Event): void => listener((event as CustomEvent<Annotation>).detail)
  document.addEventListener(REVEAL_PREPARE_EVENT, handler)
  if (pendingRevealAnnotation) listener(pendingRevealAnnotation)
  return () => document.removeEventListener(REVEAL_PREPARE_EVENT, handler)
}

const retryPendingAnnotationReveal = (): void => {
  if (pendingRevealId) {
    document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: pendingRevealId }))
  }
}

const managedAnnotationIdentity = (
  source: NonNullable<ReturnType<typeof fileAnnotationSource>>
): ManagedProjectFileAnnotationIdentity | null | undefined => {
  if (source.kind === 'project-file') {
    return resolveManagedProjectFileAnnotationIdentity(source)
  }
  if (source.kind === 'artifact-version') {
    const artifact = parseArtifactVersionLocator(source.path)
    if (
      !artifact ||
      artifact.projectId !== source.projectId ||
      artifact.appSessionId !== source.sessionId ||
      artifact.versionId !== source.versionId
    ) {
      return null
    }
    return {
      fileSource: 'artifact',
      fileId: artifact.artifactId,
      versionId: artifact.versionId
    }
  }
  const upload = parseUploadVersionReference(source.path)
  if (
    !upload ||
    (upload.projectId !== undefined && upload.projectId !== source.projectId) ||
    (upload.sessionId !== undefined && upload.sessionId !== source.sessionId) ||
    upload.versionId !== source.versionId
  ) {
    return null
  }
  return upload.fileId
    ? { fileSource: 'upload', fileId: upload.fileId, versionId: upload.versionId }
    : undefined
}

const fileSourceMatchesItem = (annotation: Annotation, item: PreviewFileItem): boolean => {
  const source = fileAnnotationSource(annotation)
  if (!source) return false
  if (item.projectId !== source.projectId) return false
  const managedIdentity = managedAnnotationIdentity(source)
  if (managedIdentity === null) return false
  const itemFileSource = item.source === 'upload' ? 'upload' : 'artifact'
  const matchesManagedIdentity =
    managedIdentity !== undefined &&
    managedIdentity.fileId === item.managedFileId &&
    managedIdentity.fileSource === itemFileSource
  if (!matchesManagedIdentity && item.path !== source.path) return false
  const itemVersionId =
    item.selectedVersionId ??
    parseArtifactVersionLocator(item.path)?.versionId ??
    parseUploadVersionReference(item.path)?.versionId
  const sourceVersionId = managedIdentity?.versionId ?? source.versionId
  if (sourceVersionId || itemVersionId) return sourceVersionId === itemVersionId
  return true
}

const sourceName = (path: string, name?: string): string =>
  name ?? path.split(/[\\/]/).at(-1) ?? path

const createAnnotationPreviewItem = (annotation: Annotation): PreviewFileItem | undefined => {
  const source = fileAnnotationSource(annotation)
  if (!source) return undefined

  const artifact = parseArtifactVersionLocator(source.path)
  const upload = parseUploadVersionReference(source.path)
  const managedIdentity = managedAnnotationIdentity(source)
  if (managedIdentity === null) return undefined
  const projectId = source.projectId
  const sessionId = source.sessionId ?? artifact?.appSessionId ?? upload?.sessionId
  if (!sessionId) return undefined

  const name = sourceName(source.path, source.name)
  const versionId =
    managedIdentity?.versionId ?? source.versionId ?? artifact?.versionId ?? upload?.versionId
  // A reopened managed tab keeps the stable logical file identity separate from its exact Version.
  const uploadFileId = managedIdentity?.fileSource === 'upload' ? managedIdentity.fileId : undefined
  const artifactFileId =
    managedIdentity?.fileSource === 'artifact' ? managedIdentity.fileId : undefined
  const managedFileId = artifactFileId ?? uploadFileId
  return createPreviewFileItem({
    id:
      artifactFileId ??
      (uploadFileId
        ? `upload:${uploadFileId}`
        : upload
          ? `upload:${upload.versionId}`
          : `file:${projectId}:${source.path}`),
    projectId,
    sessionId,
    path: source.path,
    name,
    mimeType:
      annotation.kind === 'image-point'
        ? annotation.source.mimeType
        : annotation.kind === 'pdf'
          ? 'application/pdf'
          : undefined,
    source: uploadFileId ? 'upload' : undefined,
    artifactId: artifactFileId,
    managedFileId,
    selectedVersionId: managedFileId ? versionId : undefined
  })
}

const requestAnnotationReveal = (annotation: Annotation): void => {
  if (!fileAnnotationSource(annotation)) {
    publishAnnotationReveal(annotation)
    return
  }

  const workbench = usePreviewWorkbenchStore.getState()
  const existing = workbench.items.find(
    (item) => item.type === 'file' && fileSourceMatchesItem(annotation, item)
  )
  const item = existing ?? createAnnotationPreviewItem(annotation)
  if (!item) return

  workbench.upsertAndActivateItem(item)
  publishAnnotationReveal(annotation)
}

const annotationRevealScrollBehavior = (): ScrollBehavior =>
  typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(REDUCED_MOTION_QUERY).matches
    ? 'auto'
    : 'smooth'

const revealTextAnnotationRange = (range: Range): void => {
  range.startContainer.parentElement?.scrollIntoView({
    block: 'center',
    behavior: annotationRevealScrollBehavior()
  })
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return

  const highlight = globalThis.CSS.highlights.get(REVEAL_HIGHLIGHT_NAME) ?? new Highlight()
  if (revealedRange) highlight.delete(revealedRange)
  highlight.add(range)
  globalThis.CSS.highlights.set(REVEAL_HIGHLIGHT_NAME, highlight)
  revealedRange = range

  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    if (revealedRange) highlight.delete(revealedRange)
    revealedRange = undefined
  }, REVEAL_DURATION_MS)
}

export {
  annotationRevealScrollBehavior,
  requestAnnotationReveal,
  retryPendingAnnotationReveal,
  revealTextAnnotationRange,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
}
