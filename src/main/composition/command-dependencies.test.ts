import { beforeEach, describe, expect, it, vi } from 'vitest'
import { composeCommandDependencies } from './command-dependencies'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'

// Only infrastructure constructors are replaced. The composition and Literature command owner
// execute normally; each supplied port below is explicit so missing wiring fails at its boundary.
const infrastructure = vi.hoisted(() => ({
  refresh: vi.fn(),
  replay: vi.fn(),
  recovery: vi.fn(),
  chooseFiles: vi.fn(),
  broadcast: vi.fn(),
  warn: vi.fn(),
  write: vi.fn()
}))
vi.mock('../session-package/use-case-catalog', () => ({
  UseCaseCatalog: class {
    refresh = infrastructure.refresh
  }
}))
vi.mock('../session-replay/repository', () => ({ SessionReplayRepository: class {} }))
vi.mock('../session-replay/session-reading', () => ({ SessionReadingOwner: class {} }))
vi.mock('../session-replay/service', () => ({
  SessionReplayService: class {
    constructor(...args: unknown[]) {
      infrastructure.replay(...args)
    }
  }
}))
vi.mock('../session-persistence/ipc', () => ({
  createSessionRecoveryFolderCommand: () => infrastructure.recovery
}))
vi.mock('../agents/completion-handoff-ipc', () => ({
  createCompletionHandoffCommands: () => ({})
}))
vi.mock('../network-ipc', () => ({ createNetworkCommandOwner: () => ({}) }))
vi.mock('../storage-root', () => ({ resolveConfigRoot: () => '/config-fixture' }))
vi.mock('../projects/prisma-client', () => ({ getProjectDbClient: vi.fn() }))
vi.mock('../desktop-interaction', () => ({
  desktopFileInteraction: () => ({ chooseFiles: infrastructure.chooseFiles })
}))
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: infrastructure.broadcast }))
vi.mock('../storage/migration-state', () => ({ withDataRootWrite: infrastructure.write }))
vi.mock('../settings/ipc', () => ({ SETTINGS_INSTALL_LOG_CHANNEL: 'settings:install-log' }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: infrastructure.warn }),
  diagnosticErrorFields: (error: unknown) => ({ error }),
  errorLogFields: (error: unknown) => ({ error })
}))

beforeEach(() => {
  vi.resetAllMocks()
  infrastructure.refresh.mockResolvedValue(undefined)
  infrastructure.write.mockImplementation((operation: () => unknown) => operation())
})

