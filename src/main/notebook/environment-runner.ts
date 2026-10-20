import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createMicromambaRunnerResolver,
  micromambaRunnerCachePath,
  resolveMicromambaLocations,
  type MicromambaRunner,
  type MicromambaRunnerCandidate
} from '@aipoch/environment'

import micromambaVersions from '../../../scripts/micromamba-versions.json'
import { resolveBootstrapConfigRoot, resolveConfigRootOverride } from '../../shared/config-root'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { notebookMicromambaOptions, type NotebookMicromambaDeps } from './environment-resources'

export type MicromambaRunnerDeps = NotebookMicromambaDeps & {
  packaged?: boolean
  // Binary discovery home may follow the data disk; configuration always follows the app home.
  configHome?: string
  localToolsDir?: string
  preflight?: (path: string) => Promise<void>
  verifySignature?: (path: string) => Promise<void>
}

export const createProductionMicromambaRunner = (
  deps: MicromambaRunnerDeps = {}
): MicromambaRunner | undefined => {
  const platform = deps.platform ?? process.platform
  const locations = resolveMicromambaLocations({
    ...notebookMicromambaOptions(deps),
    platform
  })
  if (platform !== 'win32') {
    const path = locations[0]?.path
    return path ? { initialPath: path, resolve: async () => path } : undefined
  }

  const env = deps.env ?? process.env
  const home = deps.home ?? env.USERPROFILE ?? env.HOME
  const localAppData = env.LOCALAPPDATA ?? (home ? join(home, 'AppData', 'Local') : undefined)
  const packaged = deps.packaged ?? true
  const isolated =
    resolveConfigRootOverride(packaged, env) ??
    (!packaged
      ? resolveBootstrapConfigRoot(
          deps.configHome ?? env.USERPROFILE ?? env.HOME ?? homedir(),
          false,
          env
        )
      : undefined)
  const oldTools = localAppData
    ? join(localAppData, 'OpenScience', 'tools', 'micromamba')
    : undefined
  const toolsDir =
    deps.localToolsDir ??
    (isolated
      ? join(isolated, 'tools', 'micromamba')
      : oldTools && existsSync(join(oldTools, 'selection.json'))
        ? oldTools
        : localAppData
          ? join(localAppData, 'Open-Science', 'tools', 'micromamba')
          : undefined)
  if (!toolsDir) {
    if (locations.length === 0) return undefined
    throw new Error('Could not resolve a local tools directory for micromamba.')
  }

  const primaryDigest = micromambaVersions.binarySha256['win-64']
  const primaryId = `primary-${micromambaVersions.releaseTag}`
  const candidates: MicromambaRunnerCandidate[] = []
  const verifySignature = deps.verifySignature
  let pathIndex = 0
  const add = (location: (typeof locations)[number]): void => {
    const id =
      location.kind === 'bundled'
        ? `primary-${micromambaVersions.releaseTag}`
        : location.kind === 'path'
          ? `path-${++pathIndex}`
          : location.kind
    candidates.push({
      id,
      path: location.path,
      expectedSha256: location.kind === 'bundled' ? primaryDigest : undefined,
      verifySignature: location.kind === 'bundled',
      selectionTier:
        location.kind === 'override'
          ? 'explicit'
          : location.kind === 'bundled'
            ? 'pinned-primary'
            : 'fallback'
    })
  }

  for (const location of locations.filter(({ kind }) => kind === 'override')) add(location)
  for (const location of locations.filter(({ kind }) => kind === 'bundled')) add(location)
  if (!locations.some(({ kind }) => kind === 'bundled')) {
    const cachedPrimary = micromambaRunnerCachePath(toolsDir, primaryId, primaryDigest)
    if (existsSync(cachedPrimary)) {
      candidates.push({
        id: primaryId,
        path: cachedPrimary,
        expectedSha256: primaryDigest,
        verifySignature: true,
        selectionTier: 'pinned-primary'
      })
    }
  }

  const resourcesPath = deps.resourcesPath ?? runtimeMetadataIfConfigured()?.resourcesPath
  const compatibilityPath = resourcesPath ? join(resourcesPath, 'micromamba-compat.exe') : undefined
  if (compatibilityPath && existsSync(compatibilityPath)) {
    candidates.push({
      id: `compat-${micromambaVersions.compatibility.releaseTag}`,
      path: compatibilityPath,
      expectedSha256: micromambaVersions.compatibility.binarySha256['win-64'],
      verifySignature: true,
      selectionTier: 'compatibility'
    })
  }

  for (const location of locations.filter(
    ({ kind }) => kind !== 'override' && kind !== 'bundled'
  )) {
    add(location)
  }
  if (candidates.length === 0) return undefined

  return createMicromambaRunnerResolver({
    candidates,
    toolsDir,
    preflight: deps.preflight,
    verifySignature
  })
}
