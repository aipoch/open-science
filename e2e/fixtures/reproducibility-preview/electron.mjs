import { app, BrowserWindow } from 'electron'

app.setPath('userData', process.env.REPRO_PREVIEW_USER_DATA)
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  window.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
