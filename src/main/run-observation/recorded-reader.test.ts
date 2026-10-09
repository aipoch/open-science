import { createHash } from 'node:crypto'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordedObservationTarget } from '../../shared/run-observation-recorded'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import type { RunObservationArchive } from '../../shared/run-observation-archive'
import { validateProjectRecording } from '../../shared/project-recording'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createPngBytes } from '../artifacts/artifact-test-fixtures'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from '../session-package/service'
import { initDataRoot } from '../storage-root'
import { UploadRepository } from '../uploads/repository'
import { buildRunObservationArchive } from './archive'
import { createRecordedObservationReader, type RecordedObservationReader } from './recorded-reader'
import { ManagedRunObservationCoordinator } from './managed-coordinator'
import { RunObservationRecorder } from './recorder'
import { browserRecordedFixture } from './browser-recorded.test-support'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})
const scope = { projectId: 'project-1', sessionId: 'session-1' }
const bytes = createPngBytes('recorded-project-screen')
const checksum = createHash('sha256').update(bytes).digest('hex')
const snapshot: RunObservationSnapshot = {
  identity: { projectId: 'author-project', sessionId: 'author-session', runId: 'author-run' },
  cursor: { epoch: 'author-epoch', sequence: 0 },
  observedAt: 100,
  phase: 'completed',
  stepId: 'run:author-run',
  artifacts: [],
  artifactsTruncated: false,
  run: {
    runId: 'author-run',
    kernelKind: 'bash',
    status: 'completed',
    startedAt: 10,
    endedAt: 99,
    logs: {
      stdout: { text: 'recorded output', truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  }
}
function adapters(fixture: Fixture): {
  versions: ManagedFileVersionService
  authority: ImmutableInputAuthority
  files: ManagedFileIndexRepository
  provenance: ArtifactProvenanceRepository
} {
  const versions = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const authority = new ImmutableInputAuthority({
    storageRoot: fixture.storageRoot,
    managedFileVersions: versions
  })
  const files = new ManagedFileIndexRepository(
    async () => fixture.client,
    fixture.storageRoot,
    versions,
    new UploadRepository(fixture.storageRoot, { getClient: async () => fixture.client })
  )
  const provenance = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: (projectId, sessionId) =>
      new SessionRepository(fixture.storageRoot).loadSession(projectId, sessionId)
  })
  return { versions, authority, files, provenance }
}
async function setup(): Promise<{
  fixture: Fixture
  reader: RecordedObservationReader
  target: RecordedObservationTarget
  archive: RunObservationArchive
  media: Awaited<ReturnType<ManagedFileVersionService['adoptLegacyArtifact']>>
  versions: ManagedFileVersionService
  authority: ImmutableInputAuthority
  files: ManagedFileIndexRepository
  provenance: ArtifactProvenanceRepository
  authorize: (target: RecordedObservationTarget) => Promise<void>
  revoke(): void
}> {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  initDataRoot(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: scope.projectId, name: 'Recorded research' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: scope.sessionId,
    projectId: scope.projectId,
    title: 'Recorded research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  const { versions, authority, files, provenance } = adapters(fixture)
  const media = await versions.adoptLegacyArtifact({
    ...scope,
    sourceFileId: 'local-screen',
    logicalFilename: 'imported-capture.png',
    content: bytes,
    contentType: 'image/png'
  })
  const archive = buildRunObservationArchive({
    recordingId: 'recording-1',
    history: { coverage: 'process-local', truncated: false, snapshots: [snapshot] },
    capturedAt: 110,
    stopReason: 'run-ended',
    media: [
      {
        mediaKey: 'frame-0',
        name: 'capture.png',
        mimeType: 'image/png',
        checksum,
        sizeBytes: bytes.length,
        sourceVersionId: media.versionId,
        stepKeys: ['observation-0']
      }
    ]
  })
  const observation = await versions.adoptLegacyArtifact({
    ...scope,
    sourceFileId: 'local-observation',
    logicalFilename: 'observation.json',
    content: Buffer.from(JSON.stringify(archive)),
    contentType: 'application/json'
  })
  let authorized = true
  const authorize = vi.fn(async (target: RecordedObservationTarget) => {
    if (!authorized || target.projectId !== scope.projectId || target.sessionId !== scope.sessionId)
      throw new Error('private scope diagnostic')
  })
  const reader = createRecordedObservationReader({
    immutableInputAuthority: authority,
    projectFilesRepository: files,
    artifactProvenanceRepository: provenance,
    authorizeScope: authorize
  })
  return {
    fixture,
    versions,
    authority,
    files,
    provenance,
    archive,
    media,
    reader,
    authorize,
    target: { ...scope, artifactId: observation.fileId, versionId: observation.versionId },
    revoke: () => {
      authorized = false
    }
  }
}

describe('receiving-session recorded observation reader', () => {
  it('selects the exact readable receiving file without constructing a step or author-side Run', async () => {
    const h = await setup()
    const selection = await h.reader.selectFile({ target: h.target, mediaKey: 'frame-0' })
    expect(selection).toMatchObject({
      kind: 'recorded-observation-file',
      source: 'run-observation',
      stage: 'unspecified',
      receiving: h.target,
      scope: 'step',
      stepKeys: ['observation-0'],
      resource: {
        ...scope,
        artifactId: h.media.fileId,
        versionId: h.media.versionId,
        checksum,
        sizeBytes: bytes.length
      }
    })
    expect(selection).not.toHaveProperty('stepId')
    expect(selection).not.toHaveProperty('record')
    await expect(
      h.reader.selectFile({ target: h.target, mediaKey: 'not-declared' })
    ).rejects.toMatchObject({ code: 'media-unavailable' })
    h.revoke()
    await expect(
      h.reader.selectFile({ target: h.target, mediaKey: 'frame-0' })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('keeps browser segment and moment authority across a real .science roundtrip without a Run', async () => {
    const h = await setup()
    const fixture = browserRecordedFixture()
    const media = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'web-segment',
      logicalFilename: 'segment.webm',
      content: fixture.bytes,
      contentType: 'video/webm'
    })
    const recording = {
      ...fixture.payload.recording,
      media: [{ ...fixture.payload.recording.media[0], sourceVersionId: media.versionId }]
    }
    const index = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'web-index',
      logicalFilename: 'web-recording.json',
      content: Buffer.from(JSON.stringify(recording)),
      contentType: 'application/json'
    })
    const target = { ...scope, artifactId: index.fileId, versionId: index.versionId }
    expect((await h.reader.readBrowser(target)).recording).toEqual(recording)
    expect((await h.reader.selectBrowserMoment(target, 1500)).resource.versionId).toBe(
      media.versionId
    )
    await expect(h.reader.selectBrowserMoment(target, 3000)).rejects.toMatchObject({
      code: 'media-unavailable'
    })
    await expect(h.reader.selectBrowserMoment(target, -1)).rejects.toMatchObject({
      code: 'media-unavailable'
    })
    const receiving = await createProvenanceTestFixture()
    fixtures.push(receiving)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    const importer = new SessionPackageService({
      storageRoot: receiving.storageRoot,
      getClient: async () => receiving.client
    })
    try {
      const path = join(h.fixture.storageRoot, 'browser-recording.science')
      await exporter.exportTo(scope, path)
      initDataRoot(receiving.storageRoot)
      const imported = await importer.importFrom(path)
      const origin = await importer.readOrigin(imported)
      const receivedTarget = {
        projectId: imported.projectId,
        sessionId: imported.sessionId,
        artifactId: origin.identities[index.fileId],
        versionId: origin.identities[index.versionId]
      }
      const dependencies = adapters(receiving)
      const reader = createRecordedObservationReader({
        immutableInputAuthority: dependencies.authority,
        projectFilesRepository: dependencies.files,
        artifactProvenanceRepository: dependencies.provenance,
        authorizeScope: async (request) => {
          expect(request.projectId).toBe(imported.projectId)
          expect(request.sessionId).toBe(imported.sessionId)
        },
        readSourceVersionMapping: (current, identity) =>
          importer.readArtifactSourceVersionMapping(imported, {
            artifactId: current.artifactId,
            versionId: current.versionId,
            checksum: identity.checksum,
            sizeBytes: identity.sizeBytes
          })
      })
      expect((await reader.readBrowser(receivedTarget)).recording).toEqual(recording)
      expect(await reader.readBrowserMedia(receivedTarget, 'segment-a')).toEqual({
        body: new Uint8Array(fixture.bytes),
        mimeType: 'video/webm'
      })
      const selected = await reader.selectBrowserMoment(receivedTarget, 1500)
      expect(selected).toMatchObject({
        receiving: receivedTarget,
        offsetMs: 1500,
        segmentOffsetMs: 1500,
        resource: { versionId: origin.identities[media.versionId] }
      })
      expect(selected.resource.versionId).not.toBe(media.versionId)
      expect(selected).not.toHaveProperty('stepKey')
      expect(
        (
          await new SessionRepository(receiving.storageRoot).loadSession(
            imported.projectId,
            imported.sessionId
          )
        )?.activeRun
      ).toBeUndefined()
      await expect(reader.readBrowserMedia(receivedTarget, '../segment')).rejects.toMatchObject({
        code: 'media-unavailable'
      })
    } finally {
      await exporter.close()
      await importer.close()
    }
  })
  it('reads an independent project recording and its historical media after a real .science roundtrip', async () => {
    const h = await setup()
    const recording = validateProjectRecording({
      format: 'open-science-project-recording',
      version: 1,
      recordingId: 'project-recording',
      startedAt: 0,
      endedAt: 10,
      frames: [],
      states: [],
      events: [],
      media: [
        {
          mediaKey: 'result',
          name: 'result.png',
          mimeType: 'image/png',
          checksum,
          sizeBytes: bytes.length,
          sourceVersionId: h.media.versionId
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
    })
    const index = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'project-recording-index',
      logicalFilename: 'project-recording.json',
      content: Buffer.from(JSON.stringify(recording)),
      contentType: 'application/json'
    })
    const originalTarget = { ...scope, artifactId: index.fileId, versionId: index.versionId }
    expect((await h.reader.readProject(originalTarget)).recording).toEqual(recording)
    const originalSelection = await h.reader.selectFile({
      target: originalTarget,
      mediaKey: 'result',
      format: 'project-recording'
    })
    expect(originalSelection).toMatchObject({
      scope: 'recording',
      stepKeys: [],
      stage: 'unspecified'
    })
    // A second name with exactly the same bytes must not choose a random immutable Version.
    const duplicate = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'duplicate-result',
      logicalFilename: 'duplicate.png',
      content: bytes,
      contentType: 'image/png'
    })
    expect((await h.reader.readProject(originalTarget)).media).toEqual([])
    await expect(
      h.reader.selectFile({
        target: originalTarget,
        mediaKey: 'result',
        format: 'project-recording'
      })
    ).rejects.toMatchObject({ code: 'media-unavailable' })
    expect(duplicate.versionId).not.toBe(h.media.versionId)
    const receiving = await createProvenanceTestFixture()
    fixtures.push(receiving)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    const importer = new SessionPackageService({
      storageRoot: receiving.storageRoot,
      getClient: async () => receiving.client
    })
    try {
      const path = join(h.fixture.storageRoot, 'project-recording.science')
      await exporter.exportTo(scope, path)
      initDataRoot(receiving.storageRoot)
      const imported = await importer.importFrom(path)
      const origin = await importer.readOrigin(imported)
      const target = {
        projectId: imported.projectId,
        sessionId: imported.sessionId,
        artifactId: origin.identities[index.fileId],
        versionId: origin.identities[index.versionId]
      }
      const { authority, files, provenance } = adapters(receiving)
      const reader = createRecordedObservationReader({
        immutableInputAuthority: authority,
        projectFilesRepository: files,
        artifactProvenanceRepository: provenance,
        authorizeScope: async (request) => {
          expect(request.projectId).toBe(imported.projectId)
          expect(request.sessionId).toBe(imported.sessionId)
        },
        readSourceVersionMapping: (current, identity) =>
          importer.readArtifactSourceVersionMapping(imported, {
            artifactId: current.artifactId,
            versionId: current.versionId,
            checksum: identity.checksum,
            sizeBytes: identity.sizeBytes
          })
      })
      const payload = await reader.readProject(target)
      expect(payload.recording).toEqual(recording)
      expect(payload.media).toEqual([
        {
          mediaKey: 'result',
          artifactId: origin.identities[h.media.fileId],
          versionId: origin.identities[h.media.versionId],
          checksum,
          sizeBytes: bytes.length
        }
      ])
      expect(await reader.readProjectMedia(target, 'result')).toEqual({
        body: new Uint8Array(bytes),
        mimeType: 'image/png'
      })
      const selected = await reader.selectFile({
        target,
        mediaKey: 'result',
        format: 'project-recording'
      })
      expect(selected.resource.versionId).toBe(origin.identities[h.media.versionId])
      expect(selected.receiving).toEqual(target)
      expect(selected).not.toHaveProperty('record')
      const session = await new SessionRepository(receiving.storageRoot).loadSession(
        imported.projectId,
        imported.sessionId
      )
      expect(session?.activeRun).toBeUndefined()
    } finally {
      await exporter.close()
      await importer.close()
    }
  }, 60000)
  async function advanceMediaHead(h: Awaited<ReturnType<typeof setup>>): Promise<void> {
    const version = await h.provenance.writeAppGeneratedVersion({
      projectId: scope.projectId,
      appSessionId: scope.sessionId,
      artifactStorageSessionId: scope.sessionId,
      artifactRunId: 'newer-screen-run',
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      filename: 'imported-capture.png',
      content: createPngBytes('newer-project-screen').toString('base64'),
      encoding: 'base64',
      contentType: 'image/png'
    })
    await h.fixture.client.artifactVersion.update({
      where: { id: version.versionId },
      data: { state: 'finalized', managedVisibleAt: new Date() }
    })
    await h.fixture.client.artifactLineage.update({
      where: { id: version.artifactId },
      data: { currentVersionId: version.versionId }
    })
    expect(version.artifactId).toBe(h.media.fileId)
    expect(version.versionNumber).toBe(2)
    expect(
      (await h.files.readExportFiles(scope)).find((file) => file.sourceFileId === h.media.fileId)
        ?.sourceVersionId
    ).toBe(version.versionId)
  }

  it('reads exact published bytes while preserving author identities only as evidence', async () => {
    const h = await setup()
    const list = vi.spyOn(h.files, 'readExportFiles')
    const result = await h.reader.read(h.target)
    expect(result.receiving).toEqual(h.target)
    expect(result.archive).toEqual(h.archive)
    expect(result.executionContext).toEqual({ purpose: 'unknown', conditionChanges: [] })
    expect(result.archive.records[0].sourceEvidence.identity.runId).toBe('author-run')
    expect(result.archive.records[0].run).not.toHaveProperty('runId')
    expect(result.media).toEqual([
      {
        mediaKey: 'frame-0',
        artifactId: h.media.fileId,
        versionId: h.media.versionId,
        checksum,
        sizeBytes: bytes.length
      }
    ])
    expect(list).toHaveBeenCalledWith(scope)
    expect(await h.reader.readMedia(h.target, 'frame-0')).toEqual({
      body: new Uint8Array(bytes),
      mimeType: 'image/png'
    })
    await expect(
      h.reader.read({ ...h.target, versionId: h.media.versionId })
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      h.reader.read({ ...h.target, sessionId: 'unrelated-session' })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('excludes unpublished media and refuses an unpublished archive without producer privileges', async () => {
    const h = await setup()
    await h.fixture.client.artifactVersion.update({
      where: { id: h.media.versionId },
      data: {
        originKind: 'agent_generated',
        managedVisibleAt: null,
        artifactRunId: 'unpublished-run',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        evidenceStorageKey: 'unpublished-evidence.json',
        evidenceJson: '{}',
        evidenceChecksum: createHash('sha256').update('{}').digest('hex'),
        evidenceSchemaVersion: 1
      }
    })
    expect((await h.reader.read(h.target)).media).toEqual([])
    await expect(h.reader.readMedia(h.target, 'frame-0')).rejects.toMatchObject({
      code: 'media-unavailable'
    })
    await h.fixture.client.artifactVersion.update({
      where: { id: h.target.versionId },
      data: { state: 'pending' }
    })
    await expect(h.reader.read(h.target)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not choose an ambiguous media match, and only a trusted receiving mapping can disambiguate', async () => {
    const h = await setup()
    const duplicate = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'duplicate',
      logicalFilename: 'duplicate.png',
      content: bytes,
      contentType: 'image/png'
    })
    expect((await h.reader.read(h.target)).media).toEqual([])
    const mapped = createRecordedObservationReader({
      immutableInputAuthority: h.authority,
      projectFilesRepository: h.files,
      authorizeScope: h.authorize,
      readSourceVersionMapping: async () => ({ [h.media.versionId]: duplicate.versionId })
    })
    expect((await mapped.read(h.target)).media[0].versionId).toBe(duplicate.versionId)
    await expect(h.reader.readMedia(h.target, 'author-run')).rejects.toMatchObject({
      code: 'media-unavailable'
    })
  })

  it('never resolves equal bytes from another Session or a repository adapter with an over-broad result', async () => {
    const h = await setup()
    const foreign = await h.versions.adoptLegacyArtifact({
      ...scope,
      sessionId: 'foreign-session',
      sourceFileId: 'foreign-screen',
      logicalFilename: 'capture.png',
      content: bytes,
      contentType: 'image/png'
    })
    const foreignRows = await h.files.readExportFiles({ ...scope, sessionId: 'foreign-session' })
    expect(foreignRows[0].sourceVersionId).toBe(foreign.versionId)
    vi.spyOn(h.files, 'readExportFiles').mockResolvedValue(foreignRows)
    vi.spyOn(h.provenance, 'resolvePublishedSessionVersionsByContent').mockResolvedValue([
      {
        ...scope,
        sessionId: 'foreign-session',
        artifactId: foreign.fileId,
        versionId: foreign.versionId,
        name: 'capture.png',
        checksum,
        size: bytes.length,
        state: 'finalized',
        isPublished: true
      }
    ])
    expect((await h.reader.read(h.target)).media).toEqual([])
  })

  it('does not use a matching archive filename to choose between equal-content historical Versions', async () => {
    const h = await setup()
    await advanceMediaHead(h)
    await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'same-content-named-copy',
      logicalFilename: h.archive.media[0].name,
      content: bytes,
      contentType: 'image/png'
    })
    expect((await h.reader.read(h.target)).media).toEqual([])
  })

  it('reads a recorded historical published Version after the same Artifact advances', async () => {
    const h = await setup()
    await advanceMediaHead(h)
    expect((await h.reader.read(h.target)).media[0]).toMatchObject({
      artifactId: h.media.fileId,
      versionId: h.media.versionId
    })
    expect((await h.reader.readMedia(h.target, 'frame-0')).body).toEqual(new Uint8Array(bytes))
    await h.fixture.client.artifactVersion.update({
      where: { id: h.media.versionId },
      data: { state: 'pending' }
    })
    expect((await h.reader.read(h.target)).media).toEqual([])
  })

  it('finds historical media after import, working-copy export and re-import without relying on sender IDs', async () => {
    const h = await setup()
    await advanceMediaHead(h)
    let sourceFixture = h.fixture
    let sourceTarget = h.target
    let previousMediaVersion = h.media.versionId
    for (let hop = 0; hop < 2; hop++) {
      const receiving = await createProvenanceTestFixture()
      fixtures.push(receiving)
      const exporter = new SessionPackageService({
        storageRoot: sourceFixture.storageRoot,
        getClient: async () => sourceFixture.client
      })
      const importer = new SessionPackageService({
        storageRoot: receiving.storageRoot,
        getClient: async () => receiving.client
      })
      try {
        const path = join(sourceFixture.storageRoot, `historical-${hop}.science`)
        await exporter.exportTo(
          { projectId: sourceTarget.projectId, sessionId: sourceTarget.sessionId },
          path
        )
        initDataRoot(receiving.storageRoot)
        const imported = await importer.importFrom(path)
        const origin = await importer.readOrigin(imported)
        const target = {
          projectId: imported.projectId,
          sessionId: imported.sessionId,
          artifactId: origin.identities[sourceTarget.artifactId],
          versionId: origin.identities[sourceTarget.versionId]
        }
        const { authority, files, provenance } = adapters(receiving)
        expect(typeof target.artifactId, `hop ${hop} receiving Artifact`).toBe('string')
        expect(typeof target.versionId, `hop ${hop} receiving Version`).toBe('string')
        expect(
          await provenance.resolvePublishedSessionVersionsByContent({
            projectId: imported.projectId,
            appSessionId: imported.sessionId,
            contents: [{ checksum, sizeBytes: bytes.length }]
          })
        ).toHaveLength(1)
        const reader = createRecordedObservationReader({
          immutableInputAuthority: authority,
          projectFilesRepository: files,
          artifactProvenanceRepository: provenance,
          readSourceVersionMapping: async () => (await importer.readOrigin(imported)).identities,
          authorizeScope: async (request) => {
            expect(request.projectId).toBe(imported.projectId)
            expect(request.sessionId).toBe(imported.sessionId)
          }
        })
        const payload = await reader.read(target)
        expect(payload.archive).toEqual(h.archive)
        expect(payload.archive.media[0].sourceVersionId).toBe(h.media.versionId)
        const remapped = origin.identities[previousMediaVersion]
        expect(remapped).toBeDefined()
        expect(payload.media[0]?.versionId).toBe(remapped)
        if (hop === 1) expect(origin.identities[h.media.versionId]).toBeUndefined()
        expect((await reader.readMedia(target, 'frame-0')).body).toEqual(new Uint8Array(bytes))
        sourceFixture = receiving
        sourceTarget = target
        previousMediaVersion = remapped
        if (hop === 0) {
          // A read-only re-export forwards the original package. Export a receiving working copy
          // to exercise actual second-hop local IDs without rewriting immutable archive bytes.
          const copy = await importer.fork(imported)
          const copyOrigin = await importer.readOrigin(copy)
          sourceTarget = {
            ...copy,
            artifactId: copyOrigin.identities[h.target.artifactId],
            versionId: copyOrigin.identities[h.target.versionId]
          }
          previousMediaVersion = copyOrigin.identities[h.media.versionId]
        }
      } finally {
        await exporter.close()
        await importer.close()
      }
    }
  }, 60000)

  it('verifies actual media bytes again and returns no internal paths when stored content is corrupt', async () => {
    const h = await setup()
    expect((await h.reader.read(h.target)).media).toHaveLength(1)
    const path = join(h.fixture.storageRoot, h.media.storageRef)
    await chmod(path, 0o600)
    await writeFile(path, Buffer.alloc(bytes.length, 1))
    await expect(h.reader.readMedia(h.target, 'frame-0')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The recorded observation is unavailable.'
    })
  })

  it('fails strict archive parsing with a fixed error instead of returning partial or executable content', async () => {
    const h = await setup()
    const invalid = await h.versions.adoptLegacyArtifact({
      ...scope,
      sourceFileId: 'invalid-archive',
      logicalFilename: 'invalid.json',
      content: Buffer.from(
        JSON.stringify({ ...h.archive, serviceUrl: 'http://localhost/private-management' })
      ),
      contentType: 'application/json'
    })
    await expect(
      h.reader.read({ ...scope, artifactId: invalid.fileId, versionId: invalid.versionId })
    ).rejects.toMatchObject({
      code: 'invalid-archive',
      message: 'The recorded observation archive is invalid.'
    })
  })

  it('revalidates authorization after actual disk reads and always closes the content lease', async () => {
    const h = await setup()
    const open = h.authority.openContent.bind(h.authority)
    let closed = false
    vi.spyOn(h.authority, 'openContent').mockImplementationOnce(async (...args) => {
      const lease = await open(...args)
      return {
        ...lease,
        readRange: async (begin, end) => {
          const body = await lease.readRange(begin, end)
          h.revoke()
          return body
        },
        close: async () => {
          closed = true
          await lease.close()
        }
      }
    })
    await expect(h.reader.read(h.target)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(closed).toBe(true)
  })

  it('reads an actual .science import after Artifact and Version identities are remapped', async () => {
    const h = await setup()
    const receiving = await createProvenanceTestFixture()
    fixtures.push(receiving)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    const importer = new SessionPackageService({
      storageRoot: receiving.storageRoot,
      getClient: async () => receiving.client
    })
    try {
      const path = join(h.fixture.storageRoot, 'recorded.science')
      await exporter.exportTo(scope, path)
      initDataRoot(receiving.storageRoot)
      const imported = await importer.importFrom(path)
      const origin = await importer.readOrigin(imported)
      const target = {
        projectId: imported.projectId,
        sessionId: imported.sessionId,
        artifactId: origin.identities[h.target.artifactId],
        versionId: origin.identities[h.target.versionId]
      }
      expect(target.artifactId).not.toBe(h.target.artifactId)
      expect(target.versionId).not.toBe(h.target.versionId)
      const { authority, files } = adapters(receiving)
      const reader = createRecordedObservationReader({
        immutableInputAuthority: authority,
        projectFilesRepository: files,
        authorizeScope: async (request) => {
          expect(request.projectId).toBe(imported.projectId)
          expect(request.sessionId).toBe(imported.sessionId)
        }
      })
      const payload = await reader.read(target)
      expect(payload.archive).toEqual(h.archive)
      expect(payload.media).toEqual([
        {
          mediaKey: 'frame-0',
          artifactId: origin.identities[h.media.fileId],
          versionId: origin.identities[h.media.versionId],
          checksum,
          sizeBytes: bytes.length
        }
      ])
      expect(await reader.readMedia(target, 'frame-0')).toEqual({
        body: new Uint8Array(bytes),
        mimeType: 'image/png'
      })
      const session = await new SessionRepository(receiving.storageRoot).loadSession(
        imported.projectId,
        imported.sessionId
      )
      expect(session?.packageOrigin).toBeDefined()
      expect(session?.activeRun).toBeUndefined()
    } finally {
      await exporter.close()
      await importer.close()
    }
  }, 60000)

  const attestNativeContext = async (purpose: 'research' | 'offline-demo'): Promise<void> => {
    const h = await setup()
    const runTarget = {
      ...scope,
      operationId: 'native-operation',
      executionInvocationId: 'native-invocation',
      runId: snapshot.run!.runId
    }
    const recorder = new RunObservationRecorder({
      dataRoot: h.fixture.storageRoot,
      intervalMs: 60000,
      read: async () => ({
        ...snapshot,
        identity: runTarget,
        run: { ...snapshot.run!, executionInvocationId: runTarget.executionInvocationId }
      }),
      isPublished: async (_target, reference) =>
        (
          await h.provenance.resolveVersionDescriptors({
            projectId: scope.projectId,
            appSessionId: scope.sessionId,
            versionIds: [reference.versionId]
          })
        ).some((version) => version.isPublished && version.state === 'finalized')
    })
    const coordinator = new ManagedRunObservationCoordinator({
      dataRoot: h.fixture.storageRoot,
      recorder: () => recorder,
      artifacts: h.provenance
    })
    const provenanceContext = {
      rootFrameId: 'native-root',
      agentFrameId: 'native-root',
      messageBranchId: 'native-branch',
      runtimeSegmentId: 'native-segment',
      promptMessageId: 'native-prompt'
    }
    const writePublished = async (output: {
      filename: string
      contentType?: string
      source: { content: string; encoding?: 'base64' }
    }): Promise<Awaited<ReturnType<ArtifactProvenanceRepository['writeAppGeneratedVersion']>>> => {
      const artifact = await h.provenance.writeAppGeneratedVersion({
        projectId: scope.projectId,
        appSessionId: scope.sessionId,
        artifactStorageSessionId: scope.sessionId,
        artifactRunId: 'native-artifact-run',
        ...provenanceContext,
        filename: output.filename,
        content: output.source.content,
        encoding: output.source.encoding,
        contentType: output.contentType
      })
      await h.fixture.client.artifactVersion.update({
        where: { id: artifact.versionId },
        data: { state: 'finalized', managedVisibleAt: new Date() }
      })
      await h.fixture.client.artifactLineage.update({
        where: { id: artifact.artifactId },
        data: { currentVersionId: artifact.versionId }
      })
      return artifact
    }
    const nativeMedia = await writePublished({
      filename: 'first-native-screen.png',
      contentType: 'image/png',
      source: { content: bytes.toString('base64'), encoding: 'base64' }
    })
    const duplicate = await writePublished({
      filename: 'second-screen.png',
      contentType: 'image/png',
      source: { content: bytes.toString('base64'), encoding: 'base64' }
    })
    const saveAuxiliaryOutput = vi.fn(async (output: Parameters<typeof writePublished>[0]) => ({
      status: 'saved' as const,
      artifact: await writePublished(output)
    }))
    const context = { ...scope, provenanceContext, saveAuxiliaryOutput }
    const receiving = await createProvenanceTestFixture()
    fixtures.push(receiving)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    const importer = new SessionPackageService({
      storageRoot: receiving.storageRoot,
      getClient: async () => receiving.client
    })
    try {
      const started = await coordinator.begin(runTarget, context)
      expect(started.handle).toBeDefined()
      const published = await coordinator.publish({
        target: runTarget,
        context,
        handle: started.handle,
        media: [nativeMedia, duplicate].map((version, index) => ({
          mediaKey: `native-frame-${index}`,
          name: index ? 'second-screen.png' : 'first-native-screen.png',
          mimeType: 'image/png',
          sourceVersionId: version.versionId,
          checksum,
          sizeBytes: bytes.length,
          stepKeys: ['observation-0']
        })),
        recovery: false
      })
      expect(published.result.status).toBe('published')
      const [artifact] = await h.provenance.resolveVersionDescriptors({
        projectId: scope.projectId,
        appSessionId: scope.sessionId,
        versionIds: [published.output!.versionId]
      })
      const target = { ...scope, artifactId: artifact.artifactId, versionId: artifact.versionId }
      const executionContext = {
        purpose,
        ...(purpose === 'research' ? { profileName: 'Small external baseline' } : {}),
        conditionChanges:
          purpose === 'research' ? ['Two steps instead of the original full benchmark'] : [],
        ...(purpose === 'offline-demo'
          ? {
              demoViewing: {
                mode: 'until-stop-or-timeout' as const,
                timeoutMs: 600000,
                endReason: 'process-exited' as const
              }
            }
          : {})
      }
      const collectionReceipt = {
        kind: 'managed-research-execution',
        version: 1,
        purpose: executionContext.purpose,
        ...(purpose === 'research'
          ? {
              executionProfile: {
                displayName: executionContext.profileName,
                conditionChanges: executionContext.conditionChanges,
                variables: { PRIVATE_IGNORED: 'not-part-of-viewer' }
              }
            }
          : { demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600000 } }),
        result: {
          runId: runTarget.runId,
          executionInvocationId: runTarget.executionInvocationId,
          observation: { recordingId: published.result.recordingId, versionId: target.versionId }
        }
      }
      // Its name deliberately carries no execution/receipt marker. Native membership and verified
      // content select the receipt; an arbitrary artifact name grants no authority.
      const receipt = await writePublished({
        filename: 'opaque-notes.json',
        contentType: 'application/json',
        source: { content: JSON.stringify(collectionReceipt) }
      })
      expect((await h.reader.read(target)).executionContext).toEqual(executionContext)
      // A descriptor is not byte authority: a corrupted receipt cannot label the observation.
      await chmod(receipt.path, 0o600)
      await writeFile(receipt.path, 'corrupt receipt')
      expect((await h.reader.read(target)).executionContext?.purpose).toBe('unknown')
      await writeFile(receipt.path, JSON.stringify(collectionReceipt))
      await h.fixture.client.artifactVersion.update({
        where: { id: receipt.versionId },
        data: { artifactRunId: 'unrelated-native-artifact-run' }
      })
      expect((await h.reader.read(target)).executionContext?.purpose).toBe('unknown')
      await h.fixture.client.artifactVersion.update({
        where: { id: receipt.versionId },
        data: { artifactRunId: 'native-artifact-run' }
      })
      const conflicting = await writePublished({
        filename: 'another-name.json',
        contentType: 'application/json',
        source: {
          content: JSON.stringify({
            ...collectionReceipt,
            purpose: purpose === 'research' ? 'offline-demo' : 'research',
            demoViewing: undefined
          })
        }
      })
      expect((await h.reader.read(target)).executionContext?.purpose).toBe('unknown')
      await h.fixture.client.artifactVersion.update({
        where: { id: conflicting.versionId },
        data: { managedVisibleAt: null }
      })
      const withoutAttestation = await h.reader.read(target)
      expect(withoutAttestation.executionContext).toEqual(executionContext)
      const identity = {
        recordingId: published.result.recordingId!,
        checksum: artifact.checksum!,
        sizeBytes: artifact.size,
        content: Buffer.from(JSON.stringify(withoutAttestation.archive))
      }
      // Exact same bytes and filenames alone still provide no permission to select a Version.
      expect(withoutAttestation.media).toEqual([])
      const mapping = await coordinator.readNativeSourceVersionMapping(target, identity)
      expect(mapping).toEqual({
        [nativeMedia.versionId]: nativeMedia.versionId,
        [duplicate.versionId]: duplicate.versionId
      })
      await recorder.close()
      await rm(join(h.fixture.storageRoot, 'managed-run-observations'), {
        recursive: true,
        force: true
      })
      const restarted = new ManagedRunObservationCoordinator({
        dataRoot: h.fixture.storageRoot,
        recorder: () => undefined,
        artifacts: h.provenance
      })
      const reader = createRecordedObservationReader({
        immutableInputAuthority: h.authority,
        projectFilesRepository: h.files,
        artifactProvenanceRepository: h.provenance,
        authorizeScope: h.authorize,
        readSourceVersionMapping: (target, identity) =>
          restarted.readNativeSourceVersionMapping(target, identity)
      })
      const native = await reader.read(target)
      expect(native.executionContext).toEqual(executionContext)
      expect(JSON.stringify(native)).not.toContain('not-part-of-viewer')
      expect(native.media.map((media) => media.versionId)).toEqual([
        nativeMedia.versionId,
        duplicate.versionId
      ])
      for (const media of native.media)
        expect((await reader.readMedia(target, media.mediaKey)).body).toEqual(new Uint8Array(bytes))
      for (const altered of [
        { ...identity, checksum: 'f'.repeat(64) },
        { ...identity, sizeBytes: identity.sizeBytes + 1 },
        { ...identity, content: Buffer.alloc(identity.sizeBytes, 1) },
        { ...identity, recordingId: 'f'.repeat(64) }
      ])
        expect(await coordinator.readNativeSourceVersionMapping(target, altered)).toBeUndefined()
      for (const altered of [
        { ...target, projectId: 'foreign-project' },
        { ...target, sessionId: 'foreign-session' },
        { ...target, artifactId: 'forged-artifact' },
        { ...target, versionId: h.target.versionId }
      ])
        expect(await coordinator.readNativeSourceVersionMapping(altered, identity)).toBeUndefined()
      const forged = await writePublished({
        filename: artifact.name,
        source: { content: JSON.stringify(native.archive) },
        contentType: 'application/json'
      })
      expect(forged.artifactId).toBe(target.artifactId)
      expect(forged.versionId).not.toBe(target.versionId)
      expect(
        (
          await reader.read({
            ...scope,
            artifactId: forged.artifactId,
            versionId: forged.versionId
          })
        ).media
      ).toEqual([])
      const noAttestation = new ManagedRunObservationCoordinator({
        dataRoot: join(h.fixture.storageRoot, 'no-private-receipt'),
        recorder: () => recorder,
        artifacts: h.provenance
      })
      expect(await noAttestation.readNativeSourceVersionMapping(target, identity)).toBeUndefined()
      await h.fixture.client.artifactVersion.update({
        where: { id: target.versionId },
        data: { managedVisibleAt: null }
      })
      expect(await coordinator.readNativeSourceVersionMapping(target, identity)).toBeUndefined()
      await h.fixture.client.artifactVersion.update({
        where: { id: target.versionId },
        data: { managedVisibleAt: new Date() }
      })
      // A media Version must still be published in the attested original Session.
      await h.fixture.client.artifactVersion.update({
        where: { id: duplicate.versionId },
        data: { state: 'pending' }
      })
      expect(await coordinator.readNativeSourceVersionMapping(target, identity)).toEqual({
        [nativeMedia.versionId]: nativeMedia.versionId
      })
      await h.fixture.client.artifactVersion.update({
        where: { id: duplicate.versionId },
        data: { state: 'finalized' }
      })
      expect(saveAuxiliaryOutput).toHaveBeenCalledOnce()
      const path = join(h.fixture.storageRoot, 'native-duplicates.science')
      await exporter.exportTo(scope, path)
      initDataRoot(receiving.storageRoot)
      const imported = await importer.importFrom(path)
      const origin = await importer.readOrigin(imported)
      const importedTarget = {
        projectId: imported.projectId,
        sessionId: imported.sessionId,
        artifactId: origin.identities[target.artifactId],
        versionId: origin.identities[target.versionId]
      }
      const receiver = adapters(receiving)
      const diagnosticRead = vi.spyOn(SessionRepository.prototype, 'loadSessionWithDiagnostics')
      const defaultRead = vi
        .spyOn(SessionRepository.prototype, 'loadSession')
        .mockRejectedValue(new Error('Observation must not invoke Session read repair.'))
      await expect(
        importer.readArtifactSourceVersionMapping(imported, {
          artifactId: importedTarget.artifactId,
          versionId: importedTarget.versionId,
          checksum: identity.checksum,
          sizeBytes: identity.sizeBytes
        })
      ).resolves.toMatchObject({
        [nativeMedia.versionId]: origin.identities[nativeMedia.versionId]
      })
      expect(diagnosticRead).toHaveBeenCalledWith(imported.projectId, imported.sessionId, {
        mode: 'read-only',
        preserveRuntimeState: true
      })
      expect(defaultRead).not.toHaveBeenCalled()
      defaultRead.mockRestore()
      diagnosticRead.mockRestore()
      const importedReader = createRecordedObservationReader({
        immutableInputAuthority: receiver.authority,
        projectFilesRepository: receiver.files,
        artifactProvenanceRepository: receiver.provenance,
        authorizeScope: async (request) => {
          expect(request.projectId).toBe(imported.projectId)
          expect(request.sessionId).toBe(imported.sessionId)
        },
        readSourceVersionMapping: (target, archive) =>
          importer.readArtifactSourceVersionMapping(
            { projectId: target.projectId, sessionId: target.sessionId },
            {
              artifactId: target.artifactId,
              versionId: target.versionId,
              checksum: archive.checksum,
              sizeBytes: archive.sizeBytes
            }
          )
      })
      const received = await importedReader.read(importedTarget)
      expect(received.archive).toEqual(native.archive)
      expect(received.executionContext).toEqual(executionContext)
      expect(received.media.map((media) => media.versionId)).toEqual([
        origin.identities[nativeMedia.versionId],
        origin.identities[duplicate.versionId]
      ])
      for (const media of received.media)
        expect((await importedReader.readMedia(importedTarget, media.mediaKey)).body).toEqual(
          new Uint8Array(bytes)
        )
      // The sender's private native publication receipt cannot authorize an imported scope.
      expect(
        await coordinator.readNativeSourceVersionMapping(importedTarget, identity)
      ).toBeUndefined()
      const copy = await importer.fork(imported)
      const copyOrigin = await importer.readOrigin(copy)
      const copiedArchive = {
        artifactId: copyOrigin.identities[target.artifactId],
        versionId: copyOrigin.identities[target.versionId]
      }
      const second = await createProvenanceTestFixture()
      fixtures.push(second)
      const nextImporter = new SessionPackageService({
        storageRoot: second.storageRoot,
        getClient: async () => second.client
      })
      const next = adapters(second)
      try {
        const secondPath = join(receiving.storageRoot, 'reshared-duplicates.science')
        await importer.exportTo(copy, secondPath)
        initDataRoot(second.storageRoot)
        const secondImport = await nextImporter.importFrom(secondPath)
        const secondOrigin = await nextImporter.readOrigin(secondImport)
        // This is a true second native export: its direct receipt no longer knows the author ID.
        expect(secondOrigin.identities[nativeMedia.versionId]).toBeUndefined()
        const secondTarget = {
          projectId: secondImport.projectId,
          sessionId: secondImport.sessionId,
          artifactId: secondOrigin.identities[copiedArchive.artifactId],
          versionId: secondOrigin.identities[copiedArchive.versionId]
        }
        const secondReader = createRecordedObservationReader({
          immutableInputAuthority: next.authority,
          projectFilesRepository: next.files,
          artifactProvenanceRepository: next.provenance,
          authorizeScope: async () => undefined,
          readSourceVersionMapping: (target, archive) =>
            nextImporter.readArtifactSourceVersionMapping(
              { projectId: target.projectId, sessionId: target.sessionId },
              {
                artifactId: target.artifactId,
                versionId: target.versionId,
                checksum: archive.checksum,
                sizeBytes: archive.sizeBytes
              }
            )
        })
        const secondPayload = await secondReader.read(secondTarget)
        expect(secondPayload.archive).toEqual(native.archive)
        expect(secondPayload.executionContext).toEqual(executionContext)
        expect(secondPayload.media.map((media) => media.versionId)).toEqual([
          secondOrigin.identities[copyOrigin.identities[nativeMedia.versionId]],
          secondOrigin.identities[copyOrigin.identities[duplicate.versionId]]
        ])
        for (const media of secondPayload.media)
          expect((await secondReader.readMedia(secondTarget, media.mediaKey)).body).toEqual(
            new Uint8Array(bytes)
          )
        const secondReference = {
          artifactId: secondTarget.artifactId,
          versionId: secondTarget.versionId,
          checksum: identity.checksum,
          sizeBytes: identity.sizeBytes
        }
        await expect(
          nextImporter.readArtifactSourceVersionMapping(secondImport, {
            ...secondReference,
            checksum: 'f'.repeat(64)
          })
        ).rejects.toThrow('exact archive')
        await expect(
          nextImporter.readArtifactSourceVersionMapping(imported, secondReference)
        ).rejects.toThrow()
        await second.client.artifactVersion.update({
          where: { id: secondTarget.versionId },
          data: { managedVisibleAt: null }
        })
        await expect(
          nextImporter.readArtifactSourceVersionMapping(secondImport, secondReference)
        ).rejects.toThrow('not published')
        await second.client.artifactVersion.update({
          where: { id: secondTarget.versionId },
          data: { managedVisibleAt: new Date() }
        })
        // Two valid current Versions claiming the same ancestral identity stay ambiguous.
        const copiedDuplicate = await receiving.client.artifactVersion.findUniqueOrThrow({
          where: { id: copyOrigin.identities[duplicate.versionId] }
        })
        const sourcePath = join(
          receiving.storageRoot,
          dirname(copiedDuplicate.contentStorageKey!),
          'reproducibility-source.json'
        )
        const sourceText = await readFile(sourcePath, 'utf8')
        for (const mode of ['collision', 'foreign-scope']) {
          const duplicateSource = JSON.parse(sourceText)
          duplicateSource.sourceScope.versionId = nativeMedia.versionId
          duplicateSource.sourceScope.artifactId = nativeMedia.artifactId
          if (mode === 'foreign-scope')
            duplicateSource.sourceScope.projectId = 'foreign-author-project'
          await writeFile(sourcePath, JSON.stringify(duplicateSource))
          const collisionPath = join(receiving.storageRoot, `${mode}-duplicates.science`)
          await importer.exportTo(copy, collisionPath)
          const collision = await nextImporter.importFrom(collisionPath)
          const collisionOrigin = await nextImporter.readOrigin(collision)
          const collisionTarget = {
            projectId: collision.projectId,
            sessionId: collision.sessionId,
            artifactId: collisionOrigin.identities[copiedArchive.artifactId],
            versionId: collisionOrigin.identities[copiedArchive.versionId]
          }
          const collisionMapping = await nextImporter.readArtifactSourceVersionMapping(collision, {
            ...secondReference,
            artifactId: collisionTarget.artifactId,
            versionId: collisionTarget.versionId
          })
          const collisionPayload = await secondReader.read(collisionTarget)
          if (mode === 'collision') {
            expect(collisionMapping[nativeMedia.versionId]).toBeUndefined()
            expect(collisionPayload.media).toEqual([])
          } else {
            // A foreign ancestral scope cannot collide with or redirect this archive's alias.
            expect(collisionMapping[nativeMedia.versionId]).toBe(
              collisionOrigin.identities[copyOrigin.identities[nativeMedia.versionId]]
            )
            expect(collisionPayload.media.map((media) => media.mediaKey)).toEqual([
              'native-frame-0'
            ])
          }
        }
        const secondSessions = new SessionRepository(second.storageRoot)
        const secondSession = await secondSessions.loadSession(
          secondImport.projectId,
          secondImport.sessionId
        )
        const inconsistentScope = vi
          .spyOn(SessionRepository.prototype, 'loadSessionWithDiagnostics')
          .mockResolvedValueOnce({
            status: 'found',
            session: {
              ...secondSession!,
              packageOrigin: {
                ...secondSession!.packageOrigin!,
                importId: 'incorrect-import'
              }
            }
          })
        await expect(
          nextImporter.readArtifactSourceVersionMapping(secondImport, secondReference)
        ).rejects.toThrow('receiving Session')
        inconsistentScope.mockRestore()
        // A retained records document whose checksum chain changed cannot supply aliases.
        const recordsPath = join(
          second.storageRoot,
          'artifacts',
          secondImport.projectId,
          secondImport.sessionId,
          '.session-package',
          'source',
          'records.json'
        )
        const recordsText = await readFile(recordsPath, 'utf8')
        await writeFile(recordsPath, recordsText + '\n')
        await expect(
          nextImporter.readArtifactSourceVersionMapping(secondImport, secondReference)
        ).rejects.toThrow('source records checksum mismatch')
      } finally {
        await nextImporter.close()
      }
    } finally {
      await recorder.close()
      await exporter.close()
      await importer.close()
    }
  }
  it.each(['research', 'offline-demo'] as const)(
    'attests native duplicate-content Versions and preserves %s context through .science',
    attestNativeContext,
    60000
  )
})
