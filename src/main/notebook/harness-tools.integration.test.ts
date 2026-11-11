import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarnessNotebookTools } from './harness-tools'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { AcpPermissionBroker } from '../acp/permission-broker'
import { runHarnessTurn } from '../settings/harness-turn'
import { HarnessSessionOwner } from '../settings/harness-session-owner'
import { SettingsRepository } from '../settings/repository'
import { ProviderTransportOwner } from '../settings/provider-transport-owner'
import { ProtocolForwardingBridge } from '../settings/protocol-forwarding-bridge'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage } from '../../shared/session-persistence'
import { initDataRoot } from '../storage-root'
import { NotebookRuntimeService, type NotebookExecutionRequest } from './runtime-service'
import { NotebookRunRepository } from './repository'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// This fixture uses actual transport, approval and Session owners; no compute kernel is started.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(name = 'list_authorized_directories', args: unknown = {}, compute = false) {
  const root = await mkdtemp(join(tmpdir(), 'harness-notebook-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  initDataRoot(root)
  const records = {
    revision: 'r1',
    directories: [
      { path: root, name: 'Fixture', access: 'ro' as const, grantedAt: '2026-11-01T00:00:00Z' }
    ]
  }
  const read = vi.fn(async () => records)
  const execute = vi.fn(async (request: NotebookExecutionRequest) => {
    expect(request.code).toBe('print(3 + 5 + 8)')
    return {
      status: 'completed' as const,
      stdout: '16',
      stderr: '',
      traceback: '',
      cwdAfter: root,
      outputs: []
    }
  })
  const service = compute
    ? new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
      })
    : undefined
  if (service) cleanup.push(() => service.dispose())
  const runtime =
    service ??
    new Proxy(
      {},
      {
        get() {
          throw new Error('Compute runtime must not be accessed')
        }
      }
    )
  const rpc = new NotebookLocalRpcServer(runtime as never, {
    transport: 'tcp',
    authorizedDirectories: read
  })
  cleanup.push(() => rpc.close())
  const admitExecution = vi.spyOn(rpc, 'authorizeExecution')
  if (compute)
    rpc.setArtifactTurnBinding('session', {
      ownerExecutionId: 'fixture-execution',
      projectId: 'project',
      provenanceContext: {
        rootFrameId: 'root-frame-session',
        agentFrameId: 'root-frame-session',
        messageBranchId: 'message-branch-session',
        runtimeSegmentId: 'fixture-segment',
        promptMessageId: 'prompt'
      }
    })
  const connection = await rpc.issueSessionConnection('session', 'project', 'root-frame-session')
  cleanup.push(async () => connection.release?.())
  const environment = {
    ...connection,
    sessionId: 'session',
    projectId: 'project',
    workspaceCwd: root
  }
  const broker = new AcpPermissionBroker(() => undefined)
  cleanup.push(async () => broker.cancelAllPending())
  const tools = createHarnessNotebookTools(
    environment,
    ['list_authorized_directories', 'notebook_execute', 'bash_execute'],
    broker,
    { promptMessageId: 'prompt', authority: rpc }
  )
  const repository = new SessionRepository(root)
  const messages: PersistedChatMessage[] = [
    {
      id: 'prompt',
      role: 'user',
      content: 'Read authorized directories.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      content: '',
      status: 'streaming',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const graph = createLinearConversationGraph({
    sessionId: 'session',
    messages,
    createdAt: 1,
    updatedAt: 2
  })
  graph.runtimeSegments = []
  for (const message of graph.messages) delete message.runtimeSegmentId
  await repository.saveSession({
    id: 'session',
    projectId: 'project',
    title: 'Harness test',
    cwd: root,
    status: 'idle',
    messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 2
  })
  const persistence = new SessionPersistenceCoordinator(repository, {
    syncSession: vi.fn(async () => []),
    softDeleteSession: vi.fn(async () => 'deleted'),
    restoreSession: vi.fn(async () => undefined),
    softDeleteProject: vi.fn(async () => 'deleted'),
    reconcileProjectSessions: vi.fn(async () => undefined),
    reconcileActiveSessions: vi.fn(async () => undefined),
    markReconciliationIncomplete: vi.fn()
  })
  const settings = new SettingsRepository(join(root, 'settings'))
  const provider = {
    id: 'provider',
    name: 'Fixture',
    type: 'custom' as const,
    baseUrl: 'https://fixture.invalid',
    model: 'fixture',
    apiEndpoints: ['chat-completions' as const]
  }
  await settings.upsertProvider(provider)
  const upstream = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    const afterTool = body.messages.at(-1).role === 'tool'
    if (afterTool)
      expect(
        (await repository.loadSession('project', 'session'))?.messages[1].harnessTurn?.transcript
          ?.tools[0].status
      ).toMatch(/completed|denied/)
    return Response.json({
      choices: [
        {
          finish_reason: afterTool ? 'stop' : 'tool_calls',
          message: {
            role: 'assistant',
            content: afterTool ? 'Done' : null,
            ...(afterTool
              ? {}
              : {
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) }
                    }
                  ]
                })
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 }
    })
  })
  const owner = new HarnessSessionOwner(
    settings,
    new ProviderTransportOwner({
      createProtocolForwardingBridge: (targets, id) =>
        new ProtocolForwardingBridge(targets, id, upstream)
    })
  )
  cleanup.push(() => owner.dispose())
  const session = await owner.open(
    { providerId: 'provider', model: 'fixture', maxSteps: 3 },
    new AbortController().signal
  )
  const scope = {
    projectId: 'project',
    sessionId: 'session',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.frames[0].activeBranchId,
    promptMessageId: 'prompt',
    messageId: 'answer',
    generation: 'generation',
    route: session.route
  }
  const input = { session, scope, persistence, tools, maxOutputTokens: 256 }
  const journal = async (): Promise<NonNullable<PersistedChatMessage['harnessTurn']>> =>
    (await repository.loadSession('project', 'session'))!.messages[1].harnessTurn!
  const decide = async (allow: boolean): Promise<void> => {
    await vi.waitFor(() => expect(broker.getPendingRequests()).toHaveLength(1))
    const pending = broker.getPendingRequests()[0]
    expect(pending.sessionId).toBe('session')
    const option = pending.options.find(
      (item) => item.kind === (allow ? 'allow_once' : 'reject_once')
    )!
    await broker.respond({ requestId: pending.requestId, optionId: option.optionId })
  }
  return {
    input,
    journal,
    decide,
    broker,
    read,
    records,
    upstream,
    owner,
    settings,
    provider,
    connection,
    environment,
    service,
    execute,
    root,
    admitExecution
  }
}

