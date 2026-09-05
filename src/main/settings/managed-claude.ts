import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream, type Dirent, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { arch as osArch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'

import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'
import { netFetchStandard } from '../skills/net-fetch'

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

// True when `resolvedPath` is the app-managed Claude binary (lives directly in managedClaudeDir).
// Detection probes PATH before the managed dir, so a PATH copy shadows the managed one and this
// returns false for it — only a genuinely app-owned install is treated as managed (and uninstallable).
const isManagedClaudePath = (resolvedPath: string, dataRoot: string): boolean =>
  resolve(dirname(resolvedPath)) === resolve(managedClaudeDir(dataRoot))

const ORPHANED_CLAUDE_RUNTIME_PATTERN =
  /^claude-code\.(?:staging|backup)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const STAGED_CLAUDE_RUNTIME_PATTERN =
  /^claude-code\.staging-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const RUNTIME_OWNER_MARKER = '.open-science-managed-runtime'
const CLAUDE_RUNTIME_OWNER = 'open-science:claude-code:v1\n'
const NO_FOLLOW_OPEN_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

const readClaudeRuntimeOwnerMarker = async (
  markerPath: string,
  pathStats: Stats
): Promise<string> => {
  const marker = await open(markerPath, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG)
  try {
    const markerStats = await marker.stat()
    if (markerStats.dev !== pathStats.dev || markerStats.ino !== pathStats.ino) {
      throw new Error(`Refusing to use a changed ownership marker: ${markerPath}`)
    }
    if (!markerStats.isFile()) {
      throw new Error(`Refusing to use a non-file ownership marker: ${markerPath}`)
    }
    if (markerStats.nlink > 1) {
      throw new Error(`Refusing to use an ownership marker with multiple hard links: ${markerPath}`)
    }
    return await marker.readFile('utf8')
  } finally {
    await marker.close()
  }
}

const ensureClaudeRuntimeOwnerMarker = async (root: string): Promise<void> => {
  const markerPath = join(root, RUNTIME_OWNER_MARKER)
  const markerStats = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })

  if (!markerStats) {
    try {
      await writeFile(markerPath, CLAUDE_RUNTIME_OWNER, { flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return ensureClaudeRuntimeOwnerMarker(root)
      }
      throw error
    }
  }

  if (markerStats.isSymbolicLink()) {
    throw new Error(`Refusing to use a symbolic-link ownership marker: ${markerPath}`)
  }
  if (!markerStats.isFile()) {
    throw new Error(`Refusing to use a non-file ownership marker: ${markerPath}`)
  }
  if (markerStats.nlink > 1) {
    throw new Error(`Refusing to use an ownership marker with multiple hard links: ${markerPath}`)
  }
  if ((await readClaudeRuntimeOwnerMarker(markerPath, markerStats)) !== CLAUDE_RUNTIME_OWNER) {
    throw new Error(`Refusing to replace an unrecognized ownership marker: ${markerPath}`)
  }
}

const isOwnedClaudeRuntime = async (root: string): Promise<boolean> => {
  const markerPath = join(root, RUNTIME_OWNER_MARKER)
  const markerStats = await lstat(markerPath).catch(() => undefined)
  if (!markerStats?.isFile() || markerStats.nlink > 1) return false
  return (
    (await readClaudeRuntimeOwnerMarker(markerPath, markerStats).catch(() => undefined)) ===
    CLAUDE_RUNTIME_OWNER
  )
}

const findOwnedClaudeRuntimeSiblings = async (
  dataRoot: string,
  pattern: RegExp
): Promise<string[]> => {
  const root = dirname(managedClaudeDir(dataRoot))
  const siblings = await readdir(dirname(root), { withFileTypes: true }).catch(() => [] as Dirent[])
  const candidates = siblings
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => join(dirname(root), entry.name))
  return (
    await Promise.all(
      candidates.map(async (path) => ((await isOwnedClaudeRuntime(path)) ? path : undefined))
    )
  ).filter((path): path is string => path !== undefined)
}

