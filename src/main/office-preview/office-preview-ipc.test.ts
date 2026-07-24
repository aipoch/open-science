import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestSender = {
  id: number
  once: (event: string, listener: () => void) => void
}

type TestEvent = { sender: TestSender }
type TestHandler = (event: TestEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, TestHandler>()
const listeners = new Map<string, TestHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: TestHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: TestHandler) => listeners.set(channel, listener))
  }
}))

const { registerOfficePreviewIpcHandlers } = await import('./office-preview-ipc')
const { OfficePreviewOpenSupersededError } = await import('./office-preview-supervisor')

type TestSupervisor = {
  open: ReturnType<typeof vi.fn>
  attachFrame: ReturnType<typeof vi.fn>
  reportState: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  closeOwner: ReturnType<typeof vi.fn>
}

const createSupervisor = (): TestSupervisor => ({
  open: vi.fn(),
  attachFrame: vi.fn(),
  reportState: vi.fn(),
  close: vi.fn(),
  closeOwner: vi.fn()
})

describe('registerOfficePreviewIpcHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
  })

  it('derives ownership from the sender for open, attach, state, and close', async () => {
    const supervisor = createSupervisor()
    supervisor.open.mockResolvedValue({ kind: 'started', sessionId: 'session-1' })
    supervisor.attachFrame.mockResolvedValue({ kind: 'attached', start: {} })
    registerOfficePreviewIpcHandlers(supervisor as never)
    const sender = { id: 7, once: vi.fn() }
    const event = { sender }
    const request = {
      requestId: 'request-1',
      source: 'artifact',
      path: 'project/session/report.xlsx',
      name: 'report.xlsx',
      extension: 'xlsx',
      attempt: 0
    }
    const state = { sessionId: 'session-1', phase: 'ready' }

    await handlers.get('office-preview:open')?.(event, request)
    await handlers.get('office-preview:attach-frame')?.(event, 'session-1')
    listeners.get('office-preview:report-state')?.(event, 'session-1', state)
    await handlers.get('office-preview:close')?.(event, 'session-1')

    expect(supervisor.open).toHaveBeenCalledWith(7, request)
    expect(supervisor.attachFrame).toHaveBeenCalledWith(7, 'session-1')
    expect(supervisor.reportState).toHaveBeenCalledWith(7, 'session-1', state)
    expect(supervisor.close).toHaveBeenCalledWith(7, 'session-1')
  })

  it('closes an owner once when its renderer exits', async () => {
    const supervisor = createSupervisor()
    supervisor.open.mockResolvedValue({ kind: 'started', sessionId: 'session-1' })
    registerOfficePreviewIpcHandlers(supervisor as never)
    const exitListeners = new Map<string, () => void>()
    const sender = {
      id: 7,
      once: vi.fn((event: string, listener: () => void) => exitListeners.set(event, listener))
    }

    await handlers.get('office-preview:open')?.(
      { sender },
      {
        requestId: 'request-1',
        source: 'artifact',
        path: 'report.xlsx',
        name: 'report.xlsx',
        extension: 'xlsx',
        attempt: 0
      }
    )
    exitListeners.get('render-process-gone')?.()
    exitListeners.get('destroyed')?.()
    await Promise.resolve()

    expect(supervisor.closeOwner).toHaveBeenCalledTimes(1)
    expect(supervisor.closeOwner).toHaveBeenCalledWith(7)
  })

  it('ignores malformed frame and runtime-state messages', async () => {
    const supervisor = createSupervisor()
    registerOfficePreviewIpcHandlers(supervisor as never)
    const event = { sender: { id: 7, once: vi.fn() } }

    await handlers.get('office-preview:attach-frame')?.(event, 123)
    listeners.get('office-preview:report-state')?.(event, 'session-1', {
      sessionId: 'different-session',
      phase: 'ready'
    })
    listeners.get('office-preview:report-state')?.(event, 'session-1', { phase: 'invalid' })
    await handlers.get('office-preview:close')?.(event, undefined)

    expect(supervisor.attachFrame).not.toHaveBeenCalled()
    expect(supervisor.reportState).not.toHaveBeenCalled()
    expect(supervisor.close).not.toHaveBeenCalled()
  })

  it('contains state-report failures inside the one-way IPC listener', () => {
    const supervisor = createSupervisor()
    supervisor.reportState.mockImplementation(() => {
      throw new Error('state failure')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerOfficePreviewIpcHandlers(supervisor as never)
    const event = { sender: { id: 7, once: vi.fn() } }

    expect(() =>
      listeners.get('office-preview:report-state')?.(event, 'session-1', {
        sessionId: 'session-1',
        phase: 'ready'
      })
    ).not.toThrow()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('returns cancellation when a development remount supersedes an open', async () => {
    const supervisor = createSupervisor()
    supervisor.open.mockRejectedValue(new OfficePreviewOpenSupersededError())
    registerOfficePreviewIpcHandlers(supervisor as never)
    const event = { sender: { id: 8, once: vi.fn() } }

    await expect(
      handlers.get('office-preview:open')?.(event, {
        requestId: 'request-1',
        source: 'artifact',
        path: 'report.xlsx',
        name: 'report.xlsx',
        extension: 'xlsx',
        attempt: 0
      })
    ).resolves.toEqual({ kind: 'cancelled' })
  })
})
