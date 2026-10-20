import { configureOfficePreviewHost } from './office-preview/application-commands'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from './office-preview/office-preview-electron'
import { printConversationPdf } from './session-persistence/conversation-pdf-electron'
import { join } from 'node:path'
import { installSessionPackageQuitGuard } from './session-package/quit-guard'
import { configureDesktopUpdateStrategy } from './update/runtime-strategy'
import { createUpdateStrategy } from './update/create-strategy'
import { configureDesktopReviewer } from './reviewer/paged-preview-host'
import { createReviewerElectronPagedContentResolver } from './reviewer/paged-preview-electron'
import { app, BrowserWindow, dialog, shell, webContents, Notification } from 'electron'
import { configureDesktopInteraction } from './desktop-interaction'

export function installElectronInteraction(): void {
  configureOfficePreviewHost({
    resolveFrame: async (clientId, runtimeUrl) =>
      createOfficePreviewFrameProcessResolver(webContents)(Number(clientId), runtimeUrl),
    processMemory: async (processId) => createOfficePreviewProcessMemoryReader(app)(processId)
  })
  configureDesktopUpdateStrategy(createUpdateStrategy)
  configureDesktopReviewer(createReviewerElectronPagedContentResolver)
  configureDesktopInteraction({
    cliLauncherEnvironment: () => ({
      platform: process.platform,
      appExecPath: process.execPath,
      cliEntryPath: app.isPackaged
        ? join(process.resourcesPath, 'cli', 'index.mjs')
        : join(app.getAppPath(), 'cli', 'index.mjs'),
      appImagePath: process.env.APPIMAGE,
      packaged: app.isPackaged,
      homeDir: app.getPath('home'),
      userDataDir: app.getPath('userData'),
      pathVar: process.env.PATH ?? ''
    }),
    installPackageQuitGuard: (active, blocked) =>
      installSessionPackageQuitGuard(app, active, blocked),
    notificationCtor: Notification,
    hasFocusedWindow: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    hasWindow: () => BrowserWindow.getAllWindows().length > 0,
    printConversationPdf,
    chooseFiles: dialog.showOpenDialog.bind(dialog),
    chooseSavePath: dialog.showSaveDialog.bind(dialog),
    chooseSavePathForCaller: async (callerId, options) => {
      if (callerId === undefined) return dialog.showSaveDialog(options)
      const id = Number(callerId)
      const sender = Number.isSafeInteger(id) && id > 0 ? webContents.fromId(id) : undefined
      const parent = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null
      if (!parent || parent.isDestroyed())
        throw new Error('Desktop command window is no longer available.')
      return dialog.showSaveDialog(parent, options)
    },
    confirm: dialog.showMessageBox.bind(dialog),
    confirmSync: dialog.showMessageBoxSync.bind(dialog),
    openPath: shell.openPath.bind(shell),
    revealPath: shell.showItemInFolder.bind(shell),
    openExternal: shell.openExternal.bind(shell),
    sender: (id) => webContents.fromId(id),
    parentWindow: (sender) => BrowserWindow.fromWebContents(sender)
  })
}
