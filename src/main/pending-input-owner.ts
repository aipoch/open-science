import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  pendingInputCommandSchema,
  pendingInputContentSchema,
  persistedPendingInputContentSchema,
  pendingInputMatchesContent,
  type PendingInput,
  type PendingInputCommand,
  type PendingInputContent,
  type PersistedPendingInputContent,
  type PendingInputResult,
  type PendingInputSnapshot
} from '../shared/pending-input'
import { toPersistedUploadedAttachment, type UploadedAttachment } from '../shared/uploads'
import type { ApplicationCallerLease } from './application-command-router'

type Row = {
  id: string
  projectId: string
  sessionId: string
  position: number
  revision: number
  phase: PendingInput['phase']
  content: string
  error: string | null
}
type Options = {
  withWrite<T>(operation: () => Promise<T>): Promise<T>
  getClient(): Promise<Pick<PrismaClient, '$executeRaw' | '$queryRaw'>>
  withSessionMutation<T>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T>
  validateSession(content: PendingInputContent | PersistedPendingInputContent): Promise<void>
  publishAttachments(content: PendingInputContent): Promise<UploadedAttachment[]>
  changed(snapshot: PendingInputSnapshot): void
}

// Earlier queue records used runtime attachment fields. Read them by immutable version identity;
// never resolve the historical path. Subsequent edits write only the new path-free representation.
const parseStoredPendingInputContent = (value: unknown): PersistedPendingInputContent => {
  const current = persistedPendingInputContentSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = pendingInputContentSchema.parse(value)
  return persistedPendingInputContentSchema.parse({
    ...legacy,
    snapshot: {
      ...legacy.snapshot,
      attachments: legacy.snapshot.attachments.map(toPersistedUploadedAttachment)
    }
  })
}

// One main-process owner serializes queue mutations and dispatch claims across every renderer.
// A renderer lease is only a live dispatch capability; it is never persisted or timed out while live.
export class PendingInputOwner {
  private readonly generation = randomUUID()
  private revision = 0
  private tail: Promise<unknown> = Promise.resolve()
  private initialized = false
  private disposed = false
  private readonly claims = new Map<string, { lease: ApplicationCallerLease; claimId: string }>()
  private readonly leases = new Map<ApplicationCallerLease, () => void>()

