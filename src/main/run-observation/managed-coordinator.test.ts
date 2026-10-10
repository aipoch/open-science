import { configureTestElectronHost } from '../../../test/runtime-host'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type {
  ArtifactVersionDescriptor,
  ArtifactVersionFile
} from '../../shared/artifact-provenance'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import type { ManagedOutputWriteAttempt } from '../notebook/managed-output-publication'
import { saveAuxiliaryOutput } from '../notebook/managed-auxiliary-output'
import { ManagedRunObservationCoordinator } from './managed-coordinator'
import { createManagedObservationPort } from './managed-port'
import { createManagedRecordingStatusReader } from './managed-status'
import { RunObservationRecorder } from './recorder'
import { RunObservationOwner } from './owner'
import { createManagedRunObservationReader } from '../managed-run-observation'
import { createSessionOperationTestHarness } from '../notebook/session-operation.test-support'
import { ManagedExecutionService } from '../notebook/managed-execution-service'
import { ManagedResearchEnvironmentOwner } from '../notebook/managed-research-environment'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

await configureTestElectronHost(await import('electron'))

const target = {
  projectId: 'project-a',
  sessionId: 'session-a',
  operationId: 'operation-a',
  executionInvocationId: 'invocation-a'
}
const provenance = {
  rootFrameId: 'root',
  agentFrameId: 'root',
  messageBranchId: 'branch',
  runtimeSegmentId: 'segment',
  promptMessageId: 'prompt'
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const snapshot: RunObservationSnapshot = {
  identity: { ...target, runId: 'run-a' },
  cursor: { epoch: 'epoch-a', sequence: 0 },
  observedAt: 200,
  phase: 'completed',
  stepId: 'run:run-a',
  artifacts: [],
  artifactsTruncated: false,
  run: {
    runId: 'run-a',
    executionInvocationId: target.executionInvocationId,
    kernelKind: 'bash',
    status: 'completed',
    startedAt: 100,
    endedAt: 190,
    logs: {
      stdout: { text: 'completed', redacted: false, truncated: false },
      stderr: { text: '', redacted: false, truncated: false },
      traceback: { text: '', redacted: false, truncated: false }
    }
  }
}
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(): Promise<{
  dataRoot: string
  coordinator: ManagedRunObservationCoordinator
  recorder: RunObservationRecorder
  context: {
    projectId: string
    sessionId: string
    provenanceContext: typeof provenance
    saveAuxiliaryOutput(
      output: Parameters<typeof saveAuxiliaryOutput>[0]
    ): ReturnType<typeof saveAuxiliaryOutput>
  }
  artifacts: {
    resolveVersionDescriptors: Mock<
      (request: { versionIds: string[] }) => Promise<ArtifactVersionDescriptor[]>
    >
    replayVersion: Mock<() => Promise<undefined>>
  }
  descriptors: Map<string, ArtifactVersionDescriptor>
  save: Mock<(output: Parameters<typeof saveAuxiliaryOutput>[0]) => Promise<ArtifactVersionFile>>
  attempts: ManagedOutputWriteAttempt[]
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'observation-publication-'))
  cleanups.push(() => rm(dataRoot, { force: true, recursive: true }))
  const descriptors = new Map<string, ArtifactVersionDescriptor>()
  const attempts: ManagedOutputWriteAttempt[] = []
  const recorder = new RunObservationRecorder({
    dataRoot,
    intervalMs: 60_000,
    read: async () => snapshot,
    isPublished: async (_target, reference) =>
      descriptors.get(reference.versionId)?.isPublished === true
  })
  cleanups.push(() => recorder.close())
  const artifacts = {
    resolveVersionDescriptors: vi.fn(async ({ versionIds }: { versionIds: string[] }) =>
      versionIds.flatMap((versionId) => {
        const value = descriptors.get(versionId)
        return value?.state === 'finalized' ? [value] : []
      })
    ),
    replayVersion: vi.fn(async () => undefined)
  }
  const coordinator = new ManagedRunObservationCoordinator({
    dataRoot,
    recorder: () => recorder,
    artifacts
  })
  const save = vi.fn(
    async (output: Parameters<typeof saveAuxiliaryOutput>[0]): Promise<ArtifactVersionFile> => {
      const content = output.source.content
      const attempt: ManagedOutputWriteAttempt = {
        schemaVersion: 1,
        request: {
          projectId: target.projectId,
          appSessionId: target.sessionId,
          artifactStorageSessionId: target.sessionId,
          artifactRunId: 'artifact-run',
          writeOperationId: 'write-capture',
          filename: output.filename,
          contentType: output.contentType
        },
        destination: {
          provenanceContext: provenance,
          messageAncestry: [provenance.promptMessageId]
        },
        source: { kind: 'inline', sha256: hash(content), sizeBytes: Buffer.byteLength(content) }
      }
      await output.publication?.beforeWrite(attempt)
      attempts.push(attempt)
      const version: ArtifactVersionDescriptor = {
        projectId: target.projectId,
        sessionId: target.sessionId,
        id: 'version-capture',
        versionId: 'version-capture',
        artifactId: 'artifact-capture',
        versionNumber: 1,
        name: output.filename,
        mimeType: output.contentType,
        checksum: hash(content),
        size: Buffer.byteLength(content),
        state: 'pending',
        isPublished: false,
        createdAt: new Date(0).toISOString(),
        mtimeMs: 0
      }
      descriptors.set(version.versionId, version)
      return { ...version, path: '/not-persisted', fileUrl: 'file:///not-persisted' }
    }
  )
  const context = {
    projectId: target.projectId,
    sessionId: target.sessionId,
    provenanceContext: provenance,
    saveAuxiliaryOutput: (output: Parameters<typeof saveAuxiliaryOutput>[0]) =>
      saveAuxiliaryOutput(output, (value) =>
        save(value as Parameters<typeof saveAuxiliaryOutput>[0])
      )
  }
  return { dataRoot, coordinator, context, recorder, artifacts, descriptors, save, attempts }
}

