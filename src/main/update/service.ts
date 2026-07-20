import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { app, BrowserWindow, dialog, shell } from 'electron'

import { APP } from '../../shared/app-config'
import { isNewer, selectDownload, type UpdateStatus } from '../../shared/update'
import { downloadInstaller } from './downloader'
import { fetchManifest } from './manifest'
import type { UpdateStrategy } from './strategy'
import { broadcastToRenderers } from '../renderer-broadcast'

export type UpdateServiceDeps = {
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  currentVersion?: string
  manifestUrl?: string
  broadcast?: (channel: string, payload: unknown) => void
  // Resolves where to save the installer, or null if the user cancels. Injected in tests; the
  // default is platform-aware (see resolveSavePath).
  promptSavePath?: (defaultFileName: string) => Promise<string | null>
  // Filesystem + shell hooks, injected in tests so apply never touches Electron/disk.
  fileExists?: (path: string) => boolean
  openPath?: (path: string) => Promise<string>
  openExternal?: (url: string) => Promise<void>
}

// Default broadcast pushes to every live window, mirroring the connector approval-broker pattern.
const defaultBroadcast = (channel: string, payload: unknown): void => {
  broadcastToRenderers(channel, payload)
}

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
  private readonly fetchImpl?: typeof fetch
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly currentVersion: string
  private readonly manifestUrl: string
  private readonly broadcast: (channel: string, payload: unknown) => void
  private readonly promptSavePath: (defaultFileName: string) => Promise<string | null>
  private readonly fileExists: (path: string) => boolean
  private readonly openPath: (path: string) => Promise<string>
  private readonly openExternal: (url: string) => Promise<void>

  constructor(deps: UpdateServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl
    this.platform = deps.platform ?? process.platform
    this.arch = deps.arch ?? process.arch
    this.currentVersion = deps.currentVersion ?? app.getVersion()
    this.manifestUrl = deps.manifestUrl ?? APP.update.manifestUrl
    this.broadcast = deps.broadcast ?? defaultBroadcast
    this.promptSavePath = deps.promptSavePath ?? ((name) => this.resolveSavePath(name))
    this.fileExists = deps.fileExists ?? existsSync
    this.openPath = deps.openPath ?? ((path) => shell.openPath(path))
    this.openExternal = deps.openExternal ?? ((url) => shell.openExternal(url))
    this.status = { state: 'idle', current: this.currentVersion, applyKind: 'installer' }
  }

  // Platform-aware save location. Windows/Linux write straight to the Downloads folder (no OS
  // permission gate). macOS Downloads is TCC-protected, so a native save panel grants access via
  // implicit consent (no permission prompt) and lets the user confirm the location.
  private async resolveSavePath(defaultFileName: string): Promise<string | null> {
    const downloadsPath = join(app.getPath('downloads'), defaultFileName)
    if (this.platform !== 'darwin') return downloadsPath

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { defaultPath: downloadsPath, title: 'Save the update installer' }
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
    this.setStatus({ state: 'checking', current: this.currentVersion })
    try {
      const manifest = await fetchManifest(this.manifestUrl, this.fetchImpl)
      if (!isNewer(manifest.version, this.currentVersion)) {
        this.setStatus({
          state: 'up-to-date',
          current: this.currentVersion,
          latest: manifest.version
        })
        return this.status
      }
      this.setStatus({
        state: 'available',
        current: this.currentVersion,
        latest: manifest.version,
        notes: manifest.notes,
        download: selectDownload(manifest, this.platform, this.arch) ?? undefined
      })
    } catch (error) {
      this.setStatus({
        state: 'error',
        current: this.currentVersion,
        error: error instanceof Error ? error.message : 'Update check failed'
      })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    // An active download is in flight; ignore repeat clicks / concurrent renderers. The abort claim
    // below is synchronous (before any await) so this guard and a cancel() during the drain both target
    // a consistent slot — a cancel while a retry is still draining must abort it, not be a no-op.
    if (this.downloadAbort) return this.status

    const { download } = this.status
    if (!download) return this.status

    // Defense-in-depth: the sha256 comes from the same manifest as the URL, so it can't catch a
    // tampered manifest pointing at a hostile host. Require the download to stay on the trusted host.
    const trustedHost = new URL(this.manifestUrl).host
    let downloadHost: string
    try {
      downloadHost = new URL(download.url).host
    } catch {
      downloadHost = ''
    }
    if (downloadHost !== trustedHost) {
      this.setStatus({ ...this.status, state: 'error', error: 'Untrusted download host' })
      return this.status
    }

    // Claim the slot synchronously, before any await, so a concurrent download() is rejected and a
    // cancel() during the drain (below) aborts this download instead of being a no-op.
    const previous = this.downloadLifecycle
    const abort = new AbortController()
    this.downloadAbort = abort

    const lifecycle = (async () => {
      try {
        // Drain any prior (e.g. just-cancelled) download so its partial-file rm can't delete a same-path
        // retry's installer. Swallow its outcome — it is owned by its own lifecycle.
        if (previous) await previous.catch(() => {})
        // A cancel() during the drain means never start this download.
        if (abort.signal.aborted) return

        // Ask where to save (platform-aware). A dialog cancel — or a cancel() during the prompt —
        // leaves the status untouched (stays 'available').
        const targetPath = await this.promptSavePath(installerFileName(download.url))
        if (!targetPath || abort.signal.aborted) return

        this.setStatus({ ...this.status, state: 'downloading', progress: 0 })
        const localPath = await downloadInstaller(download, targetPath, {
          fetchImpl: this.fetchImpl,
          onProgress: (percent) => this.broadcast('update:progress', percent),
          signal: abort.signal
        })
        this.setStatus({ ...this.status, state: 'ready', progress: 100, localPath })
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
        }
      } finally {
        if (this.downloadAbort === abort) this.downloadAbort = undefined
      }
    })()
    this.downloadLifecycle = lifecycle
    try {
      await lifecycle
    } finally {
      if (this.downloadLifecycle === lifecycle) this.downloadLifecycle = undefined
    }
    return this.status
  }

  // Aborts the in-flight installer download and resets the status to 'available' so the UI leaves the
  // downloading state. No-op when nothing is downloading.
  async cancel(): Promise<UpdateStatus> {
    this.downloadAbort?.abort()
    this.downloadAbort = undefined
    if (this.status.state === 'downloading') {
      this.setStatus({ ...this.status, state: 'available', progress: undefined })
    }
    return this.status
  }

  // Opens the downloaded installer. If the file is gone (e.g. the user deleted it) or fails to open,
  // drop back to 'available' so the user can re-download in place — the download metadata is still on
  // the status. With no installer for this platform at all, send them to the public download page.
  async apply(): Promise<UpdateStatus> {
    const { localPath, download } = this.status
    if (localPath && this.fileExists(localPath)) {
      const error = await this.openPath(localPath)
      if (!error) return this.status
    }
    if (download) {
      this.setStatus({
        ...this.status,
        state: 'available',
        localPath: undefined,
        progress: undefined
      })
    } else {
      await this.openExternal(APP.update.downloadPage)
    }
    return this.status
  }
}
