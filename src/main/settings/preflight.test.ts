import { describe, expect, it } from 'vitest'

import { computePreflight } from './preflight'
import type { StoredProvider, StoredSettings } from './types'

const customProvider: StoredProvider = {
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  keyRef: 'enc:abc',
  lastValidatedAt: 100
}

const baseSettings = (overrides: Partial<StoredSettings> = {}): StoredSettings => ({
  version: 1,
  claude: { resolvedPath: '/bin/claude' },
  providers: [customProvider],
  activeProviderId: 'p1',
  ...overrides
})

const alwaysUsable = (): boolean => true

describe('computePreflight', () => {
  it('is fully ready when claude exists and the active provider validated with a usable key', () => {
    expect(
      computePreflight({
        settings: baseSettings(),
        claudePathExists: true,
        isProviderKeyUsable: alwaysUsable
      })
    ).toEqual({ claudeReady: true, activeProviderReady: true })
  })

  it('is not claude-ready when the recorded path no longer exists', () => {
    const result = computePreflight({
      settings: baseSettings(),
      claudePathExists: false,
      isProviderKeyUsable: alwaysUsable
    })

    expect(result.claudeReady).toBe(false)
  })

  it('is not claude-ready when no path was ever recorded', () => {
    const result = computePreflight({
      settings: baseSettings({ claude: {} }),
      claudePathExists: false,
      isProviderKeyUsable: alwaysUsable
    })

    expect(result.claudeReady).toBe(false)
  })

  it('is not provider-ready without an active provider', () => {
    const result = computePreflight({
      settings: baseSettings({ activeProviderId: undefined }),
      claudePathExists: true,
      isProviderKeyUsable: alwaysUsable
    })

    expect(result.activeProviderReady).toBe(false)
  })

  it('is not provider-ready when the active provider never validated', () => {
    const result = computePreflight({
      settings: baseSettings({ providers: [{ ...customProvider, lastValidatedAt: undefined }] }),
      claudePathExists: true,
      isProviderKeyUsable: alwaysUsable
    })

    expect(result.activeProviderReady).toBe(false)
  })

  it('is not provider-ready when the active provider key is unusable', () => {
    const result = computePreflight({
      settings: baseSettings(),
      claudePathExists: true,
      isProviderKeyUsable: () => false
    })

    expect(result.activeProviderReady).toBe(false)
  })
})
