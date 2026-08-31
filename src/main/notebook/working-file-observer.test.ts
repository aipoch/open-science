import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  completeWorkingFileEvidence,
  deleteWorkingFileEvidenceProject,
  reconcileWorkingFileEvidence,
  runEvidenceWorker,
  startWorkingFileObservation,
  toPortableNotebookRelativePath,
  type WorkingFileObservationResult
} from './working-file-observer'

const execFile = promisify(execFileCallback)

const watcherUnavailable = (): never => {
  throw Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' })
}

let storageRoot: string | undefined

const createRoots = async (): Promise<{ sessionRoot: string; dataRoot: string }> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'os-working-file-evidence-'))
  const sessionRoot = join(storageRoot, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  await mkdir(dataRoot, { recursive: true })
  return { sessionRoot, dataRoot }
}

const createWorkerBlobPool = async (): Promise<{
  blobRoot: string
  expectedBlobRootIdentity: { dev: number; ino: number }
  blobStorageKeyPrefix: string
  maxEvidenceBytes: number
}> => {
  const blobRoot = join(storageRoot as string, 'file-evidence-blobs')
  await mkdir(blobRoot, { recursive: true })
  const metadata = await stat(blobRoot)
  return {
    blobRoot,
    expectedBlobRootIdentity: { dev: metadata.dev, ino: metadata.ino },
    blobStorageKeyPrefix: 'file-evidence-blobs',
    maxEvidenceBytes: 64 * 1024
  }
}

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('working-file evidence', () => {
  it('normalizes persisted paths across operating systems', () => {
    expect(
      toPortableNotebookRelativePath(
        win32.relative('C:\\session', 'C:\\session\\data\\plot.png'),
        win32.sep
      )
    ).toBe('data/plot.png')
    expect(toPortableNotebookRelativePath('data/literal\\name.png')).toBe('data/literal\\name.png')
  })

  it('freezes a created generation and persists checksummed partial evidence', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-created' },
      { watchDirectory: watcherUnavailable, createId: () => 'generation-1', now: () => 1_000 }
    )
    const output = join(dataRoot, 'result.csv')
    const content = 'x,y\n1,2\n'
    await writeFile(output, content)

    const result = await observation.finish()
    const checksum = createHash('sha256').update(content).digest('hex')
    expect(result).toMatchObject({
      workingFiles: [
        {
          path: resolve(output),
          relativePath: 'data/result.csv',
          change: 'created',
          generationId: 'generation-1',
          checksum
        }
      ],
      fileEvidence: {
        state: 'partial',
        storageKey: 'file-evidence/run-run-created/evidence.json',
        relationCount: 1,
        generationCount: 1,
        scientificOutputCount: 1,
        scientificOutputAnalysis: 'partial',
        reasonCodes: expect.arrayContaining([
          'watcher-unavailable',
          'file-reads-not-observed',
          'external-paths-not-observed',
          'transient-files-not-captured',
          'writer-not-isolated'
        ])
      }
    })

    const evidenceText = await readFile(
      join(storageRoot as string, 'file-evidence', 'run-run-created', 'evidence.json'),
      'utf8'
    )
    expect(createHash('sha256').update(evidenceText).digest('hex')).toBe(
      result.fileEvidence.checksum
    )
    const evidence = JSON.parse(evidenceText) as {
      relations: Array<{
        relation: string
        pathPortability: string
        authority: string
        generation: { contentStorageKey: string; capturedAt: string }
      }>
      scientificOutputs: Array<{
        storageShape: string
        formatHint: string
        classificationAuthority: string
        members: string[]
        riskCodes: string[]
      }>
    }
    expect(evidence.relations[0]).toMatchObject({
      relation: 'created',
      pathPortability: 'relative',
      authority: 'advisory',
      generation: { capturedAt: '1970-01-01T00:00:01.000Z' }
    })
    expect(evidence.scientificOutputs).toMatchObject([
      {
        storageShape: 'single-file',
        formatHint: 'text-data',
        classificationAuthority: 'path-heuristic',
        members: ['data/result.csv'],
        riskCodes: ['format-validity-not-verified']
      }
    ])
    expect(
      await readFile(
        join(
          storageRoot as string,
          ...evidence.relations[0].generation.contentStorageKey.split('/')
        ),
        'utf8'
      )
    ).toBe(content)
  })

  it('publishes distinct immutable generations that reuse an equal content blob', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-equal-generations' },
      { watchDirectory: watcherUnavailable }
    )
    await Promise.all([
      writeFile(join(dataRoot, 'first.csv'), 'same bytes'),
      writeFile(join(dataRoot, 'second.csv'), 'same bytes')
    ])

    const result = await observation.finish()
    const evidence = JSON.parse(
      await readFile(
        join(storageRoot as string, ...result.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as {
      relations: Array<{
        generation: { generationId: string; checksum: string; contentStorageKey: string }
      }>
    }
    const generations = evidence.relations.map((relation) => relation.generation)

    expect(result.fileEvidence).toMatchObject({ generationCount: 2 })
    expect(new Set(generations.map((generation) => generation.generationId))).toHaveLength(2)
    expect(new Set(generations.map((generation) => generation.checksum))).toHaveLength(1)
    expect(new Set(generations.map((generation) => generation.contentStorageKey))).toHaveLength(1)
    await expect(readdir(join(storageRoot as string, 'file-evidence-blobs'))).resolves.toHaveLength(
      1
    )
    await expect(
      Promise.all(
        generations.map((generation) =>
          readFile(join(storageRoot as string, ...generation.contentStorageKey.split('/')), 'utf8')
        )
      )
    ).resolves.toEqual(['same bytes', 'same bytes'])
  })

  it('reuses an unchanged baseline blob across runs without reusing generation identity', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const input = join(dataRoot, 'input.csv')
    const content = 'stable baseline'
    await writeFile(input, content)
    const generationIds = ['generation-run-1', 'generation-run-2']

    const run = async (runId: string): Promise<WorkingFileObservationResult> => {
      const observation = await startWorkingFileObservation(
        { dataRoot, notebookSessionRoot: sessionRoot, runId },
        {
          watchDirectory: watcherUnavailable,
          createId: () => generationIds.shift()!,
          maxEvidenceBytes: Buffer.byteLength(content)
        }
      )
      return observation.finish()
    }
    const first = await run('baseline-1')
    const second = await run('baseline-2')
    const generation = async (
      result: typeof first
    ): Promise<{ generationId: string; contentStorageKey: string }> => {
      const sidecar = JSON.parse(
        await readFile(
          join(storageRoot as string, ...result.fileEvidence.storageKey!.split('/')),
          'utf8'
        )
      ) as {
        relations: Array<{ generation: { generationId: string; contentStorageKey: string } }>
      }
      return sidecar.relations[0].generation
    }

    const firstGeneration = await generation(first)
    const secondGeneration = await generation(second)
    expect(firstGeneration.generationId).not.toBe(secondGeneration.generationId)
    expect(firstGeneration.contentStorageKey).not.toBe(secondGeneration.contentStorageKey)
    const contentName = firstGeneration.contentStorageKey.split('/').at(-1)!
    expect(secondGeneration.contentStorageKey.endsWith(`/${contentName}`)).toBe(true)
    const [firstBlob, secondBlob, pooledBlob] = await Promise.all([
      stat(join(storageRoot as string, ...firstGeneration.contentStorageKey.split('/'))),
      stat(join(storageRoot as string, ...secondGeneration.contentStorageKey.split('/'))),
      stat(join(storageRoot as string, 'file-evidence-blobs', contentName))
    ])
    if (process.platform !== 'win32') {
      expect({ dev: firstBlob.dev, ino: firstBlob.ino }).toEqual({
        dev: pooledBlob.dev,
        ino: pooledBlob.ino
      })
      expect({ dev: secondBlob.dev, ino: secondBlob.ino }).toEqual({
        dev: pooledBlob.dev,
        ino: pooledBlob.ino
      })
    }
    expect(pooledBlob.nlink).toBeGreaterThanOrEqual(3)
    await expect(readdir(join(storageRoot as string, 'file-evidence-blobs'))).resolves.toHaveLength(
      1
    )
  })

  it('fails closed instead of replacing a corrupted existing blob', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    await writeFile(join(dataRoot, 'input.csv'), 'original bytes')
    const first = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'blob-original' },
      { watchDirectory: watcherUnavailable }
    )
    const firstResult = await first.finish()
    const firstSidecar = JSON.parse(
      await readFile(
        join(storageRoot as string, ...firstResult.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as { relations: Array<{ generation: { contentStorageKey: string } }> }
    const blobPath = join(
      storageRoot as string,
      ...firstSidecar.relations[0].generation.contentStorageKey.split('/')
    )
    await writeFile(blobPath, 'corrupted byte')

    const second = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'blob-corrupt-reuse' },
      { watchDirectory: watcherUnavailable }
    )
    const secondResult = await second.finish()

    expect(secondResult.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readFile(blobPath, 'utf8')).resolves.toBe('corrupted byte')
  })

  it('reuses a blob without reserving space for another full copy', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    await writeFile(join(dataRoot, 'large.csv'), Buffer.alloc(64 * 1024, 1))
    const first = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'disk-reuse-first' },
      { watchDirectory: watcherUnavailable, diskReserveBytes: 100 }
    )
    await first.finish()

    const second = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'disk-reuse-second' },
      {
        watchDirectory: watcherUnavailable,
        diskReserveBytes: 100,
        getAvailableBytes: vi.fn().mockResolvedValue(10_000)
      }
    )
    const result = await second.finish()

    expect(result.fileEvidence).toMatchObject({ generationCount: 1 })
    await expect(readdir(join(storageRoot as string, 'file-evidence-blobs'))).resolves.toHaveLength(
      1
    )
  })

  it('stops adding unique blobs at the evidence budget without deleting older evidence', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const firstInput = join(dataRoot, 'first.csv')
    await writeFile(firstInput, '123456')
    const first = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'budget-first' },
      { watchDirectory: watcherUnavailable, maxEvidenceBytes: 10 }
    )
    const firstResult = await first.finish()

    const second = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'budget-second' },
      { watchDirectory: watcherUnavailable, maxEvidenceBytes: 10 }
    )
    await writeFile(join(dataRoot, 'second.csv'), 'abcdef')
    const secondResult = await second.finish()

    expect(firstResult.fileEvidence).toMatchObject({ generationCount: 1 })
    expect(secondResult.fileEvidence).toMatchObject({
      state: 'partial',
      generationCount: 1,
      reasonCodes: expect.arrayContaining(['generation-budget-exceeded'])
    })
    await expect(readdir(join(storageRoot as string, 'file-evidence-blobs'))).resolves.toHaveLength(
      1
    )
    await expect(
      readFile(
        join(storageRoot as string, ...firstResult.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ).resolves.toContain('first.csv')
  })

  it('serializes concurrent Project blob writes so the shared budget stays bounded', async () => {
    await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-budget')
    const requests = await Promise.all(
      ['one', 'two'].map(async (sessionId) => {
        const sessionRoot = join(storageRoot as string, `notebook-${sessionId}`)
        const dataRoot = join(sessionRoot, 'data')
        await mkdir(dataRoot, { recursive: true })
        await writeFile(join(dataRoot, `${sessionId}.csv`), sessionId.padEnd(6, sessionId))
        return startWorkingFileObservation(
          {
            dataRoot,
            notebookSessionRoot: sessionRoot,
            fileEvidenceStorageRoot: storageRoot,
            fileEvidenceRoot: join(projectRoot, sessionId),
            fileEvidenceStoragePrefix: `notebook-file-evidence/project-budget/${sessionId}`,
            runId: `budget-${sessionId}`
          },
          { watchDirectory: watcherUnavailable, maxEvidenceBytes: 10 }
        )
      })
    )
    const results = await Promise.all(requests.map((request) => request.finish()))

    expect(results.map((result) => result.fileEvidence.generationCount).sort()).toEqual([0, 1])
    expect(
      results.some((result) =>
        result.fileEvidence.reasonCodes.includes('generation-budget-exceeded')
      )
    ).toBe(true)
    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toHaveLength(1)
  })

  it('bounds queue wait so a concurrent capture cannot delay Notebook execution indefinitely', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const secondSessionRoot = join(storageRoot as string, 'notebook-second')
    const secondDataRoot = join(secondSessionRoot, 'data')
    await mkdir(secondDataRoot, { recursive: true })
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate
    })
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted
    })
    let beginCalls = 0
    const worker: typeof runEvidenceWorker = async (_evidenceRoot, request) => {
      if (request.operation === 'begin') {
        beginCalls += 1
        if (beginCalls === 1) {
          markFirstStarted()
          await firstGate
        }
        return { ok: true, capturedInitialGenerations: 0 }
      }
      throw new Error('simulated persistence failure')
    }
    const firstPromise = startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'queue-first' },
      {
        watchDirectory: watcherUnavailable,
        runEvidenceWorker: worker,
        evidenceQueueTimeoutMs: 1_000
      }
    )
    await firstStarted

    const second = await startWorkingFileObservation(
      {
        dataRoot: secondDataRoot,
        notebookSessionRoot: secondSessionRoot,
        runId: 'queue-second'
      },
      {
        watchDirectory: watcherUnavailable,
        runEvidenceWorker: worker,
        evidenceQueueTimeoutMs: 10
      }
    )
    const secondResult = await second.finish()

    expect(beginCalls).toBe(1)
    expect(secondResult.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    releaseFirst()
    const first = await firstPromise
    await first.finish()
  })

  it('serializes startup reconciliation behind an in-flight Project capture mutation', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-queue')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-queue/session-1'
    await writeFile(join(dataRoot, 'baseline.csv'), 'queued bytes')
    let releaseBegin!: () => void
    let markBeginStarted!: () => void
    const beginGate = new Promise<void>((resolveGate) => {
      releaseBegin = resolveGate
    })
    const beginStarted = new Promise<void>((resolveStarted) => {
      markBeginStarted = resolveStarted
    })
    const worker: typeof runEvidenceWorker = async (root, request, signal) => {
      const result = await runEvidenceWorker(root, request, signal)
      if (request.operation === 'begin') {
        markBeginStarted()
        await beginGate
      }
      return result
    }
    const observationPromise = startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: evidenceRoot,
        fileEvidenceStoragePrefix: storageKeyPrefix,
        runId: 'project-queue-run'
      },
      { watchDirectory: watcherUnavailable, runEvidenceWorker: worker }
    )
    await beginStarted
    let reconciled = false
    const reconciliation = reconcileWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      []
    ).then(() => {
      reconciled = true
    })
    await new Promise((resolvePending) => setTimeout(resolvePending, 20))
    expect(reconciled).toBe(false)

    releaseBegin()
    const observation = await observationPromise
    await reconciliation
    expect(reconciled).toBe(true)
    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toEqual([])
    const result = await observation.finish()
    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
  })

  it('immediately cleans an initial-capture receipt and staging directory after failure', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    await writeFile(join(dataRoot, 'baseline.csv'), 'frozen baseline')
    const worker: typeof runEvidenceWorker = async (evidenceRoot, request, signal) => {
      const result = await runEvidenceWorker(evidenceRoot, request, signal)
      if (request.operation === 'begin') throw new Error('simulated failure after capture')
      return result
    }

    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'initial-cleanup' },
      { watchDirectory: watcherUnavailable, runEvidenceWorker: worker }
    )
    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readdir(join(storageRoot as string, 'file-evidence'))).resolves.toEqual([])
    await expect(readdir(join(storageRoot as string, 'file-evidence-blobs'))).resolves.toEqual([])
  })

  it('persists Python/R multi-file scientific outputs without changing member generations', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-scientific-outputs' },
      { watchDirectory: watcherUnavailable }
    )
    await mkdir(join(dataRoot, 'partitioned', 'species=setosa'), { recursive: true })
    await mkdir(join(dataRoot, 'partitioned', 'species=virginica'), { recursive: true })
    await mkdir(join(dataRoot, 'climate.zarr', 'temperature', 'c', '0'), { recursive: true })
    await Promise.all([
      writeFile(join(dataRoot, 'partitioned', 'species=setosa', 'part-0.parquet'), 'part 0'),
      writeFile(join(dataRoot, 'partitioned', 'species=virginica', 'part-1.parquet'), 'part 1'),
      writeFile(join(dataRoot, 'climate.zarr', 'zarr.json'), '{}'),
      writeFile(join(dataRoot, 'climate.zarr', 'temperature', 'c', '0', '0'), 'chunk'),
      writeFile(join(dataRoot, 'results.sqlite'), 'database'),
      writeFile(join(dataRoot, 'results.sqlite-wal'), 'committed pages'),
      writeFile(join(dataRoot, 'model.rds'), 'serialized R object')
    ])

    const result = await observation.finish()
    expect(result.fileEvidence).toMatchObject({
      schemaVersion: 1,
      relationCount: 7,
      generationCount: 7,
      scientificOutputCount: 4,
      scientificOutputAnalysis: 'partial',
      reasonCodes: expect.arrayContaining([
        'delayed-writes-not-observed',
        'remote-outputs-not-observed'
      ])
    })
    expect(result.workingFiles).toHaveLength(7)
    expect(result.workingFiles.every((file) => file.generationId && file.checksum)).toBe(true)

    const evidence = JSON.parse(
      await readFile(
        join(storageRoot as string, ...result.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as {
      schemaVersion: number
      scientificOutputs: Array<{
        storageShape: string
        formatHint: string
        members: string[]
        riskCodes: string[]
      }>
    }
    expect(evidence.schemaVersion).toBe(1)
    expect(evidence.scientificOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'parquet-dataset',
          members: [
            'data/partitioned/species=setosa/part-0.parquet',
            'data/partitioned/species=virginica/part-1.parquet'
          ]
        }),
        expect.objectContaining({
          storageShape: 'directory-tree',
          formatHint: 'zarr',
          members: ['data/climate.zarr/temperature/c/0/0', 'data/climate.zarr/zarr.json']
        }),
        expect.objectContaining({
          storageShape: 'file-set',
          formatHint: 'sqlite',
          members: ['data/results.sqlite', 'data/results.sqlite-wal'],
          riskCodes: [
            'database-state-not-verified',
            'format-validity-not-verified',
            'multi-file-consistency-not-verified'
          ]
        }),
        expect.objectContaining({
          storageShape: 'single-file',
          formatHint: 'r-serialization',
          members: ['data/model.rds'],
          riskCodes: ['format-validity-not-verified', 'runtime-dependent-serialization']
        })
      ])
    )
  })

  it('freezes the initial versions referenced by modified and deleted relations', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const modified = join(dataRoot, 'modified.csv')
    const deleted = join(dataRoot, 'deleted.csv')
    await writeFile(modified, 'before')
    await writeFile(deleted, 'delete me')
    const generationIds = [
      'generation-deleted-before',
      'generation-modified-before',
      'generation-modified-after'
    ]
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-changes' },
      { watchDirectory: watcherUnavailable, createId: () => generationIds.shift()! }
    )

    await writeFile(modified, 'after is larger')
    await unlink(deleted)
    const result = await observation.finish()

    expect(result.workingFiles).toMatchObject([
      {
        path: resolve(modified),
        relativePath: 'data/modified.csv',
        change: 'modified'
      }
    ])
    expect(result.workingFiles[0]).toMatchObject({
      generationId: 'generation-modified-after',
      checksum: expect.any(String)
    })
    expect(result.fileEvidence).toMatchObject({
      state: 'partial',
      initialViewState: 'complete',
      relationCount: 4,
      generationCount: 3
    })
    const evidence = JSON.parse(
      await readFile(
        join(storageRoot as string, 'file-evidence', 'run-run-changes', 'evidence.json'),
        'utf8'
      )
    ) as {
      relations: Array<{
        relation: string
        relativePath: string
        previousGenerationId?: string
        generation?: { generationId: string; contentStorageKey: string }
      }>
    }
    expect(evidence.relations).toEqual([
      expect.objectContaining({
        relation: 'available-before',
        relativePath: 'data/deleted.csv',
        generation: expect.objectContaining({ generationId: 'generation-deleted-before' })
      }),
      expect.objectContaining({
        relation: 'available-before',
        relativePath: 'data/modified.csv',
        generation: expect.objectContaining({ generationId: 'generation-modified-before' })
      }),
      expect.objectContaining({
        relation: 'deleted',
        relativePath: 'data/deleted.csv',
        previousGenerationId: 'generation-deleted-before'
      }),
      expect.objectContaining({
        relation: 'modified',
        relativePath: 'data/modified.csv',
        previousGenerationId: 'generation-modified-before',
        generation: expect.objectContaining({ generationId: 'generation-modified-after' })
      })
    ])
    const priorContents = await Promise.all(
      evidence.relations
        .slice(0, 2)
        .map((relation) =>
          readFile(
            join(storageRoot as string, ...relation.generation!.contentStorageKey.split('/')),
            'utf8'
          )
        )
    )
    expect(priorContents).toEqual(['delete me', 'before'])
  })

  it('keeps earlier generations immutable when a later run rewrites the same logical path', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const output = join(dataRoot, 'result.csv')
    const first = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-first-version' },
      { watchDirectory: watcherUnavailable, createId: () => 'generation-first' }
    )
    await writeFile(output, 'first result')
    const firstResult = await first.finish()

    const second = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-second-version' },
      { watchDirectory: watcherUnavailable, createId: () => 'generation-second' }
    )
    await writeFile(output, 'second result')
    const secondResult = await second.finish()

    expect(firstResult.workingFiles[0]).toMatchObject({
      generationId: 'generation-first',
      change: 'created'
    })
    expect(secondResult.workingFiles[0]).toMatchObject({
      generationId: 'generation-second',
      change: 'modified'
    })
    expect(secondResult.workingFiles[0]?.checksum).not.toBe(firstResult.workingFiles[0]?.checksum)

    const generationContent = async (runId: string): Promise<string> => {
      const evidence = JSON.parse(
        await readFile(
          join(storageRoot as string, 'file-evidence', `run-${runId}`, 'evidence.json'),
          'utf8'
        )
      ) as { relations: Array<{ generation: { contentStorageKey: string } }> }
      return readFile(
        join(
          storageRoot as string,
          ...evidence.relations.at(-1)!.generation.contentStorageKey.split('/')
        ),
        'utf8'
      )
    }
    await expect(generationContent('run-first-version')).resolves.toBe('first result')
    await expect(generationContent('run-second-version')).resolves.toBe('second result')
  })

  it('fails closed when concurrent runs can write the same observed root', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const first = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-first' },
      { watchDirectory: watcherUnavailable }
    )
    const second = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-second' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'ambiguous.csv'), 'ambiguous writer')

    const [firstResult, secondResult] = await Promise.all([first.finish(), second.finish()])
    for (const result of [firstResult, secondResult]) {
      expect(result.workingFiles).toEqual([])
      expect(result.fileEvidence).toMatchObject({
        state: 'unavailable',
        relationCount: 0,
        generationCount: 0,
        reasonCodes: expect.arrayContaining(['observer-conflict'])
      })
    }
  })

  it('refuses to freeze a generation when doing so would consume the disk reserve', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const getAvailableBytes = vi.fn().mockResolvedValue(100_000)
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-disk-reserve' },
      {
        watchDirectory: watcherUnavailable,
        getAvailableBytes,
        diskReserveBytes: 8
      }
    )
    await writeFile(join(dataRoot, 'result.csv'), Buffer.alloc(1024 * 1024, 1))

    const result = await observation.finish()

    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.fileEvidence).toMatchObject({
      state: 'partial',
      generationCount: 0,
      reasonCodes: expect.arrayContaining(['generation-budget-exceeded'])
    })
  })

  it('removes run-owned generations when the evidence sidecar cannot be published', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-persist-failure' },
      {
        watchDirectory: watcherUnavailable,
        runEvidenceWorker: async () => {
          throw new Error('simulated sidecar failure')
        }
      }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'unpublished')

    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    expect(result.workingFiles[0]).toMatchObject({
      relativePath: 'data/result.csv',
      change: 'created'
    })
    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.workingFiles[0]).not.toHaveProperty('checksum')
    await expect(
      readFile(
        join(storageRoot as string, 'file-evidence', 'run-run-persist-failure', 'evidence.json')
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(storageRoot as string, 'file-evidence'))).resolves.toEqual([])
  })

  it('preserves existing evidence when a reused run ID collides during publication', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const existingRunRoot = join(storageRoot as string, 'file-evidence', 'run-run-collision')
    await mkdir(existingRunRoot, { recursive: true })
    await writeFile(join(existingRunRoot, 'sha256-existing'), 'prior immutable result')
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-collision' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'new result')

    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    await expect(readFile(join(existingRunRoot, 'sha256-existing'), 'utf8')).resolves.toBe(
      'prior immutable result'
    )
  })

  it('rejects a user-created file-evidence symlink without writing through it', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const outsideRoot = join(storageRoot as string, 'outside')
    await mkdir(outsideRoot)
    await symlink(outsideRoot, join(storageRoot as string, 'file-evidence'), 'dir')
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-symlink' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'must stay local')

    const result = await observation.finish()

    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readdir(outsideRoot)).resolves.toEqual([])
  })

  it('rejects evidence when the bound root path is replaced during publication', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const outsideRoot = join(storageRoot as string, 'outside-race')
    const displacedRoot = join(storageRoot as string, 'displaced-evidence')
    await mkdir(outsideRoot)
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-replaced-root' },
      {
        watchDirectory: watcherUnavailable,
        runEvidenceWorker: async (evidenceRoot) => {
          await rename(evidenceRoot, displacedRoot)
          await symlink(outsideRoot, evidenceRoot, 'dir')
          return {
            ok: true,
            generations: [],
            fileEvidence: {
              schemaVersion: 1,
              evidenceId: 'notebook-file-evidence-run-replaced-root',
              state: 'partial',
              checksum: 'a'.repeat(64),
              storageKey: 'file-evidence/run-run-replaced-root/evidence.json',
              relationCount: 1,
              generationCount: 0,
              scientificOutputCount: 1,
              initialViewState: 'complete',
              managedRootsFinalState: 'partial',
              scientificOutputAnalysis: 'partial',
              fileReads: 'unavailable',
              externalPaths: 'unavailable',
              writerAttribution: 'unavailable',
              reasonCodes: []
            }
          }
        }
      }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'must not be published')

    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readdir(outsideRoot)).resolves.toEqual([])
  })

  it('rejects evidence when the bound blob pool is replaced during publication', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-replaced-blob-pool' },
      { watchDirectory: watcherUnavailable }
    )
    const blobRoot = join(storageRoot as string, 'file-evidence-blobs')
    const displacedBlobRoot = join(storageRoot as string, 'displaced-file-evidence-blobs')
    await rename(blobRoot, displacedBlobRoot)
    await mkdir(blobRoot)
    await writeFile(join(dataRoot, 'result.csv'), 'must not enter replacement')

    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readdir(blobRoot)).resolves.toEqual([])
    await expect(readdir(displacedBlobRoot)).resolves.toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'does not block when a captured source is replaced by a FIFO',
    async () => {
      const { dataRoot } = await createRoots()
      const source = join(dataRoot, 'replaced.csv')
      await writeFile(source, 'captured bytes')
      const captured = await stat(source)
      await unlink(source)
      await execFile('mkfifo', [source])
      const evidenceRoot = join(storageRoot as string, 'file-evidence')
      await mkdir(evidenceRoot)
      const root = await stat(evidenceRoot)
      const blobPool = await createWorkerBlobPool()
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), 2_000)

      try {
        await runEvidenceWorker(evidenceRoot, {
          operation: 'begin',
          expectedRootIdentity: { dev: root.dev, ino: root.ino },
          receiptName: 'receipt-special-source-test.json',
          stagingName: 'staging-run-special-source-test',
          finalName: 'run-special-source-test',
          runId: 'special-source-test',
          evidenceId: 'notebook-file-evidence-special-source-test',
          storageKeyPrefix: 'file-evidence',
          ...blobPool,
          initialViewState: 'complete',
          initialFiles: [],
          maxGenerationBytes: 1024,
          maxRunBytes: 64 * 1024,
          diskReserveBytes: 0,
          availableBytes: 1024 * 1024,
          captureCancelled: false
        })
        await expect(
          runEvidenceWorker(
            evidenceRoot,
            {
              operation: 'persist',
              expectedRootIdentity: { dev: root.dev, ino: root.ino },
              receiptName: 'receipt-special-source-test.json',
              stagingName: 'staging-run-special-source-test',
              finalName: 'run-special-source-test',
              runId: 'special-source-test',
              evidenceId: 'notebook-file-evidence-special-source-test',
              storageKeyPrefix: 'file-evidence',
              ...blobPool,
              rootKinds: ['data'],
              rootsAvailable: true,
              reasonCodes: [],
              scientificOutputs: [],
              changes: [
                {
                  change: {
                    relation: 'created',
                    relativePath: 'data/replaced.csv',
                    after: {
                      physicalPath: source,
                      path: source,
                      relativePath: 'data/replaced.csv',
                      kind: 'other',
                      size: captured.size,
                      mtimeMs: captured.mtimeMs,
                      ctimeMs: captured.ctimeMs,
                      dev: captured.dev,
                      ino: captured.ino
                    }
                  },
                  generation: {
                    generationId: 'generation-special-source-test',
                    capturedAt: '1970-01-01T00:00:01.000Z'
                  }
                }
              ],
              maxGenerationBytes: 1024,
              maxRunBytes: 64 * 1024,
              diskReserveBytes: 0,
              availableBytes: 1024 * 1024,
              captureCancelled: false
            },
            controller.signal
          )
        ).resolves.toMatchObject({
          generations: [],
          fileEvidence: {
            generationCount: 0,
            reasonCodes: expect.arrayContaining(['generation-freeze-failed'])
          }
        })
      } finally {
        clearTimeout(abort)
      }
    }
  )

  it('reconciles only receipt-owned evidence and preserves matching user-created names', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    const location = {
      storageRoot: storageRoot as string,
      root: evidenceRoot,
      storageKeyPrefix: 'file-evidence'
    }
    const referenced = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-referenced' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'referenced.csv'), 'referenced')
    const referencedResult = await referenced.finish()
    const orphaned = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-unpublished' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'unpublished.csv'), 'unpublished')
    await orphaned.finish()
    await mkdir(join(evidenceRoot, 'staging-user-created'), { recursive: true })
    await mkdir(join(evidenceRoot, 'run-user-created'), { recursive: true })

    const result = await reconcileWorkingFileEvidence(location, [
      {
        runId: 'run-referenced',
        fileEvidence: referencedResult.fileEvidence
      }
    ])

    expect(result).toEqual({ removedStagingEntries: 0, removedRunEntries: 1 })
    await expect(readdir(evidenceRoot)).resolves.toEqual([
      'run-run-referenced',
      'run-user-created',
      'staging-user-created'
    ])
  })

  it('does not delete an unowned final directory named by an interrupted capture receipt', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-interrupted.json',
      stagingName: 'staging-interrupted',
      finalName: 'run-interrupted',
      runId: 'interrupted',
      evidenceId: 'notebook-file-evidence-interrupted',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    await mkdir(join(evidenceRoot, 'run-interrupted'))
    await writeFile(join(evidenceRoot, 'run-interrupted', 'keep.txt'), 'unowned')

    const result = await reconcileWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'file-evidence'
      },
      []
    )

    expect(result).toEqual({ removedStagingEntries: 1, removedRunEntries: 0 })
    await expect(readFile(join(evidenceRoot, 'run-interrupted', 'keep.txt'), 'utf8')).resolves.toBe(
      'unowned'
    )
  })

  it('recovers a prepared receipt after staging allocation using its ownership token', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    const stagingRoot = join(evidenceRoot, 'staging-prepared')
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(join(stagingRoot, '.ownership-prepared-token'), '')
    await writeFile(
      join(evidenceRoot, 'receipt-prepared.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'prepared',
        receiptName: 'receipt-prepared.json',
        stagingName: 'staging-prepared',
        finalName: 'run-prepared',
        runId: 'prepared',
        evidenceId: 'notebook-file-evidence-prepared',
        storageKeyPrefix: 'file-evidence',
        ownershipToken: 'prepared-token'
      })}\n`
    )

    const result = await reconcileWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'file-evidence'
      },
      []
    )

    expect(result).toEqual({ removedStagingEntries: 1, removedRunEntries: 0 })
    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('preserves a pre-existing staging directory when allocation collides', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    const stagingRoot = join(evidenceRoot, 'staging-allocation-collision')
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(join(stagingRoot, 'keep.txt'), 'pre-existing data')
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()

    await expect(
      runEvidenceWorker(evidenceRoot, {
        operation: 'begin',
        expectedRootIdentity: { dev: root.dev, ino: root.ino },
        receiptName: 'receipt-allocation-collision.json',
        stagingName: 'staging-allocation-collision',
        finalName: 'run-allocation-collision',
        runId: 'allocation-collision',
        evidenceId: 'notebook-file-evidence-allocation-collision',
        storageKeyPrefix: 'file-evidence',
        ...blobPool,
        initialViewState: 'complete',
        initialFiles: [],
        maxGenerationBytes: 1024,
        maxRunBytes: 64 * 1024,
        diskReserveBytes: 0,
        availableBytes: 1024 * 1024,
        captureCancelled: false
      })
    ).rejects.toThrow()
    await expect(readFile(join(stagingRoot, 'keep.txt'), 'utf8')).resolves.toBe('pre-existing data')
    await expect(
      readFile(join(evidenceRoot, 'receipt-allocation-collision.json'), 'utf8')
    ).resolves.toContain('allocation-collision')
  })

  it('recovers a final directory renamed before its capturing receipt was published', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-rename-gap.json',
      stagingName: 'staging-rename-gap',
      finalName: 'run-rename-gap',
      runId: 'rename-gap',
      evidenceId: 'notebook-file-evidence-rename-gap',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    await rename(join(evidenceRoot, 'staging-rename-gap'), join(evidenceRoot, 'run-rename-gap'))

    const result = await reconcileWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'file-evidence'
      },
      []
    )

    expect(result).toEqual({ removedStagingEntries: 0, removedRunEntries: 1 })
    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('recovers cleanup after a Run directory was quarantined', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-run-quarantine.json',
      stagingName: 'staging-run-quarantine',
      finalName: 'run-run-quarantine',
      runId: 'run-quarantine',
      evidenceId: 'notebook-file-evidence-run-quarantine',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    const receipt = JSON.parse(
      await readFile(join(evidenceRoot, 'receipt-run-quarantine.json'), 'utf8')
    ) as { ownershipToken: string }
    const tombstoneName =
      `deleting-run-${receipt.ownershipToken}-staging-` + '00000000-0000-4000-8000-000000000001'
    await rename(join(evidenceRoot, 'staging-run-quarantine'), join(evidenceRoot, tombstoneName))

    const result = await reconcileWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'file-evidence'
      },
      []
    )

    expect(result).toEqual({ removedStagingEntries: 1, removedRunEntries: 0 })
    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('preserves source, quarantine, and receipt when a Run quarantine name collides', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-run-quarantine-collision.json',
      stagingName: 'staging-run-quarantine-collision',
      finalName: 'run-run-quarantine-collision',
      runId: 'run-quarantine-collision',
      evidenceId: 'notebook-file-evidence-run-quarantine-collision',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    const receiptPath = join(evidenceRoot, 'receipt-run-quarantine-collision.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { ownershipToken: string }
    const tombstoneRoot = join(
      evidenceRoot,
      `deleting-run-${receipt.ownershipToken}-staging-` + '00000000-0000-4000-8000-000000000001'
    )
    await mkdir(tombstoneRoot)
    await writeFile(join(tombstoneRoot, 'keep.txt'), 'unowned quarantine data')

    await expect(
      reconcileWorkingFileEvidence(
        {
          storageRoot: storageRoot as string,
          root: evidenceRoot,
          storageKeyPrefix: 'file-evidence'
        },
        []
      )
    ).rejects.toThrow(/Run cleanup source and quarantine both exist/)
    await expect(
      readFile(join(evidenceRoot, 'staging-run-quarantine-collision', 'capture.json'), 'utf8')
    ).resolves.toContain('run-quarantine-collision')
    await expect(readFile(join(tombstoneRoot, 'keep.txt'), 'utf8')).resolves.toBe(
      'unowned quarantine data'
    )
    await expect(readFile(receiptPath, 'utf8')).resolves.toContain('run-quarantine-collision')
  })

  it('preserves a renamed final directory when its Run ownership marker is missing', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-rename-marker-missing.json',
      stagingName: 'staging-rename-marker-missing',
      finalName: 'run-rename-marker-missing',
      runId: 'rename-marker-missing',
      evidenceId: 'notebook-file-evidence-rename-marker-missing',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    const stagingRoot = join(evidenceRoot, 'staging-rename-marker-missing')
    const finalRoot = join(evidenceRoot, 'run-rename-marker-missing')
    const marker = (await readdir(stagingRoot)).find((entry) => entry.startsWith('.ownership-'))!
    await rename(stagingRoot, finalRoot)
    await unlink(join(finalRoot, marker))
    await writeFile(join(finalRoot, 'keep.txt'), 'unowned')

    await expect(
      reconcileWorkingFileEvidence(
        {
          storageRoot: storageRoot as string,
          root: evidenceRoot,
          storageKeyPrefix: 'file-evidence'
        },
        []
      )
    ).rejects.toThrow(/File-evidence Run ownership marker mismatch/)
    await expect(readFile(join(finalRoot, 'keep.txt'), 'utf8')).resolves.toBe('unowned')
    await expect(
      readFile(join(evidenceRoot, 'receipt-rename-marker-missing.json'), 'utf8')
    ).resolves.toContain('rename-marker-missing')
  })

  it('preserves the receipt when its allocated staging path becomes unsafe', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-unsafe-staging.json',
      stagingName: 'staging-unsafe-staging',
      finalName: 'run-unsafe-staging',
      runId: 'unsafe-staging',
      evidenceId: 'notebook-file-evidence-unsafe-staging',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    const stagingRoot = join(evidenceRoot, 'staging-unsafe-staging')
    await rm(stagingRoot, { recursive: true })
    await writeFile(stagingRoot, 'unsafe replacement')

    await expect(
      reconcileWorkingFileEvidence(
        {
          storageRoot: storageRoot as string,
          root: evidenceRoot,
          storageKeyPrefix: 'file-evidence'
        },
        []
      )
    ).rejects.toThrow(/File-evidence owned directory is unsafe/)
    await expect(readFile(stagingRoot, 'utf8')).resolves.toBe('unsafe replacement')
    await expect(
      readFile(join(evidenceRoot, 'receipt-unsafe-staging.json'), 'utf8')
    ).resolves.toContain('unsafe-staging')
  })

  it('preserves the receipt when its renamed final path becomes unsafe', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    const outsideRoot = join(storageRoot as string, 'outside-final-replacement')
    await mkdir(evidenceRoot)
    await mkdir(outsideRoot)
    await writeFile(join(outsideRoot, 'keep.txt'), 'unowned')
    const root = await stat(evidenceRoot)
    const blobPool = await createWorkerBlobPool()
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-unsafe-final.json',
      stagingName: 'staging-unsafe-final',
      finalName: 'run-unsafe-final',
      runId: 'unsafe-final',
      evidenceId: 'notebook-file-evidence-unsafe-final',
      storageKeyPrefix: 'file-evidence',
      ...blobPool,
      initialViewState: 'complete',
      initialFiles: [],
      maxGenerationBytes: 1024,
      maxRunBytes: 64 * 1024,
      diskReserveBytes: 0,
      availableBytes: 1024 * 1024,
      captureCancelled: false
    })
    await rm(join(evidenceRoot, 'staging-unsafe-final'), { recursive: true })
    await symlink(outsideRoot, join(evidenceRoot, 'run-unsafe-final'), 'dir')

    await expect(
      reconcileWorkingFileEvidence(
        {
          storageRoot: storageRoot as string,
          root: evidenceRoot,
          storageKeyPrefix: 'file-evidence'
        },
        []
      )
    ).rejects.toThrow(/File-evidence owned directory is unsafe/)
    await expect(readFile(join(outsideRoot, 'keep.txt'), 'utf8')).resolves.toBe('unowned')
    await expect(
      readFile(join(evidenceRoot, 'receipt-unsafe-final.json'), 'utf8')
    ).resolves.toContain('unsafe-final')
  })

  it('retires the exact receipt after the terminal Run has committed', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-committed' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'committed.csv'), 'committed')
    const result = await observation.finish()

    await completeWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'file-evidence'
      },
      { runId: 'run-committed', fileEvidence: result.fileEvidence }
    )

    await expect(readdir(evidenceRoot)).resolves.toEqual(['run-run-committed'])
    const runEntries = await readdir(join(evidenceRoot, 'run-run-committed'))
    expect(runEntries).toContain('evidence.json')
    expect(runEntries.some((entry) => entry.startsWith('.ownership-'))).toBe(true)
  })

  it('claims the Project before publishing evidence into its private root', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-owned')
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: join(projectRoot, 'session-1'),
        fileEvidenceStoragePrefix: 'notebook-file-evidence/project-owned/session-1',
        runId: 'run-owned-project'
      },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'owned evidence')
    const result = await observation.finish()

    expect(result.fileEvidence.storageKey).toBe(
      'notebook-file-evidence/project-owned/session-1/run-run-owned-project/evidence.json'
    )
    expect(await readdir(join(storageRoot as string, 'notebook-file-evidence'))).toContain(
      '.project-ownership-project-owned.json'
    )
    expect((await readdir(projectRoot)).some((name) => name.startsWith('.ownership-'))).toBe(true)
    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toHaveLength(1)
  })

  it('removes a failed capture blob without deleting the same bytes owned by an earlier Run', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-reuse')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-reuse/session-1'
    const baseline = join(dataRoot, 'baseline.csv')
    await writeFile(baseline, 'shared immutable bytes')
    const requestFor = (runId: string): Parameters<typeof startWorkingFileObservation>[0] => ({
      dataRoot,
      notebookSessionRoot: sessionRoot,
      fileEvidenceStorageRoot: storageRoot,
      fileEvidenceRoot: evidenceRoot,
      fileEvidenceStoragePrefix: storageKeyPrefix,
      runId
    })

    const first = await startWorkingFileObservation(requestFor('project-reuse-first'), {
      watchDirectory: watcherUnavailable
    })
    const firstResult = await first.finish()
    await completeWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      { runId: 'project-reuse-first', fileEvidence: firstResult.fileEvidence }
    )
    const firstSidecar = JSON.parse(
      await readFile(
        join(storageRoot as string, ...firstResult.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as { relations: Array<{ generation: { contentStorageKey: string } }> }

    const worker: typeof runEvidenceWorker = async (root, request, signal) => {
      const result = await runEvidenceWorker(root, request, signal)
      if (request.operation === 'begin') throw new Error('simulated failure after capture')
      return result
    }
    const failed = await startWorkingFileObservation(requestFor('project-reuse-failed'), {
      watchDirectory: watcherUnavailable,
      runEvidenceWorker: worker
    })
    const failedResult = await failed.finish()

    expect(failedResult.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toHaveLength(1)
    await expect(
      readFile(
        join(
          storageRoot as string,
          ...firstSidecar.relations[0].generation.contentStorageKey.split('/')
        ),
        'utf8'
      )
    ).resolves.toBe('shared immutable bytes')
  })

  it('reclaims an interrupted capture blob after receipt-owned startup cleanup', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-crash')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-crash/session-1'
    await writeFile(join(dataRoot, 'baseline.csv'), 'interrupted bytes')
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: evidenceRoot,
        fileEvidenceStoragePrefix: storageKeyPrefix,
        runId: 'project-crash-run'
      },
      { watchDirectory: watcherUnavailable }
    )

    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toHaveLength(1)
    await reconcileWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      []
    )

    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toEqual([])
    const result = await observation.finish()
    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['evidence-persistence-failed'])
    })
  })

  it('keeps Run-owned evidence readable when copied storage no longer shares CAS hardlinks', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-copied')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-copied/session-1'
    const content = 'copied immutable bytes'
    await writeFile(join(dataRoot, 'baseline.csv'), content)
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: evidenceRoot,
        fileEvidenceStoragePrefix: storageKeyPrefix,
        runId: 'project-copied-run'
      },
      { watchDirectory: watcherUnavailable }
    )
    const result = await observation.finish()
    await completeWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      { runId: 'project-copied-run', fileEvidence: result.fileEvidence }
    )
    const sidecar = JSON.parse(
      await readFile(
        join(storageRoot as string, ...result.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as { relations: Array<{ generation: { contentStorageKey: string } }> }
    const runBlob = join(
      storageRoot as string,
      ...sidecar.relations[0].generation.contentStorageKey.split('/')
    )
    const bytes = await readFile(runBlob)
    await unlink(runBlob)
    await writeFile(runBlob, bytes)

    await reconcileWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      [{ runId: 'project-copied-run', fileEvidence: result.fileEvidence }]
    )

    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toEqual([])
    await expect(readFile(runBlob, 'utf8')).resolves.toBe(content)
  })

  it('preserves a CAS blob when an additional hardlink makes ownership uncertain', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-held')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-held/session-1'
    await writeFile(join(dataRoot, 'baseline.csv'), 'held bytes')
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: evidenceRoot,
        fileEvidenceStoragePrefix: storageKeyPrefix,
        runId: 'project-held-run'
      },
      { watchDirectory: watcherUnavailable }
    )
    await observation.finish()
    const [contentName] = await readdir(join(projectRoot, 'blobs'))
    const heldPath = join(storageRoot as string, 'held-blob')
    await link(join(projectRoot, 'blobs', contentName), heldPath)

    await reconcileWorkingFileEvidence(
      { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix },
      []
    )

    await expect(readdir(join(projectRoot, 'blobs'))).resolves.toEqual([contentName])
    await expect(readFile(heldPath, 'utf8')).resolves.toBe('held bytes')
  })

  it('deletes no orphan blobs when the Project CAS contains an unknown entry', async () => {
    await createRoots()
    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-unsafe-pool')
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-unsafe-pool/session-1'
    const location = {
      storageRoot: storageRoot as string,
      root: evidenceRoot,
      storageKeyPrefix
    }
    await reconcileWorkingFileEvidence(location, [])
    const orphanContent = 'otherwise reclaimable'
    const orphanName = `sha256-${createHash('sha256').update(orphanContent).digest('hex')}`
    await writeFile(join(projectRoot, 'blobs', orphanName), orphanContent)
    await writeFile(join(projectRoot, 'blobs', 'unknown-entry'), 'unsafe')

    await expect(reconcileWorkingFileEvidence(location, [])).rejects.toThrow(
      /Unsafe file-evidence blob-pool entry/
    )
    await expect(readFile(join(projectRoot, 'blobs', orphanName), 'utf8')).resolves.toBe(
      orphanContent
    )
  })

  it('recovers an orphan CAS blob already moved to quarantine', async () => {
    await createRoots()
    const projectRoot = join(
      storageRoot as string,
      'notebook-file-evidence',
      'project-cas-recovery'
    )
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-cas-recovery/session-1'
    const location = { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix }
    await reconcileWorkingFileEvidence(location, [])
    const content = 'quarantined orphan bytes'
    const blobName = `sha256-${createHash('sha256').update(content).digest('hex')}`
    const blobRoot = join(projectRoot, 'blobs')
    await writeFile(join(blobRoot, blobName), content)
    await rename(
      join(blobRoot, blobName),
      join(blobRoot, `deleting-${blobName}-00000000-0000-4000-8000-000000000001`)
    )

    await reconcileWorkingFileEvidence(location, [])

    await expect(readdir(blobRoot)).resolves.toEqual([])
  })

  it('preserves CAS source and quarantine when the same blob has both entries', async () => {
    await createRoots()
    const projectRoot = join(
      storageRoot as string,
      'notebook-file-evidence',
      'project-cas-quarantine-collision'
    )
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-cas-quarantine-collision/session-1'
    const location = { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix }
    await reconcileWorkingFileEvidence(location, [])
    const content = 'colliding orphan bytes'
    const blobName = `sha256-${createHash('sha256').update(content).digest('hex')}`
    const blobRoot = join(projectRoot, 'blobs')
    const tombstoneName = `deleting-${blobName}-` + '00000000-0000-4000-8000-000000000001'
    await writeFile(join(blobRoot, blobName), content)
    await writeFile(join(blobRoot, tombstoneName), content)

    await expect(reconcileWorkingFileEvidence(location, [])).rejects.toThrow(
      /Multiple file-evidence blob entries exist/
    )
    await expect(readFile(join(blobRoot, blobName), 'utf8')).resolves.toBe(content)
    await expect(readFile(join(blobRoot, tombstoneName), 'utf8')).resolves.toBe(content)
  })

  it('preserves a CAS quarantine whose bytes do not match its hash name', async () => {
    await createRoots()
    const projectRoot = join(
      storageRoot as string,
      'notebook-file-evidence',
      'project-cas-tampered'
    )
    const evidenceRoot = join(projectRoot, 'session-1')
    const storageKeyPrefix = 'notebook-file-evidence/project-cas-tampered/session-1'
    const location = { storageRoot: storageRoot as string, root: evidenceRoot, storageKeyPrefix }
    await reconcileWorkingFileEvidence(location, [])
    const claimedContent = 'claimed bytes'
    const actualContent = 'unowned replacement bytes'
    const blobName = `sha256-${createHash('sha256').update(claimedContent).digest('hex')}`
    const tombstonePath = join(
      projectRoot,
      'blobs',
      `deleting-${blobName}-00000000-0000-4000-8000-000000000001`
    )
    await writeFile(tombstonePath, actualContent)

    await expect(reconcileWorkingFileEvidence(location, [])).rejects.toThrow(
      /blob checksum mismatch/
    )
    await expect(readFile(tombstonePath, 'utf8')).resolves.toBe(actualContent)
  })

  it('claims the Project before session evidence reconciliation creates its root', async () => {
    await createRoots()
    const evidenceRoot = join(
      storageRoot as string,
      'notebook-file-evidence',
      'project-reconcile',
      'session-1'
    )

    await reconcileWorkingFileEvidence(
      {
        storageRoot: storageRoot as string,
        root: evidenceRoot,
        storageKeyPrefix: 'notebook-file-evidence/project-reconcile/session-1'
      },
      []
    )

    const projectRoot = join(storageRoot as string, 'notebook-file-evidence', 'project-reconcile')
    expect(await readdir(join(storageRoot as string, 'notebook-file-evidence'))).toContain(
      '.project-ownership-project-reconcile.json'
    )
    expect((await readdir(projectRoot)).some((name) => name.startsWith('.ownership-'))).toBe(true)
    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-reconcile')
    await expect(readdir(projectRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes only the requested Project private evidence root', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    for (const projectName of ['project-1', 'project-2']) {
      await runEvidenceWorker(evidenceRoot, {
        operation: 'ensure-project',
        expectedRootIdentity: { dev: root.dev, ino: root.ino },
        projectName
      })
    }
    await mkdir(join(evidenceRoot, 'project-1', 'session-1'))
    await mkdir(join(evidenceRoot, 'project-2', 'session-2'))
    await writeFile(join(evidenceRoot, 'project-1', 'session-1', 'evidence.json'), 'delete')
    await writeFile(join(evidenceRoot, 'project-2', 'session-2', 'evidence.json'), 'keep')

    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-1')

    await expect(readdir(join(evidenceRoot, 'project-1'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(evidenceRoot, 'project-2', 'session-2', 'evidence.json'), 'utf8')
    ).resolves.toBe('keep')
    expect(await readdir(evidenceRoot)).toContain('.project-ownership-project-2.json')
  })

  it('recovers deletion after the owned Project was renamed to its tombstone', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-rename-gap'
    })
    const receiptPath = join(evidenceRoot, '.project-ownership-project-rename-gap.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      ownershipToken: string
    }
    const tombstoneName = `deleting-${receipt.ownershipToken}`
    await writeFile(join(evidenceRoot, 'project-rename-gap', 'evidence.json'), 'delete')
    await rename(join(evidenceRoot, 'project-rename-gap'), join(evidenceRoot, tombstoneName))

    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-rename-gap')

    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('retries a partially removed Project tombstone while preserving its marker until last', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-partial-delete'
    })
    const receiptPath = join(evidenceRoot, '.project-ownership-project-partial-delete.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      ownershipToken: string
    }
    const tombstoneName = `deleting-${receipt.ownershipToken}`
    await writeFile(join(evidenceRoot, 'project-partial-delete', 'evidence.json'), 'delete')
    await rename(join(evidenceRoot, 'project-partial-delete'), join(evidenceRoot, tombstoneName))
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'deleting',
        projectName: 'project-partial-delete',
        ownershipToken: receipt.ownershipToken,
        tombstoneName
      })}\n`
    )
    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-partial-delete')

    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('finishes deleting an empty Project tombstone after its marker was removed', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-empty-delete-gap'
    })
    const receiptPath = join(evidenceRoot, '.project-ownership-project-empty-delete-gap.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      ownershipToken: string
    }
    const tombstoneName = `deleting-${receipt.ownershipToken}`
    await rename(join(evidenceRoot, 'project-empty-delete-gap'), join(evidenceRoot, tombstoneName))
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'deleting',
        projectName: 'project-empty-delete-gap',
        ownershipToken: receipt.ownershipToken,
        tombstoneName
      })}\n`
    )
    await unlink(join(evidenceRoot, tombstoneName, `.ownership-${receipt.ownershipToken}`))

    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-empty-delete-gap')

    await expect(readdir(evidenceRoot)).resolves.toEqual([])
  })

  it('preserves a non-empty unowned directory recreated at a deletion tombstone name', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-replaced-tombstone'
    })
    const receiptPath = join(evidenceRoot, '.project-ownership-project-replaced-tombstone.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      ownershipToken: string
    }
    const tombstoneName = `deleting-${receipt.ownershipToken}`
    await rename(
      join(evidenceRoot, 'project-replaced-tombstone'),
      join(evidenceRoot, tombstoneName)
    )
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'deleting',
        projectName: 'project-replaced-tombstone',
        ownershipToken: receipt.ownershipToken,
        tombstoneName
      })}\n`
    )
    await rm(join(evidenceRoot, tombstoneName), { recursive: true })
    await mkdir(join(evidenceRoot, tombstoneName))
    await writeFile(join(evidenceRoot, tombstoneName, 'keep.txt'), 'unowned')

    await expect(
      deleteWorkingFileEvidenceProject(storageRoot as string, 'project-replaced-tombstone')
    ).rejects.toThrow(/lost its ownership marker/)
    await expect(readFile(join(evidenceRoot, tombstoneName, 'keep.txt'), 'utf8')).resolves.toBe(
      'unowned'
    )
  })

  it('preserves an unowned Project directory during deletion', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(join(evidenceRoot, 'project-unowned'), { recursive: true })
    await writeFile(join(evidenceRoot, 'project-unowned', 'keep.txt'), 'keep')

    await expect(
      deleteWorkingFileEvidenceProject(storageRoot as string, 'project-unowned')
    ).rejects.toThrow(/has no ownership receipt/)
    await expect(readFile(join(evidenceRoot, 'project-unowned', 'keep.txt'), 'utf8')).resolves.toBe(
      'keep'
    )
  })

  it('recovers a prepared Project receipt after an empty directory allocation', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    const projectRoot = join(evidenceRoot, 'project-prepared')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(
      join(evidenceRoot, '.project-ownership-project-prepared.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'prepared',
        projectName: 'project-prepared',
        ownershipToken: 'project-token'
      })}\n`
    )
    const root = await stat(evidenceRoot)

    await expect(
      runEvidenceWorker(evidenceRoot, {
        operation: 'ensure-project',
        expectedRootIdentity: { dev: root.dev, ino: root.ino },
        projectName: 'project-prepared'
      })
    ).resolves.toEqual({ ok: true, projectOwned: true })
    await expect(
      readFile(join(evidenceRoot, '.project-ownership-project-prepared.json'), 'utf8')
    ).resolves.toContain('"phase": "owned"')
    await expect(readdir(projectRoot)).resolves.toEqual(['.ownership-project-token'])
  })

  it('revalidates a copied Project marker after data-root migration changes its inode', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-migrated'
    })
    const projectRoot = join(evidenceRoot, 'project-migrated')
    const oldProjectRoot = join(evidenceRoot, 'old-project-migrated')
    const marker = (await readdir(projectRoot)).find((name) => name.startsWith('.ownership-'))!
    await rename(projectRoot, oldProjectRoot)
    await mkdir(projectRoot)
    await writeFile(join(projectRoot, marker), '')
    await writeFile(join(projectRoot, 'copied-evidence.json'), 'copied')

    await expect(
      runEvidenceWorker(evidenceRoot, {
        operation: 'ensure-project',
        expectedRootIdentity: { dev: root.dev, ino: root.ino },
        projectName: 'project-migrated'
      })
    ).resolves.toEqual({ ok: true, projectOwned: true })
    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-migrated')
    await expect(readdir(projectRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(oldProjectRoot, marker), 'utf8')).resolves.toBe('')
  })

  it('preserves an owned Project when its ownership marker is missing', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'ensure-project',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      projectName: 'project-marker-missing'
    })
    const projectRoot = join(evidenceRoot, 'project-marker-missing')
    const marker = (await readdir(projectRoot)).find((name) => name.startsWith('.ownership-'))!
    await unlink(join(projectRoot, marker))
    await writeFile(join(projectRoot, 'keep.txt'), 'keep')

    await expect(
      deleteWorkingFileEvidenceProject(storageRoot as string, 'project-marker-missing')
    ).rejects.toThrow()
    await expect(readFile(join(projectRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('refuses to delete a Project evidence path that was replaced by a symlink', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    const outsideRoot = join(storageRoot as string, 'outside-project-evidence')
    await mkdir(evidenceRoot)
    await mkdir(outsideRoot)
    await writeFile(join(outsideRoot, 'keep.txt'), 'keep')
    await symlink(outsideRoot, join(evidenceRoot, 'project-symlink'), 'dir')

    await expect(
      deleteWorkingFileEvidenceProject(storageRoot as string, 'project-symlink')
    ).rejects.toThrow(/has no ownership receipt/)
    await expect(readFile(join(outsideRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('refuses crash cleanup through a replaced evidence directory', async () => {
    await createRoots()
    const outsideRoot = join(storageRoot as string, 'outside-cleanup')
    await mkdir(outsideRoot)
    await writeFile(join(outsideRoot, 'keep.txt'), 'keep')
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await symlink(outsideRoot, evidenceRoot, 'dir')

    await expect(
      reconcileWorkingFileEvidence(
        {
          storageRoot: storageRoot as string,
          root: evidenceRoot,
          storageKeyPrefix: 'file-evidence'
        },
        []
      )
    ).rejects.toThrow(/Unsafe Notebook file-evidence directory/)
    await expect(readFile(join(outsideRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('passes cancellation into generation freezing and cleans the incomplete copy', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const controller = new AbortController()
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        runId: 'run-cancelled-freeze'
      },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'result.csv'), Buffer.alloc(1024 * 1024, 1))
    controller.abort()

    const result = await observation.finish(controller.signal)

    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.fileEvidence).toMatchObject({
      state: 'partial',
      generationCount: 0,
      reasonCodes: expect.arrayContaining(['generation-freeze-failed'])
    })
    const evidenceEntries = await readdir(
      join(storageRoot as string, 'file-evidence', 'run-run-cancelled-freeze')
    )
    expect(evidenceEntries).toContain('evidence.json')
    expect(evidenceEntries.some((entry) => entry.startsWith('.ownership-'))).toBe(true)
  })

  it('flushes generation bytes before publishing the run-owned directory', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-flushed' },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'durable bytes')

    const result = await observation.finish()

    expect(result.fileEvidence).toMatchObject({ state: 'partial', generationCount: 1 })
    const evidence = JSON.parse(
      await readFile(
        join(storageRoot as string, ...result.fileEvidence.storageKey!.split('/')),
        'utf8'
      )
    ) as { relations: Array<{ generation: { contentStorageKey: string } }> }
    await expect(
      readFile(
        join(
          storageRoot as string,
          ...evidence.relations[0].generation.contentStorageKey.split('/')
        ),
        'utf8'
      )
    ).resolves.toBe('durable bytes')
  })

  it('does not turn unobserved reads, transient files, or external writes into false evidence', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const input = join(dataRoot, 'input.csv')
    const transient = join(dataRoot, 'transient.tmp')
    await writeFile(input, 'input')
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-unobserved' },
      { watchDirectory: watcherUnavailable }
    )

    await readFile(input, 'utf8')
    await writeFile(transient, 'temporary')
    await unlink(transient)
    await writeFile(join(storageRoot as string, 'outside.csv'), 'outside')

    await expect(observation.finish()).resolves.toMatchObject({
      workingFiles: [],
      fileEvidence: {
        state: 'partial',
        initialViewState: 'complete',
        relationCount: 1,
        generationCount: 1,
        fileReads: 'unavailable',
        externalPaths: 'unavailable',
        reasonCodes: expect.arrayContaining([
          'file-reads-not-observed',
          'external-paths-not-observed',
          'transient-files-not-captured'
        ])
      }
    })
  })

  it('falls back after an asynchronous watcher failure instead of reporting no changes', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const watcher = {
      close: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'error') listener()
        return watcher
      })
    }
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-watcher-error' },
      { watchDirectory: (() => watcher) as never }
    )
    await writeFile(join(dataRoot, 'after-error.csv'), 'still observed')

    await expect(observation.finish()).resolves.toMatchObject({
      workingFiles: [{ relativePath: 'data/after-error.csv' }],
      fileEvidence: {
        state: 'partial',
        relationCount: 1,
        reasonCodes: expect.arrayContaining(['watcher-unavailable'])
      }
    })
  })

  it('preserves the historical working-file result when no run identity is supplied', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot },
      { watchDirectory: watcherUnavailable }
    )
    await writeFile(join(dataRoot, 'legacy.csv'), 'legacy')

    const result = await observation.finish()
    expect(result.workingFiles).toMatchObject([{ relativePath: 'data/legacy.csv' }])
    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.workingFiles[0]).not.toHaveProperty('change')
    expect(result.fileEvidence).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['run-identity-missing'])
    })
  })
})
