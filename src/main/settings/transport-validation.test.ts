import { describe, expect, it } from 'vitest'

import {
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readAppIconVariant,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readReasoningEffort
} from './transport-validation'

describe('Settings transport validation', () => {
  it('accepts only boolean notification preferences with the Electron error contract', () => {
    expect(readNotificationsEnabled({ enabled: false })).toBe(false)
    expect(() => readNotificationsEnabled({ enabled: 'yes' })).toThrow(
      'Invalid notifications-enabled flag: yes'
    )
    expect(() => readNotificationsEnabled(undefined)).toThrow(
      'Invalid notifications-enabled flag: undefined'
    )
  })

  it('accepts only known reasoning efforts with the Electron error contract', () => {
    expect(readReasoningEffort({ effort: 'high' })).toBe('high')
    expect(() => readReasoningEffort({ effort: 'ultra' })).toThrow(
      'Unknown reasoning effort: ultra'
    )
    expect(() => readReasoningEffort({ effort: 3 })).toThrow('Unknown reasoning effort: 3')
    expect(() => readReasoningEffort({})).toThrow('Unknown reasoning effort: undefined')
  })

  it('accepts only boolean conversation Skill import preferences', () => {
    expect(readConversationSkillImportEnabled({ enabled: true })).toBe(true)
    expect(() => readConversationSkillImportEnabled({ enabled: 'yes' })).toThrow(
      'Invalid conversation-skill-import-enabled flag: yes'
    )
    expect(() => readConversationSkillImportEnabled(null)).toThrow(
      'Invalid conversation-skill-import-enabled flag: undefined'
    )
  })

  it('accepts minimize, quit, or an omitted close preference', () => {
    expect(readClosePreference({ preference: 'minimize' })).toBe('minimize')
    expect(readClosePreference({ preference: 'quit' })).toBe('quit')
    expect(readClosePreference({})).toBeUndefined()
    expect(() => readClosePreference({ preference: 'close' })).toThrow(
      'Invalid close preference: close'
    )
  })

  it('accepts only known app icon variants with the Electron error contract', () => {
    expect(readAppIconVariant({ variant: 'dark' })).toBe('dark')
    expect(() => readAppIconVariant({ variant: 'sparkle' })).toThrow(
      'Unknown app icon variant: sparkle'
    )
    expect(() => readAppIconVariant({})).toThrow('Unknown app icon variant: undefined')
  })

  it('accepts only known default permission profiles', () => {
    expect(readDefaultPermissionProfile({ profile: 'auto' })).toBe('auto')
    expect(() => readDefaultPermissionProfile({ profile: 'always' })).toThrow(
      'Unknown default permission profile: always'
    )
    expect(() => readDefaultPermissionProfile({})).toThrow(
      'Unknown default permission profile: undefined'
    )
  })

  it('accepts only a string isolated Claude token', () => {
    expect(readIsolatedClaudeToken('sk-ant-test')).toBe('sk-ant-test')
    expect(() => readIsolatedClaudeToken(42)).toThrow('Claude sign-in token must be a string.')
    expect(() => readIsolatedClaudeToken(undefined)).toThrow(
      'Claude sign-in token must be a string.'
    )
  })
})
