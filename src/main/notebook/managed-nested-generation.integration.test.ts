import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord, NotebookWorkingFile } from '../../shared/notebook'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookLocalRpcServer } from './local-rpc-server'
import {
  createManagedShellExecutionCapability,
  type ManagedShellCleanupResult
} from './managed-shell-execution'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { getNotebookDataRoot, NotebookRunRepository } from './repository'
import { NotebookRuntimeService, type NotebookControlResult } from './runtime-service'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const enabled = process.platform === 'darwin' && process.env.RUN_MANAGED_NESTED_GENERATION === '1'
const scope = { projectId: 'nested-project', sessionId: 'nested-session' }
const provenance = {
  rootFrameId: `root-frame-${scope.sessionId}`,
  agentFrameId: `root-frame-${scope.sessionId}`,
  messageBranchId: 'nested-branch',
  runtimeSegmentId: 'nested-segment',
  promptMessageId: 'nested-prompt'
}
const outputRelativePath = 'data/managed-output/files/result.json'
const outerRelativePath = 'data/outer.txt'
const childCall = (ordinal = 1): string =>
  `await host.managedExecution.execute(${JSON.stringify({
    environmentId: 'a'.repeat(64),
    requestId: `nested-child-${ordinal}`,
    command: 'write the fixture result'
  })})`

type Evidence = {
  activityId: string
  relations: Array<{
    relation: string
    relativePath: string
    generation?: { generationId: string; checksum: string }
  }>
  scientificOutputs: Array<{ members: string[] }>
}
type ChildCompletion = {
  cleanup: ManagedShellCleanupResult
  parentInvocationId: string
  mtimeMs: number
  ctimeMs: number
  ino: number
}
type ScenarioResult = {
  outerResult: NotebookControlResult
  outer: NotebookRunRecord
  children: NotebookRunRecord[]
  completions: ChildCompletion[]
  evidence: Map<string, Evidence>
  finalOutput: { content: string; mtimeMs: number; ctimeMs: number; ino: number }
}

async function runScenario(options: {
  borrowChildOutput?: boolean
  childValues?: number[]
  fixedMtime?: boolean
  code(paths: { outputPath: string; outerPath: string }): string
}): Promise<ScenarioResult> {
  if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('This integration test requires an independent Node >=22.')
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-nested-generation-')))
  const work = join(root, 'managed-work')
  const dataRoot = getNotebookDataRoot(root, scope.projectId, scope.sessionId)
  const outputRoot = join(dataRoot, 'managed-output', 'files')
  const outputPath = join(outputRoot, 'result.json')
  await Promise.all([mkdir(work), mkdir(outputRoot, { recursive: true })])
  const node = await realpath(process.execPath)
  const sandbox = new NotebookNetworkSandboxOwner({
    resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
    temporaryRoot: join(root, 'commands'),
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    requestDecision: async () => 'deny'
  })
  const repository = new NotebookRunRepository(root)
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: scope.projectId,
    repository,
    processSandbox: sandbox,
    executorFactory: (_sessionId, lifecycle) => new NotebookKernelExecutor(lifecycle)
  })
  const completions: ChildCompletion[] = []
  const childValues = options.childValues ?? [42]
  let childIndex = 0
  // Bypass only the material/environment business layer. Both the outer REPL and the
  // inner sandboxed Bash process run through the actual runtime and durable Run repository.
  const server = new NotebookLocalRpcServer(service, {
    transport: 'tcp',
    managedExecution: {
      async call(method, _payload, context) {
        expect(method).toBe('execute')
        context.assertActive()
        const value = childValues[childIndex++]
        if (value === undefined) throw new Error('Unexpected extra nested managed execution.')
        const shellScope = { ...scope, executionInvocationId: `actual-inner-shell-${childIndex}` }
        const capability = createManagedShellExecutionCapability({
          ...shellScope,
          cwd: work,
          outputRoot,
          environment: {
            HOME: work,
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            OPEN_SCIENCE_OUTPUT_DIR: outputRoot
          },
          filesystem: { readOnlyRoots: [], readWriteRoots: [work, outputRoot] },
          signal: context.signal
        })
        const result = await service.executeManagedShell(
          {
            ...shellScope,
            workspaceCwd: root,
            command:
              `printf '{"value":${value}}\\n' > "$OPEN_SCIENCE_OUTPUT_DIR/result.json"` +
              (options.fixedMtime
                ? '; touch -t 202001010000.00 "$OPEN_SCIENCE_OUTPUT_DIR/result.json"'
                : ''),
            timeoutMs: 10000,
            rootExecutionId: context.ownerExecutionId,
            provenanceContext: context.provenanceContext
          },
          capability,
          context.signal,
          options.borrowChildOutput === false
            ? undefined
            : { parentControlInvocationId: context.invocationId }
        )
        const cleanup = await service.confirmManagedShellCleanup(shellScope, { retry: true })
        const checkpoint = await stat(outputPath)
        completions.push({
          cleanup,
          parentInvocationId: context.invocationId,
          mtimeMs: checkpoint.mtimeMs,
          ctimeMs: checkpoint.ctimeMs,
          ino: checkpoint.ino
        })
        return { exitCode: result.exitCode, cleanup }
      }
    }
  })
  service.setMcpRpcConnectionResolver((binding) =>
    server.issueControlConnection(
      binding.sessionId,
      binding.projectId,
      binding.agentFrameId,
      { role: 'main' },
      binding.executionCwd
    )
  )
  server.setArtifactTurnBinding(scope.sessionId, {
    projectId: scope.projectId,
    ownerExecutionId: 'actual-outer-artifact-turn',
    artifactRunId: 'actual-artifact-run',
    artifactStorageSessionId: 'actual-storage-route',
    provenanceContext: provenance
  })
  try {
    const outerResult = await service.executeControl({
      ...scope,
      workspaceCwd: root,
      rootExecutionId: 'actual-outer-artifact-turn',
      provenanceContext: provenance,
      code: options.code({ outputPath, outerPath: join(dataRoot, 'outer.txt') })
    })
    const runs = await repository.readSessionRuns(scope.projectId, scope.sessionId)
    expect(runs).toHaveLength(1 + childValues.length)
    const outer = runs.find((run) => run.kernelKind === 'repl')!
    const children = runs.filter((run) => run.kernelKind === 'bash')
    expect(outer).toBeDefined()
    expect(children).toHaveLength(childValues.length)
    expect(completions).toHaveLength(children.length)
    for (let index = 0; index < children.length; index++) {
      expect(children[index].status).toBe('completed')
      expect(completions[index]).toMatchObject({
        parentInvocationId: outer.runId,
        cleanup: {
          state: 'verified',
          reaped: true,
          proof: 'process-owner',
          runId: children[index].runId
        }
      })
      expect(completions[index].cleanup.runId).not.toBe(outer.runId)
    }
    const evidence = new Map<string, Evidence>()
    for (const run of runs) {
      expect(run.fileEvidence?.storageKey).toBeTruthy()
      evidence.set(
        run.runId,
        JSON.parse(await readFile(join(root, run.fileEvidence!.storageKey!), 'utf8')) as Evidence
      )
    }
    const final = await stat(outputPath)
    return {
      outerResult,
      outer,
      children,
      completions,
      evidence,
      finalOutput: {
        content: await readFile(outputPath, 'utf8'),
        mtimeMs: final.mtimeMs,
        ctimeMs: final.ctimeMs,
        ino: final.ino
      }
    }
  } finally {
    const stopped = await service.shutdownAll()
    await server.close()
    await service.dispose()
    await sandbox.dispose()
    expect(stopped.reaped).toBe(true)
    if (stopped.reaped) await rm(root, { recursive: true, force: true })
  }
}

