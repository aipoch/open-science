import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { SessionPackageService } from '../session-package/service'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { buildRunObservationArchive } from '../run-observation/archive'
import type { RecordedObservationPayload } from '../../shared/run-observation-recorded'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ArchiveCoordinator } from '../archive/coordinator'
import * as materialAuthority from '../notebook/research-material-authority'
import * as nodeRuntimes from '../notebook/managed-research-node-runtime'
import * as hostShellPath from '../settings/shell-path'
import { createTaskCallerContext } from '../caller-context'
import {
  createSessionOperationTestHarness,
  operationTestScope as scope,
  type SessionOperationTestHarness
} from '../notebook/session-operation.test-support'
import { composeManagedExecution } from './managed-execution'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
}> {
  const h = await createSessionOperationTestHarness(cleanups)
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
    versions
  }
}

it('uses Main host PATH augmentation for runtime discovery without inheriting its environment', async () => {
  const discovery = { available: false, runtimes: [] }
  const augmented = vi.spyOn(hostShellPath, 'augmentedPathEnv').mockReturnValue({
    PATH: '/host-independent-node/bin:/usr/bin',
    NODE_OPTIONS: '--require=/must-not-be-loaded.js',
    OPENAI_API_KEY: 'test-only-main-environment'
  })
  const registry = vi.spyOn(nodeRuntimes, 'createManagedResearchNodeRuntimeRegistry')
  const { composed } = await setup()
  expect(augmented).toHaveBeenCalledWith()
  expect(registry).toHaveBeenCalledExactlyOnceWith({
    path: '/host-independent-node/bin:/usr/bin'
  })
  vi.spyOn(composed.service, 'runtimes').mockResolvedValue(discovery)
  await expect(composed.external.call('runtimes', {}, createTaskCallerContext())).resolves.toEqual(
    discovery
  )
})

