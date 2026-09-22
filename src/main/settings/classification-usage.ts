import {
  AutomaticClassificationPausedError,
  AUTOMATIC_CLASSIFICATION_RUN_LIMIT,
  AUTOMATIC_CLASSIFICATION_DAY_LIMIT
} from '../../shared/classification'
import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type {
  ClassificationRequestUsage,
  ClassificationUsageContext
} from '../../shared/classification'

const measurement = z
  .object({
    eventId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    occurredAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
    status: z.enum(['started', 'completed', 'failed', 'interrupted']),
    inputTokens: z.number().int().nonnegative().safe().optional(),
    outputTokens: z.number().int().nonnegative().safe().optional()
  })
  .refine((value) => (value.inputTokens === undefined) === (value.outputTokens === undefined))

type Pending = {
  client: PrismaClient
  data: Prisma.ClassificationUsageUncheckedCreateInput
}

/** Records provider attempts independently of saved decisions and session membership. */
export class ClassificationUsageRecorder {
  private readonly recovery = new WeakMap<PrismaClient, Promise<void>>()
  // Retain completed measurements for write-only retries. If the process dies first, the durable
  // started row still reports unknown consumption instead of silently disappearing.
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly getClient: () => Promise<PrismaClient>) {}

  private async ready(client: PrismaClient): Promise<void> {
    let recovery = this.recovery.get(client)
    if (!recovery) {
      recovery = client.classificationUsage
        .updateMany({
          where: { status: 'started' },
          data: { status: 'interrupted' }
        })
        .then(() => undefined)
        .catch((error) => {
          this.recovery.delete(client)
          throw error
        })
      this.recovery.set(client, recovery)
    }
    await recovery
  }

  observer(
    context: ClassificationUsageContext
  ): (event: ClassificationRequestUsage) => Promise<void> {
    // Pin the database for this call: a retry must never write a measurement into another data root.
    let client: PrismaClient | undefined
    return async (event) => {
      const value = measurement.parse(event)
      client ??= await this.getClient()
      try {
        await this.ready(client)
      } catch (error) {
        if (context.scenario === 'literature-automatic')
          throw new AutomaticClassificationPausedError('storage-error')
        throw error
      }
      const data: Pending['data'] = {
        ...context,
        ...value,
        occurredAt: new Date(value.occurredAt),
        inputTokens: value.inputTokens === undefined ? null : BigInt(value.inputTokens),
        outputTokens: value.outputTokens === undefined ? null : BigInt(value.outputTokens),
        usageIncomplete: value.inputTokens === undefined
      }
      if (value.status === 'started') {
        // Fail before the provider request if its durable identity cannot be recorded.
        if (context.scenario === 'literature-automatic') {
          try {
            const reason = await client.$transaction(
              async (tx) => {
                if (!context.collectionId || !context.runId)
                  throw new Error('Missing automatic request owner')
                if (await tx.classificationUsage.findUnique({ where: { eventId: value.eventId } }))
                  return undefined
                const definition = await tx.literatureSmartCollection.findUniqueOrThrow({
                  where: { collectionId: context.collectionId }
                })
                if (
                  !definition.autoUpdate ||
                  (definition.automaticPauseReason &&
                    definition.automaticPauseReason !== 'interrupted')
                )
                  return definition.automaticPauseReason ?? 'interrupted'
                const run = await tx.literatureSmartRun.findUniqueOrThrow({
                  where: { id: context.runId }
                })
                if (
                  run.collectionId !== context.collectionId ||
                  run.state !== 'running' ||
                  run.ruleRevision !== definition.ruleRevision
                )
                  return 'interrupted'
                const recent = await tx.classificationUsage.count({
                  where: {
                    scenario: 'literature-automatic',
                    occurredAt: { gte: new Date(Date.now() - 86400000) }
                  }
                })
                const count = await tx.classificationUsage.count({
                  where: { scenario: 'literature-automatic', runId: context.runId }
                })
                const pause =
                  recent >= AUTOMATIC_CLASSIFICATION_DAY_LIMIT
                    ? 'daily-limit'
                    : count >= AUTOMATIC_CLASSIFICATION_RUN_LIMIT
                      ? 'run-limit'
                      : undefined
                if (pause) {
                  await tx.literatureSmartCollection.update({
                    where: { collectionId: context.collectionId },
                    data: { automaticPauseReason: pause }
                  })
                  return pause
                }
                await tx.classificationUsage.create({ data })
                return undefined
              },
              { maxWait: 30000 }
            )
            if (reason)
              throw new AutomaticClassificationPausedError(
                reason as 'run-limit' | 'daily-limit' | 'storage-error' | 'interrupted'
              )
          } catch (error) {
            if (error instanceof AutomaticClassificationPausedError) throw error
            throw new AutomaticClassificationPausedError('storage-error')
          }
        } else {
          await client.classificationUsage.upsert({
            where: { eventId: value.eventId },
            create: data,
            update: {}
          })
        }
        return
      }
      const entry = { client, data }
      this.pending.set(value.eventId, entry)
      try {
        await this.write(entry)
        if (this.pending.get(value.eventId) === entry) this.pending.delete(value.eventId)
      } catch {
        // Keep the pending measurement for write-only retries; automatic work must stop.
        if (context.scenario === 'literature-automatic')
          throw new AutomaticClassificationPausedError('storage-error')
      }
    }
  }

  private async write({ client, data }: Pending): Promise<void> {
    const result = await client.classificationUsage.updateMany({
      where: { eventId: data.eventId, status: { in: ['started', 'interrupted'] } },
      data: {
        model: data.model,
        status: data.status,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        usageIncomplete: data.usageIncomplete
      }
    })
    if (
      !result.count &&
      !(await client.classificationUsage.findUnique({
        where: { eventId: data.eventId },
        select: { eventId: true }
      }))
    ) {
      throw new Error('Classification usage request identity is missing.')
    }
  }

  async flush(recover = true): Promise<void> {
    if (recover) await this.ready(await this.getClient())
    for (const [id, entry] of this.pending) {
      await this.write(entry)
      if (this.pending.get(id) === entry) this.pending.delete(id)
    }
  }
}
