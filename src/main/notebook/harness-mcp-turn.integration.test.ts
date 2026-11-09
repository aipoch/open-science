import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createMemoryAgentStore,
  createJournalAgentStore,
  type AgentCheckpoint,
  type AgentModel,
  type Json,
  type ModelRequest,
  type ContentBlock
} from '@aipoch/agent-harness'
import { openNotebookHarnessTurn } from './harness-mcp-turn'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRuntimeService, type NotebookExecutionRequest } from './runtime-service'
import { NotebookRunRepository } from './repository'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { initDataRoot } from '../storage-root'
import { callNotebookRpc } from './mcp-server'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const text = (value: string): ContentBlock[] => [{ type: 'text' as const, text: value }]
const completed = (
  cwdAfter: string
): {
  cwdAfter: string
  status: 'completed'
  stdout: string
  stderr: string
  traceback: string
  outputs: []
} => ({
  cwdAfter,
  status: 'completed' as const,
  stdout: '16',
  stderr: '',
  traceback: '',
  outputs: []
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(
  name = 'list_authorized_directories',
  args: Json = {},
  realShell = false,
  python?: string
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-mcp-turn-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  initDataRoot(root)
  const sandbox = realShell
    ? new NotebookNetworkSandboxOwner({
        resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
        temporaryRoot: join(root, 'command-temp'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny',
        ...(python
          ? {
              getGrantedLocalRoots: async () => [
                {
                  id: 'python-fixture',
                  path: await realpath(dirname(dirname(python))),
                  name: 'Existing Python runtime',
                  access: 'ro' as const
                }
              ]
            }
          : {})
      })
    : undefined
  if (sandbox) cleanup.push(() => sandbox.dispose())
  const execute = vi.fn(async (request: NotebookExecutionRequest) => {
    expect(request.code).toBeTypeOf('string')
    return completed(root)
  })
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    repository: new NotebookRunRepository(root),
    ...(sandbox ? { processSandbox: sandbox } : {}),
    ...(python
      ? {
          discoverRuntimes: async (language: 'python' | 'r') =>
            language === 'python'
              ? [
                  {
                    language: 'python' as const,
                    provenance: 'user-own' as const,
                    envId: python,
                    interpreterPath: python,
                    label: 'existing interpreter',
                    version: 'fixture',
                    runnable: true
                  }
                ]
              : [],
          notebookRuntimeSettings: {
            getSnapshot: async (language: 'python' | 'r') => ({
              language,
              runtimeEnablement: { enabled: { [python]: true }, installAuthorized: {} },
              manualInterpreters: [],
              packageMirror: {}
            })
          }
        }
      : { executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }) })
  })
  cleanup.push(() => service.dispose())
  if (python)
    await service.bindRuntime({
      projectId: 'project',
      sessionId: 'session',
      workspaceCwd: root,
      language: 'python',
      runtimeId: python
    })
  const read = vi.fn(async () => ({ revision: 'r1', directories: [] }))
  const rpc = new NotebookLocalRpcServer(service, { transport: 'tcp', authorizedDirectories: read })
  cleanup.push(() => rpc.close())
  const binding = {
    ownerExecutionId: 'owner',
    projectId: 'project',
    provenanceContext: {
      rootFrameId: 'root-frame-session',
      agentFrameId: 'root-frame-session',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      promptMessageId: 'prompt'
    }
  }
  rpc.setArtifactTurnBinding('session', binding)
  const connection = await rpc.issueSessionConnection('session', 'project', 'root-frame-session')
  cleanup.push(async () => connection.release?.())
  const environment = {
    ...connection,
    sessionId: 'session',
    projectId: 'project',
    workspaceCwd: root
  }
  const lifetime = new AbortController()
  const requests: ModelRequest[] = []
  const model: AgentModel = {
    id: 'fixture',
    capabilities: { tools: true, images: false, files: false },
    async *stream(request) {
      requests.push(request)
      if (request.messages.some((message) => message.role === 'tool'))
        yield { type: 'finish', reason: 'complete', content: text('done') }
      else
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'call', name, arguments: args }]
        }
    }
  }
  const permissions = { requestAppApproval: vi.fn(async () => true) }
  const options = {
    environment,
    allowedNames: ['list_authorized_directories', 'notebook_execute', 'bash_execute'],
    permissions,
    execution: { promptMessageId: 'prompt', ownerExecutionId: 'owner', authority: rpc },
    session: {
      sessionId: 'package-session',
      model,
      signal: lifetime.signal,
      store: createMemoryAgentStore(),
      maxSteps: 3,
      maxOutputTokens: 128
    }
  }
  const open = async (): Promise<Awaited<ReturnType<typeof openNotebookHarnessTurn>>> => {
    const turn = await openNotebookHarnessTurn(options)
    cleanup.push(() => turn.dispose())
    return turn
  }
  return {
    open,
    options,
    rpc,
    read,
    execute,
    environment,
    binding,
    lifetime,
    permissions,
    requests,
    service
  }
}

