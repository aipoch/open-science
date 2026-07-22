import { describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

const document: NotebookRunDocument = {
  version: 1,
  projectName: 'default-project',
  sessionId: '12345678-abcd',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/storage/notebooks/default-project/12345678-abcd',
  dataRoot: '/storage/notebooks/default-project/12345678-abcd/data',
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: '/storage/runtime',
    lastKnownStatus: 'idle'
  },
  runs: [
    {
      runId: 'run-1',
      cellId: 'cell-1',
      source: 'agent',
      kernelKind: 'python',
      script: 'print("hello")',
      status: 'completed',
      startedAt: 1,
      executionCount: 1,
      text: { stdout: 'hello', stderr: '', traceback: '', plain: ['hello'] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
  ],
  updatedAt: 2
}

describe('NotebookRuntimeService exportIpynb', () => {
  it('loads the durable document and sends a serialized nbformat notebook to the save seam', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue(document)
    } as unknown as NotebookRunRepository
    const saveIpynb = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/downloads/session.ipynb' })
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      appVersion: '1.2.3',
      saveIpynb
    })

    const result = await service.exportIpynb({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace'
    })

    expect(repository.findExisting).toHaveBeenCalledWith('default-project', '12345678-abcd')
    expect(saveIpynb).toHaveBeenCalledOnce()
    expect(saveIpynb.mock.calls[0][0]).toBe('session-12345678.ipynb')
    const exported = JSON.parse(saveIpynb.mock.calls[0][1]) as {
      nbformat: number
      metadata: { open_science: { appVersion: string } }
      cells: Array<{ source: string[] }>
    }
    expect(exported).toMatchObject({
      nbformat: 4,
      metadata: { open_science: { appVersion: '1.2.3' } }
    })
    expect(exported.cells[0].source).toEqual(['print("hello")'])
    expect(result).toEqual({ saved: true, filePath: '/downloads/session.ipynb' })
  })

  it('rejects an unknown session before opening the save dialog', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue(null)
    } as unknown as NotebookRunRepository
    const saveIpynb = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      saveIpynb
    })

    await expect(
      service.exportIpynb({ sessionId: 'missing', workspaceCwd: '/workspace' })
    ).rejects.toThrow('Notebook session not found: missing')
    expect(saveIpynb).not.toHaveBeenCalled()
  })
})
