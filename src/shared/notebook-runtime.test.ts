import { describe, expect, it } from 'vitest'

import type { DiscoveredInterpreter, EnvProvenance, RuntimeEnablement } from './notebook-runtime'
import { isEnvEnabled } from './notebook-runtime'

const env = (provenance: EnvProvenance, envId = '/env'): DiscoveredInterpreter => ({
  language: 'python',
  provenance,
  envId,
  interpreterPath: envId,
  label: envId,
  runnable: true
})

describe('isEnvEnabled', () => {
  it('defaults app-managed and agent-created ON, only user-own OFF, with no explicit override', () => {
    // App-managed + agent-created are app-controlled and default enabled (the agent must be able to
    // bind an env it just created); only the user's OWN interpreters require an explicit opt-in.
    expect(isEnvEnabled(env('app-managed'))).toBe(true)
    expect(isEnvEnabled(env('agent-created'))).toBe(true)
    expect(isEnvEnabled(env('user-own'))).toBe(false)
  })

  it('applies the provenance default when the enablement map has no entry for the env', () => {
    const enablement: RuntimeEnablement = { enabled: { '/other': true }, installAuthorized: {} }
    expect(isEnvEnabled(env('app-managed', '/env'), enablement)).toBe(true)
    expect(isEnvEnabled(env('user-own', '/env'), enablement)).toBe(false)
  })

  it('lets an explicit override win over the provenance default in both directions', () => {
    const disableManaged: RuntimeEnablement = { enabled: { '/env': false }, installAuthorized: {} }
    const enableUserOwn: RuntimeEnablement = { enabled: { '/env': true }, installAuthorized: {} }
    expect(isEnvEnabled(env('app-managed', '/env'), disableManaged)).toBe(false)
    expect(isEnvEnabled(env('user-own', '/env'), enableUserOwn)).toBe(true)
  })
})
