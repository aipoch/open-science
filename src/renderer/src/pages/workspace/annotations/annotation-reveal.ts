import {
  resolveManagedProjectFileAnnotationIdentity,
  type Annotation,
  type ManagedProjectFileAnnotationIdentity
} from '../../../../../shared/annotations'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { parseLiteratureAttachmentVersionReference } from '../../../../../shared/literature'
import { parseUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { PdfAnnotation as SavedPdfAnnotation } from '../../../../../shared/pdf-annotations'
import type { Bookmark, BookmarkTarget } from '../../../../../shared/bookmarks'

import { createPreviewFileItem, LITERATURE_PREVIEW_SESSION_ID } from '../preview-file-item'

// Composer chips cannot reach their source surfaces directly. This module owns
// file-tab activation/reconstruction and publishes one generic reveal request
// that text ranges and image pins can both claim after their surface mounts.
const REVEAL_EVENT = 'annotation-reveal'
const REVEAL_PREPARE_EVENT = 'annotation-reveal-prepare'
const REVEAL_HIGHLIGHT_NAME = 'agent-annotation-reveal'
const REVEAL_DURATION_MS = 1_600
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let revealFrame: number | undefined
let restoreRevealLayout: (() => void) | undefined
let revealedRange: Range | undefined
let revealTimer: ReturnType<typeof setTimeout> | undefined
let pendingRevealId: string | undefined
type BookmarkRevealTarget = Readonly<{ id: string }> &
  (
    | BookmarkTarget
    | (Omit<Extract<BookmarkTarget, { kind: 'pdf' }>, 'source'> & {
        source: SavedPdfAnnotation['target']['source']
      })
  )
type BookmarkRevealOutcome = 'revealed' | 'source-unavailable' | 'locator-unsupported'

let pendingRevealAnnotation: Annotation | undefined
let pendingBookmarkReveal:
  | {
      target: BookmarkRevealTarget
      finish: (outcome: BookmarkRevealOutcome) => void
      timeout: ReturnType<typeof setTimeout>
    }
  | undefined
const bookmarkPreparationListeners = new Set<(target: BookmarkRevealTarget) => void>()
const bookmarkRevealListeners = new Set<
  (target: BookmarkRevealTarget) => boolean | BookmarkRevealOutcome | void
>()

const fileAnnotationSource = (
  annotation: Annotation | BookmarkRevealTarget
):
  | Extract<BookmarkRevealTarget, { kind: 'pdf' }>['source']
  | Extract<Annotation, { kind: 'image-point' | 'pdf' }>['source']
  | Extract<Extract<Annotation, { kind: 'text' }>['source'], { kind: 'project-file' }>
  | undefined => {
  if (annotation.kind !== 'text') return annotation.source
  return annotation.source.kind === 'project-file' ? annotation.source : undefined
}

const publishAnnotationReveal = (annotation: Annotation): void => {
  pendingRevealId = annotation.id
  pendingRevealAnnotation = annotation
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
  if (source.kind === 'literature-attachment-version') {
    return parseLiteratureAttachmentVersionReference(source.path) === source.versionId
      ? undefined
      : null
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

const fileSourceMatchesItem = (
  annotation: Annotation | BookmarkRevealTarget,
  item: PreviewFileItem
): boolean => {
  const source = fileAnnotationSource(annotation)
  if (!source) return false
  if (item.projectId !== source.projectId) return false
  const managedIdentity = managedAnnotationIdentity(source)
  if (managedIdentity === null) return false
  const literatureVersionId = parseLiteratureAttachmentVersionReference(source.path)
  if (literatureVersionId) {
    return (
      item.source === 'literature' &&
      item.path === source.path &&
      literatureVersionId === source.versionId
    )
  }
  const itemFileSource = item.source === 'upload' ? 'upload' : 'artifact'
  const matchesManagedIdentity =
    managedIdentity !== undefined &&
    managedIdentity.fileId === item.managedFileId &&
    managedIdentity.fileSource === itemFileSource
  if (!matchesManagedIdentity && item.path !== source.path) return false
  const itemVersionId =
    item.selectedVersionId ??
    parseArtifactVersionLocator(item.path)?.versionId ??
    parseUploadVersionReference(item.path)?.versionId ??
    parseLiteratureAttachmentVersionReference(item.path)
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
  const literatureVersionId = parseLiteratureAttachmentVersionReference(source.path)
  const projectId = source.projectId
  const sessionId =
    source.sessionId ??
    artifact?.appSessionId ??
    upload?.sessionId ??
    (literatureVersionId ? LITERATURE_PREVIEW_SESSION_ID : undefined)
  if (!sessionId) return undefined

  const name = sourceName(source.path, source.name)
  const versionId =
    managedIdentity?.versionId ??
    source.versionId ??
    artifact?.versionId ??
    upload?.versionId ??
    literatureVersionId
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
          : literatureVersionId
            ? `literature-version:${literatureVersionId}`
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
    source: uploadFileId ? 'upload' : literatureVersionId ? 'literature' : undefined,
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

type BookmarkFileSource =
  | Extract<BookmarkRevealTarget, { kind: 'pdf' }>['source']
  | Extract<Extract<BookmarkRevealTarget, { kind: 'text' }>['source'], { kind: 'project-file' }>

const bookmarkFileSource = (target: BookmarkRevealTarget): BookmarkFileSource | undefined =>
  target.kind === 'pdf'
    ? target.source
    : target.source.kind === 'project-file'
      ? target.source
      : undefined

const createBookmarkPreviewItem = (target: BookmarkRevealTarget): PreviewFileItem | undefined => {
  const source = bookmarkFileSource(target)
  if (!source) return undefined
  const artifact = parseArtifactVersionLocator(source.path)
  const upload = parseUploadVersionReference(source.path)
  const literatureVersionId = parseLiteratureAttachmentVersionReference(source.path)
  const sourceFileId = 'sourceFileId' in source ? source.sourceFileId : undefined
  const versionId =
    source.versionId ?? artifact?.versionId ?? upload?.versionId ?? literatureVersionId
  const sessionId =
    source.sessionId ??
    artifact?.appSessionId ??
    upload?.sessionId ??
    (literatureVersionId ? LITERATURE_PREVIEW_SESSION_ID : undefined)
  const requiresVersion = target.kind === 'pdf' || sourceFileId !== undefined
  if (!sessionId || (requiresVersion && !versionId)) return undefined
  const fileSource =
    source.kind === 'upload-version' ||
    (source.kind === 'project-file' && source.fileSource === 'upload')
      ? 'upload'
      : source.kind === 'literature-attachment-version'
        ? 'literature'
        : undefined
  return createPreviewFileItem({
    id: sourceFileId
      ? fileSource === 'upload'
        ? `upload:${sourceFileId}`
        : sourceFileId
      : literatureVersionId
        ? `literature-version:${literatureVersionId}`
        : `file:${source.projectId}:${source.path}`,
    projectId: source.projectId,
    sessionId,
    path: source.path,
    name: sourceName(source.path, source.name),
    mimeType: target.kind === 'pdf' ? 'application/pdf' : undefined,
    source: fileSource,
    artifactId:
      source.kind === 'artifact-version' ||
      (source.kind === 'project-file' && source.fileSource === 'artifact')
        ? sourceFileId
        : undefined,
    managedFileId: sourceFileId,
    selectedVersionId: sourceFileId ? versionId : undefined
  })
}

const deliverBookmarkReveal = (): void => {
  const pending = pendingBookmarkReveal
  if (!pending) return
  for (const listener of bookmarkPreparationListeners) listener(pending.target)
  for (const listener of bookmarkRevealListeners) {
    const result = listener(pending.target)
    if (!result) continue
    const outcome = result === true ? 'revealed' : result
    clearTimeout(pending.timeout)
    pendingBookmarkReveal = undefined
    pending.finish(outcome)
    return
  }
}

const subscribeBookmarkRevealPreparation = (
  listener: (target: BookmarkRevealTarget) => void
): (() => void) => {
  bookmarkPreparationListeners.add(listener)
  if (pendingBookmarkReveal) listener(pendingBookmarkReveal.target)
  return () => bookmarkPreparationListeners.delete(listener)
}

const subscribeBookmarkReveal = (
  listener: (target: BookmarkRevealTarget) => boolean | BookmarkRevealOutcome | void
): (() => void) => {
  bookmarkRevealListeners.add(listener)
  deliverBookmarkReveal()
  return () => bookmarkRevealListeners.delete(listener)
}

const requestSavedSourceReveal = async (
  target: BookmarkRevealTarget,
  activatePreview = true,
  signal?: AbortSignal
): Promise<BookmarkRevealOutcome> => {
  if (signal?.aborted) return 'locator-unsupported'
  const source = bookmarkFileSource(target)
  if (activatePreview && source?.projectId) {
    const workbench = usePreviewWorkbenchStore.getState()
    // Reuse the exact-Version tab: replacing it with a minimal item discards metadata and
    // remounts its renderer after the old renderer has already acknowledged this reveal.
    const existing = workbench.items.find(
      (item): item is Extract<typeof item, { type: 'file' }> =>
        item.type === 'file' && fileSourceMatchesItem(target, item)
    )
    const item = existing ?? createBookmarkPreviewItem(target)
    if (!item) return 'source-unavailable'
    workbench.upsertAndActivateItem(item)
  }
  if (pendingBookmarkReveal) {
    clearTimeout(pendingBookmarkReveal.timeout)
    pendingBookmarkReveal.finish('locator-unsupported')
  }
  return new Promise((resolve) => {
    const finish = (outcome: BookmarkRevealOutcome): void => {
      signal?.removeEventListener('abort', abort)
      resolve(outcome)
    }
    const abort = (): void => {
      if (pendingBookmarkReveal?.finish !== finish) return
      clearTimeout(pendingBookmarkReveal.timeout)
      pendingBookmarkReveal = undefined
      finish('locator-unsupported')
    }
    const timeout = setTimeout(() => {
      if (pendingBookmarkReveal?.target.id !== target.id) return
      pendingBookmarkReveal = undefined
      finish('locator-unsupported')
    }, 5_000)
    pendingBookmarkReveal = { target, finish, timeout }
    signal?.addEventListener('abort', abort, { once: true })
    deliverBookmarkReveal()
  })
}

// Both saved-source surfaces share navigation and locator delivery, not persistence.
const requestBookmarkReveal = (bookmark: Bookmark): Promise<BookmarkRevealOutcome> =>
  requestSavedSourceReveal({ id: bookmark.id, ...bookmark.target })
const requestPdfAnnotationReveal = (
  annotation: SavedPdfAnnotation,
  options?: { activatePreview: boolean; signal?: AbortSignal }
): Promise<BookmarkRevealOutcome> =>
  requestSavedSourceReveal(
    { id: annotation.id, kind: 'pdf', ...annotation.target },
    options?.activatePreview,
    options?.signal
  )

const annotationRevealScrollBehavior = (): ScrollBehavior =>
  typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(REDUCED_MOTION_QUERY).matches
    ? 'auto'
    : 'smooth'

const revealTextAnnotationRange = (range: Range): void => {
  restoreRevealLayout?.()
  if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  const parent = range.startContainer.parentElement
  const row = parent?.closest<HTMLElement>('[data-message-id]')
  if (row) {
    const previous = row.style.contentVisibility
    row.style.contentVisibility = 'visible'
    restoreRevealLayout = () => {
      row.style.contentVisibility = previous
    }
  } else restoreRevealLayout = undefined

  const scrollToRange = (): void => {
    if (!parent?.isConnected) return
    const rect = range.getBoundingClientRect?.()
    let viewport: HTMLElement | null = parent
    while (viewport) {
      if (
        viewport.scrollHeight > viewport.clientHeight &&
        /auto|scroll/.test(getComputedStyle(viewport).overflowY) &&
        rect &&
        rect.height > 0
      ) {
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            rect.top -
            viewport.getBoundingClientRect().top -
            viewport.clientTop -
            (viewport.clientHeight - rect.height) / 2,
          behavior: annotationRevealScrollBehavior()
        })
        return
      }
      viewport = viewport.parentElement
    }
    parent?.scrollIntoView({ block: 'center', behavior: annotationRevealScrollBehavior() })
  }
  scrollToRange()
  // Transcript mounting restores its reading anchor during the commit. Correct the exact
  // selection after that layout pass, using the now measured content instead of placeholders.
  if (typeof requestAnimationFrame === 'function') {
    revealFrame = requestAnimationFrame(() => {
      revealFrame = undefined
      scrollToRange()
    })
  }
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    restoreRevealLayout?.()
    restoreRevealLayout = undefined
    if (revealedRange) globalThis.CSS?.highlights?.get(REVEAL_HIGHLIGHT_NAME)?.delete(revealedRange)
    revealedRange = undefined
  }, REVEAL_DURATION_MS)
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return

  const highlight = globalThis.CSS.highlights.get(REVEAL_HIGHLIGHT_NAME) ?? new Highlight()
  if (revealedRange) highlight.delete(revealedRange)
  highlight.add(range)
  globalThis.CSS.highlights.set(REVEAL_HIGHLIGHT_NAME, highlight)
  revealedRange = range
}

export {
  annotationRevealScrollBehavior,
  createBookmarkPreviewItem,
  requestAnnotationReveal,
  requestBookmarkReveal,
  requestPdfAnnotationReveal,
  retryPendingAnnotationReveal,
  revealTextAnnotationRange,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation,
  subscribeBookmarkReveal,
  subscribeBookmarkRevealPreparation
}
export type { BookmarkRevealOutcome, BookmarkRevealTarget }
