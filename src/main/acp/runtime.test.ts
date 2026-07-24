import * as acp from '@agentclientprotocol/sdk'
import type {
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AcpRuntime } from './runtime'
import type { ReasoningEffort } from '../../shared/settings'
import { terminateProcessTree } from '../process-tree'
import { AgentMcpHttpHost } from './mcp-http-host'
import { SkillRegistry } from '../skills/registry'
import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import { ArtifactRepository } from '../artifacts/repository'
import { writeArtifactFileForCurrentRun } from '../artifacts/mcp-server'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME
} from '../activity-groups/mcp-server'
import type { UploadedAttachment } from '../../shared/uploads'
import { UploadRepository } from '../uploads/repository'
import { MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES } from '../uploads/attachment-media'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

// Captures info/warn logs so the permission-request audit line and the agent-process lifecycle records
// can be asserted; real file/console logging is otherwise irrelevant to these tests. errorLogFields is
// left as the real implementation so lifecycle records carry its true output shape.
const { infoLogSpy, warnLogSpy, errorLogSpy } = vi.hoisted(() => ({
  infoLogSpy: vi.fn(),
  warnLogSpy: vi.fn(),
  errorLogSpy: vi.fn()
}))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({
      ...actual.createLogger(scope),
      info: infoLogSpy,
      warn: warnLogSpy,
      error: errorLogSpy
    })
  }
})

// The real process-tree killer is exercised in process-tree.test.ts. Its Windows path early-returns
// without calling child.kill() when child.pid is undefined (as it is for FakeAgentProcess), which the
// POSIX path does not — so the shutdown orchestration tests here would flip on POSIX but not Windows.
// Mock it so .killed flips on every platform while preserving the orchestration the runtime relies on
// (shutdown calls terminate, awaits it, and gets back a { reaped } result). It defaults to a clean
// reaped:true; a dedicated test overrides one call with reaped:false to pin the AND-accumulation into
// the shutdown result (so dropping that accumulation in the runtime is caught).
vi.mock('../process-tree', () => ({
  terminateProcessTree: vi.fn(async (child?: { kill?: () => void }) => {
    child?.kill?.()
    return { reaped: true }
  })
}))

// Minimal child-process stand-in that exposes the streams the runtime expects.
class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  // Undefined by default (mirrors a not-yet-assigned pid); a test sets it to assert lifecycle logging.
  pid: number | undefined = undefined

  // Simulates a clean process shutdown and emits the normal exit signal.
  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

// Narrows the fake process into the runtime's child process type.
const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

// Creates a manually controlled promise for ordering async protocol steps.
const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

// Starts an in-memory fake agent that can create sessions, stream replies, and close sessions.
const startFakeAgent = (
  process: FakeAgentProcess,
  sessionIds: string[],
  options: {
    supportsResume?: boolean
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    // Option set the set_config_option RESPONSE reports back. Agents rebuild their options when a
    // switch invalidates them (effort levels are model-dependent), so this can differ from the
    // session/new set; defaults to echoing configOptions.
    updatedConfigOptions?: SessionConfigOption[]
    rejectSetConfigOption?: boolean
    // When true, the resume handler rejects with the ACP "Resource not found" (-32002) — the signal a
    // replaced agent (e.g. after a provider switch) gives for a session id it does not hold.
    resumeNotFound?: boolean
    // When true, the resume handler rejects with a generic "Internal error" (-32603) — what some
    // agents return instead of a clean not-found after their process was replaced by an app restart.
    resumeInternalError?: boolean
    // A plain handler error is serialized by the ACP SDK as -32603 with the original message in
    // data.details. This mirrors agents that do not translate their resume failure to resourceNotFound.
    resumeInternalErrorDetails?: string
    // Some agents preserve a machine-readable reason in the Internal error data instead of relying on
    // the human-facing detail string.
    resumeInternalErrorData?: unknown
    // opencode rejects a lost session with an Internal error tagged by the failing service and a
    // descriptive message suffix (e.g. `{ service: 'session' }` + "OpenCode service failure").
    resumeServiceFailure?: { service: string; message: string }
    // When true, the agent does NOT advertise session/close capability, so the runtime must fall back to
    // the session/cancel notification on delete instead of a close request.
    supportsClose?: boolean
    rejectModeChange?: boolean
    onSetMode?: (context: { sessionId: string; modeId: string }) => Promise<void> | void
    onClose?: (sessionId: string) => Promise<void> | void
    onPrompt?: (context: {
      sessionId: string
      text: string
      prompt: ContentBlock[]
    }) => Promise<PromptResponse | void> | PromptResponse | void
  } = {}
): {
  authRequests: unknown[]
  providerConfigurations: unknown[]
  prompts: Array<{ sessionId: string; text: string }>
  newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  resumedSessions: Array<{ sessionId: string; cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  closedSessions: string[]
  cancelledSessions: string[]
  modeChanges: Array<{ sessionId: string; modeId: string }>
  configChanges: Array<{ sessionId: string; configId: string; value: string | boolean }>
  actions: string[]
} => {
  const authRequests: unknown[] = []
  const providerConfigurations: unknown[] = []
  const prompts: Array<{ sessionId: string; text: string }> = []
  const newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }> = []
  const resumedSessions: Array<{
    sessionId: string
    cwd: string
    mcpServers: unknown[]
    _meta?: unknown
  }> = []
  const closedSessions: string[] = []
  const cancelledSessions: string[] = []
  const modeChanges: Array<{ sessionId: string; modeId: string }> = []
  const configChanges: Array<{ sessionId: string; configId: string; value: string | boolean }> = []
  const actions: string[] = []
  let sessionIndex = 0

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          ...(options.supportsClose === false ? {} : { close: {} }),
          ...(options.supportsResume === false ? {} : { resume: {} })
        }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      authRequests.push(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.providers.set, (ctx) => {
      providerConfigurations.push(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })
      // Return deterministic ids so the tests can assert exact routing.
      const sessionId = sessionIds[sessionIndex]
      sessionIndex += 1

      return {
        sessionId,
        modes: options.modes,
        ...(options.configOptions ? { configOptions: options.configOptions } : {})
      }
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (options.resumeNotFound) {
        throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
      }

      if (options.resumeInternalError) {
        throw acp.RequestError.internalError()
      }

      if (options.resumeInternalErrorDetails) {
        throw new Error(options.resumeInternalErrorDetails)
      }

      if (options.resumeInternalErrorData !== undefined) {
        throw acp.RequestError.internalError(options.resumeInternalErrorData)
      }

      if (options.resumeServiceFailure) {
        throw acp.RequestError.internalError(
          { service: options.resumeServiceFailure.service },
          options.resumeServiceFailure.message
        )
      }

      resumedSessions.push({
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers ?? [],
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })

      return { modes: options.modes }
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      if (options.rejectModeChange) throw new Error('set mode failed')
      const recordModeChange = (): Record<string, never> => {
        modeChanges.push({ sessionId: ctx.params.sessionId, modeId: ctx.params.modeId })
        actions.push(`mode:${ctx.params.modeId}`)
        return {}
      }
      const pending = options.onSetMode?.({
        sessionId: ctx.params.sessionId,
        modeId: ctx.params.modeId
      })
      return pending ? pending.then(recordModeChange) : recordModeChange()
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
      if (options.rejectSetConfigOption) throw acp.RequestError.internalError()

      configChanges.push({
        sessionId: ctx.params.sessionId,
        configId: ctx.params.configId,
        value: ctx.params.value
      })

      return { configOptions: options.updatedConfigOptions ?? options.configOptions ?? [] }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      // Flatten text blocks because these tests only exercise plain prompts.
      const text = ctx.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')

      prompts.push({ sessionId: ctx.params.sessionId, text })
      actions.push(`prompt:${text}`)
      const promptResponse = await options.onPrompt?.({
        sessionId: ctx.params.sessionId,
        text,
        prompt: ctx.params.prompt
      })
      // Stream one assistant chunk through the client callback path before stopping.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: {
            type: 'text',
            text: `reply for ${ctx.params.sessionId}`
          }
        }
      })
      return promptResponse ?? { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      cancelledSessions.push(ctx.params.sessionId)
      return undefined
    })
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      const recordClose = (): Record<string, never> => {
        closedSessions.push(ctx.params.sessionId)
        return {}
      }
      const pending = options.onClose?.(ctx.params.sessionId)
      return pending ? pending.then(recordClose) : recordClose()
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return {
    authRequests,
    providerConfigurations,
    prompts,
    newSessions,
    resumedSessions,
    closedSessions,
    cancelledSessions,
    modeChanges,
    configChanges,
    actions
  }
}

const createModes = (
  ids: string[],
  currentModeId: string = ids[0] ?? 'default'
): SessionModeState => ({
  currentModeId,
  availableModes: ids.map((id) => ({ id, name: id }))
})

let temporaryRoot: string | undefined

const createTemporaryRoot = async (): Promise<string> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-artifacts-'))
  return temporaryRoot
}

const getEnvValue = (mcpServer: unknown, name: string): string => {
  if (
    typeof mcpServer !== 'object' ||
    mcpServer === null ||
    !('env' in mcpServer) ||
    !Array.isArray((mcpServer as { env?: unknown }).env)
  ) {
    throw new Error('Missing MCP server env array')
  }

  const entry = (mcpServer as { env: Array<{ name?: unknown; value?: unknown }> }).env.find(
    (item) => item.name === name
  )

  if (typeof entry?.value !== 'string') {
    throw new Error(`Missing env value: ${name}`)
  }

  return entry.value
}

// Starts a fake agent that fires one permission request per prompt so the runtime's audit line
// (which carries isMcp) can be asserted black-box. `resume` selects the session/resume behavior:
// 'ok' resolves resume (reattach), 'notFound' rejects with resourceNotFound so the runtime adopts a
// fresh session under the same app id. session/new always returns `newSessionId`.
const startPermissionProbeAgent = (
  process: FakeAgentProcess,
  options: {
    newSessionId: string
    toolCallId: string
    toolTitle: string
    toolKind?: 'other' | 'execute' | 'read' | null
    providerToolName?: string
    codexMcpIdentity?: {
      server: string
      tool: string
      arguments?: Record<string, unknown>
    }
    sparseCodexMcpApproval?: boolean
    modes?: SessionModeState
    permissionOptions?: Array<{
      optionId: string
      name: string
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
    }>
    onPermissionResponse?: (response: unknown) => void
    resume?: 'ok' | 'notFound'
  }
): void => {
  acp
    .agent({ name: 'permission-probe-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, ...(options.resume ? { resume: {} } : {}) }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: options.newSessionId,
      modes: options.modes
    }))
    .onRequest(acp.methods.agent.session.setMode, () => ({}))
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (options.resume === 'notFound') {
        throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
      }

      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      if (options.codexMcpIdentity) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: options.toolCallId,
            kind: 'execute',
            title: `mcp.${options.codexMcpIdentity.server}.${options.codexMcpIdentity.tool}`,
            status: 'pending',
            rawInput: {
              server: options.codexMcpIdentity.server,
              tool: options.codexMcpIdentity.tool,
              arguments: options.codexMcpIdentity.arguments ?? {}
            },
            _meta: { is_mcp_tool_call: true }
          }
        })
      }

      // opencode renames MCP tools <server>_<tool>; classification must come from the session's
      // recorded MCP server names, so this exercises the sessionMcpServerNames map end to end.
      const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: options.toolCallId,
          ...(options.sparseCodexMcpApproval ? {} : { title: options.toolTitle }),
          status: 'pending',
          ...(options.toolKind === null
            ? {}
            : { kind: options.toolKind ?? (options.sparseCodexMcpApproval ? 'execute' : 'other') }),
          ...(!options.sparseCodexMcpApproval && options.providerToolName
            ? { _meta: { claudeCode: { toolName: options.providerToolName } } }
            : {})
        },
        options: options.permissionOptions ?? [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
        ],
        ...(options.sparseCodexMcpApproval ? { _meta: { is_mcp_tool_approval: true } } : {})
      })
      options.onPermissionResponse?.(response)

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )
}

// White-box view of the per-session MCP name map so cleanup paths (no black-box signal) can be
// asserted directly.
const mcpServerNamesMap = (runtime: AcpRuntime): Map<string, string[]> =>
  (runtime as unknown as { sessionMcpServerNames: Map<string, string[]> }).sessionMcpServerNames

const agentToAppSessionMap = (runtime: AcpRuntime): Map<string, string> =>
  (runtime as unknown as { agentToAppSessionId: Map<string, string> }).agentToAppSessionId

const sessionFrameworksMap = (runtime: AcpRuntime): Map<string, string> =>
  (runtime as unknown as { sessionFrameworks: Map<string, string> }).sessionFrameworks

const contextUsageMap = (runtime: AcpRuntime): Map<string, { used: number; size: number }> =>
  (
    runtime as unknown as {
      contextUsageBySession: Map<string, { used: number; size: number }>
    }
  ).contextUsageBySession

const handleSessionUpdate = (runtime: AcpRuntime, notification: SessionNotification): void =>
  (
    runtime as unknown as {
      handleSessionUpdate: (value: SessionNotification) => void
    }
  ).handleSessionUpdate(notification)

const reviewerSessionIds = (runtime: AcpRuntime): Set<string> =>
  (runtime as unknown as { reviewerSessionIds: Set<string> }).reviewerSessionIds

const codexMcpToolIdentitiesMap = (runtime: AcpRuntime): Map<string, Map<string, unknown>> =>
  (runtime as unknown as { codexMcpToolIdentities: Map<string, Map<string, unknown>> })
    .codexMcpToolIdentities

const observeCodexMcpToolIdentity = (
  runtime: AcpRuntime,
  notification: SessionNotification
): void =>
  (
    runtime as unknown as {
      observeCodexMcpToolIdentity: (value: SessionNotification) => void
    }
  ).observeCodexMcpToolIdentity(notification)

// Finds the isMcp flag the runtime logged for a given permission request (identified by toolCallId).
const auditedIsMcp = (toolCallId: string): boolean | undefined => {
  const call = infoLogSpy.mock.calls.find(
    ([message, data]) =>
      message === 'permission request received' &&
      (data as { toolCallId?: string }).toolCallId === toolCallId
  )

  return (call?.[1] as { isMcp?: boolean } | undefined)?.isMcp
}

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('ACP runtime migration write-gate', () => {
  afterEach(() => {
    // migration-state is a module singleton; clear it so a pending gate can't leak between tests.
    clearMigrationPending()
  })

  it('authenticates over ACP after initialize without putting the key in spawn env', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['authenticated-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        authentication: {
          methodId: 'api-key',
          _meta: { 'api-key': { apiKey: 'test-only-key' } }
        },
        providerConfiguration: {
          providerId: 'custom-gateway',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer local-token' }
        }
      })
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.authRequests).toEqual([
      { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'test-only-key' } } }
    ])
    expect(fakeAgent.providerConfigurations).toEqual([
      {
        providerId: 'custom-gateway',
        apiType: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        headers: { authorization: 'Bearer local-token' }
      }
    ])
  })

  it('rejects session creation when a required subscription model is unavailable', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['subscription-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: 'gpt-subscription',
        sessionModelRequired: true
      }),
      framework: codexFramework
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
      'The selected model "gpt-subscription" is not available for this Codex account.'
    )
  })

  it('rejects session creation when a required subscription model cannot be applied', async () => {
    const process = new FakeAgentProcess()
    const configOptions = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'gpt-default',
        options: [{ value: 'gpt-subscription', name: 'GPT Subscription' }]
      } as SessionConfigOption
    ]
    startFakeAgent(process, ['subscription-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      },
      configOptions,
      rejectSetConfigOption: true
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: 'gpt-subscription',
        sessionModelRequired: true
      }),
      framework: codexFramework
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
      'The selected model "gpt-subscription" could not be applied'
    )
  })

  it('skips set_config_option when a required subscription model already matches currentValue', async () => {
    // codex-acp reloads on every session/set_config_option call, which would stall the first prompt
    // of a new session for ~2 min when the model was already seeded via CODEX_CONFIG (issue #277).
    // When the agent reflects that seeded model as its option's currentValue, applySessionModel must
    // treat it as a successful no-op instead of (a) re-applying the same value or (b) collapsing it
    // into the required-model "not available" failure path. Verified end-to-end here.
    const process = new FakeAgentProcess()
    const configOptions = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'gpt-5.6-terra',
        options: [
          { value: 'gpt-5', name: 'GPT-5' },
          { value: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' }
        ]
      } as SessionConfigOption
    ]
    const fakeAgent = startFakeAgent(process, ['subscription-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      },
      configOptions
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: 'gpt-5.6-terra',
        sessionModelRequired: true
      }),
      framework: codexFramework
    })

    // createSession must succeed: the model is required, but it is already current — the runtime
    // must not mistake that for an unavailable model.
    const created = await runtime.createSession({ cwd: '/workspace' })
    expect(created.sessionId).toBe('subscription-session')
    // And it must NOT re-send set_config_option: that is exactly the round-trip we are trying to
    // avoid for codex-isolated subscriptions whose model is already seeded via CODEX_CONFIG.
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('rejects sendPrompt while a data-root migration is pending, then resumes once cleared', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['gated-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    beginMigration()
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'blocked' })
    ).rejects.toThrow(/moving your data/i)
    // The turn never reached the agent.
    expect(fakeAgent.prompts).toEqual([])

    clearMigrationPending()
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'allowed' })
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'gated-session', text: 'allowed' }])
  })

  it('keeps migration drain pending until a prompt that already started finishes', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['drain-session'], {
      onPrompt: () => promptGate.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    const promptPromise = runtime.sendPrompt({ sessionId: session.sessionId, text: 'running' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    promptGate.resolve()
    await promptPromise
    await drainPromise
    expect(drained).toBe(true)
  })
})

