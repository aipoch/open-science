/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Sandboxed Electron preloads require standalone CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')
// A fixed, read-only progress bridge; no general IPC or filesystem API reaches this renderer.
contextBridge.exposeInMainWorld('migrationProgress', {
  getState: () => ipcRenderer.invoke('migration-progress:get'),
  subscribe: (listener) => {
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('migration-progress:state', receive)
    return () => ipcRenderer.removeListener('migration-progress:state', receive)
  },
  painted: () => ipcRenderer.send('migration-progress:painted'),
  close: () => ipcRenderer.send('migration-progress:close'),
  copyDiagnostics: () => ipcRenderer.invoke('migration-progress:copy')
})
