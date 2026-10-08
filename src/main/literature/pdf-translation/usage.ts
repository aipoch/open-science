import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { sanitizeAcpTurnTokenUsage, type AcpTurnTokenUsage } from '../../../shared/acp'
import { withDataRootWrite } from '../../storage/migration-state'

type AttemptContext = {
  runId: string
  attachmentVersionId?: string
  sourceIndex: number
  providerId: string
  frameworkId: string
  model: string
}
type Completion = {
  status: 'completed' | 'failed' | 'interrupted'
  model?: string
  usage?: AcpTurnTokenUsage
}
type Pending = {
  client: PrismaClient
  eventId: string
  data: Prisma.PdfTranslationUsageUpdateManyMutationInput
}

/** Durable provider attempts, separate from replaceable translation checkpoints. */
export class PdfTranslationUsageRecorder {
  private readonly recovery = new WeakMap<PrismaClient, Promise<void>>()
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly getClient: () => Promise<PrismaClient>) {}

  private ready(client: PrismaClient): Promise<void> {
    let recovery = this.recovery.get(client)
    if (!recovery) {
      recovery = client.pdfTranslationUsage
        .updateMany({ where: { status: 'started' }, data: { status: 'interrupted' } })
        .then(() => undefined)
        .catch((error) => {
          this.recovery.delete(client)
          throw error
        })
      this.recovery.set(client, recovery)
    }
    return recovery
  }

  async start(context: AttemptContext): Promise<(completion: Completion) => Promise<void>> {
    return withDataRootWrite(async () => {
      const client = await this.getClient()
      await this.ready(client)
      // Do not accumulate unflushed completions or send more billable requests while storage fails.
      await this.flush()
      const eventId = randomUUID()
      await client.pdfTranslationUsage.create({
        data: { ...context, eventId, occurredAt: new Date(), status: 'started' }
      })
      let finished = false
      return async (completion) => {
        if (finished) return
        finished = true
        const usage = sanitizeAcpTurnTokenUsage(completion.usage)
        const entry: Pending = {
          client,
          eventId,
          data: {
            status: completion.status,
            completedAt: new Date(),
            ...(completion.model?.trim() ? { model: completion.model } : {}),
            inputTokens: usage ? BigInt(usage.inputTokens) : null,
            cacheTokens: usage ? BigInt(usage.cacheTokens) : null,
            cachedReadTokens:
              usage?.cachedReadTokens === undefined ? null : BigInt(usage.cachedReadTokens),
            cachedWriteTokens:
              usage?.cachedWriteTokens === undefined ? null : BigInt(usage.cachedWriteTokens),
            outputTokens: usage ? BigInt(usage.outputTokens) : null,
            usageIncomplete: !usage
          }
        }
        this.pending.set(eventId, entry)
        try {
          await this.write(entry)
          this.pending.delete(eventId)
        } catch {
          // Keep the durable started row and retry only this write. Never repeat the provider call.
        }
      }
    })
  }

  private async write({ client, eventId, data }: Pending): Promise<void> {
    return withDataRootWrite(async () => {
      const result = await client.pdfTranslationUsage.updateMany({
        where: { eventId, status: { in: ['started', 'interrupted'] } },
        data
      })
      if (!result.count && !(await client.pdfTranslationUsage.findUnique({ where: { eventId } })))
        throw new Error('Translation usage request identity is missing.')
    })
  }

  async recover(): Promise<void> {
    await withDataRootWrite(async () => this.ready(await this.getClient()))
  }

  async flush(): Promise<void> {
    for (const [id, entry] of this.pending) {
      await this.write(entry)
      if (this.pending.get(id) === entry) this.pending.delete(id)
    }
  }
}