describe('ACP runtime session management', () => {
  it('injects activity-group declarations into main sessions but not reviewer sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['main-session', 'reviewer-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      activityGroups: { mcpEntryPath: '/app/out/main/index.js' }
    })

    const mainSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: mainSession.sessionId, text: 'Search PubMed' })

    expect(fakeAgent.newSessions[0].mcpServers).toEqual([
      expect.objectContaining({
        name: ACTIVITY_GROUP_MCP_SERVER_NAME,
        args: ['/app/out/main/index.js', '--open-science-activity-group-mcp']
      })
    ])
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).toContain(BEGIN_ACTIVITY_GROUP_TOOL_NAME)
    expect(fakeAgent.prompts[0].text).toContain('mcp__open-science-activity__begin_activity_group')
    expect(fakeAgent.prompts[0].text).toContain('Before each coherent tool group this turn')

    const reviewerServer = {
      type: 'http' as const,
      name: 'open-science-reviewer',
      url: 'http://127.0.0.1:1/mcp',
      headers: []
    }
    const { session: reviewerSession } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [reviewerServer],
      systemPromptAppend: 'Reviewer-only instructions'
    })
    await reviewerSession.prompt([{ type: 'text', text: 'Review this turn' }])

    expect(fakeAgent.newSessions[1].mcpServers).toEqual([reviewerServer])
    expect(JSON.stringify(fakeAgent.newSessions[1]._meta)).not.toContain(
      BEGIN_ACTIVITY_GROUP_TOOL_NAME
    )
    expect(fakeAgent.prompts[1].text).toBe('Review this turn')
  })

  it.each([
    ['opencode', opencodeFramework],
    ['codex', codexFramework]
  ] as const)(
    'injects activity-group tooling and prompt guidance for %s',
    async (_name, framework) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['main-session'], {
        modes:
          framework.id === 'codex'
            ? createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
            : undefined
      })
      const runtime = new AcpRuntime({
        appVersion: '0.2.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework,
        activityGroups: { mcpEntryPath: '/app/out/main/index.js' }
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Inspect the project' })

      expect(fakeAgent.newSessions[0].mcpServers).toEqual([
        expect.objectContaining({ name: ACTIVITY_GROUP_MCP_SERVER_NAME })
      ])
      expect(fakeAgent.prompts[0].text).toContain(BEGIN_ACTIVITY_GROUP_TOOL_NAME)
    }
  )
  it('applies native Full access before the first prompt', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['full-session'], {
      modes: createModes(['default', 'bypassPermissions'])
    })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })

    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId: 'bypassPermissions',
      fullAccessAvailable: true
    })
    expect(fakeAgent.modeChanges).toEqual([
      { sessionId: 'full-session', modeId: 'bypassPermissions' }
    ])

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue' })

    expect(fakeAgent.actions).toEqual(['mode:bypassPermissions', 'prompt:continue'])
  })

  it('kills the agent process synchronously on shutdown so it cannot outlive the app', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['shutdown-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(process.killed).toBe(false)

    // shutdown() is synchronous (will-quit cannot await): the child must be signalled before it returns.
    runtime.shutdown()
    expect(process.killed).toBe(true)

    // Calling it again after the process is gone is a no-op, not a crash.
    expect(() => runtime.shutdown()).not.toThrow()
  })

  it('kills a child that finishes spawning after shutdown began, so quit-during-connect cannot orphan it', async () => {
    const process = new FakeAgentProcess()
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      // Model the app quitting mid-spawn: shutdown() lands before this child is handed back to connect.
      spawnAgent: () => {
        runtime.shutdown()
        return asAgentProcess(process)
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/shutting down/)

    // The child that spawned after killAgentProcess ran must still be terminated, not left as an orphan.
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()
  })

  it('shutdownForQuit awaits agent teardown so app.exit cannot race a live child', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['quit-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(process.killed).toBe(false)

    // The awaited quit path must have terminated the agent by the time it resolves.
    const outcome = await runtime.shutdownForQuit()
    expect(outcome).toHaveProperty('reaped')
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()
  })

  it('shutdownForQuit propagates a degraded reaped:false from the agent tree teardown', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['degraded-reap-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    // Model a teardown that killed the direct child but could not confirm the whole tree is gone (e.g. a
    // Windows taskkill fallback, or a POSIX descendant that survived). The runtime must AND-accumulate
    // this into the shutdown result so the quit/update-gate caller can refuse to race app.exit — a plain
    // `reaped: true` return here would hide a regression that stops accumulating result.reaped.
    vi.mocked(terminateProcessTree).mockImplementationOnce(
      async (child?: { kill?: () => void }) => {
        child?.kill?.()
        return { reaped: false }
      }
    )

    const outcome = await runtime.shutdownForQuit()
    expect(outcome).toEqual({ reaped: false })
    expect(process.killed).toBe(true)
  })

  it('restarts a stuck agent when prompt cancellation times out', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['cancel-timeout-session'], {
      onPrompt: () => promptGate.promise
    })
    let fireCancelTimeout: (() => void) | undefined
    const events: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      cancelTimeoutMs: 1,
      setTimer: (callback) => {
        fireCancelTimeout = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: vi.fn(),
      callbacks: { onEvent: (event) => events.push(event.title ?? '') }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'stay pending' })
    void prompt.catch(() => undefined)
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    await runtime.cancelPrompt({ sessionId: session.sessionId })
    await vi.waitFor(() => expect(fakeAgent.cancelledSessions).toEqual(['cancel-timeout-session']))
    expect(fireCancelTimeout).toBeDefined()
    fireCancelTimeout?.()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    expect(process.killed).toBe(true)
    expect(events).toContain('Prompt cancellation timed out')
    promptGate.resolve()
  })

  it('terminates the remaining process and clears sessions after an unexpected protocol close', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['unexpected-close-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.stdout.end()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    await vi.waitFor(() => expect(process.killed).toBe(true))
    expect(runtime.getSnapshot().sessionIds).toEqual([])
  })

  it('shutdownForQuit latches shutting-down so a later connect is refused', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['quit-latch-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.shutdownForQuit()

    // The latch makes a subsequent connect self-abort rather than spawn a fresh, orphanable agent.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/shutting down/)
  })

  it('shutdownForUpdateGate reaps the agent without latching, so the app can reconnect', async () => {
    const spawns: FakeAgentProcess[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      // A fresh agent per connect, mirroring a real reconnect after the gate tore the previous one down.
      spawnAgent: () => {
        const process = new FakeAgentProcess()
        startFakeAgent(process, [`gate-session-${spawns.length}`])
        spawns.push(process)
        return asAgentProcess(process)
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const outcome = await runtime.shutdownForUpdateGate()

    expect(outcome).toHaveProperty('reaped')
    expect(spawns[0]?.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()

    // Non-latching: a fresh session connects instead of throwing "shutting down".
    await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toBeDefined()
    expect(spawns).toHaveLength(2)
  })

  it('shutdownForQuit waits out an in-flight connect and reaps the mid-spawn child before resolving', async () => {
    const process = new FakeAgentProcess()
    let quitPromise: Promise<{ reaped: boolean }> | undefined
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      // Model quit landing mid-spawn on the async path: start the quit teardown, then hand back the
      // freshly-spawned child. shutdownForQuit must await this in-flight connect so connectFresh reaches
      // its shutting-down check and tree-kills the child before the teardown resolves — otherwise
      // app.exit() would run first and orphan it.
      spawnAgent: () => {
        quitPromise = runtime.shutdownForQuit()
        return asAgentProcess(process)
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/shutting down/)
    expect(quitPromise).toBeDefined()
    await quitPromise
    // The child spawned mid-connect has been reaped by the time the quit teardown resolves.
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()
  })

  it('shutdownForQuit kills an assigned agent instead of waiting on a stalled initialize', async () => {
    const process = new FakeAgentProcess()
    // No startFakeAgent: the agent never answers initialize, so connect() assigns the child and then
    // stalls. shutdownForQuit must kill that assigned child rather than wait out the hung connect.
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const connecting = runtime.createSession({ cwd: '/workspace' }).catch(() => undefined)
    // Let connectFresh assign this.agentProcess and reach the (unanswered) initialize await.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(process.killed).toBe(false)

    // Must resolve promptly (not hang until shutdownBackends' timeout) with the child reaped.
    await runtime.shutdownForQuit()
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()
    await connecting
  })

  it('shutdownForUpdateGate reaps a mid-spawn child, then stays non-latching so the app can reconnect', async () => {
    const midSpawn = new FakeAgentProcess()
    let gatePromise: Promise<{ reaped: boolean }> | undefined
    let spawnCount = 0
    const reconnectSpawns: FakeAgentProcess[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        spawnCount += 1
        if (spawnCount === 1) {
          // Model the update gate landing while a connect is inside spawnAgentProcess: start the gate
          // teardown, then hand back the freshly-spawned child. The gate must latch shutting-down for
          // its duration so connectFresh's check reaps this child; otherwise it is assigned after the
          // generation bump and outlives a clean-reported gate, holding the very files the NSIS
          // installer must delete open.
          gatePromise = runtime.shutdownForUpdateGate()
          return asAgentProcess(midSpawn)
        }
        const process = new FakeAgentProcess()
        startFakeAgent(process, [`gate-reconnect-${reconnectSpawns.length}`])
        reconnectSpawns.push(process)
        return asAgentProcess(process)
      }
    })

    // The gate bumped the generation (no shutting-down latch), so the mid-spawn connect self-aborts on
    // the stale-generation check rather than a shutdown latch.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/superseded/)
    expect(gatePromise).toBeDefined()
    const outcome = await gatePromise
    expect(outcome).toHaveProperty('reaped')
    // The mid-spawn child was reaped, not left orphaned holding the install dir open.
    expect(midSpawn.killed).toBe(true)

    // Non-latching: once the gate resolves, a fresh connect succeeds (no lasting shutting-down latch).
    await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toBeDefined()
    expect(reconnectSpawns).toHaveLength(1)
  })

  it('shutdownForUpdateGate never latches shutting-down, so an abandoned (hung) teardown still reconnects', async () => {
    // Models the P2 timeout shape: the gate's in-flight connect hangs inside spawnAgentProcess, so the
    // gate's own await never settles and runBounded abandons it once the budget elapses. Because the gate
    // must NOT set a shutting-down latch (it would never clear on an abandoned teardown), a fresh connect
    // afterward has to succeed instead of self-aborting forever.
    const neverResolving = new Promise<never>(() => {})
    const reconnect = new FakeAgentProcess()
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        spawnCount += 1
        if (spawnCount === 1) {
          // Hang the spawn so the connect (and thus the gate awaiting it) never settles.
          return neverResolving as unknown as ChildProcessWithoutNullStreams
        }
        startFakeAgent(reconnect, ['gate-after-hang'])
        return asAgentProcess(reconnect)
      }
    })

    // Start a connect that wedges mid-spawn; do not await it.
    const hung = runtime.createSession({ cwd: '/workspace' }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Fire the gate but do NOT await it — it hangs on the never-settling in-flight connect, exactly as
    // runBounded would then abandon at the deadline before any cleanup could clear a latch.
    void runtime.shutdownForUpdateGate()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Refused-install contract: the runtime is not wedged, so a fresh connect succeeds.
    await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toBeDefined()
    expect(spawnCount).toBe(2)
    void hung
  })

  it('reports conservative Auto when the Agent has no native auto mode', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['auto-session'], {
      modes: createModes(['default', 'bypassPermissions'])
    })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'auto' })

    expect(fakeAgent.modeChanges).toEqual([])
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'auto',
      currentModeId: 'default',
      autoReviewStrategy: 'conservative'
    })
  })

  it('rejects Full access when native bypass is not advertised', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['full-session'], { modes: createModes(['default']) })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })
    ).rejects.toThrow('Full access is not available')
    expect(runtime.getSnapshot().sessionIds).toEqual([])
  })

  it('creates protocol sessions and routes prompts by session id', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: first.sessionId, text: 'hello first' })
    await runtime.sendPrompt({ sessionId: second.sessionId, text: 'hello second' })

    expect(first.sessionId).toBe('remote-session-1')
    expect(second.sessionId).toBe('remote-session-2')
    expect(fakeAgent.prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'hello first' },
      { sessionId: 'remote-session-2', text: 'hello second' }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' },
        { sessionId: 'remote-session-2', text: 'reply for remote-session-2' }
      ])
    )
  })

  it('sends staged uploads as ACP prompt content blocks', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        {
          name: 'paste.png',
          mimeType: 'image/png',
          content: Buffer.from('png-bytes').toString('base64')
        },
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          content: Buffer.from('hello from upload').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: {
        repository: uploadRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'review these attachments',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][0]).toEqual({
      type: 'text',
      text: 'review these attachments'
    })
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
      uri: expect.stringContaining('/uploads/default-project/remote-session-1/paste.png')
    })
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        text: 'hello from upload',
        uri: expect.stringContaining('/uploads/default-project/remote-session-1/notes.txt')
      }
    })
    await expect(
      readFile(join(root, 'uploads', 'default-project', 'remote-session-1', 'notes.txt'), 'utf8')
    ).resolves.toBe('hello from upload')
  })

  it('inlines an image attachment as pixels when the browser sent no usable MIME type', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // Some drag/drop and paste sources omit the MIME (undefined) or send a generic octet-stream; the
    // runtime must still recognize these as images by extension and send real pixels, not a file link.
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        {
          name: 'no-mime.png',
          mimeType: undefined,
          content: Buffer.from('png-a').toString('base64')
        },
        {
          name: 'generic.png',
          mimeType: 'application/octet-stream',
          content: Buffer.from('png-b').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'what is in these',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    // Both files are sent as base64 image blocks with the extension-derived canonical MIME — not the
    // resource_link a missing/generic MIME would have produced before the fallback existed.
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-a').toString('base64')
    })
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-b').toString('base64')
    })
  })

  it('degrades an image attachment to a resource link when replay images consume the inline budget', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const [attachment] = await uploadRepository.stageFiles({
      files: [
        {
          name: 'overflow.png',
          mimeType: 'image/png',
          content: Buffer.from('small-image').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['image-budget-session'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const replayData = 'a'.repeat(MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES / 6)

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'continue with this image',
      historyImages: Array.from({ length: 6 }, () => ({
        mimeType: 'image/png' as const,
        data: replayData,
        byteLength: Math.floor((replayData.length * 3) / 4)
      })),
      attachments: [attachment]
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0].filter((block) => block.type === 'image')).toHaveLength(6)
    expect(receivedPrompts[0].at(-1)).toMatchObject({
      type: 'resource_link',
      name: 'overflow.png',
      mimeType: 'image/png',
      uri: expect.stringContaining('overflow.png')
    })
  })

  it('degrades images to file links once a session exceeds its cumulative inline budget', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    // A tiny budget makes small fixtures cross the cliff: the first image inlines, the next degrades
    // because the conversation's replayed history already holds the first image's bytes.
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository },
      inlineImageBudgetBytes: 15
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    const stageImage = (name: string): Promise<UploadedAttachment[]> =>
      uploadRepository.stageFiles({
        files: [
          { name, mimeType: 'image/png', content: Buffer.from('png-bytes').toString('base64') }
        ]
      })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'first image',
      attachments: await stageImage('first.png')
    })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'second image',
      attachments: await stageImage('second.png')
    })

    expect(receivedPrompts).toHaveLength(2)
    // First turn: within budget, so the pixels are inlined as base64.
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64')
    })
    // Second turn: the accumulated total would overflow, so the image degrades to a file reference
    // instead of base64 — keeping the request under the ceiling so compaction stays viable.
    expect(receivedPrompts[1][1]).toMatchObject({
      type: 'resource_link',
      name: 'second.png',
      title: 'second.png',
      mimeType: 'image/png',
      uri: expect.stringContaining('second.png')
    })
    // The raw image bytes must not be inlined anywhere in the degraded turn.
    expect(JSON.stringify(receivedPrompts[1])).not.toContain(
      Buffer.from('png-bytes').toString('base64')
    )
  })

  it('sends an oversized text upload as a bounded preview + resource_link, never the full contents', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // A >512 KB CSV: a unique marker after the preview window must never reach the prompt.
    const header = 'id,name,value\n'
    const filler = Array.from({ length: 60_000 }, (_, i) => `${i},row,${i}`).join('\n')
    const tailMarker = '\nSENTINEL_PAST_PREVIEW_WINDOW'
    const csvBody = `${header}${filler}${tailMarker}`
    expect(Buffer.byteLength(csvBody, 'utf8')).toBeGreaterThan(512 * 1024)
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        { name: 'big.csv', mimeType: 'text/csv', content: Buffer.from(csvBody).toString('base64') }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'analyze this table',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    const [prompt] = receivedPrompts
    // Order is preserved: user text, then the file's preview notice, then its link.
    expect(prompt[0]).toEqual({ type: 'text', text: 'analyze this table' })
    const notice = prompt[1] as Extract<ContentBlock, { type: 'text' }>
    expect(notice.type).toBe('text')
    expect(notice.text).toContain('big.csv')
    expect(notice.text).toContain('too large to include in full')
    expect(notice.text).toContain('id,name,value')
    expect(prompt[2]).toMatchObject({
      type: 'resource_link',
      name: 'big.csv',
      mimeType: 'text/csv',
      uri: expect.stringContaining('/uploads/default-project/remote-session-1/big.csv')
    })
    // The full contents are never inlined: no `resource` block, and the past-preview marker never ships.
    expect(prompt.some((block) => block.type === 'resource')).toBe(false)
    expect(JSON.stringify(prompt)).not.toContain('SENTINEL_PAST_PREVIEW_WINDOW')
  })

  it('adopts a fresh agent session under the same app id on a context reset', async () => {
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    // A second agent session id is available for the fresh adoption that the reset performs.
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const reset = await runtime.resetSessionContext({
      sessionId: session.sessionId,
      cwd: '/workspace'
    })

    // The app-facing id stays attached (a brand-new agent session now backs it), and the caller is told
    // to replay a transcript because the agent-side context was dropped.
    expect(reset.contextReset).toBe(true)
    expect(reset.sessionId).toBe(session.sessionId)
    expect(runtime.getSnapshot().sessionIds).toContain(session.sessionId)

    // The fresh session still accepts prompts, so the conversation continues after the reset.
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue after compaction' })
    expect(receivedPrompts.at(-1)).toBeDefined()
  })

  it('clears the previous context usage before a context reset replacement reports usage', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    contextUsageMap(runtime).set(session.sessionId, { used: 6400, size: 128000 })

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })

    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})
  })

  it('releases the in-flight prompt lock on reset so the recovery resend is not rejected', async () => {
    const process = new FakeAgentProcess()
    // Only the first prompt is gated so it stays in-flight — the overflow-recovery reset happens while it
    // is still "running", exactly as in production before the failing prompt's finally clears the lock.
    // Disposing that session rejects the gated prompt, so its promise is caught up front.
    const promptGate = createDeferred()
    let firstPrompt = true
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: () => {
        if (firstPrompt) {
          firstPrompt = false
          return promptGate.promise
        }
        return Promise.resolve()
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const inflight = runtime
      .sendPrompt({ sessionId: session.sessionId, text: 'oversized turn' })
      .catch(() => undefined)
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)
    )

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })

    // The lock the torn-down turn held is released immediately by the reset.
    expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)

    // Once the disposed turn has settled, a resend into the same app id succeeds instead of throwing
    // "An ACP prompt is already running for this session".
    promptGate.resolve()
    await inflight
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'replayed turn' })
    ).resolves.toBeDefined()
  })

  it('does not let a superseded turn finally clear the replay turn in-flight lock', async () => {
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    // Hold the abandoned turn's finally open (at emitArtifactRunEvent) until the replay turn has claimed
    // the lock, reproducing production timing where the renderer resends immediately after the reset.
    const listGate = createDeferred()
    vi.spyOn(artifactRepository, 'listPendingRunFiles').mockImplementation(async () => {
      await listGate.promise
      return []
    })

    const process = new FakeAgentProcess()
    // Both prompts stay in-flight so their locks are held; the first is abandoned by the reset.
    const gateA = createDeferred()
    const gateB = createDeferred()
    let firstPrompt = true
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: () => {
        if (firstPrompt) {
          firstPrompt = false
          return gateA.promise
        }
        return gateB.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    // The lock is claimed synchronously at turn start, so no polling is needed to observe it.
    const failedTurn = runtime
      .sendPrompt({ sessionId: session.sessionId, text: 'oversized turn' })
      .catch(() => undefined)
    expect(runtime.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

    // Reset abandons the failed turn (its finally now blocks on the gated listPendingRunFiles — before it
    // reaches its own lock cleanup) and frees the lock so the replay can start.
    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
    expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)

    // The replay turn re-claims the lock for the same app session id while the abandoned turn's finally is
    // still parked in listPendingRunFiles.
    const replayTurn = runtime
      .sendPrompt({ sessionId: session.sessionId, text: 'replayed turn' })
      .catch(() => undefined)
    expect(runtime.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

    // Let the abandoned turn's finally run to completion — its generation token is now stale, so it must
    // not delete the replay turn's lock. This is the assertion that fails without the guard.
    listGate.resolve()
    await failedTurn
    expect(runtime.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

    // Teardown: release both prompt gates so the fake agent can drain (the abandoned turn's server-side
    // handler is still parked on its gate, which otherwise blocks the replay from completing).
    gateA.resolve()
    gateB.resolve()
    await replayTurn
  })

  it('sends PDFs as extracted text, never as an inlined base64 file', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // Non-PDF bytes make extraction fail deterministically; the block must still be text, not the file.
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        {
          name: 'doc.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('not a real pdf payload').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'summarize this pdf',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    const pdfBlock = receivedPrompts[0][1]
    expect(pdfBlock.type).toBe('resource')
    expect(pdfBlock).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        uri: expect.stringContaining('/uploads/default-project/remote-session-1/doc.pdf')
      }
    })
    // The raw file bytes must never be inlined as base64 anywhere in the prompt.
    const rawBase64 = Buffer.from('not a real pdf payload').toString('base64')
    const serialized = JSON.stringify(receivedPrompts[0])
    expect(serialized).not.toContain(rawBase64)
    expect(receivedPrompts[0].some((block) => block.type === 'image')).toBe(false)
    // Headroom for the one-time dynamic import of the large pdfjs-dist bundle, whose ESM resolution
    // is markedly slower on a cold Windows CI runner and can exceed the 5s default there.
  }, 30000)

  it('attributes app-side artifact writes to the calling session while another turn is in flight', async () => {
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    const process = new FakeAgentProcess()
    const gateA = createDeferred()
    const gateB = createDeferred()
    const fakeAgent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: ({ sessionId }) =>
        sessionId === 'remote-session-1' ? gateA.promise : gateB.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/unused',
        repository: artifactRepository
      }
    })

    const sessionA = await runtime.createSession({ cwd: '/workspace' })
    const sessionB = await runtime.createSession({ cwd: '/workspace' })

    // Hold both turns open so both sessions have an active artifact run at the same time — the exact
    // condition a single global "current run" mis-attributes.
    const promptA = runtime.sendPrompt({ sessionId: sessionA.sessionId, text: 'a' })
    const promptB = runtime.sendPrompt({ sessionId: sessionB.sessionId, text: 'b' })
    // Both prompts have reached the agent, so both sessions' artifact runs are now active.
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))

    const artifactA = await runtime.writeArtifactForCurrentRun(sessionA.sessionId, {
      filename: 'a.txt',
      content: 'from A'
    })
    const artifactB = await runtime.writeArtifactForCurrentRun(sessionB.sessionId, {
      filename: 'b.txt',
      content: 'from B'
    })

    // Each write lands in its own session's distinct run, never a shared global one.
    expect(artifactA.sessionId).not.toBe(artifactB.sessionId)
    expect(artifactA.runId).not.toBe(artifactB.runId)
    expect(artifactA.path).toContain(artifactA.sessionId)
    expect(artifactB.path).toContain(artifactB.sessionId)

    // A write with no live run for the session fails closed instead of falling back to another run.
    await expect(
      runtime.writeArtifactForCurrentRun('unknown-session', { filename: 'x.txt', content: 'x' })
    ).rejects.toThrow(/active assistant turn/)

    gateA.resolve()
    gateB.resolve()
    await Promise.all([promptA, promptB])
  })

  it('appends referenced artifacts as content blocks by file type', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const artifactRepository = new ArtifactRepository(root)

    // A referenced upload (an already-staged file) resolves through the upload path validator.
    const [uploadRef] = await uploadRepository.stageFiles({
      files: [
        {
          name: 'summary.txt',
          mimeType: 'text/plain',
          content: Buffer.from('referenced upload text').toString('base64')
        }
      ]
    })

    // A referenced image output resolves through the artifact path validator and inlines its pixels.
    const imageArtifact = await artifactRepository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'chart.png',
      mimeType: 'image/png',
      source: {
        kind: 'inline',
        content: Buffer.from('png-bytes').toString('base64'),
        encoding: 'base64'
      }
    })

    // A referenced binary output has no rich representation, so it falls through to a resource link.
    const binaryArtifact = await artifactRepository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'data.bin',
      mimeType: 'application/octet-stream',
      source: {
        kind: 'inline',
        content: Buffer.from([0, 1, 2, 3]).toString('base64'),
        encoding: 'base64'
      }
    })

    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'use these files',
      referencedArtifacts: [
        {
          id: 'u1',
          name: uploadRef.originalName,
          path: uploadRef.path,
          source: 'upload',
          mimeType: uploadRef.mimeType
        },
        {
          id: 'a1',
          name: imageArtifact.name,
          path: imageArtifact.path,
          source: 'artifact',
          mimeType: imageArtifact.mimeType
        },
        {
          id: 'a2',
          name: binaryArtifact.name,
          path: binaryArtifact.path,
          source: 'artifact',
          mimeType: binaryArtifact.mimeType
        }
      ]
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][0]).toEqual({ type: 'text', text: 'use these files' })
    // Referenced upload text file -> inline resource with its contents.
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        text: 'referenced upload text',
        uri: expect.stringContaining('summary.txt')
      }
    })
    // Referenced image artifact -> base64 image block.
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
      uri: expect.stringContaining('chart.png')
    })
    // Referenced binary artifact -> resource link.
    expect(receivedPrompts[0][3]).toMatchObject({
      type: 'resource_link',
      name: 'data.bin',
      title: 'data.bin',
      mimeType: 'application/octet-stream',
      uri: expect.stringContaining('data.bin')
    })
  })

  it('resolves a bare-filename artifact write against the final-session notebook dir despite the alias', async () => {
    // Regression for the alias/final-id mismatch: the notebook MCP env is built at session creation
    // under a pre-start alias, but kernels write under the FINAL ACP session id. The per-turn handoff
    // must pin the kernel dir/root by that final id so a relative/bare artifact write resolves — and
    // the write must succeed even though the static allowedImportRoots only knew the alias.
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    const finalSessionId = 'remote-session-1'
    // The kernel's real cwd for this session, keyed by the FINAL id (not the notebook alias).
    const notebookDataDir = join(root, 'notebooks', 'default-project', finalSessionId, 'data')
    await mkdir(notebookDataDir, { recursive: true })
    await writeFile(join(notebookDataDir, 'sine.png'), 'PNGDATA', 'utf8')

    let writtenPath: string | undefined
    let capturedContext: Record<string, unknown> | undefined
    let captureError: unknown

    const process = new FakeAgentProcess()
    startFakeAgent(process, [finalSessionId], {
      // Runs mid-turn, exactly when the artifact MCP tool would fire and the handoff is still active
      // (clearArtifactRun blanks it in the post-prompt finally).
      onPrompt: async () => {
        try {
          const projectDir = join(root, 'artifacts', 'default-project')
          const [artifactSessionId] = await readdir(projectDir)
          const currentRunFile = join(projectDir, artifactSessionId, '.pending', 'current-run.json')
          capturedContext = JSON.parse(await readFile(currentRunFile, 'utf8'))

          // A bare filename with no source must resolve against the handoff's notebook data dir.
          const artifact = await writeArtifactFileForCurrentRun(
            artifactRepository,
            {
              storageRoot: root,
              projectName: 'default-project',
              sessionId: artifactSessionId,
              currentRunFile,
              allowedImportRoots: [] // authorization must come from the handoff session root
            },
            { filename: 'sine.png', mimeType: 'image/png' }
          )
          writtenPath = artifact.path
        } catch (error) {
          captureError = error
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'plot a sine wave' })

    if (captureError) throw captureError
    // The handoff pins the kernel dir by the FINAL id, never the notebook-session-* alias.
    expect(capturedContext?.notebookDataDir).toBe(notebookDataDir)
    expect(capturedContext?.notebookSessionRoot).toBe(
      join(root, 'notebooks', 'default-project', finalSessionId)
    )
    expect(capturedContext?.notebookDataDir).not.toContain('notebook-session-')
    // And the bare-filename write actually copied the kernel file into pending artifacts.
    expect(writtenPath).toBeDefined()
    await expect(readFile(writtenPath as string, 'utf8')).resolves.toBe('PNGDATA')
  })

  it('gives opencode the stdio artifact MCP server + tool guidance (it accepts stdio like Claude)', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      // opencode accepts stdio MCP over ACP (verified live), so it gets the same stdio config as Claude.
      framework: opencodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello opencode' })

    // The artifact server is delivered over stdio (command/args, not a url) and its tool guidance rides
    // opencode's prompt prefix. No Claude _meta is sent (that stays framework-specific).
    const servers = fakeAgent.newSessions[0].mcpServers as Array<{ command?: string; url?: string }>
    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBeTruthy()
    expect(servers[0].url).toBeUndefined()
    expect(fakeAgent.newSessions[0]._meta).toBeUndefined()
    expect(fakeAgent.prompts[0].text).toContain('hello opencode')
    expect(fakeAgent.prompts[0].text).toContain('write_artifact_file')
  })

  it('gives bridge-backed Codex the artifact server through its explicit function alias', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        providerConfiguration: {
          providerId: 'custom-gateway',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer bridge-token' }
        }
      }),
      framework: codexFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello codex' })

    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0]._meta).toBeUndefined()
    expect(fakeAgent.prompts[0].text).toContain('hello codex')
    expect(fakeAgent.prompts[0].text).toContain('write_artifact_file')
  })

  it('gives bridge-backed Codex the notebook alias when artifact storage is not configured', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        providerConfiguration: {
          providerId: 'custom-gateway',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer bridge-token' }
        }
      }),
      framework: codexFramework,
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'search pubmed' })

    // Only configured app-owned MCP tools are attached; arbitrary native MCP remains unsupported.
    const servers = fakeAgent.newSessions[0].mcpServers as Array<{ name?: string }>
    expect(servers.map((server) => server.name)).toEqual(['open-science-notebook'])
    expect(fakeAgent.prompts[0].text).toContain(
      'Notebook tool instructions (only applies when using open-science-notebook tools)'
    )
    expect(fakeAgent.prompts[0].text).not.toContain('<open_science_artifact_instructions>')
  })

  it('delivers the large-data-file guidance to Claude session metadata on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], { supportsResume: true })
    // No artifacts/notebook configured: the large-file guidance is unconditional, unlike the MCP-gated
    // artifact/notebook appends, so it must still ride the Claude system-prompt preset.
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    // Resume a different id than the created one so the runtime performs a real session/resume (an
    // already-attached id short-circuits), mirroring the artifact-guidance create+resume coverage.
    await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({ sessionId: 'remote-session-2', cwd: '/workspace' })

    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        preset: 'claude_code',
        append: expect.stringContaining('open_science_large_file_instructions')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('open_science_large_file_instructions')
      }
    })
  })

  it('forwards resolved Claude session options on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], { supportsResume: true })
    const sessionOptions = {
      settings: '/app/claude/settings.json',
      plugins: [{ type: 'local', path: '/app/claude', skipMcpDiscovery: true }]
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        sessionOptions
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({ sessionId: 'remote-session-2', cwd: '/workspace' })

    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      claudeCode: { options: { ...sessionOptions, settingSources: ['user'] } }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      claudeCode: { options: { ...sessionOptions, settingSources: ['user'] } }
    })
  })

  it('delivers the large-data-file guidance to opencode as a prompt prefix', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello opencode' })

    // opencode has no system-prompt preset, so the guidance rides the prompt prefix ahead of user text.
    expect(fakeAgent.newSessions[0]._meta).toBeUndefined()
    expect(fakeAgent.prompts[0].text).toContain('open_science_large_file_instructions')
    expect(fakeAgent.prompts[0].text).toContain('hello opencode')
  })

  it('serves artifact/notebook MCP over the http host for an http-only framework', async () => {
    const root = await createTemporaryRoot()
    const httpHost = new AgentMcpHttpHost()
    const closeHttpHost = vi.spyOn(httpHost, 'close')
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      // A synthetic http-only framework keeps the http-host path covered now that opencode uses stdio;
      // the AgentMcpHttpHost stays in the runtime for any future framework that rejects stdio MCP.
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      mcpHttpHost: httpHost,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1/notebook', token: 'nb' })
      }
    })

    try {
      await runtime.createSession({ cwd: '/workspace' })

      const servers = fakeAgent.newSessions[0].mcpServers as Array<{
        type?: string
        name?: string
        url?: string
        headers?: Array<{ name: string; value: string }>
      }>

      // opencode gets http MCP configs (not stdio) pointing at the local host, with bearer auth.
      expect(servers.map((server) => server.type)).toEqual(['http', 'http'])
      expect(servers.map((server) => server.name)).toEqual(
        expect.arrayContaining(['open-science-artifacts', 'open-science-notebook'])
      )
      const artifactServer = servers.find((server) => server.name === 'open-science-artifacts')
      expect(artifactServer?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/artifact\//)
      expect(artifactServer?.headers?.[0]).toMatchObject({ name: 'authorization' })

      await runtime.requestRetirement()
      expect(closeHttpHost).toHaveBeenCalledOnce()
    } finally {
      await httpHost.close()
    }
  })

  it('allows prompts from different sessions to run concurrently', async () => {
    const process = new FakeAgentProcess()
    const promptCanStopBySession = new Map<string, ReturnType<typeof createDeferred>>()
    const promptStartedBySession = new Map<string, ReturnType<typeof createDeferred>>()
    const prompts: Array<{ sessionId: string; text: string }> = []
    const events: Array<{ sessionId?: string; text?: string }> = []
    let sessionIndex = 0

    acp
      .agent({ name: 'parallel-test-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => {
        sessionIndex += 1
        return { sessionId: `remote-session-${sessionIndex}` }
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const text = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        const sessionId = ctx.params.sessionId
        const promptCanStop = promptCanStopBySession.get(sessionId)
        const promptStarted = promptStartedBySession.get(sessionId)

        if (!promptCanStop || !promptStarted) {
          throw new Error(`Unexpected prompt session: ${sessionId}`)
        }

        prompts.push({ sessionId, text })
        promptStarted.resolve(undefined)

        await promptCanStop.promise
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `reply-${sessionId}`,
            content: {
              type: 'text',
              text: `reply for ${sessionId}`
            }
          }
        })

        return { stopReason: 'end_turn' }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })
    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })

    promptCanStopBySession.set(first.sessionId, createDeferred())
    promptStartedBySession.set(first.sessionId, createDeferred())
    promptCanStopBySession.set(second.sessionId, createDeferred())
    promptStartedBySession.set(second.sessionId, createDeferred())

    const firstPrompt = runtime.sendPrompt({ sessionId: first.sessionId, text: 'first prompt' })
    const secondPrompt = runtime.sendPrompt({
      sessionId: second.sessionId,
      text: 'second prompt'
    })

    await promptStartedBySession.get(first.sessionId)?.promise
    await promptStartedBySession.get(second.sessionId)?.promise

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([
      'remote-session-1',
      'remote-session-2'
    ])

    promptCanStopBySession.get(first.sessionId)?.resolve(undefined)
    await firstPrompt
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual(['remote-session-2'])

    promptCanStopBySession.get(second.sessionId)?.resolve(undefined)
    await secondPrompt

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'first prompt' },
      { sessionId: 'remote-session-2', text: 'second prompt' }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' },
        { sessionId: 'remote-session-2', text: 'reply for remote-session-2' }
      ])
    )
  })

  it('shares one agent connection when sessions are created concurrently', async () => {
    const initializeCanFinish = createDeferred()
    let spawnCount = 0
    let sessionIndex = 0

    const createDelayedAgentProcess = (): ChildProcessWithoutNullStreams => {
      spawnCount += 1
      const process = new FakeAgentProcess()

      acp
        .agent({ name: `delayed-agent-${spawnCount}` })
        .onRequest(acp.methods.agent.initialize, async () => {
          await initializeCanFinish.promise

          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: {
                close: {}
              }
            },
            authMethods: []
          }
        })
        .onRequest(acp.methods.agent.session.new, () => {
          sessionIndex += 1
          return { sessionId: `remote-session-${sessionIndex}` }
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      return asAgentProcess(process)
    }

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: createDelayedAgentProcess
    })
    const firstSession = runtime.createSession({ cwd: '/workspace' })
    const secondSession = runtime.createSession({ cwd: '/workspace' })

    initializeCanFinish.resolve(undefined)

    await expect(Promise.all([firstSession, secondSession])).resolves.toEqual([
      { sessionId: 'remote-session-1', cwd: resolve('/workspace'), frameworkId: 'claude-code' },
      { sessionId: 'remote-session-2', cwd: resolve('/workspace'), frameworkId: 'claude-code' }
    ])
    expect(spawnCount).toBe(1)
    expect(runtime.getSnapshot().sessionIds).toEqual(['remote-session-1', 'remote-session-2'])
  })

  it('invalidates an in-flight connection when disconnect is requested before initialization finishes', async () => {
    const initializeStarted = createDeferred()
    const firstInitializeCanFinish = createDeferred()
    let spawnCount = 0

    const createDelayedAgentProcess = (): ChildProcessWithoutNullStreams => {
      spawnCount += 1
      const processId = spawnCount
      const process = new FakeAgentProcess()

      acp
        .agent({ name: `disconnect-race-agent-${processId}` })
        .onRequest(acp.methods.agent.initialize, async () => {
          if (processId === 1) {
            initializeStarted.resolve(undefined)
            await firstInitializeCanFinish.promise
          }

          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: {
                close: {}
              }
            },
            authMethods: []
          }
        })
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: `remote-session-${processId}`
        }))
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      return asAgentProcess(process)
    }

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: createDelayedAgentProcess
    })
    const firstConnect = runtime.connect({ cwd: '/first-workspace' })
    const firstConnectRejection = expect(firstConnect).rejects.toThrow()

    await initializeStarted.promise
    await expect(runtime.disconnect()).resolves.toMatchObject({ status: 'closed' })

    const session = await runtime.createSession({ cwd: '/second-workspace' })

    firstInitializeCanFinish.resolve(undefined)
    await firstConnectRejection

    expect(session).toEqual({
      sessionId: 'remote-session-2',
      cwd: resolve('/second-workspace'),
      frameworkId: 'claude-code'
    })
    expect(spawnCount).toBe(2)
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionIds: ['remote-session-2']
    })
  })

  it('rejects filesystem callbacks for unknown sessions instead of falling back to global cwd', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-runtime-'))
    const filePath = join(workspaceRoot, 'notes.txt')
    let filesystemError: string | undefined

    try {
      await writeFile(filePath, 'session scoped file', 'utf8')

      const process = new FakeAgentProcess()

      acp
        .agent({ name: 'unknown-fs-session-agent' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: {
              close: {}
            }
          },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
          try {
            await ctx.client.request(acp.methods.client.fs.readTextFile, {
              sessionId: 'missing-session',
              path: filePath
            })
          } catch (error) {
            filesystemError = String(error)
          }

          return { stopReason: 'end_turn' }
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: workspaceRoot,
        spawnAgent: () => asAgentProcess(process)
      })
      const session = await runtime.createSession({ cwd: workspaceRoot })

      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'read unknown session file' })

      expect(filesystemError).toBeDefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects permission callbacks for unknown sessions without emitting renderer prompts', async () => {
    const process = new FakeAgentProcess()
    let permissionError: string | undefined
    let emittedUnknownPermission = false

    acp
      .agent({ name: 'unknown-permission-session-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        try {
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: 'missing-session',
            toolCall: {
              toolCallId: 'tool-1',
              title: 'Run command',
              status: 'pending'
            },
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
          })
        } catch (error) {
          permissionError = String(error)
        }

        return { stopReason: 'end_turn' }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onPermissionRequest: (request) => {
          emittedUnknownPermission = request.sessionId === 'missing-session'
          runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'request unknown permission' })

    expect(emittedUnknownPermission).toBe(false)
    expect(permissionError).toBeDefined()
    expect(runtime.getSnapshot().pendingPermissions).toEqual([])
  })

  it('audits each permission request, classifying MCP origin without logging the tool title', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()

    acp
      .agent({ name: 'permission-audit-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        // opencode renames the artifact MCP tool <server>_<tool>; classification must not rely on mcp__.
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: 'remote-session-1',
          toolCall: {
            toolCallId: 'tool-mcp',
            title: 'open-science-artifacts_write_artifact_file',
            kind: 'other',
            status: 'pending'
          },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        })
        // A WebFetch title is the full URL (user data) and must never reach the audit log.
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: 'remote-session-1',
          toolCall: {
            toolCallId: 'tool-fetch',
            title: 'https://example.com/secret?token=abc123',
            kind: 'fetch',
            status: 'pending'
          },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        })

        return { stopReason: 'end_turn' }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    // Wire the artifact MCP server so the session records its name (open-science-artifacts); MCP
    // classification is derived per session from the servers the agent was actually given.
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'allow-once' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'trigger permission audit' })

    const auditCalls = infoLogSpy.mock.calls.filter(
      ([message]) => message === 'permission request received'
    )
    expect(auditCalls).toHaveLength(2)

    const dataFor = (toolCallId: string): Record<string, unknown> =>
      auditCalls.find(
        ([, data]) => (data as { toolCallId?: string }).toolCallId === toolCallId
      )?.[1] as Record<string, unknown>

    // The opencode-named MCP tool is classified as MCP even though it lacks the mcp__ prefix.
    expect(dataFor('tool-mcp').isMcp).toBe(true)
    expect(dataFor('tool-fetch').isMcp).toBe(false)

    // No audit payload may carry the raw tool title (MCP tool name or WebFetch URL are user/sensitive).
    for (const [, data] of auditCalls) {
      const serialized = JSON.stringify(data)
      expect(serialized).not.toContain('example.com')
      expect(serialized).not.toContain('write_artifact_file')
    }
  })

  it('restores Codex MCP identity before prompting and remembers a session grant across call ids', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: Array<{
      title: string
      providerToolName?: string
      rawInput?: unknown
      requestId: string
      isMcp?: boolean
      options: Array<{ optionId: string }>
    }> = []
    const permissionResponses: unknown[] = []

    acp
      .agent({ name: 'codex-mcp-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'codex-mcp-session',
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      }))
      .onRequest(acp.methods.agent.session.setMode, () => ({}))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        for (const toolCallId of ['call-notebook-1', 'call-notebook-2']) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              kind: 'execute',
              title: 'mcp.open-science-notebook.notebook_execute',
              status: 'pending',
              rawInput: {
                server: 'open-science-notebook',
                tool: 'notebook_execute',
                arguments: { code: 'print(1)', language: 'python' }
              },
              _meta: { is_mcp_tool_call: true }
            }
          })

          const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              kind: 'execute',
              status: 'pending'
            },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              {
                optionId: 'allow_session',
                name: 'Allow for This Session',
                kind: 'allow_always'
              },
              {
                optionId: 'allow_always',
                name: "Allow and Don't Ask Again",
                kind: 'allow_always'
              },
              { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
            ],
            _meta: { is_mcp_tool_approval: true }
          })
          permissionResponses.push(response)
        }

        return { stopReason: 'end_turn' }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId: 'allow_session'
          })
        }
      }
    })
    const session = await runtime.createSession({
      cwd: '/workspace',
      permissionProfile: 'auto'
    })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run two notebook cells' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({
      title: 'mcp.open-science-notebook.notebook_execute',
      providerToolName: 'notebook_execute',
      isMcp: true,
      rawInput: { code: 'print(1)', language: 'python' },
      options: [{ optionId: 'allow_once' }, { optionId: 'allow_session' }, { optionId: 'decline' }]
    })
    expect(permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow_session' } },
      { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    ])
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'mcp:mcp.open-science-notebook.notebook_execute',
        kind: 'mcp',
        label: 'mcp.open-science-notebook.notebook_execute'
      }
    ])
  })

  it('shows sparse Codex commands and remembers Always for the same command only', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: Array<{
      title: string
      rawInput?: unknown
      requestId: string
    }> = []
    const permissionResponses: unknown[] = []

    acp
      .agent({ name: 'codex-command-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'codex-command-session',
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      }))
      .onRequest(acp.methods.agent.session.setMode, () => ({}))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        for (const [toolCallId, command] of [
          ['call-command-1', 'npm run lint'],
          ['call-command-2', 'npm run lint'],
          ['call-command-3', 'npm test']
        ]) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              kind: 'execute',
              title: command,
              status: 'pending',
              rawInput: { command }
            }
          })

          const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              kind: 'execute',
              status: 'pending',
              rawInput: { command, cwd: '/workspace' }
            },
            options: [
              { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'allow-session', name: 'Allow for This Session', kind: 'allow_always' },
              { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
            ]
          })
          permissionResponses.push(response)
        }

        return { stopReason: 'end_turn' }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId: permissionRequests.length === 1 ? 'allow-session' : 'allow-once'
          })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run two npm commands' })

    expect(permissionRequests).toHaveLength(2)
    expect(permissionRequests).toMatchObject([
      {
        title: 'npm run lint',
        rawInput: { command: 'npm run lint' }
      },
      {
        title: 'npm test',
        rawInput: { command: 'npm test' }
      }
    ])
    expect(permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow-session' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    ])
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      { categoryKey: 'bash:npm run lint', kind: 'shell', label: 'npm run lint' }
    ])
  })

  it('strips Codex policy amendments using the session framework after this.framework moves', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: Array<{ requestId: string; options: Array<{ optionId: string }> }> =
      []

    acp
      .agent({ name: 'codex-amendment-reconnect-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'codex-amendment-session',
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      }))
      .onRequest(acp.methods.agent.session.setMode, () => ({}))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: 'call-amendment-1',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: './deploy', cwd: '/workspace' }
          },
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'allow-session', name: 'Allow for This Session', kind: 'allow_always' },
            {
              optionId: 'accept_execpolicy_amendment',
              name: 'Allow Commands Starting With `./deploy`',
              kind: 'allow_always'
            },
            { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
          ]
        })
        return { stopReason: 'end_turn', response }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'allow-once' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    // Simulate an overlapping reconnect moving the process-global framework off codex while the
    // Codex session persists. The projection must key off the per-session framework, not this one.
    ;(runtime as unknown as { framework: typeof claudeCodeFramework }).framework =
      claudeCodeFramework

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'deploy' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].options.map((option) => option.optionId)).toEqual([
      'allow-once',
      'allow-session',
      'decline'
    ])
  })

  it('bounds pending Codex MCP identities and clears unmatched entries when the turn stops', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const promptCanStop = createDeferred()
    startFakeAgent(process, ['codex-bounded-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async () => {
        promptStarted.resolve()
        await promptCanStop.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'auto' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'start a turn' })
    await promptStarted.promise

    for (let index = 0; index < 40; index += 1) {
      observeCodexMcpToolIdentity(runtime, {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `pending-mcp-${index}`,
          kind: 'execute',
          title: 'mcp.open-science-notebook.notebook_execute',
          status: 'pending',
          rawInput: {
            server: 'open-science-notebook',
            tool: 'notebook_execute',
            arguments: { code: `print(${index})` }
          }
        }
      })
    }

    const pendingIdentities = codexMcpToolIdentitiesMap(runtime).get(session.sessionId)
    expect(pendingIdentities?.size).toBe(32)
    expect(pendingIdentities?.has('pending-mcp-0')).toBe(false)
    expect(pendingIdentities?.has('pending-mcp-39')).toBe(true)

    promptCanStop.resolve()
    await prompt
    expect(codexMcpToolIdentitiesMap(runtime).has(session.sessionId)).toBe(false)
  })

  it('records MCP server names on resume so a resumed session audits its MCP tool calls as MCP', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startPermissionProbeAgent(process, {
      newSessionId: 'unused-new-session',
      toolCallId: 'resumed-mcp',
      toolTitle: 'open-science-artifacts_write_artifact_file',
      resume: 'ok'
    })
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'allow-once' })
        }
      }
    })

    // Resume (not create) records the artifact MCP server name for this session, so a later MCP tool
    // call is classified isMcp even though it lacks the mcp__ prefix.
    await runtime.resumeSession({ sessionId: 'resumed-session', cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'resumed-session', text: 'continue resumed session' })

    expect(auditedIsMcp('resumed-mcp')).toBe(true)
    expect(mcpServerNamesMap(runtime).get('resumed-session')).toEqual(['open-science-artifacts'])
  })

  it('records MCP server names when adopting a fresh session after an unresumable resume', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    // Resume rejects with resourceNotFound, forcing the runtime to adopt a fresh agent session
    // (adopted-session-1) under the app-facing id (switched-session).
    startPermissionProbeAgent(process, {
      newSessionId: 'adopted-session-1',
      toolCallId: 'adopted-mcp',
      toolTitle: 'open-science-artifacts_write_artifact_file',
      resume: 'notFound'
    })
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'allow-once' })
        }
      }
    })

    const resumed = await runtime.resumeSession({
      sessionId: 'switched-session',
      cwd: '/workspace'
    })
    expect(resumed.contextReset).toBe(true)

    await runtime.sendPrompt({ sessionId: 'switched-session', text: 'keep going' })

    // The adopted session recorded its MCP names under the app-facing id, so the relabeled permission
    // request audits as MCP.
    expect(auditedIsMcp('adopted-mcp')).toBe(true)
    expect(mcpServerNamesMap(runtime).get('switched-session')).toEqual(['open-science-artifacts'])
  })

  it('registers a reviewer session MCP names for auditing and clears them on dispose', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-mcp',
      toolTitle: 'Submit review checks',
      providerToolName: 'open-science-reviewer_submit_findings'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    // The reviewer session records its MCP server name so its (auto-approved) tool calls still audit
    // with the correct isMcp classification.
    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    expect(session.sessionId).toBe('reviewer-session-1')
    expect(mcpServerNamesMap(runtime).has('reviewer-session-1')).toBe(true)
    expect(sessionFrameworksMap(runtime).get('reviewer-session-1')).toBe('claude-code')

    // Drive a tool-call permission request through the reviewer session (auto-approved by the runtime).
    await session.prompt([{ type: 'text', text: 'review this turn' }])

    expect(auditedIsMcp('reviewer-mcp')).toBe(true)

    // Disposing the reviewer session unregisters its MCP names.
    runtime.disposeReviewerSession(session)
    expect(mcpServerNamesMap(runtime).has('reviewer-session-1')).toBe(false)
    expect(sessionFrameworksMap(runtime).has('reviewer-session-1')).toBe(false)
  })

  it.each([
    { tool: 'submit_findings', expectedOptionId: 'allow-once' },
    { tool: 'run_shell', expectedOptionId: 'reject-once' }
  ])(
    'handles sparse Codex reviewer MCP tool $tool through the strict allowlist',
    async ({ tool, expectedOptionId }) => {
      const process = new FakeAgentProcess()
      let permissionResponse: unknown
      startPermissionProbeAgent(process, {
        newSessionId: 'codex-reviewer-session',
        toolCallId: `codex-reviewer-${tool}`,
        toolTitle: 'unused by sparse approval',
        codexMcpIdentity: {
          server: 'open-science-reviewer',
          tool,
          arguments: { checks: [] }
        },
        sparseCodexMcpApproval: true,
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        permissionOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ],
        onPermissionResponse: (response) => {
          permissionResponse = response
        }
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework: codexFramework
      })

      const { session } = await runtime.buildReviewerSession({
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'open-science-reviewer',
            url: 'http://127.0.0.1:1/mcp',
            headers: []
          }
        ]
      })
      await session.prompt([{ type: 'text', text: 'submit the reviewer findings' }])

      expect(auditedIsMcp(`codex-reviewer-${tool}`)).toBe(true)
      expect(permissionResponse).toEqual({
        outcome: { outcome: 'selected', optionId: expectedOptionId }
      })
      runtime.disposeReviewerSession(session)
    }
  )

  it.each([null, 'read'] as const)(
    'auto-approves an exact reviewer provider tool identity with kind %s',
    async (toolKind) => {
      const process = new FakeAgentProcess()
      let permissionResponse: unknown
      startPermissionProbeAgent(process, {
        newSessionId: 'reviewer-session-1',
        toolCallId: `reviewer-provider-identity-${toolKind ?? 'missing'}`,
        toolTitle: 'Read audited turn',
        toolKind,
        providerToolName: 'mcp__open-science-reviewer__read_turn',
        permissionOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ],
        onPermissionResponse: (response) => {
          permissionResponse = response
        }
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process)
      })

      const { session } = await runtime.buildReviewerSession({
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'open-science-reviewer',
            url: 'http://127.0.0.1:1/mcp',
            headers: []
          }
        ]
      })
      await session.prompt([{ type: 'text', text: 'read the audited turn' }])

      expect(permissionResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' }
      })
      runtime.disposeReviewerSession(session)
    }
  )

  it('auto-approves an exact opencode reviewer tool title when provider metadata is absent', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-opencode-identity',
      toolTitle: 'open-science-reviewer_read_turn',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    await session.prompt([{ type: 'text', text: 'read the audited turn' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    runtime.disposeReviewerSession(session)
  })

  // Regression: claude-code (and OpenAI-compatible providers routed through it) emit reviewer MCP calls
  // with the sanitized mcp__<server>__<tool> identity in the title and no provider _meta tool name. The
  // gate must recognize that title form or every reviewer tool call is rejected (issue #329).
  it('auto-approves a claude-code reviewer MCP tool identified by its sanitized title', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'mcp__open_science_reviewer__read_turn_0',
      toolTitle: 'mcp__open_science_reviewer__read_turn',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        { type: 'http', name: 'open-science-reviewer', url: 'http://127.0.0.1:1/mcp', headers: [] }
      ]
    })
    await session.prompt([{ type: 'text', text: 'read the audited turn' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(runtime.reviewerRejectedToolCallCount(session.sessionId)).toBe(0)
    runtime.disposeReviewerSession(session)
  })

  // Claude Code preserves hyphens in MCP server names in real tool traces, so the permission title
  // can use mcp__<hyphenated-server>__<tool> instead of the sanitized underscore form.
  it('auto-approves a claude-code reviewer MCP tool identified by its hyphenated title', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-hyphenated-title',
      toolTitle: 'mcp__open-science-reviewer__read_turn',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    await session.prompt([{ type: 'text', text: 'read the audited turn' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(runtime.reviewerRejectedToolCallCount(session.sessionId)).toBe(0)
    runtime.disposeReviewerSession(session)
  })

  // Security: the toolCallId is agent-controlled, so a reviewer-shaped id must NOT authorize a call
  // whose title/kind are a genuinely disallowed tool. Only the title carries the trusted MCP identity.
  it('rejects a Bash call that carries a reviewer-shaped toolCallId', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'mcp__open_science_reviewer__read_turn_0',
      toolTitle: 'Bash',
      toolKind: 'execute',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        { type: 'http', name: 'open-science-reviewer', url: 'http://127.0.0.1:1/mcp', headers: [] }
      ]
    })
    await session.prompt([{ type: 'text', text: 'run a shell command with a spoofed id' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    expect(runtime.reviewerRejectedToolCallCount(session.sessionId)).toBe(1)
    runtime.disposeReviewerSession(session)
  })

  it('counts reviewer tool calls rejected by the strict gate', async () => {
    const process = new FakeAgentProcess()
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-blocked-bash',
      toolTitle: 'Bash',
      toolKind: 'execute',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        { type: 'http', name: 'open-science-reviewer', url: 'http://127.0.0.1:1/mcp', headers: [] }
      ]
    })
    await session.prompt([{ type: 'text', text: 'run a shell command' }])

    expect(runtime.reviewerRejectedToolCallCount(session.sessionId)).toBe(1)
    // dispose returns the final count and clears it atomically — the orchestrator relies on this.
    expect(runtime.disposeReviewerSession(session)).toEqual({
      rejectedToolCalls: 1,
      reviewerBridgeScoped: undefined
    })
    expect(runtime.reviewerRejectedToolCallCount('reviewer-session-1')).toBe(0)
  })

  it('refuses a non-loopback reviewer MCP before starting an agent connection', async () => {
    const process = new FakeAgentProcess()
    const spawnAgent = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent
    })

    await expect(
      runtime.buildReviewerSession({
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'open-science-reviewer',
            url: 'https://example.com/mcp',
            headers: []
          }
        ]
      })
    ).rejects.toThrow(/loopback HTTP open-science-reviewer/)
    expect(spawnAgent).not.toHaveBeenCalled()
  })

  it('removes the temporary reviewer directory when session startup fails', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['reviewer-session-1'], {
      modes: createModes(['default'], 'unexpected-mode'),
      rejectModeChange: true
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.buildReviewerSession({
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'open-science-reviewer',
            url: 'http://127.0.0.1:1/mcp',
            headers: []
          }
        ]
      })
    ).rejects.toThrow()

    expect(fakeAgent.newSessions).toHaveLength(1)
    const reviewerSession = fakeAgent.newSessions[0]
    if (!reviewerSession) throw new Error('Reviewer session was not created before startup failed')
    const reviewerCwd = reviewerSession.cwd
    expect(reviewerCwd).toMatch(/open-science-reviewer-/)
    await expect(stat(reviewerCwd)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reviewerSessionIds(runtime).size).toBe(0)
    expect(mcpServerNamesMap(runtime).has('reviewer-session-1')).toBe(false)
  })

  it('rejects tools from every MCP namespace except the dedicated reviewer server', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-foreign-mcp',
      toolTitle: 'mcp__other-server__read_file',
      toolKind: 'execute',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    await session.prompt([{ type: 'text', text: 'attempt an out-of-scope command' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    // It is generically recognized as MCP for audit logging, but the reviewer gate rejects it because
    // its namespace does not exactly match open-science-reviewer.
    expect(auditedIsMcp('reviewer-foreign-mcp')).toBe(true)
    runtime.disposeReviewerSession(session)
  })

  it('rejects opencode provider tools that spoof an exact reviewer MCP method title', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-spoofed-execute',
      toolTitle: 'open-science-reviewer_read_turn',
      toolKind: 'other',
      providerToolName: 'Bash',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    await session.prompt([{ type: 'text', text: 'attempt a spoofed execute call' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    runtime.disposeReviewerSession(session)
  })

  it('rejects unknown tools inside the reviewer MCP namespace', async () => {
    const process = new FakeAgentProcess()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-1',
      toolCallId: 'reviewer-unknown-method',
      toolTitle: 'mcp__open-science-reviewer__run_shell',
      providerToolName: 'mcp__open-science-reviewer__run_shell',
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    await session.prompt([{ type: 'text', text: 'attempt an unknown reviewer tool' }])

    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    runtime.disposeReviewerSession(session)
  })

  it('clears reviewer auto-approval identities when the agent disconnects', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['reviewer-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    expect(reviewerSessionIds(runtime)).toEqual(new Set(['reviewer-session-1']))

    await runtime.disconnect()
    expect(reviewerSessionIds(runtime).size).toBe(0)
  })

  it('invalidates context usage when its agent connection disconnects', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    contextUsageMap(runtime).set(session.sessionId, { used: 12000, size: 128000 })
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      [session.sessionId]: { used: 12000, size: 128000 }
    })

    await runtime.disconnect()

    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})
  })

  it('clears a session MCP server names when the session is deleted', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    expect(mcpServerNamesMap(runtime).get(session.sessionId)).toEqual(['open-science-artifacts'])

    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(mcpServerNamesMap(runtime).has(session.sessionId)).toBe(false)
  })

  it('clears all MCP server names on disconnect', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    expect(mcpServerNamesMap(runtime).has(session.sessionId)).toBe(true)

    await runtime.disconnect()

    expect(mcpServerNamesMap(runtime).size).toBe(0)
  })

  it('removes a session so later prompts cannot target it', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(fakeAgent.closedSessions).toEqual(['remote-session-1'])
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello' })
    ).rejects.toThrow(/not found/)
  })

  it('closes an adopted session on the agent by its own id, not the app-facing id', async () => {
    const process = new FakeAgentProcess()
    // Resume rejects (Resource not found), so the runtime adopts a fresh agent session
    // (adopted-session-1) under the app-facing id (switched-session). The agent only knows the
    // underlying id, so delete must close/cancel using it, not the app-facing request id.
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const resumed = await runtime.resumeSession({
      sessionId: 'switched-session',
      cwd: '/workspace'
    })
    expect(resumed.sessionId).toBe('switched-session')

    await runtime.deleteSession({ sessionId: 'switched-session' })

    // The agent received session/close for its own id, not the app-facing one it never knew.
    expect(fakeAgent.closedSessions).toEqual(['adopted-session-1'])
    // Local routing state is keyed by the app-facing id and is fully removed.
    expect(runtime.getSnapshot().sessionIds).toEqual([])
    await expect(
      runtime.sendPrompt({ sessionId: 'switched-session', text: 'hello' })
    ).rejects.toThrow(/not found/)
  })

  it('clears the reverse (agent id -> app id) mapping when an adopted session is deleted', async () => {
    const process = new FakeAgentProcess()
    // Resume rejects, so the runtime adopts a fresh agent session (adopted-session-1) under the
    // app-facing id (switched-session), registering the reverse mapping used to relabel agent events.
    startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.resumeSession({ sessionId: 'switched-session', cwd: '/workspace' })
    // The adoption recorded the underlying id -> app id mapping.
    expect(agentToAppSessionMap(runtime).get('adopted-session-1')).toBe('switched-session')

    await runtime.deleteSession({ sessionId: 'switched-session' })

    // Delete removes the reverse entry, so a reused agent id or a late agent event carrying the
    // underlying id no longer resolves to the deleted app session.
    expect(agentToAppSessionMap(runtime).has('adopted-session-1')).toBe(false)
  })

  it('cancels an adopted session by its own id when the agent lacks session/close', async () => {
    const process = new FakeAgentProcess()
    // No close capability, so delete must fall back to the session/cancel notification; resume rejects
    // so the fresh agent session (adopted-session-1) is adopted under the app-facing id.
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], {
      resumeNotFound: true,
      supportsClose: false
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.resumeSession({ sessionId: 'switched-session', cwd: '/workspace' })
    await runtime.deleteSession({ sessionId: 'switched-session' })

    // The cancel fallback targets the underlying agent id, not the app-facing one (cancel is a
    // fire-and-forget notification, so wait for the agent to receive it).
    await vi.waitFor(() => expect(fakeAgent.cancelledSessions).toEqual(['adopted-session-1']))
    expect(fakeAgent.closedSessions).toEqual([])
    expect(runtime.getSnapshot().sessionIds).toEqual([])
  })

  it('cleans up sessionFrameworks when deleting a detached session (post framework-switch)', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    // createSession records the session's framework; a framework switch disconnects (clearing
    // this.sessions) but deliberately KEEPS sessionFrameworks so a later resume can detect the switch.
    expect(sessionFrameworksMap(runtime).has(session.sessionId)).toBe(true)
    await runtime.disconnect()
    expect(runtime.getSnapshot().sessionIds).toEqual([])
    // The framework entry survives the disconnect (by design).
    expect(sessionFrameworksMap(runtime).has(session.sessionId)).toBe(true)

    // Deleting the now-detached session must not throw or talk to a torn-down agent, but must still
    // drop the leaked framework entry so it cannot later mislead the cross-framework-resume check.
    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(sessionFrameworksMap(runtime).has(session.sessionId)).toBe(false)
    expect(fakeAgent.closedSessions).toEqual([])
    expect(fakeAgent.cancelledSessions).toEqual([])
  })

  it('resumes an existing protocol session so restored conversations can continue', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [])
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    await runtime.resumeSession({
      sessionId: 'remote-session-1',
      cwd: '/workspace'
    })
    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'continue restored session'
    })

    expect(fakeAgent.resumedSessions).toEqual([
      {
        sessionId: 'remote-session-1',
        cwd: resolve('/workspace'),
        mcpServers: [],
        // Every session (new or resumed) is restricted to the app-owned "user" settings scope, and
        // carries the always-on skill-privacy guardrail in its system prompt.
        _meta: {
          claudeCode: { options: { settingSources: ['user'] } },
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: expect.stringContaining('open_science_skill_privacy_instructions')
          }
        }
      }
    ])
    expect(fakeAgent.prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'continue restored session'
      }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' }
      ])
    )
  })

  it('times out and tears down a reconnect when the agent never answers session/resume', async () => {
    const process = new FakeAgentProcess()
    const resumeReceived = createDeferred()

    // A fresh agent that advertises resume support but leaves session/resume pending forever.
    acp
      .agent({ name: 'stuck-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {}, resume: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.resume, () => {
        resumeReceived.resolve(undefined)
        return new Promise<never>(() => {})
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    // Capture the injected timer callback so the test can fire the resume timeout deterministically.
    let fireResumeTimeout: (() => void) | undefined
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      resumeTimeoutMs: 1000,
      setTimer: (fn) => {
        fireResumeTimeout = fn
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })

    const resume = runtime.resumeSession({ sessionId: 'stuck-session', cwd: '/workspace' })

    // Wait until the resume request is genuinely in flight, then trip the injected timeout.
    await resumeReceived.promise
    fireResumeTimeout?.()

    await expect(resume).rejects.toThrow(/timed out/i)
    // The half-open connection is torn down so a retry reconnects cleanly.
    expect(process.killed).toBe(true)
  })

  it('adopts a fresh session under the same id when a replaced agent no longer holds it', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    // Resume fails (Resource not found) but is transparently adopted onto a new agent session, keeping
    // the requested (app-facing) id so the conversation can continue after a provider switch.
    const resumed = await runtime.resumeSession({
      sessionId: 'switched-session',
      cwd: '/workspace'
    })
    expect(resumed.sessionId).toBe('switched-session')
    // Signals the caller that agent-side context was lost so it can replay a transcript preamble.
    expect(resumed.contextReset).toBe(true)

    await runtime.sendPrompt({ sessionId: 'switched-session', text: 'keep going' })

    // The new agent session (adopted-session-1) streamed a reply, relabeled to the app-facing id.
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'switched-session', text: 'reply for adopted-session-1' }
      ])
    )
  })

  it('prepends a history preamble to the agent content but not the user-facing message', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const messageEvents: Array<{ role?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'message' && event.role === 'user') {
            messageEvents.push({ role: event.role, text: event.text })
          }
        }
      }
    })

    await runtime.resumeSession({ sessionId: 'switched-session', cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'switched-session',
      text: 'keep going',
      historyPreamble: 'PRIOR CONTEXT: the user asked to plot data.'
    })

    // The agent sees the replayed context ahead of the user's text...
    expect(fakeAgent.prompts[0]?.text).toContain('PRIOR CONTEXT: the user asked to plot data.')
    expect(fakeAgent.prompts[0]?.text).toContain('keep going')
    // ...but the conversation bubble records only what the user actually typed.
    expect(messageEvents).toEqual([{ role: 'user', text: 'keep going' }])
  })

  it('adopts a fresh session when the agent returns a generic Internal error on resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeInternalError: true })
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    // Resume fails with -32603 "Internal error" (what a restarted agent returns instead of a clean
    // not-found). It must still be adopted onto a fresh agent session so the thread is not dead-ended.
    const resumed = await runtime.resumeSession({
      sessionId: 'restarted-session',
      cwd: '/workspace'
    })
    expect(resumed.sessionId).toBe('restarted-session')

    await runtime.sendPrompt({ sessionId: 'restarted-session', text: 'keep going' })

    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'restarted-session', text: 'reply for adopted-session-1' }
      ])
    )
  })

  it('adopts a fresh session when the ACP agent wraps a resume failure in Internal error details', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], {
      resumeInternalErrorDetails: 'Failed to restore the previous conversation'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const resumed = await runtime.resumeSession({
      sessionId: 'restarted-session',
      cwd: '/workspace'
    })
    expect(resumed).toMatchObject({
      sessionId: 'restarted-session',
      contextReset: true
    })
    expect(
      infoLogSpy.mock.calls.find(
        ([message]) => message === 'resumed session adopted after unrecoverable resume error'
      )?.[1]
    ).toMatchObject({
      sessionId: 'restarted-session',
      error: 'Internal error',
      code: -32603,
      data: { details: 'Failed to restore the previous conversation' }
    })

    await runtime.sendPrompt({ sessionId: 'restarted-session', text: 'keep going' })

    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
  })

  it('adopts a fresh session from a language-independent session-loss reason', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], {
      resumeInternalErrorData: {
        errorKind: 'session-not-found',
        details: 'The agent supplied a localized diagnostic'
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restarted-session', cwd: '/workspace' })
    ).resolves.toMatchObject({ sessionId: 'restarted-session', contextReset: true })
    expect(fakeAgent.newSessions).toHaveLength(1)
  })

  it.each([
    'Authentication failed while configuring the provider',
    'Failed to load session provider credentials',
    'Unable to load Model Context Protocol server for this session',
    'Unknown model context for this conversation'
  ])('keeps unrelated Internal error details visible: %s', async (details) => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], { resumeInternalErrorDetails: details })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restarted-session', cwd: '/workspace' })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'Internal error',
      data: { details }
    })
    expect(fakeAgent.newSessions).toEqual([])
  })

  it('trusts an unrelated structured reason over a session-like detail', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], {
      resumeInternalErrorData: {
        errorKind: 'provider-error',
        details: 'Failed to restore the previous conversation'
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restarted-session', cwd: '/workspace' })
    ).rejects.toMatchObject({ code: -32603, data: { errorKind: 'provider-error' } })
    expect(fakeAgent.newSessions).toEqual([])
  })

  it('adopts a fresh session when opencode tags a lost session with its failing service', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], {
      resumeServiceFailure: { service: 'session', message: 'OpenCode service failure' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restarted-session', cwd: '/workspace' })
    ).resolves.toMatchObject({ sessionId: 'restarted-session', contextReset: true })
    expect(fakeAgent.newSessions).toHaveLength(1)

    await runtime.sendPrompt({ sessionId: 'restarted-session', text: 'keep going' })
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
  })

  it('keeps an Internal error from a non-session service visible', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], {
      resumeServiceFailure: { service: 'provider', message: 'OpenCode service failure' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restarted-session', cwd: '/workspace' })
    ).rejects.toMatchObject({ code: -32603, data: { service: 'provider' } })
    expect(fakeAgent.newSessions).toEqual([])
  })

  it('skips resume entirely for a session that last ran under a different framework', async () => {
    // A session created under Claude, then continued after switching to opencode: resume can never
    // succeed (each framework has its own session store), so the runtime must NOT send session/resume
    // (which would make the agent log a scary internal error) and adopt a fresh session directly.
    const claudeProcess = new FakeAgentProcess()
    const claudeAgent = startFakeAgent(claudeProcess, ['claude-session-1'])
    const opencodeProcess = new FakeAgentProcess()
    const opencodeAgent = startFakeAgent(opencodeProcess, ['opencode-session-1'])

    let connects = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      // First connect resolves Claude, the second (after the switch) resolves opencode; each framework
      // spawns its own fake process so their session stores stay distinct.
      resolveBackend: async () => {
        connects += 1

        return {
          framework:
            connects === 1
              ? { ...claudeCodeFramework, spawn: () => asAgentProcess(claudeProcess) }
              : { ...opencodeFramework, spawn: () => asAgentProcess(opencodeProcess) },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    expect(created.sessionId).toBe('claude-session-1')

    // Switching frameworks disconnects; the next connect resolves opencode.
    await runtime.disconnect(false)

    const resumed = await runtime.resumeSession({
      sessionId: 'claude-session-1',
      cwd: '/workspace'
    })

    // Adopted onto opencode under the same app id, with context reset so soft-replay can run.
    expect(resumed).toEqual({
      sessionId: 'claude-session-1',
      cwd: resolve('/workspace'),
      frameworkId: 'opencode',
      contextReset: true
    })
    // The doomed resume was never sent to opencode; it built a fresh session instead.
    expect(opencodeAgent.resumedSessions).toEqual([])
    expect(opencodeAgent.newSessions).toHaveLength(1)
    // And the original Claude agent was never asked to resume either.
    expect(claudeAgent.resumedSessions).toEqual([])
  })

  it('skips resume when the same framework switches to a different provider backend', async () => {
    // Codex shared-profile and isolated-login providers use separate CODEX_HOME session stores even
    // though both run through the same Codex framework. Sending one store's session id to the other
    // produces the generic "Internal error" reported by codex-acp, so treat the backend identity as
    // part of resumability and adopt a fresh agent session directly.
    const sharedProcess = new FakeAgentProcess()
    const codexModes = createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    const sharedAgent = startFakeAgent(sharedProcess, ['shared-session-1'], { modes: codexModes })
    const isolatedProcess = new FakeAgentProcess()
    const isolatedAgent = startFakeAgent(isolatedProcess, ['isolated-session-1'], {
      modes: codexModes
    })

    let connects = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => {
        connects += 1

        return {
          framework: {
            ...codexFramework,
            spawn: () => asAgentProcess(connects === 1 ? sharedProcess : isolatedProcess)
          },
          backendId: connects === 1 ? 'codex:codex-shared' : 'codex:codex-isolated',
          executablePath: '/bin/codex-acp',
          env: {},
          args: []
        }
      }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    expect(created).toEqual({
      sessionId: 'shared-session-1',
      cwd: resolve('/workspace'),
      frameworkId: 'codex',
      backendId: 'codex:codex-shared'
    })

    await runtime.disconnect(false)

    const resumed = await runtime.resumeSession({
      sessionId: 'shared-session-1',
      cwd: '/workspace',
      previousFrameworkId: 'codex',
      previousBackendId: created.backendId
    })

    expect(resumed).toEqual({
      sessionId: 'shared-session-1',
      cwd: resolve('/workspace'),
      frameworkId: 'codex',
      backendId: 'codex:codex-isolated',
      contextReset: true
    })
    expect(isolatedAgent.resumedSessions).toEqual([])
    expect(isolatedAgent.newSessions).toHaveLength(1)
    expect(sharedAgent.resumedSessions).toEqual([])
  })

  it('uses Codex input and cache-read tokens for context usage', async () => {
    const process = new FakeAgentProcess()
    const usageSent = createDeferred()
    const finishPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          // Patched codex-acp reports only the current request's input plus cached input.
          update: { sessionUpdate: 'usage_update', used: 15, size: 128000 }
        })
        usageSent.resolve()
        await finishPrompt.promise

        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 18,
            inputTokens: 12,
            cachedReadTokens: 3,
            outputTokens: 3
          }
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await usageSent.promise
    const usageWhileGenerating = runtime.getSnapshot().contextUsageBySession
    finishPrompt.resolve()
    await prompt

    expect(usageWhileGenerating).toEqual({
      s1: { used: 15, size: 128000 }
    })
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 15, size: 128000 }
    })
  })

  it.each([
    ['Claude Code', claudeCodeFramework, 200_000],
    ['OpenCode', opencodeFramework, 128_000],
    ['Codex bridge', codexFramework, 258_400]
  ] as const)(
    'uses the selected model context window instead of the %s adapter window',
    async (_name, framework, adapterWindow) => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, ['s1'], {
        modes:
          framework.id === 'codex'
            ? createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
            : undefined
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent',
          env: {},
          contextWindow: 1_000_000
        }),
        framework
      })

      await runtime.createSession({ cwd: '/workspace' })
      handleSessionUpdate(runtime, {
        sessionId: 's1',
        update: { sessionUpdate: 'usage_update', used: 15, size: adapterWindow }
      })

      expect(runtime.getSnapshot().contextUsageBySession).toEqual({
        s1: { used: 15, size: 1_000_000 }
      })
    }
  )

  it('uses the latest Claude model request instead of accumulating the agent turn', async () => {
    const process = new FakeAgentProcess()
    const firstUsageSent = createDeferred()
    const sendSecondUsage = createDeferred()
    const secondUsageSent = createDeferred()
    const finishPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          // First upstream model response: 12 input + 3 cache read.
          update: { sessionUpdate: 'usage_update', used: 15, size: 200000 }
        })
        firstUsageSent.resolve()
        await sendSecondUsage.promise
        handleSessionUpdate(runtime, {
          sessionId,
          // A tool-followup model request replaces the first measurement: 19 input + 5 cache read.
          update: { sessionUpdate: 'usage_update', used: 24, size: 200000 }
        })
        secondUsageSent.resolve()
        await finishPrompt.promise

        return {
          stopReason: 'end_turn',
          // claude-agent-acp accumulates PromptResponse.usage across the whole agent turn. The
          // runtime must not let this overwrite the latest per-request usage_update.
          usage: {
            totalTokens: 60,
            inputTokens: 31,
            cachedReadTokens: 8,
            cachedWriteTokens: 7,
            outputTokens: 14
          }
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await firstUsageSent.promise
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 15, size: 200000 }
    })

    sendSecondUsage.resolve()
    await secondUsageSent.promise
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 24, size: 200000 }
    })

    finishPrompt.resolve()
    await prompt

    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 24, size: 200000 }
    })
  })

  it('corrects an unpatched external Codex total with its latest request usage at stop', async () => {
    const process = new FakeAgentProcess()
    const usageSent = createDeferred()
    const finishPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 18, size: 128000 }
        })
        usageSent.resolve()
        await finishPrompt.promise
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 18,
            inputTokens: 12,
            cachedReadTokens: 3,
            outputTokens: 3
          }
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await usageSent.promise
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 18, size: 128000 }
    })

    finishPrompt.resolve()
    await prompt

    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 15, size: 128000 }
    })
  })

  it('uses OpenCode native input and cache-read context usage', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 15, size: 128000 }
    })

    expect(runtime.getSnapshot().contextUsageBySession).toEqual({
      s1: { used: 15, size: 128000 }
    })
  })

  it('defers a provider reconnect until an in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    const usageSent = createDeferred()
    startFakeAgent(process, ['s1'], {
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 6800, size: 128000 }
        })
        usageSent.resolve()
        await gate.promise
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 6800,
            inputTokens: 6000,
            cachedReadTokens: 400,
            cachedWriteTokens: 100,
            outputTokens: 300
          }
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    contextUsageMap(runtime).set('s1', { used: 6400, size: 128000 })

    // Start a prompt that stays in flight until the gate is released.
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await usageSent.promise

    // A provider switch requested mid-turn must NOT disconnect the running agent.
    await runtime.requestProviderReconnect()
    expect(process.killed).toBe(false)
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})

    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 7200, size: 128000 }
    })
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})

    // Once the turn finishes, the deferred reconnect is applied (agent torn down for a fresh spawn).
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})
  })

  it('retires a framework runtime only after its in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onRetired }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    await runtime.requestRetirement()
    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().sessionIds).toEqual(['s1'])

    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionIds).toEqual([])
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not retire while createSession is resolving its backend', async () => {
    const process = new FakeAgentProcess()
    const backendEntered = createDeferred()
    const releaseBackend = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: { onRetired },
      resolveBackend: async () => {
        backendEntered.resolve()
        await releaseBackend.promise
        return {
          framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent',
          env: {}
        }
      }
    })

    const creating = runtime.createSession({ cwd: '/workspace' })
    await backendEntered.promise
    await runtime.requestRetirement()

    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()

    releaseBackend.resolve()
    await expect(creating).resolves.toMatchObject({ sessionId: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not retire while a prompt checks whether disabled skills need force-loading', async () => {
    const process = new FakeAgentProcess()
    const skillCheckEntered = createDeferred()
    const releaseSkillCheck = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onRetired },
      skills: {
        needForceLoad: async () => {
          skillCheckEntered.resolve()
          await releaseSkillCheck.promise
          return []
        },
        namesForIds: async (ids) => ids
      }
    })
    await runtime.createSession({ cwd: '/workspace' })

    const prompting = runtime.sendPrompt({
      sessionId: 's1',
      text: 'use the selected skill',
      forcedSkillIds: ['research']
    })
    await skillCheckEntered.promise
    await runtime.requestRetirement()

    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()

    releaseSkillCheck.resolve()
    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not retire while deleteSession awaits the agent close request', async () => {
    const process = new FakeAgentProcess()
    const closeEntered = createDeferred()
    const releaseClose = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'], {
      onClose: async () => {
        closeEntered.resolve()
        await releaseClose.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onRetired }
    })
    await runtime.createSession({ cwd: '/workspace' })

    const deleting = runtime.deleteSession({ sessionId: 's1' })
    await closeEntered.promise
    await runtime.requestRetirement()

    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()

    releaseClose.resolve()
    await deleting
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not retire while setPermissionProfile awaits the agent mode request', async () => {
    const process = new FakeAgentProcess()
    const modeEntered = createDeferred()
    const releaseMode = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['default', 'bypassPermissions']),
      onSetMode: async () => {
        modeEntered.resolve()
        await releaseMode.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onRetired }
    })
    await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    const changingProfile = runtime.setPermissionProfile({ sessionId: 's1', profile: 'full' })
    await modeEntered.promise
    await runtime.requestRetirement()

    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()

    releaseMode.resolve()
    await changingProfile
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('completes retirement after an unexpected connection close drains the active operation', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    const onRetired = vi.fn()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onRetired }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await runtime.requestRetirement()

    process.stdout.end()
    gate.resolve()
    await prompt.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.getSnapshot().status).toBe('closed')
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('keeps a reviewer session alive until it is disposed before retiring', async () => {
    const process = new FakeAgentProcess()
    const registerReviewerSession = vi.fn()
    const unregisterReviewerSession = vi.fn(() => false)
    const releaseBridge = vi.fn(async () => undefined)
    startFakeAgent(process, ['reviewer-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        providerConfiguration: {
          providerId: 'custom-gateway',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          headers: { authorization: 'Bearer bridge' }
        },
        responsesBridgeLease: {
          registerReviewerSession,
          unregisterReviewerSession,
          release: releaseBridge
        }
      })
    })

    const { session } = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    })
    expect(registerReviewerSession).toHaveBeenCalledWith('reviewer-session-1')

    await runtime.requestRetirement()
    expect(process.killed).toBe(false)
    expect(releaseBridge).not.toHaveBeenCalled()

    runtime.disposeReviewerSession(session)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unregisterReviewerSession).toHaveBeenCalledWith('reviewer-session-1')
    expect(errorLogSpy).toHaveBeenCalledWith('reviewer bridge request was never scoped', {
      sessionId: 'reviewer-session-1'
    })
    expect(process.killed).toBe(true)
    expect(releaseBridge).toHaveBeenCalledOnce()
  })

  it('finishes disconnect state cleanup when the responses bridge lease rejects release', async () => {
    const process = new FakeAgentProcess()
    const releaseBridge = vi.fn().mockRejectedValue(new Error('bridge close failed'))
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: {
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => true),
          release: releaseBridge
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    await expect(runtime.disconnect()).resolves.toMatchObject({ status: 'closed' })

    expect(releaseBridge).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().status).toBe('closed')
    expect(errorLogSpy).toHaveBeenCalledWith(
      'responses bridge lease release failed',
      expect.objectContaining({ error: 'bridge close failed' })
    )
  })

  it('keeps a retiring runtime alive across gaps in an activity workflow', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })
    const activityStarted = createDeferred()
    const releaseActivity = createDeferred()

    const activity = runtime.withActivity({}, async () => {
      activityStarted.resolve()
      await releaseActivity.promise
    })
    await activityStarted.promise

    await runtime.requestRetirement()
    expect(process.killed).toBe(false)

    releaseActivity.resolve()
    await activity
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(process.killed).toBe(true)
  })

  it('createSession waits for a pending provider reconnect before using the new connection', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    // Old process: one session, prompt gated so it stays in-flight.
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    // New process: serves sessions after the reconnect.
    startFakeAgent(newProcess, ['s2'])

    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    // Establish the initial connection and start an in-flight prompt.
    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // Request a provider reconnect while the prompt is running — arms the barrier.
    await runtime.requestProviderReconnect()

    // A concurrent createSession must NOT complete before the barrier resolves.
    let secondSessionDone = false
    const secondSession = runtime.createSession({ cwd: '/workspace' }).then((r) => {
      secondSessionDone = true
      return r
    })

    // Yield so any eager resolution would be observable, then assert still blocked.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondSessionDone).toBe(false)

    // Release the gate → prompt finishes → deferred reconnect fires → barrier resolves.
    gate.resolve()
    await prompt
    const result = await secondSession

    // The second session must have landed on the new connection (second spawn).
    expect(result.sessionId).toBe('s2')
    expect(spawnCount).toBe(2)
  })

  it('createSession proceeds immediately when an unexpected connection close resolves the barrier', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    startFakeAgent(newProcess, ['s2'])

    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // Arm the barrier with a deferred reconnect while the prompt is running.
    await runtime.requestProviderReconnect()

    // createSession blocks on the barrier.
    const secondSession = runtime.createSession({ cwd: '/workspace' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Simulate an unexpected connection close — handleConnectionClosed resolves the barrier.
    oldProcess.stdout.end()

    // createSession must unblock and connect fresh (the close cleared the stale connection).
    const result = await secondSession
    expect(result.sessionId).toBe('s2')

    // Clean up the in-flight prompt gate so the test can exit cleanly.
    gate.resolve()
    await prompt.catch(() => undefined)
  })

  it('reconnects on a fresh backend when the deferred disconnect rejects', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    startFakeAgent(newProcess, ['s2'])

    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // Arm the barrier with a deferred reconnect while the prompt is running.
    await runtime.requestProviderReconnect()

    // The deferred disconnect (fired when the turn settles) rejects before it can clear the stale
    // connection. The barrier must still resolve AND the stale connection must be invalidated, so a
    // blocked createSession reconnects on a fresh backend instead of reusing the old one.
    const disconnectSpy = vi
      .spyOn(runtime, 'disconnect')
      .mockRejectedValueOnce(new Error('teardown failed'))

    // A createSession issued during the deferred window blocks on the barrier.
    const secondSession = runtime.createSession({ cwd: '/workspace' })

    // Release the gate → turn settles → maybeApplyPendingProviderReconnect calls the rejecting
    // disconnect → catch invalidates the connection → finally() resolves the barrier.
    gate.resolve()
    await prompt

    // Must complete (no deadlock) AND land on the second spawn — proof the stale connection was not
    // reused after the teardown failure.
    const result = await secondSession
    expect(result.sessionId).toBe('s2')
    expect(spawnCount).toBe(2)
    disconnectSpy.mockRestore()
  })

  it('broadcasts closed and releases the barrier when a failed deferred disconnect has no follow-up', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const states: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onStateChanged: (s) => states.push(s.status) }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await runtime.requestProviderReconnect()

    const disconnectSpy = vi
      .spyOn(runtime, 'disconnect')
      .mockRejectedValueOnce(new Error('teardown failed'))

    // Turn settles → deferred disconnect rejects → no createSession follows. The catch must still
    // broadcast 'closed' so the renderer doesn't stay on the stale 'connected' snapshot.
    states.length = 0
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(states).toContain('closed')
    expect(runtime.getSnapshot().status).toBe('closed')
    disconnectSpy.mockRestore()
  })

  it('still releases the barrier when the closed broadcast on a failed disconnect throws', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    startFakeAgent(newProcess, ['s2'])

    let spawnCount = 0
    // Throw from onStateChanged only on the post-failure broadcast (the one emitted while status is
    // 'closed' with no connection), so the barrier must survive an emitState that itself throws.
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: {
        onStateChanged: (s) => {
          if (s.status === 'closed') throw new Error('renderer broadcast blew up')
        }
      },
      resolveBackend: async () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await runtime.requestProviderReconnect()

    const disconnectSpy = vi
      .spyOn(runtime, 'disconnect')
      .mockRejectedValueOnce(new Error('teardown failed'))

    const secondSession = runtime.createSession({ cwd: '/workspace' })
    gate.resolve()
    await prompt

    // The guarded emitState swallows its own throw, so the barrier still resolves and the blocked
    // createSession reconnects on a fresh backend rather than hanging.
    const result = await secondSession
    expect(result.sessionId).toBe('s2')
    expect(spawnCount).toBe(2)
    disconnectSpy.mockRestore()
  })

  it('reconnects immediately when a provider switch happens with no prompt in flight', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestProviderReconnect()

    expect(process.killed).toBe(true)
  })

  it('reloads skills immediately when no prompt is in flight', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestSkillsReload()

    expect(process.killed).toBe(true)
  })

  it('defers a skills reload until an in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // A skill toggle mid-turn must NOT disconnect the running agent.
    await runtime.requestSkillsReload()
    expect(process.killed).toBe(false)

    // Once the turn finishes, the deferred reload is applied (agent torn down for a fresh spawn).
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
  })

  it('applies a provider reconnect and a skills reload deferred in the same turn with one disconnect', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    startFakeAgent(newProcess, ['s2'])

    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // Both a provider switch and a skill toggle arrive during the same in-flight prompt.
    await runtime.requestProviderReconnect()
    await runtime.requestSkillsReload()
    expect(oldProcess.killed).toBe(false)

    // Turn finishes → a SINGLE deferred disconnect satisfies both (spawnCount 1 → 2). A second,
    // redundant disconnect would spawn a third process on the next createSession.
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(oldProcess.killed).toBe(true)

    // The next session lands on the second spawn — proof no extra reconnect churned the process.
    const next = await runtime.createSession({ cwd: '/workspace' })
    expect(next.sessionId).toBe('s2')
    expect(spawnCount).toBe(2)
  })

  it('passes the artifact MCP server to new and resumed sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science'
      }
    })

    const createdSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace'
    })

    expect(createdSession.sessionId).toBe('remote-session-1')
    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      name: 'open-science-artifacts',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-artifact-mcp']
    })
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_SESSION_ID')
    ).toMatch(/^artifact-session-/)
    expect(fakeAgent.resumedSessions[0].mcpServers).toHaveLength(1)
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_SESSION_ID')
    ).toBe('remote-session-2')
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    // The skill-privacy guardrail is appended to the system prompt on both create and resume.
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('open_science_skill_privacy_instructions')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('open_science_skill_privacy_instructions')
      }
    })
  })

  it('scopes the artifact MCP project to a caller-supplied projectName on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace', projectName: 'project-abc' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace',
      projectName: 'project-xyz'
    })

    // The per-session projectName (not the runtime default) reaches the artifact MCP server config.
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('project-abc')
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('project-xyz')
  })

  it('falls back to the runtime default projectName when none is supplied', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('default-project')
  })

  it('passes notebook MCP server and scoped notebook instructions to new and resumed sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const aliases: Array<{ aliasSessionId: string; sessionId: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        registerSessionAlias: (aliasSessionId, sessionId) => {
          aliases.push({ aliasSessionId, sessionId })
        }
      }
    })

    const createdSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace'
    })

    expect(createdSession.sessionId).toBe('remote-session-1')
    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      name: 'open-science-notebook',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-notebook-mcp']
    })
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
    ).toMatch(/^notebook-session-/)
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD')
    ).toBe(resolve('/workspace'))
    expect(aliases).toEqual([
      {
        aliasSessionId: getEnvValue(
          fakeAgent.newSessions[0].mcpServers[0],
          'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'
        ),
        sessionId: 'remote-session-1'
      }
    ])
    expect(fakeAgent.resumedSessions[0].mcpServers).toHaveLength(1)
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
    ).toBe('remote-session-2')
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining(
          'Notebook tool instructions (only applies when using open-science-notebook tools)'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('writable session workspace')
      }
    })
    const createdSessionMeta = JSON.stringify(fakeAgent.newSessions[0]._meta)
    expect(createdSessionMeta).toContain('mcp__open-science-notebook__notebook_execute')
    expect(createdSessionMeta).not.toContain('`notebook_execute`')
  })

  it('passes only the workspace as a static allowed import root, not the pre-start notebook alias', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    const byName = (name: string): unknown | undefined =>
      fakeAgent.newSessions[0].mcpServers.find(
        (server) =>
          typeof server === 'object' && server !== null && 'name' in server && server.name === name
      )
    const artifactServer = byName('open-science-artifacts')
    const notebookServer = byName('open-science-notebook')

    if (!artifactServer || !notebookServer) {
      throw new Error('Expected artifact and notebook MCP servers')
    }

    const notebookSessionId = getEnvValue(notebookServer, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')

    // The static env carries ONLY the session workspace. The notebook session root is deliberately
    // absent: at session creation we hold just the pre-start alias, and authorizing the alias dir
    // would let stale-alias absolute paths pass the allow-root check. The authoritative notebook
    // root (keyed by the final ACP session id) is supplied per turn via current-run.json instead.
    const staticRoots = JSON.parse(
      getEnvValue(artifactServer, 'OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS')
    )
    expect(staticRoots).toEqual([resolve('/workspace')])
    expect(staticRoots).not.toContain(
      join('/Users/example/.open-science', 'notebooks', 'default-project', notebookSessionId)
    )
  })

  it('uses the configured main entry path for artifact MCP server config', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science'
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      args: ['/app/out/main/index.js', '--open-science-artifact-mcp']
    })
  })

  it('adds artifact instructions through session system prompt metadata without mutating prompts', async () => {
    const storageRoot = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const events: Array<{ role?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ role: event.role, text: event.text })
      },
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(storageRoot)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Generate a little duckling meme image and save it locally'
    })

    expect(fakeAgent.prompts[0]).toMatchObject({
      sessionId: 'remote-session-1',
      text: 'Generate a little duckling meme image and save it locally'
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining(
          'Do not save generated user-facing files directly into the workspace'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('inline content or a local source path')
      }
    })
    expect(events).toEqual(
      expect.arrayContaining([
        { role: 'user', text: 'Generate a little duckling meme image and save it locally' }
      ])
    )
  })

  it('emits an artifact event with pending files before a prompt stops', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as { runId: string }

        await repository.writePendingFile({
          projectName: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.runId,
          filename: 'result.txt',
          source: { kind: 'inline', content: 'artifact content', encoding: 'utf8' }
        })
        expect(sessionId).toBe('remote-session-1')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        repository
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') {
            events.push({
              kind: event.kind,
              sessionId: event.sessionId,
              runId: event.runId,
              artifactClaimId: event.artifactClaimId,
              artifactCount: event.artifacts?.length
            })
          }
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    currentRunFile = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
    )
    await runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'make a file' })

    expect(events).toEqual([
      {
        kind: 'artifact',
        sessionId: 'remote-session-1',
        runId: expect.stringMatching(/^artifact-run-/),
        artifactClaimId: expect.stringMatching(/^artifact-claim-/),
        artifactCount: 1
      }
    ])
  })

  it('emits an artifact event for pending files even when the prompt fails', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async () => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as { runId: string }

        await repository.writePendingFile({
          projectName: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.runId,
          filename: 'result.txt',
          source: { kind: 'inline', content: 'artifact content', encoding: 'utf8' }
        })

        // Fail the turn after the file was written so it never reaches a clean stop.
        throw new Error('agent exploded mid-turn')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        repository
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') {
            events.push({
              kind: event.kind,
              sessionId: event.sessionId,
              runId: event.runId,
              artifactClaimId: event.artifactClaimId,
              artifactCount: event.artifacts?.length
            })
          }
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    currentRunFile = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
    )
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'make a file' })
    ).rejects.toThrow()

    expect(events).toEqual([
      {
        kind: 'artifact',
        sessionId: 'remote-session-1',
        runId: expect.stringMatching(/^artifact-run-/),
        artifactClaimId: expect.stringMatching(/^artifact-claim-/),
        artifactCount: 1
      }
    ])
  })

  it('cleans up prompt in-flight state when artifact run activation fails', async () => {
    const storageRoot = await createTemporaryRoot()
    const blockedStorageRoot = join(storageRoot, 'storage-file')
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: blockedStorageRoot,
        dataRoot: blockedStorageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron'
      },
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, text: event.text })
      }
    })
    startFakeAgent(process, ['remote-session-1'])
    await writeFile(blockedStorageRoot, 'not a directory', 'utf8')
    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'make a file' })
    ).rejects.toThrow()

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error'
        })
      ])
    )
  })

  it('tags a slug-only request-size overflow as context-overflow recoverable', async () => {
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; recoverable?: string }> = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        // The ACP RequestError shape of a provider-relayed rejection: the message is the generic
        // wrapper and the real reason lives in data.errorKind (here the HTTP 413 slug), so only the
        // structured-kind check can recognize the overflow.
        throw acp.RequestError.internalError({ errorKind: 'request_too_large' }, 'Internal error')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, recoverable: event.recoverable })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
    ).rejects.toThrow()

    expect(events).toContainEqual({ kind: 'error', recoverable: 'context-overflow' })
  })

  it('does not tag a generic invalid_request failure as context-overflow recoverable', async () => {
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; recoverable?: string }> = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        // A malformed-request rejection is not an overflow: resetting the agent context would destroy
        // history without any chance of fixing the turn.
        throw acp.RequestError.internalError(
          { errorKind: 'invalid_request' },
          'invalid_request: messages.0.content is required'
        )
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, recoverable: event.recoverable })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
    ).rejects.toThrow()

    const errorEvent = events.find((event) => event.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.recoverable).toBeUndefined()
  })

  it('tags a provider-relayed prompt failure with providerError so the renderer hides Report', async () => {
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; providerError?: boolean }> = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        // An upstream provider rejection the agent relays as an APIError — the user's to fix, not a bug.
        throw acp.RequestError.internalError({ errorName: 'APIError' }, 'Invalid API key')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, providerError: event.providerError })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
    ).rejects.toThrow()

    expect(events).toContainEqual({ kind: 'error', providerError: true })
  })

  it('does not tag an ACP-layer prompt failure as providerError (stays reportable)', async () => {
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; providerError?: boolean }> = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        // A protocol-level failure with no upstream provider signal is an app/ACP problem, not a
        // provider one, so it must NOT be tagged (the renderer keeps the Report button).
        throw acp.RequestError.internalError({ errorKind: 'invalid_request' }, 'malformed request')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, providerError: event.providerError })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
    ).rejects.toThrow()

    const errorEvent = events.find((event) => event.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.providerError).toBeFalsy()
  })

  it('logs the provider rejection reason (message/code/data) when a prompt fails', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        throw acp.RequestError.internalError({ errorKind: 'request_too_large' }, 'provider blew up')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
    ).rejects.toThrow()

    // Regression: a raw Error nested in the log payload serializes without its (non-enumerable)
    // message, so the file log showed only { code, data, name } and hid the provider's reason.
    // errorLogFields keeps the message, code, and data together.
    expect(errorLogSpy).toHaveBeenCalledWith(
      'prompt failed',
      expect.objectContaining({
        sessionId: 'remote-session-1',
        error: 'Internal error: provider blew up',
        code: -32603,
        data: { errorKind: 'request_too_large' }
      })
    )
  })

  it('logs the artifact-emit failure reason (message/code/data) when the prompt failed', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        throw new Error('agent exploded mid-turn')
      }
    })
    // The prompt failure routes the finally block into a second emit attempt; making the repository
    // read fail there exercises the 'artifact emit after prompt failure failed' log path. The error
    // carries a `data` detail so the assertion below also pins its survival into the log record.
    vi.spyOn(repository, 'listPendingRunFiles').mockRejectedValue(
      Object.assign(new Error('disk exploded'), {
        code: 'EIO',
        data: { operation: 'listPendingRunFiles' }
      })
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        repository
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'make a file' })
    ).rejects.toThrow()

    // Same regression class as 'prompt failed': a raw nested Error would log without its message,
    // and an incomplete serialization would drop the structured detail.
    expect(errorLogSpy).toHaveBeenCalledWith(
      'artifact emit after prompt failure failed',
      expect.objectContaining({
        sessionId: 'remote-session-1',
        error: 'disk exploded',
        code: 'EIO',
        data: { operation: 'listPendingRunFiles' }
      })
    )
  })

  it('rejects restored sessions when the agent does not advertise resume support', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], { supportsResume: false })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({
        sessionId: 'remote-session-1',
        cwd: '/workspace'
      })
    ).rejects.toThrow(/does not support session resume/)
    expect(fakeAgent.resumedSessions).toEqual([])
  })

  it('keeps a cancelling prompt in flight until the agent returns its stop response', async () => {
    const process = new FakeAgentProcess()
    const promptCanStop = createDeferred()
    const promptStarted = createDeferred()
    const prompts: string[] = []

    acp
      .agent({ name: 'cancel-test-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        // Keep the first prompt open so cancellation can be observed while it is in flight.
        const text = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        prompts.push(text)

        if (prompts.length === 1) {
          promptStarted.resolve()
          await promptCanStop.promise
          return { stopReason: 'cancelled' }
        }

        return { stopReason: 'end_turn' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        promptCanStop.resolve()
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const promptPromise = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'first prompt'
    })

    await promptStarted.promise

    const cancelSnapshot = await runtime.cancelPrompt({ sessionId: session.sessionId })

    expect(cancelSnapshot.promptInFlightSessionIds).toEqual(['remote-session-1'])
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'second prompt' })
    ).rejects.toThrow(/already running/)

    await promptPromise

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(prompts).toEqual(['first prompt'])
  })
})

