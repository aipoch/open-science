import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID
} from '../../shared/settings'
import type { SettingsService } from './service'
import type { SettingsIpcOptions } from './ipc'
import type { SettingsWorkflowEffects } from './workflows'

// Capture every ipcMain.handle registration so handlers can be invoked directly in the test.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { registerSettingsIpcHandlers } = await import('./ipc')
const { createSettingsWorkflows } = await import('./workflows')
const { addRendererBroadcastSink, broadcastToRenderers } = await import('../renderer-broadcast')
const { SettingsSnapshotCommitOwner } = await import('./settings-snapshot-commit-owner')

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// A fake service whose methods are all spies; cast to SettingsService only when registering handlers.
type FakeSettingsService = Record<
  | 'getPreflight'
  | 'getSettingsView'
  | 'isEncryptionAvailable'
  | 'isNpmAvailable'
  | 'checkEnvironment'
  | 'detectClaude'
  | 'detectCodeBuddy'
  | 'detectOpencode'
  | 'detectCodex'
  | 'installClaude'
  | 'installCodeBuddy'
  | 'installOpencode'
  | 'installCodex'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallCodeBuddy'
  | 'uninstallCodex'
  | 'setAgentFramework'
  | 'setReasoningEffort'
  | 'setReviewerModel'
  | 'setSessionDetailsModel'
  | 'setSubagentModel'
  | 'setVisionModel'
  | 'resolveActiveReasoningEffort'
  | 'resolveActiveModelChangeTarget'
  | 'setNotificationsEnabled'
  | 'setShowNotificationContent'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setProjectFilesFilter'
  | 'setDefaultPermissionProfile'
  | 'setAppIconVariant'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'validateProvider'
  | 'cancelCodexLogin'
  | 'cancelClaudeLogin'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'loginClaudeShared'
  | 'logoutClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'cancelClaudeIsolatedLogin'
  | 'logoutIsolatedClaude'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
  | 'refreshProviderModels'
  | 'markOnboardingComplete'
  | 'getPackageMirror'
  | 'setPackageMirror'
  | 'setNetworkProxy'
  | 'setNotebookNetwork'
  | 'listSkills'
  | 'getSkillDetail'
  | 'resolveSkillDocument'
  | 'buildSkillExport'
  | 'setSkillEnabled'
  | 'setSkillsEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkillZipBatch'
  | 'previewGitHubSkill'
  | 'listAgentHomeSkills'
  | 'previewAgentHomeSkill'
  | 'importAgentHomeSkills'
  | 'previewCustomServerTemplateExport'
  | 'buildCustomServerTemplateExport'
  | 'previewCustomServerTemplateImport'
  | 'setConnectorEnabled'
  | 'updateCustomServer'
  | 'cancelCustomServerAuthentication'
  | 'setComputeBookmarks',
  ReturnType<typeof vi.fn>
>

const createFakeService = (): FakeSettingsService => ({
  getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
  getSettingsView: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  isNpmAvailable: vi.fn().mockResolvedValue(true),
  checkEnvironment: vi.fn().mockResolvedValue({ ready: true, checks: [] }),
  detectClaude: vi.fn().mockResolvedValue({ found: false }),
  detectCodeBuddy: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'codebuddy' }),
  detectOpencode: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'opencode' }),
  detectCodex: vi.fn().mockResolvedValue({ codex: {}, providers: [], agentFrameworkId: 'codex' }),
  installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
  installCodeBuddy: vi.fn().mockResolvedValue({ installId: 'cb', ok: true }),
  installOpencode: vi.fn().mockResolvedValue({ installId: 'oc', ok: true }),
  installCodex: vi.fn().mockResolvedValue({ installId: 'cx', ok: true }),
  uninstallClaude: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'claude-code' },
    activeBackendAffected: true
  }),
  uninstallOpencode: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'opencode' },
    activeBackendAffected: true
  }),
  uninstallCodeBuddy: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'codebuddy' },
    activeBackendAffected: true
  }),
  uninstallCodex: vi.fn().mockResolvedValue({
    snapshot: { claude: {}, providers: [], agentFrameworkId: 'codex' },
    activeBackendAffected: true
  }),
  setAgentFramework: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], agentFrameworkId: 'opencode' }),
  setReasoningEffort: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], reasoningEffort: 'high' }),
  setReviewerModel: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], reviewerModel: { mode: 'inherit' } }),
  setSessionDetailsModel: vi.fn().mockResolvedValue({
    claude: {},
    providers: [],
    sessionDetailsModel: { mode: 'inherit', reasoningEffort: 'low' }
  }),
  setSubagentModel: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], subagentModel: { mode: 'inherit' } }),
  setVisionModel: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  resolveActiveReasoningEffort: vi.fn().mockResolvedValue('high'),
  resolveActiveModelChangeTarget: vi.fn().mockResolvedValue(undefined),
  setNotificationsEnabled: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], notificationsEnabled: false }),
  setShowNotificationContent: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], showNotificationContent: false }),
  setConversationSkillImportEnabled: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], conversationSkillImportEnabled: false }),
  setClosePreference: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], closePreference: 'quit' }),
  setProjectFilesFilter: vi.fn().mockResolvedValue({
    claude: {},
    providers: [],
    projectFilesFilter: { sourceMode: 'local' }
  }),
  setDefaultPermissionProfile: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], defaultPermissionProfile: 'auto' }),

  setAppIconVariant: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], appIconVariant: 'dark' }),
  upsertProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  deleteProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  setActiveProvider: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  validateProvider: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelCodexLogin: vi.fn(),
  cancelClaudeLogin: vi.fn(),
  loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutIsolatedCodex: vi
    .fn()
    .mockResolvedValue({ claude: {}, providers: [], activeProviderId: undefined }),
  loginClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  logoutClaudeShared: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  cancelClaudeIsolatedLogin: vi.fn(),
  logoutIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok' }),
  beginXaiOAuthLogin: vi.fn().mockResolvedValue({ userCode: 'XAI-1234' }),
  waitXaiOAuthLogin: vi.fn().mockResolvedValue({ accountEmail: 'user@example.com' }),
  cancelXaiOAuthLogin: vi.fn(),
  logoutXaiOAuth: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  refreshProviderModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
  markOnboardingComplete: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
  getPackageMirror: vi.fn().mockResolvedValue({}),
  setPackageMirror: vi.fn().mockResolvedValue({}),
  setNetworkProxy: vi.fn().mockResolvedValue({ mode: 'system' }),
  setNotebookNetwork: vi.fn().mockResolvedValue({
    allowedDomains: [],
    disabledOpenScienceDomainGroups: [],
    disabledOpenScienceDomains: []
  }),
  listSkills: vi.fn().mockResolvedValue([]),
  getSkillDetail: vi.fn().mockResolvedValue({
    id: 'demo',
    name: 'Demo',
    description: '',
    source: 'featured',
    updatedAt: '',
    enabled: true,
    body: 'b'
  }),
  resolveSkillDocument: vi.fn().mockResolvedValue(null),
  buildSkillExport: vi.fn().mockResolvedValue({
    fileName: 'my-skill.zip',
    archiveBytes: new Uint8Array([1, 2, 3])
  }),
  setSkillEnabled: vi.fn().mockResolvedValue([]),
  setSkillsEnabled: vi.fn().mockResolvedValue([]),
  createSkill: vi.fn().mockResolvedValue([]),
  updateSkill: vi.fn().mockResolvedValue([]),
  deleteSkill: vi.fn().mockResolvedValue([]),
  importSkillZipBatch: vi.fn().mockResolvedValue({ results: [], skills: [] }),
  previewGitHubSkill: vi.fn().mockResolvedValue({ name: 'GitHub preview' }),
  listAgentHomeSkills: vi.fn().mockResolvedValue([]),
  previewAgentHomeSkill: vi.fn().mockResolvedValue({ name: 'Installed preview' }),
  importAgentHomeSkills: vi.fn().mockResolvedValue({ results: [], skills: [] }),
  previewCustomServerTemplateExport: vi.fn().mockResolvedValue({
    connectorId: 'server-id',
    ready: true,
    diagnostics: [],
    digest: 'digest',
    suggestedFileName: 'open-science-connector-example.json'
  }),
  buildCustomServerTemplateExport: vi.fn().mockResolvedValue({
    preview: {
      connectorId: 'server-id',
      ready: true,
      diagnostics: [],
      digest: 'digest',
      suggestedFileName: 'open-science-connector-example.json',
      mcpClientDigest: 'mcp-digest',
      mcpClientSuggestedFileName: 'mcp-example.json'
    },
    contents: '{"schemaVersion":1}\n',
    mcpClientContents: '{"mcpServers":{}}\n'
  }),
  previewCustomServerTemplateImport: vi.fn().mockResolvedValue({
    ready: true,
    diagnostics: [],
    definition: {
      schemaVersion: 1,
      kind: 'open-science.connector',
      name: 'example-server',
      slug: 'example-server',
      transport: 'stdio',
      command: 'example-mcp'
    }
  }),
  setConnectorEnabled: vi.fn().mockResolvedValue({ connectors: [] }),
  updateCustomServer: vi.fn().mockResolvedValue({ connectors: [], customServers: [] }),
  cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
  setComputeBookmarks: vi.fn().mockResolvedValue([])
})

