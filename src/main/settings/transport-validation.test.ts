import { describe, expect, it } from 'vitest'

import {
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readAppIconVariant,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readProjectFilesFilter,
  readReasoningEffort,
  readReviewerModel,
  readSessionDetailsModel,
  readSubagentModel
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

  it('accepts only complete atomic Subagent model configurations', () => {
    expect(readSubagentModel({ configuration: { mode: 'inherit' } })).toEqual({ mode: 'inherit' })
    expect(
      readSubagentModel({
        configuration: {
          mode: 'fixed',
          providerId: 'provider-a',
          model: 'model-a',
          reasoningEffort: 'high'
        }
      })
    ).toEqual({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high'
    })
    expect(() =>
      readSubagentModel({
        configuration: { mode: 'fixed', providerId: '', model: 'model-a', reasoningEffort: 'high' }
      })
    ).toThrow('Invalid Subagent model configuration.')
    expect(() =>
      readSubagentModel({
        configuration: {
          mode: 'fixed',
          providerId: 'provider-a',
          model: 'model-a',
          reasoningEffort: 'ultra'
        }
      })
    ).toThrow('Invalid Subagent model configuration.')
    expect(() =>
      readSubagentModel({ configuration: { mode: 'inherit', providerId: 'stale' } })
    ).toThrow('Invalid Subagent model configuration.')
  })

  it('accepts only complete atomic Reviewer model configurations', () => {
    expect(
      readReviewerModel({
        configuration: {
          mode: 'fixed',
          providerId: 'provider-a',
          model: 'reviewer-model',
          reasoningEffort: 'max'
        }
      })
    ).toEqual({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'reviewer-model',
      reasoningEffort: 'max'
    })
    expect(() => readReviewerModel({ configuration: { mode: 'fixed' } })).toThrow(
      'Invalid Reviewer model configuration.'
    )
  })

  it('accepts the three Session details policies and requires independent inherited effort', () => {
    expect(
      readSessionDetailsModel({
        configuration: { mode: 'inherit', reasoningEffort: 'low' }
      })
    ).toEqual({ mode: 'inherit', reasoningEffort: 'low' })
    expect(readSessionDetailsModel({ configuration: { mode: 'disabled' } })).toEqual({
      mode: 'disabled'
    })
    expect(() => readSessionDetailsModel({ configuration: { mode: 'inherit' } })).toThrow(
      'Invalid Session details model configuration.'
    )
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

  it('accepts a well-shaped project files filter and rejects the rest', () => {
    expect(readProjectFilesFilter({})).toBeUndefined()
    expect(readProjectFilesFilter({ filter: { sourceMode: 'local' } })).toEqual({
      sourceMode: 'local'
    })
    expect(
      readProjectFilesFilter({
        filter: { sourceMode: 'local', localRootId: 'root-1' }
      })
    ).toEqual({ sourceMode: 'local', localRootId: 'root-1' })
    expect(
      readProjectFilesFilter({ filter: { sourceMode: 'artifacts', optionId: 'uploads' } })
    ).toEqual({ sourceMode: 'artifacts', optionId: 'uploads' })
    expect(() => readProjectFilesFilter({ filter: 'local' })).toThrow(
      'Invalid project files filter: local'
    )
    expect(() => readProjectFilesFilter({ filter: { sourceMode: 'remote' } })).toThrow(
      'Invalid project files filter source: remote'
    )
    expect(() =>
      readProjectFilesFilter({ filter: { sourceMode: 'local', localRootId: 7 } })
    ).toThrow('Invalid project files filter root: 7')
    expect(() =>
      readProjectFilesFilter({ filter: { sourceMode: 'artifacts', optionId: 7 } })
    ).toThrow('Invalid project files filter option: 7')
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

  it('rejects an isolated Claude token larger than 16 KiB in UTF-8', () => {
    expect(() => readIsolatedClaudeToken('é'.repeat(8_193))).toThrow(
      'Claude sign-in token must not exceed 16384 bytes.'
    )
  })
})
