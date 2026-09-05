// Pins the preload bridge channel strings and argument forwarding for the recently-added sessions
// and agent-framework/opencode settings methods.
//
// window.api methods are thin wrappers over ipcRenderer.invoke(<channel>, ...args). The main-process
// handlers and the renderer store are tested elsewhere, but nothing else pins the exact channel
// STRINGS the preload uses — so a typo in a channel name (mismatched against the handler) would still
// pass every other suite. These tests mock electron, load the preload module, capture the object it
// exposes via contextBridge, and assert each method invokes ipcRenderer.invoke with the precise
// channel and forwards its arguments verbatim.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ELECTRON_APPLICATION_COMMAND_CHANNELS,
  RENDERER_CONTRACT_GROUPS
} from '../shared/renderer-contract-catalog'

const { invokeMock, sendMock, exposeMock, getPathForFileMock, onMock, removeListenerMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    sendMock: vi.fn(),
    exposeMock: vi.fn(),
    getPathForFileMock: vi.fn(),
    onMock: vi.fn(),
    removeListenerMock: vi.fn()
  }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  webUtils: { getPathForFile: getPathForFileMock },
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    off: vi.fn(),
    send: sendMock,
    removeListener: removeListenerMock
  }
}))

// The subset of the bridge these tests exercise. Args are unknown — forwarding, not shape, is asserted.
type PreloadApi = {
  saveSessionArtifacts: (request: unknown) => unknown
  saveProjectArtifacts: (request: unknown) => unknown
  getRuntimeVersions: () => { electron: string; chrome: string; node: string }
  diagnostics: {
    reportRendererFailure: (report: unknown) => void
  }
  databaseStartup: {
    getState: () => unknown
    retry: () => unknown
    quit: () => unknown
    onStateChanged: (listener: (state: unknown) => void) => () => void
  }
  lifecycle: {
    getClientId: () => unknown
  }
  sessions: {
    loadAll: () => unknown
    loadOne: (request: unknown) => unknown
    filterPdfContextCandidates: (request: unknown) => Promise<unknown>
    linkPdfContext: (request: unknown) => Promise<unknown>
    unlinkPdfContext: (request: unknown) => Promise<unknown>
    saveSession: (session: unknown, options?: unknown) => unknown
    setDelegationPolicy: (projectId: string, sessionId: string, policy: 'allow' | 'deny') => unknown
    editDetails: (request: unknown) => unknown
    deleteSession: (request: unknown) => unknown
    saveManifest: (request: unknown) => unknown
    exportConversation: (request: unknown) => unknown
    onFlushAborted: (
      listener: (event?: { reason: 'conflict' | 'renderer-failed' }) => void
    ) => unknown
    onFlushRequest: (listener: (request: { requestId: string }) => void) => unknown
    sendFlushResponse: (response: { requestId: string }) => void
  }
  remoteAccess: {
    onChanged: (listener: () => void) => () => void
  }
  storage: {
    validateDataRoot: (parent: string) => unknown
    setDataRootAndRelaunch: (parent: string, markOnboarding?: boolean) => unknown
  }
  settings: {
    detectOpencode: () => unknown
    detectCodeBuddy: () => unknown
    detectCodex: () => unknown
    installOpencode: (request: unknown) => unknown
    installCodeBuddy: (request: unknown) => unknown
    installCodex: (request: unknown) => unknown
    setAgentFramework: (request: unknown) => unknown
    setNotificationsEnabled: (request: unknown) => unknown
    setConversationSkillImportEnabled: (request: unknown) => unknown
    setClosePreference: (request: unknown) => unknown
    setProjectFilesFilter: (request: unknown) => unknown
    setDefaultPermissionProfile: (request: unknown) => unknown

    setAppIconVariant: (request: unknown) => unknown
    listAppIcons: () => unknown
    uninstallClaude: () => unknown
    uninstallOpencode: () => unknown
    uninstallCodeBuddy: () => unknown
    uninstallCodex: () => unknown
    cancelCodexLogin: () => unknown
    loginIsolatedCodex: () => unknown
    logoutIsolatedCodex: () => unknown
    cancelClaudeLogin: () => unknown
    loginSharedClaude: () => unknown
    logoutSharedClaude: () => unknown
    loginIsolatedClaude: (token: string) => unknown
    loginIsolatedClaudeBrowser: () => unknown
    cancelIsolatedClaudeLogin: () => unknown
    logoutIsolatedClaude: () => unknown
    previewGitHubSkill: (request: unknown) => unknown
    previewAgentHomeSkill: (request: unknown) => unknown
    exportSkill: (request: unknown) => unknown
    selectCustomServerTemplate: (request?: unknown) => unknown
  }
  acp: {
    connect: (request?: unknown) => unknown
    resumeSession: (request: unknown) => unknown
    continueInterruptedTurn: (request: unknown) => unknown
    resetSessionContext: (request: unknown) => unknown
    compactSession: (request: unknown) => unknown
  }
  notebookEnv: {
    cancel: (language?: unknown) => unknown
    provision: (language: unknown, operationId?: unknown) => unknown
    repair: (language: unknown, runtimeIdentity: unknown, operationId?: unknown) => unknown
  }
  notifications: {
    peekPendingOpenSession: () => unknown
    takePendingOpenSession: (expectedToken: number) => unknown
    syncViewState: (state: unknown) => void
    onViewProbe: (listener: (challengeId: number) => void) => () => void
  }
  specialist: {
    list: () => unknown
    previewDelete: (request: unknown) => unknown
    delete: (request: unknown) => unknown
    exportContributionTemplate: () => unknown
    previewExport: (request: unknown) => unknown
    exportSpecialist: (request: unknown) => unknown
    selectPackage: () => unknown
    installPackage: (request: unknown) => unknown
    cancelPackage: (request: unknown) => unknown
    savePackageReport: (request: unknown) => unknown
    onPendingSwitch: (listener: (payload: unknown) => void) => () => void
  }
  cli: {
    getStatus: () => unknown
    install: () => unknown
    uninstall: () => unknown
  }
  officePreview: {
    attachFrame: (sessionId: string) => Promise<unknown>
    reportState: (sessionId: string, state: unknown) => void
  }
  sourcePreview: {
    release: (sourceUrl: string) => void
    onLoadState: (listener: (state: unknown) => void) => () => void
  }
  uploads: {
    stageLocalFile: (file: File, request: unknown) => Promise<unknown>
    claimLocalFile: (request: unknown) => Promise<void>
  }
  window: {
    findInPage?: (request: unknown) => void
    clearFind?: () => void
    closeFind?: () => void
    onShowWindowFind?: (
      listener: (appearance: { theme: 'light' | 'dark'; followsSystem: boolean }) => void
    ) => unknown
    onHideWindowFind?: (listener: () => void) => unknown
    onWindowFindAppearance?: (
      listener: (appearance: { theme: 'light' | 'dark'; followsSystem: boolean }) => void
    ) => unknown
    announceWindowFindAppearance?: (appearance: {
      theme: 'light' | 'dark'
      followsSystem: boolean
    }) => void
    announceWindowFindReady?: () => unknown
    announceWindowFindContentReady?: () => void
    onCloseActivePane: (listener: () => void) => () => void
  }
}

let api: PreloadApi

