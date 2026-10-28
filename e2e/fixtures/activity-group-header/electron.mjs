import { app, BrowserWindow } from 'electron'

// A renderer-only host: no application database, provider, or Notebook runtime is started.
app.setPath('userData', process.env.OPEN_SCIENCE_USER_DATA)
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    useContentSize: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
  })
  window.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
