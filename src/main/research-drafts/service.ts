import { createHash } from 'node:crypto'
import type { PrismaClient, ResearchDraft as Row } from '@prisma/client'
import {
  researchWorkspaceRequestSchema,
  type ResearchWorkspaceRequest
} from '../../shared/research-workspace'
import {
  actResearchDraftSchema,
  saveResearchDraftSchema,
  researchDraftSchema,
  type ResearchDraft,
  type SaveResearchDraftRequest,
  type ActResearchDraftRequest,
  type ResearchDraftMutationResult
} from '../../shared/research-draft'
import type { UploadedAttachment } from '../../shared/uploads'
type Client = Pick<PrismaClient, 'researchDraft' | 'researchSubmission' | 'project'>
type Admission = <T>(operation: () => Promise<T>) => Promise<T>
const toView = (row: Row): ResearchDraft => {
  const { payloadJson, requestHash: _requestHash, updatedAt, ...identity } = row
  void _requestHash
  return researchDraftSchema.parse({
    ...identity,
    payload: JSON.parse(payloadJson),
    updatedAt: updatedAt.getTime()
  })
}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class ResearchDraftService {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly getClient: () => Promise<Client>,
    private readonly preserveAttachments: (
      projectId: string,
      ownerId: string,
      attachments: UploadedAttachment[]
    ) => Promise<UploadedAttachment[]>,
    private readonly withWrite: Admission,
    private readonly withProjectAvailable: <T>(
      projectId: string,
      operation: () => Promise<T>
    ) => Promise<T> = (_projectId, operation) => operation(),
    private readonly releaseAttachments: (
      projectId: string,
      draftId: string,
      attachments: UploadedAttachment[]
    ) => Promise<unknown> = async () => undefined
  ) {}
  private write<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(
      () => this.withWrite(() => this.withProjectAvailable(projectId, operation)),
      () => this.withWrite(() => this.withProjectAvailable(projectId, operation))
    )
    this.tail = task.catch(() => undefined)
    return task
  }
  async list(input: ResearchWorkspaceRequest): Promise<ResearchDraft[]> {
    const scope = researchWorkspaceRequestSchema.parse(input)
    const client = await this.getClient()
    const rows = await client.researchDraft.findMany({
      where: { ...scope, state: 'active', project: { deletedAt: null } },
      orderBy: { updatedAt: 'desc' }
    })
    const drafts = rows.map(toView)
    // Admission to the durable submission journal owns that exact revision from this point on.
    // This closes the crash window before the renderer clears its composer; newer edits keep
    // different intent IDs and remain recoverable here.
    const admitted = await client.researchSubmission.findMany({
      where: { ...scope, id: { in: drafts.map((draft) => draft.payload.intentId) } },
      select: { id: true }
    })
    const admittedIds = new Set(admitted.map((submission) => submission.id))
    return drafts.filter((draft) => !admittedIds.has(draft.payload.intentId))
  }
  save(input: SaveResearchDraftRequest): Promise<ResearchDraftMutationResult> {
    const request = saveResearchDraftSchema.parse(input)
    return this.write(request.projectId, async () => {
      const client = await this.getClient()
      const project = await client.project.findFirst({
        where: { id: request.projectId, deletedAt: null }
      })
      if (!project) throw new Error('The research Project is unavailable.')
      const existing = await client.researchDraft.findUnique({ where: { id: request.id } })
      const requestHash = hash(request)
      if (existing?.state === 'active' && existing.requestHash === requestHash)
        return { status: 'saved', draft: toView(existing) }
      if (
        existing
          ? existing.projectId !== request.projectId ||
            existing.sourceSessionId !== request.sourceSessionId ||
            existing.editorId !== request.editorId ||
            existing.revision !== request.expectedRevision ||
            existing.state !== 'active'
          : request.expectedRevision !== 0
      )
        return {
          status: 'conflict',
          draft:
            existing &&
            existing.projectId === request.projectId &&
            existing.sourceSessionId === request.sourceSessionId
              ? toView(existing)
              : null
        }
      const attachments = await this.preserveAttachments(
        request.projectId,
        `research-draft-${request.id}`,
        request.payload.attachments
      )
      if (
        attachments.length !== request.payload.attachments.length ||
        attachments.some((attachment) => !attachment.versionId)
      )
        throw new Error('Research draft attachments could not be preserved.')
      const data = {
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        editorId: request.editorId,
        revision: request.expectedRevision + 1,
        state: 'active',
        requestHash,
        payloadJson: JSON.stringify({ ...request.payload, attachments })
      }
      const row = existing
        ? await client.researchDraft.update({ where: { id: request.id }, data })
        : await client.researchDraft.create({ data: { id: request.id, ...data } })
      return { status: 'saved', draft: toView(row) }
    })
  }
  act(input: ActResearchDraftRequest): Promise<ResearchDraftMutationResult> {
    const request = actResearchDraftSchema.parse(input)
    return this.write(request.projectId, async () => {
      const client = await this.getClient()
      const row = await client.researchDraft.findFirst({
        where: {
          id: request.id,
          projectId: request.projectId,
          sourceSessionId: request.sourceSessionId,
          project: { deletedAt: null }
        }
      })
      if (
        !row ||
        row.revision !== request.expectedRevision ||
        row.state !== 'active' ||
        (request.action === 'discard' && row.editorId !== request.editorId)
      )
        return { status: 'conflict', draft: row ? toView(row) : null }
      if (
        request.action === 'claim' &&
        (await client.researchSubmission.findFirst({
          where: {
            projectId: row.projectId,
            sourceSessionId: row.sourceSessionId,
            id: toView(row).payload.intentId
          }
        }))
      )
        return { status: 'conflict', draft: toView(row) }
      const updated = await client.researchDraft.update({
        where: { id: row.id },
        data: {
          editorId: request.editorId,
          revision: { increment: 1 },
          state: request.action === 'discard' ? 'discarded' : 'active',
          requestHash: ''
        }
      })
      if (request.action === 'discard' && request.releaseAttachments)
        await this.releaseAttachments(row.projectId, row.id, toView(row).payload.attachments)
      return { status: 'saved', draft: toView(updated) }
    })
  }
}