function fileFor(run: NotebookRunRecord, relativePath = outputRelativePath): NotebookWorkingFile {
  const file = run.workingFiles.find((candidate) => candidate.relativePath === relativePath)
  expect(file).toBeDefined()
  expect(file!.generationId).toBeTruthy()
  expect(file!.checksum).toMatch(/^[a-f0-9]{64}$/)
  return file!
}

function expectOwnGeneration(
  result: ScenarioResult,
  run: NotebookRunRecord,
  relativePath = outputRelativePath
): void {
  const file = fileFor(run, relativePath)
  expect(file.createdByRunId).toBe(run.runId)
  expect(result.evidence.get(run.runId)!.relations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relation: expect.stringMatching(/^(created|modified)$/),
        relativePath,
        generation: expect.objectContaining({
          generationId: file.generationId,
          checksum: file.checksum
        })
      })
    ])
  )
}

function expectBorrowedGeneration(result: ScenarioResult): void {
  const inner = result.children.at(-1)!
  const innerFile = fileFor(inner)
  const outerFile = fileFor(result.outer)
  expect(outerFile).toMatchObject({
    path: innerFile.path,
    relativePath: innerFile.relativePath,
    size: innerFile.size,
    mtimeMs: innerFile.mtimeMs,
    checksum: innerFile.checksum,
    generationId: innerFile.generationId,
    createdByRunId: inner.runId
  })
  expectOwnGeneration(result, inner)
  const outerEvidence = result.evidence.get(result.outer.runId)!
  expect(
    outerEvidence.relations.filter(
      (relation) =>
        relation.relativePath === outputRelativePath &&
        (relation.relation === 'created' || relation.relation === 'modified')
    )
  ).toHaveLength(0)
  expect(outerEvidence.scientificOutputs.flatMap((output) => output.members)).not.toContain(
    outputRelativePath
  )
}

