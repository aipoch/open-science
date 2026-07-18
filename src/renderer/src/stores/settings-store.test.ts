import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  EnvironmentCheckResult,
  SettingsSnapshot,
  ValidateProviderResult,
  ConnectorView
} from '../../../shared/settings'
import {
  createInitialSettingsState,
  selectProviderModelOptions,
  useSettingsStore
} from './settings-store'

// Minimal window.api.settings surface the store calls.
type SettingsApi = {
  getSettings: ReturnType<typeof vi.fn>
  getPreflight: ReturnType<typeof vi.fn>
  isEncryptionAvailable: ReturnType<typeof vi.fn>
  isNpmAvailable: ReturnType<typeof vi.fn>
  checkEnvironment: ReturnType<typeof vi.fn>
  detectClaude: ReturnType<typeof vi.fn>
  detectOpencode: ReturnType<typeof vi.fn>
  setAgentFramework: ReturnType<typeof vi.fn>
  upsertProvider: ReturnType<typeof vi.fn>
  validateProvider: ReturnType<typeof vi.fn>
  refreshProviderModels: ReturnType<typeof vi.fn>
  setActiveProvider: ReturnType<typeof vi.fn>
  deleteProvider: ReturnType<typeof vi.fn>
  markOnboardingComplete: ReturnType<typeof vi.fn>
  listSkills: ReturnType<typeof vi.fn>
  setSkillEnabled: ReturnType<typeof vi.fn>
  importSkillZip: ReturnType<typeof vi.fn>
  previewSkillZip: ReturnType<typeof vi.fn>
  listConnectors: ReturnType<typeof vi.fn>
  getConnectorDetail: ReturnType<typeof vi.fn>
  setConnectorEnabled: ReturnType<typeof vi.fn>
  setConnectorAutoAllow: ReturnType<typeof vi.fn>
  setToolPermission: ReturnType<typeof vi.fn>
  setNcbiCredentials: ReturnType<typeof vi.fn>
  addCustomServer: ReturnType<typeof vi.fn>
  setCustomServerEnabled: ReturnType<typeof vi.fn>
  removeCustomServer: ReturnType<typeof vi.fn>
  updateCustomServer: ReturnType<typeof vi.fn>
  respondConnectorApproval: ReturnType<typeof vi.fn>
}

// Minimal window.api.acp surface the provider-switch flow reads/uses.
type AcpApi = {
  getState: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const snapshot = (providers: SettingsSnapshot['providers']): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers,
  agentFrameworkId: 'claude-code',
  agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }],
  opencode: {}
})

const providerView = (id: string): SettingsSnapshot['providers'][number] => ({
  id,
  type: 'custom',
  name: 'Gateway',
  model: 'claude-sonnet-4-5',
  models: ['claude-sonnet-4-5'],
  hasKey: true,
  needsKey: false
})

let api: SettingsApi
let acp: AcpApi
// Ordered log of significant calls, used to assert cancel-before-switch ordering.
let callLog: string[]

