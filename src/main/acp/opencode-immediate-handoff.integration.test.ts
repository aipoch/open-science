import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'

import { AcpRuntime } from './runtime.test-utils'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { opencodeFramework } from '../agent-framework'
import { createOpenCodeImmediateHandoffRuntime } from './opencode-immediate-handoff'
import {
  CompletionGateCoordinator,
  createCompletionGatedControlToolInterceptor,
  createCompletionGateSwitchNotifier
} from '../agents/completion-gate'
import { AgentsService, type AgentsCatalogSource } from '../agents/agents-service'
import type { ApprovalGateway } from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import {
  NotebookControlCompletionCapturedError,
  NotebookRuntimeService,
  resolveLoopScriptPaths
} from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const startFakeOpenCodeProvider = (
  process: FakeAgentProcess,
  calls: string[],
  executeOldTool: () => Promise<unknown>
): {
  requests: string[]
  oldRequestStarted: Promise<void>
  oldToolStarted: Promise<void>
  getOldToolCompletion: () => Promise<unknown>
} => {
  const requests: string[] = []
  const oldRequestStarted = deferred()
  const oldToolStarted = deferred()
  const releaseOldRequest = deferred()
  let oldToolCompletion: Promise<unknown> | undefined

  acp
    .agent({ name: 'fake-opencode' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: 'opencode-session',
      modes: {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent', name: 'agent' }]
      }
    }))
    .onRequest(acp.methods.agent.session.setMode, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')
      requests.push(text)
      if (requests.length === 1) {
        calls.push('provider-request:old-initial')
        oldRequestStarted.resolve()
        // The observable fake provider starts the real Notebook control tool while its old request
        // owns the session. Cancellation releases the provider request independently; the tool then
        // reaches NotebookRuntimeService's completion interceptor exactly as production does.
        oldToolCompletion = (async () => {
          try {
            const result = await executeOldTool()
            // This is the fake old provider's real tool-result continuation. It is intentionally
            // adversarial: a normally returned repl_execute result synchronously starts the forbidden
            // old-identity request before its promise resolves.
            calls.push('provider-request:old-after-approval')
            return result
          } catch (error) {
            if (error instanceof NotebookControlCompletionCapturedError) {
              // The same provider handler observes the production transport's captured sentinel and
              // does not turn it into either a tool result or an old-identity request.
              calls.push('provider-tool-result:captured')
              throw error
            }
            // A legacy outer-tool error is still a completion delivered to the old provider.
            calls.push('provider-request:old-after-approval')
            throw error
          }
        })()
        void oldToolCompletion.catch(() => undefined)
        oldToolStarted.resolve()
        await releaseOldRequest.promise
      } else {
        calls.push('provider-request:new')
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'provider reply' }
        }
      })
      return { stopReason: requests.length === 1 ? 'cancelled' : 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      calls.push('stop-old-prompt')
      releaseOldRequest.resolve()
      return undefined
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return {
    requests,
    oldRequestStarted: oldRequestStarted.promise,
    oldToolStarted: oldToolStarted.promise,
    getOldToolCompletion: () => {
      if (!oldToolCompletion) throw new Error('The old provider has not started its tool.')
      return oldToolCompletion
    }
  }
}

const specialist: SpecialistView = {
  id: 'specialist-new',
  name: 'New Specialist',
  displayName: 'New Specialist',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: {
    skillIds: ['new-skill'],
    connectorIds: ['new-connector'],
    connectorTools: []
  },
  revision: 1
}

const catalog: AgentsCatalogSource = {
  listSkillCatalog: async () => [],
  getConnectors: async () => ({ enabledIds: [], autoAllowIds: [] })
}

