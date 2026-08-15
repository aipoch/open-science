import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ReserveArtifactWriteRequest } from '../../shared/artifact-provenance'
import { ArtifactWriteBudgetOwner } from './write-budget-owner'

const request = (
  overrides: Partial<ReserveArtifactWriteRequest> = {}
): ReserveArtifactWriteRequest => ({
  projectId: 'project-1',
  appSessionId: 'app-session-1',
  artifactStorageSessionId: 'storage-session-1',
  artifactRunId: 'run-1',
  writeOperationId: 'operation-1',
  filename: 'report.txt',
  fileBytes: 6,
  ...overrides
})

const artifactFile = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'legacy-file-1',
  projectId: 'project-1',
  sessionId: 'storage-session-1',
  runId: 'run-1',
  name: 'legacy.txt',
  path: '/managed/legacy.txt',
  fileUrl: 'file:///managed/legacy.txt',
  size: 3,
  mtimeMs: 1,
  ...overrides
})

const createOwner = (
  options: {
    findUnique?: (args: unknown) => Promise<{ sizeBytes: bigint } | null>
    findMany?: (args: unknown) => Promise<Array<{ writeOperationId: string }>>
    aggregate?: (args: { where: Record<string, unknown> }) => Promise<{
      _sum: { sizeBytes: bigint | null }
    }>
    publications?: Array<{
      sourceSessionId: string
      runId: string
      marker?: { sessionId: string }
    }>
    files?: ArtifactFile[]
    availableBytes?: number
    now?: () => number
    reservationTtlMs?: number
    budgets?: {
      artifactFileBytes: number
      artifactTurnBytes: number
      artifactSessionBytes: number
      diskReserveBytes: number
    }
  } = {}
): ArtifactWriteBudgetOwner => {
  const client = {
    artifactVersion: {
      findUnique: options.findUnique ?? vi.fn(async () => null),
      findMany: options.findMany ?? vi.fn(async () => []),
      aggregate: options.aggregate ?? vi.fn(async () => ({ _sum: { sizeBytes: 0n } }))
    }
  } as unknown as PrismaClient
  const compatibilityRepository = {
    listPendingRunPublications: vi.fn(async () => options.publications ?? []),
    listPendingRunFiles: vi.fn(async () => options.files ?? [])
  }

  return new ArtifactWriteBudgetOwner({
    storageRoot: '/managed',
    getClient: async () => client,
    compatibilityRepository: compatibilityRepository as never,
    getAvailableBytes: async () => options.availableBytes ?? 1_000_000,
    now: options.now,
    reservationTtlMs: options.reservationTtlMs,
    resourceBudgets: options.budgets ?? {
      artifactFileBytes: 100,
      artifactTurnBytes: 10,
      artifactSessionBytes: 20,
      diskReserveBytes: 1_000
    }
  })
}

