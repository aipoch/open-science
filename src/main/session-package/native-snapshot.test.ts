import { PrismaClient } from '@prisma/client'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { captureNativeRecords } from './native-snapshot'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
let measuredClient: PrismaClient | undefined
let fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await measuredClient?.$disconnect()
  measuredClient = undefined
  await fixture?.dispose()
  fixture = undefined
})

const createChain = async (
  depth: number
): Promise<{ client: PrismaClient; storageRoot: string; evidenceJson: string }> => {
  fixture = await createProvenanceTestFixture()
  const { client } = fixture
  await client.fileOriginSession.create({
    data: { projectId: 'project', sessionId: 'upstream', titleSnapshot: 'Upstream history' }
  })
  await client.artifactLineage.create({
    data: {
      id: 'lineage',
      projectId: 'project',
      sessionId: 'upstream',
      normalizedFilename: 'result.csv',
      filename: 'result.csv'
    }
  })
  const evidenceJson = JSON.stringify({ evidence: 'x'.repeat(8192) })
  // One extra head is unrelated to the pinned historical version and must remain outside export.
  for (let index = 0; index <= depth; index++) {
    await client.artifactVersion.create({
      data: {
        id: `version-${index}`,
        artifactId: 'lineage',
        versionNumber: index + 1,
        basedOnVersionId: index > 0 ? `version-${index - 1}` : undefined,
        filename: 'result.csv',
        state: 'finalized',
        contentStorageKey: `artifacts/project/upstream/${index}`,
        sizeBytes: 1n,
        checksum: 'a'.repeat(64),
        evidenceJson,
        artifactRunId: 'run',
        rootFrameId: 'frame',
        agentFrameId: 'frame',
        messageBranchId: 'branch',
        runtimeSegmentId: 'runtime',
        promptMessageId: 'prompt',
        evidenceStorageKey: `artifacts/project/upstream/${index}.json`,
        evidenceChecksum: 'b'.repeat(64),
        evidenceSchemaVersion: 1
      }
    })
  }
  return { client, storageRoot: fixture.storageRoot, evidenceJson }
}

it.each([16, 64])(
  'reads each dependency once while collecting a %i-version upstream chain',
  async (depth) => {
    const { storageRoot, evidenceJson } = await createChain(depth)
    const database = new PrismaClient({
      datasources: {
        db: {
          url: `file:${join(storageRoot, 'open-science.db').replace(/\\/g, '/')}?connection_limit=1`
        }
      },
      log: [{ level: 'query', emit: 'event' }]
    })
    measuredClient = database
    let queryCount = 0
    database.$on('query', () => {
      queryCount++
    })
    let returnedVersions = 0
    let returnedEvidenceBytes = 0
    const reads = vi.spyOn(database.artifactVersion, 'findMany')
    const started = performance.now()
    const captured = await captureNativeRecords(
      database,
      { projectId: 'project', sessionId: 'current' },
      [`version-${depth - 1}`]
    )
    const elapsedMs = performance.now() - started
    for (const result of reads.mock.results) {
      if (result.type !== 'return') continue
      const rows = await result.value
      returnedVersions += rows.length
      returnedEvidenceBytes += rows.reduce(
        (sum, row) => sum + (row.evidenceJson ? Buffer.byteLength(row.evidenceJson) : 0),
        0
      )
    }
    expect(captured.tables.ArtifactVersion.map((row) => row.id)).toEqual(
      Array.from({ length: depth }, (_, index) => `version-${index}`).sort()
    )
    expect(captured.tables.ArtifactVersion.every((row) => row.evidenceJson === evidenceJson)).toBe(
      true
    )
    expect(captured.tables.ArtifactLineage).toHaveLength(1)
    expect(captured.tables.FileOriginSession).toHaveLength(1)
    console.info({ depth, queryCount, returnedVersions, returnedEvidenceBytes, elapsedMs })
    // Discovery reads narrow dependency edges once; complete payloads are fetched once at publication.
    expect(queryCount).toBeLessThanOrEqual(depth * 3 + 20)
    expect(returnedVersions).toBeLessThanOrEqual(depth * 2 + 1)
    expect(returnedEvidenceBytes).toBe(Buffer.byteLength(evidenceJson) * depth)
  }
)

