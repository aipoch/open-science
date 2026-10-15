import type { FileReference } from './artifacts'
import { createArtifactVersionLocator } from './artifact-version-locator'
import { createLiteratureAttachmentVersionReference } from './literature-attachment-reference'
import type {
  MessagePdfContextSnapshot,
  PdfReadingPosition,
  SessionPdfBinding,
  SessionPdfContextSource
} from './session-persistence'
import { createUploadVersionReference } from './uploads'
import type { UploadedAttachment } from './uploads'
import { validatePdfProseRegions, type PdfProseRegion } from './pdf-text'

// Transient send identity; staged uploads resolve to immutable versions before linking.
export type PdfReadingPositionSource = SessionPdfContextSource | { attachmentId: string }

export type PdfProseReadingSelection = Readonly<{
  source: PdfReadingPositionSource
  proseRegions: readonly PdfProseRegion[]
}>

export const pdfProseReadingSelectionsFromContext = (
  context: MessagePdfContextSnapshot | undefined
): PdfProseReadingSelection[] =>
  context?.bindings.flatMap((binding) => {
    const map = context.proseRegionsByBindingId
    return map && Object.hasOwn(map, binding.bindingId)
      ? [{ source: binding, proseRegions: map[binding.bindingId].map((region) => ({ ...region })) }]
      : []
  }) ?? []

// Linking/finalizing can replace binding IDs. Only immutable source identity may transfer
// a captured reading selection; the live preview store is never consulted during send.
export const withPdfProseReadingSelections = (
  context: MessagePdfContextSnapshot | undefined,
  selections: readonly PdfProseReadingSelection[] | undefined,
  attachments: readonly UploadedAttachment[]
): MessagePdfContextSnapshot | undefined => {
  if (selections === undefined) return context
  if (selections.length > 3)
    throw new Error('PDF_READING_REGION_INVALID: Too many PDF reading selections.')
  if (!context) {
    if (selections.length)
      throw new Error('PDF_READING_REGION_INVALID: Selected body areas have no linked PDF.')
    return undefined
  }
  const { proseRegionsByBindingId, ...rest } = context
  const regionsByBinding = new Map(Object.entries(proseRegionsByBindingId ?? {}))
  const assigned = new Set<string>()
  for (const selection of selections) {
    const selectedSource = selection.source
    const source =
      'attachmentId' in selectedSource
        ? attachments.find((attachment) => attachment.id === selectedSource.attachmentId)
        : undefined
    const identity =
      'attachmentId' in selectedSource
        ? source?.versionId
          ? { sourceKind: 'upload-version' as const, sourceVersionId: source.versionId }
          : undefined
        : selectedSource
    const binding =
      identity &&
      context.bindings.find(
        (candidate) =>
          candidate.sourceKind === identity.sourceKind &&
          candidate.sourceVersionId === identity.sourceVersionId &&
          (!('sourceFileId' in identity) ||
            !identity.sourceFileId ||
            candidate.sourceFileId === identity.sourceFileId)
      )
    if (!binding || assigned.has(binding.bindingId))
      throw new Error(
        'PDF_READING_REGION_INVALID: Selected body areas do not match one linked PDF Version.'
      )
    assigned.add(binding.bindingId)
    if (!selection.proseRegions.length) regionsByBinding.delete(binding.bindingId)
    else {
      validatePdfProseRegions(selection.proseRegions)
      regionsByBinding.set(
        binding.bindingId,
        selection.proseRegions.map((region) => ({ ...region }))
      )
    }
  }
  return {
    ...rest,
    ...(regionsByBinding.size
      ? { proseRegionsByBindingId: Object.fromEntries(regionsByBinding) }
      : {})
  }
}

export const sessionPdfBindingToFileReference = (
  projectId: string,
  context: SessionPdfBinding,
  readingPosition?: PdfReadingPosition,
  documentCount = 1,
  active = false
): FileReference => {
  const contextFields = {
    sourceFileId: context.sourceFileId,
    versionId: context.sourceVersionId,
    mimeType: context.mimeType,
    pdfContextDocumentId: context.bindingId,
    pdfContextDocumentCount: documentCount,
    pdfContextActive: active,
    ...(readingPosition ? { pdfReadingPosition: readingPosition } : {})
  }
  if (context.sourceKind === 'artifact-version') {
    return {
      id: context.sourceFileId,
      name: context.name,
      source: 'artifact',
      path: createArtifactVersionLocator({
        projectId,
        appSessionId: context.sourceSessionId,
        artifactId: context.sourceFileId,
        versionId: context.sourceVersionId
      }),
      ...contextFields
    }
  }
  if (context.sourceKind === 'upload-version') {
    return {
      id: context.sourceFileId,
      name: context.name,
      source: 'upload',
      path: createUploadVersionReference(context.sourceVersionId, {
        projectId,
        sessionId: context.sourceSessionId
      }),
      ...contextFields
    }
  }
  return {
    id: context.sourceFileId,
    name: context.name,
    source: 'literature',
    path: createLiteratureAttachmentVersionReference(context.sourceVersionId),
    ...contextFields
  }
}

export const sessionPdfContextToFileReferences = (
  projectId: string,
  context: MessagePdfContextSnapshot
): FileReference[] =>
  context.bindings.map((binding) =>
    sessionPdfBindingToFileReference(
      projectId,
      binding,
      binding.bindingId === context.activeBindingId ? context.readingPosition : undefined,
      context.bindings.length,
      binding.bindingId === (context.activeBindingId ?? context.bindings[0]?.bindingId)
    )
  )

export const withPdfContext = (
  projectId: string | undefined,
  references: FileReference[] | undefined,
  context: MessagePdfContextSnapshot | undefined
): FileReference[] | undefined => {
  if (!projectId || !context) return references
  let result = references ?? []
  for (const binding of context.bindings) {
    const source =
      binding.sourceKind === 'artifact-version'
        ? 'artifact'
        : binding.sourceKind === 'upload-version'
          ? 'upload'
          : 'literature'
    const duplicate = result.findIndex(
      (reference) =>
        reference.source !== 'linked-folder' &&
        reference.source === source &&
        reference.versionId === binding.sourceVersionId
    )
    const readingPosition =
      binding.bindingId === context.activeBindingId ? context.readingPosition : undefined
    if (duplicate >= 0) {
      result = result.map((reference, index) =>
        index === duplicate && reference.source !== 'linked-folder'
          ? {
              ...reference,
              ...(readingPosition ? { pdfReadingPosition: readingPosition } : {}),
              pdfContextDocumentId: binding.bindingId,
              pdfContextDocumentCount: context.bindings.length,
              pdfContextActive:
                binding.bindingId === (context.activeBindingId ?? context.bindings[0]?.bindingId)
            }
          : reference
      )
      continue
    }
    result = [
      ...result,
      sessionPdfBindingToFileReference(
        projectId,
        binding,
        readingPosition,
        context.bindings.length,
        binding.bindingId === (context.activeBindingId ?? context.bindings[0]?.bindingId)
      )
    ]
  }
  return result
}
