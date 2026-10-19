import { createManagedRunObservationReader } from '../managed-run-observation'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ArtifactVersionDescriptor,
  ArtifactVersionFile
} from '../../shared/artifact-provenance'
import {
  executeManagedEnvironmentRequestSchema,
  type ExecuteManagedEnvironmentRequest
} from '../../shared/managed-execution'
import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import {
  ManagedExecutionService,
  type ManagedExecutionServiceDependencies,
  type ManagedExecutionTurnContext
} from './managed-execution-service'
import {
  ManagedResearchEnvironmentOwner,
  ManagedEnvironmentCancelledError,
  type ManagedResearchRuntime
} from './managed-research-environment'
import { resolveManagedShellExecutionCapability } from './managed-shell-execution'
import { resolveManagedOutputAuthority } from './managed-output-authority'
import type { ResearchMaterialAuthority } from './research-materials'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import { resolveManagedOutputRecoveryAuthority } from './managed-output-recovery'
import { managedOutputWriteAttemptSchema } from './managed-output-publication'
import type { ManagedExecutionOutput } from './managed-execution-output'
import { saveAuxiliaryOutput } from './managed-auxiliary-output'
import type { ManagedExecutionObservationPort } from './managed-execution-observation-port'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const scope = { projectId: 'project', sessionId: 'receiver' }
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const provenance = {
  rootFrameId: 'root',
  agentFrameId: 'root',
  messageBranchId: 'branch',
  runtimeSegmentId: 'segment',
  promptMessageId: 'prompt'
}

const unavailableObservation = (): ManagedExecutionObservationPort => ({
  begin: vi.fn(async () => ({
    result: { status: 'unavailable' as const, warning: 'capture-unavailable' as const }
  })),
  publish: vi.fn(async () => ({
    result: { status: 'unavailable' as const, warning: 'capture-unavailable' as const },
    savedInCurrentTurn: false
  })),
  confirm: vi.fn(async () => undefined),
  reconcilePublished: vi.fn(async () => undefined),
  drain: vi.fn(async () => undefined)
})

it.each(['external', 'turn'] as const)(
  'rejects unsupported explicit observation before admitting a %s execution',
  async (entrypoint) => {
    const h = await setup()
    const request = { ...h.request, recordObservation: true }
    await expect(
      entrypoint === 'external'
        ? h.service.execute(request)
        : h.service.executeInTurn(request, h.context)
    ).rejects.toThrow('Run observation is not available')
    expect(h.dependencies.operations.start).not.toHaveBeenCalled()
    expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
    expect(h.savedOutputs).toEqual([])
    await expect(
      h.service.getEnvironment({ ...scope, environmentId: h.request.environmentId })
    ).resolves.toMatchObject({ state: 'ready' })
  }
)

it.each([undefined, false])(
  'never captures ordinary execution with recordObservation=%s',
  async (value) => {
    const h = await setup()
    const observation = unavailableObservation()
    h.dependencies.observation = observation
    const result = await h.service.executeInTurn(
      { ...h.request, recordObservation: value },
      h.context
    )
    expect(result.status).toBe('completed')
    expect(result.observation).toBeUndefined()
    expect(result.outputs).toHaveLength(2)
    expect(observation.begin).not.toHaveBeenCalled()
    expect(observation.publish).not.toHaveBeenCalled()
    expect(observation.drain).not.toHaveBeenCalled()
  }
)

