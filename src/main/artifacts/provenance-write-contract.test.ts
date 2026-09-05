import { createHash } from 'node:crypto'
import { dirname, join, posix } from 'node:path'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { NotebookRuntimeService, type NotebookExecutionResult } from '../notebook/runtime-service'
import { createPngBytes } from './artifact-test-fixtures'
import * as provenanceModule from './provenance-repository'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { requireAgentArtifactVersion } from './provenance-version-kind'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture,
  provenanceGraph
} from './provenance-test-fixtures'

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>

const fixtures: Fixture[] = []
const fixture = async (): Promise<Fixture> => {
  const value = await createProvenanceTestFixture()
  fixtures.push(value)
  return value
}

const listFixtureRunVersions = (
  value: Fixture
): ReturnType<Fixture['repository']['listRunVersions']> =>
  value.repository.listRunVersions({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactRunId: 'artifact-run-1'
  })

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()))
})

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

const PUBLIC_METHODS = [
  'writeAppGeneratedVersion',
  'createVersion',
  'reserveWrite',
  'releaseWriteReservation',
  'releaseRunWriteReservations',
  'releaseAllWriteReservations',
  'replayVersion',
  'validateFinalizationOwnership',
  'finalizeRun',
  'activateFinalizedRun',
  'listRunVersions',
  'prepareProjectReconciliation',
  'reconcileSession',
  'getLineage',
  'getVersionProvenance',
  'getReviewerVersionTrace',
  'resolveVersionDescriptors',
  'getVersionCore',
  'readDependencyRelations',
  'getVersionExecution',
  'getVersionMessages',
  'getVersionReview',
  'readCodeReconstructionCache',
  'writeCodeReconstructionCache',
  'resolveReviewerTurnFileEvidence',
  'deleteProjectProvenance'
] as const satisfies readonly (keyof ArtifactProvenanceRepository)[]

type PublicMethod = keyof ArtifactProvenanceRepository
type ListedMethod = (typeof PUBLIC_METHODS)[number]
type ExactMethodInventory = [PublicMethod] extends [ListedMethod]
  ? [ListedMethod] extends [PublicMethod]
    ? true
    : false
  : false
const exactMethodInventory: ExactMethodInventory = true

// Hosted Windows runners rebuild the application schema under disk contention.
// The Windows full-test workflow default is 60s; write-identity suites finish later without hanging.
const WINDOWS_SQLITE_TEST_TIMEOUT_MS = 120_000

describe('artifact provenance public write contract', () => {
  it('captures constructor, method, and runtime value exports without private placement', async () => {
    const { repository } = await fixture()

    expect(exactMethodInventory).toBe(true)
    expect(PUBLIC_METHODS.every((name) => typeof repository[name] === 'function')).toBe(true)
    expect(Object.keys(provenanceModule).sort()).toEqual([
      'ArtifactFinalizationProofError',
      'ArtifactOwnershipPersistenceRaceError',
      'ArtifactProvenanceRepository'
    ])
    expect(repository).toBeInstanceOf(ArtifactProvenanceRepository)
  })
})

