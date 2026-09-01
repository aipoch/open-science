import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envDirectoryName,
  envPrefix,
  legacyDefaultEnvPrefix,
  rReadyMarkerPath,
  readyMarkerPath
} from './runtime-paths'

type ManagedRuntimeRemovalTargets = Readonly<{
  environmentName: typeof DEFAULT_PY_ENV | typeof DEFAULT_R_ENV
  prefixes: readonly string[]
  marker: string
  targets: readonly string[]
}>

const isDirectChild = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return (
    nested !== '' &&
    !isAbsolute(nested) &&
    nested !== '..' &&
    !nested.startsWith(`..${sep}`) &&
    !nested.includes(sep)
  )
}

const managedRuntimeRemovalTargets = (
  root: string,
  language: NotebookLanguage,
  platform: NodeJS.Platform = process.platform
): ManagedRuntimeRemovalTargets => {
  const environmentName = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  const prefixes = new Set([envPrefix(root, environmentName, platform)])
  if (platform === 'win32') {
    prefixes.add(join(root, 'envs', envDirectoryName(environmentName, platform)))
    prefixes.add(legacyDefaultEnvPrefix(root, environmentName))
  }
  const marker = language === 'r' ? rReadyMarkerPath(root) : readyMarkerPath(root)
  return {
    environmentName,
    prefixes: Array.from(prefixes),
    marker,
    targets: [...prefixes, marker]
  }
}

const parseManagedRuntimeRemovalTargets = (
  root: string,
  language: NotebookLanguage,
  targetPaths: readonly string[],
  platform: NodeJS.Platform = process.platform
): ManagedRuntimeRemovalTargets => {
  const expected = managedRuntimeRemovalTargets(root, language, platform)
  const allowedPrefixes = new Set(expected.prefixes)
  const uniqueTargets = new Set(targetPaths)
  const prefixes = targetPaths.filter((target) => allowedPrefixes.has(target))
  if (
    targetPaths.length < 2 ||
    uniqueTargets.size !== targetPaths.length ||
    !targetPaths.includes(expected.marker) ||
    prefixes.length !== targetPaths.length - 1 ||
    prefixes.length === 0
  ) {
    throw new Error('Interrupted Runtime removal contains an unsafe filesystem target.')
  }
  return { ...expected, prefixes, targets: targetPaths }
}

const existingStat = (path: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Managed Runtime removal path could not be inspected: "${path}".`, {
      cause: error
    })
  }
}

const assertManagedRuntimeRemovalOwnership = (
  root: string,
  removal: ManagedRuntimeRemovalTargets
): void => {
  const rootStat = existingStat(root)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Managed Runtime removal root is missing or is a symbolic link/junction.')
  }
  const canonicalRoot = realpathSync.native(root)
  const envsRoot = join(root, 'envs')
  const envsStat = existingStat(envsRoot)
  let canonicalEnvsRoot: string | undefined
  if (envsStat) {
    if (!envsStat.isDirectory() || envsStat.isSymbolicLink()) {
      throw new Error('Managed Runtime envs root is not an app-owned directory.')
    }
    canonicalEnvsRoot = realpathSync.native(envsRoot)
    if (!isDirectChild(canonicalRoot, canonicalEnvsRoot)) {
      throw new Error('Managed Runtime envs root escapes the app-managed Runtime root.')
    }
  }

  for (const prefix of removal.prefixes) {
    const prefixStat = existingStat(prefix)
    if (!prefixStat) continue
    if (!canonicalEnvsRoot || !prefixStat.isDirectory() || prefixStat.isSymbolicLink()) {
      throw new Error(`Managed Runtime prefix is not an app-owned directory: "${prefix}".`)
    }
    const canonicalPrefix = realpathSync.native(prefix)
    if (!isDirectChild(canonicalEnvsRoot, canonicalPrefix)) {
      throw new Error(`Managed Runtime prefix escapes the app-managed envs root: "${prefix}".`)
    }
  }

  const markerStat = existingStat(removal.marker)
  if (markerStat) {
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error('Managed Runtime readiness receipt is not an app-owned file.')
    }
    const canonicalMarker = realpathSync.native(removal.marker)
    if (!isDirectChild(canonicalRoot, canonicalMarker)) {
      throw new Error('Managed Runtime readiness receipt escapes the app-managed Runtime root.')
    }
  }

  // If envs is absent, every recorded prefix must also be absent. This keeps an idempotent retry valid
  // without treating a missing parent as proof that an existing path is safe.
  if (!canonicalEnvsRoot && removal.prefixes.some((prefix) => existsSync(prefix))) {
    throw new Error('Managed Runtime prefix exists without an app-owned envs root.')
  }
}

export {
  assertManagedRuntimeRemovalOwnership,
  managedRuntimeRemovalTargets,
  parseManagedRuntimeRemovalTargets
}
export type { ManagedRuntimeRemovalTargets }
