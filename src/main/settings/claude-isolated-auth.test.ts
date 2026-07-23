import { describe, expect, it, vi } from 'vitest'

import { ClaudeIsolatedAuthController, type ClaudeIsolatedTokenStore } from './claude-isolated-auth'

// A controllable token store so each test can script load/save/clear outcomes without touching
// safeStorage or the repository. Mirrors the shape the SettingsService passes in service.ts.
const createStore = (
  overrides: Partial<ClaudeIsolatedTokenStore> = {}
): ClaudeIsolatedTokenStore & {
  saveCalls: string[]
  clearCalls: { count: number }
} => {
  const saveCalls: string[] = []
  const clearCalls = { count: 0 }

  const base: ClaudeIsolatedTokenStore = {
    loadToken: async () => undefined,
    saveToken: async (token) => {
      saveCalls.push(token)
    },
    clearToken: async () => {
      clearCalls.count += 1
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

  it('cancelLogin is a no-op (the paste flow has no in-flight work to abandon)', () => {
    const store = createStore()
    const controller = new ClaudeIsolatedAuthController({ store })

    expect(() => controller.cancelLogin()).not.toThrow()
    expect(store.saveCalls).toHaveLength(0)
    expect(store.clearCalls.count).toBe(0)
  })
})