/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { userInfo } from 'node:os'

// HOME alone is not sufficient evidence that Security.framework's effective domain is isolated.
// This tool never creates/unlocks databases or changes a default/search list. A disposable login
// account/VM must provision its scenario-owned database independently before application launch.
export function prepareValidationKeychain(config, dependencies = {}) {
  const execute = dependencies.spawnSync ?? spawnSync
  const platform = dependencies.platform ?? process.platform
  const systemHome = dependencies.systemHome ?? userInfo().homedir
  if (platform !== 'darwin' || process.getuid?.() === 0)
    throw new Error('Isolated validation Keychains require a non-root macOS login user.')
  const { runRoot, homeRoot } = config
  const keychainPath =
    config.keychainPath ?? join(homeRoot, 'Library/Keychains/local-update-validation.keychain-db')
  for (const value of [runRoot, homeRoot, keychainPath])
    if (!isAbsolute(value) || resolve(value) !== value)
      throw new Error('Validation Keychain paths must be canonical absolute paths.')
  const own = (parent, value) => {
    const within = relative(parent, value)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Validation Keychain paths must belong exclusively to this scenario.')
  }
  own(runRoot, homeRoot)
  own(homeRoot, keychainPath)
  if (
    realpathSync(runRoot) !== runRoot ||
    realpathSync(homeRoot) !== homeRoot ||
    homeRoot === systemHome
  )
    throw new Error('Validation Keychain HOME must be independent of the login HOME.')
  try {
    if (!lstatSync(keychainPath).isFile() || realpathSync(keychainPath) !== keychainPath)
      throw new Error('Invalid validation Keychain file.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(
      `No preconfigured scenario Keychain exists at ${keychainPath}. Application launch refused. ` +
        'Use a dedicated disposable macOS login account or VM to provision the staged scenario; this tool never changes Keychain search/default lists.'
    )
  }
  const fingerprint = () => {
    try {
      return createHash('sha256')
        .update(readFileSync(join(systemHome, 'Library/Preferences/com.apple.security.plist')))
        .digest('hex')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const read = (args, home) => {
    const result = execute('/usr/bin/security', args, {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error || result.signal || result.status !== 0)
      throw new Error('Read-only validation Keychain metadata query failed.')
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  const metadata = (home) => ({
    default: read(['default-keychain', '-d', 'user'], home),
    search: read(['list-keychains', '-d', 'user'], home)
  })
  const beforeFingerprint = fingerprint()
  const before = metadata(systemHome)
  const scope = metadata(homeRoot)
  if (
    scope.default.length !== 1 ||
    scope.default[0] !== keychainPath ||
    scope.search.length !== 1 ||
    scope.search[0] !== keychainPath
  )
    throw new Error(
      'Preconfigured Keychain metadata does not prove exclusive scenario scope; no preferences were changed.'
    )
  if (
    JSON.stringify(metadata(systemHome)) !== JSON.stringify(before) ||
    fingerprint() !== beforeFingerprint
  )
    throw new Error(
      'Login Keychain metadata changed during read-only verification; no preferences were restored or overwritten.'
    )
  return {
    keychainPath,
    isolated: true,
    hostPreferencesUnchanged: true,
    defaultKeychain: scope.default[0],
    searchList: scope.search,
    metadataOnly: true
  }
}
