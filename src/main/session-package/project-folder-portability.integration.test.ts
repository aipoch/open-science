import { initializeProjectRecordStorage } from '../projects/record-storage'
import {
  startWorkingFileObservation,
  completeWorkingFileEvidence
} from '../notebook/working-file-observer'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import type { SessionPackageRequest } from '../../shared/session-package'
import { createRootNotebookLane } from '../notebook/lane-identity'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { readNativeEvidence } from '../artifacts/execution-evidence-log'
import { ArtifactOutputDelivery } from '../artifacts/output-delivery'
import { sha256 } from '../artifacts/provenance-canonical'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ProjectRepository } from '../projects/repository'
import {
  ensureProjectNotebookOutputDirectory,
  getProjectSessionOutputLayout
} from '../projects/session-output-layout'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { readPackageArchive } from './archive'
import { readExecutionEvidence } from './execution-evidence'
import { SessionPackageService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []
const directories: string[] = []
const services: SessionPackageService[] = []
const notebookOutput = { filename: 'result.csv', text: 'ordinary Notebook result' }
const artifactOutput = { filename: 'report.txt', text: 'published Artifact content' }

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function externalFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'science-project-input-')))
  directories.push(root)
  return root
}

async function publishSourceArtifact(
  fixture: Fixture,
  sessions: SessionRepository,
  folder: string
): Promise<void> {
  const { storageRoot, client, repositoryOptions } = fixture
  const graph = (await sessions.loadSession('source', 'session'))?.conversationGraph
  if (!graph) throw new Error('The source Session graph must be saved before publishing.')
  const managedFiles = new ManagedFileVersionService({ storageRoot, getClient: async () => client })
  const delivery = new ArtifactOutputDelivery({
    storageRoot,
    getClient: async () => client,
    openVersion: (request, versionId) => managedFiles.openVersion(request, versionId),
    getLayout: async (projectId, sessionId) =>
      getProjectSessionOutputLayout(storageRoot, projectId, sessionId)
  })
  const repository = new ArtifactProvenanceRepository({
    ...repositoryOptions,
    managedFileVersions: managedFiles,
    loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId),
    onHeadActivated: (versions) => delivery.deliverActivated(versions)
  })
  const request = createArtifactVersionRequest({
    projectId: 'source',
    appSessionId: 'session',
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'message',
    filename: artifactOutput.filename,
    contentType: 'text/plain'
  })
  const version = await repository.saveVersion(
    {
      ...request,
      source: {
        kind: 'inline',
        content: Buffer.from(artifactOutput.text).toString('base64'),
        encoding: 'base64'
      }
    },
    { allowedImportRoots: [folder] }
  )
  const proof = {
    ...request,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'message',
    artifactVersionIds: [version.versionId],
    messageId: 'reply'
  }
  await repository.finalizeRun(proof)
  await repository.activateFinalizedRun(proof)
}

