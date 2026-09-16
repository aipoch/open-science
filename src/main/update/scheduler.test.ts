import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStrategy } from './strategy'
import { startUpdateScheduler } from './scheduler'
import { MAC_INSTALLATION_RESUME_UPDATE_ARG } from '../../shared/mac-installation'

const status = { state: 'idle' as const, current: '0.5.1' }

const createStrategy = (): UpdateStrategy => ({
  getStatus: vi.fn(() => status),
  check: vi.fn().mockResolvedValue(status),
  download: vi.fn().mockResolvedValue(status),
  cancel: vi.fn().mockResolvedValue(status),
  apply: vi.fn().mockResolvedValue(status)
})

describe('startUpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resumes downloading once after an installation handoff, not on periodic checks', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([MAC_INSTALLATION_RESUME_UPDATE_ARG])
    const strategy = createStrategy()
    vi.mocked(strategy.check).mockResolvedValue({
      state: 'available',
      current: '0.5.1',
      latest: '0.6.0'
    })
    const stop = startUpdateScheduler(strategy, 1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(strategy.download).toHaveBeenCalledOnce()
    stop()
  })

  it('checks immediately and then at the requested interval', async () => {
    const strategy = createStrategy()
    const stop = startUpdateScheduler(strategy, 1_000)

    expect(strategy.check).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(strategy.check).toHaveBeenCalledTimes(4)

    stop()
  })

  it('stops future checks when the caller tears down the scheduler', async () => {
    const strategy = createStrategy()
    const stop = startUpdateScheduler(strategy, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)
    stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(strategy.check).toHaveBeenCalledTimes(2)
  })
})
