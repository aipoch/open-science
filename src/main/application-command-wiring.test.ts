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
const coreSurfaceSource = compact(readSource('src/main/ipc-surfaces/core.ts'))
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
  between(ipcSource, 'createDesktopUtilitiesElectronSurface({', 'const electronSenderFor')
)
const notificationAdapterBlock = compact(readSource('src/main/ipc-surfaces/notifications.ts'))
const dependencyBlock = compact(
  between(
    ipcSource,
    'const applicationCommandDependencies:',
    '// The shared coordinator remains the sole ACP + Notebook teardown owner.'
  )
)

describe('production application command wiring', () => {
  it('reads current global permissions when creating a fork', () => {
    expect(compact(ipcSource)).toContain(
      'getDefaultPermissionProfile: async () => getDefaultPermissionProfile(await settingsRepository.getSettings())'
    )
  })

  it('adopts package publications into the live persistence owner before exposing desktop commands', () => {
    expect(compact(ipcSource)).toContain(
      'await packagePublicationOwner.current?.adoptPublishedSession(projectId, sessionId)'
    )
    const binding = ipcSource.indexOf(
      'packagePublicationOwner.current = sessionPersistenceCoordinator'
    )
    expect(binding).toBeGreaterThan(ipcSource.indexOf('const sessionPersistenceCoordinator ='))
    expect(binding).toBeLessThan(ipcSource.indexOf('const sessionPackageDesktop ='))
  })

  it('constructs Session package desktop once with shared owners and retains lifecycle bindings', () => {
    const phase = compact(
      between(ipcSource, 'surfaceAdapters = afterAcpAdapters', 'const reviewerModelRuntime =')
    )
    expect(phase).toContain(
      'const sessionPackageDesktop = createSessionPackageDesktop({ sessionPackageService, translate, archiveCoordinator, sessionPersistenceCoordinator, applicationEvents, projectRepository, sessionRepository, isPackageHandoffHeld: () => packageHandoffHeld })'
    )
    expect(occurrences(ipcSource, 'createSessionPackageDesktop(')).toBe(1)
    expect(ipcSource).not.toContain('new SessionPackageDesktop')
    expect(phase).toContain(
      'sessionPackageDesktopLifecycle.isActive = () => sessionPackageDesktop.operations.active'
    )
    expect(phase).toContain(
      'sessionPackageDesktopLifecycle.close = async () => { removePackageQuitGuard() await sessionPackageDesktop.close() }'
    )
    expect(compact(ipcSource)).toContain(
      'await Promise.all([service.close(), sessionPackageDesktopLifecycle.close()])'
    )
    for (const call of [
      'sessionPackageDesktop.respond(',
      'sessionPackageDesktop.export(',
      'sessionPackageDesktop.import(',
      'sessionPackageDesktop.enqueueFile('
    ]) {
      expect(occurrences(ipcSource, call)).toBe(1)
    }
  })

  it('installs Session persistence once with shared owners after Notebook input preview', () => {
    const phase = compact(
      between(ipcSource, 'surfaceAdapters = afterAcpAdapters', 'const conversationExportService')
    )
    expect(phase).toContain(
      'createSessionPersistenceElectronSurface({ runtimeWriter, sessionPersistenceBackend, reviewRepository, sessionPersistenceHandlers, sessionDetailsOwner, delegatedWork, sessionRepository })'
    )
    expect(phase.indexOf("declareElectronAdapter('notebook-input-preview'")).toBeLessThan(
      phase.indexOf('createSessionPersistenceElectronSurface(')
    )
    expect(occurrences(ipcSource, 'createSessionPersistenceElectronSurface(')).toBe(1)
    expect(ipcSource).not.toContain('registerSessionPersistenceIpcHandlers')
    expect(ipcSource).not.toContain('message wake after Session activation failed')
    expect(ipcSource).not.toContain('Session recovery folder could not be opened.')
  })

  it('installs Specialist once with shared owners before Notebook runtime in afterAcp', () => {
    const phase = compact(
      between(
        ipcSource,
        'surfaceAdapters = afterAcpAdapters',
        "declareElectronAdapter('notebook-runtime'"
      )
    )
    expect(phase).toContain(
      'createSpecialistElectronSurface({ specialistService, sessionBindingService, sessionSpecialistReconfiguration, onProfilesChanged: () => void runtime.requestSkillsReload(), specialistPackageService, marketplaceService, specialistApplicationOwner, translate })'
    )
    expect(occurrences(ipcSource, 'createSpecialistElectronSurface(')).toBe(1)
    expect(
      occurrences(ipcSource, 'const specialistApplicationOwner = createSpecialistApplicationOwner(')
    ).toBe(1)
    expect(phase).toContain(
      "specialistService.subscribe(() => applicationEvents.publish('specialist:catalog-changed', undefined) )"
    )
    expect(ipcSource).not.toContain('registerSpecialistIpcHandlers')
    expect(ipcSource).not.toContain('selectSpecialistArchive')
    expect(ipcSource).not.toContain('createContributionTemplateExporter')
  })

  it('installs Office preview once with shared resources between managed preview and environment', () => {
    const phase = compact(
      between(
        ipcSource,
        'surfaceAdapters = afterAcpAdapters',
        "declareElectronAdapter('notebook-environment'"
      )
    )
    expect(phase).toContain(
      "...createOfficePreviewElectronSurfaces({ previewResources, runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html') })"
    )
    expect(phase).toContain("declareElectronAdapter('managed-preview'")
    expect(phase.indexOf("declareElectronAdapter('managed-preview'")).toBeLessThan(
      phase.indexOf('createOfficePreviewElectronSurfaces(')
    )
    expect(occurrences(ipcSource, 'createOfficePreviewElectronSurfaces(')).toBe(1)
    expect(ipcSource).not.toContain('new OfficePreviewSupervisor')
    expect(ipcSource).not.toContain('registerOfficePreviewIpcHandlers')
    expect(ipcSource).not.toContain('registerOfficePreviewRuntimeProtocol')
  })

  it('installs Settings once with shared owners before Notebook in afterAcp', () => {
    const phase = compact(
      between(
        ipcSource,
        'surfaceAdapters = afterAcpAdapters',
        "declareElectronAdapter('background-result-delivery'"
      )
    )
    expect(phase).toContain(
      'createSettingsElectronSurface({ service: settingsService, workflows: settingsWorkflows, snapshotCommits: settingsSnapshotCommits, listAppIconPreviews, translate })'
    )
    expect(phase.indexOf('createSettingsElectronSurface(')).toBeLessThan(
      phase.indexOf("declareElectronAdapter('notebook',")
    )
    expect(occurrences(ipcSource, 'createSettingsElectronSurface(')).toBe(1)
    expect(ipcSource).not.toContain('registerSettingsIpcHandlers')
    expect(ipcSource).not.toContain('showSettingsSaveDialog')
  })

  it('installs desktop utilities with shared owners and retains find-event cleanup', () => {
    const desktop = compact(
      between(ipcSource, 'createDesktopUtilitiesElectronSurface({', '// ACP identity resolution')
    )
    expect(desktop).toContain(
      'resolveManagedFilePath, managedFileVersions: managedFileVersionService, notebookInputs: notebookInputRegistry, translate, logs: logsCommandOwner, github: githubCommandOwner, cli: cliCommandOwner'
    )
    const phase = between(
      ipcSource,
      'surfaceAdapters = beforeAcpAdapters',
      'surfaceAdapters = afterAcpAdapters'
    )
    expect(phase).toContain('createDesktopUtilitiesElectronSurface({')
    expect(occurrences(ipcSource, 'createDesktopUtilitiesElectronSurface(')).toBe(1)
    const surface = compact(readSource('src/main/ipc-surfaces/desktop-utilities.ts'))
    expect(surface).toContain("createElectronSurfaceAdapter('desktop-utilities'")
    expect(surface).toContain('registerLogsIpcHandlers(logs)')
    expect(surface).toContain('registerGithubIpcHandlers({}, github)')
    expect(surface).toContain('registerCliInstallIpcHandlers(cli)')
    expect(surface).toContain('return registerWindowFindIpcHandlers()')
    expect(ipcSource).not.toContain('registerWindowFindIpcHandlers')
    expect(ipcSource).not.toContain('registerFileSaveHandlers')
  })

  it('installs approval handlers with the shared connector brokers in beforeAcp', () => {
    const phase = compact(
      between(
        ipcSource,
        'surfaceAdapters = beforeAcpAdapters',
        'surfaceAdapters = afterAcpAdapters'
      )
    )
    expect(phase).toContain(
      'surfaceAdapters.push( createConnectorApprovalElectronSurface( approvalBroker, credentialRequestBroker, skillImportApprovalBroker ) )'
    )
    expect(occurrences(ipcSource, 'createConnectorApprovalElectronSurface(')).toBe(1)
    expect(compact(ipcSource)).toContain(
      'connectorApprovals: approvalBroker, credentialRequests: credentialRequestBroker, skillImportApprovals: skillImportApprovalBroker } = connectorApplication'
    )
    const surface = compact(readSource('src/main/ipc-surfaces/connector-approvals.ts'))
    expect(surface).toContain("createElectronSurfaceAdapter('connector-approvals'")
    expect(surface).toContain('approvalBroker.respond(request.id, request.decision)')
    expect(surface).toContain('credentialRequestBroker.respond(request.id, request.configured)')
    expect(surface).toContain('skillImportApprovalBroker.respond(response)')
    expect(ipcSource).not.toContain("ipcMainHandle('connectors:approval-respond'")
  })

  it('keeps the upload owner and notification surface in its original installation phase', () => {
    const uploadSurface = compact(readSource('src/main/ipc-surfaces/uploads.ts'))
    expect(uploadSurface).toContain("import { registerUploadIpcHandlers } from '../uploads/ipc'")
    expect(uploadSurface).toContain('registerUploadIpcHandlers(owner, {')
    expect(
      between(
        ipcSource,
        'surfaceAdapters = afterAcpAdapters',
        "declareElectronAdapter('notebook-input-preview'"
      )
    ).toContain('surfaceAdapters.push(createUploadElectronSurface(uploadCommandOwner))')
    expect(occurrences(ipcSource, 'createUploadElectronSurface(uploadCommandOwner)')).toBe(1)
  })

  it('includes active reproducibility kernels in the Session export admission gate', () => {
    expect(compact(ipcSource)).toContain(
      'const notebookLifecycle = withReproducibilityNotebookLifecycle( notebookService, () => artifactReproducibilityAttemptOwnerRef.current )'
    )
    expect(compact(ipcSource)).toContain('notebookActivityRef.current = notebookLifecycle')
    expect(occurrences(ipcSource, 'withReproducibilityNotebookLifecycle(')).toBe(1)
  })

  it('routes literature mutations through the tested catalog and cleanup orchestration', () => {
    expect(compact(ipcSource)).toContain(
      'transact: (command) => transactLiterature(literatureCatalog, contentRepository, command)'
    )
  })

  it('routes background deletion through the tested owner recovery sequence', () => {
    expect(compact(ipcSource)).toContain(
      'recoverDeletionWork({ recoverOrphanJobs: () => jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive), replaySessionProjection: () => sessionRepository.reconcilePendingSessionProjection(), recoverProjects: () => projectDeletionCoordinator.recoverPendingDeletions() })'
    )
  })

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

  it('installs the Artifact surface in its existing phase with the shared owners', () => {
    expect(compact(ipcSource)).toContain(
      'surfaceAdapters.push( createArtifactElectronSurface({ artifactRepository, artifactRunRegistry, artifactProvenanceRepository, artifactHandlers, artifactReproducibilityAttemptOwnerRef, archiveCoordinator, sessionPersistenceCoordinator, notebookService, translate }) )'
    )
    const installation = ipcSource.indexOf('createArtifactElectronSurface({')
    expect(installation).toBeGreaterThan(ipcSource.indexOf('surfaceAdapters = afterAcpAdapters'))
    expect(installation).toBeGreaterThan(ipcSource.indexOf("declareElectronAdapter('storage'"))
    expect(installation).toBeLessThan(
      ipcSource.indexOf('createUploadElectronSurface(uploadCommandOwner)')
    )
    expect(ipcSource).not.toContain('registerArtifactIpcHandlers')
    expect(ipcSource).not.toContain('registerArtifactReproducibilityIpcHandlers')
    expect(ipcSource).not.toContain('createArtifactReproducibilityReceiptExporter')
  })

  it('injects each stateful owner into its Electron adapter and command composition', () => {
    const sharedOwners = [
      [
        'managedPreviewOwners',
        'installManagedPreviewElectronAdapter( previewResources, managedPreviewProtocol, managedPreviewOwners )',
        'managedPreview: managedPreviewOwners'
      ],
      [
        'sessionPersistenceHandlers',
        'reviewRepository, sessionPersistenceHandlers, sessionDetailsOwner, delegatedWork, sessionRepository',
        '...sessionPersistenceHandlers'
      ],
      [
        'artifactHandlers',
        'artifactHandlers, artifactReproducibilityAttemptOwnerRef,',
        'artifacts: artifactHandlers'
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
      ['cliCommandOwner', 'cli: cliCommandOwner', 'cli: cliCommandOwner'],
      ['githubCommandOwner', 'github: githubCommandOwner', 'github: githubCommandOwner'],
      ['logsCommandOwner', 'logs: logsCommandOwner', 'logs: logsCommandOwner'],
      [
        'uploadCommandOwner',
        'surfaceAdapters.push(createUploadElectronSurface(uploadCommandOwner))',
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
    expect(ipcSource).not.toContain("ipcMainHandle('sessions:export-package'")
    expect(ipcSource).not.toContain("ipcMainHandle('sessions:import-package'")
    expect(ipcSource).not.toContain('registerProjectIpcHandlers')
    // Keep checking the shared owner identities at the composition root. The extracted module's
    // actual registration/dispatch is covered by ipc-surfaces/core.test.ts.
    const coreDependencies = compact(
      between(ipcSource, '...createCoreElectronSurfaces({', '// Compute IPC handlers')
    )
    expect(occurrences(ipcSource, 'createCoreElectronSurfaces(')).toBe(1)
    expect(coreDependencies).toContain('permissionGrantProjection,')
    expect(coreDependencies).toContain(
      'projectFiles: [ projectFilesRepository, sessionPersistenceCoordinator, projectDeletionCoordinator, projectFilesHandlers ]'
    )
    expect(coreDependencies).toContain('previewStateRepository')
    expect(dependencyBlock).toContain('permissionGrants: permissionGrantProjection')
    expect(dependencyBlock).toContain('projectFiles: projectFilesHandlers')
    expect(coreSurfaceSource).toContain(
      'registerPermissionGrantIpcAdapter(dependencies.permissionGrantProjection)'
    )
    expect(coreSurfaceSource).toContain(
      'registerProjectFilesIpcHandlers(...dependencies.projectFiles)'
    )
    expect(coreSurfaceSource).toContain(
      'registerPreviewStateIpcHandlers(dependencies.previewStateRepository)'
    )

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
      'shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, { holdSideChatAdmission: true, legacyShellRecoveryToken: options?.legacyShellRecoveryToken })'
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
      between(ipcSource, '    applicationCommands: {', '    applicationEvents,')
    )
    expect(returnedViews).toContain('localWeb: applicationCommandComposition.localWeb')
    expect(returnedViews).toContain('remoteWeb: applicationCommandComposition.remoteWeb')
    expect(returnedViews).toContain('task: applicationCommandComposition.task')
    expect(occurrences(returnedViews, 'applicationCommandComposition.')).toBe(3)
  })

  it('shares one Electron page preview resolver with the production Reviewer owner', () => {
    const options = compact(
      between(ipcSource, 'const reviewerOptions = {', 'const reviewerCommandOwner =')
    )
    expect(options).toContain(
      'pagedContentResolver: createReviewerElectronPagedContentResolver(previewResources)'
    )
    expect(occurrences(ipcSource, 'createReviewerElectronPagedContentResolver(')).toBe(1)
    expect(compact(ipcSource)).toContain('createReviewerCommandOwner(reviewerOptions)')
    expect(compact(ipcSource)).toContain(
      'registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)'
    )
    expect(ipcSource).not.toContain('createReviewerPagedContentResolver(')
    expect(ipcSource).not.toContain("partition: 'reviewer-paged-preview'")
  })

  it('installs every notification inbox request on the Electron adapter', () => {
    expect(
      compact(
        between(
          ipcSource,
          'let surfaceAdapters = beforeComputeAdapters',
          'surfaceAdapters = beforeAcpAdapters'
        )
      )
    ).toContain(
      'surfaceAdapters.push( createNotificationElectronSurface( notificationInbox, taskNotifications, taskNotificationDeliveryDeps ) )'
    )
    expect(occurrences(ipcSource, 'createNotificationElectronSurface(')).toBe(1)
    expect(notificationAdapterBlock).toContain(
      "import { registerNotificationInboxIpcAdapter, type NotificationInboxIpcOwner } from '../notifications/notification-inbox-ipc'"
    )
    expect(notificationAdapterBlock).toContain('registerNotificationInboxIpcAdapter(inbox)')
    expect(notificationAdapterBlock).toContain('taskNotifications.peekPendingOpenSession()')
    expect(notificationAdapterBlock).toContain(
      'taskNotifications.takePendingOpenSession(expectedToken)'
    )
    expect(notificationAdapterBlock).toContain('getTaskNotificationAvailability(delivery)')
    expect(notificationAdapterBlock).toContain('showTestTaskNotification(delivery)')
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
    // Ownership bookkeeping may sit between acquisition and binding; preserve their order.
    expect(startup).toMatch(
      /const remoteAccess = await RemoteAccessService\.create\(\).*?bindRemoteAccess\(remoteAccess\) const webController = createWebServiceController\(\{[^}]*externalAccess: remoteAccess\.webAccess/
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
