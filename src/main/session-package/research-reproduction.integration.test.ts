import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { x as extractTar } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import type { ArtifactVersion } from '@prisma/client'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { SessionPackageManifest } from '../../shared/session-package'
import {
  parseResearchReproductionDescription,
  resolveResearchReproductionMaterials
} from '../../shared/research-reproduction'
import { sha256 } from '../artifacts/provenance-canonical'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { SessionPackageService } from './service'
import type { PackageRecords } from './native-snapshot'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []
const services: SessionPackageService[] = []
const PUBLIC_DATA = 'trial,arm,delivered\n1,control,1\n2,treatment,2\n'
const PRIVATE_SENTINEL = 'PRIVATE_RESEARCH_FIXTURE_NOT_FOR_PUBLICATION_58361'

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

async function fixture(): Promise<Fixture> {
  const result = await createProvenanceTestFixture()
  fixtures.push(result)
  initDataRoot(result.storageRoot)
  await result.client.project.create({ data: { id: 'project-1', name: 'Publication fixture' } })
  return result
}

function service(storage: Fixture): SessionPackageService {
  const result = new SessionPackageService({
    storageRoot: storage.storageRoot,
    getClient: async () => storage.client
  })
  services.push(result)
  return result
}

async function session(storage: Fixture, id: string, privateRecord = false): Promise<void> {
  await new SessionRepository(storage.storageRoot).saveSession({
    id,
    projectId: 'project-1',
    title: privateRecord ? PRIVATE_SENTINEL : 'Public research materials',
    cwd: '',
    status: 'idle',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: privateRecord
          ? `Original private discussion: ${PRIVATE_SENTINEL}`
          : 'Inspect only the selected public materials.',
        createdAt: 1,
        updatedAt: 1,
        status: 'complete',
        eventIds: []
      },
      {
        id: 'message-1',
        role: 'agent',
        content: privateRecord
          ? `Private material preparation: ${PRIVATE_SENTINEL}`
          : 'Selected public materials are ready for inspection.',
        createdAt: 2,
        updatedAt: 2,
        status: 'complete',
        eventIds: []
      }
    ],
    createdAt: 1,
    updatedAt: 2
  })
}

