import { initializeProjectRecordStorage } from '../projects/record-storage'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createArtifactSaveFixture } from './save-test-fixtures'
import { writeArtifactFileForCurrentRun } from './mcp-server'
import { getNotebookDataRoot, getNotebookSessionRoot } from '../notebook/repository'
import { createRootNotebookLane } from '../notebook/lane-identity'
import {
  getNotebookSessionOutputRelativePath,
  getProjectSessionOutputLayout
} from '../projects/session-output-layout'
import { ArtifactCodeReconstructionService } from './code-reconstruction'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { Project } from '../../shared/projects'
import type { ProjectFolderListing } from '../../shared/project-folder-files'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ProjectFilesQueryOwner } from '../project-files/query-owner'
import { listPublishedArtifactFolderRecords } from '../project-files/query-support'
import { ProjectFolderFiles } from '../projects/project-folder-files'
import { ArtifactOutputDelivery } from './output-delivery'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { createPngBytes } from './artifact-test-fixtures'
import {
  findPublishedArtifactCopies,
  type ReadPublishedArtifactFolderRecords
} from './project-folder-mention-candidates'
import * as boundedIo from '../bounded-file-io'

configureTestRuntimeMetadata()
const fixtures: Awaited<ReturnType<typeof createArtifactSaveFixture>>[] = []
const externalFolders: string[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
  for (const folder of externalFolders.splice(0)) await rm(folder, { recursive: true, force: true })
})

it('publishes real Notebook relative outputs from the bound Project folder through the production RPC', async () => {
  let folder = ''
  const f = await createArtifactSaveFixture(undefined, {
    assertProjectFolderHealthy: async () => folder
  })
  fixtures.push(f)
  folder = await realpath(f.storageRoot).then((root) => join(root, 'custom-project'))
  const workspace = join(f.storageRoot, 'managed-provider-workspace')
  await Promise.all([mkdir(folder), mkdir(workspace)])
  const context = { ...f.binding, agentFrameId: f.binding.rootFrameId }
  const lane = createRootNotebookLane('project-1', 'session-1', context.agentFrameId)
  const notebookDataDir = getNotebookDataRoot(f.storageRoot, 'project-1', 'session-1', lane)
  const notebookSessionRoot = getNotebookSessionRoot(f.storageRoot, 'project-1', 'session-1', lane)
  await mkdir(notebookDataDir, { recursive: true })
  // An older managed copy must never win over the current Project's relative source.
  await writeFile(join(notebookDataDir, 'result.txt'), 'stale managed bytes')
  const env = await f.environment(
    {
      allowedImportRoots: [workspace, notebookSessionRoot],
      workspaceCwd: workspace,
      notebookDataDir,
      notebookSessionRoot
    },
    { ...context, notebookSessionId: 'session-1' }
  )
  const run = await f.service.executeControl({
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: workspace,
    provenanceContext: context,
    code: "const fs = require('node:fs'); fs.writeFileSync('result.txt', 'custom output'); return process.cwd()"
  })
  expect(run.status).toBe('completed')
  expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe('custom output')
  expect(run.workingFiles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'data/result.txt'
      })
    ])
  )
  const document = await f.notebookRepository.findExisting('project-1', 'session-1', lane)
  const producerRunId = document!.runs.at(-1)!.runId
  const save = (
    path: string,
    filename: string
  ): ReturnType<typeof writeArtifactFileForCurrentRun> =>
    writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename,
      source: { kind: 'localPath', path },
      producerRunId
    })
  const result = await save('result.txt', 'relative.txt')
  const absolute = await save(join(folder, 'result.txt'), 'absolute.txt')
  const logical = await save('data/result.txt', 'logical.txt')
  const inferred = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
    filename: 'inferred.txt',
    source: { kind: 'localPath', path: 'result.txt' }
  })
  for (const artifact of [result, absolute, logical, inferred]) {
    expect(await readFile(artifact.path, 'utf8')).toBe('custom output')
    const version = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: artifact.versionId }
    })
    expect(version.producerRunId).toBe(producerRunId)
  }
  await writeFile(join(folder, 'result.txt'), 'changed original')
  expect(await readFile(result.path, 'utf8')).toBe('custom output')
  await expect(save('result.txt', 'changed.txt')).rejects.toThrow(
    'Producer source must have exactly one Run owner'
  )
  expect(document?.workspaceCwd).toBe(workspace)
  expect(document?.notebookSessionRoot).toBe(notebookSessionRoot)
  expect(document?.dataRoot).toBe(notebookDataDir)
  expect((await stat(join(notebookSessionRoot, 'run.json'))).isFile()).toBe(true)
}, 30_000)

