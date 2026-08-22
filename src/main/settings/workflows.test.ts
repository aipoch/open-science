import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type SettingsSnapshot
} from '../../shared/settings'
import {
  createSettingsWorkflows,
  type SettingsWorkflowEffects,
  type SettingsWorkflowStore
} from './workflows'

type TestSettingsWorkflowEffects = Partial<
  SettingsWorkflowEffects['runtime'] &
    SettingsWorkflowEffects['skills'] &
    SettingsWorkflowEffects['connectors'] &
    SettingsWorkflowEffects['appearance']
>

// Tests select one narrow owner at a time. No-op adapters are explicit here so required production
// effects cannot disappear merely because a property was omitted from workflow construction.
const testEffects = (effects: TestSettingsWorkflowEffects = {}): SettingsWorkflowEffects => ({
  runtime: {
    requestProviderReconnect: effects.requestProviderReconnect ?? (() => undefined),
    requestAgentFrameworkSwitch: effects.requestAgentFrameworkSwitch ?? (() => undefined)
  },
  skills: {
    requestSkillsReload: effects.requestSkillsReload ?? (() => undefined),
    notifySkillCatalogChanged: effects.notifySkillCatalogChanged ?? (() => undefined),
    removeTagsForSkill: effects.removeTagsForSkill ?? (async () => undefined)
  },
  connectors: {
    invalidatePermissionProjection: effects.invalidatePermissionProjection ?? (() => undefined),
    refreshConnectorSkillDocs: effects.refreshConnectorSkillDocs ?? (async () => undefined),
    requestSkillsReload: effects.requestSkillsReload ?? (() => undefined),
    pruneCustomServerPermissions: effects.pruneCustomServerPermissions ?? (async () => undefined),
    removeTagsForConnector: effects.removeTagsForConnector ?? (async () => undefined),
    beginCustomServerSecurityChange: effects.beginCustomServerSecurityChange ?? (() => undefined),
    clearCustomServerFailure: effects.clearCustomServerFailure ?? (() => undefined),
    resetCustomServerClient: effects.resetCustomServerClient ?? (async () => undefined)
  },
  appearance: { applyAppIconVariant: effects.applyAppIconVariant ?? (() => undefined) }
})

const snapshot = (overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  claude: {},
  opencode: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light',
  ...overrides
})

// The inferred spy methods are intentionally retained so each test can configure exact outcomes.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const fakeStore = () => {
  const store = {
    getSettingsView: vi.fn().mockResolvedValue(snapshot()),
    getConnectors: vi.fn().mockResolvedValue(undefined),
    uninstallClaude: vi.fn(),
    uninstallOpencode: vi.fn(),
    uninstallCodex: vi.fn(),
    upsertProvider: vi.fn().mockResolvedValue(snapshot()),
    deleteProvider: vi.fn().mockResolvedValue(snapshot()),
    setActiveProvider: vi.fn().mockResolvedValue(snapshot()),
    setAgentFramework: vi.fn().mockResolvedValue(snapshot()),
    setReasoningEffort: vi.fn().mockResolvedValue(snapshot()),
    resolveActiveReasoningEffort: vi.fn().mockResolvedValue('high'),
    resolveActiveModelChangeTarget: vi.fn().mockResolvedValue(undefined),
    setConversationSkillImportEnabled: vi.fn().mockResolvedValue(snapshot()),
    setAppIconVariant: vi.fn().mockResolvedValue(snapshot()),
    loginClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    logoutClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    logoutIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    logoutIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
    setSkillEnabled: vi.fn().mockResolvedValue([]),
    setSkillsEnabled: vi.fn().mockResolvedValue([]),
    createSkill: vi.fn().mockResolvedValue([]),
    updateSkill: vi.fn().mockResolvedValue([]),
    deleteSkill: vi.fn().mockResolvedValue([]),
    importSkill: vi.fn().mockResolvedValue({ skills: [] }),
    importSkillZip: vi.fn().mockResolvedValue({ skills: [] }),
    importSkillZipBatch: vi.fn().mockResolvedValue({ results: [], skills: [] }),
    importAgentHomeSkills: vi.fn().mockResolvedValue({ results: [], skills: [] }),
    setConnectorEnabled: vi.fn().mockResolvedValue({ connectors: [] }),
    setConnectorAutoAllow: vi.fn().mockResolvedValue({ connectors: [] }),
    setToolPermission: vi.fn().mockResolvedValue({ id: 'tool' }),
    setNcbiCredentials: vi.fn().mockResolvedValue({ connectors: [] }),
    listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [], ncbi: {} }),
    addCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    setCustomServerEnabled: vi.fn().mockResolvedValue({ connectors: [] }),
    removeCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    updateCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    authenticateCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined)
  }
  return { store, capability: store as unknown as SettingsWorkflowStore }
}

