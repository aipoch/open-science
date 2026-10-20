import { app, BrowserWindow } from 'electron'

// The isolated frame host has a fixed software rasterizer. GPU path caching can change a few
// anti-aliased rounded-edge pixels between cold and warm frames of the same logical scene.
// This is an export-host condition; the normal interactive application retains GPU acceleration.
app.disableHardwareAcceleration()
app.setPath('userData', process.env.REPLAY_STAGE_USER_DATA)
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
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
