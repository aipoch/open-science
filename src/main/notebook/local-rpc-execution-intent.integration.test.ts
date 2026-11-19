import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import type { NotebookRpcConnection } from './mcp-server'
import type { MemoryPolicyObservation } from './memory-policy'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookExecutionIntent } from './execution-intent'

it('requires a new user intent after rejection and never lends it to an old RPC credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-execution-intent-'))
  let pressured = true
  const observation = (): MemoryPolicyObservation => ({
    status: pressured ? 'pressured' : 'healthy',
    reason: { code: pressured ? 'low-memory' : 'healthy' },
    source: 'test-policy',
    executionScope: 'test:host'
  })
  const sample = vi.fn(async () => observation())
  const execute = vi.fn(async () => ({
    status: 'completed' as const,
    stdout: 'ran',
    stderr: '',
    traceback: '',
    cwdAfter: root,
    outputs: [],
    kernelDispatched: true
  }))
  const rejected = vi.fn()
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { getState: sample, currentState: observation },
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
    callbacks: { onMemoryPolicyRejected: rejected }
  })
  const server = new NotebookLocalRpcServer(service, { transport: 'tcp' })
  const call = async (
    connection: NotebookRpcConnection,
    method: string,
    code = '1'
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method,
          params: {
            sessionId: 'forged-session',
            workspaceCwd: root,
            ...(method === 'state' ? {} : { code })
          }
        })
      },
      'Notebook execution intent integration'
    )
    return { status: response.status, body: await response.json() }
  }
  try {
    const intent = service.createExecutionIntent({ projectId: 'project', sessionId: 'session' })
    const old = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session',
      true,
      intent
    )
    const refusal = await call(old, 'executeControl')
    expect(JSON.stringify(refusal.body)).toContain('NOTEBOOK_MEMORY_PRESSURE')
    expect(execute).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ refusalId: expect.any(String) })
    pressured = false
    const samplesBeforeRetry = sample.mock.calls.length
    const repeat = await call(old, 'executeControl', 'differentCode()')
    expect(JSON.stringify(repeat.body)).toContain('NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION')
    expect(sample).toHaveBeenCalledTimes(samplesBeforeRetry)
    expect((await call(old, 'state')).status).toBe(200)

    const nextIntent = service.createExecutionIntent({ projectId: 'project', sessionId: 'session' })
    const fresh = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session',
      true,
      nextIntent
    )
    // The old callback starts only after the new credential exists, with the same input.
    expect((await call(old, 'executeControl')).status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
    const next = await call(fresh, 'executeControl')
    expect(next.body).toMatchObject({ result: { status: 'completed' } })
    expect(execute).toHaveBeenCalledTimes(1)
    // An automatic branch may mount an older stopped intent after another healthy user intent.
    // Reconnect retains the mounted context; it cannot borrow the most recently minted healthy one.
    await server.issueSessionConnection('session', 'project', 'root-frame-session', true, intent)
    const reconnected = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session'
    )
    expect(JSON.stringify((await call(reconnected, 'executeControl')).body)).toContain(
      'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
    )
  } finally {
    await server.close()
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('pins late control callbacks to their original invocation instead of lending the next intent', async () => {
  const dispatch = vi.fn(async (_request: unknown, context: unknown) => context)
  const server = new NotebookLocalRpcServer({} as never, {
    transport: 'tcp',
    agentsService: { read: dispatch }
  })
  const control = await server.issueControlConnection('session', 'project', 'frame')
  const oldIntent = new NotebookExecutionIntent({ projectId: 'project', sessionId: 'session' })
  const freshIntent = new NotebookExecutionIntent({ projectId: 'project', sessionId: 'session' })
  const old = control.beginControlInvocation(
    {
      turnId: 'old',
      toolInvocationId: 'old',
      controlInvocationGeneration: 1,
      originatingUserMessageId: 'user-old'
    },
    oldIntent
  )
  const fresh = control.beginControlInvocation(
    {
      turnId: 'fresh',
      toolInvocationId: 'fresh',
      controlInvocationGeneration: 2,
      originatingUserMessageId: 'user-fresh'
    },
    freshIntent
  )
  const call = async (
    nonce?: string,
    op = 'switch'
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchLocalRpc(
      control,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json',
          ...(nonce ? { 'x-open-science-control-invocation': nonce } : {})
        },
        body: JSON.stringify({
          method: 'agentsCall',
          params: { op, control_invocation_id: 'forged-fresh', turn_id: 'forged-fresh' }
        })
      },
      'control intent integration'
    )
    return { status: response.status, body: await response.json() }
  }
  try {
    expect(old.nonce).toEqual(expect.any(String))
    expect((await call(old.nonce)).body).toMatchObject({
      result: { turnId: 'old', toolInvocationId: 'old' }
    })
    oldIntent.block('memory-pressure')
    expect(JSON.stringify((await call(old.nonce)).body)).toContain(
      'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
    )
    expect((await call(fresh.nonce)).body).toMatchObject({ result: { turnId: 'fresh' } })
    expect((await call()).status).toBe(403)
    expect((await call(undefined, 'list')).status).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(3)

    old()
    fresh()
    let latest = fresh
    for (let index = 0; index < 1024; index++) {
      latest = control.beginControlInvocation(
        {
          turnId: `later-${index}`,
          toolInvocationId: `later-${index}`,
          controlInvocationGeneration: index + 3
        },
        freshIntent
      )
      latest()
    }
    // Retired callbacks cannot retain every old intent for the lifetime of a persistent REPL.
    // Expiry rejects an explicitly supplied stale nonce instead of using a newer invocation.
    expect((await call(old.nonce, 'list')).status).toBe(403)
    expect((await call(latest.nonce, 'list')).body).toMatchObject({
      result: { turnId: 'later-1023', toolInvocationId: 'later-1023' }
    })
  } finally {
    old()
    fresh()
    await server.close()
  }
})