type MixedFact = { phase: number; total: number; pid?: number; cwd?: string }

// Read only observed tool output/previous summaries; never inject the fixture's expected answer.
function mixedFacts(
  value: unknown,
  facts = new Map<number, MixedFact>(),
  runIds = new Set<string>()
): MixedFact[] {
  if (typeof value === 'string') {
    for (const line of value.split('\n')) {
      if (line.startsWith('{')) {
        try {
          mixedFacts(JSON.parse(line), facts, runIds)
        } catch {
          /* Plain stdout. */
        }
      }
      if (line.startsWith('HARNESS_FACT=')) {
        const fact = JSON.parse(line.slice('HARNESS_FACT='.length)) as MixedFact
        facts.set(fact.phase, fact)
      }
    }
    try {
      mixedFacts(JSON.parse(value), facts, runIds)
    } catch {
      // Ordinary prompt/stdout text is not JSON.
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) mixedFacts(entry, facts, runIds)
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (typeof object.runId === 'string') runIds.add(object.runId)
    if (Array.isArray(object.runIds)) for (const id of object.runIds as string[]) runIds.add(id)
    if (Array.isArray(object.facts))
      for (const fact of object.facts as MixedFact[]) facts.set(fact.phase, fact)
    for (const entry of Object.values(object)) mixedFacts(entry, facts, runIds)
  }
  return [...facts.values()].sort((a, b) => a.phase - b.phase)
}

