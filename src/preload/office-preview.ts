import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { OfficePreviewRuntimeStart, OfficePreviewRuntimeState } from '../shared/office-preview'

// Keep this sandbox preload self-contained; Electron cannot require a relative shared chunk here.
const OFFICE_PREVIEW_RUNTIME_START_CHANNEL = 'office-preview-runtime:start'
const OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL = 'office-preview-runtime:state'

type OfficePreviewRuntimeBridge = {
  onStart: (listener: (start: OfficePreviewRuntimeStart) => void) => () => void
  reportState: (state: OfficePreviewRuntimeState) => void
}

const bridge: OfficePreviewRuntimeBridge = {
  onStart: (listener) => {
    const wrapped = (_event: IpcRendererEvent, start: OfficePreviewRuntimeStart): void =>
      listener(start)
    ipcRenderer.on(OFFICE_PREVIEW_RUNTIME_START_CHANNEL, wrapped)
    return () => ipcRenderer.removeListener(OFFICE_PREVIEW_RUNTIME_START_CHANNEL, wrapped)
  },
  reportState: (state) => ipcRenderer.send(OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL, state)
}

// The isolated renderer receives no general application API or filesystem path access.
contextBridge.exposeInMainWorld('officePreviewRuntime', bridge)

export type { OfficePreviewRuntimeBridge }
