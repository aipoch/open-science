import { describe, expect, it } from 'vitest'

import {
  resolveStartupView,
  shouldMarkOnboardingComplete,
  type StartupGateInput
} from './startup-gate'

const input = (patch: Partial<StartupGateInput> = {}): StartupGateInput => ({
  hasEnteredApp: false,
  onboardingDone: false,
  claudeReady: false,
  activeProviderReady: false,
  ...patch
})

describe('resolveStartupView', () => {
  it('shows onboarding only on a true first run (never entered, not done, config invalid)', () => {
    expect(resolveStartupView(input())).toBe('onboarding')
    expect(resolveStartupView(input({ claudeReady: true }))).toBe('onboarding')
  })

  it('auto-completes: not done but config already valid → app', () => {
    expect(resolveStartupView(input({ claudeReady: true, activeProviderReady: true }))).toBe('app')
  })

  it('Q3 never re-shows: onboarding done → app even when config looks broken', () => {
    expect(resolveStartupView(input({ onboardingDone: true }))).toBe('app')
    expect(resolveStartupView(input({ onboardingDone: true, claudeReady: true }))).toBe('app')
  })

  it('session latch wins: hasEnteredApp → app regardless of the other gates', () => {
    expect(resolveStartupView(input({ hasEnteredApp: true }))).toBe('app')
  })
})

describe('shouldMarkOnboardingComplete', () => {
  it('is true only when not done and config is already valid', () => {
    expect(
      shouldMarkOnboardingComplete(input({ claudeReady: true, activeProviderReady: true }))
    ).toBe(true)
    expect(shouldMarkOnboardingComplete(input({ claudeReady: true }))).toBe(false)
    expect(
      shouldMarkOnboardingComplete(
        input({ onboardingDone: true, claudeReady: true, activeProviderReady: true })
      )
    ).toBe(false)
  })
})
