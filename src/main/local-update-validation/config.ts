import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type LocalUpdateValidationConfig = {
  schema: 1
  runId: string
  scenario: string
  runRoot: string
  homeRoot: string
  credentialMode?: 'sandbox'
  keychainPath: string
  configRoot: string
  dataRoot: string
  userDataRoot: string
  updateCacheRoot: string
  eventsPath: string
  feedUrl: string
  manifestUrl: string
  installBehavior: 'boundary' | 'fail'
  targetArtifact: { version: string; arch: string; size: number; sha512: string }
}

export function assertLocalUpdateUrl(value: string, origin?: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (origin && url.origin !== origin)
  )
    throw new Error('Local update validation only permits its explicit IPv4 loopback origin.')
  return url
}

export function readLocalUpdateValidationConfig(path: string): LocalUpdateValidationConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as LocalUpdateValidationConfig
  if (
    config.schema !== 1 ||
    !config.runId ||
    !config.scenario ||
    !['boundary', 'fail'].includes(config.installBehavior) ||
    (config.credentialMode !== undefined && config.credentialMode !== 'sandbox')
  )
    throw new Error('Invalid local update validation configuration.')
  const target = config.targetArtifact
  if (
    !target ||
    typeof target.version !== 'string' ||
    !['arm64', 'x64'].includes(target.arch) ||
    !Number.isSafeInteger(target.size) ||
    target.size <= 0 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(target.sha512)
  )
    throw new Error('The local validation target artifact identity is required.')
  const keys = [
    'runRoot',
    'homeRoot',
    'keychainPath',
    'configRoot',
    'dataRoot',
    'userDataRoot',
    'updateCacheRoot',
    'eventsPath'
  ] as const
  for (const key of keys) {
    const value = config[key]
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value)
      throw new Error(`Local update validation requires an absolute canonical ${key}.`)
    if (key === 'keychainPath' && config.credentialMode === 'sandbox') continue
    // Reject symlinks at every existing component, including broken links.
    let entry = key === 'eventsPath' || key === 'keychainPath' ? dirname(value) : value
    while (true) {
      if (lstatSync(entry).isSymbolicLink()) throw new Error(`Symlink in ${key}.`)
      const parent = dirname(entry)
      if (parent === entry) break
      entry = parent
    }
    if (
      key === 'keychainPath' &&
      config.credentialMode !== 'sandbox' &&
      (!lstatSync(value).isFile() || lstatSync(value).isSymbolicLink())
    )
      throw new Error('The isolated validation Keychain must be a regular file.')
    if (key === 'eventsPath') {
      try {
        if (!lstatSync(value).isFile() || lstatSync(value).isSymbolicLink())
          throw new Error('The event journal must be a regular file.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (
      key !== 'eventsPath' &&
      key !== 'keychainPath' &&
      (!lstatSync(value).isDirectory() || realpathSync(value) !== value)
    )
      throw new Error(`Noncanonical ${key}.`)
    if (key !== 'runRoot') {
      const within = relative(config.runRoot, value)
      if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
        throw new Error(`${key} must belong to this validation run.`)
    }
  }
  const directories = [
    config.homeRoot,
    config.configRoot,
    config.dataRoot,
    config.userDataRoot,
    config.updateCacheRoot
  ]
  for (const [i, first] of directories.entries())
    for (const second of directories.slice(i + 1)) {
      const rel = relative(first, second)
      const reverse = relative(second, first)
      if (
        !rel ||
        (!rel.startsWith(`..${sep}`) && rel !== '..') ||
        (!reverse.startsWith(`..${sep}`) && reverse !== '..')
      )
        throw new Error('Local validation directories must be independent.')
    }
  const origin = assertLocalUpdateUrl(config.feedUrl).origin
  assertLocalUpdateUrl(config.manifestUrl, origin)
  return config
}
