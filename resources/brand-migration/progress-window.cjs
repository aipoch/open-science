/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- This unpacked Electron entry runs as CommonJS without a TypeScript loader. */
/* A disposable Electron UI: no application settings, database, session or logger imports. */
const { app, BrowserWindow, ipcMain, clipboard, nativeTheme } = require('electron')
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const temporary = mkdtempSync(join(tmpdir(), 'open-science-migration-ui-'))
// Configure every persistent Chromium path before ready; a memory partition alone is insufficient.
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = join(temporary, name)
  mkdirSync(directory)
  app.setPath(name, directory)
}
app.commandLine.appendSwitch('user-data-dir', join(temporary, 'userData'))
app.commandLine.appendSwitch('disk-cache-dir', join(temporary, 'cache'))
app.setName('Open-Science')
let window
let finished = false
let readySent = false
let state = {
  phase: 'checking',
  startedAt: Date.now(),
  updatedAt: Date.now(),
  locale: process.env.OPEN_SCIENCE_MIGRATION_LOCALE || 'system'
}
const send = (message) => {
  if (process.connected) process.send(message)
}
const broadcast = () => {
  if (window && !window.isDestroyed()) window.webContents.send('migration-progress:state', state)
}
const blocked = (error) => {
  finished = true
  state = { ...state, phase: 'failed', error, updatedAt: Date.now() }
  broadcast()
}
process.on('message', (message) => {
  if (message?.type === 'progress' && !finished) {
    state = {
      ...state,
      ...message.event,
      completed: message.event.completed,
      total: message.event.total,
      updatedAt: Date.now()
    }
    broadcast()
  } else if (message?.type === 'failed') blocked(String(message.error))
  else if (message?.type === 'complete') {
    finished = true
    app.quit()
  }
})
// A hard interruption leaves the error surface visible and the on-disk transaction recoverable.
process.on('disconnect', () => {
  if (!finished) blocked('migration-worker-disconnected')
})
app.on('before-quit', (event) => {
  if (!finished) event.preventDefault()
})
app.on('will-quit', () => {
  // Only this helper's freshly created temporary tree is ever removed.
  try {
    rmSync(temporary, { recursive: true, force: true })
  } catch {
    /* OS may still hold a cache file. */
  }
})
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 720,
      height: 640,
      minWidth: 460,
      minHeight: 460,
      show: false,
      title: 'Open-Science',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff',
      webPreferences: {
        preload: join(__dirname, 'progress-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: 'migration-progress'
      }
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => {
      // Losing the visible surface must stop the worker at its next progress/safety boundary.
      process.stderr.write('Migration progress renderer exited unexpectedly\n')
      finished = true
      app.quit()
    })
    window.on('close', (event) => {
      if (!finished) event.preventDefault()
    })
    const owns = (event) =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    ipcMain.handle('migration-progress:get', (event) => (owns(event) ? state : undefined))
    ipcMain.handle('migration-progress:copy', (event) => {
      if (owns(event) && finished) clipboard.writeText(JSON.stringify(state, null, 2))
    })
    ipcMain.on('migration-progress:close', (event) => {
      if (owns(event) && finished) app.quit()
    })
    ipcMain.on('migration-progress:painted', (event) => {
      if (!owns(event) || readySent) return
      readySent = true
      window.show()
      send({ type: 'processes', pids: app.getAppMetrics().map((m) => m.pid) })
      process.stderr.write('[brand-migration-ui] ready\n')
      send({ type: 'ready' })
    })
    const monitor = setInterval(() => {
      send({ type: 'processes', pids: app.getAppMetrics().map((m) => m.pid) })
      if (!finished)
        process.stderr.write(
          `[brand-migration] ${JSON.stringify({ phase: state.phase, heartbeat: true, elapsedMs: Date.now() - state.startedAt, lastUpdateMs: Date.now() - state.updatedAt })}\n`
        )
    }, 10000)
    monitor.unref()
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
      await window.loadURL(
        new URL('migration-progress.html', process.env.ELECTRON_RENDERER_URL + '/').href
      )
    else {
      // The helper is unpacked, whereas renderer assets remain inside app.asar in packaged builds.
      const root = join(__dirname, '..', '..').replace(/\.asar\.unpacked$/, '.asar')
      await window.loadFile(join(root, 'out', 'renderer', 'migration-progress.html'))
    }
  })
  .catch((error) => {
    process.stderr.write(`Migration progress UI failed: ${error.message}\n`)
    finished = true
    app.exit(1)
  })
