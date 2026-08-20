import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  WINDOW_FIND_APPEARANCE_CHANNEL,
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_RESULT_CHANNEL,
  WINDOW_FIND_SHOW_CHANNEL,
  type WindowFindAppearance,
  type WindowFindRequest,
  type WindowFindResult
} from '../shared/window-controls'

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
