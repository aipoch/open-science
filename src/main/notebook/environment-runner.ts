import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { micromambaRunnerCachePath } from '@aipoch/environment'
const execFileAsync = promisify(execFile)
const WINDOWS_PUBLISHER = 'AIPOCH PTE. LTD.'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { homedir } from 'node:os'
import { resolveBootstrapConfigRoot, resolveConfigRootOverride } from '../../shared/config-root'

import { existsSync } from 'node:fs'

import { join } from 'node:path'

import micromambaVersions from '../../../scripts/micromamba-versions.json'
import { resolveMicromambaLocations, type MicromambaDeps } from '@aipoch/environment'

import {
  createMicromambaRunnerResolver,
  type MicromambaRunner,
  type MicromambaRunnerCandidate
} from '@aipoch/environment'
export type MicromambaRunnerDeps = MicromambaDeps & {
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
    ...deps,
    resourcesPath: deps.resourcesPath ?? runtimeMetadataIfConfigured()?.resourcesPath,
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
  const verifySignature = deps.verifySignature ?? verifyWindowsAuthenticode
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

const verifyWindowsAuthenticode = async (path: string): Promise<void> => {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  const powershellModulePath = windowsRoot
    ? win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    : undefined
  const script = [
    '$ErrorActionPreference = "Stop"',
    ...(powershellModulePath
      ? ['$env:PSModulePath = $env:OPEN_SCIENCE_POWERSHELL_MODULE_PATH']
      : []),
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:OPEN_SCIENCE_AUTHENTICODE_PATH',
    'if ($signature.Status -ne "Valid") { throw "invalid Authenticode status: $($signature.Status) $($signature.StatusMessage)" }',
    '$publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)',
    `if ($publisher -ne '${WINDOWS_PUBLISHER}') { throw "unexpected Authenticode publisher: $publisher" }`,
    'if ($null -eq $signature.TimeStamperCertificate) { throw "missing Authenticode timestamp" }'
  ].join('; ')
  const env: NodeJS.ProcessEnv = { ...process.env, OPEN_SCIENCE_AUTHENTICODE_PATH: path }
  // The app may inherit a PSModulePath from a development/runtime host. Restrict module lookup to
  // Windows PowerShell's system directory so an incompatible bundled copy cannot shadow the security
  // module that supplies Get-AuthenticodeSignature.
  if (powershellModulePath) {
    env.OPEN_SCIENCE_POWERSHELL_MODULE_PATH = powershellModulePath
    env.PSModulePath = powershellModulePath
  }
  await execFileAsync(
    resolveWindowsPowerShellExecutable(process.env),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: 10_000,
      windowsHide: true,
      env
    }
  )
}
