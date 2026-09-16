import { accessSync, constants } from 'node:fs'
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

import {
  MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
  MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL,
  MAC_INSTALLATION_RESUME_UPDATE_ARG,
  type MacInstallationAssistantAction,
  type MacInstallationAssistantResult
} from '../shared/mac-installation'
import { createLogger, diagnosticErrorFields } from './logger'

export type InstallationLocation = 'writable' | 'read-only' | 'unknown'

const assistantEntry = join(__dirname, '../renderer/installation-assistant.html')
const assistantPreloadEntry = join(__dirname, '../preload/installation-assistant.js')
const log = createLogger('update')
const runFile = promisify(execFile)

// access(2) returns EROFS on an actual read-only volume. Permission denial is not evidence of
// a read-only disk, and /Volumes also contains perfectly writable external installations.
export const inspectInstallationLocation = (
  bundlePath: string,
  checkAccess: typeof accessSync = accessSync
): InstallationLocation => {
  try {
    checkAccess(bundlePath, constants.W_OK)
    return 'writable'
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EROFS' ? 'read-only' : 'unknown'
  }
}

const runningBundle = (): string => resolve(dirname(app.getPath('exe')), '../..')
const installedBundle = (): string => join('/Applications', basename(runningBundle()))

export const isReadOnlyMacInstallation = (): boolean => {
  if (process.platform !== 'darwin' || !app?.isPackaged) return false
  try {
    return inspectInstallationLocation(runningBundle()) === 'read-only'
  } catch {
    return false
  }
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

// Stage the complete signed bundle beside its destination before replacing an older installation.
// A failed final rename restores the previous app; cleanup failure only leaves a hidden staging
// directory and does not turn a completed installation into a reported failure.
const performMacInstallation = async (
  sourceBundle: string,
  applicationsDirectory: string
): Promise<string> => {
  const bundleName = basename(sourceBundle)
  if (!bundleName.endsWith('.app')) throw new Error('The running application bundle is invalid.')

  const destination = join(applicationsDirectory, bundleName)
  const stagingRoot = await mkdtemp(join(applicationsDirectory, '.open-science-install-'))
  const stagedBundle = join(stagingRoot, bundleName)
  const previousBundle = join(stagingRoot, 'previous.app')
  let previousMoved = false
  let preserveStaging = false

  try {
    // Electron's fs adapter treats app.asar as a directory. Copy outside that adapter so the
    // archive stays intact and macOS bundle metadata and relative framework symlinks survive.
    await runFile('/usr/bin/ditto', [sourceBundle, stagedBundle])

    if (await pathExists(destination)) {
      await rename(destination, previousBundle)
      previousMoved = true
    }

    try {
      await rename(stagedBundle, destination)
    } catch (error) {
      if (previousMoved) {
        try {
          await rename(previousBundle, destination)
        } catch (restoreError) {
          preserveStaging = true
          log.error('previous application restore failed', diagnosticErrorFields(restoreError))
        }
      }
      throw error
    }

    return destination
  } finally {
    if (!preserveStaging) {
      await rm(stagingRoot, { recursive: true, force: true }).catch((error) => {
        log.warn('application installation staging cleanup failed', diagnosticErrorFields(error))
      })
    }
  }
}

// Installation belongs to the application, not the assistant window. Closing and reopening the
// assistant must join the current transaction rather than replace the same destination in parallel.
const installations = new Map<string, Promise<string>>()

export const installMacApplication = (
  sourceBundle = runningBundle(),
  applicationsDirectory = '/Applications'
): Promise<string> => {
  const destination = resolve(applicationsDirectory, basename(sourceBundle))
  const existing = installations.get(destination)
  if (existing) return existing
  const pending = performMacInstallation(sourceBundle, applicationsDirectory).finally(() => {
    if (installations.get(destination) === pending) installations.delete(destination)
  })
  installations.set(destination, pending)
  return pending
}

let guidanceWindow: BrowserWindow | undefined
let guidance: Promise<void> | undefined
let guidanceReady = false
let guidanceReason: 'startup' | 'update' = 'startup'
let restartInstalledApplication: (() => void) | undefined

// Called only after the normal quit confirmation and persistence gates have completed.
export const completeMacInstallationHandoff = (): void => {
  const restart = restartInstalledApplication
  restartInstalledApplication = undefined
  restart?.()
}

const loadAssistant = (window: BrowserWindow, reason: 'startup' | 'update'): Promise<void> => {
  const developmentRendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (developmentRendererUrl) {
    const url = new URL(
      'installation-assistant.html',
      developmentRendererUrl.endsWith('/') ? developmentRendererUrl : `${developmentRendererUrl}/`
    )
    url.searchParams.set('reason', reason)
    return window.loadURL(url.toString())
  }
  return window.loadFile(assistantEntry, { query: { reason } })
}

const isAssistantAction = (value: unknown): value is MacInstallationAssistantAction =>
  value === 'continue' || value === 'install' || value === 'show-in-finder' || value === 'restart'

// The assistant is non-modal: dismissing it always leaves the DMG copy usable. Repeated startup and
// update requests focus the same window instead of starting overlapping animations or installations.
export const showMacInstallationGuidance = (reason: 'startup' | 'update'): Promise<void> => {
  if (guidanceWindow && !guidanceWindow.isDestroyed()) {
    if (reason === 'update') guidanceReason = 'update'
    if (guidanceReady) {
      guidanceWindow.show()
      guidanceWindow.focus()
    }
    return guidance ?? Promise.resolve()
  }

  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  const window = new BrowserWindow({
    parent,
    width: 640,
    height: 500,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Open-Science',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#fbfcfb',
    webPreferences: {
      preload: assistantPreloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  guidanceWindow = window
  guidanceReason = reason
  guidanceReady = false

  let resolveGuidance: (() => void) | undefined
  const pending = new Promise<void>((resolvePromise) => {
    resolveGuidance = resolvePromise
  })
  guidance = pending
  let installing = false
  let installedPath: string | undefined

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('ipc-message', (_event, channel, value) => {
    if (channel !== MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL || !isAssistantAction(value)) return

    if (value === 'continue') {
      restartInstalledApplication = undefined
      window.close()
      return
    }
    if (value === 'restart') {
      if (!installedPath) return
      const execPath = join(installedPath, 'Contents/MacOS', basename(app.getPath('exe')))
      restartInstalledApplication = () =>
        app.relaunch({
          execPath,
          args: guidanceReason === 'update' ? [MAC_INSTALLATION_RESUME_UPDATE_ARG] : []
        })
      app.quit()
      return
    }
    if (value === 'show-in-finder') {
      void pathExists(installedBundle())
        .then((installed) =>
          shell.showItemInFolder(installed ? installedBundle() : runningBundle())
        )
        .catch((error) => {
          log.warn('application reveal failed', diagnosticErrorFields(error))
        })
      return
    }
    if (installing) return

    installing = true
    void installMacApplication()
      .then((destination) => {
        installedPath = destination
        const result: MacInstallationAssistantResult = { status: 'installed' }
        if (!window.isDestroyed()) {
          window.webContents.send(MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL, result)
        }
      })
      .catch((error) => {
        log.warn('application installation failed', diagnosticErrorFields(error))
        const result: MacInstallationAssistantResult = { status: 'error' }
        if (!window.isDestroyed()) {
          window.webContents.send(MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL, result)
        }
      })
      .finally(() => {
        installing = false
      })
  })

  window.once('ready-to-show', () => {
    guidanceReady = true
    window.show()
    window.focus()
  })
  window.once('closed', () => {
    if (guidanceWindow === window) {
      guidanceWindow = undefined
      guidanceReady = false
    }
    if (guidance === pending) guidance = undefined
    resolveGuidance?.()
  })
  void loadAssistant(window, reason)
    .then(() => {
      window.webContents.on('will-navigate', (event) => event.preventDefault())
    })
    .catch((error) => {
      log.warn('installation assistant unavailable', diagnosticErrorFields(error))
      if (!window.isDestroyed()) window.destroy()
    })
  return pending
}

export const createMacInstallationGuard =
  (): ((interactive: boolean, knownReadOnly?: boolean) => boolean) =>
  (interactive, knownReadOnly = false) => {
    if (!knownReadOnly && !isReadOnlyMacInstallation()) return false
    if (interactive) void showMacInstallationGuidance('update')
    return true
  }

// Electron forwards NSError.code but electron-updater does not consistently preserve its domain.
// Require the specific Squirrel message as well as code and platform, not an arbitrary numeric 8.
export const isMacReadOnlyUpdaterError = (error: unknown, platform: NodeJS.Platform): boolean =>
  platform === 'darwin' &&
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 8 &&
  error.message.startsWith('Cannot update while running on a read-only volume.')