describe('artifact provenance allocation and write identity', () => {
  it('advances one case-folded lineage while preserving immutable bytes and canonical evidence', async () => {
    const { client, repository, stagePng, storageRoot } = await fixture()
    await stagePng('version one', 'Plot.PNG')
    const first = await repository.createVersion(
      createArtifactVersionRequest({
        filename: 'Plot.PNG',
        writeOperationId: 'write-1',
        writeRequestChecksum: '1'.repeat(64)
      })
    )
    await stagePng('version two', 'plot.png')
    const second = await repository.createVersion(
      createArtifactVersionRequest({
        filename: 'plot.png',
        writeOperationId: 'write-2',
        writeRequestChecksum: '2'.repeat(64)
      })
    )

    expect(second).toMatchObject({ artifactId: first.artifactId, versionNumber: 2 })
    expect(first.versionId).not.toBe(second.versionId)
    await expect(readFile(first.path)).resolves.toEqual(createPngBytes('version one'))
    await expect(readFile(second.path)).resolves.toEqual(createPngBytes('version two'))

    const rows = await client.artifactVersion.findMany({
      where: { artifactId: first.artifactId },
      orderBy: { versionNumber: 'asc' }
    })
    expect(rows.map(({ versionNumber }) => versionNumber)).toEqual([1, 2])
    for (const [index, row] of rows.entries()) {
      const agentRow = requireAgentArtifactVersion(row)
      const expectedBytes = createPngBytes(index === 0 ? 'version one' : 'version two')
      expect(agentRow.checksum).toBe(sha256(expectedBytes))
      expect(agentRow.evidenceChecksum).toBe(sha256(agentRow.evidenceJson))
      expect(agentRow.evidenceJson).toBe(
        JSON.stringify(canonicalize(JSON.parse(agentRow.evidenceJson)))
      )
      expect(JSON.parse(agentRow.evidenceJson)).toMatchObject({
        artifact_id: first.artifactId,
        version_id: agentRow.id,
        version_number: index + 1,
        checksum: agentRow.checksum
      })
      await expect(
        readFile(join(storageRoot, ...agentRow.contentStorageKey.split('/')))
      ).resolves.toEqual(expectedBytes)
      await expect(
        readFile(join(storageRoot, ...agentRow.evidenceStorageKey.split('/')), 'utf8')
      ).resolves.toBe(agentRow.evidenceJson)
    }
  })

  it(
    'returns the original immutable Version for an exact operation retry and rejects reuse',
    async () => {
      const { client, repository, stagePng } = await fixture()
      const request = createArtifactVersionRequest({
        writeOperationId: 'stable-operation',
        writeRequestChecksum: '3'.repeat(64)
      })
      await stagePng('original bytes')
      const first = await repository.createVersion(request)
      await stagePng('changed pending bytes')

      const retried = await repository.createVersion(request)

      expect(retried).toMatchObject({ versionId: first.versionId, versionNumber: 1 })
      await expect(readFile(retried.path)).resolves.toEqual(createPngBytes('original bytes'))
      await expect(client.artifactVersion.count()).resolves.toBe(1)
      await expect(
        repository.createVersion({ ...request, writeRequestChecksum: '4'.repeat(64) })
      ).rejects.toThrow(/write operation.*different request/i)
      await expect(client.artifactVersion.count()).resolves.toBe(1)
    },
    WINDOWS_SQLITE_TEST_TIMEOUT_MS
  )

  it('diffs a generated text Version against its published or same-run predecessor', async () => {
    const value = await fixture()
    await value.client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'write a README',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const assistant = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt, assistant],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Generated text versions',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, assistant],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => session
    })
    const context = {
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: conversationGraph.branches[0].id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: prompt.id
    }
    const writeVersion = async (
      artifactRunId: string,
      writeOperationId: string,
      content: string
    ): Promise<ArtifactVersionFile> => {
      await value.compatibilityRepository.writePendingFile({
        projectId: 'project-1',
        sessionId: 'artifact-session-1',
        runId: artifactRunId,
        filename: 'README.md',
        mimeType: 'text/markdown',
        source: { kind: 'inline', content, encoding: 'utf8' }
      })
      return repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId,
        writeOperationId,
        writeRequestChecksum: sha256(writeOperationId),
        ...context,
        filename: 'README.md',
        contentType: 'text/markdown'
      })
    }
    const finishRun = async (
      artifactRunId: string,
      artifactVersionIds: string[],
      activate: boolean
    ): Promise<void> => {
      const request = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId,
        artifactVersionIds,
        ...context,
        messageId: assistant.id
      }
      const finalized = await repository.finalizeRun(request)
      expect(finalized.every((artifact) => artifact.isPublished === false)).toBe(true)
      if (activate) {
        const published = await repository.activateFinalizedRun(request)
        expect(published.every((artifact) => artifact.isPublished === true)).toBe(true)
      }
    }

    const first = await writeVersion('artifact-run-public', 'write-markdown-1', '# First\n')
    expect(first.isPublished).toBe(false)
    await finishRun('artifact-run-public', [first.versionId], true)

    const hidden = await writeVersion('artifact-run-hidden', 'write-markdown-2', '# Hidden\n')
    await finishRun('artifact-run-hidden', [hidden.versionId], false)

    const third = await writeVersion('artifact-run-active', 'write-markdown-3', '# Third\n')
    const fourth = await writeVersion('artifact-run-active', 'write-markdown-4', '# Fourth\n')
    await expect(
      value.client.artifactVersion.findMany({
        where: { id: { in: [third.versionId, fourth.versionId] } },
        orderBy: { versionNumber: 'asc' },
        select: { basedOnVersionId: true }
      })
    ).resolves.toEqual([
      { basedOnVersionId: first.versionId },
      { basedOnVersionId: third.versionId }
    ])

    await finishRun('artifact-run-active', [third.versionId, fourth.versionId], false)
    await expect(
      value.client.artifactLineage.findUniqueOrThrow({ where: { id: first.artifactId } })
    ).resolves.toMatchObject({ currentVersionId: first.versionId })
    await expect(
      value.client.artifactVersion.findUniqueOrThrow({ where: { id: hidden.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', managedVisibleAt: null })

    await repository.activateFinalizedRun({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactRunId: 'artifact-run-active',
      artifactVersionIds: [third.versionId, fourth.versionId],
      ...context,
      messageId: assistant.id
    })

    const service = new ManagedFileVersionService({
      storageRoot: value.storageRoot,
      getClient: () => Promise.resolve(value.client)
    })
    await expect(
      service.diffText({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fourth.artifactId,
        versionId: fourth.versionId,
        requestId: 'generated-markdown-diff'
      })
    ).resolves.toMatchObject({
      baseVersionId: third.versionId,
      selectedVersionId: fourth.versionId,
      lines: expect.arrayContaining([
        expect.objectContaining({ kind: 'removed', oldLineNumber: 1 }),
        expect.objectContaining({ kind: 'added', newLineNumber: 1 })
      ])
    })
  })

  it('keeps the SQLite lifecycle in staging when an immutable evidence barrier fails', async () => {
    const value = await fixture()
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      durability: {
        syncFile: async (path) => {
          if (path.endsWith('evidence.json')) throw new Error('evidence barrier failed')
        },
        syncDirectory: async () => undefined
      }
    })
    const request = createArtifactVersionRequest({ writeOperationId: 'barrier-operation' })
    await value.stagePng('barrier bytes')

    await expect(repository.createVersion(request)).rejects.toThrow('evidence barrier failed')
    await expect(
      value.client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'staging' })
  })
})

