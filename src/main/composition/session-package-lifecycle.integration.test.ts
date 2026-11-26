import * as packageState from '../storage/session-package-state'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { healthyNotebookMemoryPolicy } from '../notebook/memory-policy.test-support'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { createWindowsStandardProcessSandbox } from '../notebook/fixtures/windows-standard-process-sandbox'
import { terminateProcessTree } from '../process-tree'
import { inspectOwnedWindowsProcessIds } from '../process-tree-windows'
import { ProjectRepository } from '../projects/repository'
import * as projectDatabase from '../projects/prisma-client'
import { readPackageArchive } from '../session-package/archive'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionRepository } from '../session-persistence/repository'
import * as storageRoots from '../storage-root'
import { composeSessionPackages, composeSessionPackageSurfaces } from './session-packages'

const desktopHost = vi.hoisted(() => ({
  installPackageQuitGuard: vi.fn(),
  chooseSavePath: vi.fn()
}))
vi.mock('../desktop-interaction', () => ({
  desktopInteraction: () => desktopHost,
  desktopFileInteraction: () => desktopHost
}))
vi.mock('../session-package/inspection-worker-entry?nodeWorker', () => ({ default: vi.fn() }))
vi.mock('../session-package/inspection-worker', async () => {
  const { inspectSessionPackage } = await import('../session-package/inspection')
  return { createPackageInspector: () => inspectSessionPackage }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
const resetOwnership = configureTestRuntimeMetadata()

type LifecycleFixture = {
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  scope: { projectId: string; sessionId: string; workspaceCwd: string }
  persistence: SessionPersistenceCoordinator
  archive: ArchiveCoordinator
  runtimeActivity: {
    isSessionBusy: Mock<() => boolean>
    isProjectBusy: () => boolean
    liveSessionProjectId: () => undefined
  }
  notebook: NotebookRuntimeService
  entered: PromiseWithResolvers<void>
  cleanup: PromiseWithResolvers<void>
  reaping: { confirmed: boolean }
  composed: Awaited<ReturnType<typeof composeSessionPackages>>
  surfaces: () => ReturnType<typeof composeSessionPackageSurfaces>
  getExportOwners: Parameters<typeof composeSessionPackages>[0]['getSessionExportOwners']
  readImageTasks: Mock<Parameters<typeof composeSessionPackages>[0]['readImageTasks']>
  dispose: () => Promise<void>
}

async function createLifecycleFixture(realWindowsOwner = false): Promise<LifecycleFixture> {
  vi.clearAllMocks()
  const fixture = await createProvenanceTestFixture()
  const root = fixture.storageRoot
  storageRoots.initDataRoot(root)
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  await fixture.client.project.create({ data: { id: scope.projectId, name: 'Research' } })
  const getClient = async (): Promise<typeof fixture.client> => fixture.client
  const sessions = new SessionRepository(root, {}, new SessionProjectionRepository(getClient))
  await sessions.saveSession({
    id: scope.sessionId,
    projectId: scope.projectId,
    title: 'Retained research',
    cwd: root,
    status: 'idle',
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'Study the evidence',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 2
  })
  const persistence = new SessionPersistenceCoordinator(sessions, {
    syncSession: async () => [],
    softDeleteSession: async () => 'deletion',
    restoreSession: async () => undefined,
    softDeleteProject: async () => 'deletion',
    reconcileProjectSessions: async () => undefined,
    reconcileActiveSessions: async () => undefined,
    markReconciliationIncomplete: () => undefined
  })
  await persistence.loadAll()
  const projects = new ProjectRepository(getClient, root)
  const runtimeActivity = {
    isSessionBusy: vi.fn(() => false),
    isProjectBusy: () => false,
    liveSessionProjectId: () => undefined
  }
  const archive = new ArchiveCoordinator(projects, persistence, runtimeActivity)
  const entered = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const reaping = { confirmed: true }
  const windowsSandbox = realWindowsOwner ? await createWindowsStandardProcessSandbox() : undefined
  if (windowsSandbox) {
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    const wrap = windowsSandbox.port.wrap
    windowsSandbox.port.wrap = async (invocation) => {
      const wrapped = await wrap(invocation)
      return {
        ...wrapped,
        cleanup: async (reason, outcome) => {
          const result = await wrapped.cleanup(reason, outcome)
          entered.resolve()
          await cleanup.promise
          // Real Job proof is unchanged; only dependency completion is controlled.
          return reaping.confirmed ? result : { ...result, networkClosed: false }
        }
      }
    }
  }
  const notebook = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: scope.projectId,
    memoryPolicy: healthyNotebookMemoryPolicy(),
    admitSessionWork: (projectId, sessionId, observation) =>
      archive.admitSessionWork(projectId, sessionId, observation ? 'observation' : 'work'),
    isSessionExporting: (projectId, sessionId) => archive.isSessionExporting(projectId, sessionId),
    processSandbox: windowsSandbox?.port,
    executorFactory: realWindowsOwner
      ? undefined
      : () =>
          new NotebookKernelExecutor({
            replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
            terminateTree: async (child) => {
              const result = await terminateProcessTree(child)
              entered.resolve()
              await cleanup.promise
              return { ...result, reaped: result.reaped && reaping.confirmed }
            }
          })
  })
  vi.spyOn(storageRoots, 'resolveConfigRoot').mockReturnValue(root)
  vi.spyOn(storageRoots, 'resolveDataRoot').mockReturnValue(root)
  vi.spyOn(projectDatabase, 'getProjectDbClient').mockResolvedValue(fixture.client)
  const getExportOwners = vi.fn(() => ({
    archiveCoordinator: archive,
    sessionPersistenceCoordinator: persistence,
    notebookService: notebook
  }))
  const readImageTasks = vi
    .fn<Parameters<typeof composeSessionPackages>[0]['readImageTasks']>()
    .mockResolvedValue([])
  const composed = await composeSessionPackages({
    settingsRepository: { getSettings: async () => ({}) },
    storedSettings: { pathsNormalizedAt: 1 },
    getDetectSessionExportBlockingSessions: () => () => [],
    getSessionExportOwners: getExportOwners,
    readImageTasks,
    modules: { add: (_: undefined, create: () => { capability: unknown }) => create().capability }
  } as unknown as Parameters<typeof composeSessionPackages>[0])
  composed.packagePublicationOwner.current = persistence
  const surfaces = (): ReturnType<typeof composeSessionPackageSurfaces> =>
    composeSessionPackageSurfaces({
      ...composed,
      declareElectronAdapter: () => undefined,
      applicationEvents: { publish: () => undefined },
      sessionRepository: sessions,
      rememberSensitiveContentFailure: () => undefined,
      sessionPersistenceCoordinator: persistence,
      archiveCoordinator: archive,
      runtime: { getActivePromptSessions: () => [] },
      translate: englishNativeTranslator
    } as unknown as Parameters<typeof composeSessionPackageSurfaces>[0])
  return {
    fixture,
    scope,
    persistence,
    archive,
    runtimeActivity,
    notebook,
    entered,
    cleanup,
    reaping,
    composed,
    surfaces,
    getExportOwners,
    readImageTasks,
    dispose: async () => {
      cleanup.resolve()
      await composed.sessionPackageDesktopLifecycle.close()
      await composed.sessionPackageService.close()
      await notebook.dispose()
      if (windowsSandbox) {
        expect(inspectOwnedWindowsProcessIds()).toEqual([])
        await windowsSandbox.dispose()
        await resetOwnership()
      }
      await fixture.dispose()
    }
  }
}

