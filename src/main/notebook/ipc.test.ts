import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRuntimeService } from './runtime-service'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
  }
}))

import { createNotebookHandlers, registerNotebookIpcHandlers } from './ipc'

beforeEach(() => {
  ipcHandlers.clear()
})

describe('notebook IPC handlers', () => {
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
      importIpynb: vi.fn().mockResolvedValue({ imported: true, cellCount: 1 }),
      openInJupyterLab: vi
        .fn()
        .mockResolvedValue({ opened: true, url: 'http://localhost:8888', alreadyRunning: false }),
      beginCodeCell: vi.fn().mockResolvedValue({ cellId: 'cell-1', writeId: 'write-1' }),
      appendCodeCell: vi.fn().mockResolvedValue({ receivedBytes: 5 }),
      finishCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      restart: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      shutdown: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'shutdown' })
    } as unknown as NotebookRuntimeService
    const handlers = createNotebookHandlers(service)

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
    await handlers.importIpynb({ sessionId: 'session-1', workspaceCwd: '/workspace' })
    await handlers.openInJupyterLab({ sessionId: 'session-1', workspaceCwd: '/workspace' })

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
    expect(service.importIpynb).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    expect(service.openInJupyterLab).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
  })

  it('registers every notebook channel and forwards the renderer payload unchanged', async () => {
    const service = {
      state: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getSessionReference: vi.fn().mockResolvedValue(null),
      beginCodeCell: vi.fn().mockResolvedValue({ cellId: 'cell-1', writeId: 'write-1' }),
      appendCodeCell: vi.fn().mockResolvedValue({ receivedBytes: 5 }),
      finishCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      runCell: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' }),
      execute: vi.fn().mockResolvedValue({ runId: 'run-2', status: 'completed' }),
      exportIpynb: vi.fn().mockResolvedValue({ saved: false }),
      importIpynb: vi.fn().mockResolvedValue({ imported: false }),
      openInJupyterLab: vi.fn().mockResolvedValue({
        opened: true,
        url: 'http://localhost:8888',
        alreadyRunning: false
      }),
      restart: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      shutdown: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'shutdown' })
    } as unknown as NotebookRuntimeService
    registerNotebookIpcHandlers(service)

    expect([...ipcHandlers.keys()]).toEqual([
      'notebook:state',
      'notebook:reference',
      'notebook:begin-code-cell',
      'notebook:append-code-cell',
      'notebook:finish-code-cell',
      'notebook:run-cell',
      'notebook:execute',
      'notebook:export-ipynb',
      'notebook:export-ipynb-all',
      'notebook:import-ipynb',
      'notebook:open-jupyterlab',
      'notebook:restart',
      'notebook:shutdown'
    ])

    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    const begin = { ...session }
    const append = { ...session, cellId: 'cell-1', writeId: 'write-1', delta: 'hello' }
    const finish = { ...session, cellId: 'cell-1', writeId: 'write-1' }
    const run = { ...session, cellId: 'cell-1', source: 'user' as const }
    const execute = { ...session, code: 'print(1)', source: 'user' as const }

    await ipcHandlers.get('notebook:state')?.(undefined, session)
    await ipcHandlers.get('notebook:reference')?.(undefined, session)
    await ipcHandlers.get('notebook:begin-code-cell')?.(undefined, begin)
    await ipcHandlers.get('notebook:append-code-cell')?.(undefined, append)
    await ipcHandlers.get('notebook:finish-code-cell')?.(undefined, finish)
    await ipcHandlers.get('notebook:run-cell')?.(undefined, run)
    await ipcHandlers.get('notebook:execute')?.(undefined, execute)
    await ipcHandlers.get('notebook:export-ipynb')?.(undefined, session)
    await ipcHandlers.get('notebook:import-ipynb')?.(undefined, session)
    await ipcHandlers.get('notebook:open-jupyterlab')?.(undefined, session)
    await ipcHandlers.get('notebook:restart')?.(undefined, session)
    await ipcHandlers.get('notebook:shutdown')?.(undefined, session)

    expect(service.state).toHaveBeenCalledWith(session)
    expect(service.getSessionReference).toHaveBeenCalledWith(session)
    expect(service.beginCodeCell).toHaveBeenCalledWith(begin)
    expect(service.appendCodeCell).toHaveBeenCalledWith(append)
    expect(service.finishCodeCell).toHaveBeenCalledWith(finish)
    expect(service.runCell).toHaveBeenCalledWith(run)
    expect(service.execute).toHaveBeenCalledWith(execute)
    expect(service.exportIpynb).toHaveBeenCalledWith(session)
    expect(service.importIpynb).toHaveBeenCalledWith(session)
    expect(service.openInJupyterLab).toHaveBeenCalledWith(session)
    expect(service.restart).toHaveBeenCalledWith(session)
    expect(service.shutdown).toHaveBeenCalledWith(session)
  })
})
