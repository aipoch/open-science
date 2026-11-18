import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DurableJsonReadLimitError,
  readFileWithinLimit,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import { createLogger } from '@aipoch/diagnostics/node'
import { Prisma, type PrismaClient } from '@prisma/client'

import type { AcpTurnTokenUsage } from '../../shared/acp-usage-contract'

const SESSION_AUXILIARY_TURN_USAGE_SOURCES = [
  'reviewer',
  'side-chat',
  'vision',
  'session-details',
  'host-llm',
  'artifact-code-reconstruction',
  'context-compaction',
  'classification',
  'image-generation'
] as const

type SessionAuxiliaryTurnUsageSource = (typeof SESSION_AUXILIARY_TURN_USAGE_SOURCES)[number]

type SessionAuxiliaryTurnUsageRecord = Readonly<{
  projectId: string
  sessionId: string
  eventId: string
  source: SessionAuxiliaryTurnUsageSource
  frameworkId: string
  providerId?: string
  model?: string
  completedAtMs: number
  usage: AcpTurnTokenUsage
}>

type AuxiliaryUsageClient = () => Promise<PrismaClient>

class InvalidAuxiliaryUsageError extends Error {}
const log = createLogger('session-usage:auxiliary')

const nonEmpty = (value: string, field: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new InvalidAuxiliaryUsageError(`Auxiliary turn Usage ${field} must not be empty.`)
  return value
}

const nonNegative = (value: number, field: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidAuxiliaryUsageError(
      `Auxiliary turn Usage ${field} must be a non-negative safe integer.`
    )
  }
  return BigInt(value)
}

const optionalNonNegative = (value: number | undefined, field: string): bigint | null =>
  value === undefined ? null : nonNegative(value, field)

const optionalPositiveInt = (value: number | undefined, field: string): number | null => {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new InvalidAuxiliaryUsageError(
      `Auxiliary turn Usage ${field} must be a positive SQLite Int.`
    )
  }
  return value
}

type PendingAuxiliaryUsage = {
  projectId: string
  data: Prisma.SessionAuxiliaryTurnUsageUncheckedCreateInput
}

class AuxiliaryUsageOwnershipError extends Error {}

class SessionAuxiliaryTurnUsageRecorder {
  // Other auxiliary sources retain their existing in-memory retry policy.
  private readonly pending = new Map<string, PendingAuxiliaryUsage>()
  private retryOperation: Promise<void> | undefined

  constructor(
    private readonly client: AuxiliaryUsageClient,
    private readonly outboxRoot?: () => string
  ) {}

