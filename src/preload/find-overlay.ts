import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  WindowFindAppearance,
  WindowFindRequest,
  WindowFindResult
} from '../shared/window-controls'

// Sandboxed preloads cannot require local chunks emitted by Rollup. Keep this second preload entry's
// runtime constants local so it stays self-contained instead of sharing a chunk with the main preload.
// The dedicated preload tests pin every channel string against the main-process contract.
const WINDOW_FIND_REQUEST_CHANNEL = 'window:find-in-page'
const WINDOW_FIND_CLEAR_CHANNEL = 'window:clear-find-in-page'
const WINDOW_FIND_RESULT_CHANNEL = 'window:find-in-page-result'
const WINDOW_FIND_SHOW_CHANNEL = 'window:find-show'
const WINDOW_FIND_APPEARANCE_CHANNEL = 'window:find-appearance'
const WINDOW_FIND_CLOSE_CHANNEL = 'window:find-close'

type RemoveListener = () => void
type Listener<Payload> = (payload: Payload) => void

const onIpcMessage = <Payload>(channel: string, listener: Listener<Payload>): RemoveListener => {
  const wrappedListener = (_event: IpcRendererEvent, payload: Payload): void => listener(payload)
  ipcRenderer.on(channel, wrappedListener)
  return () => ipcRenderer.removeListener(channel, wrappedListener)
}

const api = {
  window: {
    findInPage: (request: WindowFindRequest): void =>
      ipcRenderer.send(WINDOW_FIND_REQUEST_CHANNEL, request),
    clearFind: (): void => ipcRenderer.send(WINDOW_FIND_CLEAR_CHANNEL),
    onFindInPageResult: (listener: Listener<WindowFindResult>): RemoveListener =>
      onIpcMessage(WINDOW_FIND_RESULT_CHANNEL, listener),
    onShowWindowFind: (listener: Listener<WindowFindAppearance>): RemoveListener =>
      onIpcMessage(WINDOW_FIND_SHOW_CHANNEL, listener),
    onWindowFindAppearance: (listener: Listener<WindowFindAppearance>): RemoveListener =>
      onIpcMessage(WINDOW_FIND_APPEARANCE_CHANNEL, listener),
    closeFind: (): void => ipcRenderer.send(WINDOW_FIND_CLOSE_CHANNEL)
  }
}

contextBridge.exposeInMainWorld('api', api)