beforeEach(() => {
  callLog = []
  api = {
    getSettings: vi.fn().mockResolvedValue(snapshot([])),
    getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
    isEncryptionAvailable: vi.fn().mockResolvedValue(true),
    isNpmAvailable: vi.fn().mockResolvedValue(true),
    checkEnvironment: vi.fn().mockResolvedValue({
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    }),
    detectClaude: vi.fn().mockResolvedValue({ found: false }),
    detectOpencode: vi.fn().mockImplementation(() => {
      callLog.push('detectOpencode')
      return Promise.resolve({ ...snapshot([]), agentFrameworkId: 'opencode' })
    }),
    setAgentFramework: vi.fn().mockImplementation((request: { id: string }) => {
      callLog.push(`setFramework:${request.id}`)
      return Promise.resolve({ ...snapshot([]), agentFrameworkId: request.id })
    }),
    upsertProvider: vi.fn(),
    validateProvider: vi.fn(),
    refreshProviderModels: vi.fn(),
    setActiveProvider: vi.fn().mockImplementation((request: { id: string }) => {
      callLog.push(`setActive:${request.id}`)
      return Promise.resolve({ ...snapshot([]), activeProviderId: request.id })
    }),
    deleteProvider: vi.fn(),
    markOnboardingComplete: vi
      .fn()
      .mockResolvedValue({ ...snapshot([]), onboardingCompletedAt: 4242 }),
    listSkills: vi.fn().mockResolvedValue([]),
    setSkillEnabled: vi.fn().mockResolvedValue([]),
    importSkillZip: vi.fn().mockResolvedValue({ status: 'imported', id: 'z', skills: [] }),
    previewSkillZip: vi.fn().mockResolvedValue([]),
    listConnectors: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    getConnectorDetail: vi.fn(),
    setConnectorEnabled: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    setConnectorAutoAllow: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    setToolPermission: vi.fn(),
    setNcbiCredentials: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    addCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    setCustomServerEnabled: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    removeCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    updateCustomServer: vi
      .fn()
      .mockResolvedValue({ connectors: [], customServers: [], ncbi: { hasApiKey: false } }),
    respondConnectorApproval: vi.fn().mockResolvedValue(undefined)
  }
  acp = {
    getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
    cancel: vi.fn().mockImplementation((request: { sessionId: string }) => {
      callLog.push(`cancel:${request.sessionId}`)
      return Promise.resolve({})
    })
  }
  ;(globalThis as { window?: unknown }).window = { api: { settings: api, acp } }
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('settings store: saveAndActivateProvider', () => {
  it('creates, validates, then activates a new provider on success', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({ ok: true, category: 'ok' } as ValidateProviderResult)
    api.setActiveProvider.mockResolvedValue({
      ...snapshot([providerView('p_new')]),
      activeProviderId: 'p_new'
    })

    const result = await useSettingsStore.getState().saveAndActivateProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result).toEqual({ providerId: 'p_new', validation: { ok: true, category: 'ok' } })
    expect(api.validateProvider).toHaveBeenCalledWith({ providerId: 'p_new' })
    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p_new' })
    expect(useSettingsStore.getState().activeProviderId).toBe('p_new')
  })

  it('does not activate when validation fails', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)

    const result = await useSettingsStore.getState().saveAndActivateProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result.validation.ok).toBe(false)
    expect(api.setActiveProvider).not.toHaveBeenCalled()
    // The failed provider is kept (flagged as unverified), not rolled back.
    expect(api.deleteProvider).not.toHaveBeenCalled()
  })

  it('resolves the edited id directly instead of diffing', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_existing')]))
    api.validateProvider.mockResolvedValue({ ok: true, category: 'ok' } as ValidateProviderResult)

    const { providerId } = await useSettingsStore
      .getState()
      .saveProvider({ id: 'p_existing', type: 'custom', name: 'Renamed' })

    expect(providerId).toBe('p_existing')
    expect(api.validateProvider).toHaveBeenCalledWith({ providerId: 'p_existing' })
  })
})

describe('settings store: persistProvider', () => {
  it('persists a new provider and returns its id without testing it', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))

    const providerId = await useSettingsStore.getState().persistProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(providerId).toBe('p_new')
    // Persisting does not run the connection test — the Settings page tests in the background.
    expect(api.validateProvider).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })
})