const removeOwnedClaudeRuntimeSiblings = async (
  dataRoot: string,
  pattern: RegExp
): Promise<void> => {
  const owned = await findOwnedClaudeRuntimeSiblings(dataRoot, pattern)
  await Promise.all(
    owned.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined))
  )
}

// Removes the app-managed Claude install tree and exact installer-owned staging/backup siblings.
// Resolves (never rejects); a missing dir is a no-op so callers can uninstall idempotently.
const uninstallManagedClaude = async (dataRoot: string): Promise<void> => {
  const root = dirname(managedClaudeDir(dataRoot))
  await removeOwnedClaudeRuntimeSiblings(dataRoot, ORPHANED_CLAUDE_RUNTIME_PATTERN)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

// ---- Registry metadata -----------------------------------------------------------------------------

export type FetchJson = (url: string, signal?: AbortSignal) => Promise<unknown>
export type FetchTarball = (
  url: string,
  signal?: AbortSignal
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
const fetchLatestVersion = async (
  registry: string,
  fetchJson: FetchJson,
  signal?: AbortSignal
): Promise<string> => {
  const meta = asRecord(await fetchJson(`${registry}/${ENCODED_WRAPPER}`, signal))
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
  fetchJson,
  signal
}: {
  registry: string
  platform: ManagedPlatform
  version?: string
  fetchJson: FetchJson
  signal?: AbortSignal
}): Promise<NativeResolution> => {
  const resolvedVersion = version ?? (await fetchLatestVersion(registry, fetchJson, signal))
  const encodedPkg = `${ENCODED_WRAPPER}-${platform.key}`
  const meta = asRecord(await fetchJson(`${registry}/${encodedPkg}/${resolvedVersion}`, signal))
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
  fetchTarball,
  signal
}: {
  url: string
  integrity: string
  destPath: string
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  fetchTarball: FetchTarball
  signal?: AbortSignal
}): Promise<void> => {
  const { stream, totalBytes } = await fetchTarball(url, signal)
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
  await pipeline(stream, meter, createWriteStream(destPath), { signal })

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
  destPath,
  signal
}: {
  tgzPath: string
  entryName: string
  destPath: string
  signal?: AbortSignal
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
  const outputClosed = new Promise<void>((resolve) => out.once('close', resolve))
  const abortOutput = (): void => {
    out.destroy()
  }
  signal?.addEventListener('abort', abortOutput, { once: true })
  try {
    signal?.throwIfAborted()
    await pipeline(createReadStream(tgzPath), createGunzip(), sink, { signal })
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve()))
    )
  } finally {
    signal?.removeEventListener('abort', abortOutput)
    if (!out.closed) out.destroy()
    await outputClosed
  }

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
  verifyBinary: (binPath: string, signal?: AbortSignal) => Promise<string | undefined>
  signal?: AbortSignal
  renamePath?: typeof rename
  tmpDir?: string
}

// Keeps operational failures actionable in the existing install log instead of adding more startup
// checks. The original message is retained so support reports still include the platform error.
const describeManagedInstallError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''

  if (code === 'ENOSPC' || /no space left on device/i.test(message)) {
    return `Insufficient disk space (ENOSPC). Free some space, then install again. ${message}`
  }

  if (['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) {
    return `Network error (${code}). Check the network, proxy, VPN, or firewall, then install again. ${message}`
  }

  return message
}

