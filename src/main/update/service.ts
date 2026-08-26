import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { app, BrowserWindow, dialog, shell } from 'electron'

import { APP } from '../../shared/app-config'
import {
  isNewer,
  selectDownload,
  type UpdateDownloadOptions,
  type UpdateStatus
} from '../../shared/update'
import { startDiagnosticOperation, type DiagnosticOperation } from '../diagnostics/operation'
import type { Logger } from '../logger'
import { downloadInstaller } from './downloader'
import { fetchManifest } from './manifest'
import type { UpdateStrategy } from './strategy'
import type { ApplicationEventMap } from '../application-events'
import { broadcastToRenderers } from '../renderer-broadcast'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'

type UpdateBroadcast = <Channel extends 'update:status' | 'update:progress'>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
) => void

export type UpdateServiceDeps = {
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  currentVersion?: string
  manifestUrl?: string
  broadcast?: UpdateBroadcast
  // Resolves where to save the installer, or null if the user cancels. Injected in tests; the
  // default is platform-aware (see resolveSavePath).
  promptSavePath?: (defaultFileName: string) => Promise<string | null>
  // Resolves a deterministic target without opening a native dialog (CLI/headless downloads).
  defaultDownloadPath?: (defaultFileName: string) => string
  // Filesystem + shell hooks, injected in tests so apply never touches Electron/disk.
  fileExists?: (path: string) => boolean
  openPath?: (path: string) => Promise<string>
  openExternal?: (url: string) => Promise<void>
  // Removes a stale partial file. Injected in tests; defaults to fs rm (best-effort). Used to drop a
  // prior session's <target>.part the FIRST time a target path is downloaded this session, so a restart
  // starts the installer download from scratch rather than resuming last session's fragment via Range.
  removeFile?: (path: string) => Promise<void>
  log?: Logger
  translate?: NativeTranslator
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

// Default broadcast pushes to every live window, mirroring the connector approval-broker pattern.
const defaultBroadcast: UpdateBroadcast = (channel, payload) =>
  broadcastToRenderers(channel, payload)

// Derive a safe on-disk installer name from the URL path only (never the query string), so a
// query-polluted or malformed URL still yields a sane default filename.
const installerFileName = (url: string): string => {
  try {
    return basename(new URL(url).pathname) || 'installer'
  } catch {
    return 'installer'
  }
}

// Owns the update lifecycle and the single UpdateStatus. Every transition is broadcast so all
// renderer stores stay in sync. All I/O is injectable for tests; production reads Electron/OS.
export class UpdateService implements UpdateStrategy {
  private status: UpdateStatus
  // Aborts the in-flight installer download; held so cancel() can stop it. Cleared once download settles.
  private downloadAbort?: AbortController
  // The current download()'s lifecycle promise, resolved only after downloadInstaller has fully settled
  // (including its partial-file rm cleanup on abort). A retry awaits this so an aborted download's
  // deferred rm can't delete a same-path retry's freshly written installer.
  private downloadLifecycle?: Promise<void>
  // Monotonic id per started download; the finally only clears downloadLifecycle when it is still the
  // latest, so an older (drained) download can't clear a newer one's lifecycle.
  private downloadGeneration = 0
  private downloadOperation?: DiagnosticOperation
  // In-flight check() promise. Overlapping check()/download() await this instead of returning a
  // snapshot taken while the startup scheduler still owns the manifest fetch.
  private checkLifecycle?: Promise<UpdateStatus>
  private readonly fetchImpl?: typeof fetch
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly currentVersion: string
  private readonly manifestUrl: string
  private readonly broadcast: UpdateBroadcast
  private readonly promptSavePath: (defaultFileName: string) => Promise<string | null>
  private readonly defaultDownloadPath: (defaultFileName: string) => string
  private readonly fileExists: (path: string) => boolean
  private readonly openPath: (path: string) => Promise<string>
  private readonly openExternal: (url: string) => Promise<void>
  private readonly removeFile: (path: string) => Promise<void>
  private readonly log: Logger
  private readonly translate: NativeTranslator
  // Per-session set of target paths that have already been downloaded once this run. The first
  // download to a given path removes any pre-existing <target>.part and validator sidecar so a restart
  // starts fresh
  // (design: "app closes → start from scratch"). Within a session the path stays in the set and a
  // cancel/retry may resume via Range when the response supplied a usable validator; otherwise the
  // shared downloader safely restarts from zero.
  private readonly freshTargets = new Set<string>()

  constructor(deps: UpdateServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl
    this.platform = deps.platform ?? process.platform
    this.arch = deps.arch ?? process.arch
    this.currentVersion = deps.currentVersion ?? app.getVersion()
    this.manifestUrl = deps.manifestUrl ?? APP.update.manifestUrl
    this.broadcast = deps.broadcast ?? defaultBroadcast
    this.promptSavePath = deps.promptSavePath ?? ((name) => this.resolveSavePath(name))
    this.defaultDownloadPath =
      deps.defaultDownloadPath ?? ((name) => join(app.getPath('userData'), `update-${name}`))
    this.fileExists = deps.fileExists ?? existsSync
    this.openPath = deps.openPath ?? ((path) => shell.openPath(path))
    this.openExternal = deps.openExternal ?? ((url) => shell.openExternal(url))
    this.removeFile = deps.removeFile ?? ((path) => rm(path, { force: true }))
    this.log = deps.log ?? NOOP_LOGGER
    this.translate = deps.translate ?? englishNativeTranslator
    this.status = { state: 'idle', current: this.currentVersion, applyKind: 'installer' }
  }

  // Platform-aware save location. Windows/Linux write straight to the Downloads folder (no OS
  // permission gate). macOS Downloads is TCC-protected, so a native save panel grants access via
  // implicit consent (no permission prompt) and lets the user confirm the location.
  private async resolveSavePath(defaultFileName: string): Promise<string | null> {
    const downloadsPath = join(app.getPath('downloads'), defaultFileName)
    if (this.platform !== 'darwin') return downloadsPath

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      defaultPath: downloadsPath,
      title: this.translate('Save the update installer')
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)

    return result.canceled || !result.filePath ? null : result.filePath
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  // Manifest flow always applies via an installer, so stamp applyKind here so every broadcast status
  // carries it (the renderer picks the "Open installer" vs "Restart" action off this field).
  private setStatus(next: UpdateStatus): void {
    this.status = { ...next, applyKind: 'installer' }
    this.broadcast('update:status', this.status)
  }

  async check(): Promise<UpdateStatus> {
    // A transfer and a manifest check cannot own the status concurrently. Once ready, checks still run
    // but only a strictly newer release may supersede the downloaded installer.
    if (this.downloadLifecycle) return this.status
    if (this.checkLifecycle) return this.checkLifecycle

    const readyStatus = this.status.state === 'ready' ? this.status : undefined
    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-check',
      fields: { strategy: 'manifest' }
    })
    const lifecycle = (async () => {
      if (!readyStatus) this.setStatus({ state: 'checking', current: this.currentVersion })
      operation.phase('fetch-manifest')
      try {
        const manifest = await fetchManifest(this.manifestUrl, this.fetchImpl)
        if (readyStatus) {
          // Another operation (for example apply() discovering a missing file) already moved the
          // lifecycle forward; this check no longer owns the snapshot it started from.
          if (this.status !== readyStatus) {
            operation.complete({ result: 'superseded' })
            return this.status
          }
          if (!isNewer(manifest.version, readyStatus.latest ?? this.currentVersion)) {
            operation.complete({ result: 'ready-preserved' })
            return this.status
          }
        }
        if (!isNewer(manifest.version, this.currentVersion)) {
          this.setStatus({
            state: 'up-to-date',
            current: this.currentVersion,
            latest: manifest.version
          })
          operation.complete({ result: 'up-to-date' })
          return this.status
        }
        const download = selectDownload(manifest, this.platform, this.arch) ?? undefined
        this.setStatus({
          state: 'available',
          current: this.currentVersion,
          latest: manifest.version,
          notes: manifest.notes,
          localizedNotes: manifest.localizedNotes,
          download,
          totalBytes: download?.size
        })
        operation.complete({ result: 'available', artifactAvailable: download !== undefined })
      } catch (error) {
        // A failed refresh must not discard an already downloaded installer. Ordinary checks continue
        // to surface the provider error as before.
        if (!readyStatus) {
          this.setStatus({
            state: 'error',
            current: this.currentVersion,
            error: error instanceof Error ? error.message : 'Update check failed'
          })
        }
        operation.fail(error, { result: 'error' })
      }
      return this.status
    })()
    this.checkLifecycle = lifecycle
    try {
      return await lifecycle
    } finally {
      if (this.checkLifecycle === lifecycle) this.checkLifecycle = undefined
    }
  }

  async download(options: UpdateDownloadOptions = {}): Promise<UpdateStatus> {
    // An active download is in flight; ignore repeat clicks / concurrent renderers. The abort claim
    // below is synchronous (before any await) so this guard and a cancel() during the drain both target
    // a consistent slot — a cancel while a retry is still draining must abort it, not be a no-op.
    if (this.downloadAbort) return this.status
    // The startup scheduler owns check() at launch. Returning the in-flight snapshot dropped download
    // requests that arrived after the UI/RPC already observed `available`. Wait, then start.
    if (this.checkLifecycle) await this.checkLifecycle
    if (this.downloadAbort) return this.status

    const { download } = this.status
    if (!download) return this.status

    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-download',
      fields: { strategy: 'manifest' }
    })
    this.downloadOperation = operation
    operation.phase('validate-source')

    // Defense-in-depth: the sha256 comes from the same manifest as the URL, so it can't catch a
    // tampered manifest pointing at a hostile host. Require the download to stay on the trusted host.
    let trustedHost: string
    try {
      trustedHost = new URL(this.manifestUrl).host
    } catch (error) {
      operation.fail(error, { reason: 'invalid-manifest-url' })
      if (this.downloadOperation === operation) this.downloadOperation = undefined
      throw error
    }
    let downloadHost: string
    try {
      downloadHost = new URL(download.url).host
    } catch {
      downloadHost = ''
    }
    if (downloadHost !== trustedHost) {
      this.setStatus({ ...this.status, state: 'error', error: 'Untrusted download host' })
      operation.fail(new URIError('Untrusted update source'), { reason: 'untrusted-source' })
      if (this.downloadOperation === operation) this.downloadOperation = undefined
      return this.status
    }

    // Claim the slot synchronously, before any await, so a concurrent download() is rejected and a
    // cancel() during the drain (below) aborts this download instead of being a no-op.
    const previous = this.downloadLifecycle
    const generation = ++this.downloadGeneration
    const abort = new AbortController()
    this.downloadAbort = abort

    const lifecycle = (async () => {
      try {
        // Drain any prior (e.g. just-cancelled) download so its partial-file rm can't delete a same-path
        // retry's installer. Swallow its outcome — it is owned by its own lifecycle.
        if (previous) {
          operation.phase('wait-for-previous')
          await previous.catch(() => {})
        }
        // A cancel() during the drain means never start this download.
        if (abort.signal.aborted) return

        // Ask where to save (platform-aware). A dialog cancel — or a cancel() during the prompt —
        // leaves the status untouched (stays 'available').
        operation.phase('select-target')
        const defaultFileName = installerFileName(download.url)
        const targetPath = options.nonInteractive
          ? this.defaultDownloadPath(defaultFileName)
          : await this.promptSavePath(defaultFileName)
        if (!targetPath) {
          operation.cancel({ reason: 'target-selection' })
          return
        }
        if (abort.signal.aborted) return

        // The CLI target is deterministic. Drop an older completed artifact before final rename so a
        // repeated command cannot fail merely because the same release filename is already staged.
        if (options.nonInteractive) await this.removeFile(targetPath)
        if (abort.signal.aborted) return

        // First time this session that we download to this exact path: drop any <target>.part and its
        // validator sidecar left by a PRIOR session so the resilient core can't Range-resume a stale
        // fragment (the user may re-pick the same Save location after a restart). Mark the path fresh
        // ONLY after both removals succeed — if either throws, we do NOT add it and let the error
        // propagate to the catch below, so a retry re-attempts the cleanup instead of resuming a
        // fragment we failed to delete (a same-version fragment would otherwise pass the final
        // checksum and silently complete a cross-restart resume). Subsequent downloads to the same
        // path this session are left to the resilient core, which resumes only when its validator
        // sidecar binds the partial to the remote representation.
        if (!this.freshTargets.has(targetPath)) {
          operation.phase('prepare-target')
          await this.removeFile(`${targetPath}.part`)
          await this.removeFile(`${targetPath}.part.meta`)
          this.freshTargets.add(targetPath)
          if (abort.signal.aborted) return
        }

        this.setStatus({
          ...this.status,
          state: 'downloading',
          progress: 0,
          downloadedBytes: 0,
          totalBytes: download.size
        })
        operation.phase('transfer')
        const localPath = await downloadInstaller(download, targetPath, {
          fetchImpl: this.fetchImpl,
          onProgress: (progress) => {
            if (abort.signal.aborted) return
            this.setStatus({
              ...this.status,
              state: 'downloading',
              progress: progress.percent ?? this.status.progress,
              downloadedBytes: progress.transferred,
              totalBytes: progress.total ?? this.status.totalBytes,
              downloadProgress: progress
            })
            this.broadcast('update:progress', progress)
          },
          signal: abort.signal
        })
        this.setStatus({
          ...this.status,
          state: 'ready',
          progress: 100,
          downloadedBytes: download.size,
          totalBytes: download.size,
          localPath
        })
        operation.complete({ result: 'ready' })
      } catch (error) {
        // A user cancel aborts the fetch (rejects here); cancel() already reset the status to
        // 'available', so leave it. Any other failure — including a save-dialog rejection — surfaces as
        // an error the user can retry from. Caught here so the lifecycle never rejects and can't poison
        // the next download()'s drain.
        if (!abort.signal.aborted) {
          this.setStatus({
            ...this.status,
            state: 'error',
            error: error instanceof Error ? error.message : 'Download failed'
          })
          operation.fail(error, { result: 'error' })
        }
      } finally {
        if (this.downloadAbort === abort) this.downloadAbort = undefined
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

  // Aborts the in-flight installer download and resets the status to 'available' so the UI leaves the
  // downloading state. No-op when nothing is downloading.
  async cancel(): Promise<UpdateStatus> {
    this.downloadAbort?.abort()
    this.downloadAbort = undefined
    this.downloadOperation?.cancel({ reason: 'user' })
    if (this.status.state === 'downloading') {
      this.setStatus({ ...this.status, state: 'available', progress: undefined })
    }
    return this.status
  }

  // Opens the downloaded installer. If the file is gone (e.g. the user deleted it) or fails to open,
  // drop back to 'available' so the user can re-download in place — the download metadata is still on
  // the status. With no installer for this platform at all, send them to the public download page.
  async apply(): Promise<UpdateStatus> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'update-apply',
      fields: { strategy: 'manifest' }
    })
    try {
      const { localPath, download } = this.status
      if (localPath) {
        operation.phase('verify-installer')
        if (this.fileExists(localPath)) {
          operation.phase('open-installer')
          const error = await this.openPath(localPath)
          if (!error) {
            operation.complete({ result: 'installer-opened' })
            return this.status
          }
          operation.fail(new Error('Installer open failed'), { reason: 'open-failed' })
        } else {
          operation.fail(new Error('Installer unavailable'), { reason: 'installer-missing' })
        }
      } else if (download) {
        operation.fail(new Error('Installer unavailable'), { reason: 'installer-missing' })
      }

      if (download) {
        this.setStatus({
          ...this.status,
          state: 'available',
          localPath: undefined,
          progress: undefined
        })
      } else {
        operation.phase('open-download-page')
        await this.openExternal(APP.update.downloadPage)
        operation.complete({ result: 'download-page-opened' })
      }
      return this.status
    } catch (error) {
      operation.fail(error, { result: 'error' })
      throw error
    }
  }
}
