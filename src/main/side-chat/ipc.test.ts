import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSideChatIpcHandlers } from './ipc'

const handlers = new Map<string, (event: unknown, payload: never) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (event: unknown, payload: never) => unknown) =>
    handlers.set(channel, handler)
}))

describe('Side chat IPC', () => {
  beforeEach(() => handlers.clear())

  it('loads a main-owned bounded history snapshot before starting', async () => {
    const runtime = {
      start: vi.fn(async (request) => ({ sideSessionId: 'side-1', ...request })),
      send: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      closeActiveForParent: vi.fn(),
      closeForParent: vi.fn()
    }
    const dependencies = {
      loadParentSession: vi.fn(async () => ({
        messages: [
          { role: 'user', content: 'Plot cosine.', status: 'complete' },
          { role: 'assistant', content: 'Done.', status: 'complete' }
        ]
      })),
      hasLiveParentSession: vi.fn(() => false),
      assertParentAvailable: vi.fn(async () => undefined)
    }
    registerSideChatIpcHandlers(runtime as never, dependencies as never)

    await handlers.get('side-chat:start')?.(undefined, {
      parentSessionId: 'main-1',
      projectId: 'project-1',
      text: 'What context do you have?'
    } as never)

    expect(runtime.start).toHaveBeenCalledWith({
      parentSessionId: 'main-1',
      projectId: 'project-1',
      text: 'What context do you have?',
      historyPreamble: expect.stringContaining('Plot cosine.')
    })
  })

  it('rejects an unavailable parent and does not start a temporary runtime', async () => {
    const runtime = {
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      closeActiveForParent: vi.fn(),
      closeForParent: vi.fn()
    }
    registerSideChatIpcHandlers(runtime as never, {
      loadParentSession: vi.fn(async () => undefined),
      hasLiveParentSession: vi.fn(() => false),
      assertParentAvailable: vi.fn(async () => undefined)
    })

    await expect(
      handlers.get('side-chat:start')?.(undefined, {
        parentSessionId: 'missing',
        projectId: 'project-1',
        text: 'Hello'
      } as never)
    ).rejects.toThrow('parent Session is unavailable')
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('forwards follow-up, cancel, and close commands to the active owner', async () => {
    const runtime = {
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      closeActiveForParent: vi.fn(),
      closeForParent: vi.fn()
    }
    registerSideChatIpcHandlers(runtime as never, {} as never)

    await handlers.get('side-chat:send')?.(undefined, {
      sideSessionId: 'side-1',
      text: 'Follow up'
    } as never)
    await handlers.get('side-chat:cancel')?.(undefined, { sideSessionId: 'side-1' } as never)
    await handlers.get('side-chat:close')?.(undefined, { sideSessionId: 'side-1' } as never)

    expect(runtime.send).toHaveBeenCalledWith({ sideSessionId: 'side-1', text: 'Follow up' })
    expect(runtime.cancel).toHaveBeenCalledWith({ sideSessionId: 'side-1' })
    expect(runtime.close).toHaveBeenCalledWith({ sideSessionId: 'side-1' })
  })

  it('does not start a temporary runtime when the panel closes during parent preflight', async () => {
    let finishPreflight!: () => void
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const runtime = {
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      closeActiveForParent: vi.fn(),
      closeForParent: vi.fn()
    }
    registerSideChatIpcHandlers(runtime as never, {
      loadParentSession: vi.fn(async () => undefined),
      hasLiveParentSession: vi.fn(() => true),
      assertParentAvailable: vi.fn(() => preflight)
    })

    const start = handlers.get('side-chat:start')?.(undefined, {
      parentSessionId: 'main-1',
      projectId: 'project-1',
      text: 'Hello'
    } as never) as Promise<unknown>
    await handlers.get('side-chat:close')?.(undefined, {
      parentSessionId: 'main-1',
      discardRelays: false
    } as never)
    finishPreflight()

    await expect(start).rejects.toThrow('closed before startup completed')
    expect(runtime.start).not.toHaveBeenCalled()
    expect(runtime.closeActiveForParent).toHaveBeenCalledWith('main-1')
  })

  it('drops parent relay state when a workspace-scope close is requested', async () => {
    const runtime = {
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      closeActiveForParent: vi.fn(),
      closeForParent: vi.fn()
    }
    registerSideChatIpcHandlers(runtime as never, {} as never)

    await handlers.get('side-chat:close')?.(undefined, {
      parentSessionId: 'main-1',
      discardRelays: true
    } as never)

    expect(runtime.closeForParent).toHaveBeenCalledWith('main-1')
    expect(runtime.closeActiveForParent).not.toHaveBeenCalled()
  })
})
