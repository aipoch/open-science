import { randomUUID } from 'node:crypto'
import type { TranslationUsageRepository, TranslationUsageUpdate } from './usage-storage.js'
import { standaloneWriteAdmission, type TranslationWriteAdmission } from './ports.js'
import {
  sanitizeTranslationUsage as sanitizeAcpTurnTokenUsage,
  type TranslationUsage as AcpTurnTokenUsage
} from './inference.js'

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
  client: TranslationUsageRepository
  eventId: string
  data: TranslationUsageUpdate
}

/** Durable provider attempts, separate from replaceable translation checkpoints. */
export class PdfTranslationUsageRecorder {
  private readonly recovery = new WeakMap<TranslationUsageRepository, Promise<void>>()
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly getClient: () => Promise<TranslationUsageRepository>,
    private readonly writes: TranslationWriteAdmission = standaloneWriteAdmission
  ) {}

  private ready(client: TranslationUsageRepository): Promise<void> {
    let recovery = this.recovery.get(client)
    if (!recovery) {
      recovery = client
        .recoverStarted()
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
    return this.writes.write(async () => {
      const client = await this.getClient()
      await this.ready(client)
      // Do not accumulate unflushed completions or send more billable requests while storage fails.
      await this.flushAdmitted()
      const eventId = randomUUID()
      await client.createAttempt({ ...context, eventId, occurredAt: new Date(), status: 'started' })
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
          await this.writes.write(() => this.persist(entry))
          this.pending.delete(eventId)
        } catch {
          // Keep the durable started row and retry only this write. Never repeat the provider call.
        }
      }
    })
  }

  private async persist({ client, eventId, data }: Pending): Promise<void> {
    const result = await client.completeAttempt(eventId, data)
    if (!result.count && !(await client.hasAttempt(eventId)))
      throw new Error('Translation usage request identity is missing.')
  }

  async recover(): Promise<void> {
    await this.writes.write(async () => this.ready(await this.getClient()))
  }

  async flush(): Promise<void> {
    if (this.pending.size) await this.writes.write(() => this.flushAdmitted())
  }

  private async flushAdmitted(): Promise<void> {
    for (const [id, entry] of this.pending) {
      await this.persist(entry)
      if (this.pending.get(id) === entry) this.pending.delete(id)
    }
  }
}
