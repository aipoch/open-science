import { configureTestElectronHost } from '../../../test/runtime-host'
import { createHash } from 'node:crypto'
import { access, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { RunObservationArchive } from '../../shared/run-observation-archive'
import type { RecordedObservationTarget } from '../../shared/run-observation-recorded'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ManagedResearchEnvironmentOwner } from '../notebook/managed-research-environment'
import { createSessionOperationTestHarness } from '../notebook/session-operation.test-support'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from '../session-package/service'
import { initDataRoot } from '../storage-root'
import { UploadRepository } from '../uploads/repository'
import { ObservationMediaCollector, type ObservationMediaTarget } from './media-collector'
import type { ObservationMediaCaptureResult } from '../../shared/run-observation-capture'
import { RunObservationOwner } from './owner'
import { readObservationProjectExport } from './project-export-reader'
import { createRecordedObservationReader, type RecordedObservationReader } from './recorded-reader'
import { RunObservationRecorder } from './recorder'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
await configureTestElectronHost(await import('electron'))

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const scope = { projectId: 'project-1', sessionId: 'session-1' }
const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
function receivingReader(
  fixture: Fixture,
  importer: SessionPackageService,
  receiving: { projectId: string; sessionId: string }
): RecordedObservationReader {
  const versions = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const sessions = new SessionRepository(fixture.storageRoot)
  const provenance = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
  })
  return createRecordedObservationReader({
    immutableInputAuthority: new ImmutableInputAuthority({
      storageRoot: fixture.storageRoot,
      managedFileVersions: versions
    }),
    projectFilesRepository: new ManagedFileIndexRepository(
      async () => fixture.client,
      fixture.storageRoot,
      versions,
      new UploadRepository(fixture.storageRoot, { getClient: async () => fixture.client })
    ),
    artifactProvenanceRepository: provenance,
    readSourceVersionMapping: async () => (await importer.readOrigin(receiving)).identities,
    authorizeScope: async (target) => {
      if (
        target.projectId !== receiving.projectId ||
        target.sessionId !== receiving.sessionId ||
        !(await sessions.loadSession(target.projectId, target.sessionId))
      )
        throw new Error('Wrong receiving scope')
    }
  })
}

