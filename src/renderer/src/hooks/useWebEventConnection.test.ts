// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE
} from '../../../shared/web-event-connection'
import { useWebEventConnection } from './useWebEventConnection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderHook = <Value>(
  hook: () => Value
): {
  result: { current: Value }
  unmount: () => void
} => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }
  const HookHarness = (): null => {
    result.current = hook()
    return null
  }
  act(() => root.render(createElement(HookHarness)))
  return {
    result,
    unmount: () => act(() => root.unmount())
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
})

afterEach(() => {
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  vi.useRealTimers()
})

describe('useWebEventConnection', () => {
  it('stays live and does not announce consumers on non-Web renderers', () => {
    const ready = vi.fn()
    window.addEventListener(WEB_EVENT_CONSUMERS_READY_EVENT, ready)
    const hook = renderHook(() => useWebEventConnection(true))

    act(() => vi.runAllTimers())
    expect(hook.result.current).toBe('live')
    expect(ready).not.toHaveBeenCalled()
    hook.unmount()
    window.removeEventListener(WEB_EVENT_CONSUMERS_READY_EVENT, ready)
  })

  it('announces mounted consumers and follows bootstrap connection phases on Web', () => {
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    const ready = vi.fn()
    window.addEventListener(WEB_EVENT_CONSUMERS_READY_EVENT, ready)
    const hook = renderHook(() => useWebEventConnection(true))

    expect(hook.result.current).toBe('connecting')
    act(() => vi.runAllTimers())
    expect(ready).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, {
          detail: { phase: 'replaying' }
        })
      )
    })
    expect(hook.result.current).toBe('replaying')

    act(() => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, {
          detail: { phase: 'reload-required' }
        })
      )
    })
    expect(hook.result.current).toBe('reload-required')
    hook.unmount()
    window.removeEventListener(WEB_EVENT_CONSUMERS_READY_EVENT, ready)
  })
})
