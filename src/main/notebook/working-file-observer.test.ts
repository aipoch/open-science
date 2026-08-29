import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startWorkingFileObservation,
  toPortableNotebookRelativePath
} from './working-file-observer'

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
        storageKey: 'file-evidence/runs/run-created/evidence.json',
        relationCount: 1,
        generationCount: 1,
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
      join(sessionRoot, 'file-evidence', 'runs', 'run-created', 'evidence.json'),
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
    }
    expect(evidence.relations[0]).toMatchObject({
      relation: 'created',
      pathPortability: 'relative',
      authority: 'advisory',
      generation: { capturedAt: '1970-01-01T00:00:01.000Z' }
    })
    expect(
      await readFile(
        join(sessionRoot, ...evidence.relations[0].generation.contentStorageKey.split('/')),
        'utf8'
      )
    ).toBe(content)
  })

  it('records modified and deleted relations without dropping legacy working-file discovery', async () => {
    const { sessionRoot, dataRoot } = await createRoots()
    const modified = join(dataRoot, 'modified.csv')
    const deleted = join(dataRoot, 'deleted.csv')
    await writeFile(modified, 'before')
    await writeFile(deleted, 'delete me')
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-changes' },
      { watchDirectory: watcherUnavailable, maxGenerationBytes: 0 }
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
    expect(result.workingFiles[0]).not.toHaveProperty('generationId')
    expect(result.fileEvidence).toMatchObject({
      state: 'partial',
      relationCount: 2,
      generationCount: 0,
      reasonCodes: expect.arrayContaining(['generation-budget-exceeded'])
    })
    const evidence = JSON.parse(
      await readFile(
        join(sessionRoot, 'file-evidence', 'runs', 'run-changes', 'evidence.json'),
        'utf8'
      )
    ) as { relations: Array<{ relation: string; relativePath: string; reasonCode?: string }> }
    expect(evidence.relations).toEqual([
      {
        relation: 'deleted',
        relativePath: 'data/deleted.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        before: expect.any(Object)
      },
      {
        relation: 'modified',
        relativePath: 'data/modified.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        before: expect.any(Object),
        reasonCode: 'generation-budget-exceeded'
      }
    ])
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
        await readFile(join(sessionRoot, 'file-evidence', 'runs', runId, 'evidence.json'), 'utf8')
      ) as { relations: Array<{ generation: { contentStorageKey: string } }> }
      return readFile(
        join(sessionRoot, ...evidence.relations[0].generation.contentStorageKey.split('/')),
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
    const getAvailableBytes = vi.fn().mockResolvedValueOnce(8).mockResolvedValue(100_000)
    const observation = await startWorkingFileObservation(
      { dataRoot, notebookSessionRoot: sessionRoot, runId: 'run-disk-reserve' },
      {
        watchDirectory: watcherUnavailable,
        getAvailableBytes,
        diskReserveBytes: 8
      }
    )
    await writeFile(join(dataRoot, 'result.csv'), 'too large')

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
        writeEvidenceFile: async () => {
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
    await expect(
      readFile(join(sessionRoot, 'file-evidence', 'runs', 'run-persist-failure', 'evidence.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readdir(join(sessionRoot, 'file-evidence', 'staging')).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
    ).resolves.toEqual([])
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
        relationCount: 0,
        generationCount: 0,
        fileReads: 'unavailable',
        externalPaths: 'unavailable',
        reasonCodes: expect.arrayContaining([
          'file-reads-not-observed',
          'initial-file-generations-not-captured',
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