it.skipIf(process.platform !== 'win32').each(['complete', 'incomplete', 'cancelled'] as const)(
  'Windows owner export coordinates Archive, original cleanup and persistence after %s',
  async (ending) => {
    const f = await createLifecycleFixture(true)
    const { projectId, sessionId } = f.scope
    const destination = join(f.fixture.storageRoot, 'windows.science')
    const controller = new AbortController()
    const reservePersistence = vi.spyOn(f.persistence, 'reserveSessionExport')
    let pending: Promise<unknown> | undefined
    try {
      await expect(
        f.notebook.executeControl({
          ...f.scope,
          code: 'globalThis.kept = 41; console.log(process.pid)'
        })
      ).resolves.toMatchObject({ status: 'completed' })
      const before = await f.notebook.state(f.scope)
      const persistedBefore = JSON.parse(await readFile(before.runJsonPath, 'utf8'))
      const receiptDirectory = join(f.fixture.storageRoot, 'runtime', 'kernel-processes')
      const receipts: Array<{ windowsJobName: string }> = await Promise.all(
        (await readdir(receiptDirectory)).map(async (name) =>
          JSON.parse(await readFile(join(receiptDirectory, name), 'utf8'))
        )
      )
      expect(receipts).toHaveLength(1)
      expect(receipts[0].windowsJobName).toMatch(/^Local\\OpenScience\.Notebook\./)
      const group = (await f.notebook.getProjectResources(f.scope)).groups[0]
      const operation = await f.notebook.releaseSessionResources(
        { ...f.scope, revision: group.revision },
        () => undefined
      )
      const releaseRequest = { ...f.scope, operationId: operation.operationId }
      await f.entered.promise
      expect(inspectOwnedWindowsProcessIds()).toEqual([])
      pending = f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination, {
        signal: controller.signal
      })
      void pending.catch(() => undefined)
      await vi.waitFor(() => expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(true))
      expect(() => f.archive.admitSessionWork(projectId, sessionId)).toThrow(/export/i)
      expect(reservePersistence).not.toHaveBeenCalled()
      await expect(
        f.persistence.runSessionMutation(projectId, sessionId, async () => 'cleanup may persist')
      ).resolves.toBe('cleanup may persist')
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      if (ending === 'cancelled') {
        const reason = new Error('Windows export observer cancelled')
        controller.abort(reason)
        await expect(pending).rejects.toBe(reason)
        expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
        expect(f.notebook.getResourceRelease(releaseRequest).status).toBe('releasing')
      }
      f.reaping.confirmed = ending !== 'incomplete'
      f.cleanup.resolve()
      if (ending === 'incomplete') {
        await expect(f.notebook.waitForSessionTeardown(f.scope)).rejects.toThrow(
          /cleanup.*incomplete/i
        )
        await expect(pending).rejects.toThrow(/cleanup.*incomplete/i)
        expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
        expect(reservePersistence).not.toHaveBeenCalled()
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(
          f.persistence.runSessionMutation(projectId, sessionId, async () => 'not frozen')
        ).resolves.toBe('not frozen')
        f.reaping.confirmed = true
        await f.notebook.retryResourceRelease(releaseRequest, () => undefined)
      }
      await f.notebook.waitForSessionTeardown(f.scope)
      expect(f.notebook.getResourceRelease(releaseRequest)).toMatchObject({
        operationId: operation.operationId,
        status: 'released',
        resources: [expect.objectContaining({ id: group.resources[0].id, projection: 'complete' })]
      })
      if (ending !== 'complete') {
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        pending = f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination)
      }
      await expect(pending).resolves.toMatchObject({ title: 'Retained research' })
      expect(reservePersistence).toHaveBeenCalledOnce()
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
      const expanded = join(f.fixture.storageRoot, 'expanded-windows')
      await mkdir(expanded)
      await readPackageArchive(destination, expanded, new AbortController().signal)
      const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
      expect(manifest.schemaVersion).toBe(1)
      expect(
        manifest.inventory.some((entry: { storageKey?: string }) =>
          entry.storageKey?.includes('runtime/kernel-processes')
        )
      ).toBe(false)
      const run = manifest.inventory.find((entry: { storageKey?: string }) =>
        entry.storageKey?.endsWith('/run.json')
      )
      const document = JSON.parse(await readFile(join(expanded, run.path), 'utf8'))
      expect(document.version).toBe(1)
      expect(document.runs).toEqual(persistedBefore.runs)
      expect(document.kernel.terminatedKernelInstances).toContainEqual({ kind: 'repl' })
      const encodedJobName = JSON.stringify(receipts[0].windowsJobName).slice(1, -1)
      const assertNoLocalJob = (candidate: unknown): void => {
        expect(JSON.stringify(candidate)).not.toContain(encodedJobName)
      }
      const contaminated = {
        ...document,
        kernel: { ...document.kernel, windowsJobName: receipts[0].windowsJobName }
      }
      expect(() => assertNoLocalJob(contaminated)).toThrow()
      assertNoLocalJob(document)
      await expect(
        f.persistence.runSessionMutation(projectId, sessionId, async () => 'released')
      ).resolves.toBe('released')
      console.info('Windows original cleanup/export tracer', {
        ending,
        node: process.version,
        platform: process.platform,
        job: receipts[0].windowsJobName,
        operation: operation.operationId,
        runVersion: document.version,
        packageSchema: manifest.schemaVersion,
        retainedRuns: document.runs.length
      })
    } finally {
      f.reaping.confirmed = true
      f.cleanup.resolve()
      await pending?.catch(() => undefined)
      await f.dispose()
    }
  },
  30_000
)

