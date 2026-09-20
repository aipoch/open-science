import { describe, expect, it } from 'vitest'

import { SettingsInstallCoordinator } from './settings-install-coordinator'

describe('SettingsInstallCoordinator', () => {
  it('admits only one Settings installation until its lease is released', () => {
    const coordinator = new SettingsInstallCoordinator()

    const runtimeInstall = coordinator.tryAcquire('runtime-install')

    expect(runtimeInstall).toBeDefined()
    expect(coordinator.getActiveId()).toBe('runtime-install')
    expect(coordinator.tryAcquire('wsl-install')).toBeUndefined()

    runtimeInstall?.release()

    expect(coordinator.getActiveId()).toBeUndefined()
    expect(coordinator.tryAcquire('wsl-install')).toBeDefined()
  })

  it('keeps installation admission closed until every holder releases it', () => {
    const coordinator = new SettingsInstallCoordinator()
    const releaseUpdate = coordinator.holdAdmission()
    const releaseDataMove = coordinator.holdAdmission()

    releaseUpdate()
    expect(coordinator.tryAcquire('wsl-install')).toBeUndefined()

    releaseDataMove()
    expect(coordinator.tryAcquire('wsl-install')).toBeDefined()
  })
})
