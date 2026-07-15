import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { get } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { arch as osArch } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'

// App-managed Claude installer. The `@anthropic-ai/claude-code` npm package is a thin wrapper whose
// real payload is a per-platform native binary shipped as an optionalDependency
// (`@anthropic-ai/claude-code-<platform>-<arch>[-musl]`). That native binary runs with no Node.js at
// runtime, so the app can install Claude for a user who has neither Node nor npm: resolve the native
// package for the host, download its tarball from a registry (verifying the registry's sha512), and
// extract the single binary into the app's data dir. Every side-effecting dependency (network, fs
// platform probes) is injectable so the whole flow is unit-tested offline.

const PACKAGE_PREFIX = '@anthropic-ai/claude-code'
// URL-encoded scoped name (`/` -> `%2f`) for registry metadata endpoints.
const ENCODED_WRAPPER = '@anthropic-ai%2fclaude-code'

// Official registry first, China-friendly mirror second. Tried in order; a failure at any step
// (resolve/download/verify) falls through to the next registry.
const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']

// Native binary packages by `${platform}-${arch}[-musl]` key, mirroring the wrapper's own install.cjs.
// Windows binaries carry the `.exe` extension; every other platform is a bare `claude`.
const NATIVE_PLATFORMS: Record<string, { bin: string }> = {
  'darwin-arm64': { bin: 'claude' },
  'darwin-x64': { bin: 'claude' },
  'linux-x64': { bin: 'claude' },
  'linux-arm64': { bin: 'claude' },
  'linux-x64-musl': { bin: 'claude' },
  'linux-arm64-musl': { bin: 'claude' },
  'win32-x64': { bin: 'claude.exe' },
  'win32-arm64': { bin: 'claude.exe' }
}

export type ManagedPlatform = { key: string; pkg: string; binName: string }

// Injectable probes for the two platform ambiguities: musl vs glibc on Linux, and Rosetta-translated
// x64 Node on Apple Silicon (which should still get the arm64 binary — the x64 build needs AVX).
export type ManagedPlatformDeps = {
  platform?: NodeJS.Platform
  arch?: string
  // Returns Node's process report (or null); musl is inferred from a missing glibcVersionRuntime.
  getReport?: () => { header?: { glibcVersionRuntime?: string } } | null
  // True when an x64 process is running under Rosetta 2 on Apple Silicon.
  isRosetta?: () => boolean
}

const toPlatform = (key: string): ManagedPlatform => {
  const info = NATIVE_PLATFORMS[key]

  if (!info) {
    throw new Error(`Unsupported platform for the app-managed Claude install: ${key}`)
  }

  return { key, pkg: `${PACKAGE_PREFIX}-${key}`, binName: info.bin }
}

const detectMusl = (getReport?: ManagedPlatformDeps['getReport']): boolean => {
  const report = getReport
    ? getReport()
    : typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null

  return report != null && report.header?.glibcVersionRuntime === undefined
}

const defaultIsRosetta = (): boolean => {
  try {
    const result = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' })

    return result.stdout?.trim() === '1'
  } catch {
    return false
  }
}

// Resolves the native package descriptor for the host, applying the musl and Rosetta rules.
const getManagedPlatform = (deps: ManagedPlatformDeps = {}): ManagedPlatform => {
  const platform = deps.platform ?? process.platform
  let cpu = deps.arch ?? osArch()

  if (platform === 'linux') {
    return toPlatform(`linux-${cpu}${detectMusl(deps.getReport) ? '-musl' : ''}`)
  }

  if (platform === 'darwin' && cpu === 'x64') {
    const rosetta = deps.isRosetta ? deps.isRosetta() : defaultIsRosetta()
    if (rosetta) cpu = 'arm64'
  }

  return toPlatform(`${platform}-${cpu}`)
}

// Stable on-disk location for the managed binary. Kept version-independent (overwritten on upgrade) so
// detection and PATH augmentation can point at one fixed directory without symlinks (portable to
// Windows). The resolved version is recorded separately in the persisted ClaudeInfo.
const managedClaudeDir = (dataRoot: string): string => join(dataRoot, 'claude-code', 'bin')

// ---- Registry metadata -----------------------------------------------------------------------------

export type FetchJson = (url: string) => Promise<unknown>
export type FetchTarball = (
  url: string
) => Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }>

