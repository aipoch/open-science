import { spawnSync } from 'node:child_process'
import { chmod, rm } from 'node:fs/promises'
import { arch as osArch } from 'node:os'
import { join } from 'node:path'

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
// extract helpers are reused. Modern CPUs get the standard build; a non-AVX2 x64 host whose post-install
// smoke check dies with SIGILL falls back once to the `-baseline` variant opencode publishes for x64 (no
// fragile pre-detection). Every side-effecting dependency is injectable so the flow is unit-testable offline.

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
// terminating signal (SIGILL etc.), or a non-zero exit all mean the binary is not usable here. Exported
// so the production classification (not just injected fakes) is exercised by tests.
export const defaultVerifyBinary: VerifyBinary = (binPath) => {
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

// Outcome of one package-key install attempt: a runnable binary, or a soft "extracted but won't run"
// failure (smoke check) the caller may recover from via the baseline retry. Resolve/download/extract
// errors are thrown instead (registry-level, handled by moving to the next registry).
type PackageAttempt =
  | { ok: true; version: string }
  | { ok: false; error: string; sigill: boolean; resolvedVersion: string }

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

  // Downloads, extracts, and smoke-checks one package key. Throws on registry-level errors (so the
  // caller can advance to the next registry); returns a soft failure only when the binary extracted
  // cleanly but does not run on this CPU.
  const installFromPackage = async (
    registry: string,
    packageKey: string,
    pinnedVersion: string | undefined
  ): Promise<PackageAttempt> => {
    const tgzPath = join(scratch, `opencode-download-${Date.now()}.tgz`)

    try {
      onEvent({ kind: 'progress', installId, phase: 'resolving' })
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Resolving ${OPENCODE_PLATFORM_PREFIX}-${packageKey} from ${registry} …\n`
      })
      const resolution = await resolveNative(registry, packageKey, pinnedVersion, fetchJson)

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
      // on this CPU. Remove the unusable binary and report a soft failure so no broken path is persisted.
      const verification = verifyBinary(destPath)
      if (!verification.ok) {
        await rm(destPath, { force: true }).catch(() => undefined)
        const sigill = verification.signal === 'SIGILL'
        const hint = sigill ? ' Your CPU may not support the required instruction set (AVX2).' : ''
        return {
          ok: false,
          sigill,
          resolvedVersion: resolution.version,
          error: `OpenCode installed but failed to run (${verification.reason}).${hint}`
        }
      }

      return { ok: true, version: resolution.version }
    } finally {
      await rm(tgzPath, { force: true }).catch(() => undefined)
    }
  }

  // x64 hosts have a `-baseline` native package variant that drops AVX2; a musl or plain x64 key still
  // contains "x64". arm64 has no baseline, so it is never retried.
  const isX64 = platform.key.includes('x64')

  for (const registry of registries) {
    try {
      const standard = await installFromPackage(registry, platform.key, version)
      if (standard.ok) {
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `Installed OpenCode ${standard.version}.\n`
        })
        return { result: { installId, ok: true }, resolvedPath: destPath, version: standard.version }
      }

      // The standard build extracted but died on this CPU. On a non-AVX2 x64 host (SIGILL) retry once
      // with the `-baseline` variant so the onboarding "auto-installable" claim actually holds. If the
      // baseline package is missing (404 at resolve) or also fails to run, surface the SIGILL/AVX2
      // diagnosis rather than crashing on an unverifiable package name.
      if (standard.sigill && isX64) {
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: 'Standard build is not runnable on this CPU; retrying the -baseline variant …\n'
        })
        try {
          const baseline = await installFromPackage(
            registry,
            `${platform.key}-baseline`,
            standard.resolvedVersion
          )
          if (baseline.ok) {
            onEvent({
              kind: 'log',
              installId,
              stream: 'system',
              chunk: `Installed OpenCode ${baseline.version} (baseline).\n`
            })
            return {
              result: { installId, ok: true },
              resolvedPath: destPath,
              version: baseline.version
            }
          }
        } catch {
          // Baseline unavailable (e.g. 404): fall through to the SIGILL/AVX2 error below.
        }
      }

      throw new Error(standard.error)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `${registry} failed: ${lastError}\n`
      })
    }
  }

  return { result: { installId, ok: false, error: lastError } }
}
