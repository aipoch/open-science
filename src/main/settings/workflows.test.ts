import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
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
  codebuddy: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codebuddyManaged: false,
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
    uninstallCodeBuddy: vi.fn(),
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
    waitXaiOAuthLogin: vi.fn().mockResolvedValue({ ok: true }),
    logoutXaiOAuth: vi.fn().mockResolvedValue(snapshot()),
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
    listDeviceCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
    deviceCredentialConsumerIds: vi.fn().mockResolvedValue([]),
    deviceCredentialIdForServer: vi.fn().mockResolvedValue(undefined),
    createDeviceCredential: vi.fn().mockResolvedValue({
      credentials: [],
      createdCredential: {
        id: 'created',
        displayName: 'Created',
        kind: 'token',
        status: 'stored',
        needsSecret: false,
        consumerCount: 0,
        consumerNames: [],
        createdAt: 1,
        updatedAt: 1
      }
    }),
    updateDeviceCredential: vi.fn().mockResolvedValue({ credentials: [] }),
    removeDeviceCredential: vi.fn().mockResolvedValue({ credentials: [] }),
    authenticateDeviceCredential: vi.fn().mockResolvedValue({ credentials: [] }),
    cancelDeviceCredentialAuthentication: vi.fn().mockResolvedValue(undefined),
    disconnectDeviceCredential: vi.fn().mockResolvedValue({ credentials: [] }),
    addCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    setCustomServerEnabled: vi.fn().mockResolvedValue({ connectors: [] }),
    removeCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    updateCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    authenticateCustomServer: vi.fn().mockResolvedValue({ connectors: [] }),
    cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
    disconnectCustomServer: vi.fn().mockResolvedValue({ connectors: [] })
  }
  return { store, capability: store as unknown as SettingsWorkflowStore }
}