it.skipIf(process.platform !== 'darwin' || !process.env.OPEN_SCIENCE_TEST_PY_ENV)(
  'preserves real mixed Notebook/shell effects through automatic compaction and MCP recreation',
  async () => {
    const h = await setup('notebook_execute', {}, true, process.env.OPEN_SCIENCE_TEST_PY_ENV)
    const directory = join(h.environment.workspaceCwd, 'journal')
    const scripts: { name: string; arguments: Record<string, Json> }[] = [
      {
        name: 'notebook_execute',
        arguments: {
          code: [
            'import os, json',
            'execution_count = globals().get("execution_count", 0) + 1',
            'persistent_total = sum([3, 5, 8])',
            'fact = dict(phase=1, total=persistent_total, pid=os.getpid(), cwd=os.getcwd())',
            'with open("mixed-evidence.json", "w") as f: json.dump(fact, f)',
            'with open("mixed-ledger.txt", "a") as f: f.write("python-init\\n")',
            'print("HARNESS_FACT=" + json.dumps(fact))',
            'print("diagnostic " * 1000)'
          ].join('\n')
        }
      },
      {
        name: 'bash_execute',
        arguments: {
          command:
            'printf "HARNESS_FACT="; cat mixed-evidence.json; printf "\\n"; printf "shell-read\\n" >> mixed-ledger.txt'
        }
      },
      {
        name: 'notebook_execute',
        arguments: {
          code: [
            'assert execution_count == 1',
            'assert persistent_total == 16',
            'persistent_total += 5',
            'fact = dict(phase=3, total=persistent_total, pid=os.getpid(), cwd=os.getcwd())',
            'with open("mixed-evidence.json", "w") as f: json.dump(fact, f)',
            'with open("mixed-ledger.txt", "a") as f: f.write("python-update\\n")',
            'print("HARNESS_FACT=" + json.dumps(fact))',
            'print("diagnostic " * 1000)'
          ].join('\n')
        }
      },
      {
        name: 'bash_execute',
        arguments: {
          command:
            'printf "HARNESS_FACT="; cat mixed-evidence.json; printf "\\n"; printf "shell-final\\n" >> mixed-ledger.txt'
        }
      }
    ]
    let phase = 0,
      invoked = false
    const requests: ModelRequest[] = [],
      summaries: ModelRequest[] = []
    const model: AgentModel = {
      id: 'mixed-runtime-fixture',
      capabilities: { tools: true, images: false, files: false },
      async *stream(request, signal) {
        const last = request.messages.at(-1)?.content[0]
        if (
          last?.type === 'text' &&
          last.text.startsWith('Create a compact continuation checkpoint')
        ) {
          yield* summary.stream(request, signal)
          return
        }
        requests.push(request)
        if (!invoked) {
          invoked = true
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [{ id: `mixed-${phase}`, ...scripts[phase] }]
          }
        } else {
          const result = request.messages.findLast((message) => message.role === 'tool')!
          expect(result.isError).not.toBe(true)
          const facts = mixedFacts(result.content)
          expect(facts.at(-1)?.total).toBe(phase < 2 ? 16 : 21)
          yield { type: 'finish', reason: 'complete', content: text('ACK') }
        }
      }
    }
    const summary: AgentModel = {
      ...model,
      async *stream(request) {
        summaries.push(request)
        const runIds = new Set<string>()
        const facts = mixedFacts(request.messages, new Map(), runIds)
        expect(facts.length).toBeGreaterThan(0)
        yield {
          type: 'finish',
          reason: 'complete',
          content: text(
            `## Goal\nContinue phases.\n## Progress\nRecorded effects.\n## Evidence\n${JSON.stringify({ facts, runIds: [...runIds] })}\n## Next\nExecute remaining phases.`
          )
        }
      }
    }
    let previous: AgentCheckpoint | undefined
    for (phase = 0; phase < scripts.length; phase++) {
      invoked = false
      const ownerExecutionId = `mixed-owner-${phase}`,
        promptMessageId = `mixed-prompt-${phase}`
      h.rpc.setArtifactTurnBinding('session', {
        ...h.binding,
        ownerExecutionId,
        provenanceContext: { ...h.binding.provenanceContext, promptMessageId }
      })
      const approvals = h.permissions.requestAppApproval.mock.calls.length
      const turn = await openNotebookHarnessTurn({
        ...h.options,
        execution: { ...h.options.execution, ownerExecutionId, promptMessageId },
        session: {
          ...h.options.session,
          model,
          store: createJournalAgentStore({ directory }),
          compaction: {
            inputBudget: 6000,
            keepRecentItems: 2,
            maxOutputTokens: 512,
            // Deliberately small test threshold; this is not the provider's tokenizer/budget.
            measure: (request) => Math.ceil(Buffer.byteLength(JSON.stringify(request.messages)) / 4)
          }
        }
      })
      cleanup.push(() => turn.dispose())
      if (previous) expect(await turn.snapshot()).toEqual(previous)
      expect(h.permissions.requestAppApproval).toHaveBeenCalledTimes(approvals)
      expect(await turn.run(text(`Execute mixed phase ${phase + 1}.`))).toBe('complete')
      previous = await turn.snapshot()
      expect(previous.pending).toEqual([])
      expect(h.rpc.getArtifactTurnScope('session')).toBeUndefined()
      expect(h.permissions.requestAppApproval).toHaveBeenCalledTimes(phase + 1)
    }
    expect(summaries.length).toBeGreaterThan(0)
    expect(previous!.compactions.length).toBe(summaries.length)
    expect(requests).toHaveLength(8)
    expect(requests.at(-1)!.tools).toEqual(requests[0].tools)
    expect(requests.at(-1)!.messages.some((message) => message.role === 'summary')).toBe(true)
    const retainedIds = new Set<string>(),
      originalIds = new Set<string>()
    const retained = mixedFacts(requests.at(-1)!.messages, new Map(), retainedIds)
    mixedFacts(previous!.messages, new Map(), originalIds)
    // Foreground shell exposes exitCode/stdout; only Notebook results carry public runId.
    expect(originalIds.size).toBe(2)
    expect(retainedIds).toEqual(originalIds)
    expect(retained.map(({ phase, total }) => ({ phase, total }))).toEqual([
      { phase: 1, total: 16 },
      { phase: 3, total: 21 }
    ])
    expect(retained[0].pid).toBe(retained[1].pid)
    expect(await readFile(join(retained[0].cwd!, 'mixed-ledger.txt'), 'utf8')).toBe(
      'python-init\nshell-read\npython-update\nshell-final\n'
    )
    expect(h.execute).not.toHaveBeenCalled()
    expect(JSON.stringify(previous)).not.toContain(h.environment.token)
    await h.service.shutdownSession('session')
    expect(() => process.kill(retained[0].pid!, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    )
    // Turn-owned MCP was released while the borrowed host RPC capability remains usable.
    await expect(callNotebookRpc(h.environment, 'listAuthorizedDirectories')).resolves.toEqual({
      revision: 'r1',
      directories: []
    })
  },
  60_000
)

