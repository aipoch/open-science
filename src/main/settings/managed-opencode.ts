import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
// extract helpers are reused. Modern CPUs get the standard build; an x64 host detected up front to lack
// AVX2 installs the `-baseline` variant on the first try, and any x64 host whose post-install smoke check
// still dies on an illegal instruction (SIGILL on POSIX, the NTSTATUS illegal-instruction exit status on
// Windows) falls back once to that `-baseline` variant as a safety net. Every side-effecting dependency
// is injectable so the flow is unit-testable offline.

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

// Injectable probes for the AVX2 detector so both OS branches are unit-testable cross-platform (parallel
// to ResolveOpencodePlatformDeps). Real defaults hit /proc/cpuinfo (linux) and sysctl (darwin).
export type DetectAvx2Deps = {
  platform?: NodeJS.Platform
  readCpuinfo?: () => string
  runSysctl?: () => { error?: Error; status?: number | null; stdout?: string }
}

// Up-front AVX2 probe so a non-AVX2 x64 host installs the `-baseline` build on the FIRST try instead of
// downloading the standard build, dying on SIGILL, and retrying. Errs on the side of `true` (standard
// build) whenever it cannot cheaply/reliably tell — the illegal-instruction→baseline retry is the safety
// net for those cases. Only meaningful on x64; the caller gates on that.
export const detectAvx2 = (deps: DetectAvx2Deps = {}): boolean => {
  const platform = deps.platform ?? process.platform

  if (platform === 'linux') {
    try {
      const readCpuinfo = deps.readCpuinfo ?? (() => readFileSync('/proc/cpuinfo', 'utf8'))
      return /\bavx2\b/i.test(readCpuinfo())
    } catch {
      return true
    }
  }
  if (platform === 'darwin') {
    try {
      const runSysctl =
        deps.runSysctl ??
        (() => spawnSync('sysctl', ['-n', 'machdep.cpu.leaf7_features'], { encoding: 'utf8' }))
      const out = runSysctl()
      // spawnSync signals failure via out.error / a non-zero out.status rather than throwing, leaving
      // stdout empty — treat any such failure as "assume present" BEFORE testing stdout so a capable
      // Intel Mac is never mis-flagged as baseline when sysctl is missing or errors.
      if (out.error || (out.status != null && out.status !== 0)) return true
      return /avx2/i.test(out.stdout ?? '')
    } catch {
      return true
    }
  }
  // win32 / anything else: no cheap reliable probe — assume standard and rely on the SIGILL retry.
  return true
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
// this host (e.g. a non-AVX2 x64 CPU dies on an illegal instruction at first spawn), so we execute
// `--version` before treating the install as successful. `ok:false` carries a human reason plus an
// `illegalInstruction` flag (the AVX2-baseline signal) so the caller can add an actionable hint.
export type VerifyBinaryResult =
  { ok: true } | { ok: false; reason: string; illegalInstruction: boolean }
export type VerifyBinary = (binPath: string) => VerifyBinaryResult

// Windows reports an illegal instruction not as a signal but as NTSTATUS STATUS_ILLEGAL_INSTRUCTION in
// the exit status. Node surfaces it as the unsigned value (3221225501) or its signed 32-bit form
// (-1073741795), so accept both.
const ILLEGAL_INSTRUCTION_STATUS = 0xc000001d
const isIllegalInstructionStatus = (status: number | null | undefined): boolean =>
  status === ILLEGAL_INSTRUCTION_STATUS || status === (ILLEGAL_INSTRUCTION_STATUS | 0)

// Just the fields of a spawnSync result the classifier reads.
export type VersionProbe = Partial<Pick<SpawnSyncReturns<string>, 'error' | 'signal' | 'status'>>
export type VersionProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number }
) => VersionProbe

// Runs the installed binary with `--version`. The injectable spawn (defaulting to the real spawnSync)
// lets tests lock the exact args and timeout without a real process.
export const runVersionProbe = (
  binPath: string,
  spawn: VersionProbeSpawn = spawnSync as unknown as VersionProbeSpawn
): VersionProbe => spawn(binPath, ['--version'], { encoding: 'utf8', timeout: 15_000 })

