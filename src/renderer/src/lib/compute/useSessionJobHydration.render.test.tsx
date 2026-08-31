// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSessionJobState, useSessionJobStore } from '../../stores/session-job-store'
import { useSessionJobHydration } from './useSessionJobHydration'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useSessionJobHydration recovery', () => {
  let container: HTMLDivElement
  let root: Root
  const jobsList = vi.fn()
  let recovery: ReturnType<typeof useSessionJobHydration> | undefined

  const Probe = (): null => {
    recovery = useSessionJobHydration('session-1')
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jobsList.mockReset()
    useSessionJobStore.setState(createInitialSessionJobState())
    window.api = { compute: { jobsList } } as unknown as Window['api']
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('keeps an IPC failure visible and retries on focus', async () => {
    jobsList.mockRejectedValueOnce(new Error('database busy')).mockResolvedValueOnce([])

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(recovery?.error).toBe('database busy')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(jobsList).toHaveBeenCalledTimes(2)
    expect(recovery?.error).toBeUndefined()
  })

  it('cancels a scheduled exponential retry when its owner unmounts', async () => {
    vi.useFakeTimers()
    jobsList.mockRejectedValue(new Error('database busy'))

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    act(() => root.unmount())
    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    expect(jobsList).toHaveBeenCalledTimes(1)
  })
})
