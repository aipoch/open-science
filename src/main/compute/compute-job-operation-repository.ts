import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import type { ComputeJobStatus } from '../../shared/compute'

type OperationClient = Pick<PrismaClient, '$transaction' | 'computeJobOperation'>
type OperationClientProvider = () => Promise<OperationClient>

type ComputeJobOperationKind = 'cancel'
type ComputeJobOperationPhase = 'active' | 'settled'
type ComputeJobOperationOutcome = 'fulfilled' | 'superseded'

type ComputeJobOperationRecord = Readonly<{
  id: string
  jobId: string
  kind: ComputeJobOperationKind
  phase: ComputeJobOperationPhase
  outcome: ComputeJobOperationOutcome | null
  revision: number
  attemptCount: number
  eligibleAt: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
  createdAt: Date
  settledAt: Date | null
  updatedAt: Date
}>

type ComputeJobOperationScope = Readonly<{
  projectId: string
  sessionId: string
  providerId: string
}>

type ClaimedComputeJobOperation = Readonly<{
  operation: ComputeJobOperationRecord
  jobId: string
}>

const ACTIVE_STATUSES = ['queued', 'submitted', 'running'] as const
const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'error'] as const

const asKind = (value: string): ComputeJobOperationKind => {
  switch (value) {
    case 'cancel':
      return value
  }
  throw new Error(`Invalid Compute Job operation kind: ${value}`)
}

const asPhase = (value: string): ComputeJobOperationPhase => {
  switch (value) {
    case 'active':
    case 'settled':
      return value
  }
  throw new Error(`Invalid Compute Job operation phase: ${value}`)
}

const asOutcome = (value: string | null): ComputeJobOperationOutcome | null => {
  switch (value) {
    case null:
    case 'fulfilled':
    case 'superseded':
      return value
  }
  throw new Error(`Invalid Compute Job operation outcome: ${value}`)
}

const asJobStatus = (value: string): ComputeJobStatus => value as ComputeJobStatus

const toRecord = (row: {
  id: string
  jobId: string
  kind: string
  phase: string
  outcome: string | null
  revision: number
  attemptCount: number
  eligibleAt: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
  createdAt: Date
  settledAt: Date | null
  updatedAt: Date
}): ComputeJobOperationRecord => ({
  ...row,
  kind: asKind(row.kind),
  phase: asPhase(row.phase),
  outcome: asOutcome(row.outcome)
})

class ComputeJobOperationRepository {
  constructor(private readonly getClient: OperationClientProvider) {}

  async get(
    jobId: string,
    kind: ComputeJobOperationKind
  ): Promise<ComputeJobOperationRecord | null> {
    const client = await this.getClient()
    const row = await client.computeJobOperation.findUnique({
      where: { jobId_kind: { jobId, kind } }
    })
    return row ? toRecord(row) : null
  }

