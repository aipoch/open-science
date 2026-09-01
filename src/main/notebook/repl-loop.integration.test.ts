import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { framePythonRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'
import { listenForLocalRpc } from '../local-rpc-transport'
import { hostSdkHelp } from '../host-sdk/help'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { AgentsService } from '../agents/agents-service'
import { createSpecialistService } from '../specialist/service'
import { createDeterministicDelegateExecution } from '../delegation/deterministic-execution'
import { createInMemoryDelegatedWorkRecords } from '../delegation/durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from '../delegation/durable-delegated-work-test-fixture'

// Run with: RUN_KERNEL=1 npx vitest run src/main/notebook/repl-loop.integration.test.ts
// Node is always available in vitest, so the only gate is RUN_KERNEL. The child is spawned exactly
// as the driver will spawn it: this process's executable with ELECTRON_RUN_AS_NODE=1 (harmless
// under plain node, makes the Electron binary behave as Node in production).
const gate = process.env.RUN_KERNEL ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

// Minimal one-shot client over the loop's JSON-lines stdio protocol, reusing the shared framing and
// parsing helpers so the test exercises the real wire format.
const startLoop = (
  env: NodeJS.ProcessEnv,
  inheritedRpcToken?: string
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
} => {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [LOOP], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    ...(inheritedRpcToken === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  })
  if (inheritedRpcToken !== undefined) {
    const tokenPipe = child.stdio[3]
    if (!tokenPipe || !('end' in tokenPipe)) throw new Error('RPC token pipe was not created')
    tokenPipe.end(inheritedRpcToken)
  }
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: KernelLoopResponse) => void>()
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonRequest(reqId, code))
    })
  return { child, send }
}

