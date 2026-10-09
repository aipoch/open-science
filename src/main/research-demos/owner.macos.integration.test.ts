import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { SessionPackageService } from '../session-package/service'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { RecordedObservationPayload } from '../../shared/run-observation-recorded'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createTaskCallerContext } from '../caller-context'
import {
  createSessionOperationTestHarness,
  operationTestScope as scope,
  type SessionOperationTestHarness
} from '../notebook/session-operation.test-support'
import { composeManagedExecution } from '../composition/managed-execution'
import type { ResearchDemoReceipt } from '../../shared/research-demo'
import type { RuntimeViewAccess } from '../../shared/runtime-view'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Native demo cleanup failed.')
})

async function setup(options: { persistedObservationAdmission?: boolean } = {}): Promise<{
  h: SessionOperationTestHarness
  composed: Awaited<ReturnType<typeof composeManagedExecution>>
  releaseRoot: Mock<() => void>
  releaseWork: Mock<() => void>
  assertSessionAvailable: Mock<(projectId: string, sessionId: string) => Promise<void>>
  shutdownAll: Mock<() => Promise<{ reaped: boolean }>>
  archive: ArchiveCoordinator
  publish: Mock
  reserveSessionOperation: Mock
  packages: SessionPackageService
  versions: ManagedFileVersionService
  files: ManagedFileIndexRepository
}> {
  const h = await createSessionOperationTestHarness(cleanups, {
    canonicalStorageRoot: true,
    nativeSandbox: true
  })
  await h.notebook.recoverInterruptedOperations()
  const versions = new ManagedFileVersionService({
    storageRoot: h.fixture.storageRoot,
    getClient: async () => h.fixture.client
  })
  const files = new ManagedFileIndexRepository(
    async () => h.fixture.client,
    h.fixture.storageRoot,
    versions,
    new UploadRepository(h.fixture.storageRoot, { getClient: async () => h.fixture.client })
  )
  const persistence = new SessionPersistenceCoordinator(h.sessions, files)
  const packages = new SessionPackageService({
    storageRoot: h.fixture.storageRoot,
    getClient: async () => h.fixture.client
  })
  cleanups.push(() => packages.close())
  const registry = new ArtifactRunRegistry()
  const releaseRoot = vi.fn<() => void>()
  const releaseWork = vi.fn<() => void>()
  const reserveSessionOperation = vi.fn(async () => releaseRoot)
  const assertSessionAvailable = vi.fn(async (projectId: string, sessionId: string) => {
    if (options.persistedObservationAdmission)
      await persistence.assertSessionAvailable(projectId, sessionId)
  })
  const shutdownAll = vi.fn(async () => ({ reaped: true }))
  const publish = vi.fn()
  const archive = new ArchiveCoordinator(
    {
      get: async (id) => ({
        id,
        name: 'Test',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }),
      updateArchive: vi.fn()
    },
    {
      assertSessionAvailable,
      sessionProjectId: async (sessionId) =>
        options.persistedObservationAdmission
          ? (await h.sessions.loadAllWithDiagnostics({ mode: 'read-only' })).result.sessions.find(
              (session) => session.id === sessionId
            )?.projectId
          : scope.projectId,
      assertProjectArchivable: vi.fn(),
      updateArchive: vi.fn()
    },
    {
      isSessionBusy: () => false,
      isProjectBusy: () => false,
      liveSessionProjectId: () => scope.projectId
    }
  )
  const admitSessionWork = archive.admitSessionWork.bind(archive)
  vi.spyOn(archive, 'admitSessionWork').mockImplementation((projectId, sessionId, userPrompt) => {
    const release = admitSessionWork(projectId, sessionId, userPrompt)
    return () => {
      release()
      releaseWork()
    }
  })
  const params = {
    applicationEvents: { publish },
    managedFiles: {
      artifactRepository: h.fixture.compatibilityRepository,
      artifactRunRegistry: registry,
      artifactProvenanceRepository: h.artifacts,
      notebookRepository: h.fixture.notebookRepository,
      immutableInputAuthority: new ImmutableInputAuthority({
        storageRoot: h.fixture.storageRoot,
        managedFileVersions: versions
      })
    },
    sessionAuthority: {
      projectFilesRepository: files,
      sessionPersistenceCoordinator: {
        readSessionSnapshot: persistence.readSessionSnapshot.bind(persistence),
        readSessionForOperation: (projectId: string, sessionId: string) =>
          h.read({ projectId, sessionId }),
        loadSessionForContinuation: async (projectId: string, sessionId: string) => {
          const session = await h.read({ projectId, sessionId })
          if (!session) throw new Error('missing')
          return session
        },
        saveSession: h.sessions.saveSession.bind(h.sessions),
        deleteSession: h.sessions.deleteSession.bind(h.sessions),
        mutateRuntimeSession: h.mutate,
        retryArtifactFinalization: h.retryArtifactFinalization
      },
      artifactHandlersRef: {
        current: createArtifactHandlers(h.fixture.compatibilityRepository, registry, {
          provenance: h.artifacts
        })
      }
    },
    sessionPackages: { sessionPackageService: packages },
    projectLifecycle: { archiveCoordinator: archive },
    notebookRuntime: {
      notebookService: h.notebook,
      notebookLifecycle: {
        getActiveNotebookSessions: () => [],
        shutdownAll,
        dispose: async () => ({ reaped: true })
      }
    },
    runtimeRef: { current: { reserveSessionOperation } },
    modules: {
      add: async (_input: unknown, build: () => { dispose: () => Promise<void> }) => {
        const module = build()
        cleanups.push(module.dispose)
      }
    }
  }
  const composed = await composeManagedExecution(
    params as unknown as Parameters<typeof composeManagedExecution>[0]
  )
  return {
    h,
    composed,
    releaseRoot,
    releaseWork,
    assertSessionAvailable,
    shutdownAll,
    archive,
    publish,
    reserveSessionOperation,
    packages,
    versions,
    files
  }
}