it('refreshes the current Project binding and rejects escaped paths and fabricated Run ownership', async () => {
  let folder = ''
  const f = await createArtifactSaveFixture(undefined, {
    assertProjectFolderHealthy: async () => folder
  })
  fixtures.push(f)
  const root = await realpath(f.storageRoot)
  folder = join(root, 'project-original')
  const workspace = join(root, 'managed-workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(folder), mkdir(workspace), mkdir(outside)])
  const original = join(folder, 'input.txt')
  await writeFile(original, 'existing user input')
  const context = { ...f.binding, agentFrameId: f.binding.rootFrameId }
  const lane = createRootNotebookLane('project-1', 'session-1', context.agentFrameId)
  const env = await f.environment(
    { allowedImportRoots: [workspace], workspaceCwd: workspace },
    { ...context, notebookSessionId: 'session-1' }
  )
  await f.service.executeControl({
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: workspace,
    provenanceContext: context,
    code: "require('node:fs').writeFileSync('produced.txt', 'produced'); return 'done'"
  })
  const document = await f.notebookRepository.findExisting('project-1', 'session-1', lane)
  const runId = document!.runs.at(-1)!.runId
  const imported = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
    filename: 'import.txt',
    source: { kind: 'localPath', path: 'input.txt' }
  })
  const version = await f.client.artifactVersion.findUniqueOrThrow({
    where: { id: imported.versionId }
  })
  expect(version.producerRunId).toBeNull()
  await mkdir(join(folder, 'data'))
  await writeFile(join(folder, 'data', 'input.txt'), 'explicit data subdirectory')
  const nested = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
    filename: 'nested.txt',
    source: { kind: 'localPath', path: 'data/input.txt' }
  })
  expect(await readFile(nested.path, 'utf8')).toBe('explicit data subdirectory')
  await expect(
    writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'false-producer.txt',
      source: { kind: 'localPath', path: 'input.txt' },
      producerRunId: runId
    })
  ).rejects.toThrow('Producer source must have exactly one Run owner')

  // The persistent REPL holds the old cwd open on Windows.
  expect(await f.service.shutdownAll()).toMatchObject({ reaped: true })
  const movedFolder = join(root, 'project-relocated')
  await rename(folder, movedFolder)
  const oldFolder = folder
  folder = movedFolder
  await mkdir(oldFolder)
  await writeFile(join(oldFolder, 'old.txt'), 'stale binding')
  await expect(
    writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: 'old.txt',
      source: { kind: 'localPath', path: join(oldFolder, 'old.txt') }
    })
  ).rejects.toThrow('outside allowed artifact import roots')
  const moved = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
    filename: 'moved.txt',
    source: { kind: 'localPath', path: 'input.txt' }
  })
  expect(await readFile(moved.path, 'utf8')).toBe('existing user input')
  // Delegated lanes still execute in their managed workspace; Project names must not shadow it.
  await writeFile(join(workspace, 'input.txt'), 'delegated workspace output')
  const delegated = await f.environment({
    allowedImportRoots: [workspace],
    workspaceCwd: workspace
  })
  const delegatedArtifact = await writeArtifactFileForCurrentRun(
    f.compatibilityRepository,
    delegated,
    {
      filename: 'delegated.txt',
      source: { kind: 'localPath', path: 'input.txt' }
    }
  )
  expect(await readFile(delegatedArtifact.path, 'utf8')).toBe('delegated workspace output')
  await writeFile(join(outside, 'secret.txt'), 'outside content')
  await symlink(outside, join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of ['escape/secret.txt', '../outside/secret.txt']) {
    await expect(
      writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
        filename: 'escaped.txt',
        source: { kind: 'localPath', path }
      })
    ).rejects.toThrow('outside allowed artifact import roots')
  }
}, 30_000)