const appendNotebookRun = async (
  value: Fixture,
  input: {
    runId: string
    filename: string
    payload: string
    ownsSource: boolean
    inputFiles?: NotebookRunInputFile[]
    provenanceContext?: Partial<
      Pick<
        NotebookRunRecord,
        'rootFrameId' | 'agentFrameId' | 'messageBranchId' | 'runtimeSegmentId' | 'promptMessageId'
      >
    >
  }
): Promise<{ path: string; sizeBytes: number; mtimeMs: number }> => {
  const lane = createFrameNotebookLane('project-1', 'session-1', provenanceGraph.agentFrameId)
  const document = await value.notebookRepository.loadOrCreate({
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: join(value.storageRoot, 'workspace'),
    lane
  })
  const sourcePath = join(document.notebookSessionRoot, 'data', input.filename)
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, createPngBytes(input.payload))
  const sourceStat = await stat(sourcePath)
  await value.notebookRepository.appendRun({
    projectId: 'project-1',
    sessionId: 'session-1',
    lane,
    run: {
      runId: input.runId,
      cellId: `cell-${input.runId}`,
      source: 'agent',
      kernelKind: 'python',
      status: 'completed',
      startedAt: sourceStat.mtimeMs - 100,
      endedAt: sourceStat.mtimeMs + 100,
      script: `save_plot(${JSON.stringify(input.filename)})`,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      inputFiles: input.inputFiles ?? [],
      workingFiles: input.ownsSource
        ? [
            {
              path: sourcePath,
              relativePath: posix.join('data', input.filename),
              kind: 'other',
              size: sourceStat.size,
              mtimeMs: sourceStat.mtimeMs,
              createdByRunId: input.runId
            }
          ]
        : [],
      ...provenanceGraph,
      ...input.provenanceContext
    }
  })
  return {
    path: await realpath(sourcePath),
    sizeBytes: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs
  }
}