it.skipIf(process.platform === 'win32')(
  'carries an actual managed PNG capture through ordinary Artifacts and .science import after releasing its original runtime and cache',
  async () => {
    // This is a bounded process/provenance fixture, not a scientific experiment or OS sandbox test.
    const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
    const png = await sharp({
      create: { width: 24, height: 16, channels: 3, background: '#457ac1' }
    })
      .png()
      .toBuffer()
    const checksum = digest(png)
    const executable = await realpath(process.execPath)
    const environments = new ManagedResearchEnvironmentOwner({
      dataRoot: h.fixture.storageRoot,
      socketRoot: await realpath(tmpdir()),
      verifyRuntime: async (runtime) => {
        expect(runtime.executable).toBe(executable)
      },
      stopExecution: async (identity) => ({
        verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true })).reaped
      })
    })
    cleanups.push(() => environments.close())
    const prepared = await environments.prepare({
      ...scope,
      requestId: 'captured-image-environment',
      authority: {
        source: { ...scope, identity: 'image-fixture-input' },
        versions: [
          {
            versionId: 'input-image',
            sourceIdentity: 'image-fixture-input',
            filename: 'frame.png',
            sha256: checksum,
            sizeBytes: png.length
          }
        ],
        readVersion: async (versionId) => {
          expect(versionId).toBe('input-image')
          return png
        }
      },
      materials: { files: [{ versionId: 'input-image', restorePath: 'frame.png' }] },
      runtime: {
        kind: 'node',
        executable,
        version: process.versions.node,
        sha256: digest(await readFile(executable)),
        platform: process.platform as 'darwin' | 'linux',
        arch: process.arch,
        readOnlyRoots: [dirname(executable)]
      }
    })
    const collector = new ObservationMediaCollector()
    cleanups.push(() => collector.close())
    let target: ObservationMediaTarget | undefined
    let archive: RunObservationArchive | undefined
    let savedArchive: ArtifactVersionFile | undefined
    let capture: ObservationMediaCaptureResult | undefined
    let outputRoot = ''
    const observer = new RunObservationOwner({
      authorize: async (selected) => {
        expect(selected.projectId).toBe(scope.projectId)
        expect(selected.sessionId).toBe(scope.sessionId)
        expect(await h.read(scope)).toBeDefined()
      },
      read: async (selected) => {
        const matches = (
          await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
        ).filter(
          (run) =>
            run.executionInvocationId === selected.executionInvocationId &&
            run.runId === selected.runId
        )
        if (matches.length !== 1) return undefined
        const run = matches[0]
        return {
          identity: { ...selected, runId: run.runId, environmentId: prepared.environmentId },
          phase:
            run.status === 'running'
              ? 'running'
              : run.status === 'completed'
                ? 'completed'
                : 'failed',
          run,
          artifacts: [],
          privatePaths: [h.fixture.storageRoot, outputRoot]
        }
      }
    })
    cleanups.push(async () => observer.close())
    const recorder = new RunObservationRecorder({
      dataRoot: h.fixture.storageRoot,
      intervalMs: 60_000,
      read: (selected) => observer.snapshot(selected, { viewerId: 'main-package-capture' })
    })
    cleanups.push(() => recorder.close())
    const requestId = 'capture-and-package'
    await h.owner.start({
      ...scope,
      requestId,
      requestFingerprint: digest(requestId),
      requestText:
        'Capture the declared engineering fixture image and preserve its real Run evidence.',
      execute: async (context, signal) => {
        const executionInvocationId = 'capture-package-invocation'
        await environments.withExecution(
          { ...scope, environmentId: prepared.environmentId, executionInvocationId, signal },
          async (environment) => {
            outputRoot = environment.outputRoot
            const execution = h.notebook.executeManagedShell(
              {
                ...scope,
                workspaceCwd: context.workspaceCwd,
                executionInvocationId,
                rootExecutionId: context.operationId,
                provenanceContext: context.provenanceContext,
                command:
                  'cp "$OPEN_SCIENCE_INPUT_DIR/frame.png" "$OPEN_SCIENCE_OUTPUT_DIR/frame.png"; printf ready; while [ ! -f "$OPEN_SCIENCE_OUTPUT_DIR/done" ]; do sleep 0.01; done',
                timeoutMs: 20_000
              },
              environment.capability,
              environment.signal
            )
            // Attach a handler immediately; cleanup below still observes and asserts the actual result.
            void execution.catch(() => undefined)
            let registration: ReturnType<ObservationMediaCollector['register']> | undefined
            try {
              await vi.waitFor(
                async () => {
                  expect(await readFile(join(environment.outputRoot, 'frame.png'))).toEqual(png)
                  const runs = await h.fixture.notebookRepository.readSessionRuns(
                    scope.projectId,
                    scope.sessionId
                  )
                  const running = runs.find(
                    (run) =>
                      run.executionInvocationId === executionInvocationId &&
                      run.status === 'running'
                  )
                  expect(running).toBeDefined()
                  target = {
                    ...scope,
                    operationId: context.operationId,
                    executionInvocationId,
                    runId: running!.runId
                  }
                },
                { timeout: 5000 }
              )
              const recording = await recorder.start(target!)
              const authority = environment.createOutputAuthority(context.operationId)
              registration = collector.register({
                target: target!,
                generationId: prepared.directoryNonce,
                recording,
                signal: environment.signal,
                assertCurrent: () => environment.signal.throwIfAborted(),
                sampleCurrent: async (captureSignal) => {
                  captureSignal.throwIfAborted()
                  await recording.sample()
                  return (await recorder.load(target!))!.history.snapshots.at(-1)!
                },
                projectExports: ['frame.png'],
                readProjectExport: (path, captureSignal) =>
                  readObservationProjectExport({
                    authority,
                    scope: { ...scope, operationId: context.operationId },
                    path,
                    signal: captureSignal
                  }),
                saveAuxiliaryOutput: (output) => context.saveAuxiliaryOutput!(output)
              })
              const captureStarted = Date.now()
              capture = await collector.capture(
                target!,
                { source: 'project-export', exportKey: 'frame.png', idempotencyKey: 'first-frame' },
                { assertAuthorized: () => signal.throwIfAborted(), signal }
              )
              expect(capture.capture).toMatchObject({
                source: 'project-export',
                association: 'current-observation',
                width: 24,
                height: 16
              })
              expect(capture.capture.startedAt).toBeGreaterThanOrEqual(captureStarted)
              expect(capture.capture.finishedAt).toBeGreaterThanOrEqual(capture.capture.startedAt)
              // Unchanged Run evidence keeps its original observation time; media capture has
              // its own trusted time bracket and is associated with that exact retained step.
              expect(capture.capture.observedAt).toBeLessThanOrEqual(Date.now())
              expect(capture).toMatchObject({
                checksum,
                sizeBytes: png.length,
                publication: 'awaiting-publication'
              })
              expect(
                collector.readFrame(target!, capture.captureId, {
                  assertAuthorized: () => undefined
                })?.bytes
              ).toEqual(png)
              await registration.close()
              await writeFile(join(environment.outputRoot, 'done'), '')
              expect((await execution).exitCode).toBe(0)
              expect(
                await h.notebook.confirmManagedShellCleanup({ ...scope, executionInvocationId })
              ).toMatchObject({ reaped: true })
              await context.recordRun(target!.runId)
              archive = await recording.finish()
              expect(archive?.coverage).toMatchObject({
                stopReason: 'run-ended',
                terminalRunObserved: true
              })
              expect(archive!.media[0]).toMatchObject({
                sourceVersionId: capture.versionId,
                checksum,
                stepKeys: [capture.stepKey],
                capture: capture.capture
              })
              const saved = await context.saveAuxiliaryOutput!({
                filename: `replay-${recording.recordingId}.json`,
                contentType: 'application/json',
                source: { kind: 'inline', content: JSON.stringify(archive) }
              })
              expect(saved.status).toBe('saved')
              if (saved.status === 'saved') savedArchive = saved.artifact
            } finally {
              await registration?.close()
              await writeFile(join(environment.outputRoot, 'done'), '').catch(() => undefined)
              await execution
            }
          }
        )
        return { text: 'Captured image and sampled Run evidence are saved as ordinary Artifacts.' }
      }
    })
    const settled = await h.owner.wait({ ...scope, requestId })
    expect(settled, settled?.error).toMatchObject({
      status: 'completed',
      notebookRunIds: [expect.any(String)]
    })
    expect(target).toBeDefined()
    expect(capture).toBeDefined()
    expect(savedArchive).toBeDefined()
    expect(archive).toBeDefined()
    expect(h.kernelExecute).not.toHaveBeenCalled()
    for (const versionId of [capture!.versionId, savedArchive!.versionId]) {
      const row = await h.fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })
      expect(row.state).toBe('finalized')
      expect(row.producerRunId).toBeNull()
      expect(row.notebookSessionId).toBeNull()
    }
    const mediaRow = await h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: capture!.versionId }
    })
    expect(await readFile(join(h.fixture.storageRoot, mediaRow.contentStorageKey))).toEqual(png)
    expect(
      archive!.records.every((record) => record.sourceEvidence.identity.runId === target!.runId)
    ).toBe(true)
    expect(archive!.records.every((record) => !record.run || !('runId' in record.run))).toBe(true)
    expect(archive!.records.find((record) => record.stepKey === capture!.stepKey)?.observedAt).toBe(
      capture!.capture.observedAt
    )
    expect(JSON.stringify(archive)).not.toContain(h.fixture.storageRoot)

    // Dispose the live collector and release the actual environment before packaging. Neither
    // the original output directory nor the temporary recorder/collector caches can serve reads.
    await collector.close()
    expect(
      collector.readFrame(target!, capture!.captureId, { assertAuthorized: () => undefined })
    ).toBeUndefined()
    expect(
      await environments.release({ ...scope, environmentId: prepared.environmentId })
    ).toMatchObject({ state: 'released' })
    await expect(access(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await recorder.close()
    observer.close()
    await rm(join(h.fixture.storageRoot, 'managed-run-observations'), {
      recursive: true,
      force: true
    })
    await h.snapshots.captureFinalizedMessages((await h.read(scope))!)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    cleanups.push(() => exporter.close())
    const packagePath = join(h.fixture.storageRoot, 'actual-captured-image.science')
    await exporter.exportTo(scope, packagePath)
    const receiving = await createProvenanceTestFixture()
    cleanups.push(receiving.dispose)
    initDataRoot(receiving.storageRoot)
    const importer = new SessionPackageService({
      storageRoot: receiving.storageRoot,
      getClient: async () => receiving.client
    })
    cleanups.push(() => importer.close())
    const imported = await importer.importFrom(packagePath)
    const origin = await importer.readOrigin(imported)
    const receivingTarget: RecordedObservationTarget = {
      ...imported,
      artifactId: origin.identities[savedArchive!.artifactId],
      versionId: origin.identities[savedArchive!.versionId]
    }
    const receivedMediaVersion = origin.identities[capture!.versionId]
    expect(receivingTarget.sessionId).not.toBe(scope.sessionId)
    expect(receivingTarget.versionId).not.toBe(savedArchive!.versionId)
    expect(receivedMediaVersion).not.toBe(capture!.versionId)
    const reader = receivingReader(receiving, importer, imported)
    const received = await reader.read(receivingTarget)
    expect(received.receiving).toEqual(receivingTarget)
    expect(received.archive).toEqual(archive)
    expect(received.media).toEqual([
      {
        mediaKey: capture!.captureId,
        artifactId: origin.identities[capture!.artifactId],
        versionId: receivedMediaVersion,
        checksum,
        sizeBytes: png.length
      }
    ])
    expect(received.archive.media[0].capture).toEqual(capture!.capture)
    expect(received.archive.media[0].stepKeys).toEqual([capture!.stepKey])
    const image = await reader.readMedia(receivingTarget, capture!.captureId)
    expect(image.mimeType).toBe('image/png')
    expect(Buffer.from(image.body)).toEqual(png)
    expect(digest(image.body)).toBe(checksum)
    expect(await sharp(image.body).metadata()).toMatchObject({
      format: 'png',
      width: 24,
      height: 16
    })
    const receivedVersion = await receiving.client.artifactVersion.findUniqueOrThrow({
      where: { id: receivedMediaVersion }
    })
    expect(receivedVersion.producerRunId).toBeNull()
    const receivedRuns = await receiving.notebookRepository.readSessionRuns(
      imported.projectId,
      imported.sessionId
    )
    expect(receivedRuns).toHaveLength(1)
    expect(receivedRuns[0].runId).toBe(origin.identities[target!.runId])
    expect(receivedRuns[0].runId).not.toBe(target!.runId)
    expect(receivedRuns[0].status).toBe('completed')
    // The archive's author Run ID is immutable source evidence, not that receiver-local Run.
    expect(received.archive.records[0].sourceEvidence.identity.runId).toBe(target!.runId)
    await expect(
      reader.read({ ...receivingTarget, sessionId: scope.sessionId })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  },
  60_000
)
