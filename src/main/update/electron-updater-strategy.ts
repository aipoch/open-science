import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { autoUpdater, CancellationToken } from 'electron-updater'

import { APP } from '../../shared/app-config'
import { isCurrentInFlight } from '../../shared/in-flight-promise'
import { isNewer, type UpdateApplyOptions, type UpdateStatus } from '../../shared/update'
import { startDiagnosticOperation, type DiagnosticOperation } from '../diagnostics/operation'
import type { Logger } from '../logger'
import { fetchManifest } from './manifest'
import {
  canStartUpdateDownload,
  toAvailableUpdateStatus,
  type InstallGate,
  type UpdateStrategy
} from './strategy'
import type { ApplicationEventMap } from '../application-events'
import { broadcastToRenderers } from '../renderer-broadcast'
import { markApplicationShutdownTrigger } from '../application-shutdown-trigger'

type UpdateBroadcast = <Channel extends 'update:status' | 'update:progress'>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
) => void

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

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
  broadcast?: UpdateBroadcast
  // Factory for the per-download cancellation token; defaults to electron-updater's CancellationToken.
  // Injectable so tests can drive cancel() without the real class.
  createCancellationToken?: () => MinimalCancellationToken
  // CDN manifest the release notes are read from (same version.json the installer flow uses).
  // Injectable for tests; defaults to the public stable manifest.
  fetchImpl?: typeof fetch
  manifestUrl?: string
  // Pre-install backend-shutdown gate, fixed when the strategy is constructed.
  installGate?: InstallGate
  // Releases resources the install gate may have held when the installer handoff is aborted.
  releaseInstallHandoff?: () => void
  // Diagnostics sink for update lifecycle operations; defaults to a no-op so unit tests stay quiet.
  log?: Logger
  // Marks the app lifecycle handoff immediately before quitAndInstall. Injectable for tests.
  markUpdateShutdown?: () => () => void
  // True when an x64 process is running under Rosetta 2 on Apple Silicon; false when definitively not;
  // undefined when the probe could not determine it. Electron-updater detects this via
  // sysctl.proc_translated and selects the arm64 artifact, so we must match that to show the correct
  // pre-download size. When undefined, the strategy omits size rather than risking the wrong arch.
  isRosetta?: () => boolean | undefined
}

// Detects whether an x64 process is running under Rosetta 2 on Apple Silicon. Electron-updater's
// MacUpdater.filterFilesForArch uses the same sysctl key to pick the arm64 entry, so we must match
// it to show the correct pre-download size. Prefers Electron's app.runningUnderARM64Translation — a
// definitive boolean — when available; falls back to sysctl only when the Electron property is absent
// (e.g. test without Electron). Returns undefined only when the sysctl fallback is inconclusive.
const defaultIsRosetta = (): boolean | undefined => {
  try {
    // Electron's property is a definitive boolean — return it directly without falling through.
    if (typeof app?.runningUnderARM64Translation === 'boolean') {
      return app.runningUnderARM64Translation
    }
  } catch {
    // app not available (test without Electron)
  }
  try {
    const result = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' })
    const value = result.stdout?.trim()
    if (value === '1') return true
    if (value === '0') return false
  } catch {
    // sysctl failed — can't determine
  }
  return undefined
}

