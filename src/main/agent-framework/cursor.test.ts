import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { cursorFramework, cursorStorageDir } from './cursor'

describe('cursorFramework', () => {
  it('exposes conservative capability flags for the first Cursor backend', () => {
    expect(cursorFramework.id).toBe('cursor')
    expect(cursorFramework.displayName).toBe('Cursor Agent')
    expect(cursorFramework.supportsSkills).toBe(false)
    expect(cursorFramework.acceptsStdioMcp).toBe(false)
    expect(cursorFramework.supportsLiveEffortChange).toBe(false)
    expect(cursorFramework.supportedApiTypes).toEqual([])
    expect(cursorFramework.contextCompaction).toEqual({ kind: 'framework-managed' })
  })

  it('authenticates Cursor subscription providers via cursor_login', () => {
    const config = cursorFramework.prepareModelConfig(
      { type: 'cursor-subscription', model: 'composer-2.5' },
      { storageRoot: '/data', executablePath: '/bin/agent' }
    )

    expect(config.authentication).toEqual({ methodId: 'cursor_login' })
    expect(config.sessionModel).toBe('composer-2.5')
    expect(config.env).toBeUndefined()
  })

  it('returns an empty model config for non-subscription providers', () => {
    const config = cursorFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://example', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/agent' }
    )

    expect(config).toEqual({})
  })

  it('delivers system-prompt appends as a prompt prefix', () => {
    const setup = cursorFramework.buildSessionSetup({
      systemPromptAppends: ['Use write_artifact_file for outputs.']
    })

    expect(setup.promptPrefix).toContain('mcp__open_science_artifacts__write_artifact_file')
    expect(setup.meta).toBeUndefined()
  })

  it('maps permission profiles onto Cursor agent/ask modes with broker full access', () => {
    const modes = {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' }
      ]
    }

    expect(cursorFramework.mapPermissionProfile('ask', modes).modeId).toBe('ask')
    expect(cursorFramework.mapPermissionProfile('auto', modes).modeId).toBe('agent')
    expect(cursorFramework.mapPermissionProfile('full', modes).modeId).toBe('agent')
    expect(cursorFramework.mapPermissionProfile('full', modes).state.fullAccessAvailable).toBe(true)
  })

  it('falls back safely when an older Cursor build advertises model ids as modes', () => {
    const legacyModes = {
      currentModeId: 'composer-2.5',
      availableModes: [
        { id: 'composer-2.5', name: 'Composer 2.5' },
        { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet' }
      ]
    }

    expect(cursorFramework.mapPermissionProfile('ask', legacyModes).modeId).toBeUndefined()
    expect(cursorFramework.mapPermissionProfile('auto', legacyModes).modeId).toBeUndefined()
    expect(cursorFramework.mapPermissionProfile('full', legacyModes).modeId).toBeUndefined()
    expect(
      cursorFramework.mapPermissionProfile('full', legacyModes).state.fullAccessAvailable
    ).toBe(true)
  })

  it('keeps the Cursor storage root under the app data tree', () => {
    expect(cursorStorageDir('/data')).toBe(join('/data', 'cursor'))
  })
})
