import { app } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'

import { APP } from '../../shared/app-config'
import type { UpdateStatus } from '../../shared/update'
import { fetchManifest } from './manifest'
import type { InstallGate, UpdateStrategy } from './strategy'
import { broadcastToRenderers } from '../renderer-broadcast'

// Minimal logger surface so tests inject a spy without pulling electron-log.
type UpdaterLogger = { info: (msg: string) => void; error: (msg: string, err?: unknown) => void }

// The slice of electron-updater's CancellationToken we drive: pass it to downloadUpdate() so the
// in-flight HTTP download can be aborted, and read `cancelled` to distinguish a user cancel from a
// real download failure.
export interface MinimalCancellationToken {
  readonly cancelled: boolean
  cancel(): void
}

// Structural subset of electron-updater's autoUpdater we depend on, so tests can inject a fake without
// pulling a real Electron runtime.
export interface MinimalAutoUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(cancellationToken?: MinimalCancellationToken): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type ElectronUpdaterDeps = {
  updater?: MinimalAutoUpdater
  currentVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  broadcast?: (channel: string, payload: unknown) => void
  // Factory for the per-download cancellation token; defaults to electron-updater's CancellationToken.
  // Injectable so tests can drive cancel() without the real class.
  createCancellationToken?: () => MinimalCancellationToken
  // CDN manifest the release notes are read from (same version.json the installer flow uses).
  // Injectable for tests; defaults to the public stable manifest.
  fetchImpl?: typeof fetch
  manifestUrl?: string
  // Pre-install backend-shutdown gate; usually injected later via setInstallGate once the runtime exists.
  installGate?: InstallGate
  // Diagnostics sink for the apply path; defaults to a no-op so unit tests stay quiet.
  log?: UpdaterLogger
}

// Default broadcast pushes to every live window (mirrors service.ts). Never runs in unit tests, which
// inject their own broadcast.
const defaultBroadcast = (channel: string, payload: unknown): void => {
  broadcastToRenderers(channel, payload)
}

// Coerce electron-updater's releaseNotes (string | {note}[] | null) to a plain string for the dialog.
const notesToString = (notes: unknown): string => {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((n) =>
        n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note) : ''
      )
      .join('\n')
  }
  return ''
}

// A file entry in electron-updater's UpdateInfo.files array.
type UpdateFeedFile = { url?: string; size?: number }

// The file extension electron-updater downloads for each platform (the auto-update artifact, not the
// CDN manifest's installer entry): ZIP on macOS, NSIS .exe on Windows, AppImage on Linux.
const PLATFORM_ARTIFACT_EXT: Record<string, string> = {
  darwin: '.zip',
  win32: '.exe',
  linux: '.AppImage'
}

// Architecture tokens that appear in electron-updater artifact filenames for each platform.
const PLATFORM_ARCH_TOKENS: Record<string, string[]> = {
  darwin: ['arm64', 'x64'],
  win32: ['x64', 'arm64'],
  linux: ['x64', 'arm64']
}

// Extracts the auto-update artifact size from the updater feed's files list. Matches both the platform's
// expected extension AND the current architecture token (e.g. `-arm64` or `-x64` in the URL), because
// production feeds carry per-arch entries (macOS latest-mac.yml lists both arm64 and x64 ZIPs). When
// multiple files match (ambiguous), returns undefined rather than risking the wrong size.
const extractArtifactSize = (
  files: UpdateFeedFile[] | undefined,
  platform: NodeJS.Platform,
  arch: string
): number | undefined => {
  if (!files || files.length === 0) return undefined
  const targetExt = PLATFORM_ARTIFACT_EXT[platform]
  if (!targetExt) return files.find((f) => f.size != null)?.size
  const archToken = PLATFORM_ARCH_TOKENS[platform]?.find((token) => arch.includes(token))
  if (archToken) {
    // Match both extension and arch token — the exact artifact electron-updater will download.
    const matches = files.filter(
      (f) => f.size != null && f.url?.endsWith(targetExt) && f.url?.includes(archToken)
    )
    if (matches.length === 1) return matches[0].size
    // Ambiguous (0 or 2+ matches) — don't risk showing the wrong size.
    if (matches.length > 1) return undefined
  }
  // No arch token to disambiguate (or no matching file): fall back to a single unambiguous extension match.
  const extMatches = files.filter((f) => f.size != null && f.url?.endsWith(targetExt))
  if (extMatches.length === 1) return extMatches[0].size
  // Still ambiguous or no extension match: try any file with a size, but only if there's exactly one.
  const sized = files.filter((f) => f.size != null)
  if (sized.length === 1) return sized[0].size
  return undefined
}

