import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

import {
  SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL,
  type SessionPersistenceFlushRequest,
  type SessionPersistenceFlushResponse
} from '../../shared/session-persistence-flush'

type RendererSessionPersistenceFlushDeps = {
  isRendererAvailable: () => boolean
  sendRequest: (requestId: string) => void
  onResponse: (listener: (response: SessionPersistenceFlushResponse) => void) => () => void
  onRendererGone: (listener: () => void) => () => void
  createRequestId: () => string
  timeoutMs: number
}

const DEFAULT_RENDERER_FLUSH_TIMEOUT_MS = 5_000

export type RendererSessionPersistenceFlushOutcome =
  | 'completed'
  | 'conflict'
  | 'renderer-failed'
  | 'unavailable'
  | 'renderer-gone'
  | 'send-failed'
  | 'timeout'

export type RendererSessionPersistenceFlushPolicy = 'ordinary-shutdown' | 'data-root-handoff'

export const rendererSessionPersistenceFlushBlocksShutdown = (
  outcome: RendererSessionPersistenceFlushOutcome,
  policy: RendererSessionPersistenceFlushPolicy = 'ordinary-shutdown'
): boolean => {
  if (policy === 'data-root-handoff') return outcome !== 'completed'
  return outcome === 'conflict' || outcome === 'renderer-failed'
}

export const requestRendererSessionPersistenceFlush = async (
  deps: RendererSessionPersistenceFlushDeps
): Promise<RendererSessionPersistenceFlushOutcome> => {
  if (!deps.isRendererAvailable()) return 'unavailable'

  const requestId = deps.createRequestId()
  return new Promise<RendererSessionPersistenceFlushOutcome>((resolve) => {
    let settled = false
    let removeResponse = (): void => undefined
    let removeRendererGone = (): void => undefined
    const finish = (outcome: RendererSessionPersistenceFlushOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeResponse()
      removeRendererGone()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), deps.timeoutMs)
    removeResponse = deps.onResponse((response) => {
      if (response.requestId !== requestId) return
      if (response.status === 'completed' || response.status === 'conflict') {
        finish(response.status)
        return
      }
      finish('renderer-failed')
    })
    removeRendererGone = deps.onRendererGone(() => finish('renderer-gone'))

    try {
      deps.sendRequest(requestId)
    } catch {
      finish('send-failed')
    }
  })
}

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
  getWindow: () => BrowserWindow | undefined
): void => {
  const window = getWindow()
  const webContents = window?.webContents
  if (!window || window.isDestroyed() || !webContents || webContents.isDestroyed()) return
  webContents.send(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL)
}