it('keeps an installed observer unavailable result separate from the real experiment result', async () => {
  const h = await setup()
  const observation = unavailableObservation()
  h.dependencies.observation = observation
  const result = await h.service.executeInTurn({ ...h.request, recordObservation: true }, h.context)
  expect(result.status).toBe('completed')
  expect(result.observation).toEqual({ status: 'unavailable', warning: 'capture-unavailable' })
  expect(result.outputs).toHaveLength(2)
  expect(observation.begin).toHaveBeenCalledOnce()
  expect(observation.publish).toHaveBeenCalledOnce()
  expect(observation.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      ...scope,
      operationId: 'operation',
      executionInvocationId: expect.stringMatching(/^managed-[a-f0-9]{64}$/)
    }),
    expect.objectContaining({ ...scope, provenanceContext: provenance })
  )
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it.each(['reported', 'thrown'] as const)(
  'keeps a %s capture-start failure separate from execution and delegates publication recovery',
  async (failure) => {
    const h = await setup()
    const observation = unavailableObservation()
    const result = { status: 'failed' as const, warning: 'capture-start-failed' as const }
    if (failure === 'thrown') {
      vi.mocked(observation.begin).mockRejectedValue(new Error('Capture could not start'))
    } else {
      vi.mocked(observation.begin).mockResolvedValue({ result })
    }
    vi.mocked(observation.publish).mockResolvedValue({ result, savedInCurrentTurn: false })
    h.dependencies.observation = observation

    const completed = await h.service.executeInTurn(
      { ...h.request, recordObservation: true },
      h.context
    )
    expect(completed).toMatchObject({ status: 'completed', observation: result })
    expect(completed.outputs).toHaveLength(2)
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
    expect(observation.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ ...scope, operationId: 'operation' }),
        handle: undefined,
        recovery: false
      })
    )
    expect(observation.drain).not.toHaveBeenCalled()
  }
)

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(): Promise<{
  root: string
  service: ManagedExecutionService
  dependencies: ManagedExecutionServiceDependencies
  environments: ManagedResearchEnvironmentOwner
  context: ManagedExecutionTurnContext
  request: ExecuteManagedEnvironmentRequest
  runtime: ManagedExecutionServiceDependencies['runtime']
  savedOutputs: Array<{ filename: string; content: string; producerRunId?: string }>
  descriptors: Map<string, ArtifactVersionDescriptor>
  publishSavedVersions: (versionIds?: string[]) => void
  runs: NotebookRunRecord[]
  contextFor: (operationId: string, promptMessageId?: string) => ManagedExecutionTurnContext
  executeFixture: ManagedExecutionServiceDependencies['runtime']['executeManagedShell']
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-core-')))
  roots.push(root)
  await mkdir(join(root, 'workspace'))
  const node: ManagedResearchRuntime = {
    kind: 'node',
    executable: join(root, 'node'),
    version: '24.1.0',
    sha256: sha('node'),
    platform: process.platform as 'darwin' | 'linux' | 'win32',
    arch: process.arch,
    readOnlyRoots: [join(root, 'runtime')]
  }
  const runs: NotebookRunRecord[] = []
  // Unit boundary only: no interpreter is launched. Model the durable Notebook evidence for the
  // bytes this fake runtime actually writes; real executor/Artifact integration has its own tests.
  const executeFixture: ManagedExecutionServiceDependencies['runtime']['executeManagedShell'] =
    async (request, capability) => {
      const policy = resolveManagedShellExecutionCapability(capability, {
        ...scope,
        executionInvocationId: request.executionInvocationId!
      })
      const path = join(policy.environment.OPEN_SCIENCE_OUTPUT_DIR, 'result.json')
      const content = '{"value":42}'
      await writeFile(path, content)
      const environmentId = basename(dirname(policy.environment.OPEN_SCIENCE_OUTPUT_DIR))
      const runId = runs.length ? `notebook-run-${runs.length + 1}` : 'notebook-run'
      runs.push({
        runId,
        submissionIdentity: request.executionInvocationId,
        executionInvocationId: request.executionInvocationId,
        cellId: 'cell',
        source: 'agent',
        kernelKind: 'bash',
        script: request.command,
        status: 'completed',
        exitCode: 0,
        startedAt: 1,
        endedAt: 2,
        text: { stdout: '42', stderr: '', traceback: '', plain: [] },
        outputs: [],
        inputFiles: [],
        ...request.provenanceContext,
        workingFiles: [
          {
            path,
            relativePath: `data/managed-execution/${environmentId}/files/result.json`,
            kind: 'other',
            size: Buffer.byteLength(content),
            createdByRunId: runId,
            generationId: 'generation-result',
            checksum: sha(content)
          }
        ]
      })
      return { stdout: '42', stderr: '', exitCode: 0 }
    }
  const runtime: ManagedExecutionServiceDependencies['runtime'] = {
    executeManagedShell: vi.fn(executeFixture),
    confirmManagedShellCleanup: vi.fn<
      ManagedExecutionServiceDependencies['runtime']['confirmManagedShellCleanup']
    >(async (request) => ({
      scope: request,
      state: 'verified',
      reaped: true,
      runId:
        runs.find((run) => run.executionInvocationId === request.executionInvocationId)?.runId ??
        'notebook-run',
      proof: 'process-owner'
    }))
  }
  const environments = new ManagedResearchEnvironmentOwner({
    dataRoot: root,
    socketRoot: await realpath(tmpdir()),
    verifyRuntime: async () => undefined,
    stopExecution: async (request) => ({
      verified: (await runtime.confirmManagedShellCleanup(request, { retry: true })).reaped
    })
  })
  const content = 'export const input = 42'
  const materials: ResearchMaterialAuthority = {
    source: { projectId: scope.projectId, sessionId: 'source', identity: 'source-checksum' },
    versions: [
      {
        versionId: 'version-1',
        sourceIdentity: 'source-checksum',
        filename: 'input.mjs',
        sha256: sha(content),
        sizeBytes: Buffer.byteLength(content)
      }
    ],
    readVersion: async () => Buffer.from(content)
  }
  const descriptors = new Map<string, ArtifactVersionDescriptor>()
  const publishSavedVersions = (versionIds = [...descriptors.keys()]): void => {
    for (const versionId of versionIds) {
      const descriptor = descriptors.get(versionId)
      if (!descriptor) throw new Error('Unit fixture cannot publish an unsaved Version.')
      descriptor.state = 'finalized'
      descriptor.isPublished = true
    }
  }
  const dependencies: ManagedExecutionServiceDependencies = {
    dataRoot: root,
    environments,
    runtime,
    artifacts: {
      replayVersion: vi.fn(async (request) => {
        const artifact = saved.get(request.writeOperationId)
        if (!artifact) return undefined
        return { ...artifact, ...descriptors.get(artifact.versionId)! }
      }),
      resolveVersionDescriptors: vi.fn<
        ManagedExecutionServiceDependencies['artifacts']['resolveVersionDescriptors']
      >(async ({ versionIds }) =>
        versionIds.flatMap((versionId) => {
          const descriptor = descriptors.get(versionId)
          return descriptor ? [structuredClone(descriptor)] : []
        })
      )
    },
    notebooks: {
      readSessionDocuments: vi.fn(async (projectId, sessionId) => {
        if (projectId !== scope.projectId || sessionId !== scope.sessionId) return []
        const document: NotebookRunDocument = {
          version: 1,
          ...scope,
          workspaceCwd: join(root, 'workspace'),
          notebookSessionRoot: join(root, 'notebooks'),
          dataRoot: join(root, 'data'),
          kernel: { kernelName: 'unit-boundary', runtimeRoot: root, lastKnownStatus: 'idle' },
          runs: structuredClone(runs),
          updatedAt: 2
        }
        return [document]
      })
    },
    runtimes: {
      discover: async () => ({
        runtimes: [{ runtimeId: sha('runtime'), runtime: node }],
        unavailable: [{ candidate: '/private/node', reason: 'private' }]
      }),
      resolve: vi.fn(async () => node)
    },
    materials: vi.fn(async () => materials),
    resolvePreparedInputs: vi.fn(async () => []),
    createSession: vi.fn(async (request) => ({
      projectId: request.projectId,
      sessionId: 'created'
    })),
    withWritableSession: vi.fn(async (_scope, operation) => operation()),
    operations: { start: vi.fn(), get: vi.fn(), cancel: vi.fn(), wait: vi.fn() }
  }
  const service = new ManagedExecutionService(dependencies)
  const prepared = (await service.prepare({
    ...scope,
    requestId: 'prepare',
    sourceSessionId: 'source',
    sourceIdentity: 'source-checksum',
    runtimeId: sha('runtime'),
    materials: { files: [{ versionId: 'version-1', restorePath: 'input.mjs' }] }
  })) as { environmentId: string }
  const savedOutputs: Array<{ filename: string; content: string; producerRunId?: string }> = []
  const saved = new Map<string, ArtifactVersionFile>()
  const contextFor = (
    operationId: string,
    promptMessageId = 'prompt'
  ): ManagedExecutionTurnContext => {
    const context: ManagedExecutionTurnContext = {
      ...scope,
      operationId,
      workspaceCwd: join(root, 'workspace'),
      provenanceContext: { ...provenance, promptMessageId },
      recordRun: vi.fn(async () => undefined),
      saveOutput: vi.fn(async (output) => save(output)),
      saveAuxiliaryOutput: (output) =>
        saveAuxiliaryOutput(output, (value) => context.saveOutput(value)),
      recoverOutput: vi.fn(async (output) => {
        const proof = resolveManagedOutputRecoveryAuthority(output.recoveryAuthority, context, {
          filename: output.filename,
          path: output.source.path,
          producerRunId: output.producerRunId
        })
        expect(proof.producerProvenance).toEqual(provenance)
        expect(proof.output.generationId).toBe('generation-result')
        for (const attempt of output.publication.previousAttempts) {
          const artifact = saved.get(attempt.request.writeOperationId)
          if (artifact) {
            const descriptor = descriptors.get(artifact.versionId)
            if (descriptor?.state !== 'finalized' || descriptor.isPublished !== true)
              throw new Error('The previous Artifact turn has not published this Version.')
            return { artifact, reused: true }
          }
        }
        const managed = await resolveManagedOutputAuthority(
          output.source.authority,
          context,
          output.source.path
        )
        const content = await readFile(managed.path, 'utf8')
        if (
          sha(content) !== proof.output.sha256 ||
          Buffer.byteLength(content) !== proof.output.sizeBytes
        )
          throw new Error('Retained output no longer matches its original file generation.')
        return { artifact: await save(output), reused: false }
      })
    }
    async function save(output: ManagedExecutionOutput): Promise<ArtifactVersionFile> {
      if (output.source.kind === 'localPath')
        throw new Error('Service must use an output capability')
      const bytes =
        output.source.kind === 'inline'
          ? Buffer.from(
              output.source.content,
              output.source.encoding === 'base64' ? 'base64' : 'utf8'
            )
          : await readFile(
              (
                await resolveManagedOutputAuthority(
                  output.source.authority,
                  context,
                  output.source.path
                )
              ).path
            )
      const content = bytes.toString('utf8')
      const generation = runs
        .find((run) => run.runId === output.producerRunId)
        ?.workingFiles.find((file) => file.checksum === sha(bytes) && file.size === bytes.length)
      const attempt = managedOutputWriteAttemptSchema.parse({
        schemaVersion: 1,
        request: {
          projectId: scope.projectId,
          appSessionId: scope.sessionId,
          artifactStorageSessionId: 'artifact-storage',
          artifactRunId: `artifact-${operationId}`,
          writeOperationId: 'write-' + sha(JSON.stringify([operationId, output.filename])),
          filename: output.filename,
          contentType: output.contentType,
          producerRunId: output.producerRunId
        },
        destination: {
          provenanceContext: context.provenanceContext,
          messageAncestry: [...new Set(['prompt', promptMessageId])]
        },
        source: {
          kind: output.source.kind,
          sha256: sha(bytes),
          sizeBytes: bytes.length,
          ...(output.producerRunId
            ? {
                producerRunId: output.producerRunId,
                producerProvenance: provenance,
                generationId: generation?.generationId,
                relativePath:
                  output.source.kind === 'managedOutput' ? output.source.path : undefined
              }
            : {})
        }
      })
      await output.publication?.beforeWrite(attempt)
      savedOutputs.push({ filename: output.filename, content, producerRunId: output.producerRunId })
      const versionId = 'version-' + savedOutputs.length
      // Saving does not finalize an Artifact turn. Tests explicitly publish the saved Versions.
      const descriptor: ArtifactVersionDescriptor = {
        ...scope,
        id: versionId,
        artifactId: 'artifact-' + output.filename,
        versionId,
        versionNumber: 1,
        name: output.filename,
        mimeType: output.contentType,
        checksum: sha(bytes),
        size: bytes.length,
        createdAt: new Date(0).toISOString(),
        mtimeMs: 0,
        state: 'pending',
        isPublished: false,
        producerRunId: output.producerRunId
      }
      descriptors.set(versionId, descriptor)
      const artifact: ArtifactVersionFile = {
        ...descriptor,
        path: join(root, 'saved-versions', versionId),
        fileUrl: 'file://' + join(root, 'saved-versions', versionId)
      }
      saved.set(attempt.request.writeOperationId, artifact)
      return artifact
    }
    return context
  }
  const context = contextFor('operation')
  return {
    root,
    service,
    dependencies,
    environments,
    context,
    runtime,
    savedOutputs,
    descriptors,
    publishSavedVersions,
    runs,
    contextFor,
    executeFixture,
    request: {
      ...scope,
      environmentId: prepared.environmentId,
      requestId: 'run',
      command: 'fixture',
      outputs: [{ path: 'result.json', filename: 'result.json' }]
    }
  }
}