it.skipIf(
  process.env.RUN_PROJECT_FOLDER_NATIVE !== '1' || !['darwin', 'linux'].includes(process.platform)
)(
  'publishes real Python direct and independently prepared relative outputs with their exact producer generations',
  async () => {
    let folder = ''
    const python = process.env.OPEN_SCIENCE_TEST_PY_ENV ?? '/usr/bin/python3'
    const f = await createArtifactSaveFixture(undefined, {
      assertProjectFolderHealthy: async () => folder,
      discoverRuntimes: async (language) =>
        language === 'python'
          ? [
              {
                language: 'python',
                provenance: 'user-own',
                envId: python,
                interpreterPath: python,
                label: 'test interpreter',
                version: 'fixture',
                runnable: true
              }
            ]
          : [],
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: { [python]: true }, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      }
    })
    fixtures.push(f)
    folder = await realpath(await mkdtemp(join(tmpdir(), 'os-output-project-')))
    externalFolders.push(folder)
    const workspace = join(f.storageRoot, 'managed-provider-workspace')
    await mkdir(workspace)
    const context = { ...f.binding, agentFrameId: f.binding.rootFrameId }
    const lane = createRootNotebookLane('project-1', 'session-1', context.agentFrameId)
    const notebookDataDir = getNotebookDataRoot(f.storageRoot, 'project-1', 'session-1', lane)
    const notebookSessionRoot = getNotebookSessionRoot(
      f.storageRoot,
      'project-1',
      'session-1',
      lane
    )
    const env = await f.environment(
      {
        allowedImportRoots: [workspace, notebookSessionRoot],
        workspaceCwd: workspace,
        notebookDataDir,
        notebookSessionRoot
      },
      { ...context, notebookSessionId: 'session-1' }
    )
    f.service.setRuntimeBindingApproval(async () => true)
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: workspace,
      provenanceContext: context,
      language: 'python' as const
    }
    for (const mode of ['direct', 'prepared'] as const) {
      const name = `${mode}.txt`
      const code =
        mode === 'direct'
          ? 'open("direct.txt", "w").write("direct output")\nopen("extra.txt", "w").write("extra")'
          : 'open("prepared.txt", "w").write("prepared output")'
      const run = await f.service.execute({ ...request, code })
      expect(run.status, JSON.stringify(run)).toBe('completed')
      expect(await readFile(join(folder, name), 'utf8')).toBe(`${mode} output`)
      const document = await f.notebookRepository.findExisting('project-1', 'session-1', lane)
      const record = document!.runs.find((candidate) => candidate.runId === run.runId)!
      if (mode === 'prepared') {
        expect(record.projectFolderChanges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ relativePath: name, state: 'applied' })
          ])
        )
      }
      for (const declared of [true, false]) {
        const artifact = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
          filename: `${mode}-${declared}.txt`,
          source: { kind: 'localPath', path: name },
          ...(declared ? { producerRunId: run.runId } : {})
        })
        const version = await f.client.artifactVersion.findUniqueOrThrow({
          where: { id: artifact.versionId }
        })
        expect(version.producerRunId).toBe(run.runId)
        const evidence = JSON.parse(version.evidenceJson!)
        expect(evidence.producer.state).toBe('available')
        const snapshot = JSON.parse(version.executionSnapshotJson!)
        const generation = record.workingFiles.find((file) => file.relativePath === `data/${name}`)
        expect(generation?.generationId).toBeTruthy()
        expect(snapshot.provenanceGraph.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'used',
              entityId: `file-generation:${generation!.generationId}`,
              evidenceSource: 'artifact-publication'
            })
          ])
        )
        expect(await readFile(artifact.path, 'utf8')).toBe(`${mode} output`)
      }
    }
  },
  60_000
)

