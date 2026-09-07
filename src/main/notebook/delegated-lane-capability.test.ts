import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

let storageRoot: string | undefined

const request = (
  connection: { endpoint: string; socketPath?: string; token: string },
  method: string,
  params: Record<string, unknown>
): Promise<Response> =>
  fetchLocalRpc(
    connection,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method, params })
    },
    'Delegated Notebook capability test'
  )

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('delegated Notebook lane capability', () => {
  it('keeps child code reception alive until its own capability is revoked', async () => {
    const beginCodeCell = vi.fn(async (_request: unknown, signal?: AbortSignal) => ({
      cancelled: signal?.aborted
    }))
    const server = new NotebookLocalRpcServer({
      beginCodeCell,
      shutdown: vi.fn(async () => undefined)
    } as never)
    const child = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'child-frame',
      attemptId: 'child-attempt',
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'child-runtime',
      promptMessageId: 'child-prompt',
      workspaceCwd: '/workspace/child',
      isAttemptWritable: () => true
    })
    server.setArtifactTurnBinding('session-1', {
      projectId: 'project-1',
      ownerExecutionId: 'main-turn',
      provenanceContext: {
        rootFrameId: 'root-frame',
        agentFrameId: 'root-frame',
        messageBranchId: 'main-branch',
        runtimeSegmentId: 'main-runtime',
        promptMessageId: 'main-prompt'
      }
    })
    try {
      const response = await request(child, 'beginCodeCell', {})
      expect(response.status).toBe(200)
      await response.json()
      const signal = beginCodeCell.mock.calls[0]?.[1]
      expect(signal?.aborted).toBe(false)
      server.clearArtifactTurnBinding('session-1', 'main-turn')
      server.releaseSessionCapabilities('session-1')
      expect(signal?.aborted).toBe(false)
      await child.revoke()
      expect(signal?.aborted).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('binds child Help and parent messaging to the issued production capability identity', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-discovery-capability-'))
    const sendMessage = vi.fn(async () => ({
      request_id: 'request-1',
      message_id: 'message-1',
      source_frame_id: 'child-frame',
      target_frame_id: 'root-frame',
      queued_at: 1,
      same_request_safe: true as const,
      direction: 'to_parent' as const,
      disposition: 'message' as const,
      source_attempt_id: 'child-attempt',
      root_prompt_message_id: 'root-prompt',
      status: 'queued' as const,
      new_request_retry_safe: false as const
    }))
    const messageReceipt = vi.fn(async () => ({
      request_id: 'request-1',
      message_id: 'message-1',
      source_frame_id: 'child-frame',
      target_frame_id: 'root-frame',
      queued_at: 1,
      same_request_safe: true as const,
      direction: 'to_parent' as const,
      disposition: 'message' as const,
      source_attempt_id: 'child-attempt',
      root_prompt_message_id: 'root-prompt',
      status: 'queued' as const,
      new_request_retry_safe: false as const
    }))
    const children = vi.fn(async (caller: { role: string }) => {
      if (caller.role === 'delegate') throw new Error('authorization: root Main only')
      return []
    })
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => ({
        execute: async (input) => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: input.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service, {
      delegatedWorkService: {
        delegate: vi.fn(),
        children,
        stopChildren: vi.fn(),
        sendMessage,
        messageReceipt
      }
    })
    const child = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'child-frame',
      attemptId: 'child-attempt',
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'child-runtime',
      promptMessageId: 'child-prompt',
      workspaceCwd: '/workspace/child',
      isAttemptWritable: () => true
    })
    try {
      const catalog = await request(child, 'hostSdkHelp', { caller_role: 'main' })
      expect(catalog.status).toBe(200)
      await expect(catalog.json()).resolves.toMatchObject({
        result: {
          kind: 'catalog',
          topics: expect.arrayContaining([
            expect.objectContaining({ id: 'host.children' }),
            expect.objectContaining({ id: 'host.stopChild' }),
            expect.objectContaining({
              id: 'host.sendFrameMessage',
              availability: { status: 'available' }
            }),
            expect.objectContaining({
              id: 'host.messageReceipt',
              availability: { status: 'available' }
            })
          ])
        }
      })
      for (const topic of ['children', 'stopChild']) {
        const help = await request(child, 'hostSdkHelp', { query: topic, caller_role: 'main' })
        expect(help.status).toBe(200)
        await expect(help.json()).resolves.toMatchObject({
          result: {
            id: `host.${topic}`,
            availability: { status: 'unavailable' }
          }
        })
      }

      const sent = await request(child, 'delegatedWorkCall', {
        op: 'send_message',
        target: 'parent',
        message: 'Need the cohort definition',
        options: { request_id: 'request-1' },
        project_id: 'forged',
        session_id: 'forged',
        frame_id: 'forged',
        attempt_id: 'forged',
        origin_message_id: 'forged',
        tool_invocation_id: 'forged'
      })
      expect(sent.status).toBe(200)
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          session: { projectId: 'project-1', sessionId: 'session-1' },
          frameId: 'child-frame',
          attemptId: 'child-attempt',
          role: 'delegate',
          originMessageId: 'child-prompt',
          toolInvocationId: expect.stringMatching(/^delegated-notebook-capability:/)
        }),
        'parent',
        'Need the cohort definition',
        { requestId: 'request-1' }
      )

      const receipt = await request(child, 'delegatedWorkCall', {
        op: 'message_receipt',
        selector: 'message-1',
        options: { timeout_seconds: 0 }
      })
      expect(receipt.status).toBe(200)
      expect(messageReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          frameId: 'child-frame',
          attemptId: 'child-attempt',
          role: 'delegate'
        }),
        'message-1',
        { timeoutSeconds: 0 }
      )

      const rootOnly = await request(child, 'delegatedWorkCall', { op: 'children' })
      expect(rootOnly.status).toBe(500)
      await expect(rootOnly.json()).resolves.toMatchObject({
        error: expect.stringContaining('authorization: root Main only')
      })
      expect(children).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'delegate', frameId: 'child-frame' }),
        undefined
      )
    } finally {
      await server.close()
    }
  })

  it('binds submitOutput ownership to the child capability and fences revoked writes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-output-capability-'))
    const submitOutput = vi.fn(async () => ({ accepted: true as const }))
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => ({
        execute: async (input) => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: input.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'global-token',
      delegatedWorkService: { delegate: vi.fn(), submitOutput }
    })
    const child = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'child-frame',
      attemptId: 'child-attempt',
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'child-runtime',
      promptMessageId: 'child-prompt',
      workspaceCwd: '/workspace/child',
      isAttemptWritable: () => true
    })
    try {
      const globalForgery = await request(
        { endpoint: child.endpoint, socketPath: child.socketPath, token: 'global-token' },
        'delegatedOutputCall',
        {
          value: { answer: 0 },
          project_id: 'project-1',
          session_id: 'session-1',
          frame_id: 'child-frame',
          attempt_id: 'child-attempt',
          origin_message_id: 'child-prompt'
        }
      )
      expect(globalForgery.status).toBe(401)
      expect(submitOutput).not.toHaveBeenCalled()
      const response = await request(child, 'delegatedOutputCall', {
        value: { answer: 42 },
        project_id: 'forged',
        session_id: 'forged',
        frame_id: 'forged',
        attempt_id: 'forged'
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ result: { accepted: true } })
      expect(submitOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          session: { projectId: 'project-1', sessionId: 'session-1' },
          frameId: 'child-frame',
          attemptId: 'child-attempt',
          role: 'delegate'
        }),
        { answer: 42 }
      )
      await child.revoke()
      expect((await request(child, 'delegatedOutputCall', { value: null })).status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('binds sibling tokens to isolated Frame lanes and actual Run provenance', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-notebook-'))
    const invocationCounts = new WeakMap<object, number>()
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => {
        const executor = {
          async execute(input: { cwd: string }) {
            const count = (invocationCounts.get(executor) ?? 0) + 1
            invocationCounts.set(executor, count)
            return {
              status: 'completed' as const,
              stdout: `${count}\n`,
              stderr: '',
              traceback: '',
              cwdAfter: input.cwd,
              outputs: [],
              workingFiles: []
            }
          },
          shutdown: vi.fn(async () => ({ reaped: true }))
        }
        return executor
      }
    })
    const server = new NotebookLocalRpcServer(service)
    const childOne = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-one',
      attemptId: 'attempt-one',
      messageBranchId: 'branch-one',
      runtimeSegmentId: 'runtime-one',
      promptMessageId: 'message-one',
      workspaceCwd: '/workspace/one',
      isAttemptWritable: () => true
    })
    const childTwo = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-two',
      attemptId: 'attempt-two',
      messageBranchId: 'branch-two',
      runtimeSegmentId: 'runtime-two',
      promptMessageId: 'message-two',
      workspaceCwd: '/workspace/two',
      isAttemptWritable: () => true
    })
    expect(childOne.token).not.toBe(childTwo.token)

    try {
      const [one, two] = await Promise.all([
        request(childOne, 'execute', {
          sessionId: 'forged',
          projectId: 'forged',
          workspaceCwd: '/forged',
          code: 'producer = "one"'
        }),
        request(childTwo, 'execute', {
          sessionId: 'forged',
          projectId: 'forged',
          workspaceCwd: '/forged',
          code: 'producer = "two"'
        })
      ])
      expect(one.status).toBe(200)
      expect(two.status).toBe(200)
      const [onePayload, twoPayload] = (await Promise.all([one.json(), two.json()])) as Array<{
        result: { text: { stdout: string }; dataRoot: string }
      }>
      expect(onePayload).toMatchObject({ result: { text: { stdout: '1\n' } } })
      expect(twoPayload).toMatchObject({ result: { text: { stdout: '1\n' } } })
      expect(onePayload.result.dataRoot).toBe(
        join(storageRoot, 'notebooks', 'project-1', 'session-1', 'frames', 'frame-one', 'data')
      )
      expect(twoPayload.result.dataRoot).toBe(
        join(storageRoot, 'notebooks', 'project-1', 'session-1', 'frames', 'frame-two', 'data')
      )

      const runs = await new NotebookRunRepository(storageRoot).readSessionRuns(
        'project-1',
        'session-1'
      )
      expect(runs).toHaveLength(2)
      expect(
        runs.map(({ script, agentFrameId, runtimeSegmentId }) => ({
          script,
          agentFrameId,
          runtimeSegmentId
        }))
      ).toEqual(
        expect.arrayContaining([
          {
            script: 'producer = "one"',
            agentFrameId: 'frame-one',
            runtimeSegmentId: 'runtime-one'
          },
          {
            script: 'producer = "two"',
            agentFrameId: 'frame-two',
            runtimeSegmentId: 'runtime-two'
          }
        ])
      )
    } finally {
      await childOne.revoke()
      await childTwo.revoke()
      await server.close()
    }
  })

  it('fences stopped and superseded Attempts without revoking a sibling lane', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-notebook-fence-'))
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => ({
        execute: async (input) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: input.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service)
    let firstWritable = true
    const first = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-one',
      attemptId: 'attempt-one',
      messageBranchId: 'branch-one',
      runtimeSegmentId: 'runtime-one',
      promptMessageId: 'message-one',
      workspaceCwd: '/workspace/one',
      isAttemptWritable: () => firstWritable
    })
    const sibling = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-two',
      attemptId: 'attempt-two',
      messageBranchId: 'branch-two',
      runtimeSegmentId: 'runtime-two',
      promptMessageId: 'message-two',
      workspaceCwd: '/workspace/two',
      isAttemptWritable: () => true
    })

    try {
      firstWritable = false
      const stopped = await request(first, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'late = True'
      })
      expect(stopped.status).toBe(403)

      await first.revoke()
      const superseded = await request(first, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'later = True'
      })
      expect(superseded.status).toBe(401)

      const restarted = await server.issueDelegatedNotebookConnection({
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'frame-one',
        attemptId: 'attempt-one-restarted',
        messageBranchId: 'branch-one',
        runtimeSegmentId: 'runtime-one-restarted',
        promptMessageId: 'message-one-restarted',
        workspaceCwd: '/workspace/one',
        isAttemptWritable: () => true
      })
      const resumed = await request(restarted, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'resumed = True'
      })
      expect(resumed.status).toBe(200)
      await expect(resumed.json()).resolves.toMatchObject({ result: { text: { stdout: 'ok\n' } } })
      await restarted.revoke()

      const unaffected = await request(sibling, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/two',
        code: 'still_running = True'
      })
      expect(unaffected.status).toBe(200)
      const runs = await new NotebookRunRepository(storageRoot).readSessionRuns(
        'project-1',
        'session-1'
      )
      expect(runs.map((run) => [run.script, run.runtimeSegmentId])).toEqual(
        expect.arrayContaining([
          ['resumed = True', 'runtime-one-restarted'],
          ['still_running = True', 'runtime-two']
        ])
      )
    } finally {
      await sibling.revoke()
      await server.close()
    }
  })
})
