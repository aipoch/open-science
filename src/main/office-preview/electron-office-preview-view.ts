import { app, BrowserWindow, WebContentsView, ipcMain, webContents } from 'electron'

import type { OfficePreviewRuntimeState } from '../../shared/office-preview'
import { OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL } from '../../shared/office-preview'
import {
  createOfficePreviewViewFactory,
  type PlatformParentWindow,
  type PlatformView,
  type PlatformWebContents
} from './office-preview-view'
import type {
  CreateOfficePreviewViewOptions,
  OfficePreviewChildView
} from './office-preview-supervisor'

type ElectronOfficePreviewViewOptions = {
  preloadPath: string
  runtimeHtmlPath: string
  devServerUrl?: string
  registerPreviewProtocol: (
    targetProtocol: Electron.Protocol,
    isResourceAllowed: (resourceId: string) => boolean
  ) => () => void
}

const createElectronOfficePreviewViewFactory = (
  options: ElectronOfficePreviewViewOptions
): ((options: CreateOfficePreviewViewOptions) => OfficePreviewChildView) => {
  const parentOwnerByChild = new Map<number, number>()
  return createOfficePreviewViewFactory({
    resolveParentWindow: (ownerId) => {
      const parentContents = webContents.fromId(ownerId)
      const parent = parentContents ? BrowserWindow.fromWebContents(parentContents) : null
      if (!parent) return undefined

      return {
        addChildView: (view) => parent.contentView.addChildView(view as never),
        removeChildView: (view) => parent.contentView.removeChildView(view as never)
      } satisfies PlatformParentWindow
    },
    createPlatformView: (sessionId, parentOwnerId) => {
      // A unique in-memory partition prevents Office previews from sharing cookies or storage.
      const view = new WebContentsView({
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: `office-preview-${sessionId}`
        }
      })
      let previewResourceId: string | undefined
      const unregisterPreviewProtocol = options.registerPreviewProtocol(
        view.webContents.session.protocol,
        (resourceId) => resourceId === previewResourceId
      )
      view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      view.webContents.session.setPermissionCheckHandler(() => false)
      const preventDownload = (event: Electron.Event): void => event.preventDefault()
      view.webContents.session.on('will-download', preventDownload)
      const platformView = view as unknown as PlatformView
      parentOwnerByChild.set(view.webContents.id, parentOwnerId)
      platformView.setPreviewResourceId = (resourceId) => {
        previewResourceId = resourceId
      }
      platformView.dispose = () => {
        parentOwnerByChild.delete(view.webContents.id)
        try {
          view.webContents.session.off('will-download', preventDownload)
          view.webContents.session.setPermissionRequestHandler(null)
          view.webContents.session.setPermissionCheckHandler(null)
        } catch {
          // A terminated renderer may have already destroyed its in-memory session.
        }
        try {
          unregisterPreviewProtocol()
        } catch {
          // A destroyed session has already discarded its protocol handlers.
        }
      }
      return platformView
    },
    listenRuntimeState: (listener) => {
      const wrapped = (event: Electron.IpcMainEvent, state: OfficePreviewRuntimeState): void =>
        listener(event.sender.id, state)
      ipcMain.on(OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL, wrapped)
      return () => ipcMain.off(OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL, wrapped)
    },
    getMemoryUsageBytes: (contents) => {
      const liveContents = webContents.fromId(contents.id)
      if (!liveContents) return 0

      const pid = liveContents.getOSProcessId()
      const memory = app.getAppMetrics().find((metric) => metric.pid === pid)?.memory
      const kilobytes = memory?.privateBytes ?? memory?.workingSetSize ?? 0
      return kilobytes * 1024
    },
    loadRuntime: async (contents: PlatformWebContents) => {
      const liveContents = webContents.fromId(contents.id)
      if (!liveContents) throw new Error('Office preview webContents is unavailable')

      if (options.devServerUrl) {
        const runtimeUrl = new URL('office-preview.html', `${options.devServerUrl}/`).toString()
        await liveContents.loadURL(runtimeUrl)
      } else {
        await liveContents.loadFile(options.runtimeHtmlPath)
      }

      const parentOwnerId = parentOwnerByChild.get(contents.id)
      const parentContents = parentOwnerId ? webContents.fromId(parentOwnerId) : undefined
      const childPid = liveContents.getOSProcessId()
      const parentPid = parentContents?.getOSProcessId() ?? 0
      if (childPid > 0 && parentPid > 0 && childPid === parentPid) {
        throw new Error('Office preview did not receive a dedicated renderer process')
      }
    }
  })
}

export { createElectronOfficePreviewViewFactory }
export type { ElectronOfficePreviewViewOptions }
