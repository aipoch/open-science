import { spawnSync } from 'node:child_process'
import { chmod, rm } from 'node:fs/promises'
import { arch as osArch } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { ClaudeInstallEvent } from '../../shared/settings'
import {
  DEFAULT_REGISTRIES,
  defaultFetchJson,
  defaultFetchTarball,
  downloadAndVerify,
  extractFileFromTgz,
  type FetchJson,
  type FetchTarball,
  type ManagedInstallOutcome
} from './managed-claude'

// App-managed OpenCode installer. opencode ships per-platform native packages
// (`opencode-<os>-<arch>[-musl]`) as optionalDependencies of the `opencode-ai` wrapper, with the binary
// at `package/bin/opencode` — the same native-package model as Claude, so the shared download/verify/
// extract helpers are reused. Non-AVX2 `-baseline` variants are not selected; modern CPUs get the
// standard build. Every side-effecting dependency is injectable so the flow is unit-testable offline.

// Wrapper package (its dist-tags.latest gives the version) and the native-package name prefix. Note the
// native packages are `opencode-<key>`, NOT `opencode-ai-<key>`, so the prefix differs from the wrapper.
const OPENCODE_WRAPPER = 'opencode-ai'
const OPENCODE_PLATFORM_PREFIX = 'opencode'

type OpencodePlatform = { key: string; binName: string }

// The non-baseline native packages opencode publishes as `opencode-ai` optionalDependencies. A host key
// outside this set has no managed package, so resolveOpencodePlatform must throw rather than hand back a
// key that later 404s at the registry — this is what lets the environment check report an unsupported
// arch as not auto-installable, mirroring Claude's NATIVE_PLATFORMS allowlist.
const OPENCODE_NATIVE_KEYS = new Set([
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
  'windows-arm64'
])

// Injectable host probes so key resolution is unit-testable offline (parallel to Claude's deps).
export type ResolveOpencodePlatformDeps = {
  platform?: NodeJS.Platform
  arch?: string
  detectMusl?: () => boolean
  isRosetta?: () => boolean
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

// musl (Alpine) is inferred from a missing glibcVersionRuntime in Node's process report.
const detectMusl = (): boolean => {
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null

  return report != null && report.header?.glibcVersionRuntime === undefined
}

// An x64 Node under Rosetta 2 on Apple Silicon should still get the arm64 binary.
const isRosetta = (): boolean => {
  try {
    return (
      spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout?.trim() ===
      '1'
    )
  } catch {
    return false
  }
}

// Maps the host to opencode's native-package key. opencode uses `windows` (not Node's `win32`).
// Resolves the opencode native-package key for this host, throwing on any platform/arch opencode does
// not publish a package for. Exported so the environment check can gauge opencode auto-installability
// without the Claude platform map.
export const resolveOpencodePlatform = (
  deps: ResolveOpencodePlatformDeps = {}
): OpencodePlatform => {
  const platform = deps.platform ?? process.platform
  let cpu = deps.arch ?? osArch()

  let key: string
  let binName: string

  if (platform === 'linux') {
    const musl = deps.detectMusl ? deps.detectMusl() : detectMusl()
    key = `linux-${cpu}${musl ? '-musl' : ''}`
    binName = 'opencode'
  } else if (platform === 'darwin') {
    if (cpu === 'x64' && (deps.isRosetta ? deps.isRosetta() : isRosetta())) cpu = 'arm64'
    key = `darwin-${cpu}`
    binName = 'opencode'
  } else if (platform === 'win32') {
    key = `windows-${cpu}`
    binName = 'opencode.exe'
  } else {
    throw new Error(`Unsupported platform for the app-managed OpenCode install: ${platform}-${cpu}`)
  }

  if (!OPENCODE_NATIVE_KEYS.has(key)) {
    throw new Error(`Unsupported platform for the app-managed OpenCode install: ${key}`)
  }

  return { key, binName }
}

// Stable on-disk location for the managed binary (overwritten on upgrade), parallel to Claude's dir.
export const managedOpencodeDir = (dataRoot: string): string =>
  join(dataRoot, 'opencode-managed', 'bin')

// True when `resolvedPath` is the app-managed OpenCode binary (lives directly in managedOpencodeDir).
// Detection probes PATH before the managed dir, so a PATH copy shadows the managed one and this
// returns false for it — only a genuinely app-owned install is treated as managed (and uninstallable).
export const isManagedOpencodePath = (resolvedPath: string, dataRoot: string): boolean =>
  resolve(dirname(resolvedPath)) === resolve(managedOpencodeDir(dataRoot))

// Removes the app-managed OpenCode install tree (the `opencode-managed` dir holding `bin/<binName>`).
// Resolves (never rejects); a missing dir is a no-op so callers can uninstall idempotently.
export const uninstallManagedOpencode = async (dataRoot: string): Promise<void> => {
  await rm(dirname(managedOpencodeDir(dataRoot)), { recursive: true, force: true }).catch(
    () => undefined
  )
}

// Resolves the native package tarball URL + sha512 for one registry: `opencode-ai` latest (unless a
// version is pinned), then the platform package's dist metadata at that version.
const resolveNative = async (
  registry: string,
  key: string,
  version: string | undefined,
  fetchJson: FetchJson
): Promise<{ version: string; tarball: string; integrity: string }> => {
  let resolvedVersion = version

  if (!resolvedVersion) {
    const wrapper = asRecord(await fetchJson(`${registry}/${OPENCODE_WRAPPER}`))
    const latest = asRecord(wrapper['dist-tags']).latest
    if (typeof latest !== 'string' || latest.length === 0) {
      throw new Error('Registry did not report a latest opencode version')
    }
    resolvedVersion = latest
  }

  const meta = asRecord(
    await fetchJson(`${registry}/${OPENCODE_PLATFORM_PREFIX}-${key}/${resolvedVersion}`)
  )
  const dist = asRecord(meta.dist)
  const tarball = dist.tarball
  const integrity = dist.integrity

  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`Incomplete registry metadata for ${OPENCODE_PLATFORM_PREFIX}-${key}`)
  }

  return { version: resolvedVersion, tarball, integrity }
}