describe('ACP runtime skill force-load + nudge', () => {
  // Builds a spawner that returns a fresh fake agent per connect, so a force-load reconnect can spawn a
  // second working agent. All agent handles are collected so tests can assert prompts across reconnects.
  const createFreshAgentSpawner = (): {
    spawn: () => ChildProcessWithoutNullStreams
    agents: Array<ReturnType<typeof startFakeAgent>>
    spawnCount: () => number
  } => {
    const agents: Array<ReturnType<typeof startFakeAgent>> = []
    let count = 0

    return {
      spawn: () => {
        count += 1
        const process = new FakeAgentProcess()
        agents.push(startFakeAgent(process, ['remote-session-1']))
        return asAgentProcess(process)
      },
      agents,
      spawnCount: () => count
    }
  }

  // A stub of the settings-service skill hooks with per-call spies for assertions.
  const createSkillsHooks = (options: {
    needForceLoad: string[]
    nudgeNames?: Record<string, string>
  }): {
    needForceLoad: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
    namesForIds: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
  } => ({
    needForceLoad: vi.fn<(ids: string[]) => Promise<string[]>>(async () => options.needForceLoad),
    namesForIds: vi.fn<(ids: string[]) => Promise<string[]>>(async (ids: string[]) =>
      ids.map((id) => options.nudgeNames?.[id] ?? id)
    )
  })

  it('passes turn-forced skill ids to backend resolution per runtime instance', async () => {
    const firstSpawner = createFreshAgentSpawner()
    const secondSpawner = createFreshAgentSpawner()
    const firstContexts: Array<{ forcedSkillIds: string[] } | undefined> = []
    const secondContexts: Array<{ forcedSkillIds: string[] } | undefined> = []
    const createRuntime = (
      spawner: ReturnType<typeof createFreshAgentSpawner>,
      contexts: Array<{ forcedSkillIds: string[] } | undefined>
    ): AcpRuntime =>
      new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: (context?: { forcedSkillIds: string[] }) => {
          contexts.push(context)
          return {
            framework: { ...claudeCodeFramework, spawn: spawner.spawn },
            executablePath: '/bin/agent',
            env: {}
          }
        },
        skills: {
          needForceLoad: async (ids) => ids,
          namesForIds: async (ids) => ids
        }
      })

    const first = createRuntime(firstSpawner, firstContexts)
    const second = createRuntime(secondSpawner, secondContexts)
    await Promise.all([
      first.createSession({ cwd: '/workspace' }),
      second.createSession({ cwd: '/workspace' })
    ])
    await Promise.all([
      first.sendPrompt({
        sessionId: 'remote-session-1',
        text: 'first',
        forcedSkillIds: ['skill-a']
      }),
      second.sendPrompt({
        sessionId: 'remote-session-1',
        text: 'second',
        forcedSkillIds: ['skill-b']
      })
    ])

    expect(firstContexts).toContainEqual({ forcedSkillIds: ['skill-a'] })
    expect(secondContexts).toContainEqual({ forcedSkillIds: ['skill-b'] })
    expect(firstContexts).not.toContainEqual({ forcedSkillIds: ['skill-b'] })
    expect(secondContexts).not.toContainEqual({ forcedSkillIds: ['skill-a'] })
  })

  it('respawns and nudges when a picked skill is disabled, then restores after the turn', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({ needForceLoad: ['research'] })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(spawner.spawnCount()).toBe(1)

    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    // The picked skill was scoped to this runtime and the agent respawned before the prompt.
    expect(spawner.spawnCount()).toBe(2)
    expect(spawner.agents[1].resumedSessions).toHaveLength(1)

    // The nudge names the skill by its slug id (the identifier the agent's Skill tool resolves),
    // NOT its human display name — a display name like "Deep Research" is unknown to the tool.
    expect(spawner.agents[1].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: research.\n\nsummarize the paper'
      }
    ])

    // After the turn the force set is cleared and a restore reconnect is scheduled (agent torn down).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getSnapshot().status).toBe('closed')
  })

  it('nudges without any reconnect when every picked skill is already enabled', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({ needForceLoad: [] })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    // No disabled picks → no respawn and no force set toggling, but the nudge is still prepended.
    expect(spawner.spawnCount()).toBe(1)
    expect(spawner.agents[0].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: research.\n\nsummarize the paper'
      }
    ])
  })

  it('nudges a personal skill by its agent-resolvable frontmatter name', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({
      needForceLoad: [],
      nudgeNames: { 'personal-my-skill': 'My Skill' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['personal-my-skill']
    })

    expect(spawner.agents[0].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: My Skill.\n\nsummarize the paper'
      }
    ])
    expect(hooks.namesForIds).toHaveBeenCalledWith(['personal-my-skill'])
  })

  it('leaves the prompt untouched when no skills are picked', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({ needForceLoad: ['research'] })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'plain prompt' })

    // With no forcedSkillIds, none of the skill hooks run and the text is unchanged.
    expect(hooks.needForceLoad).not.toHaveBeenCalled()
    expect(spawner.spawnCount()).toBe(1)
    expect(spawner.agents[0].prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'plain prompt' }
    ])
  })

  // End-to-end guard over the whole bundled set: for EVERY real bundled skill, the nudge the agent
  // receives must name it by the exact id the agent's Skill tool resolves (its frontmatter name), and
  // must NOT leak the human display name. This is the regression that "any / skill errors" reduces to.
  it('nudges every bundled skill by its resolvable id, never its display name', async () => {
    const bundled = await new SkillRegistry(
      join(__dirname, '..', '..', '..', 'resources', 'skills')
    ).list()
    expect(bundled.length).toBeGreaterThan(0)

    for (const skill of bundled) {
      const spawner = createFreshAgentSpawner()
      const hooks = createSkillsHooks({ needForceLoad: [] })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: spawner.spawn,
        skills: hooks
      })

      await runtime.createSession({ cwd: '/workspace' })
      await runtime.sendPrompt({
        sessionId: 'remote-session-1',
        text: 'do the task',
        forcedSkillIds: [skill.id]
      })

      const prompt = spawner.agents[0].prompts[0]?.text ?? ''
      expect(prompt, `nudge for "${skill.id}"`).toBe(
        `Use the following skill(s) for this task: ${skill.id}.\n\ndo the task`
      )
      // A display name that differs from the id (16 of 18 bundled skills) must never reach the agent.
      if (skill.name !== skill.id) {
        expect(prompt, `display name for "${skill.id}"`).not.toContain(skill.name)
      }
    }
  })
})

