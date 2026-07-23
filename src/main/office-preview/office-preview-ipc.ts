import { BrowserWindow, ipcMain } from 'electron'

import type { OfficePreviewOpenRequest } from '../../shared/office-preview'
import {
  isOfficePreviewBounds,
  OFFICE_PREVIEW_CLOSE_CHANNEL,
  OFFICE_PREVIEW_OPEN_CHANNEL,
  OFFICE_PREVIEW_SET_BOUNDS_CHANNEL
} from '../../shared/office-preview'
import type { OfficePreviewSupervisor } from './office-preview-supervisor'
import { OfficePreviewOpenSupersededError } from './office-preview-supervisor'

type OfficePreviewSupervisorPort = Pick<
  OfficePreviewSupervisor,
  'open' | 'setBounds' | 'resizeOwner' | 'close' | 'closeOwner'
>

const registerOfficePreviewIpcHandlers = (supervisor: OfficePreviewSupervisorPort): void => {
  const trackedOwners = new Map<
    number,
    {
      sender: Electron.WebContents
      ownerWindow: Electron.BrowserWindow | null
      resizeOwner: () => void
    }
  >()
  // Ownership always comes from Electron's sender; renderer payloads never select another owner.
  ipcMain.handle(OFFICE_PREVIEW_OPEN_CHANNEL, (event, request: OfficePreviewOpenRequest) => {
    const ownerId = event.sender.id
    if (trackedOwners.get(ownerId)?.sender !== event.sender) {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      const resizeOwner = (): void => {
        if (!ownerWindow || ownerWindow.isDestroyed()) return
        const [width, height] = ownerWindow.getContentSize()
        try {
          supervisor.resizeOwner(ownerId, { width, height })
        } catch (error) {
          console.error('Failed to resize the Office preview owner', error)
        }
      }
      trackedOwners.set(ownerId, { sender: event.sender, ownerWindow, resizeOwner })
      ownerWindow?.on('resize', resizeOwner)
      let closed = false
      const closeOwner = (): void => {
        if (closed || trackedOwners.get(ownerId)?.sender !== event.sender) return
        closed = true
        ownerWindow?.removeListener('resize', resizeOwner)
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
  // Bounds are one-way transient state; only open/close commands need invoke/handle replies.
  ipcMain.on(OFFICE_PREVIEW_SET_BOUNDS_CHANNEL, (event, sessionId: unknown, bounds: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || !isOfficePreviewBounds(bounds)) return

    try {
      supervisor.setBounds(event.sender.id, sessionId, bounds)
    } catch (error) {
      console.error('Failed to update Office preview bounds', error)
    }
  })
  ipcMain.handle(OFFICE_PREVIEW_CLOSE_CHANNEL, (event, sessionId: string) =>
    supervisor.close(event.sender.id, sessionId)
  )
}

export { registerOfficePreviewIpcHandlers }
export type { OfficePreviewSupervisorPort }
