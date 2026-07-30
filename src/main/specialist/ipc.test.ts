import { describe, expect, it, vi } from 'vitest'

import type { SpecialistProfileView } from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { SessionBindingService } from './session-binding'
import { registerSpecialistIpcHandlers } from './ipc'
import type { ProfileService } from './service'

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const profile = {
  id: 'specialist-1',
  name: 'RESEARCHER',
  description: '',
  systemPrompt: 'Research.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
} as SpecialistProfileView

const createProfileService = (): ProfileService =>
  ({
    getById: vi.fn().mockResolvedValue(profile),
    listForSettings: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn()
  }) as unknown as ProfileService

describe('specialist session IPC', () => {
  it('registers and persists a session specialist switch', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const persistSessionSpecialist = vi.fn().mockResolvedValue(undefined)

    registerSpecialistIpcHandlers(createProfileService(), binding, persistSessionSpecialist)

    const handler = handlers.get(SPECIALIST_IPC.SET_SESSION_SPECIALIST)
    expect(handler).toBeDefined()

    await handler?.(undefined, { sessionId: 'session-1', specialistId: profile.id })

    expect(persistSessionSpecialist).toHaveBeenCalledWith('session-1', profile.id)
    expect(binding.getBinding('session-1')).toBe(profile.id)
  })
})