async function artifact(
  storage: Fixture,
  sessionId: string,
  filename: string,
  content: string,
  input?: ArtifactVersion
): Promise<ArtifactVersion> {
  const operation = `${sessionId}-${filename}`
  const sessions = new SessionRepository(storage.storageRoot)
  const durableSession = await sessions.loadSession('project-1', sessionId)
  const graph = durableSession?.conversationGraph
  if (!graph) throw new Error('Fixture requires a durable Session graph')
  const anchors = {
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'prompt-1'
  }
  const repository = new ArtifactProvenanceRepository({
    ...storage.repositoryOptions,
    loadSession: (projectId, appSessionId) => sessions.loadSession(projectId, appSessionId)
  })
  const lane = createFrameNotebookLane('project-1', sessionId, anchors.agentFrameId)
  const inputFiles: NotebookRunInputFile[] = input
    ? [
        {
          inputFileVersionId: input.id,
          sourceKind: 'artifact-version',
          sourceFileId: input.artifactId,
          sourceVersionNumber: input.versionNumber,
          sourceCreatedAt: input.createdAt.toISOString(),
          sourceProjectId: 'project-1',
          sourceSessionId: 'private',
          filename: input.filename,
          ...(input.contentType ? { contentType: input.contentType } : {}),
          sizeBytes: Number(input.sizeBytes),
          checksum: input.checksum,
          storageKey: input.contentStorageKey,
          association: 'resolver-accessed'
        }
      ]
    : []
  await storage.notebookRepository.loadOrCreate({
    projectId: 'project-1',
    sessionId,
    workspaceCwd: storage.storageRoot,
    lane
  })
  await storage.notebookRepository.appendRun({
    projectId: 'project-1',
    sessionId,
    lane,
    run: {
      ...anchors,
      runId: operation,
      cellId: operation,
      source: 'agent',
      kernelKind: 'python',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      script:
        sessionId === 'private'
          ? `# Private recorded source: ${PRIVATE_SENTINEL}`
          : '# Selected public material fixture; never executed.',
      text: {
        stdout:
          sessionId === 'private'
            ? `Private recorded output: ${PRIVATE_SENTINEL}`
            : 'Public material prepared.',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      workingFiles: [],
      inputFiles,
      environmentCapture: { state: 'unavailable', reason: 'environment-capture-failed' }
    }
  })
  await storage.compatibilityRepository.writePendingFile({
    projectId: 'project-1',
    sessionId,
    runId: operation,
    filename,
    mimeType: filename.endsWith('.json') ? 'application/json' : 'text/plain',
    source: { kind: 'inline', content, encoding: 'utf8' }
  })
  const result = await repository.createVersion(
    createArtifactVersionRequest({
      ...anchors,
      appSessionId: sessionId,
      artifactStorageSessionId: sessionId,
      artifactRunId: operation,
      writeOperationId: operation,
      writeRequestChecksum: sha256(content),
      notebookSessionId: sessionId,
      producerRunId: operation,
      sourceKind: 'inline',
      filename,
      contentType: filename.endsWith('.json') ? 'application/json' : 'text/plain'
    })
  )
  const finalization = {
    ...anchors,
    projectId: 'project-1',
    appSessionId: sessionId,
    artifactRunId: operation,
    artifactVersionIds: [result.versionId],
    messageId: 'message-1'
  }
  await repository.finalizeRun(finalization)
  await repository.activateFinalizedRun(finalization)
  await new ProvenanceMessageSnapshotRepository({
    storageRoot: storage.storageRoot,
    getClient: async () => storage.client
  }).captureFinalizedMessages(durableSession)
  return storage.client.artifactVersion.findUniqueOrThrow({ where: { id: result.versionId } })
}

function description(version = 1): Record<string, unknown> {
  return {
    format: 'open-science-reproduction-description',
    descriptionVersion: version,
    title: 'Public downstream analysis fixture',
    materials: [
      {
        key: 'observations',
        role: 'data',
        availability: 'included',
        filename: 'observations.csv',
        sha256: sha256(PUBLIC_DATA),
        sizeBytes: Buffer.byteLength(PUBLIC_DATA),
        restorePath: 'inputs/observations.csv'
      },
      {
        key: 'private-input',
        role: 'source',
        availability: 'withheld',
        description: 'Original private inputs and their generation process are not shared.'
      }
    ],
    plans: [
      {
        key: 'analysis',
        title: 'Reanalyse public observations',
        scope: 'downstream-only',
        materialKeys: ['observations'],
        claim: 'Checks the published observations, not the private generation process.',
        limitations: ['Original private inputs are not provided.'],
        entrypoints: [],
        requirements: {}
      }
    ]
  }
}

async function unpack(path: string, directory: string): Promise<Map<string, Buffer>> {
  await mkdir(directory, { recursive: true })
  await extractTar({ file: path, cwd: directory, gzip: true })
  const result = new Map<string, Buffer>()
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(next)
      else result.set(next, await readFile(join(directory, next)))
    }
  }
  await walk('')
  return result
}

