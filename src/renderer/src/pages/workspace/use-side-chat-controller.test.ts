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

    act(() => result.current.close())
    expect(close).toHaveBeenCalledWith({ sideSessionId: 'side-1' })
    act(() => root.unmount())
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains one Side chat across Session navigation and app routes', async () => {
    const close = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    let eventListener: ((event: never) => void) | undefined
    window.api = {
      sideChat: {
        start: vi.fn(async () => ({
          sideSessionId: 'side-scope',
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
    expect(result.current.view?.sideSessionId).toBe('side-scope')
    act(() => result.current.setDraft('Unsent follow up'))

    parent = { sessionId: 'main-other', projectId: 'project-1' }
    render()
    expect(result.current.view).toBeUndefined()
    expect(result.current.unavailableReason).toContain('Another Side chat is open')
    expect(await result.current.start('Another')).toBe(false)
    expect(close).not.toHaveBeenCalled()
    act(() => {
      eventListener?.({
        parentSessionId: 'main-scope',
        sideSessionId: 'side-scope',
        event: { id: 'stop-scope', timestamp: 2, kind: 'stop', level: 'info' }
      } as never)
    })

    parent = { sessionId: 'main-scope', projectId: 'project-1' }
    render()
    expect(result.current.view?.entries[0]).toMatchObject({ text: 'Hello' })
    expect(result.current.view?.draft).toBe('Unsent follow up')
    await act(async () => expect(await result.current.send('Continue')).toBe(true))
    expect(send).toHaveBeenCalledWith({ sideSessionId: 'side-scope', text: 'Continue' })

    act(() => root.unmount())
    expect(close).not.toHaveBeenCalled()
  })

  it('drops the app-lifetime projection when the provider connection closes', async () => {
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

    expect(result.current.view).toBeUndefined()
    act(() => root.unmount())
  })
})
