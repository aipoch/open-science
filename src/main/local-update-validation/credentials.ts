import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import type { LocalUpdateValidationConfig } from './config'

export type KeychainMetadataQuery = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
) => Pick<ReturnType<typeof spawnSync>, 'status' | 'stdout' | 'error' | 'signal'>

// Keychain's database is part of the credential identity. The production native helpers keep their
// signed, fixed service/account names, but must see only this scenario's dedicated database.
// These commands query metadata only; they never read passwords or change keychain preferences.
export function verifyLocalUpdateCredentialScope(
  config: LocalUpdateValidationConfig,
  query: KeychainMetadataQuery = spawnSync
): { keychainPath: string; defaultKeychain: string; searchList: string[] } {
  const read = (args: string[]): string[] => {
    const result = query('/usr/bin/security', args, {
      env: { ...process.env, HOME: config.homeRoot },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error || result.status !== 0 || result.signal)
      throw new Error('The local validation home has no usable isolated Keychain configuration.')
    try {
      return String(result.stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const value: unknown = JSON.parse(line)
          if (typeof value !== 'string') throw new Error('Invalid Keychain path.')
          return value
        })
    } catch {
      throw new Error('The local validation Keychain metadata could not be verified.')
    }
  }
  const defaults = read(['default-keychain', '-d', 'user'])
  const searchList = read(['list-keychains', '-d', 'user'])
  if (
    defaults.length !== 1 ||
    defaults[0] !== config.keychainPath ||
    searchList.length !== 1 ||
    searchList[0] !== config.keychainPath
  )
    throw new Error('Local validation must use only the dedicated Keychain owned by this scenario.')
  // macOS always appends the read-only common System database to the effective search list.
  // Never change that global list or let a same-named System item become a fallback credential.
  const systemKeychain = '/Library/Keychains/System.keychain'
  const effective = read(['list-keychains'])
  if (
    !effective.includes(config.keychainPath) ||
    effective.some((path) => path !== config.keychainPath && path !== systemKeychain)
  )
    throw new Error('The effective validation Keychain search scope contains another database.')
  if (effective.includes(systemKeychain)) {
    for (const appName of ['Open-Science', 'Open Science']) {
      for (const account of [`${appName} Key`, appName]) {
        const result = query(
          '/usr/bin/security',
          ['find-generic-password', '-s', `${appName} Safe Storage`, '-a', account, systemKeychain],
          {
            env: { ...process.env, HOME: config.homeRoot },
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 16_384,
            stdio: ['ignore', 'ignore', 'ignore']
          }
        )
        // `find-generic-password` without -g/-w is metadata-only. Item-not-found is -25300,
        // represented as exit status 44. Unknown results and any existing account refuse startup.
        if (result.error || result.signal || result.status !== 44)
          throw new Error(
            'Shared System Keychain metadata does not prove local credential isolation.'
          )
      }
    }
  }
  return { keychainPath: config.keychainPath, defaultKeychain: defaults[0], searchList }
}