it('rejects bootstrap execution authority and preserves inherited child authority across credential refresh and target-scope release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-child-intent-'))
  const execute = vi.fn(async () => ({
    status: 'completed' as const,
    stdout: 'child-result',
    stderr: '',
    traceback: '',
    cwdAfter: root,
    outputs: [],
    kernelDispatched: true
  }))
  const { healthyNotebookMemoryPolicy } = await import('./memory-policy.test-support')
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: healthyNotebookMemoryPolicy(),
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
  })
  const shutdown = vi.spyOn(service, 'shutdown')
  const server = new NotebookLocalRpcServer(service, { transport: 'tcp' })
  const call = async (
    connection: NotebookRpcConnection
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'executeControl',
          params: { sessionId: 'child-session', workspaceCwd: root, code: '1' }
        })
      },
      'child intent integration'
    )
    return { status: response.status, body: await response.json() }
  }
  let child: Awaited<ReturnType<typeof server.issueDelegatedNotebookConnection>> | undefined
  try {
    expect((await call(await server.ensureStarted())).status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
    const original = service.createExecutionIntent({
      projectId: 'project',
      sessionId: 'root-session'
    })
    await server.issueSessionConnection(
      'provisional-root',
      'project',
      'root-frame-provisional-root',
      true,
      original
    )
    server.registerSessionAlias('provisional-root', 'root-session')
    child = await server.issueDelegatedNotebookConnection({
      projectId: 'project',
      sessionId: 'child-session',
      rootFrameId: 'root',
      agentFrameId: 'child',
      attemptId: 'attempt',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'original-user',
      workspaceCwd: root,
      isAttemptWritable: () => true,
      executionIntent: original
    })
    expect(
      service.blockExecutionIntents({ projectId: 'project', sessionId: 'root-session' })
    ).toEqual([{ projectId: 'project', sessionId: 'root-session', refusalId: original.refusalId }])
    expect(JSON.stringify((await call(child)).body)).toContain(
      'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
    )
    const next = service.createExecutionIntent({ projectId: 'project', sessionId: 'root-session' })
    const fresh = await child.refreshExecutionIntent(next)
    expect((await call(child)).status).toBe(401)
    expect((await call(fresh)).body).toMatchObject({ result: { status: 'completed' } })
    expect(execute).toHaveBeenCalledOnce()
    // The actual target Session is an alias of this same root intent, not another grant.
    const continuations = service.blockExecutionIntents({
      projectId: 'project',
      sessionId: 'child-session'
    })
    expect(continuations).toEqual([
      { projectId: 'project', sessionId: 'root-session', refusalId: next.refusalId }
    ])
    expect(JSON.stringify((await call(fresh)).body)).toContain(
      'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
    )
    expect(next.refusalId).toEqual(expect.any(String))
    await child.revoke()
    await child.revoke()
    expect(shutdown).toHaveBeenCalledOnce()
  } finally {
    await child?.revoke()
    await server.close()
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