// Reads the private framework pointer so a test can simulate a mid-reconnect backend switch.
const setRuntimeFramework = (runtime: AcpRuntime, framework: unknown): void => {
  ;(runtime as unknown as { framework: unknown }).framework = framework
}

describe('ACP runtime — agent process lifecycle logging', () => {
  it('logs a non-zero agent exit with code, framework, pid, and expected=false', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 4321
    startFakeAgent(process, ['exit-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    // A spontaneous crash (not an app-initiated teardown, so it is not in expectedProcessExits).
    process.emit('exit', 1, null)

    const call = infoLogSpy.mock.calls.find(([message]) => message === 'agent process exit')
    expect(call).toBeDefined()
    const data = call?.[1] as {
      code: number
      framework: string
      expected: boolean
      pid: number
      status: string
      sessionCount: number
    }
    expect(data.code).toBe(1)
    expect(data.framework).toBe('claude-code')
    expect(data.expected).toBe(false)
    expect(data.pid).toBe(4321)
    expect(data.status).toBe('connected')
    expect(data.sessionCount).toBe(1)
  })

  it('logs a signal-terminated exit with the signal name', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['signal-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.emit('exit', null, 'SIGKILL')

    const call = infoLogSpy.mock.calls.find(([message]) => message === 'agent process exit')
    expect((call?.[1] as { signal: string }).signal).toBe('SIGKILL')
  })

  it('logs an agent process error event with framework and pid', async () => {
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 9090
    startFakeAgent(process, ['error-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.emit('error', new Error('EPIPE'))

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent process error event')
    expect(call).toBeDefined()
    const data = call?.[1] as { error: string; framework: string; pid: number; status: string }
    expect(data.error).toBe('EPIPE')
    expect(data.framework).toBe('claude-code')
    expect(data.pid).toBe(9090)
    expect(data.status).toBe('connected')
  })

  it('logs agent stderr with the framework the process was spawned under', async () => {
    warnLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['stderr-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.stderr.emit('data', Buffer.from('provider auth failed'))

    const call = warnLogSpy.mock.calls.find(([message]) => message === 'agent stderr')
    expect(call).toBeDefined()
    const data = call?.[1] as {
      text: string
      framework: string
      status: string
      sessionCount: number
    }
    expect(data.text).toBe('provider auth failed')
    expect(data.framework).toBe('claude-code')
    expect(data.status).toBe('connected')
    expect(data.sessionCount).toBe(1)
  })

  it('labels a late stderr with the framework captured at bind time, not the current one', async () => {
    warnLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['bind-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    // Simulate a reconnect having swapped the active backend after this process was bound. A late
    // stderr from the *old* process must still be attributed to the framework it was spawned under.
    setRuntimeFramework(runtime, opencodeFramework)
    process.stderr.emit('data', Buffer.from('slow tail output'))

    const call = warnLogSpy.mock.calls.find(([message]) => message === 'agent stderr')
    expect((call?.[1] as { framework: string }).framework).toBe('claude-code')
  })
})

describe('ACP runtime — connect failure logging', () => {
  it('logs "agent connection failed" with error, cwd, and framework when spawn throws', async () => {
    errorLogSpy.mockClear()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/ENOENT/)

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect(call).toBeDefined()
    const data = call?.[1] as { error: string; code: string; cwd: string; framework: string }
    expect(data.error).toBe('spawn claude ENOENT')
    expect(data.code).toBe('ENOENT')
    expect(data.cwd).toBe(resolve('/workspace'))
    expect(data.framework).toBe('claude-code')
  })

  it('logs "agent connection abandoned" (not failed) when the generation is superseded mid-spawn', async () => {
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 1212
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      // Bump the connection generation synchronously during spawn: the connect that captured the older
      // generation must detect the supersede after the child appears and abandon it.
      spawnAgent: () => {
        ;(runtime as unknown as { connectionGeneration: number }).connectionGeneration += 1
        return asAgentProcess(process)
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/superseded/i)

    const abandoned = warnLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection abandoned (superseded or shutting down)'
    )
    expect(abandoned).toBeDefined()
    const data = abandoned?.[1] as { framework: string; agentProcessPid: number; cwd: string }
    expect(data.framework).toBe('claude-code')
    expect(data.agentProcessPid).toBe(1212)
    expect(data.cwd).toBe(resolve('/workspace'))
    // The supersede path must NOT also emit the error-level "failed" record.
    expect(errorLogSpy.mock.calls.some(([message]) => message === 'agent connection failed')).toBe(
      false
    )
  })

  it('labels a real-backend spawn failure with the resolved (switched) framework, not the old one', async () => {
    errorLogSpy.mockClear()
    // The runtime defaults to claude-code; this reconnect resolves a *different* backend whose real
    // framework.spawn() throws. spawnAgentProcess sets this.framework to opencode before spawning, so
    // the failure must be attributed to opencode — the backend actually launched — via the spawn tag,
    // exercising the real resolveBackend + framework switch + framework.spawn() path (no injected spawn).
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...opencodeFramework,
          spawn: () => {
            throw new Error('spawn opencode ENOENT')
          }
        },
        executablePath: '/bin/opencode',
        env: {}
      })
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/opencode ENOENT/)

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect(call).toBeDefined()
    const data = call?.[1] as { error: string; framework: string }
    expect(data.error).toBe('spawn opencode ENOENT')
    expect(data.framework).toBe('opencode')
  })

  it('logs "agent connection abandoned" when a real async resolveBackend is superseded mid-resolution by a public disconnect()', async () => {
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 3434
    let signalEntered: () => void = () => undefined
    const enteredResolver = new Promise<void>((resolvePromise) => {
      signalEntered = resolvePromise
    })
    let releaseBackend: () => void = () => undefined
    const backendGate = new Promise<void>((resolvePromise) => {
      releaseBackend = resolvePromise
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      // A genuinely async backend resolution that signals once entered, then parks. The test only
      // supersedes AFTER the connect is inside the resolver (past the pre-spawn teardown + generation
      // assertion), so the supersede is detected post-spawn and the child is captured in the log.
      resolveBackend: async () => {
        signalEntered()
        await backendGate

        return {
          framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent',
          env: {}
        }
      }
    })

    const createPromise = runtime.createSession({ cwd: '/workspace' })
    await enteredResolver
    // Overlapping teardown while the connect is parked inside resolveBackend: bumps the generation via
    // the real disconnect path. Only after that do we release the gate so the resolver returns.
    await runtime.disconnect()
    releaseBackend()

    await expect(createPromise).rejects.toThrow(/superseded|shutting down/i)

    // The connect resumes, spawns the child, then detects the supersede and abandons it. Key guarantees:
    // logged as *abandoned* (a warning) with the spawned child's pid + target cwd/framework, and NOT
    // also raised as the error-level "failed" record.
    const abandoned = warnLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection abandoned (superseded or shutting down)'
    )
    expect(abandoned).toBeDefined()
    const data = abandoned?.[1] as { cwd: string; framework: string; agentProcessPid: number }
    expect(data.cwd).toBe(resolve('/workspace'))
    expect(data.framework).toBe('claude-code')
    expect(data.agentProcessPid).toBe(3434)
    expect(errorLogSpy.mock.calls.some(([message]) => message === 'agent connection failed')).toBe(
      false
    )
  })

  it('labels a non-Error spawn throw with the resolved framework and re-throws the original value', async () => {
    errorLogSpy.mockClear()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...opencodeFramework,
          spawn: () => {
            // A non-Error throwable: the old mutate-the-throwable tagging couldn't attach to this at
            // all, so the framework label would have fallen back to the (wrong) previous backend.
            throw 'raw string spawn failure'
          }
        },
        executablePath: '/bin/opencode',
        env: {}
      })
    })

    // The original value (not an Error, not a wrapper) must propagate unchanged.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(
      'raw string spawn failure'
    )

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect(call).toBeDefined()
    const data = call?.[1] as { error: string; framework: string }
    expect(data.error).toBe('raw string spawn failure')
    expect(data.framework).toBe('opencode')
  })

  it('does not mutate a frozen spawn Error, still labels the framework, and re-throws it verbatim', async () => {
    errorLogSpy.mockClear()
    const frozen = Object.freeze(new Error('frozen spawn failure'))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...opencodeFramework,
          spawn: () => {
            throw frozen
          }
        },
        executablePath: '/bin/opencode',
        env: {}
      })
    })

    // The old approach assigned a tag onto the throwable — a TypeError on a frozen Error, masking the
    // real failure. The wrapper leaves it untouched and re-throws the exact same object.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(frozen)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect((frozen as unknown as { spawnFramework?: unknown }).spawnFramework).toBeUndefined()

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect((call?.[1] as { framework: string }).framework).toBe('opencode')
  })
})

