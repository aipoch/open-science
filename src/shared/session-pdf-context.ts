import type { FileReference } from './artifacts'
import { createArtifactVersionLocator } from './artifact-provenance'
import type {
  MessagePdfContextSnapshot,
  PdfReadingPosition,
  SessionPdfBinding
} from './session-persistence'
import { createUploadVersionReference } from './uploads'

export const sessionPdfBindingToFileReference = (
  projectId: string,
  context: SessionPdfBinding,
  readingPosition?: PdfReadingPosition,
  documentCount = 1,
  active = false
): FileReference =>
  context.sourceKind === 'artifact-version'
    ? {
        id: context.sourceFileId,
        sourceFileId: context.sourceFileId,
        name: context.name,
        source: 'artifact',
        path: createArtifactVersionLocator({
          projectId,
          appSessionId: context.sourceSessionId,
          artifactId: context.sourceFileId,
          versionId: context.sourceVersionId
        }),
        versionId: context.sourceVersionId,
        mimeType: context.mimeType,
        pdfContextDocumentId: context.bindingId,
        pdfContextDocumentCount: documentCount,
        pdfContextActive: active,
        ...(readingPosition ? { pdfReadingPosition: readingPosition } : {})
      }
    : {
        id: context.sourceFileId,
        sourceFileId: context.sourceFileId,
        name: context.name,
        source: 'upload',
        path: createUploadVersionReference(context.sourceVersionId, {
          projectId,
          sessionId: context.sourceSessionId
        }),
        versionId: context.sourceVersionId,
        mimeType: context.mimeType,
        pdfContextDocumentId: context.bindingId,
        pdfContextDocumentCount: documentCount,
        pdfContextActive: active,
        ...(readingPosition ? { pdfReadingPosition: readingPosition } : {})
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
    const source = binding.sourceKind === 'artifact-version' ? 'artifact' : 'upload'
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