describe('ArtifactWriteBudgetOwner', () => {
  it('serializes concurrent reservations and includes outstanding bytes in the turn budget', async () => {
    const owner = createOwner()
    const first = await owner.reserve(request())

    await expect(
      owner.reserve(
        request({ writeOperationId: 'operation-2', filename: 'second.txt', fileBytes: 5 })
      )
    ).rejects.toMatchObject({ dimension: 'turn' })

    await owner.release({
      projectId: 'project-1',
      appSessionId: 'app-session-1',
      artifactStorageSessionId: 'storage-session-1',
      artifactRunId: 'run-1',
      reservationId: first.id
    })
    await expect(
      owner.reserve(
        request({ writeOperationId: 'operation-2', filename: 'second.txt', fileBytes: 5 })
      )
    ).resolves.toMatchObject({ fileBytes: 5 })
  })

  it('does not count a persisted Version and its outstanding reservation twice', async () => {
    let persisted = false
    const owner = createOwner({
      aggregate: vi.fn(async () => ({
        _sum: { sizeBytes: persisted ? 6n : 0n }
      })),
      findMany: vi.fn(async () => (persisted ? [{ writeOperationId: 'operation-1' }] : [])),
      budgets: {
        artifactFileBytes: 100,
        artifactTurnBytes: 11,
        artifactSessionBytes: 11,
        diskReserveBytes: 1_000
      }
    })
    await owner.reserve(request())
    persisted = true

    await expect(
      owner.reserve(
        request({ writeOperationId: 'operation-2', filename: 'second.txt', fileBytes: 5 })
      )
    ).resolves.toMatchObject({ fileBytes: 5 })
  })

  it('counts native rows and unversioned compatibility files against the Session budget', async () => {
    const owner = createOwner({
      aggregate: vi.fn(async ({ where }) => ({
        _sum: { sizeBytes: 'artifactRunId' in where ? 1n : 4n }
      })),
      publications: [
        { sourceSessionId: 'storage-session-1', runId: 'run-1' },
        { sourceSessionId: 'other-storage-session', runId: 'run-1' }
      ],
      files: [artifactFile(), artifactFile({ id: 'native', name: 'native.txt', versionId: 'v1' })],
      budgets: {
        artifactFileBytes: 100,
        artifactTurnBytes: 100,
        artifactSessionBytes: 10,
        diskReserveBytes: 1_000
      }
    })

    await expect(
      owner.reserve(request({ artifactRunId: 'run-2', fileBytes: 5 }))
    ).rejects.toMatchObject({ dimension: 'session', observedBytes: 12, limitBytes: 10 })
  })

  it('counts marked compatibility files from another storage handoff in the logical Session', async () => {
    const owner = createOwner({
      aggregate: vi.fn(async ({ where }) => ({
        _sum: { sizeBytes: 'artifactRunId' in where ? 0n : 4n }
      })),
      publications: [
        {
          sourceSessionId: 'delegated-storage-session',
          runId: 'legacy-run',
          marker: { sessionId: 'app-session-1' }
        }
      ],
      files: [artifactFile({ sessionId: 'delegated-storage-session', runId: 'legacy-run' })],
      budgets: {
        artifactFileBytes: 100,
        artifactTurnBytes: 100,
        artifactSessionBytes: 10,
        diskReserveBytes: 1_000
      }
    })

    await expect(
      owner.reserve(request({ artifactRunId: 'run-2', fileBytes: 5 }))
    ).rejects.toMatchObject({ dimension: 'session', observedBytes: 12, limitBytes: 10 })
  })

  it('reserves physical amplification and disk headroom across concurrent writes', async () => {
    const owner = createOwner({
      availableBytes: 200_000,
      budgets: {
        artifactFileBytes: 100_000,
        artifactTurnBytes: 1_000_000,
        artifactSessionBytes: 1_000_000,
        diskReserveBytes: 1_000
      }
    })
    await owner.reserve(request({ fileBytes: 50_000 }))

    await expect(
      owner.reserve(
        request({ writeOperationId: 'operation-2', filename: 'second.bin', fileBytes: 50_000 })
      )
    ).rejects.toMatchObject({ dimension: 'disk-reserve' })
  })

  it('replays one operation reservation, rejects identity drift, and prunes expired ownership', async () => {
    let now = 100
    const owner = createOwner({ now: () => now, reservationTtlMs: 10 })
    const first = await owner.reserve(request())
    await expect(owner.reserve(request())).resolves.toEqual(first)
    await expect(owner.reserve(request({ filename: 'different.txt' }))).rejects.toThrow(
      /reused for a different reservation/u
    )

    now = 111
    await expect(
      owner.assertReserved({
        reservationId: first.id,
        projectId: 'project-1',
        appSessionId: 'app-session-1',
        artifactStorageSessionId: 'storage-session-1',
        artifactRunId: 'run-1',
        writeOperationId: 'operation-1',
        filename: 'report.txt',
        actualBytes: 6
      })
    ).rejects.toThrow(/missing or expired/u)
    await expect(owner.reserve(request())).resolves.not.toEqual(first)
  })
})
