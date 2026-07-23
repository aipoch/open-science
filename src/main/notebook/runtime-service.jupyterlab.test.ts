import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import type { JupyterLabManager, JupyterLabLaunchRequest } from './jupyterlab'
import type { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { envPrefix, pythonBin, runtimeRoot } from './runtime-paths'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NotebookRuntimeService openInJupyterLab', () => {
  it('writes the current projection and launches with the bound managed Python', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-jupyterlab-'))
    roots.push(root)
    const document: NotebookRunDocument = {
      version: 1,
      projectName: 'default-project',
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace',
      notebookSessionRoot: join(root, 'notebooks', 'default-project', '12345678-abcd'),
      dataRoot: join(root, 'notebooks', 'default-project', '12345678-abcd', 'data'),
      kernel: {
        language: 'python',
        kernelName: 'python3',
        runtimeRoot: runtimeRoot(root),
        lastKnownStatus: 'idle'
      },
      runs: [
        {
          runId: 'run-1',
          cellId: 'cell-1',
          source: 'agent',
          kernelKind: 'python',
          script: 'print(1)',
          status: 'completed',
          startedAt: 1,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: []
        }
      ],
      updatedAt: 2
    }
    const repository = {
      loadOrCreate: vi.fn().mockResolvedValue(document),
      findExisting: vi.fn().mockResolvedValue(document)
    } as unknown as NotebookRunRepository
    let launchRequest: JupyterLabLaunchRequest | undefined
    const manager = {
      launch: vi.fn(async (request: JupyterLabLaunchRequest) => {
        launchRequest = request
        return { url: 'http://localhost:8888/lab?token=x', alreadyRunning: false }
      }),
      shutdown: vi.fn().mockResolvedValue({ reaped: true }),
      shutdownAll: vi.fn().mockResolvedValue({ reaped: true })
    } as unknown as JupyterLabManager
    const service = new NotebookRuntimeService({
      configRoot: join(root, 'config'),
      dataRoot: root,
      projectName: 'default-project',
      repository,
      executorFactory: () => ({
        execute: vi.fn(),
        shutdown: vi.fn().mockResolvedValue({ reaped: true })
      }),
      jupyterLabManager: manager
    })

    const result = await service.openInJupyterLab({
      sessionId: '12345678-abcd',
      workspaceCwd: '/workspace'
    })

    expect(result).toEqual({
      opened: true,
      url: 'http://localhost:8888/lab?token=x',
      alreadyRunning: false
    })
    expect(launchRequest).toMatchObject({
      sessionId: '12345678-abcd',
      command: pythonBin(envPrefix(runtimeRoot(root), 'default-python')),
      rootDir: document.dataRoot,
      cwd: document.dataRoot
    })
    const notebookPath = launchRequest?.notebookPath
    expect(notebookPath).toBe(join(document.dataRoot, 'session-12345678.ipynb'))
    const written = JSON.parse(await readFile(notebookPath as string, 'utf8')) as {
      nbformat: number
      cells: Array<{ source: string[] }>
    }
    expect(written).toMatchObject({ nbformat: 4, cells: [{ source: ['print(1)'] }] })
  })
})
