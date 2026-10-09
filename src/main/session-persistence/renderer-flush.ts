import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

import {
  SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL,
  type SessionPersistenceFlushAbortedEvent,
  type SessionPersistenceFlushRequest,
  type SessionPersistenceFlushResponse
} from '../../shared/session-persistence-flush'

import {
  DEFAULT_RENDERER_FLUSH_TIMEOUT_MS,
  requestRendererSessionPersistenceFlush,
  type RendererSessionPersistenceFlushOutcome
} from './flush-protocol'
export * from './flush-protocol'

export const createElectronSessionPersistenceFlush = (
  getWindow: () => BrowserWindow | undefined,
  timeoutMs = DEFAULT_RENDERER_FLUSH_TIMEOUT_MS
): ((timeoutOverrideMs?: number) => Promise<RendererSessionPersistenceFlushOutcome>) => {
  return (timeoutOverrideMs) => {
    const window = getWindow()
    const webContents = window?.webContents
    return requestRendererSessionPersistenceFlush({
      isRendererAvailable: () =>
        Boolean(window && !window.isDestroyed() && webContents && !webContents.isDestroyed()),
      sendRequest: (requestId) => {
        const request: SessionPersistenceFlushRequest = { requestId }
        webContents?.send(SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL, request)
      },
      onResponse: (listener) => {
        const handler = (
          event: Electron.IpcMainEvent,
          response: SessionPersistenceFlushResponse | undefined
        ): void => {
          if (event.sender !== webContents || typeof response?.requestId !== 'string') return
          listener(response)
        }
        ipcMain.on(SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL, handler)
        return () => ipcMain.removeListener(SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL, handler)
      },
      onRendererGone: (listener) => {
        webContents?.on('render-process-gone', listener)
        return () => webContents?.removeListener('render-process-gone', listener)
      },
      createRequestId: randomUUID,
      timeoutMs: timeoutOverrideMs ?? timeoutMs
    })
  }
}

export const notifyRendererSessionPersistenceFlushAborted = (
  getWindow: () => BrowserWindow | undefined,
  reason?: SessionPersistenceFlushAbortedEvent['reason']
): void => {
  const window = getWindow()
  const webContents = window?.webContents
  if (!window || window.isDestroyed() || !webContents || webContents.isDestroyed()) return
  if (reason) {
    webContents.send(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL, {
      reason
    } satisfies SessionPersistenceFlushAbortedEvent)
    return
  }
  webContents.send(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL)
}
