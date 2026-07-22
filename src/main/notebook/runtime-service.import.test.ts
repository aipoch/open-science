import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const document = (root: string): NotebookRunDocument => ({
  version: 1,
  projectName: 'default-project',
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
  dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: join(root, 'runtime'),
    lastKnownStatus: 'idle'
  },
  runs: [],
  updatedAt: 1
})

const executor = {
  execute: vi.fn(),
  shutdown: vi.fn().mockResolvedValue({ reaped: true })
}

describe('NotebookRuntimeService importIpynb', () => {
  it('imports in one repository append and exposes data cells for rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ipynb-import-'))
    roots.push(root)
    const filePath = join(root, 'source.ipynb')
    await writeFile(
      filePath,
      JSON.stringify({
        nbformat: 4,
        metadata: { kernelspec: { name: 'python3', language: 'python' } },
        cells: [
          {
            cell_type: 'code',
            source: 'print(1)',
            execution_count: null,
            metadata: {},
            outputs: []
          },
          { cell_type: 'markdown', source: '# ignored' }
        ]
      })
    )
    const stored = document(root)
    const repository = {
      loadOrCreate: vi.fn().mockResolvedValue(stored),
      appendRuns: vi.fn().mockImplementation(async ({ runs }) => ({ ...stored, runs }))
    } as unknown as NotebookRunRepository
    const service = new NotebookRuntimeService({
      configRoot: join(root, 'config'),
      dataRoot: root,
      projectName: 'default-project',
      repository,
      executorFactory: () => executor,
      pickIpynb: async () => filePath
    })

    const result = await service.importIpynb({
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(result).toEqual({ imported: true, cellCount: 1, skippedCellCount: 1 })
    expect(repository.appendRuns).toHaveBeenCalledOnce()
    const importedRuns = vi.mocked(repository.appendRuns).mock.calls[0][0].runs
    expect(importedRuns[0]).toMatchObject({
      script: 'print(1)',
      status: 'imported',
      kernelKind: 'python'
    })
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    expect(state.cells).toEqual([
      expect.objectContaining({
        id: importedRuns[0].cellId,
        language: 'python',
        code: 'print(1)',
        status: 'idle'
      })
    ])
  })

  it('returns a cancellation result without reading or creating a session', async () => {
    const repository = {
      loadOrCreate: vi.fn()
    } as unknown as NotebookRunRepository
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      pickIpynb: async () => null
    })

    await expect(
      service.importIpynb({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    ).resolves.toEqual({ imported: false })
    expect(repository.loadOrCreate).not.toHaveBeenCalled()
  })

  it('reports invalid JSON as an import error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-ipynb-import-'))
    roots.push(root)
    const filePath = join(root, 'broken.ipynb')
    await writeFile(filePath, '{')
    const service = new NotebookRuntimeService({
      configRoot: join(root, 'config'),
      dataRoot: root,
      projectName: 'default-project',
      pickIpynb: async () => filePath
    })

    await expect(
      service.importIpynb({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    ).rejects.toThrow('Could not read .ipynb')
  })
})