describe('settings store: saveProvider keeps a provider whose test fails', () => {
  it('does not delete a new provider when validation fails, and refreshes to surface the failure', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_new')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)
    // The post-validate refresh returns the persisted provider (now carrying the recorded failure).
    api.getSettings.mockResolvedValue(snapshot([providerView('p_new')]))

    const result = await useSettingsStore.getState().saveProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      key: 'k'
    })

    expect(result.validation.ok).toBe(false)
    expect(result.providerId).toBe('p_new')
    expect(api.deleteProvider).not.toHaveBeenCalled()
    // The kept provider stays in the renderer cache after the refresh.
    expect(useSettingsStore.getState().providers).toHaveLength(1)
  })

  it('keeps an existing provider when an edit fails validation', async () => {
    api.upsertProvider.mockResolvedValue(snapshot([providerView('p_existing')]))
    api.validateProvider.mockResolvedValue({
      ok: false,
      category: 'auth'
    } as ValidateProviderResult)
    api.getSettings.mockResolvedValue(snapshot([providerView('p_existing')]))

    const result = await useSettingsStore
      .getState()
      .saveProvider({ id: 'p_existing', type: 'custom', name: 'Renamed' })

    expect(result.validation.ok).toBe(false)
    expect(result.providerId).toBe('p_existing')
    expect(api.deleteProvider).not.toHaveBeenCalled()
  })
})

describe('settings store: detectClaude refreshes npm', () => {
  it('re-checks npm availability so a mid-onboarding Node.js install is picked up', async () => {
    // Start from the "npm missing" state a genuine first run without Node.js would have.
    useSettingsStore.setState({ npmAvailable: false })
    api.isNpmAvailable.mockResolvedValue(true)

    await useSettingsStore.getState().detectClaude()

    expect(api.isNpmAvailable).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().npmAvailable).toBe(true)
  })
})

describe('settings store: environment check', () => {
  it('caches the launch inspection and refreshes preflight after detection', async () => {
    api.getSettings.mockResolvedValue({
      ...snapshot([]),
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    const result = await useSettingsStore.getState().checkEnvironment()

    expect(result?.ready).toBe(true)
    expect(useSettingsStore.getState().environmentCheck?.platform).toBe('darwin')
    expect(useSettingsStore.getState().claude.resolvedPath).toBe('/bin/claude')
    expect(api.getPreflight).toHaveBeenCalled()
  })

  it('deduplicates concurrent launch checks', async () => {
    let resolveCheck: ((value: EnvironmentCheckResult) => void) | undefined
    api.checkEnvironment.mockImplementation(
      () =>
        new Promise<EnvironmentCheckResult>((resolve) => {
          resolveCheck = resolve
        })
    )

    const first = useSettingsStore.getState().checkEnvironment()
    const second = useSettingsStore.getState().checkEnvironment()

    expect(api.checkEnvironment).toHaveBeenCalledTimes(1)
    expect(await second).toBeUndefined()

    resolveCheck?.({
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [],
      ready: true,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code',
      runtime: { found: true, path: '/bin/claude' }
    })
    await first
  })

  it('surfaces a failed main-process inspection and always clears loading state', async () => {
    api.checkEnvironment.mockRejectedValue(new Error('environment IPC unavailable'))

    const result = await useSettingsStore.getState().checkEnvironment()

    expect(result).toBeUndefined()
    expect(useSettingsStore.getState()).toMatchObject({
      isCheckingEnvironment: false,
      isDetectingClaude: false,
      environmentCheckError: 'environment IPC unavailable'
    })
  })
})

describe('settings store: onboarding completion', () => {
  it('completeOnboarding persists the marker and caches it locally', async () => {
    await useSettingsStore.getState().completeOnboarding()

    expect(api.markOnboardingComplete).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().onboardingCompletedAt).toBe(4242)
  })

  it('applySnapshot-driven load caches onboardingCompletedAt', async () => {
    api.getSettings.mockResolvedValue({ ...snapshot([]), onboardingCompletedAt: 999 })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().onboardingCompletedAt).toBe(999)
  })
})

describe('settings store: provider/model selection', () => {
  it('passes the chosen model to the IPC and caches activeModel', async () => {
    api.setActiveProvider.mockResolvedValue({
      ...snapshot([providerView('p1')]),
      activeProviderId: 'p1',
      activeModel: 'glm-4.7'
    })

    await useSettingsStore.getState().setActiveProvider('p1', 'glm-4.7')

    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p1', model: 'glm-4.7' })
    expect(useSettingsStore.getState().activeModel).toBe('glm-4.7')
  })

  it('treats an empty model as "no specific model" (provider default)', async () => {
    api.setActiveProvider.mockResolvedValue(snapshot([providerView('p1')]))

    await useSettingsStore.getState().setActiveProvider('p1', '')

    expect(api.setActiveProvider).toHaveBeenCalledWith({ id: 'p1', model: undefined })
  })
})