const createReadyUploadInput = async (
  value: Fixture
): Promise<{ input: NotebookRunInputFile; inputPath: string }> => {
  const content = 'source-A'
  const storageKey =
    'uploads/project-1/source-session-1/upload-file-1/versions/upload-version-1/content'
  const inputPath = join(value.storageRoot, ...storageKey.split('/'))
  const createdAt = new Date('2026-08-08T08:00:00.000Z')
  await mkdir(dirname(inputPath), { recursive: true })
  await writeFile(inputPath, content)
  await value.client.project.upsert({
    where: { id: 'project-1' },
    create: { id: 'project-1', name: 'Project one' },
    update: {}
  })
  await value.client.fileOriginSession.upsert({
    where: {
      projectId_sessionId: { projectId: 'project-1', sessionId: 'source-session-1' }
    },
    create: { projectId: 'project-1', sessionId: 'source-session-1' },
    update: {}
  })
  await value.client.uploadFile.create({
    data: {
      id: 'upload-file-1',
      projectId: 'project-1',
      sessionId: 'source-session-1',
      filename: 'input.csv',
      originalFilename: 'input.csv',
      versions: {
        create: {
          id: 'upload-version-1',
          versionNumber: 1,
          state: 'ready',
          contentStorageKey: storageKey,
          filename: 'input.csv',
          originalFilename: 'input.csv',
          contentType: 'text/csv',
          sizeBytes: BigInt(Buffer.byteLength(content)),
          checksum: sha256(content),
          createdAt
        }
      }
    }
  })
  await value.client.uploadFile.update({
    where: { id: 'upload-file-1' },
    data: { currentVersionId: 'upload-version-1' }
  })
  return {
    inputPath,
    input: {
      inputFileVersionId: 'upload-version-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-file-1',
      sourceVersionNumber: 1,
      sourceCreatedAt: createdAt.toISOString(),
      sourceProjectId: 'project-1',
      sourceSessionId: 'source-session-1',
      filename: 'input.csv',
      contentType: 'text/csv',
      sizeBytes: Buffer.byteLength(content),
      checksum: sha256(content),
      storageKey,
      association: 'resolver-accessed'
    }
  }
}

