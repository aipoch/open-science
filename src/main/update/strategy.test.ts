import { describe, expect, it, vi } from 'vitest'

import {
  createActiveResearchSafeInstallGate,
  createDataRootResearchSafeInstallGate,
  type InstallGate,
  type InstallReadiness
} from './strategy'

describe('createActiveResearchSafeInstallGate', () => {
  it('does not start update teardown while a data-root handoff owns the process', async () => {
    const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
    const restoreRenderer = vi.fn()
    const gate = createActiveResearchSafeInstallGate(
      () => [],
      teardown,
      () => true,
      restoreRenderer
    )

    await expect(gate()).resolves.toEqual({ completed: false, reaped: false })
    expect(teardown).not.toHaveBeenCalled()
    expect(restoreRenderer).not.toHaveBeenCalled()
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

  it('restores renderer preparation when the final update boundary refuses new work', async () => {
    let blockers: ReturnType<Parameters<typeof createActiveResearchSafeInstallGate>[0]> = []
    const teardown = vi.fn<InstallGate>().mockImplementation(async () => {
      blockers = ['delegated']
      return { completed: true, reaped: true }
    })
    const restoreRenderer = vi.fn()
    const gate = createActiveResearchSafeInstallGate(
      () => blockers,
      teardown,
      () => false,
      restoreRenderer
    )

    await expect(gate()).resolves.toMatchObject({ completed: false, reaped: false })
    expect(restoreRenderer).toHaveBeenCalledOnce()
  })
})

describe('createDataRootResearchSafeInstallGate', () => {
  it.each(['agent', 'delegated', 'notebook'] as const)(
    'does not teardown unconfirmed %s work',
    async (blocker) => {
      const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
      const gate = createDataRootResearchSafeInstallGate(() => [blocker], teardown)

      await expect(gate()).resolves.toEqual({
        completed: false,
        reaped: false,
        blockedBy: [blocker]
      })
      expect(teardown).not.toHaveBeenCalled()
    }
  )

  it.each(['agent', 'notebook'] as const)(
    'allows confirmed %s interruption for migration',
    async (blocker) => {
      const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
      const gate = createDataRootResearchSafeInstallGate(() => [blocker], teardown, true)

      await expect(gate()).resolves.toEqual({ completed: true, reaped: true })
      expect(teardown).toHaveBeenCalledOnce()
    }
  )

  it.each(['delegated', 'reviewer', 'settings-install'] as const)(
    'still refuses confirmed migration while %s work is active',
    async (blocker) => {
      const teardown = vi.fn<InstallGate>().mockResolvedValue({ completed: true, reaped: true })
      const gate = createDataRootResearchSafeInstallGate(() => [blocker], teardown, true)

      await expect(gate()).resolves.toEqual({
        completed: false,
        reaped: false,
        blockedBy: [blocker]
      })
      expect(teardown).not.toHaveBeenCalled()
    }
  )
})
