import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../..')
const readSource = (path: string): string => readFileSync(resolve(projectRoot, path), 'utf8')
const compact = (source: string): string => source.replace(/\s+/g, ' ').trim()
const occurrences = (source: string, token: string): number => source.split(token).length - 1

const between = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Production command wiring marker is missing: ${start} -> ${end}`)
  }
  return source.slice(startIndex, endIndex)
}

const ipcSource = readSource('src/main/ipc.ts')
const indexSource = readSource('src/main/index.ts')
const runtimeSource = readSource('src/main/application-runtime.ts')
const compositionSource = readSource('src/main/application-command-composition.ts')
const ipcRegistrySource = readSource('src/main/ipc-handler-registry.ts')
const notificationIpcSource = readSource('src/main/notifications/notification-inbox-ipc.ts')
const webAdapterSources = [
  'src/main/application-command-client.ts',
  'src/main/tasks/task-runner.ts',
  'src/main/web-service/http-server.ts',
  'src/main/web-service/index.ts',
  'src/main/web-service/task-api.ts'
].map(readSource)
const legacyAdapterBlock = compact(
  between(ipcSource, "declareElectronAdapter('desktop-utilities'", 'const electronSenderFor')
)
const notificationAdapterBlock = compact(
  between(
    ipcSource,
    "declareElectronAdapter('task-notifications'",
    'const connectorApplication = await modules.add('
  )
)
const dependencyBlock = compact(
  between(
    ipcSource,
    'const applicationCommandDependencies:',
    '// The shared coordinator remains the sole ACP + Notebook teardown owner.'
  )
)

describe('production application command wiring', () => {
  it('restores durable deletion barriers before managed file version recovery', () => {
    const deletionBarrierRestore = ipcSource.indexOf(
      'projectDeletionCoordinator.restorePendingDeletionBarriers()'
    )
    const managedFileRecovery = ipcSource.indexOf(
      'managedFileVersionService.recoverPendingWrites()'
    )
    expect(deletionBarrierRestore).toBeGreaterThan(-1)
    expect(managedFileRecovery).toBeGreaterThan(deletionBarrierRestore)
    expect(ipcSource).toMatch(
      /runDataRootStartupRecovery\(\s*\(\)\s*=>\s*projectDeletionCoordinator\.restorePendingDeletionBarriers\(\)\s*\)/
    )
    expect(ipcSource).toMatch(
      /withDataRootWrite\(\(\)\s*=>\s*managedFileVersionService\.recoverPendingWrites\(\)\)/
    )
  })

  it('defers legacy data-path normalization behind data-root startup recovery', () => {
    const normalizationBlock = compact(
      between(
        ipcSource,
        'if (!storedSettings.pathsNormalizedAt)',
        '// Share one repository and registry so runtime artifact claims and renderer finalization meet.'
      )
    )

    expect(normalizationBlock).toContain('await runDataRootStartupRecovery(')
    expect(normalizationBlock).toContain('await normalizeLegacyDataPaths({')
  })

  it('does not block application startup on managed file content integrity scanning', () => {
    expect(ipcSource).toMatch(/managedFileVersionService\s*\.auditActiveVersionIntegrity\(\)/)
    expect(ipcSource).not.toMatch(
      /await\s+managedFileVersionService\s*\.auditActiveVersionIntegrity\(\)/
    )
  })

  it('injects each stateful owner into its Electron adapter and command composition', () => {
    const sharedOwners = [
      [
        'managedPreviewOwners',
        'installManagedPreviewElectronAdapter( previewResources, managedPreviewProtocol, managedPreviewOwners )',
        'managedPreview: managedPreviewOwners'
      ],
      [
        'projectFilesHandlers',
        'projectDeletionCoordinator, projectFilesHandlers )',
        'projectFiles: projectFilesHandlers'
      ],
      [
        'sessionPersistenceHandlers',
        'reviewRepository, sessionPersistenceHandlers, async (session)',
        '...sessionPersistenceHandlers'
      ],
      ['artifactHandlers', 'artifactHandlers )', 'artifacts: artifactHandlers'],
      [
        'permissionGrantProjection',
        'registerPermissionGrantIpcAdapter(permissionGrantProjection)',
        'permissionGrants: permissionGrantProjection'
      ],
      ['storageCommandOwner', 'storageCommandOwner )', 'storage: storageCommandOwner'],
      [
        'reviewerCommandOwner',
        'registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)',
        'reviewer: reviewerCommandOwner'
      ],
      [
        'updateCommandOwner',
        'registerUpdateIpcHandlers(updateStrategy, updateCommandOwner)',
        'update: updateCommandOwner'
      ],
      ['cliCommandOwner', 'registerCliInstallIpcHandlers(cliCommandOwner)', 'cli: cliCommandOwner'],
      [
        'githubCommandOwner',
        'registerGithubIpcHandlers({}, githubCommandOwner)',
        'github: githubCommandOwner'
      ],
      ['logsCommandOwner', 'registerLogsIpcHandlers(logsCommandOwner)', 'logs: logsCommandOwner'],
      [
        'uploadCommandOwner',
        'registerUploadIpcHandlers(uploadCommandOwner, {',
        'uploads: uploadCommandOwner'
      ],
      [
        'conversationExportService',
        'registerConversationExportIpcHandler(conversationExportService)',
        'conversationExportService.exportConversation('
      ]
    ] as const

    for (const [owner, electronUse, compositionUse] of sharedOwners) {
      expect(legacyAdapterBlock, `${owner} must be used by the legacy Electron adapter`).toContain(
        electronUse
      )
      expect(dependencyBlock, `${owner} must be used by command composition`).toContain(
        compositionUse
      )
    }

    expect(dependencyBlock).toContain('projects: projectHandlers')
    expect(dependencyBlock).toContain('tags: tagService')
    expect(compact(ipcSource)).toContain('const tagService = new TagService( new TagRepository')
    expect(dependencyBlock).toContain(
      'deleteSession: (request) => sessionDeletionOwner.delete(request)'
    )
    expect(compact(ipcSource)).toContain(
      "declareElectronAdapter('application-projects', () => registerApplicationCommandElectronAdapter(applicationCommandComposition.electron) )"
    )
    expect(ipcSource).not.toContain('registerSessionDeletionIpcHandler')
    expect(ipcSource).not.toContain("declareElectronAdapter('session-deletion'")
    expect(ipcSource).not.toContain("ipcMainHandle('sessions:edit-details'")
    expect(ipcSource).not.toContain('registerProjectIpcHandlers')
    expect(legacyAdapterBlock).toContain('registerPreviewStateIpcHandlers(previewStateRepository)')

    expect(compact(ipcSource)).toContain(
      'electronAdapters: { beforeCompute: beforeComputeAdapters, compute: { handlers: computeIpcModule.handlers, enabledHosts: sessionEnabledComputeHostsOwner },'
    )
    expect(dependencyBlock).toContain('compute: computeIpcModule.handlers')
    expect(ipcSource).toContain('await cliCommandOwner.ensureCurrent()')
    expect(dependencyBlock).toContain('enabledHosts: sessionEnabledComputeHostsOwner')
    expect(ipcSource).toContain(
      'const githubCommandOwner = createGithubCommandOwner({ fetch: netFetchStandard })'
    )
  })

  it('holds side chat admission through the in-place update handoff', () => {
    const updateGate = compact(
      between(ipcSource, 'const durableBackendHandoffGate', 'const detectResearchBlockers')
    )
    const updateStrategy = compact(
      between(ipcSource, 'const updateStrategy', 'const updateCommandOwner')
    )
    expect(updateGate).toContain(
      'shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, { holdSideChatAdmission: true })'
    )
    expect(updateStrategy).toContain('releaseInstallHandoff: abortUpdateHandoff')
  })

  it('keeps native-only commands inside the Electron owner adapter and exposes only narrow views', () => {
    const electronOwner = compact(
      between(dependencyBlock, 'electron: {', 'events: applicationEvents')
    )
    expect(occurrences(electronOwner, 'exportConversationFromInvokingWindow')).toBe(1)
    expect(occurrences(electronOwner, 'stageLocalFileWithProgress')).toBe(1)
    expect(compositionSource).toContain("'sessions:export-conversation'")
    expect(compositionSource).toContain("'uploads:stage-local-file'")

    const returnedViews = compact(
      between(ipcSource, 'return {\n    applicationCommands:', '    applicationEvents,')
    )
    expect(returnedViews).toContain('localWeb: applicationCommandComposition.localWeb')
    expect(returnedViews).toContain('remoteWeb: applicationCommandComposition.remoteWeb')
    expect(returnedViews).toContain('task: applicationCommandComposition.task')
    expect(occurrences(returnedViews, 'applicationCommandComposition.')).toBe(3)
  })

  it('injects the bounded isolated page preview resolver into production reviews', () => {
    const source = compact(ipcSource)
    expect(source).toContain('pagedContentResolver: createReviewerPagedContentResolver({')
    expect(source).toContain("partition: 'reviewer-paged-preview'")
    expect(source).toContain('contextIsolation: true, nodeIntegration: false, sandbox: true')
    expect(source).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
    expect(source).toContain('previewResources.acquireResolvedFile(')
    expect(source).toContain('renderPdfPages: renderPdfPagePreviews')
  })

  it('installs every notification inbox request on the Electron adapter', () => {
    expect(notificationAdapterBlock).toContain(
      'registerNotificationInboxIpcAdapter(notificationInbox)'
    )
    expect(notificationIpcSource).toContain("ipcMainHandle('notifications:get-snapshot'")
    expect(notificationIpcSource).toContain("ipcMainHandle('notifications:mark-read'")
    expect(notificationIpcSource).toContain("ipcMainHandle('notifications:mark-all-read'")
    expect(notificationIpcSource).toContain(
      "ipcMainHandle('notifications:mark-session-completions-read'"
    )
    expect(notificationIpcSource).toContain('owner.getSnapshot()')
    expect(notificationIpcSource).toContain('owner.markRead(')
    expect(notificationIpcSource).toContain('owner.markAllRead(')
    expect(notificationIpcSource).toContain('owner.markSessionCompletionsRead(')
  })

  it('adds transport adapters after composition and disposes the router before its owners', () => {
    const backendModule = ipcSource.indexOf("name: 'backend-shutdown-coordinator'")
    const commandModule = ipcSource.indexOf("name: 'application-command-composition'")
    expect(backendModule).toBeGreaterThan(-1)
    expect(commandModule).toBeGreaterThan(backendModule)
    expect(compact(ipcSource)).toContain('dispose: () => composition.dispose()')

    const build = runtimeSource.indexOf('const built = await createModules(modules)')
    const install = runtimeSource.indexOf(
      'const installation = await installAdapters(built.electronAdapters)'
    )
    const ownAdapter = runtimeSource.indexOf('await modules.add(installation, (installed) => ({')
    expect(build).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(build)
    expect(ownAdapter).toBeGreaterThan(install)
    expect(runtimeSource).toContain("await modules.dispose('rollback')")
  })

  it('registers startup network IPC before creating the first renderer window', () => {
    const preWindowStartup = compact(
      between(indexSource, 'await app.whenReady()', 'const startupWindow = webMode.headless')
    )

    expect(preWindowStartup).toContain('registerNetworkIpcHandlers()')
    expect(legacyAdapterBlock).not.toContain('registerNetworkIpcHandlers()')
    expect(occurrences(indexSource + ipcSource, 'registerNetworkIpcHandlers()')).toBe(1)
  })

  it('late-binds the unique Remote Access owner and passes only narrow views to Web and Task', () => {
    const startup = compact(
      between(
        indexSource,
        'const remoteAccess = await RemoteAccessService.create()',
        '// A launch that itself requested serving'
      )
    )
    expect(occurrences(indexSource, 'RemoteAccessService.create()')).toBe(1)
    expect(startup).toMatch(
      /const remoteAccess = await RemoteAccessService\.create\(\) bindRemoteAccess\(remoteAccess\) const webController = createWebServiceController\(\{[^}]*externalAccess: remoteAccess\.webAccess/
    )
    expect(startup).toContain('remoteAccess.attachWebController(webController)')
    expect(startup).toContain('registerRemoteAccessIpcHandlers(remoteAccess)')

    expect(occurrences(ipcSource, 'applicationCommands')).toBe(2)
    expect(indexSource).toContain('applicationCommands,')
    expect(startup).toContain('applicationCommands,')
    expect(startup).toContain('taskControls, computePreferences, detectActiveSessions }')
    expect(compact(ipcSource)).toContain(
      "computePreferences: Pick<SessionEnabledComputeHostsOwner, 'withReservation' | 'set'>"
    )
    expect(compact(ipcSource)).toContain('computePreferences: sessionEnabledComputeHostsOwner')
    expect(compact(ipcSource)).toContain(
      'resolveComputeExecutionTargetIds: (sessionId) => hostsRegistry.getSelected(sessionId)'
    )
    const webServiceSource = readSource('src/main/web-service/index.ts')
    expect(webServiceSource).toContain(
      "Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>"
    )
    expect(compact(webServiceSource)).toContain(
      '{ commands: applicationCommands.task, agent: taskAgent, controls: taskControls, computePreferences, detectActiveSessions }'
    )
    expect(webServiceSource).toContain('localWeb: applicationCommands.localWeb')
    expect(webServiceSource).toContain('remoteWeb: applicationCommands.remoteWeb')
    expect(readSource('src/main/tasks/task-runner.ts')).not.toContain('applicationCommands')
  })

  it('keeps Web and Task direct dispatch independent from Electron IPC capture machinery', () => {
    expect(ipcRegistrySource).not.toContain('WebIpcSender')
    expect(ipcRegistrySource).not.toContain('webHandlers')
    expect(ipcRegistrySource).not.toContain('nextSenderId')
    for (const source of webAdapterSources) {
      expect(source).not.toContain('ipc-handler-registry')
      expect(source).not.toContain('IpcMainInvokeEvent')
      expect(source).not.toContain('sender.id')
    }
  })
})