it('keeps its exact write intent outside the execution journal and confirms publication after independent restart', async () => {
  const h = await setup()
  const capture = await h.coordinator.begin(target, h.context)
  const saved = await h.coordinator.publish({
    target,
    context: h.context,
    handle: capture.handle,
    recovery: false
  })
  expect(saved).toMatchObject({
    savedInCurrentTurn: true,
    result: { status: 'saved', versionId: 'version-capture' }
  })
  const files = await readdir(join(h.dataRoot, 'managed-observation-publications'))
  expect(files).toHaveLength(1)
  const text = await readFile(
    join(h.dataRoot, 'managed-observation-publications', files[0]),
    'utf8'
  )
  expect(text).not.toMatch(/not-persisted|file:\/\/|producerRunId/)
  expect(JSON.parse(text)).toMatchObject({
    target,
    reference: { versionId: 'version-capture' },
    attempts: [{ request: h.attempts[0].request }]
  })
  const descriptor = h.descriptors.get('version-capture')!
  descriptor.state = 'finalized'
  descriptor.isPublished = true
  const restarted = new ManagedRunObservationCoordinator({
    dataRoot: h.dataRoot,
    recorder: () => h.recorder,
    artifacts: h.artifacts
  })
  await restarted.reconcilePublished(target)
  expect(await restarted.status(target)).toMatchObject({
    status: 'published',
    versionId: 'version-capture'
  })
  expect(h.save).toHaveBeenCalledOnce()
})

it('does not deadlock when the current Artifact write emits a reentrant publication hint', async () => {
  const h = await setup()
  const capture = await h.coordinator.begin(target, h.context)
  const markPublished = h.recorder.markPublished.bind(h.recorder)
  vi.spyOn(h.recorder, 'markPublished').mockImplementation(async (...args) => {
    // The exact reference is already durable at this point; this hook must skip its own in-flight writer.
    await h.coordinator.reconcilePublished(target)
    return markPublished(...args)
  })
  const save = h.save.getMockImplementation()!
  h.save.mockImplementation(async (output) => {
    const result = await save(output)
    await h.coordinator.reconcilePublished(target)
    return result
  })
  const result = await h.coordinator.publish({
    target,
    context: h.context,
    handle: capture.handle,
    recovery: false
  })
  expect(result.result.status).toBe('saved')
})

it('refuses a foreign Main branch or changed operation identity before any Artifact write', async () => {
  const h = await setup()
  const capture = await h.coordinator.begin(target, h.context)
  await capture.handle!.finish()
  const branch = await h.coordinator.publish({
    target,
    context: { ...h.context, provenanceContext: { ...provenance, messageBranchId: 'foreign' } },
    recovery: true
  })
  expect(branch.result).toMatchObject({ status: 'pending', warning: 'archive-recovery-pending' })
  const operation = await h.coordinator.publish({
    target: { ...target, operationId: 'different-operation' },
    context: h.context,
    recovery: true
  })
  expect(operation.result.status).toBe('pending')
  expect(h.save).not.toHaveBeenCalled()
})

