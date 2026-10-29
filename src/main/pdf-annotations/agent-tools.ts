import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import { createArtifactVersionLocator } from '../../shared/artifact-version-locator'
import { createLiteratureAttachmentVersionReference } from '../../shared/literature-attachment-reference'
import { createUploadVersionReference } from '../../shared/uploads'
import { PDF_MARK_COLORS } from '../../shared/pdf-bookmarks'
import type {
  PdfAnnotationSelector,
  PdfAnnotationSource,
  PdfAnnotationScope
} from '../../shared/pdf-annotations'
import type { PersistedChatSession, SessionPdfBinding } from '../../shared/session-persistence'
import type { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import type { SessionCatalog } from '../session-persistence/coordinator'
import type {
  PdfElementAgentReader,
  PdfElementContext
} from '../literature/pdf-structure/agent-reader'
import type { PdfAnnotationService } from './service'
import { locatePdfAnnotationGeometryInWorker } from './agent-geometry'

const documentId = z.string().trim().min(1).max(512).optional()
const pageNumber = z.number().int().positive().max(100_000)
export const listPdfAnnotationsInput = z
  .object({
    documentId,
    cursor: z
      .object({ createdAt: z.iso.datetime(), id: z.string().min(1).max(1024) })
      .strict()
      .optional()
  })
  .strict()
export const locatePdfAnnotationInput = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('document-note'), documentId }).strict(),
      z.object({ kind: z.literal('page-note'), documentId, pageNumber }).strict(),
      z
        .object({
          kind: z.literal('text'),
          documentId,
          pageNumber,
          quote: z.string().trim().min(1).max(4000),
          prefix: z.string().trim().min(1).max(200).optional(),
          suffix: z.string().trim().min(1).max(200).optional()
        })
        .strict(),
      z.object({ kind: z.literal('element'), elementRef: z.string().min(1).max(8192) }).strict()
    ])
  })
  .strict()
export const createPdfAnnotationInput = z
  .object({
    targetRef: z.string().uuid(),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    note: z.string().max(20_000),
    color: z.enum(PDF_MARK_COLORS).optional()
  })
  .strict()
export type AnnotationToolContext = PdfElementContext & { check: () => void }
export type ListPdfAnnotationsInput = z.infer<typeof listPdfAnnotationsInput>
export type LocatePdfAnnotationInput = z.infer<typeof locatePdfAnnotationInput>
export type CreatePdfAnnotationInput = z.infer<typeof createPdfAnnotationInput>
export type PdfAnnotationAgentTools = Pick<PdfAnnotationAgent, 'list' | 'locate' | 'create'>
const stale = (): Error =>
  new Error('PDF_ANNOTATION_TARGET_STALE: Resolve a fresh target in the current Reading message.')
const key = (context: PdfElementContext): string =>
  JSON.stringify([context.projectId, context.sessionId, context.promptMessageId])
const bindingKey = (binding: SessionPdfBinding): string =>
  JSON.stringify([
    binding.bindingId,
    binding.sourceKind,
    binding.sourceFileId,
    binding.sourceVersionId,
    binding.sourceSessionId,
    binding.checksum,
    binding.sizeBytes
  ])
const scope = (source: PdfAnnotationSource): PdfAnnotationScope =>
  source.kind === 'literature-attachment-version'
    ? { literatureVersionId: source.versionId }
    : { projectId: source.projectId }
const sourceOf = (projectId: string, binding: SessionPdfBinding): PdfAnnotationSource => ({
  kind: binding.sourceKind,
  sourceFileId: binding.sourceFileId,
  versionId: binding.sourceVersionId,
  checksum: binding.checksum,
  name: binding.name,
  ...(binding.sourceKind === 'literature-attachment-version'
    ? {
        path: createLiteratureAttachmentVersionReference(binding.sourceVersionId)
      }
    : {
        projectId,
        sessionId: binding.sourceSessionId,
        path:
          binding.sourceKind === 'upload-version'
            ? createUploadVersionReference(binding.sourceVersionId, {
                projectId,
                sessionId: binding.sourceSessionId!,
                fileId: binding.sourceFileId
              })
            : createArtifactVersionLocator({
                projectId,
                appSessionId: binding.sourceSessionId!,
                artifactId: binding.sourceFileId,
                versionId: binding.sourceVersionId
              })
      })
})
function bindingFor(
  session: PersistedChatSession,
  context: PdfElementContext,
  document?: string
): SessionPdfBinding {
  if (session.projectId !== context.projectId || session.id !== context.sessionId) throw stale()
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  const prompt = messages.find(
    (message) => message.id === context.promptMessageId && message.role === 'user'
  )
  const bindings = prompt?.pdfContext?.bindings ?? []
  if (!document && bindings.length !== 1)
    throw new Error(
      'PDF_DOCUMENT_SELECTION_REQUIRED: Select one documentId from the current Reading message.'
    )
  const binding = bindings.find(
    (binding) => binding.bindingId === (document ?? bindings[0]?.bindingId)
  )
  if (!binding) throw stale()
  return binding
}
type Target = {
  context: string
  binding: SessionPdfBinding
  selector: PdfAnnotationSelector
  source: PdfAnnotationSource
  expires: number
}

