import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  mkdir,
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
  toPortableNotebookRelativePath
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

  it('publishes equal bytes as distinct immutable generations', async () => {
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
      relations: Array<{ generation: { checksum: string; contentStorageKey: string } }>
    }
    const generations = evidence.relations.map((relation) => relation.generation)

    expect(result.fileEvidence).toMatchObject({ generationCount: 2 })
    expect(new Set(generations.map((generation) => generation.checksum))).toHaveLength(1)
    expect(new Set(generations.map((generation) => generation.contentStorageKey))).toHaveLength(2)
    await expect(
      Promise.all(
        generations.map((generation) =>
          readFile(join(storageRoot as string, ...generation.contentStorageKey.split('/')), 'utf8')
        )
      )
    ).resolves.toEqual(['same bytes', 'same bytes'])
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
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-interrupted.json',
      stagingName: 'staging-interrupted',
      finalName: 'run-interrupted',
      runId: 'interrupted',
      evidenceId: 'notebook-file-evidence-interrupted',
      storageKeyPrefix: 'file-evidence',
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

  it('recovers a final directory renamed before its capturing receipt was published', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'file-evidence')
    await mkdir(evidenceRoot)
    const root = await stat(evidenceRoot)
    await runEvidenceWorker(evidenceRoot, {
      operation: 'begin',
      expectedRootIdentity: { dev: root.dev, ino: root.ino },
      receiptName: 'receipt-rename-gap.json',
      stagingName: 'staging-rename-gap',
      finalName: 'run-rename-gap',
      runId: 'rename-gap',
      evidenceId: 'notebook-file-evidence-rename-gap',
      storageKeyPrefix: 'file-evidence',
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
  })

  it('deletes only the requested Project private evidence root', async () => {
    await createRoots()
    const evidenceRoot = join(storageRoot as string, 'notebook-file-evidence')
    await mkdir(join(evidenceRoot, 'project-1', 'session-1'), { recursive: true })
    await mkdir(join(evidenceRoot, 'project-2', 'session-2'), { recursive: true })
    await writeFile(join(evidenceRoot, 'project-1', 'session-1', 'evidence.json'), 'delete')
    await writeFile(join(evidenceRoot, 'project-2', 'session-2', 'evidence.json'), 'keep')

    await deleteWorkingFileEvidenceProject(storageRoot as string, 'project-1')

    await expect(readdir(join(evidenceRoot, 'project-1'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(evidenceRoot, 'project-2', 'session-2', 'evidence.json'), 'utf8')
    ).resolves.toBe('keep')
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
    ).rejects.toThrow(/Unsafe Notebook file-evidence Project directory/)
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
    await expect(
      readdir(join(storageRoot as string, 'file-evidence', 'run-run-cancelled-freeze'))
    ).resolves.toEqual(['evidence.json'])
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
