import { createHash } from 'node:crypto'
import { dirname, join, posix } from 'node:path'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { createPngBytes } from './artifact-test-fixtures'
import * as provenanceModule from './provenance-repository'
import { ArtifactProvenanceRepository } from './provenance-repository'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture,
  provenanceGraph
} from './provenance-test-fixtures'

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>

const fixtures: Fixture[] = []
const fixture = async (): Promise<Fixture> => {
  const value = await createProvenanceTestFixture()
  fixtures.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()))
})

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

const PUBLIC_METHODS = [
  'writeAppGeneratedVersion',
  'createVersion',
  'replayVersion',
  'validateFinalizationOwnership',
  'finalizeRun',
  'listRunVersions',
  'prepareProjectReconciliation',
  'reconcileSession',
  'getLineage',
  'getVersionProvenance',
  'resolveVersionDescriptors',
  'getVersionCore',
  'getVersionExecution',
  'getVersionMessages',
  'getVersionReview',
  'readCodeReconstructionCache',
  'writeCodeReconstructionCache',
  'resolveVersionContent',
  'deleteProjectProvenance'
] as const satisfies readonly (keyof ArtifactProvenanceRepository)[]

type PublicMethod = keyof ArtifactProvenanceRepository
type ListedMethod = (typeof PUBLIC_METHODS)[number]
type ExactMethodInventory = [PublicMethod] extends [ListedMethod]
  ? [ListedMethod] extends [PublicMethod]
    ? true
    : false
  : false
const exactMethodInventory: ExactMethodInventory = true

describe('artifact provenance public write contract', () => {
  it('captures constructor, method, and runtime value exports without private placement', async () => {
    const { repository } = await fixture()

    expect(exactMethodInventory).toBe(true)
    expect(PUBLIC_METHODS.every((name) => typeof repository[name] === 'function')).toBe(true)
    expect(Object.keys(provenanceModule).sort()).toEqual([
      'ArtifactFinalizationProofError',
      'ArtifactOwnershipPersistenceRaceError',
      'ArtifactProvenanceRepository'
    ])
    expect(repository).toBeInstanceOf(ArtifactProvenanceRepository)
  })
})

describe('artifact provenance allocation and write identity', () => {
  it('advances one case-folded lineage while preserving immutable bytes and canonical evidence', async () => {
    const { client, repository, stagePng, storageRoot } = await fixture()
    await stagePng('version one', 'Plot.PNG')
    const first = await repository.createVersion(
      createArtifactVersionRequest({
        filename: 'Plot.PNG',
        writeOperationId: 'write-1',
        writeRequestChecksum: '1'.repeat(64)
      })
    )
    await stagePng('version two', 'plot.png')
    const second = await repository.createVersion(
      createArtifactVersionRequest({
        filename: 'plot.png',
        writeOperationId: 'write-2',
        writeRequestChecksum: '2'.repeat(64)
      })
    )

    expect(second).toMatchObject({ artifactId: first.artifactId, versionNumber: 2 })
    expect(first.versionId).not.toBe(second.versionId)
    await expect(readFile(first.path)).resolves.toEqual(createPngBytes('version one'))
    await expect(readFile(second.path)).resolves.toEqual(createPngBytes('version two'))

    const rows = await client.artifactVersion.findMany({
      where: { artifactId: first.artifactId },
      orderBy: { versionNumber: 'asc' }
    })
    expect(rows.map(({ versionNumber }) => versionNumber)).toEqual([1, 2])
    for (const [index, row] of rows.entries()) {
      const expectedBytes = createPngBytes(index === 0 ? 'version one' : 'version two')
      expect(row.checksum).toBe(sha256(expectedBytes))
      expect(row.evidenceChecksum).toBe(sha256(row.evidenceJson))
      expect(row.evidenceJson).toBe(JSON.stringify(canonicalize(JSON.parse(row.evidenceJson))))
      expect(JSON.parse(row.evidenceJson)).toMatchObject({
        artifact_id: first.artifactId,
        version_id: row.id,
        version_number: index + 1,
        checksum: row.checksum
      })
      await expect(
        readFile(join(storageRoot, ...row.contentStorageKey.split('/')))
      ).resolves.toEqual(expectedBytes)
      await expect(
        readFile(join(storageRoot, ...row.evidenceStorageKey.split('/')), 'utf8')
      ).resolves.toBe(row.evidenceJson)
    }
  })

  it('returns the original immutable Version for an exact operation retry and rejects reuse', async () => {
    const { client, repository, stagePng } = await fixture()
    const request = createArtifactVersionRequest({
      writeOperationId: 'stable-operation',
      writeRequestChecksum: '3'.repeat(64)
    })
    await stagePng('original bytes')
    const first = await repository.createVersion(request)
    await stagePng('changed pending bytes')

    const retried = await repository.createVersion(request)

    expect(retried).toMatchObject({ versionId: first.versionId, versionNumber: 1 })
    await expect(readFile(retried.path)).resolves.toEqual(createPngBytes('original bytes'))
    await expect(client.artifactVersion.count()).resolves.toBe(1)
    await expect(
      repository.createVersion({ ...request, writeRequestChecksum: '4'.repeat(64) })
    ).rejects.toThrow(/write operation.*different request/i)
    await expect(client.artifactVersion.count()).resolves.toBe(1)
  })

  it('keeps the SQLite lifecycle in staging when an immutable evidence barrier fails', async () => {
    const value = await fixture()
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      durability: {
        syncFile: async (path) => {
          if (path.endsWith('evidence.json')) throw new Error('evidence barrier failed')
        },
        syncDirectory: async () => undefined
      }
    })
    const request = createArtifactVersionRequest({ writeOperationId: 'barrier-operation' })
    await value.stagePng('barrier bytes')

    await expect(repository.createVersion(request)).rejects.toThrow('evidence barrier failed')
    await expect(
      value.client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'staging' })
  })
})