describe('SettingsWorkflows runtime effects', () => {
  it.each([
    ['uninstallClaude', 'claude-code', 'opencode'],
    ['uninstallOpencode', 'opencode', 'codex'],
    ['uninstallCodex', 'codex', 'claude-code']
  ] as const)(
    'switches framework after an affected %s uninstall selects a fallback',
    async (method, framework, fallback) => {
      const { store, capability } = fakeStore()
      store[method].mockResolvedValue({
        snapshot: snapshot({ agentFrameworkId: fallback }),
        activeBackendAffected: true
      })
      const requestAgentFrameworkSwitch = vi.fn()
      const requestProviderReconnect = vi.fn()

      await createSettingsWorkflows(
        capability,
        testEffects({ requestAgentFrameworkSwitch, requestProviderReconnect })
      ).runtime.uninstallRuntime(method, framework)

      expect(requestAgentFrameworkSwitch).toHaveBeenCalledOnce()
      expect(requestProviderReconnect).not.toHaveBeenCalled()
    }
  )

  it('reconnects only when an affected uninstall keeps the same framework', async () => {
    const { store, capability } = fakeStore()
    store.uninstallClaude.mockResolvedValue({
      snapshot: snapshot({ agentFrameworkId: 'claude-code' }),
      activeBackendAffected: true
    })
    const requestProviderReconnect = vi.fn()
    const requestAgentFrameworkSwitch = vi.fn()

    await createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect, requestAgentFrameworkSwitch })
    ).runtime.uninstallRuntime('uninstallClaude', 'claude-code')

    expect(requestProviderReconnect).toHaveBeenCalledOnce()
    expect(requestAgentFrameworkSwitch).not.toHaveBeenCalled()

    store.uninstallClaude.mockResolvedValue({
      snapshot: snapshot({ agentFrameworkId: 'claude-code' }),
      activeBackendAffected: false
    })
    await createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect, requestAgentFrameworkSwitch })
    ).runtime.uninstallRuntime('uninstallClaude', 'claude-code')
    expect(requestProviderReconnect).toHaveBeenCalledOnce()
  })

  it('reconnects after active provider edits, selection, and deletion only after persistence', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.getSettingsView.mockImplementation(async () => {
      calls.push('read')
      return snapshot({ activeProviderId: 'active' })
    })
    store.upsertProvider.mockImplementation(async () => {
      calls.push('upsert')
      return snapshot({ activeProviderId: 'active' })
    })
    store.setActiveProvider.mockImplementation(async () => {
      calls.push('select')
      return snapshot({ activeProviderId: 'next' })
    })
    store.deleteProvider.mockImplementation(async () => {
      calls.push('delete')
      return snapshot({ activeProviderId: undefined })
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect: () => calls.push('reconnect') })
    ).runtime

    await workflows.upsertProvider({ id: 'active', name: 'Active', type: 'custom' })
    await workflows.setActiveProvider({ id: 'next' })
    await workflows.deleteProvider('active')

    expect(calls).toEqual(['read', 'upsert', 'reconnect', 'select', 'read', 'delete', 'reconnect'])
  })

  it('persists the default model without mutating live Sessions', async () => {
    const { store, capability } = fakeStore()
    const result = snapshot({ activeProviderId: 'active', activeModel: 'model-b' })
    store.setActiveProvider.mockResolvedValue(result)
    const requestProviderReconnect = vi.fn()

    await expect(
      createSettingsWorkflows(
        capability,
        testEffects({ requestProviderReconnect })
      ).runtime.setActiveProvider({ id: 'active', model: 'model-b' })
    ).resolves.toBe(result)

    expect(store.getSettingsView).not.toHaveBeenCalled()
    expect(requestProviderReconnect).not.toHaveBeenCalled()
  })

  it('persists the default reasoning effort without mutating live Sessions', async () => {
    const { store, capability } = fakeStore()
    const result = snapshot({ reasoningEffort: 'high' })
    store.setReasoningEffort.mockResolvedValue(result)
    const requestProviderReconnect = vi.fn()

    await expect(
      createSettingsWorkflows(
        capability,
        testEffects({ requestProviderReconnect })
      ).runtime.setReasoningEffort({ effort: 'high' })
    ).resolves.toBe(result)

    expect(store.resolveActiveReasoningEffort).not.toHaveBeenCalled()
    expect(requestProviderReconnect).not.toHaveBeenCalled()
  })

  it('does not reconnect for a new or inactive provider edit or a failed mutation', async () => {
    const { store, capability } = fakeStore()
    store.getSettingsView.mockResolvedValue(snapshot({ activeProviderId: 'active' }))
    store.upsertProvider.mockResolvedValue(snapshot({ activeProviderId: 'active' }))
    const requestProviderReconnect = vi.fn()
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect })
    ).runtime

    await workflows.upsertProvider({ name: 'New', type: 'custom' })
    await workflows.upsertProvider({ id: 'inactive', name: 'Inactive', type: 'custom' })
    store.setActiveProvider.mockRejectedValue(new Error('save failed'))
    await expect(workflows.setActiveProvider({ id: 'next' })).rejects.toThrow('save failed')

    expect(requestProviderReconnect).not.toHaveBeenCalled()
  })
})