describe('SettingsWorkflows runtime effects', () => {
  it.each([
    ['uninstallClaude', 'claude-code', 'opencode'],
    ['uninstallOpencode', 'opencode', 'codex'],
    ['uninstallCodeBuddy', 'codebuddy', 'claude-code'],
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

  it('retires matching generations when an affected uninstall keeps the same framework', async () => {
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

    expect(requestAgentFrameworkSwitch).toHaveBeenCalledOnce()
    expect(requestAgentFrameworkSwitch).toHaveBeenCalledWith('claude-code')
    expect(requestProviderReconnect).not.toHaveBeenCalled()

    store.uninstallClaude.mockResolvedValue({
      snapshot: snapshot({ agentFrameworkId: 'claude-code' }),
      activeBackendAffected: false
    })
    await createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect, requestAgentFrameworkSwitch })
    ).runtime.uninstallRuntime('uninstallClaude', 'claude-code')
    expect(requestAgentFrameworkSwitch).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).not.toHaveBeenCalled()
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

  it('targets an edited inactive provider without reconnecting the default runtime', async () => {
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

    expect(requestProviderReconnect).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).toHaveBeenCalledWith(['inactive'], false)
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

  it('ignores failed or stale logins and targets a successful no-longer-active provider', async () => {
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

    expect(requestProviderReconnect).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).toHaveBeenCalledWith([CLAUDE_SHARED_PROVIDER_ID], false)
  })

  it('reconnects targeted XAI Sessions after login even when another provider is active', async () => {
    const { store, capability } = fakeStore()
    store.getSettingsView.mockResolvedValue(snapshot({ activeProviderId: 'other' }))
    const requestProviderReconnect = vi.fn()
    await createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect })
    ).runtime.waitXaiOAuthLogin()
    expect(requestProviderReconnect).toHaveBeenCalledWith([XAI_SUBSCRIPTION_PROVIDER_ID], false)
  })

  it('reconnects targeted XAI Sessions after logout even when another provider is active', async () => {
    const { store, capability } = fakeStore()
    store.logoutXaiOAuth.mockResolvedValue(snapshot({ activeProviderId: 'other' }))
    const requestProviderReconnect = vi.fn()
    await createSettingsWorkflows(
      capability,
      testEffects({ requestProviderReconnect })
    ).runtime.logoutXaiOAuth()
    expect(requestProviderReconnect).toHaveBeenCalledWith([XAI_SUBSCRIPTION_PROVIDER_ID], false)
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
    removeTagsForSkill.mockRejectedValueOnce(new Error('Tag cleanup failed'))
    await expect(workflows.deleteSkill({ id: 'deleted-skill-with-tag-failure' })).resolves.toEqual(
      []
    )
    await workflows.setConversationSkillImportEnabled({ enabled: false })
    store.deleteSkill.mockRejectedValue(new Error('delete failed'))
    await expect(workflows.deleteSkill({ id: 'skill' })).rejects.toThrow('delete failed')

    expect(removeTagsForSkill).toHaveBeenNthCalledWith(1, 'deleted-skill')
    expect(removeTagsForSkill).toHaveBeenNthCalledWith(2, 'deleted-skill-with-tag-failure')
    expect(notifySkillCatalogChanged).toHaveBeenCalledTimes(5)
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

  it('closes an unbound device credential client before removing the credential', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.removeDeviceCredential.mockImplementation(async () => {
      calls.push('remove')
      return { credentials: [] }
    })
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        resetCustomServerClient: async (id) => {
          calls.push(`reset:${id}`)
        }
      })
    ).connectors

    await workflows.removeDeviceCredential({ id: 'shared-oauth' })

    expect(calls).toEqual(['reset:credential:shared-oauth', 'remove'])
  })

  it('leaves a bound device credential client untouched when removal will be rejected', async () => {
    const resetCustomServerClient = vi.fn(async () => undefined)
    const { store, capability } = fakeStore()
    store.deviceCredentialConsumerIds.mockResolvedValue(['server-1'])
    store.removeDeviceCredential.mockRejectedValue(new Error('Credential is used by: server-1'))
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({ resetCustomServerClient })
    ).connectors

    await expect(workflows.removeDeviceCredential({ id: 'shared-oauth' })).rejects.toThrow(
      /server-1/
    )

    expect(resetCustomServerClient).not.toHaveBeenCalled()
  })

  it('resets every consumer before disconnecting a shared OAuth credential', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.disconnectDeviceCredential.mockImplementation(async (_request, withConsumersBlocked) =>
      withConsumersBlocked(['server-1', 'server-2'], async () => {
        calls.push('disconnect')
        return { credentials: [] }
      })
    )
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        beginCustomServerSecurityChange: (id) => {
          calls.push(`begin:${id}`)
          return {
            commit: vi.fn(),
            rollback: () => calls.push(`release:${id}`)
          } as never
        },
        resetCustomServerClient: async (id) => {
          calls.push(`reset:${id}`)
        }
      })
    ).connectors

    await workflows.disconnectDeviceCredential({ id: 'shared-oauth' })

    expect(calls).toEqual([
      'begin:server-1',
      'begin:server-2',
      'reset:server-1',
      'reset:server-2',
      'disconnect',
      'reset:server-1',
      'reset:server-2',
      'release:server-1',
      'release:server-2'
    ])
  })

  it('uses the same consumer barrier when disconnecting through a Connector', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    store.disconnectCustomServer.mockImplementation(async (_serverId, withConsumersBlocked) =>
      withConsumersBlocked(['server-1', 'server-2'], async () => {
        calls.push('disconnect')
        return { connectors: [], customServers: [] }
      })
    )
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        beginCustomServerSecurityChange: (id) => {
          calls.push(`begin:${id}`)
          return {
            commit: vi.fn(),
            rollback: () => calls.push(`release:${id}`)
          } as never
        },
        resetCustomServerClient: async (id) => {
          calls.push(`reset:${id}`)
        }
      })
    ).connectors

    await workflows.disconnectCustomServer({ id: 'server-1' })

    expect(calls).toEqual([
      'begin:server-1',
      'begin:server-2',
      'reset:server-1',
      'reset:server-2',
      'disconnect',
      'reset:server-1',
      'reset:server-2',
      'release:server-1',
      'release:server-2'
    ])
  })

  it('blocks and resets consumers across a static credential rotation', async () => {
    const calls: string[] = []
    let finishRefresh!: () => void
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const { store, capability } = fakeStore()
    store.updateDeviceCredential.mockImplementation(async (_request, withConsumersBlocked) =>
      withConsumersBlocked(['server-1'], async () => {
        calls.push('update')
        return { credentials: [] }
      })
    )
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        beginCustomServerSecurityChange: () => {
          calls.push('begin')
          return { commit: vi.fn(), rollback: () => calls.push('release') } as never
        },
        resetCustomServerClient: async () => {
          calls.push('reset')
        },
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: () => {
          calls.push('refresh')
          return refresh
        },
        requestSkillsReload: () => calls.push('reload')
      })
    ).connectors

    const rotation = workflows.updateDeviceCredential({
      id: 'shared-static',
      secret: 'rotated'
    })
    await vi.waitFor(() =>
      expect(calls).toEqual(['begin', 'reset', 'update', 'invalidate', 'refresh'])
    )

    finishRefresh()
    await rotation

    expect(calls).toEqual([
      'begin',
      'reset',
      'update',
      'invalidate',
      'refresh',
      'reload',
      'reset',
      'release'
    ])
  })

  it('keeps consumers fail-closed when a rotated credential cannot reach the runtime', async () => {
    const release = vi.fn()
    const { store, capability } = fakeStore()
    store.updateDeviceCredential.mockImplementation(async (_request, withConsumersBlocked) =>
      withConsumersBlocked(['server-1'], async () => ({ credentials: [] }))
    )
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        beginCustomServerSecurityChange: () => ({ commit: vi.fn(), rollback: release }) as never,
        refreshConnectorSkillDocs: async () => {
          throw new Error('refresh failed')
        }
      })
    ).connectors

    await expect(
      workflows.updateDeviceCredential({ id: 'shared-static', secret: 'rotated' })
    ).rejects.toThrow('refresh failed')

    expect(store.updateDeviceCredential).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
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

  it('reports an explicit Connector projection retry failure after requesting an Agent reload', async () => {
    const calls: string[] = []
    const { store, capability } = fakeStore()
    const workflows = createSettingsWorkflows(
      capability,
      testEffects({
        invalidatePermissionProjection: () => calls.push('invalidate'),
        refreshConnectorSkillDocs: async () => {
          calls.push('refresh')
          throw new Error('projection refresh failed')
        },
        requestSkillsReload: () => calls.push('reload')
      })
    ).connectors

    await expect(workflows.retryConnectorProjection()).rejects.toThrow('projection refresh failed')

    expect(calls).toEqual(['invalidate', 'refresh', 'reload'])
    expect(store.listConnectors).not.toHaveBeenCalled()
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

    calls.length = 0
    pruneCustomServerPermissions.mockImplementation(async () => {
      calls.push('prune')
    })
    removeTagsForConnector.mockImplementationOnce(async () => {
      calls.push('tags')
      throw new Error('Tag cleanup failed')
    })
    await expect(workflows.removeCustomServer({ id: 'server' })).rejects.toThrow(
      'Tag cleanup failed'
    )
    expect(calls).toEqual(['persist', 'reset', 'clear', 'prune', 'tags', 'invalidate', 'refresh'])
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
