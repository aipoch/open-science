import { ipcMain } from 'electron'

import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DeleteSpecialistRequest,
  DuplicateSpecialistRequest,
  CreateSpecialistInput,
  SpecialistListItem,
  SpecialistProfileView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution
} from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { ProfileService } from './service'
import { SessionBindingService } from './session-binding'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'

const log = createLogger('specialist:ipc')

type PersistSessionSpecialist = (
  sessionId: string,
  specialistId: string | undefined
) => Promise<void>

// Broadcasts a catalog-changed event to all renderer windows.
const broadcastCatalogChanged = (): void => {
  broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
}

// Registers all specialist IPC handlers against ipcMain.
// Call once per app lifecycle, after the ProfileService is ready.
export const registerSpecialistIpcHandlers = (
  service: ProfileService,
  sessionBindingService: SessionBindingService,
  // Persists the specialist UUID to the durable session file before exposing the binding to the
  // runtime. Required — an absent writer silently disables durability, which is the same failure
  // shape the previous TODO introduced. Tests pass a vi.fn() mock; headless callers may pass an
  // explicit no-op if session persistence is unavailable in their environment.
  persistSessionSpecialist: PersistSessionSpecialist,
  // Applies a switch to the live agent runtime. Kept as a callback so this module stays decoupled
  // from the ACP coordinator. Returns whether the runtime replaced the agent session (context reset),
  // which tells the renderer to replay conversation history into the next prompt.
  switchSessionSpecialist?: (
    sessionId: string,
    specialistId: string | undefined
  ) => Promise<{ contextReset: boolean }>,
  // Notifies the runtime that a specialist profile's capabilities changed (skills/connectors/enabled).
  // The runtime reconnects so live sessions re-provision skills and re-apply the updated whitelist on
  // the next turn. Optional so headless/tests can omit it.
  onProfilesChanged?: () => void
): void => {
  // Subscribe once so every mutation (create, setEnabled) triggers a broadcast.
  service.subscribe(broadcastCatalogChanged)

  ipcMain.handle(SPECIALIST_IPC.LIST, async (): Promise<SpecialistListItem[]> => {
    try {
      return await service.listForSettings()
    } catch (error) {
      log.error('specialist:list failed', { error })
      throw error
    }
  })

  ipcMain.handle(
    SPECIALIST_IPC.CREATE,
    async (_event, request: CreateSpecialistRequest): Promise<SpecialistProfileView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        return await service.create(request)
      } catch (error) {
        log.error('specialist:create failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.UPDATE,
    async (_event, request: UpdateSpecialistRequest): Promise<SpecialistProfileView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        const updated = await service.update(request)
        // A capability edit (skills/connectors) must reach live sessions: trigger a reconnect so the
        // next turn re-provisions skills and re-applies the updated specialist whitelist.
        onProfilesChanged?.()
        return updated
      } catch (error) {
        log.error('specialist:update failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.SET_ENABLED,
    async (_event, request: SetSpecialistEnabledRequest): Promise<SpecialistProfileView> => {
      try {
        const updated = await service.setEnabled(request.id, request.enabled)
        onProfilesChanged?.()
        return updated
      } catch (error) {
        log.error('specialist:set-enabled failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.DELETE,
    async (_event, request: DeleteSpecialistRequest): Promise<void> => {
      try {
        await service.delete(request.id, request.expectedRevision)
        onProfilesChanged?.()
      } catch (error) {
        log.error('specialist:delete failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.DUPLICATE,
    async (_event, request: DuplicateSpecialistRequest): Promise<CreateSpecialistInput> =>
      service.duplicate(request.id)
  )

  // Session switching. This handler is a named seam: the future host.agents.switch() SDK (issue 08)
  // will resolve name→UUID and call this same channel, not a parallel path.
  ipcMain.handle(
    SPECIALIST_IPC.SET_SESSION_SPECIALIST,
    async (_event, request: SetSessionSpecialistRequest): Promise<SetSessionSpecialistResponse> => {
      if (!request || typeof request.sessionId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: sessionId must be a string.')
      }
      if (request.specialistId !== undefined && typeof request.specialistId !== 'string') {
        throw new Error('SET_SESSION_SPECIALIST: specialistId must be a string or undefined.')
      }
      // Validate the UUID exists and is enabled before accepting it.
      if (request.specialistId !== undefined) {
        const resolution = await sessionBindingService.resolve(
          request.sessionId,
          request.specialistId
        )
        if (resolution.kind === 'unavailable') {
          // Surface the reason so the renderer can show a meaningful message.
          throw new Error(resolution.reason)
        }
      }
      // Make the durable session file authoritative before exposing the new binding to runtime.
      // Otherwise an app restart between these steps would silently restore the old specialist.
      await persistSessionSpecialist(request.sessionId, request.specialistId)
      sessionBindingService.setBinding(request.sessionId, request.specialistId)

      // Apply the switch to the live agent session so the new specialist takes effect now, not
      // just on the next session create/resume. When no runtime is wired (headless/tests) this is
      // a no-op and the binding recorded above still takes effect on the next create/resume.
      let contextReset = false
      if (switchSessionSpecialist) {
        const result = await switchSessionSpecialist(request.sessionId, request.specialistId)
        contextReset = result.contextReset
      }
      return { contextReset }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.RESOLVE_SESSION_SPECIALIST,
    async (
      _event,
      request: ResolveSessionSpecialistRequest
    ): Promise<SessionSpecialistResolution> => {
      if (!request || typeof request.sessionId !== 'string') {
        throw new Error('RESOLVE_SESSION_SPECIALIST: sessionId must be a string.')
      }
      return sessionBindingService.resolve(request.sessionId)
    }
  )
}
