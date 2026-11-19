import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NotebookRuntimeService, type NotebookExecutionResult } from './runtime-service'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { releaseNotebookResources } from './owned-resources'
import type { NotebookExecutionRequest } from './execution-contract'
import type { NotebookShellProcess } from './shell-process'

it.each(['python', 'repl', 'shell', 'python-background', 'repl-background', 'shell-background'])(
  'cancels the original %s admission while a shared late healthy sample still admits another caller',
  async (surface) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-owned-admission-'))
    const healthy = healthyNotebookMemoryPolicy()
    const sample = Promise.withResolvers<ReturnType<typeof healthy.currentState>>()
    const entered = Promise.withResolvers<void>()
    let waiting = 0
    const execute = vi.fn(
      async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        outputs: [],
        cwdAfter: request.cwd
      })
    )
    const shell = vi.fn<NotebookShellProcess['execute']>(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0
    }))
    const executorFactory = vi.fn(() => ({ execute, shutdown: async () => ({ reaped: true }) }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: {
        ...healthy,
        getState: async () => {
          if (++waiting === 2) entered.resolve()
          return sample.promise
        }
      },
      executorFactory,
      shellProcess: { execute: shell },
      pythonRBackgroundExecutionEnabled: true,
      replBackgroundExecutionEnabled: true,
      shellBackgroundExecutionEnabled: true
    })
    const submit = (sessionId: string): Promise<unknown> => {
      const request = {
        sessionId,
        projectId: 'project',
        workspaceCwd: root,
        source: 'user' as const
      }
      switch (surface) {
        case 'repl':
          return service.executeControl({ ...request, code: '1' })
        case 'shell':
          return service.executeShell({ ...request, command: 'echo 1' })
        case 'repl-background':
          return service.executeControlBackground({ ...request, code: '1' })
        case 'shell-background':
          return service.executeShellBackground({ ...request, command: 'echo 1' })
        case 'python-background':
          return service.executeBackground({ ...request, language: 'python', code: '1' })
        default:
          return service.execute({ ...request, language: 'python', code: '1' })
      }
    }
    const first = submit('cancelled').catch((error: unknown) => error)
    const other = submit('other')
    try {
      await entered.promise
      const resources = service.ownedResources({ projectId: 'project', sessionId: 'cancelled' })
      expect(resources).toHaveLength(1)
      expect(resources[0]).toMatchObject({ group: 'operation', kind: 'session-work' })
      const release = releaseNotebookResources(resources)
      await Promise.resolve()
      sample.resolve(healthy.currentState())
      await release
      await expect(first).resolves.toMatchObject({ message: 'Notebook operation was released.' })
      const result = await other
      if (surface.endsWith('-background'))
        await service.waitForBackgroundRun((result as { runId: string }).runId)
      expect(executorFactory).toHaveBeenCalledOnce()
      expect(execute.mock.calls.every(([request]) => request.sessionId === 'other')).toBe(true)
      expect(shell.mock.calls.every(([request]) => request.sessionId === 'other')).toBe(true)
      expect(execute.mock.calls.length + shell.mock.calls.length).toBe(1)
    } finally {
      sample.resolve(healthy.currentState())
      await Promise.allSettled([first, other])
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('projects original pending controllers with exact Project/Session scope and cancels only those operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-owned-operations-'))
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'one',
    memoryPolicy: healthyNotebookMemoryPolicy(),
    executorFactory: () => ({
      execute: async (request): Promise<NotebookExecutionResult> => {
        entered[request.projectId === 'one' ? 0 : 1].resolve()
        if (!request.signal?.aborted) {
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener('abort', () => resolve(), { once: true })
          )
        }
        return {
          status: 'cancelled',
          stdout: '',
          stderr: '',
          traceback: '',
          outputs: [],
          cwdAfter: request.cwd
        }
      },
      shutdown: async () => ({ reaped: true })
    })
  })
  const request = {
    sessionId: 'same',
    workspaceCwd: root,
    source: 'user' as const,
    language: 'python' as const,
    code: 'print(1)'
  }
  const first = service.execute({ ...request, projectId: 'one' })
  const other = service.execute({ ...request, projectId: 'two' })
  try {
    await Promise.all(entered.map(({ promise }) => promise))
    const resources = service.ownedResources({ projectId: 'one', sessionId: 'same' })
    expect(resources).toEqual([
      expect.objectContaining({
        group: 'operation',
        projectId: 'one',
        sessionId: 'same',
        startedAt: expect.any(Number)
      })
    ])
    await expect(releaseNotebookResources(resources)).resolves.toEqual([
      expect.objectContaining({ result: { reaped: true } })
    ])
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(service.ownedResources({ projectId: 'two', sessionId: 'same' })).toHaveLength(1)
    expect(service.ownedResources({ projectId: 'dormant' })).toEqual([])
  } finally {
    await releaseNotebookResources(service.ownedResources())
    await Promise.allSettled([first, other])
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