describe('repl_loop local RPC transport', () => {
  it('exposes only the camelCase public method names', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        "const c = host.compute.create('ssh:x'); " +
          'return JSON.stringify({' +
          "artifactPath: 'artifactPath' in host, artifact_path: 'artifact_path' in host, " +
          "viewImage: 'viewImage' in host, view_image: 'view_image' in host, " +
          "listSkills: 'listSkills' in host.agents, list_skills: 'list_skills' in host.agents, " +
          "listConnectors: 'listConnectors' in host.agents, list_connectors: 'list_connectors' in host.agents, " +
          "attachSkill: 'attachSkill' in host.agents, attach_skill: 'attach_skill' in host.agents, " +
          "detachSkill: 'detachSkill' in host.agents, detach_skill: 'detach_skill' in host.agents, " +
          "attachConnector: 'attachConnector' in host.agents, attach_connector: 'attach_connector' in host.agents, " +
          "detachConnector: 'detachConnector' in host.agents, detach_connector: 'detach_connector' in host.agents, " +
          "stopChild: 'stopChild' in host, stop_child: 'stop_child' in host, " +
          "sendFrameMessage: 'sendFrameMessage' in host, send_frame_message: 'send_frame_message' in host, " +
          "messageReceipt: 'messageReceipt' in host, message_receipt: 'message_receipt' in host, " +
          "resolveMessage: 'resolveMessage' in host, resolve_message: 'resolve_message' in host, " +
          "submitOutput: 'submitOutput' in host, submit_output: 'submit_output' in host, " +
          "listRegistered: 'listRegistered' in host.compute, listPreferred: 'listPreferred' in host.compute, " +
          "listEnabled: 'listEnabled' in host.compute, listCompute: 'listCompute' in host.compute, list_compute: 'list_compute' in host.compute, " +
          "callCommand: 'callCommand' in c, call_command: 'call_command' in c, " +
          "submitJob: 'submitJob' in c, submit_job: 'submit_job' in c, " +
          "attachJob: 'attachJob' in c, attach_job: 'attach_job' in c, " +
          "setConcurrencyLimit: 'setConcurrencyLimit' in c, set_concurrency_limit: 'set_concurrency_limit' in c" +
          '})'
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        artifactPath: true,
        artifact_path: false,
        viewImage: true,
        view_image: false,
        listSkills: true,
        list_skills: false,
        listConnectors: true,
        list_connectors: false,
        attachSkill: true,
        attach_skill: false,
        detachSkill: true,
        detach_skill: false,
        attachConnector: true,
        attach_connector: false,
        detachConnector: true,
        detach_connector: false,
        stopChild: true,
        stop_child: false,
        sendFrameMessage: true,
        send_frame_message: false,
        messageReceipt: true,
        message_receipt: false,
        resolveMessage: true,
        resolve_message: false,
        submitOutput: true,
        submit_output: false,
        listRegistered: true,
        listPreferred: true,
        listEnabled: false,
        listCompute: true,
        list_compute: false,
        callCommand: true,
        call_command: false,
        submitJob: true,
        submit_job: false,
        attachJob: true,
        attach_job: false,
        setConcurrencyLimit: true,
        set_concurrency_limit: false
      })
    } finally {
      child.kill()
    }
  })

  it('echoes a trailing expression when the call spans multiple lines', async () => {
    const { child, send } = startLoop({})

    try {
      const oneLine = await send("await Promise.resolve({ kind: 'ok' })")
      const multiLine = await send(['await Promise.resolve(', "  { kind: 'ok' }", ')'].join('\n'))

      expect(oneLine.error).toBeNull()
      expect(multiLine.error).toBeNull()
      expect(JSON.parse(oneLine.result ?? '{}')).toEqual({ kind: 'ok' })
      expect(JSON.parse(multiLine.result ?? '{}')).toEqual({ kind: 'ok' })
    } finally {
      child.kill()
    }
  })

  it('does not publish the pre-reliability send_message alias', async () => {
    const { child, send } = startLoop({})

    try {
      const result = await send(
        'return { current: typeof host.sendFrameMessage, legacy: typeof host.send_message }'
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        current: 'function',
        legacy: 'undefined'
      })
    } finally {
      child.kill()
    }
  })

  it('exposes host.help as a thin Host SDK help RPC adapter', async () => {
    let received: { method?: string; params?: Record<string, unknown> } = {}
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            result: {
              kind: 'operation',
              id: 'host.delegate',
              availability: { status: 'available' }
            }
          })
        )
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-host-sdk-help-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const result = await send("return await host.help('delegate')")
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        kind: 'operation',
        id: 'host.delegate',
        availability: { status: 'available' }
      })
      expect(received).toEqual({ method: 'hostSdkHelp', params: { query: 'delegate' } })
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('routes the reserved Windows RPC endpoint through the authenticated command gateway', async () => {
    let received:
      | {
          authorization?: string
          path?: string
          proxyAuthorization?: string
        }
      | undefined
    const proxy = createServer((request, response) => {
      received = {
        authorization: request.headers.authorization,
        path: request.url,
        proxyAuthorization: request.headers['proxy-authorization']
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          result: {
            kind: 'operation',
            id: 'host.delegate',
            availability: { status: 'available' }
          }
        })
      )
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address() as { port: number }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: 'http://open-science-notebook-rpc.invalid/',
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      HTTP_PROXY: `http://command:secret@127.0.0.1:${address.port}`
    })

    try {
      const result = await send("return await host.help('delegate')")
      expect(result.error).toBeNull()
      expect(received).toEqual({
        authorization: 'Bearer test-token',
        path: 'http://open-science-notebook-rpc.invalid/',
        proxyAuthorization: `Basic ${Buffer.from('command:secret').toString('base64')}`
      })
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('projects delegation name and Attempt agent name across help, delegate, children, and collect', async () => {
    const received: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const call = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        received.push(call)
        let result: unknown
        if (call.method === 'hostSdkHelp') {
          result = hostSdkHelp.query(call.params?.query, {
            callerRole: 'main',
            capabilities: {
              delegate: true,
              children: true,
              collect: true,
              stopChild: true,
              sendFrameMessage: true,
              messageReceipt: true,
              resolveMessage: true,
              submitOutput: true
            }
          })
        } else if (call.params?.op === 'children') {
          result = [
            {
              frameId: 'child-1',
              attemptId: 'attempt-1',
              title: 'Source trace',
              name: 'Source trace',
              agentName: 'Evidence Analyst',
              status: 'completed'
            }
          ]
        } else if (call.params?.op === 'collect') {
          result = [
            {
              frameId: 'child-1',
              attemptId: 'attempt-1',
              name: 'Source trace',
              agentName: 'Evidence Analyst',
              status: 'completed',
              response: 'Durable answer',
              artifactsCreated: []
            }
          ]
        } else {
          result = {
            kind: 'results',
            children: [
              {
                frameId: 'child-1',
                attemptId: 'attempt-1',
                name: 'Source trace',
                agentName: 'Evidence Analyst',
                status: 'completed',
                response: 'Durable answer',
                artifactsCreated: []
              }
            ]
          }
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegate-profile-projection-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const output = await send(
        "const help = await host.help('delegate'); const delegated = await host.delegate({ task: 'Trace sources', name: 'Source trace', profile: 'EVIDENCE_ANALYST' }); const children = await host.children(); const collected = await host.collect(['child-1']); return { profile_description: help.request.fields.find(({ name }) => name === 'profile').description, constraints: help.constraints, delegated, children, collected }"
      )
      expect(output.error).toBeNull()
      expect(JSON.parse(output.result ?? '{}')).toEqual({
        profile_description: 'Specialist id/name; omit to inherit the parent.',
        constraints: expect.arrayContaining([
          'Use host.agents.list() for profiles; omission inherits.'
        ]),
        delegated: {
          kind: 'results',
          children: [
            {
              frameId: 'child-1',
              attemptId: 'attempt-1',
              name: 'Source trace',
              agentName: 'Evidence Analyst',
              status: 'completed',
              response: 'Durable answer',
              artifactsCreated: []
            }
          ]
        },
        children: [
          {
            frameId: 'child-1',
            attemptId: 'attempt-1',
            title: 'Source trace',
            name: 'Source trace',
            agentName: 'Evidence Analyst',
            status: 'completed'
          }
        ],
        collected: [
          {
            frameId: 'child-1',
            attemptId: 'attempt-1',
            name: 'Source trace',
            agentName: 'Evidence Analyst',
            status: 'completed',
            response: 'Durable answer',
            artifactsCreated: []
          }
        ]
      })
      expect(received.map(({ method, params }) => [method, params?.op])).toEqual([
        ['hostSdkHelp', undefined],
        ['delegatedWorkCall', undefined],
        ['delegatedWorkCall', 'children'],
        ['delegatedWorkCall', 'collect']
      ])
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('discovers a public Specialist and delegates by its stable id and exact name through the authenticated REPL', async () => {
    const profileStorage = await mkdtemp(join(tmpdir(), 'repl-delegate-profile-roundtrip-'))
    const profiles = createSpecialistService(profileStorage)
    const selected = await profiles.create({
      name: 'EVIDENCE_ANALYST',
      displayName: 'Evidence Analyst'
    })
    const execution = createDeterministicDelegateExecution()
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: (profileId) => profiles.resolveRunnableById(profileId),
      resolveSpecialistReference: (reference) => profiles.resolveRunnableByReference(reference)
    })
    const agents = new AgentsService({
      specialistService: profiles,
      catalog: {
        listSkillCatalog: async () => [],
        getConnectors: async () => undefined
      }
    })
    const server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'pipe',
      agentsService: agents,
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'root-frame-1',
      { role: 'main' }
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: connection.token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: session.sessionId
    })

    try {
      const workflow =
        "const specialists = await host.agents.list(); const selected = specialists[0]; const byId = await host.delegate({ name: 'Stable id lookup', task: 'By stable id', profile: selected.id }, { wait: false }); const byName = await host.delegate({ name: 'Exact name lookup', task: 'By exact name', profile: selected.name }, { wait: false }); const main = await host.delegate({ name: 'Default Main lookup', task: 'Default Main' }, { wait: false }); return JSON.stringify({ selected: { id: selected.id, name: selected.name }, byId, byName, main })"
      const response = await send(workflow)
      expect(response.error).toBeNull()
      const result = JSON.parse(response.result ?? '{}')
      expect(result.selected).toEqual({ id: selected.id, name: selected.name })
      expect(result.byId.children[0]).toMatchObject({
        agentName: 'Evidence Analyst',
        status: 'running'
      })
      expect(result.byName.children[0]).toMatchObject({
        agentName: 'Evidence Analyst',
        status: 'running'
      })
      expect(result.main.children[0]).toMatchObject({
        agentName: 'Main Agent',
        status: 'running'
      })

      await expect.poll(() => execution.controls()).toHaveLength(3)
      expect(execution.controls().map(({ input }) => input.profile)).toEqual([
        selected.id,
        selected.id,
        undefined
      ])
      expect(
        (await records.snapshot()).records.map(({ attempts }) => attempts[0].resolvedAgent)
      ).toEqual([
        {
          kind: 'specialist',
          profileId: selected.id,
          revision: selected.revision,
          displayName: selected.displayName
        },
        {
          kind: 'specialist',
          profileId: selected.id,
          revision: selected.revision,
          displayName: selected.displayName
        },
        { kind: 'main' }
      ])

      const replay = await send(workflow)
      expect(replay.error).toBeNull()
      expect(JSON.parse(replay.result ?? '{}')).toEqual(result)
      expect(execution.controls()).toHaveLength(3)
      expect(execution.reservationCounts()).toEqual([1, 1, 1])
      expect((await records.snapshot()).records).toHaveLength(3)
    } finally {
      for (const control of execution.controls()) {
        control.accept()
        control.cancel()
      }
      child.kill()
      endInvocation()
      connection.release()
      await server.close()
      await rm(profileStorage, { recursive: true, force: true })
    }
  }, 60_000)

  it('exposes host.children and host.collect with snake-case durable projections', async () => {
    const received: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const call = JSON.parse(body)
        received.push(call)
        const result =
          call.params.op === undefined
            ? {
                kind: 'receipts',
                children: [
                  {
                    frameId: 'child-1',
                    attemptId: 'attempt-1',
                    name: 'Source trace',
                    agentName: 'Main Agent',
                    status: 'running'
                  }
                ]
              }
            : call.params.op === 'children'
              ? [
                  {
                    frameId: 'child-1',
                    attemptId: 'attempt-1',
                    title: 'Source trace',
                    status: 'running'
                  }
                ]
              : [
                  {
                    frameId: 'child-1',
                    attemptId: 'attempt-1',
                    status: 'completed',
                    terminalMessageId: 'message-1',
                    response: 'Durable answer',
                    artifactsCreated: []
                  },
                  {
                    frameId: 'child-2',
                    attemptId: 'attempt-2',
                    name: 'Long analysis',
                    agentName: 'Main Agent',
                    status: 'running'
                  }
                ]
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-work-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const firstCell = await send(
        "globalThis.pendingDelegation = await host.delegate({ task: 'Trace sources', name: 'Source trace', outputSchema: { type: 'object' } }, { wait: false }); return { delegated: globalThis.pendingDelegation, children: await host.children() }"
      )
      expect(firstCell.error).toBeNull()
      expect(JSON.parse(firstCell.result ?? '{}')).toEqual({
        delegated: {
          kind: 'receipts',
          children: [
            {
              frameId: 'child-1',
              attemptId: 'attempt-1',
              name: 'Source trace',
              agentName: 'Main Agent',
              status: 'running'
            }
          ]
        },
        children: [
          {
            frameId: 'child-1',
            attemptId: 'attempt-1',
            title: 'Source trace',
            status: 'running'
          }
        ]
      })
      const secondCell = await send(
        "return { results: await host.collect(globalThis.pendingDelegation.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })), { timeoutSeconds: 0, returnWhen: 'any' }) }"
      )
      expect(secondCell.error).toBeNull()
      expect(JSON.parse(secondCell.result ?? '{}')).toEqual({
        results: [
          {
            frameId: 'child-1',
            attemptId: 'attempt-1',
            status: 'completed',
            terminalMessageId: 'message-1',
            response: 'Durable answer',
            artifactsCreated: []
          },
          {
            frameId: 'child-2',
            attemptId: 'attempt-2',
            name: 'Long analysis',
            agentName: 'Main Agent',
            status: 'running'
          }
        ]
      })
      expect(received).toEqual([
        {
          method: 'delegatedWorkCall',
          params: {
            request: {
              task: 'Trace sources',
              name: 'Source trace',
              output_schema: { type: 'object' }
            },
            options: { wait: false },
            delegation_call_id: '1'
          }
        },
        { method: 'delegatedWorkCall', params: { op: 'children' } },
        {
          method: 'delegatedWorkCall',
          params: {
            op: 'collect',
            selectors: [{ frame_id: 'child-1', attempt_id: 'attempt-1' }],
            options: { timeout_seconds: 0, return_when: 'any' }
          }
        }
      ])
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('routes host.submitOutput through its dedicated child capability method', async () => {
    let received: { method?: string; params?: Record<string, unknown> } = {}
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received = JSON.parse(body)
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { accepted: true } }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-submit-output-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'child-token'
    })
    try {
      const result = await send('return await host.submitOutput({ answer: 42 })')
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({ accepted: true })
      expect(received).toEqual({
        method: 'delegatedOutputCall',
        params: { value: { answer: 42 } }
      })
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('routes host.sendFrameMessage options through delegated work and projects a continuation receipt', async () => {
    let received: { method?: string; params?: Record<string, unknown> } = {}
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            result: {
              direction: 'to_child',
              disposition: 'continued',
              status: 'queued',
              continuation_attempt_id: 'attempt-2'
            }
          })
        )
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-work-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const result = await send(
        "return JSON.stringify(await host.sendFrameMessage('child-frame', 'Check a counterexample', { kind: 'question', requestId: 'request-1', replyToMessageId: 'message-0' }))"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result as string)).toEqual({
        direction: 'to_child',
        disposition: 'continued',
        status: 'queued',
        continuationAttemptId: 'attempt-2'
      })
      expect(received).toEqual({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: 'child-frame',
          message: 'Check a counterexample',
          options: {
            kind: 'question',
            request_id: 'request-1',
            reply_to_message_id: 'message-0'
          }
        }
      })
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('keeps the two-argument host.sendFrameMessage call compatible', async () => {
    let received: { method?: string; params?: Record<string, unknown> } = {}
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            result: {
              direction: 'to_child',
              disposition: 'continued',
              status: 'queued',
              continuation_attempt_id: 'attempt-2'
            }
          })
        )
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-work-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const result = await send(
        "return JSON.stringify(await host.sendFrameMessage('child-frame', 'Check a counterexample'))"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result as string)).toEqual({
        direction: 'to_child',
        disposition: 'continued',
        status: 'queued',
        continuationAttemptId: 'attempt-2'
      })
      expect(received).toEqual({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: 'child-frame',
          message: 'Check a counterexample'
        }
      })
      expect(received.params).not.toHaveProperty('kind')
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('projects a Delegate-to-parent queued sendFrameMessage receipt without a child', async () => {
    let received: { method?: string; params?: Record<string, unknown> } = {}
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            result: {
              direction: 'to_parent',
              disposition: 'message',
              status: 'queued',
              message_id: 'message-1',
              target_frame_id: 'parent-frame',
              source_attempt_id: 'attempt-1'
            }
          })
        )
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-work-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const result = await send(
        "return JSON.stringify(await host.sendFrameMessage('parent', 'Which cohort?', { kind: 'question' }))"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result as string)).toEqual({
        direction: 'to_parent',
        disposition: 'message',
        status: 'queued',
        messageId: 'message-1',
        targetFrameId: 'parent-frame',
        sourceAttemptId: 'attempt-1'
      })
      expect(received).toEqual({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: 'parent',
          message: 'Which cohort?',
          options: { kind: 'question' }
        }
      })
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('remaps camelCase stop and message inputs onto the private delegated-work wire', async () => {
    const received: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const call = JSON.parse(body)
        received.push(call)
        const result =
          call.params.operation === 'stop_children'
            ? [{ frameId: 'child-frame', status: 'cancelled' }]
            : { status: 'accepted' }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-message-remap-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const result = await send(
        "return { stopped: await host.stopChild(['child-frame']), observed: await host.messageReceipt('request-1', { timeoutSeconds: 0 }), resolved: await host.resolveMessage('message-1', { action: 'acknowledge_uncertain' }) }"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        stopped: [{ frameId: 'child-frame', status: 'cancelled' }],
        observed: { status: 'accepted' },
        resolved: { status: 'accepted' }
      })
      expect(received).toEqual([
        {
          method: 'delegatedWorkCall',
          params: { operation: 'stop_children', frame_ids: ['child-frame'] }
        },
        {
          method: 'delegatedWorkCall',
          params: {
            op: 'message_receipt',
            selector: 'request-1',
            options: { timeout_seconds: 0 }
          }
        },
        {
          method: 'delegatedWorkCall',
          params: {
            op: 'resolve_message',
            message_id: 'message-1',
            action: 'acknowledge_uncertain'
          }
        }
      ])
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('rejects legacy and mixed-case delegated-work inputs before issuing RPC', async () => {
    let requestCount = 0
    const server = createServer((_request, response) => {
      requestCount += 1
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ result: {} }))
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-input-rejection-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const result = await send(
        "const capture = async (call) => { try { await call(); return null } catch (error) { return error.message } }; return await Promise.all([capture(() => host.delegate({ task: 'x', output_schema: {} })), capture(() => host.delegate({ task: 'x' }, { timeout_seconds: 0 })), capture(() => host.collect([{ frameId: 'f', attempt_id: 'a' }], { timeoutSeconds: 0 })), capture(() => host.sendFrameMessage('f', 'x', { requestId: 'r', request_id: 'r' })), capture(() => host.messageReceipt('r', { timeout_seconds: 0 })), capture(() => host.resolveMessage('m', { action: 'acknowledge_uncertain', message_id: 'm' }))])"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '[]')).toEqual([
        'host.delegate request unknown option: output_schema',
        'host.delegate options unknown option: timeout_seconds',
        'host.collect selector unknown option: attempt_id',
        'host.sendFrameMessage options unknown option: request_id',
        'host.messageReceipt options unknown option: timeout_seconds',
        'host.resolveMessage options unknown option: message_id'
      ])
      expect(requestCount).toBe(0)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('projects private delegation parser errors onto public camelCase names only', async () => {
    const privateErrors = [
      'host.delegate: options.timeout_seconds is invalid; error_code=timeout_seconds_invalid',
      'host.collect: selector invalid; use {frame_id, attempt_id}; code=selector_invalid',
      'host.message_receipt: message_receipt timeout_seconds is invalid; action=acknowledge_uncertain',
      'database unavailable; enum=acknowledge_uncertain; code=reply_to_message_id_invalid'
    ]
    let requestCount = 0
    const server = createServer((_request, response) => {
      const error = privateErrors[requestCount++]
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-delegated-error-projection-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const result = await send(
        "const capture = async (call) => { try { await call(); return null } catch (error) { return error.message } }; return [await capture(() => host.delegate({ task: 'x' }, { timeoutSeconds: 1801 })), await capture(() => host.collect([{ frameId: 'f', attemptId: 'a' }])), await capture(() => host.messageReceipt('request-1', { timeoutSeconds: 1801 })), await capture(() => host.sendFrameMessage('f', 'x'))]"
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '[]')).toEqual([
        'host.delegate: options.timeoutSeconds is invalid; error_code=timeout_seconds_invalid',
        'host.collect: selector invalid; use {frameId, attemptId}; code=selector_invalid',
        'host.messageReceipt: messageReceipt timeoutSeconds is invalid; action=acknowledge_uncertain',
        'host.sendFrameMessage: database unavailable; enum=acknowledge_uncertain; code=reply_to_message_id_invalid'
      ])
      expect(requestCount).toBe(4)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('routes host.mcp through the issued local socket', async () => {
    let received: { method?: string; params?: { server?: string } } = {}
    let authorization: string | undefined
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        authorization = request.headers.authorization
        received = JSON.parse(body)
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { ok: true } }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const result = await send("return await host.mcp('pubmed', 'search', { q: 'rna' })")
      expect(result.error).toBeNull()
      expect(result.result).toBe('{"ok":true}')
      expect(received).toMatchObject({
        method: 'mcpCall',
        params: { server: 'pubmed' }
      })
      expect(authorization).toBe('Bearer test-token')
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates, freezes, and refreshes host.capabilities projections', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        requests.push(JSON.parse(body))
        const result =
          requests.length === 3
            ? {
                mcp: true,
                compute: true,
                agents: true,
                skills: true,
                artifacts: true,
                lineage: true,
                frames: true,
                llm: true,
                viewImage: true,
                'not-valid': true
              }
            : requests.length === 4
              ? {
                  mcp: 'yes',
                  compute: true,
                  agents: true,
                  skills: true,
                  artifacts: true,
                  lineage: true,
                  frames: true,
                  llm: true,
                  viewImage: true
                }
              : requests.length === 2
                ? {
                    mcp: true,
                    compute: true,
                    agents: true,
                    skills: true,
                    artifacts: true,
                    lineage: true,
                    frames: true,
                    llm: true
                  }
                : {
                    mcp: true,
                    compute: true,
                    agents: true,
                    skills: true,
                    artifacts: true,
                    lineage: true,
                    frames: true,
                    llm: true,
                    viewImage: true,
                    experimentalFeature: true
                  }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-capabilities-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const projection = await send(
        'const first = await host.capabilities(); first.mcp = false; ' +
          'const second = await host.capabilities(); ' +
          'return JSON.stringify({ first, second, frozen: Object.isFrozen(first), same: first === second, ' +
          "missingKnownKey: Object.hasOwn(second, 'viewImage') })"
      )
      expect(projection.error).toBeNull()
      expect(JSON.parse(projection.result ?? '{}')).toEqual({
        first: {
          mcp: true,
          compute: true,
          agents: true,
          skills: true,
          artifacts: true,
          lineage: true,
          frames: true,
          llm: true,
          viewImage: true,
          experimentalFeature: true
        },
        second: {
          mcp: true,
          compute: true,
          agents: true,
          skills: true,
          artifacts: true,
          lineage: true,
          frames: true,
          llm: true
        },
        frozen: true,
        same: false,
        missingKnownKey: false
      })
      expect(requests).toEqual([
        { method: 'capabilitiesCall', params: {} },
        { method: 'capabilitiesCall', params: {} }
      ])

      const extraArgument = await send(
        "try { await host.capabilities('unexpected'); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(extraArgument.result).toBe('TypeError: host.capabilities accepts no arguments')
      expect(requests).toHaveLength(2)

      const invalidKey = await send(
        "try { await host.capabilities(); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidKey.result).toBe('host.capabilities returned an invalid capability projection')
      expect(requests).toHaveLength(3)

      const nonBoolean = await send(
        "try { await host.capabilities(); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(nonBoolean.result).toBe('host.capabilities returned an invalid capability projection')
      expect(requests).toHaveLength(4)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('forwards the exact host.viewImage camel-case contract and freezes validated metadata', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            result: {
              attached: true,
              sourceKind: 'workspacePath',
              originalSize: { width: 101, height: 51 },
              crop: { left: 10, top: 10, right: 81, bottom: 46 },
              outputSize: { width: 40, height: 20 },
              mimeType: 'image/png'
            }
          })
        )
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-view-image-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const response = await send(
        "const result = await host.viewImage({ path: 'results/image.png' }, { " +
          "crop: { unit: 'fraction', left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }, maxSize: 40 }); " +
          'return JSON.stringify({ result, frozen: Object.isFrozen(result), sizes: Object.isFrozen(result.originalSize) && Object.isFrozen(result.crop) && Object.isFrozen(result.outputSize) })'
      )
      expect(response.error).toBeNull()
      expect(JSON.parse(response.result ?? '{}')).toMatchObject({
        result: {
          attached: true,
          sourceKind: 'workspacePath',
          mimeType: 'image/png'
        },
        frozen: true,
        sizes: true
      })
      expect(requests).toEqual([
        {
          method: 'viewImageCall',
          params: {
            source: { path: 'results/image.png' },
            options: {
              crop: { unit: 'fraction', left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 },
              maxSize: 40
            }
          }
        }
      ])

      for (const code of [
        "await host.viewImage({ version_id: 'v1' })",
        "await host.viewImage({ path: 'image.png' }, { max_size: 10 })"
      ]) {
        const invalid = await send(
          `try { ${code}; return 'no error' } catch (error) { return error.message }`
        )
        expect(invalid.result).toMatch(/unknown option/u)
      }
      expect(requests).toHaveLength(1)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates, freezes, and freshly reads host.lineage graph and core provenance', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const graphResult = (versionId: string): Record<string, unknown> => ({
      project_id: 'project-a',
      root_version_id: versionId,
      direction: 'up',
      truncated: false,
      nodes: [
        {
          file_id: 'artifact-1',
          version_id: versionId,
          filename: 'result.csv',
          version_number: 1,
          session_id: 'session-other',
          root_frame_id: 'root-1',
          agent_frame_id: 'agent-1',
          created_at: '2026-08-01T00:00:00.000Z',
          content_type: 'text/csv',
          size_bytes: 12,
          checksum: 'a'.repeat(64),
          is_user_upload: false
        }
      ],
      edges: []
    })
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(parsed)
        const versionId = String(parsed.params?.version_id)
        let result: Record<string, unknown>
        if (parsed.params?.op === 'get') {
          const environment = {
            capture_kind: 'completed-run',
            environment_name: 'science',
            kernel_kind: 'python',
            runtime_source: 'managed',
            runtime_version: '3.13.5',
            platform: 'darwin',
            architecture: 'arm64',
            packages: [
              {
                name: 'numpy',
                version: '2.0.0',
                version_status: 'known',
                ecosystem: 'python',
                evidence_sources: ['python-importlib-metadata'],
                loaded_state: 'loaded',
                library_rank: 0,
                library_scope: 'environment',
                built_for_runtime: '3.13',
                priority: 'other',
                source: {
                  type: 'github',
                  repository: 'numpy/numpy',
                  ref: 'v2.0.0',
                  commit: 'abc123'
                }
              }
            ],
            python_version: '3.13.5',
            inventory_sources: ['kernel-native', 'operation-log'],
            installed_inventory: {
              captured_at: '2026-08-01T00:00:00.000Z',
              source: 'full-scan',
              validation: 'full-scan'
            },
            op_log: [
              {
                operation_id: 'operation-1',
                timestamp: '2026-08-01T00:00:00.000Z',
                operation: 'install',
                packages: ['numpy'],
                result: 'success',
                attempts: [
                  {
                    group_ordinal: 0,
                    installer: 'pip',
                    packages: ['numpy'],
                    status: 'succeeded',
                    mutation_risk: 'confirmed',
                    reason: 'unknown'
                  }
                ],
                fallback_used: false,
                inventory_refresh: 'published',
                inventory_refresh_attempts: [
                  {
                    attempt: 1,
                    trigger: 'terminal',
                    timestamp: '2026-08-01T00:00:01.000Z',
                    result: 'published'
                  }
                ],
                package_changes: [
                  {
                    name: 'numpy',
                    ecosystem: 'python',
                    relationship: 'requested',
                    change: 'installed',
                    after_version: '2.0.0',
                    library_rank: 0,
                    library_scope: 'environment',
                    source: {
                      type: 'github',
                      repository: 'numpy/numpy',
                      ref: 'v2.0.0',
                      commit: 'abc123'
                    }
                  }
                ]
              }
            ],
            op_log_truncation: {
              omitted_count: 2,
              earliest_retained_at: '2026-07-31T23:59:00.000Z'
            },
            captured_at: '2026-08-01T00:00:00.000Z',
            source_manifest_checksum: 'b'.repeat(64),
            complete: true,
            capture_status: 'complete',
            warnings: ['capture warning']
          }
          if (versionId === 'invalid-environment-reason') {
            environment.op_log[0].attempts[0].reason = 'secret-reason'
          }
          if (versionId === 'unknown-environment-key') {
            Object.assign(environment.packages[0], { storage_key: 'secret' })
          }
          if (versionId === 'invalid-environment-truncation') {
            environment.op_log_truncation.omitted_count = 0
          }
          result = {
            project_id: 'project-a',
            artifact_id: 'artifact-1',
            version_id: versionId,
            filename: 'result.csv',
            version_number: 1,
            session_id: 'session-other',
            root_frame_id: 'root-1',
            agent_frame_id: 'agent-1',
            message_branch_id: 'branch-1',
            runtime_segment_id: 'runtime-1',
            prompt_message_id: 'prompt-1',
            created_at: '2026-08-01T00:00:00.000Z',
            content_type: 'text/csv',
            size_bytes: 12,
            checksum: 'a'.repeat(64),
            content_status: { state: 'available' },
            reproduction_code: 'print(1)',
            execution_status: { state: 'available' },
            producer: {
              state: 'available',
              notebook_session_id: 'notebook-1',
              producer_run_id: 'run-1',
              run_index: 0,
              kernel_kind: 'python',
              association_method: 'agent-declared-and-session-validated',
              environment_manifest_checksum: 'b'.repeat(64)
            },
            environment_status: { state: 'available' },
            environment,
            inputs: []
          }
        } else {
          result = graphResult(versionId)
          if (versionId === 'invalid-v1') {
            result.nodes = [{ ...(result.nodes as object[])[0], storage_key: 'secret' }]
          }
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-lineage-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const projection = await send(
        "const first = await host.lineage.graph('artifact-v1', { direction: 'down', maxDepth: 0, maxNodes: 5 }); " +
          "const second = await host.lineage.graph('artifact-v1', { direction: 'down', maxDepth: 0, maxNodes: 5 }); " +
          "const core = await host.lineage.get('artifact-v1'); " +
          'return JSON.stringify({ firstFrozen: Object.isFrozen(first), ' +
          'nodesFrozen: Object.isFrozen(first.nodes), nodeFrozen: Object.isFrozen(first.nodes[0]), ' +
          'fresh: first !== second, coreFrozen: Object.isFrozen(core), ' +
          'inputsFrozen: Object.isFrozen(core.inputs), producerFrozen: Object.isFrozen(core.producer), ' +
          'environmentFrozen: Object.isFrozen(core.environment), ' +
          'packagesFrozen: Object.isFrozen(core.environment.packages), ' +
          'packageFrozen: Object.isFrozen(core.environment.packages[0]), ' +
          'packageSourceFrozen: Object.isFrozen(core.environment.packages[0].source), ' +
          'opLogFrozen: Object.isFrozen(core.environment.opLog), ' +
          'changeSourceFrozen: Object.isFrozen(core.environment.opLog[0].packageChanges[0].source), ' +
          'attemptFrozen: Object.isFrozen(core.environment.opLog[0].attempts[0]), ' +
          'returnFields: [first.rootVersionId, first.nodes[0].versionId, core.versionId] })'
      )
      expect(projection.error).toBeNull()
      expect(JSON.parse(projection.result ?? '{}')).toEqual({
        firstFrozen: true,
        nodesFrozen: true,
        nodeFrozen: true,
        fresh: true,
        coreFrozen: true,
        inputsFrozen: true,
        producerFrozen: true,
        environmentFrozen: true,
        packagesFrozen: true,
        packageFrozen: true,
        packageSourceFrozen: true,
        opLogFrozen: true,
        changeSourceFrozen: true,
        attemptFrozen: true,
        returnFields: ['artifact-v1', 'artifact-v1', 'artifact-v1']
      })
      expect(requests).toEqual([
        {
          method: 'lineageCall',
          params: {
            op: 'graph',
            version_id: 'artifact-v1',
            options: { direction: 'down', max_depth: 0, max_nodes: 5 }
          }
        },
        {
          method: 'lineageCall',
          params: {
            op: 'graph',
            version_id: 'artifact-v1',
            options: { direction: 'down', max_depth: 0, max_nodes: 5 }
          }
        },
        { method: 'lineageCall', params: { op: 'get', version_id: 'artifact-v1' } }
      ])

      const extraArgument = await send(
        "try { await host.lineage.get('artifact-v1', {}); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(extraArgument.result).toBe('TypeError: host.lineage.get accepts one versionId')
      expect(requests).toHaveLength(3)

      const oldOptions = await send(
        "const errors = []; for (const [key, value] of [['max_depth', 0], ['max_nodes', 5]]) { " +
          "try { await host.lineage.graph('artifact-v1', { [key]: value }) } " +
          "catch (error) { errors.push(error.name + ': ' + error.message) } } " +
          'return JSON.stringify(errors)'
      )
      expect(JSON.parse(oldOptions.result ?? '[]')).toEqual([
        'TypeError: host.lineage.graph options unknown option: max_depth',
        'TypeError: host.lineage.graph options unknown option: max_nodes'
      ])
      expect(requests).toHaveLength(3)

      const invalidProjection = await send(
        "try { await host.lineage.graph('invalid-v1'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidProjection.result).toBe('host.lineage.graph returned an invalid node')
      expect(requests).toHaveLength(4)

      const invalidEnvironmentReason = await send(
        "try { await host.lineage.get('invalid-environment-reason'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidEnvironmentReason.result).toBe(
        'host.lineage.get returned an invalid environment attempt'
      )
      expect(requests).toHaveLength(5)

      const unknownEnvironmentKey = await send(
        "try { await host.lineage.get('unknown-environment-key'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(unknownEnvironmentKey.result).toBe(
        'host.lineage.get returned an invalid environment package'
      )
      expect(requests).toHaveLength(6)

      const invalidEnvironmentTruncation = await send(
        "try { await host.lineage.get('invalid-environment-truncation'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidEnvironmentTruncation.result).toBe(
        'host.lineage.get returned an invalid operation-log truncation'
      )
      expect(requests).toHaveLength(7)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates and freezes Host model introspection results', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as { method?: string; params?: Record<string, unknown> }
        requests.push(parsed)
        const result = parsed.method === 'currentModelCall' ? 'model-b' : ['model-a', 'model-b']
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-host-model-introspection-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const result = await send(
        'const current = await host.currentModel(); const models = await host.listModels(); ' +
          'return JSON.stringify({ current, models, frozen: Object.isFrozen(models) })'
      )

      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        current: 'model-b',
        models: ['model-a', 'model-b'],
        frozen: true
      })
      expect(requests).toEqual([
        { method: 'currentModelCall', params: {} },
        { method: 'listModelsCall', params: {} }
      ])

      const extraCurrent = await send(
        "try { await host.currentModel('forged'); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(extraCurrent.result).toBe('TypeError: host.currentModel accepts no arguments')
      expect(requests).toHaveLength(2)

      const extraList = await send(
        "try { await host.listModels({ providerId: 'forged' }); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(extraList.result).toBe('TypeError: host.listModels accepts no arguments')
      expect(requests).toHaveLength(2)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('rejects malformed Host model introspection results', async () => {
    const results: unknown[] = [
      '',
      'provider-default',
      [],
      ['model-b', 'model-a'],
      ['model-a', 'model-a'],
      ['model-a', 42]
    ]
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: results.shift() }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-host-model-introspection-invalid-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      for (let index = 0; index < 2; index += 1) {
        const current = await send(
          "try { await host.currentModel(); return 'no error' } " +
            'catch (error) { return error.message }'
        )
        expect(current.result).toBe('host.currentModel returned an invalid model id')
      }

      for (let index = 0; index < 4; index += 1) {
        const models = await send(
          "try { await host.listModels(); return 'no error' } " +
            'catch (error) { return error.message }'
        )
        expect(models.result).toBe('host.listModels returned an invalid model catalog')
      }
      expect(results).toEqual([])
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates and deeply freezes host.llm single and batch results', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(parsed)
        const batchRequests = parsed.params?.requests
        const result = Array.isArray(batchRequests)
          ? batchRequests.map((request, index) =>
              request === null
                ? {
                    error:
                      'host.llm requests must be a prompt string or an exact { prompt } object.'
                  }
                : index === 1
                  ? { error: 'provider unavailable' }
                  : { text: 'A', model: 'model-a', stopReason: 'end_turn' }
            )
          : parsed.params?.request === 'INVALID_RESULT'
            ? { text: 'leak', model: 'model-a', stopReason: 'end_turn', raw: 'private' }
            : parsed.params?.request === 'LEGACY_RESULT'
              ? { text: 'legacy', model: 'model-a', stop_reason: 'end_turn' }
              : parsed.params?.request === 'LEGACY_USAGE'
                ? {
                    text: 'legacy',
                    model: 'model-a',
                    stopReason: 'end_turn',
                    usage: { input_tokens: 1, cache_tokens: 0, output_tokens: 1 }
                  }
                : parsed.params?.request === 'INVALID_USAGE'
                  ? {
                      text: 'leak',
                      model: 'model-a',
                      stopReason: 'end_turn',
                      usage: { inputTokens: 1, outputTokens: 1 }
                    }
                  : {
                      text: 'PONG',
                      model: 'model-a',
                      stopReason: 'end_turn',
                      usage: {
                        inputTokens: 10,
                        cacheTokens: 3,
                        outputTokens: 4,
                        cachedReadTokens: 2,
                        cachedWriteTokens: 1,
                        turnCount: 1
                      }
                    }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-host-llm-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const single = await send(
        "const value = await host.llm('PING'); " +
          'return JSON.stringify({ value, frozen: Object.isFrozen(value), usageFrozen: Object.isFrozen(value.usage) })'
      )
      expect(single.error).toBeNull()
      expect(JSON.parse(single.result ?? '{}')).toEqual({
        value: {
          text: 'PONG',
          model: 'model-a',
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            cacheTokens: 3,
            outputTokens: 4,
            cachedReadTokens: 2,
            cachedWriteTokens: 1,
            turnCount: 1
          }
        },
        frozen: true,
        usageFrozen: true
      })

      const batch = await send(
        "const value = await host.llm(['a', { prompt: 'b' }], { maxConcurrency: 2 }); " +
          'return JSON.stringify({ value, frozen: Object.isFrozen(value), itemFrozen: value.every(Object.isFrozen) })'
      )
      expect(batch.error).toBeNull()
      expect(JSON.parse(batch.result ?? '{}')).toEqual({
        value: [
          { text: 'A', model: 'model-a', stopReason: 'end_turn' },
          { error: 'provider unavailable' }
        ],
        frozen: true,
        itemFrozen: true
      })
      expect(requests).toEqual([
        { method: 'llmCall', params: { request: 'PING' } },
        {
          method: 'llmCall',
          params: { requests: ['a', { prompt: 'b' }], options: { max_concurrency: 2 } }
        }
      ])

      const invalidOptions = await send(
        "try { await host.llm('single', { maxConcurrency: 2 }); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(invalidOptions.result).toBe(
        'TypeError: host.llm options are only accepted for batch calls'
      )
      expect(requests).toHaveLength(2)

      const invalidSingle = await send(
        "try { await host.llm({ prompt: 'x', model: undefined }); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(invalidSingle.result).toBe(
        'TypeError: host.llm requests must be a prompt string or an exact { prompt } object.'
      )
      expect(requests).toHaveLength(2)

      const invalidBatchOptions = await send(
        "try { await host.llm(['x'], { maxConcurrency: 2, extra: undefined }); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(invalidBatchOptions.result).toBe(
        'TypeError: host.llm batch options unknown option: extra'
      )
      expect(requests).toHaveLength(2)

      const oldBatchOption = await send(
        "try { await host.llm(['x'], { max_concurrency: 2 }); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(oldBatchOption.result).toBe(
        'TypeError: host.llm batch options unknown option: max_concurrency'
      )
      expect(requests).toHaveLength(2)

      const isolatedInvalidItems = await send(
        "const cyclic = { prompt: 'bad' }; cyclic.extra = cyclic; " +
          "const value = await host.llm(['ok', 1n, cyclic]); return JSON.stringify(value)"
      )
      expect(isolatedInvalidItems.error).toBeNull()
      expect(JSON.parse(isolatedInvalidItems.result ?? '[]')).toEqual([
        { text: 'A', model: 'model-a', stopReason: 'end_turn' },
        { error: 'host.llm requests must be a prompt string or an exact { prompt } object.' },
        { error: 'host.llm requests must be a prompt string or an exact { prompt } object.' }
      ])
      expect(requests.at(-1)).toEqual({
        method: 'llmCall',
        params: { requests: ['ok', null, null] }
      })

      const snapshottedAccessor = await send(
        "let reads = 0; const item = { get prompt() { reads += 1; return reads === 1 ? 'snapshot' : 1n } }; " +
          'const value = await host.llm([item]); return JSON.stringify({ value, reads })'
      )
      expect(snapshottedAccessor.error).toBeNull()
      expect(JSON.parse(snapshottedAccessor.result ?? '{}')).toEqual({
        value: [{ text: 'A', model: 'model-a', stopReason: 'end_turn' }],
        reads: 1
      })
      expect(requests.at(-1)).toEqual({
        method: 'llmCall',
        params: { requests: [{ prompt: 'snapshot' }] }
      })

      const throwingOptionsAccessor = await send(
        "const options = {}; Object.defineProperty(options, 'maxConcurrency', { get() { throw new TypeError('unknown option: raw getter detail') } }); " +
          "try { await host.llm(['x'], options); return 'no error' } " +
          "catch (error) { return error.name + ': ' + error.message }"
      )
      expect(throwingOptionsAccessor.result).toBe(
        'TypeError: host.llm batch options only accept maxConcurrency.'
      )
      expect(requests).toHaveLength(4)

      const invalidResult = await send(
        "try { await host.llm('INVALID_RESULT'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidResult.result).toBe('host.llm returned an invalid result')

      const invalidUsage = await send(
        "try { await host.llm('INVALID_USAGE'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalidUsage.result).toBe('host.llm returned invalid usage')

      const legacyResult = await send(
        "try { await host.llm('LEGACY_RESULT'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(legacyResult.result).toBe('host.llm returned an invalid result')

      const legacyUsage = await send(
        "try { await host.llm('LEGACY_USAGE'); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(legacyUsage.result).toBe('host.llm returned invalid usage')
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates and freezes host.artifacts results and resolves host.artifactPath', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const managedPath = join(tmpdir(), 'managed', 'report.pdf')
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(parsed)
        const result =
          parsed.params?.op === 'path'
            ? managedPath
            : {
                count: 3,
                projectId: 'project-a',
                truncated: true,
                nextCursor: 'next-page',
                ignoredFutureField: 'not-public',
                artifacts: [
                  {
                    id: 'artifact-1',
                    filename: 'result.csv',
                    contentType: 'text/csv',
                    sizeBytes: 12,
                    latestVersionId: 'artifact-version-1',
                    checksum: 'a'.repeat(64),
                    projectId: 'project-a',
                    sessionId: 'session-a',
                    rootFrameId: 'root-1',
                    agentFrameId: 'frame-1',
                    isUserUpload: false,
                    createdAt: '2026-07-31T00:00:00.000Z',
                    latestVersionCreatedAt: '2026-08-01T00:00:00.000Z',
                    ignoredFutureField: 'not-public'
                  },
                  {
                    id: 'upload-1',
                    filename: 'report.pdf',
                    contentType: null,
                    sizeBytes: 24,
                    latestVersionId: 'upload-version-1',
                    checksum: null,
                    projectId: 'project-a',
                    sessionId: 'session-b',
                    rootFrameId: null,
                    agentFrameId: null,
                    isUserUpload: true,
                    createdAt: '2026-08-01T00:00:00.000Z',
                    latestVersionCreatedAt: '2026-08-02T00:00:00.000Z'
                  }
                ]
              }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-artifacts-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const projection = await send(
        "const page = await host.artifacts({ search: 'report', frameId: 'frame-1', contentType: 'text/csv', limit: 2 }); " +
          "await host.artifacts({ versionId: 'artifact-version-1' }); " +
          'const localPath = await host.artifactPath(page.artifacts[1].latestVersionId); ' +
          'return JSON.stringify({ page, localPath, pageFrozen: Object.isFrozen(page), ' +
          'artifactsFrozen: Object.isFrozen(page.artifacts), itemFrozen: Object.isFrozen(page.artifacts[0]) })'
      )
      expect(projection.error).toBeNull()
      const projected = JSON.parse(projection.result ?? '{}')
      expect(projected).toMatchObject({
        page: {
          count: 3,
          projectId: 'project-a',
          truncated: true,
          nextCursor: 'next-page'
        },
        localPath: managedPath,
        pageFrozen: true,
        artifactsFrozen: true,
        itemFrozen: true
      })
      expect(projected.page.artifacts[0].latestVersionId).toBe('artifact-version-1')
      expect(Object.keys(projected.page)).toEqual([
        'count',
        'projectId',
        'truncated',
        'nextCursor',
        'artifacts'
      ])
      expect(Object.keys(projected.page.artifacts[0])).toEqual([
        'id',
        'filename',
        'contentType',
        'sizeBytes',
        'latestVersionId',
        'checksum',
        'projectId',
        'sessionId',
        'rootFrameId',
        'agentFrameId',
        'isUserUpload',
        'createdAt',
        'latestVersionCreatedAt'
      ])
      expect(projected.page.artifacts[1]).toMatchObject({
        contentType: null,
        checksum: null,
        rootFrameId: null,
        agentFrameId: null
      })
      expect(requests).toEqual([
        {
          method: 'artifactsCall',
          params: {
            op: 'list',
            options: {
              search: 'report',
              frame_id: 'frame-1',
              content_type: 'text/csv',
              limit: 2
            }
          }
        },
        {
          method: 'artifactsCall',
          params: { op: 'list', options: { version_id: 'artifact-version-1' } }
        },
        { method: 'artifactsCall', params: { op: 'path', version_id: 'upload-version-1' } }
      ])

      const oldOptions = await send(
        "const errors = []; for (const [key, value] of [['sessionId', 'session-a'], ['version_id', 'artifact-version-1'], ['frame_id', 'frame-1'], ['session_id', 'session-a'], ['content_type', 'text/csv']]) { " +
          'try { await host.artifacts({ [key]: value }) } ' +
          "catch (error) { errors.push(error.name + ': ' + error.message) } } " +
          'return JSON.stringify(errors)'
      )
      expect(JSON.parse(oldOptions.result ?? '[]')).toEqual([
        'TypeError: host.artifacts options unknown option: sessionId',
        'TypeError: host.artifacts options unknown option: version_id',
        'TypeError: host.artifacts options unknown option: frame_id',
        'TypeError: host.artifacts options unknown option: session_id',
        'TypeError: host.artifacts options unknown option: content_type'
      ])
      expect(requests).toHaveLength(3)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates and freezes host.frames list and get projections', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const frame = {
      frame_id: 'frame-1',
      session_id: 'session-a',
      session_title: 'Research session',
      kind: 'root',
      recorded_frame_status: 'completed',
      session_status: 'idle',
      created_at: '2026-08-01T00:00:00.000Z',
      completed_at: '2026-08-01T00:01:00.000Z',
      session_updated_at: '2026-08-01T00:01:00.000Z',
      message_count: 2,
      child_count: 0
    }
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(parsed)
        const result =
          requests.length === 3
            ? { project_id: 'project-a', total_count: 0, frames: [], cwd: '/private' }
            : parsed.params?.op === 'get'
              ? {
                  project_id: 'project-a',
                  session: {
                    session_id: 'session-a',
                    session_title: 'Research session',
                    session_status: 'idle',
                    created_at: '2026-08-01T00:00:00.000Z',
                    updated_at: '2026-08-01T00:01:00.000Z'
                  },
                  frame,
                  branch: {
                    branch_id: 'branch-1',
                    created_at: '2026-08-01T00:00:00.000Z',
                    updated_at: '2026-08-01T00:01:00.000Z'
                  },
                  transcript: {
                    messages: [
                      {
                        message_id: 'message-1',
                        role: 'agent',
                        content: 'Visible answer',
                        status: 'complete',
                        runtime_segment_id: 'runtime-1',
                        created_at: '2026-08-01T00:00:30.000Z',
                        updated_at: '2026-08-01T00:01:00.000Z',
                        turn_usage: {
                          input_tokens: 10,
                          cache_tokens: 2,
                          output_tokens: 5
                        },
                        attachments: [
                          {
                            kind: 'artifact',
                            attachment_id: 'artifact-1',
                            version_id: 'artifact-version-1',
                            name: 'report.pdf',
                            mime_type: 'application/pdf',
                            size_bytes: 42
                          }
                        ]
                      }
                    ],
                    has_more_before: false
                  },
                  runtime_segments: [
                    {
                      runtime_segment_id: 'runtime-1',
                      agent_name: 'Research Agent',
                      started_at: '2026-08-01T00:00:00.000Z',
                      ended_at: '2026-08-01T00:01:00.000Z'
                    }
                  ]
                }
              : { project_id: 'project-a', total_count: 1, next_cursor: 'next', frames: [frame] }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-frames-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const projection = await send(
        "const page = await host.frames.list({ search: 'research', sessionId: 'session-a', rootsOnly: false }); " +
          "const detail = await host.frames.get('frame-1', { sessionId: 'session-a', branchId: 'branch-1' }); " +
          'return JSON.stringify({ page, detail, pageFrozen: Object.isFrozen(page), ' +
          'framesFrozen: Object.isFrozen(page.frames), frameFrozen: Object.isFrozen(page.frames[0]), ' +
          'detailFrozen: Object.isFrozen(detail), transcriptFrozen: Object.isFrozen(detail.transcript), ' +
          'sessionFrozen: Object.isFrozen(detail.session), detailFrameFrozen: Object.isFrozen(detail.frame), ' +
          'branchFrozen: Object.isFrozen(detail.branch), segmentsFrozen: Object.isFrozen(detail.runtimeSegments), ' +
          'segmentFrozen: Object.isFrozen(detail.runtimeSegments[0]), ' +
          'messagesFrozen: Object.isFrozen(detail.transcript.messages), ' +
          'messageFrozen: Object.isFrozen(detail.transcript.messages[0]), ' +
          'usageFrozen: Object.isFrozen(detail.transcript.messages[0].turnUsage), ' +
          'attachmentsFrozen: Object.isFrozen(detail.transcript.messages[0].attachments), ' +
          'attachmentFrozen: Object.isFrozen(detail.transcript.messages[0].attachments[0]) })'
      )
      expect(projection.error).toBeNull()
      expect(JSON.parse(projection.result ?? '{}')).toMatchObject({
        page: { projectId: 'project-a', totalCount: 1, nextCursor: 'next' },
        detail: { projectId: 'project-a', frame: { frameId: 'frame-1' } },
        pageFrozen: true,
        framesFrozen: true,
        frameFrozen: true,
        detailFrozen: true,
        transcriptFrozen: true,
        sessionFrozen: true,
        detailFrameFrozen: true,
        branchFrozen: true,
        segmentsFrozen: true,
        segmentFrozen: true,
        messagesFrozen: true,
        messageFrozen: true,
        usageFrozen: true,
        attachmentsFrozen: true,
        attachmentFrozen: true
      })
      expect(requests).toEqual([
        {
          method: 'framesCall',
          params: {
            op: 'list',
            options: { search: 'research', session_id: 'session-a', roots_only: false }
          }
        },
        {
          method: 'framesCall',
          params: {
            op: 'get',
            frame_id: 'frame-1',
            options: { session_id: 'session-a', branch_id: 'branch-1' }
          }
        }
      ])

      const oldOptions = await send(
        'const errors = []; for (const call of [' +
          "() => host.frames.list({ session_id: 'session-a' }), " +
          '() => host.frames.list({ roots_only: false }), ' +
          "() => host.frames.get('frame-1', { session_id: 'session-a' }), " +
          "() => host.frames.get('frame-1', { branch_id: 'branch-1' })]) { " +
          "try { await call() } catch (error) { errors.push(error.name + ': ' + error.message) } } " +
          'return JSON.stringify(errors)'
      )
      expect(JSON.parse(oldOptions.result ?? '[]')).toEqual([
        'TypeError: host.frames.list options unknown option: session_id',
        'TypeError: host.frames.list options unknown option: roots_only',
        'TypeError: host.frames.get options unknown option: session_id',
        'TypeError: host.frames.get options unknown option: branch_id'
      ])
      expect(requests).toHaveLength(2)

      const invalid = await send(
        "try { await host.frames.list(); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalid.result).toBe('host.frames.list returned an invalid result')
      expect(requests).toHaveLength(3)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('validates and freezes camelCase host.sessions list and inspect projections', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
    const session = {
      session_id: 'session-a',
      title: 'Research session',
      status: 'running',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:01:00.000Z',
      active_run_started_at: '2026-08-01T00:00:30.000Z',
      runtime: {
        attached: true,
        connection_status: 'connected',
        prompt_in_flight: true,
        agent_prompt_in_flight: true,
        permission_pending: false,
        user_input_pending: false
      },
      active_conversation: {
        frame_id: 'frame-1',
        branch_id: 'branch-1',
        message_count: 2
      },
      latest_observation: {
        timestamp: '2026-08-01T00:00:45.000Z',
        kind: 'tool',
        level: 'info',
        status: 'in_progress'
      }
    }
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(parsed)
        const result =
          requests.length === 3
            ? { total_count: 0, sessions: [], private_path: '/private' }
            : parsed.params?.op === 'inspect'
              ? session
              : { total_count: 1, next_cursor: 'next', sessions: [session] }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-sessions-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token'
    })

    try {
      const projection = await send(
        "const page = await host.sessions.list({ archived: 'include', search: 'research', limit: 2 }); " +
          "const detail = await host.sessions.inspect('session-a'); " +
          'return JSON.stringify({ page, detail, pageFrozen: Object.isFrozen(page), ' +
          'sessionsFrozen: Object.isFrozen(page.sessions), sessionFrozen: Object.isFrozen(page.sessions[0]), ' +
          'detailFrozen: Object.isFrozen(detail), runtimeFrozen: Object.isFrozen(detail.runtime), ' +
          'conversationFrozen: Object.isFrozen(detail.activeConversation), ' +
          'observationFrozen: Object.isFrozen(detail.latestObservation) })'
      )
      expect(projection.error).toBeNull()
      expect(JSON.parse(projection.result ?? '{}')).toMatchObject({
        page: {
          totalCount: 1,
          nextCursor: 'next',
          sessions: [{ sessionId: 'session-a', activeRunStartedAt: expect.any(String) }]
        },
        detail: {
          sessionId: 'session-a',
          runtime: { connectionStatus: 'connected', promptInFlight: true },
          activeConversation: { frameId: 'frame-1', branchId: 'branch-1', messageCount: 2 },
          latestObservation: { kind: 'tool', status: 'in_progress' }
        },
        pageFrozen: true,
        sessionsFrozen: true,
        sessionFrozen: true,
        detailFrozen: true,
        runtimeFrozen: true,
        conversationFrozen: true,
        observationFrozen: true
      })
      expect(requests).toEqual([
        {
          method: 'sessionsCall',
          params: {
            op: 'list',
            options: { archived: 'include', search: 'research', limit: 2 }
          }
        },
        {
          method: 'sessionsCall',
          params: { op: 'inspect', session_id: 'session-a' }
        }
      ])

      const oldOptions = await send(
        'const errors = []; for (const call of [' +
          "() => host.sessions.list({ projectId: 'project-a' }), " +
          "() => host.sessions.list({ project_id: 'project-a' }), " +
          "() => host.sessions.inspect('session-a', {})]) { " +
          "try { await call() } catch (error) { errors.push(error.name + ': ' + error.message) } } " +
          'return JSON.stringify(errors)'
      )
      expect(JSON.parse(oldOptions.result ?? '[]')).toEqual([
        'TypeError: host.sessions.list options unknown option: projectId',
        'TypeError: host.sessions.list options unknown option: project_id',
        'TypeError: host.sessions.inspect accepts one sessionId'
      ])
      expect(requests).toHaveLength(2)

      const invalid = await send(
        "try { await host.sessions.list(); return 'no error' } " +
          'catch (error) { return error.message }'
      )
      expect(invalid.result).toBe('host.sessions.list returned an invalid result')
      expect(requests).toHaveLength(3)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)

  it('routes host.skills through its native skillsCall method', async () => {
    const requests: { method?: string; params?: Record<string, unknown> }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const received = JSON.parse(body) as {
          method?: string
          params?: Record<string, unknown>
        }
        requests.push(received)
        const results: Record<string, unknown> = {
          list: [
            {
              id: 'personal:demo',
              name: 'demo',
              displayName: 'Demo',
              description: 'Demo Skill',
              origin: 'personal',
              editable: true
            }
          ],
          read: {
            name: 'demo',
            origin: 'draft',
            path: 'SKILL.md',
            content: '---\nname: demo\n---\nDemo\n',
            files: ['SKILL.md', 'references/guide.md']
          },
          validate: {
            valid: true,
            name: 'demo',
            origin: 'draft',
            errors: [],
            warnings: [{ code: 'missingResource', path: 'SKILL.md', message: 'Missing guide.md' }]
          },
          edit: { status: 'edited', name: 'demo', path: 'SKILL.md', origin: 'draft' },
          publish: { status: 'published', id: 'personal:demo', name: 'demo', origin: 'personal' },
          delete:
            received.params?.name === 'declined-demo'
              ? { status: 'declined', operation: 'delete' }
              : { status: 'deleted', operation: 'delete', name: 'demo' }
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: results[String(received.params?.op)] }))
      })
    })
    const connection = await listenForLocalRpc(server, {
      name: 'repl-loop-skills-test',
      transport: 'pipe'
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: connection.socketPath,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'test-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1'
    })

    try {
      const methods = await send('return Object.keys(host.skills).sort()')
      expect(JSON.parse(methods.result ?? '[]')).toEqual([
        'delete',
        'edit',
        'list',
        'publish',
        'read',
        'validate'
      ])

      const result = await send(
        'return JSON.stringify({' +
          'list: await host.skills.list(), ' +
          "read: await host.skills.read('demo'), " +
          "validate: await host.skills.validate('demo'), " +
          "edit: await host.skills.edit('demo', 'SKILL.md', 'new body', 'old body'), " +
          "publish: await host.skills.publish('demo', true), " +
          "deleted: await host.skills.delete('demo'), " +
          "declined: await host.skills.delete('declined-demo')" +
          '})'
      )
      expect(result.error).toBeNull()
      expect(JSON.parse(result.result ?? '{}')).toEqual({
        list: [
          {
            id: 'personal:demo',
            name: 'demo',
            displayName: 'Demo',
            description: 'Demo Skill',
            origin: 'personal',
            editable: true
          }
        ],
        read: {
          name: 'demo',
          origin: 'draft',
          path: 'SKILL.md',
          content: '---\nname: demo\n---\nDemo\n',
          files: ['SKILL.md', 'references/guide.md']
        },
        validate: {
          valid: true,
          name: 'demo',
          origin: 'draft',
          errors: [],
          warnings: [{ code: 'missingResource', path: 'SKILL.md', message: 'Missing guide.md' }]
        },
        edit: { status: 'edited', name: 'demo', path: 'SKILL.md', origin: 'draft' },
        publish: { status: 'published', id: 'personal:demo', name: 'demo', origin: 'personal' },
        deleted: { status: 'deleted', operation: 'delete', name: 'demo' },
        declined: { status: 'declined', operation: 'delete' }
      })
      expect(requests).toEqual([
        { method: 'skillsCall', params: { op: 'list', session_id: 'session-1' } },
        {
          method: 'skillsCall',
          params: { op: 'read', name: 'demo', path: 'SKILL.md', session_id: 'session-1' }
        },
        {
          method: 'skillsCall',
          params: { op: 'validate', name: 'demo', session_id: 'session-1' }
        },
        {
          method: 'skillsCall',
          params: {
            op: 'edit',
            name: 'demo',
            path: 'SKILL.md',
            content: 'new body',
            old_string: 'old body',
            session_id: 'session-1'
          }
        },
        {
          method: 'skillsCall',
          params: { op: 'publish', name: 'demo', overwrite: true, session_id: 'session-1' }
        },
        {
          method: 'skillsCall',
          params: { op: 'delete', name: 'demo', session_id: 'session-1' }
        },
        {
          method: 'skillsCall',
          params: { op: 'delete', name: 'declined-demo', session_id: 'session-1' }
        }
      ])
      expect(JSON.stringify(result)).not.toContain('old_string')
      expect(JSON.stringify(result)).not.toContain('body')

      const publicError = await send(
        "try { await host.skills.edit('demo', 'SKILL.md', 'new body', '') } " +
          'catch (error) { return error.message }'
      )
      expect(publicError.result).toBe(
        'host.skills.edit: oldString must be a non-empty string when provided'
      )
      expect(JSON.stringify(publicError)).not.toContain('old_string')
      expect(requests).toHaveLength(7)
    } finally {
      child.kill()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 60_000)
})

gate('repl_loop.js', () => {
  it('consumes the RPC token from fd 3 without leaving it in the environment', async () => {
    const token = 'fd-only-rpc-token'
    const { child, send } = startLoop({ OPEN_SCIENCE_MCP_RPC_TOKEN_FD: '3' }, token)
    try {
      const response = await send(
        `const fs = require('node:fs'); ` +
          `return { ` +
          `envTokenPresent: Object.hasOwn(process.env, 'OPEN_SCIENCE_MCP_RPC_TOKEN'), ` +
          `envFdPresent: Object.hasOwn(process.env, 'OPEN_SCIENCE_MCP_RPC_TOKEN_FD'), ` +
          `procContainsToken: process.platform === 'linux' && fs.readFileSync('/proc/self/environ').includes(${JSON.stringify(token)}) }`
      )
      expect(response.error).toBeNull()
      expect(JSON.parse(response.result ?? '{}')).toEqual({
        envTokenPresent: false,
        envFdPresent: false,
        procContainsToken: false
      })
    } finally {
      child.kill()
    }
  }, 60_000)

  it('captures console.log, keeps a persistent context, and survives a thrown error', async () => {
    const { child, send } = startLoop({})
    try {
      // console.log is captured into stdout.
      const a = await send("console.log('hi')")
      expect(a.error).toBeNull()
      expect(a.stdout).toContain('hi')

      // User-assigned globals persist across requests.
      const b = await send('globalThis.x = 41')
      expect(b.error).toBeNull()
      const c = await send('console.log(globalThis.x + 1)')
      expect(c.error).toBeNull()
      expect(c.stdout).toContain('42')

      // A thrown error is reported as a stack string, not a crash.
      const d = await send("throw new Error('boom')")
      expect(d.error).toContain('boom')

      // The loop survives the throw and keeps serving requests.
      const e = await send("console.log('still alive')")
      expect(e.error).toBeNull()
      expect(e.stdout).toContain('still alive')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks dynamically assembled child_process package commands at runtime', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const cp = require('node:child_process'); ` +
          `cp['ex' + 'ec']('p' + 'ip in' + 'stall pandas')`
      )
      expect(result.error).toMatch(/manage_packages/)

      const encoded = Buffer.from('pip install pandas', 'utf16le').toString('base64')
      const encodedResult = await send(
        `require('node:child_process').execFileSync('powershell.exe', ` +
          `${JSON.stringify(['-NoProfile', '-ec', encoded])})`
      )
      expect(encodedResult.error).toMatch(/manage_packages/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('allows dynamically assembled pip inspection commands at runtime', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `require('node:child_process')['spa' + 'wnSync'](` +
          `'python3', ['-m', 'p' + 'ip', 'li' + 'st', '--help']); 'allowed'`
      )
      expect(result.error).toBeNull()
      expect(result.result).toBe('allowed')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks child_process.fork from escaping the runtime guard', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const cp = require('node:child_process'); cp['fo' + 'rk']('untrusted-helper.js')`
      )
      expect(result.error).toMatch(/child_process\.fork is not allowed/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks Worker isolates that would reload unguarded built-in modules', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const { Worker } = require('node:worker_threads'); ` +
          `new Worker('require("node:fs").writeFileSync("escape.txt", "x")', { eval: true })`
      )
      expect(result.error).toMatch(/Worker is not allowed/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks child process payloads that write into the managed runtime', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-guard-'))
    const blockedPath = join(runtimeRoot, 'child-blocked.txt')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `require('node:child_process').execFileSync('/bin/sh', ` +
          `['-c', 'touch "$OPEN_SCIENCE_RUNTIME_DIR/child-blocked.txt"'])`
      )
      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    [
      'shell',
      '/bin/sh',
      ['-c', 'cd "$OPEN_SCIENCE_RUNTIME_DIR"; touch relative-shell.txt'],
      'relative-shell.txt'
    ],
    [
      'PowerShell',
      'powershell.exe',
      [
        '-NoProfile',
        '-c',
        'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; Set-Content relative-powershell.txt x'
      ],
      'relative-powershell.txt'
    ],
    [
      'shell from a runtime subdirectory',
      '/bin/sh',
      ['-c', 'cd "$OPEN_SCIENCE_RUNTIME_DIR/subdir"; cd ..; touch relative-shell-subdir.txt'],
      'relative-shell-subdir.txt'
    ],
    [
      'PowerShell from a runtime subdirectory',
      'powershell.exe',
      [
        '-NoProfile',
        '-c',
        'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR\\subdir; Set-Location ..; Set-Content relative-powershell-subdir.txt x'
      ],
      'relative-powershell-subdir.txt'
    ]
  ] as const)(
    'blocks %s child-process writes after entering the managed runtime',
    async (_name, command, args, relativeTarget) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-cwd-'))
      await mkdir(join(runtimeRoot, 'subdir'))
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const result = await send(
          `require('node:child_process').execFileSync(${JSON.stringify(command)}, ` +
            `${JSON.stringify(args)})`
        )
        expect(result.error).toMatch(/manage_packages/)
        expect(existsSync(join(runtimeRoot, relativeTarget))).toBe(false)
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('allows child process payloads that only read the runtime and write elsewhere', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-read-'))
    const workspace = await mkdtemp(join(tmpdir(), 'os-repl-child-output-'))
    const source = join(runtimeRoot, 'source.txt')
    const copied = join(workspace, 'copied.txt')
    const report = join(workspace, 'report.txt')
    await writeFile(source, 'runtime input')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const payload = [
        `const fs = require('node:fs')`,
        `console.log(process.env.OPEN_SCIENCE_RUNTIME_DIR)`,
        `fs.copyFileSync(${JSON.stringify(source)}, ${JSON.stringify(copied)})`,
        `fs.writeFileSync(${JSON.stringify(report)}, 'workspace output')`
      ].join('; ')
      const result = await send(
        `require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(payload)}])`
      )

      expect(result.error).toBeNull()
      expect(await readFile(copied, 'utf8')).toBe('runtime input')
      expect(await readFile(report, 'utf8')).toBe('workspace output')

      if (process.platform !== 'win32') {
        const shellCopy = join(workspace, 'shell-copy.txt')
        const shellReport = join(workspace, 'shell-report.txt')
        const shellPayload =
          `cp "$OPEN_SCIENCE_RUNTIME_DIR/source.txt" ${JSON.stringify(shellCopy)}; ` +
          `printf '%s' "$OPEN_SCIENCE_RUNTIME_DIR" > /dev/null; ` +
          `cd "$OPEN_SCIENCE_RUNTIME_DIR"; ` +
          `touch ${JSON.stringify(shellReport)}`
        const shellResult = await send(
          `require('node:child_process').execFileSync('/bin/sh', ['-c', ${JSON.stringify(shellPayload)}])`
        )
        expect(shellResult.error).toBeNull()
        expect(await readFile(shellCopy, 'utf8')).toBe('runtime input')
        expect(existsSync(shellReport)).toBe(true)
      }
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it('uses PowerShell write targets instead of blocking every runtime-path mention', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-powershell-targets-'))
    const workspace = await mkdtemp(join(tmpdir(), 'os-repl-powershell-output-'))
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const allowedPayload =
        `Copy-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\source.txt" ${JSON.stringify(join(workspace, 'report.txt'))}; ` +
        `Write-Output $env:OPEN_SCIENCE_RUNTIME_DIR; ` +
        `Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; ` +
        `New-Item ${JSON.stringify(join(workspace, 'report-created.txt'))}`
      const allowed = await send(
        `try { require('node:child_process').execFileSync('powershell.exe', ` +
          `['-NoProfile', '-Command', ${JSON.stringify(allowedPayload)}]) } ` +
          `catch (error) { if (String(error).includes('manage_packages')) throw error }; 'allowed'`
      )
      expect(allowed.error).toBeNull()
      expect(allowed.result).toBe('allowed')

      const blocked = await send(
        `require('node:child_process').execFileSync('powershell.exe', ` +
          `['-NoProfile', '-Command', ` +
          `${JSON.stringify(`Set-Content "$env:OPEN_SCIENCE_RUNTIME_DIR\\blocked.txt" x`)}])`
      )
      expect(blocked.error).toMatch(/manage_packages/)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['sync', 'promise'] as const)(
    'blocks %s hard-link aliases sourced from the managed runtime',
    async (variant) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-hard-link-runtime-'))
      const workspace = await mkdtemp(join(tmpdir(), 'os-repl-hard-link-output-'))
      const source = join(runtimeRoot, 'protected.txt')
      const alias = join(workspace, 'alias.txt')
      await writeFile(source, 'protected')
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const operation =
          variant === 'sync'
            ? `fs.linkSync(${JSON.stringify(source)}, ${JSON.stringify(alias)}); fs.writeFileSync(${JSON.stringify(alias)}, 'changed')`
            : `await fs.promises.link(${JSON.stringify(source)}, ${JSON.stringify(alias)}); await fs.promises.writeFile(${JSON.stringify(alias)}, 'changed')`
        const result = await send(`const fs = require('node:fs'); ${operation}`)

        expect(result.error).toMatch(/manage_packages/)
        expect(await readFile(source, 'utf8')).toBe('protected')
        expect(existsSync(alias)).toBe(false)
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
        await rm(workspace, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('blocks symlink aliases sourced from the managed runtime', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'os-repl-symlink-'))
    const runtimeRoot = join(parent, 'runtime')
    const workspace = join(parent, 'workspace')
    await mkdir(runtimeRoot)
    await mkdir(workspace)
    const source = join(runtimeRoot, 'protected.txt')
    const alias = join(workspace, 'alias.txt')
    const relativeSource = relative(workspace, source)
    await writeFile(source, 'protected')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `require('node:fs').symlinkSync(${JSON.stringify(relativeSource)}, ${JSON.stringify(alias)})`
      )

      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(alias)).toBe(false)
    } finally {
      child.kill()
      await rm(parent, { recursive: true, force: true })
    }
  }, 60_000)

  it('blocks managed-runtime writes routed through a temporary variable', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-runtime-guard-'))
    const blockedPath = join(runtimeRoot, 'blocked.txt')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `const target = process.env.OPEN_SCIENCE_RUNTIME_DIR + '/blocked.txt'; ` +
          `require('node:fs').writeFileSync(target, 'changed')`
      )
      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    `require('node:fs').mkdtempSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + '/sync-')`,
    `await require('node:fs').promises.mkdtemp(process.env.OPEN_SCIENCE_RUNTIME_DIR + '/promise-')`,
    `await new Promise((resolve, reject) => require('node:fs').mkdtemp(` +
      `process.env.OPEN_SCIENCE_RUNTIME_DIR + '/callback-', ` +
      `(error, value) => error ? reject(error) : resolve(value)))`
  ])(
    'blocks managed-runtime temporary directory creation at runtime',
    async (source) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-mkdtemp-guard-'))
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const result = await send(source)
        expect(result.error).toMatch(/manage_packages/)
        expect(await readdir(runtimeRoot)).toEqual([])
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
})