// Pure classifier for a version probe. A spawn error, a terminating signal, or a non-zero exit all mean
// the binary is not usable here; `illegalInstruction` is the AVX2-baseline signal (SIGILL on POSIX, the
// NTSTATUS illegal-instruction exit status on Windows). The injectable platform makes the Windows
// status branch testable off-Windows.
export const classifyVerifyResult = (
  probe: VersionProbe,
  platform: NodeJS.Platform = process.platform
): VerifyBinaryResult => {
  if (probe.error)
    return { ok: false, reason: `spawn error: ${probe.error.message}`, illegalInstruction: false }
  if (probe.signal)
    return {
      ok: false,
      reason: `killed by ${probe.signal}`,
      illegalInstruction: probe.signal === 'SIGILL'
    }
  if (probe.status !== 0)
    return {
      ok: false,
      reason: `\`--version\` exited with code ${probe.status}`,
      illegalInstruction: platform === 'win32' && isIllegalInstructionStatus(probe.status)
    }
  return { ok: true }
}

// Default verifier: probe the installed binary, then classify. Exported so the production classification
// (not just injected fakes) is exercised by tests.
export const defaultVerifyBinary: VerifyBinary = (binPath) =>
  classifyVerifyResult(runVersionProbe(binPath))

// The baseline native package inserts `baseline` right after the x64 arch token, BEFORE any `-musl`
// suffix, matching what opencode publishes: linux-x64 → linux-x64-baseline, linux-x64-musl →
// linux-x64-baseline-musl. Every x64 key has exactly one `x64` token, so a single replace is correct.
const baselinePackageKey = (key: string): string => key.replace('x64', 'x64-baseline')

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
  detectAvx2?: () => boolean
  tmpDir?: string
}

// Outcome of one package-key install attempt: a runnable binary, or a soft "extracted but won't run"
// failure (smoke check) the caller may recover from via the baseline retry. Resolve/download/extract
// errors are thrown instead (registry-level, handled by moving to the next registry).
type PackageAttempt =
  | { ok: true; version: string }
  | { ok: false; error: string; illegalInstruction: boolean; resolvedVersion: string }

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
  detectAvx2: detectAvx2Dep = detectAvx2,
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
        const illegalInstruction = verification.illegalInstruction
        const hint = illegalInstruction
          ? ' Your CPU may not support the required instruction set (AVX2).'
          : ''
        return {
          ok: false,
          illegalInstruction,
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
  // On an x64 host that we can positively tell lacks AVX2, install the baseline build FIRST (no wasted
  // standard download + SIGILL). When AVX2 is present or undetectable we try the standard build first and
  // keep the illegal-instruction→baseline retry as the safety net.
  const preferBaseline = isX64 && !detectAvx2Dep()
  const firstKey = preferBaseline ? baselinePackageKey(platform.key) : platform.key

  for (const registry of registries) {
    try {
      const first = await installFromPackage(registry, firstKey, version)
      if (first.ok) {
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `Installed OpenCode ${first.version}${preferBaseline ? ' (baseline)' : ''}.\n`
        })
        return {
          result: { installId, ok: true },
          resolvedPath: destPath,
          version: first.version
        }
      }

      // The first build extracted but died on this CPU. If we did NOT already prefer baseline and this is
      // an x64 host reporting an illegal instruction (SIGILL on POSIX, the NTSTATUS status on Windows),
      // retry once with the `-baseline` variant so the onboarding "auto-installable" claim holds. Gating
      // on `!preferBaseline` avoids building a double-`baseline` key when the first attempt already was
      // baseline. If the baseline package is missing (404 at resolve) or also fails to run, surface the
      // illegal-instruction/AVX2 diagnosis rather than crashing on an unverifiable package name.
      if (!preferBaseline && first.illegalInstruction && isX64) {
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: 'Standard build is not runnable on this CPU; retrying the -baseline variant …\n'
        })
        try {
          const baseline = await installFromPackage(
            registry,
            baselinePackageKey(platform.key),
            first.resolvedVersion
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
          // Baseline unavailable (e.g. 404): fall through to the illegal-instruction/AVX2 error below.
        }
      }

      throw new Error(first.error)
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