it('collects mixed Review and input dependencies through a cycle without unrelated heads', async () => {
  const { client } = await createChain(5)
  await client.uploadFile.create({
    data: {
      id: 'upload',
      projectId: 'project',
      sessionId: 'upstream',
      filename: 'input.csv',
      originalFilename: 'input.csv'
    }
  })
  for (let index = 0; index < 3; index++)
    await client.uploadVersion.create({
      data: {
        id: `upload-${index}`,
        uploadFileId: 'upload',
        versionNumber: index + 1,
        basedOnVersionId: index ? `upload-${index - 1}` : undefined,
        state: 'ready',
        contentStorageKey: `uploads/project/upstream/${index}`,
        filename: 'input.csv',
        originalFilename: 'input.csv',
        sizeBytes: 1n,
        checksum: 'c'.repeat(64)
      }
    })
  for (const id of ['review-a', 'review-b'])
    await client.review.create({
      data: {
        id,
        projectId: 'project',
        sessionId: 'upstream',
        turnMessageId: 'prompt',
        lifecycle: 'complete',
        outcome: 'flagged',
        scope: JSON.stringify({
          artifactVersionIds: id === 'review-b' ? ['version-3'] : ['version-0'],
          sourceDocumentVersionIds: ['upload-1']
        })
      }
    })
  await client.finding.create({
    data: { id: 'finding', reviewId: 'review-a', artifactVersionId: 'version-0', status: 'warn' }
  })
  await client.reviewFindingDisposition.create({
    data: {
      id: 'disposition',
      sourceFindingId: 'finding',
      causeReviewId: 'review-b',
      assessedArtifactVersionId: 'version-2',
      sequence: 1,
      trigger: 'review_submission',
      outcome: 'still_open'
    }
  })
  // Review B reaches v3; its input reaches v4, whose derivation points back to v3.
  await client.artifactVersionInput.create({
    data: {
      id: 'input',
      artifactVersionId: 'version-3',
      ordinal: 0,
      inputFileVersionId: 'version-4',
      sourceKind: 'artifact-version',
      sourceFileId: 'lineage',
      sourceArtifactVersionId: 'version-4',
      sourceProjectId: 'project',
      sourceSessionId: 'upstream',
      filename: 'result.csv',
      sizeBytes: 1n,
      checksum: 'a'.repeat(64),
      storageKey: 'artifacts/project/upstream/4',
      strongestAssociation: 'captured-version'
    }
  })
  const request = { projectId: 'project', sessionId: 'current' }
  const records = await captureNativeRecords(client, request, ['version-1'])
  expect(records.tables.ArtifactVersion.map((row) => row.id)).toEqual([
    'version-0',
    'version-1',
    'version-2',
    'version-3',
    'version-4'
  ])
  expect(records.tables.UploadVersion.map((row) => row.id)).toEqual(['upload-0', 'upload-1'])
  expect(records.tables.Review.map((row) => row.id)).toEqual(['review-a', 'review-b'])
  expect(records.tables.Finding.map((row) => row.id)).toEqual(['finding'])
  expect(records.tables.ReviewFindingDisposition.map((row) => row.id)).toEqual(['disposition'])
  expect(records.tables.ArtifactVersionInput.map((row) => row.id)).toEqual(['input'])
  // A new capture must see changed source authority instead of retaining the previous visited set.
  await client.review.update({
    where: { id: 'review-b' },
    data: {
      scope: JSON.stringify({
        artifactVersionIds: ['version-5'],
        sourceDocumentVersionIds: ['upload-2']
      })
    }
  })
  const refreshed = await captureNativeRecords(client, request, ['version-1'])
  expect(refreshed.tables.ArtifactVersion).toHaveLength(6)
  expect(refreshed.tables.UploadVersion).toHaveLength(3)
  await client.review.update({
    where: { id: 'review-b' },
    data: { scope: JSON.stringify({ sourceDocumentVersionIds: ['missing-source'] }) }
  })
  await expect(captureNativeRecords(client, request, ['version-1'])).rejects.toThrow(
    'missing source evidence'
  )
})

it('still rejects missing and staging versions after dependency discovery', async () => {
  const { client } = await createChain(1)
  const request = { projectId: 'project', sessionId: 'current' }
  await expect(captureNativeRecords(client, request, ['missing'])).rejects.toThrow(
    'missing file evidence'
  )
  await client.artifactVersion.update({ where: { id: 'version-0' }, data: { state: 'staging' } })
  await expect(captureNativeRecords(client, request, ['version-0'])).rejects.toThrow(
    'file writes to finish'
  )
})