describe('SettingsWorkflows authentication follow-up', () => {
  it.each([
    [
      'loginClaudeShared',
      CLAUDE_SHARED_PROVIDER_ID,
      { id: CLAUDE_SHARED_PROVIDER_ID, name: 'Claude', type: 'claude-shared' }
    ],
    [
      'loginIsolatedClaude',
      CLAUDE_ISOLATED_PROVIDER_ID,
      { id: CLAUDE_ISOLATED_PROVIDER_ID, name: 'Claude', type: 'claude-isolated' }
    ],
    [
      'loginIsolatedCodex',
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      {
        id: CODEX_SUBSCRIPTION_PROVIDER_ID,
        name: 'Codex',
        type: 'codex-isolated',
        codexAuthMode: 'isolated'
      }
    ]
  ] as const)('reconnects a fresh active %s result', async (method, activeProviderId, provider) => {
    const { store, capability } = fakeStore()
    store.getSettingsView.mockResolvedValue(
      snapshot({ activeProviderId, providers: [provider] as SettingsSnapshot['providers'] })
    )
    const requestProviderReconnect = vi.fn()
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect })
    ).runtime

    if (method === 'loginIsolatedClaude') await workflows.loginIsolatedClaude('token')
    else await workflows[method]()

    expect(requestProviderReconnect).toHaveBeenCalledOnce()
  })

  it('does not reconnect failed, stale, or no-longer-active login results', async () => {
    const { store, capability } = fakeStore()
    const requestProviderReconnect = vi.fn()
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect })
    ).runtime

    store.loginIsolatedCodex.mockResolvedValue({ ok: true, category: 'ok', applied: false })
    await workflows.loginIsolatedCodex()
    store.loginIsolatedClaude.mockResolvedValue({ ok: false, category: 'unknown' })
    await workflows.loginIsolatedClaude('token')
    store.loginClaudeShared.mockResolvedValue({ ok: true, category: 'ok' })
    store.getSettingsView.mockResolvedValue(snapshot({ activeProviderId: 'other' }))
    await workflows.loginClaudeShared()

    expect(requestProviderReconnect).not.toHaveBeenCalled()
  })

  it.each([
    ['logoutClaudeShared', CLAUDE_SHARED_PROVIDER_ID],
    ['logoutIsolatedClaude', CLAUDE_ISOLATED_PROVIDER_ID],
    ['logoutIsolatedCodex', CODEX_SUBSCRIPTION_PROVIDER_ID]
  ] as const)('reconnects after successful active %s', async (method, activeProviderId) => {
    const { store, capability } = fakeStore()
    store.getSettingsView.mockResolvedValue(snapshot({ activeProviderId }))
    const requestProviderReconnect = vi.fn()
    await createSettingsWorkflows(capability, testEffects({ requestProviderReconnect })).runtime[
      method
    ]()
    expect(requestProviderReconnect).toHaveBeenCalledOnce()
  })
})