describe('artifact provenance producer and source validation', () => {
  it('accepts a root Notebook producer after renderer state creates the Session owner first', async () => {
    const value = await fixture()
    const rootFrameId = 'root-frame-pending-session-1'
    const service = new NotebookRuntimeService({
      configRoot: value.storageRoot,
      dataRoot: value.storageRoot,
      projectId: 'project-1',
      repository: value.notebookRepository,
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    try {
      await service.state({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: join(value.storageRoot, 'workspace')
      })
      await service.executeControl({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: join(value.storageRoot, 'workspace'),
        code: 'save_plot("plot.png")',
        provenanceContext: {
          rootFrameId,
          agentFrameId: rootFrameId,
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-segment-1',
          promptMessageId: 'prompt-1'
        }
      })
      const notebookState = await service.state({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: join(value.storageRoot, 'workspace')
      })
      const producerRunId = notebookState.runs.at(-1)?.runId
      expect(producerRunId).toBeDefined()

      await value.stagePng('producer bytes')
      const version = await value.repository.createVersion(
        createArtifactVersionRequest({
          notebookSessionId: 'session-1',
          producerRunId,
          sourceKind: 'inline',
          rootFrameId,
          agentFrameId: rootFrameId,
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-segment-1',
          promptMessageId: 'prompt-1'
        })
      )

      await expect(
        value.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
      ).resolves.toMatchObject({ producerRunId })
    } finally {
      await service.shutdownAll()
    }
  })

  it('binds a declared producer only to the exact observed source owner and retries identically', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'producer-run',
      filename: 'plot.png',
      payload: 'producer bytes',
      ownsSource: true
    })
    await appendNotebookRun(value, {
      runId: 'unrelated-run',
      filename: 'unrelated.png',
      payload: 'unrelated bytes',
      ownsSource: false
    })
    await value.stagePng('producer bytes')
    const request = createArtifactVersionRequest({
      writeOperationId: 'producer-operation',
      notebookSessionId: 'session-1',
      producerRunId: 'producer-run',
      sourceKind: 'localPath',
      sourceFileObservation: observation
    })

    const version = await value.repository.createVersion(request)
    const row = requireAgentArtifactVersion(
      await value.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    )
    expect(row).toMatchObject({ producerRunId: 'producer-run', producerRunIndex: 0 })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: {
        state: 'available',
        producer_run_id: 'producer-run',
        association_method: 'agent-declared-and-session-validated'
      },
      execution_status: { state: 'available' }
    })
    await expect(value.repository.createVersion(request)).resolves.toMatchObject({
      versionId: version.versionId,
      versionNumber: 1
    })

    await expect(
      value.repository.createVersion({
        ...request,
        writeOperationId: 'wrong-owner-operation',
        writeRequestChecksum: '5'.repeat(64),
        producerRunId: 'unrelated-run'
      })
    ).rejects.toThrow(/producer.*source.*another Notebook run/i)
    await expect(value.client.artifactVersion.count()).resolves.toBe(1)

    await expect(
      value.repository.createVersion({
        ...request,
        writeOperationId: 'wrong-scope-operation',
        writeRequestChecksum: '7'.repeat(64),
        runtimeSegmentId: 'other-runtime-segment'
      })
    ).rejects.toThrow(/producer run does not belong.*runtimeSegmentId/i)
    await expect(value.client.artifactVersion.count()).resolves.toBe(1)
  })

  it('accepts a declared source owner from an ancestor Conversation Branch', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'ancestor-producer-run',
      filename: 'plot.png',
      payload: 'ancestor producer bytes',
      ownsSource: true,
      provenanceContext: {
        messageBranchId: 'branch-parent',
        runtimeSegmentId: 'runtime-segment-parent',
        promptMessageId: 'prompt-parent'
      }
    })
    await value.stagePng('ancestor producer bytes')

    const version = await value.repository.createVersion(
      createArtifactVersionRequest({
        writeOperationId: 'ancestor-producer-operation',
        notebookSessionId: 'session-1',
        producerRunId: 'ancestor-producer-run',
        sourceKind: 'localPath',
        sourceFileObservation: observation,
        messageBranchAncestry: ['branch-parent', provenanceGraph.messageBranchId],
        messageAncestry: ['prompt-parent', provenanceGraph.promptMessageId]
      })
    )

    await expect(
      value.repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({ execution: { producerRunId: 'ancestor-producer-run' } })
  })

  it('infers the exact source owner from an ancestor Branch when producerRunId is omitted', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'inferred-ancestor-run',
      filename: 'plot.png',
      payload: 'inferred ancestor bytes',
      ownsSource: true,
      provenanceContext: {
        messageBranchId: 'branch-parent',
        runtimeSegmentId: 'runtime-segment-parent',
        promptMessageId: 'prompt-parent'
      }
    })
    await value.stagePng('inferred ancestor bytes')

    const version = await value.repository.createVersion(
      createArtifactVersionRequest({
        writeOperationId: 'inferred-ancestor-operation',
        notebookSessionId: 'session-1',
        sourceKind: 'localPath',
        sourceFileObservation: observation,
        messageBranchAncestry: ['branch-parent', provenanceGraph.messageBranchId],
        messageAncestry: ['prompt-parent', provenanceGraph.promptMessageId]
      })
    )

    await expect(
      value.repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({ execution: { producerRunId: 'inferred-ancestor-run' } })
  })

  it('rejects a missing declared run but never infers a producer from mtime alone', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'mtime-only-run',
      filename: 'plot.png',
      payload: 'mtime bytes',
      ownsSource: false
    })
    await value.stagePng('mtime bytes')
    const base = createArtifactVersionRequest({
      notebookSessionId: 'session-1',
      sourceKind: 'localPath',
      sourceFileObservation: observation
    })

    await expect(
      value.repository.createVersion({
        ...base,
        writeOperationId: 'missing-producer-operation',
        producerRunId: 'missing-run'
      })
    ).rejects.toThrow('Notebook producer run not found: missing-run')

    await expect(
      value.repository.createVersion({
        ...base,
        writeOperationId: 'mtime-operation',
        writeRequestChecksum: '6'.repeat(64)
      })
    ).rejects.toThrow('Notebook source must have exactly one eligible Run owner.')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects Artifact Finalization when a declared producer source observation is corrupt', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'observed-run',
      filename: 'plot.png',
      payload: 'observed bytes',
      ownsSource: true
    })
    await value.stagePng('observed bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'corrupt-observation-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'observed-run',
          sourceKind: 'localPath',
          sourceFileObservation: { ...observation, sizeBytes: observation.sizeBytes + 1 }
        })
      )
    ).rejects.toThrow('Notebook producer source could not be verified: observed-run')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects a corrupt Notebook-owned source observation when producerRunId is omitted', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'inferred-corrupt-observation-run',
      filename: 'plot.png',
      payload: 'inferred corrupt observation bytes',
      ownsSource: true
    })
    await value.stagePng('inferred corrupt observation bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'inferred-corrupt-observation-operation',
          notebookSessionId: 'session-1',
          sourceKind: 'localPath',
          sourceFileObservation: { ...observation, sizeBytes: observation.sizeBytes + 1 }
        })
      )
    ).rejects.toThrow('Notebook source observation could not be verified.')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects a Notebook-owned source when its Run document is unreadable', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'unreadable-document-run',
      filename: 'plot.png',
      payload: 'unreadable document bytes',
      ownsSource: true
    })
    await writeFile(join(dirname(dirname(observation.path)), 'run.json'), '{ not-json', 'utf8')
    await value.stagePng('unreadable document bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'unreadable-document-operation',
          notebookSessionId: 'session-1',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow('Notebook source must have exactly one eligible Run owner.')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects Artifact Finalization when a declared local producer has no source observation', async () => {
    const value = await fixture()
    await appendNotebookRun(value, {
      runId: 'unobserved-source-run',
      filename: 'plot.png',
      payload: 'unobserved source bytes',
      ownsSource: true
    })
    await value.stagePng('unobserved source bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'unobserved-source-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'unobserved-source-run',
          sourceKind: 'localPath'
        })
      )
    ).rejects.toThrow('Notebook producer source observation is required: unobserved-source-run')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects Artifact Finalization when no Run owns the declared producer source', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'unowned-source-run',
      filename: 'plot.png',
      payload: 'unowned source bytes',
      ownsSource: false
    })
    await value.stagePng('unowned source bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'unowned-source-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'unowned-source-run',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow('Producer source must have exactly one Run owner: unowned-source-run')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('rejects an unowned Notebook source when producerRunId is omitted', async () => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'unowned-inferred-run',
      filename: 'plot.png',
      payload: 'unowned inferred bytes',
      ownsSource: false
    })
    await value.stagePng('unowned inferred bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'unowned-inferred-operation',
          notebookSessionId: 'session-1',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow('Notebook source must have exactly one eligible Run owner.')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })

  it('requires a Notebook Session for an inline declared producer', async () => {
    const value = await fixture()
    await value.stagePng('inline producer bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'producer-without-session-operation',
          producerRunId: 'producer-run',
          sourceKind: 'inline'
        })
      )
    ).rejects.toThrow('producerRunId requires notebookSessionId in the active Artifact run.')
  })

  it('rejects an observed source outside both durable Notebook roots', async () => {
    const value = await fixture()
    await appendNotebookRun(value, {
      runId: 'outside-root-run',
      filename: 'plot.png',
      payload: 'outside root bytes',
      ownsSource: true
    })
    const outsidePath = join(value.storageRoot, 'outside-notebook-roots', 'plot.png')
    await mkdir(dirname(outsidePath), { recursive: true })
    await writeFile(outsidePath, createPngBytes('outside root bytes'))
    const outsideStat = await stat(outsidePath)
    await value.stagePng('outside root bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'outside-root-observation-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'outside-root-run',
          sourceKind: 'localPath',
          sourceFileObservation: {
            path: await realpath(outsidePath),
            sizeBytes: outsideStat.size,
            mtimeMs: outsideStat.mtimeMs
          }
        })
      )
    ).rejects.toThrow('Notebook producer source could not be verified: outside-root-run')
    await expect(listFixtureRunVersions(value)).resolves.toEqual([])
  })
})

