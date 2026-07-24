import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeIsolatedAuthController, type ClaudeIsolatedTokenStore } from './claude-isolated-auth'

// The browser flow spawns `claude setup-token`; mock node:child_process so tests can script the
// subprocess's stdout/stderr/exit without launching anything. Each test sets `nextSpawn` to the
// child it wants the next spawn() call to return.
const spawnCalls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
let nextSpawn: (() => FakeChild) | undefined

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, env: options?.env })
    return (nextSpawn ?? (() => new FakeChild()))()
  }
}))

// Minimal fake child process exposing the stdout/stderr/close surface the controller consumes.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

// Returns a child that emits the given stdout/stderr then closes with `code` on the next tick, so the
// controller's listeners are attached before the events fire.
const scriptChild =
  (stdout: string, stderr: string, code: number): (() => FakeChild) =>
  () => {
    const child = new FakeChild()
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', code)
    })
    return child
  }

// A controllable token store so each test can script load/save/clear outcomes without touching
// safeStorage or the repository. Mirrors the shape the SettingsService passes in service.ts. The
// default saveToken also records the token so a follow-up loadToken (the post-save roundtrip the
// controller uses to distinguish a successful save from a corrupted one) reads the same value back.
const createStore = (
  overrides: Partial<ClaudeIsolatedTokenStore> = {}
): ClaudeIsolatedTokenStore & {
  saveCalls: string[]
  clearCalls: { count: number }
} => {
  const saveCalls: string[] = []
  const clearCalls = { count: 0 }
  const stored: { current: string | undefined } = { current: undefined }

  const base: ClaudeIsolatedTokenStore = {
    loadToken: async () => stored.current,
    saveToken: async (token) => {
      saveCalls.push(token)
      stored.current = token
    },
    clearToken: async () => {
      clearCalls.count += 1
      stored.current = undefined
    },
    isEncryptionAvailable: () => true
  }

  const store: ClaudeIsolatedTokenStore & {
    saveCalls: string[]
    clearCalls: { count: number }
  } = Object.assign(base, overrides, { saveCalls, clearCalls })

  return store
}