describe('SettingsWorkflows catalog and appearance effects', () => {
  it('reloads once after successful Skill mutations and not after a failure', async () => {
    const { store, capability } = fakeStore()
    const requestSkillsReload = vi.fn()
    const notifySkillCatalogChanged = vi.fn()
    const removeTagsForSkill = vi.fn().mockResolvedValue(undefined)
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ requestSkillsReload, notifySkillCatalogChanged, removeTagsForSkill })
    ).skills

    await workflows.setSkillEnabled({ id: 'skill', enabled: true })
    await workflows.setSkillsEnabled({ ids: ['imported-skill'], enabled: false })
    await workflows.createSkill({ name: 'Skill', description: '', body: 'Body' })
    await workflows.deleteSkill({ id: 'deleted-skill' })
    await workflows.setConversationSkillImportEnabled({ enabled: false })
    store.deleteSkill.mockRejectedValue(new Error('delete failed'))
    await expect(workflows.deleteSkill({ id: 'skill' })).rejects.toThrow('delete failed')

    expect(removeTagsForSkill).toHaveBeenCalledWith('deleted-skill')
    expect(notifySkillCatalogChanged).toHaveBeenCalledTimes(4)
    expect(requestSkillsReload).toHaveBeenCalledOnce()
  })

  it('reloads installed Skill batches only when an item changed', async () => {
    const { store, capability } = fakeStore()
    const notifySkillCatalogChanged = vi.fn()
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ notifySkillCatalogChanged })
    ).skills
    const request = { skills: [] }

    store.importAgentHomeSkills.mockResolvedValue({
      results: [{ id: 'a', status: 'unchanged' }],
      skills: []
    })
    await workflows.importAgentHomeSkills(request)
    store.importAgentHomeSkills.mockResolvedValue({
      results: [{ id: 'a', status: 'updated' }],
      skills: []
    })
    await workflows.importAgentHomeSkills(request)

    expect(notifySkillCatalogChanged).toHaveBeenCalledOnce()
  })

  it('invalidates permissions before a fire-and-forget Connector refresh and reloads on settle', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.setConnectorEnabled.mockImplementation(async () => {
      calls.push('persist')
      return { connectors: [] }
    })
    let finishRefresh: (() => void) | undefined
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const effects = testEffects({
      invalidatePermissionProjection: () => calls.push('invalidate'),
      refreshConnectorSkillDocs: () => {
        calls.push('refresh')
        return refresh
      },
      requestSkillsReload: () => calls.push('reload')
    })

    await createSettingsWorkflows(capability, effects).connectors.setConnectorEnabled({
      id: 'chemistry',
      enabled: false
    })
    expect(calls).toEqual(['persist', 'invalidate', 'refresh'])

    finishRefresh?.()
    await vi.waitFor(() => expect(calls).toEqual(['persist', 'invalidate', 'refresh', 'reload']))
  })

  it('refreshes only the custom server whose enabled state changed', async () => {
    const { capability } = fakeStore()
    const refreshConnectorSkillDocs = vi.fn(async () => undefined)
    const effects = testEffects({ refreshConnectorSkillDocs })

    await createSettingsWorkflows(capability, effects).connectors.setCustomServerEnabled({
      id: 'server-1',
      enabled: true
    })

    expect(refreshConnectorSkillDocs).toHaveBeenCalledWith('server-1')
  })

  it('regenerates Connector Skill docs after a displayName update', async () => {
    const { store, capability } = fakeStore()
    const refreshConnectorSkillDocs = vi.fn(async () => undefined)
    store.updateCustomServer.mockResolvedValue({ connectors: [] })

    await createSettingsWorkflows(
      capability,
      testEffects({ refreshConnectorSkillDocs })
    ).connectors.updateCustomServer({
      id: 'server-1',
      displayName: 'Updated label',
      transport: 'stdio',
      command: 'mcp'
    })

    expect(refreshConnectorSkillDocs).toHaveBeenCalledOnce()
  })

  it('refreshes Connector projections after OAuth authentication', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.authenticateCustomServer.mockImplementation(async () => {
      calls.push('authenticate')
      return { connectors: [] }
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        clearCustomServerFailure: (serverId) => calls.push(`clear:${serverId}`),
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: async () => {
          calls.push('refresh')
        }
      })
    ).connectors

    await workflows.authenticateCustomServer({ id: 'server-1' })
    await vi.waitFor(() =>
      expect(calls).toEqual(['authenticate', 'clear:server-1', 'invalidate', 'refresh'])
    )
  })

  it('cancels OAuth authentication without refreshing Connector projections', async () => {
    const { store, capability } = fakeStore()
    const refreshConnectorSkillDocs = vi.fn(async () => undefined)
    const effects = testEffects({ refreshConnectorSkillDocs })
    const workflows = createSettingsWorkflows(capability, effects).connectors

    await workflows.cancelCustomServerAuthentication({ id: 'server-1' })

    expect(store.cancelCustomServerAuthentication).toHaveBeenCalledWith('server-1')
    expect(refreshConnectorSkillDocs).not.toHaveBeenCalled()
  })

  it('waits for a custom Connector retry before returning its refreshed status', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.listConnectors.mockImplementation(async () => {
      calls.push('snapshot')
      return { connectors: [], customServers: [], ncbi: { hasApiKey: false } }
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        resetCustomServerClient: async (id) => {
          calls.push(`reset:${id}`)
        },
        clearCustomServerFailure: (id) => calls.push(`clear:${id}`),
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: async () => {
          calls.push('refresh')
        },
        requestSkillsReload: () => calls.push('reload')
      })
    ).connectors

    await workflows.retryCustomServer({ id: 'server-1' })

    expect(calls).toEqual([
      'reset:server-1',
      'clear:server-1',
      'invalidate',
      'refresh',
      'reload',
      'snapshot'
    ])
  })

  it('refreshes after journaled deletion even when permission pruning fails', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.getConnectors.mockResolvedValue({
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [
        { id: 'server', name: 'Server', transport: 'stdio', command: 'mcp', enabled: true }
      ]
    })
    store.removeCustomServer.mockImplementation(async (_request, afterPersistedRemoval) => {
      calls.push('persist')
      await afterPersistedRemoval('server')
      return { connectors: [] }
    })
    const pruneCustomServerPermissions = vi.fn(async () => {
      calls.push('prune')
    })
    const resetCustomServerClient = vi.fn(async () => {
      calls.push('reset')
    })
    const clearCustomServerFailure = vi.fn(() => {
      calls.push('clear')
    })
    const removeTagsForConnector = vi.fn(async () => {
      calls.push('tags')
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        pruneCustomServerPermissions,
        resetCustomServerClient,
        clearCustomServerFailure,
        removeTagsForConnector,
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: async () => {
          calls.push('refresh')
        }
      })
    ).connectors

    await workflows.removeCustomServer({ id: 'server' })
    expect(calls).toEqual(['persist', 'reset', 'clear', 'prune', 'tags', 'invalidate', 'refresh'])

    calls.length = 0
    pruneCustomServerPermissions.mockImplementation(async () => {
      calls.push('prune')
      throw new Error('prune failed')
    })
    await expect(workflows.removeCustomServer({ id: 'server' })).rejects.toThrow('prune failed')
    expect(calls).toEqual(['persist', 'reset', 'clear', 'prune', 'invalidate', 'refresh'])

    calls.length = 0
    resetCustomServerClient.mockImplementationOnce(async () => {
      calls.push('reset')
      throw new Error('reset failed')
    })
    await expect(workflows.removeCustomServer({ id: 'server' })).rejects.toThrow('reset failed')
    expect(calls).toEqual(['persist', 'reset', 'invalidate', 'refresh'])
  })

  it('owns the security-sensitive update barrier and rolls it back when prune fails', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    const guard = {
      commit: vi.fn(() => calls.push('commit')),
      rollback: vi.fn(() => calls.push('rollback'))
    }
    store.updateCustomServer.mockImplementation(async (_request, beforeSecurityChange) => {
      const acquired = await beforeSecurityChange('server')
      calls.push('persist')
      acquired?.commit({ id: 'server' })
      return { connectors: [] }
    })
    const pruneCustomServerPermissions = vi.fn(async () => {
      calls.push('prune')
    })
    store.cancelCustomServerAuthentication.mockImplementation(async () => {
      calls.push('cancel')
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        beginCustomServerSecurityChange: () => {
          calls.push('begin')
          return guard as never
        },
        pruneCustomServerPermissions,
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: async () => {
          calls.push('refresh')
        }
      })
    ).connectors
    const request = { id: 'server', transport: 'stdio' as const, command: 'new-mcp' }

    await workflows.updateCustomServer(request)
    expect(calls).toEqual([
      'begin',
      'cancel',
      'prune',
      'persist',
      'commit',
      'invalidate',
      'refresh'
    ])

    calls.length = 0
    pruneCustomServerPermissions.mockRejectedValue(new Error('prune failed'))
    await expect(workflows.updateCustomServer(request)).rejects.toThrow('prune failed')
    expect(calls).toEqual(['begin', 'cancel', 'rollback'])
  })

  it('applies an icon only after persistence succeeds', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.setAppIconVariant.mockImplementation(async () => {
      calls.push('persist')
      return snapshot({ appIconVariant: 'dark' })
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ applyAppIconVariant: () => calls.push('apply') })
    ).appearance

    await workflows.setAppIconVariant('dark')
    expect(calls).toEqual(['persist', 'apply'])

    store.setAppIconVariant.mockRejectedValue(new Error('save failed'))
    await expect(workflows.setAppIconVariant('light')).rejects.toThrow('save failed')
    expect(calls).toEqual(['persist', 'apply'])
  })
})
