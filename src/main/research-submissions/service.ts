import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient, ResearchSubmission as Row } from '@prisma/client'
import {
  enqueueResearchSubmissionSchema,
  researchSubmissionSchema,
  researchSubmissionPayloadSchema,
  type EnqueueResearchSubmissionRequest,
  type ResearchSubmission,
  type ResearchSubmissionClaim,
  type ResearchSubmissionFinishRequest,
  type ResearchSubmissionActionRequest
} from '../../shared/research-submission'
import type { ResearchWorkspaceRequest } from '../../shared/research-workspace'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { UploadedAttachment } from '../../shared/uploads'
import type {
  ResearchWorkspaceService,
  ResearchWorkspaceSessions
} from '../research-workspaces/service'

type Client = Pick<PrismaClient, 'researchSubmission'>
type Admission = <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
const toView = (row: Row): ResearchSubmission =>
  researchSubmissionSchema.parse({
    id: row.id,
    sequence: row.sequence,
    projectId: row.projectId,
    sourceSessionId: row.sourceSessionId,
    discussionSessionId: row.discussionSessionId ?? undefined,
    messageId: row.messageId,
    payload: JSON.parse(row.payloadJson),
    state: row.state,
    error: row.error ?? undefined,
    claimToken: row.claimToken ?? undefined,
    createdAt: row.createdAt.getTime()
  })
const hasMessage = (session: PersistedChatSession, messageId: string): boolean =>
  [...session.messages, ...(session.conversationGraph?.messages ?? [])].some(
    (message) => message.id === messageId && message.role === 'user'
  )
const turnFinished = (session: PersistedChatSession, messageId: string): boolean =>
  [...session.messages, ...(session.conversationGraph?.messages ?? [])].some(
    (message) =>
      (message.role === 'agent' &&
        message.responseToMessageId === messageId &&
        (message.status === 'complete' || message.status === 'error')) ||
      (message.id === messageId && message.interrupted === true)
  )
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  )

