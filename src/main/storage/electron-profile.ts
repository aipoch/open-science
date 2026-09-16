import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveConfigRootOverride } from './config-root'
export { resolveBootstrapConfigRoot } from './config-root'
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
const readProfileRecordFile = (recordPath: string): ElectronProfileRecord | undefined => {
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
export const readElectronProfileRecord = (
  configRoot: string
): ElectronProfileRecord | undefined => {
  const path = profileRecordPath(configRoot)
  const canonical = readProfileRecordFile(path)
  const pending = readProfileRecordFile(path + '.bootstrap')
  if (pending && (!pending.bootstrap || (canonical && !isDeepStrictEqual(canonical, pending)))) {
    throw new Error(
      `Conflicting Electron profile records: ${path} and ${path}.bootstrap. Preserve both files and restore the intended profile location before restarting.`
    )
  }
  return canonical ?? pending
}

const sameProfilePath = (left: string, right: string): boolean => {
  const a = normalize(left),
    b = normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

// Validate again at the write boundary: an env override selects a location, but does not grant
// permission to recreate a completed profile that has subsequently disappeared.
export const validateElectronProfileLocation = (
  configRoot: string,
  path: string,
  explicitPath: string | undefined = process.env.OPEN_SCIENCE_USER_DATA?.trim()
): ElectronProfileRecord | undefined => {
  const record = readElectronProfileRecord(configRoot)
  // Find the first existing directory entry, not just a resolvable target. A broken link at the
  // leaf or an ancestor is recovery evidence, never permission to create a replacement profile.
  let ancestor = path
  while (true) {
    try {
      lstatSync(ancestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
        throw error
      ancestor = dirname(ancestor)
      continue
    }
    try {
      if (!statSync(ancestor).isDirectory()) throw new Error('The path is not a directory.')
    } catch (cause) {
      throw new Error(
        `The selected Electron profile is not a directory or has an unavailable link: ${path}. Reconnect or restore ${ancestor} before restarting.`,
        { cause }
      )
    }
    break
  }
  const profileExists = ancestor === path
  if (!record) return undefined
  if (!sameProfilePath(record.path, path)) {
    if (record.bootstrap || !explicitPath || !sameProfilePath(explicitPath, path)) {
      throw new Error(
        `The selected Electron profile location conflicts with ${profileRecordPath(configRoot)}. Restore the recorded location before restarting. To choose a different completed profile explicitly, set OPEN_SCIENCE_USER_DATA to its absolute path.`
      )
    }
    return record
  }
  if (!profileExists) {
    if (record.bootstrap?.createProfile) return record
    throw new Error(
      `The saved Electron profile is missing: ${path}. Reconnect it or restore it from backup before restarting. Profile selection: ${profileRecordPath(configRoot)}.`
    )
  }
  return record
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
  if (explicit && !isAbsolute(explicit))
    throw new Error('OPEN_SCIENCE_USER_DATA must be an absolute path.')
  const recordPath = profileRecordPath(options.configRoot)
  const record = readElectronProfileRecord(options.configRoot)
  const isolated = resolveConfigRootOverride(options.packaged, env)
  const selected = explicit
    ? normalize(explicit)
    : isolated
      ? join(options.configRoot, 'electron-profile')
      : record?.path
  if (selected) {
    validateElectronProfileLocation(options.configRoot, selected, explicit ?? '')
    return selected
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
  const recovered = validateElectronProfileLocation(options.configRoot, options.profilePath)
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
  const parent = resolveConfigRootOverride(options.packaged) ?? options.home
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