// Preserve the inferred types of individual spies instead of erasing their call contracts.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const memoryService = {
    snapshot: vi.fn(),
    isEnabled: vi.fn().mockResolvedValue(false),
    setEnabled: vi.fn().mockResolvedValue({ enabled: true }),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    deleteEntry: vi.fn(),
    clearAll: vi.fn()
  }
  const coordinator = {
    deleteRecoveryFile: vi.fn(),
    readSessionRuntimeContext: vi.fn(),
    patchSessionRuntimeContext: vi.fn().mockResolvedValue({}),
    bindTaskSession: vi.fn(),
    admitTaskTurn: vi.fn(),
    stageTaskCompletion: vi.fn(),
    settleTaskCompletion: vi.fn(),
    failTaskRun: vi.fn(),
    updateSessionConfiguration: vi.fn()
  }
  const pdfContext = {
    filterCandidates: vi.fn(),
    linkWithResult: vi.fn(),
    unlink: vi.fn()
  }
  const preview = { get: vi.fn(), save: vi.fn(), delete: vi.fn() }
  const desktop = {
    respond: vi.fn(),
    fork: vi.fn(),
    export: vi.fn(),
    import: vi.fn()
  }
  const diagnostics = { inspect: vi.fn(), export: vi.fn(), cancel: vi.fn() }
  const notificationInbox = {
    getSnapshot: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    markSessionCompletionsRead: vi.fn()
  }
  const input = {
    localeOwner: {},
    sideChatCommands: {},
    applicationEvents: {},
    reportUploadProgress: vi.fn(),
    settingsBootstrap: {
      settingsService: { getComputeBookmarks: vi.fn(), setComputeBookmarks: vi.fn() },
      settingsSnapshotCommits: {}
    },
    storageStartup: { notificationInbox },
    managedFileVersionService: {},
    uploadRepository: {
      resolveManagedUploadPath: vi.fn().mockResolvedValue('/staged/package.science'),
      deleteUpload: vi.fn().mockResolvedValue(undefined)
    },
    runtimeRef: {
      current: {
        enableLiteratureContext: vi.fn().mockResolvedValue(undefined),
        disableLiteratureContext: vi.fn().mockResolvedValue(undefined)
      }
    },
    sessionFoundation: {
      sessionRepository: { loadSessionWithDiagnostics: vi.fn() },
      sessionDiagnosticsDesktop: diagnostics
    },
    sessionPackages: { previewStateRepository: preview },
    managedFiles: { artifactProvenanceRepository: {}, contentRepository: {} },
    sessionAuthority: {
      sessionPersistenceCoordinator: coordinator,
      notebookInputRegistry: { readPreview: vi.fn() }
    },
    researchFilm: {},
    localModels: {},
    documentReading: {
      sessionPdfContextOwner: pdfContext,
      literatureContextLog: { error: vi.fn(), warn: vi.fn() }
    },
    projectLifecycle: {
      archiveCoordinator: {
        withSessionRecoveryDeletion: vi.fn(
          (_project: string, _session: string, operation: () => unknown) => operation()
        )
      },
      projectDeletionCoordinator: {
        waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
      },
      uploadCommandOwner: { stageLocalFile: vi.fn() }
    },
    notebookRuntime: {},
    researchCatalog: {
      literatureOverview: { run: vi.fn() },
      literatureOverviewBatch: { run: vi.fn() },
      literatureCatalog: { get: vi.fn() },
      memoryService,
      tagService: {}
    },
    taskNotifications: { peekPendingOpenSession: vi.fn(), takePendingOpenSession: vi.fn() },
    notificationDelivery: { getAvailability: vi.fn(), sendTest: vi.fn() },
    connectors: {},
    computeServices: { computeIpcModule: { handlers: {} } },
    computeAdmission: {},
    delegation: {
      delegatedWork: {
        root: {
          respondQuestion: vi.fn(),
          wakeMessages: vi.fn().mockResolvedValue(undefined)
        }
      }
    },
    officePreviewCommands: {},
    fileSaveCommands: {},
    cliCommandOwner: {},
    githubCommandOwner: {},
    logsCommandOwner: {},
    agentRuntime: { runtime: { requestSkillsReload: vi.fn().mockResolvedValue(undefined) } },
    agentCompletion: {},
    agentWorkflows: {},
    handoff: {},
    settingsEffects: { settingsWorkflows: {} },
    sessionSurfaces: {
      sessionPersistenceHandlers: { saveSession: vi.fn() },
      sessionDetailsOwner: { edit: vi.fn(), afterSessionSaved: vi.fn() }
    },
    runtimeWorkflows: {},
    notebookEnvironmentLifecycle: {},
    storageHandoff: {},
    artifactSurfaces: { sessionDeletionOwner: { delete: vi.fn() } },
    sessionPackageSurfaces: {
      sessionPackageDesktop: desktop,
      conversationExportService: { exportConversation: vi.fn() }
    },
    reviewerCommandOwner: {},
    listAppIconPreviews: vi.fn()
  }
  // Unrelated services are intentionally absent rather than universal no-op mocks. The cast is
  // restricted to this boundary because production dependencies include concrete private classes.
  const compose = (): ReturnType<
    typeof composeCommandDependencies
  >['applicationCommandDependencies'] =>
    composeCommandDependencies(input as unknown as Parameters<typeof composeCommandDependencies>[0])
      .applicationCommandDependencies
  return { input, compose, memoryService, coordinator, pdfContext, preview, desktop, diagnostics }
}