// Default broadcast pushes to every live window (mirrors service.ts). Never runs in unit tests, which
// inject their own broadcast.
const defaultBroadcast: UpdateBroadcast = (channel, payload) =>
  broadcastToRenderers(channel, payload)

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
  private readonly broadcast: UpdateBroadcast
  private readonly fetchImpl?: typeof fetch
  private readonly manifestUrl: string
  private readonly log: Logger
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
  private downloadOperation?: DiagnosticOperation
  // In-flight check() promise. Overlapping check()/download() await this instead of returning a
  // snapshot taken after `update-available` but before notes hydration finishes.
  private checkLifecycle?: Promise<UpdateStatus>
  private readyCheckStatus?: UpdateStatus
  private readyCheckError?: unknown
  private status: UpdateStatus
  private applying = false
  private installerStarted = false
  private pendingInstallRollback?: () => void
  // Pre-install backend-shutdown gate, owned immutably for the strategy lifetime.
  private readonly installGate?: InstallGate
  private readonly releaseInstallHandoff: () => void
  private readonly markUpdateShutdown: () => () => void

  constructor(deps: ElectronUpdaterDeps = {}) {
    this.updater = deps.updater ?? (autoUpdater as unknown as MinimalAutoUpdater)
    this.currentVersion = deps.currentVersion ?? app?.getVersion?.() ?? '0.0.0'
    this.platform = deps.platform ?? process.platform
    // Resolve the effective arch: an x64 app under Rosetta on Apple Silicon downloads the arm64
    // artifact (electron-updater does the same), so promote x64 → arm64 to match the correct size.
    const rawArch = deps.arch ?? process.arch
    let arch = rawArch
    if (this.platform === 'darwin' && rawArch === 'x64') {
      const rosetta = (deps.isRosetta ?? defaultIsRosetta)()
      if (rosetta === true) {
        arch = 'arm64'
      } else if (rosetta === undefined) {
        // Can't determine Rosetta status — electron-updater might still pick arm64. Blank the arch
        // token so extractArtifactSize sees a multi-arch feed as ambiguous and omits the size.
        arch = ''
      }
    }
    this.arch = arch
    this.broadcast = deps.broadcast ?? defaultBroadcast
    this.fetchImpl = deps.fetchImpl
    this.manifestUrl = deps.manifestUrl ?? APP.update.manifestUrl
    this.log = deps.log ?? NOOP_LOGGER
    this.createCancellationToken = deps.createCancellationToken ?? (() => new CancellationToken())
    this.installGate = deps.installGate
    this.releaseInstallHandoff = deps.releaseInstallHandoff ?? (() => undefined)
    this.markUpdateShutdown =
      deps.markUpdateShutdown ?? (() => markApplicationShutdownTrigger('update'))
    this.status = { state: 'idle', current: this.currentVersion, applyKind: 'restart' }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.subscribe()
  }

  private subscribe(): void {
    this.updater.on('checking-for-update', () => {
      if (this.readyCheckStatus && this.status === this.readyCheckStatus) return
      this.setStatus({ state: 'checking' })
    })
    this.updater.on('update-available', (info) => {
      const i = info as { version?: string; releaseNotes?: unknown; files?: UpdateFeedFile[] }
      const readyStatus = this.readyCheckStatus
      if (
        readyStatus &&
        this.status === readyStatus &&
        (!i.version || !isNewer(i.version, readyStatus.latest ?? this.currentVersion))
      ) {
        return
      }
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
      if (i.version) void this.hydrateNotes(i.version)
    })
    this.updater.on('update-not-available', (info) => {
      if (this.readyCheckStatus && this.status === this.readyCheckStatus) return
      const i = info as { version?: string }
      this.setStatus({ state: 'up-to-date', latest: i.version })
    })
    this.updater.on('download-progress', (p) => {
      const info = p as {
        percent?: number
        transferred?: number
        total?: number
        bytesPerSecond?: number
      }
      const percent = Math.round(info.percent ?? 0)
      const transferred = info.transferred ?? this.status.downloadedBytes ?? 0
      // Preserve the known artifact size when the event lacks a usable total, so a progress
      // event omitting it can't clobber the size extracted at check time with 0.
      const total = info.total || this.status.totalBytes || 0
      // electron-updater handles its own retries internally, so downloads only ever surface as the
      // 'downloading' phase with attempt 0; its native bytesPerSecond feeds the shared speed display.
      this.broadcast('update:progress', {
        phase: 'downloading',
        percent,
        transferred,
        total,
        bytesPerSecond: info.bytesPerSecond ?? 0,
        attempt: 0
      })
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
      if (this.applying && !this.installerStarted) return
      if (this.readyCheckStatus && this.status === this.readyCheckStatus) {
        this.readyCheckError = err
        return
      }
      if (this.installerStarted) {
        this.pendingInstallRollback?.()
        this.pendingInstallRollback = undefined
        this.releaseAbortedInstallHandoff()
        const operation = startDiagnosticOperation(this.log, {
          operation: 'update-installer',
          fields: { strategy: 'in-place' }
        })
        operation.phase('handoff')
        operation.fail(err, { result: 'error' })
      }
      this.applying = false
      this.installerStarted = false
      this.setStatus({
        ...this.status,
        state: 'error',
        error: err instanceof Error ? err.message : 'Update error'
      })
    })
  }

  private releaseAbortedInstallHandoff(): void {
    try {
      this.releaseInstallHandoff()
    } catch (error) {
      this.log.warn('update install handoff cleanup failed', error)
    }
  }

  // Always re-stamps current + applyKind so every broadcast status is self-consistent regardless of
  // which event produced it.
  private setStatus(partial: Partial<UpdateStatus>): void {
    if (this.applying && partial.state !== 'applying') return
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
      if (
        manifest.version === version &&
        (manifest.notes || manifest.localizedNotes) &&
        this.status.latest === version
      ) {
        this.setStatus({
          ...this.status,
          notes: manifest.notes || this.status.notes,
          localizedNotes: manifest.localizedNotes
        })
      }
    } catch {
      // Keep the fallback that links out to the GitHub release.
    }
  }

  async check(): Promise<UpdateStatus> {
    // Keep provider checks mutually exclusive with downloads. A ready update may still be refreshed,
    // but its events are reconciled against the downloaded version by the subscribers above.
    if (this.applying || this.downloadLifecycle) {
      return this.status
    }
    if (this.checkLifecycle) return this.checkLifecycle

    const readyStatus = this.status.state === 'ready' ? this.status : undefined
    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-check',
      fields: { strategy: 'in-place' }
    })
    this.readyCheckStatus = readyStatus
    this.readyCheckError = undefined
    const lifecycle = (async () => {
      try {
        operation.phase('query-provider')
        let providerFailure: unknown
        try {
          await this.updater.checkForUpdates()
        } catch (error) {
          providerFailure = error
          if (!readyStatus || this.status !== readyStatus) {
            this.setStatus({
              state: 'error',
              error: error instanceof Error ? error.message : 'Update check failed'
            })
          }
        }
        providerFailure ??= this.readyCheckError
        if (providerFailure) {
          operation.fail(providerFailure, { result: 'error' })
        } else if (this.status.state === 'error') {
          operation.fail(new Error('Updater check failed'), { result: 'error' })
        } else {
          operation.complete({ result: this.status.state })
        }
        return this.status
      } finally {
        this.readyCheckStatus = undefined
        this.readyCheckError = undefined
      }
    })()
    this.checkLifecycle = lifecycle
    try {
      return await lifecycle
    } finally {
      if (isCurrentInFlight(this.checkLifecycle, lifecycle)) this.checkLifecycle = undefined
    }
  }

  async download(): Promise<UpdateStatus> {
    // An active download is in flight; ignore repeat clicks / concurrent renderers. Starting a second
    // would overwrite downloadToken and orphan the first (cancel() could no longer stop it). This guard
    // and the token claim below are synchronous so a racing download()/cancel() sees a consistent slot.
    if (this.applying || this.downloadToken) return this.status
    // The startup scheduler and notes hydration keep check() in flight after `update-available` has
    // already marked the status `available`. Returning that snapshot dropped RPC/UI download requests,
    // including the Windows upgrade-smoke harness talking to 0.18.0+. Wait for the check, then start.
    if (this.checkLifecycle) await this.checkLifecycle
    if (this.applying || this.downloadToken) return this.status
    if (!canStartUpdateDownload(this.status)) return this.status

    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-download',
      fields: { strategy: 'in-place' }
    })
    this.downloadOperation = operation

    // A just-cancelled download may still be settling: cancel() returns before electron-updater's
    // underlying downloadPromise rejects. downloadUpdate() reuses that live promise and ignores a fresh
    // token while it exists (see AppUpdater.downloadUpdate), so a retry must first drain it. Capture it
    // and await it INSIDE the new lifecycle — awaiting here (before claiming the token) would defer a
    // microtask and let a concurrent download() slip past the guard.
    const previous = this.downloadLifecycle
    const generation = ++this.downloadGeneration
    const token = this.createCancellationToken()
    this.downloadToken = token
    this.setStatus({
      ...this.status,
      state: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      downloadProgress: undefined,
      error: undefined,
      blockedBy: undefined
    })

    const lifecycle = (async () => {
      try {
        // Let the prior cancelled download's promise clear (and its cleanup finish) before starting.
        // Swallow its outcome — it is owned by its own lifecycle.
        if (previous) {
          operation.phase('wait-for-previous')
          await previous.catch(() => {})
        }
        // A cancel() during the drain means never start this download.
        if (token.cancelled) return
        operation.phase('transfer')
        await this.updater.downloadUpdate(token)
        if (this.status.state === 'error') {
          operation.fail(new Error('Updater download failed'), { result: 'error' })
        } else {
          operation.complete({ result: this.status.state })
        }
      } catch (error) {
        // A user cancel rejects downloadUpdate too; don't surface it as an error. cancel() has already
        // reset the status to 'available', so leave it untouched here. Caught so the lifecycle never
        // rejects and can't poison the next download()'s drain.
        if (!token.cancelled) {
          this.setStatus({
            ...this.status,
            state: 'error',
            error: error instanceof Error ? error.message : 'Download failed'
          })
          operation.fail(error, { result: 'error' })
        }
      } finally {
        if (this.downloadToken === token) this.downloadToken = undefined
        if (this.downloadOperation === operation) this.downloadOperation = undefined
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
    if (this.applying) return this.status
    this.downloadToken?.cancel()
    this.downloadToken = undefined
    if (this.status.state === 'downloading') {
      this.setStatus(toAvailableUpdateStatus(this.status))
    }
    this.downloadOperation?.cancel({ reason: 'user' })
    return this.status
  }

  // Triggered by the user's "Restart to update" click once the download is ready. On Windows,
  // isSilent=true bypasses the assisted NSIS wizard and isForceRunAfter=true relaunches into the new
  // version. Other updaters ignore isSilent.
  async apply(options: UpdateApplyOptions = {}): Promise<UpdateStatus> {
    // Ignore stale/out-of-order renderer calls until electron-updater reports a completed download,
    // then claim the update synchronously so repeat clicks or concurrent renderers cannot start a
    // second teardown/install. The broadcast also gives the renderer immediate feedback during the
    // shutdown gate, which can take up to 15 seconds on Windows.
    if (this.status.state !== 'ready' || this.applying) return this.status
    this.applying = true
    this.installerStarted = false
    this.setStatus({ ...this.status, state: 'applying' })

    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-apply',
      fields: { strategy: 'in-place' }
    })

    // Stop the agent, Reviewer, and notebook process trees BEFORE handing off to the installer. Its
    // uninstall step deletes the running app's files, and on Windows an executable/DLL still mapped by
    // a background child (agent CLI, python kernel, conda) is locked — the classic "Failed to uninstall
    // old application files" error. If the teardown is degraded (budget elapsed, or taskkill fell back
    // and may have left grandchildren), refuse the install rather than fail mid-uninstall: the gate is
    // non-latching, so the app stays usable and the user can retry (fewer live processes next time).
    if (this.installGate) {
      operation.phase('install-gate')
      let readiness: Awaited<ReturnType<InstallGate>>
      try {
        readiness = await this.installGate()
      } catch (error) {
        this.releaseAbortedInstallHandoff()
        this.log.error('update install gate failed', error)
        this.applying = false
        this.setStatus({
          ...this.status,
          state: 'error',
          error: 'Could not stop background processes before updating. Please try again.'
        })
        operation.fail(error, { result: 'error' })
        return this.status
      }
      if (!this.applying) {
        this.releaseAbortedInstallHandoff()
        operation.cancel({ reason: 'apply-interrupted' })
        return this.status
      }
      if (!readiness.completed || !readiness.reaped) {
        this.releaseAbortedInstallHandoff()
        this.log.error('update install gate refused: backend teardown degraded', readiness)
        this.applying = false
        this.setStatus({
          ...this.status,
          state: 'error',
          error:
            readiness.blockedBy?.length === 1 && readiness.blockedBy[0] === 'delegated'
              ? 'Subagents are still running. Return to their tasks and stop them before restarting to update.'
              : readiness.blockedBy?.length === 1 && readiness.blockedBy[0] === 'settings-install'
                ? 'An Agent Runtime is still installing. Wait for it to finish before restarting to update.'
                : readiness.blockedBy?.length
                  ? 'Research work is still running. Stop it before restarting to update.'
                  : 'Could not fully stop background processes before updating. Please try again.',
          ...(readiness.blockedBy ? { blockedBy: readiness.blockedBy } : {})
        })
        operation.fail(new Error('Install gate refused'), {
          reason: 'install-gate-refused',
          gateCompleted: readiness.completed,
          processTreesReaped: readiness.reaped,
          ...(readiness.blockedBy ? { blockedBy: readiness.blockedBy.join(',') } : {})
        })
        return this.status
      }
      this.log.info('update install gate cleared; proceeding to quitAndInstall')
    }

    operation.phase('install')
    const rollbackTrigger = this.markUpdateShutdown()
    this.pendingInstallRollback = rollbackTrigger
    this.installerStarted = true
    try {
      this.updater.quitAndInstall(true, options.relaunch ?? true)
    } catch (error) {
      rollbackTrigger()
      this.pendingInstallRollback = undefined
      this.releaseAbortedInstallHandoff()
      this.applying = false
      this.installerStarted = false
      this.setStatus({
        ...this.status,
        state: 'error',
        error: error instanceof Error ? error.message : 'Could not start the update installer.'
      })
      operation.fail(error, { result: 'error' })
      return this.status
    }
    operation.complete({ result: 'handoff-requested' })
    return this.status
  }
}
