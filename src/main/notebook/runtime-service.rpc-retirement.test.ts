import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { getNotebookDataRoot, NotebookRunRepository } from './repository'
import { getNotebookInputRoot } from './input-staging'
import { materializeNotebookPromptInput } from './prompt-input-materialization'
import { createFrameNotebookLane } from './lane-identity'
import {
  NotebookRuntimeService,
  type NotebookControlResult,
  type NotebookExecutionRequest,
  type NotebookExecutorLifecycleCallbacks
} from './runtime-service'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('inspects a session dataset through authenticated RPC without executing or trusting body scope', async () => {
  const h = await harness()
  const dataRoot = getNotebookDataRoot(h.root, 'default-project', 'session-1')
  await mkdir(dataRoot, { recursive: true })
  await writeFile(join(dataRoot, 'table.csv'), 'id,value\na,1\na,3\n')
  const execute = vi.spyOn(h.service, 'execute')
  const state = vi.spyOn(h.service, 'state')
  const connection = await h.server.issueSessionConnection(
    'session-1',
    'default-project',
    'root-frame-session-1'
  )
  const call = (path: string): Promise<Response> =>
    fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'inspectDataset',
          params: {
            sessionId: 'forged-session',
            projectId: 'forged-project',
            workspaceCwd: h.root,
            path,
            idColumn: 'id',
            columns: ['value']
          }
        })
      },
      'Dataset inspection test'
    )
  const response = await call('table.csv')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    result: {
      dimensions: { rows: 2, columns: 2 },
      inspection: { scope: 'complete' },
      columns: [{ duplicateIdCount: 1 }, { numericRange: { min: 1, max: 3 } }]
    }
  })
  await writeFile(join(h.root, 'outside.csv'), 'id,value\na,99\n')
  const outside = await call(join(h.root, 'outside.csv'))
  expect(outside.ok).toBe(false)
  expect(await outside.text()).toContain('outside the current session read scope')
  const otherSession = getNotebookDataRoot(h.root, 'default-project', 'session-2')
  await mkdir(otherSession, { recursive: true })
  await writeFile(join(otherSession, 'table.csv'), 'id,value\na,99\n')
  expect((await call(join(otherSession, 'table.csv'))).ok).toBe(false)

  const content = 'id,value\nattached,7\n'
  const stagedRoot = getNotebookInputRoot(h.root, 'default-project', 'session-1')
  await mkdir(stagedRoot, { recursive: true })
  const stagedPath = join(stagedRoot, 'content')
  await writeFile(stagedPath, content)
  const attached = await materializeNotebookPromptInput({
    storageRoot: h.root,
    projectId: 'default-project',
    appSessionId: 'session-1',
    stagedPath,
    input: {
      inputFileVersionId: 'version-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceProjectId: 'default-project',
      sourceSessionId: 'session-1',
      filename: 'attached.csv',
      sizeBytes: Buffer.byteLength(content),
      checksum: createHash('sha256').update(content).digest('hex'),
      storageKey: 'unused',
      association: 'turn-attached'
    }
  })
  expect(await (await call(attached.notebookPath)).json()).toMatchObject({
    result: { preview: { rows: [['attached', '7']] } }
  })
  expect(execute).not.toHaveBeenCalled()
  expect(state).not.toHaveBeenCalled()
})

it('keeps inspection inside the authenticated child lane and denies revoked attempts', async () => {
  const h = await harness()
  const scope = { projectId: 'default-project', sessionId: 'session-1', agentFrameId: 'frame-one' }
  const childRoot = getNotebookDataRoot(
    h.root,
    scope.projectId,
    scope.sessionId,
    createFrameNotebookLane(scope.projectId, scope.sessionId, scope.agentFrameId, 'attempt-one')
  )
  const siblingRoot = getNotebookDataRoot(
    h.root,
    scope.projectId,
    scope.sessionId,
    createFrameNotebookLane(scope.projectId, scope.sessionId, 'frame-two')
  )
  for (const root of [childRoot, siblingRoot]) {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'table.csv'), 'value\n1')
  }
  let writable = true
  const connection = await h.server.issueDelegatedNotebookConnection({
    ...scope,
    rootFrameId: 'root-frame-session-1',
    attemptId: 'attempt-one',
    messageBranchId: 'branch-one',
    runtimeSegmentId: 'runtime-one',
    promptMessageId: 'message-one',
    workspaceCwd: siblingRoot,
    isAttemptWritable: () => writable
  })
  cleanups.push(() => connection.revoke())
  const call = (path: string): Promise<Response> =>
    fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'inspectDataset',
          params: {
            projectId: scope.projectId,
            sessionId: scope.sessionId,
            workspaceCwd: siblingRoot,
            path,
            provenanceContext: { rootFrameId: 'root-frame-session-1', agentFrameId: 'frame-two' }
          }
        })
      },
      'Dataset child inspection test'
    )
  const inspected = await call('table.csv')
  expect(inspected.status, await inspected.text()).toBe(200)
  expect((await call(join(siblingRoot, 'table.csv'))).ok).toBe(false)
  writable = false
  expect((await call('table.csv')).status).toBe(403)
  expect(h.requests).toHaveLength(0)
})

