import { fileURLToPath } from 'node:url'

import { ARTIFACT_MCP_SERVER_ARG, runArtifactMcpServer } from './artifacts/mcp-server'
import { NOTEBOOK_MCP_SERVER_ARG, runNotebookMcpServer } from './notebook/mcp-server'

const APP_NAME = 'Open Science'
const APP_USER_MODEL_ID = 'com.aipoch.open-science'
const shouldRunArtifactMcpServer = process.argv.includes(ARTIFACT_MCP_SERVER_ARG)
const shouldRunNotebookMcpServer = process.argv.includes(NOTEBOOK_MCP_SERVER_ARG)

if (shouldRunArtifactMcpServer) {
  // Reuse the packaged entry point as a Node stdio MCP server before Electron modules are imported.
  runArtifactMcpServer().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
} else if (shouldRunNotebookMcpServer) {
  // Keep notebook MCP mode as a Node stdio process that proxies to the app-owned runtime.
  runNotebookMcpServer().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  void startElectronApp(fileURLToPath(import.meta.url)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

// Boots the Electron app only in normal UI mode, keeping artifact MCP mode free of Electron imports.
async function startElectronApp(mainEntryPath: string): Promise<void> {
  const [{ app, BrowserWindow, nativeImage }, { electronApp, optimizer }, { default: icon }] =
    await Promise.all([
      import('electron'),
      import('@electron-toolkit/utils'),
      import('../../resources/icon.png?asset')
    ])
  const [{ registerIpcHandlers }, { createMainWindow }] = await Promise.all([
    import('./ipc'),
    import('./windows')
  ])

  app.setName(APP_NAME)

  await app.whenReady()

  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)

  // Dev builds use the app icon for the macOS dock.
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(icon)
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon)
    }
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Pass the concrete main entry path so ACP can launch the artifact MCP server from the same bundle.
  registerIpcHandlers({ mainEntryPath })

  createMainWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
