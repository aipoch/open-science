import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestSender = {
  id: number
  once: (event: string, listener: () => void) => void
}

const handlers = new Map<string, (event: { sender: TestSender }, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: typeof handlers extends Map<string, infer T> ? T : never) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

const { registerOfficePreviewIpcHandlers } = await import('./office-preview-ipc')
const { OfficePreviewOpenSupersededError } = await import('./office-preview-supervisor')

describe('registerOfficePreviewIpcHandlers', () => {
  beforeEach(() => handlers.clear())

  it('derives Office preview ownership from the sending webContents', async () => {
    const supervisor = {
      open: vi.fn().mockResolvedValue({ kind: 'started', sessionId: 'session-1' }),
      setBounds: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      closeOwner: vi.fn().mockResolvedValue(undefined)
    }
    registerOfficePreviewIpcHandlers(supervisor)
    let destroyed: (() => void) | undefined
    let renderProcessGone: (() => void) | undefined
    const event = {
      sender: {
        id: 7,
        once: vi.fn((event: string, listener: () => void) => {
          if (event === 'destroyed') destroyed = listener
          if (event === 'render-process-gone') renderProcessGone = listener
        })
      }
    }
    const request = {
      source: 'artifact' as const,
      path: 'project/session/report.xlsx',
      name: 'report.xlsx',
      extension: 'xlsx' as const,
      attempt: 0
    }
    const bounds = { x: 1, y: 2, width: 300, height: 200, visible: true }

    await handlers.get('office-preview:open')?.(event, request)
    await handlers.get('office-preview:set-bounds')?.(event, 'session-1', bounds)
    await handlers.get('office-preview:close')?.(event, 'session-1')

    expect(supervisor.open).toHaveBeenCalledWith(7, request)
    expect(supervisor.setBounds).toHaveBeenCalledWith(7, 'session-1', bounds)
    expect(supervisor.close).toHaveBeenCalledWith(7, 'session-1')

    renderProcessGone?.()
    await Promise.resolve()
    expect(supervisor.closeOwner).toHaveBeenCalledWith(7)

    destroyed?.()
    await Promise.resolve()
    expect(supervisor.closeOwner).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit cancellation for a superseded development remount', async () => {
    const supervisor = {
      open: vi.fn().mockRejectedValue(new OfficePreviewOpenSupersededError()),
      setBounds: vi.fn(),
      close: vi.fn(),
      closeOwner: vi.fn()
    }
    registerOfficePreviewIpcHandlers(supervisor)
    const sender = { id: 8, once: vi.fn() }

    await expect(
      handlers.get('office-preview:open')?.(
        { sender },
        {
          source: 'artifact',
          path: 'report.xlsx',
          name: 'report.xlsx',
          extension: 'xlsx',
          attempt: 0
        }
      )
    ).resolves.toEqual({ kind: 'cancelled' })
  })
})