// In-place auto-update strategy: wraps electron-updater for true download + restart on win/linux and
// on signed stable macOS (Squirrel.Mac). Emits the same UpdateStatus shape as UpdateService, always
// stamped applyKind:'restart'. Opt-in: autoDownload and autoInstallOnAppQuit are disabled so nothing
// downloads/installs without a user action.
export class ElectronUpdaterStrategy implements UpdateStrategy {
  private readonly updater: MinimalAutoUpdater
  private readonly currentVersion: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly broadcast: (channel: string, payload: unknown) => void
  private readonly fetchImpl?: typeof fetch
  private readonly manifestUrl: string
  private readonly log: UpdaterLogger
  private readonly createCancellationToken: () => MinimalCancellationToken
  // The token for the current download, held so cancel() can abort it. Cleared once download() settles.
  private downloadToken?: MinimalCancellationToken
  // The current download()'s lifecycle promise, resolved only after the underlying downloadUpdate has
  // fully settled. A retry awaits this so it never reuses electron-updater's still-live downloadPromise
  // (which ignores a fresh token — see AppUpdater.downloadUpdate) or races an aborted download's cleanup.
  private downloadLifecycle?: Promise<void>
  // Monotonic id per started download; the finally only clears downloadLifecycle when it is still the
  // latest, so an older (drained) download can't clear a newer one's lifecycle.
  private downloadGeneration = 0
  private status: UpdateStatus
  // In-flight manifest notes fetch for the current update, awaited by check() so the returned
  // status reflects the hydrated notes.
  private notesHydration?: Promise<void>
  // Pre-install backend-shutdown gate, injected once the runtime exists (see ipc.ts).
  private installGate?: InstallGate

  constructor(deps: ElectronUpdaterDeps = {}) {
    this.updater = deps.updater ?? (autoUpdater as unknown as MinimalAutoUpdater)
    this.currentVersion = deps.currentVersion ?? app?.getVersion?.() ?? '0.0.0'
    this.platform = deps.platform ?? process.platform
    this.arch = deps.arch ?? process.arch
    this.broadcast = deps.broadcast ?? defaultBroadcast
    this.fetchImpl = deps.fetchImpl
    this.manifestUrl = deps.manifestUrl ?? APP.update.manifestUrl
    this.log = deps.log ?? { info: () => {}, error: () => {} }
    this.createCancellationToken = deps.createCancellationToken ?? (() => new CancellationToken())
    this.installGate = deps.installGate
    this.status = { state: 'idle', current: this.currentVersion, applyKind: 'restart' }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.subscribe()
  }

  setInstallGate(gate: InstallGate): void {
    this.installGate = gate
  }

  private subscribe(): void {
    this.updater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    this.updater.on('update-available', (info) => {
      const i = info as { version?: string; releaseNotes?: unknown; files?: UpdateFeedFile[] }
      const totalBytes = extractArtifactSize(i.files, this.platform, this.arch)
      this.setStatus({
        state: 'available',
        latest: i.version,
        notes: notesToString(i.releaseNotes),
        ...(totalBytes != null ? { totalBytes } : {})
      })
      // electron-updater's *.yml feed carries no release notes, so the dialog would only get a
      // GitHub link. Hydrate the notes from the CDN manifest (the same version.json the installer
      // flow reads) so the "What's new" section renders in-app.
      if (i.version) this.notesHydration = this.hydrateNotes(i.version)
    })
    this.updater.on('update-not-available', (info) => {
      const i = info as { version?: string }
      this.setStatus({ state: 'up-to-date', latest: i.version })
    })
    this.updater.on('download-progress', (p) => {
      const info = p as { percent?: number; transferred?: number; total?: number }
      const percent = Math.round(info.percent ?? 0)
      const transferred = info.transferred ?? this.status.downloadedBytes ?? 0
      // Preserve the known artifact size when the event lacks a usable total, so a progress
      // event omitting it can't clobber the size extracted at check time with 0.
      const total = info.total || this.status.totalBytes || 0
      this.broadcast('update:progress', { percent, transferred, total })
      this.setStatus({
        ...this.status,
        state: 'downloading',
        progress: percent,
        downloadedBytes: transferred,
        totalBytes: total
      })
    })
    this.updater.on('update-downloaded', () => {
      this.setStatus({ ...this.status, state: 'ready', progress: 100 })
    })
    this.updater.on('error', (err) => {
      this.setStatus({ state: 'error', error: err instanceof Error ? err.message : 'Update error' })
    })
  }