it.skipIf(process.platform !== 'darwin')(
  'reaps a real foreground shell on lifetime abort before admitting a successor MCP turn',
  async () => {
    const h = await setup('bash_execute', { command: 'pwd' }, true)
    const warmup = await h.open()
    expect(await warmup.run(text('Locate the managed shell workspace.'))).toBe('complete')
    const output = (await warmup.snapshot()).messages.find((message) => message.role === 'tool')!
    const cwd = JSON.parse((output.content[0] as { text: string }).text).stdout.trim() as string
    const marker = join(cwd, 'cancel-shell.pid')
    h.rpc.setArtifactTurnBinding('session', h.binding)
    h.options.session.model = {
      id: 'cancel-shell-fixture',
      capabilities: { tools: true, images: false, files: false },
      async *stream() {
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [
            {
              id: 'long-shell',
              name: 'bash_execute',
              arguments: {
                command: `set -e; printf '%s' "$$" > '${marker}'; exec sleep 60`
              }
            }
          ]
        }
      }
    }
    const turn = await h.open()
    const running = turn.run(text('Start the cancellable shell.'))
    // Attach a handler immediately, including when startup fails before the PID marker exists.
    let settled = false
    const result = running
      .then(
        (status) => ({ status }),
        (error: unknown) => ({ error })
      )
      .finally(() => {
        settled = true
      })
    let pid = 0
    try {
      await vi.waitFor(
        async () => {
          if (settled) throw new Error(JSON.stringify(await turn.snapshot()))
          pid = Number(await readFile(marker, 'utf8'))
          expect(pid).toBeGreaterThan(1)
        },
        { timeout: 15_000 }
      )
      expect(() => process.kill(pid, 0)).not.toThrow()
      h.lifetime.abort()
      expect(await result).toEqual({ status: 'blocked' })
      await turn.dispose()
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect((await turn.snapshot()).pending[0].status).toBe('unknown')
      expect(h.rpc.getArtifactTurnScope('session')).toBeUndefined()
      h.rpc.setArtifactTurnBinding('session', h.binding)
      const successor = await openNotebookHarnessTurn({
        ...h.options,
        session: {
          ...h.options.session,
          signal: new AbortController().signal,
          sessionId: 'successor-session',
          store: createMemoryAgentStore(),
          model: {
            ...h.options.session.model,
            async *stream() {
              yield { type: 'finish', reason: 'complete', content: text('successor') }
            }
          }
        }
      })
      cleanup.push(() => successor.dispose())
      expect(await successor.run(text('Continue after drain.'))).toBe('complete')
      expect(h.permissions.requestAppApproval).toHaveBeenCalledTimes(2)
    } finally {
      h.lifetime.abort()
      await result
      await turn.dispose()
    }
  },
  30_000
)

