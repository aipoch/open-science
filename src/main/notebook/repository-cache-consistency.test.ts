import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import { createRootNotebookLane } from './lane-identity'

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fsMocks.readFile.mockImplementation(actual.readFile)
  fsMocks.stat.mockImplementation(actual.stat)
  return { ...actual, readFile: fsMocks.readFile, stat: fsMocks.stat }
})

import { NotebookRunRepository } from './repository'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

describe('notebook repository cache consistency', () => {
  it('retries when run.json is atomically replaced during a cache-miss read', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-cache-race-'))
    const repository = new NotebookRunRepository(storageRoot)
    const sessionId = 'session-1'
    const runJsonPath = join(storageRoot, 'notebooks', 'default-project', sessionId, 'run.json')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace',
      lane: createRootNotebookLane('default-project', sessionId, 'root-frame-session-1')
    })

    const oldRaw = await readFile(runJsonPath, 'utf8')
    const oldInfo = await stat(runJsonPath)
    const replacementRun: NotebookRunRecord = {
      runId: 'replacement-run',
      cellId: 'replacement-cell',
      source: 'agent',
      kernelKind: 'python',
      script: '1',
      status: 'completed',
      startedAt: 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
    const replacement = JSON.parse(oldRaw) as NotebookRunDocument
    replacement.runs = [replacementRun]
    const replacementRaw = `${JSON.stringify(replacement, null, 2)}\n`
    const replacementInfo = {
      ...oldInfo,
      ino: oldInfo.ino + 1,
      mtimeMs: oldInfo.mtimeMs + 1,
      size: Buffer.byteLength(replacementRaw)
    }

    const cache = repository as unknown as {
      documentCache: Map<string, { document: NotebookRunDocument }>
    }
    cache.documentCache.clear()
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockResolvedValueOnce(oldRaw).mockResolvedValueOnce(replacementRaw)
    fsMocks.stat.mockReset()
    fsMocks.stat
      .mockResolvedValueOnce(oldInfo)
      .mockResolvedValueOnce(replacementInfo)
      .mockResolvedValueOnce(replacementInfo)
      .mockResolvedValueOnce(replacementInfo)

    const loaded = await repository.findExisting('default-project', sessionId)

    expect(loaded?.runs.map((run) => run.runId)).toEqual(['replacement-run'])
    expect(cache.documentCache.get(runJsonPath)?.document.runs[0]?.runId).toBe('replacement-run')
    expect(fsMocks.readFile).toHaveBeenCalledTimes(2)
  })
})