  constructor(private readonly options: Options) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() =>
      this.options.withWrite(async () => {
        if (this.disposed) throw new Error('Pending input owner is unavailable.')
        if (!this.initialized) {
          const client = await this.options.getClient()
          // Only explicit deletion evidence permits cleanup; missing Session projections may
          // simply be rebuilding and must never erase pending input.
          await client.$executeRaw`DELETE FROM "PendingInput" WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "deletedAt" IS NOT NULL) OR "sessionId" IN (SELECT "id" FROM "Session" WHERE "deletedAtMs" IS NOT NULL)`
          await client.$executeRaw`UPDATE "PendingInput" SET "phase" = 'recovery-required', "revision" = "revision" + 1`
          this.initialized = true
        }
        return operation()
      })
    )
    this.tail = result.catch(() => undefined)
    return result
  }

  private async snapshot(): Promise<PendingInputSnapshot> {
    const client = await this.options.getClient()
    const rows = await client.$queryRaw<
      Row[]
    >`SELECT * FROM "PendingInput" ORDER BY "position", "id"`
    return {
      generation: this.generation,
      revision: this.revision,
      items: rows.map((row) => ({
        ...parseStoredPendingInputContent(JSON.parse(row.content)),
        revision: Number(row.revision),
        position: Number(row.position),
        phase: row.phase,
        ...(row.error ? { error: JSON.parse(row.error) as PendingInput['error'] } : {})
      }))
    }
  }

  private async publish(): Promise<PendingInputSnapshot> {
    this.revision++
    const snapshot = await this.snapshot()
    try {
      this.options.changed(snapshot)
    } catch {
      // Delivery is a projection: a failed subscriber must not turn a committed write into a
      // rejected admission. Reconnecting clients fetch the authoritative snapshot.
    }
    return snapshot
  }

  private observeLease(lease: ApplicationCallerLease): void {
    if (this.leases.has(lease)) return
    const release = (): void => {
      void this.serial(async () => {
        const client = await this.options.getClient()
        for (const [id, owner] of this.claims) {
          if (owner.lease !== lease) continue
          await client.$executeRaw`UPDATE "PendingInput" SET "phase" = 'recovery-required', "revision" = "revision" + 1 WHERE "id" = ${id}`
          this.claims.delete(id)
        }
        this.leases.get(lease)?.()
        this.leases.delete(lease)
        await this.publish()
      }).catch(() => undefined)
    }
    if (lease.signal.aborted || !lease.isCurrent())
      throw new Error('Pending input caller is unavailable.')
    lease.signal.addEventListener('abort', release, { once: true })
    this.leases.set(lease, () => lease.signal.removeEventListener('abort', release))
  }

  execute(
    command: PendingInputCommand,
    lease: ApplicationCallerLease
  ): Promise<PendingInputResult> {
    const request = pendingInputCommandSchema.parse(command)
    return this.serial(async () => {
      if (lease.signal.aborted || !lease.isCurrent())
        throw new Error('Pending input caller is unavailable.')
      if (request.operation === 'list') return this.snapshot()
      const client = await this.options.getClient()
      if (request.operation === 'enqueue') {
        const content = request.content
        return this.options.withSessionMutation(content.projectId, content.sessionId, async () => {
          await this.options.validateSession(content)
          const prior = (await this.snapshot()).items.find((item) => item.id === content.id)
          if (
            prior &&
            (prior.projectId !== content.projectId || prior.sessionId !== content.sessionId)
          )
            throw new Error('A queued message cannot be moved to another Session.')
          if (
            prior &&
            request.expectedRevision !== undefined &&
            (prior.revision !== request.expectedRevision || this.claims.has(prior.id))
          )
            throw new Error('The queued message changed. Review the current queue and try again.')
          if (!prior && request.expectedRevision !== undefined)
            throw new Error('The queued message no longer exists.')
          const attachments = await this.options.publishAttachments(content)
          const saved = persistedPendingInputContentSchema.parse({
            ...content,
            snapshot: {
              ...content.snapshot,
              attachments: attachments.map(toPersistedUploadedAttachment)
            }
          })
          if (attachments.some((file) => !file.versionId || !file.versionNumber))
            throw new Error('Queued attachments must have durable versions.')
          // Publication may finish after the caller disappeared. Its bytes now belong to the Session;
          // retain the input for review instead of acknowledging automatic dispatch to a dead client.
          if (prior && request.expectedRevision === undefined) {
            if (!pendingInputMatchesContent(prior, saved))
              throw new Error('Conflicting pending input identity.')
            return { ...(await this.snapshot()), item: prior }
          }
          const phase = lease.signal.aborted || !lease.isCurrent() ? 'recovery-required' : 'queued'
          if (prior) {
            await client.$executeRaw`UPDATE "PendingInput" SET "content" = ${JSON.stringify(saved)}, "phase" = ${phase}, "revision" = "revision" + 1, "error" = NULL WHERE "id" = ${saved.id}`
          } else {
            await client.$executeRaw`INSERT INTO "PendingInput" ("id", "projectId", "sessionId", "position", "revision", "phase", "content") VALUES (${saved.id}, ${saved.projectId}, ${saved.sessionId}, (SELECT COALESCE(MAX("position"), 0) + 1 FROM "PendingInput"), 1, ${phase}, ${JSON.stringify(saved)})`
          }

          const snapshot = await this.publish()
          return { ...snapshot, item: snapshot.items.find((item) => item.id === saved.id) }
        })
      }
      const snapshot = await this.snapshot()
      const item = snapshot.items.find((item) => item.id === request.id)
      if (!item || item.revision !== request.revision)
        throw new Error('The queued message changed. Review the current queue and try again.')
      return this.options.withSessionMutation(item.projectId, item.sessionId, async () => {
        if (request.operation === 'settle') {
          const claim = this.claims.get(item.id)
          if (
            claim?.lease !== lease ||
            (request.claimId && request.claimId !== claim.claimId) ||
            item.phase !== 'sending'
          )
            throw new Error('The queued message dispatch is no longer owned by this client.')
          if (request.outcome === 'sent') {
            await client.$executeRaw`DELETE FROM "PendingInput" WHERE "id" = ${item.id}`
          } else {
            const phase =
              request.outcome === 'uncertain'
                ? 'recovery-required'
                : request.outcome === 'error'
                  ? 'error'
                  : 'queued'
            await client.$executeRaw`UPDATE "PendingInput" SET "phase" = ${phase}, "revision" = "revision" + 1, "error" = ${request.error ? JSON.stringify(request.error) : null} WHERE "id" = ${item.id}`
          }
          this.claims.delete(item.id)
        } else {
          if (this.claims.has(item.id) || item.phase === 'sending')
            throw new Error('The queued message is being sent.')
          if (request.operation === 'remove') {
            await client.$executeRaw`DELETE FROM "PendingInput" WHERE "id" = ${item.id}`
          } else if (request.operation === 'move') {
            const items = snapshot.items.filter(
              (candidate) => candidate.sessionId === item.sessionId && candidate.id !== item.id
            )
            const target = items.findIndex((candidate) => candidate.id === request.targetId)
            if (target < 0) throw new Error('The queue destination no longer exists.')
            items.splice(target + (request.edge === 'after' ? 1 : 0), 0, item)
            // A single SQLite statement makes a reorder atomic without acquiring a second writer.
            const cases = Prisma.join(
              items.map((candidate, index) => Prisma.sql`WHEN ${candidate.id} THEN ${index}`),
              ' '
            )
            await client.$executeRaw(
              Prisma.sql`UPDATE "PendingInput" SET "position" = CASE "id" ${cases} END, "revision" = "revision" + CASE WHEN "phase" = 'sending' THEN 0 ELSE 1 END WHERE "sessionId" = ${item.sessionId}`
            )
          } else {
            if (request.operation !== 'edit') {
              try {
                await this.options.validateSession(item)
              } catch (error) {
                if (request.operation === 'claim') {
                  await client.$executeRaw`UPDATE "PendingInput" SET "phase" = 'recovery-required', "revision" = "revision" + 1 WHERE "id" = ${item.id}`
                  await this.publish()
                }
                throw error
              }
            }
            if (request.operation === 'claim') {
              if (item.phase !== 'queued' && !request.prioritize)
                throw new Error('Review this queued message before sending it.')
              if (
                [...this.claims.keys()].some((id) =>
                  snapshot.items.some(
                    (candidate) => candidate.id === id && candidate.sessionId === item.sessionId
                  )
                )
              )
                throw new Error('Another queued message is being sent in this Session.')
              this.observeLease(lease)
            }
            const phase =
              request.operation === 'claim'
                ? 'sending'
                : request.operation === 'edit'
                  ? 'recovery-required'
                  : 'queued'
            if (request.operation === 'claim' && request.prioritize) {
              await client.$executeRaw`UPDATE "PendingInput" SET "phase" = ${phase}, "error" = NULL, "revision" = "revision" + 1, "position" = (SELECT MIN("position") - 1 FROM "PendingInput" WHERE "sessionId" = ${item.sessionId}) WHERE "id" = ${item.id}`
            } else {
              await client.$executeRaw`UPDATE "PendingInput" SET "phase" = ${phase}, "error" = NULL, "revision" = "revision" + 1 WHERE "id" = ${item.id}`
            }
            if (request.operation === 'claim')
              this.claims.set(item.id, { lease, claimId: request.claimId })
          }
        }
        const updated = await this.publish()
        return { ...updated, item: updated.items.find((candidate) => candidate.id === item.id) }
      })
    })
  }

  deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.serial(async () => {
      const client = await this.options.getClient()
      await client.$executeRaw`DELETE FROM "PendingInput" WHERE "projectId" = ${projectId} AND "sessionId" = ${sessionId}`
      await this.publish()
    })
  }

  deleteProject(projectId: string): Promise<void> {
    return this.serial(async () => {
      const client = await this.options.getClient()
      await client.$executeRaw`DELETE FROM "PendingInput" WHERE "projectId" = ${projectId}`
      await this.publish()
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const unsubscribe of this.leases.values()) unsubscribe()
    this.leases.clear()
    await this.tail
    this.claims.clear()
  }
}