it('freezes parsed requests before asynchronous preparation and publishes only stopped-run output', async () => {
  const h = await setup()
  const gate = deferred()
  vi.mocked(h.dependencies.resolvePreparedInputs).mockImplementation(async () => {
    await gate.promise
    return []
  })
  const pending = h.service.executeInTurn(h.request, h.context)
  await vi.waitFor(() => expect(h.dependencies.resolvePreparedInputs).toHaveBeenCalledOnce())
  h.request.command = 'changed after admission'
  h.request.outputs![0].path = '../private'
  gate.resolve()
  const result = await pending
  expect(h.runtime.executeManagedShell).toHaveBeenCalledWith(
    expect.objectContaining({
      ...scope,
      command: 'fixture',
      rootExecutionId: 'operation',
      provenanceContext: provenance
    }),
    expect.any(Object),
    expect.any(AbortSignal),
    undefined
  )
  expect(result).toMatchObject({ runId: 'notebook-run', status: 'completed' })
  expect(h.context.recordRun).toHaveBeenCalledWith('notebook-run')
  expect(h.savedOutputs[0]).toEqual({
    filename: 'result.json',
    content: '{"value":42}',
    producerRunId: 'notebook-run'
  })
  const receipt = JSON.parse(h.savedOutputs[1].content)
  expect(receipt).toMatchObject({
    kind: 'managed-research-execution',
    transport: 'none',
    result: { runId: 'notebook-run' }
  })
  expect(receipt.runtime).not.toHaveProperty('executable')
  expect(receipt.runtime).not.toHaveProperty('readOnlyRoots')
})

it('snapshots trusted turn identities before awaits so mutation cannot relabel a Notebook Run', async () => {
  const h = await setup()
  const gate = deferred()
  vi.mocked(h.dependencies.resolvePreparedInputs).mockImplementation(async () => {
    await gate.promise
    return []
  })
  const context = {
    ...h.context,
    executionInvocationId: 'outer-control-run',
    provenanceContext: { ...h.context.provenanceContext }
  }
  const originalCwd = context.workspaceCwd
  const pending = h.service.executeInTurn(h.request, context)
  await vi.waitFor(() => expect(h.dependencies.resolvePreparedInputs).toHaveBeenCalledOnce())
  context.operationId = 'different-operation'
  context.executionInvocationId = 'different-control-run'
  context.workspaceCwd = join(h.root, 'other-workspace')
  context.provenanceContext.promptMessageId = 'different-prompt'
  gate.resolve()
  await pending
  expect(h.runtime.executeManagedShell).toHaveBeenCalledWith(
    expect.objectContaining({
      rootExecutionId: 'operation',
      workspaceCwd: originalCwd,
      provenanceContext: provenance
    }),
    expect.any(Object),
    expect.any(AbortSignal),
    { parentControlInvocationId: 'outer-control-run' }
  )
})

it('deduplicates concurrent and restarted calls and rejects different content without rerunning', async () => {
  const h = await setup()
  const gate = deferred()
  vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
    await gate.promise
    return h.executeFixture(request, capability)
  })
  const first = h.service.executeInTurn(h.request, h.context)
  const second = h.service.executeInTurn(h.request, h.context)
  await vi.waitFor(() => expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce())
  await expect(
    h.service.executeInTurn({ ...h.request, command: 'different' }, h.context)
  ).rejects.toThrow('conflicts')
  gate.resolve()
  expect(await first).toEqual(await second)
  expect(
    await new ManagedExecutionService(h.dependencies).executeInTurn(h.request, h.context)
  ).toEqual(await first)
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  expect(h.savedOutputs).toHaveLength(2)
})

it('retains a fully saved collection until its original turn publishes every Version, then completes a requested release after restart', async () => {
  const h = await setup()
  const result = await h.service.executeInTurn(h.request, h.context)
  const collection = {
    ...scope,
    environmentId: h.request.environmentId,
    collectionId: result.collectionId,
    requestId: 'collect'
  }
  const outputPath = h.runs[0].workingFiles[0].path
  expect(h.savedOutputs).toHaveLength(2)
  expect(
    await h.service.releaseEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).toMatchObject({
    state: 'ready',
    pendingCollection: { collectionId: result.collectionId }
  })
  expect((await h.environments.get(h.request)).releaseRequested).toBe(true)
  const context = h.contextFor('later', 'next-prompt')
  await expect(h.service.collectOutputsInTurn(collection, context)).rejects.toThrow(
    'awaiting publication'
  )
  expect(context.saveOutput).not.toHaveBeenCalled()
  expect(context.recoverOutput).not.toHaveBeenCalled()
  expect(await readFile(outputPath, 'utf8')).toBe('{"value":42}')
  const restarted = new ManagedExecutionService(h.dependencies)
  await restarted.reconcilePublishedOutputs()
  expect((await h.environments.get(h.request)).pendingCollection).toBeDefined()
  h.publishSavedVersions()
  await restarted.reconcilePublishedOutputs()
  expect(await h.environments.get(h.request)).toMatchObject({ state: 'released' })
  expect((await h.environments.get(h.request)).pendingCollection).toBeUndefined()
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await restarted.collectOutputsInTurn(collection, context)).toEqual(result)
  expect(await restarted.executeInTurn(h.request, h.context)).toEqual(result)
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  expect(h.savedOutputs).toHaveLength(2)
})