// Adapts the spy bag into the SettingsService shape the registration function expects.
const asService = (fake: FakeSettingsService): SettingsService => fake as unknown as SettingsService

type TestSettingsIpcOptions = {
  service: SettingsService
  onActiveProviderChanged?: () => void
  onAgentFrameworkChanged?: SettingsWorkflowEffects['runtime']['requestAgentFrameworkSwitch']
  onSkillsChanged?: () => void
  onConnectorsChanged?: () => void
  onCustomServerRemoved?: (serverId: string) => Promise<void>
  onCustomServerSecurityChanged?: (serverId: string) => Promise<unknown>
  onAppIconVariantChanged?: SettingsWorkflowEffects['appearance']['applyAppIconVariant']
  listAppIconPreviews?: SettingsIpcOptions['listAppIconPreviews']
  connectorTemplateFiles?: SettingsIpcOptions['connectorTemplateFiles']
  skillExportFiles?: SettingsIpcOptions['skillExportFiles']
}

// Keeps the adapter tests concise while routing every mutation through the real workflow owner.
const registerTestSettingsIpcHandlers = ({
  service,
  onActiveProviderChanged,
  onAgentFrameworkChanged,
  onSkillsChanged,
  onConnectorsChanged,
  onCustomServerRemoved,
  onCustomServerSecurityChanged,
  onAppIconVariantChanged,
  listAppIconPreviews,
  connectorTemplateFiles,
  skillExportFiles
}: TestSettingsIpcOptions): void => {
  registerSettingsIpcHandlers({
    service,
    snapshotCommits: new SettingsSnapshotCommitOwner(service, {
      publish: (channel, payload) => broadcastToRenderers(channel, payload)
    }),
    workflows: createSettingsWorkflows(service, {
      runtime: {
        requestProviderReconnect: onActiveProviderChanged ?? (() => undefined),
        requestAgentFrameworkSwitch: onAgentFrameworkChanged ?? (() => undefined)
      },
      skills: {
        requestSkillsReload: onSkillsChanged ?? (() => undefined),
        notifySkillCatalogChanged: onSkillsChanged ?? (() => undefined),
        removeTagsForSkill: async () => undefined
      },
      connectors: {
        invalidatePermissionProjection: onConnectorsChanged ?? (() => undefined),
        refreshConnectorSkillDocs: async () => undefined,
        requestSkillsReload: onSkillsChanged ?? (() => undefined),
        pruneCustomServerPermissions:
          onCustomServerRemoved ??
          (onCustomServerSecurityChanged
            ? async (serverId) => {
                await onCustomServerSecurityChanged(serverId)
              }
            : async () => undefined),
        removeTagsForConnector: async () => undefined,
        beginCustomServerSecurityChange: () => undefined,
        clearCustomServerFailure: () => undefined,
        resetCustomServerClient: async () => undefined
      },
      appearance: {
        applyAppIconVariant: onAppIconVariantChanged ?? (() => undefined)
      }
    }),
    listAppIconPreviews,
    connectorTemplateFiles,
    skillExportFiles
  })
}

const ipcSender = { id: 42 }
const invoke = (channel: string, payload?: unknown): unknown =>
  handlers.get(channel)!({ sender: ipcSender }, payload)

