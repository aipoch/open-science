import { homedir } from 'node:os'
import { resolveBootstrapConfigRoot, resolveConfigRootOverride } from '../../shared/config-root'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import micromambaVersions from '../../../scripts/micromamba-versions.json'
import { resolveMicromambaLocations, type MicromambaDeps } from './micromamba'

export type MicromambaRunnerCandidate = {
  id: string
  path: string
  // SHA-256 of the extracted upstream executable before an optional release signature is added.
  expectedSha256?: string
  // Bundled Windows candidates may be Authenticode-signed after this digest was recorded.
  verifySignature?: boolean
  selectionTier?: 'explicit' | 'pinned-primary' | 'compatibility' | 'fallback'
}

export type MicromambaRunner = {
  initialPath: string
  resolve: () => Promise<string>
}

export type MicromambaRunnerResolverOptions = {
  candidates: MicromambaRunnerCandidate[]
  toolsDir: string
  preflight?: (path: string) => Promise<void>
  verifySignature?: (path: string) => Promise<void>
}

export type MicromambaRunnerDeps = MicromambaDeps & {
  packaged?: boolean
  // Binary discovery home may follow the data disk; configuration always follows the app home.
  configHome?: string
  localToolsDir?: string
  preflight?: (path: string) => Promise<void>
  verifySignature?: (path: string) => Promise<void>
}

type SelectionReceipt = {
  schema: 1
  candidateId: string
  sha256: string
}

const execFileAsync = promisify(execFile)
const digestPattern = /^[0-9a-f]{64}$/
const candidateIdPattern = /^[a-z0-9][a-z0-9.-]*$/
const WINDOWS_PUBLISHER = 'AIPOCH PTE. LTD.'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const hashFile = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })

const defaultPreflight = async (path: string): Promise<void> => {
  await execFileAsync(path, ['--version'], { timeout: 10_000, windowsHide: true })
}

const verifyWindowsAuthenticode = async (path: string): Promise<void> => {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$env:PSModulePath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules"',
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
  env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
  await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 10_000,
    windowsHide: true,
    env
  })
}

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const code = (error as Error & { code?: string | number }).code
  if (typeof code === 'number') {
    const windowsStatus = `0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
    return `${error.message} (exit ${code}; ${windowsStatus})`
  }
  return code === undefined ? error.message : `${error.message} (exit ${code})`
}

const targetPath = (toolsDir: string, candidateId: string, digest: string): string =>
  join(toolsDir, candidateId, digest, 'micromamba.exe')

const readReceipt = async (path: string): Promise<SelectionReceipt | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SelectionReceipt>
    if (
      parsed.schema !== 1 ||
      typeof parsed.candidateId !== 'string' ||
      !candidateIdPattern.test(parsed.candidateId) ||
      typeof parsed.sha256 !== 'string' ||
      !digestPattern.test(parsed.sha256)
    ) {
      return undefined
    }
    return parsed as SelectionReceipt
  } catch {
    return undefined
  }
}

const existingFileMatches = async (path: string, expected: string): Promise<boolean> => {
  try {
    return (await hashFile(path)) === expected
  } catch {
    return false
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const materializeCandidate = async (
  candidate: MicromambaRunnerCandidate,
  toolsDir: string,
  verifySignature?: (path: string) => Promise<void>
): Promise<{ path: string; sha256: string }> => {
  if (!candidateIdPattern.test(candidate.id)) {
    throw new Error(`invalid runner candidate id: ${candidate.id}`)
  }

  const sourceDigest = await hashFile(candidate.path)
  const expected = candidate.expectedSha256?.toLowerCase()
  const signedSource = Boolean(expected && sourceDigest !== expected && candidate.verifySignature)
  if (expected && sourceDigest !== expected && !signedSource) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${sourceDigest}`)
  }
  if (signedSource) {
    if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
    await verifySignature(candidate.path)
  }

  const destination = targetPath(toolsDir, candidate.id, sourceDigest)
  if (await existingFileMatches(destination, sourceDigest)) {
    if (signedSource) {
      if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
      await verifySignature(destination)
    }
    return { path: destination, sha256: sourceDigest }
  }

  await mkdir(join(toolsDir, candidate.id, sourceDigest), { recursive: true })
  const staging = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await copyFile(candidate.path, staging)
    if (!(await existingFileMatches(staging, sourceDigest))) {
      throw new Error('copied runner failed sha256 verification')
    }
    if (signedSource) {
      if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
      await verifySignature(staging)
    }
    await rm(destination, { force: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }

  return { path: destination, sha256: sourceDigest }
}

