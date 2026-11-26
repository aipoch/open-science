import { configureTestElectronHost } from '../../../test/runtime-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NotebookRuntimeService } from './runtime-service'
import type { NotebookExecutionRequest } from './execution-contract'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import {
  notebookUserOperation,
  withNotebookExecutionIntent,
  withNotebookUserOperation
} from './execution-intent'

const { ipcHandlers, log } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => log
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
  }
}))

import { registerNotebookIpcHandlers } from './ipc'
import { createNotebookCommandWorkflows } from './notebook-workflows'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'

beforeEach(() => {
  ipcHandlers.clear()
  log.error.mockClear()
})
afterEach(() => clearMigrationPending())

describe('notebook IPC handlers', () => {
  it('forces a fresh terminal check through native IPC and the real runtime without replacing the kernel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-terminal-native-recheck-'))
    const policy = healthyNotebookMemoryPolicy()
    const getState = vi.fn(policy.getState)
    const identity = {}
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const executorFactory = vi.fn(() => ({
      execute,
      shutdown: async () => ({ reaped: true }),
      idleProcesses: () => [
        { identity, processKey: 'python:default-python', release: async () => true }
      ]
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: { ...policy, getState },
      executorFactory
    })
    const workflows = createNotebookCommandWorkflows(service)
    registerNotebookIpcHandlers(workflows)
    const sender = Object.assign(new EventEmitter(), { id: 324, isDestroyed: () => false })
    const request = {
      sessionId: 'session',
      workspaceCwd: root,
      source: 'user' as const,
      language: 'python' as const,
      code: '1'
    }
    try {
      expect((await workflows.execute(request)).status).toBe('completed')
      getState.mockClear()
      const terminal = { ...request, inputKind: 'terminal' as const }
      expect((await workflows.execute(terminal)).status).toBe('completed')
      expect(getState.mock.calls.some(([options]) => options?.force)).toBe(false)

      getState.mockClear()
      await expect(
        ipcHandlers.get('notebook:execute')!({ sender }, terminal)
      ).resolves.toMatchObject({ status: 'completed' })
      expect(getState.mock.calls.some(([options]) => options?.force)).toBe(true)
      expect(notebookUserOperation(terminal)).toBeUndefined()
      expect(execute).toHaveBeenCalledTimes(3)
      expect(executorFactory).toHaveBeenCalledOnce()
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks only a current native human terminal request and retains the caller fence', async () => {
    const execute = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
    const service = { execute } as unknown as NotebookRuntimeService
    registerNotebookIpcHandlers(createNotebookCommandWorkflows(service))
    const sender = Object.assign(new EventEmitter(), { id: 322, isDestroyed: () => false })
    const request = {
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      source: 'user' as const,
      inputKind: 'terminal' as const
    }
    const handler = ipcHandlers.get('notebook:execute')!

    await handler({ sender }, request)

    const operation = notebookUserOperation(execute.mock.calls[0][0])
    expect(operation).toEqual({ assertCurrent: expect.any(Function) })
    expect(execute).toHaveBeenCalledExactlyOnceWith(withNotebookUserOperation(request, operation!))
    expect(notebookUserOperation(request)).toBeUndefined()
    expect(() => operation!.assertCurrent()).not.toThrow()
    sender.emit('destroyed')
    expect(() => operation!.assertCurrent()).toThrow(/current human|lease/i)
    await expect(Promise.resolve().then(() => handler({ sender }, request))).rejects.toThrow(
      /current human|lease/i
    )
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not mark an ordinary user execution as an explicit terminal operation', async () => {
    const execute = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
    const service = { execute } as unknown as NotebookRuntimeService
    registerNotebookIpcHandlers(createNotebookCommandWorkflows(service))
    const request = {
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      source: 'user' as const
    }

    await ipcHandlers.get('notebook:execute')!(undefined, request)

    expect(execute).toHaveBeenCalledExactlyOnceWith(request)
    expect(notebookUserOperation(execute.mock.calls[0][0])).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a legacy release when its native caller is destroyed during Session validation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'notebook-release-native-lease-'))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project',
        memoryPolicy: healthyNotebookMemoryPolicy()
      })
      const entered = Promise.withResolvers<void>()
      const authority = Promise.withResolvers<void>()
      const workflows = createNotebookCommandWorkflows(service, {
        withSessionAvailable: async (_project, _session, operation) => {
          entered.resolve()
          await authority.promise
          return operation()
        },
        isSessionResourceReadable: async () => true,
        assertSessionResourceReleaseAvailable: () => undefined
      })
      workflows.configureResourceReleaseGuard(() => undefined)
      registerNotebookIpcHandlers(workflows)
      const sender = Object.assign(new EventEmitter(), { id: 321, isDestroyed: () => false })
      const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
      const intent = service.createExecutionIntent(scope)
      try {
        await service.executeControl(
          withNotebookExecutionIntent({ ...scope, code: 'globalThis.kept = 41' }, intent)
        )
        const group = (await service.getProjectResources(scope)).groups[0]
        const release = ipcHandlers.get('notebook:release-session-resources')!(
          { sender },
          { ...scope, revision: group.revision }
        )
        void Promise.resolve(release).catch(() => undefined)
        await entered.promise
        sender.emit('destroyed')
        authority.resolve()
        await expect(release).rejects.toThrow(/current human|lease/i)
        expect(intent.refusalId).toBeUndefined()
        await expect(
          service.executeControl(
            withNotebookExecutionIntent({ ...scope, code: 'console.log(kept)' }, intent)
          )
        ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('41') })
      } finally {
        authority.resolve()
        await service.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects direct renderer execution while a data-root migration is pending', async () => {
    const service = {
      execute: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
    } as unknown as NotebookRuntimeService
    const handlers = createNotebookCommandWorkflows(service)
    beginMigration()

    await expect(
      handlers.execute({
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user'
      })
    ).rejects.toThrow(/moving your data/i)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('delegates renderer notebook commands to the shared runtime service', async () => {
    const service = {
      state: vi.fn().mockResolvedValue({ sessionId: 'session-1', cells: [] }),
      getSessionReference: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      execute: vi.fn().mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        text: { stdout: 'ok\n', stderr: '', traceback: '', plain: ['ok'] }
      }),
      runCell: vi.fn().mockResolvedValue({ runId: 'run-2', status: 'completed' }),
      exportIpynb: vi.fn().mockResolvedValue({ saved: true, filePath: '/tmp/session.ipynb' }),
      beginCodeCell: vi.fn().mockResolvedValue({ cellId: 'cell-1', writeId: 'write-1' }),
      appendCodeCell: vi.fn().mockResolvedValue({ receivedBytes: 5 }),
      abortCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      finishCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      restart: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      shutdown: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'shutdown' })
    } as unknown as NotebookRuntimeService
    const handlers = createNotebookCommandWorkflows(service)

    await handlers.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.reference({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.execute({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print("ok")',
      source: 'user'
    })
    await handlers.runCell({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      source: 'user'
    })
    await handlers.beginCodeCell({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.appendCodeCell({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      writeId: 'write-1',
      delta: 'hello'
    })
    await handlers.finishCodeCell({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      writeId: 'write-1'
    })
    await handlers.restart({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.shutdown({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.exportIpynb({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      kernel: 'python'
    })

    expect(service.execute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print("ok")',
      source: 'user'
    })
    expect(service.runCell).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      source: 'user'
    })
    expect(service.shutdown).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    expect(service.getSessionReference).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    expect(service.exportIpynb).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      kernel: 'python'
    })
  })

  it('registers every notebook channel and forwards the renderer payload unchanged', async () => {
    const service = {
      runIndex: vi.fn().mockResolvedValue([{ runId: 'recorded-run' }]),
      state: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getMemoryPolicyState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      getProjectActivity: vi.fn().mockReturnValue({ kernels: [], backgroundRuns: [] }),
      inspectNamespace: vi.fn().mockResolvedValue({ status: 'unavailable' }),
      getSessionReference: vi.fn().mockResolvedValue(null),
      beginCodeCell: vi.fn().mockResolvedValue({ cellId: 'cell-1', writeId: 'write-1' }),
      appendCodeCell: vi.fn().mockResolvedValue({ receivedBytes: 5 }),
      abortCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      finishCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      runCell: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' }),
      execute: vi.fn().mockResolvedValue({ runId: 'run-2', status: 'completed' }),
      exportIpynb: vi.fn().mockResolvedValue({ saved: false }),
      exportIpynbAll: vi.fn().mockResolvedValue({ saved: false }),
      restart: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      shutdown: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'shutdown' })
    } as unknown as NotebookRuntimeService
    registerNotebookIpcHandlers(createNotebookCommandWorkflows(service))

    expect([...ipcHandlers.keys()]).toEqual([
      'notebook:project-resources',
      'notebook:release-session-resources',
      'notebook:resource-release',
      'notebook:retry-resource-release',
      'notebook:process-monitor',
      'notebook:terminate-monitored-process',
      'notebook:background-tasks',
      'notebook:run-figure',
      'notebook:run-evidence',
      'notebook:run-index',
      'notebook:state',
      'notebook:memory-policy-state',
      'notebook:project-activity',
      'notebook:inspect-namespace',
      'notebook:reference',
      'notebook:begin-code-cell',
      'notebook:append-code-cell',
      'notebook:abort-code-cell',
      'notebook:finish-code-cell',
      'notebook:run-cell',
      'notebook:execute',
      'notebook:export-ipynb',
      'notebook:export-ipynb-all',
      'notebook:restart',
      'notebook:shutdown',
      'notebook:background-run',
      'notebook:cancel-background-run'
    ])

    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    const project = { projectId: 'project-1' }
    const restartTarget = { ...session, language: 'r' as const, environment: 'default-r' }
    const namespace = { ...session, language: 'python' as const, environment: 'default-python' }
    const begin = { ...session }
    const append = { ...session, cellId: 'cell-1', writeId: 'write-1', delta: 'hello' }
    const finish = { ...session, cellId: 'cell-1', writeId: 'write-1' }
    const publicRun = { ...session, cellId: 'cell-1', source: 'user' as const }
    const publicExecute = { ...session, code: 'print(1)', source: 'user' as const }
    const forgedTurnContext = {
      provenanceContext: {
        rootFrameId: 'forged-root',
        agentFrameId: 'forged-agent',
        messageBranchId: 'forged-branch',
        runtimeSegmentId: 'forged-runtime',
        promptMessageId: 'forged-prompt'
      },
      registeredInputFiles: [],
      registeredHelperSkillIds: ['forged-skill'],
      inputRunLeaseId: 'forged-input-run-lease'
    }
    const run = { ...publicRun, ...forgedTurnContext }
    const execute = { ...publicExecute, ...forgedTurnContext }

    expect(ipcHandlers.has('notebook:run-index')).toBe(true)
    await expect(ipcHandlers.get('notebook:run-index')!(undefined, session)).resolves.toEqual([
      { runId: 'recorded-run' }
    ])
    expect(service.runIndex).toHaveBeenCalledWith(session)
    await ipcHandlers.get('notebook:state')?.(undefined, session)
    await expect(
      ipcHandlers.get('notebook:memory-policy-state')?.(undefined, {
        executionScope: 'darwin:host'
      })
    ).resolves.toEqual({ status: 'healthy' })
    expect(service.getMemoryPolicyState).toHaveBeenCalledWith({ executionScope: 'darwin:host' })
    await ipcHandlers.get('notebook:project-activity')?.(undefined, project)
    await ipcHandlers.get('notebook:inspect-namespace')?.(undefined, namespace)
    await ipcHandlers.get('notebook:reference')?.(undefined, session)
    await ipcHandlers.get('notebook:begin-code-cell')?.(undefined, begin)
    await ipcHandlers.get('notebook:append-code-cell')?.(undefined, append)
    await ipcHandlers.get('notebook:finish-code-cell')?.(undefined, finish)
    await ipcHandlers.get('notebook:run-cell')?.(undefined, run)
    await ipcHandlers.get('notebook:execute')?.(undefined, execute)
    await ipcHandlers.get('notebook:export-ipynb')?.(undefined, session)
    await ipcHandlers.get('notebook:export-ipynb-all')?.(undefined, session)
    await ipcHandlers.get('notebook:restart')?.(undefined, restartTarget)
    await ipcHandlers.get('notebook:shutdown')?.(undefined, session)

    expect(service.state).toHaveBeenCalledWith(session)
    expect(service.getProjectActivity).toHaveBeenCalledWith(project)
    expect(service.inspectNamespace).toHaveBeenCalledWith(namespace)
    expect(service.getSessionReference).toHaveBeenCalledWith(session)
    expect(service.beginCodeCell).toHaveBeenCalledWith(begin)
    expect(service.appendCodeCell).toHaveBeenCalledWith(append)
    expect(service.finishCodeCell).toHaveBeenCalledWith(finish)
    expect(service.runCell).toHaveBeenCalledWith(publicRun)
    expect(service.execute).toHaveBeenCalledWith(publicExecute)
    expect(service.exportIpynb).toHaveBeenCalledWith(session)
    expect(service.exportIpynbAll).toHaveBeenCalledWith(session)
    expect(service.restart).toHaveBeenCalledWith(restartTarget)
    expect(service.shutdown).toHaveBeenCalledWith(session)
  })

  it('logs terminal execution and submission failures without logging source code', async () => {
    const executionFailure = {
      runId: 'run-failed',
      status: 'failed',
      environment: 'default-python',
      text: {
        stdout: '',
        stderr: '',
        traceback: 'Traceback\nValueError: diagnostic detail',
        plain: []
      }
    }
    const submissionFailure = new Error('kernel connection closed')
    const execute = vi
      .fn()
      .mockResolvedValueOnce(executionFailure)
      .mockRejectedValueOnce(submissionFailure)
    const service = { execute } as unknown as NotebookRuntimeService
    registerNotebookIpcHandlers(createNotebookCommandWorkflows(service))
    const request = {
      sessionId: 'session-1',
      projectId: 'project-1',
      workspaceCwd: '/workspace',
      code: 'secret = 42',
      source: 'user' as const,
      inputKind: 'terminal' as const,
      language: 'python' as const
    }
    const handler = ipcHandlers.get('notebook:execute')
    const sender = Object.assign(new EventEmitter(), { id: 323, isDestroyed: () => false })

    await expect(handler?.({ sender }, request)).resolves.toBe(executionFailure)
    await expect(handler?.({ sender }, request)).rejects.toBe(submissionFailure)

    expect(log.error).toHaveBeenNthCalledWith(1, 'user terminal execution failed', {
      sessionId: 'session-1',
      projectId: 'project-1',
      language: 'python',
      environment: 'default-python',
      runId: 'run-failed',
      status: 'failed'
    })
    expect(log.error).toHaveBeenNthCalledWith(2, 'user terminal submission failed', {
      sessionId: 'session-1',
      projectId: 'project-1',
      language: 'python',
      codeLength: 11,
      errorCategory: 'error'
    })
    const logged = JSON.stringify(log.error.mock.calls)
    expect(logged).not.toContain('secret = 42')
    expect(logged).not.toContain('diagnostic detail')
    expect(logged).not.toContain('kernel connection closed')
  })
})

await configureTestElectronHost(await import('electron'))
