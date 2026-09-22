import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'
import { createOpencodeFramework } from '../agent-framework/opencode'

import { AcpContextRecoveryOwner } from './context-recovery-owner'
import { buildRecoveryHandoff } from './recovery-handoff'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { AcpSessionRegistry } from './session-registry'
import { AcpProviderSessionAdopter } from './provider-session-adopter'
import { AcpSessionReplacementWorkflow } from './session-replacement-workflow'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
} from './session-capability-owner'
import { AcpSessionConfigurator } from './session-configurator'
// Opt in with OPEN_SCIENCE_OPENCODE_TEST_BINARY=/absolute/path/to/opencode.
const binary = process.env.OPEN_SCIENCE_OPENCODE_TEST_BINARY
it.runIf(Boolean(binary))(
  'real OpenCode: main recovery owner replaces poisoned history and continues with bounded evidence',
  async () => {
    const version = execFileSync(binary!, ['--version'], { encoding: 'utf8' }).trim()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-context-native-')))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const fixturePath = join(workspace, 'large-tool-result.txt')
    await writeFile(
      fixturePath,
      Array.from({ length: 400 }, (_, i) => `${i}: ${'evidence '.repeat(13)}`).join('\n')
    )
    const captures: {
      mode: string
      inputLimit: number
      path: string | undefined
      inputTokens: number
      wireBytes: number
      tooLarge: boolean
      tools: number
      messageCount: number
      toolBytes: number
      lastText: string
    }[] = []
    const outcomes: unknown[] = []
    let mode = 'initial'
    const inputLimit = 12000
    let toolIssued = false
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (x) => chunks.push(x))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          model: string
          messages?: { role: string; content: unknown }[]
          tools?: { function?: { name: string } }[]
        }
        const wireBytes = Buffer.byteLength(
          JSON.stringify({ messages: body.messages, tools: body.tools })
        )
        // Deterministic synthetic tokenizer, shared by acceptance and returned usage.
        const inputTokens = Math.ceil(wireBytes / 4)
        const tooLarge = inputTokens > inputLimit
        const toolMessages = (body.messages ?? []).filter((m) => m.role === 'tool')
        captures.push({
          mode,
          inputLimit,
          path: req.url,
          inputTokens,
          wireBytes,
          tooLarge,
          tools: body.tools?.length ?? 0,
          messageCount: body.messages?.length ?? 0,
          toolBytes: Buffer.byteLength(JSON.stringify(toolMessages)),
          lastText: JSON.stringify(body.messages?.at(-1)?.content).slice(0, 220)
        })
        if (tooLarge) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
                message: `This model's maximum context length is ${inputLimit} tokens. However, your messages resulted in ${inputTokens} tokens.`
              }
            })
          )
          return
        }
        const call =
          mode === 'initial' && !toolIssued && body.tools?.some((t) => t.function?.name === 'read')
        if (call) toolIssued = true
        const delta = call
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'read_fixture',
                  type: 'function',
                  function: { name: 'read', arguments: JSON.stringify({ filePath: fixturePath }) }
                }
              ]
            }
          : {
              role: 'assistant',
              content: 'Bounded context accepted. Preserve the task and continue.'
            }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          [
            `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: 30, total_tokens: inputTokens + 30 } })}`,
            'data: [DONE]',
            ''
          ].join('\n\n')
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const config = createOpencodeFramework().prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        model: 'probe-model',
        key: 'local-fixture-key',
        baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`,
        contextWindow: 16000,
        maxInputTokens: 12000,
        maxOutputTokens: 2048
      },
      { storageRoot: root, executablePath: binary! }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const child = spawn(binary!, ['acp'], {
      cwd: workspace,
      env: { ...process.env, ...config.env, OPENCODE_DISABLE_MODELS_FETCH: 'true' },
      stdio: 'pipe'
    })
    const stderr: string[] = []
    child.stderr.on('data', (x) => stderr.push(String(x)))
    const run = async (session: acp.ActiveSession, text: string): Promise<acp.PromptResponse> => {
      const failure = new Promise<never>((_, reject) => {
        session.prompt(text).catch(reject)
      })
      for (;;) {
        const update = await Promise.race([session.nextUpdate(), failure])
        if (update.kind === 'stop') return update.response
      }
    }
    let saved: PersistedChatSession | undefined
    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
      await acp
        .client({ name: 'context-recovery-native' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
          outcome: { outcome: 'selected', optionId: ctx.params.options[0].optionId }
        }))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
          })
          const original = await ctx.buildSession({ cwd: workspace, mcpServers: [] }).start()
          // Execute one real provider-managed tool before poisoning the history.
          expect(
            (await run(original, 'Read the fixture file and retain the result.')).stopReason
          ).toBe('end_turn')
          expect(toolIssued).toBe(true)
          mode = 'poisoned'
          const history = 'TASK: preserve every sample and p < 0.01.\n' + 'x'.repeat(100000)
          let failure: unknown
          try {
            await run(original, history)
          } catch (error) {
            failure = error
          }
          expect(String(failure)).toContain('too large to compact')
          try {
            await run(original, 'Continue with p < 0.01, retaining every sample.')
          } catch (error) {
            failure = error
          }
          const messages = [
            {
              id: 'material',
              role: 'user' as const,
              content: history,
              status: 'complete' as const,
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            },
            {
              id: 'continue',
              role: 'user' as const,
              content: 'Continue with p < 0.01, retaining every sample.',
              status: 'complete' as const,
              eventIds: [],
              createdAt: 2,
              updatedAt: 2
            }
          ]
          saved = {
            id: 'stable-app',
            projectId: 'project',
            title: 'Recovery probe',
            cwd: workspace,
            status: 'error',
            agentFrameworkId: 'opencode',
            providerSessionId: original.sessionId,
            messages,
            createdAt: 1,
            updatedAt: 2,
            conversationGraph: createLinearConversationGraph({
              sessionId: 'stable-app',
              messages,
              createdAt: 1,
              updatedAt: 2
            })
          }
          const graph = saved.conversationGraph!
          graph.activities.push({
            id: 'read_fixture',
            kind: 'tool',
            title: 'Read fixture',
            toolKind: 'read',
            status: 'completed',
            sortIndex: 1,
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            agentFrameId: graph.activeFrameId,
            messageBranchId: graph.branches[0].id,
            promptMessageId: 'material',
            runtimeSegmentId: graph.runtimeSegments[0].id,
            rawOutput: { file: fixturePath, lines: 400 }
          })
          const originalGraph = structuredClone(graph)
          const registry = new AcpSessionRegistry()
          const reserved = registry.reserve({ sessionIds: ['stable-app', original.sessionId] })
          if (reserved.collision) throw reserved.collision
          registry.publish(reserved.reservation, 'stable-app', {
            session: original,
            cwd: workspace,
            projectId: 'project',
            frameworkId: 'opencode',
            permissionProfile: {
              selectedProfile: 'ask',
              effectiveProfile: 'ask',
              availableModeIds: [],
              fullAccessAvailable: false
            }
          })
          reserved.reservation.release()
          const connection = { agent: ctx } as unknown as acp.ClientConnection
          const backend = {
            framework: createOpencodeFramework(),
            backendId: 'opencode',
            session: { modelRequired: false },
            prompt: { systemPromptAppends: [] },
            context: { supportsImageInput: false },
            adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
          }
          const adopter = new AcpProviderSessionAdopter({
            currentBackend: () => backend,
            registry,
            reserveIdentity: (reservation, sessionIds) =>
              registry.reserve({ reservation, sessionIds }),
            capabilities: new AcpSessionCapabilityOwner({}),
            capabilityPolicy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
            configurator: new AcpSessionConfigurator({
              assertCurrentConnection: () => {},
              diagnosticContext: () => ({})
            }),
            peekClaudeReplay: () => undefined,
            commitClaudeReplay: () => {},
            updateCwd: () => {},
            emitState: () => {},
            diagnosticContext: () => ({})
          })
          const replacement = new AcpSessionReplacementWorkflow({
            defaultCwd: workspace,
            defaultProjectId: 'project',
            currentCwd: () => workspace,
            currentFrameworkId: () => 'opencode',
            ensureConnected: async () => connection,
            assertCurrentConnection: () => {},
            registry,
            reserveIdentity: (sessionId, publishedAppSessionId) =>
              registry.reserve({ sessionIds: [sessionId], publishedAppSessionId }),
            adopter,
            reconfigureSession: vi.fn(),
            assertSkillScopeRefreshSupported: () => {},
            permission: { cancelForSession: () => {}, clearLivePermissionProfile: () => {} },
            elicitation: { cancelForSession: () => false },
            clearUserChoiceProvenanceForSession: () => {},
            appContinuations: { delete: () => false },
            promptContent: { resetSession: () => {} },
            releasePromptResourcesForSession: () => {},
            contextUsage: { deleteSession: () => {} },
            interactions: { current: () => undefined, supersedeCurrent: () => {} }
          })
          const compact = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
          const replace = vi.fn(
            (
              request: Parameters<typeof replacement.reset>[0],
              hooks: Parameters<typeof replacement.reset>[1]
            ) => replacement.reset(request, hooks)
          )
          const owner = new AcpContextRecoveryOwner({
            load: async () => structuredClone(saved!),
            save: async (_id, record, providerSessionId) => {
              saved = {
                ...saved!,
                ...(providerSessionId ? { providerSessionId } : {}),
                runtimeContext: { version: 1, revision: 1, contextRecovery: record }
              }
            },
            prepare: (session, request) =>
              buildRecoveryHandoff({
                session,
                currentInput: request?.text,
                contextWindowTokens: 16000,
                fixedOverheadTokens: 6000,
                outputReserveTokens: 2048
              }),
            compact,
            replace,
            continue: async (request) => {
              mode = 'recovery'
              expect(request.text).not.toContain('x'.repeat(1000))
              return run(registry.lookup('stable-app')!.attachment!.session, request.text)
            },
            changed: () => {}
          })
          await owner.recover('stable-app', {
            error: failure,
            request: {
              sessionId: 'stable-app',
              text: messages[1].content,
              provenanceContext: { promptMessageId: 'continue' }
            }
          })
          outcomes.push({
            failure: String(failure),
            state: owner.snapshot(),
            oldProvider: original.sessionId,
            newProvider: saved!.providerSessionId
          })
          expect(owner.snapshot()['stable-app'].phase).toBe('completed')
          expect(compact).not.toHaveBeenCalled()
          expect(replace).toHaveBeenCalledOnce()
          expect(saved!.providerSessionId).not.toBe(original.sessionId)
          expect(saved!.id).toBe('stable-app')
          expect(saved!.conversationGraph).toEqual(originalGraph)
          expect(captures.filter((x) => x.mode === 'recovery').length).toBeGreaterThan(0)
          expect(
            captures
              .filter((x) => x.mode === 'recovery')
              .every((x) => !x.tooLarge && x.toolBytes === 2)
          ).toBe(true)
          await owner.recover('stable-app', {
            error: failure,
            request: {
              sessionId: 'stable-app',
              text: messages[1].content,
              provenanceContext: { promptMessageId: 'continue' }
            }
          })
          expect(replace).toHaveBeenCalledOnce()
          await ctx.request(acp.methods.agent.session.resume, {
            sessionId: saved!.providerSessionId!,
            cwd: workspace,
            mcpServers: []
          })
          registry.lookup('stable-app')?.attachment?.session.dispose()
        })
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        if (child.exitCode !== null) return r()
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          r()
        })
      })
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      if (process.env.OPEN_SCIENCE_OPENCODE_TEST_REPORT)
        await writeFile(
          process.env.OPEN_SCIENCE_OPENCODE_TEST_REPORT,
          JSON.stringify(
            {
              binary: binary!,
              version,
              root,
              syntheticInputLimit: 12000,
              tokenizer: 'ceil(UTF8 bytes of messages+tools / 4)',
              outcomes,
              captures,
              stderr
            },
            null,
            2
          )
        )
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)