const appendNotebookRun = async (
  value: Fixture,
  input: { runId: string; filename: string; payload: string; ownsSource: boolean }
): Promise<{ path: string; sizeBytes: number; mtimeMs: number }> => {
  const document = await value.notebookRepository.loadOrCreate({
    projectName: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: join(value.storageRoot, 'workspace')
  })
  const sourcePath = join(document.notebookSessionRoot, 'data', input.filename)
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, createPngBytes(input.payload))
  const sourceStat = await stat(sourcePath)
  await value.notebookRepository.appendRun({
    projectName: 'project-1',
    sessionId: 'session-1',
    run: {
      runId: input.runId,
      cellId: `cell-${input.runId}`,
      source: 'agent',
      kernelKind: 'python',
      status: 'completed',
      startedAt: sourceStat.mtimeMs - 100,
      endedAt: sourceStat.mtimeMs + 100,
      script: `save_plot(${JSON.stringify(input.filename)})`,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      inputFiles: [],
      workingFiles: input.ownsSource
        ? [
            {
              path: sourcePath,
              relativePath: posix.join('data', input.filename),
              kind: 'other',
              size: sourceStat.size,
              mtimeMs: sourceStat.mtimeMs,
              createdByRunId: input.runId
            }
          ]
        : [],
      ...provenanceGraph
    }
  })
  return {
    path: await realpath(sourcePath),
    sizeBytes: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs
  }
}

describe('artifact provenance producer and source validation', () => {
  it('binds a declared producer only to the exact observed source owner and retries identically', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'producer-run',
      filename: 'plot.png',
      payload: 'producer bytes',
      ownsSource: true
    })
    await appendNotebookRun(value, {
      runId: 'unrelated-run',
      filename: 'unrelated.png',
      payload: 'unrelated bytes',
      ownsSource: false
    })
    await value.stagePng('producer bytes')
    const request = createArtifactVersionRequest({
      writeOperationId: 'producer-operation',
      notebookSessionId: 'session-1',
      producerRunId: 'producer-run',
      sourceKind: 'localPath',
      sourceFileObservation: observation
    })

    const version = await value.repository.createVersion(request)
    const row = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    expect(row).toMatchObject({ producerRunId: 'producer-run', producerRunIndex: 0 })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: {
        state: 'available',
        producer_run_id: 'producer-run',
        association_method: 'agent-declared-and-session-validated'
      },
      execution_status: { state: 'available' }
    })
    await expect(value.repository.createVersion(request)).resolves.toMatchObject({
      versionId: version.versionId,
      versionNumber: 1
    })

    await expect(
      value.repository.createVersion({
        ...request,
        writeOperationId: 'wrong-owner-operation',
        writeRequestChecksum: '5'.repeat(64),
        producerRunId: 'unrelated-run'
      })
    ).rejects.toThrow(/producer.*source.*another Notebook run/i)
    await expect(value.client.artifactVersion.count()).resolves.toBe(1)

    await expect(
      value.repository.createVersion({
        ...request,
        writeOperationId: 'wrong-scope-operation',
        writeRequestChecksum: '7'.repeat(64),
        runtimeSegmentId: 'other-runtime-segment'
      })
    ).rejects.toThrow(/producer run does not belong.*runtimeSegmentId/i)
    await expect(value.client.artifactVersion.count()).resolves.toBe(1)
  })

  it('rejects a missing declared run but never infers a producer from mtime alone', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'mtime-only-run',
      filename: 'plot.png',
      payload: 'mtime bytes',
      ownsSource: false
    })
    await value.stagePng('mtime bytes')
    const base = createArtifactVersionRequest({
      notebookSessionId: 'session-1',
      sourceKind: 'localPath',
      sourceFileObservation: observation
    })

    await expect(
      value.repository.createVersion({
        ...base,
        writeOperationId: 'missing-producer-operation',
        producerRunId: 'missing-run'
      })
    ).rejects.toThrow('Notebook producer run not found: missing-run')

    const version = await value.repository.createVersion({
      ...base,
      writeOperationId: 'mtime-operation',
      writeRequestChecksum: '6'.repeat(64)
    })
    const row = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    expect(row).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-source-unverifiable' },
      execution_status: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })
  })

  it('fails closed to unavailable evidence when the source observation is corrupt', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'observed-run',
      filename: 'plot.png',
      payload: 'observed bytes',
      ownsSource: true
    })
    await value.stagePng('observed bytes')

    const version = await value.repository.createVersion(
      createArtifactVersionRequest({
        writeOperationId: 'corrupt-observation-operation',
        notebookSessionId: 'session-1',
        producerRunId: 'observed-run',
        sourceKind: 'localPath',
        sourceFileObservation: { ...observation, sizeBytes: observation.sizeBytes + 1 }
      })
    )
    const row = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    expect(row).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })
  })
})
