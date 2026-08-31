import { Prisma, type PrismaClient } from '@prisma/client'

import type { AcpTurnTokenUsage } from '../../shared/acp'

const SESSION_AUXILIARY_TURN_USAGE_SOURCES = [
  'reviewer',
  'side-chat',
  'vision',
  'session-details',
  'host-llm',
  'artifact-code-reconstruction',
  'context-compaction'
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

const nonEmpty = (value: string, field: string): string => {
  if (!value.trim()) throw new Error(`Auxiliary turn Usage ${field} must not be empty.`)
  return value
}

const nonNegative = (value: number, field: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Auxiliary turn Usage ${field} must be a non-negative safe integer.`)
  }
  return BigInt(value)
}

const optionalNonNegative = (value: number | undefined, field: string): bigint | null =>
  value === undefined ? null : nonNegative(value, field)

const optionalPositiveInt = (value: number | undefined, field: string): number | null => {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`Auxiliary turn Usage ${field} must be a positive SQLite Int.`)
  }
  return value
}

class SessionAuxiliaryTurnUsageRecorder {
  constructor(private readonly client: AuxiliaryUsageClient) {}

  async record(input: SessionAuxiliaryTurnUsageRecord): Promise<boolean> {
    const projectId = nonEmpty(input.projectId, 'projectId')
    const sessionId = nonEmpty(input.sessionId, 'sessionId')
    const eventId = nonEmpty(input.eventId, 'eventId')
    const frameworkId = nonEmpty(input.frameworkId, 'frameworkId')
    const providerId =
      input.providerId === undefined ? null : nonEmpty(input.providerId, 'providerId')
    const model = input.model === undefined ? null : nonEmpty(input.model, 'model')
    const cachedReadTokens = optionalNonNegative(input.usage.cachedReadTokens, 'cachedReadTokens')
    const cachedWriteTokens = optionalNonNegative(
      input.usage.cachedWriteTokens,
      'cachedWriteTokens'
    )
    if ((cachedReadTokens === null) !== (cachedWriteTokens === null)) {
      throw new Error('Auxiliary turn Usage cache read/write detail must be reported together.')
    }

    const client = await this.client()
    try {
      return await client.$transaction(async (tx) => {
        const owner = await tx.session.findFirst({
          where: { id: sessionId, projectId, deletedAtMs: null },
          select: { id: true }
        })
        if (!owner) throw new Error('Auxiliary turn Usage Session ownership is unavailable.')
        const existing = await tx.sessionAuxiliaryTurnUsage.findUnique({
          where: { sessionId_eventId: { sessionId, eventId } },
          select: { eventId: true }
        })
        if (existing) return false
        await tx.sessionAuxiliaryTurnUsage.create({
          data: {
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