describe('ACP runtime — session effort', () => {
  // A select option like the thought_level selector opencode/Claude Code advertise from session/new.
  const thoughtLevelOption = (values: string[]): SessionConfigOption =>
    ({
      type: 'select',
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: values[0],
      options: values.map((value) => ({ value, name: value }))
    }) as SessionConfigOption

  const createEffortRuntime = (
    process: FakeAgentProcess,
    sessionEffort: ReasoningEffort | undefined,
    sessionModel?: string
  ): AcpRuntime =>
    new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode',
        env: {},
        sessionModel,
        sessionEffort
      })
    })

  it('applies the resolved backend effort via the thought_level config option', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'medium', 'high'])]
    })
    const runtime = createEffortRuntime(process, 'high')

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-effort', configId: 'effort', value: 'high' }
    ])
  })

  it('sends no set_config_option request when the resolved backend carries no effort', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'high'])]
    })
    const runtime = createEffortRuntime(process, undefined)

    await runtime.createSession({ cwd: '/workspace' })

    // Undefined means "don't override": the agent keeps its own default.
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('clamps the desired level to the closest advertised value', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'medium'])]
    })
    const runtime = createEffortRuntime(process, 'max')

    await runtime.createSession({ cwd: '/workspace' })

    // 'max' is not advertised; the model's top level takes its place instead of a no-op.
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-effort', configId: 'effort', value: 'medium' }
    ])
  })

  it('resolves effort against the option set reported after a model switch', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'model-a',
          options: [{ value: 'model-b', name: 'Model B' }]
        } as SessionConfigOption,
        thoughtLevelOption(['low', 'high'])
      ],
      // Effort levels are model-dependent: model-b tops out at 'medium', not the 'high' the
      // session originally advertised.
      updatedConfigOptions: [thoughtLevelOption(['low', 'medium'])]
    })
    const runtime = createEffortRuntime(process, 'max', 'model-b')

    await runtime.createSession({ cwd: '/workspace' })

    // Clamping against the pre-switch set would apply 'high' — invalid for model-b. The post-switch
    // set yields 'medium' instead.
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-effort', configId: 'model', value: 'model-b' },
      { sessionId: 's-effort', configId: 'effort', value: 'medium' }
    ])
  })

  it('sends no request when the agent advertises no recognizable effort level', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['default'])]
    })
    const runtime = createEffortRuntime(process, 'max')

    await runtime.createSession({ cwd: '/workspace' })

    // Only the 'default' sentinel is offered: nothing to clamp onto, the agent keeps its default.
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('live-applies an effort change to open sessions without a respawn', async () => {
    const process = new FakeAgentProcess()
    const spawn = vi.fn(() => asAgentProcess(process))
    const fakeAgent = startFakeAgent(process, ['s-live', 's-live-2'], {
      configOptions: [thoughtLevelOption(['default', 'low', 'medium', 'high'])]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn },
        executablePath: '/bin/claude',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    expect(fakeAgent.configChanges).toEqual([])

    const applied = await runtime.applyReasoningEffortChange('max')

    // The open session gets the closest advertised level over ACP, still on the original process.
    expect(applied).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-live', configId: 'effort', value: 'high' }
    ])

    // Sessions created later in the same process inherit the new level.
    await runtime.createSession({ cwd: '/workspace' })
    expect(fakeAgent.configChanges[1]).toMatchObject({ configId: 'effort', value: 'high' })
  })

  it('hands control back to the agent default when the level is cleared live', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-live'], {
      configOptions: [thoughtLevelOption(['default', 'low', 'high'])]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    await runtime.applyReasoningEffortChange('max')

    const applied = await runtime.applyReasoningEffortChange('default')

    // The advertised 'default' sentinel clears the previously forced level.
    expect(applied).toBe(true)
    expect(fakeAgent.configChanges.at(-1)).toEqual({
      sessionId: 's-live',
      configId: 'effort',
      value: 'default'
    })
  })

  it('resolves a live effort change against the options reported after a model switch', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-live'], {
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'model-a',
          options: [{ value: 'model-b', name: 'Model B' }]
        } as SessionConfigOption,
        thoughtLevelOption(['low', 'high'])
      ],
      // The model switch narrows the effort set: the session/new options are now stale.
      updatedConfigOptions: [thoughtLevelOption(['low', 'medium'])]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-b'
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const applied = await runtime.applyReasoningEffortChange('max')

    // The post-switch set tops out at 'medium'; the stale session/new set would wrongly yield 'high'.
    expect(applied).toBe(true)
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-live', configId: 'effort', value: 'medium' }
    ])
  })

  it('reports failure so the caller reconnects when a live apply is rejected', async () => {
    const process = new FakeAgentProcess()
    const agentOptions: Parameters<typeof startFakeAgent>[2] = {
      configOptions: [thoughtLevelOption(['low', 'high'])]
    }
    const fakeAgent = startFakeAgent(process, ['s-live'], agentOptions)
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    agentOptions.rejectSetConfigOption = true
    const applied = await runtime.applyReasoningEffortChange('high')

    // The level never reached the agent: returning false lets the caller reconnect instead of
    // leaving the UI showing a level the agent never received.
    expect(applied).toBe(false)
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('declines the live change when the framework bakes effort into its spawn config', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'high'])]
    })
    // createEffortRuntime drives the opencode framework, which advertises no live effort channel.
    const runtime = createEffortRuntime(process, 'high')
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const applied = await runtime.applyReasoningEffortChange('low')

    // The caller reconnects instead: nothing is sent, and the pending level stays as resolved.
    expect(applied).toBe(false)
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('falls back to a reconnect when no Codex session advertises an effort option', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-codex'], {
      // An adapter build that surfaces no thought_level option at all.
      configOptions: [],
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent'].map((id) => ({ id, name: id }))
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    const applied = await runtime.applyReasoningEffortChange('high')

    // Codex bakes effort into its spawn config, so only a reconnect delivers it here — the UI must
    // not report a level the running session never received.
    expect(applied).toBe(false)
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('reports success without a reconnect when a Claude session simply lacks effort support', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s-claude'], { configOptions: [] })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    // Claude has no config channel to fall back to: the model doesn't support effort, and a
    // respawn can't change that — report success rather than restarting for nothing.
    expect(await runtime.applyReasoningEffortChange('high')).toBe(true)
  })

  it('swallows a set_config_option rejection instead of failing the session', async () => {
    warnLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'high'])],
      rejectSetConfigOption: true
    })
    const runtime = createEffortRuntime(process, 'high')

    const session = await runtime.createSession({ cwd: '/workspace' })

    // Best-effort: the failure is logged, the session still comes up.
    expect(session.sessionId).toBe('s-effort')
    expect(fakeAgent.configChanges).toEqual([])
    const call = warnLogSpy.mock.calls.find(([message]) => message === 'set session effort failed')
    expect(call).toBeDefined()
    expect((call?.[1] as { sessionId: string }).sessionId).toBe('s-effort')
  })
})