const collectFunctionPaths = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'function') return [prefix]
  if (!value || typeof value !== 'object') return []

  return Object.entries(value)
    .flatMap(([key, child]) => collectFunctionPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

beforeAll(async () => {
  // Take the contextBridge branch of the preload's expose logic (production path with context isolation).
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  invokeMock.mockImplementation(async (channel: string) =>
    channel === 'sessions:link-pdf-context' || channel === 'sessions:unlink-pdf-context'
      ? { ok: true, result: { version: 1, revision: 0 } }
      : validatedApplicationCommandChannels.has(channel) || channel === 'sessions:save-session'
        ? { ok: true, result: undefined }
        : undefined
  )

  await import('./index')

  const exposed = exposeMock.mock.calls.find((call) => call[0] === 'api')?.[1] as
    PreloadApi | undefined
  if (!exposed) throw new Error('preload did not expose an "api" bridge')
  api = exposed
})

afterEach(() => {
  invokeMock.mockClear()
  sendMock.mockClear()
  getPathForFileMock.mockReset()
  onMock.mockClear()
  removeListenerMock.mockClear()
})

const runtimeContractCapabilities = new Set([
  'acp',
  'permissions',
  'settings',
  'specialist',
  'handoff',
  'compute',
  'notebook',
  'notebook-environment',
  'runtime'
])

const runtimeContracts = RENDERER_CONTRACT_GROUPS.filter(({ capability }) =>
  runtimeContractCapabilities.has(capability)
).flatMap(({ contracts }) => contracts)

const coreContractGroups = RENDERER_CONTRACT_GROUPS.filter(
  ({ capability }) => !runtimeContractCapabilities.has(capability)
)
const coreContracts = coreContractGroups.flatMap(({ contracts }) => contracts)
const validatedApplicationCommandChannels = new Set(ELECTRON_APPLICATION_COMMAND_CHANNELS)

const getApiCallable = (publicPath: string): ((...args: unknown[]) => unknown) => {
  const callable = publicPath
    .split('.')
    .reduce<unknown>((value, member) => (value as Record<string, unknown>)[member], api)
  if (typeof callable !== 'function') {
    throw new Error(`window.api path is not callable: ${publicPath}`)
  }
  return callable as (...args: unknown[]) => unknown
}

describe('preload bridge — public surface inventory', () => {
  it('pins every callable path exposed through window.api', () => {
    expect(collectFunctionPaths(api)).toEqual([
      'acp.cancel',
      'acp.compactSession',
      'acp.connect',
      'acp.continueInterruptedTurn',
      'acp.createSession',
      'acp.deleteSession',
      'acp.disconnect',
      'acp.getPlanProjection',
      'acp.getState',
      'acp.onAgentRuntimeUpdate',
      'acp.onEvent',
      'acp.onPermissionRequest',
      'acp.onState',
      'acp.resetSessionContext',
      'acp.respondPlan',
      'acp.respondToElicitation',
      'acp.respondToPermission',
      'acp.resumeSession',
      'acp.revokePermissionGrant',
      'acp.saveAsSkill',
      'acp.sendPrompt',
      'acp.setPermissionProfile',
      'acp.steerFollowUp',
      'artifacts.finalizeRunArtifacts',
      'artifacts.generateCodeReconstruction',
      'artifacts.getCodeReconstruction',
      'artifacts.getLineage',
      'artifacts.getVersionExecution',
      'artifacts.getVersionMessages',
      'artifacts.getVersionProvenance',
      'artifacts.getVersionReview',
      'artifacts.openFile',
      'artifacts.readPreview',
      'artifacts.reconcilePendingArtifacts',
      'artifacts.resolveVersionDescriptors',
      'cli.getStatus',
      'cli.install',
      'cli.uninstall',
      'compute.bookmarksGet',
      'compute.bookmarksSet',
      'compute.changeAuthentication',
      'compute.concurrencySet',
      'compute.create',
      'compute.createPassword',
      'compute.delete',
      'compute.deletionStatus',
      'compute.detailsGet',
      'compute.detailsSave',
      'compute.download',
      'compute.enabledHostsGet',
      'compute.enabledHostsSet',
      'compute.get',
      'compute.hostEnabledSet',
      'compute.hostSelectedSet',
      'compute.jobsCancel',
      'compute.jobsList',
      'compute.jobsMarkConsumed',
      'compute.jobsPendingNotification',
      'compute.jobsSetRemoteCleanup',
      'compute.jobsTransitionAnalysis',
      'compute.list',
      'compute.listDir',
      'compute.onApprovalRequest',
      'compute.onApprovalSettled',
      'compute.onJobUpdated',
      'compute.passwordCapability',
      'compute.probe',
      'compute.replayApproval',
      'compute.replayPendingApprovals',
      'compute.resetPassword',
      'compute.respondApproval',
      'compute.revealInFolder',
      'compute.scratchClear',
      'compute.scratchSet',
      'compute.sshConfigAliases',
      'databaseStartup.getState',
      'databaseStartup.onStateChanged',
      'databaseStartup.quit',
      'databaseStartup.retry',
      'diagnostics.reportRendererFailure',
      'getRuntimeVersions',
      'github.getStars',
      'handoff.list',
      'handoff.onChanged',
      'handoff.retry',
      'lifecycle.getClientId',
      'localFs.getRoots',
      'localFs.grantRoot',
      'localFs.listDir',
      'localFs.listDrives',
      'localFs.listGrantedRoots',
      'localFs.openPath',
      'localFs.readPreview',
      'localFs.removeGrantedRoot',
      'localFs.reveal',
      'localFs.setGrantedRootAccess',
      'locale.initialize',
      'locale.onChanged',
      'locale.setPreference',
      'logs.getStatus',
      'logs.openFile',
      'logs.revealInFolder',
      'managedFileVersions.cancelDiff',
      'managedFileVersions.diffText',
      'managedFileVersions.inspect',
      'managedFileVersions.saveTextEdit',
      'memory.clearAll',
      'memory.createCategory',
      'memory.createEntry',
      'memory.deleteCategory',
      'memory.deleteEntry',
      'memory.onChanged',
      'memory.setEnabled',
      'memory.snapshot',
      'memory.updateCategory',
      'memory.updateEntry',
      'network.checkConnectivity',
      'network.getInfo',
      'network.onSystemResume',
      'notebook.appendCodeCell',
      'notebook.beginCodeCell',
      'notebook.execute',
      'notebook.exportIpynb',
      'notebook.exportIpynbAll',
      'notebook.finishCodeCell',
      'notebook.getReference',
      'notebook.inspectNamespace',
      'notebook.onAvailable',
      'notebook.onChanged',
      'notebook.readInputPreview',
      'notebook.restart',
      'notebook.runCell',
      'notebook.shutdown',
      'notebook.state',
      'notebookEnv.cancel',
      'notebookEnv.getStatus',
      'notebookEnv.onProgress',
      'notebookEnv.provision',
      'notebookEnv.repair',
      'notifications.getDesktopAvailability',
      'notifications.getSnapshot',
      'notifications.markAllRead',
      'notifications.markRead',
      'notifications.markSessionCompletionsRead',
      'notifications.onChanged',
      'notifications.onOpenSession',
      'notifications.onViewProbe',
      'notifications.peekPendingOpenSession',
      'notifications.sendTest',
      'notifications.syncViewState',
      'notifications.takePendingOpenSession',
      'officePreview.attachFrame',
      'officePreview.close',
      'officePreview.onState',
      'officePreview.open',
      'officePreview.reportState',
      'permissions.extendUndo',
      'permissions.list',
      'permissions.onChanged',
      'permissions.restore',
      'permissions.restoreDefaults',
      'permissions.revoke',
      'preview.delete',
      'preview.load',
      'preview.save',
      'previewContextMenu.onRequested',
      'previewResources.acquire',
      'previewResources.readRange',
      'previewResources.release',
      'projectFiles.getOverview',
      'projectFiles.listArtifactGroups',
      'projectFiles.listFiles',
      'projectFiles.onChanged',
      'projectFiles.repairIndex',
      'projectFiles.resolveFile',
      'projectFiles.searchArtifacts',
      'projects.create',
      'projects.delete',
      'projects.get',
      'projects.list',
      'projects.listDeletionCleanup',
      'projects.onCreated',
      'projects.onDeleted',
      'projects.onDeletionCleanupChanged',
      'projects.onUpdated',
      'projects.retryDeletionCleanup',
      'projects.update',
      'projects.updateArchive',
      'remoteAccess.approve',
      'remoteAccess.detect',
      'remoteAccess.disable',
      'remoteAccess.getSnapshot',
      'remoteAccess.onChanged',
      'remoteAccess.probe',
      'remoteAccess.reject',
      'remoteAccess.revokeBrowser',
      'remoteAccess.setMode',
      'reviewer.abortFixLoop',
      'reviewer.getForSession',
      'reviewer.onFixLoopEnd',
      'reviewer.onFixLoopStart',
      'reviewer.onSuppressNextAutoReview',
      'reviewer.onUpdated',
      'reviewer.run',
      'runtime.describeUsage',
      'runtime.getAgentEnvironmentCreationEnabled',
      'runtime.getEnablement',
      'runtime.listEnvironments',
      'runtime.listPackageCounts',
      'runtime.listPackages',
      'runtime.pickInterpreter',
      'runtime.registerInterpreter',
      'runtime.setAgentEnvironmentCreationEnabled',
      'runtime.setEnvironmentEnabled',
      'runtime.setInstallAuthorized',
      'runtime.unregisterInterpreter',
      'saveBlobFile',
      'saveManagedFile',
      'saveProjectArtifacts',
      'saveSessionArtifacts',
      'sessions.deleteSession',
      'sessions.editDetails',
      'sessions.exportConversation',
      'sessions.filterPdfContextCandidates',
      'sessions.linkPdfContext',
      'sessions.list',
      'sessions.loadAll',
      'sessions.loadOne',
      'sessions.loadUsage',
      'sessions.onCreated',
      'sessions.onDeleted',
      'sessions.onFlushAborted',
      'sessions.onFlushRequest',
      'sessions.onUpdated',
      'sessions.openRecoveryFolder',
      'sessions.saveManifest',
      'sessions.saveSession',
      'sessions.sendFlushResponse',
      'sessions.setDelegationPolicy',
      'sessions.unlinkPdfContext',
      'sessions.updateArchive',
      'settings.addCustomServer',
      'settings.authenticateCustomServer',
      'settings.authenticateDeviceCredential',
      'settings.beginXaiOAuthLogin',
      'settings.cancelClaudeLogin',
      'settings.cancelCodexLogin',
      'settings.cancelCustomServerAuthentication',
      'settings.cancelDeviceCredentialAuthentication',
      'settings.cancelIsolatedClaudeLogin',
      'settings.cancelXaiOAuthLogin',
      'settings.checkEnvironment',
      'settings.createDeviceCredential',
      'settings.createSkill',
      'settings.deleteProvider',
      'settings.deleteSkill',
      'settings.detectClaude',
      'settings.detectCodeBuddy',
      'settings.detectCodex',
      'settings.detectOpencode',
      'settings.disconnectCustomServer',
      'settings.disconnectDeviceCredential',
      'settings.exportCustomServerTemplate',
      'settings.exportSkill',
      'settings.getConnectorDetail',
      'settings.getGitHubTokenStatus',
      'settings.getNotebookNetworkStatus',
      'settings.getPackageMirror',
      'settings.getPreflight',
      'settings.getSettings',
      'settings.getSkillDetail',
      'settings.importAgentHomeSkills',
      'settings.importSkill',
      'settings.importSkillZip',
      'settings.importSkillZipBatch',
      'settings.installClaude',
      'settings.installCodeBuddy',
      'settings.installCodex',
      'settings.installNotebookNetwork',
      'settings.installOpencode',
      'settings.isEncryptionAvailable',
      'settings.isNpmAvailable',
      'settings.listAgentHomeSkills',
      'settings.listAppIcons',
      'settings.listConnectors',
      'settings.listDeviceCredentials',
      'settings.listSkills',
      'settings.loginIsolatedClaude',
      'settings.loginIsolatedClaudeBrowser',
      'settings.loginIsolatedCodex',
      'settings.loginSharedClaude',
      'settings.logoutIsolatedClaude',
      'settings.logoutIsolatedCodex',
      'settings.logoutSharedClaude',
      'settings.logoutXaiOAuth',
      'settings.markOnboardingComplete',
      'settings.onChanged',
      'settings.onConnectorApprovalRequest',
      'settings.onConnectorApprovalSettled',
      'settings.onConnectorCredentialRequest',
      'settings.onConnectorCredentialSettled',
      'settings.onConnectorRuntimeChanged',
      'settings.onInstallLog',
      'settings.onSkillCatalogChanged',
      'settings.onSkillImportApprovalRequest',
      'settings.onSkillImportApprovalSettled',
      'settings.previewAgentHomeSkill',
      'settings.previewCustomServerTemplateExport',
      'settings.previewGitHubSkill',
      'settings.previewSkillZip',
      'settings.refreshProviderModels',
      'settings.removeCustomServer',
      'settings.removeDeviceCredential',
      'settings.removeGitHubToken',
      'settings.removeNotebookNetwork',
      'settings.replayConnectorApproval',
      'settings.replayPendingConnectorApprovals',
      'settings.replayPendingConnectorCredentialRequests',
      'settings.replayPendingSkillImportApprovals',
      'settings.resolveSkillDocument',
      'settings.respondConnectorApproval',
      'settings.respondConnectorCredentialRequest',
      'settings.respondSkillImportApproval',
      'settings.retryConnectorProjection',
      'settings.retryCustomServer',
      'settings.saveGitHubToken',
      'settings.scanRepoSkills',
      'settings.selectCustomServerTemplate',
      'settings.setActiveProvider',
      'settings.setAgentFramework',
      'settings.setAppIconVariant',
      'settings.setClosePreference',
      'settings.setConnectorAutoAllow',
      'settings.setConnectorEnabled',
      'settings.setConversationSkillImportEnabled',
      'settings.setCustomServerEnabled',
      'settings.setDefaultPermissionProfile',
      'settings.setNcbiCredentials',
      'settings.setNetworkProxy',
      'settings.setNotebookNetwork',
      'settings.setNotificationsEnabled',
      'settings.setOpenAlexCredential',
      'settings.setPackageMirror',
      'settings.setProjectFilesFilter',
      'settings.setReasoningEffort',
      'settings.setReviewerModel',
      'settings.setSessionDetailsModel',
      'settings.setShowNotificationContent',
      'settings.setSkillEnabled',
      'settings.setSkillsEnabled',
      'settings.setSubagentModel',
      'settings.setToolPermission',
      'settings.setVisionModel',
      'settings.uninstallClaude',
      'settings.uninstallCodeBuddy',
      'settings.uninstallCodex',
      'settings.uninstallOpencode',
      'settings.updateCustomServer',
      'settings.updateDeviceCredential',
      'settings.updateSkill',
      'settings.upsertProvider',
      'settings.validateOpenAlexCredential',
      'settings.validateProvider',
      'settings.waitXaiOAuthLogin',
      'sideChat.cancel',
      'sideChat.close',
      'sideChat.list',
      'sideChat.onEvent',
      'sideChat.onRelayDelivered',
      'sideChat.send',
      'sideChat.start',
      'sourcePreview.onLoadState',
      'sourcePreview.release',
      'specialist.addMarketplaceSource',
      'specialist.cancelHandoff',
      'specialist.cancelMarketplaceCandidate',
      'specialist.cancelPackage',
      'specialist.create',
      'specialist.delete',
      'specialist.duplicate',
      'specialist.exportContributionTemplate',
      'specialist.exportSpecialist',
      'specialist.getHandoffEvents',
      'specialist.getMarketplaceRelease',
      'specialist.inspectGitHubMarketplaceSource',
      'specialist.installMarketplace',
      'specialist.installPackage',
      'specialist.list',
      'specialist.listMarketplace',
      'specialist.onCatalogChanged',
      'specialist.onHandoffLifecycleEvent',
      'specialist.onMarketplaceDownloadProgress',
      'specialist.onPendingSwitch',
      'specialist.prepareMarketplaceInstall',
      'specialist.previewDelete',
      'specialist.previewExport',
      'specialist.removeMarketplaceSource',
      'specialist.resolveSessionSpecialist',
      'specialist.retryHandoff',
      'specialist.savePackageReport',
      'specialist.selectPackage',
      'specialist.setEnabled',
      'specialist.setSessionSpecialist',
      'specialist.update',
      'storage.acceptMissingDataRoot',
      'storage.ackDataRootHandoffFlush',
      'storage.cancelMigrate',
      'storage.commitAndRelaunch',
      'storage.detectActive',
      'storage.discardMigratedCopy',
      'storage.dismissLegacyMovePrompt',
      'storage.getInfo',
      'storage.getStatus',
      'storage.inspectDataRoot',
      'storage.migrate',
      'storage.onProgress',
      'storage.pickDirectory',
      'storage.revealAppStorage',
      'storage.setDataRootAndRelaunch',
      'storage.validateDataRoot',
      'tags.create',
      'tags.delete',
      'tags.onChanged',
      'tags.reorder',
      'tags.setAssignment',
      'tags.snapshot',
      'tags.update',
      'update.apply',
      'update.cancel',
      'update.check',
      'update.download',
      'update.getAppInfo',
      'update.getStatus',
      'update.onProgress',
      'update.onStatus',
      'uploads.abortTransfer',
      'uploads.appendTransfer',
      'uploads.beginTransfer',
      'uploads.claimLocalFile',
      'uploads.deleteUpload',
      'uploads.finalizeSession',
      'uploads.finishTransfer',
      'uploads.getTransferStatus',
      'uploads.onTransferProgress',
      'uploads.readPreview',
      'uploads.stageLocalFile',
      'uploads.stageLocalPath',
      'window.announceWindowFindAppearance',
      'window.announceWindowFindContentReady',
      'window.announceWindowFindReady',
      'window.clearFind',
      'window.close',
      'window.closeFind',
      'window.findInPage',
      'window.onCloseActivePane',
      'window.onCloseConfirmRequest',
      'window.onFindInPageResult',
      'window.onHideWindowFind',
      'window.onShowWindowFind',
      'window.onWindowFindAppearance',
      'window.sendCloseConfirmResponse'
    ])
  })
})

describe('preload bridge — Connector configuration files', () => {
  it('forwards dropped file contents for main-process validation', async () => {
    const request = {
      fileName: 'example.json',
      contents: '{"schemaVersion":1,"kind":"open-science.connector"}'
    }

    await api.settings.selectCustomServerTemplate(request)

    expect(invokeMock).toHaveBeenCalledWith('settings:select-custom-server-template', request)
  })
})

describe('preload bridge — runtime renderer contract catalog', () => {
  it('routes every owned method through its cataloged Electron channel', async () => {
    const requestContracts = runtimeContracts.filter(({ kind }) => kind === 'method')

    for (const contract of requestContracts) {
      invokeMock.mockClear()

      await getApiCallable(contract.publicPath)()

      expect(invokeMock, contract.publicPath).toHaveBeenCalledTimes(1)
      expect(invokeMock, contract.publicPath).toHaveBeenCalledWith(
        contract.channel,
        ...invokeMock.mock.calls[0].slice(1)
      )
    }
  })

  it('strips event metadata and removes each cataloged listener by exact identity', () => {
    const eventContracts = runtimeContracts.filter(({ kind }) => kind === 'event')

    for (const contract of eventContracts) {
      onMock.mockClear()
      removeListenerMock.mockClear()
      const listener = vi.fn()
      const unsubscribe = getApiCallable(contract.publicPath)(listener) as () => void
      const wrappedListener = onMock.mock.calls[0]?.[1]
      const payload = { publicPath: contract.publicPath }

      wrappedListener?.({ sender: 'electron' }, payload)
      unsubscribe()

      expect(onMock, contract.publicPath).toHaveBeenCalledWith(contract.channel, wrappedListener)
      expect(listener, contract.publicPath).toHaveBeenCalledWith(payload)
      expect(removeListenerMock, contract.publicPath).toHaveBeenCalledWith(
        contract.channel,
        wrappedListener
      )
    }
  })

  it('preserves ACP defaults and notebook environment operation arguments', async () => {
    await api.acp.connect()
    await api.acp.connect(undefined)
    await api.notebookEnv.cancel()
    await api.notebookEnv.cancel(undefined)
    await api.notebookEnv.provision('r', 'provision-operation')
    await api.notebookEnv.repair('python', 'default-python', 'repair-operation')

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'acp:connect', {})
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'acp:connect', {})
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'notebook-env:cancel', undefined)
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'notebook-env:cancel', undefined)
    expect(invokeMock).toHaveBeenNthCalledWith(
      5,
      'notebook-env:provision',
      'r',
      'provision-operation'
    )
    expect(invokeMock).toHaveBeenNthCalledWith(
      6,
      'notebook-env:repair',
      'python',
      'default-python',
      'repair-operation'
    )
  })
})

