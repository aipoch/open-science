import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

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

// Check execution order at the composition root; inspect domain builders separately.
// Concatenating builder definitions would make file order look like runtime order.
const ipcSource = [
  readSource('src/main/ipc.ts'),
  readSource('src/main/ipc-application-composition.ts')
].join('\n')
const commandRegistrationSource = compact(
  readSource('src/main/composition/application-commands.ts')
)
const literatureOwnerSource = compact(readSource('src/main/literature/command-owner.ts'))
const coreSurfaceSource = compact(readSource('src/main/ipc-surfaces/core.ts'))
const indexSource = readSource('src/main/index.ts')
const nodeEntrySource = readSource('src/main/node-entry.ts')
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
const domain = (name: string): string => readSource(`src/main/composition/${name}.ts`)
const domainCompact = (name: string): string => compact(domain(name))
const dependencyBlock = domainCompact('command-dependencies')
const reviewerCompositionSource = domainCompact('reviewer')
const notificationAdapterBlock = compact(readSource('src/main/ipc-surfaces/notifications.ts'))
const legacyAdapterBlock = domainCompact('desktop-utilities')
const afterAcp = (): string => between(ipcSource, 'surfaceAdapters = afterAcpAdapters', 'return {')
const callBefore = (first: string, second: string): void => {
  const firstIndex = ipcSource.indexOf(first)
  const secondIndex = ipcSource.indexOf(second)
  expect(firstIndex, first).toBeGreaterThan(-1)
  expect(secondIndex, second).toBeGreaterThan(firstIndex)
}