const resolveRunner = async (opts: MicromambaRunnerResolverOptions): Promise<string> => {
  const preflight = opts.preflight ?? defaultPreflight
  const receiptPath = join(opts.toolsDir, 'selection.json')
  const failures: string[] = []
  const attempted = new Set<string>()
  const receipt = await readReceipt(receiptPath)

  const tryCandidate = async (
    candidate: MicromambaRunnerCandidate
  ): Promise<string | undefined> => {
    if (attempted.has(candidate.id)) return undefined
    attempted.add(candidate.id)
    try {
      const materialized = await materializeCandidate(
        candidate,
        opts.toolsDir,
        opts.verifySignature
      )
      await preflight(materialized.path)
      await mkdir(opts.toolsDir, { recursive: true })
      await writeFile(
        receiptPath,
        JSON.stringify(
          { schema: 1, candidateId: candidate.id, sha256: materialized.sha256 },
          undefined,
          2
        ) + '\n',
        'utf8'
      )
      return materialized.path
    } catch (error) {
      failures.push(`${candidate.id}: ${errorText(error)}`)
      return undefined
    }
  }

  const receiptCandidate = receipt
    ? opts.candidates.find((candidate) => candidate.id === receipt.candidateId)
    : undefined
  const receiptTier = receiptCandidate?.selectionTier ?? 'fallback'
  for (const candidate of opts.candidates) {
    const supersedesReceipt =
      (candidate.selectionTier === 'explicit' && candidate.id !== receiptCandidate?.id) ||
      (candidate.selectionTier === 'pinned-primary' && receiptTier === 'fallback')
    if (!supersedesReceipt) continue
    const selected = await tryCandidate(candidate)
    if (selected) return selected
  }

  if (receipt) {
    const cached = receiptCandidate
    const expected = cached?.expectedSha256?.toLowerCase()
    let sourceStillMatches = false
    if (cached) {
      const sourceDigest = await hashFile(cached.path).catch(() => undefined)
      sourceStillMatches = sourceDigest === receipt.sha256 || sourceDigest === expected
      if (!sourceStillMatches && cached.verifySignature && sourceDigest && opts.verifySignature) {
        try {
          await opts.verifySignature(cached.path)
          sourceStillMatches = true
        } catch (error) {
          failures.push(`${cached.id} cached signature: ${errorText(error)}`)
        }
      }
    }
    const receiptMatchesInstalled =
      cached &&
      (await existingFileMatches(
        targetPath(opts.toolsDir, cached.id, receipt.sha256),
        receipt.sha256
      ))
    if (cached && sourceStillMatches && receiptMatchesInstalled) {
      const path = targetPath(opts.toolsDir, cached.id, receipt.sha256)
      try {
        if (cached.verifySignature && expected !== receipt.sha256) {
          if (!opts.verifySignature) {
            throw new Error('signed runner requires Authenticode verification')
          }
          await opts.verifySignature(path)
        }
        if (await existingFileMatches(path, receipt.sha256)) {
          attempted.add(cached.id)
          await preflight(path)
          return path
        }
      } catch (error) {
        failures.push(`${cached.id} cached preflight: ${errorText(error)}`)
      }
    }
  }

  for (const candidate of opts.candidates) {
    const selected = await tryCandidate(candidate)
    if (selected) return selected
  }

  throw new Error(`No usable micromamba runner. ${failures.join('; ')}`)
}

export const createMicromambaRunnerResolver = (
  opts: MicromambaRunnerResolverOptions
): MicromambaRunner => {
  if (opts.candidates.length === 0)
    throw new Error('No micromamba runner candidates were provided.')
  let resolution: Promise<string> | undefined
  return {
    initialPath: opts.candidates[0].path,
    resolve: () => (resolution ??= resolveRunner(opts))
  }
}

export const createProductionMicromambaRunner = (
  deps: MicromambaRunnerDeps = {}
): MicromambaRunner | undefined => {
  const platform = deps.platform ?? process.platform
  const locations = resolveMicromambaLocations({ ...deps, platform })
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
    const cachedPrimary = targetPath(toolsDir, primaryId, primaryDigest)
    if (isFile(cachedPrimary)) {
      candidates.push({
        id: primaryId,
        path: cachedPrimary,
        expectedSha256: primaryDigest,
        verifySignature: true,
        selectionTier: 'pinned-primary'
      })
    }
  }

  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  const compatibilityPath = resourcesPath ? join(resourcesPath, 'micromamba-compat.exe') : undefined
  if (compatibilityPath && isFile(compatibilityPath)) {
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
