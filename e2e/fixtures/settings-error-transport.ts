import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { ApplicationCommandError } from '../../src/shared/application-command-contract'
import { configureIpcHandlerRegistry } from '../../src/main/ipc-handler-registry'
import { installDesktopRuntimeElectronAdapter } from '../../src/main/desktop-runtime-electron-adapter'

// Inject at the backend-client boundary; both Electron serialization boundaries and the
// production preload are real. Snapshot-owner classification is covered in its module suite.
void app.whenReady().then(async () => {
  configureIpcHandlerRegistry(ipcMain)
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs')
    }
  })
  installDesktopRuntimeElectronAdapter(
    {
      commandNames: () => ['settings:get-settings'],
      invoke: async () => {
        switch (process.env.SETTINGS_TRANSPORT_FAULT) {
          case 'storage':
            throw new ApplicationCommandError(
              'settings-storage-unavailable',
              'Settings read failed.'
            )
          case 'invalid':
            throw new ApplicationCommandError('settings-invalid', 'Settings read failed.')
          case 'credential':
            throw new ApplicationCommandError(
              'settings-credential-unavailable',
              'Settings read failed.'
            )
          default:
            return { providers: [], revision: 7 }
        }
      },
      release: () => undefined
    },
    (sender) => sender === window.webContents
  )
  await window.loadURL('data:text/html,<title>Settings transport regression</title>')
})