export class PdfAnnotationAgent {
  private readonly targets = new Map<string, Target>()
  constructor(
    private readonly options: {
      sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>
      sources: Pick<SessionPdfSourceResolver, 'resolveVersion'>
      withSession: <T>(
        context: PdfElementContext,
        operation: (session: PersistedChatSession) => Promise<T>
      ) => Promise<T>
      annotations: Pick<PdfAnnotationService, 'list' | 'create' | 'withVerifiedSource'>
      elements: Pick<PdfElementAgentReader, 'annotationRegions'>
      geometry?: typeof locatePdfAnnotationGeometryInWorker
    }
  ) {}
  private async binding(
    context: AnnotationToolContext,
    document?: string
  ): Promise<SessionPdfBinding> {
    context.check()
    const session = await this.options.sessions.loadSessionForContinuation(
      context.projectId,
      context.sessionId
    )
    context.check()
    return bindingFor(session, context, document)
  }
  private async source(
    context: AnnotationToolContext,
    binding: SessionPdfBinding
  ): Promise<PdfAnnotationSource> {
    if (binding.sourceKind === 'literature-attachment-version') {
      // Session packages retain Literature references while storing their bytes as managed uploads.
      const packaged = await this.options.sources.resolveVersion({
        projectId: context.projectId,
        sourceKind: 'upload-version',
        sourceVersionId: binding.sourceVersionId,
        expectedSourceFileId: binding.sourceFileId
      })
      context.check()
      if (packaged) {
        if (
          packaged.sourceKind !== 'upload-version' ||
          packaged.checksum !== binding.checksum ||
          packaged.sizeBytes !== binding.sizeBytes
        )
          throw stale()
        return sourceOf(context.projectId, {
          ...binding,
          sourceKind: 'upload-version',
          sourceSessionId: packaged.sourceSessionId,
          name: packaged.filename
        })
      }
    }
    return sourceOf(context.projectId, binding)
  }
  async list(
    context: AnnotationToolContext,
    raw: ListPdfAnnotationsInput
  ): Promise<Record<string, unknown>> {
    const input = listPdfAnnotationsInput.parse(raw)
    const binding = await this.binding(context, input.documentId)
    const source = await this.source(context, binding)
    const result = await this.options.annotations.list({
      ...scope(source),
      ...(source.kind !== 'literature-attachment-version' ? { sessionId: context.sessionId } : {}),
      sourceFileId: source.sourceFileId,
      versionId: source.versionId,
      cursor: input.cursor,
      limit: 20
    })
    const current = await this.binding(context, binding.bindingId)
    if (bindingKey(current) !== bindingKey(binding)) throw stale()
    return {
      documentId: binding.bindingId,
      readOnly: result.readOnly ?? false,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      annotations: result.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        note: item.note.slice(0, 1000),
        noteTruncated: item.note.length > 1000,
        color: item.color,
        pageNumber:
          'pageNumber' in item.target.selector ? item.target.selector.pageNumber : undefined,
        quote:
          item.target.selector.kind === 'text'
            ? item.target.selector.exact.slice(0, 500)
            : undefined,
        quoteTruncated:
          item.target.selector.kind === 'text' && item.target.selector.exact.length > 500
      }))
    }
  }
  async locate(
    context: AnnotationToolContext,
    raw: LocatePdfAnnotationInput
  ): Promise<Record<string, unknown>> {
    const { target: input } = locatePdfAnnotationInput.parse(raw)
    context.check()
    const element =
      input.kind === 'element'
        ? await this.options.elements.annotationRegions(context, input.elementRef)
        : undefined
    const binding = await this.binding(
      context,
      element?.documentId ?? ('documentId' in input ? input.documentId : undefined)
    )
    const source = await this.source(context, binding)
    let selectors: PdfAnnotationSelector[] = []
    let truncated = false
    await this.options.annotations.withVerifiedSource(source, async (lease) => {
      const geometry = this.options.geometry ?? locatePdfAnnotationGeometryInWorker
      if (input.kind === 'document-note')
        selectors = [{ kind: 'document-note', coordinateVersion: 1 }]
      else if (element) {
        const rotations = new Map<number, number>()
        for (const region of element.regions) {
          if (!rotations.has(region.page)) {
            const result = await geometry(
              { filePath: lease.path, pageNumber: region.page },
              context.signal
            )
            const page = result.selectors[0]
            if (page?.kind !== 'page-note') throw stale()
            rotations.set(region.page, page.pageRotation)
          }
          const pageRotation = rotations.get(region.page)!
          let { x, y, width, height } = region
          for (let turn = 0; turn < ((pageRotation - region.rotation + 360) % 360) / 90; turn++)
            [x, y, width, height] = [1 - y - height, x, height, width]
          selectors.push({
            kind: 'region',
            pageNumber: region.page,
            rect: { x, y, width, height },
            pageRotation,
            coordinateVersion: 1
          })
        }
      } else if (input.kind === 'text' || input.kind === 'page-note') {
        const result = await geometry(
          {
            filePath: lease.path,
            pageNumber: input.pageNumber,
            ...(input.kind === 'text'
              ? { quote: input.quote, prefix: input.prefix, suffix: input.suffix }
              : {})
          },
          context.signal
        )
        selectors = result.selectors
        truncated = result.truncated
      }
      await lease.verifyUnchanged()
    })
    const current = await this.binding(context, binding.bindingId)
    if (bindingKey(current) !== bindingKey(binding)) throw stale()
    for (const [id, target] of this.targets)
      if (target.expires < Date.now()) this.targets.delete(id)
    const targets = selectors.map((selector) => {
      while (this.targets.size >= 256) this.targets.delete(this.targets.keys().next().value!)
      const targetRef = randomUUID()
      this.targets.set(targetRef, {
        context: key(context),
        binding: structuredClone(binding),
        selector,
        source,
        expires: Date.now() + 30 * 60_000
      })
      return {
        targetRef,
        kind: selector.kind,
        ...('pageNumber' in selector ? { pageNumber: selector.pageNumber } : {}),
        ...(selector.kind === 'text'
          ? { quote: selector.exact, prefix: selector.prefix, suffix: selector.suffix }
          : {}),
        ...(selector.kind === 'region' ? { rect: selector.rect } : {})
      }
    })
    return {
      documentId: binding.bindingId,
      targets,
      truncated,
      selection: element ? 'regions-of-one-element' : 'alternatives'
    }
  }
  async create(
    context: AnnotationToolContext,
    raw: CreatePdfAnnotationInput
  ): Promise<Record<string, unknown>> {
    const input = createPdfAnnotationInput.parse(raw)
    context.check()
    const target = this.targets.get(input.targetRef)
    if (!target || target.context !== key(context) || target.expires < Date.now()) throw stale()
    if (
      (target.selector.kind === 'page-note' || target.selector.kind === 'document-note') &&
      !input.note.trim()
    )
      throw new Error('PDF_ANNOTATION_NOTE_REQUIRED: A document or page note must contain text.')
    return this.options.withSession(context, async (session) => {
      context.check()
      if (session.packageOrigin)
        throw new Error('PDF_ANNOTATION_READ_ONLY: Imported Sessions are read-only.')
      const binding = bindingFor(session, context, target.binding.bindingId)
      if (bindingKey(binding) !== bindingKey(target.binding)) throw stale()
      const source = target.source
      const id = `agent-note-${createHash('sha256')
        .update(JSON.stringify([key(context), input.requestId]))
        .digest('hex')}`
      const annotation = await this.options.annotations.create(
        {
          id,
          ...scope(source),
          createdInSessionId: context.sessionId,
          kind:
            target.selector.kind === 'text'
              ? 'highlight'
              : target.selector.kind === 'region'
                ? 'area'
                : target.selector.kind,
          note: input.note,
          ...(input.color ? { color: input.color } : {}),
          tagIds: [],
          target: { source, selector: target.selector }
        },
        context.check
      )
      // A committed write survives transport cancellation. Stable requestId recovers its receipt.
      return {
        id: annotation.id,
        documentId: binding.bindingId,
        kind: annotation.kind,
        pageNumber:
          'pageNumber' in annotation.target.selector
            ? annotation.target.selector.pageNumber
            : undefined,
        note: annotation.note,
        updatedAt: annotation.updatedAt
      }
    })
  }
}
