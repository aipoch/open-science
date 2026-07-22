import { ipcMain } from 'electron'

import type { OfficePreviewBounds, OfficePreviewOpenRequest } from '../../shared/office-preview'
import {
  OFFICE_PREVIEW_CLOSE_CHANNEL,
  OFFICE_PREVIEW_OPEN_CHANNEL,
  OFFICE_PREVIEW_SET_BOUNDS_CHANNEL
} from '../../shared/office-preview'
import type { OfficePreviewSupervisor } from './office-preview-supervisor'
import { OfficePreviewOpenSupersededError } from './office-preview-supervisor'

type OfficePreviewSupervisorPort = Pick<
  OfficePreviewSupervisor,
  'open' | 'setBounds' | 'close' | 'closeOwner'
>

const registerOfficePreviewIpcHandlers = (supervisor: OfficePreviewSupervisorPort): void => {
  const trackedOwners = new Map<number, Electron.WebContents>()
  // Ownership always comes from Electron's sender; renderer payloads never select another owner.
  ipcMain.handle(OFFICE_PREVIEW_OPEN_CHANNEL, (event, request: OfficePreviewOpenRequest) => {
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
  ipcMain.handle(
    OFFICE_PREVIEW_SET_BOUNDS_CHANNEL,
    (event, sessionId: string, bounds: OfficePreviewBounds) =>
      supervisor.setBounds(event.sender.id, sessionId, bounds)
  )
  ipcMain.handle(OFFICE_PREVIEW_CLOSE_CHANNEL, (event, sessionId: string) =>
    supervisor.close(event.sender.id, sessionId)
  )
}

export { registerOfficePreviewIpcHandlers }
export type { OfficePreviewSupervisorPort }
