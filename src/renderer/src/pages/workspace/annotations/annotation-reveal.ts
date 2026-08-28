import type { Annotation } from '../../../../../shared/annotations'
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

let revealedRange: Range | undefined
let revealTimer: ReturnType<typeof setTimeout> | undefined
let pendingRevealId: string | undefined

const publishAnnotationReveal = (annotationId: string): void => {
  pendingRevealId = annotationId
  document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: annotationId }))
}

const subscribeAnnotationReveal = (
  listener: (annotationId: string) => boolean | void
): (() => void) => {
  const deliver = (annotationId: string): void => {
    if (!listener(annotationId)) return
    if (pendingRevealId === annotationId) pendingRevealId = undefined
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
  return () => document.removeEventListener(REVEAL_PREPARE_EVENT, handler)
}

const fileSourceMatchesItem = (annotation: Annotation, item: PreviewFileItem): boolean => {
  const source = annotation.source
  if (source.kind === 'agent-message' || source.kind === 'session-item') return false
  if (item.projectId !== source.projectId || item.path !== source.path) return false
  const itemVersionId =
    item.selectedVersionId ??
    parseArtifactVersionLocator(item.path)?.versionId ??
    parseUploadVersionReference(item.path)?.versionId
  if (source.versionId || itemVersionId) return source.versionId === itemVersionId
  return true
}

const sourceName = (path: string, name?: string): string =>
  name ?? path.split(/[\\/]/).at(-1) ?? path

const createAnnotationPreviewItem = (annotation: Annotation): PreviewFileItem | undefined => {
  const source = annotation.source
  if (source.kind === 'agent-message' || source.kind === 'session-item') return undefined

  const artifact = parseArtifactVersionLocator(source.path)
  const upload = parseUploadVersionReference(source.path)
  const projectId = source.projectId
  const sessionId = source.sessionId ?? artifact?.appSessionId ?? upload?.sessionId
  if (!sessionId) return undefined

  const name = sourceName(source.path, source.name)
  const versionId = source.versionId ?? artifact?.versionId ?? upload?.versionId
  return createPreviewFileItem({
    id:
      artifact?.artifactId ??
      (upload ? `upload:${upload.versionId}` : `file:${projectId}:${source.path}`),
    projectId,
    sessionId,
    path: source.path,
    name,
    mimeType: annotation.kind === 'image-point' ? annotation.source.mimeType : undefined,
    source: upload ? 'upload' : undefined,
    artifactId: artifact?.artifactId,
    selectedVersionId: artifact ? versionId : undefined
  })
}

const requestAnnotationReveal = (annotation: Annotation): void => {
  if (annotation.source.kind === 'agent-message' || annotation.source.kind === 'session-item') {
    document.dispatchEvent(new CustomEvent(REVEAL_PREPARE_EVENT, { detail: annotation }))
    publishAnnotationReveal(annotation.id)
    return
  }

  const workbench = usePreviewWorkbenchStore.getState()
  const existing = workbench.items.find(
    (item) => item.type === 'file' && fileSourceMatchesItem(annotation, item)
  )
  const item = existing ?? createAnnotationPreviewItem(annotation)
  if (!item) return

  workbench.upsertAndActivateItem(item)
  publishAnnotationReveal(annotation.id)
}

const revealTextAnnotationRange = (range: Range): void => {
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
  requestAnnotationReveal,
  revealTextAnnotationRange,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
}