export type NativeResolution = {
  version: string
  tarball: string
  integrity: string
  registry: string
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

// Reads the wrapper package's `dist-tags.latest` from a registry.
const fetchLatestVersion = async (registry: string, fetchJson: FetchJson): Promise<string> => {
  const meta = asRecord(await fetchJson(`${registry}/${ENCODED_WRAPPER}`))
  const latest = asRecord(meta['dist-tags']).latest

  if (typeof latest !== 'string' || latest.length === 0) {
    throw new Error('Registry did not report a latest claude-code version')
  }

  return latest
}

// Resolves the native package's tarball URL + sha512 integrity from a single registry. Uses the
// pinned `version` when given, otherwise the wrapper's latest.
const resolveNativePackage = async ({
  registry,
  platform,
  version,
  fetchJson
}: {
  registry: string
  platform: ManagedPlatform
  version?: string
  fetchJson: FetchJson
}): Promise<NativeResolution> => {
  const resolvedVersion = version ?? (await fetchLatestVersion(registry, fetchJson))
  const encodedPkg = `${ENCODED_WRAPPER}-${platform.key}`
  const meta = asRecord(await fetchJson(`${registry}/${encodedPkg}/${resolvedVersion}`))
  const dist = asRecord(meta.dist)
  const tarball = dist.tarball
  const integrity = dist.integrity

  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`Incomplete registry metadata for ${platform.pkg}@${resolvedVersion}`)
  }

  return { version: resolvedVersion, tarball, integrity, registry }
}

// ---- Download + verify -----------------------------------------------------------------------------

// Streams a tarball to `destPath`, computing its sha512 as it goes and rejecting on an
// integrity mismatch (the file is removed). Emits `downloading` progress ticks, throttled to
// whole-percent steps when the total size is known (indeterminate otherwise).
const downloadAndVerify = async ({
  url,
  integrity,
  destPath,
  installId,
  onEvent,
  fetchTarball
}: {
  url: string
  integrity: string
  destPath: string
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  fetchTarball: FetchTarball
}): Promise<void> => {
  const { stream, totalBytes } = await fetchTarball(url)
  const hash = createHash('sha512')
  let received = 0
  let lastPercent = 0

  // Kick off the download phase immediately so the bar switches from "resolving" without waiting for
  // the first chunk (matters when the total is unknown and no percent ticks will follow).
  onEvent({ kind: 'progress', installId, phase: 'downloading', receivedBytes: 0, totalBytes })

  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      received += chunk.length

      // Determinate: emit only when the whole-percent advances (≤100 ticks). Unknown total stays
      // indeterminate and rides the initial event above (the bar animates on its own).
      if (totalBytes) {
        const percent = Math.floor((received / totalBytes) * 100)
        if (percent > lastPercent) {
          lastPercent = percent
          onEvent({
            kind: 'progress',
            installId,
            phase: 'downloading',
            receivedBytes: received,
            totalBytes
          })
        }
      }

      cb(null, chunk)
    }
  })

  await mkdir(dirname(destPath), { recursive: true })
  await pipeline(stream, meter, createWriteStream(destPath))

  const digest = `sha512-${hash.digest('base64')}`
  if (digest !== integrity) {
    await rm(destPath, { force: true })
    throw new Error('Downloaded Claude failed its integrity check (sha512 mismatch)')
  }
}

// ---- Tar extraction (minimal, single entry) --------------------------------------------------------

const TAR_BLOCK = 512

const isZeroBlock = (block: Buffer): boolean => {
  for (const byte of block) if (byte !== 0) return false
  return true
}

const readTarName = (header: Buffer): string => {
  const trim = (buf: Buffer): string => {
    const end = buf.indexOf(0)
    return buf.toString('utf8', 0, end === -1 ? buf.length : end)
  }
  const name = trim(header.subarray(0, 100))
  const prefix = trim(header.subarray(345, 500))

  return prefix ? `${prefix}/${name}` : name
}

const readTarSize = (header: Buffer): number => {
  const raw = header.toString('utf8', 124, 136).replace(/\0/g, '').trim()
  return raw ? parseInt(raw, 8) : 0
}

// Streaming Writable that extracts exactly one entry (`entryName`) from an uncompressed tar stream,
// forwarding its bytes through `onData` (which returns a Promise, giving natural backpressure to the
// destination file). All other entries are skipped. Handles entry/data spanning arbitrary chunk sizes.
class SingleEntrySink extends Writable {
  private leftover: Buffer = Buffer.alloc(0)
  private mode: 'header' | 'body' = 'header'
  private remaining = 0
  private padding = 0
  private capturing = false
  private found = false

  constructor(
    private readonly entryName: string,
    private readonly onData: (chunk: Buffer) => Promise<void>
  ) {
    super()
  }

  isFound(): boolean {
    return this.found
  }

  async _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void
  ): Promise<void> {
    try {
      this.leftover = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk
      await this.consume()
      cb()
    } catch (error) {
      cb(error as Error)
    }
  }

  private async consume(): Promise<void> {
    for (;;) {
      if (this.mode === 'header') {
        if (this.leftover.length < TAR_BLOCK) return

        const header = this.leftover.subarray(0, TAR_BLOCK)
        this.leftover = this.leftover.subarray(TAR_BLOCK)

        if (isZeroBlock(header)) continue // end-of-archive marker(s)

        const size = readTarSize(header)
        this.remaining = size
        this.padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK
        this.capturing = !this.found && readTarName(header) === this.entryName
        this.mode = 'body'
        continue
      }

      if (this.remaining > 0) {
        if (this.leftover.length === 0) return
        const take = Math.min(this.remaining, this.leftover.length)
        const piece = this.leftover.subarray(0, take)
        this.leftover = this.leftover.subarray(take)
        this.remaining -= take
        if (this.capturing) await this.onData(piece)
        continue
      }

      if (this.padding > 0) {
        if (this.leftover.length === 0) return
        const skip = Math.min(this.padding, this.leftover.length)
        this.leftover = this.leftover.subarray(skip)
        this.padding -= skip
        continue
      }

      if (this.capturing) this.found = true
      this.capturing = false
      this.mode = 'header'
    }
  }
}

