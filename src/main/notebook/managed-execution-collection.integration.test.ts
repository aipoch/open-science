import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi, type MockInstance } from 'vitest'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { ArtifactFile } from '../../shared/artifacts'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createArtifactHandlers } from '../artifacts/ipc'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { createNotebookArtifactSourceScopeProvider } from './artifact-source-scope'
import { getNotebookDataRoot } from './repository'
import type {
  ExecuteManagedEnvironmentRequest,
  ManagedCollectionReference,
  ManagedEnvironmentReference
} from '../../shared/managed-execution'
import type { NotebookRuntimeService } from './runtime-service'
import type { SessionOperationSnapshot } from './session-operation-owner'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import { ManagedExecutionService, type ManagedExecutionResult } from './managed-execution-service'
import {
  ManagedResearchEnvironmentOwner,
  type ManagedResearchRuntime
} from './managed-research-environment'
import type { ManagedExecutionProvenance } from './managed-execution-output'
import {
  createSessionOperationTestHarness,
  operationTestScope as scope
} from './session-operation.test-support'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const contents = 'value,42\n'

type Fault = 'before-save' | 'after-save' | 'none'
type CollectionObservation = {
  operation: SessionOperationSnapshot
  result?: ManagedExecutionResult
}
type CollectionHarness = {
  h: Awaited<ReturnType<typeof createSessionOperationTestHarness>>
  service: ManagedExecutionService
  environments: ManagedResearchEnvironmentOwner
  environment: ManagedEnvironmentReference
  execute: ExecuteManagedEnvironmentRequest
  dispatch: MockInstance<NotebookRuntimeService['executeManagedShell']>
  savedBeforeFailure: string[]
  collectInOrdinaryTurn(
    reference: ManagedCollectionReference,
    requestId: string,
    alreadyPublished?: boolean
  ): Promise<CollectionObservation>
}
const harness = async (fault: Fault): Promise<CollectionHarness> => {
  const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
  const executable = await realpath(process.execPath)
  const runtime: ManagedResearchRuntime = {
    kind: 'node',
    executable,
    version: process.versions.node,
    sha256: sha('test-runtime'),
    platform: process.platform as 'darwin' | 'linux',
    arch: process.arch,
    readOnlyRoots: [dirname(executable)]
  }
  // The shared fixture runs the real Shell process, Notebook persistence and SQLite Artifact
  // repository. Its pass-through sandbox tests integration, not native OS policy containment.
  const environments = new ManagedResearchEnvironmentOwner({
    dataRoot: h.fixture.storageRoot,
    socketRoot: await realpath(tmpdir()),
    verifyRuntime: async () => undefined,
    stopExecution: async (identity) => ({
      verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true })).reaped
    })
  })
  cleanups.push(() => environments.close())
  // Call-through observation only: no Shell, Notebook or Artifact implementation is replaced.
  const dispatch = vi.spyOn(h.notebook, 'executeManagedShell')
  const savedBeforeFailure: string[] = []
  let injectFault = fault !== 'none'
  const service = new ManagedExecutionService({
    dataRoot: h.fixture.storageRoot,
    notebooks: h.fixture.notebookRepository,
    artifacts: h.artifacts,
    environments,
    runtime: h.notebook,
    operations: {
      start: (request) =>
        h.owner.start({
          ...request,
          execute: (context, signal) =>
            request.execute(
              {
                ...context,
                saveOutput: async (output) => {
                  if (injectFault && output.filename === 'result.csv') {
                    injectFault = false
                    // Simulate the save/collection acknowledgement boundary, preserving the real
                    // writer's beforeWrite intent and (for after-save) its committed immutable Version.
                    if (fault === 'after-save')
                      savedBeforeFailure.push((await context.saveOutput(output)).versionId)
                    throw new Error(`Injected ${fault} collection interruption`)
                  }
                  return context.saveOutput(output)
                }
              },
              signal
            )
        }),
      get: (request) => h.owner.get(request),
      wait: (request) => h.owner.wait(request),
      cancel: (request) => h.owner.cancel(request)
    },
    runtimes: {
      discover: async () => ({ runtimes: [{ runtimeId: sha('runtime-id'), runtime }] }),
      resolve: async () => runtime
    },
    materials: async () => ({
      source: { projectId: scope.projectId, sessionId: 'source', identity: 'fixed-source' },
      versions: [
        {
          versionId: 'input',
          sourceIdentity: 'fixed-source',
          filename: 'input.txt',
          sha256: sha('fixed input'),
          sizeBytes: Buffer.byteLength('fixed input')
        }
      ],
      readVersion: async () => Buffer.from('fixed input')
    }),
    resolvePreparedInputs: async () => [],
    createSession: async () => {
      throw new Error('No additional Session may be created.')
    },
    withWritableSession: async (_identity, operation) => operation()
  })
  const prepared = (await service.prepare({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    requestId: 'prepare',
    sourceSessionId: 'source',
    sourceIdentity: 'fixed-source',
    runtimeId: sha('runtime-id'),
    materials: { files: [{ versionId: 'input', restorePath: 'input.txt' }] }
  })) as { environmentId: string }
  const environment = {
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    environmentId: prepared.environmentId
  }
  const execute = {
    ...environment,
    requestId: 'original-execution',
    command: 'printf "value,42\\n" > "$OPEN_SCIENCE_OUTPUT_DIR/result.csv"',
    outputs: [{ path: 'result.csv', filename: 'result.csv', contentType: 'text/csv' }]
  }
  const collectInOrdinaryTurn = async (
    reference: ManagedCollectionReference,
    requestId: string,
    alreadyPublished?: boolean
  ): Promise<CollectionObservation> => {
    let result: ManagedExecutionResult | undefined
    await h.owner.start({
      ...scope,
      requestId,
      requestFingerprint: sha(requestId),
      requestText: 'Collect the retained output in this ordinary Session without executing it.',
      execute: async (context, signal) => {
        const handle = h.artifactTurns.handleForExecution(context.operationId)
        const port = createManagedExecutionTurnPort({
          dataRoot: h.fixture.storageRoot,
          service,
          artifacts: h.artifacts,
          notebooks: h.fixture.notebookRepository,
          trackArtifactWrite: (sessionId, executionId, write) => {
            expect(sessionId).toBe(scope.sessionId)
            expect(executionId).toBe(context.operationId)
            return h.artifactTurns.trackWrite(handle, write)
          }
        })
        const turn = Object.freeze({
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          ownerExecutionId: context.operationId,
          artifactRunId: h.artifactTurns.snapshot(handle).runId,
          artifactStorageSessionId: scope.sessionId,
          workspaceCwd: context.workspaceCwd,
          invocationId: `control-${requestId}`,
          provenanceContext: context.provenanceContext as ManagedExecutionProvenance,
          signal,
          assertActive: () => signal.throwIfAborted()
        })
        const input = {
          environmentId: reference.environmentId,
          collectionId: reference.collectionId,
          requestId
        }
        result = (await port.call('collectOutputs', input, turn)) as ManagedExecutionResult
        // A repeat never creates another Version. A newly saved result still awaits this turn's
        // publication; a result already published by its owner can be returned immediately.
        if (alreadyPublished) expect(await port.call('collectOutputs', input, turn)).toEqual(result)
        else
          await expect(port.call('collectOutputs', input, turn)).rejects.toThrow(
            'awaiting publication by their original conversation turn'
          )
        return { text: 'Collected existing outputs; no command executed.' }
      }
    })
    return { operation: (await h.owner.wait({ ...scope, requestId }))!, result }
  }
  return {
    h,
    service,
    environments,
    environment,
    execute,
    dispatch,
    savedBeforeFailure,
    collectInOrdinaryTurn
  }
}