it.skipIf(process.platform === 'win32')(
  'fences direct export before Notebook cleanup, freezes persistence afterwards, and exports its final projection',
  async () => {
    const f = await createLifecycleFixture()
    const { projectId, sessionId } = f.scope
    let pending: Promise<unknown> | undefined
    try {
      expect(f.getExportOwners).not.toHaveBeenCalled()
      await f.notebook.executeControl({ ...f.scope, code: 'globalThis.kept = 41' })
      const group = (await f.notebook.getProjectResources(f.scope)).groups[0]
      await f.notebook.releaseSessionResources(
        { ...f.scope, revision: group.revision },
        () => undefined
      )
      await f.entered.promise
      const destination = join(f.fixture.storageRoot, 'research.science')
      pending = f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination)
      let failure: unknown
      void pending.catch((error) => {
        failure = error
      })
      await vi.waitFor(() => {
        if (failure) throw failure
        expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(true)
      })
      expect(f.readImageTasks).not.toHaveBeenCalled()
      expect(() => f.archive.admitSessionWork(projectId, sessionId)).toThrow(/export/i)
      await expect(
        f.persistence.runSessionMutation(
          projectId,
          sessionId,
          async () => 'cleanup can still write'
        )
      ).resolves.toBe('cleanup can still write')
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      f.cleanup.resolve()
      await expect(pending).resolves.toMatchObject({ title: 'Retained research' })
      expect(f.readImageTasks).toHaveBeenCalledExactlyOnceWith({ projectId, sessionId })
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
      const expanded = join(f.fixture.storageRoot, 'expanded')
      await mkdir(expanded)
      await readPackageArchive(destination, expanded, new AbortController().signal)
      const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
      const run = manifest.inventory.find((entry: { storageKey?: string }) =>
        entry.storageKey?.endsWith('/run.json')
      )
      const document = JSON.parse(await readFile(join(expanded, run.path), 'utf8'))
      expect(document.runs[0]).toMatchObject({ status: 'completed' })
      expect(document.kernel).toMatchObject({
        lastKnownStatus: 'terminated',
        terminatedKernelInstances: [{ kind: 'repl' }]
      })
      await expect(
        f.persistence.runSessionMutation(projectId, sessionId, async () => 'released')
      ).resolves.toBe('released')
    } finally {
      f.cleanup.resolve()
      await pending?.catch(() => undefined)
      await f.dispose()
    }
  }
)