describe('production application command wiring', () => {
  it('constructs each domain once at the root without composing domains inside each other', () => {
    const domains = readdirSync(resolve(projectRoot, 'src/main/composition'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => readSource(`src/main/composition/${name}`))
    const factories = domains.flatMap((source) =>
      [...source.matchAll(/export (?:async )?function (compose\w+)\(/gu)].map((match) => match[1])
    )
    expect(factories.length).toBeGreaterThan(0)
    expect(new Set(factories).size).toBe(factories.length)
    for (const factory of factories) {
      expect(occurrences(ipcSource, `${factory}(`), `${factory} root construction`).toBe(1)
      // The only occurrence in the domain sources is the function declaration itself.
      expect(
        domains.reduce((count, source) => count + occurrences(source, `${factory}(`), 0),
        `${factory} nested construction`
      ).toBe(1)
    }
    for (const source of domains) {
      expect(source).not.toMatch(/from ['"]\.\.\/(?:ipc|ipc-application-composition)['"]/u)
    }
  })

  it('reads current global permissions when creating a fork', () => {
    expect(domainCompact('session-packages')).toContain(
      'getDefaultPermissionProfile: async () => getDefaultPermissionProfile(await settingsRepository.getSettings())'
    )
  })

  it('adopts package publications into the live persistence owner before exposing desktop commands', () => {
    expect(domainCompact('session-packages')).toContain(
      'await packagePublicationOwner.current?.adoptPublishedSession(publication)'
    )
    const authority = domain('session-authority')
    expect(
      authority.indexOf('packagePublicationOwner.current = sessionPersistenceCoordinator')
    ).toBeGreaterThan(authority.indexOf('const sessionPersistenceCoordinator ='))
    callBefore('await composeSessionAuthority({', 'composeSessionPackageSurfaces({')
  })

  it('constructs Session package desktop once with shared owners and retains lifecycle bindings', () => {
    const source = domainCompact('session-packages')
    expect(source).toContain(
      'const sessionPackageDesktop = createSessionPackageDesktop({ sessionPackageService, translate, archiveCoordinator, sessionPersistenceCoordinator, applicationEvents, projectRepository, sessionRepository, isPackageHandoffHeld: () => packageHandoffHeld.current, cancelBrowserTransfer: (id) => browserPackageImport.cancel(id), onSensitiveContentFailure: rememberSensitiveContentFailure })'
    )
    expect(occurrences(source, 'createSessionPackageDesktop(')).toBe(1)
    expect(source).toContain(
      'sessionPackageDesktopLifecycle.isActive = () => browserPackageImport.active || sessionPackageDesktop.operations.active'
    )
    expect(source).toContain(
      'sessionPackageDesktopLifecycle.close = async () => { browserPackageImport.stop() await sessionPackageDesktop.close() await browserPackageImport.close() }'
    )
    expect(source).toContain(
      'await Promise.all([service.close(), sessionPackageDesktopLifecycle.close()])'
    )
    for (const call of [
      'sessionPackageDesktop.respond(',
      'sessionPackageDesktop.export(',
      'sessionPackageDesktop.import('
    ]) {
      expect(occurrences(dependencyBlock, call)).toBe(1)
    }
    expect(ipcSource).toContain('sessionPackageSurfaces.sessionPackageDesktop.enqueueFile(path)')
    expect(afterAcp()).toContain('composeSessionPackageSurfaces({')
  })

  it('installs Session persistence once with shared owners after Notebook input preview', () => {
    const source = domainCompact('artifact-surfaces')
    expect(source).toContain(
      'createSessionPersistenceElectronSurface({ runtimeWriter, sessionPersistenceBackend, reviewRepository, sessionPersistenceHandlers, sessionDetailsOwner, delegatedWork, sessionRepository })'
    )
    const preview = source.indexOf("declareElectronAdapter('notebook-input-preview'")
    expect(preview).toBeGreaterThan(-1)
    expect(source.indexOf('createSessionPersistenceElectronSurface(')).toBeGreaterThan(preview)
    expect(occurrences(source, 'createSessionPersistenceElectronSurface(')).toBe(1)
    expect(source).not.toContain('registerSessionPersistenceIpcHandlers')
    callBefore('composeArtifactSurfaces({', 'composeSessionPackageSurfaces({')
  })

  it('installs Specialist once with shared owners before Notebook runtime in afterAcp', () => {
    const source = domainCompact('session-surfaces')
    expect(source).toContain(
      'createSpecialistElectronSurface({ specialistService, sessionBindingService, sessionSpecialistReconfiguration, onProfilesChanged: () => void runtime.requestSkillsReload(), specialistPackageService, marketplaceService, specialistApplicationOwner, translate })'
    )
    expect(occurrences(source, 'createSpecialistElectronSurface(')).toBe(1)
    expect(
      occurrences(source, 'const specialistApplicationOwner = createSpecialistApplicationOwner(')
    ).toBe(1)
    expect(source).toContain(
      "specialistService.subscribe(() => applicationEvents.publish('specialist:catalog-changed', undefined) )"
    )
    expect(source).not.toContain('registerSpecialistIpcHandlers')
    expect(afterAcp()).toContain('composeSessionSurfaces({')
    callBefore('composeSessionSurfaces({', 'composeNotebookSurfaces({')
  })

  it('installs Office preview once with shared resources between managed preview and environment', () => {
    const source = domainCompact('notebook-surfaces')
    expect(source).toContain(
      "...createOfficePreviewElectronSurfaces({ commands: officePreviewCommands, previewResources: managedFiles.previewResources, runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html') })"
    )
    const preview = source.indexOf("declareElectronAdapter('managed-preview'")
    const office = source.indexOf('...createOfficePreviewElectronSurfaces(')
    const environment = source.indexOf('await registerNotebookEnvironmentComposition(')
    expect(preview).toBeGreaterThan(-1)
    expect(office).toBeGreaterThan(preview)
    expect(environment).toBeGreaterThan(office)
    expect(occurrences(source, 'createOfficePreviewElectronSurfaces(')).toBe(1)
    expect(afterAcp()).toContain('composeNotebookSurfaces({')
  })

  it('installs Settings once with shared owners before Notebook in afterAcp', () => {
    const source = domainCompact('settings-effects')
    expect(source).toContain(
      'createSettingsElectronSurface({ fileCommands: settingsFileCommands, service: settingsService, workflows: settingsWorkflows, snapshotCommits: settingsSnapshotCommits, listAppIconPreviews, translate })'
    )
    const settings = source.indexOf('createSettingsElectronSurface(')
    expect(settings).toBeGreaterThan(-1)
    expect(source.indexOf("declareElectronAdapter('notebook',")).toBeGreaterThan(settings)
    expect(occurrences(source, 'createSettingsElectronSurface(')).toBe(1)
    expect(afterAcp()).toContain('composeSettingsEffects({')
  })

  it('installs desktop utilities with shared owners and retains find-event cleanup', () => {
    const desktop = domainCompact('desktop-utilities')
    expect(desktop).toContain(
      'resolveManagedFilePath: managedFiles.resolveManagedFilePath, managedFileVersions: managedFileVersionService, notebookInputs: sessionAuthority.notebookInputRegistry, translate, logs: logsCommandOwner, github: githubCommandOwner, cli: cliCommandOwner'
    )
    expect(
      between(
        ipcSource,
        'surfaceAdapters = beforeAcpAdapters',
        'surfaceAdapters = afterAcpAdapters'
      )
    ).toContain('composeDesktopUtilities({')
    expect(occurrences(desktop, 'createDesktopUtilitiesElectronSurface(')).toBe(1)
    const surface = compact(readSource('src/main/ipc-surfaces/desktop-utilities.ts'))
    for (const call of [
      "createElectronSurfaceAdapter('desktop-utilities'",
      'registerLogsIpcHandlers(logs)',
      'registerGithubIpcHandlers({}, github)',
      'registerCliInstallIpcHandlers(cli)',
      'return registerWindowFindIpcHandlers()'
    ])
      expect(surface).toContain(call)
    expect(desktop).not.toContain('registerWindowFindIpcHandlers')
    expect(desktop).not.toContain('registerFileSaveHandlers')
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
      'surfaceAdapters.push( createConnectorApprovalElectronSurface( connectors.approvalBroker, connectors.credentialRequestBroker, connectors.skillImportApprovalBroker ) )'
    )
    expect(occurrences(ipcSource, 'createConnectorApprovalElectronSurface(')).toBe(1)
    expect(domainCompact('connectors')).toContain(
      'connectorApprovals: approvalBroker, credentialRequests: credentialRequestBroker } = connectorApplication'
    )
    const surface = compact(readSource('src/main/ipc-surfaces/connector-approvals.ts'))
    expect(surface).toContain("createElectronSurfaceAdapter('connector-approvals'")
    expect(surface).toContain('approvalBroker.respond(request.id, request.decision)')
    expect(surface).toContain('credentialRequestBroker.respond(request.id, request.configured)')
    expect(surface).toContain('skillImportApprovalBroker.respond(response)')
    expect(ipcSource).not.toContain("ipcMainHandle('connectors:approval-respond'")
  })

  it('keeps the upload owner and notification surface in its original installation phase', () => {
    const surface = compact(readSource('src/main/ipc-surfaces/uploads.ts'))
    expect(surface).toContain("import { registerUploadIpcHandlers } from '../uploads/ipc'")
    expect(surface).toContain('registerUploadIpcHandlers(owner, {')
    const source = domain('artifact-surfaces')
    expect(
      occurrences(source, 'surfaceAdapters.push(createUploadElectronSurface(uploadCommandOwner))')
    ).toBe(1)
    expect(source.indexOf('createUploadElectronSurface(uploadCommandOwner)')).toBeLessThan(
      source.indexOf("declareElectronAdapter('notebook-input-preview'")
    )
    expect(afterAcp()).toContain('composeArtifactSurfaces({')
  })

  it('includes active reproducibility kernels in the Session export admission gate', () => {
    expect(compact(domain('notebook-runtime'))).toContain(
      'const notebookLifecycle = withReproducibilityNotebookLifecycle( notebookService, () => artifactReproducibilityAttemptOwnerRef.current )'
    )
    expect(compact(domain('notebook-runtime'))).toContain(
      'notebookActivityRef.current = notebookLifecycle'
    )
    expect(occurrences(domain('notebook-runtime'), 'withReproducibilityNotebookLifecycle(')).toBe(1)
  })

  it('routes literature mutations through the tested catalog and cleanup orchestration', () => {
    expect(compact(domain('command-dependencies'))).toContain(
      'literature: createLiteratureCommandOwner({'
    )
    expect(literatureOwnerSource).toContain(
      'transact: (command) => transactLiterature(literatureCatalog, contentRepository, command)'
    )
  })

  it('wakes durable delegated messages after command saves without holding the write gate', () => {
    const source = compact(domain('command-dependencies'))
    expect(source).toContain(
      'sessionSurfaces.sessionDetailsOwner.afterSessionSaved(result.session)'
    )
    expect(source).toContain(
      'void delegation.delegatedWork.root.wakeMessages?.(result.session.id).catch('
    )
    expect(source.indexOf('wakeMessages?.(result.session.id)')).toBeGreaterThan(
      source.indexOf('sessionSurfaces.sessionDetailsOwner.afterSessionSaved(result.session)')
    )
  })

  it('routes background deletion through the tested owner recovery sequence', () => {
    expect(compact(domain('project-lifecycle'))).toContain(
      'recoverDeletionWork({ recoverOrphanJobs: () => jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive), replaySessionProjection: () => sessionRepository.reconcilePendingSessionProjection(), recoverProjects: () => projectDeletionCoordinator.recoverPendingDeletions() })'
    )
  })

  it('restores durable deletion barriers before managed file version recovery', () => {
    const deletionBarrierRestore = domain('compute').indexOf(
      'projectDeletionCoordinator.restorePendingDeletionBarriers()'
    )
    const managedFileRecovery = domain('compute').indexOf(
      'managedFileVersionService.recoverPendingWrites()'
    )
    expect(deletionBarrierRestore).toBeGreaterThan(-1)
    expect(managedFileRecovery).toBeGreaterThan(deletionBarrierRestore)
    expect(domain('compute')).toMatch(
      /runDataRootStartupRecovery\(\s*\(\)\s*=>\s*projectDeletionCoordinator\.restorePendingDeletionBarriers\(\)\s*\)/
    )
    expect(domain('compute')).toMatch(
      /withDataRootWrite\(\(\)\s*=>\s*managedFileVersionService\.recoverPendingWrites\(\)\)/
    )
  })

  it('defers legacy data-path normalization behind data-root startup recovery', () => {
    const source = domain('session-packages')
    const normalization = compact(
      between(
        source,
        'if (!storedSettings.pathsNormalizedAt)',
        'normalizationOperation?.fail(error)'
      )
    )
    expect(normalization).toContain('await runDataRootStartupRecovery(')
    expect(normalization).toContain('await normalizeLegacyDataPaths({')
  })

  it('does not block application startup on managed file content integrity scanning', () => {
    expect(domain('compute')).toMatch(
      /managedFileVersionService\s*\.auditActiveVersionIntegrity\(\)/
    )
    expect(domain('compute')).not.toMatch(
      /await\s+managedFileVersionService\s*\.auditActiveVersionIntegrity\(\)/
    )
  })

  it('installs the Artifact surface in its existing phase with the shared owners', () => {
    const source = domainCompact('artifact-surfaces')
    expect(source).toContain(
      'surfaceAdapters.push( createArtifactElectronSurface({ reproducibilityCommands, artifactRepository, artifactRunRegistry, artifactProvenanceRepository, artifactHandlers, artifactReproducibilityAttemptOwnerRef, archiveCoordinator, sessionPersistenceCoordinator, notebookService, translate }) )'
    )
    expect(source.indexOf('createArtifactElectronSurface(')).toBeLessThan(
      source.indexOf('createUploadElectronSurface(uploadCommandOwner)')
    )
    expect(afterAcp()).toContain('composeArtifactSurfaces({')
    callBefore('composeStorageHandoff({', 'composeArtifactSurfaces({')
    expect(source).not.toContain('registerArtifactIpcHandlers')
    expect(source).not.toContain('registerArtifactReproducibilityIpcHandlers')
  })

  it('injects each stateful owner into its Electron adapter and command composition', () => {
    const bindings = [
      [
        'notebook-surfaces',
        'managedFiles.managedPreviewOwners',
        'managedPreview: managedFiles.managedPreviewOwners'
      ],
      [
        'artifact-surfaces',
        'reviewRepository, sessionPersistenceHandlers, sessionDetailsOwner, delegatedWork, sessionRepository',
        '...sessionSurfaces.sessionPersistenceHandlers'
      ],
      [
        'artifact-surfaces',
        'artifactHandlers, artifactReproducibilityAttemptOwnerRef,',
        'artifacts: artifactSurfaces.artifactHandlers'
      ],
      ['handoff', 'storageCommandOwner )', 'storage: storageHandoff.storageCommandOwner'],
      [
        'reviewer',
        'registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)',
        'reviewer: reviewerCommandOwner'
      ],
      [
        'handoff',
        'registerUpdateIpcHandlers(updateStrategy, updateCommandOwner)',
        'update: handoff.updateCommandOwner'
      ],
      ['desktop-utilities', 'cli: cliCommandOwner', 'cli: cliCommandOwner'],
      ['desktop-utilities', 'github: githubCommandOwner', 'github: githubCommandOwner'],
      ['desktop-utilities', 'logs: logsCommandOwner', 'logs: logsCommandOwner'],
      [
        'artifact-surfaces',
        'createUploadElectronSurface(uploadCommandOwner)',
        'uploads: projectLifecycle.uploadCommandOwner'
      ],
      [
        'session-packages',
        'registerConversationExportIpcHandler(conversationExportService)',
        'sessionPackageSurfaces.conversationExportService.exportConversation('
      ]
    ] as const
    for (const [owner, adapter, command] of bindings) {
      expect(domainCompact(owner), owner).toContain(adapter)
      expect(dependencyBlock, owner).toContain(command)
    }
    expect(dependencyBlock).toContain('projects: projectLifecycle.projectHandlers')
    expect(dependencyBlock).toContain('tags: researchCatalog.tagService')
    expect(domainCompact('research-catalog')).toContain(
      'const tagService = new TagService( new TagRepository'
    )
    expect(dependencyBlock).toContain(
      'deleteSession: (request) => artifactSurfaces.sessionDeletionOwner.delete(request)'
    )
    expect(commandRegistrationSource).toContain(
      "declareElectronAdapter('application-projects', () => registerApplicationCommandElectronAdapter(applicationCommandComposition.electron) )"
    )
    for (const forbidden of [
      'registerSessionDeletionIpcHandler',
      "declareElectronAdapter('session-deletion'",
      "ipcMainHandle('sessions:edit-details'",
      "ipcMainHandle('sessions:export-package'",
      "ipcMainHandle('sessions:import-package'",
      'registerProjectIpcHandlers'
    ])
      expect(dependencyBlock).not.toContain(forbidden)
    expect(occurrences(ipcSource, 'createCoreElectronSurfaces(')).toBe(1)
    expect(compact(ipcSource)).toContain(
      'permissionGrantProjection: settingsEffects.permissionGrantProjection'
    )
    expect(compact(ipcSource)).toContain(
      'projectFiles: [ sessionAuthority.projectFilesRepository, sessionAuthority.sessionPersistenceCoordinator, projectLifecycle.projectDeletionCoordinator, projectLifecycle.projectFilesHandlers ]'
    )
    expect(compact(ipcSource)).toContain(
      'previewStateRepository: sessionPackages.previewStateRepository'
    )
    expect(dependencyBlock).toContain('permissionGrants: settingsEffects.permissionGrantProjection')
    expect(dependencyBlock).toContain('projectFiles: projectLifecycle.projectFilesHandlers')
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
      'compute: { handlers: computeServices.computeIpcModule.handlers, enabledHosts: computeAdmission.sessionEnabledComputeHostsOwner }'
    )
    expect(dependencyBlock).toContain('compute: computeServices.computeIpcModule.handlers')
    expect(dependencyBlock).toContain(
      'enabledHosts: computeAdmission.sessionEnabledComputeHostsOwner'
    )
    expect(domain('desktop-utilities')).toContain('await cliCommandOwner.ensureCurrent()')
    expect(domain('desktop-utilities')).toContain(
      'const githubCommandOwner = createGithubCommandOwner({ fetch: netFetchStandard })'
    )
  })

  it('holds side chat admission through the in-place update handoff', () => {
    const updateGate = compact(
      between(domain('handoff'), 'const durableBackendHandoffGate', 'const detectResearchBlockers')
    )
    const updateStrategy = compact(
      between(domain('handoff'), 'const updateStrategy', 'const updateCommandOwner')
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
    expect(returnedViews).toContain('desktop: applicationCommandComposition.desktop')
    expect(occurrences(returnedViews, 'applicationCommandComposition.')).toBe(4)
  })

  it('shares one Electron page preview resolver with the production Reviewer owner', () => {
    expect(compact(ipcSource)).toContain(
      'const reviewerCommandOwner = await registerReviewerComposition(modules, {'
    )
    expect(compact(ipcSource)).toContain(
      'previewResources: managedFiles.previewResources, runtimeShutdownOwner: handoff.reviewerModelRuntimeShutdown, declareElectronAdapter'
    )
    expect(reviewerCompositionSource).toContain(
      'pagedContentResolver: createReviewerHostPagedContentResolver(previewResources)'
    )
    expect(occurrences(reviewerCompositionSource, 'createReviewerHostPagedContentResolver(')).toBe(
      1
    )
    expect(reviewerCompositionSource).toContain('createReviewerCommandOwner(reviewerOptions)')
    expect(reviewerCompositionSource).toContain(
      'registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)'
    )
    expect(ipcSource).not.toContain('createReviewerCommandOwner(')
    expect(ipcSource).not.toContain("partition: 'reviewer-paged-preview'")
  })

  it('installs every notification inbox request on the Electron adapter', () => {
    callBefore('composeNotifications({', 'composeComputeServices({')
    expect(domainCompact('notifications')).toContain(
      'surfaceAdapters.push( createNotificationElectronSurface( storageStartup.notificationInbox, taskNotifications, taskNotificationDeliveryDeps, delivery ) )'
    )
    expect(occurrences(domain('notifications'), 'createNotificationElectronSurface(')).toBe(1)
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

  it('adds transport adapters after composition and disposes the router before backend teardown', () => {
    const backendModule = ipcSource.indexOf('await composeBackendLifecycle({')
    const commandModule = ipcSource.indexOf('await registerApplicationCommandComposition({')
    expect(backendModule).toBeGreaterThan(-1)
    expect(commandModule).toBeGreaterThan(backendModule)
    expect(commandRegistrationSource).toContain("name: 'application-command-composition'")
    expect(commandRegistrationSource).toContain('dispose: () => capability.dispose()')

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

  it('cancels journal writes before draining commands and Compute during reverse disposal', () => {
    const journalModule = ipcSource.indexOf('await modules.add(researchCatalog.journalAttributes')
    const commandModule = ipcSource.indexOf('await registerApplicationCommandComposition({')
    const computeModule = ipcSource.indexOf('await composeComputeRecovery({')
    expect(computeModule).toBeGreaterThan(-1)
    expect(commandModule).toBeGreaterThan(computeModule)
    expect(journalModule).toBeGreaterThan(commandModule)
    expect(occurrences(ipcSource, "name: 'literature-journal-attributes'")).toBe(1)
  })

  it('exposes startup network commands before attaching the desktop transport', () => {
    const preWindowStartup = compact(
      between(
        nodeEntrySource,
        'const earlyChannels =',
        'desktop = await startDesktopRuntimeTransport('
      )
    )
    expect(preWindowStartup).toContain("'network:get-info'")
    expect(preWindowStartup).toContain("'network:check-connectivity'")
    expect(preWindowStartup).toContain('requireDesktopCaller(invocation.callerContext)')
    expect(preWindowStartup).toContain('return networkCommands.getInfo()')
    expect(preWindowStartup).toContain('return networkCommands.checkConnectivity()')
    expect(legacyAdapterBlock).not.toContain('registerNetworkIpcHandlers()')
    expect(occurrences(nodeEntrySource, 'createNetworkCommandOwner()')).toBe(1)
    const desktopStartup = between(
      indexSource,
      'await app.whenReady()',
      'const lifecycle = installAppLifecycle('
    )
    expect(desktopStartup).toContain('installElectronNetwork()')
    expect(desktopStartup).toContain('installDesktopRuntimeElectronAdapter(')
  })

  it('late-binds the unique Remote Access owner and passes only narrow views to Web and Task', () => {
    const startup = compact(
      between(
        nodeEntrySource,
        'remoteAccess = await RemoteAccessService.create()',
        'void remoteAccess.restore()'
      )
    )
    expect(occurrences(nodeEntrySource, 'RemoteAccessService.create()')).toBe(1)
    expect(indexSource).not.toContain('RemoteAccessService.create()')
    // Ownership bookkeeping may sit between acquisition and binding; preserve their order.
    expect(startup).toMatch(
      /remoteAccess = await RemoteAccessService\.create\(\).*?runtime\.bindRemoteAccess\(remoteAccess\) web = createWebServiceController\(\{[^}]*externalAccess: remoteAccess\.webAccess/
    )
    expect(startup).toContain('remoteAccess.attachWebController(web)')
    expect(startup).toContain('...runtime,')

    expect(occurrences(ipcSource, 'applicationCommands')).toBe(2)
    expect(nodeEntrySource).toContain('runtime.applicationCommands.desktop')
    expect(compact(ipcSource)).toContain('taskControls: {')
    expect(compact(ipcSource)).toContain(
      "computePreferences: Pick<SessionEnabledComputeHostsOwner, 'withReservation' | 'set'>"
    )
    expect(compact(ipcSource)).toContain(
      'computePreferences: computeAdmission.sessionEnabledComputeHostsOwner'
    )
    expect(domainCompact('agent-runtime')).toContain(
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

const rootFixture = vi.hoisted(() => ({ owners: {} as Record<string, unknown> }))
vi.mock('./composition/agent-activation', () => ({
  composeAgentActivation: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/agent-completion', () => ({
  composeAgentCompletion: vi.fn(() => rootFixture.owners),
  composeAgentWorkflows: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/agent-controls', () => ({
  composeAgentControls: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/agent-runtime', () => ({
  composeAgentRuntime: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/application-commands', () => ({
  registerApplicationCommandComposition: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/artifact-surfaces', () => ({
  composeArtifactSurfaces: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/backend-lifecycle', () => ({
  composeBackendLifecycle: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/background-results', () => ({
  composeBackgroundResults: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/command-dependencies', () => ({
  composeCommandDependencies: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/compute', () => ({
  composeComputeAdmission: vi.fn(() => rootFixture.owners),
  composeComputeServices: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/compute-recovery', () => ({
  composeComputeRecovery: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/connectors', () => ({
  composeConnectorRecovery: vi.fn(() => rootFixture.owners),
  composeConnectors: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/delegation', () => ({ composeDelegation: vi.fn(() => rootFixture.owners) }))
vi.mock('./composition/desktop-utilities', () => ({
  composeDesktopUtilities: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/document-reading', () => ({
  composeDocumentReading: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/handoff', () => ({
  composeHandoff: vi.fn(() => rootFixture.owners),
  composeStorageHandoff: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/managed-files', () => ({
  composeManagedFiles: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/notebook-bridge', () => ({
  composeNotebookBridge: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/notebook-runtime', () => ({
  composeNotebookRuntime: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/notebook-surfaces', () => ({
  composeNotebookSurfaces: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/notifications', () => ({
  composeNotifications: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/project-lifecycle', () => ({
  composeProjectLifecycle: vi.fn(() => rootFixture.owners),
  composeProjectRecovery: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/research-catalog', () => ({
  composeResearchCatalog: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/reviewer', () => ({
  registerReviewerComposition: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/session-authority', () => ({
  composeSessionAuthority: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/session-foundation', () => ({
  composeSessionFoundation: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/session-packages', () => ({
  composeSessionPackageSurfaces: vi.fn(() => rootFixture.owners),
  composeSessionPackages: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/session-projection', () => ({
  composeSessionProjection: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/session-surfaces', () => ({
  composeSessionSurfaces: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/settings-bootstrap', () => ({
  composeSettingsBootstrap: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/settings-effects', () => ({
  composeSettingsEffects: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/side-chat', () => ({ composeSideChat: vi.fn(() => rootFixture.owners) }))
vi.mock('./composition/specialists', () => ({
  composeSessionSpecialists: vi.fn(() => rootFixture.owners),
  composeSpecialistCatalog: vi.fn(() => rootFixture.owners),
  composeSpecialistPackages: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/storage-startup', () => ({
  composeStorageStartup: vi.fn(() => rootFixture.owners)
}))
vi.mock('./composition/upload-storage', () => ({
  composeUploadStorage: vi.fn(() => rootFixture.owners)
}))
vi.mock('./managed-preview-handler', () => ({ createManagedPreviewProtocolHandler: vi.fn() }))
vi.mock('./desktop-surface-declarations', () => ({
  createElectronSurfaceAdapter: (name: string, install: () => void) => ({ name, install }),
  createConnectorApprovalElectronSurface: vi.fn(() => ({ name: 'connector-approval' })),
  createCoreElectronSurfaces: vi.fn(() => [])
}))
vi.mock('./runtime-metadata', () => ({ runtimeMetadata: () => ({ version: 'test' }) }))

import { createApplicationModules } from './ipc-application-composition'
import { composeProjectLifecycle } from './composition/project-lifecycle'
import { composeSettingsBootstrap } from './composition/settings-bootstrap'
import { composeBackgroundResults } from './composition/background-results'
import { composeManagedFiles } from './composition/managed-files'
import { composeSessionAuthority } from './composition/session-authority'
import { composeSessionPackages } from './composition/session-packages'
import { composeAgentControls } from './composition/agent-controls'
import { composeConnectors } from './composition/connectors'
import { createConnectorApprovalElectronSurface } from './desktop-surface-declarations'
import { CredentialRequestBroker } from './connectors/credential-request-broker'

// Keep domain factories isolated while exercising their real construction order and late bindings.
it('connects committed deletion to the same credential broker used by approval surfaces', async () => {
  const broadcast = vi.fn()
  const broker = new CredentialRequestBroker({ generateId: () => 'credential', broadcast })
  const journalDispose = vi.fn()
  const runtime = { prepareForQuit: vi.fn(async () => 'completed'), abortQuitPreparation: vi.fn() }
  const shutdown = vi.fn(async () => 'completed')
  const resumeAfterHandoff = vi.fn()
  const setClosePreference = vi.fn(async () => undefined)
  const currentSnapshotAfter = vi.fn(async (value) => value)
  const resolveSpecialist = vi.fn()
  const owners = {
    credentialRequestBroker: broker,
    approvalBroker: {},
    skillImportApprovalBroker: {},
    reviewerCommandOwnerRef: { current: undefined },
    journalAttributes: { dispose: journalDispose },
    computeIpcModule: { handlers: {} },
    runtime,
    sideChatRuntime: { resumeAfterHandoff },
    shutdownCoordinator: { runForQuitPreparation: shutdown },
    reviewerModelRuntimeShutdown: { current: { hasActiveWork: vi.fn(() => true) } },
    settingsService: {
      setClosePreference,
      getActiveInstallId: vi.fn(() => 'install'),
      holdInstallAdmission: vi.fn()
    },
    settingsSnapshotCommits: { currentSnapshotAfter },
    specialistService: { resolveRunnableByReference: resolveSpecialist },
    browserPackageImport: { active: false },
    sessionPackageDesktop: {
      reportOpenOverflow: vi.fn(),
      enqueueFile: vi.fn(),
      hasActiveTransfer: vi.fn(() => true)
    },
    sessionPersistenceCoordinator: { sessionProjectId: vi.fn(async () => 'project') },
    sessionRepository: { loadSession: vi.fn(async () => ({ memoryEnabled: false })) },
    archiveCoordinator: { withSessionAvailableById: vi.fn(async (_id, operation) => operation()) },
    notebookService: {},
    specialistDomain: {},
    notebookCommands: {},
    jobRepository: {},
    hostRepository: {},
    notebookInputRegistry: {},
    delegatedWorkRef: {},
    literatureCatalog: { getMany: vi.fn() },
    detectSessionExportBlockingSessions: vi.fn(),
    localWeb: {},
    remoteWeb: {},
    task: {},
    desktop: {}
  }
  rootFixture.owners = owners
  const moduleRecords: { name: string; dispose?: () => unknown }[] = []
  const events = { publish: vi.fn() }
  const add = vi.fn(async (input, create) => {
    if (typeof input === 'function') return events
    const module = await create(input)
    moduleRecords.push(module)
    return module.capability
  })
  const localeOwner = { t: vi.fn((key: string) => key) }
  const phase = vi.fn()
  const result = await createApplicationModules(
    { mainEntryPath: '/unused/main.js', localeOwner } as unknown as Parameters<
      typeof createApplicationModules
    >[0],
    { add } as unknown as Parameters<typeof createApplicationModules>[1],
    { phase } as unknown as Parameters<typeof createApplicationModules>[2]
  )
  const lifecycle = vi.mocked(composeProjectLifecycle).mock.calls.at(-1)![0]
  const info = {
    credentialId: 'openalex' as const,
    connector: 'literature',
    method: 'search',
    sessionId: 'session'
  }
  const pending = broker.request(info)
  broker.respond('credential', false)
  expect(await pending).toBe(false)
  expect(await broker.request(info)).toBe(false)
  expect(broadcast).toHaveBeenCalledTimes(1)
  lifecycle.clearSessionCredentials('session')
  const renewed = broker.request(info)
  expect(broadcast).toHaveBeenCalledTimes(2)
  broker.respond('credential', true)
  expect(await renewed).toBe(true)
  expect(createConnectorApprovalElectronSurface).toHaveBeenLastCalledWith(
    owners.approvalBroker,
    broker,
    owners.skillImportApprovalBroker
  )
  expect(vi.mocked(composeProjectLifecycle).mock.invocationCallOrder.at(-1)).toBeLessThan(
    vi.mocked(composeConnectors).mock.invocationCallOrder.at(-1)!
  )
  expect(lifecycle.getNotebookService()).toBe(owners.notebookService)

  const settings = vi.mocked(composeSettingsBootstrap).mock.calls.at(-1)![0]
  expect(settings.getSpecialistDomain()).toBe(owners.specialistDomain)
  expect(settings.getSpecialistService()).toBe(owners.specialistService)
  expect(settings.getRuntimeRef()).toBe(lifecycle.runtimeRef)
  const background = vi.mocked(composeBackgroundResults).mock.calls.at(-1)![0]
  expect(background.getSessionRepository()).toBe(owners.sessionRepository)
  expect(background.getSessionPersistenceCoordinator()).toBe(owners.sessionPersistenceCoordinator)
  expect(background.getNotebookCommands()).toBe(owners.notebookCommands)
  expect(background.getJobRepository()).toBe(owners.jobRepository)
  expect(background.getHostRepository()).toBe(owners.hostRepository)
  const managed = vi.mocked(composeManagedFiles).mock.calls.at(-1)![0]
  expect(managed.getNotebookInputRegistry()).toBe(owners.notebookInputRegistry)
  managed.readLiteratureItems(['paper'])
  expect(owners.literatureCatalog.getMany).toHaveBeenCalledWith(['paper'])
  expect(vi.mocked(composeSessionAuthority).mock.calls.at(-1)![0].getDelegatedWorkRef()).toBe(
    owners.delegatedWorkRef
  )
  expect(
    vi.mocked(composeSessionPackages).mock.calls.at(-1)![0].getDetectSessionExportBlockingSessions()
  ).toBe(owners.detectSessionExportBlockingSessions)
  expect(vi.mocked(composeAgentControls).mock.calls.at(-1)![0].getRuntime()).toBe(runtime)
  expect(phase).toHaveBeenCalledWith('commands')
  expect(result.applicationCommands.localWeb).toBe(owners.localWeb)
  expect(result.applicationCommands.remoteWeb).toBe(owners.remoteWeb)
  expect(result.applicationCommands.task).toBe(owners.task)
  expect(result.applicationCommands.desktop).toBe(owners.desktop)
  expect(result.sessionDeletionCapability).toBe(owners.sessionPersistenceCoordinator)
  expect(result.archiveCapability).toBe(owners.archiveCoordinator)

  await result.commitClosePreference('quit')
  expect(setClosePreference).toHaveBeenCalledWith('quit')
  expect(currentSnapshotAfter).toHaveBeenCalledOnce()
  result.openSessionPackageFile(null)
  result.openSessionPackageFile('/session.osci')
  expect(owners.sessionPackageDesktop.reportOpenOverflow).toHaveBeenCalledOnce()
  expect(owners.sessionPackageDesktop.enqueueFile).toHaveBeenCalledWith('/session.osci')
  expect(result.hasActivePackageTransfer()).toBe(true)
  owners.sessionPackageDesktop.hasActiveTransfer.mockReturnValue(false)
  owners.browserPackageImport.active = true
  expect(result.hasActivePackageTransfer()).toBe(true)
  owners.browserPackageImport.active = false
  expect(result.hasActivePackageTransfer()).toBe(false)
  expect(result.hasActiveReviewerWork()).toBe(true)
  expect(result.getActiveSettingsInstallId()).toBe('install')
  result.holdSettingsInstallAdmission()
  expect(owners.settingsService.holdInstallAdmission).toHaveBeenCalledOnce()
  await result.taskControls.specialists.resolve('specialist')
  expect(resolveSpecialist).toHaveBeenCalledWith('specialist')
  expect(await result.prepareForQuit()).toBe('completed')
  expect(shutdown).toHaveBeenCalledOnce()
  runtime.prepareForQuit.mockResolvedValueOnce('timeout')
  expect(await result.prepareForQuit()).toBe('timeout')
  expect(shutdown).toHaveBeenCalledOnce()
  runtime.abortQuitPreparation.mockImplementationOnce(() => {
    throw new Error('abort failed')
  })
  expect(() => result.abortQuitPreparation()).toThrow('abort failed')
  expect(resumeAfterHandoff).toHaveBeenCalledOnce()

  const { trackLifecycleSettlement, waitForLifecycleSettlement } =
    await import('./lifecycle-settlement')
  let finishCleanup!: () => void
  trackLifecycleSettlement(
    new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
  )
  result.abortQuitPreparation()
  expect(runtime.abortQuitPreparation).toHaveBeenCalledTimes(2)
  expect(resumeAfterHandoff).toHaveBeenCalledOnce()
  finishCleanup()
  await waitForLifecycleSettlement()
  await Promise.resolve()
  expect(resumeAfterHandoff).toHaveBeenCalledTimes(2)

  let finishOldCleanup!: () => void
  trackLifecycleSettlement(
    new Promise<void>((resolve) => {
      finishOldCleanup = resolve
    })
  )
  result.abortQuitPreparation()
  // A later preparation owns the admission hold, even if an earlier abort is still queued.
  await result.prepareForQuit()
  finishOldCleanup()
  await waitForLifecycleSettlement()
  await Promise.resolve()
  expect(resumeAfterHandoff).toHaveBeenCalledTimes(2)
  result.abortQuitPreparation()
  expect(resumeAfterHandoff).toHaveBeenCalledTimes(3)

  // A teardown that never settles is abandoned, so Side Chat still resumes.
  trackLifecycleSettlement(new Promise<void>(() => {}), { abandonAfterMs: 50 })
  result.abortQuitPreparation()
  expect(resumeAfterHandoff).toHaveBeenCalledTimes(3)
  await vi.waitFor(() => expect(resumeAfterHandoff).toHaveBeenCalledTimes(4), { timeout: 2000 })
  const operation = vi.fn(async () => 'available')
  expect(
    await result.electronAdapters.acp.sessionAdmission.withSessionAvailableById(
      'session',
      operation
    )
  ).toBe('available')
  expect(owners.archiveCoordinator.withSessionAvailableById).toHaveBeenCalledWith(
    'session',
    operation
  )
  expect(await result.electronAdapters.acp.resolveMemoryEnabled!({ sessionId: 'session' })).toBe(
    false
  )
  expect(owners.sessionRepository.loadSession).toHaveBeenCalledWith('project', 'session')
  await moduleRecords.find((module) => module.name === 'literature-journal-attributes')!.dispose!()
  expect(journalDispose).toHaveBeenCalledOnce()
})
