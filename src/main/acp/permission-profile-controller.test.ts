import type { SessionModeState } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  PermissionProfileUnavailableError,
  applyCurrentModeUpdate,
  resolvePermissionProfileApplication
} from './permission-profile-controller'

const createModes = (
  ids: string[],
  currentModeId: string = ids[0] ?? 'default'
): SessionModeState => ({
  currentModeId,
  availableModes: ids.map((id) => ({ id, name: id }))
})

describe('permission profile controller', () => {
  describe('A03: native permission downgrade', () => {
    it.each(['ask', 'auto'] as const)(
      'rejects %s when the current native bypass has no advertised exit',
      (profile) => {
        expect(() =>
          resolvePermissionProfileApplication(profile, createModes(['bypassPermissions']))
        ).toThrow(PermissionProfileUnavailableError)
      }
    )

    it.each(['ask', 'auto'] as const)(
      'rejects %s from CodeBuddy fullAccess even with broker fallback enabled',
      (profile) => {
        expect(() =>
          resolvePermissionProfileApplication(profile, createModes(['fullAccess']), {
            fullAccessModeId: 'fullAccess',
            brokerEnforcesFullAccess: true
          })
        ).toThrow(PermissionProfileUnavailableError)
      }
    )

    it('rejects Ask from bypass when Auto is advertised but default is missing', () => {
      const modes = createModes(['auto', 'bypassPermissions'], 'bypassPermissions')
      expect(() => resolvePermissionProfileApplication('ask', modes)).toThrow(
        PermissionProfileUnavailableError
      )
    })

    it('can leave bypass through an advertised native Auto mode without default', () => {
      const modes = createModes(['auto', 'bypassPermissions'], 'bypassPermissions')
      expect(resolvePermissionProfileApplication('auto', modes)).toMatchObject({
        modeId: 'auto',
        state: { effectiveProfile: 'auto', currentModeId: 'auto', autoReviewStrategy: 'native' }
      })
    })

    // Preserve the existing fallback outside the confirmed native-bypass defect. These mapping
    // checks do not prove that an unknown provider delegates every permission to the broker.
    it.each([
      { label: 'null mode state', modes: null },
      { label: 'undefined mode state', modes: undefined },
      { label: 'unknown current mode', modes: createModes(['custom'], 'custom') }
    ])('preserves the existing fallback for $label', ({ modes }) => {
      for (const profile of ['ask', 'auto'] as const) {
        expect(resolvePermissionProfileApplication(profile, modes)).toMatchObject({
          modeId: undefined,
          state: {
            selectedProfile: profile,
            effectiveProfile: profile,
            currentModeId: modes?.currentModeId
          }
        })
      }
    })

    it('retains a known default posture even when it is absent from the mode catalog', () => {
      for (const profile of ['ask', 'auto'] as const) {
        expect(
          resolvePermissionProfileApplication(profile, createModes([], 'default'))
        ).toMatchObject({
          modeId: undefined,
          state: { selectedProfile: profile, effectiveProfile: profile, currentModeId: 'default' }
        })
      }
    })

    it('can leave an unknown mode using an advertised default', () => {
      for (const profile of ['ask', 'auto'] as const) {
        expect(
          resolvePermissionProfileApplication(profile, createModes(['default'], 'custom'))
        ).toMatchObject({
          modeId: 'default',
          state: { selectedProfile: profile, effectiveProfile: profile, currentModeId: 'default' }
        })
      }
    })

    it.each([null, undefined, createModes(['build', 'plan'])])(
      'retains app-enforced profiles when the framework guarantees broker enforcement (%j)',
      (modes) => {
        for (const profile of ['ask', 'auto', 'full'] as const) {
          expect(
            resolvePermissionProfileApplication(profile, modes, { brokerEnforcesFullAccess: true })
          ).toMatchObject({
            modeId: undefined,
            state: {
              selectedProfile: profile,
              effectiveProfile: profile,
              fullAccessAvailable: true
            }
          })
        }
      }
    )
  })

  it('maps Ask and native Auto to advertised ACP modes', () => {
    const modes = createModes(['default', 'auto', 'bypassPermissions'])

    expect(resolvePermissionProfileApplication('ask', modes)).toMatchObject({
      modeId: 'default',
      state: { selectedProfile: 'ask', currentModeId: 'default', fullAccessAvailable: true }
    })
    expect(resolvePermissionProfileApplication('auto', modes)).toMatchObject({
      modeId: 'auto',
      state: { selectedProfile: 'auto', autoReviewStrategy: 'native' }
    })
  })

  it('falls back to conservative review when native Auto is not advertised', () => {
    const application = resolvePermissionProfileApplication(
      'auto',
      createModes(['default', 'bypassPermissions'])
    )

    expect(application.modeId).toBe('default')
    expect(application.state.autoReviewStrategy).toBe('conservative')
    expect(application.state.message).toContain('auto-approve only clearly low-risk')
  })

  it('uses real bypass mode for Full access and rejects it when unavailable', () => {
    expect(
      resolvePermissionProfileApplication('full', createModes(['default', 'bypassPermissions']))
        .modeId
    ).toBe('bypassPermissions')

    expect(() => resolvePermissionProfileApplication('full', createModes(['default']))).toThrow(
      PermissionProfileUnavailableError
    )
  })

  it('offers broker-enforced Full access when the agent has no native bypass mode', () => {
    // opencode advertises build/plan, no bypassPermissions; the app owns the decision instead.
    const modes = createModes(['build', 'plan'])

    const application = resolvePermissionProfileApplication('full', modes, {
      brokerEnforcesFullAccess: true
    })

    // No native mode to set, but Full access is available and won't throw — the broker enforces it.
    expect(application.modeId).toBeUndefined()
    expect(application.state).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      fullAccessAvailable: true
    })
  })

  it('still rejects Full access when neither native bypass nor broker enforcement is available', () => {
    expect(() =>
      resolvePermissionProfileApplication('full', createModes(['build', 'plan']))
    ).toThrow(PermissionProfileUnavailableError)
  })

  it('keeps conservative Auto selected when the Agent reports default mode', () => {
    const state = resolvePermissionProfileApplication('auto', createModes(['default'])).state

    expect(applyCurrentModeUpdate(state, 'default')).toMatchObject({
      selectedProfile: 'auto',
      effectiveProfile: 'auto',
      currentModeId: 'default',
      autoReviewStrategy: 'conservative'
    })
  })

  it('recognizes a framework-specific full access mode update', () => {
    const state = resolvePermissionProfileApplication(
      'ask',
      createModes(['default', 'fullAccess'])
    ).state

    expect(
      applyCurrentModeUpdate(state, 'fullAccess', { fullAccessModeId: 'fullAccess' })
    ).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId: 'fullAccess'
    })
  })
})
