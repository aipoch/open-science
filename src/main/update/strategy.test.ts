import { describe, expect, it, vi } from 'vitest'

import {
  createActiveResearchSafeInstallGate,
  type InstallGate,
  type InstallReadiness
} from './strategy'

describe('createActiveResearchSafeInstallGate', () => {
  it('does not start update teardown while a data-root handoff owns the process', async () => {
    const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
    const gate = createActiveResearchSafeInstallGate(
      () => [],
      teardown,
      () => true
    )

    await expect(gate()).resolves.toEqual({ completed: false, reaped: false })
    expect(teardown).not.toHaveBeenCalled()
  })

  it('keeps the existing research blocker result ahead of teardown', async () => {
    const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
    const gate = createActiveResearchSafeInstallGate(() => ['reviewer'], teardown)

    const result: InstallReadiness = await gate()

    expect(result).toEqual({ completed: false, reaped: false, blockedBy: ['reviewer'] })
    expect(teardown).not.toHaveBeenCalled()
  })

  it('refuses installation when delegated work starts while teardown is awaiting', async () => {
    let blockers: ReturnType<Parameters<typeof createActiveResearchSafeInstallGate>[0]> = []
    const teardown = vi.fn<InstallGate>().mockImplementation(async () => {
      blockers = ['delegated']
      return { completed: true, reaped: true }
    })
    const gate = createActiveResearchSafeInstallGate(() => blockers, teardown)

    await expect(gate()).resolves.toEqual({
      completed: false,
      reaped: false,
      blockedBy: ['delegated']
    })
    expect(teardown).toHaveBeenCalledOnce()
  })
})