describe('selectProviderModelOptions', () => {
  it('emits one option per catalog model for an official provider', () => {
    const options = selectProviderModelOptions([
      {
        id: 'off',
        type: 'official',
        name: 'GLM',
        vendorId: 'zhipu',
        models: ['glm-5.2', 'glm-4.7'],
        hasKey: true,
        needsKey: false
      }
    ])

    expect(options).toEqual([
      {
        providerId: 'off',
        providerName: 'GLM',
        providerType: 'official',
        vendorId: 'zhipu',
        model: 'glm-5.2'
      },
      {
        providerId: 'off',
        providerName: 'GLM',
        providerType: 'official',
        vendorId: 'zhipu',
        model: 'glm-4.7'
      }
    ])
  })

  it('emits one option for a custom provider and a default entry for a modelless provider', () => {
    const options = selectProviderModelOptions([
      {
        id: 'c',
        type: 'custom',
        name: 'GW',
        model: 'm',
        models: ['m'],
        hasKey: true,
        needsKey: false
      },
      {
        id: 'local',
        type: 'claude-default',
        name: 'Local',
        models: [],
        hasKey: false,
        needsKey: false
      }
    ])

    expect(options).toEqual([
      { providerId: 'c', providerName: 'GW', providerType: 'custom', model: 'm' },
      // A provider with no concrete model still yields one selectable "default" entry (empty model).
      { providerId: 'local', providerName: 'Local', providerType: 'claude-default', model: '' }
    ])
  })

  it('excludes a provider whose last test failed so it cannot be selected as a model source', () => {
    const options = selectProviderModelOptions([
      {
        id: 'ok',
        type: 'custom',
        name: 'Good',
        model: 'm',
        models: ['m'],
        hasKey: true,
        needsKey: false,
        lastValidatedAt: 200
      },
      {
        id: 'bad',
        type: 'custom',
        name: 'Broken',
        model: 'm',
        models: ['m'],
        hasKey: true,
        needsKey: false,
        lastValidationFailure: { at: 300, category: 'auth' }
      }
    ])

    expect(options).toEqual([
      { providerId: 'ok', providerName: 'Good', providerType: 'custom', model: 'm' }
    ])
  })
})

describe('settings store: refreshProviderModels', () => {
  it('refreshes the cache from the snapshot when the vendor fetch succeeds', async () => {
    api.refreshProviderModels.mockResolvedValue({ ok: true, category: 'ok', models: ['m1', 'm2'] })
    api.getSettings.mockResolvedValue(snapshot([providerView('p1')]))

    const result = await useSettingsStore.getState().refreshProviderModels('p1')

    expect(result.ok).toBe(true)
    expect(api.refreshProviderModels).toHaveBeenCalledWith({ providerId: 'p1' })
    expect(useSettingsStore.getState().providers.map((p) => p.id)).toEqual(['p1'])
  })

  it('leaves the cache untouched when the fetch fails', async () => {
    api.refreshProviderModels.mockResolvedValue({ ok: false, category: 'auth', message: 'nope' })

    const result = await useSettingsStore.getState().refreshProviderModels('p1')

    expect(result.ok).toBe(false)
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('loads skills and toggles optimistically', async () => {
    api.listSkills.mockResolvedValue([
      {
        id: 'demo',
        name: 'Demo',
        description: '',
        source: 'featured',
        updatedAt: '',
        enabled: true
      }
    ])
    api.setSkillEnabled.mockResolvedValue([
      {
        id: 'demo',
        name: 'Demo',
        description: '',
        source: 'featured',
        updatedAt: '',
        enabled: false
      }
    ])

    await useSettingsStore.getState().loadSkills()
    expect(useSettingsStore.getState().skills[0].enabled).toBe(true)

    await useSettingsStore.getState().setSkillEnabled('demo', false)
    expect(api.setSkillEnabled).toHaveBeenCalledWith({ id: 'demo', enabled: false })
    expect(useSettingsStore.getState().skills[0].enabled).toBe(false)
  })
})

describe('settings store: openSettingsToSkill', () => {
  it('opens the dialog on a skill; consume and close both clear the pending id', () => {
    useSettingsStore.getState().openSettingsToSkill('x')
    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSkillId).toBe('x')

    useSettingsStore.getState().consumePendingSkill()
    expect(useSettingsStore.getState().pendingSkillId).toBeUndefined()

    // Closing after a fresh open-to-skill clears the pending id so a later open starts fresh.
    useSettingsStore.getState().openSettingsToSkill('y')
    useSettingsStore.getState().closeSettings()
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useSettingsStore.getState().pendingSkillId).toBeUndefined()
  })
})

