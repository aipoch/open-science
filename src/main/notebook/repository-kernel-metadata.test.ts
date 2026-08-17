import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookKernelKind, NotebookRunRecord } from '../../shared/notebook'
import { createRootNotebookLane } from './lane-identity'
import { NotebookRunRepository } from './repository'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-kernel-metadata-'))
  return storageRoot
}

const runFor = (kernelKind: NotebookKernelKind): NotebookRunRecord => ({
  runId: `run-${kernelKind}`,
  cellId: `cell-${kernelKind}`,
  source: 'agent',
  kernelKind,
  script: '1',
  status: 'completed',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: []
})

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('notebook repository kernel metadata', () => {
  it.each<NotebookKernelKind>(['r', 'repl', 'bash'])(
    'does not persist a document-level language for %s-only history',
    async (kernelKind) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')

      const created = await repository.loadOrCreate({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        lane
      })
      expect(created.kernel).not.toHaveProperty('language')

      await repository.appendRun({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        run: runFor(kernelKind)
      })

      const persisted = JSON.parse(
        await readFile(join(root, 'notebooks', 'default-project', 'session-1', 'run.json'), 'utf8')
      ) as { kernel: Record<string, unknown>; runs: NotebookRunRecord[] }
      expect(persisted.kernel).not.toHaveProperty('language')
      expect(persisted.runs).toEqual([expect.objectContaining({ kernelKind })])
    }
  )

  it('reads legacy language metadata and removes it on the next write', async () => {
    const root = await createStorageRoot()
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    const repository = new NotebookRunRepository(root)
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })

    const legacy = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
      kernel: Record<string, unknown>
    }
    legacy.kernel.language = 'python'
    await writeFile(runJsonPath, JSON.stringify(legacy, null, 2), 'utf8')

    const reloadedRepository = new NotebookRunRepository(root)
    const loaded = await reloadedRepository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    expect(loaded.kernel).not.toHaveProperty('language')

    await reloadedRepository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: runFor('r')
    })
    const persisted = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
      kernel: Record<string, unknown>
    }
    expect(persisted.kernel).not.toHaveProperty('language')
  })
})
