import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type {
  ArtifactWriteReservation,
  ReleaseArtifactWriteReservationRequest,
  ReserveArtifactWriteRequest
} from '../../shared/artifact-provenance'
import { availableBytes } from '../storage/usage'
import {
  LOCAL_RESOURCE_BUDGETS,
  assertWithinResourceBudget,
  type LocalResourceBudgetOverrides
} from '../resource-budget'
import { assertDiskReserve } from '../bounded-file-io'
import type { ArtifactRepository } from './repository'

const RESERVATION_METADATA_BYTES = 64 * 1024
const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000
const COUNTED_VERSION_STATES = ['staging', 'pending', 'finalized']

const usageBytes = (value: bigint | null | undefined): number =>
  value !== undefined && value !== null && value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value ?? 0n)

type ReservationRecord = ArtifactWriteReservation &
  ReserveArtifactWriteRequest & {
    physicalBytes: number
  }

type ArtifactWriteBudgetOwnerOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  compatibilityRepository: Pick<
    ArtifactRepository,
    'listPendingRunFiles' | 'listPendingRunPublications'
  >
  resourceBudgets?: LocalResourceBudgetOverrides
  getAvailableBytes?: (path: string) => Promise<number>
  now?: () => number
  reservationTtlMs?: number
}

class ArtifactWriteBudgetOwner {
  private readonly reservations = new Map<string, ReservationRecord>()
  private tail = Promise.resolve()

  constructor(private readonly options: ArtifactWriteBudgetOwnerOptions) {}

  reserve(request: ReserveArtifactWriteRequest): Promise<ArtifactWriteReservation> {
    return this.serialized(async () => {
      this.pruneExpired()
      const budgets = { ...LOCAL_RESOURCE_BUDGETS, ...this.options.resourceBudgets }
      assertWithinResourceBudget('file', request.fileBytes, budgets.artifactFileBytes)

      const duplicate = [...this.reservations.values()].find(
        (reservation) =>
          reservation.projectId === request.projectId &&
          reservation.appSessionId === request.appSessionId &&
          reservation.writeOperationId === request.writeOperationId
      )
      if (duplicate) {
        if (
          duplicate.fileBytes !== request.fileBytes ||
          duplicate.filename !== request.filename ||
          duplicate.artifactRunId !== request.artifactRunId
        ) {
          throw new Error(
            `Artifact write operation was reused for a different reservation: ${request.writeOperationId}`
          )
        }
        return this.publicReservation(duplicate)
      }

      const client = await this.options.getClient()
      const existing = await client.artifactVersion.findUnique({
        where: { writeOperationId: request.writeOperationId }
      })
      if (existing && Number(existing.sizeBytes) !== request.fileBytes) {
        throw new Error(
          `Artifact write operation was reused with a different size: ${request.writeOperationId}`
        )
      }

      const outstanding = [...this.reservations.values()].filter(
        (reservation) =>
          reservation.projectId === request.projectId &&
          reservation.appSessionId === request.appSessionId
      )
      // Read persisted ownership before aggregate totals. If a Version becomes counted between
      // these reads, the result is conservatively double-counted rather than under-counted.
      const persistedOutstanding =
        outstanding.length === 0
          ? []
          : await client.artifactVersion.findMany({
              where: {
                writeOperationId: {
                  in: outstanding.map((reservation) => reservation.writeOperationId)
                },
                state: { in: COUNTED_VERSION_STATES }
              },
              select: { writeOperationId: true }
            })
      const [turnUsage, sessionUsage, compatibility] = await Promise.all([
        client.artifactVersion.aggregate({
          where: {
            artifactRunId: request.artifactRunId,
            state: { in: COUNTED_VERSION_STATES }
          },
          _sum: { sizeBytes: true }
        }),
        client.artifactVersion.aggregate({
          where: {
            artifact: {
              projectId: request.projectId,
              sessionId: request.appSessionId
            },
            state: { in: COUNTED_VERSION_STATES }
          },
          _sum: { sizeBytes: true }
        }),
        this.compatibilityUsage(request)
      ])
      const persistedOperationIds = new Set(
        persistedOutstanding.map((version) => version.writeOperationId)
      )
      const logicalOutstanding = outstanding.filter(
        (reservation) => !persistedOperationIds.has(reservation.writeOperationId)
      )
      const incomingLogicalBytes = existing ? 0 : request.fileBytes
      const outstandingSessionBytes = logicalOutstanding.reduce(
        (total, reservation) => total + reservation.fileBytes,
        0
      )
      const outstandingTurnBytes = logicalOutstanding
        .filter((reservation) => reservation.artifactRunId === request.artifactRunId)
        .reduce((total, reservation) => total + reservation.fileBytes, 0)
      assertWithinResourceBudget(
        'turn',
        usageBytes(turnUsage._sum.sizeBytes) +
          compatibility.turnBytes +
          outstandingTurnBytes +
          incomingLogicalBytes,
        budgets.artifactTurnBytes
      )
      assertWithinResourceBudget(
        'session',
        usageBytes(sessionUsage._sum.sizeBytes) +
          compatibility.sessionBytes +
          outstandingSessionBytes +
          incomingLogicalBytes,
        budgets.artifactSessionBytes
      )

      const physicalBytes = request.fileBytes * (existing ? 1 : 2) + RESERVATION_METADATA_BYTES
      const outstandingPhysicalBytes = [...this.reservations.values()].reduce(
        (total, reservation) => total + reservation.physicalBytes,
        0
      )
      const diskAvailable = await (this.options.getAvailableBytes ?? availableBytes)(
        this.options.storageRoot
      )
      assertDiskReserve(
        diskAvailable - outstandingPhysicalBytes,
        physicalBytes,
        budgets.diskReserveBytes
      )

      const record: ReservationRecord = {
        ...request,
        id: randomUUID(),
        expiresAt:
          (this.options.now ?? Date.now)() +
          (this.options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS),
        physicalBytes
      }
      this.reservations.set(record.id, record)
      return this.publicReservation(record)
    })
  }