describe.skipIf(!enabled)('managed child generations through real REPL and sandboxed Bash', () => {
  it('preserves the duplicate-owner reproducer when parent observation binding is omitted', async () => {
    const result = await runScenario({ borrowChildOutput: false, code: () => childCall() })
    expect(result.outerResult.status).toBe('completed')
    expectOwnGeneration(result, result.outer)
    expectOwnGeneration(result, result.children[0])
    const outer = fileFor(result.outer)
    const inner = fileFor(result.children[0])
    expect(outer).toMatchObject({
      path: inner.path,
      checksum: inner.checksum,
      size: inner.size,
      mtimeMs: inner.mtimeMs
    })
    expect(outer.generationId).not.toBe(inner.generationId)
  })

  it.each(['completed', 'failed'] as const)(
    'references the child generation when the outer REPL is %s',
    async (status) => {
      const result = await runScenario({
        code: () =>
          `${childCall()}; ${status === 'failed' ? 'throw new Error("outer failed after child")' : ''}`
      })
      expect(result.outerResult.status).toBe(status)
      expect(result.outer.status).toBe(status)
      expect(result.finalOutput.content).toBe('{"value":42}\n')
      expectBorrowedGeneration(result)
    }
  )

  it('keeps a genuine later outer write as a separate generation', async () => {
    const result = await runScenario({
      code: ({ outputPath }) =>
        `${childCall()}; require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, '{"value":99}\\n')`
    })
    expect(result.outerResult.status).toBe('completed')
    expect(result.finalOutput.content).toBe('{"value":99}\n')
    expectOwnGeneration(result, result.outer)
    expectOwnGeneration(result, result.children[0])
    expect(fileFor(result.outer).generationId).not.toBe(fileFor(result.children[0]).generationId)
    expect(fileFor(result.outer).checksum).not.toBe(fileFor(result.children[0]).checksum)
  })

  it('keeps an outer rewrite of identical bytes after mtime restoration as a separate generation', async () => {
    const result = await runScenario({
      fixedMtime: true,
      code: ({ outputPath }) => `${childCall()};
        const fs = require('node:fs');
        const path = ${JSON.stringify(outputPath)};
        const before = fs.statSync(path);
        const content = fs.readFileSync(path);
        fs.writeFileSync(path, content);
        fs.utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);`
    })
    expect(result.outerResult.status).toBe('completed')
    expect(result.finalOutput.content).toBe('{"value":42}\n')
    expect(result.finalOutput.mtimeMs).toBe(result.completions[0].mtimeMs)
    expect(result.finalOutput.ctimeMs).not.toBe(result.completions[0].ctimeMs)
    expectOwnGeneration(result, result.outer)
    expectOwnGeneration(result, result.children[0])
    const outer = fileFor(result.outer)
    const inner = fileFor(result.children[0])
    expect(outer).toMatchObject({
      checksum: inner.checksum,
      size: inner.size,
      mtimeMs: inner.mtimeMs
    })
    expect(outer.generationId).not.toBe(inner.generationId)
  })

  it('keeps an inode replacement with identical bytes and restored mtime as an outer generation', async () => {
    const result = await runScenario({
      fixedMtime: true,
      code: ({ outputPath }) => `${childCall()};
        const fs = require('node:fs');
        const path = ${JSON.stringify(outputPath)};
        const before = fs.statSync(path);
        const content = fs.readFileSync(path);
        fs.renameSync(path, path + '.previous');
        fs.writeFileSync(path, content);
        fs.utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);`
    })
    expect(result.outerResult.status).toBe('completed')
    expect(result.finalOutput.content).toBe('{"value":42}\n')
    expect(result.finalOutput.mtimeMs).toBe(result.completions[0].mtimeMs)
    expect(result.finalOutput.ino).not.toBe(result.completions[0].ino)
    expectOwnGeneration(result, result.outer)
    expectOwnGeneration(result, result.children[0])
    const outer = fileFor(result.outer)
    const inner = fileFor(result.children[0])
    expect(outer).toMatchObject({
      checksum: inner.checksum,
      size: inner.size,
      mtimeMs: inner.mtimeMs
    })
    expect(outer.generationId).not.toBe(inner.generationId)
  })

  it('references only the final child generation after sequential writes to the same path', async () => {
    const result = await runScenario({
      childValues: [42, 99],
      code: () => `${childCall(1)}; ${childCall(2)}`
    })
    expect(result.outerResult.status).toBe('completed')
    expect(result.finalOutput.content).toBe('{"value":99}\n')
    expectOwnGeneration(result, result.children[0])
    expectBorrowedGeneration(result)
    expect(fileFor(result.children[0]).checksum).not.toBe(fileFor(result.children[1]).checksum)
    expect(
      result.outer.workingFiles.filter((file) => file.relativePath === outputRelativePath)
    ).toHaveLength(1)
    expect(fileFor(result.outer).generationId).not.toBe(fileFor(result.children[0]).generationId)
  })

  it('preserves the outer own output alongside a borrowed child output', async () => {
    const result = await runScenario({
      code: ({ outerPath }) =>
        `${childCall()}; require('node:fs').writeFileSync(${JSON.stringify(outerPath)}, 'outer output')`
    })
    expect(result.outerResult.status).toBe('completed')
    expectBorrowedGeneration(result)
    expectOwnGeneration(result, result.outer, outerRelativePath)
  })
})

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