const replaceManagedClaudeRoot = async (
  stagedRoot: string,
  root: string,
  renamePath: typeof rename
): Promise<void> => {
  const backup = `${root}.backup-${randomUUID()}`
  let backedUp = false

  const rejectSymbolicLink = async (path: string, label: string): Promise<void> => {
    const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (stats?.isSymbolicLink()) {
      throw new Error(`Refusing to replace ${label} because it is a symbolic link: ${path}`)
    }
  }

  await rejectSymbolicLink(root, 'the managed Claude runtime root')
  await ensureClaudeRuntimeOwnerMarker(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })

  try {
    await renamePath(root, backup)
    backedUp = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  try {
    await renamePath(stagedRoot, root)
  } catch (swapError) {
    if (backedUp) {
      try {
        await renamePath(backup, root)
      } catch (restoreError) {
        const swapMessage = swapError instanceof Error ? swapError.message : String(swapError)
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        throw new Error(
          `Claude runtime swap failed: ${swapMessage}. The previous runtime remains at ${backup} because restore failed: ${restoreMessage}.`
        )
      }
    }
    throw swapError
  }

  if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

// Downloads + installs the managed Claude binary, trying each registry in order. Streams progress via
// `onEvent` and resolves (never rejects) with a structured outcome the service can persist.
const installManagedClaude = async ({
  installId,
  onEvent,
  dataRoot,
  registries = DEFAULT_REGISTRIES,
  version,
  platform = getManagedPlatform(),
  fetchJson = defaultFetchJson,
  fetchTarball = defaultFetchTarball,
  verifyBinary,
  signal,
  renamePath = rename,
  tmpDir
}: InstallManagedClaudeOptions): Promise<ManagedInstallOutcome> => {
  const root = dirname(managedClaudeDir(dataRoot))
  const destPath = join(root, 'bin', platform.binName)
  const scratch = `${root}.staging-${randomUUID()}`
  const stagedRoot = join(scratch, 'runtime')
  const stagedPath = join(stagedRoot, 'bin', platform.binName)
  const downloadDir = tmpDir ?? scratch
  let lastError = 'no registries configured'

  await removeOwnedClaudeRuntimeSiblings(dataRoot, STAGED_CLAUDE_RUNTIME_PATTERN)
  try {
    await mkdir(scratch, { recursive: true })
    await ensureClaudeRuntimeOwnerMarker(scratch)
  } catch (error) {
    lastError = describeManagedInstallError(error)
    onEvent({
      kind: 'log',
      installId,
      stream: 'system',
      chunk: `Failed to prepare the Claude staging directory: ${lastError}\n`
    })
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { result: { installId, ok: false, error: lastError } }
  }
  try {
    for (const registry of registries) {
      const tgzPath = join(downloadDir, `claude-download-${randomUUID()}.tgz`)
      let reachedPublication = false

      try {
        await rm(stagedRoot, { recursive: true, force: true })
        onEvent({ kind: 'progress', installId, phase: 'resolving' })
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `Resolving Claude from ${registry} …\n`
        })
        const resolution = await resolveNativePackage({
          registry,
          platform,
          version,
          fetchJson,
          signal
        })

        await downloadAndVerify({
          url: resolution.tarball,
          integrity: resolution.integrity,
          destPath: tgzPath,
          installId,
          onEvent,
          fetchTarball,
          signal
        })

        onEvent({ kind: 'progress', installId, phase: 'extracting' })
        const found = await extractFileFromTgz({
          tgzPath,
          entryName: `package/${platform.binName}`,
          destPath: stagedPath,
          signal
        })

        if (!found) throw new Error(`Native package did not contain ${platform.binName}`)
        if (process.platform !== 'win32') await chmod(stagedPath, 0o755)
        const installedVersion = await verifyBinary(stagedPath, signal)
        if (!installedVersion) {
          throw new Error(
            'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
          )
        }
        await ensureClaudeRuntimeOwnerMarker(stagedRoot)
        signal?.throwIfAborted()

        reachedPublication = true
        await replaceManagedClaudeRoot(stagedRoot, root, renamePath)

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
        lastError = describeManagedInstallError(error)
        onEvent({
          kind: 'log',
          installId,
          stream: 'system',
          chunk: `${registry} failed: ${lastError}\n`
        })
        if (signal?.aborted) return { result: { installId, ok: false, error: lastError } }
        if (reachedPublication) return { result: { installId, ok: false, error: lastError } }
      } finally {
        await rm(tgzPath, { force: true }).catch(() => undefined)
      }
    }

    onEvent({
      kind: 'log',
      installId,
      stream: 'system',
      chunk:
        'Automatic setup stopped. Correct the error above and install again. No candidate runtime was published.\n'
    })

    return { result: { installId, ok: false, error: lastError } }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---- Default Electron transport (Session-proxy-aware) ---------------------------------------------

const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 20_000
const MAX_HTTPS_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308])