  private async outbox(create = false): Promise<string | undefined> {
    if (!this.outboxRoot) return undefined
    const directory = join(this.outboxRoot(), 'image-usage-outbox')
    if (create)
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!info) return undefined
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe image Usage outbox.')
    return directory
  }
  private outboxName(input: SessionAuxiliaryTurnUsageRecord): string {
    return (
      createHash('sha256')
        .update(JSON.stringify([input.projectId, input.sessionId, input.eventId]))
        .digest('hex') + '.json'
    )
  }
  private async removeOutbox(input: SessionAuxiliaryTurnUsageRecord): Promise<void> {
    const directory = await this.outbox()
    if (directory)
      await unlink(join(directory, this.outboxName(input))).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        }
      )
  }
  private async replayOutbox(): Promise<void> {
    const directory = await this.outbox()
    if (!directory) return
    let failure: unknown
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const path = join(directory, name)
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink())
          throw new InvalidAuxiliaryUsageError('Unsafe image Usage record.')
        const input = JSON.parse(
          await readFileWithinLimit(path, 16384)
        ) as SessionAuxiliaryTurnUsageRecord | null
        if (input?.source !== 'image-generation' || this.outboxName(input) !== name)
          throw new InvalidAuxiliaryUsageError('Invalid image Usage receipt.')
        await this.record(input, 'replay')
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          error instanceof InvalidAuxiliaryUsageError ||
          error instanceof DurableJsonReadLimitError
        ) {
          try {
            await rename(path, `${path}.${randomUUID()}.invalid`)
            log.warn('Isolated invalid image Usage receipt', { receipt: name })
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= renameError
          }
        } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error
      }
    }
    if (failure) throw failure
  }

  async record(
    input: SessionAuxiliaryTurnUsageRecord,
    mode: 'write' | 'replay' | 'stage' = 'write'
  ): Promise<boolean> {
    const replay = mode === 'replay'
    const projectId = nonEmpty(input.projectId, 'projectId')
    const sessionId = nonEmpty(input.sessionId, 'sessionId')
    const eventId = nonEmpty(input.eventId, 'eventId')
    const frameworkId = nonEmpty(input.frameworkId, 'frameworkId')
    const providerId =
      input.providerId === undefined ? null : nonEmpty(input.providerId, 'providerId')
    const model = input.model === undefined ? null : nonEmpty(input.model, 'model')
    if (!input.usage || typeof input.usage !== 'object')
      throw new InvalidAuxiliaryUsageError('Auxiliary turn Usage measurement is missing.')
    const cachedReadTokens = optionalNonNegative(input.usage.cachedReadTokens, 'cachedReadTokens')
    const cachedWriteTokens = optionalNonNegative(
      input.usage.cachedWriteTokens,
      'cachedWriteTokens'
    )
    if ((cachedReadTokens === null) !== (cachedWriteTokens === null)) {
      throw new InvalidAuxiliaryUsageError(
        'Auxiliary turn Usage cache read/write detail must be reported together.'
      )
    }

    const key = JSON.stringify([projectId, sessionId, eventId])
    // Validate and snapshot before queueing, so malformed input cannot poison later statistics and
    // callers cannot mutate token totals while a failed write is waiting to be retried.
    const data: PendingAuxiliaryUsage['data'] = {
      sessionId,
      eventId,
      source: input.source,
      frameworkId,
      providerId,
      model,
      completedAtMs: nonNegative(input.completedAtMs, 'completedAtMs'),
      inputTokens: nonNegative(input.usage.inputTokens, 'inputTokens'),
      cacheTokens: nonNegative(input.usage.cacheTokens, 'cacheTokens'),
      cachedReadTokens,
      cachedWriteTokens,
      outputTokens: nonNegative(input.usage.outputTokens, 'outputTokens'),
      modelCallCount: optionalPositiveInt(input.usage.turnCount, 'modelCallCount')
    }
    const entry = this.pending.get(key) ?? { projectId, data }
    if (input.source === 'image-generation' && !replay) {
      const directory = await this.outbox(true)
      if (directory) {
        await writeDurableJsonFile(join(directory, this.outboxName(input)), JSON.stringify(input))
        if (mode === 'stage') return false
      }
    }
    let inserted: boolean
    try {
      inserted = await this.write(entry)
      this.pending.delete(key)
      if (input.source === 'image-generation') await this.removeOutbox(input)
    } catch (error) {
      if (!(error instanceof AuxiliaryUsageOwnershipError)) this.pending.set(key, entry)
      else if (input.source === 'image-generation') {
        await this.removeOutbox(input)
        if (replay) return false
      }
      throw error
    }
    // A successful new measurement is also an opportunity to recover earlier failures. Keep its
    // result independent; unresolved earlier failures remain observable through flush on Usage reads.
    if (!replay) await this.flush().catch(() => undefined)
    return inserted
  }

  flush(): Promise<void> {
    this.retryOperation ??= this.retryPending().finally(() => {
      this.retryOperation = undefined
    })
    return this.retryOperation
  }

  async flushStaged(): Promise<void> {
    // A running flush may already have listed the outbox before the latest image was staged.
    await this.retryOperation?.catch(() => undefined)
    await this.flush()
  }

  private async retryPending(): Promise<void> {
    let failure: unknown
    try {
      await this.replayOutbox()
    } catch (error) {
      failure = error
    }
    for (const [key, entry] of [...this.pending]) {
      try {
        await this.write(entry)
        if (this.pending.get(key) === entry) this.pending.delete(key)
      } catch (error) {
        // Retrying must not resurrect deleted Sessions or retain invalid ownership forever.
        if (error instanceof AuxiliaryUsageOwnershipError) {
          if (this.pending.get(key) === entry) this.pending.delete(key)
        } else {
          failure ??= error
        }
      }
    }
    if (failure || this.pending.size > 0) {
      throw failure ?? new Error('Auxiliary turn Usage is pending persistence.')
    }
  }

  private async write({ projectId, data }: PendingAuxiliaryUsage): Promise<boolean> {
    const { sessionId, eventId } = data
    const client = await this.client()
    try {
      return await client.$transaction(async (tx) => {
        const owner = await tx.session.findFirst({
          where: { id: sessionId, projectId, deletedAtMs: null },
          select: { id: true }
        })
        if (!owner)
          throw new AuxiliaryUsageOwnershipError(
            'Auxiliary turn Usage Session ownership is unavailable.'
          )
        const existing = await tx.sessionAuxiliaryTurnUsage.findUnique({
          where: { sessionId_eventId: { sessionId, eventId } },
          select: { eventId: true }
        })
        if (existing) return false
        await tx.sessionAuxiliaryTurnUsage.create({
          data
        })
        return true
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false
      }
      throw error
    }
  }
}

export { SESSION_AUXILIARY_TURN_USAGE_SOURCES, SessionAuxiliaryTurnUsageRecorder }
export type { SessionAuxiliaryTurnUsageRecord, SessionAuxiliaryTurnUsageSource }