describe('harness through managed Notebook tools', () => {
  it('dispatches an approved cell through the real Notebook run owner with execution provenance', async () => {
    const h = await setup('notebook_execute', { code: 'print(3 + 5 + 8)' }, true)
    h.execute.mockImplementation(async (request) => {
      expect(request.code).toBe('print(3 + 5 + 8)')
      expect((await h.journal()).transcript?.tools[0].status).toBe('started')
      return {
        status: 'completed',
        stdout: '16',
        stderr: '',
        traceback: '',
        cwdAfter: h.root,
        outputs: []
      }
    })
    const turn = runHarnessTurn(h.input)
    await h.decide(true)
    expect(await turn).toBe('complete')
    expect(h.execute).toHaveBeenCalledOnce()
    const state = await h.service!.state({ sessionId: 'session', workspaceCwd: h.root })
    expect(state.runs.at(-1)).toMatchObject({
      status: 'completed',
      executionInvocationId: expect.any(String)
    })
    expect((await h.journal()).transcript?.tools[0].output).toContain('16')
  })
  it('awaits real approval, executes authenticated RPC and persists results before the next model call', async () => {
    const h = await setup()
    const turn = runHarnessTurn(h.input)
    await vi.waitFor(() => expect(h.broker.getPendingRequests()).toHaveLength(1))
    expect(h.read).not.toHaveBeenCalled()
    expect((await h.journal()).transcript?.tools).toEqual([])
    await h.decide(true)
    expect(await turn).toBe('complete')
    expect(h.read).toHaveBeenCalledOnce()
    const stored = await h.journal()
    expect(stored.status).toBe('complete')
    expect(stored.transcript?.tools[0]).toMatchObject({
      status: 'completed',
      output: expect.stringContaining('Fixture')
    })
    expect(stored.requests).toHaveLength(2)
    expect(h.broker.getPendingRequests()).toEqual([])
    expect(JSON.stringify(h.upstream.mock.calls)).not.toContain(h.connection.token)
  })

  it.each(['notebook_execute', 'bash_execute'])(
    'returns a denial for %s without invoking a compute runtime',
    async (name) => {
      const h = await setup(
        name,
        name === 'notebook_execute' ? { code: 'print(1)' } : { command: 'echo 1' }
      )
      const turn = runHarnessTurn(h.input)
      await h.decide(false)
      expect(await turn).toBe('complete')
      expect((await h.journal()).transcript?.tools).toEqual([
        {
          requestId: expect.any(String),
          callId: 'call-1',
          status: 'denied',
          output: 'Permission denied'
        }
      ])
      expect(h.read).not.toHaveBeenCalled()
      expect(h.admitExecution).not.toHaveBeenCalled()
    }
  )

  it.each(['notebook_execute', 'bash_execute'])(
    'requires a live execution binding after approval of %s',
    async (name) => {
      const h = await setup(
        name,
        name === 'notebook_execute' ? { code: 'print(1)' } : { command: 'echo 1' }
      )
      const turn = runHarnessTurn(h.input)
      await h.decide(true)
      await expect(turn).rejects.toThrow('execution admission is unavailable')
      expect((await h.journal()).transcript?.tools[0].status).toBe('unknown')
      expect(h.read).not.toHaveBeenCalled()
      expect(h.admitExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session',
          promptMessageId: 'prompt',
          toolCallId: 'call-1',
          method: name === 'notebook_execute' ? 'execute' : 'executeShell'
        })
      )
      expect(() =>
        createHarnessNotebookTools(h.environment, ['notebook_execute'], h.broker)
      ).toThrow('active Notebook turn binding')
    }
  )

  it('does not admit background jobs without a lifecycle owner', async () => {
    const h = await setup('notebook_execute', { code: 'print(1)', background: true })
    await expect(runHarnessTurn(h.input)).rejects.toThrow()
    expect(h.broker.getPendingRequests()).toEqual([])
    expect((await h.journal()).transcript?.tools).toEqual([])
  })

  it.each(['sessionId', 'projectId', 'endpoint', 'token'])(
    'rejects model-supplied %s before permission or dispatch',
    async (key) => {
      const h = await setup('list_authorized_directories', { [key]: 'forged' })
      await expect(runHarnessTurn(h.input)).rejects.toThrow()
      expect(h.broker.getPendingRequests()).toEqual([])
      expect(h.read).not.toHaveBeenCalled()
      expect((await h.journal()).status).toBe('failed')
    }
  )

  it.each(['account', 'dispose'])(
    'removes pending approval on %s invalidation',
    async (trigger) => {
      const h = await setup()
      const turn = runHarnessTurn(h.input)
      await vi.waitFor(() => expect(h.broker.getPendingRequests()).toHaveLength(1))
      if (trigger === 'dispose') await h.owner.dispose()
      else
        await h.settings.upsertProvider(
          { ...h.provider, baseUrl: 'https://changed.invalid' },
          'provider',
          {}
        )
      expect(await turn).toBe('cancelled')
      expect(h.broker.getPendingRequests()).toEqual([])
      expect(h.read).not.toHaveBeenCalled()
      expect((await h.journal()).status).toBe('cancelled')
    }
  )

  it('rejects a competing turn without settling or cancelling the admitted writer', async () => {
    const h = await setup()
    const turn = runHarnessTurn(h.input)
    await vi.waitFor(() => expect(h.broker.getPendingRequests()).toHaveLength(1))
    await expect(runHarnessTurn(h.input)).rejects.toThrow()
    expect((await h.journal()).status).toBe('running')
    await h.decide(true)
    expect(await turn).toBe('complete')
  })

  it('fails closed after the exact RPC capability is released', async () => {
    const h = await setup()
    const turn = runHarnessTurn(h.input)
    await vi.waitFor(() => expect(h.broker.getPendingRequests()).toHaveLength(1))
    h.connection.release?.()
    await h.decide(true)
    await expect(turn).rejects.toThrow()
    expect(h.read).not.toHaveBeenCalled()
    expect((await h.journal()).transcript?.tools[0].status).toBe('unknown')
  })

  it('settles a bounded tool loop as budget exhaustion rather than completion', async () => {
    const h = await setup()
    let call = 0
    h.upstream.mockImplementation(async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-${++call}`,
                  type: 'function',
                  function: { name: 'list_authorized_directories', arguments: '{}' }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    )
    const turn = runHarnessTurn(h.input)
    for (let index = 0; index < 3; index++) await h.decide(true)
    expect(await turn).toBe('budget')
    expect((await h.journal()).status).toBe('budget')
    expect((await h.journal()).transcript?.tools).toHaveLength(3)
  })

  it('retains a falsy execution rejection as failure and does not retry', async () => {
    const h = await setup()
    const tools = h.input.tools.map((tool) => ({
      ...tool,
      execute: async (): Promise<string> => {
        throw 0
      }
    }))
    const turn = runHarnessTurn({ ...h.input, tools })
    await h.decide(true)
    await expect(turn).rejects.toBe(0)
    expect(h.upstream).toHaveBeenCalledOnce()
    expect((await h.journal()).status).toBe('failed')
    expect((await h.journal()).transcript?.tools[0].status).toBe('unknown')
  })

  it('rejects unapproved tools and snapshots the host route independently of later mutation', async () => {
    const h = await setup()
    expect(() => createHarnessNotebookTools(h.environment, ['repl_execute'], h.broker)).toThrow(
      'Unsupported'
    )
    expect(() =>
      createHarnessNotebookTools(h.environment, ['notebook_execute', 'notebook_execute'], h.broker)
    ).toThrow('Duplicate')
    h.environment.sessionId = 'forged'
    h.environment.token = 'changed'
    const turn = runHarnessTurn(h.input)
    await h.decide(true)
    expect(await turn).toBe('complete')
    expect(h.read).toHaveBeenCalledOnce()
  })
})