gate('repl_loop.js host.compute', () => {
  let server: Server
  let endpoint: string
  // Last computeCall params the stub received, so tests can assert the JS shim's wire payload.
  let received: { method?: string; params?: Record<string, unknown> } = {}
  // Next response the stub returns: { status, body } lets a case drive success and structured-error paths.
  let next: { status: number; body: unknown } = { status: 200, body: { result: null } }

  beforeAll(async () => {
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = body ? JSON.parse(body) : {}
        res
          .writeHead(next.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(next.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    endpoint = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('host.compute.list() posts op=list and returns the parsed result', async () => {
    next = {
      status: 200,
      body: { result: [{ provider_id: 'ssh:biowulf', display_name: 'biowulf' }] }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send('return (await host.compute.list())[0].provider_id')
      expect(r.error).toBeNull()
      expect(r.result).toContain('ssh:biowulf')
      expect(received.method).toBe('computeCall')
      expect(received.params?.op).toBe('list')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('maps canonical and compatibility discovery methods to their operations', async () => {
    next = {
      status: 200,
      body: { result: [{ provider_id: 'ssh:biowulf', display_name: 'biowulf' }] }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const hosts = await send('return (await host.compute.listHosts())[0].provider_id')
      expect(hosts.error).toBeNull()
      expect(received.params?.op).toBe('list_hosts')
      expect(received.params?.session_id).toBe('session-42')

      const registered = await send('return (await host.compute.listRegistered())[0].provider_id')
      expect(registered.error).toBeNull()
      expect(received.params?.op).toBe('list_registered')

      const preferred = await send('return (await host.compute.listPreferred())[0].provider_id')
      expect(preferred.error).toBeNull()
      expect(received.params?.op).toBe('list_preferred')
      expect(received.params?.session_id).toBe('session-42')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().callCommand() posts op=call_command with defaults and returns the ExecResult', async () => {
    next = {
      status: 200,
      body: { result: { exit_code: 0, stdout: 'hi', stderr: '', truncated: false } }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); const res = await c.callCommand('echo hi', 'probe'); return res.stdout"
      )
      expect(r.error).toBeNull()
      expect(r.result).toContain('hi')
      expect(received.params?.op).toBe('call_command')
      expect(received.params?.provider_id).toBe('ssh:biowulf')
      expect(received.params?.cmd).toBe('echo hi')
      expect(received.params?.intent).toBe('probe')
      // Public loginShell defaults to true; omitted timeoutSeconds stays omitted on the wire.
      expect(received.params?.login_shell).toBe(true)
      expect(received.params?.timeout_seconds).toBeUndefined()
    } finally {
      child.kill()
    }
  }, 60_000)

  it('maps a structured compute error onto the thrown Error (error_code / retry_after_user_action)', async () => {
    // The RPC layer re-serializes ComputeService's structured error as a JSON string in `error`.
    next = {
      status: 500,
      body: {
        error: JSON.stringify({
          error_code: 'host_unreachable',
          message: 'SSH connect failed',
          retry_after_user_action: true
        })
      }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:x');\n" +
          'try { await c.callCommand("id", "probe") }\n' +
          'catch (e) { return JSON.stringify({ code: e.error_code, retry: e.retry_after_user_action, msg: e.message }) }'
      )
      expect(r.error).toBeNull()
      const parsed = JSON.parse(r.result ?? '')
      expect(parsed.code).toBe('host_unreachable')
      expect(parsed.retry).toBe(true)
      expect(parsed.msg).toContain('SSH connect failed')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('details() maps public oldText to wire old_text and returns the result', async () => {
    next = { status: 200, body: { result: { doc: 'the doc', isSkeleton: false } } }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      // read: only mode is forwarded.
      const read = await send(
        "return (await host.compute.details('ssh:biowulf', { mode: 'read' })).doc"
      )
      expect(read.error).toBeNull()
      expect(read.result).toContain('the doc')
      expect(received.params?.op).toBe('details')
      expect(received.params?.provider_id).toBe('ssh:biowulf')
      expect(received.params?.mode).toBe('read')

      // Public oldText maps immediately to the unchanged snake_case RPC field.
      next = { status: 200, body: { result: { ok: true } } }
      const replace = await send(
        "await host.compute.details('ssh:biowulf', { mode: 'replace', text: 'new', oldText: 'old' }); return 'done'"
      )
      expect(replace.error).toBeNull()
      expect(received.params?.mode).toBe('replace')
      expect(received.params?.text).toBe('new')
      expect(received.params?.old_text).toBe('old')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('threads session/project identity from the spawn env into the callCommand payload', async () => {
    next = {
      status: 200,
      body: { result: { exit_code: 0, stdout: '', stderr: '', truncated: false } }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42',
      OPEN_SCIENCE_NOTEBOOK_PROJECT_ID: 'my-project'
    })
    try {
      const r = await send(
        "await host.compute.create('ssh:biowulf').callCommand('id', 'probe'); return 'ok'"
      )
      expect(r.error).toBeNull()
      expect(received.params?.session_id).toBe('session-42')
      expect(received.params?.project_id).toBe('my-project')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('normalizes and removes legacy session/project identity from process.env', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42',
      OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME: 'my-project'
    })
    try {
      const r = await send(
        'return JSON.stringify([process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID, process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_ID, process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME])'
      )
      expect(r.error).toBeNull()
      expect(JSON.parse(r.result ?? '')).toEqual([null, null, null])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().setConcurrencyLimit(k) posts op=set_concurrency_limit with session_id and limit', async () => {
    next = { status: 200, body: { result: null } }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); await c.setConcurrencyLimit(5); return 'ok'"
      )
      expect(r.error).toBeNull()
      expect(r.result).toContain('ok')
      expect(received.params?.op).toBe('set_concurrency_limit')
      expect(received.params?.session_id).toBe('session-42')
      expect(received.params?.limit).toBe(5)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().setConcurrencyLimit() validates that k is a positive integer', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      // Negative number should throw
      const r1 = await send(
        "const c = host.compute.create('ssh:biowulf'); try { await c.setConcurrencyLimit(-1); return 'bad' } catch (e) { return e.message }"
      )
      expect(r1.result).toContain('positive integer')

      // Zero should throw
      const r2 = await send(
        "const c2 = host.compute.create('ssh:biowulf'); try { await c2.setConcurrencyLimit(0); return 'bad' } catch (e) { return e.message }"
      )
      expect(r2.result).toContain('positive integer')

      // Float should throw
      const r3 = await send(
        "const c3 = host.compute.create('ssh:biowulf'); try { await c3.setConcurrencyLimit(2.5); return 'bad' } catch (e) { return e.message }"
      )
      expect(r3.result).toContain('positive integer')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().status() posts op=concurrency_status and returns session status dict', async () => {
    next = {
      status: 200,
      body: {
        result: {
          session_limit: 10,
          active_count: 3,
          queued_count: 1,
          provider_ceilings: { 'ssh:biowulf': 50, 'ssh:cluster-a': 10 }
        }
      }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); const s = await c.status(); return JSON.stringify(s)"
      )
      expect(r.error).toBeNull()
      const parsed = JSON.parse(r.result ?? '')
      expect(parsed.session_limit).toBe(10)
      expect(parsed.active_count).toBe(3)
      expect(parsed.queued_count).toBe(1)
      expect(parsed.provider_ceilings).toEqual({ 'ssh:biowulf': 50, 'ssh:cluster-a': 10 })
      expect(received.params?.op).toBe('concurrency_status')
      expect(received.params?.session_id).toBe('session-42')
    } finally {
      child.kill()
    }
  }, 60_000)
})

gate('repl_loop.js host.mcp', () => {
  let server: Server
  let endpoint: string

  beforeAll(async () => {
    // Minimal stub RPC endpoint returning a fixed dict for any mcpCall, mirroring
    // host-mcp.integration.test.ts's stub.
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { ok: true } }))
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    endpoint = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('runs top-level await host.mcp and returns the stub result', async () => {
    const token = 'tok'
    const { child, send } = startLoop(
      {
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
        OPEN_SCIENCE_MCP_RPC_TOKEN_FD: '3'
      },
      token
    )
    try {
      const r = await send("return await host.mcp('chemistry', 'm', { cids: [1] })")
      expect(r.error).toBeNull()
      expect(r.result).toContain('true')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('echoes a trailing bare expression like a REPL (no explicit return needed)', async () => {
    const { child, send } = startLoop({})
    try {
      // Trailing expression on its own line after other statements (the common agent pattern).
      const a = await send('const r = { hits: 3 };\nglobalThis.saved = r;\nr;')
      expect(a.error).toBeNull()
      expect(a.result).toBe('{"hits":3}')

      // Also on a single line with ';'-separated statements, and with top-level await.
      const b = await send('const x = await Promise.resolve(41); x + 1')
      expect(b.result).toBe('42')

      // A statement/declaration tail is not echoed and must not error (safe fallback).
      const c = await send('let z = 5;')
      expect(c.error).toBeNull()
      expect(c.result).toBeNull()

      // JSON.stringify returns undefined for these values without throwing. They remain an absent
      // REPL echo instead of being coerced into a fabricated literal "undefined" result.
      const fn = await send('(() => 1)')
      const symbol = await send("Symbol('not-json')")
      expect(fn.error).toBeNull()
      expect(fn.result).toBeNull()
      expect(symbol.error).toBeNull()
      expect(symbol.result).toBeNull()
    } finally {
      child.kill()
    }
  }, 60_000)
})