describe('settings store: skill bundle upload', () => {
  it('previewSkillZip returns one preview per skill root the bundle contains', async () => {
    api.previewSkillZip.mockResolvedValue([
      {
        subPath: 'skills/alpha',
        name: 'Alpha',
        description: '',
        files: ['SKILL.md'],
        alreadyImported: false
      },
      {
        subPath: 'skills/beta',
        name: 'Beta',
        description: '',
        files: ['SKILL.md'],
        alreadyImported: true
      }
    ])

    const previews = await useSettingsStore.getState().previewSkillZip('YmFzZTY0')

    expect(api.previewSkillZip).toHaveBeenCalledWith({ dataBase64: 'YmFzZTY0' })
    expect(previews).toHaveLength(2)
    expect(previews.map((preview) => preview.name)).toEqual(['Alpha', 'Beta'])
  })

  it('importSkillZip forwards the subPath/replaceId opts and reconciles the skill list', async () => {
    api.importSkillZip.mockResolvedValue({
      status: 'imported',
      id: 'imported-alpha',
      skills: [
        {
          id: 'imported-alpha',
          name: 'Alpha',
          description: '',
          source: 'imported',
          updatedAt: '',
          enabled: true
        }
      ]
    })

    const result = await useSettingsStore
      .getState()
      .importSkillZip('YmFzZTY0', { subPath: 'skills/alpha', replaceId: 'old-alpha' })

    expect(api.importSkillZip).toHaveBeenCalledWith({
      dataBase64: 'YmFzZTY0',
      subPath: 'skills/alpha',
      replaceId: 'old-alpha'
    })
    expect(result.status).toBe('imported')
    expect(useSettingsStore.getState().skills.map((skill) => skill.id)).toEqual(['imported-alpha'])
  })
})