// Extracts `entryName` from a gzipped tar at `tgzPath` into `destPath`. Returns whether the entry was
// present; a miss leaves no partial file behind.
const extractFileFromTgz = async ({
  tgzPath,
  entryName,
  destPath
}: {
  tgzPath: string
  entryName: string
  destPath: string
}): Promise<boolean> => {
  await mkdir(dirname(destPath), { recursive: true })

  const out = createWriteStream(destPath)
  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      out.once('error', onError)
      if (out.write(chunk)) {
        out.removeListener('error', onError)
        resolve()
      } else {
        out.once('drain', () => {
          out.removeListener('error', onError)
          resolve()
        })
      }
    })

  const sink = new SingleEntrySink(entryName, write)

  await pipeline(createReadStream(tgzPath), createGunzip(), sink)
  await new Promise<void>((resolve, reject) =>
    out.end((error?: Error | null) => (error ? reject(error) : resolve()))
  )

  if (!sink.isFound()) {
    await rm(destPath, { force: true })
    return false
  }

  return true
}

// ---- Orchestration ---------------------------------------------------------------------------------

export type ManagedInstallOutcome = {
  result: ClaudeInstallResult
  resolvedPath?: string
  version?: string
}

export type InstallManagedClaudeOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  // Root under which the binary is placed (<dataRoot>/claude-code/bin/<binName>). Pass the app's
  // configurable storage root, not a hardcoded userData path.
  dataRoot: string
  registries?: string[]
  version?: string
  platform?: ManagedPlatform
  fetchJson?: FetchJson
  fetchTarball?: FetchTarball
  tmpDir?: string
}

// Downloads + installs the managed Claude binary, trying each registry in order. Streams progress via
// `onLog` and resolves (never rejects) with a structured outcome the service can persist.
const installManagedClaude = async ({
  installId,
  onEvent,
  dataRoot,
  registries = DEFAULT_REGISTRIES,
  version,
  platform = getManagedPlatform(),
  fetchJson = defaultFetchJson,
  fetchTarball = defaultFetchTarball,
  tmpDir
}: InstallManagedClaudeOptions): Promise<ManagedInstallOutcome> => {
  const destPath = join(managedClaudeDir(dataRoot), platform.binName)
  const scratch = tmpDir ?? managedClaudeDir(dataRoot)
  let lastError = 'no registries configured'

  for (const registry of registries) {
    const tgzPath = join(scratch, `claude-download-${Date.now()}.tgz`)

    try {
      onEvent({ kind: 'progress', installId, phase: 'resolving' })
      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Resolving Claude from ${registry} …\n`
      })
      const resolution = await resolveNativePackage({ registry, platform, version, fetchJson })

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
        entryName: `package/${platform.binName}`,
        destPath
      })

      if (!found) throw new Error(`Native package did not contain ${platform.binName}`)
      if (process.platform !== 'win32') await chmod(destPath, 0o755)

      onEvent({
        kind: 'log',
        installId,
        stream: 'system',
        chunk: `Installed Claude ${resolution.version}.\n`
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

// ---- Default HTTPS transport (redirect-following) --------------------------------------------------

const httpsGetFollow = (
  url: string,
  { timeoutMs = 20_000, maxRedirects = 5 } = {}
): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const visit = (target: string, redirectsLeft: number): void => {
      const req = get(target, (res) => {
        const status = res.statusCode ?? 0

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects for ${target}`))
            return
          }
          visit(new URL(res.headers.location, target).toString(), redirectsLeft - 1)
          return
        }

        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`HTTP ${status} for ${target}`))
          return
        }

        resolve(res)
      })

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out for ${target}`)))
      req.on('error', reject)
    }

    visit(url, maxRedirects)
  })

const defaultFetchJson: FetchJson = async (url) => {
  const res = await httpsGetFollow(url)
  const chunks: Buffer[] = []

  for await (const chunk of res) chunks.push(chunk as Buffer)

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const defaultFetchTarball: FetchTarball = async (url) => {
  const res = await httpsGetFollow(url)
  const length = Number(res.headers['content-length'])

  return { stream: res, totalBytes: Number.isFinite(length) ? length : undefined }
}

export {
  DEFAULT_REGISTRIES,
  downloadAndVerify,
  extractFileFromTgz,
  getManagedPlatform,
  installManagedClaude,
  managedClaudeDir,
  resolveNativePackage
}