it.each(['export', 'fork'] as const)(
  'uses one source reservation for Desktop %s through the composed package service',
  async (kind) => {
    const f = await createLifecycleFixture()
    const request = { projectId: f.scope.projectId, sessionId: f.scope.sessionId }
    const { sessionPackageDesktop } = f.surfaces()
    const reserveSource = vi.spyOn(f.archive, 'reserveSessionExport')
    const reservePersistence = vi.spyOn(f.persistence, 'reserveSessionExport')
    f.readImageTasks.mockImplementationOnce(async ({ projectId, sessionId }) => {
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(true)
      await f.persistence.runSessionMutation(projectId, sessionId, async () => undefined)
      return []
    })
    try {
      if (kind === 'export') {
        const destination = join(f.fixture.storageRoot, 'desktop.science')
        const imported = Promise.withResolvers<boolean>()
        vi.spyOn(packageState, 'isImportedResearchSession').mockReturnValueOnce(imported.promise)
        const reading = f.notebook.backgroundTasks(f.scope)
        f.runtimeActivity.isSessionBusy.mockImplementationOnce(() => {
          // Resume the panel's read only after export has fenced new work.
          expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(true)
          imported.resolve(false)
          return false
        })
        await expect(sessionPackageDesktop.export(request, 'cli', destination)).resolves.toEqual({
          saved: true,
          filePath: destination
        })
        await expect(reading).resolves.toEqual({ runs: [] })
        await expect(f.composed.sessionPackageService.inspect(destination)).resolves.toMatchObject({
          title: 'Retained research',
          messageCount: 1
        })
      } else {
        const child = await sessionPackageDesktop.fork(request)
        expect(child?.sessionId).not.toBe(request.sessionId)
        expect(await f.persistence.sessionProjectId(child!.sessionId)).toBe(request.projectId)
      }
      expect(reserveSource).toHaveBeenCalledOnce()
      expect(reservePersistence).toHaveBeenCalledExactlyOnceWith(
        request.projectId,
        request.sessionId
      )
      expect(f.readImageTasks).toHaveBeenCalledExactlyOnceWith(request)
      expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(false)
      await expect(
        f.persistence.runSessionMutation(
          request.projectId,
          request.sessionId,
          async () => 'released'
        )
      ).resolves.toBe('released')
    } finally {
      await f.dispose()
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'makes conversation export wait for the same original Notebook cleanup before reading or rendering',
  async () => {
    const f = await createLifecycleFixture()
    const { projectId, sessionId } = f.scope
    const destination = join(f.fixture.storageRoot, 'conversation.md')
    desktopHost.chooseSavePath.mockResolvedValue({ canceled: false, filePath: destination })
    const { conversationExportService } = f.surfaces()
    let pending: Promise<unknown> | undefined
    try {
      await f.notebook.executeControl({ ...f.scope, code: 'globalThis.kept = 41' })
      const group = (await f.notebook.getProjectResources(f.scope)).groups[0]
      await f.notebook.releaseSessionResources(
        { ...f.scope, revision: group.revision },
        () => undefined
      )
      await f.entered.promise
      pending = conversationExportService.exportConversation({
        projectId,
        sessionId,
        format: 'markdown'
      })
      void pending.catch(() => undefined)
      await vi.waitFor(() => {
        expect(f.getExportOwners).toHaveBeenCalledOnce()
        expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(true)
      })
      expect(desktopHost.chooseSavePath).not.toHaveBeenCalled()
      await expect(
        f.persistence.runSessionMutation(
          projectId,
          sessionId,
          async () => 'cleanup can still write'
        )
      ).resolves.toBe('cleanup can still write')
      f.cleanup.resolve()
      await expect(pending).resolves.toEqual({ saved: true, filePath: destination })
      expect(await readFile(destination, 'utf8')).toContain('Study the evidence')
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
    } finally {
      f.cleanup.resolve()
      await pending?.catch(() => undefined)
      await f.dispose()
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'cancels an export wait without cancelling the committed Notebook cleanup or publishing late bytes',
  async () => {
    const f = await createLifecycleFixture()
    const { projectId, sessionId } = f.scope
    const destination = join(f.fixture.storageRoot, 'cancelled.science')
    const controller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      await f.notebook.executeControl({ ...f.scope, code: 'globalThis.kept = 41' })
      const group = (await f.notebook.getProjectResources(f.scope)).groups[0]
      const operation = await f.notebook.releaseSessionResources(
        { ...f.scope, revision: group.revision },
        () => undefined
      )
      await f.entered.promise
      pending = f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination, {
        signal: controller.signal
      })
      let failure: unknown
      void pending.catch((error) => {
        failure = error
      })
      await vi.waitFor(() => expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(true))
      const reason = new Error('Export cancelled by the user')
      controller.abort(reason)
      await vi.waitFor(() => expect(failure).toBe(reason))
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
      const releaseRequest = { ...f.scope, operationId: operation.operationId }
      expect(f.notebook.getResourceRelease(releaseRequest).status).toBe('releasing')
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      f.cleanup.resolve()
      await f.notebook.waitForSessionTeardown(f.scope)
      expect(f.notebook.getResourceRelease(releaseRequest).status).toBe('released')
      await expect(
        f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination)
      ).resolves.toMatchObject({ title: 'Retained research' })
    } finally {
      f.cleanup.resolve()
      await pending?.catch(() => undefined)
      await f.dispose()
    }
  }
)

it('releases a late persistence reservation after cancellation and never publishes the cancelled snapshot', async () => {
  const f = await createLifecycleFixture()
  const { projectId, sessionId } = f.scope
  const acquired = Promise.withResolvers<void>()
  const deliver = Promise.withResolvers<void>()
  const reserve = f.persistence.reserveSessionExport.bind(f.persistence)
  vi.spyOn(f.persistence, 'reserveSessionExport').mockImplementation(async (...args) => {
    const release = await reserve(...args)
    acquired.resolve()
    await deliver.promise
    return release
  })
  const controller = new AbortController()
  const destination = join(f.fixture.storageRoot, 'late.science')
  const pending = f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination, {
    signal: controller.signal
  })
  void pending.catch(() => undefined)
  try {
    await acquired.promise
    const reason = new Error('Export cancelled during persistence admission')
    controller.abort(reason)
    await expect(
      f.persistence.runSessionMutation(projectId, sessionId, async () => 'too early')
    ).rejects.toThrow(/export/i)
    deliver.resolve()
    await expect(pending).rejects.toBe(reason)
    expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
    await expect(
      f.persistence.runSessionMutation(projectId, sessionId, async () => 'released')
    ).resolves.toBe('released')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    deliver.resolve()
    await pending.catch(() => undefined)
    await f.dispose()
  }
})