// Explicit opt-in: reviewed public package and a NEW evidence directory. This never reads a
// workspace .env, the user's installed data root, model configuration or external credentials.
const packagePath = process.env.OPEN_SCIENCE_NATIVE_DEMO_PACKAGE
const evidencePath = process.env.OPEN_SCIENCE_NATIVE_DEMO_EVIDENCE
const cancellationOnly = process.env.OPEN_SCIENCE_NATIVE_DEMO_CANCEL_ONLY === '1'
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const done = (receipt: ResearchDemoReceipt): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted', 'recovery-pending'].includes(receipt.state)

const http = (
  url: string,
  method = 'GET',
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method,
        headers,
        family: 4,
        lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4)
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.once('end', () =>
          resolve({ status: response.statusCode!, headers: response.headers, body })
        )
        response.once('error', reject)
      }
    )
    request.setTimeout(5000, () => request.destroy(new Error('Native demo HTTP timeout')))
    request.once('error', reject)
    request.end()
  })

it.skipIf(process.platform !== 'darwin' || !packagePath || !evidencePath || cancellationOnly)(
  'imports a reviewed demo, runs and cancels real native processes without a model, then preserves materials and purpose through native packages',
  async () => {
    const reviewedPackage = await realpath(packagePath!)
    const output = resolve(evidencePath!)
    await mkdir(output, { recursive: false })
    const { h, composed, packages, files, publish } = await setup({
      persistedObservationAdmission: true
    })
    const caller = createTaskCallerContext()
    const entries: unknown[] = []
    const packageSha256 = sha(await readFile(reviewedPackage))
    const persistEvidence = async (status: string): Promise<void> => {
      await writeFile(
        join(output, 'native-demo-results.json'),
        JSON.stringify(
          {
            status,
            packageFilename: basename(reviewedPackage),
            packageSha256,
            updatedAt: new Date().toISOString(),
            modelInvocations: vi.mocked(h.kernelExecute).mock.calls.length,
            entries
          },
          null,
          2
        ) + '\n'
      )
    }
    try {
      const imported = await packages.importFrom(reviewedPackage, undefined, undefined, undefined, {
        projectId: scope.projectId
      })
      const sourceSession = await h.read(imported)
      expect(sourceSession?.packageOrigin).toBeDefined()
      const sourceFile = join(
        h.fixture.storageRoot,
        'sessions',
        imported.projectId,
        `${imported.sessionId}.json`
      )
      const originalSessionBytes = await readFile(sourceFile)
      const source = {
        projectId: imported.projectId,
        sourceSessionId: imported.sessionId,
        sourceImportId: sourceSession!.packageOrigin!.importId
      }
      const inspection = await composed.researchDemos.inspect(source)
      const candidate = inspection.candidates.find((item) => item.status === 'ready')
      expect(candidate, JSON.stringify(inspection)).toBeDefined()
      const start = {
        ...source,
        demoVersionId: candidate!.demoVersionId,
        expectedSourceIdentity: inspection.source.identity,
        requestId: 'native-demo-completion'
      }
      const initial = await composed.researchDemos.start(start)
      expect(initial).toMatchObject({ purpose: 'offline-demo', state: 'preparing' })
      expect((await composed.researchDemos.start(start)).requestId).toBe(initial.requestId)
      let current!: ResearchDemoReceipt
      let projectAccess!: RuntimeViewAccess
      await vi.waitFor(
        async () => {
          current = await composed.researchDemos.get({ ...source, requestId: start.requestId })
          expect(current.state, JSON.stringify(current)).toBe('running')
          expect(current.runTarget?.runId).toBeDefined()
          const execution = await composed.service.inspectExecution(current.runTarget!)
          expect(execution?.run?.status).toBe('running')
          projectAccess = await composed.projectViews.open(
            {
              projectId: source.projectId,
              sessionId: current.sessionId!,
              runId: current.runTarget!.runId!
            },
            'native-demo-acceptance-view',
            ['http://127.0.0.1:4111']
          )
        },
        { timeout: 60_000, interval: 250 }
      )
      const live = await composed.observationViewers.create(current.runTarget!, caller)
      const liveSnapshot = await composed.observationViewers.snapshot(live.viewerId, { caller })
      expect(liveSnapshot.executionContext?.purpose).toBe('offline-demo')
      const bootstrap = await http(projectAccess.url)
      expect(bootstrap.status).toBe(303)
      const origin = new URL(projectAccess.url).origin
      const cookie = bootstrap.headers['set-cookie']![0].split(';')[0]
      const page = await http(origin + '/', 'GET', { cookie })
      expect(page.status).toBe(200)
      expect(page.body.toLowerCase()).toContain('<html')
      // A generic interactive fixture proves a real request reaches the owned project process.
      // Other reviewed projects retain their own interactions; no Tuanzi-specific API is guessed.
      let interaction: unknown
      if (page.body.includes('id="increment"')) {
        expect((await http(origin + '/increment', 'POST', { cookie, origin })).status).toBe(200)
        interaction = JSON.parse((await http(origin + '/state', 'GET', { cookie })).body)
        expect(interaction).toMatchObject({ clicks: 1 })
      }
      entries.push({ stage: 'live-native-project', title: candidate!.title, interaction })
      await persistEvidence('in-progress')
      await vi.waitFor(
        async () => {
          current = await composed.researchDemos.get({ ...source, requestId: start.requestId })
          expect(done(current), JSON.stringify(current)).toBe(true)
        },
        { timeout: 650_000, interval: 500 }
      )
      expect(current, JSON.stringify(current)).toMatchObject({
        state: 'completed',
        purpose: 'offline-demo',
        recordingStatus: 'saved'
      })
      expect(current.recordingTarget).toBeDefined()
      const completedExecution = await composed.service.inspectExecution(current.runTarget!)
      await vi.waitFor(
        async () =>
          expect(
            await composed.service.getEnvironment({
              projectId: source.projectId,
              sessionId: current.sessionId!,
              environmentId: completedExecution!.identity.environmentId!
            })
          ).toMatchObject({ state: 'released' }),
        { timeout: 15_000, interval: 100 }
      )
      const carrier = { projectId: source.projectId, sessionId: current.sessionId! }
      expect((await h.read(carrier))?.packageOrigin).toBeUndefined()
      expect(await composed.researchDemos.carriers({ projectId: source.projectId })).toEqual([
        { sessionId: carrier.sessionId, source }
      ])
      const recordedView = await composed.observationViewers.createRecorded(
        current.recordingTarget!,
        caller
      )
      const recorded = await composed.observationViewers.recording(recordedView.viewerId, {
        caller
      })
      if (!('archive' in recorded)) throw new Error('Expected the original observation archive.')
      await writeFile(join(output, 'completed-observation.json'), JSON.stringify(recorded, null, 2))
      expect(recorded.executionContext?.purpose).toBe('offline-demo')
      // The archive closes during result collection, before the enclosing operation commits.
      // Notebook terminal evidence is authoritative even when the recorded phase is collecting.
      expect(recorded.archive.coverage.terminalRunObserved).toBe(true)
      expect(recorded.archive.records.at(-1)?.run?.status).toBe('completed')
      expect(recorded.archive.version).toBe(1)
      expect(recorded.archive).not.toHaveProperty('executionContext')
      const selected = await composed.observationViewers.selectRecording(
        recordedView.viewerId,
        recorded.archive.records.at(-1)!.stepKey,
        { caller }
      )
      expect(selected.executionContext?.purpose).toBe('offline-demo')
      entries.push({ stage: 'completed', receipt: current, recording: recorded.archive.coverage })
      await persistEvidence('in-progress')

      // Export normal native Session data: graph closure must retain the explicit demo Artifact
      // and its fixed materials, with no custom .science field or local execution authority.
      const sourceExports = await files.readExportFiles(imported)
      expect(sourceExports.length).toBeGreaterThan(0)
      const consumedInputs = (await composed.service.inspectExecution(current.runTarget!))!.run!
        .inputFiles!
      expect(consumedInputs.length).toBeGreaterThan(0)
      await h.snapshots.captureFinalizedMessages((await h.read(carrier))!)
      const exported = join(output, 'demo-results.science')
      await packages.exportTo(carrier, exported)
      const roundTrip = await packages.importFrom(exported, undefined, undefined, undefined, {
        projectId: source.projectId
      })
      const receipt = await packages.readOrigin(roundTrip)
      expect(receipt.identities[candidate!.demoVersionId]).toBeDefined()
      const remapped = {
        ...roundTrip,
        artifactId: receipt.identities[current.recordingTarget!.artifactId],
        versionId: receipt.identities[current.recordingTarget!.versionId]
      }
      const reopened = await composed.observationViewers.createRecorded(remapped, caller)
      const restored = (await composed.observationViewers.recording(reopened.viewerId, {
        caller
      })) as RecordedObservationPayload
      expect(restored.archive).toEqual(recorded.archive)
      expect(restored.executionContext?.purpose).toBe('offline-demo')
      expect(restored.receiving.sessionId).not.toBe(carrier.sessionId)
      // The Files panel lists outputs owned by this Session. Imported input dependencies belong
      // to their retained source scope; validate the package closure and material authority instead.
      for (const material of consumedInputs) {
        expect(material.checksum).toMatch(/^[a-f0-9]{64}$/u)
        expect(
          receipt.files.some((file) => file.sourceChecksum === material.checksum),
          `Missing imported input: ${material.filename}`
        ).toBe(true)
      }
      const reimportedSession = (await h.read(roundTrip))!
      const rediscovered = await composed.researchDemos.inspect({
        projectId: roundTrip.projectId,
        sourceSessionId: roundTrip.sessionId,
        sourceImportId: reimportedSession.packageOrigin!.importId
      })
      expect(rediscovered.candidates).toContainEqual(
        expect.objectContaining({
          demoVersionId: receipt.identities[candidate!.demoVersionId],
          status: 'ready'
        })
      )
      const forwarded = join(output, 'original-research.science')
      await packages.exportTo(imported, forwarded)
      const forwardedImport = await packages.importFrom(
        forwarded,
        undefined,
        undefined,
        undefined,
        { projectId: source.projectId }
      )
      const forwardedFiles = await files.readExportFiles(forwardedImport)
      expect(forwardedFiles.map((file) => file.checksum).sort()).toEqual(
        sourceExports.map((file) => file.checksum).sort()
      )
      expect(await readFile(sourceFile)).toEqual(originalSessionBytes)
      entries.push({
        stage: 'native-round-trip',
        packageFilename: basename(exported),
        packageSha256: sha(await readFile(exported)),
        explicitDemoMaterialPreserved: true,
        materialCount: consumedInputs.length,
        originalSessionUnchanged: true,
        purpose: restored.executionContext?.purpose,
        archiveVersion: restored.archive.version
      })
      await persistEvidence('in-progress')

      const cancelledRequest = { ...start, requestId: 'native-demo-cancellation' }
      await composed.researchDemos.start(cancelledRequest)
      let cancelled!: ResearchDemoReceipt
      await vi.waitFor(
        async () => {
          cancelled = await composed.researchDemos.get({
            ...source,
            requestId: cancelledRequest.requestId
          })
          expect(cancelled.state, JSON.stringify(cancelled)).toBe('running')
          const execution = cancelled.runTarget
            ? await composed.service.inspectExecution(cancelled.runTarget)
            : undefined
          expect(execution?.run?.status).toBe('running')
        },
        { timeout: 60_000, interval: 250 }
      )
      cancelled = await composed.researchDemos.stop({
        ...source,
        requestId: cancelledRequest.requestId
      })
      await vi.waitFor(
        async () => {
          cancelled = await composed.researchDemos.get({
            ...source,
            requestId: cancelledRequest.requestId
          })
          expect(cancelled.state, JSON.stringify(cancelled)).toBe('cancelled')
        },
        { timeout: 60_000, interval: 250 }
      )
      expect(cancelled.sessionId).toBe(carrier.sessionId)
      expect(cancelled.recordingStatus).toBe('saved')
      expect(cancelled.runTarget?.runId).not.toBe(current.runTarget?.runId)
      const cancelledExecution = await composed.service.inspectExecution(cancelled.runTarget!)
      await vi.waitFor(
        async () =>
          expect(
            await composed.service.getEnvironment({
              ...carrier,
              environmentId: cancelledExecution!.identity.environmentId!
            })
          ).toMatchObject({ state: 'released' }),
        { timeout: 15_000, interval: 100 }
      )
      const history = await composed.researchDemos.list(source)
      expect(history.carrierSessionId).toBe(carrier.sessionId)
      expect(history.receipts.map((receipt) => receipt.requestId).sort()).toEqual(
        [start.requestId, cancelledRequest.requestId].sort()
      )
      expect(
        history.receipts.every((receipt) => receipt.source.sourceSessionId === imported.sessionId)
      ).toBe(true)
      expect(await readFile(sourceFile)).toEqual(originalSessionBytes)
      expect(h.kernelExecute).not.toHaveBeenCalled()
      expect(publish.mock.calls.filter(([name]) => name === 'session:created')).toHaveLength(1)
      entries.push({ stage: 'cancelled', receipt: cancelled })

      await persistEvidence('passed')
    } catch (error) {
      entries.push({
        stage: 'failure',
        message: error instanceof Error ? error.message : 'unknown'
      })
      await persistEvidence('failed')
      throw error
    }
  },
  900_000
)