  // This is the operation request linearization point. Kind-specific atomic job transitions stay
  // exhaustive here so a future kind must define its persistence semantics explicitly.
  async request(
    jobId: string,
    kind: ComputeJobOperationKind,
    scope: ComputeJobOperationScope,
    now: Date
  ): Promise<
    | { found: false }
    | { found: true; jobStatus: ComputeJobStatus; record: ComputeJobOperationRecord }
  > {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const job = await transaction.computeJob.findFirst({
        where: {
          id: jobId,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          providerId: scope.providerId
        },
        select: { status: true }
      })
      if (!job) return { found: false } as const

      const existing = await transaction.computeJobOperation.findUnique({
        where: { jobId_kind: { jobId, kind } }
      })
      if (existing) {
        return {
          found: true,
          jobStatus: asJobStatus(job.status),
          record: toRecord(existing)
        } as const
      }

      switch (kind) {
        case 'cancel': {
          const terminal = (TERMINAL_STATUSES as readonly string[]).includes(job.status)
          const queued = job.status === 'queued'
          const settled = terminal || queued
          const row = await transaction.computeJobOperation.create({
            data: {
              id: randomUUID(),
              jobId,
              kind,
              phase: settled ? 'settled' : 'active',
              outcome: terminal ? 'superseded' : queued ? 'fulfilled' : null,
              revision: 1,
              attemptCount: 0,
              createdAt: now,
              settledAt: settled ? now : null,
              updatedAt: now
            }
          })
          if (queued) {
            await transaction.computeJob.updateMany({
              where: { id: jobId, status: 'queued' },
              data: { status: 'failed', finishedAt: now }
            })
          }
          return {
            found: true,
            jobStatus: queued ? ('failed' as const) : asJobStatus(job.status),
            record: toRecord(row)
          } as const
        }
      }
    })
  }

  // `eligibleAt = null` is ready now; a non-null value delays retry until that instant.
  async claimNext(
    kind: ComputeJobOperationKind,
    now: Date,
    leaseMs: number,
    claimToken: string
  ): Promise<ClaimedComputeJobOperation | null> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      switch (kind) {
        case 'cancel': {
          const terminal = await transaction.computeJobOperation.findFirst({
            where: {
              kind,
              phase: 'active',
              job: { is: { status: { in: [...TERMINAL_STATUSES] } } }
            },
            orderBy: { createdAt: 'asc' }
          })
          if (terminal) {
            await transaction.computeJobOperation.updateMany({
              where: { id: terminal.id, revision: terminal.revision, phase: 'active' },
              data: {
                phase: 'settled',
                outcome: 'superseded',
                revision: { increment: 1 },
                eligibleAt: null,
                claimToken: null,
                claimExpiresAt: null,
                settledAt: now,
                updatedAt: now
              }
            })
          }
          break
        }
      }

      const candidate = await transaction.computeJobOperation.findFirst({
        where: {
          kind,
          phase: 'active',
          job: { is: { status: { in: [...ACTIVE_STATUSES] } } },
          OR: [
            {
              claimToken: null,
              claimExpiresAt: null,
              OR: [{ eligibleAt: null }, { eligibleAt: { lte: now } }]
            },
            { claimToken: { not: null }, claimExpiresAt: { lte: now } }
          ]
        },
        orderBy: { createdAt: 'asc' }
      })
      if (!candidate) return null

      const claimed = await transaction.computeJobOperation.updateMany({
        where: { id: candidate.id, revision: candidate.revision, phase: 'active' },
        data: {
          revision: { increment: 1 },
          attemptCount: { increment: 1 },
          eligibleAt: null,
          claimToken,
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          updatedAt: now
        }
      })
      if (claimed.count === 0) return null
      const row = await transaction.computeJobOperation.findUniqueOrThrow({
        where: { id: candidate.id }
      })
      return { operation: toRecord(row), jobId: candidate.jobId }
    })
  }

  async fulfill(claim: ClaimedComputeJobOperation, now: Date): Promise<boolean> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      switch (claim.operation.kind) {
        case 'cancel': {
          const terminalized = await transaction.computeJob.updateMany({
            where: {
              id: claim.jobId,
              status: { in: [...ACTIVE_STATUSES] },
              operations: {
                some: {
                  id: claim.operation.id,
                  phase: 'active',
                  revision: claim.operation.revision,
                  claimToken: claim.operation.claimToken
                }
              }
            },
            data: { status: 'failed', finishedAt: now }
          })
          if (terminalized.count === 0) return false
          break
        }
      }

      const settled = await transaction.computeJobOperation.updateMany({
        where: {
          id: claim.operation.id,
          phase: 'active',
          revision: claim.operation.revision,
          claimToken: claim.operation.claimToken
        },
        data: {
          phase: 'settled',
          outcome: 'fulfilled',
          revision: { increment: 1 },
          eligibleAt: null,
          claimToken: null,
          claimExpiresAt: null,
          settledAt: now,
          updatedAt: now
        }
      })
      if (settled.count !== 1) throw new Error('Operation fulfillment lost its ownership claim')
      return true
    })
  }

  async fulfillCancellationAfterRemoteCleanup(
    jobId: string,
    scope: ComputeJobOperationScope,
    now: Date
  ): Promise<boolean> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const job = await transaction.computeJob.findFirst({
        where: {
          id: jobId,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          providerId: scope.providerId
        },
        select: { status: true }
      })
      if (!job) throw new Error('Compute Job cleanup scope does not match.')
      const operation = await transaction.computeJobOperation.findUnique({
        where: { jobId_kind: { jobId, kind: 'cancel' } }
      })
      if (!operation || operation.phase !== 'active') {
        if ((ACTIVE_STATUSES as readonly string[]).includes(job.status)) {
          throw new Error('Compute Job cancellation is not active.')
        }
        return false
      }
      if ((ACTIVE_STATUSES as readonly string[]).includes(job.status)) {
        await transaction.computeJob.update({
          where: { id: jobId },
          data: { status: 'failed', finishedAt: now }
        })
      }
      const settled = await transaction.computeJobOperation.updateMany({
        where: {
          id: operation.id,
          revision: operation.revision,
          phase: 'active',
          claimToken: null
        },
        data: {
          phase: 'settled',
          outcome: 'fulfilled',
          revision: { increment: 1 },
          eligibleAt: null,
          claimToken: null,
          claimExpiresAt: null,
          settledAt: now,
          updatedAt: now
        }
      })
      if (settled.count !== 1) throw new Error('Cancellation fulfillment lost its ownership claim')
      return true
    })
  }

  async retry(claim: ClaimedComputeJobOperation, now: Date, eligibleAt: Date): Promise<boolean> {
    const client = await this.getClient()
    const data: Prisma.ComputeJobOperationUpdateManyMutationInput = {
      revision: { increment: 1 },
      eligibleAt,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now
    }
    const result = await client.computeJobOperation.updateMany({
      where: {
        id: claim.operation.id,
        phase: 'active',
        revision: claim.operation.revision,
        claimToken: claim.operation.claimToken
      },
      data
    })
    return result.count === 1
  }
}

export { ComputeJobOperationRepository }
export type {
  ClaimedComputeJobOperation,
  ComputeJobOperationKind,
  ComputeJobOperationOutcome,
  ComputeJobOperationPhase,
  ComputeJobOperationRecord,
  ComputeJobOperationScope,
  OperationClient,
  OperationClientProvider
}
