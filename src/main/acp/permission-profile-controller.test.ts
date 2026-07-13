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

  it('keeps conservative Auto selected when the Agent reports default mode', () => {
    const state = resolvePermissionProfileApplication('auto', createModes(['default'])).state

    expect(applyCurrentModeUpdate(state, 'default')).toMatchObject({
      selectedProfile: 'auto',
      effectiveProfile: 'auto',
      currentModeId: 'default',
      autoReviewStrategy: 'conservative'
    })
  })
})