describe('preload bridge — core renderer contract catalog', () => {
  it('pins the core T1d capability complement', () => {
    expect(coreContractGroups.map(({ capability }) => capability)).toEqual([
      'artifacts',
      'cli',
      'database-startup',
      'diagnostics',
      'github',
      'lifecycle',
      'locale',
      'local-fs',
      'memory',
      'logs',
      'managed-file-versions',
      'network',
      'notifications',
      'office-preview',
      'source-preview',
      'platform-file-save',
      'preview',
      'preview-context-menu',
      'preview-resources',
      'project-files',
      'projects',
      'tags',
      'remote-access',
      'reviewer',
      'sessions',
      'side-chat',
      'storage',
      'update',
      'uploads',
      'window'
    ])
  })

  it('routes every request method through its cataloged Electron channel', async () => {
    const requestContracts = coreContracts.filter(
      ({ dispatchPolicy, publicPath }) =>
        dispatchPolicy.electron === 'electron-ipc-request' &&
        publicPath !== 'sessions.filterPdfContextCandidates' &&
        publicPath !== 'sessions.linkPdfContext' &&
        publicPath !== 'sessions.unlinkPdfContext'
    )
    const localFile = { name: 'catalog.csv' } as File

    for (const contract of requestContracts) {
      invokeMock.mockClear()
      getPathForFileMock.mockReturnValue('/data/catalog.csv')
      const args = contract.publicPath === 'uploads.stageLocalFile' ? [localFile, {}] : []

      await getApiCallable(contract.publicPath)(...args)

      expect(invokeMock, contract.publicPath).toHaveBeenCalledTimes(1)
      expect(invokeMock, contract.publicPath).toHaveBeenCalledWith(
        contract.channel,
        ...invokeMock.mock.calls[0].slice(1)
      )
    }
  })

  it('projects Memory requests and events without a handwritten preload bridge', async () => {
    const request = { enabled: false }
    await getApiCallable('memory.setEnabled')(request)

    expect(invokeMock).toHaveBeenCalledWith('memory:set-enabled', request)

    const listener = vi.fn()
    const unsubscribe = getApiCallable('memory.onChanged')(listener) as () => void
    const wrappedListener = onMock.mock.calls.at(-1)?.[1]
    const event = { revision: 42 }

    wrappedListener?.({ sender: 'electron' }, event)
    unsubscribe()

    expect(onMock).toHaveBeenCalledWith('memory:changed', wrappedListener)
    expect(listener).toHaveBeenCalledWith(event)
    expect(removeListenerMock).toHaveBeenCalledWith('memory:changed', wrappedListener)
  })

  it('unwraps the runtime-validated PDF context Session commands', async () => {
    const cases = [
      {
        call: () => api.sessions.setDelegationPolicy('project-1', 'session-1', 'deny'),
        channel: 'sessions:set-delegation-policy'
      },
      {
        call: () =>
          api.sessions.filterPdfContextCandidates({
            projectId: 'project-1',
            sources: []
          }),
        channel: 'sessions:filter-pdf-context-candidates'
      },
      {
        call: () =>
          api.sessions.linkPdfContext({
            projectId: 'project-1',
            sessionId: 'session-1',
            expectedRevision: 0,
            sourceKind: 'artifact-version',
            sourceVersionId: 'version-1'
          }),
        channel: 'sessions:link-pdf-context'
      },
      {
        call: () =>
          api.sessions.unlinkPdfContext({
            projectId: 'project-1',
            sessionId: 'session-1',
            expectedRevision: 1,
            bindingId: 'binding-1'
          }),
        channel: 'sessions:unlink-pdf-context'
      }
    ]

    for (const testCase of cases) {
      invokeMock.mockResolvedValueOnce({ ok: true, result: { version: 1, revision: 2 } })
      await expect(testCase.call()).resolves.toEqual({ version: 1, revision: 2 })
      if (testCase.channel === 'sessions:set-delegation-policy') {
        expect(invokeMock).toHaveBeenLastCalledWith(
          testCase.channel,
          'project-1',
          'session-1',
          'deny'
        )
      } else {
        expect(invokeMock).toHaveBeenLastCalledWith(testCase.channel, expect.any(Object))
      }
    }
  })

  it('routes all generic events and removes each wrapped listener by exact identity', () => {
    const eventContracts = coreContracts.filter(({ kind }) => kind === 'event')
    const genericEventContracts = eventContracts.filter(
      ({ lifecycleDispatch }) => lifecycleDispatch == null
    )

    for (const contract of genericEventContracts) {
      onMock.mockClear()
      removeListenerMock.mockClear()
      const listener = vi.fn()
      const unsubscribe = getApiCallable(contract.publicPath)(listener) as () => void
      const wrappedListener = onMock.mock.calls[0]?.[1]
      const payload = { publicPath: contract.publicPath }

      wrappedListener?.({ sender: 'electron' }, payload)
      unsubscribe()

      expect(onMock, contract.publicPath).toHaveBeenCalledWith(contract.channel, wrappedListener)
      if (contract.publicPath === 'remoteAccess.onChanged') {
        expect(listener, contract.publicPath).toHaveBeenCalledWith()
      } else {
        expect(listener, contract.publicPath).toHaveBeenCalledWith(payload)
      }
      expect(removeListenerMock, contract.publicPath).toHaveBeenCalledWith(
        contract.channel,
        wrappedListener
      )
    }
  })

  it('routes every generic one-way send through its cataloged Electron channel', () => {
    const sendContracts = coreContracts.filter(
      ({ dispatchPolicy }) => dispatchPolicy.electron === 'electron-ipc-send'
    )
    const genericSendContracts = sendContracts.filter(
      ({ lifecycleDispatch }) => lifecycleDispatch == null
    )

    for (const contract of genericSendContracts) {
      sendMock.mockClear()

      getApiCallable(contract.publicPath)()

      expect(sendMock, contract.publicPath).toHaveBeenCalledTimes(1)
      expect(sendMock, contract.publicPath).toHaveBeenCalledWith(
        contract.channel,
        ...sendMock.mock.calls[0].slice(1)
      )
    }
  })

  it('keeps runtime versions surface-native', () => {
    expect(api.getRuntimeVersions()).toEqual({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('preserves Session, Storage, and native-upload request argument shapes', async () => {
    const session = { id: 'session-1' }
    const options = { expectedRevision: 4 }
    const file = { name: 'large.csv' } as File
    const request = { transferId: 'transfer-1' }
    getPathForFileMock.mockReturnValue('/data/large.csv')

    await api.sessions.saveSession(session)
    await api.sessions.saveSession(session, undefined)
    await api.sessions.saveSession(session, null)
    await api.sessions.saveSession(session, options)
    await api.storage.validateDataRoot('/data/open-science')
    await api.storage.setDataRootAndRelaunch('/data/open-science', true)
    await api.uploads.stageLocalFile(file, request)

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'sessions:save-session', session)
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'sessions:save-session', session)
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'sessions:save-session', session)
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'sessions:save-session', session, options)
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'storage:validate-data-root', {
      parent: '/data/open-science'
    })
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'storage:set-data-root-and-relaunch', {
      parent: '/data/open-science',
      markOnboarding: true
    })
    expect(invokeMock).toHaveBeenNthCalledWith(7, 'uploads:stage-local-file', {
      ...request,
      sourcePath: '/data/large.csv'
    })
  })

  it('restores a revision-conflict rejection from the Session save IPC outcome', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'session-revision-conflict',
        message:
          'Session revision conflict: expected 3, actual 4. Reload the latest conversation before retrying.'
      }
    })

    await expect(api.sessions.saveSession({ id: 'session-1' })).rejects.toMatchObject({
      code: 'session-revision-conflict'
    })
    expect(invokeMock).toHaveBeenCalledWith('sessions:save-session', { id: 'session-1' })
  })

  it('restores a details-conflict rejection from the Session edit IPC outcome', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'session-details-conflict',
        message: 'Session details changed elsewhere. Reopen the editor and try again.'
      }
    })

    await expect(api.sessions.editDetails(sampleEditSessionDetails)).rejects.toMatchObject({
      code: 'session-details-conflict'
    })
    expect(invokeMock).toHaveBeenCalledWith('sessions:edit-details', sampleEditSessionDetails)
  })

  it('returns null without IPC when native upload path extraction fails', async () => {
    const file = { name: 'clipboard.csv' } as File
    getPathForFileMock.mockReturnValue('')

    await expect(api.uploads.stageLocalFile(file, { transferId: 'transfer-1' })).resolves.toBeNull()

    expect(getPathForFileMock).toHaveBeenCalledWith(file)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('preload bridge — renderer diagnostics', () => {
  it('sends the bounded renderer failure report over its one-way channel', () => {
    const report = {
      source: 'window-error',
      surface: 'workspace',
      errorCategory: 'type',
      fingerprint: 'a1b2c3d4'
    }

    api.diagnostics.reportRendererFailure(report)

    expect(sendMock).toHaveBeenCalledWith('diagnostics:renderer-failure', report)
  })
})

describe('preload bridge — window find IPC channels', () => {
  it('subscribes before READY and removes the listener before UNREADY for close-pane lifecycle', () => {
    const listener = vi.fn()

    const unsubscribe = api.window.onCloseActivePane(listener)

    expect(onMock).toHaveBeenCalledWith('shortcut:close-active-pane', expect.any(Function))
    expect(sendMock).toHaveBeenCalledWith('shortcut:close-active-pane-ready')
    expect(onMock.mock.invocationCallOrder[0]).toBeLessThan(sendMock.mock.invocationCallOrder[0])

    const wrappedListener = onMock.mock.calls[0]?.[1] as
      ((_event: unknown, payload: unknown) => void) | undefined
    wrappedListener?.({}, undefined)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()

    expect(removeListenerMock).toHaveBeenCalledWith('shortcut:close-active-pane', wrappedListener)
    expect(sendMock).toHaveBeenLastCalledWith('shortcut:close-active-pane-unready')
    expect(removeListenerMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMock.mock.invocationCallOrder[1]
    )
  })

  it('forwards find and clear requests without exposing a raw Electron object', () => {
    const request = { requestId: 1, text: 'protein', findNext: true, forward: true }

    api.window.findInPage?.(request)
    api.window.clearFind?.()

    expect(sendMock).toHaveBeenNthCalledWith(1, 'window:find-in-page', request)
    expect(sendMock).toHaveBeenNthCalledWith(2, 'window:clear-find-in-page')
  })

  it('forwards the overlay close request and find-overlay events from main', () => {
    const showListener = vi.fn()
    const hideListener = vi.fn()
    const appearanceListener = vi.fn()
    api.window.closeFind?.()
    api.window.onShowWindowFind?.(showListener)
    api.window.onHideWindowFind?.(hideListener)
    api.window.onWindowFindAppearance?.(appearanceListener)

    expect(sendMock).toHaveBeenCalledWith('window:find-close')
    expect(onMock).toHaveBeenCalledWith('window:find-show', expect.any(Function))
    expect(onMock).toHaveBeenCalledWith('window:find-hide', expect.any(Function))
    expect(onMock).toHaveBeenCalledWith('window:find-appearance', expect.any(Function))

    const wrappedListener = onMock.mock.calls.find(
      ([channel]) => channel === 'window:find-show'
    )?.[1] as ((event: unknown, appearance: unknown) => void) | undefined
    const wrappedAppearanceListener = onMock.mock.calls.find(
      ([channel]) => channel === 'window:find-appearance'
    )?.[1] as ((event: unknown, appearance: unknown) => void) | undefined
    const appearance = { theme: 'dark' as const, followsSystem: false }
    wrappedListener?.({}, appearance)
    wrappedAppearanceListener?.({}, appearance)

    expect(showListener).toHaveBeenCalledWith(appearance)
    expect(appearanceListener).toHaveBeenCalledWith(appearance)
  })

  it('announces Workspace find readiness on mount and unready on cleanup', () => {
    const dispose = api.window.announceWindowFindReady?.() as (() => void) | undefined

    expect(sendMock).toHaveBeenCalledWith('shortcut:window-find-ready')

    dispose?.()

    expect(sendMock).toHaveBeenNthCalledWith(2, 'shortcut:window-find-unready')
  })

  it('announces that the searchable transcript has committed before native find opens', () => {
    api.window.announceWindowFindContentReady?.()

    expect(sendMock).toHaveBeenCalledWith('shortcut:window-find-content-ready')
  })

  it('forwards renderer theme changes to main as a typed appearance payload', () => {
    const appearance = { theme: 'dark' as const, followsSystem: false }

    api.window.announceWindowFindAppearance?.(appearance)

    expect(sendMock).toHaveBeenCalledWith('window:find-appearance-changed', appearance)
  })
})

// Each case: invoke a bridge method with sample args, then assert the exact channel + forwarded args.
type ForwardingCase = {
  name: string
  invoke: (api: PreloadApi) => void
  channel: string
  args: unknown[]
}

const sampleSession = { id: 's-1', projectId: 'p-1', title: 't' }
const sampleDeleteSession = { projectId: 'p-1', sessionId: 's-1' }
const sampleEditSessionDetails = {
  projectId: 'p-1',
  sessionId: 's-1',
  expectedTitle: 'Original',
  expectedDescription: 'Original description',
  title: 'Edited',
  description: 'Description'
}
const sampleManifest = { projectId: 'p-1', sessionId: 's-1' }
const sampleConversationExport = {
  projectId: 'p-1',
  sessionId: 's-1',
  format: 'markdown',
  selectedPromptMessageIds: ['prompt-1']
}
const sampleInstall = { executablePath: '/usr/local/bin/opencode' }
const sampleFramework = { framework: 'opencode' }
const sampleResumeRequest = { sessionId: 's-1', cwd: '/workspace/project' }
const sampleInterruptedTurnRequest = {
  sessionId: 's-1',
  projectId: 'project-1',
  promptMessageId: 'prompt-1'
}
const sampleGitHubPreview = { url: 'https://github.com/acme/skills/tree/main/foo' }
const sampleAgentHomePreview = { source: 'agents', slug: 'foo' }
const sampleSessionArtifactSelection = {
  projectId: 'p-1',
  sessionId: 's-1',
  files: [{ path: 'artifact://report', suggestedName: 'report.csv' }]
}
const sampleProjectArtifactSelection = {
  projectId: 'p-1',
  suggestedArchiveName: 'Research',
  files: [
    { source: 'artifact', sessionId: 's-1', path: 'artifact://report', suggestedName: 'report.csv' }
  ]
}

const cases: ForwardingCase[] = [
  {
    name: 'settings.exportSkill → settings:export-skill',
    invoke: (a) => a.settings.exportSkill({ id: 'personal-my-skill' }),
    channel: 'settings:export-skill',
    args: [{ id: 'personal-my-skill' }]
  },
  {
    name: 'specialist.previewDelete → specialist:delete-preview',
    invoke: (a) => a.specialist.previewDelete({ id: 'research-synth' }),
    channel: 'specialist:delete-preview',
    args: [{ id: 'research-synth' }]
  },
  {
    name: 'specialist.delete → specialist:delete',
    invoke: (a) =>
      a.specialist.delete({
        id: 'research-synth',
        expectedRevision: 3,
        deleteSkillIds: ['analysis-tools']
      }),
    channel: 'specialist:delete',
    args: [
      {
        id: 'research-synth',
        expectedRevision: 3,
        deleteSkillIds: ['analysis-tools']
      }
    ]
  },
  {
    name: 'specialist.previewExport → specialist:export-preview',
    invoke: (a) => a.specialist.previewExport({ specialistId: 'research-synth' }),
    channel: 'specialist:export-preview',
    args: [{ specialistId: 'research-synth' }]
  },
  {
    name: 'specialist.exportSpecialist → specialist:export-save',
    invoke: (a) =>
      a.specialist.exportSpecialist({
        specialistId: 'research-synth',
        expectedRevision: 3,
        includedSkillIds: ['analysis-tools']
      }),
    channel: 'specialist:export-save',
    args: [
      {
        specialistId: 'research-synth',
        expectedRevision: 3,
        includedSkillIds: ['analysis-tools']
      }
    ]
  },
  {
    name: 'specialist.exportContributionTemplate → specialist:export-contribution-template',
    invoke: (a) => a.specialist.exportContributionTemplate(),
    channel: 'specialist:export-contribution-template',
    args: []
  },
  {
    name: 'saveSessionArtifacts → file:save-session-artifacts',
    invoke: (a) => a.saveSessionArtifacts(sampleSessionArtifactSelection),
    channel: 'file:save-session-artifacts',
    args: [sampleSessionArtifactSelection]
  },
  {
    name: 'saveProjectArtifacts → file:save-project-artifacts',
    invoke: (a) => a.saveProjectArtifacts(sampleProjectArtifactSelection),
    channel: 'file:save-project-artifacts',
    args: [sampleProjectArtifactSelection]
  },
  {
    name: 'lifecycle.getClientId → lifecycle:client-id (no args)',
    invoke: (a) => a.lifecycle.getClientId(),
    channel: 'lifecycle:client-id',
    args: []
  },
  // sessions block
  {
    name: 'sessions.loadAll → sessions:load-all (no args)',
    invoke: (a) => a.sessions.loadAll(),
    channel: 'sessions:load-all',
    args: []
  },
  {
    name: 'sessions.loadOne → sessions:load-one',
    invoke: (a) => a.sessions.loadOne(sampleDeleteSession),
    channel: 'sessions:load-one',
    args: [sampleDeleteSession]
  },
  {
    name: 'sessions.saveSession → sessions:save-session',
    invoke: (a) => a.sessions.saveSession(sampleSession),
    channel: 'sessions:save-session',
    args: [sampleSession]
  },
  {
    name: 'sessions.setDelegationPolicy → sessions:set-delegation-policy',
    invoke: (a) => a.sessions.setDelegationPolicy('p-1', 's-1', 'deny'),
    channel: 'sessions:set-delegation-policy',
    args: ['p-1', 's-1', 'deny']
  },
  {
    name: 'sessions.editDetails → sessions:edit-details',
    invoke: (a) => a.sessions.editDetails(sampleEditSessionDetails),
    channel: 'sessions:edit-details',
    args: [sampleEditSessionDetails]
  },
  {
    name: 'sessions.deleteSession → sessions:delete-session',
    invoke: (a) => a.sessions.deleteSession(sampleDeleteSession),
    channel: 'sessions:delete-session',
    args: [sampleDeleteSession]
  },
  {
    name: 'sessions.saveManifest → sessions:save-manifest',
    invoke: (a) => a.sessions.saveManifest(sampleManifest),
    channel: 'sessions:save-manifest',
    args: [sampleManifest]
  },
  {
    name: 'sessions.exportConversation → sessions:export-conversation',
    invoke: (a) => a.sessions.exportConversation(sampleConversationExport),
    channel: 'sessions:export-conversation',
    args: [sampleConversationExport]
  },
  // agent-framework / opencode settings additions
  {
    name: 'settings.detectOpencode → settings:detect-opencode (no args)',
    invoke: (a) => a.settings.detectOpencode(),
    channel: 'settings:detect-opencode',
    args: []
  },
  {
    name: 'settings.installOpencode → settings:install-opencode',
    invoke: (a) => a.settings.installOpencode(sampleInstall),
    channel: 'settings:install-opencode',
    args: [sampleInstall]
  },
  {
    name: 'settings.detectCodeBuddy → settings:detect-codebuddy (no args)',
    invoke: (a) => a.settings.detectCodeBuddy(),
    channel: 'settings:detect-codebuddy',
    args: []
  },
  {
    name: 'settings.installCodeBuddy → settings:install-codebuddy',
    invoke: (a) => a.settings.installCodeBuddy({ source: 'managed' }),
    channel: 'settings:install-codebuddy',
    args: [{ source: 'managed' }]
  },
  {
    name: 'settings.detectCodex → settings:detect-codex (no args)',
    invoke: (a) => a.settings.detectCodex(),
    channel: 'settings:detect-codex',
    args: []
  },
  {
    name: 'settings.installCodex → settings:install-codex',
    invoke: (a) => a.settings.installCodex(sampleInstall),
    channel: 'settings:install-codex',
    args: [sampleInstall]
  },
  {
    name: 'settings.setAgentFramework → settings:set-agent-framework',
    invoke: (a) => a.settings.setAgentFramework(sampleFramework),
    channel: 'settings:set-agent-framework',
    args: [sampleFramework]
  },
  {
    name: 'settings.setNotificationsEnabled → settings:set-notifications-enabled',
    invoke: (a) => a.settings.setNotificationsEnabled({ enabled: false }),
    channel: 'settings:set-notifications-enabled',
    args: [{ enabled: false }]
  },
  {
    name: 'settings.setConversationSkillImportEnabled → settings:set-conversation-skill-import-enabled',
    invoke: (a) => a.settings.setConversationSkillImportEnabled({ enabled: false }),
    channel: 'settings:set-conversation-skill-import-enabled',
    args: [{ enabled: false }]
  },
  {
    name: 'settings.setClosePreference → settings:set-close-preference',
    invoke: (a) => a.settings.setClosePreference({ preference: 'minimize' }),
    channel: 'settings:set-close-preference',
    args: [{ preference: 'minimize' }]
  },
  {
    name: 'settings.setProjectFilesFilter → settings:set-project-files-filter',
    invoke: (a) => a.settings.setProjectFilesFilter({ filter: { sourceMode: 'local' } }),
    channel: 'settings:set-project-files-filter',
    args: [{ filter: { sourceMode: 'local' } }]
  },
  {
    name: 'settings.setDefaultPermissionProfile → settings:set-default-permission-profile',
    invoke: (a) => a.settings.setDefaultPermissionProfile({ profile: 'auto' }),
    channel: 'settings:set-default-permission-profile',
    args: [{ profile: 'auto' }]
  },
  {
    name: 'settings.setAppIconVariant → settings:set-app-icon-variant',
    invoke: (a) => a.settings.setAppIconVariant({ variant: 'dark' }),
    channel: 'settings:set-app-icon-variant',
    args: [{ variant: 'dark' }]
  },
  {
    name: 'settings.listAppIcons → settings:list-app-icons (no args)',
    invoke: (a) => a.settings.listAppIcons(),
    channel: 'settings:list-app-icons',
    args: []
  },
  {
    name: 'settings.uninstallClaude → settings:uninstall-claude (no args)',
    invoke: (a) => a.settings.uninstallClaude(),
    channel: 'settings:uninstall-claude',
    args: []
  },
  {
    name: 'settings.uninstallOpencode → settings:uninstall-opencode (no args)',
    invoke: (a) => a.settings.uninstallOpencode(),
    channel: 'settings:uninstall-opencode',
    args: []
  },
  {
    name: 'settings.uninstallCodeBuddy → settings:uninstall-codebuddy (no args)',
    invoke: (a) => a.settings.uninstallCodeBuddy(),
    channel: 'settings:uninstall-codebuddy',
    args: []
  },
  {
    name: 'settings.uninstallCodex → settings:uninstall-codex (no args)',
    invoke: (a) => a.settings.uninstallCodex(),
    channel: 'settings:uninstall-codex',
    args: []
  },
  {
    name: 'settings.cancelCodexLogin → settings:cancel-codex-login (no args)',
    invoke: (a) => a.settings.cancelCodexLogin(),
    channel: 'settings:cancel-codex-login',
    args: []
  },
  {
    name: 'settings.loginIsolatedCodex → settings:login-isolated-codex (no args)',
    invoke: (a) => a.settings.loginIsolatedCodex(),
    channel: 'settings:login-isolated-codex',
    args: []
  },
  {
    name: 'settings.logoutIsolatedCodex → settings:logout-isolated-codex (no args)',
    invoke: (a) => a.settings.logoutIsolatedCodex(),
    channel: 'settings:logout-isolated-codex',
    args: []
  },
  {
    name: 'settings.cancelClaudeLogin → settings:cancel-claude-login (no args)',
    invoke: (a) => a.settings.cancelClaudeLogin(),
    channel: 'settings:cancel-claude-login',
    args: []
  },
  {
    name: 'settings.loginSharedClaude → settings:login-shared-claude (no args)',
    invoke: (a) => a.settings.loginSharedClaude(),
    channel: 'settings:login-shared-claude',
    args: []
  },
  {
    name: 'settings.logoutSharedClaude → settings:logout-shared-claude (no args)',
    invoke: (a) => a.settings.logoutSharedClaude(),
    channel: 'settings:logout-shared-claude',
    args: []
  },
  {
    name: 'settings.loginIsolatedClaude → settings:login-isolated-claude',
    invoke: (a) => a.settings.loginIsolatedClaude('sk-ant-test'),
    channel: 'settings:login-isolated-claude',
    args: ['sk-ant-test']
  },
  {
    name: 'settings.loginIsolatedClaudeBrowser → settings:login-isolated-claude-browser (no args)',
    invoke: (a) => a.settings.loginIsolatedClaudeBrowser(),
    channel: 'settings:login-isolated-claude-browser',
    args: []
  },
  {
    name: 'settings.cancelIsolatedClaudeLogin → settings:cancel-isolated-claude-login (no args)',
    invoke: (a) => a.settings.cancelIsolatedClaudeLogin(),
    channel: 'settings:cancel-isolated-claude-login',
    args: []
  },
  {
    name: 'settings.logoutIsolatedClaude → settings:logout-isolated-claude (no args)',
    invoke: (a) => a.settings.logoutIsolatedClaude(),
    channel: 'settings:logout-isolated-claude',
    args: []
  },
  {
    name: 'settings.previewGitHubSkill → settings:preview-github-skill',
    invoke: (a) => a.settings.previewGitHubSkill(sampleGitHubPreview),
    channel: 'settings:preview-github-skill',
    args: [sampleGitHubPreview]
  },
  {
    name: 'settings.previewAgentHomeSkill → settings:preview-agent-home-skill',
    invoke: (a) => a.settings.previewAgentHomeSkill(sampleAgentHomePreview),
    channel: 'settings:preview-agent-home-skill',
    args: [sampleAgentHomePreview]
  },
  // command-line launcher install/uninstall/status
  {
    name: 'cli.getStatus → cli:get-status (no args)',
    invoke: (a) => a.cli.getStatus(),
    channel: 'cli:get-status',
    args: []
  },
  {
    name: 'cli.install → cli:install (no args)',
    invoke: (a) => a.cli.install(),
    channel: 'cli:install',
    args: []
  },
  {
    name: 'cli.uninstall → cli:uninstall (no args)',
    invoke: (a) => a.cli.uninstall(),
    channel: 'cli:uninstall',
    args: []
  },
  // ACP session context: resume vs the overflow-recovery reset must hit distinct channels.
  {
    name: 'acp.resumeSession → acp:resume-session',
    invoke: (a) => a.acp.resumeSession(sampleResumeRequest),
    channel: 'acp:resume-session',
    args: [sampleResumeRequest]
  },
  {
    name: 'acp.continueInterruptedTurn → acp:continue-interrupted-turn',
    invoke: (a) => a.acp.continueInterruptedTurn(sampleInterruptedTurnRequest),
    channel: 'acp:continue-interrupted-turn',
    args: [sampleInterruptedTurnRequest]
  },
  {
    name: 'acp.resetSessionContext → acp:reset-session-context',
    invoke: (a) => a.acp.resetSessionContext(sampleResumeRequest),
    channel: 'acp:reset-session-context',
    args: [sampleResumeRequest]
  },
  {
    name: 'acp.compactSession → acp:compact-session',
    invoke: (a) => a.acp.compactSession({ sessionId: 's-1' }),
    channel: 'acp:compact-session',
    args: [{ sessionId: 's-1' }]
  },
  // Notification click target: inspect first so partial hydration can retain an omitted session.
  {
    name: 'notifications.peekPendingOpenSession → notifications:peek-pending-open-session',
    invoke: (a) => a.notifications.peekPendingOpenSession(),
    channel: 'notifications:peek-pending-open-session',
    args: []
  },
  {
    name: 'notifications.takePendingOpenSession → notifications:take-pending-open-session',
    invoke: (a) => a.notifications.takePendingOpenSession(7),
    channel: 'notifications:take-pending-open-session',
    args: [7]
  }
]

describe('preload bridge — sessions + agent-framework IPC channels', () => {
  it('sends desktop-only unread visibility without adding a Web invoke route', () => {
    const state = { visibleSessionId: 's-1' }

    api.notifications.syncViewState(state)

    expect(sendMock).toHaveBeenCalledWith('notifications:sync-unread-view', state)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('exposes the unread visibility probe as a narrow renderer event', () => {
    const listener = vi.fn()

    api.notifications.onViewProbe(listener)

    expect(onMock).toHaveBeenCalledWith('notifications:probe-unread-view', expect.any(Function))
    const wrappedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, challengeId: number) => void) | undefined
    wrappedListener?.({}, 41)
    expect(listener).toHaveBeenCalledWith(41)
  })

  it('does not expose the legacy half-delete project-session command', () => {
    expect(api.sessions).not.toHaveProperty('deleteProjectSessions')
  })

  it('bridges the bounded Session flush request and acknowledgement channels', () => {
    const listener = vi.fn()
    const abortedListener = vi.fn()
    const response = { requestId: 'flush-1' }

    api.sessions.onFlushAborted(abortedListener)
    expect(onMock).toHaveBeenCalledWith('sessions:flush-aborted', expect.any(Function))
    const wrappedAbortedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, payload: { reason: 'conflict' }) => void) | undefined
    wrappedAbortedListener?.({}, { reason: 'conflict' })
    expect(abortedListener).toHaveBeenCalledWith({ reason: 'conflict' })

    api.sessions.onFlushRequest(listener)
    expect(onMock).toHaveBeenCalledWith('sessions:flush-request', expect.any(Function))
    const wrappedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, request: { requestId: string }) => void) | undefined
    wrappedListener?.({}, response)
    expect(listener).toHaveBeenCalledWith(response)

    api.sessions.sendFlushResponse(response)
    expect(sendMock).toHaveBeenCalledWith('sessions:flush-response', response)
  })

  it('keeps Specialist management and pending-switch delivery on the Electron bridge', () => {
    const listener = vi.fn()
    const payload = { sessionId: 'session-1', targetName: 'ANALYST' }

    api.specialist.list()
    expect(invokeMock).toHaveBeenCalledWith('specialist:list')

    api.specialist.onPendingSwitch(listener)
    expect(onMock).toHaveBeenCalledWith('specialist:pending-switch', expect.any(Function))
    const wrappedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, value: unknown) => void) | undefined
    wrappedListener?.({}, payload)
    expect(listener).toHaveBeenCalledWith(payload)
  })

  it.each(cases)('$name', ({ invoke, channel, args }) => {
    invoke(api)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(channel, ...args)
  })

  it('forwards the exact argument reference given by the caller', () => {
    // Guards against accidental cloning/reshaping in the bridge: the same object reference must reach
    // ipcRenderer.invoke unchanged.
    api.settings.installOpencode(sampleInstall)
    expect(invokeMock.mock.calls[0]?.[1]).toBe(sampleInstall)
  })

  it('attaches the OOPIF and reports runtime state over the narrow Office bridge', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'attached' })
    await api.officePreview.attachFrame('office-session-1')
    api.officePreview.reportState('office-session-1', {
      sessionId: 'office-session-1',
      phase: 'ready'
    })

    expect(invokeMock).toHaveBeenCalledWith('office-preview:attach-frame', 'office-session-1')
    expect(sendMock).toHaveBeenCalledWith('office-preview:report-state', 'office-session-1', {
      sessionId: 'office-session-1',
      phase: 'ready'
    })
  })

  it('exposes source loading as a read-only renderer event', () => {
    const listener = vi.fn()
    const state = {
      navigationId: 1,
      sourceUrl: 'https://example.com/paper',
      currentUrl: 'https://example.com/paper',
      phase: 'loaded'
    }

    api.sourcePreview.onLoadState(listener)

    expect(onMock).toHaveBeenCalledWith('source-preview:load-state', expect.any(Function))
    const wrappedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, payload: unknown) => void) | undefined
    wrappedListener?.({}, state)
    expect(listener).toHaveBeenCalledWith(state)
  })

  it('releases source-preview tracking through a one-way renderer message', () => {
    const sourcePreview = api.sourcePreview as typeof api.sourcePreview & {
      release?: (sourceUrl: string) => void
    }

    expect(sourcePreview.release).toBeTypeOf('function')
    sourcePreview.release?.('https://example.com/paper')

    expect(sendMock).toHaveBeenCalledWith('source-preview:release', 'https://example.com/paper')
  })

  it('resolves native upload paths in preload and sends only metadata to main', async () => {
    const file = { name: 'large.csv', size: 1024, type: 'text/csv' } as File
    const attachment = { path: '/managed/.pending/large.csv' }
    const request = {
      transferId: 'transfer-1',
      name: 'large.csv',
      size: 1024,
      mimeType: 'text/csv'
    }
    getPathForFileMock.mockReturnValue('/data/large.csv')
    invokeMock.mockResolvedValueOnce(attachment)

    await expect(api.uploads.stageLocalFile(file, request)).resolves.toBe(attachment)
    await api.uploads.claimLocalFile({ transferId: request.transferId })

    expect(getPathForFileMock).toHaveBeenCalledWith(file)
    expect(invokeMock).toHaveBeenCalledWith('uploads:stage-local-file', {
      ...request,
      sourcePath: '/data/large.csv'
    })
    expect(invokeMock).toHaveBeenCalledWith('uploads:claim-local-file', {
      transferId: request.transferId
    })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})