describe('OpenCode immediate handoff production path', () => {
  it('makes the next provider request under the approved projection in the original user turn', async () => {
    const calls: string[] = []
    const process = new FakeAgentProcess()
    const storageRoot = await mkdtemp(join(tmpdir(), 'opencode-handoff-'))
    const notebookSpecialists: Array<string | undefined> = []
    const turnTokens: string[] = []
    const userMessages: string[] = []
    const runtime = new AcpRuntimeCoordinator(
      (callbacks) =>
        new AcpRuntime({
          appVersion: '0.1.0',
          defaultCwd: '/workspace',
          spawnAgent: () => process as unknown as ChildProcessWithoutNullStreams,
          framework: opencodeFramework,
          callbacks,
          notebook: {
            projectId: 'Artifacts',
            mcpEntryPath: '/bin/mcp',
            getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
            registerSessionSpecialist: (_sessionId, specialistId) => {
              notebookSpecialists.push(specialistId)
            }
          },
          resolveSpecialistIdentity: async (specialistId) => ({
            append: '',
            prefix: specialistId === 'specialist-new' ? 'New Specialist identity' : 'Old identity'
          }),
          resolveSpecialistSkills: async (specialistId) => ({
            kind: 'specialist',
            skillIds: [`${specialistId}-skill`],
            frameworkNames:
              specialistId === 'specialist-new'
                ? ['New Skill', 'New Connector']
                : ['Old Skill', 'Old Connector'],
            missingSkillIds: []
          })
        }),
      {
        onPromptStarted: (_sessionId, turnToken) => turnTokens.push(turnToken),
        onEvent: (event) => {
          if (event.kind === 'message' && event.role === 'user' && event.text) {
            userMessages.push(event.text)
          }
        }
      }
    )
    let boundSpecialistId: string | undefined = 'specialist-old'
    const handoffRuntime = createOpenCodeImmediateHandoffRuntime({
      runtime,
      resolveSpecialistId: () => boundSpecialistId,
      reportHandoffFailure: async (error) => {
        throw error
      }
    })
    const completionCoordinator = new CompletionGateCoordinator(handoffRuntime)
    const approvalGateway: ApprovalGateway = {
      decide: vi.fn(async () => ({ status: 'approved' as const }))
    }
    const agents = new AgentsService({
      specialistService: {
        getByName: vi.fn(async () => specialist),
        getById: vi.fn(async () => specialist),
        resolveRunnableByName: vi.fn(async () => specialist),
        resolveRunnableById: vi.fn(async () => specialist),
        list: vi.fn(async () => [specialist])
      } as unknown as SpecialistService,
      catalog,
      approvalGateway,
      sessionBinding: {
        getBinding: vi.fn(() => boundSpecialistId),
        setBinding: vi.fn((_sessionId: string, specialistId: string | undefined) => {
          boundSpecialistId = specialistId
        })
      } as unknown as SessionBindingService,
      persistSessionSpecialist: vi.fn(async (_sessionId, specialistId) => {
        boundSpecialistId = specialistId
      }),
      switchNotifier: createCompletionGateSwitchNotifier(completionCoordinator)
    })
    const loops = resolveLoopScriptPaths()
    const notebookService = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'default-project',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () =>
        new NotebookKernelExecutor({
          pythonLoopPath: loops.pythonLoopPath,
          rLoopPath: loops.rLoopPath,
          replLoopPath: loops.replLoopPath
        })
    })
    const server = new NotebookLocalRpcServer(notebookService, {
      token: 'opencode-production-handoff',
      agentsService: agents
    })
    notebookService.setMcpRpcConnectionResolver(({ sessionId, projectId }) =>
      server.issueControlConnection(sessionId, projectId, 'root-frame-' + sessionId)
    )
    notebookService.setControlCompletionInterceptor(
      createCompletionGatedControlToolInterceptor(completionCoordinator, async () => undefined)
    )
    const provider = startFakeOpenCodeProvider(process, calls, () =>
      notebookService.executeControl({
        sessionId: 'opencode-session',
        workspaceCwd: storageRoot,
        code: "const switched = await host.agents.switch('New Specialist'); return JSON.stringify({ switched, afterAwait: 'completed' })"
      })
    )

    try {
      const session = await runtime.createSession({
        cwd: '/workspace',
        specialistId: 'specialist-old'
      })
      const originalTurn = runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'analyse the original dataset',
        provenanceContext: { promptMessageId: 'original-user-message' }
      })
      await provider.oldRequestStarted
      await provider.oldToolStarted
      await expect(provider.getOldToolCompletion()).rejects.toBeInstanceOf(
        NotebookControlCompletionCapturedError
      )
      await originalTurn

      expect(calls).toEqual([
        'provider-request:old-initial',
        'stop-old-prompt',
        'provider-request:new',
        'provider-tool-result:captured'
      ])
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]).toContain('New Specialist identity')
      expect(provider.requests[1]).toContain('New Skill')
      expect(provider.requests[1]).toContain('New Connector')
      expect(provider.requests[1]).toContain('\\"afterAwait\\":\\"completed\\"')
      expect(notebookSpecialists.at(-1)).toBe('specialist-new')
      expect(turnTokens).toEqual([turnTokens[0], turnTokens[0]])
      expect(userMessages).toEqual(['analyse the original dataset'])
    } finally {
      await notebookService.shutdownAll()
      await server.close()
      await runtime.shutdownForQuit()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
})