it.skipIf(process.platform === 'win32')(
  'rejects export after incomplete original cleanup and permits it only after retrying that cleanup',
  async () => {
    const f = await createLifecycleFixture()
    const { projectId, sessionId } = f.scope
    const destination = join(f.fixture.storageRoot, 'retry.science')
    try {
      f.reaping.confirmed = false
      await f.notebook.executeControl({ ...f.scope, code: 'globalThis.kept = 41' })
      const group = (await f.notebook.getProjectResources(f.scope)).groups[0]
      const operation = await f.notebook.releaseSessionResources(
        { ...f.scope, revision: group.revision },
        () => undefined
      )
      f.cleanup.resolve()
      await expect(f.notebook.waitForSessionTeardown(f.scope)).rejects.toThrow(
        /cleanup.*incomplete/i
      )
      await expect(
        f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination)
      ).rejects.toThrow(/cleanup.*incomplete/i)
      expect(f.archive.isSessionExporting(projectId, sessionId)).toBe(false)
      await expect(
        f.persistence.runSessionMutation(projectId, sessionId, async () => 'not frozen')
      ).resolves.toBe('not frozen')
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      f.reaping.confirmed = true
      await f.notebook.retryResourceRelease(
        { ...f.scope, operationId: operation.operationId },
        () => undefined
      )
      await f.notebook.waitForSessionTeardown(f.scope)
      await expect(
        f.composed.sessionPackageService.exportTo({ projectId, sessionId }, destination)
      ).resolves.toMatchObject({ title: 'Retained research' })
    } finally {
      f.reaping.confirmed = true
      await f.dispose()
    }
  }
)