it('uses package session + real MCP + authenticated RPC, preserving a borrowed capability', async () => {
  const h = await setup(),
    turn = await h.open()
  expect(await turn.run(text('Read authorized directories.'))).toBe('complete')
  expect(h.read).toHaveBeenCalledTimes(1)
  expect(h.requests[0].tools.map((tool) => tool.name)).toEqual([
    'bash_execute',
    'list_authorized_directories',
    'notebook_execute'
  ])
  expect(h.requests[0].tools).toEqual(h.requests[1].tools)
  expect(
    h.requests[0].tools.find((tool) => tool.name === 'bash_execute')?.description
  ).not.toContain('background:true')
  expect(JSON.stringify(await turn.snapshot())).not.toContain(h.environment.token)
  const blocks = h.requests[1].messages.find((message) => message.role === 'tool')!.content
  expect(blocks).toHaveLength(1)
  expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual({
    revision: 'r1',
    directories: []
  })
  expect(await callNotebookRpc(h.environment, 'listAuthorizedDirectories')).toEqual({
    revision: 'r1',
    directories: []
  })
  await expect(turn.run(text('again'))).rejects.toThrow('already run')
})

it('refuses invalid fields and denied approvals before execution', async () => {
  const h = await setup('notebook_execute', { code: 42 }),
    turn = await h.open()
  expect(await turn.run(text('run'))).toBe('complete')
  expect(h.permissions.requestAppApproval).not.toHaveBeenCalled()
  expect(h.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(await turn.snapshot())).toContain('$.code: expected string')
  const denied = await setup('notebook_execute', { code: 'print(16)' })
  denied.permissions.requestAppApproval.mockResolvedValue(false)
  const deniedTurn = await denied.open()
  await deniedTurn.run(text('run'))
  expect(denied.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(await deniedTurn.snapshot())).toContain('Permission denied')
})

it('runs managed Notebook execution with bound provenance and refuses a second domain owner', async () => {
  const h = await setup('notebook_execute', { code: 'print(16)' }),
    turn = await h.open()
  await expect(h.open()).rejects.toThrow('domain is busy')
  expect(await turn.run(text('calculate'))).toBe('complete')
  expect(h.execute).toHaveBeenCalledTimes(1)
  expect(h.execute.mock.calls[0][0]).toMatchObject({ code: 'print(16)', sessionId: 'session' })
  expect(JSON.stringify(await turn.snapshot())).toContain('16')
  expect((await turn.snapshot()).pending).toEqual([])
})

it('keeps a transport-reported execution failure unknown instead of retrying', async () => {
  const h = await setup('notebook_execute', { code: 'print(16)' }),
    turn = await h.open()
  h.environment.release?.()
  await expect(turn.run(text('run'))).rejects.toThrow('outcome is unknown')
  expect(h.execute).not.toHaveBeenCalled()
  expect((await turn.snapshot()).pending[0].status).toBe('unknown')
  expect(h.requests).toHaveLength(1)
})

it('awaits actual RPC execution drain after account lifetime cancellation', async () => {
  const h = await setup('notebook_execute', { code: 'print(16)' })
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  h.execute.mockImplementation(async () => {
    enter()
    await gate
    return completed(h.environment.workspaceCwd)
  })
  const turn = await h.open()
  let settled = false
  const running = turn.run(text('run')).finally(() => {
    settled = true
  })
  try {
    await entered
    h.lifetime.abort()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    h.rpc.setArtifactTurnBinding('session', {
      ...h.binding,
      ownerExecutionId: 'successor',
      provenanceContext: { ...h.binding.provenanceContext, promptMessageId: 'new-prompt' }
    })
    await expect(
      openNotebookHarnessTurn({
        ...h.options,
        execution: {
          ...h.options.execution,
          ownerExecutionId: 'successor',
          promptMessageId: 'new-prompt'
        },
        session: { ...h.options.session, signal: new AbortController().signal }
      })
    ).rejects.toThrow('domain is busy')
  } finally {
    release()
  }
  expect(await running).toBe('blocked')
  await turn.dispose()
  expect((await turn.snapshot()).pending[0].status).toBe('unknown')
})

