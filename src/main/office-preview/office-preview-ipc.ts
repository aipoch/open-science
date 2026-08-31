import { ipcMain } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, diagnosticErrorFields } from '../logger'

import type { OfficePreviewOpenRequest } from '../../shared/office-preview'
import {
  isOfficePreviewRuntimeState,
  OFFICE_PREVIEW_ATTACH_FRAME_CHANNEL,
  OFFICE_PREVIEW_CLOSE_CHANNEL,
  OFFICE_PREVIEW_OPEN_CHANNEL,
  OFFICE_PREVIEW_REPORT_STATE_CHANNEL
} from '../../shared/office-preview'
import type { OfficePreviewSupervisor } from './office-preview-supervisor'
import { OfficePreviewOpenSupersededError } from './office-preview-supervisor'

const log = createLogger('office-preview:ipc')

type OfficePreviewSupervisorPort = Pick<
  OfficePreviewSupervisor,
  'open' | 'attachFrame' | 'reportState' | 'close' | 'closeOwner'
>

const registerOfficePreviewIpcHandlers = (supervisor: OfficePreviewSupervisorPort): void => {
  const trackedOwners = new Map<number, Electron.WebContents>()

  // Ownership always comes from Electron's sender; renderer payloads never select another owner.
  ipcMainHandle(OFFICE_PREVIEW_OPEN_CHANNEL, (event, request: OfficePreviewOpenRequest) => {
    const ownerId = event.sender.id
    if (trackedOwners.get(ownerId) !== event.sender) {
      trackedOwners.set(ownerId, event.sender)
      let closed = false
      const closeOwner = (): void => {
        if (closed || trackedOwners.get(ownerId) !== event.sender) return
        closed = true
        trackedOwners.delete(ownerId)
        void supervisor.closeOwner(ownerId)
      }
      event.sender.once('destroyed', closeOwner)
      event.sender.once('render-process-gone', closeOwner)
    }
    return supervisor.open(ownerId, request).catch((error) => {
      // Development remounts and rapid tab changes cancel stale opens without surfacing IPC errors.
      if (error instanceof OfficePreviewOpenSupersededError) return { kind: 'cancelled' } as const
      throw error
    })
  })

  ipcMainHandle(OFFICE_PREVIEW_ATTACH_FRAME_CHANNEL, (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    return supervisor.attachFrame(event.sender.id, sessionId)
  })

  // Runtime state crosses the iframe boundary through the owner renderer and is validated again here.
  ipcMain.on(OFFICE_PREVIEW_REPORT_STATE_CHANNEL, (event, sessionId: unknown, state: unknown) => {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      !isOfficePreviewRuntimeState(state) ||
      state.sessionId !== sessionId
    ) {
      return
    }
    try {
      supervisor.reportState(event.sender.id, sessionId, state)
    } catch (error) {
      log.error('failed to report runtime state', diagnosticErrorFields(error))
    }
  })

  ipcMainHandle(OFFICE_PREVIEW_CLOSE_CHANNEL, (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    return supervisor.close(event.sender.id, sessionId)
  })
}

export { registerOfficePreviewIpcHandlers }
export type { OfficePreviewSupervisorPort }