describe('artifact provenance input authority', () => {
  const baseUploadInput = {
    inputFileVersionId: 'missing-upload-version',
    sourceKind: 'upload-version',
    sourceFileId: 'upload-file-1',
    sourceVersionNumber: 1,
    sourceProjectId: 'project-1',
    sourceSessionId: 'source-session-1',
    filename: 'input.csv',
    contentType: 'text/csv',
    sizeBytes: 4,
    checksum: 'b'.repeat(64),
    storageKey: 'uploads/project-1/source-session-1/upload-file-1/input.csv',
    association: 'resolver-accessed'
  } as const satisfies NotebookRunInputFile

  it.each([
    {
      name: 'cross-project input',
      input: { ...baseUploadInput, sourceProjectId: 'other-project' },
      error: 'Notebook input belongs to another Project: missing-upload-version'
    },
    {
      name: 'corrupt Upload identity',
      input: baseUploadInput,
      error: 'Notebook Upload input identity is corrupt: missing-upload-version'
    }
  ])('rejects a $name', async ({ input, error }) => {
    const value = await fixture()
    const observation = await appendNotebookRun(value, {
      runId: 'input-authority-run',
      filename: 'plot.png',
      payload: 'input authority bytes',
      ownsSource: true,
      inputFiles: [input]
    })
    await value.stagePng('input authority bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: `invalid-${input.sourceProjectId}-input-operation`,
          notebookSessionId: 'session-1',
          producerRunId: 'input-authority-run',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow(error)
    await expect(value.client.artifactVersion.count()).resolves.toBe(0)
  })

  it('rejects corrupt immutable input bytes at Provenance commit time', async () => {
    const value = await fixture()
    const { input, inputPath } = await createReadyUploadInput(value)
    const inputAuthority = new ImmutableInputAuthority({
      storageRoot: value.storageRoot,
      managedFileVersions: new ManagedFileVersionService({
        storageRoot: value.storageRoot,
        getClient: () => Promise.resolve(value.client)
      })
    })
    await inputAuthority.resolveVersion({
      projectId: 'project-1',
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId,
      expectedSourceFileId: input.sourceFileId
    })
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      inputAuthority
    })
    const observation = await appendNotebookRun(value, {
      runId: 'corrupt-input-run',
      filename: 'plot.png',
      payload: 'derived bytes',
      ownsSource: true,
      inputFiles: [input]
    })
    await writeFile(inputPath, 'source-B')
    await value.stagePng('derived bytes')

    await expect(
      repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'corrupt-input-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'corrupt-input-run',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow(/version content is unavailable or corrupt/i)
    await expect(value.client.artifactVersion.count()).resolves.toBe(0)
  })

  it('rejects immutable input metadata drift at Provenance commit time', async () => {
    const value = await fixture()
    const { input } = await createReadyUploadInput(value)
    const observation = await appendNotebookRun(value, {
      runId: 'metadata-drift-run',
      filename: 'plot.png',
      payload: 'derived bytes',
      ownsSource: true,
      inputFiles: [{ ...input, sourceVersionNumber: 2 }]
    })
    await value.stagePng('derived bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'metadata-drift-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'metadata-drift-run',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow(`Notebook Upload input identity is corrupt: ${input.inputFileVersionId}`)
    await expect(value.client.artifactVersion.count()).resolves.toBe(0)
  })

  it('rejects an Artifact input whose durable Version is not finalized', async () => {
    const value = await fixture()
    await value.stagePng('upstream bytes', 'upstream.png')
    const upstream = await value.repository.createVersion(
      createArtifactVersionRequest({
        filename: 'upstream.png',
        writeOperationId: 'pending-upstream-operation'
      })
    )
    const upstreamRow = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: upstream.versionId }
    })
    expect(upstreamRow.state).toBe('pending')
    const observation = await appendNotebookRun(value, {
      runId: 'pending-artifact-input-run',
      filename: 'plot.png',
      payload: 'derived bytes',
      ownsSource: true,
      inputFiles: [
        {
          inputFileVersionId: upstream.versionId,
          sourceKind: 'artifact-version',
          sourceFileId: upstream.artifactId,
          sourceVersionNumber: upstream.versionNumber,
          sourceCreatedAt: upstreamRow.createdAt.toISOString(),
          sourceProjectId: 'project-1',
          sourceSessionId: 'session-1',
          filename: upstreamRow.filename,
          contentType: upstreamRow.contentType ?? undefined,
          sizeBytes: Number(upstreamRow.sizeBytes),
          checksum: upstreamRow.checksum,
          storageKey: upstreamRow.contentStorageKey,
          association: 'resolver-accessed'
        }
      ]
    })
    await value.stagePng('derived bytes')

    await expect(
      value.repository.createVersion(
        createArtifactVersionRequest({
          writeOperationId: 'pending-artifact-input-operation',
          notebookSessionId: 'session-1',
          producerRunId: 'pending-artifact-input-run',
          sourceKind: 'localPath',
          sourceFileObservation: observation
        })
      )
    ).rejects.toThrow(`Notebook Artifact input identity is corrupt: ${upstream.versionId}`)
    await expect(value.client.artifactVersion.count()).resolves.toBe(1)
  })
})