describe('settings store: connectors slice', () => {
  const connectorView = (id: string, enabled: boolean): ConnectorView => ({
    id,
    displayName: 'PubMed',
    description: '',
    sources: [],
    requiresNcbi: true,
    enabled,
    autoAllow: false,
    group: 'featured'
  })

  it('loadConnectors populates connectors and ncbi from the snapshot', async () => {
    api.listConnectors.mockResolvedValue({
      connectors: [connectorView('pubmed', true)],
      customServers: [],
      ncbi: { contactEmail: 'a@b.com', hasApiKey: true }
    })

    await useSettingsStore.getState().loadConnectors()

    expect(useSettingsStore.getState().connectors[0].id).toBe('pubmed')
    expect(useSettingsStore.getState().ncbi).toEqual({ contactEmail: 'a@b.com', hasApiKey: true })
  })

  it('setConnectorEnabled flips optimistically then reconciles from the returned snapshot', async () => {
    api.listConnectors.mockResolvedValue({
      connectors: [connectorView('pubmed', true)],
      customServers: [],
      ncbi: { hasApiKey: false }
    })
    api.setConnectorEnabled.mockResolvedValue({
      connectors: [connectorView('pubmed', false)],
      customServers: [],
      ncbi: { hasApiKey: false }
    })

    await useSettingsStore.getState().loadConnectors()
    expect(useSettingsStore.getState().connectors[0].enabled).toBe(true)

    await useSettingsStore.getState().setConnectorEnabled('pubmed', false)
    expect(api.setConnectorEnabled).toHaveBeenCalledWith({ id: 'pubmed', enabled: false })
    expect(useSettingsStore.getState().connectors[0].enabled).toBe(false)
  })

  it('setNcbiCredentials reconciles the ncbi credential state', async () => {
    api.setNcbiCredentials.mockResolvedValue({
      connectors: [],
      customServers: [],
      ncbi: { contactEmail: 'me@lab.org', hasApiKey: true }
    })

    await useSettingsStore
      .getState()
      .setNcbiCredentials({ contactEmail: 'me@lab.org', apiKey: 'k' })

    expect(api.setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'me@lab.org',
      apiKey: 'k'
    })
    expect(useSettingsStore.getState().ncbi).toEqual({
      contactEmail: 'me@lab.org',
      hasApiKey: true
    })
  })

  it('addCustomServer and removeCustomServer reconcile the custom-server list', async () => {
    const server = {
      id: 'srv-1',
      name: 'my-mem',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx'
    }
    api.addCustomServer.mockResolvedValue({
      connectors: [],
      customServers: [server],
      ncbi: { hasApiKey: false }
    })
    api.removeCustomServer.mockResolvedValue({
      connectors: [],
      customServers: [],
      ncbi: { hasApiKey: false }
    })

    await useSettingsStore
      .getState()
      .addCustomServer({ name: 'my-mem', transport: 'stdio', command: 'npx' })
    expect(api.addCustomServer).toHaveBeenCalledWith({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx'
    })
    expect(useSettingsStore.getState().customServers).toEqual([server])

    await useSettingsStore.getState().removeCustomServer('srv-1')
    expect(api.removeCustomServer).toHaveBeenCalledWith({ id: 'srv-1' })
    expect(useSettingsStore.getState().customServers).toEqual([])
  })

  it('enqueues an approval request and responds, clearing it from the queue', async () => {
    const request = {
      id: 'req-1',
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{"x":1}'
    }
    useSettingsStore.getState().enqueueApproval(request)
    expect(useSettingsStore.getState().pendingApprovals).toEqual([request])

    // Duplicate ids are ignored.
    useSettingsStore.getState().enqueueApproval(request)
    expect(useSettingsStore.getState().pendingApprovals).toHaveLength(1)

    await useSettingsStore.getState().respondApproval('req-1', 'allow')
    expect(api.respondConnectorApproval).toHaveBeenCalledWith({ id: 'req-1', decision: 'allow' })
    expect(useSettingsStore.getState().pendingApprovals).toEqual([])
  })
})

describe('settings store: setAgentFramework', () => {
  beforeEach(() => {
    useSettingsStore.setState(createInitialSettingsState())
  })

  it('switches, then live-detects the selected framework and refreshes preflight', async () => {
    await useSettingsStore.getState().setAgentFramework('opencode')

    // The switch persists first, then the newly-selected framework is re-detected so a
    // just-installed (or just-deleted) binary is reflected before the readiness gate is recomputed.
    expect(callLog).toEqual(['setFramework:opencode', 'detectOpencode'])
    expect(api.getPreflight).toHaveBeenCalled()
    expect(useSettingsStore.getState().agentFrameworkId).toBe('opencode')
  })

  it('re-detects Claude when switching back to claude-code', async () => {
    await useSettingsStore.getState().setAgentFramework('claude-code')

    expect(api.detectClaude).toHaveBeenCalled()
    expect(api.detectOpencode).not.toHaveBeenCalled()
  })
})
