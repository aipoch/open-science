// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SideChatProvider, useSideChatController } from './use-side-chat-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const originalApi = window.api

afterEach(() => {
  window.api = originalApi
})

describe('Side chat renderer controller', () => {
  it('opens immediately, merges streamed chunks, and reuses one admitted Session', async () => {
    const started = deferred<{ sideSessionId: string; frameworkId: 'claude-code' }>()
    let eventListener: ((event: never) => void) | undefined
    const start = vi.fn(() => started.promise)
    const send = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    window.api = {
      sideChat: {
        start,
        send,
        cancel: vi.fn(async () => undefined),
        close,
        onEvent: vi.fn((listener) => {
          eventListener = listener as never
          return () => undefined
        }),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const container = document.createElement('div')
    const root = createRoot(container)
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    const Harness = (): null => {
      result.current = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
      return null
    }
    act(() => root.render(createElement(SideChatProvider, null, createElement(Harness))))

    let admitted!: Promise<boolean>
    act(() => {
      admitted = result.current.start('Initial question')
    })
    expect(result.current.view?.entries[0]).toMatchObject({
      role: 'user',
      text: 'Initial question'
    })
    const initialLiveTurnUserEntryId = result.current.view?.entries[0]?.id
    expect(result.current.view?.liveTurnUserEntryId).toBe(initialLiveTurnUserEntryId)

    act(() => {
      eventListener?.({
        parentSessionId: 'main-1',
        sideSessionId: 'side-1',
        event: {
          id: 'event-1',
          timestamp: 1,
          kind: 'message',
          level: 'info',
          sessionId: 'side-1',
          messageId: 'assistant-1',
          role: 'assistant',
          text: 'Hello '
        }
      } as never)
      eventListener?.({
        parentSessionId: 'main-1',
        sideSessionId: 'side-1',
        event: {
          id: 'event-2',
          timestamp: 2,
          kind: 'message',
          level: 'info',
          sessionId: 'side-1',
          messageId: 'assistant-1',
          role: 'assistant',
          text: 'there'
        }
      } as never)
    })
    expect(result.current.view?.entries[1]).toMatchObject({ text: 'Hello there' })

    await act(async () => {
      started.resolve({ sideSessionId: 'side-1', frameworkId: 'claude-code' })
      await admitted
    })
    await act(async () => {
      expect(await result.current.send('Follow up')).toBe(false)
      eventListener?.({
        parentSessionId: 'main-1',
        sideSessionId: 'side-1',
        event: { id: 'stop-1', timestamp: 3, kind: 'stop', level: 'info' }
      } as never)
      expect(await result.current.send('Follow up')).toBe(true)
    })
    expect(send).toHaveBeenCalledWith({ sideSessionId: 'side-1', text: 'Follow up' })
    const followUpEntry = result.current.view?.entries.findLast(
      (entry) => entry.kind === 'message' && entry.role === 'user'
    )
    expect(result.current.view?.liveTurnUserEntryId).toBe(followUpEntry?.id)
    expect(result.current.view?.liveTurnUserEntryId).not.toBe(initialLiveTurnUserEntryId)

    act(() => result.current.close())
    expect(close).toHaveBeenCalledWith({ sideSessionId: 'side-1' })
    act(() => root.unmount())
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains independent Side chats across Session navigation and app routes', async () => {
    const close = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    let eventListener: ((event: never) => void) | undefined
    let startNumber = 0
    window.api = {
      sideChat: {
        start: vi.fn(async () => ({
          sideSessionId: `side-scope-${++startNumber}`,
          frameworkId: 'claude-code' as const
        })),
        send,
        cancel: vi.fn(async () => undefined),
        close,
        onEvent: vi.fn((listener) => {
          eventListener = listener as never
          return () => undefined
        }),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']
    const container = document.createElement('div')
    const root = createRoot(container)
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    let parent = { sessionId: 'main-scope', projectId: 'project-1' }
    const Harness = (): null => {
      result.current = useSideChatController(parent)
      return null
    }
    const render = (): void =>
      act(() => root.render(createElement(SideChatProvider, null, createElement(Harness))))
    render()
    await act(async () => {
      expect(await result.current.start('Hello')).toBe(true)
    })
    expect(result.current.view?.sideSessionId).toBe('side-scope-1')
    act(() => result.current.setDraft('Unsent follow up'))

    parent = { sessionId: 'main-other', projectId: 'project-1' }
    render()
    expect(result.current.view).toBeUndefined()
    expect(result.current.unavailableReason).toBeUndefined()
    await act(async () => expect(await result.current.start('Another')).toBe(true))
    expect(result.current.view?.sideSessionId).toBe('side-scope-2')
    expect(close).not.toHaveBeenCalled()
    act(() => {
      eventListener?.({
        parentSessionId: 'main-scope',
        sideSessionId: 'side-scope-1',
        event: { id: 'stop-scope', timestamp: 2, kind: 'stop', level: 'info' }
      } as never)
    })

    parent = { sessionId: 'main-scope', projectId: 'project-1' }
    render()
    expect(result.current.view?.entries[0]).toMatchObject({ text: 'Hello' })
    expect(result.current.view?.draft).toBe('Unsent follow up')
    await act(async () => expect(await result.current.send('Continue')).toBe(true))
    expect(send).toHaveBeenCalledWith({ sideSessionId: 'side-scope-1', text: 'Continue' })

    parent = { sessionId: 'main-other', projectId: 'project-1' }
    render()
    expect(result.current.view?.entries[0]).toMatchObject({ text: 'Another' })

    act(() => root.unmount())
    expect(close).not.toHaveBeenCalled()
  })

  it('blocks only the closing parent until cleanup finishes', async () => {
    const closed = deferred<void>()
    const start = vi.fn(async ({ parentSessionId }: { parentSessionId: string }) => ({
      sideSessionId: `side-${parentSessionId}-${start.mock.calls.length}`,
      frameworkId: 'claude-code' as const
    }))
    window.api = {
      sideChat: {
        start,
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(() => closed.promise),
        onEvent: vi.fn(() => () => undefined),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    let parent = { sessionId: 'main-closing', projectId: 'project-1' }
    const Harness = (): null => {
      result.current = useSideChatController(parent)
      return null
    }
    const render = (): void =>
      act(() => root.render(createElement(SideChatProvider, null, createElement(Harness))))

    render()
    await act(async () => expect(await result.current.start('First')).toBe(true))
    act(() => result.current.close())
    expect(result.current.view).toBeUndefined()
    expect(result.current.unavailableReason).toBe('Closing Side chat…')
    await act(async () => expect(await result.current.start('Too soon')).toBe(false))
    expect(start).toHaveBeenCalledOnce()

    parent = { sessionId: 'main-other', projectId: 'project-1' }
    render()
    expect(result.current.unavailableReason).toBeUndefined()
    await act(async () => expect(await result.current.start('Other')).toBe(true))

    parent = { sessionId: 'main-closing', projectId: 'project-1' }
    render()
    expect(result.current.unavailableReason).toBe('Closing Side chat…')
    await act(async () => {
      closed.resolve()
      await closed.promise
    })
    expect(result.current.unavailableReason).toBeUndefined()
    await act(async () => expect(await result.current.start('Fresh')).toBe(true))
    expect(start).toHaveBeenCalledTimes(3)
    act(() => root.unmount())
  })

  it('restores the panel when durable cleanup fails so close can be retried', async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Session file is busy'))
      .mockResolvedValueOnce(undefined)
    window.api = {
      sideChat: {
        start: vi.fn(async () => ({
          sideSessionId: 'side-close-retry',
          frameworkId: 'claude-code' as const
        })),
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close,
        onEvent: vi.fn(() => () => undefined),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    const Harness = (): null => {
      result.current = useSideChatController({ sessionId: 'main-retry', projectId: 'project-1' })
      return null
    }
    act(() => root.render(createElement(SideChatProvider, null, createElement(Harness))))
    await act(async () => expect(await result.current.start('Hello')).toBe(true))

    await act(async () => {
      result.current.close()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.view).toMatchObject({
      sideSessionId: 'side-close-retry',
      error: expect.stringContaining('Session file is busy')
    })

    await act(async () => {
      result.current.close()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(close).toHaveBeenCalledTimes(2)
    expect(result.current.view).toBeUndefined()
    act(() => root.unmount())
  })

  it('retries hydration once when the initial Side chat list fails', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary IPC failure'))
      .mockResolvedValueOnce({ revision: 0, chats: [] })
    const start = vi.fn(async () => ({
      sideSessionId: 'side-after-retry',
      frameworkId: 'claude-code' as const
    }))
    window.api = {
      sideChat: {
        list,
        start,
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onEvent: vi.fn(() => () => undefined),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    const Harness = (): null => {
      result.current = useSideChatController({ sessionId: 'main-retry', projectId: 'project-1' })
      return null
    }

    await act(async () => {
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(list).toHaveBeenCalledTimes(2)
    expect(result.current.unavailableReason).toBeUndefined()
    await act(async () => expect(await result.current.start('Recovered')).toBe(true))
    expect(start).toHaveBeenCalledWith({
      parentSessionId: 'main-retry',
      projectId: 'project-1',
      text: 'Recovered'
    })
    act(() => root.unmount())
  })

  it('exposes a user retry after automatic hydration attempts fail', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary IPC failure'))
      .mockRejectedValueOnce(new Error('IPC still unavailable'))
      .mockResolvedValueOnce({ revision: 0, chats: [] })
    window.api = {
      sideChat: {
        list,
        start: vi.fn(),
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onEvent: vi.fn(() => () => undefined),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    const Harness = (): null => {
      result.current = useSideChatController({ sessionId: 'main-retry', projectId: 'project-1' })
      return null
    }

    await act(async () => {
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(list).toHaveBeenCalledTimes(2)
    expect(result.current.unavailableReason).toContain('Could not restore Side chats')
    const retryHydration = result.current.retryHydration
    expect(retryHydration).toBeTypeOf('function')

    await act(async () => {
      retryHydration?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(list).toHaveBeenCalledTimes(3)
    expect(result.current.unavailableReason).toBeUndefined()
    act(() => root.unmount())
  })

  it('hydrates every live Side chat and routes background events by parent Session', async () => {
    let eventListener: ((event: never) => void) | undefined
    const list = vi.fn(async () => ({
      revision: 4,
      chats: [
        {
          revision: 3,
          parentSessionId: 'main-a',
          projectId: 'project-1',
          sideSessionId: 'side-a',
          entries: [{ id: 'user-a', kind: 'message' as const, role: 'user' as const, text: 'A' }],
          running: true
        },
        {
          revision: 4,
          parentSessionId: 'main-b',
          projectId: 'project-1',
          sideSessionId: 'side-b',
          entries: [{ id: 'user-b', kind: 'message' as const, role: 'user' as const, text: 'B' }],
          running: false
        }
      ]
    }))
    window.api = {
      sideChat: {
        list,
        start: vi.fn(),
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onEvent: vi.fn((listener) => {
          eventListener = listener as never
          return () => undefined
        }),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']

    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    let parent = { sessionId: 'main-b', projectId: 'project-1' }
    const Harness = (): null => {
      result.current = useSideChatController(parent)
      return null
    }
    const render = async (): Promise<void> => {
      await act(async () => {
        root.render(createElement(SideChatProvider, null, createElement(Harness)))
        await Promise.resolve()
      })
    }

    await render()
    expect(list).toHaveBeenCalledOnce()
    expect(result.current.view?.entries[0]).toMatchObject({ text: 'B' })
    expect(result.current.view?.liveTurnUserEntryId).toBeUndefined()

    act(() => {
      eventListener?.({
        revision: 5,
        parentSessionId: 'main-a',
        projectId: 'project-1',
        sideSessionId: 'side-a',
        event: {
          id: 'assistant-a',
          timestamp: 2,
          kind: 'message',
          level: 'info',
          role: 'assistant',
          text: 'A answer'
        }
      } as never)
    })
    expect(result.current.view?.entries).toHaveLength(1)

    parent = { sessionId: 'main-a', projectId: 'project-1' }
    await render()
    expect(result.current.view?.entries).toEqual([
      expect.objectContaining({ text: 'A' }),
      expect.objectContaining({ text: 'A answer' })
    ])
    expect(result.current.view?.liveTurnUserEntryId).toBe('user-a')
    act(() => root.unmount())
  })

  it('keeps the durable projection retryable when the provider connection closes', async () => {
    let eventListener: ((event: never) => void) | undefined
    window.api = {
      sideChat: {
        start: vi.fn(async () => ({
          sideSessionId: 'side-closed',
          frameworkId: 'claude-code' as const
        })),
        send: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onEvent: vi.fn((listener) => {
          eventListener = listener as never
          return () => undefined
        }),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']
    const root = createRoot(document.createElement('div'))
    const result = {
      current: undefined as unknown as ReturnType<typeof useSideChatController>
    }
    const Harness = (): null => {
      result.current = useSideChatController({ sessionId: 'main-closed', projectId: 'project-1' })
      return null
    }
    act(() => root.render(createElement(SideChatProvider, null, createElement(Harness))))
    await act(async () => expect(await result.current.start('Hello')).toBe(true))

    act(() => {
      eventListener?.({
        parentSessionId: 'main-closed',
        sideSessionId: 'side-closed',
        event: { kind: 'closed', reason: 'connection-error' }
      } as never)
    })

    expect(result.current.view).toMatchObject({
      sideSessionId: 'side-closed',
      running: false,
      error: expect.stringContaining('reconnect')
    })
    await act(async () => expect(await result.current.send('Retry')).toBe(true))
    act(() => root.unmount())
  })
})

it('shows only one user message after a rejected follow-up is retried', async () => {
  const snapshot = {
    revision: 1,
    chats: [
      {
        revision: 1,
        parentSessionId: 'main-1',
        projectId: 'project-1',
        sideSessionId: 'side-1',
        entries: [],
        running: false
      }
    ]
  }
  const send = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('Session file is busy'))
  window.api = {
    sideChat: {
      list: vi.fn(async () => snapshot),
      send,
      onEvent: vi.fn(() => () => undefined),
      onRelayDelivered: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  const root = createRoot(document.createElement('div'))
  let controller!: ReturnType<typeof useSideChatController>
  const Harness = (): null => {
    controller = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
    return null
  }
  try {
    await act(async () =>
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
    )
    await act(async () => expect(await controller.send('Retry this exact question')).toBe(false))
    await act(async () => expect(await controller.send('Retry this exact question')).toBe(true))
    expect(
      controller.view?.entries.filter(
        (entry) =>
          entry.kind === 'message' &&
          entry.role === 'user' &&
          entry.text === 'Retry this exact question'
      )
    ).toHaveLength(1)
  } finally {
    act(() => root.unmount())
  }
})

it('localizes the restoration message in a non-English interface', async () => {
  const { i18next } = await import('../../i18n')
  await i18next.changeLanguage('zh-Hans')
  const listed = deferred<{ revision: number; chats: [] }>()
  window.api = {
    sideChat: {
      list: vi.fn(() => listed.promise),
      onEvent: vi.fn(() => () => undefined),
      onRelayDelivered: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  const root = createRoot(document.createElement('div'))
  let controller!: ReturnType<typeof useSideChatController>
  const Harness = (): null => {
    controller = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
    return null
  }
  try {
    await act(async () =>
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
    )
    expect(controller.unavailableReason).toMatch(/[\u3400-\u9fff]/)
  } finally {
    await act(async () => {
      listed.resolve({ revision: 1, chats: [] })
      await listed.promise
    })
    act(() => root.unmount())
    await i18next.changeLanguage('en')
  }
})

it.each([
  'restore-failed',
  'closing',
  'close-failed',
  'connection-closed',
  'interrupted-snapshot',
  'cancelled-snapshot',
  'electron-cancelled-snapshot'
] as const)(
  'localizes the owned %s notice while preserving diagnostic details',
  async (scenario) => {
    const { i18next } = await import('../../i18n')
    await i18next.changeLanguage('zh-Hans')
    const closed = deferred<void>()
    let listener: ((event: never) => void) | undefined
    const snapshot = {
      revision: 1,
      chats: [
        {
          revision: 1,
          parentSessionId: 'main-1',
          projectId: 'project-1',
          sideSessionId: 'side-1',
          entries: [],
          running: false,
          error:
            scenario === 'cancelled-snapshot'
              ? 'Side chat prompt cancelled.'
              : scenario === 'electron-cancelled-snapshot'
                ? "Error invoking remote method 'side-chat:send': Error: Side chat prompt cancelled."
                : undefined,
          ...(scenario === 'interrupted-snapshot'
            ? {
                notice: 'interrupted' as const
              }
            : {})
        }
      ]
    }
    window.api = {
      sideChat: {
        list: vi.fn(async () => {
          if (scenario === 'restore-failed') throw new Error('diagnostic-detail')
          return snapshot
        }),
        close: vi.fn(async () => {
          if (scenario === 'close-failed') throw new Error('diagnostic-detail')
          await closed.promise
        }),
        onEvent: vi.fn((callback) => {
          listener = callback as never
          return () => undefined
        }),
        onRelayDelivered: vi.fn(() => () => undefined)
      }
    } as unknown as Window['api']
    const root = createRoot(document.createElement('div'))
    let controller!: ReturnType<typeof useSideChatController>
    const Harness = (): null => {
      controller = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
      return null
    }
    try {
      await act(async () =>
        root.render(createElement(SideChatProvider, null, createElement(Harness)))
      )
      if (scenario === 'closing' || scenario === 'close-failed')
        await act(async () => controller.close())
      if (scenario === 'connection-closed')
        act(() =>
          listener?.({
            revision: 2,
            parentSessionId: 'main-1',
            projectId: 'project-1',
            sideSessionId: 'side-1',
            event: { kind: 'closed', reason: 'connection-closed' }
          } as never)
        )
      const notice = controller.unavailableReason ?? controller.view?.error
      if (scenario === 'restore-failed' || scenario === 'close-failed')
        expect(notice).toContain('diagnostic-detail')
      expect(notice).toMatch(/[\u3400-\u9fff]/)
    } finally {
      await act(async () => {
        closed.resolve()
        await closed.promise
      })
      act(() => root.unmount())
      await i18next.changeLanguage('en')
    }
  }
)

it('keeps an admitted follow-up when its IPC response fails', async () => {
  const base = {
    revision: 1,
    parentSessionId: 'main-1',
    projectId: 'project-1',
    sideSessionId: 'side-1',
    entries: [],
    running: false
  }
  const list = vi.fn(async () => ({
    revision: 2,
    chats: [
      {
        ...base,
        revision: 2,
        running: true,
        entries: [
          {
            id: 'user-authoritative',
            kind: 'message' as const,
            role: 'user' as const,
            text: 'Already sent'
          }
        ]
      }
    ]
  }))
  list.mockResolvedValueOnce({ revision: 1, chats: [base] })
  window.api = {
    sideChat: {
      list,
      send: vi.fn(async () => {
        throw new Error('Lost IPC response')
      }),
      onEvent: vi.fn(() => () => undefined),
      onRelayDelivered: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  const root = createRoot(document.createElement('div'))
  let controller!: ReturnType<typeof useSideChatController>
  const Harness = (): null => {
    controller = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
    return null
  }
  try {
    await act(async () =>
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
    )
    await act(async () => expect(await controller.send('Already sent')).toBe(true))
    expect(controller.view).toMatchObject({
      running: true,
      entries: [{ id: 'user-authoritative', text: 'Already sent' }]
    })
  } finally {
    act(() => root.unmount())
  }
})

it('publishes save failure and recovery without replacing a pending follow-up or its running state', async () => {
  const sent = deferred<void>()
  let listener: ((event: never) => void) | undefined
  window.api = {
    sideChat: {
      list: async () => ({
        revision: 1,
        chats: [
          {
            revision: 1,
            parentSessionId: 'main-1',
            projectId: 'project-1',
            sideSessionId: 'side-1',
            entries: [],
            running: false
          }
        ]
      }),
      send: () => sent.promise,
      onEvent: (callback: (event: never) => void) => {
        listener = callback as never
        return () => undefined
      },
      onRelayDelivered: () => () => undefined
    }
  } as unknown as Window['api']
  const root = createRoot(document.createElement('div'))
  let controller!: ReturnType<typeof useSideChatController>
  const Harness = (): null => {
    controller = useSideChatController({ sessionId: 'main-1', projectId: 'project-1' })
    return null
  }
  try {
    await act(async () =>
      root.render(createElement(SideChatProvider, null, createElement(Harness)))
    )
    let sending!: Promise<boolean>
    act(() => {
      sending = controller.send('Pending follow-up')
    })
    const entries = controller.view!.entries
    const envelope = { parentSessionId: 'main-1', projectId: 'project-1', sideSessionId: 'side-1' }
    act(() =>
      listener?.({
        ...envelope,
        revision: 2,
        event: { kind: 'persistence', error: 'Disk full' }
      } as never)
    )
    expect(controller.view).toMatchObject({ running: true, persistenceError: 'Disk full' })
    expect(controller.view!.entries).toBe(entries)
    act(() => listener?.({ ...envelope, revision: 3, event: { kind: 'persistence' } } as never))
    expect(controller.view!.persistenceError).toBeUndefined()
    expect(controller.view!.running).toBe(true)
    act(() =>
      listener?.({
        ...envelope,
        revision: 2,
        event: { kind: 'persistence', error: 'Stale failure' }
      } as never)
    )
    expect(controller.view!.persistenceError).toBeUndefined()
    await act(async () => {
      sent.resolve()
      await sending
    })
  } finally {
    act(() => root.unmount())
  }
})
