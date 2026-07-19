import { describe, expect, it } from 'vitest'

import { computePreflight, type PreflightInput } from './preflight'
import type { StoredProvider, StoredSettings } from './types'

const customProvider: StoredProvider = {
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  keyRef: 'enc:abc',
  lastValidatedAt: 100
}

const baseSettings = (overrides: Partial<StoredSettings> = {}): StoredSettings => ({
  version: 2,
  claude: { resolvedPath: '/bin/claude' },
  providers: [customProvider],
  activeProviderId: 'p1',
  ...overrides
})

const alwaysUsable = (): boolean => true

// Fills the injected checks with permissive defaults so each case overrides only what it exercises.
const run = (overrides: Partial<PreflightInput> = {}): ReturnType<typeof computePreflight> =>
  computePreflight({
    settings: baseSettings(),
    claudePathExists: true,
    opencodePathExists: false,
    codexPathExists: false,
    agentFrameworkId: 'claude-code',
    isProviderKeyUsable: alwaysUsable,
    activeProviderCompatible: true,
    ...overrides
  })

describe('computePreflight', () => {
  it('is fully ready when claude exists and the active provider validated with a usable key', () => {
    expect(run()).toEqual({
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: true
    })
  })

  it('is not claude-ready when the recorded path no longer exists', () => {
    expect(run({ claudePathExists: false }).claudeReady).toBe(false)
  })

  it('is not claude-ready when no path was ever recorded', () => {
    expect(
      run({ settings: baseSettings({ claude: {} }), claudePathExists: false }).claudeReady
    ).toBe(false)
  })

  it('tracks opencode readiness from its own stored path', () => {
    const settings = baseSettings({ opencodePath: '/bin/opencode' })

    expect(run({ settings, opencodePathExists: true }).opencodeReady).toBe(true)
    // A binary deleted after onboarding flips opencode back to unready.
    expect(run({ settings, opencodePathExists: false }).opencodeReady).toBe(false)
  })

  it('binds agentReady to the selected framework', () => {
    const settings = baseSettings({ opencodePath: '/bin/opencode' })

    // Selecting opencode makes agentReady follow opencode, even though claude is present.
    expect(
      run({
        settings,
        agentFrameworkId: 'opencode',
        claudePathExists: true,
        opencodePathExists: false
      })
    ).toMatchObject({ agentFrameworkId: 'opencode', agentReady: false, claudeReady: true })

    expect(run({ settings, agentFrameworkId: 'opencode', opencodePathExists: true })).toMatchObject(
      { agentReady: true }
    )
  })

  it('tracks Codex readiness and binds agentReady to Codex when selected', () => {
    const settings = baseSettings({ codex: { resolvedPath: '/bin/codex-acp' } })

    expect(run({ settings, agentFrameworkId: 'codex', codexPathExists: true })).toMatchObject({
      codexReady: true,
      agentReady: true
    })
    expect(run({ settings, agentFrameworkId: 'codex', codexPathExists: false })).toMatchObject({
      codexReady: false,
      agentReady: false
    })
  })

  it('is not provider-ready without an active provider', () => {
    expect(
      run({ settings: baseSettings({ activeProviderId: undefined }) }).activeProviderReady
    ).toBe(false)
  })

  it('is not provider-ready when the active provider never validated', () => {
    const settings = baseSettings({
      providers: [{ ...customProvider, lastValidatedAt: undefined }]
    })

    expect(run({ settings }).activeProviderReady).toBe(false)
  })

  it('is not provider-ready when the latest validation failed after an earlier success', () => {
    const settings = baseSettings({
      providers: [
        {
          ...customProvider,
          lastValidatedAt: 100,
          lastValidationFailure: { at: 200, category: 'auth' }
        }
      ]
    })

    expect(run({ settings }).activeProviderReady).toBe(false)
  })

  it('is not provider-ready when the active provider key is unusable', () => {
    expect(run({ isProviderKeyUsable: () => false }).activeProviderReady).toBe(false)
  })

  it('is not provider-ready when the active provider is incompatible with the framework', () => {
    // e.g. OpenCode selected but the active provider is a Local Claude — validated + usable key, yet
    // unusable by the framework, so the pair must not be marked ready.
    expect(run({ activeProviderCompatible: false }).activeProviderReady).toBe(false)
  })
})