// Main owns queue order and the claim boundary. A claim is deliberately not a timed retry lease:
// once a renderer could have called the model, loss of that renderer requires explicit recovery.
export class ResearchSubmissionService {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly epoch = randomUUID()
  constructor(
    private readonly getClient: () => Promise<Client>,
    private readonly workspaces: Pick<ResearchWorkspaceService, 'get' | 'ensureDiscussion'>,
    private readonly sessions: Pick<ResearchWorkspaceSessions, 'read'>,
    private readonly preserveAttachments: (
      projectId: string,
      ownerId: string,
      attachments: UploadedAttachment[]
    ) => Promise<UploadedAttachment[]>,
    private readonly withProjectAvailable: Admission
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.catch(() => undefined)
    return task
  }
  private async recover(client: Client): Promise<void> {
    await client.researchSubmission.updateMany({
      where: { state: 'sending', OR: [{ ownerEpoch: { not: this.epoch } }, { ownerEpoch: null }] },
      data: {
        state: 'uncertain',
        error: 'Delivery was interrupted. Inspect the Discussion before taking another action.',
        claimToken: null
      }
    })
  }
  async enqueue(input: EnqueueResearchSubmissionRequest): Promise<ResearchSubmission> {
    const request = enqueueResearchSubmissionSchema.parse(input)
    const requestHash = createHash('sha256').update(stableJson(request)).digest('hex')
    return this.serial(() =>
      this.withProjectAvailable(request.projectId, async () => {
        const client = await this.getClient()
        const existing = await client.researchSubmission.findUnique({ where: { id: request.id } })
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new Error('This research question identity already belongs to a different draft.')
          return toView(existing)
        }
        const workspace = await this.workspaces.get({
          projectId: request.projectId,
          sourceSessionId: request.sourceSessionId
        })
        if (
          workspace.discussionStatus !== 'available' &&
          (workspace.sourceStatus !== 'available' ||
            !['none', 'creating'].includes(workspace.discussionStatus))
        )
          throw new Error('The research Discussion is unavailable. The draft has been retained.')
        // Publish staged uploads before acknowledging the journal. Pending upload paths are cleaned
        // at restart; immutable versions owned by this local intent survive creation/send failures.
        const attachments = await this.preserveAttachments(
          request.projectId,
          `research-submission-${request.id}`,
          request.payload.attachments
        )
        if (
          attachments.length !== request.payload.attachments.length ||
          attachments.some((item) => !item.versionId)
        )
          throw new Error('Research question attachments could not be preserved.')
        const payload = researchSubmissionPayloadSchema.parse({ ...request.payload, attachments })
        return toView(
          await client.researchSubmission.create({
            data: {
              id: request.id,
              projectId: request.projectId,
              sourceSessionId: request.sourceSessionId,
              discussionSessionId: workspace.discussionSessionId,
              messageId: `research-${request.id}`,
              requestHash,
              payloadJson: JSON.stringify(payload)
            }
          })
        )
      })
    )
  }
  async list(request: ResearchWorkspaceRequest): Promise<ResearchSubmission[]> {
    return this.serial(async () => {
      const client = await this.getClient()
      await this.recover(client)
      const rows = await client.researchSubmission.findMany({
        where: request,
        orderBy: { sequence: 'asc' }
      })
      return rows.map(toView)
    })
  }
  async claim(clientId: string): Promise<ResearchSubmissionClaim> {
    return this.serial(async () => {
      const client = await this.getClient()
      await this.recover(client)
      // If a different elected writer takes over in this process, the former writer may already
      // have dispatched. Fence it and block the lane; do not infer non-delivery from lease loss.
      await client.researchSubmission.updateMany({
        where: { state: 'sending', ownerClientId: { not: clientId } },
        data: {
          state: 'uncertain',
          claimToken: null,
          error: 'The sending window changed. Inspect the Discussion before taking another action.'
        }
      })
      const rows = await client.researchSubmission.findMany({
        where: { state: { in: ['queued', 'sending', 'failed', 'uncertain', 'accepted'] } },
        orderBy: { sequence: 'asc' }
      })
      const blocked = new Set<string>()
      for (const row of rows) {
        const key = JSON.stringify([row.projectId, row.sourceSessionId])
        if (blocked.has(key)) continue
        if (row.state === 'accepted') {
          const current = row.discussionSessionId
            ? await this.sessions.read(row.projectId, row.discussionSessionId)
            : undefined
          if (current?.status !== 'found' || !turnFinished(current.session, row.messageId))
            blocked.add(key)
          continue
        }
        blocked.add(key)
        if (row.state !== 'queued') continue
        try {
          const identity = { projectId: row.projectId, sourceSessionId: row.sourceSessionId }
          // ensureDiscussion takes the same non-reentrant project admission gate. Prepare before
          // entering it, then reread under admission so deletion/archive cannot make the claim stale.
          const prepared = await this.workspaces.ensureDiscussion(identity)
          const claimed = await this.withProjectAvailable(row.projectId, async () => {
            const workspace = await this.workspaces.get(identity)
            const session = workspace.discussionSession
            if (
              !session ||
              workspace.discussionStatus !== 'available' ||
              session.archivedAt !== undefined
            )
              throw new Error('The research Discussion is unavailable.')
            if (
              prepared.discussionSessionId !== session.id ||
              (row.discussionSessionId && row.discussionSessionId !== session.id)
            )
              throw new Error(
                'The research Discussion was replaced. Restore this question explicitly.'
              )
            if (hasMessage(session, row.messageId)) {
              await client.researchSubmission.update({
                where: { id: row.id },
                data: {
                  state: 'uncertain',
                  error:
                    'This question is already in the Discussion. Inspect its delivery before continuing.'
                }
              })
              return null
            }
            if (session.activeRun || session.status !== 'idle') return null
            const updated = await client.researchSubmission.update({
              where: { id: row.id },
              data: {
                state: 'sending',
                discussionSessionId: session.id,
                claimToken: randomUUID(),
                ownerEpoch: this.epoch,
                ownerClientId: clientId,
                error: null
              }
            })
            return { submission: toView(updated), session }
          })
          if (claimed) return claimed
        } catch (error) {
          await client.researchSubmission.update({
            where: { id: row.id },
            data: {
              state: 'failed',
              error: (error instanceof Error ? error.message : String(error)).slice(0, 4000)
            }
          })
        }
      }
      return null
    })
  }
  async finish(
    clientId: string,
    request: ResearchSubmissionFinishRequest
  ): Promise<ResearchSubmission> {
    return this.serial(async () => {
      const client = await this.getClient()
      const row = await client.researchSubmission.findUniqueOrThrow({ where: { id: request.id } })
      if (
        row.state !== 'sending' ||
        row.claimToken !== request.claimToken ||
        row.ownerEpoch !== this.epoch ||
        row.ownerClientId !== clientId
      )
        throw new Error('Research question delivery ownership changed.')
      const current = row.discussionSessionId
        ? await this.sessions.read(row.projectId, row.discussionSessionId)
        : undefined
      const recorded = current?.status === 'found' && hasMessage(current.session, row.messageId)
      // A failed renderer send may have appended before failing. Its model acceptance is unknown.
      const state =
        request.disposition === 'accepted' && recorded
          ? 'accepted'
          : recorded || current?.status !== 'found'
            ? 'uncertain'
            : 'failed'
      return toView(
        await client.researchSubmission.update({
          where: { id: row.id },
          data: {
            state,
            claimToken: null,
            error:
              state === 'accepted'
                ? null
                : (request.error ??
                  'The question was not confirmed. The saved draft remains available.')
          }
        })
      )
    })
  }
  async act(request: ResearchSubmissionActionRequest): Promise<ResearchSubmission> {
    return this.serial(() =>
      this.withProjectAvailable(request.projectId, async () => {
        const client = await this.getClient()
        await this.recover(client)
        const row = await client.researchSubmission.findUniqueOrThrow({ where: { id: request.id } })
        if (row.projectId !== request.projectId || row.sourceSessionId !== request.sourceSessionId)
          throw new Error('Research question identity does not match.')
        if (request.action === 'cancel') {
          if (!['queued', 'failed', 'uncertain'].includes(row.state))
            throw new Error('A sending or accepted question cannot be cancelled here.')
          return toView(
            await client.researchSubmission.update({
              where: { id: row.id },
              data: { state: 'cancelled', claimToken: null }
            })
          )
        }
        if (row.state !== 'failed')
          throw new Error(
            'Only a confirmed unsent question can be retried. Inspect the Discussion for an uncertain delivery.'
          )
        const current = row.discussionSessionId
          ? await this.sessions.read(row.projectId, row.discussionSessionId)
          : undefined
        if (
          current?.status === 'unreadable' ||
          (current?.status === 'found' && hasMessage(current.session, row.messageId))
        )
          throw new Error('Question delivery is uncertain. Inspect the Discussion first.')
        return toView(
          await client.researchSubmission.update({
            where: { id: row.id },
            data: { state: 'queued', error: null, claimToken: null }
          })
        )
      })
    )
  }
}