function invocation(
  surface = 'web',
  args: unknown[] = [{ projectId: 'project' }]
): {
  args: unknown[]
  callerContext: { surface: string; clientId: string; lifecycleClientId: string }
  callerLease: { signal: AbortSignal; isCurrent: ReturnType<typeof vi.fn> }
} {
  return {
    args,
    callerContext: { surface, clientId: 'client', lifecycleClientId: 'lifecycle' },
    callerLease: { signal: new AbortController().signal, isCurrent: vi.fn().mockReturnValue(true) }
  }
}

describe('composeCommandDependencies Literature snapshot boundary', () => {
  it('uses the research catalog snapshot service through the real Literature owner', async () => {
    const f = fixture()
    const request = { itemId: 'paper', expectedSourceKey: 'source-v2', language: 'en' }
    const result = { itemId: 'paper', status: 'ready' }
    f.input.researchCatalog.literatureOverview.run.mockResolvedValue(result)
    const commands = f.compose()
    const controller = new AbortController()
    await expect(commands.literature.studySnapshot(request, controller.signal)).resolves.toBe(
      result
    )
    expect(f.input.researchCatalog.literatureOverview.run).toHaveBeenCalledExactlyOnceWith(
      request,
      controller.signal
    )
    expect(f.input.researchCatalog.literatureCatalog.get).not.toHaveBeenCalled()
    expect(infrastructure.write).not.toHaveBeenCalled()
    expect(infrastructure.broadcast).not.toHaveBeenCalled()
  })

  it('preserves caller cancellation and the service rejection', async () => {
    const f = fixture()
    const controller = new AbortController()
    const reason = new Error('Caller closed snapshot')
    let observedSignal: AbortSignal | undefined
    f.input.researchCatalog.literatureOverview.run.mockImplementation(
      (_request, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const pending = f
      .compose()
      .literature.studySnapshot(
        { itemId: 'paper', expectedSourceKey: 'source', language: 'en' },
        controller.signal
      )
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(observedSignal).toBe(controller.signal)
  })

  it('does not wrap owner errors or require an optional cancellation signal', async () => {
    const f = fixture()
    const error = new Error('Snapshot source changed')
    f.input.researchCatalog.literatureOverview.run.mockRejectedValue(error)
    const request = { itemId: 'paper', expectedSourceKey: 'old-source', language: 'en' }
    await expect(f.compose().literature.studySnapshot(request)).rejects.toBe(error)
    expect(f.input.researchCatalog.literatureOverview.run).toHaveBeenCalledWith(request, undefined)
  })
})

it('keeps catalog warm-up failure optional and uses read-only replay loading', async () => {
  infrastructure.refresh.mockRejectedValue(new Error('Marketplace offline'))
  const f = fixture()
  const expected = { status: 'missing' }
  f.input.sessionFoundation.sessionRepository.loadSessionWithDiagnostics.mockResolvedValue(expected)
  f.compose()
  const [, sessions] = infrastructure.replay.mock.calls[0]
  await expect(sessions.read('project', 'session')).resolves.toBe(expected)
  expect(
    f.input.sessionFoundation.sessionRepository.loadSessionWithDiagnostics
  ).toHaveBeenCalledWith('project', 'session', { mode: 'read-only', preserveRuntimeState: true })
  await Promise.resolve()
  expect(infrastructure.refresh).toHaveBeenCalledOnce()
})

it('reloads agent skills only after a successful memory enablement change', async () => {
  const f = fixture()
  const memory = f.compose().memory
  const request = { enabled: true }
  await expect(memory.setEnabled(request)).resolves.toEqual({ enabled: true })
  expect(f.memoryService.setEnabled).toHaveBeenCalledWith(request)
  expect(f.input.agentRuntime.runtime.requestSkillsReload).toHaveBeenCalledOnce()
  expect(f.memoryService.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(
    f.input.agentRuntime.runtime.requestSkillsReload.mock.invocationCallOrder[0]
  )
  f.memoryService.isEnabled.mockResolvedValue(true)
  await memory.setEnabled(request)
  expect(f.input.agentRuntime.runtime.requestSkillsReload).toHaveBeenCalledOnce()
  const error = new Error('Memory write denied')
  f.memoryService.setEnabled.mockRejectedValue(error)
  await expect(memory.setEnabled({ enabled: false })).rejects.toBe(error)
  expect(f.input.agentRuntime.runtime.requestSkillsReload).toHaveBeenCalledOnce()
})

it('routes each memory operation to the catalog memory service', async () => {
  const f = fixture()
  const memory = f.compose().memory
  for (const name of [
    'createCategory',
    'updateCategory',
    'deleteCategory',
    'createEntry',
    'updateEntry',
    'deleteEntry'
  ] as const) {
    const request = { id: `${name}-id`, name: 'Research notes' }
    const result = { operation: name }
    f.memoryService[name].mockResolvedValue(result)
    await expect(memory[name](request as never)).resolves.toBe(result)
    expect(f.memoryService[name]).toHaveBeenCalledExactlyOnceWith(request)
  }
  for (const name of ['snapshot', 'clearAll'] as const) {
    f.memoryService[name].mockResolvedValue(name)
    await expect(memory[name]()).resolves.toBe(name)
    expect(f.memoryService[name]).toHaveBeenCalledExactlyOnceWith()
  }
})

it('binds notebook preview, interpreter selection, settings events and compute bookmarks', async () => {
  const f = fixture()
  const c = f.compose()
  const request = { projectId: 'project', inputId: 'input' }
  f.input.sessionAuthority.notebookInputRegistry.readPreview.mockResolvedValue('preview')
  await expect(c.notebook.readInputPreview(request as never)).resolves.toBe('preview')
  expect(f.input.sessionAuthority.notebookInputRegistry.readPreview).toHaveBeenCalledWith(request)
  infrastructure.chooseFiles.mockResolvedValue({ filePaths: ['/python', '/ignored'] })
  await expect(c.notebookRuntime.pickInterpreter()).resolves.toBe('/python')
  expect(infrastructure.chooseFiles).toHaveBeenCalledWith({ properties: ['openFile'] })
  infrastructure.chooseFiles.mockResolvedValue({ filePaths: [] })
  await expect(c.notebookRuntime.pickInterpreter()).resolves.toBeNull()
  const event = { status: 'completed' }
  c.settingsCore.emitInstallEvent(event as never)
  expect(infrastructure.broadcast).toHaveBeenCalledWith('settings:install-log', event)
  const settings = f.input.settingsBootstrap.settingsService
  settings.getComputeBookmarks.mockResolvedValue(['/home'])
  await expect(c.compute.bookmarks.get('remote')).resolves.toEqual(['/home'])
  expect(settings.getComputeBookmarks).toHaveBeenCalledWith('remote')
  settings.setComputeBookmarks.mockResolvedValue(['/work'])
  await expect(c.compute.bookmarks.set('remote', ['/work'])).resolves.toEqual(['/work'])
  expect(settings.setComputeBookmarks).toHaveBeenCalledWith('remote', ['/work'])
})

it('binds preview persistence with the caller revision', async () => {
  const f = fixture()
  const preview = f.compose().dataContent.preview
  f.preview.get.mockResolvedValue({ revision: 4 })
  await expect(preview.load({ projectId: 'project' })).resolves.toEqual({ revision: 4 })
  expect(f.preview.get).toHaveBeenCalledWith('project')
  const request = { projectId: 'project', state: { files: [] }, expectedRevision: 4 }
  f.preview.save.mockResolvedValue({ revision: 5 })
  await expect(preview.save(request as never)).resolves.toEqual({ revision: 5 })
  expect(f.preview.save).toHaveBeenCalledWith('project', request.state, 4)
  f.preview.delete.mockResolvedValue(true)
  await expect(preview.delete({ projectId: 'project' })).resolves.toBe(true)
  expect(f.preview.delete).toHaveBeenCalledWith('project')
})

it('forwards delegated answers and fails explicitly when the owner is unavailable', async () => {
  const f = fixture()
  const c = f.compose()
  const respond = c.acp.respondDelegatedQuestion
  if (!respond) throw new Error('Command composition must provide delegated question responses.')
  const request = { questionId: 'question', answer: 'yes' }
  f.input.delegation.delegatedWork.root.respondQuestion.mockResolvedValue('accepted')
  await expect(respond(request as never)).resolves.toBe('accepted')
  expect(f.input.delegation.delegatedWork.root.respondQuestion).toHaveBeenCalledWith(request)
  Object.assign(f.input.delegation.delegatedWork.root, { respondQuestion: undefined })
  expect(() => respond(request as never)).toThrow(
    'Delegated question response owner is unavailable.'
  )
})

it('forwards notification operations to the correct inbox and delivery owners', async () => {
  const f = fixture()
  const n = f.compose().host.notifications
  const cases = [
    [() => n.getDesktopAvailability(), f.input.notificationDelivery.getAvailability, []],
    [() => n.sendTest(), f.input.notificationDelivery.sendTest, []],
    [() => n.getSnapshot(), f.input.storageStartup.notificationInbox.getSnapshot, []],
    [
      () => n.markRead({ ids: ['notice'] }),
      f.input.storageStartup.notificationInbox.markRead,
      [['notice']]
    ],
    [
      () => n.markAllRead({ throughSequence: 12 }),
      f.input.storageStartup.notificationInbox.markAllRead,
      [12]
    ],
    [
      () => n.markSessionCompletionsRead({ sessionIds: ['session'] }),
      f.input.storageStartup.notificationInbox.markSessionCompletionsRead,
      [['session']]
    ],
    [() => n.peekPendingOpenSession(), f.input.taskNotifications.peekPendingOpenSession, []],
    [() => n.takePendingOpenSession(17), f.input.taskNotifications.takePendingOpenSession, [17]]
  ] as const
  for (const [call, owner, args] of cases) {
    const result = { source: owner }
    owner.mockResolvedValue(result)
    await expect(call()).resolves.toBe(result)
    expect(owner).toHaveBeenCalledExactlyOnceWith(...args)
  }
})

it('forwards desktop diagnostics and session package caller identities', async () => {
  const f = fixture()
  const e = f.compose().dataContent.electron
  const call = invocation()
  const cases = [
    [() => e.openRecoveryFolder(call as never), infrastructure.recovery, [call.args[0]]],
    [() => e.inspectSessionDiagnostics(call as never), f.diagnostics.inspect, [call.args[0]]],
    [() => e.exportSessionDiagnostics(call as never), f.diagnostics.export, [call.args[0]]],
    [() => e.cancelSessionDiagnostics(call as never), f.diagnostics.cancel, [call.args[0]]],
    [() => e.sessionPackageOperation(call as never), f.desktop.respond, [call.args[0]]],
    [() => e.forkSession(call as never), f.desktop.fork, [call.args[0], 'lifecycle']],
    [
      () => e.exportConversationFromInvokingWindow(call as never),
      f.input.sessionPackageSurfaces.conversationExportService.exportConversation,
      [call.args[0], 'client']
    ]
  ] as const
  for (const [invoke, owner, args] of cases) {
    owner.mockResolvedValue('result')
    await expect(invoke()).resolves.toBe('result')
    expect(owner).toHaveBeenCalledExactlyOnceWith(...args)
  }
})

it('stages Web exports only when the caller supplied no destination', async () => {
  const f = fixture()
  const e = f.compose().dataContent.electron
  for (const [surface, destination, options] of [
    ['web', undefined, { stageDownload: true }],
    ['web', '/chosen.science', undefined],
    ['cli', '/cli.science', undefined],
    ['electron', undefined, undefined]
  ] as const) {
    f.desktop.export.mockResolvedValue('exported')
    await expect(
      e.exportSessionPackage(invocation(surface, ['session', destination]) as never)
    ).resolves.toBe('exported')
    expect(f.desktop.export).toHaveBeenLastCalledWith('session', 'client', destination, options)
  }
})

it('resolves Web uploads and releases the resolved package under the write gate', async () => {
  const f = fixture()
  const e = f.compose().dataContent.electron
  const options = { strategy: 'copy' }
  f.desktop.import.mockResolvedValue('imported')
  await expect(
    e.importSessionPackage(invocation('web', ['project', '/upload-token', options]) as never)
  ).resolves.toBe('imported')
  expect(f.input.uploadRepository.resolveManagedUploadPath).toHaveBeenCalledWith(
    { path: '/upload-token' },
    { sessionId: PENDING_UPLOAD_SESSION_ID }
  )
  expect(f.desktop.import).toHaveBeenCalledWith(
    'client',
    'lifecycle',
    'project',
    '/staged/package.science',
    false,
    { ...options, onReleased: expect.any(Function) }
  )
  const released = f.desktop.import.mock.calls[0][5].onReleased
  await released()
  expect(infrastructure.write).toHaveBeenCalledOnce()
  expect(f.input.uploadRepository.deleteUpload).toHaveBeenCalledWith({
    path: '/staged/package.science'
  })
  const error = new Error('Upload cleanup failed')
  f.input.uploadRepository.deleteUpload.mockRejectedValue(error)
  await expect(released()).resolves.toBeUndefined()
  expect(infrastructure.warn).toHaveBeenCalledWith('Could not release staged package upload', {
    error
  })
})

it('preserves explicit native package paths without upload resolution or release callbacks', async () => {
  const f = fixture()
  const options = { strategy: 'copy' }
  await f
    .compose()
    .dataContent.electron.importSessionPackage(
      invocation('electron', ['project', '/native.science', options]) as never
    )
  expect(f.input.uploadRepository.resolveManagedUploadPath).not.toHaveBeenCalled()
  expect(f.desktop.import).toHaveBeenCalledWith(
    'client',
    'lifecycle',
    'project',
    '/native.science',
    false,
    options
  )
})

it('reports upload progress only while the invoking caller lease is live and current', () => {
  const f = fixture()
  const c = f.compose()
  const call = invocation()
  c.dataContent.electron.stageLocalFileWithProgress(call as never)
  const progress = { phase: 'copying', transferredBytes: 10 }
  const reporter = f.input.projectLifecycle.uploadCommandOwner.stageLocalFile.mock.calls[0][1]
  reporter.report(progress)
  expect(f.input.reportUploadProgress).toHaveBeenCalledExactlyOnceWith('client', progress)
  call.callerLease.isCurrent.mockReturnValue(false)
  reporter.report(progress)
  call.callerLease.isCurrent.mockReturnValue(true)
  Object.assign(call.callerLease, { signal: AbortSignal.abort() })
  reporter.report(progress)
  expect(f.input.reportUploadProgress).toHaveBeenCalledOnce()
  Object.assign(f.input, { reportUploadProgress: undefined })
  expect(() => f.compose().dataContent.electron.stageLocalFileWithProgress(call as never)).toThrow(
    'Desktop upload progress is unavailable.'
  )
})

it('waits for project operations and archives the exact recovery session identity before deletion', async () => {
  const f = fixture()
  const request = { projectId: 'project', fileName: 'session.json' }
  const gate = Promise.withResolvers<void>()
  f.input.projectLifecycle.projectDeletionCoordinator.waitForProjectOperations.mockReturnValue(
    gate.promise
  )
  const deleting = f.compose().dataContent.sessions.deleteRecoveryFile(request)
  expect(
    f.input.projectLifecycle.archiveCoordinator.withSessionRecoveryDeletion
  ).not.toHaveBeenCalled()
  expect(f.coordinator.deleteRecoveryFile).not.toHaveBeenCalled()
  gate.resolve()
  await deleting
  expect(
    f.input.projectLifecycle.projectDeletionCoordinator.waitForProjectOperations
  ).toHaveBeenCalledWith(['project'])
  expect(
    f.input.projectLifecycle.archiveCoordinator.withSessionRecoveryDeletion
  ).toHaveBeenCalledWith('project', 'session', expect.any(Function))
  expect(f.coordinator.deleteRecoveryFile).toHaveBeenCalledWith(request)
  expect(
    f.input.projectLifecycle.projectDeletionCoordinator.waitForProjectOperations.mock
      .invocationCallOrder[0]
  ).toBeLessThan(f.coordinator.deleteRecoveryFile.mock.invocationCallOrder[0])
})

it('rolls PDF context back to its previous bindings if enabling the runtime fails', async () => {
  const f = fixture()
  const request = { projectId: 'project', sessionId: 'session', itemId: 'paper' }
  const previous = { revision: 2, pdfContext: { bindings: [{ itemId: 'old-paper' }] } }
  const linked = { revision: 3, pdfContext: { bindings: [{ itemId: 'paper' }] } }
  const error = new Error('Runtime capability unavailable')
  f.coordinator.readSessionRuntimeContext.mockResolvedValue(previous)
  f.pdfContext.linkWithResult.mockResolvedValue({ changed: true, context: linked })
  f.input.runtimeRef.current.enableLiteratureContext.mockRejectedValue(error)
  const sessions = f.compose().dataContent.sessions
  await expect(sessions.linkPdfContext(request as never)).rejects.toBe(error)
  expect(f.coordinator.readSessionRuntimeContext).toHaveBeenCalledWith('project', 'session')
  expect(f.pdfContext.linkWithResult).toHaveBeenCalledWith(request)
  expect(f.input.runtimeRef.current.enableLiteratureContext).toHaveBeenCalledWith('session')
  expect(f.coordinator.patchSessionRuntimeContext).toHaveBeenCalledWith({
    projectId: 'project',
    sessionId: 'session',
    expectedRevision: 3,
    patch: { pdfContext: previous.pdfContext }
  })
  const rollback = new Error('Revision conflict')
  f.coordinator.patchSessionRuntimeContext.mockRejectedValue(rollback)
  await expect(sessions.linkPdfContext(request as never)).rejects.toBe(error)
  expect(f.input.documentReading.literatureContextLog.error).toHaveBeenCalledWith(
    'PDF context link rollback failed',
    { sessionId: 'session', error: rollback }
  )
})

it('disables Literature context only after the last PDF binding is unlinked, tolerating runtime errors', async () => {
  const f = fixture()
  const sessions = f.compose().dataContent.sessions
  const request = { projectId: 'project', sessionId: 'session', itemId: 'paper' }
  const retained = { pdfContext: { bindings: [{ itemId: 'other' }] } }
  f.pdfContext.unlink.mockResolvedValue(retained)
  await expect(sessions.unlinkPdfContext(request as never)).resolves.toBe(retained)
  expect(f.input.runtimeRef.current.disableLiteratureContext).not.toHaveBeenCalled()
  const empty = { pdfContext: { bindings: [] } }
  f.pdfContext.unlink.mockResolvedValue(empty)
  const error = new Error('Runtime stopped')
  f.input.runtimeRef.current.disableLiteratureContext.mockRejectedValue(error)
  await expect(sessions.unlinkPdfContext(request as never)).resolves.toBe(empty)
  expect(f.pdfContext.unlink).toHaveBeenLastCalledWith(request)
  expect(f.input.runtimeRef.current.disableLiteratureContext).toHaveBeenCalledWith('session')
  expect(f.input.documentReading.literatureContextLog.warn).toHaveBeenCalledWith(
    'Literature capability disable failed after PDF unlink',
    { sessionId: 'session', error }
  )
})

it('forwards session lifecycle operations to their owning coordinators', async () => {
  const f = fixture()
  const sessions = f.compose().dataContent.sessions
  const request = { projectId: 'project', sessionId: 'session' }
  for (const name of [
    'bindTaskSession',
    'admitTaskTurn',
    'stageTaskCompletion',
    'settleTaskCompletion',
    'failTaskRun'
  ] as const) {
    f.coordinator[name].mockResolvedValue(name)
    await expect(sessions[name](request as never)).resolves.toBe(name)
    expect(f.coordinator[name]).toHaveBeenCalledExactlyOnceWith(request)
  }
  f.coordinator.updateSessionConfiguration.mockResolvedValue('configured')
  await expect(sessions.updateSessionConfiguration(request as never, 7)).resolves.toBe('configured')
  expect(f.coordinator.updateSessionConfiguration).toHaveBeenCalledWith(request, 7)
  f.pdfContext.filterCandidates.mockResolvedValue(['candidate'])
  await expect(sessions.filterPdfContextCandidates(request as never)).resolves.toEqual([
    'candidate'
  ])
  expect(f.pdfContext.filterCandidates).toHaveBeenCalledWith(request)
  f.input.sessionSurfaces.sessionDetailsOwner.edit.mockResolvedValue('edited')
  await expect(sessions.editDetails(request as never)).resolves.toBe('edited')
  expect(f.input.sessionSurfaces.sessionDetailsOwner.edit).toHaveBeenCalledWith(request)
  f.input.artifactSurfaces.sessionDeletionOwner.delete.mockResolvedValue('deleted')
  await expect(sessions.deleteSession(request as never)).resolves.toBe('deleted')
  expect(f.input.artifactSurfaces.sessionDeletionOwner.delete).toHaveBeenCalledWith(request)
})

it('notifies session details with the saved session and wakes delegation after saving', async () => {
  const f = fixture()
  const sessions = f.compose().dataContent.sessions
  const session = { id: 'session', projectId: 'project' }
  const saved = { session: { ...session, title: 'Canonical saved title' }, created: false }
  const options = { expectedRevision: 4 }
  const authority = { source: 'test' }
  const save = f.input.sessionSurfaces.sessionPersistenceHandlers.saveSession
  const gate = Promise.withResolvers<typeof saved>()
  const wake = Promise.withResolvers<void>()
  f.input.delegation.delegatedWork.root.wakeMessages.mockReturnValueOnce(wake.promise)
  save.mockReturnValueOnce(gate.promise).mockResolvedValue(saved)
  const saving = sessions.saveSession(session as never, options as never, authority as never)
  let saveCompleted = false
  void saving.then(
    () => {
      saveCompleted = true
    },
    () => undefined
  )
  try {
    expect(f.input.sessionSurfaces.sessionDetailsOwner.afterSessionSaved).not.toHaveBeenCalled()
    expect(f.input.delegation.delegatedWork.root.wakeMessages).not.toHaveBeenCalled()
    gate.resolve(saved)
    // Drain this turn's promise continuations without releasing wake. Waiting for wake here
    // would deadlock a caller that still holds the data-root write gate until save returns.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.input.delegation.delegatedWork.root.wakeMessages).toHaveBeenCalledWith('session')
    expect(saveCompleted).toBe(true)
    await expect(saving).resolves.toBe(saved)
  } finally {
    gate.resolve(saved)
    wake.resolve()
    await saving
  }
  expect(save).toHaveBeenCalledWith(session, options, authority)
  expect(f.input.sessionSurfaces.sessionDetailsOwner.afterSessionSaved).toHaveBeenCalledWith(
    saved.session
  )
  expect(f.input.delegation.delegatedWork.root.wakeMessages).toHaveBeenCalledWith('session')
  const wakeError = new Error('Delegation unavailable')
  f.input.delegation.delegatedWork.root.wakeMessages.mockRejectedValue(wakeError)
  await expect(sessions.saveSession(session as never, options as never)).resolves.toBe(saved)
  expect(save).toHaveBeenLastCalledWith(session, options)
  expect(infrastructure.warn).toHaveBeenCalledWith('message wake after Session activation failed', {
    error: wakeError
  })
  const saveError = new Error('Session write denied')
  save.mockRejectedValue(saveError)
  await expect(sessions.saveSession(session as never)).rejects.toBe(saveError)
  expect(f.input.sessionSurfaces.sessionDetailsOwner.afterSessionSaved).toHaveBeenCalledTimes(2)
  expect(f.input.delegation.delegatedWork.root.wakeMessages).toHaveBeenCalledTimes(2)
})
