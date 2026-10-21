import { describe, expect, it, vi } from 'vitest'
import type { spawnSync } from 'node:child_process'
import type { LocalUpdateValidationConfig } from './config'
import { verifyLocalUpdateCredentialScope, type KeychainMetadataQuery } from './credentials'

const config = {
  homeRoot: '/validation/scenario/home',
  keychainPath: '/validation/scenario/home/Library/Keychains/validation.keychain-db'
} as LocalUpdateValidationConfig
function result(paths: string[], status = 0): ReturnType<typeof spawnSync> {
  return {
    status,
    stdout: paths.map((path) => JSON.stringify(path)).join('\n'),
    stderr: '',
    signal: null,
    pid: 1,
    output: []
  } as ReturnType<typeof spawnSync>
}
describe('local validation credential database isolation', () => {
  it('refuses shared System credentials and never requests password output', () => {
    const system = '/Library/Keychains/System.keychain'
    const query = vi
      .fn<typeof spawnSync>()
      .mockReturnValueOnce(result([config.keychainPath]))
      .mockReturnValueOnce(result([config.keychainPath]))
      .mockReturnValueOnce(result([config.keychainPath, system]))
      .mockReturnValue(result([], 0))
    expect(() => verifyLocalUpdateCredentialScope(config, query)).toThrow(
      'Shared System Keychain metadata'
    )
    const args = query.mock.calls.at(-1)![1] as string[]
    expect(args[0]).toBe('find-generic-password')
    expect(args).not.toContain('-g')
    expect(args).not.toContain('-w')
  })
  it('permits the OS common database only after metadata proves application accounts absent', () => {
    const query = vi
      .fn<typeof spawnSync>()
      .mockReturnValueOnce(result([config.keychainPath]))
      .mockReturnValueOnce(result([config.keychainPath]))
      .mockReturnValueOnce(result([config.keychainPath, '/Library/Keychains/System.keychain']))
      .mockReturnValue(result([], 44))
    expect(verifyLocalUpdateCredentialScope(config, query).keychainPath).toBe(config.keychainPath)
    expect(query).toHaveBeenCalledTimes(7)
  })

  it('verifies only the scenario database through metadata-only queries in the isolated home', () => {
    const query = vi.fn<KeychainMetadataQuery>().mockReturnValue(result([config.keychainPath]))
    expect(verifyLocalUpdateCredentialScope(config, query)).toEqual({
      keychainPath: config.keychainPath,
      defaultKeychain: config.keychainPath,
      searchList: [config.keychainPath]
    })
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ['default-keychain', '-d', 'user'],
      ['list-keychains', '-d', 'user'],
      ['list-keychains']
    ])
    for (const call of query.mock.calls)
      expect(call[2]).toMatchObject({
        env: { HOME: config.homeRoot },
        stdio: ['ignore', 'pipe', 'ignore']
      })
  })
  it('fails before native secret operations when the isolated HOME has no default Keychain', () => {
    const query = vi.fn<KeychainMetadataQuery>().mockReturnValue(result([], 1))
    expect(() => verifyLocalUpdateCredentialScope(config, query)).toThrow(
      'no usable isolated Keychain'
    )
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('rejects a daily default database and a daily database included in the search list', () => {
    const daily = '/Users/owner/Library/Keychains/login.keychain-db'
    const wrongDefault = vi.fn<KeychainMetadataQuery>().mockReturnValue(result([daily]))
    expect(() => verifyLocalUpdateCredentialScope(config, wrongDefault)).toThrow(
      'only the dedicated Keychain'
    )
    const extraDatabase = vi
      .fn<typeof spawnSync>()
      .mockReturnValueOnce(result([config.keychainPath]))
      .mockReturnValueOnce(result([config.keychainPath, daily]))
    expect(() => verifyLocalUpdateCredentialScope(config, extraDatabase)).toThrow(
      'only the dedicated Keychain'
    )
  })
})