it('cancels an admitted inspection on project deletion and drains without creating a kernel', async () => {
  const h = await harness()
  const root = getNotebookDataRoot(h.root, 'default-project', 'session-1')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'table.csv'), 'value\n1')
  const fs = await import('node:fs/promises')
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const opened = deferred()
  const resume = deferred()
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    opened.resolve()
    await resume.promise
    return handle
  })
  const request = {
    projectId: 'default-project',
    sessionId: 'session-1',
    workspaceCwd: root,
    path: 'table.csv'
  }
  const pending = h.service.inspectDataset(request)
  const rejected = expect(pending).rejects.toThrow()
  try {
    await opened.promise
    h.service.beginProjectDeletion('default-project')
    resume.resolve()
    await rejected
    await expect(h.service.inspectDataset(request)).rejects.toThrow()
    h.service.releaseProjectDeletion('default-project')
    expect(await h.service.inspectDataset(request)).toMatchObject({
      inspection: { scope: 'complete' }
    })
    expect(h.requests).toHaveLength(0)
  } finally {
    resume.resolve()
    spy.mockRestore()
    h.service.releaseProjectDeletion('default-project')
  }
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function harness(
  options: {
    onExecute?: (request: NotebookExecutionRequest) => Promise<void>
    realExecutor?: boolean
    onSpawn?: () => Promise<void>
    serverOptions?: ConstructorParameters<typeof NotebookLocalRpcServer>[1]
  } = {}
): Promise<{
  root: string
  repository: NotebookRunRepository
  service: NotebookRuntimeService
  server: NotebookLocalRpcServer
  requests: NotebookExecutionRequest[]
  lifecycles: NotebookExecutorLifecycleCallbacks[]
  execute: (
    sessionId?: string,
    code?: string,
    signal?: AbortSignal
  ) => Promise<NotebookControlResult>
  authorityStatus: (request: NotebookExecutionRequest) => Promise<number>
}> {
  const root = await mkdtemp(join(tmpdir(), 'notebook-rpc-retirement-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const requests: NotebookExecutionRequest[] = []
  const lifecycles: NotebookExecutorLifecycleCallbacks[] = []
  const repository = new NotebookRunRepository(root)
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'default-project',
    repository,
    executorFactory: (_sessionId, lifecycle) => {
      lifecycles.push(lifecycle)
      if (options.realExecutor) {
        const executor = new NotebookKernelExecutor(lifecycle)
        const execute = executor.execute.bind(executor)
        vi.spyOn(executor, 'execute').mockImplementation(async (request) => {
          requests.push(request)
          await options.onExecute?.(request)
          return execute(request)
        })
        const spawn = executor['spawnLoop'].bind(executor)
        executor['spawnLoop'] = async (...args) => {
          await options.onSpawn?.()
          return spawn(...args)
        }
        return executor
      }
      return {
        execute: async (request) => {
          requests.push(request)
          await options.onExecute?.(request)
          return {
            status: 'completed' as const,
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      }
    }
  })
  const server = new NotebookLocalRpcServer(service, { transport: 'tcp', ...options.serverOptions })
  cleanups.push(() => server.close())
  cleanups.push(() => service.shutdownAll())
  service.setMcpRpcConnectionResolver((binding) =>
    server.issueControlConnection(
      binding.sessionId,
      binding.projectId,
      binding.agentFrameId,
      { role: 'main' },
      binding.executionCwd
    )
  )
  const execute = (
    sessionId = 'session-1',
    code = 'return 1',
    signal?: AbortSignal
  ): Promise<NotebookControlResult> =>
    service.executeControl(
      {
        projectId: 'default-project',
        sessionId,
        workspaceCwd: root,
        code
      },
      signal
    )
  const authorityStatus = async (request: NotebookExecutionRequest): Promise<number> => {
    const response = await fetchLocalRpc(
      { endpoint: request.mcpRpcEndpoint! },
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.mcpRpcToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
      },
      'REPL retirement authority test'
    )
    await response.json()
    return response.status
  }
  return { root, repository, service, server, requests, lifecycles, execute, authorityStatus }
}

describe('REPL process RPC ownership', () => {
  it.each(['starting', 'running'] as const)(
    'waits for a %s REPL and fences later calls until targeted restart completes',
    async (phase) => {
      const entered = deferred()
      const release = deferred()
      let first = true
      const h = await harness({
        realExecutor: true,
        onSpawn: async () => {
          if (phase !== 'starting' || !first) return
          first = false
          entered.resolve()
          await release.promise
        }
      })
      const marker = join(h.root, 'running')
      const gate = join(h.root, 'continue')
      const initial = h.execute(
        'session-1',
        phase === 'starting'
          ? 'globalThis.reviewSentinel = 17'
          : `globalThis.reviewSentinel = 17;
         require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');
         while (!require('node:fs').existsSync(${JSON.stringify(gate)})) {
           await new Promise(resolve => setTimeout(resolve, 10));
         }`
      )
      const operations: Promise<unknown>[] = [initial]
      try {
        if (phase === 'starting') await entered.promise
        else await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 })
        let restarted = false
        const restart = h.service
          .restart({
            projectId: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: h.root,
            kernel: 'repl'
          })
          .then(() => {
            restarted = true
          })
        operations.push(restart)
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(restarted).toBe(false)
        expect(await h.authorityStatus(h.requests[0])).toBe(200)
        const next = h.execute('session-1', 'console.log(globalThis.reviewSentinel)')
        operations.push(next)
        release.resolve()
        await writeFile(gate, '')
        expect((await initial).status).toBe('completed')
        await restart
        const result = await next
        expect(result.stdout.trim()).toBe('undefined')
        expect(h.requests[1].kernelEpochId).not.toBe(h.requests[0].kernelEpochId)
        expect(await h.authorityStatus(h.requests[0])).toBe(401)
        expect(await h.authorityStatus(h.requests[1])).toBe(200)
        expect((await h.execute('session-1', 'console.log(23)')).stdout.trim()).toBe('23')
      } finally {
        release.resolve()
        await writeFile(gate, '')
        await Promise.allSettled(operations)
      }
    }
  )

  it('revokes a retired REPL capability while preserving another session and its successor', async () => {
    const h = await harness()
    await h.execute()
    const old = h.requests[0]
    await h.execute('session-2')
    const other = h.requests[1]
    expect(await h.authorityStatus(old)).toBe(200)
    await h.lifecycles[0].onTerminated('repl')
    expect(await h.authorityStatus(old)).toBe(401)
    expect(await h.authorityStatus(other)).toBe(200)
    await h.execute()
    const successor = h.requests[2]
    expect(successor.kernelEpochId).not.toBe(old.kernelEpochId)
    expect(successor.mcpRpcToken).not.toBe(old.mcpRpcToken)
    expect(await h.authorityStatus(successor)).toBe(200)
    expect(await h.authorityStatus(old)).toBe(401)
  })

  it('keeps the REPL authority across Python/R termination and provider detach/reconnect', async () => {
    const h = await harness()
    await h.execute()
    const repl = h.requests[0]
    await h.lifecycles[0].onTerminated('python', 'default-python')
    await h.lifecycles[0].onIdleShutdown('r', 'default-r')
    h.server.releaseSessionCapabilities('session-1')
    await h.server.issueSessionConnection('session-1', 'default-project', 'root-frame-session-1')
    await h.execute()
    expect(h.requests[1].mcpRpcToken).toBe(repl.mcpRpcToken)
    expect(await h.authorityStatus(repl)).toBe(200)
  })

  it('binds an already queued successor after retirement persistence to its actual dispatch epoch', async () => {
    const firstDispatched = deferred()
    const finishFirst = deferred()
    const h = await harness({
      onExecute: async (request) => {
        if (request.code === 'first') {
          firstDispatched.resolve()
          await finishFirst.promise
        }
      }
    })
    const first = h.execute('session-1', 'first')
    await firstDispatched.promise
    const second = h.execute('session-1', 'second')
    await vi.waitFor(async () => {
      const state = await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })
      expect(state.runs.find((run) => run.script === 'second')?.status).toBe('queued')
    })
    const persistGate = deferred()
    const persistStarted = deferred()
    const mark = h.repository.markKernelTerminated.bind(h.repository)
    vi.spyOn(h.repository, 'markKernelTerminated').mockImplementation(async (request) => {
      persistStarted.resolve()
      await persistGate.promise
      return mark(request)
    })
    const retired = h.lifecycles[0].onTerminated('repl')
    await persistStarted.promise
    finishFirst.resolve()
    await first
    expect(h.requests).toHaveLength(1)
    expect(await h.authorityStatus(h.requests[0])).toBe(401)
    persistGate.resolve()
    await retired
    await second
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].kernelEpochId).not.toBe(h.requests[0].kernelEpochId)
    expect(h.requests[1].mcpRpcToken).not.toBe(h.requests[0].mcpRpcToken)
    expect(await h.authorityStatus(h.requests[1])).toBe(200)
    const state = await h.service.state({ sessionId: 'session-1', workspaceCwd: h.root })
    expect(state.runs.find((run) => run.script === 'second')?.kernelEpochId).toBe(
      h.requests[1].kernelEpochId
    )
  })

  it('releases late capability acquisition after retirement without dispatching that run', async () => {
    const h = await harness()
    const issued = deferred()
    const returnConnection = deferred()
    let old: Awaited<ReturnType<typeof h.server.issueControlConnection>> | undefined
    h.service.setMcpRpcConnectionResolver(async (binding) => {
      const connection = await h.server.issueControlConnection(
        binding.sessionId,
        binding.projectId,
        binding.agentFrameId
      )
      if (!old) {
        old = connection
        issued.resolve()
        await returnConnection.promise
      }
      return connection
    })
    const first = h.execute()
    await issued.promise
    await h.lifecycles[0].onTerminated('repl')
    returnConnection.resolve()
    await expect(first).resolves.toMatchObject({ status: 'failed' })
    expect(h.requests).toHaveLength(0)
    expect(
      await h.authorityStatus({
        mcpRpcEndpoint: old!.endpoint,
        mcpRpcToken: old!.token
      } as NotebookExecutionRequest)
    ).toBe(401)
    await h.execute('session-1', 'successor')
    expect(h.requests).toHaveLength(1)
    expect(await h.authorityStatus(h.requests[0])).toBe(200)
  })

  it('does not dispatch a cancelled invocation after its pending capability resolver completes', async () => {
    const h = await harness()
    const issued = deferred()
    const returnConnection = deferred()
    h.service.setMcpRpcConnectionResolver(async (binding) => {
      const connection = await h.server.issueControlConnection(
        binding.sessionId,
        binding.projectId,
        binding.agentFrameId
      )
      issued.resolve()
      await returnConnection.promise
      return connection
    })
    const abort = new AbortController()
    const first = h.execute('session-1', 'cancelled', abort.signal)
    await issued.promise
    abort.abort(new Error('cancel during capability acquisition'))
    returnConnection.resolve()
    await first
    expect(h.requests).toHaveLength(0)
    await h.execute('session-1', 'successor')
    expect(h.requests).toHaveLength(1)
    expect(await h.authorityStatus(h.requests[0])).toBe(200)
  })

  it.each([false, true])(
    'keeps exact retired invocation image ownership through successor and shutdown=%s',
    async (shutdown) => {
      const completedIds: string[] = []
      const discarded = new Set<string>()
      const image = {
        data: Buffer.from('image').toString('base64'),
        mimeType: 'image/png' as const
      }
      const h = await harness({
        serverOptions: {
          hostViewImage: {
            isAvailable: async () => true,
            stage: async () => ({}) as never,
            complete: async (id) => {
              completedIds.push(id)
              return discarded.has(id) ? [] : [image]
            },
            discard: (id) => {
              discarded.add(id)
            },
            discardSession: () => undefined,
            shutdown: () => undefined
          }
        }
      })
      const intercepted = deferred()
      const completeFirst = deferred()
      let count = 0
      h.service.setControlCompletionInterceptor({
        intercept: async ({ execute }) => {
          const result = await execute()
          if (++count === 1) {
            intercepted.resolve()
            await completeFirst.promise
          }
          return { kind: 'deliver', result }
        }
      })
      const first = h.execute('session-1', 'first')
      await intercepted.promise
      await h.lifecycles[0].onTerminated('repl')
      await h.execute('session-1', 'second')
      if (shutdown) await h.service.shutdownAll()
      completeFirst.resolve()
      if (shutdown) {
        await expect(first).resolves.not.toHaveProperty('viewImages')
        expect(discarded).toContain(h.requests[0].runId)
      } else {
        await expect(first).resolves.toMatchObject({ viewImages: [image] })
        expect(discarded.size).toBe(0)
        expect(completedIds).toEqual([h.requests[1].runId, h.requests[0].runId])
      }
      expect(await h.authorityStatus(h.requests[0])).toBe(401)
      expect(await h.authorityStatus(h.requests[1])).toBe(shutdown ? 401 : 200)
    }
  )

  it.each(['terminated', 'idle'] as const)(
    'ignores an old process %s callback arriving after its successor starts',
    async (event) => {
      const h = await harness()
      await h.execute()
      const old = h.requests[0]
      await h.lifecycles[0].onTerminated('repl', undefined, undefined, old.kernelEpochId)
      await h.execute('session-1', 'successor')
      const successor = h.requests[1]
      if (event === 'terminated')
        await h.lifecycles[0].onTerminated('repl', undefined, undefined, old.kernelEpochId)
      else await h.lifecycles[0].onIdleShutdown('repl', undefined, old.kernelEpochId)
      expect(await h.authorityStatus(successor)).toBe(200)
      await h.execute('session-1', 'still successor')
      expect(h.requests[2].kernelEpochId).toBe(successor.kernelEpochId)
      expect(h.requests[2].mcpRpcToken).toBe(successor.mcpRpcToken)
      expect(await h.authorityStatus(old)).toBe(401)
    }
  )

  it('does not dispatch after a retired epoch capability resolver rejects late', async () => {
    const h = await harness()
    const started = deferred()
    const rejectConnection = deferred()
    h.service.setMcpRpcConnectionResolver(async () => {
      started.resolve()
      await rejectConnection.promise
      throw new Error('resolver unavailable')
    })
    const first = h.execute()
    await started.promise
    await h.lifecycles[0].onTerminated('repl')
    rejectConnection.resolve()
    await expect(first).resolves.toMatchObject({ status: 'failed' })
    expect(h.requests).toHaveLength(0)
  })

  it('does not let an old executor generation revoke its replacement REPL capability', async () => {
    const h = await harness()
    await h.execute()
    const old = h.requests[0]
    await h.service.restart({ sessionId: 'session-1', workspaceCwd: h.root })
    await h.execute('session-1', 'replacement')
    const replacement = h.requests[1]
    // Even a legacy injected callback without an epoch remains fenced by its executor generation.
    await h.lifecycles[0].onTerminated('repl')
    await h.lifecycles[0].onIdleShutdown('repl')
    expect(await h.authorityStatus(old)).toBe(401)
    expect(await h.authorityStatus(replacement)).toBe(200)
    await h.execute('session-1', 'reuse replacement')
    expect(h.requests[2].mcpRpcToken).toBe(replacement.mcpRpcToken)
  })
  it('discards retired output when shutdown races an already running image completion', async () => {
    const completing = deferred()
    const finishImage = deferred()
    const discarded: string[] = []
    const h = await harness({
      serverOptions: {
        hostViewImage: {
          isAvailable: async () => true,
          stage: async () => ({}) as never,
          complete: async () => {
            completing.resolve()
            await finishImage.promise
            return [
              { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' as const }
            ]
          },
          discard: (id) => {
            discarded.push(id)
          },
          discardSession: () => undefined,
          shutdown: () => undefined
        }
      }
    })
    const first = h.execute()
    await completing.promise
    await h.lifecycles[0].onTerminated('repl')
    await h.service.shutdownAll()
    finishImage.resolve()
    await expect(first).resolves.not.toHaveProperty('viewImages')
    expect(discarded).toEqual([h.requests[0].runId])
    expect(await h.authorityStatus(h.requests[0])).toBe(401)
  })
})

configureTestRuntimeMetadata()
