import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { NativeActionMenuRequest, NativeActionMenuResult } from '../shared/action-menu-overlay'

// Keep this sandboxed entry self-contained; the menu gets no general application API.
contextBridge.exposeInMainWorld('actionMenu', {
  onShow: (listener: (request: NativeActionMenuRequest) => void) => {
    const handler = (_event: IpcRendererEvent, request: NativeActionMenuRequest): void =>
      listener(request)
    ipcRenderer.on('action-menu:show', handler)
    return () => ipcRenderer.removeListener('action-menu:show', handler)
  },
  onHide: (listener: (id: string) => void) => {
    const handler = (_event: IpcRendererEvent, id: string): void => listener(id)
    ipcRenderer.on('action-menu:hide', handler)
    return () => ipcRenderer.removeListener('action-menu:hide', handler)
  },
  mounted: () => ipcRenderer.send('action-menu:mounted'),
  ready: (id: string) => ipcRenderer.send('action-menu:ready', id),
  result: (result: NativeActionMenuResult) => ipcRenderer.send('action-menu:result', result)
})