it('preserves optional description bytes and resolves content after native IDs change', async () => {
  const source = await fixture()
  const target = await fixture()
  await session(source, 'public')
  const data = await artifact(source, 'public', 'observations.csv', PUBLIC_DATA)
  const descriptionText = JSON.stringify(description())
  const descriptor = await artifact(source, 'public', 'research-reproduction.json', descriptionText)
  const archive = join(source.storageRoot, 'public.science')
  await service(source).exportTo({ projectId: 'project-1', sessionId: 'public' }, archive)
  const contents = await unpack(archive, join(source.storageRoot, 'unpacked'))
  const manifest = JSON.parse(contents.get('manifest.json')!.toString())
  expect(manifest.schemaVersion).toBe(1)
  expect(manifest.requiredFeatures ?? []).not.toContain('reproduction')
  expect([...contents.keys()]).not.toContain('research-reproduction.json')
  expect(
    [...contents.entries()]
      .filter(([key]) => key.startsWith('objects/'))
      .map(([, bytes]) => bytes.toString())
  ).toContain(descriptionText)

  // No material lookup may consult the author's artifact or Notebook directories.
  await rm(join(source.storageRoot, 'artifacts'), { recursive: true, force: true })
  await rm(join(source.storageRoot, 'notebooks'), { recursive: true, force: true })
  const importer = service(target)
  const imported = await importer.importFrom(archive)
  const origin = await importer.readOrigin(imported)
  expect(origin.identities[data.id]).not.toBe(data.id)
  const importedDescription = await target.client.artifactVersion.findUniqueOrThrow({
    where: { id: origin.identities[descriptor.id] }
  })
  const bytes = await readFile(
    join(target.storageRoot, importedDescription.contentStorageKey),
    'utf8'
  )
  expect(bytes).toBe(descriptionText)
  const parsed = parseResearchReproductionDescription(bytes)
  expect(parsed.status).toBe('valid')
  if (parsed.status !== 'valid') throw new Error('Expected a valid material description')
  const rows = await target.client.artifactVersion.findMany()
  const resolved = resolveResearchReproductionMaterials(parsed.description, {
    researchId: imported.sessionId,
    artifacts: rows.map((row) => ({
      researchId: imported.sessionId,
      artifactId: row.id,
      filename: row.filename,
      sha256: row.checksum,
      sizeBytes: Number(row.sizeBytes)
    }))
  })
  expect(resolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'observations', status: 'available' }),
      expect.objectContaining({ key: 'private-input', status: 'withheld' })
    ])
  )
  const record = await new SessionRepository(target.storageRoot).loadSession(
    imported.projectId,
    imported.sessionId
  )
  expect(record?.packageOrigin).toBeDefined()
  const forwarded = join(target.storageRoot, 'forwarded.science')
  await importer.exportTo(imported, forwarded)
  const forwardedContents = await unpack(forwarded, join(target.storageRoot, 'forwarded'))
  expect(
    [...forwardedContents.values()].some((value) => value.toString() === descriptionText)
  ).toBe(true)
  const secondTarget = await fixture()
  await expect(service(secondTarget).importFrom(forwarded)).resolves.toHaveProperty('sessionId')
}, 60_000)

