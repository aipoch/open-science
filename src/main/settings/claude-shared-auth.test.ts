import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeSharedAuthController } from './claude-shared-auth'

// Mock node:child_process so tests can script the subprocess without launching anything.
const spawnCalls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
let nextSpawn: (() => FakeChild) | undefined

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, env: options?.env })
    return (nextSpawn ?? (() => new FakeChild()))()
  }
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

const scriptChild = (stdout: string, stderr: string, code: number): (() => FakeChild) => () => {
  const child = new FakeChild()
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', code)
  })
  return child
}

const makeController = (
  claudePath: string | (() => string | Promise<string>) = 'claude',
  opts?: { loginTimeoutMs?: number; statusTimeoutMs?: number }
): ClaudeSharedAuthController => new ClaudeSharedAuthController({ claudePath, ...opts })

beforeEach(() => {
  spawnCalls.length = 0
  nextSpawn = undefined
})

describe('ClaudeSharedAuthController.getStatus', () => {
  it('reads loggedIn (not authenticated) from the CLI JSON output', async () => {
    nextSpawn = scriptChild('{"loggedIn":true,"authMethod":"oauth_token"}', '', 0)
    const ctrl = makeController()
    await expect(ctrl.getStatus()).resolves.toEqual({ supported: true, authenticated: true })
    expect(spawnCalls[0]?.args).toEqual(['auth', 'status', '--json'])
  })

  it('reports signed out when loggedIn is false', async () => {
    nextSpawn = scriptChild('{"loggedIn":false}', '', 0)
    const ctrl = makeController()
    await expect(ctrl.getStatus()).resolves.toMatchObject({ supported: true, authenticated: false })
  })

  it('treats a non-zero exit as not signed in and surfaces stderr', async () => {
    nextSpawn = scriptChild('', 'Error: daemon not running', 1)
    const ctrl = makeController()
    const result = await ctrl.getStatus()
    expect(result.authenticated).toBe(false)
    expect(result.message).toContain('daemon not running')
  })

  it('surfaces a parse failure without crashing', async () => {
    nextSpawn = scriptChild('not json', '', 0)
    const ctrl = makeController()
    const result = await ctrl.getStatus()
    expect(result.authenticated).toBe(false)
    expect(result.message).toMatch(/parse/i)
  })

  it('surfaces a timeout without hanging', async () => {
    // A child that never emits close — triggers the timeout.
    nextSpawn = () => new FakeChild()
    const ctrl = makeController('claude', { statusTimeoutMs: 50 })
    const result = await ctrl.getStatus()
    expect(result.authenticated).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('resolves the path lazily for each call', async () => {
    let calls = 0
    nextSpawn = scriptChild('{"loggedIn":true}', '', 0)
    const ctrl = makeController(() => {
      calls++
      return 'my-claude'
    })
    await ctrl.getStatus()
    expect(calls).toBe(1)
    expect(spawnCalls[0]?.command).toBe('my-claude')
  })
})

describe('ClaudeSharedAuthController.loginShared', () => {
  it('returns authenticated:true when the CLI exits 0', async () => {
    nextSpawn = scriptChild('', '', 0)
    const ctrl = makeController()
    await expect(ctrl.loginShared()).resolves.toMatchObject({ supported: true, authenticated: true })
    expect(spawnCalls[0]?.args).toEqual(['auth', 'login', '--claudeai'])
  })

  it('returns authenticated:false and surfaces stderr on non-zero exit', async () => {
    nextSpawn = scriptChild('', 'OAuth failed', 1)
    const ctrl = makeController()
    const result = await ctrl.loginShared()
    expect(result.authenticated).toBe(false)
    expect(result.message).toContain('OAuth failed')
  })

  it('refuses a second concurrent login with a clear message', async () => {
    // First login never closes — stays in flight.
    nextSpawn = () => new FakeChild()
    const ctrl = makeController()
    const first = ctrl.loginShared() // in flight

    const second = await ctrl.loginShared()
    expect(second.authenticated).toBe(false)
    expect(second.message).toMatch(/already in progress/i)

    // Clean up: cancel the first one.
    ctrl.cancelLogin()
    await first
  })

  it('respects a timeout', async () => {
    nextSpawn = () => new FakeChild()
    const ctrl = makeController('claude', { loginTimeoutMs: 50 })
    const result = await ctrl.loginShared()
    expect(result.authenticated).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('uses the lazy path resolver', async () => {
    nextSpawn = scriptChild('', '', 0)
    const ctrl = makeController(async () => '/resolved/claude')
    await ctrl.loginShared()
    expect(spawnCalls[0]?.command).toBe('/resolved/claude')
  })
})

describe('ClaudeSharedAuthController.cancelLogin', () => {
  it('aborts an in-flight login and returns a cancelled result', async () => {
    nextSpawn = () => new FakeChild() // never closes
    const ctrl = makeController()
    const pending = ctrl.loginShared()
    ctrl.cancelLogin()
    const result = await pending
    expect(result.authenticated).toBe(false)
    expect(result.message).not.toMatch(/timed out/)
  })

  it('is a no-op when no login is in flight', () => {
    const ctrl = makeController()
    expect(() => ctrl.cancelLogin()).not.toThrow()
  })
})

describe('ClaudeSharedAuthController.logoutShared', () => {
  it('returns authenticated:false on successful logout', async () => {
    nextSpawn = scriptChild('', '', 0)
    const ctrl = makeController()
    await expect(ctrl.logoutShared()).resolves.toMatchObject({
      supported: true,
      authenticated: false
    })
    expect(spawnCalls[0]?.args).toEqual(['auth', 'logout'])
  })

  it('surfaces the error message on a failed logout', async () => {
    nextSpawn = scriptChild('', 'keychain locked', 1)
    const ctrl = makeController()
    const result = await ctrl.logoutShared()
    expect(result.authenticated).toBe(false)
    expect(result.message).toContain('keychain locked')
  })

  it('uses the lazy path resolver', async () => {
    nextSpawn = scriptChild('', '', 0)
    const ctrl = makeController(() => '/abs/claude')
    await ctrl.logoutShared()
    expect(spawnCalls[0]?.command).toBe('/abs/claude')
  })
})