it.skipIf(process.platform === 'win32').each<Fault>(['before-save', 'after-save'])(
  'collects retained real execution output after %s without rerunning or reassigning an existing Version',
  async (fault) => {
    const {
      h,
      service,
      environment,
      execute,
      dispatch,
      savedBeforeFailure,
      collectInOrdinaryTurn
    } = await harness(fault)
    await service.execute(execute)
    const original = (await service.waitOperation({ ...scope, requestId: execute.requestId }))!
    expect(original).toMatchObject({ status: 'failed' })
    expect(original.error).toContain(`Injected ${fault}`)
    expect(original.recoveryPending).not.toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const runsBefore = await h.fixture.notebookRepository.readSessionRuns(
      scope.projectId,
      scope.sessionId
    )
    expect(runsBefore).toHaveLength(1)
    const run = runsBefore[0]
    expect(run).toMatchObject({ status: 'completed', script: execute.command, exitCode: 0 })
    expect(original.notebookRunIds).toEqual([run.runId])
    const retained = (await service.getEnvironment(environment)) as {
      state: string
      pendingCollection: { collectionId: string }
    }
    expect(retained.state).toBe('ready')
    expect(retained.pendingCollection.collectionId).toMatch(/^[a-f0-9]{64}$/)
    const reference = { ...environment, collectionId: retained.pendingCollection.collectionId }
    const journalPath = join(
      h.fixture.storageRoot,
      'managed-execution-requests',
      reference.collectionId + '.json'
    )
    const journalBefore = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(journalBefore.collection.frozen).toMatchObject({ runId: run.runId, status: 'completed' })
    expect(journalBefore.collection.frozen.files[0]).toMatchObject({
      sha256: sha(contents),
      sizeBytes: Buffer.byteLength(contents)
    })
    expect(journalBefore.collection.frozen.files[0]).not.toHaveProperty('versionId')
    expect(journalBefore.collection.frozen.files[0].attempts).toHaveLength(
      fault === 'after-save' ? 1 : 0
    )
    // Default release must retain this pending generation and keep collection possible.
    expect(await service.releaseEnvironment(environment)).toMatchObject({
      state: 'ready',
      pendingCollection: retained.pendingCollection
    })
    const journalRetained = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(journalRetained).toEqual(journalBefore)
    expect(
      JSON.parse(
        await readFile(
          join(
            h.fixture.storageRoot,
            'research-environments',
            'receipts',
            environment.environmentId + '.json'
          ),
          'utf8'
        )
      )
    ).toMatchObject({ releaseRequested: true })
    const saved = await h.fixture.client.artifactVersion.findMany({
      where: { filename: 'result.csv' }
    })
    expect(saved).toHaveLength(fault === 'after-save' ? 1 : 0)
    const committed = saved[0]
    if (fault === 'after-save') {
      expect(savedBeforeFailure).toEqual([committed.id])
      expect(journalBefore.collection.frozen.files[0].attempts[0].request.writeOperationId).toBe(
        committed.writeOperationId
      )
      expect(committed).toMatchObject({
        state: 'finalized',
        producerRunId: run.runId,
        artifactRunId: original.artifactRunId
      })
    } else {
      // Fork through the real conversation command reducer. A different active Main branch
      // cannot consume the pending generation, even inside a newly admitted ordinary turn.
      const otherBranch = 'collection-other-branch'
      await h.mutate(scope, (session) =>
        applySessionConversationCommands(session, [
          {
            id: 'fork-before-collection',
            timestamp: Date.now(),
            kind: 'fork-message',
            branchId: otherBranch,
            parentBranchId: original.provenance!.messageBranchId,
            messageId: original.provenance!.promptMessageId
          }
        ])
      )
      const denied = await collectInOrdinaryTurn(reference, 'wrong-branch-collection')
      expect(denied.operation).toMatchObject({ status: 'failed' })
      expect(denied.operation.error).toContain('original Main Agent branch')
      expect(denied.result).toBeUndefined()
      expect(await h.fixture.client.artifactVersion.count()).toBe(0)
      expect(await service.getEnvironment(environment)).toMatchObject({
        pendingCollection: retained.pendingCollection
      })
      expect(await readFile(journalPath, 'utf8')).toBe(JSON.stringify(journalRetained))
      await h.mutate(scope, (session) =>
        applySessionConversationCommands(session, [
          {
            id: 'select-original-for-collection',
            timestamp: Date.now(),
            kind: 'select-branch',
            branchId: original.provenance!.messageBranchId,
            previousBranchId: otherBranch
          }
        ])
      )
    }
    const requestId = 'collect-retained'
    const collected =
      fault === 'before-save'
        ? (await collectInOrdinaryTurn(reference, requestId)).operation
        : (await service.collectOutputs({ ...reference, requestId }),
          (await service.waitOperation({ ...scope, requestId }))!)
    expect(collected, JSON.stringify(collected)).toMatchObject({ status: 'completed' })
    expect(collected.operationId).not.toBe(original.operationId)
    expect(collected.artifactRunId).not.toBe(original.artifactRunId)
    expect(collected.notebookRunIds).toEqual([])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(h.kernelExecute).not.toHaveBeenCalled()
    expect(
      await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
    ).toEqual(runsBefore)
    const versions = await h.fixture.client.artifactVersion.findMany({
      where: { filename: 'result.csv' }
    })
    expect(versions).toHaveLength(1)
    const output = versions[0]
    expect(output).toMatchObject({
      state: 'finalized',
      producerRunId: run.runId,
      checksum: sha(contents),
      sizeBytes: BigInt(Buffer.byteLength(contents))
    })
    if (fault === 'after-save') {
      expect(output).toEqual(committed)
      expect(collected.artifactVersionIds).not.toContain(output.id)
    } else {
      expect(output.artifactRunId).toBe(collected.artifactRunId)
      expect(output.promptMessageId).toBe(collected.provenance!.promptMessageId)
    }
    const session = (await h.read(scope))!
    expect(session.artifacts?.filter((artifact) => artifact.versionId === output.id)).toHaveLength(
      1
    )
    const outputMessage = session.messages.find((message) =>
      message.artifactIds?.includes(output.id)
    )
    expect(outputMessage?.id).toBe(output.messageId)
    expect(outputMessage?.responseToMessageId).toBe(
      (fault === 'after-save' ? original : collected).provenance!.promptMessageId
    )
    const receipts = await h.fixture.client.artifactVersion.findMany({
      where: { artifactRunId: collected.artifactRunId, filename: { startsWith: 'collection-' } }
    })
    expect(receipts).toHaveLength(1)
    if (fault === 'after-save') expect(collected.artifactVersionIds).toEqual([receipts[0].id])
    const receipt = JSON.parse(
      await readFile(join(h.fixture.storageRoot, receipts[0].contentStorageKey), 'utf8')
    )
    expect(receipt).toMatchObject({
      collectedWithoutExecution: true,
      result: { runId: run.runId, outputs: [{ filename: 'result.csv', versionId: output.id }] }
    })
    expect(receipts[0].state).toBe('finalized')
    await service.reconcilePublishedOutputs(scope)
    const journalAfter = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(journalAfter).toMatchObject({
      state: 'completed',
      collection: { frozen: { files: [{ versionId: output.id }] } }
    })
    expect(await service.getEnvironment(environment)).not.toHaveProperty(
      'pendingCollection',
      expect.anything()
    )
    expect(await service.releaseEnvironment(environment)).toMatchObject({ state: 'released' })
    expect(await readFile(join(h.fixture.storageRoot, output.contentStorageKey), 'utf8')).toBe(
      contents
    )
    expect(
      await readFile(join(h.fixture.storageRoot, receipts[0].contentStorageKey), 'utf8')
    ).toContain('collectedWithoutExecution')
    expect(dispatch).toHaveBeenCalledTimes(1)
  },
  30_000
)