it('publishes relative, absolute and data paths into durable Project Artifact records', async () => {
  let folder = ''
  const f = await createArtifactSaveFixture(undefined, {
    assertProjectFolderHealthy: async () => folder
  })
  fixtures.push(f)
  folder = join(await realpath(f.storageRoot), 'portable-project')
  const workspace = join(f.storageRoot, 'managed-workspace')
  await Promise.all([mkdir(folder), mkdir(workspace)])
  await initializeProjectRecordStorage(f.storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId: 'project-1',
    name: 'Research',
    createdAt: 1
  })
  const context = { ...f.binding, agentFrameId: f.binding.rootFrameId }
  const env = await f.environment(
    { allowedImportRoots: [workspace], workspaceCwd: workspace },
    { ...context, notebookSessionId: 'session-1' }
  )
  const run = await f.service.executeControl({
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: workspace,
    provenanceContext: context,
    code: "const fs = require('node:fs'); fs.writeFileSync('output.txt', 'durable output'); return process.cwd()"
  })
  expect(run.status).toBe('completed')
  const lane = createRootNotebookLane('project-1', 'session-1', context.agentFrameId)
  const document = await f.notebookRepository.findExisting('project-1', 'session-1', lane)
  const producerRunId = document!.runs.at(-1)!.runId
  const artifacts = []
  for (const [index, path] of [
    'output.txt',
    join(folder, 'output.txt'),
    'data/output.txt'
  ].entries()) {
    const artifact = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename: `copy-${index}.txt`,
      source: { kind: 'localPath', path },
      producerRunId
    })
    artifacts.push(artifact)
    expect(artifact.path).toContain(join(folder, '.open-science', 'artifacts', 'project-1'))
    expect(await readFile(artifact.path, 'utf8')).toBe('durable output')
    expect(
      await f.client.artifactVersion.findUniqueOrThrow({ where: { id: artifact.versionId } })
    ).toMatchObject({ producerRunId })
    const version = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: artifact.versionId }
    })
    const snapshot = JSON.parse(version.executionSnapshotJson!)
    expect(
      snapshot.provenanceGraph.activities.find(
        (activity: { activityId: string }) => activity.activityId === producerRunId
      )
    ).toMatchObject({ evidenceState: document!.runs.at(-1)!.fileEvidence!.state })
    expect(snapshot.provenanceGraph.reasonCodes).not.toContain('activity-evidence-unavailable')
    expect(snapshot.provenanceGraph.reasonCodes).not.toContain('activity-evidence-corrupt')
    expect(await f.compatibilityRepository.resolveManagedFilePath({ path: artifact.path })).toBe(
      artifact.path
    )
  }
  await writeFile(join(folder, 'output.txt'), 'changed user file')
  for (const artifact of artifacts)
    expect(await readFile(artifact.path, 'utf8')).toBe('durable output')
}, 30_000)