describe('ClaudeIsolatedAuthController', () => {
  it('reports authenticated: true when the stored token decrypts', async () => {
    const store = createStore({ loadToken: async () => 'sk-ant-decrypted' })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.getStatus()).resolves.toEqual({
      supported: true,
      authenticated: true
    })
  })

  it('reports authenticated: false with no message when no token is stored', async () => {
    const store = createStore({ loadToken: async () => undefined })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.getStatus()).resolves.toEqual({
      supported: true,
      authenticated: false
    })
  })

  it('surfaces a load failure as the dedicated message rather than throwing', async () => {
    const store = createStore({
      loadToken: async () => {
        throw new Error('Stored Claude token could not be decrypted.')
      }
    })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.getStatus()).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'Stored Claude token could not be decrypted.'
    })
  })

  it('rejects an empty / whitespace token without persisting', async () => {
    const store = createStore()
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('   ')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'Paste the token printed by `claude setup-token`.'
    })
    expect(store.saveCalls).toHaveLength(0)
  })

  it('refuses to save when encryption is unavailable', async () => {
    const store = createStore({ isEncryptionAvailable: () => false })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('sk-ant-token')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    })
    expect(store.saveCalls).toHaveLength(0)
  })

  it('persists a trimmed token and reports authenticated', async () => {
    const store = createStore()
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('  sk-ant-pasted  ')).resolves.toEqual({
      supported: true,
      authenticated: true
    })
    expect(store.saveCalls).toEqual(['sk-ant-pasted'])
  })

  it('rejects a save whose post-write load returns undefined (corrupted store)', async () => {
    // Roundtrip check: even when saveToken "succeeds", a follow-up load that returns nothing means
    // the encrypted store lost the entry between the two calls — masquerading as authenticated would
    // leave the user looking at a green check for a credential Claude cannot carry. The malformed
    // message is what the card surfaces.
    const store = createStore({ loadToken: async () => undefined })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('sk-ant-pasted')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'Saved token could not be re-read. Retry the paste.'
    })
  })

  it('rejects a save whose post-write load returns a different value (corrupted store)', async () => {
    // A save that roundtrips to a *different* value indicates the encrypted store is no longer
    // faithful — treat the same as no token rather than a successful paste.
    const store = createStore({ loadToken: async () => 'something-else' })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('sk-ant-pasted')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'Saved token did not roundtrip cleanly. Retry the paste.'
    })
  })

  it('surfaces a re-read failure (thrown load) as a dedicated error rather than authenticated', async () => {
    const store = createStore({
      loadToken: vi.fn(async () => {
        throw new Error('keychain read failed')
      })
    })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('sk-ant-pasted')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'keychain read failed'
    })
  })

  it('surfaces save failures without throwing', async () => {
    const store = createStore({
      saveToken: vi.fn(async () => {
        throw new Error('keychain write failed')
      })
    })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.loginIsolated('sk-ant-token')).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'keychain write failed'
    })
  })

  it('clears the stored token on logout', async () => {
    const store = createStore()
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.logoutIsolated()).resolves.toEqual({
      supported: true,
      authenticated: false
    })
    expect(store.clearCalls.count).toBe(1)
  })

  it('surfaces a clear failure as the dedicated message', async () => {
    const store = createStore({
      clearToken: vi.fn(async () => {
        throw new Error('keychain delete failed')
      })
    })
    const controller = new ClaudeIsolatedAuthController({ store })

    await expect(controller.logoutIsolated()).resolves.toEqual({
      supported: true,
      authenticated: false,
      message: 'keychain delete failed'
    })
  })

  it('cancelLogin is a no-op when no browser sign-in is in flight', () => {
    const store = createStore()
    const controller = new ClaudeIsolatedAuthController({ store })

    expect(() => controller.cancelLogin()).not.toThrow()
    expect(store.saveCalls).toHaveLength(0)
    expect(store.clearCalls.count).toBe(0)
  })

  describe('loginIsolatedBrowser', () => {
    beforeEach(() => {
      spawnCalls.length = 0
      nextSpawn = undefined
    })

    it('reports unavailable when the claude path is not configured', async () => {
      const store = createStore()
      const controller = new ClaudeIsolatedAuthController({ store })

      await expect(controller.loginIsolatedBrowser()).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'Browser sign-in is unavailable: the Claude executable was not found.'
      })
      expect(spawnCalls).toHaveLength(0)
    })

    it('refuses to run when encryption is unavailable', async () => {
      const store = createStore({ isEncryptionAvailable: () => false })
      const controller = new ClaudeIsolatedAuthController({
        store,
        claudePath: 'claude',
        configDir: '/tmp/app-claude'
      })

      await expect(controller.loginIsolatedBrowser()).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
      })
      expect(spawnCalls).toHaveLength(0)
    })

    it('runs setup-token under the isolated config dir and stores the captured token', async () => {
      const store = createStore()
      const controller = new ClaudeIsolatedAuthController({
        store,
        claudePath: '/usr/bin/claude',
        configDir: '/tmp/app-claude'
      })
      nextSpawn = scriptChild('Success! Here is your token:\nsk-ant-oat01-abc123\n', '', 0)

      await expect(controller.loginIsolatedBrowser()).resolves.toEqual({
        supported: true,
        authenticated: true
      })
      expect(store.saveCalls).toEqual(['sk-ant-oat01-abc123'])
      expect(spawnCalls[0]?.command).toBe('/usr/bin/claude')
      expect(spawnCalls[0]?.args).toEqual(['setup-token'])
      expect(spawnCalls[0]?.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/app-claude')
    })

    it('runs a resolved JavaScript CLI through Electron in Node mode', async () => {
      const controller = new ClaudeIsolatedAuthController({
        store: createStore(),
        claudePath: '/resolved/cli.js',
        configDir: '/tmp/app-claude'
      })
      nextSpawn = scriptChild('sk-ant-oat01-abc123\n', '', 0)

      await controller.loginIsolatedBrowser()

      expect(spawnCalls[0]).toMatchObject({
        command: process.execPath,
        args: ['/resolved/cli.js', 'setup-token'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      })
    })

    it('returns a structured failure when the path resolver rejects', async () => {
      const controller = new ClaudeIsolatedAuthController({
        store: createStore(),
        claudePath: () => Promise.reject(new Error('Claude path unavailable')),
        configDir: '/tmp/app-claude'
      })

      await expect(controller.loginIsolatedBrowser()).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'Claude path unavailable'
      })
    })

    it('strips NO_BROWSER and CI so the CLI is never told to suppress the browser', async () => {
      const priorNoBrowser = process.env.NO_BROWSER
      const priorCi = process.env.CI
      process.env.NO_BROWSER = '1'
      process.env.CI = 'true'

      try {
        const controller = new ClaudeIsolatedAuthController({
          store: createStore(),
          claudePath: '/usr/bin/claude',
          configDir: '/tmp/app-claude'
        })
        nextSpawn = scriptChild('sk-ant-oat01-abc123\n', '', 0)

        await controller.loginIsolatedBrowser()

        expect(spawnCalls[0]?.env?.NO_BROWSER).toBeUndefined()
        expect(spawnCalls[0]?.env?.CI).toBeUndefined()
      } finally {
        if (priorNoBrowser === undefined) delete process.env.NO_BROWSER
        else process.env.NO_BROWSER = priorNoBrowser
        if (priorCi === undefined) delete process.env.CI
        else process.env.CI = priorCi
      }
    })

    it('surfaces the stderr text when setup-token exits without a token', async () => {
      const store = createStore()
      const controller = new ClaudeIsolatedAuthController({
        store,
        claudePath: 'claude',
        configDir: '/tmp/app-claude'
      })
      nextSpawn = scriptChild('', 'browser sign-in aborted\n', 1)

      await expect(controller.loginIsolatedBrowser()).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'browser sign-in aborted'
      })
      expect(store.saveCalls).toHaveLength(0)
    })

    it('cancelLogin aborts an in-flight browser sign-in', async () => {
      const store = createStore()
      const controller = new ClaudeIsolatedAuthController({
        store,
        claudePath: 'claude',
        configDir: '/tmp/app-claude'
      })
      // A child that never closes on its own, so only the abort settles the login.
      nextSpawn = () => new FakeChild()

      const pending = controller.loginIsolatedBrowser()
      controller.cancelLogin()

      await expect(pending).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'Sign-in cancelled.',
        cancelled: true
      })
      expect(store.saveCalls).toHaveLength(0)
    })

    it('does not persist a captured browser token after the login is cancelled', async () => {
      const store = createStore()
      const controller = new ClaudeIsolatedAuthController({
        store,
        claudePath: 'claude',
        configDir: '/tmp/app-claude'
      })
      const child = new FakeChild()
      nextSpawn = () => child

      const pending = controller.loginIsolatedBrowser()
      await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
      child.on('close', () => controller.cancelLogin())
      child.stdout.emit('data', Buffer.from('sk-ant-oat01-browser-token\n'))
      child.emit('close', 0)

      await expect(pending).resolves.toEqual({
        supported: true,
        authenticated: false,
        message: 'Sign-in cancelled.',
        cancelled: true
      })
      expect(store.saveCalls).toHaveLength(0)
    })
  })
})
