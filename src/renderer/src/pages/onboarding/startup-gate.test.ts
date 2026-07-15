import { describe, expect, it } from 'vitest'

import { resolveStartupView, type StartupGateInput } from './startup-gate'

const input = (patch: Partial<StartupGateInput> = {}): StartupGateInput => ({
  onboardingDone: false,
  repairRequested: false,
  ...patch
})

describe('resolveStartupView', () => {
  it('always shows onboarding until the first-run flow is explicitly completed', () => {
    expect(resolveStartupView(input())).toBe('onboarding')
  })

  it('opens the app immediately for completed users without waiting for background checks', () => {
    expect(resolveStartupView(input({ onboardingDone: true }))).toBe('app')
  })

  it('opens repair only after a completed user explicitly requests it', () => {
    expect(resolveStartupView(input({ onboardingDone: true, repairRequested: true }))).toBe(
      'onboarding'
    )
  })
})