it('preserves a malformed or future publication record instead of issuing another write', async () => {
  const h = await setup()
  const capture = await h.coordinator.begin(target, h.context)
  await capture.handle!.finish()
  const path = join(
    h.dataRoot,
    'managed-observation-publications',
    (await readdir(join(h.dataRoot, 'managed-observation-publications')))[0]
  )
  const future = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), schemaVersion: 2 })
  await writeFile(path, future)
  const result = await h.coordinator.publish({ target, context: h.context, recovery: true })
  expect(result.result.status).toBe('pending')
  expect(await readFile(path, 'utf8')).toBe(future)
  expect(h.save).not.toHaveBeenCalled()
})

it('never falls back to a required-output writer when the optional capability is absent', async () => {
  const h = await setup()
  const capture = await h.coordinator.begin(target, h.context)
  const result = await h.coordinator.publish({
    target,
    context: { ...h.context, saveAuxiliaryOutput: undefined },
    handle: capture.handle,
    recovery: false
  })
  expect(result.result).toMatchObject({ status: 'pending', warning: 'archive-save-failed' })
  expect(h.save).not.toHaveBeenCalled()
  expect((await h.recorder.load(target))?.archive).toBeDefined()
})

it.skipIf(process.platform === 'win32').each(['returned', 'response-lost'] as const)(
  'confirms an actual pending Artifact only after its original turn publishes, including %s restart recovery',
  async (mode) => {
    const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
    const scope = { projectId: 'project-1', sessionId: 'session-1' }
    const executable = await realpath(process.execPath)
    const runtime = {
      kind: 'node' as const,
      executable,
      version: process.versions.node,
      sha256: hash('runtime'),
      platform: process.platform as 'darwin' | 'linux',
      arch: process.arch,
      readOnlyRoots: [dirname(executable)]
    }
    const environments = new ManagedResearchEnvironmentOwner({
      dataRoot: h.fixture.storageRoot,
      socketRoot: await realpath(tmpdir()),
      verifyRuntime: async () => undefined,
      stopExecution: async (identity) => ({
        verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true })).reaped
      })
    })
    cleanups.push(() => environments.close())
    let service: ManagedExecutionService
    const observer = new RunObservationOwner({
      authorize: async () => undefined,
      read: (selected) => createManagedRunObservationReader(service)(selected)
    })
    cleanups.push(async () => observer.close())
    const makeRecorder = (): RunObservationRecorder => {
      const recorder = new RunObservationRecorder({
        dataRoot: h.fixture.storageRoot,
        intervalMs: 60_000,
        read: (selected) => observer.snapshot(selected, { viewerId: 'real-publication' }),
        isPublished: async (selected, reference) =>
          (
            await h.artifacts.resolveVersionDescriptors({
              projectId: selected.projectId,
              appSessionId: selected.sessionId,
              versionIds: [reference.versionId]
            })
          ).some((version) => version.state === 'finalized' && version.isPublished)
      })
      cleanups.push(() => recorder.close())
      return recorder
    }
    const recorder = makeRecorder()
    const dependencies = {
      artifacts: h.artifacts,
      notebooks: h.fixture.notebookRepository,
      dataRoot: h.fixture.storageRoot,
      environments,
      operations: h.owner,
      runtime: h.notebook,
      runtimes: {
        discover: async () => ({ runtimes: [{ runtimeId: hash('runtime'), runtime }] }),
        resolve: async () => runtime
      },
      materials: async () => ({
        source: { ...scope, identity: 'fixed-input' },
        versions: [
          {
            versionId: 'input',
            sourceIdentity: 'fixed-input',
            filename: 'input.txt',
            sha256: hash('input'),
            sizeBytes: 5
          }
        ],
        readVersion: async () => Buffer.from('input')
      }),
      resolvePreparedInputs: async () => [],
      createSession: async () => {
        throw new Error('No new Session')
      },
      withWritableSession: async <T>(_scope: unknown, action: () => Promise<T>): Promise<T> =>
        action()
    }
    const coordinator = new ManagedRunObservationCoordinator({
      dataRoot: h.fixture.storageRoot,
      recorder: () => recorder,
      artifacts: h.artifacts
    })
    service = new ManagedExecutionService({
      ...dependencies,
      observation: createManagedObservationPort(coordinator).port
    })
    const save = h.artifacts.saveVersion.bind(h.artifacts)
    let savedVersion: ArtifactVersionFile | undefined
    let saveCount = 0
    vi.spyOn(h.artifacts, 'saveVersion').mockImplementation(async (...args) => {
      const artifact = await save(...args)
      if (artifact.name.startsWith('replay-')) {
        saveCount++
        savedVersion = artifact
        const pending = await h.fixture.client.artifactVersion.findUniqueOrThrow({
          where: { id: artifact.versionId }
        })
        expect(pending.state).toBe('pending')
        expect(
          await h.artifacts.resolveVersionDescriptors({
            ...scope,
            appSessionId: scope.sessionId,
            versionIds: [artifact.versionId]
          })
        ).toEqual([])
        const publicationDirectory = join(h.fixture.storageRoot, 'managed-observation-publications')
        const publicationPath = join(publicationDirectory, (await readdir(publicationDirectory))[0])
        const publication = JSON.parse(await readFile(publicationPath, 'utf8'))
        expect(
          await h.artifacts.readPublishedVersionForWrite(publication.attempts[0].request)
        ).toBeUndefined()
        if (mode === 'response-lost')
          throw new Error('The real write succeeded but its response was lost.')
      }
      return artifact
    })
    const prepared = (await service.prepare({
      ...scope,
      requestId: 'prepare',
      sourceSessionId: scope.sessionId,
      sourceIdentity: 'fixed-input',
      runtimeId: hash('runtime'),
      materials: { files: [{ versionId: 'input', restorePath: 'input.txt' }] }
    })) as { environmentId: string }
    const operation = await service.execute({
      ...scope,
      environmentId: prepared.environmentId,
      requestId: 'actual-publication',
      command: 'printf observed',
      timeoutMs: 10_000,
      recordObservation: true
    })
    const settled = await h.owner.wait({ ...scope, requestId: 'actual-publication' })
    expect(settled, settled?.error).toMatchObject({
      status: 'completed',
      notebookRunIds: [expect.any(String)]
    })
    expect(savedVersion).toBeDefined()
    const directory = join(h.fixture.storageRoot, 'managed-observation-publications')
    const path = join(directory, (await readdir(directory))[0])
    const before = JSON.parse(await readFile(path, 'utf8'))
    expect(before.attempts).toHaveLength(1)
    if (mode === 'returned') expect(before.reference.versionId).toBe(savedVersion!.versionId)
    else expect(before.reference).toBeUndefined()
    const row = await h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: savedVersion!.versionId }
    })
    expect(row).toMatchObject({ state: 'finalized', producerRunId: null })
    expect(row.managedVisibleAt).not.toBeNull()
    await expect(
      h.artifacts.readPublishedVersionForWrite({
        ...before.attempts[0].request,
        artifactRunId: 'foreign-original-turn'
      })
    ).rejects.toThrow('does not match')
    await expect(
      h.artifacts.readPublishedVersionForWrite({
        ...before.attempts[0].request,
        appSessionId: 'foreign-session'
      })
    ).rejects.toThrow('does not match')
    expect(
      await h.artifacts.readPublishedVersionForWrite(before.attempts[0].request)
    ).toMatchObject({
      versionId: row.id,
      isPublished: true
    })
    const immutableBefore = await readFile(join(h.fixture.storageRoot, row.contentStorageKey))
    await recorder.close()
    const restartedRecorder = makeRecorder()
    const restartedCoordinator = new ManagedRunObservationCoordinator({
      dataRoot: h.fixture.storageRoot,
      recorder: () => restartedRecorder,
      artifacts: h.artifacts
    })
    service = new ManagedExecutionService({
      ...dependencies,
      observation: createManagedObservationPort(restartedCoordinator).port
    })
    const recordingStatus = createManagedRecordingStatusReader({
      inspect: (target) => service.inspectExecution(target),
      coordinator: restartedCoordinator,
      recorder: restartedRecorder,
      artifacts: h.artifacts
    })
    const replay = vi
      .spyOn(h.artifacts, 'replayVersion')
      .mockRejectedValue(new Error('Status must never replay or repair a write.'))
    const writesBefore = await h.fixture.client.artifactVersion.count()
    expect(await recordingStatus({ ...scope, operationId: operation.operationId })).toMatchObject({
      state: 'saved',
      archive: { ...scope, artifactId: row.artifactId, versionId: row.id }
    })
    expect(JSON.parse(await readFile(path, 'utf8')).result.status).toBe('published')
    expect(await h.fixture.client.artifactVersion.count()).toBe(writesBefore)
    expect(await readFile(join(h.fixture.storageRoot, row.contentStorageKey))).toEqual(
      immutableBefore
    )
    expect(saveCount).toBe(1)
    expect(replay).not.toHaveBeenCalled()
    expect(h.kernelExecute).not.toHaveBeenCalled()
  },
  30_000
)
