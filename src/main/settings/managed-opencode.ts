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
// extract helpers are reused. Non-AVX2 `-baseline` variants are not selected; modern CPUs get the
// standard build. Every side-effecting dependency is injectable so the flow is unit-testable offline.

// Wrapper package (its dist-tags.latest gives the version) and the native-package name prefix. Note the
// native packages are `opencode-<key>`, NOT `opencode-ai-<key>`, so the prefix differs from the wrapper.
const OPENCODE_WRAPPER = 'opencode-ai'
const OPENCODE_PLATFORM_PREFIX = 'opencode'

type OpencodePlatform = { key: string; binName: string }

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
const resolveOpencodePlatform = (): OpencodePlatform => {
  const platform = process.platform
  let cpu = osArch()

  if (platform === 'linux') {
    return { key: `linux-${cpu}${detectMusl() ? '-musl' : ''}`, binName: 'opencode' }
  }

  if (platform === 'darwin') {
    if (cpu === 'x64' && isRosetta()) cpu = 'arm64'
    return { key: `darwin-${cpu}`, binName: 'opencode' }
  }

  if (platform === 'win32') {
    return { key: `windows-${cpu}`, binName: 'opencode.exe' }
  }

  throw new Error(`Unsupported platform for the app-managed OpenCode install: ${platform}-${cpu}`)
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

export type InstallManagedOpencodeOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  dataRoot: string
  registries?: string[]
  version?: string
  platform?: OpencodePlatform
  fetchJson?: FetchJson
  fetchTarball?: FetchTarball
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