it('requires publication of the ordinary execution receipt as well as every declared output', async () => {
  const h = await setup()
  const result = await h.service.executeInTurn(h.request, h.context)
  h.publishSavedVersions([result.outputs[0].versionId])
  await h.service.reconcilePublishedOutputs(scope)
  expect((await h.environments.get(h.request)).pendingCollection?.collectionId).toBe(
    result.collectionId
  )
  expect(
    await h.service.releaseEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).toMatchObject({ state: 'ready' })
  expect(await readFile(h.runs[0].workingFiles[0].path, 'utf8')).toBe('{"value":42}')
  h.publishSavedVersions([result.outputs[1].versionId])
  await h.service.reconcilePublishedOutputs(scope)
  expect((await h.environments.get(h.request)).state).toBe('released')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it.each(['project', 'session', 'name', 'version', 'pending', 'unpublished'] as const)(
  'rejects mismatched %s publication metadata while preserving saved bytes',
  async (mismatch) => {
    const h = await setup()
    const result = await h.service.executeInTurn(h.request, h.context)
    h.publishSavedVersions()
    const version = h.descriptors.get(result.outputs[0].versionId)!
    const exact = structuredClone(version)
    if (mismatch === 'project')
      h.descriptors.set(version.versionId, { ...version, projectId: 'foreign' })
    else if (mismatch === 'session') version.sessionId = 'foreign'
    else if (mismatch === 'name') version.name = 'unrelated.json'
    else if (mismatch === 'version') version.versionId = 'unrelated-version'
    else if (mismatch === 'pending') version.state = 'pending'
    else version.isPublished = false
    await h.service.reconcilePublishedOutputs(scope)
    expect((await h.environments.get(h.request)).pendingCollection?.collectionId).toBe(
      result.collectionId
    )
    expect(await readFile(h.runs[0].workingFiles[0].path, 'utf8')).toBe('{"value":42}')
    h.descriptors.set(exact.versionId, exact)
    await h.service.reconcilePublishedOutputs(scope)
    expect((await h.environments.get(h.request)).pendingCollection).toBeUndefined()
    expect((await h.environments.get(h.request)).state).toBe('ready')
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  }
)

it('does not replay a failed or interrupted command after restarting its service', async () => {
  const h = await setup()
  vi.mocked(h.runtime.executeManagedShell).mockRejectedValueOnce(
    new Error('response lost after launch')
  )
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow('response lost')
  await expect(
    new ManagedExecutionService(h.dependencies).executeInTurn(h.request, h.context)
  ).rejects.toThrow('interrupted or failed')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  expect(h.savedOutputs).toEqual([])
})

it('preserves optional missing outputs but propagates unexpected collection failures', async () => {
  const h = await setup()
  h.request.outputs!.push({ path: 'optional.csv', filename: 'optional.csv', optional: true })
  expect(await h.service.executeInTurn(h.request, h.context)).toMatchObject({
    missingOptionalOutputs: ['optional.csv'],
    status: 'completed'
  })
  const second = await setup()
  vi.mocked(second.context.saveOutput).mockRejectedValueOnce(
    Object.assign(new Error('permission denied'), { code: 'EACCES' })
  )
  second.request.outputs![0].optional = true
  await expect(second.service.executeInTurn(second.request, second.context)).rejects.toThrow(
    'permission denied'
  )
})

async function retainCollection(h: Awaited<ReturnType<typeof setup>>): Promise<{
  projectId: string
  sessionId: string
  environmentId: string
  collectionId: string
}> {
  vi.mocked(h.context.saveOutput).mockRejectedValueOnce(new Error('publication unavailable'))
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow(
    'publication unavailable'
  )
  const receipt = await h.environments.get(h.request)
  expect(receipt.pendingCollection).toBeDefined()
  return {
    ...scope,
    environmentId: h.request.environmentId,
    collectionId: receipt.pendingCollection!.collectionId
  }
}

it('retains stopped output after collection failure and default release, and blocks another execution', async () => {
  const h = await setup()
  const collection = await retainCollection(h)
  const outputPath = h.runs[0].workingFiles[0].path
  expect(await readFile(outputPath, 'utf8')).toBe('{"value":42}')
  expect(
    await h.service.releaseEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).toMatchObject({
    state: 'ready',
    pendingCollection: { collectionId: collection.collectionId }
  })
  expect(await readFile(outputPath, 'utf8')).toBe('{"value":42}')
  await expect(
    h.service.executeInTurn({ ...h.request, requestId: 'second-run' }, h.context)
  ).rejects.toThrow('awaiting collection')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  expect(h.savedOutputs).toEqual([])
})

it('recovers after owner and service restart in a later turn without executing again or changing the producer', async () => {
  const h = await setup()
  const collection = await retainCollection(h)
  await h.environments.close()
  const verifyRuntime = vi.fn(async () => undefined)
  const restartedEnvironments = new ManagedResearchEnvironmentOwner({
    dataRoot: h.root,
    socketRoot: await realpath(tmpdir()),
    verifyRuntime,
    stopExecution: async (request) => ({
      verified: (await h.runtime.confirmManagedShellCleanup(request, { retry: true })).reaped
    })
  })
  await restartedEnvironments.recover()
  const restarted = new ManagedExecutionService({
    ...h.dependencies,
    environments: restartedEnvironments
  })
  const context = h.contextFor('collection-operation', 'next-prompt')
  const request = { ...collection, requestId: 'collect-once' }
  const result = await restarted.collectOutputsInTurn(request, context)
  expect(result).toMatchObject({
    collectionId: collection.collectionId,
    runId: 'notebook-run',
    status: 'completed',
    outputs: [{ filename: 'result.json', versionId: 'version-1' }, expect.any(Object)]
  })
  expect(h.savedOutputs[0]).toEqual({
    filename: 'result.json',
    content: '{"value":42}',
    producerRunId: 'notebook-run'
  })
  expect(JSON.parse(h.savedOutputs[1].content)).toMatchObject({
    collectedWithoutExecution: true,
    result: { runId: 'notebook-run' }
  })
  expect(context.recoverOutput).toHaveBeenCalledOnce()
  expect(context.recordRun).not.toHaveBeenCalled()
  expect((await restartedEnvironments.get(collection)).pendingCollection).toBeDefined()
  h.publishSavedVersions()
  await restarted.reconcilePublishedOutputs(scope)
  expect((await restartedEnvironments.get(collection)).pendingCollection).toBeUndefined()
  expect(await restarted.collectOutputsInTurn(request, context)).toEqual(result)
  expect(context.recoverOutput).toHaveBeenCalledOnce()
  expect(h.savedOutputs).toHaveLength(2)
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  expect(verifyRuntime).not.toHaveBeenCalled()
})

it('returns a completed collection A while preserving a later pending collection B in the same environment', async () => {
  const h = await setup()
  const completed = await h.service.executeInTurn(h.request, h.context)
  h.publishSavedVersions()
  await h.service.reconcilePublishedOutputs(scope)
  vi.mocked(h.context.saveOutput).mockRejectedValueOnce(new Error('collection B unavailable'))
  await expect(
    h.service.executeInTurn({ ...h.request, requestId: 'run-b' }, h.context)
  ).rejects.toThrow('collection B unavailable')
  const pendingB = (await h.environments.get(h.request)).pendingCollection!
  expect(pendingB.collectionId).not.toBe(completed.collectionId)
  const context = h.contextFor('retry-a', 'next-prompt')
  expect(
    await new ManagedExecutionService(h.dependencies).collectOutputsInTurn(
      {
        ...scope,
        environmentId: h.request.environmentId,
        collectionId: completed.collectionId,
        requestId: 'retry-completed-a'
      },
      context
    )
  ).toEqual(completed)
  expect((await h.environments.get(h.request)).pendingCollection).toEqual(pendingB)
  expect(await readFile(h.runs[1].workingFiles[0].path, 'utf8')).toBe('{"value":42}')
  expect(context.recoverOutput).not.toHaveBeenCalled()
  expect(context.saveOutput).not.toHaveBeenCalled()
  expect(h.runtime.executeManagedShell).toHaveBeenCalledTimes(2)
})

it('reuses an already-saved Version after its receipt fails instead of publishing a duplicate', async () => {
  const h = await setup()
  const save = vi.mocked(h.context.saveOutput).getMockImplementation()!
  vi.mocked(h.context.saveOutput).mockImplementation(async (output) => {
    if (output.source.kind === 'inline') throw new Error('receipt publication unavailable')
    return save(output)
  })
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow(
    'receipt publication unavailable'
  )
  const receipt = await h.environments.get(h.request)
  const collection = {
    ...scope,
    environmentId: h.request.environmentId,
    collectionId: receipt.pendingCollection!.collectionId
  }
  const journal = JSON.parse(
    await readFile(
      join(h.root, 'managed-execution-requests', collection.collectionId + '.json'),
      'utf8'
    )
  )
  expect(journal.collection.frozen.files[0]).toMatchObject({
    versionId: 'version-1',
    attempts: [
      {
        request: { artifactRunId: 'artifact-operation', producerRunId: 'notebook-run' },
        source: { sha256: sha('{"value":42}'), sizeBytes: 12, generationId: 'generation-result' }
      }
    ]
  })
  h.publishSavedVersions()
  const context = h.contextFor('receipt-recovery', 'next-prompt')
  const result = await new ManagedExecutionService(h.dependencies).collectOutputsInTurn(
    { ...collection, requestId: 'collect' },
    context
  )
  expect(result.outputs[0]).toEqual({ filename: 'result.json', versionId: 'version-1' })
  expect(h.savedOutputs.filter((output) => output.filename === 'result.json')).toHaveLength(1)
  expect(context.recoverOutput).toHaveBeenCalledOnce()
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it('records an explicit discard before allowing release and never collects discarded output', async () => {
  const h = await setup()
  const collection = await retainCollection(h)
  const outputPath = h.runs[0].workingFiles[0].path
  expect(await h.service.discardOutputs(collection)).toMatchObject({
    discardedCollections: [expect.objectContaining({ collectionId: collection.collectionId })]
  })
  const journal = JSON.parse(
    await readFile(
      join(h.root, 'managed-execution-requests', collection.collectionId + '.json'),
      'utf8'
    )
  )
  expect(journal.collection).toMatchObject({
    discarded: true,
    frozen: {
      runId: 'notebook-run',
      files: [{ filename: 'result.json', sha256: sha('{"value":42}') }]
    }
  })
  expect(await readFile(outputPath, 'utf8')).toBe('{"value":42}')
  expect(
    await h.service.releaseEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).toMatchObject({ state: 'released' })
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    h.service.collectOutputsInTurn(
      { ...collection, requestId: 'after-discard' },
      h.contextFor('later')
    )
  ).rejects.toThrow('explicitly discarded')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it('refuses another environment, Session, Project or Main branch without consuming retained output', async () => {
  const h = await setup()
  const collection = await retainCollection(h)
  const context = h.contextFor('later', 'next-prompt')
  for (const changed of [
    { environmentId: 'f'.repeat(64) },
    { sessionId: 'foreign' },
    { projectId: 'foreign' }
  ]) {
    await expect(
      h.service.collectOutputsInTurn({ ...collection, ...changed, requestId: 'forged' }, context)
    ).rejects.toThrow()
  }
  for (const changed of [{ sessionId: 'foreign' }, { projectId: 'foreign' }]) {
    await expect(
      h.service.collectOutputsInTurn(
        { ...collection, ...changed, requestId: 'forged-matching-context' },
        { ...context, ...changed }
      )
    ).rejects.toThrow('No matching retained output collection')
  }
  await expect(
    h.service.collectOutputsInTurn(
      { ...collection, requestId: 'wrong-branch' },
      {
        ...context,
        provenanceContext: { ...context.provenanceContext, messageBranchId: 'foreign-branch' }
      }
    )
  ).rejects.toThrow('original Main Agent branch')
  expect((await h.environments.get(collection)).pendingCollection?.collectionId).toBe(
    collection.collectionId
  )
  expect(context.recoverOutput).not.toHaveBeenCalled()
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it.each(['failed', 'cancelled'] as const)(
  'preserves the original %s result when a later turn collects its output',
  async (status) => {
    const h = await setup()
    vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
      const result = await h.executeFixture(request, capability)
      h.runs[0].status = status
      h.runs[0].exitCode = status === 'failed' ? 1 : null
      return { ...result, exitCode: h.runs[0].exitCode }
    })
    const collection = await retainCollection(h)
    const result = await new ManagedExecutionService(h.dependencies).collectOutputsInTurn(
      { ...collection, requestId: 'collect' },
      h.contextFor('later', 'next-prompt')
    )
    expect(result).toMatchObject({
      status,
      runId: 'notebook-run',
      exitCode: status === 'failed' ? 1 : null
    })
    expect(JSON.parse(h.savedOutputs[1].content)).toMatchObject({
      collectedWithoutExecution: true,
      result: { status }
    })
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  }
)

it('keeps retained evidence when output bytes change after the collection was frozen', async () => {
  const h = await setup()
  const collection = await retainCollection(h)
  await writeFile(h.runs[0].workingFiles[0].path, '{"value":43}')
  await expect(
    new ManagedExecutionService(h.dependencies).collectOutputsInTurn(
      { ...collection, requestId: 'collect' },
      h.contextFor('later', 'next-prompt')
    )
  ).rejects.toThrow('original file generation')
  expect((await h.environments.get(collection)).pendingCollection?.collectionId).toBe(
    collection.collectionId
  )
  expect(h.savedOutputs).toEqual([])
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it.each([
  'submission',
  'invocation',
  'nonterminal',
  'provenance',
  'producer',
  'path',
  'bytes',
  'duplicate-run'
] as const)(
  'retains output rather than inventing missing or conflicting %s evidence',
  async (kind) => {
    const h = await setup()
    vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
      const result = await h.executeFixture(request, capability)
      const run = h.runs[0]
      if (kind === 'submission') run.submissionIdentity = 'different-submission'
      else if (kind === 'invocation') run.executionInvocationId = 'different-invocation'
      else if (kind === 'nonterminal') run.status = 'running'
      else if (kind === 'provenance') run.messageBranchId = 'different-branch'
      else if (kind === 'producer') run.workingFiles[0].createdByRunId = 'another-run'
      else if (kind === 'path') run.workingFiles[0].relativePath = 'unrelated/result.json'
      else if (kind === 'bytes') await writeFile(run.workingFiles[0].path, '{"value":43}')
      else h.runs.push(structuredClone(run))
      return result
    })
    await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow()
    expect((await h.environments.get(h.request)).pendingCollection).toBeDefined()
    expect(await readFile(h.runs[0].workingFiles[0].path, 'utf8')).toContain('value')
    expect(h.context.saveOutput).not.toHaveBeenCalled()
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
  }
)

it.each(['generation', 'generation-and-checksum'] as const)(
  'allows first publication with partial %s capture without inventing generation evidence',
  async (missing) => {
    const h = await setup()
    vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
      const result = await h.executeFixture(request, capability)
      delete h.runs[0].workingFiles[0].generationId
      if (missing === 'generation-and-checksum') delete h.runs[0].workingFiles[0].checksum
      return result
    })
    const result = await h.service.executeInTurn(h.request, h.context)
    expect(result).toMatchObject({
      status: 'completed',
      outputs: [{ filename: 'result.json', versionId: 'version-1' }, expect.any(Object)]
    })
    expect(h.savedOutputs[0]).toEqual({
      filename: 'result.json',
      content: '{"value":42}',
      producerRunId: 'notebook-run'
    })
    const journal = JSON.parse(
      await readFile(
        join(h.root, 'managed-execution-requests', result.collectionId + '.json'),
        'utf8'
      )
    )
    expect(journal.collection.frozen.files[0]).not.toHaveProperty('generationId')
    expect(journal.collection.frozen.files[0].attempts[0].source).not.toHaveProperty('generationId')
    expect((await h.environments.get(h.request)).pendingCollection).toBeDefined()
    h.publishSavedVersions()
    await h.service.reconcilePublishedOutputs(scope)
    expect((await h.environments.get(h.request)).pendingCollection).toBeUndefined()
  }
)

it('preserves output and refuses cross-turn recovery when its original generation was never captured', async () => {
  const h = await setup()
  vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
    const result = await h.executeFixture(request, capability)
    delete h.runs[0].workingFiles[0].generationId
    delete h.runs[0].workingFiles[0].checksum
    return result
  })
  const collection = await retainCollection(h)
  const context = h.contextFor('later', 'next-prompt')
  await expect(
    new ManagedExecutionService(h.dependencies).collectOutputsInTurn(
      { ...collection, requestId: 'collect' },
      context
    )
  ).rejects.toThrow(/generation/i)
  expect(context.recoverOutput).not.toHaveBeenCalled()
  expect((await h.environments.get(collection)).pendingCollection?.collectionId).toBe(
    collection.collectionId
  )
  expect(await readFile(h.runs[0].workingFiles[0].path, 'utf8')).toBe('{"value":42}')
  expect(h.savedOutputs).toEqual([])
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it('reads a historical result without collection metadata but cannot grant recovery from it', async () => {
  const h = await setup()
  const result = await h.service.executeInTurn(h.request, h.context)
  const journalPath = join(h.root, 'managed-execution-requests', result.collectionId + '.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  delete journal.collection
  delete journal.result.collectionId
  await writeFile(journalPath, JSON.stringify(journal))
  const restarted = new ManagedExecutionService(h.dependencies)
  expect(await restarted.executeInTurn(h.request, h.context)).toEqual(journal.result)
  await expect(
    restarted.collectOutputsInTurn(
      {
        ...scope,
        environmentId: h.request.environmentId,
        collectionId: result.collectionId,
        requestId: 'legacy-collect'
      },
      h.contextFor('later')
    )
  ).rejects.toThrow('No matching retained output collection')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it('collects partial outputs after process cancellation and reports a cancelled result', async () => {
  const h = await setup()
  const controller = new AbortController()
  vi.mocked(h.runtime.executeManagedShell).mockImplementationOnce(async (request, capability) => {
    await h.executeFixture(request, capability)
    const run = h.runs[0]
    const content = '{"partial":true}'
    await writeFile(run.workingFiles[0].path, content)
    run.status = 'cancelled'
    run.exitCode = null
    run.workingFiles[0].checksum = sha(content)
    run.workingFiles[0].size = Buffer.byteLength(content)
    controller.abort(new Error('cancelled'))
    return { stdout: '', stderr: '', exitCode: null, cancelled: true }
  })
  expect(await h.service.executeInTurn(h.request, h.context, controller.signal)).toMatchObject({
    status: 'cancelled',
    exitCode: null
  })
  expect(h.savedOutputs[0].content).toBe('{"partial":true}')
  expect(JSON.parse(h.savedOutputs[1].content).result.status).toBe('cancelled')
})

it('finishes early cancellation with explicitly unproduced required outputs and releases its collection', async () => {
  const h = await setup()
  h.request.outputs!.push({ path: 'optional.json', filename: 'optional.json', optional: true })
  vi.mocked(h.runtime.executeManagedShell).mockImplementationOnce(async (request, capability) => {
    await h.executeFixture(request, capability)
    const run = h.runs[0]
    await rm(run.workingFiles[0].path)
    run.workingFiles = []
    run.status = 'cancelled'
    run.exitCode = null
    return { stdout: '', stderr: '', exitCode: null, cancelled: true }
  })
  const result = await h.service.executeInTurn(h.request, h.context)
  expect(result).toMatchObject({
    status: 'cancelled',
    missingOptionalOutputs: ['optional.json'],
    missingCancelledOutputs: ['result.json']
  })
  expect(h.savedOutputs).toHaveLength(1)
  expect(JSON.parse(h.savedOutputs[0].content).result.missingCancelledOutputs).toEqual([
    'result.json'
  ])
  h.publishSavedVersions()
  expect(
    await h.service.releaseEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).toMatchObject({ state: 'released' })
  expect(h.runtime.executeManagedShell).toHaveBeenCalledTimes(1)
})

it.each(['completed', 'failed'] as const)(
  'still retains evidence when a %s Run omits required outputs',
  async (status) => {
    const h = await setup()
    vi.mocked(h.runtime.executeManagedShell).mockImplementationOnce(async (request, capability) => {
      await h.executeFixture(request, capability)
      const run = h.runs[0]
      await rm(run.workingFiles[0].path)
      run.workingFiles = []
      run.status = status
      return { stdout: '', stderr: '', exitCode: status === 'completed' ? 0 : 1 }
    })
    await expect(h.service.executeInTurn(h.request, h.context)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(h.savedOutputs).toEqual([])
    expect((await h.environments.get(h.request)).pendingCollection).toBeDefined()
  }
)

it('keeps resources and publishes nothing when process cleanup is unverified', async () => {
  const h = await setup()
  vi.mocked(h.runtime.confirmManagedShellCleanup).mockImplementation(async (scope) => ({
    scope,
    state: 'cleanup-pending',
    reaped: false,
    runId: 'notebook-run'
  }))
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow('cleanup')
  expect(h.savedOutputs).toEqual([])
  expect(h.context.recordRun).not.toHaveBeenCalled()
  expect(await h.environments.get(h.request)).toMatchObject({
    state: 'cleanup-pending',
    activeExecution: { executionInvocationId: expect.any(String) }
  })
  expect(
    await readFile(
      join(h.root, 'research-environments', h.request.environmentId, 'inputs/input.mjs'),
      'utf8'
    )
  ).toContain('42')
})

it('rejects a cleanup proof for another invocation before publishing outputs', async () => {
  const h = await setup()
  vi.mocked(h.runtime.confirmManagedShellCleanup).mockImplementation(async (scope) => ({
    scope: { ...scope, executionInvocationId: 'another-run' },
    state: 'verified',
    reaped: true,
    runId: 'foreign-run',
    proof: 'process-owner'
  }))
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow(
    /proof|verified|belong/
  )
  expect(h.savedOutputs).toEqual([])
  expect(h.context.recordRun).not.toHaveBeenCalled()
})

it('rejects forged path or permission inputs before dispatch and strips private runtime details', async () => {
  const h = await setup()
  for (const payload of [
    { ...h.request, cwd: '/private' },
    { ...h.request, status: 'cancelled' },
    { ...h.request, environment: { TOKEN: 'secret' } },
    { ...h.request, capability: {} },
    { ...h.request, recordObservation: { enabled: true } },
    { ...h.request, failurePolicy: 'ignore' },
    { ...h.request, outputs: [{ path: '../outside', filename: 'result' }] },
    { ...h.request, sessionId: 'foreign' }
  ])
    await expect(h.service.executeInTurn(payload, h.context)).rejects.toThrow()
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
  const discovery = await h.service.runtimes()
  expect(JSON.stringify(discovery)).not.toContain('/private')
  expect(discovery).toMatchObject({ available: true, runtimes: [{ kind: 'node' }] })
  expect(
    await h.service.getEnvironment({ ...scope, environmentId: h.request.environmentId })
  ).not.toHaveProperty('activeExecution')
})

it('explains absent or unsuitable runtimes without publishing private discovery details', async () => {
  const h = await setup()
  for (const code of [
    'node_not_found',
    'node_version_unsupported',
    'node_host_mismatch',
    'node_not_independent',
    'node_unusable',
    'unexpected-private-code'
  ]) {
    h.dependencies.runtimes.discover = async () => ({
      runtimes: [],
      unavailable: [
        { candidate: '/private/person/node', code, reason: 'private-token-from-probe' },
        { candidate: '/another/private/path', code, reason: 'private-token-from-probe' }
      ]
    })
    const result = await h.service.runtimes()
    expect(result).toMatchObject({
      available: false,
      runtimes: [],
      diagnostics: {
        issues: expect.arrayContaining([
          {
            code: code === 'unexpected-private-code' ? 'node_unusable' : code,
            message: expect.any(String),
            action: expect.any(String)
          }
        ])
      }
    })
    expect(
      result.diagnostics!.issues.filter((issue) => issue.code !== 'native_service_unsupported')
    ).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(
      /\/private\/|private-token|unexpected-private-code|"candidate"/
    )
  }
  h.dependencies.runtimes.discover = async () => ({ runtimes: [] })
  expect(await h.service.runtimes()).toMatchObject({
    available: false,
    diagnostics: {
      issues: expect.arrayContaining([expect.objectContaining({ code: 'node_not_found' })])
    }
  })
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
  expect(h.dependencies.operations.start).not.toHaveBeenCalled()
})

it('reports unsupported native services separately from available Node and preserves internal host diagnostics', async () => {
  const h = await setup()
  const port = createManagedExecutionTurnPort({
    dataRoot: h.root,
    service: h.service,
    trackArtifactWrite: async (_sessionId, _owner, write) => write({} as never),
    artifacts: { saveVersion: vi.fn(), replayVersion: vi.fn() },
    notebooks: { readSessionDocuments: vi.fn() }
  })
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    for (const platform of ['linux', 'win32', 'darwin']) {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      const result = await h.service.runtimes()
      expect(result.available).toBe(true)
      expect(result.diagnostics).toEqual({
        nativeServiceSupported: platform === 'darwin',
        issues:
          platform === 'darwin'
            ? []
            : [
                {
                  code: 'native_service_unsupported',
                  message: expect.stringContaining('native macOS'),
                  action: expect.any(String)
                }
              ]
      })
      expect(
        await port.call(
          'runtimes',
          {},
          {
            ...scope,
            ownerExecutionId: 'operation',
            artifactRunId: 'artifact-run',
            artifactStorageSessionId: scope.sessionId,
            workspaceCwd: h.root,
            invocationId: 'invocation',
            provenanceContext: provenance,
            signal: new AbortController().signal,
            assertActive: () => undefined
          }
        )
      ).toEqual(result)
      expect(JSON.stringify(result)).not.toContain('/private')
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
})

it('wait timeout returns current status without cancelling or resubmitting execution', async () => {
  const h = await setup()
  const gate = deferred()
  vi.mocked(h.dependencies.operations.wait).mockImplementation(async () => {
    await gate.promise
    return undefined
  })
  const snapshot = { status: 'running' } as Awaited<
    ReturnType<typeof h.dependencies.operations.get>
  >
  vi.mocked(h.dependencies.operations.get).mockResolvedValue(snapshot)
  const request = { ...scope, requestId: 'run', timeoutMs: 1 }
  expect(await h.service.waitOperation(request)).toEqual(snapshot)
  expect(h.dependencies.operations.cancel).not.toHaveBeenCalled()
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
  gate.resolve()
})

it('passes a typed pre-dispatch cancellation to the external owner without treating same-text failures as cancellation', async () => {
  const h = await setup()
  await h.service.execute(h.request)
  const admitted = vi.mocked(h.dependencies.operations.start).mock.calls[0][0]
  const context = { ...h.context, notebookDataDir: join(h.root, 'notebook') }
  const signal = new AbortController().signal
  const cancelled = new ManagedEnvironmentCancelledError()
  vi.spyOn(h.service, 'executeInTurn').mockRejectedValueOnce(cancelled)
  await expect(admitted.execute(context, signal)).resolves.toMatchObject({ status: 'cancelled' })
  expect(signal.aborted).toBe(false)
  const ordinaryFailure = new Error(cancelled.message)
  vi.mocked(h.service.executeInTurn).mockRejectedValueOnce(ordinaryFailure)
  await expect(admitted.execute(context, signal)).rejects.toBe(ordinaryFailure)
})

it('observes the exact live invocation and real output before execution returns without creating work', async () => {
  const h = await setup()
  await expect(
    h.service.inspectExecution({ ...scope, operationId: 'operation' })
  ).resolves.toBeUndefined()
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
  const entered = deferred()
  const finish = deferred()
  vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
    const result = await h.executeFixture(request, capability)
    const run = h.runs[0]
    run.status = 'running'
    delete run.endedAt
    const policy = resolveManagedShellExecutionCapability(capability, {
      ...scope,
      executionInvocationId: request.executionInvocationId!
    })
    policy.onOutput?.({ runId: run.runId, stream: 'stdout', text: 'step one\n' })
    policy.onOutput?.({ runId: run.runId, stream: 'stderr', text: 'progress warning\n' })
    // A mismatched Run cannot replace evidence for the admitted execution.
    policy.onOutput?.({ runId: 'foreign-run', stream: 'stdout', text: 'wrong\n' })
    entered.resolve()
    await finish.promise
    run.status = 'completed'
    run.endedAt = 2
    return result
  })
  const pending = h.service.executeInTurn(h.request, h.context)
  try {
    await entered.promise
    const live = await h.service.inspectExecution({ ...scope, operationId: 'operation' })
    expect(live).toMatchObject({
      state: 'running',
      purpose: 'research',
      identity: { ...scope, operationId: 'operation', runId: 'notebook-run' },
      run: { status: 'running', text: { stdout: 'step one\n', stderr: 'progress warning\n' } },
      artifacts: []
    })
    expect(h.context.recordRun).not.toHaveBeenCalled()
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
    await expect(
      h.service.inspectExecution({ ...scope, runId: 'notebook-run', operationId: 'foreign' })
    ).resolves.toBeUndefined()
    await expect(
      h.service.inspectExecution({
        ...scope,
        sessionId: 'foreign',
        executionInvocationId: live!.identity.executionInvocationId
      })
    ).resolves.toBeUndefined()
  } finally {
    finish.resolve()
    await pending
  }
  const terminal = await h.service.inspectExecution({ ...scope, runId: 'notebook-run' })
  expect(terminal?.run).toMatchObject({ status: 'completed', text: { stdout: '42' } })
  expect(terminal?.artifacts).toEqual([])
  h.publishSavedVersions()
  expect(
    (await h.service.inspectExecution({ ...scope, runId: 'notebook-run' }))?.artifacts
  ).toHaveLength(2)
})

it('does not choose a latest Run when recorded invocation identity is ambiguous', async () => {
  const h = await setup()
  await h.service.executeInTurn(h.request, h.context)
  h.runs.push({ ...h.runs[0], runId: 'another-run' })
  await expect(h.service.inspectExecution({ ...scope, operationId: 'operation' })).rejects.toThrow(
    'ambiguous'
  )
})

it.each(['external', 'turn'] as const)(
  'requires an explicit service declaration and available Main integration before admitting a %s interactive run',
  async (entrypoint) => {
    const h = await setup()
    const execute = (request: ExecuteManagedEnvironmentRequest): Promise<unknown> =>
      entrypoint === 'external'
        ? h.service.execute(request)
        : h.service.executeInTurn(request, h.context)
    await expect(execute({ ...h.request, projectView: { title: 'Project' } })).rejects.toThrow(
      'declared local service port'
    )
    await expect(
      execute({ ...h.request, localServicePort: 4173, projectView: { title: 'Project' } })
    ).rejects.toThrow('not available')
    expect(h.dependencies.operations.start).not.toHaveBeenCalled()
    expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
    expect(h.savedOutputs).toEqual([])
  }
)

it.skipIf(process.platform !== 'darwin')(
  'binds the opt-in adapter and proof to the actual managed service generation',
  async () => {
    const h = await setup()
    const unregister = vi.fn()
    h.dependencies.registerProjectService = vi.fn(() => unregister)
    h.dependencies.registerObservationMedia = vi.fn(() => ({ close: vi.fn() }))
    vi.mocked(h.runtime.executeManagedShell).mockImplementation(async (request, capability) => {
      const result = await h.executeFixture(request, capability)
      const policy = resolveManagedShellExecutionCapability(capability, {
        ...scope,
        executionInvocationId: request.executionInvocationId!
      })
      expect(policy.environment.NODE_OPTIONS).toContain('--import=file:')
      expect(policy.environment.OPEN_SCIENCE_SERVICE_ADAPTER_SHA256).toMatch(/^[a-f0-9]{64}$/)
      expect(policy.environment).not.toHaveProperty('OPEN_SCIENCE_SERVICE_PROOF')
      await policy.localService!.prepareSocket({ runId: h.runs[0].runId })
      expect(h.dependencies.registerProjectService).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({
            ...scope,
            runId: h.runs[0].runId,
            environmentId: h.request.environmentId
          }),
          logicalPort: 4173,
          proof: {
            value: expect.stringMatching(/^[a-f0-9]{64}$/),
            path: expect.stringMatching(/^\/__open_science_proof_[a-f0-9]{32}$/)
          }
        })
      )
      expect(unregister).not.toHaveBeenCalled()
      return result
    })
    await h.service.executeInTurn(
      {
        ...h.request,
        localServicePort: 4173,
        projectView: { title: 'Generic service', entryPath: '/lab' }
      },
      h.context
    )
    expect(unregister).toHaveBeenCalledOnce()
    expect(h.dependencies.registerObservationMedia).not.toHaveBeenCalled()
    expect(h.savedOutputs.some((output) => output.filename.startsWith('replay-'))).toBe(false)
    const inspected = await h.service.inspectExecution({ ...scope, operationId: 'operation' })
    expect(inspected?.projectView).toEqual({ title: 'Generic service', entryPath: '/lab' })
    expect(inspected?.secrets).toEqual([])
  }
)

it('keeps offline execution purpose Main-owned and rejects switching the same request into research', async () => {
  const h = await setup()
  let policy: ReturnType<typeof resolveManagedShellExecutionCapability> | undefined
  vi.mocked(h.runtime.executeManagedShell).mockImplementation(
    async (request, capability, ...rest) => {
      policy = resolveManagedShellExecutionCapability(capability, {
        ...scope,
        executionInvocationId: request.executionInvocationId!
      })
      return h.executeFixture(request, capability, ...rest)
    }
  )
  await expect(
    h.service.executeInTurn({ ...h.request, confinement: { mode: 'offline-demo' } }, h.context)
  ).rejects.toThrow()
  const result = await h.service.executeDemoInTurn(h.request, h.context)
  expect(result.status).toBe('completed')
  expect((await h.service.inspectExecution({ ...scope, operationId: 'operation' }))?.purpose).toBe(
    'offline-demo'
  )
  expect(policy?.confinement).toEqual({ mode: 'offline-demo', allowedNetworkHosts: [] })
  await expect(h.service.executeInTurn(h.request, h.context)).rejects.toThrow('conflict')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledTimes(1)
  expect(
    h.savedOutputs.find((output) => output.filename.startsWith('execution-'))?.content
  ).toContain('"purpose": "offline-demo"')
})

it('keeps the demo viewing budget Main-only and validates its execution timeout before admission', async () => {
  const h = await setup()
  const executionAdmission = vi.spyOn(h.environments, 'withExecution')
  h.request.timeoutMs = 10000
  h.request.projectView = { title: 'Project' }
  h.request.localServicePort = 4173
  h.dependencies.registerProjectService = vi.fn(() => () => undefined)
  const demoViewing = { mode: 'until-stop-or-timeout' as const, timeoutMs: 10000 }
  for (const untrusted of [{ demoViewing }, { viewing: { mode: 'until-stop-or-timeout' } }])
    await expect(
      h.service.executeInTurn({ ...h.request, ...untrusted }, h.context)
    ).rejects.toThrow()
  await expect(
    h.service.executeDemoInTurn(h.request, h.context, undefined, {
      demoViewing: { ...demoViewing, timeoutMs: 20000 }
    })
  ).rejects.toThrow('does not match')
  await expect(
    h.service.executeDemoInTurn(h.request, h.context, undefined, {
      demoViewing: { ...demoViewing, endReason: 'time-limit' } as never
    })
  ).rejects.toThrow()
  expect(executionAdmission).not.toHaveBeenCalled()
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'darwin')(
  'binds demo viewing retries and persists the budget without extending process lifetime',
  async () => {
    const h = await setup()
    h.request.timeoutMs = 10000
    h.request.projectView = { title: 'Project' }
    h.request.localServicePort = 4173
    h.dependencies.registerProjectService = vi.fn(() => () => undefined)
    const demoViewing = { mode: 'until-stop-or-timeout' as const, timeoutMs: 10000 }
    const result = await h.service.executeDemoInTurn(h.request, h.context, undefined, {
      demoViewing
    })
    expect(result.status).toBe('completed')
    expect(h.runtime.executeManagedShell).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10000 }),
      expect.anything(),
      expect.anything(),
      undefined
    )
    const restarted = new ManagedExecutionService(h.dependencies)
    expect(
      await restarted.executeDemoInTurn(h.request, h.context, undefined, { demoViewing })
    ).toEqual(result)
    await expect(
      restarted.executeDemoInTurn(h.request, h.context, undefined, {
        demoViewing: { ...demoViewing, mode: 'process-lifetime' }
      })
    ).rejects.toThrow('conflict')
    expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
    expect(
      (await restarted.inspectExecution({ ...scope, operationId: 'operation' }))?.demoViewing
    ).toEqual(demoViewing)
    const observed = await createManagedRunObservationReader(restarted)({
      ...scope,
      operationId: 'operation'
    })
    expect(observed?.executionContext?.demoViewing).toEqual({
      ...demoViewing,
      endReason: 'process-exited'
    })
    const receipt = JSON.parse(
      h.savedOutputs.find((output) => output.filename.startsWith('execution-'))!.content
    )
    expect(receipt.demoViewing).toEqual(demoViewing)
    expect(receipt.demoViewing).not.toHaveProperty('endReason')
  }
)

it.each(['linux', 'win32'] as const)(
  'rejects a trusted demo viewing request on %s before starting a local service',
  async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      const h = await setup()
      h.request.timeoutMs = 10000
      h.request.projectView = { title: 'Project' }
      h.request.localServicePort = 4173
      h.dependencies.registerProjectService = vi.fn(() => () => undefined)
      await expect(
        h.service.executeDemoInTurn(h.request, h.context, undefined, {
          demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 10000 }
        })
      ).rejects.toThrow('Managed local services currently require native macOS.')
      expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
      expect(h.dependencies.registerProjectService).not.toHaveBeenCalled()
      expect(h.runs).toEqual([])
      expect(h.savedOutputs).toEqual([])
      expect(
        (await h.service.inspectExecution({ ...scope, operationId: 'operation' }))?.state
      ).toBe('failed')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }
)

