import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { writeDurableJsonFile } from './durable-json-file'
import { directoryHasFiles } from './location-evidence'
import { hasDataRootContent, selectDefaultDataRoot } from './data-location-selection'

export type ProfileLocationOptions = {
  appData: string
  configRoot: string
  packaged: boolean
  env?: NodeJS.ProcessEnv
}
export type ElectronProfileRecord = {
  version: 1
  path: string
  // Written before creating either fresh location. Until completed, startup can resume the exact
  // choices after a crash without treating its own bootstrap files as evidence of a lost old root.
  bootstrap?: { dataRoot: string; createDataRoot: boolean; createProfile: boolean }
}
const profileRecordPath = (configRoot: string): string => join(configRoot, 'electron-profile.json')
export const readElectronProfileRecord = (
  configRoot: string
): ElectronProfileRecord | undefined => {
  const canonical = profileRecordPath(configRoot)
  const recordPath = existsSync(canonical) ? canonical : canonical + '.bootstrap'
  if (!existsSync(recordPath)) return undefined
  let record: Partial<ElectronProfileRecord> | null
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `The saved Electron profile location cannot be read: ${recordPath}. Restore this file before restarting.`,
      { cause: error }
    )
  }
  const pending = record?.bootstrap
  if (
    !record ||
    record.version !== 1 ||
    typeof record.path !== 'string' ||
    !isAbsolute(record.path) ||
    (pending !== undefined &&
      (!pending ||
        typeof pending.dataRoot !== 'string' ||
        !isAbsolute(pending.dataRoot) ||
        typeof pending.createDataRoot !== 'boolean' ||
        typeof pending.createProfile !== 'boolean'))
  ) {
    throw new Error(
      `The saved Electron profile location is invalid: ${recordPath}. Restore this file before restarting.`
    )
  }
  return record as ElectronProfileRecord
}
export const writeElectronProfileRecord = async (
  configRoot: string,
  record: ElectronProfileRecord
): Promise<void> => {
  await writeDurableJsonFile(profileRecordPath(configRoot), JSON.stringify(record) + '\n')
}

// Read-only until the caller owns the Electron single-instance lock. Explicit overrides are an
// intentional location selection; certification never falls back to a shared profile.
export const resolveElectronProfile = (options: ProfileLocationOptions): string => {
  const env = options.env ?? process.env
  const explicit = env.OPEN_SCIENCE_USER_DATA?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('OPEN_SCIENCE_USER_DATA must be an absolute path.')
    return normalize(explicit)
  }
  if (
    env.OPEN_SCIENCE_CONFIG_ROOT?.trim() ||
    env.OPEN_SCIENCE_E2E_STORAGE_ROOT?.trim() ||
    (!options.packaged && env.OPEN_SCIENCE_STORAGE_ROOT?.trim())
  )
    return join(options.configRoot, 'electron-profile')
  const recordPath = profileRecordPath(options.configRoot)
  const record = readElectronProfileRecord(options.configRoot)
  if (record) {
    if (!existsSync(record.path)) {
      if (record.bootstrap?.createProfile) return record.path
      throw new Error(
        `The saved Electron profile is missing: ${record.path}. Reconnect it before restarting.`
      )
    }
    if (!statSync(record.path).isDirectory())
      throw new Error(`The saved Electron profile is not a directory: ${record.path}`)
    return record.path
  }
  const suffix = options.packaged ? '' : ' (DEV)'
  const candidates = ['Open-Science', 'Open Science'].map((name) =>
    join(options.appData, name + suffix)
  )
  const populated = candidates.filter((path) => profileHasHistory(path))
  if (populated.length > 1)
    throw new Error(
      `Multiple Electron profiles exist. Restore the profile selection in ${recordPath} before restarting:\n${populated.join('\n')}`
    )
  if (!populated.length && directoryHasFiles(options.configRoot))
    throw new Error(
      `The Electron profile location is missing. Restore ${recordPath} with the verified original profile before restarting. No new profile was created.`
    )
  return populated[0] ?? candidates[0]
}

export const resolveBootstrapConfigRoot = (
  home: string,
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const override =
    env.OPEN_SCIENCE_E2E_STORAGE_ROOT?.trim() ||
    env.OPEN_SCIENCE_CONFIG_ROOT?.trim() ||
    (!packaged && env.OPEN_SCIENCE_STORAGE_ROOT?.trim())
  if (override) {
    if (!isAbsolute(override)) throw new Error('The config root must be an absolute path.')
    return normalize(override)
  }
  return join(home, packaged ? '.open-science' : '.open-science-project')
}

const PROFILE_LOCK_NAMES = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile'
])
export const profileHasHistory = (path: string): boolean =>
  directoryHasFiles(path, 0, PROFILE_LOCK_NAMES)

// Only the lock owner calls this, synchronously before Electron's native profile writers can run.
// A complete .bootstrap file is also readable after a crash before rename; a partial file blocks
// startup with an explicit recovery error instead of selecting another location.
export const pinFreshApplicationLocations = (options: {
  configRoot: string
  profilePath: string
  home: string
  packaged: boolean
  existingInstallation: boolean
}): void => {
  const canonical = profileRecordPath(options.configRoot)
  const recovered = readElectronProfileRecord(options.configRoot)
  const interrupted = canonical + '.bootstrap'
  if (recovered && existsSync(interrupted)) {
    if (existsSync(canonical)) unlinkSync(interrupted)
    else {
      // Windows FlushFileBuffers requires a writable handle even when bytes remain unchanged.
      const fd = openSync(interrupted, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(interrupted, canonical)
    }
    if (process.platform !== 'win32') {
      const directory = openSync(options.configRoot, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
  }
  if (options.existingInstallation || recovered) return
  const parent =
    process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT?.trim() ||
    process.env.OPEN_SCIENCE_CONFIG_ROOT?.trim() ||
    (!options.packaged && process.env.OPEN_SCIENCE_STORAGE_ROOT?.trim()) ||
    options.home
  const dataRoot = selectDefaultDataRoot(options.configRoot, parent, options.packaged, false)
  const record: ElectronProfileRecord = {
    version: 1,
    path: options.profilePath,
    bootstrap: {
      dataRoot,
      createDataRoot: !hasDataRootContent(dataRoot),
      createProfile: !existsSync(options.profilePath)
    }
  }
  mkdirSync(options.configRoot, { recursive: true })
  const pending = profileRecordPath(options.configRoot) + '.bootstrap'
  const fd = openSync(pending, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(record) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(pending, profileRecordPath(options.configRoot))
  if (process.platform !== 'win32') {
    const directory = openSync(options.configRoot, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
}
