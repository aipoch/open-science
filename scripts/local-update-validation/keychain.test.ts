import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareValidationKeychain } from './keychain.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): {
  runRoot: string
  homeRoot: string
  systemHome: string
  keychainPath: string
} {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'validation-keychain-')))
  roots.push(runRoot)
  const homeRoot = join(runRoot, 'home')
  const systemHome = join(runRoot, 'login-home')
  mkdirSync(homeRoot)
  mkdirSync(systemHome)
  const keychainPath = join(homeRoot, 'scenario.keychain-db')
  return { runRoot, homeRoot, systemHome, keychainPath }
}

describe('scenario-owned Keychain read-only verification', () => {
  it('refuses an unprovisioned scenario before invoking any security command', () => {
    const config = fixture()
    const execute = vi.fn()
    expect(() =>
      prepareValidationKeychain(config, {
        platform: 'darwin',
        systemHome: config.systemHome,
        spawnSync: execute
      })
    ).toThrow('never changes Keychain')
    expect(execute).not.toHaveBeenCalled()
  })
  it('queries preconfigured metadata without create, unlock, or list/default replacement', () => {
    const config = fixture()
    writeFileSync(config.keychainPath, 'preconfigured disposable database')
    const execute = vi.fn(
      (_command: string, args: string[], options: { env: { HOME: string } }) => ({
        status: 0,
        stdout:
          JSON.stringify(
            options.env.HOME === config.systemHome
              ? '/login/daily.keychain-db'
              : config.keychainPath
          ) + '\n'
      })
    )
    const proof = prepareValidationKeychain(config, {
      platform: 'darwin',
      systemHome: config.systemHome,
      spawnSync: execute
    })
    expect(proof.metadataOnly).toBe(true)
    expect(proof.hostPreferencesUnchanged).toBe(true)
    expect(
      execute.mock.calls.every(
        ([, args]) =>
          ['list-keychains', 'default-keychain'].includes(args[0]) && !args.includes('-s')
      )
    ).toBe(true)
  })
  it('rejects a daily search list without changing or restoring it', () => {
    const config = fixture()
    writeFileSync(config.keychainPath, 'preconfigured disposable database')
    const execute = vi.fn(() => ({ status: 0, stdout: '"/login/daily.keychain-db"\n' }))
    expect(() =>
      prepareValidationKeychain(config, {
        platform: 'darwin',
        systemHome: config.systemHome,
        spawnSync: execute
      })
    ).toThrow('no preferences were changed')
    expect(execute.mock.calls.length).toBe(4)
  })
})
