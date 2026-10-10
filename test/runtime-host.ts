import { afterAll } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { configureRuntimeNetwork } from '../src/main/runtime-network'
import { configureTestRuntimeMetadata } from './runtime-metadata'

// Connector tests replace global fetch or use their own loopback server, without Chromium.
export function configureTestRuntimeNetwork(): void {
  const unsupported = async (): Promise<never> => {
    throw new Error('Test must provide proxy behavior explicitly.')
  }
  configureRuntimeNetwork({
    fetch: (...args) => fetch(...args),
    fetchWithManualRedirect: (...args) => fetch(...args),
    resolveProxy: unsupported,
    setProxy: unsupported
  })
}

export async function configureTestElectronHost(
  electron: Partial<typeof import('electron')>
): Promise<void> {
  if ('app' in electron) {
    const app = electron.app!
    if (app.quit) {
      const { configureRuntimeLifecycle } = await import('../src/main/runtime-lifecycle')
      configureRuntimeLifecycle({
        relaunch: () => app.relaunch(),
        quit: () => app.quit(),
        exit: (code) => app.exit(code)
      })
    }
    configureTestRuntimeMetadata(() => ({
      packaged: app.isPackaged ?? false,
      applicationPath: app.getAppPath?.() ?? process.cwd(),
      homePath: app.getPath?.('home') ?? homedir(),
      downloadsPath: app.getPath?.('downloads') ?? resolve('Downloads'),
      version: app.getVersion?.() ?? '0.0.0-test',
      locale: app.getLocale?.() ?? 'en-US'
    }))
  } else configureTestRuntimeMetadata()
  if ('safeStorage' in electron) {
    const { configureSecureStorageCipher } = await import('../src/main/secure-storage')
    configureSecureStorageCipher(electron.safeStorage!)
  }
  if ('ipcMain' in electron) {
    const { configureIpcHandlerRegistry } = await import('../src/main/ipc-handler-registry')
    configureIpcHandlerRegistry(electron.ipcMain!)
  }
  if ('net' in electron || 'session' in electron) {
    const { configureRuntimeNetwork } = await import('../src/main/runtime-network')
    configureRuntimeNetwork({
      fetch: (input, init) => electron.net!.fetch(input instanceof URL ? input.href : input, init),
      fetchWithManualRedirect: (input, init) =>
        electron.net!.fetch(input instanceof URL ? input.href : input, init),
      resolveProxy: (url) => electron.session!.defaultSession.resolveProxy(url),
      setProxy: (config) => electron.session!.defaultSession.setProxy(config)
    })
  }
  if ('BrowserWindow' in electron) {
    const { installElectronBroadcast } = await import('../src/main/renderer-broadcast-electron')
    const remove = installElectronBroadcast()
    afterAll(remove)
  }
  if ('dialog' in electron || 'shell' in electron || 'BrowserWindow' in electron) {
    const { configureDesktopInteraction } = await import('../src/main/desktop-interaction')
    const dialog = 'dialog' in electron ? electron.dialog : undefined
    const unavailable = (): never => {
      throw new Error('Test must provide this desktop capability.')
    }
    configureDesktopInteraction({
      chooseFiles: dialog?.showOpenDialog?.bind(dialog) ?? unavailable,
      chooseSavePath: dialog?.showSaveDialog?.bind(dialog) ?? unavailable,
      confirm: dialog?.showMessageBox?.bind(dialog) ?? unavailable,
      confirmSync: dialog?.showMessageBoxSync?.bind(dialog) ?? unavailable,
      openPath: (path) => electron.shell!.openPath(path),
      revealPath: (path) => electron.shell!.showItemInFolder(path),
      openExternal: (url) => electron.shell!.openExternal(url),
      printConversationPdf: unavailable,
      chooseSavePathForCaller: async (callerId, options) => {
        if (callerId === undefined) return dialog!.showSaveDialog(options)
        const parent = electron.BrowserWindow!.fromWebContents(
          electron.webContents!.fromId(Number(callerId))!
        )
        if (!parent) throw new Error('Test must provide a calling window.')
        return dialog!.showSaveDialog(parent, options)
      },
      sender: (id) => electron.webContents!.fromId(id),
      parentWindow: (sender) => electron.BrowserWindow!.fromWebContents(sender),
      hasWindow: () => electron.BrowserWindow!.getAllWindows().length > 0,
      hasFocusedWindow: () =>
        electron.BrowserWindow!.getAllWindows().some((window) => window.isFocused()),
      notificationCtor: 'Notification' in electron ? electron.Notification! : (undefined as never),
      cliLauncherEnvironment: () => {
        throw new Error('Test must provide a CLI launcher environment.')
      },
      installPackageQuitGuard: () => {
        throw new Error('Test must provide a package quit guard.')
      }
    })
  }
}