  assertReserved(request: {
    reservationId: string
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
    writeOperationId: string
    filename: string
    actualBytes: number
  }): Promise<void> {
    return this.serialized(async () => {
      this.pruneExpired()
      const reservation = this.reservations.get(request.reservationId)
      if (!reservation) throw new Error('Artifact write reservation is missing or expired.')
      for (const field of [
        'projectId',
        'appSessionId',
        'artifactStorageSessionId',
        'artifactRunId',
        'writeOperationId',
        'filename'
      ] as const) {
        if (reservation[field] !== request[field]) {
          throw new Error(`Artifact write reservation does not match ${field}.`)
        }
      }
      if (reservation.fileBytes !== request.actualBytes) {
        throw new Error('Artifact write reservation does not match the streamed byte count.')
      }
    })
  }

  release(request: ReleaseArtifactWriteReservationRequest): Promise<void> {
    return this.serialized(async () => {
      const reservation = this.reservations.get(request.reservationId)
      if (!reservation) return
      if (
        reservation.projectId !== request.projectId ||
        reservation.appSessionId !== request.appSessionId ||
        reservation.artifactStorageSessionId !== request.artifactStorageSessionId ||
        reservation.artifactRunId !== request.artifactRunId
      ) {
        throw new Error('Artifact write reservation release scope does not match.')
      }
      this.reservations.delete(request.reservationId)
    })
  }

  releaseRun(request: {
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
  }): Promise<void> {
    return this.serialized(async () => {
      for (const [id, reservation] of this.reservations) {
        if (
          reservation.projectId === request.projectId &&
          reservation.appSessionId === request.appSessionId &&
          reservation.artifactStorageSessionId === request.artifactStorageSessionId &&
          reservation.artifactRunId === request.artifactRunId
        ) {
          this.reservations.delete(id)
        }
      }
    })
  }

  releaseAll(): Promise<void> {
    return this.serialized(async () => {
      this.reservations.clear()
    })
  }

  private async compatibilityUsage(
    request: ReserveArtifactWriteRequest
  ): Promise<{ turnBytes: number; sessionBytes: number }> {
    let turnBytes = 0
    let sessionBytes = 0
    const outstandingKeys = new Set(
      [...this.reservations.values()].map(
        (reservation) =>
          `${reservation.artifactStorageSessionId}\0${reservation.artifactRunId}\0${reservation.filename}`
      )
    )
    const publications = await this.options.compatibilityRepository.listPendingRunPublications(
      request.projectId
    )
    for (const publication of publications) {
      // Marked handoffs carry their logical app Session and may live under a delegated storage
      // Session. Markerless legacy layouts have no stronger ownership signal, so preserve their
      // historical current-storage fallback instead of charging an unrelated Session.
      const belongsToSession = publication.marker
        ? publication.marker.sessionId === request.appSessionId
        : publication.sourceSessionId === request.artifactStorageSessionId
      if (!belongsToSession) continue
      const files = await this.options.compatibilityRepository.listPendingRunFiles({
        projectId: request.projectId,
        sessionId: publication.sourceSessionId,
        runId: publication.runId
      })
      for (const file of files) {
        if (file.versionId) continue
        const key = `${publication.sourceSessionId}\0${publication.runId}\0${file.name}`
        if (outstandingKeys.has(key)) continue
        sessionBytes += file.size
        if (publication.runId === request.artifactRunId) turnBytes += file.size
      }
    }
    return { turnBytes, sessionBytes }
  }

  private pruneExpired(): void {
    const now = (this.options.now ?? Date.now)()
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) this.reservations.delete(id)
    }
  }

  private publicReservation(record: ReservationRecord): ArtifactWriteReservation {
    return { id: record.id, fileBytes: record.fileBytes, expiresAt: record.expiresAt }
  }

  private async serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tail
    let release = (): void => undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export { ArtifactWriteBudgetOwner }
export type { ArtifactWriteBudgetOwnerOptions }