it('offers published Notebook files through their Artifact heads and retains independent folder files', async () => {
  let folder = ''
  const f = await createArtifactSaveFixture(undefined, {
    assertProjectFolderHealthy: async () => folder
  })
  fixtures.push(f)
  const { projectId, appSessionId: sessionId } = f.binding
  folder = await realpath(await mkdtemp(join(tmpdir(), 'os-notebook-mention-')))
  externalFolders.push(folder)
  const workspace = join(f.storageRoot, 'workspace')
  await mkdir(workspace)
  await initializeProjectRecordStorage(f.storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId,
    name: 'Research',
    createdAt: 1
  })
  await f.client.project.create({ data: { id: projectId, name: 'Research', rootPath: folder } })
  const messages: PersistedChatSession['messages'] = (['user', 'agent'] as const).map(
    (role, index) => ({
      id: index === 0 ? 'prompt' : 'answer',
      role,
      content: 'Publish results',
      status: 'complete',
      eventIds: [],
      createdAt: index + 1,
      updatedAt: index + 1
    })
  )
  const graph = createLinearConversationGraph({
    sessionId,
    messages,
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 2
  })
  const rootFrameId = graph.rootFrameId
  const context = {
    ...f.binding,
    rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'prompt'
  }
  const outputs = {
    'mention_result.py': Buffer.from('print(1)'),
    'mention_result.png': createPngBytes(Buffer.alloc(12 * 1024 * 1024)),
    'mention_result_unpublished.txt': Buffer.from('unpublished'),
    'mention_result_same_bytes.py': Buffer.from('print(1)')
  }
  await writeFile(join(folder, 'mention_result.py'), outputs['mention_result.py'])
  const run = await f.service.executeControl({
    projectId,
    sessionId,
    workspaceCwd: workspace,
    provenanceContext: context,
    code: Object.entries(outputs)
      .map(([filename, bytes]) => {
        const prefix = JSON.stringify(bytes.subarray(0, 16).toString('base64'))
        return `require("node:fs").writeFileSync(require("node:path").join(process.env.OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR, ${JSON.stringify(filename)}), Buffer.concat([Buffer.from(${prefix}, "base64")], ${bytes.length}))`
      })
      .join('\n')
  })
  expect(run.status, run.traceback || run.stderr).toBe('completed')
  const lane = createRootNotebookLane(projectId, sessionId, rootFrameId)
  const notebook = await f.notebookRepository.findExisting(projectId, sessionId, lane)
  const producerRunId = notebook!.runs.at(-1)!.runId
  const outputRelativePath = getNotebookSessionOutputRelativePath(projectId, sessionId)
  const env = await f.environment(
    { allowedImportRoots: [workspace], workspaceCwd: workspace },
    { ...context, notebookSessionId: sessionId }
  )
  const publications = [
    { source: 'mention_result.py', filename: 'mention_result_code.py' },
    { source: 'mention_result.png', filename: 'mention_result.png' }
  ] as const
  const readRecords = vi.fn<ReadPublishedArtifactFolderRecords>((...scope) =>
    listPublishedArtifactFolderRecords(f.client, ...scope)
  )
  const projectFolder = new ProjectFolderFiles(
    async () => ({ rootPath: folder }) as Project,
    () => f.storageRoot,
    (projectId, root, storageRoot, candidates) =>
      findPublishedArtifactCopies(projectId, root, storageRoot, candidates, readRecords)
  )
  const search = (relativePath = '', query = 'mention_result'): Promise<ProjectFolderListing> =>
    projectFolder.listFolder({
      projectId,
      relativePath,
      limit: 12,
      query,
      searchDescendants: true,
      excludePublishedArtifactCopies: true
    })
  const artifacts = []
  const reconstruction = new ArtifactCodeReconstructionService({
    provenance: f.repository,
    runner: { captureTarget: vi.fn(), run: vi.fn() }
  })
  for (const { source, filename } of publications) {
    const artifact = await writeArtifactFileForCurrentRun(f.compatibilityRepository, env, {
      filename,
      source: { kind: 'localPath', path: join(folder, outputRelativePath, source) }
    })
    artifacts.push(artifact)
    const request = {
      projectId,
      appSessionId: sessionId,
      artifactId: artifact.artifactId!,
      versionId: artifact.versionId!
    }
    const state = await reconstruction.get(request)
    expect(state, JSON.stringify(state)).toMatchObject({ state: 'ready' })
    await expect(f.repository.getVersionExecution(request)).resolves.toMatchObject({
      execution: { producerRunId, runs: [{ runId: producerRunId }] }
    })
    const generation = run.workingFiles?.find(
      (file) => file.relativePath === `data/${outputRelativePath}/${source}`
    )
    expect(generation?.generationId).toBeTruthy()
    const version = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: artifact.versionId }
    })
    expect(JSON.parse(version.executionSnapshotJson!).provenanceGraph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        entityId: `file-generation:${generation!.generationId}`,
        evidenceSource: 'artifact-publication'
      })
    )
  }

  const managed = new ManagedFileVersionService({
    storageRoot: f.storageRoot,
    getClient: async () => f.client
  })
  const delivery = new ArtifactOutputDelivery({
    storageRoot: f.storageRoot,
    getClient: async () => f.client,
    openVersion: (request, versionId) => managed.openVersion(request, versionId),
    getLayout: async (projectId, sessionId) =>
      getProjectSessionOutputLayout(f.storageRoot, projectId, sessionId)
  })
  managed.setArtifactOutputDelivery(delivery)
  const publisher = new ArtifactProvenanceRepository({
    ...f.repositoryOptions,
    managedFileVersions: managed,
    onHeadActivated: (versions) => delivery.deliverActivated(versions),
    loadSession: async () => ({
      id: sessionId,
      projectId,
      title: 'Research',
      cwd: workspace,
      status: 'idle',
      messages,
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 2
    })
  })
  const proof = {
    projectId,
    appSessionId: sessionId,
    artifactRunId: context.artifactRunId,
    rootFrameId,
    agentFrameId: context.agentFrameId,
    messageBranchId: context.messageBranchId,
    runtimeSegmentId: context.runtimeSegmentId,
    promptMessageId: context.promptMessageId,
    messageId: 'answer',
    artifactVersionIds: artifacts.map((artifact) => artifact.versionId!)
  }
  await publisher.finalizeRun(proof)
  expect((await search()).entries).toHaveLength(5)
  await publisher.activateFinalizedRun(proof)
  const catalog = new ProjectFilesQueryOwner(
    async () => f.client,
    () => true
  )
  const { items } = await catalog.listFiles({ projectId, collection: { kind: 'all' }, limit: 12 })
  expect(items.map((item) => item.sourceVersionId).sort()).toEqual(
    proof.artifactVersionIds.toSorted()
  )
  for (const artifact of artifacts) {
    const inspected = await managed.inspect({
      source: 'artifact',
      projectId,
      fileId: artifact.artifactId!
    })
    expect(inspected, JSON.stringify(inspected.outputDelivery)).toMatchObject({
      headVersionId: artifact.versionId,
      outputDelivery: { state: 'delivered' }
    })
  }

  const artifactDirectory = getProjectSessionOutputLayout(
    f.storageRoot,
    projectId,
    sessionId
  )!.artifactDirectoryRelativePath
  readRecords.mockClear()
  const digest = vi.spyOn(boundedIo, 'digestOpenFileWithinBudget')
  const folderPaths = (await search('', '')).entries.map((entry) => entry.relativePath)
  expect(digest).not.toHaveBeenCalled()
  digest.mockRestore()
  expect(readRecords).toHaveBeenCalledTimes(1)
  expect(readRecords).toHaveBeenCalledWith(
    projectId,
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'notebook',
        relativePath: `${outputRelativePath}/mention_result.png`
      }),
      expect.objectContaining({
        kind: 'delivery',
        relativePath: `${artifactDirectory}/mention_result.png`
      })
    ])
  )
  expect(folderPaths.sort()).toEqual(
    [
      'mention_result.py',
      `${outputRelativePath}/mention_result_same_bytes.py`,
      `${outputRelativePath}/mention_result_unpublished.txt`
    ].sort()
  )
  const renamed = await search('', 'mention_result.py')
  expect(renamed.entries.map((entry) => entry.relativePath)).toEqual(['mention_result.py'])
  expect(renamed.publishedArtifacts).toEqual([
    expect.objectContaining({
      name: 'mention_result_code.py',
      sourceFileId: artifacts[0].artifactId,
      versionId: artifacts[0].versionId,
      relativePath: `${outputRelativePath}/mention_result.py`,
      exactPathMatch: false
    })
  ])
  const prefixed = await search(outputRelativePath, 'mention_res')
  expect(prefixed.entries.map((entry) => entry.name).sort()).toEqual([
    'mention_result_same_bytes.py',
    'mention_result_unpublished.txt'
  ])
  expect(prefixed.publishedArtifacts?.map((artifact) => artifact.versionId).sort()).toEqual(
    proof.artifactVersionIds.toSorted()
  )
  const browser = await projectFolder.listFolder({
    projectId,
    relativePath: artifactDirectory,
    limit: 20
  })
  expect(browser.entries.map((entry) => entry.name).sort()).toEqual(
    publications.map(({ filename }) => filename).sort()
  )
  for (const [index, { filename, source }] of publications.entries()) {
    const expectExact = expect.objectContaining({
      publishedArtifacts: [
        expect.objectContaining({
          name: filename,
          sourceFileId: artifacts[index].artifactId,
          versionId: artifacts[index].versionId,
          exactPathMatch: true
        })
      ]
    })
    expect(await search(artifactDirectory, filename)).toEqual(expectExact)
    expect(await search(outputRelativePath, source)).toEqual(expectExact)
    expect(
      (await readFile(join(folder, artifactDirectory, filename))).equals(outputs[source])
    ).toBe(true)
    expect((await readFile(join(folder, outputRelativePath, source))).equals(outputs[source])).toBe(
      true
    )
    expect((await readFile(artifacts[index].path)).equals(outputs[source])).toBe(true)
  }
  const pythonSource = join(folder, outputRelativePath, 'mention_result.py')
  const pythonStat = await stat(pythonSource)
  await utimes(pythonSource, pythonStat.atime, new Date(pythonStat.mtimeMs + 3000))
  const touched = await search(outputRelativePath, 'mention_result.py')
  expect(touched.entries).toEqual([])
  expect(touched.publishedArtifacts?.map((item) => item.versionId)).toEqual([
    artifacts[0].versionId
  ])
  // A rewrite of the large source keeps its size and uses the same path.
  const changed = createPngBytes(Buffer.alloc(12 * 1024 * 1024, 1))
  await writeFile(join(folder, outputRelativePath, 'mention_result.png'), changed)
  const patched = await search(outputRelativePath, 'mention_result.png')
  expect(patched.entries.map((entry) => entry.name)).toEqual(['mention_result.png'])
  expect(patched.publishedArtifacts).toBeUndefined()
}, 30_000)