it('keeps application composition available when host PATH exceeds runtime discovery bounds', async () => {
  vi.spyOn(hostShellPath, 'augmentedPathEnv').mockReturnValue({
    PATH: Array.from({ length: 65 }, (_, i) => join(tmpdir(), `private-node-${i}`)).join(delimiter)
  })
  const { composed, h, reserveSessionOperation } = await setup()
  const execute = vi.spyOn(h.notebook, 'executeManagedShell')
  const discovery = await composed.external.call('runtimes', {}, createTaskCallerContext())
  expect(discovery).toMatchObject({
    available: false,
    runtimes: [],
    diagnostics: {
      issues: expect.arrayContaining([expect.objectContaining({ code: 'node_unusable' })])
    }
  })
  expect(JSON.stringify(discovery)).not.toContain('private-node')
  expect(reserveSessionOperation).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it('keeps the actual external adapter authenticated, local-only, schema-checked and held during handoff', async () => {
  const { composed } = await setup()
  const runtimes = vi
    .spyOn(composed.service, 'runtimes')
    .mockResolvedValue({ available: false, runtimes: [] })
  await expect(composed.external.call('runtimes', {})).rejects.toMatchObject({
    code: 'unauthorized'
  })
  await expect(
    composed.external.call('runtimes', {}, createTaskCallerContext({ location: 'remote' }))
  ).rejects.toMatchObject({ code: 'unsupported_location' })
  expect(runtimes).not.toHaveBeenCalled()
  const caller = createTaskCallerContext()
  await expect(
    composed.external.call('getOperation', { arbitraryPath: '/private' }, caller)
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(composed.external.call('getOperation', scope, caller)).rejects.toMatchObject({
    code: 'not_found'
  })
  composed.hold()
  await expect(composed.external.call('runtimes', {}, caller)).rejects.toMatchObject({
    code: 'unavailable'
  })
  composed.resume()
  await expect(composed.external.call('runtimes', {}, caller)).resolves.toEqual({
    available: false,
    runtimes: []
  })
})

it('holds real Session work through cancellation publication before releasing either lifecycle reservation', async () => {
  const { h, composed, releaseRoot, releaseWork, shutdownAll } = await setup()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: () => void
  const output = new Promise<void>((resolve) => {
    finish = resolve
  })
  await composed.operations.start({
    ...scope,
    requestText: 'Collect the available result on stop.',
    requestFingerprint: 'b'.repeat(64),
    execute: async (context, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      await output
      await context.saveOutput({
        filename: 'cancelled-note.txt',
        source: { kind: 'inline', content: 'The execution was cancelled.' }
      })
      return { text: 'stopped' }
    }
  })
  await started
  expect(composed.notebookLifecycle.getActiveNotebookSessions()).toContainEqual({
    projectId: scope.projectId,
    sessionId: scope.sessionId
  })
  const stopping = composed.notebookLifecycle.shutdownAll()
  await Promise.resolve()
  expect(releaseRoot).not.toHaveBeenCalled()
  expect(releaseWork).not.toHaveBeenCalled()
  expect(shutdownAll).not.toHaveBeenCalled()
  finish()
  await stopping
  expect(await composed.operations.get(scope)).toMatchObject({ status: 'cancelled' })
  expect((await h.read(scope))!.artifacts).toHaveLength(1)
  expect(releaseWork).toHaveBeenCalledOnce()
  expect(releaseRoot).toHaveBeenCalledOnce()
  expect(shutdownAll).toHaveBeenCalledOnce()
  expect(composed.getActiveSessions()).toEqual([])
})

it('does not acquire root admission if the existing archive fence denies the Session', async () => {
  const { h, composed, releaseRoot, releaseWork, assertSessionAvailable } = await setup()
  assertSessionAvailable.mockRejectedValueOnce(new Error('Session deletion is active'))
  const execute = vi.fn(async () => ({ text: 'never' }))
  await expect(
    composed.operations.start({
      ...scope,
      requestText: 'Should be rejected.',
      requestFingerprint: 'b'.repeat(64),
      execute
    })
  ).rejects.toThrow('deletion')
  expect(releaseRoot).not.toHaveBeenCalled()
  expect(releaseWork).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  expect(composed.getActiveSessions()).toEqual([])
  expect((await h.read(scope))!.messages).toEqual([])
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('creates an ordinary persisted Session and publishes its visible identity without starting an Agent', async () => {
  const { h, composed, publish, reserveSessionOperation } = await setup()
  const request = {
    projectId: scope.projectId,
    requestId: 'new-session',
    title: 'Prepared research'
  }
  const caller = createTaskCallerContext()
  const first = (await composed.external.call('createSession', request, caller)) as {
    projectId: string
    sessionId: string
  }
  const retry = await composed.external.call('createSession', request, caller)
  expect(retry).toEqual(first)
  const saved = await h.read(first)
  expect(saved).toMatchObject({ title: request.title, status: 'idle', messages: [] })
  expect(saved?.cwd).toContain('/workspaces/')
  expect(saved?.activeRun).toBeUndefined()
  expect(saved?.packageOrigin).toBeUndefined()
  expect(publish).toHaveBeenCalledWith('session:created', {
    session: saved,
    originClientId: 'main:managed-execution'
  })
  expect(reserveSessionOperation).not.toHaveBeenCalled()
  expect(h.kernelExecute).not.toHaveBeenCalled()
})

it('does not deadlock deletion on an external admission queued behind the Project gate', async () => {
  const { h, composed, archive, reserveSessionOperation } = await setup()
  const admission = vi.spyOn(archive, 'withSessionAvailable')
  const entered = deferred()
  const proceed = deferred()
  const deletion = archive.withProjectDeletion(scope.projectId, async () => {
    entered.resolve()
    await proceed.promise
    await composed.stopProject(scope.projectId)
  })
  await entered.promise
  const execute = vi.fn(async () => ({ text: 'never' }))
  const starting = composed.operations.start({
    ...scope,
    requestText: 'Too late',
    requestFingerprint: 'e'.repeat(64),
    execute
  })
  const rejected = expect(starting).rejects.toThrow(/delet/i)
  await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce())
  expect(reserveSessionOperation).not.toHaveBeenCalled()
  proceed.resolve()
  await deletion
  await rejected
  expect(execute).not.toHaveBeenCalled()
  expect((await h.read(scope))!.messages).toEqual([])
})

it.each(['session', 'project'] as const)(
  'drains admitted material work during %s deletion and performs a final environment release',
  async (kind) => {
    const { composed, archive } = await setup()
    const entered = deferred()
    const finish = deferred()
    vi.spyOn(materialAuthority, 'createResearchMaterialAuthority').mockImplementationOnce(
      async () => {
        entered.resolve()
        await finish.promise
        throw new Error('Fixture material scan finished')
      }
    )
    const scanning = composed.service.inspectMaterials({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      sourceSessionId: scope.sessionId
    })
    const scanned = expect(scanning).rejects.toThrow('Fixture material scan finished')
    await Promise.race([entered.promise, scanning])
    expect(composed.getActiveSessions()).toEqual([
      { projectId: scope.projectId, sessionId: scope.sessionId }
    ])
    const release = vi.spyOn(
      composed.environments,
      kind === 'session' ? 'releaseSession' : 'releaseProject'
    )
    let finished = false
    const stopping = (
      kind === 'session'
        ? composed.stopSession(scope.projectId, scope.sessionId)
        : archive.withProjectDeletion(scope.projectId, () => composed.stopProject(scope.projectId))
    ).then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    finish.resolve()
    await Promise.all([scanned, stopping])
    expect(release).toHaveBeenCalledTimes(2)
    expect(composed.getActiveSessions()).toEqual([])
  }
)

it('keeps the lifecycle held and drains accepted material work even when environment cleanup fails', async () => {
  const { composed, shutdownAll } = await setup()
  const entered = deferred()
  const finish = deferred()
  vi.spyOn(materialAuthority, 'createResearchMaterialAuthority').mockImplementationOnce(
    async () => {
      entered.resolve()
      await finish.promise
      throw new Error('Fixture scan finished')
    }
  )
  const scanning = composed.service.inspectMaterials({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    sourceSessionId: scope.sessionId
  })
  const scanned = expect(scanning).rejects.toThrow('Fixture scan finished')
  await Promise.race([entered.promise, scanning])
  vi.spyOn(composed.environments, 'quiesce').mockRejectedValueOnce(new Error('Unverified cleanup'))
  let finished = false
  const shuttingDown = composed.notebookLifecycle.shutdownAll().finally(() => {
    finished = true
  })
  const rejected = expect(shuttingDown).rejects.toThrow('Managed execution cleanup failed')
  await Promise.resolve()
  expect(finished).toBe(false)
  finish.resolve()
  await Promise.all([scanned, rejected])
  expect(shutdownAll).not.toHaveBeenCalled()
  await expect(
    composed.external.call('runtimes', {}, createTaskCallerContext())
  ).rejects.toMatchObject({ code: 'unavailable' })
  composed.resume()
  await composed.quiesce()
})

it('defers reopening after an aborted handoff until its outstanding cleanup pass settles', async () => {
  const { composed } = await setup()
  const finish = deferred()
  const cleanup = vi
    .spyOn(composed.environments, 'quiesce')
    .mockImplementationOnce(() => finish.promise)
  vi.spyOn(composed.service, 'runtimes').mockResolvedValue({ available: false, runtimes: [] })
  const stopping = composed.quiesce()
  expect(cleanup).toHaveBeenCalledOnce()
  composed.resume()
  await expect(
    composed.external.call('runtimes', {}, createTaskCallerContext())
  ).rejects.toMatchObject({ code: 'unavailable' })
  finish.resolve()
  await stopping
  await expect(
    composed.external.call('runtimes', {}, createTaskCallerContext())
  ).resolves.toMatchObject({ available: false })
})

it('applies the same handoff fence to native Agent calls as to authenticated external callers', async () => {
  const { h, composed } = await setup()
  vi.spyOn(composed.service, 'runtimes').mockResolvedValue({ available: false, runtimes: [] })
  const turn = {
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    ownerExecutionId: 'root',
    artifactRunId: 'artifacts',
    artifactStorageSessionId: scope.sessionId,
    workspaceCwd: (await h.read(scope))!.cwd,
    invocationId: 'invocation',
    provenanceContext: {
      rootFrameId: 'root',
      agentFrameId: 'root',
      messageBranchId: 'main',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    },
    signal: new AbortController().signal,
    assertActive: vi.fn()
  }
  composed.hold()
  await expect(composed.internal.call('runtimes', {}, turn)).rejects.toMatchObject({
    code: 'unavailable'
  })
  composed.resume()
  await expect(composed.internal.call('runtimes', {}, turn)).resolves.toEqual({
    available: false,
    runtimes: []
  })
  expect(turn.assertActive).toHaveBeenCalledOnce()
})

it('reconciles published output markers only after environment and operation startup recovery', async () => {
  const { composed } = await setup()
  const order: string[] = []
  vi.spyOn(composed.environments, 'recover').mockImplementation(async () => {
    order.push('environment')
  })
  vi.spyOn(composed.operations, 'recover').mockImplementation(async () => {
    order.push('operations')
  })
  const reconcile = vi
    .spyOn(composed.service, 'reconcilePublishedOutputs')
    .mockImplementation(async () => {
      order.push('published-outputs')
    })
  await composed.recover()
  expect(order).toEqual(['environment', 'operations', 'published-outputs'])
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(undefined)
})

it.each(['quiesce', 'close'] as const)(
  'drains tracked publication reconciliation through %s and rejects work after hold',
  async (method) => {
    const { composed } = await setup()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const reconcile = vi
      .spyOn(composed.service, 'reconcilePublishedOutputs')
      .mockImplementation(() => pending)
    const environmentQuiesce = vi.spyOn(composed.environments, 'quiesce')
    const reference = { projectId: scope.projectId, sessionId: scope.sessionId }
    const work = composed.reconcilePublishedOutputs(reference)
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledExactlyOnceWith(reference))
    composed.hold()
    await expect(composed.reconcilePublishedOutputs(reference)).rejects.toMatchObject({
      code: 'unavailable'
    })
    let drained = false
    const stopping = composed[method]().then(() => {
      drained = true
    })
    try {
      await vi.waitFor(() => expect(environmentQuiesce).toHaveBeenCalled())
      expect(drained).toBe(false)
    } finally {
      finish()
      await Promise.all([work, stopping])
    }
    expect(drained).toBe(true)
    expect(reconcile).toHaveBeenCalledOnce()
  }
)

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
it('opens a real imported recording through production composition without granting write admission', async () => {
  const {
    h,
    composed,
    packages,
    versions,
    archive,
    assertSessionAvailable,
    reserveSessionOperation
  } = await setup({ persistedObservationAdmission: true })
  const originalScope = { projectId: scope.projectId, sessionId: scope.sessionId }
  const content = Buffer.from('{"status":"ready"}')
  const media = []
  for (const name of ['initial-status.json', 'final-status.json']) {
    media.push(
      await versions.adoptLegacyArtifact({
        ...originalScope,
        sourceFileId: name,
        logicalFilename: name,
        content,
        contentType: 'application/json'
      })
    )
  }
  const recording = buildRunObservationArchive({
    recordingId: 'composition-recording',
    capturedAt: 100,
    stopReason: 'run-ended',
    history: {
      coverage: 'process-local',
      truncated: false,
      snapshots: [
        {
          identity: { ...originalScope, runId: 'original-run' },
          cursor: { epoch: 'original-epoch', sequence: 0 },
          observedAt: 99,
          phase: 'completed',
          stepId: 'run:original-run',
          artifacts: [],
          artifactsTruncated: false,
          run: {
            runId: 'original-run',
            kernelKind: 'bash',
            status: 'completed',
            startedAt: 10,
            endedAt: 90,
            logs: {
              stdout: { text: 'ready', truncated: false, redacted: false },
              stderr: { text: '', truncated: false, redacted: false },
              traceback: { text: '', truncated: false, redacted: false }
            }
          }
        }
      ]
    },
    media: media.map((file, index) => ({
      mediaKey: `status-${index}`,
      name: index ? 'final-status.json' : 'initial-status.json',
      mimeType: 'application/json',
      checksum: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      sourceVersionId: file.versionId,
      stepKeys: ['observation-0']
    }))
  })
  const source = await versions.adoptLegacyArtifact({
    ...originalScope,
    sourceFileId: 'observation',
    logicalFilename: 'run-observation.json',
    content: Buffer.from(JSON.stringify(recording)),
    contentType: 'application/json'
  })
  const projectRecording = {
    format: 'open-science-project-recording',
    version: 1,
    recordingId: 'independent-recording',
    startedAt: 100,
    endedAt: 101,
    media: [],
    frames: [],
    events: [],
    states: [
      {
        stateId: 'state-0',
        sequence: 0,
        recordedAt: 100,
        source: 'author-declared',
        value: { count: 2 }
      }
    ],
    coverage: {
      kind: 'sampled-project-recording',
      stopReason: 'finished',
      failures: 0,
      unchangedSamples: 0,
      droppedSamples: 0,
      missingMediaKeys: []
    }
  }
  const projectSource = await versions.adoptLegacyArtifact({
    ...originalScope,
    sourceFileId: 'project-recording',
    logicalFilename: 'project-recording.json',
    content: Buffer.from(JSON.stringify(projectRecording)),
    contentType: 'application/json'
  })
  const packagePath = join(h.fixture.storageRoot, 'recording.science')
  await packages.exportTo(originalScope, packagePath)
  const imported = await packages.importFrom(packagePath)
  const receipt = await packages.readOrigin(imported)
  const target = {
    projectId: imported.projectId,
    sessionId: imported.sessionId,
    artifactId: receipt.identities[source.fileId],
    versionId: receipt.identities[source.versionId]
  }
  const importedSession = await h.read(imported)
  expect(importedSession?.packageOrigin).toBeDefined()
  const sessionPath = join(
    h.fixture.storageRoot,
    'sessions',
    imported.projectId,
    `${imported.sessionId}.json`
  )
  const before = await readFile(sessionPath)
  // This is the real pre-existing write-admission rule, not a mock that silently accepts imports.
  await expect(
    archive.withSessionAvailable(imported.projectId, imported.sessionId, async () => undefined)
  ).rejects.toThrow('read-only')
  assertSessionAvailable.mockClear()
  const mapping = vi.spyOn(packages, 'readArtifactSourceVersionMapping')
  const caller = createTaskCallerContext()
  const view = (await composed.external.observation!.call('openRecorded', { target }, caller)) as {
    viewerId: string
  }
  const payload = (await composed.external.observation!.call(
    'recording',
    { viewerId: view.viewerId },
    caller
  )) as RecordedObservationPayload
  expect(payload.receiving).toEqual(target)
  expect(payload.archive).toEqual(recording)
  expect(payload.media.map((item) => item.versionId)).toEqual(
    media.map((item) => receipt.identities[item.versionId])
  )
  expect(mapping).toHaveBeenCalledWith(
    imported,
    expect.objectContaining({ artifactId: target.artifactId, versionId: target.versionId })
  )
  const selection = await composed.external.observation!.call(
    'selectRecording',
    { viewerId: view.viewerId, stepKey: 'observation-0' },
    caller
  )
  expect(selection).toMatchObject({ receiving: target, record: recording.records[0] })
  await expect(
    composed.external.observation!.call('readRecorded', { target }, caller)
  ).resolves.toEqual(payload)
  const selectedFile = await composed.external.observation!.call(
    'selectRecordedFile',
    { target, mediaKey: 'status-1' },
    caller
  )
  expect(selectedFile).toMatchObject({
    kind: 'recorded-observation-file',
    receiving: target,
    resource: { ...imported, versionId: receipt.identities[media[1].versionId] },
    stage: 'unspecified'
  })
  const viewerFile = await composed.external.observation!.call(
    'selectRecordingFile',
    { viewerId: view.viewerId, mediaKey: 'status-1' },
    caller
  )
  expect(viewerFile).toMatchObject({
    kind: 'recorded-observation-file',
    receiving: target,
    resource: { ...imported, versionId: receipt.identities[media[1].versionId] },
    stage: 'unspecified'
  })
  await expect(
    composed.external.observation!.call(
      'recordingFileSelection',
      { viewerId: view.viewerId },
      caller
    )
  ).resolves.toEqual(viewerFile)
  const projectTarget = {
    ...imported,
    artifactId: receipt.identities[projectSource.fileId],
    versionId: receipt.identities[projectSource.versionId]
  }
  await expect(
    composed.external.observation!.call('readProjectRecording', { target: projectTarget }, caller)
  ).resolves.toMatchObject({ receiving: projectTarget, recording: projectRecording })
  const projectView = (await composed.external.observation!.call(
    'openRecorded',
    { target: projectTarget, format: 'project-recording' },
    caller
  )) as { viewerId: string }
  await expect(
    composed.external.observation!.call('recording', { viewerId: projectView.viewerId }, caller)
  ).resolves.toMatchObject({ receiving: projectTarget, recording: projectRecording })
  await expect(
    composed.external.observation!.call(
      'selectRecording',
      { viewerId: projectView.viewerId, stepKey: 'observation-0' },
      caller
    )
  ).rejects.toMatchObject({ code: 'unavailable' })
  expect(await readFile(sessionPath)).toEqual(before)
  expect(assertSessionAvailable).not.toHaveBeenCalled()
  expect(reserveSessionOperation).not.toHaveBeenCalled()
  expect(h.kernelExecute).not.toHaveBeenCalled()
  // Cross-scope IDs and revocation still fail; no new execution or imported Session mutation.
  await expect(
    composed.external.observation!.call(
      'openRecorded',
      { target: { ...target, sessionId: scope.sessionId } },
      caller
    )
  ).rejects.toMatchObject({ code: 'unavailable' })
  composed.hold()
  await expect(
    composed.external.observation!.call('recording', { viewerId: view.viewerId }, caller)
  ).rejects.toMatchObject({ code: 'unavailable' })
  composed.resume()
  await archive.withProjectDeletion(imported.projectId, async () => undefined)
  await expect(
    composed.external.observation!.call('recording', { viewerId: view.viewerId }, caller)
  ).rejects.toMatchObject({ code: 'unavailable' })
  archive.releaseProjectDeletion(imported.projectId)
  // A persisted Session archive remains unavailable even though its immutable Artifact exists.
  const envelope = JSON.parse(before.toString())
  envelope.session.archivedAt = 1
  await writeFile(sessionPath, JSON.stringify(envelope))
  await expect(
    composed.external.observation!.call('openRecorded', { target }, caller)
  ).rejects.toMatchObject({ code: 'unavailable' })
}, 60000)