it.each(
  (['export', 'fork'] as const).flatMap((kind) =>
    (['images', 'persistence', 'idle', 'archive-after-callback'] as const).map((failure) => ({
      kind,
      failure
    }))
  )
)('releases $kind admission without publication when $failure fails', async ({ kind, failure }) => {
  const f = await createLifecycleFixture()
  const request = { projectId: f.scope.projectId, sessionId: f.scope.sessionId }
  const destination = join(f.fixture.storageRoot, 'failed.science')
  try {
    if (failure === 'images') {
      f.readImageTasks.mockRejectedValueOnce(new Error('Image task recovery failed'))
    } else if (failure === 'persistence') {
      vi.spyOn(f.persistence, 'reserveSessionExport').mockRejectedValueOnce(
        new Error('Retained terminal write failed')
      )
    } else if (failure === 'idle') {
      const sessions = new SessionRepository(f.fixture.storageRoot)
      const source = (await sessions.loadSession(request.projectId, request.sessionId))!
      await sessions.saveSession({ ...source, status: 'running' })
    } else {
      f.runtimeActivity.isSessionBusy.mockReturnValueOnce(false).mockReturnValueOnce(true)
    }
    await expect(
      kind === 'export'
        ? f.composed.sessionPackageService.exportTo(request, destination)
        : f.composed.sessionPackageService.fork(request)
    ).rejects.toThrow()
    expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(false)
    await expect(
      f.persistence.runSessionMutation(request.projectId, request.sessionId, async () => 'released')
    ).resolves.toBe('released')
    expect((await f.persistence.sessionMetadataSnapshot()).sessions.map(({ id }) => id)).toEqual([
      request.sessionId
    ])
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.dispose()
  }
})

