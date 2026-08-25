import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_WEB_PORT, MARKER, buildNativeSendNowLaunch } from './dev-native-send-now.cjs'

const fixtureRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'os-native-send-now-'))
  mkdirSync(join(root, 'src', 'main', 'acp'), { recursive: true })
  writeFileSync(join(root, MARKER), '')
  mkdirSync(join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), {
    recursive: true
  })
  writeFileSync(
    join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'),
    '{"version":"0.70.0"}\n'
  )
  return root
}

describe('buildNativeSendNowLaunch', () => {
  it('refuses a tree without the native follow-up module', () => {
    const root = mkdtempSync(join(tmpdir(), 'os-native-send-now-missing-'))
    expect(() => buildNativeSendNowLaunch(root, {})).toThrow(
      /only for the native-send-now worktree/
    )
  })

  it('isolates port, storage, userData, and the multi-instance flag', () => {
    const root = fixtureRoot()
    const { command, args, env, identity } = buildNativeSendNowLaunch(root, {})
    expect(command).toBe('npx')
    expect(args).toEqual(['electron-vite', 'dev'])
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe(DEFAULT_WEB_PORT)
    expect(env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE).toBe('1')
    expect(env.OPEN_SCIENCE_STORAGE_ROOT).toBe(join(root, '.dev-isolate', 'storage'))
    expect(env.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBe(env.OPEN_SCIENCE_STORAGE_ROOT)
    expect(env.OPEN_SCIENCE_USER_DATA).toBe(join(root, '.dev-isolate', 'electron-user-data'))
    expect(identity.claudeAgentAcp).toBe('0.70.0')
    expect(identity.port).toBe(DEFAULT_WEB_PORT)
  })

  it('keeps an explicit web port', () => {
    const root = fixtureRoot()
    const { env } = buildNativeSendNowLaunch(root, { OPEN_SCIENCE_WEB_PORT: '44111' })
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe('44111')
  })
})