describe('ACP runtime — session-creation and spawn diagnostics', () => {
  it('logs the createSession stage breadcrumbs through to completion', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['staged-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({
      cwd: '/workspace',
      projectName: 'my-project'
    })

    // Helper: fetch a breadcrumb's payload by message.
    const payloadOf = (message: string): Record<string, unknown> | undefined =>
      infoLogSpy.mock.calls.find(([m]) => m === message)?.[1] as Record<string, unknown> | undefined

    // Every stage of a successful createSession leaves a breadcrumb, and each carries the context that
    // makes it useful for diagnosis — not just the message name.
    expect(payloadOf('createSession: starting')).toMatchObject({
      request: { cwd: '/workspace', projectName: 'my-project' }
    })
    expect(payloadOf('createSession: ensureConnected')).toMatchObject({
      sessionCwd: resolve('/workspace'),
      projectName: 'my-project'
    })
    const mcpBreadcrumb = payloadOf('createSession: createMcpServers')
    expect(typeof mcpBreadcrumb?.artifactSessionId).toBe('string')
    expect(typeof mcpBreadcrumb?.notebookSessionId).toBe('string')
    expect(typeof (payloadOf('createSession: buildSession')?.mcpServersCount as number)).toBe(
      'number'
    )
    expect(payloadOf('createSession: configurePermissionProfile')).toMatchObject({
      sessionId: session.sessionId
    })
    expect(payloadOf('createSession: applySessionModel')).toMatchObject({
      sessionId: session.sessionId
    })
    expect(payloadOf('createSession: completed successfully')).toMatchObject({
      sessionId: session.sessionId
    })
    expect(payloadOf('ensureConnected: attempting connection')).toMatchObject({
      cwd: resolve('/workspace')
    })
    expect(payloadOf('ensureConnected: connection established')).toMatchObject({
      cwd: resolve('/workspace')
    })
  })

  it('logs "createSession: failed" and "ensureConnected: connect failed" when the connection fails', async () => {
    errorLogSpy.mockClear()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        throw new Error('spawn boom')
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/spawn boom/)

    const messages = errorLogSpy.mock.calls.map(([message]) => message)
    // The failure surfaces at each layer that owns a diagnostic log: the connect, the ensureConnected
    // wrapper, and createSession itself.
    expect(messages).toContain('agent connection failed')
    expect(messages).toContain('ensureConnected: connect failed')
    expect(messages).toContain('createSession: failed')
    const createFailure = errorLogSpy.mock.calls.find(
      ([message]) => message === 'createSession: failed'
    )
    expect((createFailure?.[1] as { error: string }).error).toBe('spawn boom')
  })

  it('logs "createSession: configurePermissionProfile failed" with the full error when the profile setup throws', async () => {
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['perm-fail-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    // Force the permission-profile step to throw after the session is built.
    const boom = Object.assign(new Error('permission setup failed'), { code: 'EPERM' })
    vi.spyOn(
      runtime as unknown as { configurePermissionProfile: () => Promise<void> },
      'configurePermissionProfile'
    ).mockRejectedValueOnce(boom)

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(boom)

    const call = errorLogSpy.mock.calls.find(
      ([message]) => message === 'createSession: configurePermissionProfile failed'
    )
    expect(call).toBeDefined()
    const data = call?.[1] as { error: string; code: string }
    expect(data.error).toBe('permission setup failed')
    expect(data.code).toBe('EPERM')
  })

  it('logs the resolved backend (executable + env keys, values omitted) and the spawned pid', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 7654
    startFakeAgent(process, ['spawn-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: { ANTHROPIC_AUTH_TOKEN: 'secret-should-not-be-logged', REGION: 'us' },
        args: ['--acp']
      })
    })

    await runtime.createSession({ cwd: '/workspace' })

    const resolved = infoLogSpy.mock.calls.find(([message]) => message === 'agent backend resolved')
    expect(resolved).toBeDefined()
    const resolvedData = resolved?.[1] as {
      executablePath: string
      envKeys: string[]
      args: string[]
    }
    expect(resolvedData.executablePath).toBe('/bin/agent')
    expect(resolvedData.envKeys).toEqual(['ANTHROPIC_AUTH_TOKEN', 'REGION'])
    expect(resolvedData.args).toEqual(['--acp'])
    // The env *values* must never be logged — only the keys.
    expect(JSON.stringify(resolvedData)).not.toContain('secret-should-not-be-logged')

    const spawned = infoLogSpy.mock.calls.find(([message]) => message === 'agent process spawned')
    expect((spawned?.[1] as { pid: number }).pid).toBe(7654)
  })

  it('logs "ensureConnected: connection is null after connect" when connect resolves without a connection', async () => {
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['null-conn-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    // Simulate the defensive branch: connect() resolves but never establishes this.connection.
    vi.spyOn(runtime, 'connect').mockResolvedValue(runtime.getSnapshot())

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
      /ACP connection failed/
    )

    const call = errorLogSpy.mock.calls.find(
      ([message]) => message === 'ensureConnected: connection is null after connect'
    )
    expect(call).toBeDefined()
    // The branch carries the target cwd + current status, not just the message.
    const data = call?.[1] as { cwd: string; status: string }
    expect(data.cwd).toBe(resolve('/workspace'))
    expect(typeof data.status).toBe('string')
  })

  it('does not let a cleanup failure mask the original connection error', async () => {
    errorLogSpy.mockClear()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        throw new Error('spawn boom')
      }
    })
    // First disconnectCurrent (pre-connect teardown) succeeds; the catch-path cleanup then throws.
    const disconnectSpy = vi.spyOn(
      runtime as unknown as { disconnectCurrent: () => Promise<unknown> },
      'disconnectCurrent'
    )
    disconnectSpy.mockResolvedValueOnce(runtime.getSnapshot())
    disconnectSpy.mockRejectedValueOnce(new Error('cleanup boom'))

    // The rejection is the ORIGINAL spawn failure, not the cleanup error.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/spawn boom/)

    // Both the original failure and the (non-masking) cleanup failure are recorded with context.
    const failed = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect((failed?.[1] as { error: string }).error).toBe('spawn boom')
    const cleanup = errorLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection cleanup failed'
    )
    expect(cleanup).toBeDefined()
    const cleanupData = cleanup?.[1] as { error: string; framework: string; cwd: string }
    expect(cleanupData.error).toBe('cleanup boom')
    expect(cleanupData.framework).toBe('claude-code')
    expect(cleanupData.cwd).toBe(resolve('/workspace'))
  })

  it('survives a hostile Error (throwing message getter) through the real connectFresh path', async () => {
    errorLogSpy.mockClear()
    // An Error whose message getter throws — the kind of value errorMessage/errorLogFields must tolerate
    // when it flows through connectFresh's catch into the snapshot + event text.
    const hostile = new Error('placeholder')
    Object.defineProperty(hostile, 'message', {
      configurable: true,
      get() {
        throw new Error('message getter trap')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            throw hostile
          }
        },
        executablePath: '/bin/agent',
        env: {}
      })
    })

    // The original hostile value propagates unchanged; handling it must not throw a different error.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(hostile)

    // The failure is still logged (message degraded to the marker, framework intact), and the snapshot's
    // error is a safe string — never a raw throwing value that would break the renderer broadcast.
    const failed = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect(failed).toBeDefined()
    expect((failed?.[1] as { error: string; framework: string }).framework).toBe('claude-code')
    expect(typeof runtime.getSnapshot().error).toBe('string')
  })
})

