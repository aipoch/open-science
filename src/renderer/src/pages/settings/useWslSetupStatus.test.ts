// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WslSetupStatus } from '../../../../shared/wsl-setup'
import { useWslSetupStatus } from './useWslSetupStatus'

const renderHook = <Value>(
  hook: () => Value
): { result: { current: Value }; unmount: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }
  const Harness = (): null => {
    result.current = hook()
    return null
  }
  act(() => root.render(createElement(Harness)))
  return { result, unmount: () => act(() => root.unmount()) }
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useWslSetupStatus', () => {
  it('retries an unavailable read and polls when status events are not supported', async () => {
    vi.useFakeTimers()
    const running: WslSetupStatus = {
      revision: 1,
      operation: {
        state: 'running',
        kind: 'install-platform',
        phase: 'installing',
        operationReference: 'install1',
        startedAt: 1
      }
    }
    const finished: WslSetupStatus = {
      revision: 2,
      operation: {
        state: 'finished',
        kind: 'install-platform',
        outcome: 'completed',
        operationReference: 'install1',
        startedAt: 1,
        finishedAt: 2
      }
    }
    const getWslSetupStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(running)
      .mockResolvedValue(finished)
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getWslSetupStatus
      }
    }

    const hook = renderHook(useWslSetupStatus)
    await act(async () => {})
    expect(hook.result.current).toBeUndefined()

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(hook.result.current).toEqual(running)

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(hook.result.current).toEqual(finished)
    hook.unmount()
    vi.useRealTimers()
  })

  it('keeps the newest revision when an event races the initial read and unsubscribes on unmount', async () => {
    const initialRead = Promise.withResolvers<WslSetupStatus>()
    let listener: ((status: WslSetupStatus) => void) | undefined
    const unsubscribe = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getWslSetupStatus: vi.fn(() => initialRead.promise),
        onWslSetupChanged: vi.fn((nextListener) => {
          listener = nextListener
          return unsubscribe
        })
      }
    }

    const hook = renderHook(useWslSetupStatus)
    const liveStatus: WslSetupStatus = {
      revision: 2,
      operation: {
        state: 'running',
        kind: 'install-platform',
        phase: 'installing',
        operationReference: 'install1',
        startedAt: 1
      }
    }
    act(() => listener?.(liveStatus))

    initialRead.resolve({ revision: 1, operation: { state: 'idle' } })
    await act(async () => {})
    expect(hook.result.current).toEqual(liveStatus)

    hook.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