it('does not invent viewing facts when replaying a legacy demo journal', async () => {
  const h = await setup()
  const result = await h.service.executeDemoInTurn(h.request, h.context)
  const key = sha(
    JSON.stringify([scope.projectId, scope.sessionId, h.context.operationId, h.request.requestId])
  )
  const path = join(h.root, 'managed-execution-requests', key + '.json')
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.demoViewing
  await writeFile(path, JSON.stringify(legacy))
  const restarted = new ManagedExecutionService(h.dependencies)
  expect(await restarted.executeDemoInTurn(h.request, h.context)).toEqual(result)
  const observed = await createManagedRunObservationReader(restarted)({
    ...scope,
    operationId: 'operation'
  })
  expect(observed?.executionContext?.purpose).toBe('offline-demo')
  expect(observed?.executionContext?.demoViewing).toBeUndefined()
  expect(h.runtime.executeManagedShell).toHaveBeenCalledOnce()
})

it('verifies supplemental demo Versions against the source and records their dependency without restoring caller paths', async () => {
  const h = await setup()
  await expect(
    h.service.executeDemoInTurn(h.request, h.context, undefined, {
      inputVersionIds: ['outside-source']
    })
  ).rejects.toThrow('unavailable')
  expect(h.runtime.executeManagedShell).not.toHaveBeenCalled()
  await h.service.executeDemoInTurn(h.request, h.context, undefined, {
    inputVersionIds: ['version-1']
  })
  const receipt = JSON.parse(
    h.savedOutputs.find((output) => output.filename.startsWith('execution-'))!.content
  )
  expect(receipt.supplementalInputs).toEqual([
    expect.objectContaining({ versionId: 'version-1', sha256: sha('export const input = 42') })
  ])
  expect(h.dependencies.resolvePreparedInputs).toHaveBeenCalledTimes(2)
})