  // Always re-stamps current + applyKind so every broadcast status is self-consistent regardless of
  // which event produced it.
  private setStatus(partial: Partial<UpdateStatus>): void {
    this.status = {
      ...partial,
      state: partial.state ?? this.status.state,
      current: this.currentVersion,
      applyKind: 'restart'
    }
    this.broadcast('update:status', this.status)
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  // Fetch the CDN manifest and, when it matches the offered update and actually carries notes,
  // merge them into the current status. Any failure (network, parse, version drift) leaves the
  // GitHub-link fallback in place — notes are best-effort and never block the update.
  private async hydrateNotes(version: string): Promise<void> {
    try {
      const manifest = await fetchManifest(this.manifestUrl, this.fetchImpl)
      if (manifest.version === version && manifest.notes && this.status.latest === version) {
        this.setStatus({ ...this.status, notes: manifest.notes })
      }
    } catch {
      // Keep the fallback that links out to the GitHub release.
    }
  }

  async check(): Promise<UpdateStatus> {
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : 'Update check failed'
      })
    }
    // Wait for the notes fetch triggered by update-available so the returned status carries them.
    await this.notesHydration
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    // An active download is in flight; ignore repeat clicks / concurrent renderers. Starting a second
    // would overwrite downloadToken and orphan the first (cancel() could no longer stop it). This guard
    // and the token claim below are synchronous so a racing download()/cancel() sees a consistent slot.
    if (this.downloadToken) return this.status

    // A just-cancelled download may still be settling: cancel() returns before electron-updater's
    // underlying downloadPromise rejects. downloadUpdate() reuses that live promise and ignores a fresh
    // token while it exists (see AppUpdater.downloadUpdate), so a retry must first drain it. Capture it
    // and await it INSIDE the new lifecycle — awaiting here (before claiming the token) would defer a
    // microtask and let a concurrent download() slip past the guard.
    const previous = this.downloadLifecycle
    const generation = ++this.downloadGeneration
    const token = this.createCancellationToken()
    this.downloadToken = token
    this.setStatus({ ...this.status, state: 'downloading', progress: 0, downloadedBytes: 0 })

    const lifecycle = (async () => {
      try {
        // Let the prior cancelled download's promise clear (and its cleanup finish) before starting.
        // Swallow its outcome — it is owned by its own lifecycle.
        if (previous) await previous.catch(() => {})
        // A cancel() during the drain means never start this download.
        if (token.cancelled) return
        await this.updater.downloadUpdate(token)
      } catch (error) {
        // A user cancel rejects downloadUpdate too; don't surface it as an error. cancel() has already
        // reset the status to 'available', so leave it untouched here. Caught so the lifecycle never
        // rejects and can't poison the next download()'s drain.
        if (!token.cancelled) {
          this.setStatus({
            state: 'error',
            error: error instanceof Error ? error.message : 'Download failed'
          })
        }
      } finally {
        if (this.downloadToken === token) this.downloadToken = undefined
      }
    })()
    this.downloadLifecycle = lifecycle
    try {
      await lifecycle
    } finally {
      if (this.downloadGeneration === generation) this.downloadLifecycle = undefined
    }
    return this.status
  }

  // Aborts the in-flight electron-updater download by cancelling its token and resets the status to
  // 'available' so the UI leaves the downloading state. Does not clear downloadLifecycle: the next
  // download() awaits it so it never reuses the still-settling (cancelled) downloadPromise. No-op when
  // nothing is downloading.
  async cancel(): Promise<UpdateStatus> {
    this.downloadToken?.cancel()
    this.downloadToken = undefined
    if (this.status.state === 'downloading') {
      this.setStatus({ ...this.status, state: 'available', progress: undefined })
    }
    return this.status
  }

  // Triggered by the user's "Restart to update" click once the download is ready. On win/linux,
  // isSilent=true keeps the assisted NSIS installer from showing its wizard and isForceRunAfter=true
  // relaunches into the new version (per-user install = no UAC prompt). On macOS Squirrel.Mac swaps
  // the .app and relaunches; it ignores isSilent, so the same call is correct there too.
  async apply(): Promise<UpdateStatus> {
    // Stop the agent + notebook process trees BEFORE handing off to the installer. Its uninstall step
    // deletes the running app's files, and on Windows an executable/DLL still mapped by a background
    // child (agent CLI, python kernel, conda) is locked — the classic "Failed to uninstall old
    // application files" error. If the teardown is degraded (budget elapsed, or taskkill fell back and
    // may have left grandchildren), refuse the install rather than fail mid-uninstall: the gate is
    // non-latching, so the app stays usable and the user can retry (fewer live processes next time).
    if (this.installGate) {
      const readiness = await this.installGate()
      if (!readiness.completed || !readiness.reaped) {
        this.log.error('update install gate refused: backend teardown degraded', readiness)
        this.setStatus({
          state: 'error',
          error: 'Could not fully stop background processes before updating. Please try again.'
        })
        return this.status
      }
      this.log.info('update install gate cleared; proceeding to quitAndInstall')
    }

    this.updater.quitAndInstall(true, true)
    return this.status
  }
}
