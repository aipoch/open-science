import { describe, expect, it, vi } from 'vitest'

import type { SpecialistProfileView } from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { SessionBindingService } from './session-binding'
import { registerSpecialistIpcHandlers } from './ipc'
import type { ProfileService } from './service'
import { SessionSpecialistReconfiguration } from './session-reconfiguration'

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const broadcastToRenderers = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers }))

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
    resolveRunnableById: vi.fn().mockResolvedValue(profile),
    listForSettings: vi.fn().mockResolvedValue([]),
    listForSettingsSnapshot: vi.fn().mockResolvedValue({ items: [], integrity: { status: 'ok' } }),
    subscribe: vi.fn()
  }) as unknown as ProfileService

const createReconfigurationStub = (): Pick<SessionSpecialistReconfiguration, 'requestSwitch'> => ({
  requestSwitch: vi.fn().mockResolvedValue({ status: 'applied', contextReset: false })
})

describe('specialist session IPC', () => {
  it('broadcasts only an invalidation signal without profile prompts or resource paths', () => {
    let notify: (() => void) | undefined
    const service = {
      ...createProfileService(),
      subscribe: vi.fn((listener: () => void) => {
        notify = listener
        return vi.fn()
      })
    } as unknown as ProfileService

    registerSpecialistIpcHandlers(
      service,
      new SessionBindingService(service),
      createReconfigurationStub()
    )
    notify?.()

    expect(broadcastToRenderers).toHaveBeenCalledWith(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
    const payload = JSON.stringify(broadcastToRenderers.mock.calls)
    expect(payload).not.toContain(profile.systemPrompt)
    expect(payload).not.toMatch(/resources[/\\]specialists/)
  })

  it('routes a session specialist switch through the reconfiguration owner', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const reconfiguration = createReconfigurationStub()

    registerSpecialistIpcHandlers(createProfileService(), binding, reconfiguration)

    const handler = handlers.get(SPECIALIST_IPC.SET_SESSION_SPECIALIST)
    expect(handler).toBeDefined()

    await expect(
      handler?.(undefined, { sessionId: 'session-1', specialistId: profile.id })
    ).resolves.toEqual({ status: 'applied', contextReset: false })

    expect(reconfiguration.requestSwitch).toHaveBeenCalledWith('session-1', profile.id)
  })

  it('does not leave durable, Main-memory, and runtime Specialist bindings silently divergent', async () => {
    handlers.clear()
    const service = createProfileService()
    const binding = new SessionBindingService(service)
    binding.setBinding('session-1', 'specialist-old')
    let durableBinding: {
      specialistId: string | undefined
      specialistBindingPending?: true
    } = { specialistId: 'specialist-old' }
    const runtimeSpecialistId: string | undefined = 'specialist-old'
    const reconfiguration = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => durableBinding,
      persistBinding: async (_sessionId, specialistId, pending) => {
        durableBinding = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: async () => {
        throw new Error('runtime replacement failed')
      }
    })

    registerSpecialistIpcHandlers(service, binding, reconfiguration)

    const handler = handlers.get(SPECIALIST_IPC.SET_SESSION_SPECIALIST)
    let result: unknown
    try {
      result = await handler?.(undefined, {
        sessionId: 'session-1',
        specialistId: profile.id
      })
    } catch {
      // A rejected switch is acceptable only when the three authorities still agree.
    }

    const authoritiesAgree =
      new Set([durableBinding.specialistId, binding.getBinding('session-1'), runtimeSpecialistId])
        .size === 1
    const explicitlyPending =
      typeof result === 'object' &&
      result !== null &&
      (result as { status?: unknown }).status === 'pending'

    expect(authoritiesAgree || explicitlyPending).toBe(true)
    expect(durableBinding).toEqual({
      specialistId: profile.id,
      specialistBindingPending: true
    })
    await expect(reconfiguration.assertUserPromptReady('session-1')).rejects.toThrow(
      /has not been applied/
    )
    expect(runtimeSpecialistId).toBe('specialist-old')
  })

  it('returns only the renderer-safe template save result from main', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: true })

    registerSpecialistIpcHandlers(
      createProfileService(),
      binding,
      createReconfigurationStub(),
      undefined,
      exportContributionTemplate
    )

    const result = await handlers.get(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE)?.(
      undefined,
      undefined
    )
    expect(result).toEqual({ saved: true })
  })

  it('keeps archive bytes in main and rejects mutated install requests before the package service', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const preview = vi.fn().mockResolvedValue({
      candidateToken: 'candidate-1',
      summary: { id: 'safe-id' },
      diagnostics: [],
      installable: true
    })
    const install = vi.fn()
    const dispose = vi.fn()
    const once = vi.fn()

    registerSpecialistIpcHandlers(
      createProfileService(),
      binding,
      createReconfigurationStub(),
      undefined,
      undefined,
      {
        service: {
          preview,
          previewOversizedArchive: vi.fn(),
          install,
          cancel: vi.fn(),
          dispose,
          report: vi.fn(),
          previewExport: vi.fn(),
          export: vi.fn(),
          previewSpecialistDelete: vi.fn(),
          deleteSpecialist: vi.fn()
        },
        selectArchive: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) }),
        saveReport: vi.fn(),
        saveExport: vi.fn()
      }
    )

    const event = { sender: { id: 17, once } }
    const selected = await handlers.get(SPECIALIST_IPC.SELECT_PACKAGE)?.(event, undefined)
    expect(selected).toEqual({
      candidateToken: 'candidate-1',
      summary: { id: 'safe-id' },
      diagnostics: [],
      installable: true
    })
    expect(JSON.stringify(selected)).not.toMatch(/bytes|path/i)
    expect(dispose).toHaveBeenCalledWith(17)
    expect(preview).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 17)
    expect(once).toHaveBeenCalledWith('destroyed', expect.any(Function))

    await expect(
      handlers.get(SPECIALIST_IPC.INSTALL_PACKAGE)?.(undefined, {
        candidateToken: 'candidate-1',
        enabled: false
      })
    ).resolves.toEqual({ status: 'failed', code: 'candidate-invalid' })
    expect(install).not.toHaveBeenCalled()
  })

  it('saves only the main-owned report for a valid candidate request', async () => {
    handlers.clear()
    const report = { schemaVersion: 1 as const, diagnostics: [], installable: false }
    const saveReport = vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: '/downloads/report.json' })

    registerSpecialistIpcHandlers(
      createProfileService(),
      new SessionBindingService(createProfileService()),
      createReconfigurationStub(),
      undefined,
      undefined,
      {
        service: {
          preview: vi.fn(),
          previewOversizedArchive: vi.fn(),
          install: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
          report: vi.fn().mockReturnValue(report),
          previewExport: vi.fn(),
          export: vi.fn(),
          previewSpecialistDelete: vi.fn(),
          deleteSpecialist: vi.fn()
        },
        selectArchive: vi.fn(),
        saveReport,
        saveExport: vi.fn()
      }
    )

    await expect(
      handlers.get(SPECIALIST_IPC.SAVE_PACKAGE_REPORT)?.(undefined, {
        candidateToken: 'candidate-1'
      })
    ).resolves.toEqual({ saved: true })
    expect(saveReport).toHaveBeenCalledWith(report)

    await expect(
      handlers.get(SPECIALIST_IPC.SAVE_PACKAGE_REPORT)?.(undefined, {
        candidateToken: 'candidate-1',
        report: { secret: true }
      })
    ).resolves.toEqual({ saved: false })
    expect(saveReport).toHaveBeenCalledOnce()
  })

  it('keeps export and linked deletion routes available on the same package owner', async () => {
    handlers.clear()
    const previewExport = vi.fn().mockResolvedValue({
      specialistId: 'research-synth',
      name: 'Research Synthesizer',
      version: '1.3.0',
      fileName: 'open-science-specialist-research-synthesizer-v1.3.0.zip',
      expectedRevision: 3,
      skills: [],
      diagnostics: [],
      canExport: true
    })
    const exportArchive = vi.fn().mockResolvedValue({
      fileName: 'research-synth-1.3.0.zip',
      archiveBytes: new Uint8Array([1, 2, 3])
    })
    const saveExport = vi.fn().mockResolvedValue({ saved: true })
    const previewSpecialistDelete = vi.fn().mockResolvedValue({
      specialistId: 'specialist-1',
      specialistName: 'Researcher',
      expectedRevision: 1,
      skills: []
    })
    const deleteSpecialist = vi.fn().mockResolvedValue({ status: 'deleted' })
    const onProfilesChanged = vi.fn()
    const packageService = {
      preview: vi.fn(),
      previewOversizedArchive: vi.fn(),
      install: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
      report: vi.fn(),
      previewExport,
      export: exportArchive,
      previewSpecialistDelete,
      deleteSpecialist
    }
    registerSpecialistIpcHandlers(
      createProfileService(),
      new SessionBindingService(createProfileService()),
      createReconfigurationStub(),
      onProfilesChanged,
      undefined,
      { service: packageService, selectArchive: vi.fn(), saveReport: vi.fn(), saveExport }
    )

    await expect(
      handlers.get(SPECIALIST_IPC.PREVIEW_EXPORT)?.(undefined, {
        specialistId: 'research-synth'
      })
    ).resolves.toMatchObject({ specialistId: 'research-synth', canExport: true })
    const result = await handlers.get(SPECIALIST_IPC.EXPORT)?.(undefined, {
      specialistId: 'research-synth',
      expectedRevision: 3,
      includedSkillIds: []
    })
    expect(result).toEqual({ saved: true })
    expect(saveExport).toHaveBeenCalledWith({
      fileName: 'research-synth-1.3.0.zip',
      archiveBytes: new Uint8Array([1, 2, 3])
    })
    expect(JSON.stringify(result)).not.toMatch(/archiveBytes|\/downloads/)

    await expect(
      handlers.get(SPECIALIST_IPC.PREVIEW_DELETE)?.(undefined, { id: 'specialist-1' })
    ).resolves.toMatchObject({ expectedRevision: 1 })
    await expect(
      handlers.get(SPECIALIST_IPC.DELETE)?.(undefined, {
        id: 'specialist-1',
        expectedRevision: 1,
        deleteSkillIds: []
      })
    ).resolves.toEqual({ status: 'deleted' })
    expect(previewSpecialistDelete).toHaveBeenCalledWith({ id: 'specialist-1' })
    expect(deleteSpecialist).toHaveBeenCalledWith({
      id: 'specialist-1',
      expectedRevision: 1,
      deleteSkillIds: []
    })
    expect(onProfilesChanged).not.toHaveBeenCalled()
  })
})