async function sourceArchive(recordVersion?: 1 | 2): Promise<{
  source: Fixture
  service: SessionPackageService
  archive: string
  folder: string
  phrase: string
}> {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  initDataRoot(source.storageRoot)
  const folder = await externalFolder()
  const phrase = `Research text keeps ${folder}`
  await writeFile(join(folder, 'raw.csv'), 'value\n7\n')
  await source.client.project.create({
    data: { id: 'source', name: 'Folder research', rootPath: folder }
  })
  if (recordVersion)
    await initializeProjectRecordStorage(source.storageRoot, folder, {
      format: 'open-science-project',
      ...(recordVersion === 2 ? { version: 2, outputLayout: 'session-v1' } : { version: 1 }),
      projectId: 'source',
      name: 'Folder research',
      createdAt: 1
    })
  const sessions = new SessionRepository(source.storageRoot)
  await sessions.saveSession({
    id: 'session',
    projectId: 'source',
    title: 'Research',
    cwd: folder,
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'message',
        role: 'user',
        content: phrase,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 2
      },
      ...(recordVersion === 2
        ? [
            {
              id: 'reply',
              role: 'agent' as const,
              content: 'Report ready.',
              status: 'complete' as const,
              eventIds: [],
              createdAt: 2,
              updatedAt: 2
            }
          ]
        : [])
    ]
  })
  const scope = {
    projectId: 'source',
    sessionId: 'session',
    workspaceCwd: folder,
    lane: createRootNotebookLane('source', 'session', 'frame')
  }
  const document = await source.notebookRepository.loadOrCreate(scope)
  const run = {
    runId: 'run',
    cellId: 'cell',
    source: 'user',
    kernelKind: 'python',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    script: `print(${JSON.stringify(phrase)})`,
    cwdBefore: folder,
    cwdAfter: folder,
    text: { stdout: phrase, stderr: '', traceback: '', plain: [] },
    outputs: [{ type: 'text', text: phrase }],
    workingFiles: [],
    frozenShellContext: {
      cwd: folder,
      handoffDir: folder,
      runtimeRoot: folder,
      notebookSessionRoot: folder,
      inputRoot: folder,
      protectedDirs: [folder],
      environment: { PWD: folder, USER_RESEARCH_NOTE: phrase },
      timeoutMs: 1000,
      platform: process.platform
    },
    projectFolderInputs: [
      {
        relativePath: 'raw.csv',
        checksum: sha256('value\n7\n'),
        sizeBytes: Buffer.byteLength('value\n7\n'),
        frozen: false
      }
    ]
  } as NotebookRunRecord
  if (recordVersion) {
    const location = source.notebookRepository.fileEvidenceLocation('source', 'session', scope.lane)
    const observation = await startWorkingFileObservation({
      dataRoot: document.dataRoot,
      notebookSessionRoot: document.notebookSessionRoot,
      cwd: document.dataRoot,
      runId: run.runId,
      language: 'python',
      code: 'open("evidence.txt", "w").write("captured")',
      observationMode: 'declared-paths',
      fileEvidenceStorageRoot: location.storageRoot,
      fileEvidenceRoot: location.root,
      fileEvidenceStoragePrefix: location.storageKeyPrefix
    })
    await writeFile(join(document.dataRoot, 'evidence.txt'), 'captured')
    run.fileEvidence = (await observation.finish()).fileEvidence
    await completeWorkingFileEvidence(location, {
      runId: run.runId,
      fileEvidence: run.fileEvidence
    })
  }
  await source.notebookRepository.appendRun({ ...scope, run })
  await writeFile(join(document.dataRoot, 'raw.csv'), 'PRIVATE SOURCE WORKING COPY')
  await writeFile(join(document.dataRoot, 'failed-preparation.csv'), 'PRIVATE FAILED PREPARATION')
  await mkdir(join(document.notebookSessionRoot, 'attachments'))
  await writeFile(join(document.notebookSessionRoot, 'attachments', 'research.txt'), phrase)
  await mkdir(join(source.storageRoot, 'project-folder-history', 'changes'), { recursive: true })
  await writeFile(
    join(source.storageRoot, 'project-folder-history', 'changes', 'backup.txt'),
    'PRIVATE D3 BACKUP'
  )
  if (recordVersion === 2) {
    const outputRoot = await ensureProjectNotebookOutputDirectory(
      source.storageRoot,
      'source',
      'session'
    )
    if (!outputRoot) throw new Error('The source Project must have a v2 Notebook output directory.')
    await writeFile(join(outputRoot, notebookOutput.filename), notebookOutput.text)
    await publishSourceArtifact(source, sessions, folder)
  }
  const archive = join(source.storageRoot, 'research.science')
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client,
    assertProjectFolderHealthy: async () => folder,
    getProjectRootPath: async () => folder
  })
  services.push(service)
  await service.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
  return { source, service, archive, folder, phrase }
}