it('recognizes old research request receipts after upgrade without rerunning or relabeling them as demos', async () => {
  const h = await setup()
  const result = await h.service.executeInTurn(h.request, h.context)
  const key = sha(
    JSON.stringify([scope.projectId, scope.sessionId, h.context.operationId, h.request.requestId])
  )
  const path = join(h.root, 'managed-execution-requests', key + '.json')
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.purpose
  legacy.fingerprint = sha(JSON.stringify(executeManagedEnvironmentRequestSchema.parse(h.request)))
  await writeFile(path, JSON.stringify(legacy))
  const restarted = new ManagedExecutionService(h.dependencies)
  expect(await restarted.executeInTurn(h.request, h.context)).toEqual(result)
  expect(
    (await restarted.inspectExecution({ ...scope, operationId: 'operation' }))?.purpose
  ).toBeUndefined()
  await expect(restarted.executeDemoInTurn(h.request, h.context)).rejects.toThrow('conflicts')
  expect(h.runtime.executeManagedShell).toHaveBeenCalledTimes(1)
  vi.mocked(h.dependencies.operations.get).mockResolvedValueOnce({
    requestFingerprint: legacy.fingerprint
  } as never)
  await restarted.execute(h.request)
  expect(h.dependencies.operations.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ requestFingerprint: legacy.fingerprint })
  )
})