it('closes Desktop during file selection and releases the composed source and persistence reservations', async () => {
  const f = await createLifecycleFixture()
  const request = { projectId: f.scope.projectId, sessionId: f.scope.sessionId }
  const { sessionPackageDesktop } = f.surfaces()
  const pending = sessionPackageDesktop.export(request)
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(() =>
      expect(sessionPackageDesktop.operations.snapshot?.state).toBe('awaiting-selection')
    )
    expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(true)
    await expect(
      f.persistence.runSessionMutation(
        request.projectId,
        request.sessionId,
        async () => 'too early'
      )
    ).rejects.toThrow(/export/i)
    await sessionPackageDesktop.close()
    await expect(pending).rejects.toThrow()
    expect(sessionPackageDesktop.operations.snapshot?.state).toBe('cancelled')
    expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(false)
    await expect(
      f.persistence.runSessionMutation(request.projectId, request.sessionId, async () => 'released')
    ).resolves.toBe('released')
    expect(desktopHost.chooseSavePath).not.toHaveBeenCalled()
  } finally {
    await sessionPackageDesktop.close()
    await pending.catch(() => undefined)
    await f.dispose()
  }
})

it('releases the shared reservation when conversation Save As is cancelled', async () => {
  const f = await createLifecycleFixture()
  const request = { projectId: f.scope.projectId, sessionId: f.scope.sessionId }
  desktopHost.chooseSavePath.mockResolvedValue({ canceled: true })
  const { conversationExportService } = f.surfaces()
  try {
    await expect(
      conversationExportService.exportConversation({ ...request, format: 'markdown' })
    ).resolves.toEqual({ saved: false })
    expect(f.getExportOwners).toHaveBeenCalledOnce()
    expect(f.readImageTasks).not.toHaveBeenCalled()
    expect(f.archive.isSessionExporting(request.projectId, request.sessionId)).toBe(false)
    await expect(
      f.persistence.runSessionMutation(request.projectId, request.sessionId, async () => 'released')
    ).resolves.toBe('released')
  } finally {
    await f.dispose()
  }
})
