import { broadcastToRenderers } from '../renderer-broadcast'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import type { UploadCommandOwner } from '../uploads/command-owner'
import { registerUploadIpcHandlers } from '../uploads/ipc'
import { createElectronSurfaceAdapter } from './adapter'

export const createUploadElectronSurface = (
  owner: UploadCommandOwner
): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('uploads', () =>
    registerUploadIpcHandlers(owner, {
      // Standalone "Save as artifact" uploads have no session mutation to piggyback on, so the
      // Files panel only learns about them through this broadcast.
      onStandaloneUploadSaved: (projectId, sessionId) =>
        broadcastToRenderers('project-files:changed', {
          projectId,
          sessionId,
          sources: ['upload'],
          kind: 'upsert'
        })
    })
  )