it.skipIf(process.platform !== 'darwin' || !packagePath || !evidencePath || !cancellationOnly)(
  'cancels immediately after native process admission and retains truthful cleanup evidence',
  async () => {
    const output = resolve(evidencePath!)
    await mkdir(output, { recursive: false })
    const { h, composed, packages } = await setup({ persistedObservationAdmission: true })
    const imported = await packages.importFrom(packagePath!, undefined, undefined, undefined, {
      projectId: scope.projectId
    })
    const original = await h.read(imported)
    const source = {
      projectId: imported.projectId,
      sourceSessionId: imported.sessionId,
      sourceImportId: original!.packageOrigin!.importId
    }
    const inspection = await composed.researchDemos.inspect(source)
    const candidate = inspection.candidates.find((entry) => entry.status === 'ready')!
    expect(candidate, JSON.stringify(inspection)).toBeDefined()
    const request = { ...source, requestId: 'native-demo-early-cancel' }
    await composed.researchDemos.start({
      ...request,
      demoVersionId: candidate.demoVersionId,
      expectedSourceIdentity: inspection.source.identity
    })
    let current!: ResearchDemoReceipt
    await vi.waitFor(
      async () => {
        current = await composed.researchDemos.get(request)
        const execution = current.runTarget
          ? await composed.service.inspectExecution(current.runTarget)
          : undefined
        expect(execution?.run?.status).toBe('running')
      },
      { timeout: 60_000, interval: 100 }
    )
    await composed.researchDemos.stop(request)
    await vi.waitFor(
      async () => {
        current = await composed.researchDemos.get(request)
        expect(done(current)).toBe(true)
      },
      { timeout: 60_000, interval: 100 }
    )
    const operation = await composed.service.getOperation({
      projectId: source.projectId,
      sessionId: current.sessionId!,
      requestId: current.operationRequestId!
    })
    const execution = current.runTarget
      ? await composed.service.inspectExecution(current.runTarget)
      : undefined
    let environment = execution?.identity.environmentId
      ? await composed.service.getEnvironment({
          projectId: source.projectId,
          sessionId: current.sessionId!,
          environmentId: execution.identity.environmentId
        })
      : undefined
    await writeFile(
      join(output, 'native-demo-cancellation.json'),
      JSON.stringify(
        {
          receipt: current,
          operation,
          execution: execution ? { state: execution.state, run: execution.run } : undefined,
          environment,
          modelInvocations: vi.mocked(h.kernelExecute).mock.calls.length
        },
        null,
        2
      )
    )
    expect(current, JSON.stringify(current)).toMatchObject({ state: 'cancelled' })
    expect(current.recordingStatus).toBe('saved')
    expect(operation?.recoveryPending).not.toBe(true)
    await vi.waitFor(
      async () => {
        const released = await composed.service.getEnvironment({
          projectId: source.projectId,
          sessionId: current.sessionId!,
          environmentId: execution!.identity.environmentId!
        })
        expect(released).toMatchObject({ state: 'released' })
        environment = released
      },
      { timeout: 15_000, interval: 100 }
    )
    expect(h.kernelExecute).not.toHaveBeenCalled()
    await writeFile(
      join(output, 'native-demo-cancellation.json'),
      JSON.stringify(
        {
          receipt: current,
          operation,
          execution: execution ? { state: execution.state, run: execution.run } : undefined,
          environment,
          cleanupConfirmed: true,
          modelInvocations: 0
        },
        null,
        2
      )
    )
  },
  120_000
)