it('scrubs known execution metadata, preserves research strings and bytes, and excludes every private working projection', async () => {
  const { source, archive, folder, phrase } = await sourceArchive()
  const expanded = join(source.storageRoot, 'expanded')
  const manifest = await readPackageArchive(archive, expanded)
  const session = JSON.parse(await readFile(join(expanded, 'session.json'), 'utf8')).session
  expect(session.cwd).toBe('')
  expect(session.messages[0].content).toBe(phrase)
  const notebookEntry = manifest.inventory.find(
    (entry) => entry.storageKey === 'notebooks/source/session/run.json'
  )!
  const notebook = JSON.parse(await readFile(join(expanded, notebookEntry.path), 'utf8'))
  expect(notebook.workspaceCwd).toBe('')
  expect(notebook.runs[0].cwdBefore).toBe('')
  expect(notebook.runs[0].cwdAfter).toBe('')
  expect(notebook.runs[0].frozenShellContext.cwd).toBe('')
  expect(notebook.runs[0].frozenShellContext.environment.PWD).toBe('')
  expect(notebook.runs[0].script).toBe(`print(${JSON.stringify(phrase)})`)
  expect(notebook.runs[0].text.stdout).toBe(phrase)
  expect(notebook.runs[0].outputs[0].text).toBe(phrase)
  expect(notebook.runs[0].frozenShellContext.environment.USER_RESEARCH_NOTE).toBe(phrase)
  const attachment = manifest.inventory.find((entry) =>
    entry.storageKey?.endsWith('/attachments/research.txt')
  )!
  expect(await readFile(join(expanded, attachment.path), 'utf8')).toBe(phrase)
  expect(manifest.inventory.some((entry) => entry.storageKey?.includes('/data/'))).toBe(false)
  expect(
    manifest.inventory.some((entry) => entry.storageKey?.startsWith('project-folder-history/'))
  ).toBe(false)
  expect(manifest.omissions).toContainEqual(
    expect.objectContaining({ kind: 'external', description: expect.stringContaining('raw.csv') })
  )
  expect(JSON.stringify(manifest.omissions)).not.toContain(folder)
  for (const entry of manifest.inventory) {
    const contents = await readFile(join(expanded, entry.path))
    expect(contents.includes(Buffer.from('PRIVATE SOURCE WORKING COPY'))).toBe(false)
    expect(contents.includes(Buffer.from('PRIVATE FAILED PREPARATION'))).toBe(false)
    expect(contents.includes(Buffer.from('PRIVATE D3 BACKUP'))).toBe(false)
  }
})

it.each([false, true])(
  'imports history into a bound project with managed provider state (records: %s)',
  async (recordMode) => {
    const { archive } = await sourceArchive()
    const target = await createProvenanceTestFixture()
    fixtures.push(target)
    const folder = await externalFolder()
    await writeFile(join(folder, 'raw.csv'), 'value\n42\n')
    const projects = new ProjectRepository(async () => target.client, undefined, {
      homePath: target.storageRoot,
      dataRoot: target.storageRoot,
      configRoot: target.storageRoot,
      preflight: async () => undefined
    })
    const project = await projects.create({ name: 'Receiving research', rootPath: folder })
    if (recordMode)
      await initializeProjectRecordStorage(target.storageRoot, folder, {
        format: 'open-science-project',
        version: 1,
        projectId: project.id,
        name: project.name,
        createdAt: 1
      })
    const service = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client,
      assertProjectFolderHealthy: (id) => projects.assertProjectFolderHealthy(id),
      getProjectRootPath: async (id) => (await projects.get(id))?.rootPath ?? undefined
    })
    services.push(service)
    const imported = await service.importFrom(archive, undefined, undefined, undefined, {
      projectId: project.id
    })
    if (recordMode) {
      expect(target.notebookRepository.runJsonPath(project.id, imported.sessionId)).toContain(
        folder
      )
      expect(
        await readFile(
          join(
            target.storageRoot,
            'notebooks',
            project.id,
            imported.sessionId,
            'attachments/research.txt'
          ),
          'utf8'
        )
      ).toContain('Research text keeps')
    }
    const derived = await service.fork(imported)
    const session = await new SessionRepository(target.storageRoot).loadSession(
      derived.projectId,
      derived.sessionId
    )
    expect(session?.cwd.startsWith(join(target.storageRoot, 'workspaces') + sep)).toBe(true)
    expect(session?.cwd).not.toBe(folder)
    expect(
      await readFile(
        join((await projects.assertProjectFolderHealthy(project.id))!, 'raw.csv'),
        'utf8'
      )
    ).toBe('value\n42\n')
    expect((await projects.get(project.id))?.rootPath).toBe(folder)
    await rename(folder, folder + '-moved')
    directories.push(folder + '-moved')
    await expect(service.fork(imported)).rejects.toMatchObject({ code: 'project-folder-not-found' })
  }
)