it.each([false, true])(
  'makes the actual publication dependency closure observable (linked=%s)',
  async (linked) => {
    const source = await fixture()
    await session(source, 'private', true)
    await session(source, 'public')
    const hidden = await artifact(source, 'private', 'private-input.txt', PRIVATE_SENTINEL)
    const publicData = await artifact(
      source,
      'public',
      'observations.csv',
      PUBLIC_DATA,
      linked ? hidden : undefined
    )
    await artifact(source, 'public', 'research-reproduction.json', JSON.stringify(description()))
    // The normal Artifact repository captures this dependency from a legal recorded Notebook
    // input, keeping its database edge, execution snapshot and content evidence consistent.
    expect(
      await source.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: publicData.id,
        direction: 'up'
      })
    ).toHaveLength(linked ? 1 : 0)
    const archive = join(source.storageRoot, 'publication.science')
    await service(source).exportTo({ projectId: 'project-1', sessionId: 'public' }, archive)
    const contents = await unpack(archive, join(source.storageRoot, 'unpacked'))
    const manifest = JSON.parse(contents.get('manifest.json')!.toString()) as SessionPackageManifest
    const records = JSON.parse(contents.get('records.json')!.toString()) as PackageRecords
    const allDecodedContents = [...contents.values()].map((value) => value.toString())
    expect(allDecodedContents.some((value) => value.includes(PRIVATE_SENTINEL))).toBe(linked)
    expect(allDecodedContents.some((value) => value.includes(hidden.id))).toBe(linked)
    // The source really contains private messages and Notebook records. A clean publication
    // owns only selected public materials; a 'withheld' label never redacts a retained edge.
    expect(
      JSON.stringify(await source.notebookRepository.readSessionDocuments('project-1', 'private'))
    ).toContain(`Private recorded source: ${PRIVATE_SENTINEL}`)
    expect(contents.get('session.json')!.toString()).not.toContain(PRIVATE_SENTINEL)
    expect(records.tables.ArtifactVersion).toHaveLength(linked ? 3 : 2)
    expect(records.tables.ArtifactVersionInput).toHaveLength(linked ? 1 : 0)
    expect(records.tables.ArtifactMessageSnapshot).toHaveLength(linked ? 2 : 1)
    const notebookPayloads = manifest.inventory
      .filter((entry) => entry.kind === 'notebook')
      .map((entry) => contents.get(entry.path)!.toString())
    expect(notebookPayloads.length).toBeGreaterThan(0)
    expect(notebookPayloads.every((value) => !value.includes(PRIVATE_SENTINEL))).toBe(true)
    const messagePayloads = records.tables.ArtifactMessageSnapshot.map((row) => {
      const entry = manifest.inventory.find((entry) => entry.storageKey === row.storageKey)
      expect(entry).toBeDefined()
      return contents.get(entry!.path)!.toString()
    })
    expect(
      messagePayloads.some((value) =>
        value.includes(`Original private discussion: ${PRIVATE_SENTINEL}`)
      )
    ).toBe(linked)
    expect(
      records.tables.ArtifactVersion.some((row) =>
        String(row.executionSnapshotJson).includes(`Private recorded source: ${PRIVATE_SENTINEL}`)
      )
    ).toBe(linked)
    expect(allDecodedContents.includes(PRIVATE_SENTINEL)).toBe(linked)
    const target = await fixture()
    const imported = await service(target).importFrom(archive)
    const importedSession = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    expect(importedSession?.title).toBe('Public research materials')
    expect(JSON.stringify(importedSession?.messages)).not.toContain(PRIVATE_SENTINEL)
    if (!linked) {
      expect(await target.client.artifactVersionInput.count()).toBe(0)
      expect(await target.client.artifactVersion.count()).toBe(2)
    }
  },
  60_000
)

it.each(['absent', 'unknown-version'] as const)(
  'imports the package without executing a %s description',
  async (kind) => {
    const source = await fixture()
    const target = await fixture()
    const marker = join(target.storageRoot, 'must-not-execute')
    await session(source, 'public')
    await artifact(source, 'public', 'observations.csv', PUBLIC_DATA)
    const executable = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`
    await artifact(source, 'public', 'never-execute.mjs', executable)
    const candidate = description(999)
    ;(candidate.materials as unknown[]).push({
      key: 'executable',
      role: 'script',
      availability: 'included',
      filename: 'never-execute.mjs',
      sha256: sha256(executable),
      sizeBytes: Buffer.byteLength(executable),
      restorePath: 'scripts/never-execute.mjs'
    })
    const text = JSON.stringify(candidate)
    if (kind === 'unknown-version') {
      await artifact(source, 'public', 'research-reproduction.json', text)
    }
    const archive = join(source.storageRoot, 'compatible.science')
    await service(source).exportTo({ projectId: 'project-1', sessionId: 'public' }, archive)
    const imported = await service(target).importFrom(archive)
    const importedSession = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    expect(importedSession?.packageOrigin).toBeDefined()
    const expectedCount = kind === 'absent' ? 2 : 3
    expect(await target.client.artifactVersion.count()).toBe(expectedCount)
    const importedRuns = (
      await target.notebookRepository.readSessionDocuments(imported.projectId, imported.sessionId)
    ).flatMap((document) => document.runs)
    expect(importedRuns).toHaveLength(expectedCount)
    expect(importedRuns.every((run) => run.status === 'completed')).toBe(true)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    if (kind === 'unknown-version') {
      expect(parseResearchReproductionDescription(text)).toMatchObject({ status: 'unsupported' })
    }
  },
  60_000
)
