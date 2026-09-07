import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRuntimeService } from './runtime-service'

const { ipcHandlers, log } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
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
      state: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
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
      'notebook:state',
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
      'notebook:shutdown'
    ])

    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
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

    await ipcHandlers.get('notebook:state')?.(undefined, session)
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

    await expect(handler?.(undefined, request)).resolves.toBe(executionFailure)
    await expect(handler?.(undefined, request)).rejects.toBe(submissionFailure)

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