it
  .skipIf(process.platform === 'win32')
  .each(['on-published', 'startup-recheck', 'ack-response-lost'] as const)(
  'retains durable but unmarked ordinary Agent outputs until the real publication is acknowledged through %s',
  async (notification) => {
    const { h, service, environments, environment, execute, dispatch, collectInOrdinaryTurn } =
      await harness('none')
    const prompt = {
      id: 'ordinary-managed-prompt',
      role: 'user' as const,
      content: 'Run the engineering check.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: scope.sessionId,
      messages: [prompt],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    await h.mutate(scope, (session) => ({
      ...session,
      status: 'running',
      activeRun: { promptMessageId: prompt.id, startedAt: 1 },
      messages: graph.messages,
      conversationGraph: graph,
      runtimeTranscriptOwner: 'main'
    }))
    const session = (await h.read(scope))!
    const provenance = {
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      promptMessageId: prompt.id
    }
    const executionId = 'ordinary-managed-execution'
    const registry = new ArtifactRunRegistry()
    const owner = new ArtifactTurnOwner({
      dataRoot: h.fixture.storageRoot,
      repository: h.fixture.compatibilityRepository,
      runRegistry: registry,
      provenance: h.artifacts,
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(h.fixture.storageRoot)
    })
    const handle = await owner.openRootExecution({
      executionId,
      projectId: scope.projectId,
      appSessionId: scope.sessionId,
      artifactStorageSessionId: 'ordinary-artifact-storage',
      workspaceCwd: session.cwd,
      agentName: 'Main Agent',
      provenanceContext: { ...provenance, messageAncestry: [prompt.id] }
    })
    cleanups.push(() => owner.dispose(handle))
    const signal = new AbortController().signal
    const turn = {
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      ownerExecutionId: executionId,
      artifactRunId: owner.snapshot(handle).runId,
      artifactStorageSessionId: 'ordinary-artifact-storage',
      workspaceCwd: session.cwd,
      invocationId: 'ordinary-repl',
      provenanceContext: provenance,
      signal,
      assertActive: () => signal.throwIfAborted()
    }
    const port = createManagedExecutionTurnPort({
      dataRoot: h.fixture.storageRoot,
      service,
      artifacts: h.artifacts,
      notebooks: h.fixture.notebookRepository,
      trackArtifactWrite: (sessionId, ownerExecutionId, write) => {
        expect(sessionId).toBe(scope.sessionId)
        expect(ownerExecutionId).toBe(executionId)
        return owner.trackWrite(handle, write)
      }
    })
    const result = (await port.call(
      'execute',
      {
        environmentId: environment.environmentId,
        requestId: execute.requestId,
        command: execute.command,
        outputs: execute.outputs
      },
      turn
    )) as ManagedExecutionResult
    expect(result.status).toBe('completed')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(result.outputs).toHaveLength(2)
    const versionIds = result.outputs.map(({ versionId }) => versionId)
    const versions = await h.fixture.client.artifactVersion.findMany({
      where: { id: { in: versionIds } }
    })
    expect(versions).toHaveLength(2)
    for (const version of versions) {
      expect(version).toMatchObject({
        state: 'pending',
        managedVisibleAt: null,
        messageId: null,
        artifactRunId: turn.artifactRunId
      })
      expect(
        await readFile(join(h.fixture.storageRoot, version.contentStorageKey))
      ).not.toHaveLength(0)
    }
    expect(
      await h.fixture.compatibilityRepository.findRunFinalizationMarker(
        scope.projectId,
        turn.artifactRunId
      )
    ).toBeUndefined()
    const journalPath = join(
      h.fixture.storageRoot,
      'managed-execution-requests',
      result.collectionId + '.json'
    )
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
      state: 'awaiting-publication',
      result
    })
    const retained = (await service.releaseEnvironment(environment)) as {
      state: string
      pendingCollection: { collectionId: string }
    }
    expect(retained).toMatchObject({
      state: 'ready',
      pendingCollection: { collectionId: result.collectionId }
    })
    const journalBefore = JSON.parse(await readFile(journalPath, 'utf8'))
    const retainedFile = join(
      getNotebookDataRoot(h.fixture.storageRoot, scope.projectId, scope.sessionId),
      'managed-execution',
      environment.environmentId,
      'files',
      'result.csv'
    )
    expect(await readFile(retainedFile, 'utf8')).toBe(contents)
    expect(
      JSON.parse(
        await readFile(
          join(
            h.fixture.storageRoot,
            'research-environments',
            'receipts',
            environment.environmentId + '.json'
          ),
          'utf8'
        )
      )
    ).toMatchObject({ releaseRequested: true })
    // The same reconciliation used on startup may inspect this exact durable crash window, but
    // must not invent the missing publication claim or mistake stored bytes for public artifacts.
    await service.reconcilePublishedOutputs()
    expect(await service.getEnvironment(environment)).toMatchObject({
      state: 'ready',
      pendingCollection: retained.pendingCollection
    })
    await expect(
      port.call(
        'collectOutputs',
        {
          environmentId: environment.environmentId,
          collectionId: result.collectionId,
          requestId: 'retry-before-publication'
        },
        turn
      )
    ).rejects.toThrow('awaiting publication by their original conversation turn')
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toEqual(journalBefore)
    expect(await h.fixture.client.artifactVersion.count()).toBe(2)
    expect(dispatch).toHaveBeenCalledTimes(1)

    if (notification === 'ack-response-lost') {
      const acknowledge = environments.acknowledgeCollection.bind(environments)
      vi.spyOn(environments, 'acknowledgeCollection').mockImplementationOnce(async (reference) => {
        await acknowledge(reference)
        throw new Error('Acknowledgment response lost after durable cleanup')
      })
    }
    let acknowledgement: Promise<void> | undefined
    const onPublished = vi.fn((artifacts: readonly ArtifactFile[]) => {
      expect(artifacts.map(({ versionId }) => versionId).sort()).toEqual([...versionIds].sort())
      expect(artifacts.every(({ isPublished }) => isPublished === true)).toBe(true)
      if (notification !== 'startup-recheck') {
        acknowledgement = service.reconcilePublishedOutputs(scope)
        void acknowledgement.catch(() => undefined)
      }
    })
    const handlers = createArtifactHandlers(h.fixture.compatibilityRepository, registry, {
      provenance: h.artifacts,
      onPublished
    })
    const runtime = new RuntimeSessionOwner({
      loadSession: h.read,
      mutateSession: h.mutate,
      finalizeArtifacts: (request) => handlers.finalizeRunArtifacts(request)
    })
    await runtime.begin({ ...scope, executionId, ...provenance }, { reviewOwner: 'task' })
    runtime.accept({
      id: 'ordinary-result-event',
      timestamp: Date.now(),
      kind: 'message',
      level: 'info',
      sessionId: scope.sessionId,
      promptMessageId: prompt.id,
      promptExecutionId: executionId,
      messageId: 'ordinary-result',
      role: 'assistant',
      text: 'The check completed; here are its outputs.'
    })
    await runtime.flush(scope.sessionId, prompt.id)
    const publication = await owner.finalize(handle)
    expect(publication).toBeDefined()
    await runtime.publish({ ...publication!, executionId })
    expect(onPublished).toHaveBeenCalledTimes(1)
    if (notification === 'startup-recheck') {
      expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
        state: 'awaiting-publication'
      })
      await service.reconcilePublishedOutputs()
    } else if (notification === 'ack-response-lost') {
      await expect(acknowledgement).rejects.toThrow(
        'Acknowledgment response lost after durable cleanup'
      )
      expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ state: 'completed' })
      await service.reconcilePublishedOutputs()
    } else await acknowledgement
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
      state: 'completed',
      result
    })
    expect(await service.getEnvironment(environment)).toMatchObject({ state: 'released' })
    expect(await service.getEnvironment(environment)).toMatchObject({
      pendingCollection: undefined
    })
    expect(
      JSON.parse(
        await readFile(
          join(
            h.fixture.storageRoot,
            'research-environments',
            'receipts',
            environment.environmentId + '.json'
          ),
          'utf8'
        )
      )
    ).not.toHaveProperty('pendingCollection')
    await expect(readFile(retainedFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await runtime.commitTerminal(
      {
        id: 'ordinary-completed',
        timestamp: Date.now(),
        kind: 'stop',
        level: 'info',
        sessionId: scope.sessionId,
        promptMessageId: prompt.id,
        promptExecutionId: executionId,
        text: 'end_turn'
      },
      () => undefined
    )
    await runtime.flush(scope.sessionId, prompt.id)
    await owner.dispose(handle)
    const collected = await collectInOrdinaryTurn(
      { ...environment, collectionId: result.collectionId! },
      'retry-after-publication',
      true
    )
    expect(collected.operation).toMatchObject({
      status: 'completed',
      artifactVersionIds: [],
      notebookRunIds: []
    })
    expect(collected.result).toEqual(result)
    expect(await h.fixture.client.artifactVersion.count()).toBe(2)
    expect(dispatch).toHaveBeenCalledTimes(1)
    for (const version of await h.fixture.client.artifactVersion.findMany()) {
      expect(version).toMatchObject({ state: 'finalized', artifactRunId: turn.artifactRunId })
      expect(version.managedVisibleAt).not.toBeNull()
      expect(
        await readFile(join(h.fixture.storageRoot, version.contentStorageKey))
      ).not.toHaveLength(0)
    }
    const current = (await h.read(scope))!
    expect(current.artifacts?.map(({ versionId }) => versionId).sort()).toEqual(
      [...versionIds].sort()
    )
  },
  30000
)

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