it('requires live target folder protection checks and fails closed without the host health capability', async () => {
  const { archive } = await sourceArchive()
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  const folder = await externalFolder()
  await target.client.project.create({
    data: { id: 'bound-target', name: 'Target', rootPath: folder }
  })
  const missingCapability = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const rejected = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client,
    assertProjectFolderHealthy: async () => {
      throw Object.assign(new Error('Protection unavailable'), {
        code: 'project-folder-unavailable'
      })
    }
  })
  services.push(missingCapability, rejected)
  for (const service of [missingCapability, rejected])
    await expect(
      service.importFrom(archive, undefined, undefined, undefined, { projectId: 'bound-target' })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
})

async function expectV2SessionRecords(
  fixture: Fixture,
  folder: string,
  { projectId, sessionId }: SessionPackageRequest
): Promise<void> {
  const recordRoot = join(folder, '.open-science')
  const [run] = await fixture.notebookRepository.readSessionRuns(projectId, sessionId)
  const evidence = run.fileEvidence!
  expect(evidence.generationCount).toBeGreaterThan(0)
  const bytes = await readNativeEvidence(
    recordRoot,
    evidence.storageKey!,
    evidence.checksum!,
    1024 * 1024
  )
  const evidenceRecord = readExecutionEvidence(JSON.parse(bytes.toString('utf8')))
  expect(evidenceRecord.activityId).toBe(run.runId)
  const generation = evidenceRecord.relations.find((relation) => relation.generation)?.generation
  await expect(readFile(join(recordRoot, generation!.contentStorageKey), 'utf8')).resolves.toBe(
    'captured'
  )
  const [lineage] = await fixture.client.artifactLineage.findMany({
    where: { projectId, sessionId },
    include: { currentVersion: true }
  })
  expect(lineage).toMatchObject({
    filename: artifactOutput.filename,
    outputDeliveryJson: null,
    currentVersion: { state: 'finalized' }
  })
  await expect(
    readFile(join(recordRoot, lineage.currentVersion!.contentStorageKey!), 'utf8')
  ).resolves.toBe(artifactOutput.text)
  for (const path of [
    join(folder, 'notebooks', projectId, sessionId, 'data', notebookOutput.filename),
    join(folder, 'artifacts', projectId, sessionId, artifactOutput.filename)
  ]) {
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

async function verifyProjectRecordsRoundTrip(recordVersion: 1 | 2): Promise<void> {
  const { source, service: exporter, archive, folder } = await sourceArchive(recordVersion)
  const expanded = join(source.storageRoot, 'expanded-records')
  const manifest = await readPackageArchive(archive, expanded)
  const notebookEntry = manifest.inventory.find(
    (entry) => entry.storageKey === 'notebooks/source/session/run.json'
  )!
  expect(notebookEntry).toBeDefined()
  const notebook = JSON.parse(await readFile(join(expanded, notebookEntry.path), 'utf8'))
  expect(notebook.workspaceCwd).toBe('')
  expect(notebook.notebookSessionRoot).not.toContain(folder)
  expect(notebook.runs[0].fileEvidence.generationCount).toBeGreaterThan(0)
  expect(
    manifest.inventory.some((entry) => entry.storageKey?.startsWith('execution-file-evidence/'))
  ).toBe(true)
  if (recordVersion === 2) {
    const publicNotebook = join(
      folder,
      'notebooks',
      'source',
      'session',
      'data',
      notebookOutput.filename
    )
    const publicArtifact = join(folder, 'artifacts', 'source', 'session', artifactOutput.filename)
    const sourceLineage = await source.client.artifactLineage.findFirstOrThrow({
      where: { projectId: 'source', sessionId: 'session' }
    })
    expect(JSON.parse(sourceLineage.outputDeliveryJson!)).toMatchObject({
      state: 'delivered',
      relativePath: `artifacts/source/session/${artifactOutput.filename}`
    })
    const records = JSON.parse(await readFile(join(expanded, 'records.json'), 'utf8'))
    expect(records.tables.ArtifactLineage).toHaveLength(1)
    expect(records.tables.ArtifactLineage[0]).not.toHaveProperty('outputDeliveryJson')
    const packagedKeys = manifest.inventory.map((entry) => entry.storageKey)
    expect(packagedKeys).not.toContain(`notebooks/source/session/data/${notebookOutput.filename}`)
    expect(packagedKeys).not.toContain(`artifacts/source/session/${artifactOutput.filename}`)
    const nativeFork = await exporter.fork({ projectId: 'source', sessionId: 'session' })
    expect(nativeFork.projectId).toBe('source')
    expect(nativeFork.sessionId).not.toBe('session')
    await expect(
      assertResearchSessionWritable(source.storageRoot, nativeFork.projectId, nativeFork.sessionId)
    ).resolves.toBeUndefined()
    await expectV2SessionRecords(source, folder, nativeFork)
    await expect(readFile(publicNotebook, 'utf8')).resolves.toBe(notebookOutput.text)
    await expect(readFile(publicArtifact, 'utf8')).resolves.toBe(artifactOutput.text)
    await expect(readFile(join(folder, 'raw.csv'), 'utf8')).resolves.toBe('value\n7\n')
  }
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  const destination = await externalFolder()
  await target.client.project.create({
    data: { id: 'target-records', name: 'Records target', rootPath: destination }
  })
  await initializeProjectRecordStorage(target.storageRoot, destination, {
    format: 'open-science-project',
    ...(recordVersion === 2 ? { version: 2, outputLayout: 'session-v1' } : { version: 1 }),
    projectId: 'target-records',
    name: 'Records target',
    createdAt: 1
  })
  await writeFile(join(destination, 'raw.csv'), 'value\n42\n')
  const service = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client,
    assertProjectFolderHealthy: async () => destination,
    getProjectRootPath: async () => destination
  })
  services.push(service)
  const imported = await service.importFrom(archive, undefined, undefined, undefined, {
    projectId: 'target-records'
  })
  const importedDocument = await target.notebookRepository.findExisting(
    imported.projectId,
    imported.sessionId
  )
  expect(importedDocument?.runs[0].script).toBe(notebook.runs[0].script)
  expect(target.notebookRepository.runJsonPath(imported.projectId, imported.sessionId)).toBe(
    join(
      destination,
      '.open-science',
      'notebooks',
      imported.projectId,
      imported.sessionId,
      'run.json'
    )
  )
  await expect(
    assertResearchSessionWritable(target.storageRoot, imported.projectId, imported.sessionId)
  ).rejects.toThrow('Imported research history is read-only.')
  const fork = await service.fork(imported)
  await expect(
    assertResearchSessionWritable(target.storageRoot, fork.projectId, fork.sessionId)
  ).resolves.toBeUndefined()
  expect(
    await target.notebookRepository.readSessionRuns(fork.projectId, fork.sessionId)
  ).toHaveLength(1)
  const forked = await target.notebookRepository.findExisting(fork.projectId, fork.sessionId)
  expect(forked?.runs[0].script).toBe(notebook.runs[0].script)
  expect(forked?.runs[0].cwdBefore).toBe('')
  if (recordVersion === 2) {
    const sessions = new SessionRepository(target.storageRoot)
    const importedSession = await sessions.loadSession(imported.projectId, imported.sessionId)
    expect(importedSession?.packageOrigin).toMatchObject({
      sourceProjectId: 'source',
      sourceSessionId: 'session'
    })
    const forkedSession = await sessions.loadSession(fork.projectId, fork.sessionId)
    expect(forkedSession?.forkOrigin?.sourceSessionId).toBe(imported.sessionId)
    expect(forkedSession?.packageOrigin).toBeUndefined()
    await expectV2SessionRecords(target, destination, imported)
    await expectV2SessionRecords(target, destination, fork)
    expect((await readdir(destination)).sort()).toEqual(['.open-science', 'raw.csv'])
  }
  await expect(readFile(join(destination, 'raw.csv'), 'utf8')).resolves.toBe('value\n42\n')
}

it.each([1, 2] as const)(
  'exports external Notebook records and evidence, then imports and forks into another v%s record project',
  verifyProjectRecordsRoundTrip,
  60_000
)
