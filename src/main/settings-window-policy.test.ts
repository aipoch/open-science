import { describe, expect, it } from 'vitest'
import { settingsReceivesEvent } from './settings-window-policy'
import { isSettingsWindowRequest, isSettingsWorkspaceNavigation } from '../shared/settings-window'
describe('settings window boundary', () => {
  it('does not project transcript, agent or quit-flush events into settings', () => {
    for (const channel of [
      'acp:event',
      'acp:state',
      'session:updated',
      'sessions:flush-request',
      'review:update'
    ])
      expect(settingsReceivesEvent(channel)).toBe(false)
    expect(settingsReceivesEvent('settings:changed')).toBe(true)
    expect(settingsReceivesEvent('permissions:changed')).toBe(true)
  })
  it('rejects unsupported routes, arbitrary workspace methods and oversized payloads', () => {
    expect(isSettingsWindowRequest({ route: { panel: 'general' } })).toBe(true)
    expect(isSettingsWindowRequest({ route: { panel: 'execute' } })).toBe(false)
    expect(isSettingsWorkspaceNavigation({ method: 'setState', args: [] })).toBe(false)
    expect(
      isSettingsWorkspaceNavigation({ method: 'openProject', args: ['x'.repeat(65536)] })
    ).toBe(false)
  })
})