it('does not revoke a successor turn when an older owner is disposed', async () => {
  const h = await setup(),
    turn = await h.open()
  h.rpc.setArtifactTurnBinding('session', {
    ...h.binding,
    ownerExecutionId: 'successor',
    provenanceContext: { ...h.binding.provenanceContext, promptMessageId: 'new-prompt' }
  })
  await turn.dispose()
  expect(
    h.rpc.authorizeExecution({
      sessionId: 'session',
      promptMessageId: 'new-prompt',
      toolCallId: 'new-call',
      method: 'execute',
      rawInput: { code: 'print(16)' }
    })
  ).toBeTruthy()
})

it.skipIf(process.platform !== 'darwin')(
  'executes a real managed shell through MCP and the production sandbox',
  async () => {
    const h = await setup('bash_execute', { command: 'printf harness-mcp-real-shell' }, true)
    const turn = await h.open()
    expect(await turn.run(text('run diagnostic'))).toBe('complete')
    const snapshot = await turn.snapshot()
    expect(JSON.stringify(snapshot)).toContain('harness-mcp-real-shell')
    const result = snapshot.messages.find((message) => message.role === 'tool')!
    expect(result.isError).not.toBe(true)
    const output = JSON.parse((result.content[0] as { text: string }).text)
    expect(output).toMatchObject({ exitCode: 0 })
    expect(h.execute).not.toHaveBeenCalled()
  },
  30_000
)

it.skipIf(process.platform !== 'darwin' || !process.env.OPEN_SCIENCE_TEST_PY_ENV)(
  'executes real Python through package, MCP, RPC and the production sandbox',
  async () => {
    const h = await setup(
      'notebook_execute',
      { code: 'print(sum(i*i for i in range(100)))' },
      true,
      process.env.OPEN_SCIENCE_TEST_PY_ENV
    )
    const turn = await h.open()
    expect(await turn.run(text('compute'))).toBe('complete')
    const snapshot = await turn.snapshot()
    const result = snapshot.messages.find((message) => message.role === 'tool')!
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('328350')
    expect(h.execute).not.toHaveBeenCalled()
  },
  30_000
)

it('rejects a mismatched turn identity without clearing the legitimate owner', async () => {
  const h = await setup()
  await expect(
    openNotebookHarnessTurn({
      ...h.options,
      execution: { ...h.options.execution, ownerExecutionId: 'wrong-owner' }
    })
  ).rejects.toThrow('identity mismatch')
  expect(h.rpc.getArtifactTurnScope('session')?.ownerExecutionId).toBe('owner')
  const turn = await h.open()
  h.rpc.registerSessionAlias('alias', 'session')
  await expect(
    openNotebookHarnessTurn({
      ...h.options,
      environment: { ...h.options.environment, sessionId: 'alias' }
    })
  ).rejects.toThrow('domain is busy')
  await turn.dispose()
})

it('rejects an obsolete turn before requesting execution authority', async () => {
  const h = await setup('notebook_execute', { code: 'print(16)' }),
    turn = await h.open()
  h.rpc.setArtifactTurnBinding('session', {
    ...h.binding,
    ownerExecutionId: 'replacement',
    provenanceContext: { ...h.binding.provenanceContext, promptMessageId: 'new-prompt' }
  })
  await turn.run(text('obsolete'))
  expect(h.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(await turn.snapshot())).toContain('no longer active')
  expect(h.rpc.getArtifactTurnScope('session')?.ownerExecutionId).toBe('replacement')
})

it('surfaces cleanup failure and keeps the execution domain fenced', async () => {
  const h = await setup()
  const turn = await openNotebookHarnessTurn(h.options)
  const clear = h.rpc.clearArtifactTurnBinding.bind(h.rpc)
  vi.spyOn(h.rpc, 'clearArtifactTurnBinding').mockImplementationOnce(async (...args) => {
    await clear(...args)
    throw new Error('termination not confirmed')
  })
  await expect(turn.dispose()).rejects.toThrow('cleanup failed')
  await expect(turn.dispose()).rejects.toThrow('cleanup failed')
  h.rpc.setArtifactTurnBinding('session', h.binding)
  await expect(h.open()).rejects.toThrow('domain is busy')
})
