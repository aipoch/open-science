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
  it('exports root and Frame-lane runs through the same Session work surface', async () => {
    const childRun = {
      ...document.runs[0]!,
      runId: 'run-child',
      cellId: 'cell-child',
      script: 'print("child")',
      startedAt: 3,
      rootFrameId: 'root-frame-12345678-abcd',
      agentFrameId: 'child-frame-1',
      runtimeSegmentId: 'runtime-child'
    }
    const repository = {
      findExisting: vi.fn().mockResolvedValue(document),
      readSessionRuns: vi.fn().mockResolvedValue([document.runs[0], childRun])
    } as unknown as NotebookRunRepository
    const saveIpynb = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/downloads/export.ipynb' })
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      saveIpynb
    })

    await service.exportIpynb({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace',
      kernel: 'python'
    })

    expect(repository.readSessionRuns).toHaveBeenCalledWith('default-project', '12345678-abcd')
    const exported = JSON.parse(saveIpynb.mock.calls[0]![1] as string) as {
      cells: Array<{ source: string[]; metadata: { open_science: { agentFrameId?: string } } }>
    }
    expect(exported.cells.map((cell) => cell.source.join(''))).toEqual([
      'print("hello")',
      'print("child")'
    ])

    await service.exportIpynb({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace',
      kernel: 'python',
      agentFrameFilter: 'child-frame-1'
    })
    const childExport = JSON.parse(saveIpynb.mock.calls[1]![1] as string) as {
      cells: Array<{ source: string[] }>
    }
    expect(childExport.cells.map((cell) => cell.source.join(''))).toEqual(['print("child")'])

    await service.exportIpynb({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace',
      kernel: 'python',
      agentFrameFilter: null
    })
    const legacyExport = JSON.parse(saveIpynb.mock.calls[2]![1] as string) as {
      cells: Array<{ source: string[] }>
    }
    expect(legacyExport.cells.map((cell) => cell.source.join(''))).toEqual(['print("hello")'])
  })

  it('loads the durable document and sends a serialized nbformat notebook to the save seam', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue(document)
    } as unknown as NotebookRunRepository
    const saveIpynb = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/downloads/session-12345678-python.ipynb' })
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
      workspaceCwd: '/workspace',
      kernel: 'python'
    })

    expect(repository.findExisting).toHaveBeenCalledWith('default-project', '12345678-abcd')
    expect(saveIpynb).toHaveBeenCalledOnce()
    expect(saveIpynb.mock.calls[0][0]).toBe('session-12345678-python.ipynb')
    const serialized = saveIpynb.mock.calls[0][1] as string
    const exported = JSON.parse(serialized) as {
      nbformat: number
      metadata: { open_science: { appVersion: string } }
      cells: Array<{ source: string[] }>
    }
    expect(serialized).toBe(`${JSON.stringify(exported, null, 2)}\n`)
    expect(exported).toMatchObject({
      nbformat: 4,
      metadata: { open_science: { appVersion: '1.2.3' } }
    })
    expect(exported.cells[0].source).toEqual(['print("hello")'])
    expect(result).toEqual({ saved: true, filePath: '/downloads/session-12345678-python.ipynb' })
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
      service.exportIpynb({ sessionId: 'missing', workspaceCwd: '/workspace', kernel: 'python' })
    ).rejects.toThrow('Notebook session not found: missing')
    expect(saveIpynb).not.toHaveBeenCalled()
  })

  it('keeps the existing no-data-kernel error and does not open the save dialog', async () => {
    const repository = {
      findExisting: vi.fn().mockResolvedValue({
        ...document,
        runs: [{ ...document.runs[0], kernelKind: 'repl' }]
      })
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
      service.exportIpynb({
        sessionId: '12345678-abcd',
        workspaceCwd: '/workspace',
        kernel: 'repl'
      })
    ).rejects.toThrow('No data-kernel runs in this session. Run a Python or R cell first.')
    expect(saveIpynb).not.toHaveBeenCalled()
  })

  it('keeps multi-kernel filenames, byte serialization, and control-run attribution', async () => {
    const run = document.runs[0]!
    const mixedDocument: NotebookRunDocument = {
      ...document,
      runs: [
        { ...run, runId: 'bash-before', cellId: 'bash-before', kernelKind: 'bash', script: 'pwd' },
        { ...run, runId: 'python', cellId: 'python', kernelKind: 'python', script: 'print(1)' },
        { ...run, runId: 'repl', cellId: 'repl', kernelKind: 'repl', script: 'await task()' },
        { ...run, runId: 'r', cellId: 'r', kernelKind: 'r', script: 'print(2)' },
        { ...run, runId: 'bash-after', cellId: 'bash-after', kernelKind: 'bash', script: 'ls' }
      ]
    }
    const repository = {
      findExisting: vi.fn().mockResolvedValue(mixedDocument)
    } as unknown as NotebookRunRepository
    const saveIpynbAll = vi.fn().mockResolvedValue({ saved: true, filePaths: [] })
    const service = new NotebookRuntimeService({
      configRoot: '/config',
      dataRoot: '/storage',
      projectName: 'default-project',
      repository,
      saveIpynbAll
    })

    await service.exportIpynbAll({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace'
    })

    const files = saveIpynbAll.mock.calls[0][0] as Array<{
      kernel: 'python' | 'r'
      name: string
      data: string
    }>
    expect(files.map(({ kernel, name }) => ({ kernel, name }))).toEqual([
      { kernel: 'python', name: 'session-12345678-python.ipynb' },
      { kernel: 'r', name: 'session-12345678-r.ipynb' }
    ])

    const python = JSON.parse(files[0]!.data) as { cells: Array<{ source: string[] }> }
    const r = JSON.parse(files[1]!.data) as { cells: Array<{ source: string[] }> }
    expect(files[0]!.data).toBe(`${JSON.stringify(python, null, 2)}\n`)
    expect(files[1]!.data).toBe(`${JSON.stringify(r, null, 2)}\n`)
    expect(python.cells.map((cell) => cell.source.join(''))).toEqual([
      '%%bash\npwd',
      'print(1)',
      '%%javascript\nawait task()'
    ])
    expect(r.cells.map((cell) => cell.source.join(''))).toEqual(['print(2)', '%%bash\nls'])
  })
})