describe('ACP runtime — failure-path robustness (errorMessage coercion + sync-callback isolation)', () => {
  // Builds a runtime whose spawn throws an Error carrying `message`, runs createSession (which rejects),
  // and returns the resulting snapshot error text — exercising errorMessage through the real connectFresh
  // catch. `message` is set via defineProperty so non-string values survive assignment.
  const snapshotErrorForMessage = async (message: unknown): Promise<string | undefined> => {
    const hostile = new Error('placeholder')
    Object.defineProperty(hostile, 'message', { value: message, configurable: true })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            throw hostile
          }
        },
        executablePath: '/bin/agent',
        env: {}
      })
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(hostile)

    return runtime.getSnapshot().error
  }

  it('coerces a bigint message to a string in the snapshot', async () => {
    expect(await snapshotErrorForMessage(42n)).toBe('42')
  })

  it('coerces a Symbol message to a string in the snapshot', async () => {
    expect(await snapshotErrorForMessage(Symbol('boom'))).toBe('Symbol(boom)')
  })

  it('coerces an object message to a string in the snapshot', async () => {
    expect(await snapshotErrorForMessage({ nested: true })).toBe('[object Object]')
  })

  it('falls back to a safe string when the message throws on coercion', async () => {
    const hostileMessage = {
      [Symbol.toPrimitive]() {
        throw new Error('toPrimitive trap')
      }
    }
    const result = await snapshotErrorForMessage(hostileMessage)
    // Never a thrown value or non-string — just the guarded fallback.
    expect(result).toBe('unknown error')
  })

  // Builds a runtime whose spawn throws `spawnError`, with the given callbacks, and asserts createSession
  // still rejects with the ORIGINAL spawn error (a synchronous sink/logger throw must not mask it).
  const expectSpawnCausePropagates = async (
    spawnError: Error,
    callbacks: {
      onEvent?: () => void
      onStateChanged?: (state: { status: string }) => void
    }
  ): Promise<void> => {
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks,
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            throw spawnError
          }
        },
        executablePath: '/bin/agent',
        env: {}
      })
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(spawnError)
  }

  it('propagates the spawn cause even when onEvent throws synchronously', async () => {
    const spawnError = new Error('spawn failed A')
    await expectSpawnCausePropagates(spawnError, {
      onEvent: () => {
        throw new Error('onEvent boom')
      }
    })
  })

  it('propagates the spawn cause even when onStateChanged throws on the error state', async () => {
    const spawnError = new Error('spawn failed B')
    await expectSpawnCausePropagates(spawnError, {
      onStateChanged: (state) => {
        // Throw only for the terminal error emit so earlier "connecting" emits still work.
        if (state.status === 'error') throw new Error('onStateChanged boom')
      }
    })
  })

  it('propagates the spawn cause even when the logger throws', async () => {
    const spawnError = new Error('spawn failed C')
    errorLogSpy.mockImplementation(() => {
      throw new Error('logger boom')
    })
    try {
      await expectSpawnCausePropagates(spawnError, {})
    } finally {
      errorLogSpy.mockReset()
    }
  })

  it('still runs cleanup and emits the error state when the logger throws', async () => {
    const spawnError = new Error('spawn failed D')
    const statuses: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: { onStateChanged: (state) => statuses.push(state.status) },
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            throw spawnError
          }
        },
        executablePath: '/bin/agent',
        env: {}
      })
    })
    const disconnectSpy = vi.spyOn(
      runtime as unknown as { disconnectCurrent: () => Promise<unknown> },
      'disconnectCurrent'
    )
    errorLogSpy.mockImplementation(() => {
      throw new Error('logger boom')
    })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(spawnError)
    } finally {
      errorLogSpy.mockReset()
    }

    // A throwing logger must not skip the failure-handling side effects. disconnectCurrent runs twice:
    // once in the pre-connect teardown and once in the catch-path cleanup — asserting exactly two proves
    // the catch cleanup actually ran (dropping it would leave only the pre-connect call).
    expect(disconnectSpy).toHaveBeenCalledTimes(2)
    expect(statuses).toContain('error')
  })

  it('re-throws the permission-profile failure even when the logger throws', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['perm-log-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const boom = new Error('permission setup failed')
    vi.spyOn(
      runtime as unknown as { configurePermissionProfile: () => Promise<void> },
      'configurePermissionProfile'
    ).mockRejectedValueOnce(boom)
    errorLogSpy.mockImplementation(() => {
      throw new Error('logger boom')
    })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(boom)
    } finally {
      errorLogSpy.mockReset()
    }
  })

  it('re-throws the null-connection failure even when the logger throws', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['null-log-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    vi.spyOn(runtime, 'connect').mockResolvedValue(runtime.getSnapshot())
    errorLogSpy.mockImplementation(() => {
      throw new Error('logger boom')
    })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
        /ACP connection failed/
      )
    } finally {
      errorLogSpy.mockReset()
    }
  })

  it('re-throws the cause on the abandoned path even when the warn logger throws', async () => {
    const process = new FakeAgentProcess()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        ;(runtime as unknown as { connectionGeneration: number }).connectionGeneration += 1
        return asAgentProcess(process)
      }
    })
    warnLogSpy.mockImplementation(() => {
      throw new Error('warn boom')
    })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/superseded/i)
    } finally {
      warnLogSpy.mockReset()
    }
  })
})

describe('prompt streaming after a context reset', () => {
  it('streams the assistant reply as events for a prompt sent right after the reset', async () => {
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; sessionId?: string; role?: string; text?: string }> = []
    // A second agent session id backs the fresh adoption the reset performs.
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'first turn' })
    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })

    events.length = 0
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'edited turn',
      historyPreamble: 'first turn\n\nreply for first turn'
    })

    // The fresh agent session's reply streams through the same event channel, labelled with the
    // app-facing session id so the renderer grows the truncated conversation.
    const assistantChunks = events.filter(
      (event) => event.kind === 'message' && event.role === 'assistant'
    )
    expect(assistantChunks.length).toBeGreaterThan(0)
    expect(assistantChunks[0]).toMatchObject({
      sessionId: session.sessionId,
      text: 'reply for remote-session-2'
    })
  })
})
