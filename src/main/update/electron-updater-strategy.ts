import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateStatus } from '../../shared/update'
import type { UpdateStrategy } from './strategy'

// Structural subset of electron-updater's autoUpdater we depend on, so tests can inject a fake without
// pulling a real Electron runtime.
export interface MinimalAutoUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export type ElectronUpdaterDeps = {
  updater?: MinimalAutoUpdater
  currentVersion?: string
  broadcast?: (channel: string, payload: unknown) => void
}

// Default broadcast pushes to every live window (mirrors service.ts). Never runs in unit tests, which
// inject their own broadcast.
const defaultBroadcast = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
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

// win/linux strategy: wraps electron-updater for true in-place download + restart. Emits the same
// UpdateStatus shape as UpdateService, always stamped applyKind:'restart'. Opt-in: autoDownload and
// autoInstallOnAppQuit are disabled so nothing downloads/installs without a user action.
export class ElectronUpdaterStrategy implements UpdateStrategy {
  private readonly updater: MinimalAutoUpdater
  private readonly currentVersion: string
  private readonly broadcast: (channel: string, payload: unknown) => void
  private status: UpdateStatus

  constructor(deps: ElectronUpdaterDeps = {}) {
    this.updater = deps.updater ?? (autoUpdater as unknown as MinimalAutoUpdater)
    this.currentVersion = deps.currentVersion ?? app?.getVersion?.() ?? '0.0.0'
    this.broadcast = deps.broadcast ?? defaultBroadcast
    this.status = { state: 'idle', current: this.currentVersion, applyKind: 'restart' }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.subscribe()
  }

  private subscribe(): void {
    this.updater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    this.updater.on('update-available', (info) => {
      const i = info as { version?: string; releaseNotes?: unknown }
      this.setStatus({
        state: 'available',
        latest: i.version,
        notes: notesToString(i.releaseNotes)
      })
    })
    this.updater.on('update-not-available', (info) => {
      const i = info as { version?: string }
      this.setStatus({ state: 'up-to-date', latest: i.version })
    })
    this.updater.on('download-progress', (p) => {
      const percent = Math.round((p as { percent?: number }).percent ?? 0)
      this.broadcast('update:progress', percent)
      this.setStatus({ ...this.status, state: 'downloading', progress: percent })
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

  async check(): Promise<UpdateStatus> {
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : 'Update check failed'
      })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    this.setStatus({ ...this.status, state: 'downloading', progress: 0 })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : 'Download failed'
      })
    }
    return this.status
  }

  async apply(): Promise<UpdateStatus> {
    this.updater.quitAndInstall()
    return this.status
  }
}