// Post-install smoke check. A native package can download+extract cleanly yet still be unrunnable on
// this host (e.g. a non-AVX2 x64 CPU dies with SIGILL at first spawn), so we execute `--version` before
// treating the install as successful. `ok:false` carries a human reason plus the raw signal so the
// caller can add an actionable hint.
export type VerifyBinaryResult =
  { ok: true } | { ok: false; reason: string; signal?: string | null }
export type VerifyBinary = (binPath: string) => VerifyBinaryResult

// Default verifier: run the installed binary with `--version` and classify failures. A spawn error, a
// terminating signal (SIGILL etc.), or a non-zero exit all mean the binary is not usable here.
const defaultVerifyBinary: VerifyBinary = (binPath) => {
  const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.error) return { ok: false, reason: `spawn error: ${probe.error.message}` }
  if (probe.signal) return { ok: false, reason: `killed by ${probe.signal}`, signal: probe.signal }
  if (probe.status !== 0)
    return { ok: false, reason: `\`--version\` exited with code ${probe.status}` }
  return { ok: true }
}

export type InstallManagedOpencodeOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  dataRoot: string
  registries?: string[]
  version?: string
  platform?: OpencodePlatform
  fetchJson?: FetchJson
  fetchTarball?: FetchTarball
  verifyBinary?: VerifyBinary
  tmpDir?: string
}

// Downloads + installs the managed opencode binary, trying each registry in order. Resolves (never
// rejects) with a structured outcome the service can persist.
export const installManagedOpencode = async ({
  installId,
  onEvent,
  dataRoot,
  registries = DEFAULT_REGISTRIES,
  version,
  platform = resolveOpencodePlatform(),
  fetchJson = defaultFetchJson,
  fetchTarball = defaultFetchTarball,
  verifyBinary = defaultVerifyBinary,
  tmpDir
}: InstallManagedOpencodeOptions): Promise<ManagedInstallOutcome> => {
  const destPath = join(managedOpencodeDir(dataRoot), platform.binName)
  const scratch = tmpDir ?? managedOpencodeDir(dataRoot)
  let lastError = 'no registries configured'

  for (const registry of registries) {
    const tgzPath = join(scratch, `opencode-download-${Date.now()}.tgz`)

    try {
      onEvent({ kind: 'progress', installId, phase: 'resolving' })
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Resolving OpenCode from ${registry} …\n`
      })
      const resolution = await resolveNative(registry, platform.key, version, fetchJson)

      await downloadAndVerify({
        url: resolution.tarball,
        integrity: resolution.integrity,
        destPath: tgzPath,
        installId,
        onEvent,
        fetchTarball
      })

      onEvent({ kind: 'progress', installId, phase: 'extracting' })
      const found = await extractFileFromTgz({
        tgzPath,
        entryName: `package/bin/${platform.binName}`,
        destPath
      })

      if (!found) throw new Error(`Native package did not contain bin/${platform.binName}`)
      if (process.platform !== 'win32') await chmod(destPath, 0o755)

      // Smoke-check the binary before reporting success — a clean download does not guarantee it runs
      // on this CPU. Remove the unusable binary and fail loudly so no broken path gets persisted.
      const verification = verifyBinary(destPath)
      if (!verification.ok) {
        await rm(destPath, { force: true }).catch(() => undefined)
        const hint =
          verification.signal === 'SIGILL'
            ? ' Your CPU may not support the required instruction set (AVX2).'
            : ''
        throw new Error(`OpenCode installed but failed to run (${verification.reason}).${hint}`)
      }

      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Installed OpenCode ${resolution.version}.\n`
      })

      return {
        result: { installId, ok: true },
        resolvedPath: destPath,
        version: resolution.version
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `${registry} failed: ${lastError}\n`
      })
    } finally {
      await rm(tgzPath, { force: true }).catch(() => undefined)
    }
  }

  return { result: { installId, ok: false, error: lastError } }
}