const fetchSuccessfulResponse = async (url: string, init?: RequestInit): Promise<Response> => {
  let target = new URL(url)
  if (target.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS installer request for ${target.toString()}`)
  }

  for (let redirects = 0; ; redirects += 1) {
    const response = await netFetchStandard(target.toString(), { ...init, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${target.toString()}`)
      return response
    }

    const location = response.headers.get('location')
    if (!location) {
      await response.body?.cancel()
      throw new Error(
        `HTTP ${response.status} without a redirect location for ${target.toString()}`
      )
    }
    if (redirects >= MAX_HTTPS_REDIRECTS) {
      await response.body?.cancel()
      throw new Error(`Too many redirects for ${url}`)
    }

    const next = new URL(location, target)
    if (next.protocol !== 'https:') {
      await response.body?.cancel()
      throw new Error(
        `Refusing installer redirect from ${target.toString()} to non-HTTPS ${next.toString()}`
      )
    }

    await response.body?.cancel()
    target = next
  }
}

const withInactivityTimeout = (
  source: Readable,
  { url, abort }: { url: string; abort: (reason?: unknown) => void }
): Readable => {
  let timer: NodeJS.Timeout | undefined

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function reset(): void {
    clear()
    timer = setTimeout(
      () => output.destroy(new Error(`Request timed out for ${url}`)),
      DOWNLOAD_INACTIVITY_TIMEOUT_MS
    )
  }

  const output = new Transform({
    transform(chunk, _encoding, callback) {
      reset()
      callback(null, chunk)
    }
  })

  const forwardSourceError = (error: Error): void => {
    output.destroy(error)
  }
  source.on('error', forwardSourceError)
  output.once('finish', clear)
  output.once('close', () => {
    clear()
    source.off('error', forwardSourceError)
    if (!source.destroyed) {
      abort()
      source.destroy()
    }
  })

  reset()
  source.pipe(output)
  return output
}

const defaultFetchJson: FetchJson = async (url, signal) => {
  const timeout = AbortSignal.timeout(20_000)
  const response = await fetchSuccessfulResponse(url, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout
  })
  return (await response.json()) as unknown
}

const defaultFetchTarball: FetchTarball = async (url, signal) => {
  const controller = new AbortController()
  const timeoutError = new Error(`Request timed out for ${url}`)
  let headerTimedOut = false
  const headerTimer = setTimeout(() => {
    headerTimedOut = true
    controller.abort(timeoutError)
  }, DOWNLOAD_INACTIVITY_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchSuccessfulResponse(url, {
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    })
  } catch (error) {
    if (headerTimedOut) throw timeoutError
    throw error
  } finally {
    clearTimeout(headerTimer)
  }

  if (!response.body) throw new Error(`Empty response body for ${url}`)

  const contentLength = response.headers.get('content-length')
  const length = contentLength === null ? undefined : Number(contentLength)
  const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
  const stream = withInactivityTimeout(source, {
    url,
    abort: (reason) => controller.abort(reason)
  })

  return {
    stream,
    totalBytes: length !== undefined && Number.isFinite(length) ? length : undefined
  }
}

export {
  DEFAULT_REGISTRIES,
  defaultFetchJson,
  defaultFetchTarball,
  downloadAndVerify,
  extractFileFromTgz,
  getManagedPlatform,
  installManagedClaude,
  isManagedClaudePath,
  managedClaudeDir,
  resolveNativePackage,
  uninstallManagedClaude
}