describe('settings IPC handlers', () => {
  it('registers every settings channel', () => {
    handlers.clear()
    registerTestSettingsIpcHandlers({ service: asService(createFakeService()) })

    for (const channel of [
      'settings:get-preflight',
      'settings:get-settings',
      'settings:encryption-available',
      'settings:npm-available',
      'settings:check-environment',
      'settings:detect-claude',
      'settings:install-claude',
      'settings:upsert-provider',
      'settings:delete-provider',
      'settings:set-active-provider',
      'settings:set-subagent-model',
      'settings:set-conversation-skill-import-enabled',
      'settings:validate-provider',
      'settings:cancel-codex-login',
      'settings:cancel-claude-login',
      'settings:login-isolated-codex',
      'settings:logout-isolated-codex',
      'settings:login-shared-claude',
      'settings:logout-shared-claude',
      'settings:login-isolated-claude',
      'settings:login-isolated-claude-browser',
      'settings:cancel-isolated-claude-login',
      'settings:logout-isolated-claude',
      'settings:mark-onboarding-complete',
      'settings:export-skill',
      'settings:preview-custom-server-template-export',
      'settings:select-custom-server-template',
      'settings:export-custom-server-template'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('validates selected Connector files and saves only the previewed export', async () => {
    handlers.clear()
    const service = createFakeService()
    const connectorTemplateFiles = {
      select: vi.fn().mockResolvedValue({
        cancelled: false as const,
        fileName: 'example.json',
        contents: '{"schemaVersion":1}'
      }),
      save: vi.fn().mockResolvedValue(true)
    }
    registerTestSettingsIpcHandlers({
      service: asService(service),
      connectorTemplateFiles
    })

    await expect(invoke('settings:select-custom-server-template')).resolves.toMatchObject({
      cancelled: false,
      fileName: 'example.json',
      preview: { ready: true }
    })
    expect(service.previewCustomServerTemplateImport).toHaveBeenCalledWith('{"schemaVersion":1}')

    await expect(
      invoke('settings:select-custom-server-template', {
        fileName: 'dropped.json',
        contents: '{"schemaVersion":1,"kind":"open-science.connector"}'
      })
    ).resolves.toMatchObject({
      cancelled: false,
      fileName: 'dropped.json',
      preview: { ready: true }
    })
    expect(connectorTemplateFiles.select).toHaveBeenCalledTimes(1)
    expect(service.previewCustomServerTemplateImport).toHaveBeenLastCalledWith(
      '{"schemaVersion":1,"kind":"open-science.connector"}'
    )

    await expect(
      invoke('settings:export-custom-server-template', {
        id: 'server-id',
        expectedDigest: 'digest'
      })
    ).resolves.toEqual({ saved: true })
    expect(connectorTemplateFiles.save).toHaveBeenCalledWith(
      'open-science-connector-example.json',
      '{"schemaVersion":1}\n',
      ipcSender
    )

    await expect(
      invoke('settings:export-custom-server-template', {
        id: 'server-id',
        expectedDigest: 'mcp-digest',
        format: 'mcp-client'
      })
    ).resolves.toEqual({ saved: true })
    expect(connectorTemplateFiles.save).toHaveBeenLastCalledWith(
      'mcp-example.json',
      '{"mcpServers":{}}\n',
      ipcSender
    )

    await expect(
      invoke('settings:export-custom-server-template', {
        id: 'server-id',
        expectedDigest: 'stale'
      })
    ).rejects.toThrow('changed after preview')
  })

  it('routes provider commands to the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:upsert-provider', { type: 'custom', name: 'G' })
    expect(service.upsertProvider).toHaveBeenCalledWith({ type: 'custom', name: 'G' })

    await invoke('settings:delete-provider', { id: 'p1' })
    expect(service.deleteProvider).toHaveBeenCalledWith('p1')

    await invoke('settings:validate-provider', { providerId: 'p1' })
    expect(service.validateProvider).toHaveBeenCalledWith({ providerId: 'p1' })

    await invoke('settings:cancel-codex-login')
    expect(service.cancelCodexLogin).toHaveBeenCalledOnce()

    await invoke('settings:logout-isolated-codex')
    expect(service.logoutIsolatedCodex).toHaveBeenCalledOnce()

    await invoke('settings:cancel-claude-login')
    expect(service.cancelClaudeLogin).toHaveBeenCalledOnce()

    await invoke('settings:login-shared-claude')
    expect(service.loginClaudeShared).toHaveBeenCalledOnce()

    await invoke('settings:logout-shared-claude')
    expect(service.logoutClaudeShared).toHaveBeenCalledOnce()

    await invoke('settings:login-isolated-claude', 'sk-ant-test')
    expect(service.loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-test')

    await invoke('settings:login-isolated-claude-browser')
    expect(service.loginIsolatedClaudeBrowser).toHaveBeenCalledOnce()

    await invoke('settings:cancel-isolated-claude-login')
    expect(service.cancelClaudeIsolatedLogin).toHaveBeenCalledOnce()
  })

  it('reconnects the active Codex subscription after isolated logout', async () => {
    handlers.clear()
    const service = createFakeService()
    service.logoutIsolatedCodex.mockResolvedValue({ ok: true, category: 'ok' })
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    await invoke('settings:logout-isolated-codex')

    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('does not reconnect when app-owned isolated logout fails', async () => {
    handlers.clear()
    const service = createFakeService()
    service.logoutIsolatedCodex.mockResolvedValue({
      ok: false,
      category: 'unknown',
      message: 'The Open Science Codex login could not be removed.'
    })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    await invoke('settings:logout-isolated-codex')

    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('reconnects the active provider only when the isolated login was actually applied', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    // Login succeeded and the active provider is still the isolated subscription: reconnect.
    service.loginIsolatedCodex.mockResolvedValue({ ok: true, category: 'ok', applied: true })
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [
        {
          id: CODEX_SUBSCRIPTION_PROVIDER_ID,
          type: 'codex-isolated',
          codexAuthMode: 'isolated'
        }
      ],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    await invoke('settings:login-isolated-codex')
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()

    // Login succeeded but the provider was switched to imported auth mid-flow (outcome discarded):
    // the imported runtime's credentials didn't change, so a reconnect would be redundant.
    onActiveProviderChanged.mockClear()
    service.loginIsolatedCodex.mockResolvedValue({ ok: true, category: 'ok', applied: false })
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [
        {
          id: CODEX_SUBSCRIPTION_PROVIDER_ID,
          type: 'codex-isolated',
          codexAuthMode: 'imported'
        }
      ],
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID
    })
    await invoke('settings:login-isolated-codex')
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('routes mark-onboarding-complete to the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:mark-onboarding-complete')

    expect(service.markOnboardingComplete).toHaveBeenCalledTimes(1)
  })

  it('fires onConnectorsChanged after a connector is toggled', async () => {
    handlers.clear()
    const service = createFakeService()
    const onConnectorsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onConnectorsChanged })

    await invoke('settings:set-connector-enabled', { id: 'biomart', enabled: false })

    // The callback is what drives ipc.ts's refresh-then-reload chain (reload runs in a .finally so it
    // fires even if the refresh rejects — see connector-skill-reload.finally.test.ts).
    expect(service.setConnectorEnabled).toHaveBeenCalledWith({ id: 'biomart', enabled: false })
    expect(onConnectorsChanged).toHaveBeenCalledOnce()
  })

  it('routes OAuth cancellation without treating it as a Connector settings change', async () => {
    handlers.clear()
    const fake = createFakeService()
    const onConnectorsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(fake), onConnectorsChanged })

    await invoke('settings:cancel-custom-server-authentication', { id: 'server-id' })

    expect(fake.cancelCustomServerAuthentication).toHaveBeenCalledWith('server-id')
    expect(onConnectorsChanged).not.toHaveBeenCalled()
  })

  it('passes the custom-server security invalidation gate through before refreshing connectors', async () => {
    handlers.clear()
    const service = createFakeService()
    const onCustomServerSecurityChanged = vi.fn().mockResolvedValue(undefined)
    const onConnectorsChanged = vi.fn()
    service.updateCustomServer.mockImplementation(async (_request, beforeSecurityChange) => {
      await beforeSecurityChange('server-id')
      return { connectors: [], customServers: [] }
    })
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onCustomServerSecurityChanged,
      onConnectorsChanged
    })
    const request = {
      id: 'server-id',
      transport: 'streamable_http' as const,
      url: 'https://replacement.example/mcp'
    }

    await invoke('settings:update-custom-server', request)

    expect(service.updateCustomServer).toHaveBeenCalledWith(request, expect.any(Function))
    expect(onCustomServerSecurityChanged).toHaveBeenCalledWith('server-id')
    expect(onConnectorsChanged).toHaveBeenCalledOnce()
  })

  it('persists an active provider as the default without reconnecting live Sessions', async () => {
    handlers.clear()
    const service = createFakeService()
    service.getSettingsView.mockResolvedValue({ activeProviderId: 'p0', providers: [] })
    service.setActiveProvider.mockResolvedValue({ activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:set-active-provider', { id: 'p1' })

    expect(service.setActiveProvider).toHaveBeenCalledWith('p1', undefined)
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('drops the agent connection when the active provider is deleted', async () => {
    handlers.clear()
    const service = createFakeService()
    service.getSettingsView.mockResolvedValue({ activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:delete-provider', { id: 'p1' })

    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it('drops the agent connection when grouped Claude deletion removes the active sibling', async () => {
    handlers.clear()
    const service = createFakeService()
    service.getSettingsView.mockResolvedValue({
      activeProviderId: CLAUDE_SHARED_PROVIDER_ID,
      providers: []
    })
    service.deleteProvider.mockResolvedValue({
      claude: {},
      activeProviderId: undefined,
      providers: []
    })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:delete-provider', { id: CLAUDE_ISOLATED_PROVIDER_ID })

    expect(onActiveProviderChanged).toHaveBeenCalledWith(
      [CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID],
      true
    )
  })

  it('drops the agent connection when the edited provider is the active one', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:upsert-provider', { id: 'p1', type: 'custom', name: 'G' })

    // Editing the live provider must respawn the agent so the new base URL / key / model take effect.
    expect(onActiveProviderChanged).toHaveBeenCalledOnce()
  })

  it.each([
    [CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID, 'claude-isolated'],
    [CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID, 'claude-shared']
  ] as const)(
    'drops the agent connection when active Claude mode changes from %s to %s',
    async (previousProviderId, nextProviderId, nextType) => {
      handlers.clear()
      const service = createFakeService()
      service.getSettingsView.mockResolvedValue({
        claude: {},
        activeProviderId: previousProviderId,
        providers: []
      })
      service.upsertProvider.mockResolvedValue({
        claude: {},
        activeProviderId: nextProviderId,
        providers: []
      })
      const onActiveProviderChanged = vi.fn()
      registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

      await invoke('settings:upsert-provider', {
        id: previousProviderId,
        type: nextType,
        name: 'Claude subscription'
      })

      expect(onActiveProviderChanged).toHaveBeenCalledOnce()
    }
  )

  it('targets Sessions using an edited non-active provider without reconnecting the default', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:upsert-provider', { id: 'p2', type: 'custom', name: 'Other' })

    expect(onActiveProviderChanged).toHaveBeenCalledWith(['p2'], false)
  })

  it('does not drop the connection when creating a new provider', async () => {
    handlers.clear()
    const service = createFakeService()
    service.upsertProvider.mockResolvedValue({ claude: {}, activeProviderId: 'p1', providers: [] })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    // A create has no id, so it can't be the active provider yet — no respawn.
    await invoke('settings:upsert-provider', { type: 'custom', name: 'New' })

    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', 'opencode'],
    ['opencode', 'codex'],
    ['codebuddy', 'claude-code'],
    ['codex', 'claude-code']
  ] as const)(
    'rotates the runtime after uninstalling active %s auto-switches frameworks',
    async (channel, fallbackFramework) => {
      handlers.clear()
      const service = createFakeService()
      service[
        channel === 'claude'
          ? 'uninstallClaude'
          : channel === 'opencode'
            ? 'uninstallOpencode'
            : channel === 'codebuddy'
              ? 'uninstallCodeBuddy'
              : 'uninstallCodex'
      ].mockResolvedValue({
        snapshot: { claude: {}, providers: [], agentFrameworkId: fallbackFramework },
        activeBackendAffected: true
      })
      const onActiveProviderChanged = vi.fn()
      const onAgentFrameworkChanged = vi.fn()
      registerTestSettingsIpcHandlers({
        service: asService(service),
        onActiveProviderChanged,
        onAgentFrameworkChanged
      })

      await invoke(`settings:uninstall-${channel}`)

      expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
      expect(onActiveProviderChanged).not.toHaveBeenCalled()
    }
  )

  it('retires matching generations after uninstalling the active runtime without a fallback', async () => {
    handlers.clear()
    const service = createFakeService()
    service.uninstallClaude.mockResolvedValue({
      snapshot: { claude: {}, providers: [], agentFrameworkId: 'claude-code' },
      activeBackendAffected: true
    })
    const onActiveProviderChanged = vi.fn()
    const onAgentFrameworkChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onAgentFrameworkChanged
    })

    await invoke('settings:uninstall-claude')

    expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
    expect(onAgentFrameworkChanged).toHaveBeenCalledWith('claude-code')
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('does not reconnect after uninstalling the inactive runtime', async () => {
    handlers.clear()
    const service = createFakeService()
    // OpenCode is uninstalled while Claude is active: the live agent is untouched.
    service.uninstallOpencode.mockResolvedValue({
      snapshot: { claude: {}, providers: [] },
      activeBackendAffected: false
    })
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    await invoke('settings:uninstall-opencode')

    expect(service.uninstallOpencode).toHaveBeenCalledTimes(1)
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('registers skill channels and fires onSkillsChanged after set-skill-enabled', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    await invoke('settings:list-skills')
    expect(service.listSkills).toHaveBeenCalledTimes(1)

    await invoke('settings:get-skill-detail', 'demo')
    expect(service.getSkillDetail).toHaveBeenCalledWith('demo')

    await invoke('settings:resolve-skill-document', { name: 'demo' })
    expect(service.resolveSkillDocument).toHaveBeenCalledWith({ name: 'demo' })

    await invoke('settings:set-skill-enabled', { id: 'demo', enabled: false })
    expect(service.setSkillEnabled).toHaveBeenCalledWith({ id: 'demo', enabled: false })

    await invoke('settings:set-skills-enabled', { ids: ['imported-demo'], enabled: false })
    expect(service.setSkillsEnabled).toHaveBeenCalledWith({
      ids: ['imported-demo'],
      enabled: false
    })
    expect(onSkillsChanged).toHaveBeenCalledTimes(2)
  })

  it('builds and saves an eligible Skill export through the desktop adapter', async () => {
    handlers.clear()
    const service = createFakeService()
    const skillExportFiles = { save: vi.fn().mockResolvedValue({ saved: true }) }
    registerTestSettingsIpcHandlers({
      service: asService(service),
      skillExportFiles
    })

    await expect(invoke('settings:export-skill', { id: 'personal-my-skill' })).resolves.toEqual({
      saved: true
    })
    expect(service.buildSkillExport).toHaveBeenCalledWith('personal-my-skill')
    expect(skillExportFiles.save).toHaveBeenCalledWith(
      {
        fileName: 'my-skill.zip',
        archiveBytes: new Uint8Array([1, 2, 3])
      },
      ipcSender
    )
  })

  it('routes create/update/delete skill channels and fires onSkillsChanged', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    await invoke('settings:create-skill', { name: 'S', description: 'd', body: 'b' })
    expect(service.createSkill).toHaveBeenCalledWith({ name: 'S', description: 'd', body: 'b' })

    await invoke('settings:update-skill', {
      id: 'personal-s',
      name: 'S',
      description: 'd',
      body: 'b2'
    })
    expect(service.updateSkill).toHaveBeenCalledWith({
      id: 'personal-s',
      name: 'S',
      description: 'd',
      body: 'b2'
    })

    await invoke('settings:delete-skill', { id: 'personal-s' })
    expect(service.deleteSkill).toHaveBeenCalledWith({ id: 'personal-s' })

    expect(onSkillsChanged).toHaveBeenCalledTimes(3)
  })

  it('routes import-skill-zip-batch to the service, forwards its result, and fires onSkillsChanged', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    const result = {
      results: [{ subPath: 'a', status: 'imported' as const, id: 'imported-a' }],
      skills: []
    }
    service.importSkillZipBatch.mockResolvedValue(result)
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    expect(handlers.has('settings:import-skill-zip-batch')).toBe(true)

    const request = { dataBase64: 'YmFzZTY0', items: [{ subPath: 'a' }] }
    const forwarded = await invoke('settings:import-skill-zip-batch', request)

    expect(service.importSkillZipBatch).toHaveBeenCalledWith(request)
    expect(forwarded).toBe(result)
    expect(onSkillsChanged).toHaveBeenCalledTimes(1)
  })

  it('routes one installed-skill batch and fires onSkillsChanged once', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    const result = {
      results: [
        {
          source: 'agents',
          slug: 'shared',
          status: 'imported',
          id: 'imported-shared'
        }
      ],
      skills: []
    }
    service.importAgentHomeSkills.mockResolvedValue(result)
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })
    const request = { skills: [{ source: 'agents', slug: 'shared' }] }

    expect(await invoke('settings:list-agent-home-skills')).toEqual([])
    const forwarded = await invoke('settings:import-agent-home-skills', request)

    expect(service.listAgentHomeSkills).toHaveBeenCalledOnce()
    expect(service.importAgentHomeSkills).toHaveBeenCalledWith(request)
    expect(forwarded).toBe(result)
    expect(onSkillsChanged).toHaveBeenCalledOnce()
  })

  it('does not fire onSkillsChanged when an installed-skill batch makes no changes', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    const result = {
      results: [
        {
          source: 'agents',
          slug: 'existing',
          status: 'unchanged' as const,
          id: 'imported-existing'
        },
        { source: 'claude', slug: 'missing', error: 'Skill not found.' }
      ],
      skills: []
    }
    service.importAgentHomeSkills.mockResolvedValue(result)
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    expect(
      await invoke('settings:import-agent-home-skills', {
        skills: [
          { source: 'agents', slug: 'existing' },
          { source: 'claude', slug: 'missing' }
        ]
      })
    ).toBe(result)
    expect(onSkillsChanged).not.toHaveBeenCalled()
  })

  it('routes read-only candidate previews without firing the skills-changed callback', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })
    const github = { url: 'https://github.com/acme/skills/tree/main/foo' }
    const installed = { source: 'agents', slug: 'foo' }

    await invoke('settings:preview-github-skill', github)
    await invoke('settings:preview-agent-home-skill', installed)

    expect(service.previewGitHubSkill).toHaveBeenCalledWith(github)
    expect(service.previewAgentHomeSkill).toHaveBeenCalledWith(installed)
    expect(onSkillsChanged).not.toHaveBeenCalled()
  })

  it('registers the OpenCode / framework-switch channels', () => {
    handlers.clear()
    registerTestSettingsIpcHandlers({ service: asService(createFakeService()) })

    for (const channel of [
      'settings:detect-opencode',
      'settings:install-opencode',
      'settings:set-agent-framework'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('routes Codex detection, installation, and uninstall through the service', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    const onAgentFrameworkChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onAgentFrameworkChanged
    })

    expect(handlers.has('settings:detect-codex')).toBe(true)
    expect(handlers.has('settings:install-codex')).toBe(true)
    expect(handlers.has('settings:uninstall-codex')).toBe(true)

    await invoke('settings:detect-codex')
    await invoke('settings:install-codex', { source: 'managed' })
    await invoke('settings:uninstall-codex')

    expect(service.detectCodex).toHaveBeenCalledOnce()
    expect(service.installCodex).toHaveBeenCalledWith({ source: 'managed' }, expect.any(Function))
    expect(service.uninstallCodex).toHaveBeenCalledOnce()
    expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
    expect(onAgentFrameworkChanged).toHaveBeenCalledWith('codex')
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('routes detect-opencode to the service and forwards its snapshot', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], agentFrameworkId: 'opencode' }
    service.detectOpencode.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:detect-opencode')

    expect(service.detectOpencode).toHaveBeenCalledTimes(1)
    expect(result).toBe(snapshot)
  })

  it('routes install-opencode to the service with the requested source and a stream callback', async () => {
    handlers.clear()
    const service = createFakeService()
    const outcome = { installId: 'oc', ok: true }
    service.installOpencode.mockResolvedValue(outcome)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:install-opencode', { source: 'managed' })

    // The handler forwards the typed request plus the broadcast callback used to stream install logs.
    expect(service.installOpencode).toHaveBeenCalledWith(
      { source: 'managed' },
      expect.any(Function)
    )
    expect(result).toBe(outcome)
  })

  it('routes each install-opencode source to the service unchanged', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    for (const source of ['managed', 'npm', 'official-script'] as const) {
      await invoke('settings:install-opencode', { source })
      expect(service.installOpencode).toHaveBeenCalledWith({ source }, expect.any(Function))
    }
  })

  it('persists the selected framework and rotates future sessions on set-agent-framework', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], agentFrameworkId: 'opencode' }
    service.setAgentFramework.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    const onAgentFrameworkChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged,
      onAgentFrameworkChanged
    })

    const result = await invoke('settings:set-agent-framework', { id: 'opencode' })

    // The handler unwraps the request to the bare framework id the service expects.
    expect(service.setAgentFramework).toHaveBeenCalledWith('opencode')
    // Existing sessions keep their owning runtime; only future sessions rotate to the new framework.
    expect(onAgentFrameworkChanged).toHaveBeenCalledOnce()
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
    expect(result).toBe(snapshot)
  })

  it('persists reasoning effort as the default for new Sessions', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], reasoningEffort: 'high' }
    service.setReasoningEffort.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({
      service: asService(service),
      onActiveProviderChanged
    })

    const result = await invoke('settings:set-reasoning-effort', { effort: 'high' })

    expect(service.setReasoningEffort).toHaveBeenCalledWith('high')
    expect(service.resolveActiveReasoningEffort).not.toHaveBeenCalled()
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
    expect(result).toBe(snapshot)
  })

  it('broadcasts every committed optimistic preference snapshot', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })
    const changed: unknown[] = []
    const removeSink = addRendererBroadcastSink((channel, payload) => {
      if (channel === 'settings:changed') changed.push(payload)
    })

    try {
      const expected = await Promise.all([
        invoke('settings:set-reasoning-effort', { effort: 'high' }),
        invoke('settings:set-session-details-model', {
          configuration: { mode: 'inherit', reasoningEffort: 'low' }
        }),
        invoke('settings:set-notifications-enabled', { enabled: false }),
        invoke('settings:set-show-notification-content', { enabled: false }),
        invoke('settings:set-conversation-skill-import-enabled', { enabled: false }),
        invoke('settings:set-close-preference', { preference: 'quit' }),
        invoke('settings:set-app-icon-variant', { variant: 'dark' }),
        invoke('settings:set-project-files-filter', { filter: { sourceMode: 'local' } }),
        invoke('settings:set-default-permission-profile', { profile: 'auto' })
      ])

      expect(changed).toEqual(expect.arrayContaining(expected))
      expect(changed).toHaveLength(expected.length)
    } finally {
      removeSink()
    }
  })

  it('returns and broadcasts a current snapshot when an older mutation snapshot resolves late', async () => {
    handlers.clear()
    const service = createFakeService()
    const staleSnapshot = { claude: {}, providers: [], notificationsEnabled: false }
    const newerMutationSnapshot = {
      claude: {},
      providers: [],
      notificationsEnabled: true,
      showNotificationContent: false
    }
    const currentSnapshot = {
      claude: {},
      providers: [],
      notificationsEnabled: false,
      showNotificationContent: false
    }
    const staleMutation = deferred<typeof staleSnapshot>()
    service.setNotificationsEnabled.mockReturnValueOnce(staleMutation.promise)
    service.setShowNotificationContent.mockResolvedValueOnce(newerMutationSnapshot)
    service.getSettingsView.mockResolvedValue(currentSnapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })
    const changed: unknown[] = []
    const removeSink = addRendererBroadcastSink((channel, payload) => {
      if (channel === 'settings:changed') changed.push(payload)
    })

    try {
      const older = invoke('settings:set-notifications-enabled', { enabled: false })
      const newer = invoke('settings:set-show-notification-content', { enabled: false })
      await expect(newer).resolves.toBe(currentSnapshot)
      staleMutation.resolve(staleSnapshot)
      await expect(older).resolves.toBe(currentSnapshot)
      expect(changed).toEqual([currentSnapshot, currentSnapshot])
    } finally {
      removeSink()
    }
  })

  it('serializes current snapshot reads and broadcasts in mutation-completion order', async () => {
    handlers.clear()
    const service = createFakeService()
    const firstSnapshot = { claude: {}, providers: [], notificationsEnabled: false }
    const secondSnapshot = {
      claude: {},
      providers: [],
      notificationsEnabled: false,
      showNotificationContent: false
    }
    const firstRead = deferred<typeof firstSnapshot>()
    service.getSettingsView
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(secondSnapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })
    const changed: unknown[] = []
    const removeSink = addRendererBroadcastSink((channel, payload) => {
      if (channel === 'settings:changed') changed.push(payload)
    })

    try {
      const first = invoke('settings:set-notifications-enabled', { enabled: false })
      await vi.waitFor(() => expect(service.getSettingsView).toHaveBeenCalledOnce())
      const second = invoke('settings:set-show-notification-content', { enabled: false })
      await Promise.resolve()
      expect(service.getSettingsView).toHaveBeenCalledOnce()

      firstRead.resolve(firstSnapshot)
      await expect(first).resolves.toBe(firstSnapshot)
      await expect(second).resolves.toBe(secondSnapshot)
      expect(changed).toEqual([firstSnapshot, secondSnapshot])
    } finally {
      removeSink()
    }
  })

  it.each([
    ['settings:check-environment', undefined],
    ['settings:detect-codebuddy', undefined],
    ['settings:install-codebuddy', { source: 'managed' }],
    ['settings:uninstall-codex', undefined],
    ['settings:upsert-provider', { type: 'custom', name: 'Lab' }],
    ['settings:set-agent-framework', { id: 'opencode' }],
    ['settings:validate-provider', { providerId: 'p1' }],
    ['settings:login-isolated-codex', undefined],
    ['settings:wait-xai-oauth-login', undefined],
    ['settings:refresh-provider-models', { providerId: 'p1' }],
    ['settings:mark-onboarding-complete', undefined],
    ['settings:set-package-mirror', {}],
    ['settings:set-network-proxy', { mode: 'system' }],
    [
      'settings:set-notebook-network',
      {
        allowedDomains: [],
        disabledOpenScienceDomainGroups: [],
        disabledOpenScienceDomains: []
      }
    ]
  ])('broadcasts the current SettingsSnapshot after %s', async (channel, payload) => {
    handlers.clear()
    const service = createFakeService()
    const currentSnapshot = { claude: {}, providers: [], notificationsEnabled: true }
    service.getSettingsView.mockResolvedValue(currentSnapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })
    const changed: unknown[] = []
    const removeSink = addRendererBroadcastSink((broadcastChannel, broadcastPayload) => {
      if (broadcastChannel === 'settings:changed') changed.push(broadcastPayload)
    })

    try {
      await invoke(channel, payload)
      expect(changed).toEqual([currentSnapshot])
    } finally {
      removeSink()
    }
  })

  it('does not broadcast SettingsSnapshot for Skill, Connector, or Bookmark directory changes', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })
    const changed: unknown[] = []
    const removeSink = addRendererBroadcastSink((channel, payload) => {
      if (channel === 'settings:changed') changed.push(payload)
    })

    try {
      await invoke('settings:set-skill-enabled', { id: 'skill-a', enabled: false })
      await invoke('settings:set-connector-enabled', { id: 'connector-a', enabled: false })
      await (
        handlers.get('compute:bookmarks:set') as unknown as (
          event: unknown,
          providerId: string,
          folders: string[]
        ) => Promise<unknown>
      )({ sender: ipcSender }, 'compute-a', ['/work'])
      expect(changed).toEqual([])
    } finally {
      removeSink()
    }
  })

  it('rejects an unknown reasoning effort without touching the service or the agent', async () => {
    handlers.clear()
    const service = createFakeService()
    const onActiveProviderChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onActiveProviderChanged })

    // Renderer payloads are untyped at runtime: garbage must fail at the boundary, not persist.
    await expect(invoke('settings:set-reasoning-effort', { effort: 'ultra' })).rejects.toThrow(
      'Unknown reasoning effort'
    )
    await expect(invoke('settings:set-reasoning-effort', { effort: 3 })).rejects.toThrow(
      'Unknown reasoning effort'
    )
    await expect(invoke('settings:set-reasoning-effort', {})).rejects.toThrow(
      'Unknown reasoning effort'
    )
    expect(service.setReasoningEffort).not.toHaveBeenCalled()
    expect(onActiveProviderChanged).not.toHaveBeenCalled()
  })

  it('validates and forwards one complete Subagent model mutation', async () => {
    handlers.clear()
    const service = createFakeService()
    const configuration = {
      mode: 'fixed' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high' as const
    }
    const snapshot = { claude: {}, providers: [], subagentModel: configuration }
    service.setSubagentModel.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:set-subagent-model', { configuration })).resolves.toBe(snapshot)
    expect(service.setSubagentModel).toHaveBeenCalledWith(configuration)

    await expect(
      invoke('settings:set-subagent-model', {
        configuration: { ...configuration, providerId: '' }
      })
    ).rejects.toThrow('Invalid Subagent model configuration.')
    expect(service.setSubagentModel).toHaveBeenCalledOnce()
  })

  it('validates and forwards one complete Reviewer model mutation', async () => {
    handlers.clear()
    const service = createFakeService()
    const configuration = {
      mode: 'fixed' as const,
      providerId: 'provider-a',
      model: 'reviewer-model',
      reasoningEffort: 'high' as const
    }
    const snapshot = { claude: {}, providers: [], reviewerModel: configuration }
    service.setReviewerModel.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:set-reviewer-model', { configuration })).resolves.toBe(snapshot)
    expect(service.setReviewerModel).toHaveBeenCalledWith(configuration)

    await expect(
      invoke('settings:set-reviewer-model', {
        configuration: { ...configuration, model: '' }
      })
    ).rejects.toThrow('Invalid Reviewer model configuration.')
    expect(service.setReviewerModel).toHaveBeenCalledOnce()
  })

  it('validates and forwards a Session details model policy', async () => {
    handlers.clear()
    const service = createFakeService()
    const configuration = { mode: 'inherit' as const, reasoningEffort: 'low' as const }
    const snapshot = { claude: {}, providers: [], sessionDetailsModel: configuration }
    service.setSessionDetailsModel.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:set-session-details-model', { configuration })).resolves.toBe(
      snapshot
    )
    expect(service.setSessionDetailsModel).toHaveBeenCalledWith(configuration)
    await expect(
      invoke('settings:set-session-details-model', { configuration: { mode: 'inherit' } })
    ).rejects.toThrow('Invalid Session details model configuration.')
  })

  it('validates, clears, and forwards the Vision model configuration', async () => {
    handlers.clear()
    const service = createFakeService()
    const configuration = {
      providerId: 'provider-a',
      model: 'vision-model',
      reasoningEffort: 'high' as const
    }
    const snapshot = { claude: {}, providers: [], visionModel: configuration }
    service.setVisionModel.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:set-vision-model', { configuration })).resolves.toBe(snapshot)
    await expect(invoke('settings:set-vision-model', {})).resolves.toBe(snapshot)
    expect(service.setVisionModel).toHaveBeenNthCalledWith(1, configuration)
    expect(service.setVisionModel).toHaveBeenNthCalledWith(2, undefined)

    await expect(
      invoke('settings:set-vision-model', { configuration: { ...configuration, model: '' } })
    ).rejects.toThrow('Invalid Vision model configuration.')
    expect(service.setVisionModel).toHaveBeenCalledTimes(2)
  })

  it('persists the notifications preference on set-notifications-enabled', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], notificationsEnabled: false }
    service.setNotificationsEnabled.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:set-notifications-enabled', { enabled: false })

    // The handler unwraps the request to the bare boolean the service expects.
    expect(service.setNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(result).toBe(snapshot)
  })

  it('rejects a non-boolean notifications flag without touching the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    // Renderer payloads are untyped at runtime: garbage must fail at the boundary, not persist.
    await expect(invoke('settings:set-notifications-enabled', { enabled: 'yes' })).rejects.toThrow(
      'Invalid notifications-enabled flag'
    )
    await expect(invoke('settings:set-notifications-enabled', {})).rejects.toThrow(
      'Invalid notifications-enabled flag'
    )
    expect(service.setNotificationsEnabled).not.toHaveBeenCalled()
  })

  it('persists the native notification content preference on Electron IPC', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], showNotificationContent: true }
    service.setShowNotificationContent.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    registerTestSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:set-show-notification-content', { enabled: true })

    expect(service.setShowNotificationContent).toHaveBeenCalledWith(true)
    expect(result).toBe(snapshot)
  })

  it('rejects a non-boolean native notification content flag without touching the service', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(
      invoke('settings:set-show-notification-content', { enabled: 'yes' })
    ).rejects.toThrow('Invalid show-notification-content flag')
    await expect(invoke('settings:set-show-notification-content', {})).rejects.toThrow(
      'Invalid show-notification-content flag'
    )
    expect(service.setShowNotificationContent).not.toHaveBeenCalled()
  })

  it('persists the conversation Skill import preference and reloads runtime tooling', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], conversationSkillImportEnabled: false }
    service.setConversationSkillImportEnabled.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    const onSkillsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    const result = await invoke('settings:set-conversation-skill-import-enabled', {
      enabled: false
    })

    expect(service.setConversationSkillImportEnabled).toHaveBeenCalledWith(false)
    expect(onSkillsChanged).toHaveBeenCalledOnce()
    expect(result).toBe(snapshot)
  })

  it('rejects a non-boolean conversation Skill import flag without reloading', async () => {
    handlers.clear()
    const service = createFakeService()
    const onSkillsChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onSkillsChanged })

    await expect(
      invoke('settings:set-conversation-skill-import-enabled', { enabled: 'yes' })
    ).rejects.toThrow('Invalid conversation-skill-import-enabled flag')
    await expect(invoke('settings:set-conversation-skill-import-enabled', {})).rejects.toThrow(
      'Invalid conversation-skill-import-enabled flag'
    )
    expect(service.setConversationSkillImportEnabled).not.toHaveBeenCalled()
    expect(onSkillsChanged).not.toHaveBeenCalled()
  })

  it('persists valid close preferences and rejects unknown values', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:set-close-preference', { preference: 'quit' })
    await invoke('settings:set-close-preference', {})

    expect(service.setClosePreference).toHaveBeenNthCalledWith(1, 'quit')
    expect(service.setClosePreference).toHaveBeenNthCalledWith(2, undefined)
    await expect(invoke('settings:set-close-preference', { preference: 'close' })).rejects.toThrow(
      'Invalid close preference'
    )
  })

  it('persists valid project files filters and rejects malformed ones', async () => {
    handlers.clear()
    const service = createFakeService()
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await invoke('settings:set-project-files-filter', {
      filter: { sourceMode: 'local', localRootId: 'root-1' }
    })
    await invoke('settings:set-project-files-filter', {})

    expect(service.setProjectFilesFilter).toHaveBeenNthCalledWith(1, {
      sourceMode: 'local',
      localRootId: 'root-1'
    })
    expect(service.setProjectFilesFilter).toHaveBeenNthCalledWith(2, undefined)
    await expect(
      invoke('settings:set-project-files-filter', { filter: { sourceMode: 'remote' } })
    ).rejects.toThrow('Invalid project files filter source')
  })

  it('persists the app icon variant and applies it live on set-app-icon-variant', async () => {
    handlers.clear()
    const service = createFakeService()
    const snapshot = { claude: {}, providers: [], appIconVariant: 'dark' }
    service.setAppIconVariant.mockResolvedValue(snapshot)
    service.getSettingsView.mockResolvedValue(snapshot)
    const onAppIconVariantChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onAppIconVariantChanged })

    const result = await invoke('settings:set-app-icon-variant', { variant: 'dark' })

    // The handler unwraps the request to the bare variant the service expects, then applies it live.
    expect(service.setAppIconVariant).toHaveBeenCalledWith('dark')
    expect(onAppIconVariantChanged).toHaveBeenCalledWith('dark')
    expect(result).toBe(snapshot)
  })

  it('persists valid default permission profiles and rejects unknown values', async () => {
    handlers.clear()
    const service = createFakeService()
    service.getSettingsView.mockResolvedValue({
      claude: {},
      providers: [],
      defaultPermissionProfile: 'auto'
    })
    registerTestSettingsIpcHandlers({ service: asService(service) })

    const result = await invoke('settings:set-default-permission-profile', { profile: 'auto' })

    expect(service.setDefaultPermissionProfile).toHaveBeenCalledWith('auto')
    expect(result).toMatchObject({ defaultPermissionProfile: 'auto' })
    await expect(
      invoke('settings:set-default-permission-profile', { profile: 'always' })
    ).rejects.toThrow('Unknown default permission profile')
    expect(service.setDefaultPermissionProfile).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown app icon variant without touching the service', async () => {
    handlers.clear()
    const service = createFakeService()
    const onAppIconVariantChanged = vi.fn()
    registerTestSettingsIpcHandlers({ service: asService(service), onAppIconVariantChanged })

    await expect(invoke('settings:set-app-icon-variant', { variant: 'sparkle' })).rejects.toThrow(
      'Unknown app icon variant'
    )
    await expect(invoke('settings:set-app-icon-variant', {})).rejects.toThrow(
      'Unknown app icon variant'
    )
    expect(service.setAppIconVariant).not.toHaveBeenCalled()
    expect(onAppIconVariantChanged).not.toHaveBeenCalled()
  })

  it('returns the icon previews from list-app-icons, or an empty list when unavailable', async () => {
    handlers.clear()
    const service = createFakeService()
    const previews: { id: 'light'; label: string; description: string; previewDataUrl: string }[] =
      [
        {
          id: 'light',
          label: 'Light',
          description: 'x',
          previewDataUrl: 'data:image/png;base64,AA'
        }
      ]
    registerTestSettingsIpcHandlers({
      service: asService(service),
      listAppIconPreviews: () => previews
    })
    expect(await invoke('settings:list-app-icons')).toBe(previews)

    handlers.clear()
    registerTestSettingsIpcHandlers({ service: asService(createFakeService()) })
    expect(await invoke('settings:list-app-icons')).toEqual([])
  })

  it('surfaces a service error thrown by install-opencode', async () => {
    handlers.clear()
    const service = createFakeService()
    service.installOpencode.mockRejectedValue(new Error('download failed'))
    registerTestSettingsIpcHandlers({ service: asService(service) })

    await expect(invoke('settings:install-opencode', { source: 'managed' })).rejects.toThrow(
      'download failed'
    )
  })
})
