import { describe, expect, it, vi } from 'vitest'

import type { NotebookRuntimeService } from './runtime-service'
import { createNotebookHandlers } from './ipc'

describe('notebook IPC handlers', () => {
  it('delegates renderer notebook commands to the shared runtime service', async () => {
    const service = {
      state: vi.fn().mockResolvedValue({ sessionId: 'session-1', cells: [] }),
      execute: vi.fn().mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        text: { stdout: 'ok\n', stderr: '', traceback: '', plain: ['ok'] }
      }),
      runCell: vi.fn().mockResolvedValue({ runId: 'run-2', status: 'completed' }),
      beginCodeCell: vi.fn().mockResolvedValue({ cellId: 'cell-1', writeId: 'write-1' }),
      appendCodeCell: vi.fn().mockResolvedValue({ receivedBytes: 5 }),
      finishCodeCell: vi.fn().mockResolvedValue({ status: 'idle' }),
      restart: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      shutdown: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'shutdown' })
    } as unknown as NotebookRuntimeService
    const handlers = createNotebookHandlers(service)

    await handlers.state({ sessionId: 'session-1', workspaceCwd: '/workspace' })
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
  })
})
