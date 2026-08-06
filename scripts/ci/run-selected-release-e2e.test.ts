import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { releaseE2ECommand, selectReleaseSpecs } from './run-selected-release-e2e.mjs'

describe('selected release Electron E2E', () => {
  it('selects only journeys assigned to the current platform', () => {
    expect(
      selectReleaseSpecs(
        ['e2e_provider_bridge_linux', 'e2e_remote_pairing_linux', 'e2e_storage_migration_windows'],
        'linux'
      )
    ).toEqual([
      'e2e/certification/provider-bridge.spec.ts',
      'e2e/certification/remote-pairing.spec.ts'
    ])
  })

  it('returns no specs when no journey lane targets the platform', () => {
    expect(selectReleaseSpecs(['e2e_notebook_lifecycle_macos'], 'win32')).toEqual([])
  })

  it('fails closed on an unsupported platform', () => {
    expect(() => selectReleaseSpecs([], 'freebsd')).toThrow(
      'Unsupported Electron E2E platform: freebsd'
    )
  })

  it('launches the installed Playwright CLI directly through Node', () => {
    const spec = 'e2e/certification/provider-bridge.spec.ts'

    expect(releaseE2ECommand([spec])).toEqual({
      executable: process.execPath,
      args: [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', spec]
    })
  })
})
