import * as acp from '@agentclientprotocol/sdk'
import type {
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AcpRuntime } from './runtime.test-utils'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import { createAcpTaskAgentPort } from './task-agent-port'
import type { AcpAgentConnectionAdapter } from './agent-connection-adapter'
import type { AcpConnectionCloseWorkflow } from './connection-close-workflow'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import type { RuntimeEventInput } from './runtime-snapshot-owner'
import { AcpPermissionContext } from './permission-context'
import { permissionRequestFingerprint } from './permission-broker'
import { ACP_STEERING_METHOD } from './native-follow-up'
import { ContextUsageTracker, type TokenCounter } from './context-usage-tracker'
import {
  ACP_PROMPT_FAILED_EVENT_TITLE,
  type AcpContextUsage,
  type AcpPermissionResponse,
  type AcpPermissionRequest,
  type AcpRuntimeEvent,
  type AcpStateSnapshot
} from '../../shared/acp'
import type { ModelReasoningEffort } from '../../shared/reasoning-effort'
import { terminateProcessTree } from '../process-tree'
import { AgentMcpHttpHost } from './mcp-http-host'
import { SIDE_CHAT_SESSION_CAPABILITY_POLICY } from './session-capability-owner'
import { SkillRegistry } from '../skills/registry'
import {
  claudeCodeFramework,
  codeBuddyFramework,
  codexFramework,
  opencodeFramework,
  type AgentModelChangeTarget,
  type ResolvedAgentBackend
} from '../agent-framework'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-server'
import { CODEX_BRIDGE_MODEL } from '../agent-framework/codex'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { validateDurableMessageOwnership } from '../artifacts/provenance-message-finalization'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { ArtifactRunClaim } from '../artifacts/run-registry'
import { createPngBytes, createPngInlineSource } from '../artifacts/artifact-test-fixtures'
import { writeArtifactFileForCurrentRun } from '../artifacts/mcp-server'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { BEGIN_ACTIVITY_GROUP_TOOL_NAME } from '../../shared/activity-groups'
import type { UploadedAttachment } from '../../shared/uploads'
import {
  createLinearConversationGraph,
  forkConversationAfterActivity,
  getActiveConversationContext,
  projectConversationMessage,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES } from '../uploads/attachment-media'
import { ConversationSkillImporter, SkillImportApprovalBroker } from '../skills/conversation-import'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
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

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => {
    throw new Error('invalid test PDF')
  }
}))

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

const createBackendLeaseHarness = (): {
  release: () => Promise<void>
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
} => {
  const release = vi.fn(async () => undefined)
  return {
    release,
    lease: {
      selectSkills: vi.fn(async () => []),
      registerReviewerSession: vi.fn(),
      unregisterReviewerSession: vi.fn(() => false),
      release
    }
  }
}

// Creates a manually controlled promise for ordering async protocol steps.
type Deferred<Value = void> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
}

const createDeferred = <Value = void>(): Deferred<Value> => {
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
    onSetConfigOption?: (context: {
      sessionId: string
      configId: string
      value: string | boolean
    }) => Promise<void> | void
    // When true, the resume handler rejects with the ACP "Resource not found" (-32002) — the signal a
    // replaced agent (e.g. after a provider switch) gives for a session id it does not hold.
    resumeNotFound?: boolean
    // When true, the resume handler rejects with a detail-free generic "Internal error" (-32603).
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
    newSessionError?: unknown
    onNewSession?: (context: { sessionId: string; index: number }) => Promise<void> | void
    onResumeRequest?: (context: {
      sessionId: string
      index: number
      signal: AbortSignal
    }) => Promise<void> | void
    onResume?: (sessionId: string) => Promise<void> | void
    onSetMode?: (context: { sessionId: string; modeId: string }) => Promise<void> | void
    onClose?: (sessionId: string) => Promise<void> | void
    onPrompt?: (context: {
      sessionId: string
      text: string
      prompt: ContentBlock[]
    }) => Promise<PromptResponse | void> | PromptResponse | void
    elicitationForPrompt?: (context: {
      sessionId: string
      text: string
    }) => acp.CreateElicitationRequest | undefined
    codexMcpToolCallBeforeElicitation?: {
      toolCallId: string
      server: string
      tool: string
      arguments?: Record<string, unknown>
    }
    elicitationRepeatCount?: number
    toolForPrompt?: (text: string) => { toolCallId: string; title: string } | undefined
    replyForPrompt?: (text: string) => string
    usageForPrompt?: (text: string) => { used: number; size: number } | undefined
    claudeTurnCountForPrompt?: (text: string) => number | undefined
    claudeResultMessagesForPrompt?: (text: string) => Array<{
      numTurns: number
      origin?: string
    }>
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
  initializeRequests: acp.InitializeRequest[]
  elicitationResponses: acp.CreateElicitationResponse[]
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
  const initializeRequests: acp.InitializeRequest[] = []
  const elicitationResponses: acp.CreateElicitationResponse[] = []
  let sessionIndex = 0
  let resumeIndex = 0

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      initializeRequests.push(ctx.params)
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            ...(options.supportsClose === false ? {} : { close: {} }),
            ...(options.supportsResume === false ? {} : { resume: {} })
          }
        },
        authMethods: []
      }
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      authRequests.push(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.providers.set, (ctx) => {
      providerConfigurations.push(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      if (options.newSessionError !== undefined) throw options.newSessionError

      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })
      // Return deterministic ids so the tests can assert exact routing.
      const index = sessionIndex
      const sessionId = sessionIds[sessionIndex]
      sessionIndex += 1

      await options.onNewSession?.({ sessionId, index })

      return {
        sessionId,
        modes: options.modes,
        ...(options.configOptions ? { configOptions: options.configOptions } : {})
      }
    })
    .onRequest(acp.methods.agent.session.resume, async (ctx) => {
      const index = resumeIndex
      resumeIndex += 1
      await options.onResumeRequest?.({
        sessionId: ctx.params.sessionId,
        index,
        signal: ctx.signal
      })

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

      await options.onResume?.(ctx.params.sessionId)

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
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      if (options.rejectSetConfigOption) throw acp.RequestError.internalError()

      configChanges.push({
        sessionId: ctx.params.sessionId,
        configId: ctx.params.configId,
        value: ctx.params.value
      })
      await options.onSetConfigOption?.({
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
      const elicitation = options.elicitationForPrompt?.({
        sessionId: ctx.params.sessionId,
        text
      })
      if (elicitation) {
        const codexMcpToolCall = options.codexMcpToolCallBeforeElicitation
        if (codexMcpToolCall) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: codexMcpToolCall.toolCallId,
              kind: 'execute',
              title: `mcp.${codexMcpToolCall.server}.${codexMcpToolCall.tool}`,
              status: 'pending',
              rawInput: {
                server: codexMcpToolCall.server,
                tool: codexMcpToolCall.tool,
                arguments: codexMcpToolCall.arguments ?? {}
              },
              _meta: { is_mcp_tool_call: true }
            }
          })
        }
        for (let index = 0; index < (options.elicitationRepeatCount ?? 1); index += 1) {
          const response = await ctx.client.request(
            acp.methods.client.elicitation.create,
            elicitation
          )
          elicitationResponses.push(response)
        }
      }
      const tool = options.toolForPrompt?.(text)
      if (tool) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: tool.toolCallId,
            title: tool.title,
            status: 'completed'
          }
        })
      }
      const usage = options.usageForPrompt?.(text)
      if (usage) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'usage_update', ...usage }
        })
      }
      const claudeTurnCount = options.claudeTurnCountForPrompt?.(text)
      const claudeResultMessages =
        options.claudeResultMessagesForPrompt?.(text) ??
        (claudeTurnCount === undefined ? [] : [{ numTurns: claudeTurnCount, origin: 'human' }])
      for (const result of claudeResultMessages) {
        await ctx.client.notify('_claude/sdkMessage', {
          sessionId: ctx.params.sessionId,
          message: {
            type: 'result',
            num_turns: result.numTurns,
            ...(result.origin === undefined ? {} : { origin: { kind: result.origin } })
          }
        })
      }
      // Stream one assistant chunk through the client callback path before stopping.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: {
            type: 'text',
            text: options.replyForPrompt?.(text) ?? `reply for ${ctx.params.sessionId}`
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
    actions,
    initializeRequests,
    elicitationResponses
  }
}

const createModes = (
  ids: string[],
  currentModeId: string = ids[0] ?? 'default'
): SessionModeState => ({
  currentModeId,
  availableModes: ids.map((id) => ({ id, name: id }))
})

const startPendingReviewerRace = async (
  sessionIds: string[]
): Promise<{
  fakeAgent: ReturnType<typeof startFakeAgent>
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
  runtime: AcpRuntime
  reviewer: ReturnType<AcpRuntime['buildReviewerSession']>
  request: Parameters<AcpRuntime['buildReviewerSession']>[0]
  releaseReviewerMode: Deferred
  modeRequestCount: () => number
}> => {
  const process = new FakeAgentProcess()
  const reviewerModeStarted = createDeferred()
  const releaseReviewerMode = createDeferred()
  let modeRequestCount = 0
  const fakeAgent = startFakeAgent(process, sessionIds, {
    modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
    onSetMode: async () => {
      modeRequestCount += 1
      if (modeRequestCount === 1) {
        reviewerModeStarted.resolve()
        await releaseReviewerMode.promise
      }
    }
  })
  const { lease } = createBackendLeaseHarness()
  const runtime = new AcpRuntime({
    appVersion: '0.1.0',
    defaultCwd: '/workspace',
    resolveBackend: () => ({
      framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
      executablePath: '/bin/codex-acp',
      env: {},
      responsesBridgeLease: lease
    })
  })
  const request = {
    cwd: '/workspace',
    mcpServers: [
      {
        type: 'http' as const,
        name: 'open-science-reviewer',
        url: 'http://127.0.0.1:1/mcp',
        headers: []
      }
    ]
  }
  const reviewer = runtime.buildReviewerSession(request)
  await reviewerModeStarted.promise

  return {
    fakeAgent,
    lease,
    runtime,
    reviewer,
    request,
    releaseReviewerMode,
    modeRequestCount: () => modeRequestCount
  }
}

type StartPrimarySession = (runtime: AcpRuntime) => ReturnType<AcpRuntime['createSession']>

const startPendingPrimaryRace = async (
  sessionIds: string[],
  startPrimary: StartPrimarySession
): Promise<{
  fakeAgent: ReturnType<typeof startFakeAgent>
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
  runtime: AcpRuntime
  primary: ReturnType<AcpRuntime['createSession']>
  reviewer: ReturnType<AcpRuntime['buildReviewerSession']>
  releasePrimaryMode: Deferred
  modeRequestCount: () => number
}> => {
  const process = new FakeAgentProcess()
  const primaryModeStarted = createDeferred()
  const releasePrimaryMode = createDeferred()
  let modeRequestCount = 0
  const fakeAgent = startFakeAgent(process, sessionIds, {
    modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
    onSetMode: async () => {
      modeRequestCount += 1
      if (modeRequestCount === 1) {
        primaryModeStarted.resolve()
        await releasePrimaryMode.promise
      }
    }
  })
  const { lease } = createBackendLeaseHarness()
  const runtime = new AcpRuntime({
    appVersion: '0.1.0',
    defaultCwd: '/workspace',
    resolveBackend: () => ({
      framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
      executablePath: '/bin/codex-acp',
      env: {},
      responsesBridgeLease: lease
    })
  })
  const primary = startPrimary(runtime)
  await primaryModeStarted.promise
  const reviewer = runtime.buildReviewerSession({
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

  return {
    fakeAgent,
    lease,
    runtime,
    primary,
    reviewer,
    releasePrimaryMode,
    modeRequestCount: () => modeRequestCount
  }
}

let temporaryRoot: string | undefined
const temporaryDisconnections: Array<() => Promise<void>> = []

const createTemporaryRoot = async (): Promise<string> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-artifacts-'))
  return temporaryRoot
}

const createManagedReadLease = async ({
  source,
  projectId,
  sessionId,
  fileId,
  path,
  name,
  mimeType
}: {
  source: 'artifact' | 'upload'
  projectId: string
  sessionId: string
  fileId: string
  path: string
  name: string
  mimeType?: string
}): Promise<Record<string, unknown>> => {
  const content = await readFile(path)
  const checksum = createHash('sha256').update(content).digest('hex')
  const versionId = `version-${fileId}`
  return {
    path,
    size: content.byteLength,
    read: vi.fn(async () => content),
    readRange: vi.fn(async (begin: number, end: number) => content.subarray(begin, end)),
    copyTo: vi.fn(async (destinationPath: string) =>
      writeFile(destinationPath, content, { flag: 'wx' })
    ),
    verifyUnchanged: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    logicalFile: {
      source,
      id: fileId,
      projectId,
      sessionId,
      displayName: name,
      currentVersionId: versionId
    },
    version: {
      id: versionId,
      fileId,
      versionNumber: 1,
      filename: name,
      contentType: mimeType,
      checksum,
      createdAt: new Date('2026-01-01T00:00:00.000Z')
    }
  }
}

const buildStoredSkillArchive = (skillName: string): Buffer => {
  const path = Buffer.from('SKILL.md', 'utf8')
  const content = Buffer.from(`---\nname: ${skillName}\n---\nFollow the workflow.`, 'utf8')
  const local = Buffer.alloc(30 + path.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt32LE(content.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(path.length, 26)
  path.copy(local, 30)

  const central = Buffer.alloc(46 + path.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt32LE(content.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(path.length, 28)
  path.copy(central, 46)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length + content.length, 16)
  return Buffer.concat([local, content, central, end])
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
    toolRawInput?: unknown
    permissionRawInput?: unknown
    providerToolName?: string
    announcedProviderToolName?: string
    codexMcpIdentity?: {
      server: string
      tool: string
      arguments?: Record<string, unknown>
    }
    codexMcpMarker?: boolean
    codexMcpTitle?: string
    codexMcpApprovalViaElicitation?: boolean
    announceToolCall?: boolean
    toolCallUpdateRawInput?: unknown
    toolCallUpdateCount?: number
    skipPermissionRequest?: boolean
    sparseCodexMcpApproval?: boolean
    modes?: SessionModeState
    onSetMode?: (context: {
      sessionId: string
      modeId: string
      notifyCurrentMode: (currentModeId: string) => Promise<void>
    }) => Promise<void> | void
    permissionOptions?: Array<{
      optionId: string
      name: string
      kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
    }>
    onPermissionResponse?: (response: unknown) => void
    onSteer?: (params: unknown) => void
    advertiseSteering?: boolean
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
      ...(options.advertiseSteering ? { _meta: { steering: { supported: true } } } : {}),
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: options.newSessionId,
      modes: options.modes
    }))
    .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
      await options.onSetMode?.({
        sessionId: ctx.params.sessionId,
        modeId: ctx.params.modeId,
        notifyCurrentMode: async (currentModeId) =>
          ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId }
          })
      })
      return {}
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (options.resume === 'notFound') {
        throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
      }

      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      if (options.announceToolCall) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: options.toolCallId,
            title: options.toolTitle,
            kind: options.toolKind ?? 'other',
            status: 'pending',
            ...(options.toolRawInput === undefined ? {} : { rawInput: options.toolRawInput }),
            ...(options.announcedProviderToolName
              ? { _meta: { toolName: options.announcedProviderToolName } }
              : {})
          }
        })
      }

      for (let index = 0; index < (options.toolCallUpdateCount ?? 0); index += 1) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: options.toolCallId,
            status: 'in_progress',
            rawInput: options.toolCallUpdateRawInput
          }
        })
      }

      if (options.codexMcpIdentity) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: options.toolCallId,
            kind: 'execute',
            title:
              options.codexMcpTitle ??
              `mcp.${options.codexMcpIdentity.server}.${options.codexMcpIdentity.tool}`,
            status: 'pending',
            rawInput: {
              server: options.codexMcpIdentity.server,
              tool: options.codexMcpIdentity.tool,
              arguments: options.codexMcpIdentity.arguments ?? {}
            },
            ...(options.codexMcpMarker === false ? {} : { _meta: { is_mcp_tool_call: true } })
          }
        })
      }

      // opencode renames MCP tools <server>_<tool>; classification must come from the session's
      // recorded MCP server names, so this exercises the sessionMcpServerNames map end to end.
      if (options.codexMcpApprovalViaElicitation) {
        const response = await ctx.client.request(acp.methods.client.elicitation.create, {
          mode: 'form',
          sessionId: ctx.params.sessionId,
          toolCallId: options.toolCallId,
          message: 'Allow this MCP tool?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call' }
        })
        options.onPermissionResponse?.(response)
        return { stopReason: 'end_turn' }
      }

      if (options.skipPermissionRequest) return { stopReason: 'end_turn' }

      const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: options.toolCallId,
          ...(options.sparseCodexMcpApproval ? {} : { title: options.toolTitle }),
          status: 'pending',
          ...(options.toolKind === null
            ? {}
            : { kind: options.toolKind ?? (options.sparseCodexMcpApproval ? 'execute' : 'other') }),
          ...((options.permissionRawInput ?? options.toolRawInput) === undefined
            ? {}
            : { rawInput: options.permissionRawInput ?? options.toolRawInput }),
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
    .onRequest(
      ACP_STEERING_METHOD,
      (params) => params,
      (ctx) => {
        options.onSteer?.(ctx.params)
        return { outcome: 'injected' }
      }
    )
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )
}

const mcpServerNamesFor = (runtime: AcpRuntime, sessionId: string): readonly string[] =>
  (
    runtime as unknown as {
      providerSessionCreator: {
        deps: {
          capabilities: { mcpServerNamesFor: (sessionId: string) => readonly string[] }
        }
      }
    }
  ).providerSessionCreator.deps.capabilities.mcpServerNamesFor(sessionId)

const activeSessionForTest = (
  runtime: AcpRuntime,
  sessionId: string
): { dispose: () => void } | undefined =>
  (
    runtime as unknown as {
      activeSessionFor: (sessionId: string) => { dispose: () => void } | undefined
    }
  ).activeSessionFor(sessionId)

const providerReconnectPending = (runtime: AcpRuntime): boolean =>
  (
    runtime as unknown as {
      connectionTransitions: { providerReconnectPending: boolean }
    }
  ).connectionTransitions.providerReconnectPending

const contextUsageMap = (
  runtime: AcpRuntime
): { set: (sessionId: string, usage: AcpContextUsage) => void } => {
  const tracker = (
    runtime as unknown as {
      contextCompactionWorkflow: { options: { context: ContextUsageTracker } }
    }
  ).contextCompactionWorkflow.options.context
  return {
    set: (sessionId, usage) => tracker.reconcileProviderUsage(sessionId, usage)
  }
}

const promptContentLifecycle = (
  runtime: AcpRuntime
): Pick<AcpPromptContentOwner, 'prepare' | 'resetSession'> =>
  (
    runtime as unknown as {
      contextCompactionWorkflow: {
        options: { promptContent: Pick<AcpPromptContentOwner, 'prepare' | 'resetSession'> }
      }
    }
  ).contextCompactionWorkflow.options.promptContent

const resolveArtifactRunClaim = (runtime: AcpRuntime, claimId: string): ArtifactRunClaim =>
  (
    runtime as unknown as {
      artifactTurns: {
        options: { runRegistry: { resolve: (id: string) => ArtifactRunClaim } }
      }
    }
  ).artifactTurns.options.runRegistry.resolve(claimId)

const handleSessionUpdate = (runtime: AcpRuntime, notification: SessionNotification): void =>
  (
    runtime as unknown as {
      sessionUpdateProjector: { route: (value: SessionNotification) => void }
    }
  ).sessionUpdateProjector.route(notification)

type ReviewerOwnerProbe = {
  contextFor: (sessionId: string) =>
    | {
        frameworkId: string
        mcpServerNames: readonly string[]
        role: 'reviewer'
      }
    | undefined
  snapshot: () => Array<{
    lifecycle: 'pending' | 'active'
    role: 'reviewer'
    sessionId: string
  }>
}

const reviewerOwnerProbe = (runtime: AcpRuntime): ReviewerOwnerProbe =>
  (runtime as unknown as { reviewerSessions: ReviewerOwnerProbe }).reviewerSessions

const reviewerSessionIds = (runtime: AcpRuntime): Set<string> =>
  new Set(
    reviewerOwnerProbe(runtime)
      .snapshot()
      .filter(({ lifecycle }) => lifecycle === 'active')
      .map(({ sessionId }) => sessionId)
  )

const pendingReviewerSessionIds = (runtime: AcpRuntime): Map<string, symbol> =>
  new Map(
    reviewerOwnerProbe(runtime)
      .snapshot()
      .filter(({ lifecycle }) => lifecycle === 'pending')
      .map(({ sessionId }) => [sessionId, Symbol.for(sessionId)])
  )

const permissionContext = (runtime: AcpRuntime): AcpPermissionContext =>
  (runtime as unknown as { permissionContext: AcpPermissionContext }).permissionContext

const openCodeUsageApiForTest = (runtime: AcpRuntime): unknown =>
  (
    runtime as unknown as {
      backendGeneration: { openCodeUsageApi: () => unknown }
    }
  ).backendGeneration.openCodeUsageApi()

const connectionCloseForTest = (
  runtime: AcpRuntime
): Pick<AcpConnectionCloseWorkflow, 'disconnectCurrent'> =>
  (runtime as unknown as { connectionClose: AcpConnectionCloseWorkflow }).connectionClose

const publicationForTest = (
  runtime: AcpRuntime
): { pushEvent: (event: RuntimeEventInput) => void } =>
  (runtime as unknown as { publication: { pushEvent: (event: RuntimeEventInput) => void } })
    .publication

const invalidatePendingSessionStartupsForTest = (runtime: AcpRuntime): void => {
  const owners = runtime as unknown as {
    generationActivity: { invalidateStartups: () => void }
    reviewerSessions: { invalidatePending: () => void }
    sessionRegistry: { invalidatePending: () => void }
  }
  owners.generationActivity.invalidateStartups()
  owners.sessionRegistry.invalidatePending()
  owners.reviewerSessions.invalidatePending()
}

const codexMcpToolIdentitiesMap = (runtime: AcpRuntime): Map<string, Map<string, unknown>> =>
  (
    permissionContext(runtime) as unknown as {
      codexMcpToolIdentities: Map<string, Map<string, unknown>>
    }
  ).codexMcpToolIdentities

const opencodeMcpToolInputsMap = (runtime: AcpRuntime): Map<string, Map<string, unknown>> =>
  (
    permissionContext(runtime) as unknown as {
      opencodeMcpToolInputs: Map<string, Map<string, unknown>>
    }
  ).opencodeMcpToolInputs

const opencodeMcpToolInputWaitersMap = (
  runtime: AcpRuntime
): Map<string, Map<string, Set<unknown>>> =>
  (
    permissionContext(runtime) as unknown as {
      opencodeMcpToolInputWaiters: Map<string, Map<string, Set<unknown>>>
    }
  ).opencodeMcpToolInputWaiters

const waitForOpenCodeMcpToolInput = (
  runtime: AcpRuntime,
  sessionId: string,
  toolCallId: string
): Promise<'ready' | 'timeout' | 'cancelled'> =>
  (
    permissionContext(runtime) as unknown as {
      waitForOpenCodeMcpToolInput: (
        currentSessionId: string,
        currentToolCallId: string,
        context: {
          sessionId: string
          framework: 'opencode'
          mcpServerNames: readonly string[]
          isCancelled: () => boolean
        }
      ) => Promise<'ready' | 'timeout' | 'cancelled'>
    }
  ).waitForOpenCodeMcpToolInput(sessionId, toolCallId, {
    sessionId,
    framework: 'opencode',
    mcpServerNames: ['open-science-notebook'],
    isCancelled: () => false
  })

const observePermissionToolContext = (
  runtime: AcpRuntime,
  notification: SessionNotification
): void => permissionContext(runtime).observeProviderUpdate(notification)

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
  await Promise.allSettled(temporaryDisconnections.splice(0).map((disconnect) => disconnect()))
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
          providerId: 'openai',
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
        providerId: 'openai',
        apiType: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        headers: { authorization: 'Bearer local-token' }
      }
    ])
  })

  it('preserves resolved backend initialization when the agent process is injected', async () => {
    const process = new FakeAgentProcess()
    const actions: string[] = []
    acp
      .agent({ name: 'injected-process-agent' })
      .onRequest(acp.methods.agent.initialize, () => {
        actions.push('initialize')
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
          authMethods: []
        }
      })
      .onRequest(acp.methods.agent.authenticate, () => {
        actions.push('authenticate')
        return {}
      })
      .onRequest(acp.methods.agent.providers.set, () => {
        actions.push('configure-provider')
        return {}
      })
      .onRequest(acp.methods.agent.session.new, () => {
        actions.push('session-new')
        return {
          sessionId: 'injected-session',
          modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
        }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const spawnAgent = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent,
      resolveBackend: () => ({
        framework: codexFramework,
        executablePath: '/bin/codex-acp',
        env: {},
        authentication: { methodId: 'api-key' },
        providerConfiguration: {
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: {}
        }
      })
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect({ actions, spawnCount: spawnAgent.mock.calls.length }).toEqual({
      actions: ['initialize', 'authenticate', 'configure-provider', 'session-new'],
      spawnCount: 1
    })
  })

  it('publishes connected only after initialize, authentication, and provider configuration', async () => {
    const process = new FakeAgentProcess()
    const actions: string[] = []
    acp
      .agent({ name: 'connection-order-agent' })
      .onRequest(acp.methods.agent.initialize, () => {
        actions.push('initialize')
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
          authMethods: []
        }
      })
      .onRequest(acp.methods.agent.authenticate, () => {
        actions.push('authenticate')
        return {}
      })
      .onRequest(acp.methods.agent.providers.set, () => {
        actions.push('configure-provider')
        return {}
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
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        authentication: { methodId: 'api-key' },
        providerConfiguration: {
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: {}
        }
      }),
      callbacks: {
        onEvent: (event) => {
          if (event.title === 'Agent initialized') actions.push('initialized-event')
        },
        onStateChanged: (snapshot) => {
          if (snapshot.status === 'connected') actions.push('publish-connected')
        }
      }
    })

    await runtime.connect({ cwd: '/workspace' })

    expect(actions).toEqual([
      'initialize',
      'authenticate',
      'configure-provider',
      'initialized-event',
      'publish-connected'
    ])
    await runtime.disconnect()
  })

  it('ignores a detached connection closing after its replacement is connected', async () => {
    const oldProcess = new FakeAgentProcess()
    const replacementProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['old-session'])
    startFakeAgent(replacementProcess, ['replacement-session'])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(spawnCount++ === 0 ? oldProcess : replacementProcess)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.disconnect()
    await runtime.createSession({ cwd: '/workspace' })

    oldProcess.stdout.end()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionIds: ['replacement-session']
    })
    expect(replacementProcess.killed).toBe(false)
    await runtime.disconnect()
  })

  it('ignores detached process events after a replacement connection is published', async () => {
    const oldProcess = new FakeAgentProcess()
    const replacementProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['old-session'])
    startFakeAgent(replacementProcess, ['replacement-session'])
    const events: AcpRuntimeEvent[] = []
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: { onEvent: (event) => events.push(event) },
      spawnAgent: () => asAgentProcess(spawnCount++ === 0 ? oldProcess : replacementProcess)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.disconnect()
    await runtime.createSession({ cwd: '/workspace' })
    events.length = 0

    oldProcess.stderr.emit('data', Buffer.from('late detached stderr'))
    oldProcess.emit('error', new Error('late detached error'))
    oldProcess.emit('exit', 1, null)

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionIds: ['replacement-session']
    })
    expect(events).toEqual([])
    await runtime.disconnect()
  })

  it('keeps using a published connection when teardown fails before resource detach', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['first-session', 'successor-session'])
    const spawnAgent = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent
    })
    await runtime.createSession({ cwd: '/workspace' })
    const disconnectCurrentSpy = vi
      .spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
      .mockRejectedValueOnce(new Error('disconnect failed before detach'))

    try {
      await expect(runtime.disconnect()).rejects.toThrow('disconnect failed before detach')
      await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toMatchObject({
        sessionId: 'successor-session'
      })
      expect(fakeAgent.newSessions).toHaveLength(2)
      expect(spawnAgent).toHaveBeenCalledOnce()
      expect(process.killed).toBe(false)
    } finally {
      disconnectCurrentSpy.mockRestore()
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it.each(['initialize', 'authenticate'] as const)(
    'clears one-shot connection intents when %s fails',
    async (failureStage) => {
      const process = new FakeAgentProcess()
      const providerSet = vi.fn()
      acp
        .agent({ name: `failing-${failureStage}-agent` })
        .onRequest(acp.methods.agent.initialize, () => {
          if (failureStage === 'initialize') throw new Error('initialize failed')
          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false },
            authMethods: []
          }
        })
        .onRequest(acp.methods.agent.authenticate, () => {
          throw new Error('authenticate failed')
        })
        .onRequest(acp.methods.agent.providers.set, providerSet)
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

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
            providerId: 'openai',
            apiType: 'openai',
            baseUrl: 'http://127.0.0.1:1234/v1',
            headers: { authorization: 'Bearer test-only-token' }
          }
        })
      })

      await expect(runtime.connect({ cwd: '/workspace' })).rejects.toThrow()

      const internal = runtime as unknown as {
        pendingAuthentication?: unknown
        pendingProviderConfiguration?: unknown
      }
      expect(internal.pendingAuthentication).toBeUndefined()
      expect(internal.pendingProviderConfiguration).toBeUndefined()
      expect(providerSet).not.toHaveBeenCalled()
    }
  )

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
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('unavailable-model disposal failed')
      })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
        'The selected model "gpt-subscription" is not available for this Codex account.'
      )
    } finally {
      disposeSpy.mockRestore()
    }
  })

  it('does not tokenize against an optional model that the Agent could not apply', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['fallback-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode-acp',
        env: {},
        sessionModel: 'claude-sonnet-4-5',
        contextUsageModel: 'claude-sonnet-4-5',
        contextWindow: 1_000_000
      }),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 'fallback-session',
      update: { sessionUpdate: 'usage_update', used: 15, size: 128000 }
    })

    expect(
      runtime.getSnapshot().contextUsageBySession['fallback-session']?.breakdown
    ).toMatchObject({
      tokenizer: 'cl100k_base'
    })
    expect(
      runtime.getSnapshot().contextUsageBySession['fallback-session']?.breakdown
    ).not.toHaveProperty('model')
    expect(runtime.getSnapshot().contextUsageBySession['fallback-session']?.size).toBe(128_000)
  })

  it('tokenizes against an optional OpenCode model after the Agent confirms it', async () => {
    const process = new FakeAgentProcess()
    const configOptions = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'openai/gpt-4.1-mini',
        options: [
          { value: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini' },
          { value: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }
        ]
      } as SessionConfigOption
    ]
    startFakeAgent(process, ['selected-session'], { configOptions })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode-acp',
        env: {},
        sessionModel: 'claude-sonnet-4-5',
        contextUsageModel: 'claude-sonnet-4-5'
      }),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 'selected-session',
      update: { sessionUpdate: 'usage_update', used: 15, size: 200000 }
    })

    expect(
      runtime.getSnapshot().contextUsageBySession['selected-session']?.breakdown
    ).toMatchObject({
      tokenizer: 'anthropic',
      model: 'claude-sonnet-4-5'
    })
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
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('required-model disposal failed')
      })

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
        'The selected model "gpt-subscription" could not be applied'
      )
    } finally {
      disposeSpy.mockRestore()
    }
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

describe('ACP runtime provider prompt acceptance', () => {
  it.each([
    ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
    ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
    ['Codex Responses', codexFramework, 'codex-responses', 'codex:provider-a'],
    ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
  ] as const)(
    'forwards visual input and reports provider acceptance after the first %s update',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      let receivedPrompt: ContentBlock[] = []
      startFakeAgent(process, ['acceptance-session'], {
        onPrompt: ({ prompt }) => {
          receivedPrompt = prompt
        },
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const onProviderPromptAccepted = vi.fn()
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        callbacks: { onProviderPromptAccepted },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      const imageData = Buffer.from(`visual-${modelRoute}`).toString('base64')
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'Research this.',
        currentImages: [
          {
            mimeType: 'image/png',
            data: imageData,
            byteLength: Buffer.byteLength(`visual-${modelRoute}`)
          }
        ]
      })

      expect(receivedPrompt).toContainEqual({
        type: 'image',
        mimeType: 'image/png',
        data: imageData
      })
      expect(onProviderPromptAccepted).toHaveBeenCalledOnce()
      expect(onProviderPromptAccepted).toHaveBeenCalledWith(session.sessionId, undefined)
    }
  )
})

describe('ACP runtime incremental publication routes', () => {
  it.each([
    ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
    ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
    ['Codex Responses', codexFramework, 'codex-responses', 'codex:provider-a'],
    ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
  ] as const)(
    'keeps %s tool and message updates on the incremental channel',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, ['incremental-session'], {
        toolForPrompt: () => ({
          toolCallId: 'notebook-tool-1',
          title: 'Notebook run'
        }),
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const publicationOrder: string[] = []
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        callbacks: {
          onEvent: (event) => publicationOrder.push(`event:${event.kind}`),
          onStateChanged: () => publicationOrder.push('state')
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      publicationOrder.length = 0
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Run the notebook.' })

      const toolEventIndex = publicationOrder.indexOf('event:tool')
      expect(toolEventIndex).toBeGreaterThanOrEqual(0)
      expect(publicationOrder.slice(toolEventIndex, toolEventIndex + 2)).toEqual([
        'event:tool',
        'event:message'
      ])
    }
  )
})

const PERMISSION_PROJECTION_FRAMEWORKS = [
  ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
  ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
  ['Codex Responses', codexFramework, 'codex-responses', 'codex:provider-a'],
  ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
] as const

const PERMISSION_PROJECTION_DECISIONS = [
  ['allow', 'allow-once', undefined],
  ['deny', 'reject-once', 'declined'],
  ['cancel', undefined, 'permission-closed']
] as const

describe('ACP Notebook permission presentation contract', () => {
  it.each([
    [
      'Claude Code',
      claudeCodeFramework,
      'claude-anthropic',
      'claude-code:provider-a',
      createModes(['default', 'bypassPermissions']),
      true
    ],
    [
      'Codex Responses',
      codexFramework,
      'codex-responses',
      'codex:provider-a',
      createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      false
    ],
    [
      'Codex Bridge',
      codexFramework,
      'codex-bridge',
      'codex:provider-a',
      createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      false
    ]
  ] as const)(
    'projects native Full Access %s Notebook calls as executing without a permission request',
    async (_name, framework, modelRoute, backendId, modes, lateInput) => {
      const process = new FakeAgentProcess()
      const toolCallId = `native-full-${modelRoute}`
      const authorizeExecution = vi.fn(() => `invocation-${toolCallId}`)
      const onPermissionRequest = vi.fn()
      const isCodex = framework.id === 'codex'
      startPermissionProbeAgent(process, {
        newSessionId: `session-${modelRoute}`,
        toolCallId,
        toolTitle: isCodex
          ? 'mcp.open-science-notebook.notebook_execute'
          : 'mcp__open-science-notebook__notebook_execute',
        toolKind: 'execute',
        toolRawInput: lateInput ? {} : { language: 'python', code: 'print(1)' },
        ...(lateInput
          ? {
              toolCallUpdateRawInput: { language: 'python', code: 'print(1)' },
              toolCallUpdateCount: 2
            }
          : {}),
        ...(isCodex
          ? {
              codexMcpIdentity: {
                server: 'open-science-notebook',
                tool: 'notebook_execute',
                arguments: { language: 'python', code: 'print(1)' }
              }
            }
          : {
              announceToolCall: true,
              announcedProviderToolName: 'mcp__open-science-notebook__notebook_execute'
            }),
        modes,
        skipPermissionRequest: true
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
          authorizeExecution
        },
        callbacks: { onPermissionRequest },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'run this notebook cell',
        provenanceContext: { promptMessageId: 'prompt-native-full' }
      })

      expect(onPermissionRequest).not.toHaveBeenCalled()
      expect(authorizeExecution.mock.calls).toEqual([
        [
          expect.objectContaining({
            sessionId: session.sessionId,
            toolCallId,
            promptMessageId: 'prompt-native-full',
            method: 'execute',
            rawInput: { language: 'python', code: 'print(1)' }
          })
        ]
      ])
      expect(runtime.getSnapshot().events).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          toolCallId,
          executionInvocationId: `invocation-${toolCallId}`
        })
      )
    },
    30_000
  )

  it.each([
    [
      'OpenCode broker Full Access',
      opencodeFramework,
      createModes(['build', 'plan'], 'build'),
      {
        announceToolCall: true,
        announcedProviderToolName: 'open_science_notebook_notebook_execute'
      }
    ],
    [
      'untrusted Codex metadata',
      codexFramework,
      createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      {
        codexMcpIdentity: {
          server: 'open-science-notebook',
          tool: 'notebook_execute',
          arguments: { language: 'python', code: 'print(1)' }
        },
        codexMcpMarker: false
      }
    ]
  ] as const)(
    'does not infer execution authorization from %s provider updates',
    async (_name, framework, modes, providerOptions) => {
      const process = new FakeAgentProcess()
      const authorizeExecution = vi.fn(() => 'unexpected-invocation')
      startPermissionProbeAgent(process, {
        newSessionId: `session-${framework.id}`,
        toolCallId: `untrusted-${framework.id}`,
        toolTitle:
          framework.id === 'codex'
            ? 'mcp.open-science-notebook.notebook_execute'
            : 'open_science_notebook_notebook_execute',
        toolKind: 'execute',
        toolRawInput: { language: 'python', code: 'print(1)' },
        modes,
        skipPermissionRequest: true,
        ...providerOptions
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        framework,
        spawnAgent: () => asAgentProcess(process),
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
          authorizeExecution
        }
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'run this notebook cell',
        provenanceContext: { promptMessageId: 'prompt-untrusted' }
      })

      expect(authorizeExecution).not.toHaveBeenCalled()
      expect(
        runtime.getSnapshot().events.some((event) => event.executionInvocationId != null)
      ).toBe(false)
    }
  )

  it.each(
    PERMISSION_PROJECTION_FRAMEWORKS.flatMap(([name, framework, modelRoute, backendId]) =>
      PERMISSION_PROJECTION_DECISIONS.map(
        ([decision, optionId, disposition]) =>
          [name, framework, modelRoute, backendId, decision, optionId, disposition] as const
      )
    )
  )(
    'projects session/request_permission %s %s without inventing execution',
    async (_name, framework, modelRoute, backendId, _decision, optionId, disposition) => {
      const process = new FakeAgentProcess()
      const toolCallId = `notebook-${modelRoute}-${_decision}`
      const isCodex = framework.id === 'codex'
      let permissionResponse: unknown
      startPermissionProbeAgent(process, {
        newSessionId: `session-${modelRoute}-${_decision}`,
        toolCallId,
        toolTitle:
          framework.id === 'claude-code'
            ? 'mcp__open-science-notebook__notebook_execute'
            : 'open_science_notebook_notebook_execute',
        toolKind: 'execute',
        toolRawInput: { language: 'python', code: 'print(1)' },
        ...(isCodex
          ? {
              codexMcpIdentity: {
                server: 'open-science-notebook',
                tool: 'notebook_execute',
                arguments: { language: 'python', code: 'print(1)' }
              },
              sparseCodexMcpApproval: true
            }
          : {
              announceToolCall: true,
              announcedProviderToolName:
                framework.id === 'claude-code'
                  ? 'mcp__open-science-notebook__notebook_execute'
                  : 'open_science_notebook_notebook_execute'
            }),
        modes: isCodex
          ? createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
          : undefined,
        permissionOptions: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ],
        onPermissionResponse: (response) => {
          permissionResponse = response
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
        },
        callbacks: {
          onPermissionRequest: (request) => {
            void runtime.respondToPermission({
              requestId: request.requestId,
              ...(optionId ? { optionId } : { cancelled: true })
            })
          }
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run this notebook cell' })

      expect(permissionResponse).toEqual(
        optionId
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } }
      )
      const projected = runtime
        .getSnapshot()
        .events.filter((event) => event.toolCallId === toolCallId && event.toolDisposition)
      if (disposition) {
        expect(projected).toContainEqual(
          expect.objectContaining({
            kind: 'tool',
            toolDisposition: disposition,
            status: disposition === 'declined' ? 'completed' : 'in_progress'
          })
        )
      } else {
        expect(projected).toEqual([])
      }
    },
    30_000
  )

  it.each([
    ['Claude Code', claudeCodeFramework, 'mcp__open-science-notebook__notebook_execute'],
    ['OpenCode', opencodeFramework, 'open_science_notebook_notebook_execute']
  ] as const)(
    'issues a fresh execution identity for each %s call released by a remembered grant',
    async (_name, framework, toolTitle) => {
      const process = new FakeAgentProcess()
      const permissionRequests: AcpPermissionRequest[] = []
      const executionToolCallIds: string[] = []
      let promptIndex = 0
      acp
        .agent({ name: 'remembered-notebook-permission-agent' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remembered-session' }))
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
          const toolCallId = `remembered-call-${++promptIndex}`
          const rawInput = { language: 'python', code: `print(${promptIndex})` }
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: toolTitle,
              kind: 'other',
              status: 'pending',
              rawInput
            }
          })
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              title: toolTitle,
              kind: 'other',
              status: 'pending',
              rawInput
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
            ]
          })
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
        framework,
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
          authorizeExecution: (authorization) => {
            executionToolCallIds.push(authorization.toolCallId)
            return `invocation-${authorization.toolCallId}`
          }
        },
        callbacks: {
          onPermissionRequest: (request) => {
            permissionRequests.push(request)
            const sessionOptionId = request.options.find(
              (option) => option.scope === 'session'
            )?.optionId
            if (!sessionOptionId) throw new Error('Missing Session grant option')
            void runtime.respondToPermission({
              requestId: request.requestId,
              optionId: sessionOptionId
            })
          }
        }
      })
      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'run once',
        provenanceContext: { promptMessageId: 'prompt-1' }
      })
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'run again',
        provenanceContext: { promptMessageId: 'prompt-2' }
      })

      expect(permissionRequests).toHaveLength(1)
      expect(executionToolCallIds).toEqual(['remembered-call-1', 'remembered-call-2'])
    }
  )

  it.each(
    PERMISSION_PROJECTION_FRAMEWORKS.filter(([, framework]) => framework.id === 'codex').flatMap(
      ([name, framework, modelRoute, backendId]) =>
        PERMISSION_PROJECTION_DECISIONS.map(
          ([decision, , disposition]) =>
            [name, framework, modelRoute, backendId, decision, disposition] as const
        )
    )
  )(
    'projects elicitation/create %s %s without inventing execution',
    async (_name, framework, modelRoute, backendId, _decision, disposition) => {
      const process = new FakeAgentProcess()
      const toolCallId = `elicitation-${modelRoute}-${_decision}`
      let elicitationResponse: unknown
      startPermissionProbeAgent(process, {
        newSessionId: `elicitation-session-${modelRoute}-${_decision}`,
        toolCallId,
        toolTitle: 'unused by sparse Codex approval',
        codexMcpIdentity: {
          server: 'open-science-notebook',
          tool: 'notebook_execute',
          arguments: { language: 'python', code: 'print(1)' }
        },
        codexMcpApprovalViaElicitation: true,
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
        onPermissionResponse: (response) => {
          elicitationResponse = response
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
        },
        callbacks: {
          onPermissionRequest: (request) => {
            const decisionOptionId = request.options.find((option) =>
              _decision === 'allow' ? option.kind === 'allow_once' : option.kind === 'reject_once'
            )?.optionId
            void runtime.respondToPermission({
              requestId: request.requestId,
              ...(_decision === 'cancel' ? { cancelled: true } : { optionId: decisionOptionId })
            })
          }
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run this notebook cell' })

      expect(elicitationResponse).toEqual({
        action: _decision === 'allow' ? 'accept' : _decision === 'deny' ? 'decline' : 'cancel'
      })
      const projected = runtime
        .getSnapshot()
        .events.filter((event) => event.toolCallId === toolCallId && event.toolDisposition)
      if (disposition) {
        expect(projected).toContainEqual(expect.objectContaining({ toolDisposition: disposition }))
      } else {
        expect(projected).toEqual([])
      }
    },
    30_000
  )
})

const createRestoredContinuationSession = (
  promptMessageId = 'prompt-1',
  sessionId = 'restored-session',
  projectId = 'project-1'
): PersistedChatSession => {
  const messages: PersistedChatSession['messages'] = [
    {
      id: promptMessageId,
      role: 'user',
      content: 'Continue the restored task.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  return {
    id: sessionId,
    projectId,
    title: 'Restored task',
    cwd: '/workspace',
    status: 'waiting-permission',
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: 'pending-session',
      messages,
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    }),
    createdAt: 1,
    updatedAt: 1
  }
}

const addPendingRestoredChoice = (
  session: PersistedChatSession,
  input: {
    requestId?: string
    toolCallId?: string
    promptMessageId?: string
    message?: string
  } = {}
): PersistedChatSession => {
  const requestId = input.requestId ?? 'choice-restored-1'
  const toolCallId = input.toolCallId ?? 'tool-choice-restored-1'
  const promptMessageId = input.promptMessageId ?? 'prompt-restored-1'
  const message = input.message ?? 'Choose an approach'
  session.status = 'waiting-for-user'
  session.activities = [
    {
      id: toolCallId,
      kind: 'tool',
      title: message,
      status: 'in_progress',
      sortIndex: 0,
      eventIds: [],
      promptMessageId,
      elicitation: {
        message,
        fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
        state: 'pending',
        durable: { kind: 'agent-user-choice', requestId, promptMessageId }
      },
      createdAt: 2,
      updatedAt: 2
    }
  ]
  if (session.conversationGraph) {
    session.conversationGraph = synchronizeActiveConversationActivities(
      session.conversationGraph,
      session.activities,
      []
    )
  }
  return session
}

const createRestoredChoiceRevisionSession = (): PersistedChatSession => {
  const messages: PersistedChatSession['messages'] = [
    {
      id: 'prompt-restored-1',
      role: 'user',
      content: 'Choose an approach.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'agent-question-preamble',
      role: 'agent',
      content: 'Please choose one option.',
      status: 'complete',
      responseToMessageId: 'prompt-restored-1',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const activity: NonNullable<PersistedChatSession['activities']>[number] = {
    id: 'tool-choice-restored-1',
    kind: 'tool',
    title: 'Choose an approach',
    status: 'completed',
    sortIndex: 0,
    eventIds: [],
    promptMessageId: 'prompt-restored-1',
    elicitation: {
      message: 'Choose an approach',
      fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
      state: 'answered',
      durable: {
        kind: 'agent-user-choice',
        requestId: 'choice-restored-1',
        promptMessageId: 'prompt-restored-1'
      },
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    },
    createdAt: 2,
    updatedAt: 2
  }
  let graph = createLinearConversationGraph({
    sessionId: 'pending-session',
    messages,
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 2
  })
  graph = synchronizeActiveConversationActivities(graph, [activity], [])
  graph = forkConversationAfterActivity(
    graph,
    'agent-question-preamble',
    activity.id,
    'message-branch-revision',
    3
  )
  return {
    id: 'restored-choice-session',
    projectId: 'project-1',
    title: 'Restored choice revision',
    cwd: '/workspace',
    status: 'idle',
    messages,
    conversationGraph: graph,
    activities: [],
    createdAt: 1,
    updatedAt: 3
  }
}

const RESTORED_CONTINUATION_FRAMEWORKS = [
  ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
  ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
  ['Codex Responses', codexFramework, 'codex-responses', 'codex:provider-a'],
  ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
] as const

describe('ACP runtime restored permission continuation', () => {
  it('keeps the original Notebook presentation id while authorizing the provider replay id', async () => {
    const process = new FakeAgentProcess()
    const originalToolCallId = 'notebook-original'
    const replayToolCallId = 'notebook-replayed'
    const toolTitle = 'mcp.open-science-notebook.notebook_execute'
    const rawInput = { language: 'python', code: 'print(1)' }
    const originalRequest: AcpPermissionRequest = {
      requestId: 'permission-restored',
      sessionId: 'restored-session',
      toolCallId: originalToolCallId,
      title: toolTitle,
      providerToolName: 'notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      toolKind: 'execute',
      rawInput,
      options: [
        {
          optionId: 'allow-once',
          name: 'Allow once',
          kind: 'allow_once',
          scope: 'once'
        }
      ]
    }
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: originalRequest,
        originatingPromptMessageId: 'prompt-1',
        fingerprint: permissionRequestFingerprint(originalRequest)!,
        createdAt: 1
      }
    }
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run the Notebook code.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const persistedSession: PersistedChatSession = {
      id: 'restored-session',
      projectId: 'project-1',
      title: 'Restored Notebook permission',
      cwd: '/workspace',
      status: 'waiting-permission',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'restored-session',
        messages,
        frameworkId: 'codex',
        backendId: 'codex:provider-a',
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    const authorizeExecution = vi.fn(() => 'execution-replayed')
    startPermissionProbeAgent(process, {
      newSessionId: 'restored-session',
      toolCallId: replayToolCallId,
      toolTitle,
      toolKind: 'execute',
      toolRawInput: rawInput,
      codexMcpIdentity: {
        server: 'open-science-notebook',
        tool: 'notebook_execute',
        arguments: rawInput
      },
      sparseCodexMcpApproval: true,
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      permissionOptions: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      notebook: {
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
        authorizeExecution
      },
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext: vi.fn(async (command) => {
            runtimeContext = {
              ...runtimeContext,
              ...command.patch,
              revision: runtimeContext.revision + 1
            }
            return structuredClone(runtimeContext)
          }),
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
        }
      },
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        backendId: 'codex:provider-a',
        modelRoute: 'codex-responses',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToPermission({
      requestId: originalRequest.requestId,
      optionId: 'allow-once',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })

    await vi.waitFor(() => expect(authorizeExecution).toHaveBeenCalledOnce())
    expect(authorizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'restored-session',
        toolCallId: replayToolCallId,
        promptMessageId: 'prompt-1',
        rawInput
      })
    )
    const notebookEvents = runtime
      .getSnapshot()
      .events.filter((event) => event.kind === 'tool' && event.executionInvocationId)
    expect(notebookEvents).toContainEqual(
      expect.objectContaining({
        toolCallId: originalToolCallId,
        executionInvocationId: 'execution-replayed'
      })
    )
    expect(
      runtime
        .getSnapshot()
        .events.some((event) => event.kind === 'tool' && event.toolCallId === replayToolCallId)
    ).toBe(false)
  })

  it('cancels restored pending authority without a live ACP interaction', async () => {
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const patchSessionRuntimeContext = vi.fn(async (command) => {
      runtimeContext = {
        ...runtimeContext,
        ...command.patch,
        revision: runtimeContext.revision + 1
      }
      return structuredClone(runtimeContext)
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(),
          sessionProjectId: vi.fn(async () => 'project-1')
        }
      }
    })

    await runtime.cancelPrompt({ sessionId: 'restored-session' })

    expect(runtimeContext.permission).toBeUndefined()
    expect(patchSessionRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'restored-session',
        patch: { permission: undefined },
        sessionStatus: 'idle'
      })
    )
  })

  it('does not present a cancelled restored permission as an explicit user denial', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['restored-session'])
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
          ]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run the requested test command.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const persistedSession: PersistedChatSession = {
      id: 'restored-session',
      projectId: 'project-1',
      title: 'Restored permission',
      cwd: '/workspace',
      status: 'waiting-permission',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'restored-session',
        messages,
        frameworkId: 'claude-code',
        backendId: 'claude-code:provider-a',
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      framework: claudeCodeFramework,
      spawnAgent: () => asAgentProcess(process),
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext: vi.fn(async (command) => {
            runtimeContext = {
              ...runtimeContext,
              ...command.patch,
              revision: runtimeContext.revision + 1
            }
            return structuredClone(runtimeContext)
          }),
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
        }
      }
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToPermission({
      requestId: 'permission-restored',
      cancelled: true,
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(fakeAgent.prompts[0]?.text).toContain(
      'The pending permission interaction was cancelled without granting authorization'
    )
    expect(fakeAgent.prompts[0]?.text).not.toContain('The user explicitly denied this operation')
  })

  it.each(RESTORED_CONTINUATION_FRAMEWORKS)(
    'continues an approved restored wait through %s and then clears its authority',
    async (_name, framework, modelRoute, backendId) => {
      const root = await createTemporaryRoot()
      const process = new FakeAgentProcess()
      const receivedPrompts: ContentBlock[][] = []
      let artifactContext: Record<string, unknown> | undefined
      const fakeAgent = startFakeAgent(process, ['restored-session'], {
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {}),
        onPrompt: async ({ prompt }) => {
          receivedPrompts.push(prompt)
          const [artifactSessionId] = await readdir(join(root, 'artifacts', 'project-1'))
          artifactContext = JSON.parse(
            await readFile(
              join(
                root,
                'artifacts',
                'project-1',
                artifactSessionId,
                '.pending',
                'current-run.json'
              ),
              'utf8'
            )
          ) as Record<string, unknown>
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      let runtimeContext: SessionRuntimeContext = {
        version: 1,
        revision: 1,
        permission: {
          state: 'pending',
          request: {
            requestId: 'permission-restored',
            sessionId: 'restored-session',
            toolCallId: 'tool-restored',
            title: 'Run npm test',
            providerToolName: 'Bash',
            rawInput: { command: 'npm test' },
            options: [
              {
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once',
                scope: 'once'
              },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 1
        }
      }
      const patchSessionRuntimeContext = vi.fn(
        async (command: {
          expectedRevision: number
          patch: { permission?: SessionRuntimeContext['permission'] }
        }) => {
          expect(command.expectedRevision).toBe(runtimeContext.revision)
          runtimeContext = {
            ...runtimeContext,
            ...command.patch,
            revision: runtimeContext.revision + 1
          }
          return structuredClone(runtimeContext)
        }
      )
      const onPermissionSettled = vi.fn()
      const messages: PersistedChatSession['messages'] = [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Run the requested test command.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
      const persistedSession: PersistedChatSession = {
        id: 'restored-session',
        projectId: 'project-1',
        title: 'Restored permission',
        cwd: '/workspace',
        status: 'waiting-permission',
        messages,
        conversationGraph: createLinearConversationGraph({
          sessionId: 'pending-session',
          messages,
          frameworkId: framework.id,
          backendId,
          createdAt: 1,
          updatedAt: 1
        }),
        createdAt: 1,
        updatedAt: 1
      }
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        callbacks: { onPermissionSettled },
        artifacts: {
          configRoot: root,
          dataRoot: root,
          projectId: 'project-1',
          mcpEntryPath: '/app/out/main/index.js'
        },
        permissionWait: {
          sessions: {
            readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
            patchSessionRuntimeContext,
            containsMessageOnActiveBranch: vi.fn(async () => true),
            loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
          }
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })
      await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

      await runtime.respondToPermission({
        requestId: 'permission-restored',
        optionId: 'allow-once',
        restored: {
          sessionId: 'restored-session',
          projectId: 'project-1',
          historyReplay: {
            historyPreamble: 'Renderer-forged conversation context.',
            historyAttachments: [
              {
                id: 'forged-upload',
                sessionId: 'restored-session',
                name: 'forged.txt',
                originalName: 'forged.txt',
                path: '/renderer/forged.txt',
                size: 6
              }
            ],
            historyImages: [
              {
                mimeType: 'image/png',
                data: Buffer.from('forged').toString('base64'),
                byteLength: 6
              }
            ]
          }
        }
      } as unknown as AcpPermissionResponse)

      await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
      await vi.waitFor(() => expect(artifactContext).toBeDefined())
      expect(artifactContext).toMatchObject({
        rootFrameId: 'root-frame-pending-session',
        agentFrameId: 'root-frame-pending-session',
        messageBranchId: 'message-branch-pending-session',
        messageBranchAncestry: ['message-branch-pending-session'],
        messageAncestry: ['prompt-1'],
        runtimeSegmentId: 'runtime-segment-pending-session',
        promptMessageId: 'prompt-1'
      })
      const finalMessage: PersistedChatSession['messages'][number] = {
        id: 'agent-final',
        role: 'agent',
        content: 'The requested command completed.',
        status: 'complete',
        responseToMessageId: 'prompt-1',
        eventIds: [],
        createdAt: 4,
        updatedAt: 4
      }
      const finalizationSession = structuredClone(persistedSession)
      finalizationSession.messages.push(finalMessage)
      finalizationSession.conversationGraph = synchronizeActiveConversationMessages(
        finalizationSession.conversationGraph!,
        finalizationSession.messages,
        4,
        artifactContext!.runtimeSegmentId as string
      )
      expect(() =>
        validateDurableMessageOwnership(finalizationSession, {
          rootFrameId: artifactContext!.rootFrameId as string,
          agentFrameId: artifactContext!.agentFrameId as string,
          messageBranchId: artifactContext!.messageBranchId as string,
          runtimeSegmentId: artifactContext!.runtimeSegmentId as string,
          promptMessageId: artifactContext!.promptMessageId as string,
          messageId: finalMessage.id
        })
      ).not.toThrow()
      expect(fakeAgent.prompts[0]?.text).not.toContain('Renderer-forged conversation context.')
      expect(receivedPrompts[0]?.every((content) => content.type === 'text')).toBe(true)
      expect(fakeAgent.prompts[0]?.text).toContain('approved the pending tool permission')
      await vi.waitFor(() => expect(runtimeContext.permission).toBeUndefined())
      expect(patchSessionRuntimeContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionStatus: 'idle',
          patch: { permission: undefined }
        })
      )
      expect(onPermissionSettled).toHaveBeenCalledWith('permission-restored', 'resolved')
      expect(runtime.getSnapshot().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'permission',
            title: 'Restored permission continuation settled',
            permissionRequestId: 'permission-restored'
          })
        ])
      )
    }
  )

  it('does not publish stale settlement when permission authority changed during continuation', async () => {
    const process = new FakeAgentProcess()
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const replacementPermission: NonNullable<SessionRuntimeContext['permission']> = {
      ...runtimeContext.permission!,
      state: 'pending',
      request: {
        ...runtimeContext.permission!.request,
        requestId: 'permission-newer',
        toolCallId: 'tool-newer'
      },
      fingerprint: 'b'.repeat(64),
      createdAt: 2
    }
    const fakeAgent = startFakeAgent(process, ['restored-session'], {
      onPrompt: () => {
        runtimeContext = {
          ...runtimeContext,
          revision: runtimeContext.revision + 1,
          permission: replacementPermission
        }
      }
    })
    const patchSessionRuntimeContext = vi.fn(
      async (command: {
        expectedRevision: number
        patch: { permission?: SessionRuntimeContext['permission'] }
      }) => {
        expect(command.expectedRevision).toBe(runtimeContext.revision)
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => createRestoredContinuationSession())
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToPermission({
      requestId: 'permission-restored',
      optionId: 'allow-once',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain('restored-session')
    )
    expect(runtimeContext.permission).toMatchObject({
      state: 'pending',
      request: { requestId: 'permission-newer' }
    })
    expect(runtime.getSnapshot().events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'permission',
          sessionId: 'restored-session',
          title: 'Restored permission continuation settled'
        })
      ])
    )
  })

  it.each([
    ...RESTORED_CONTINUATION_FRAMEWORKS.map(
      ([name, framework, modelRoute, backendId]) =>
        [name, framework, modelRoute, backendId, true, false] as const
    ),
    [
      'OpenCode with Vision relay',
      opencodeFramework,
      'opencode-openai',
      'opencode:provider-a',
      false,
      true
    ] as const
  ])(
    'builds restored permission replay through %s from Main-owned Session history after context reset',
    async (_name, framework, modelRoute, backendId, supportsImageInput, usesImageRelay) => {
      const process = new FakeAgentProcess()
      const receivedPrompts: ContentBlock[][] = []
      const fakeAgent = startFakeAgent(process, ['adopted-provider-session'], {
        resumeNotFound: true,
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {}),
        onPrompt: ({ prompt }) => {
          receivedPrompts.push(prompt)
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      let runtimeContext: SessionRuntimeContext = {
        version: 1,
        revision: 1,
        permission: {
          state: 'pending',
          request: {
            requestId: 'permission-restored',
            sessionId: 'restored-session',
            toolCallId: 'tool-restored',
            title: 'Run npm test',
            providerToolName: 'Bash',
            rawInput: { command: 'npm test' },
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 1
        }
      }
      const persistedSession: PersistedChatSession = {
        id: 'restored-session',
        projectId: 'project-1',
        title: 'Restored permission',
        cwd: '/workspace',
        status: 'waiting-permission',
        messages: [
          {
            id: 'prompt-0',
            role: 'user',
            content: 'Main-owned earlier request.',
            status: 'complete',
            images: [
              {
                id: 'permission-replay-image',
                mimeType: 'image/png',
                data: createPngBytes('permission-replay').toString('base64'),
                byteLength: createPngBytes('permission-replay').byteLength
              }
            ],
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'reply-0',
            role: 'agent',
            content: 'Main-owned earlier response.',
            status: 'complete',
            responseToMessageId: 'prompt-0',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2
          },
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Run the requested test command.',
            status: 'complete',
            eventIds: [],
            createdAt: 3,
            updatedAt: 3
          }
        ],
        createdAt: 1,
        updatedAt: 3
      }
      persistedSession.conversationGraph = createLinearConversationGraph({
        sessionId: 'pending-session',
        messages: persistedSession.messages,
        frameworkId: framework.id,
        backendId,
        createdAt: 1,
        updatedAt: 3
      })
      const patchSessionRuntimeContext = vi.fn(
        async (command: { patch: { permission?: SessionRuntimeContext['permission'] } }) => {
          runtimeContext = {
            ...runtimeContext,
            ...command.patch,
            revision: runtimeContext.revision + 1
          }
          return structuredClone(runtimeContext)
        }
      )
      const loadSessionForContinuation = vi.fn(async () => structuredClone(persistedSession))
      const imageInputCompatibility = {
        isAvailable: vi.fn(async () => true),
        prepare: vi.fn(async ({ content }: { content: string | ContentBlock[] }) =>
          typeof content === 'string'
            ? content
            : content.map((block) =>
                block.type === 'image'
                  ? { type: 'text' as const, text: 'Vision-relayed historical image evidence.' }
                  : block
              )
        )
      }
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        ...(usesImageRelay ? { imageInputCompatibility } : {}),
        permissionWait: {
          sessions: {
            readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
            patchSessionRuntimeContext,
            containsMessageOnActiveBranch: vi.fn(async () => true),
            loadSessionForContinuation
          }
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          contextWindow: 200_000,
          supportsImageInput,
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      await expect(
        runtime.resumeSession({
          sessionId: 'restored-session',
          cwd: '/workspace',
          projectId: 'project-1'
        })
      ).resolves.toMatchObject({ sessionId: 'restored-session', contextReset: true })
      await runtime.respondToPermission({
        requestId: 'permission-restored',
        optionId: 'allow-once',
        restored: { sessionId: 'restored-session', projectId: 'project-1' }
      })

      await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
      expect(loadSessionForContinuation).toHaveBeenCalledWith('project-1', 'restored-session')
      expect(fakeAgent.prompts[0]?.text).toContain('Main-owned earlier request.')
      expect(fakeAgent.prompts[0]?.text).toContain('approved the pending tool permission')
      if (usesImageRelay) {
        expect(imageInputCompatibility.isAvailable).toHaveBeenCalledOnce()
        expect(imageInputCompatibility.prepare).toHaveBeenCalledWith(
          expect.objectContaining({ supportsImageInput: false, historyImageCount: 1 })
        )
        expect(receivedPrompts[0]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: 'Vision-relayed historical image evidence.'
            })
          ])
        )
        expect(receivedPrompts[0]).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'image' })])
        )
      } else {
        expect(receivedPrompts[0]).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'image' })])
        )
      }
    }
  )

  it('marks restored authority continuing before committing a persistent grant', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['restored-session'])
    const journal: string[] = []
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [
            {
              optionId: 'allow-project',
              name: 'Allow for project',
              kind: 'allow_always',
              scope: 'project'
            }
          ]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        capability: { kind: 'execution', key: 'exec:agent/shell' },
        createdAt: 1
      }
    }
    const patchSessionRuntimeContext = vi.fn(
      async (command: { patch: { permission?: SessionRuntimeContext['permission'] } }) => {
        if (command.patch.permission?.state === 'continuing') journal.push('authority')
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const permissionGrantRegistry = {
      resolve: vi.fn(),
      remember: vi.fn(async () => {
        journal.push('grant')
        return undefined as never
      }),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionGrantRegistry,
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => createRestoredContinuationSession())
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToPermission({
      requestId: 'permission-restored',
      optionId: 'allow-project',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })

    expect(journal.slice(0, 2)).toEqual(['authority', 'grant'])
  })

  it('releases the restored decision lock after a failed continuation so the card can retry', async () => {
    const process = new FakeAgentProcess()
    let continuationAttempts = 0
    const fakeAgent = startFakeAgent(process, ['restored-session'], {
      onPrompt: () => {
        continuationAttempts += 1
        if (continuationAttempts === 1) throw new Error('continuation unavailable')
      }
    })
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
              scope: 'once'
            },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
          ]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const patchSessionRuntimeContext = vi.fn(
      async (command: {
        expectedRevision: number
        patch: { permission?: SessionRuntimeContext['permission'] }
      }) => {
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => createRestoredContinuationSession())
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    const response = {
      requestId: 'permission-restored',
      optionId: 'allow-once',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    }

    await runtime.respondToPermission(response)
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    await vi.waitFor(() =>
      expect(
        runtime
          .getSnapshot()
          .events.some(
            (event) => event.kind === 'error' && event.title === 'Could not continue the Agent task'
          )
      ).toBe(true)
    )
    expect(runtimeContext.permission).toBeDefined()
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'permission',
          title: 'Restored permission continuation re-armed',
          permissionRequestId: 'permission-restored'
        })
      ])
    )

    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(runtime.respondToPermission(response)).resolves.toBeDefined()
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))
    await vi.waitFor(() => expect(runtimeContext.permission).toBeUndefined())
    expect(patchSessionRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionStatus: 'idle', patch: { permission: undefined } })
    )
  })

  it('keeps a successful continuation non-replayable when clearing its authority fails', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['restored-session'])
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
              scope: 'once'
            }
          ]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const patchSessionRuntimeContext = vi.fn(
      async (command: {
        expectedRevision: number
        patch: { permission?: SessionRuntimeContext['permission'] }
      }) => {
        if (command.patch.permission === undefined) throw new Error('disk unavailable')
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => createRestoredContinuationSession())
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToPermission({
      requestId: 'permission-restored',
      optionId: 'allow-once',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    await vi.waitFor(() =>
      expect(
        runtime
          .getSnapshot()
          .events.some(
            (event) =>
              event.kind === 'permission' &&
              event.title ===
                'Permission continuation completed but its wait could not be cleared' &&
              event.permissionRequestId === 'permission-restored'
          )
      ).toBe(true)
    )
    expect(runtimeContext.permission).toMatchObject({ state: 'continuing' })
  })

  it('clears durable restored authority when its active continuation is cancelled', async () => {
    const process = new FakeAgentProcess()
    const continuationGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['restored-session'], {
      onPrompt: async () => {
        await continuationGate.promise
      }
    })
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 1,
      permission: {
        state: 'pending',
        request: {
          requestId: 'permission-restored',
          sessionId: 'restored-session',
          toolCallId: 'tool-restored',
          title: 'Run npm test',
          providerToolName: 'Bash',
          rawInput: { command: 'npm test' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 1
      }
    }
    const patchSessionRuntimeContext = vi.fn(
      async (command: { patch: { permission?: SessionRuntimeContext['permission'] } }) => {
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext,
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => createRestoredContinuationSession())
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/agent',
        env: {}
      })
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.respondToPermission({
      requestId: 'permission-restored',
      optionId: 'allow-once',
      restored: { sessionId: 'restored-session', projectId: 'project-1' }
    })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    await runtime.cancelPrompt({ sessionId: 'restored-session' })

    expect(runtimeContext.permission).toBeUndefined()
    continuationGate.resolve()
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain('restored-session')
    )
    expect(runtimeContext.permission).toBeUndefined()
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'permission',
          sessionId: 'restored-session',
          title: 'Restored permission continuation settled',
          permissionRequestId: 'permission-restored',
          text: 'cancelled'
        })
      ])
    )
  })
})

describe('ACP runtime session management', () => {
  const sideChatRecoveryCases = [
    ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
    ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
    [
      'Codex Responses compatibility',
      codexFramework,
      'codex-responses-compatibility',
      'codex:provider-a'
    ],
    ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
  ] as const

  const createSideChatMcpHost = (): {
    host: AgentMcpHttpHost
    registerHostMessage: ReturnType<typeof vi.fn>
  } => {
    const registerHostMessage = vi.fn()
    return {
      host: {
        ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
        registerHostMessage,
        urlFor: vi.fn(
          (kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn(async () => undefined)
      } as unknown as AgentMcpHttpHost,
      registerHostMessage
    }
  }

  it.each(sideChatRecoveryCases)(
    'keeps the host-message-only capability when a %s Side chat resumes',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, [], {
        supportsResume: true,
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const { host, registerHostMessage } = createSideChatMcpHost()
      const sendMessage = vi.fn()
      const runtime = new AcpRuntime({
        appVersion: '0.2.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(modelRoute === 'codex-bridge' ? { providerContinuityToken: 'bridge-token' } : {})
        }),
        mcpHttpHost: host,
        sessionCapabilityPolicy: SIDE_CHAT_SESSION_CAPABILITY_POLICY,
        sideChat: { sendMessage }
      })

      await runtime.resumeSession({
        sessionId: 'side-chat-restored',
        providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
        cwd: '/workspace',
        previousFrameworkId: framework.id,
        previousBackendId: backendId,
        ...(modelRoute === 'codex-bridge' ? { providerContinuityToken: 'bridge-token' } : {})
      })

      expect(fakeAgent.resumedSessions).toHaveLength(1)
      expect(fakeAgent.resumedSessions[0].mcpServers).toEqual([
        expect.objectContaining({
          type: 'http',
          name:
            framework.id === 'opencode' ? 'open_science_host_message' : 'open-science-host-message'
        })
      ])
      expect(registerHostMessage).toHaveBeenCalledWith(
        'side-chat-restored',
        expect.objectContaining({ sendMessage: expect.any(Function) })
      )
      await registerHostMessage.mock.lastCall?.[1].sendMessage({ target: 'main', text: 'relay' })
      expect(sendMessage).toHaveBeenCalledWith('side-chat-restored', {
        target: 'main',
        text: 'relay'
      })

      await runtime.disconnect()
    }
  )

  it.each(sideChatRecoveryCases)(
    'keeps the host-message-only capability when a %s Side chat adopts after resume loss',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      const freshProviderSessionId =
        framework.id === 'codex' ? '019fb8c8-6c66-7f22-9653-17b5b287dbbc' : 'fresh-provider-session'
      const fakeAgent = startFakeAgent(process, [freshProviderSessionId], {
        supportsResume: true,
        resumeNotFound: true,
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const { host, registerHostMessage } = createSideChatMcpHost()
      const sendMessage = vi.fn()
      const runtime = new AcpRuntime({
        appVersion: '0.2.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(modelRoute === 'codex-bridge' ? { providerContinuityToken: 'bridge-token' } : {})
        }),
        mcpHttpHost: host,
        sessionCapabilityPolicy: SIDE_CHAT_SESSION_CAPABILITY_POLICY,
        sideChat: { sendMessage }
      })

      const restored = await runtime.resumeSession({
        sessionId: 'side-chat-restored',
        providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
        cwd: '/workspace',
        previousFrameworkId: framework.id,
        previousBackendId: backendId,
        ...(modelRoute === 'codex-bridge' ? { providerContinuityToken: 'bridge-token' } : {})
      })

      expect(restored).toMatchObject({
        sessionId: 'side-chat-restored',
        providerSessionId: freshProviderSessionId,
        contextReset: true
      })
      expect(fakeAgent.newSessions).toHaveLength(1)
      expect(fakeAgent.newSessions[0].mcpServers).toEqual([
        expect.objectContaining({
          type: 'http',
          name:
            framework.id === 'opencode' ? 'open_science_host_message' : 'open-science-host-message'
        })
      ])
      expect(registerHostMessage).toHaveBeenLastCalledWith(
        'side-chat-restored',
        expect.objectContaining({ sendMessage: expect.any(Function) })
      )
      await registerHostMessage.mock.lastCall?.[1].sendMessage({ target: 'main', text: 'relay' })
      expect(sendMessage).toHaveBeenCalledWith('side-chat-restored', {
        target: 'main',
        text: 'relay'
      })

      await runtime.disconnect()
    }
  )

  it('keeps the current primary capability set separate from reviewer-only authority', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['primary-session', 'reviewer-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'notebook-token'
        })
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4568',
          token: 'skill-token'
        })
      }
    })

    const reviewerServer = {
      type: 'http' as const,
      name: 'open-science-reviewer',
      url: 'http://127.0.0.1:1/mcp',
      headers: []
    }

    try {
      await runtime.createSession({ cwd: '/workspace' })
      const reviewer = await runtime.buildReviewerSession({
        cwd: '/workspace',
        mcpServers: [reviewerServer]
      })

      expect(
        fakeAgent.newSessions[0].mcpServers.map((server) => (server as { name: string }).name)
      ).toEqual(['open-science-artifacts', 'open-science-notebook', 'open-science-skills'])
      expect(fakeAgent.newSessions[1].mcpServers).toEqual([reviewerServer])
      expect(reviewer.role).toBe('reviewer')

      await runtime.disposeReviewerSession(reviewer.session)
    } finally {
      await runtime.disconnect()
    }
  })

  it('omits activity-group declarations from main and reviewer sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['main-session', 'reviewer-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const mainSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: mainSession.sessionId, text: 'Search PubMed' })

    expect(fakeAgent.newSessions[0].mcpServers).toEqual([])
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).not.toContain(
      BEGIN_ACTIVITY_GROUP_TOOL_NAME
    )
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).toContain(
      'Do not describe a tool-backed action as future work'
    )
    expect(fakeAgent.prompts[0].text).not.toContain(
      'mcp__open-science-activity__begin_activity_group'
    )
    expect(fakeAgent.prompts[0].text).not.toContain('Before each coherent tool group this turn')

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
    expect(fakeAgent.newSessions[1]._meta).toMatchObject({
      claudeCode: { options: { tools: [] } }
    })
    expect(fakeAgent.prompts[1].text).toBe('Review this turn')
  })

  it.each([
    ['opencode', opencodeFramework],
    ['codex', codexFramework]
  ] as const)(
    'omits activity-group tooling and prompt guidance for %s',
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
        framework
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Inspect the project' })

      expect(fakeAgent.newSessions[0].mcpServers).toEqual([])
      expect(fakeAgent.prompts[0].text).not.toContain(BEGIN_ACTIVITY_GROUP_TOOL_NAME)
      expect(fakeAgent.prompts[0].text).toContain(
        'Do not describe a tool-backed action as future work'
      )
    }
  )

  const restoredPlanProjection = (
    approval: 'pending' | 'approved' | 'rejected',
    revision: number
  ): ActivePlanProjection => ({
    artifactId: 'artifact-1',
    artifactVersionId: 'version-1',
    artifactChecksum: 'a'.repeat(64),
    originatingPromptMessageId: 'plan-origin',
    revision,
    approval,
    lifecycle:
      approval === 'pending'
        ? 'awaiting_approval'
        : approval === 'approved'
          ? 'approved'
          : 'rejected',
    requiresExplicitContinuation: false,
    document: {
      schema_version: 1,
      task_summary: 'Analyze data',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Main Agent',
              steps: [{ title: 'Analyze', description: 'Analyze the data.' }]
            }
          ]
        }
      ],
      desired_outputs: ['Result'],
      feasibility: { confidence: 'high', rationale: 'Ready.' }
    },
    stepStatuses: {},
    stepStates: { Analyze: { status: approval === 'rejected' ? 'not_run' : 'not_started' } },
    counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
  })

  const durablePlanSessions = (
    messageIds: string[] = ['plan-origin']
  ): {
    containsMessageOnActiveBranch(
      projectId: string,
      sessionId: string,
      messageId: string
    ): Promise<boolean>
  } => ({
    containsMessageOnActiveBranch: vi.fn(
      async (_projectId: string, _sessionId: string, messageId: string) =>
        messageIds.includes(messageId)
    )
  })

  const installPromptPlanTestWorkflow = (
    runtime: AcpRuntime,
    planService: unknown,
    sessions = durablePlanSessions()
  ): void => {
    const internals = runtime as unknown as {
      sessionInteractions: unknown
      artifactTurns: unknown
      publication: unknown
      sessionEnvironment: unknown
      sessionPlanWorkflow: unknown
      promptTurnWorkflow: { options: { plan: unknown } }
    }
    const planInteractions = new SessionPlanInteractionOwner()
    const sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(
      { plan: { sessions } } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
      {
        planService,
        planInteractions,
        sessionInteractions: internals.sessionInteractions,
        artifactTurns: internals.artifactTurns
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
      {
        publication: internals.publication,
        sessionEnvironment: internals.sessionEnvironment
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
    )
    Object.assign(internals, { sessionPlanWorkflow })
    Object.assign(internals.promptTurnWorkflow.options, { plan: sessionPlanWorkflow.prompt })
  }

  it('continues a detached approved Plan with one hidden durable Attempt', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const promptAttempts: Array<string | undefined> = []
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 4,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'a'.repeat(64),
        originatingPromptMessageId: 'plan-origin',
        approval: 'pending',
        stepStatuses: {}
      }
    }
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'plan-origin',
        role: 'user',
        content: 'Analyze the dataset.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const persistedSession: PersistedChatSession = {
      id: 's1',
      projectId: 'project-1',
      title: 'Detached Plan',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 's1',
        messages,
        frameworkId: opencodeFramework.id,
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    const sessions = {
      readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
      patchSessionRuntimeContext: vi.fn(async (command) => {
        expect(command.expectedRevision).toBe(runtimeContext.revision)
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }),
      appendUserMessageToInteraction: vi.fn(),
      containsMessageOnActiveBranch: vi.fn(async () => true),
      loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onPromptStarted: (_sessionId, _turnToken, promptAttemptId) =>
          promptAttempts.push(promptAttemptId)
      },
      plan: {
        mcpEntryPath: '/unused',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'token' }),
        sessions
      },
      permissionWait: { sessions }
    })
    const pending = restoredPlanProjection('pending', 4)
    const approved = {
      ...restoredPlanProjection('approved', 5),
      continuationState: 'queued' as const
    }
    installPromptPlanTestWorkflow(runtime, {
      getProjection: vi.fn(async () => pending),
      respond: vi.fn(async () => {
        runtimeContext = {
          ...runtimeContext,
          revision: 5,
          plan: {
            ...runtimeContext.plan!,
            approval: 'approved',
            continuation: {
              commandId: 'plan-continuation-1',
              kind: 'approved-plan',
              state: 'queued',
              originatingPromptMessageId: 'plan-origin',
              createdAt: 2
            }
          }
        }
        return { projection: approved, changed: true }
      }),
      authorizeContinuation: vi.fn(async () => restoredPlanProjection('approved', 6))
    })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 's1',
      artifactVersionId: 'version-1',
      expectedRevision: 4,
      decision: 'approved'
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(fakeAgent.prompts[0]?.text).toContain('approved the pending Session Plan')
    expect(fakeAgent.prompts[0]?.text).toContain('approval=approved lifecycle=approved')
    expect(promptAttempts).toEqual([undefined])
    await vi.waitFor(() => expect(runtimeContext.plan?.continuation).toBeUndefined())
  })

  const createDurablePlanResumeHarness = (
    state: 'queued' | 'continuing',
    options: Readonly<{
      stopReason?: PromptResponse['stopReason']
      kind?: 'approved-plan' | 'rejected-plan' | 'review-feedback'
      claimRevisionConflicts?: number
    }> = {}
  ): Readonly<{
    runtime: AcpRuntime
    fakeAgent: ReturnType<typeof startFakeAgent>
    events: AcpRuntimeEvent[]
    promptAttempts: Array<string | undefined>
    readSessionRuntimeContext: ReturnType<typeof vi.fn>
    patchSessionRuntimeContext: ReturnType<typeof vi.fn>
    runtimeContext: () => SessionRuntimeContext
  }> => {
    const continuationKind = options.kind ?? 'approved-plan'
    const approval =
      continuationKind === 'approved-plan'
        ? 'approved'
        : continuationKind === 'rejected-plan'
          ? 'rejected'
          : 'pending'
    const continuationOrigin =
      continuationKind === 'review-feedback' ? 'feedback-message-1' : 'plan-origin'
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], {
      supportsResume: true,
      ...(options.stopReason ? { onPrompt: () => ({ stopReason: options.stopReason! }) } : {})
    })
    const promptAttempts: Array<string | undefined> = []
    const events: AcpRuntimeEvent[] = []
    let remainingClaimRevisionConflicts = options.claimRevisionConflicts ?? 0
    let runtimeContext: SessionRuntimeContext = {
      version: 1,
      revision: 5,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'a'.repeat(64),
        originatingPromptMessageId: 'plan-origin',
        approval,
        ...(continuationKind === 'review-feedback'
          ? { reviewFeedbackMessageId: continuationOrigin }
          : {}),
        continuation: {
          commandId: 'plan-continuation-resume-1',
          kind: continuationKind,
          state,
          originatingPromptMessageId: continuationOrigin,
          createdAt: 2
        },
        stepStatuses: {}
      }
    }
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'plan-origin',
        role: 'user',
        content: 'Analyze the restored dataset.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      ...(continuationKind === 'review-feedback'
        ? [
            {
              id: continuationOrigin,
              role: 'user' as const,
              content: 'Split the analysis by cohort.',
              status: 'complete' as const,
              eventIds: [],
              responseToMessageId: 'plan-origin',
              createdAt: 2,
              updatedAt: 2
            }
          ]
        : [])
    ]
    const initialMessages = messages.slice(0, 1)
    const persistedSession: PersistedChatSession = materializeSessionConversationGraph({
      id: 'restored-plan-session',
      projectId: 'project-1',
      title: 'Restored approved Plan',
      cwd: '/workspace',
      status: 'idle',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'restored-plan-session',
        messages: initialMessages,
        frameworkId: opencodeFramework.id,
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    })
    const readSessionRuntimeContext = vi.fn(async () => structuredClone(runtimeContext))
    const patchSessionRuntimeContext = vi.fn(
      async (
        command: Parameters<SessionPersistenceCoordinator['patchSessionRuntimeContext']>[0]
      ) => {
        expect(command.expectedRevision).toBe(runtimeContext.revision)
        if (remainingClaimRevisionConflicts > 0) {
          remainingClaimRevisionConflicts -= 1
          throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
        }
        runtimeContext = {
          ...runtimeContext,
          ...command.patch,
          revision: runtimeContext.revision + 1
        }
        return structuredClone(runtimeContext)
      }
    )
    const sessions = {
      readSessionRuntimeContext,
      patchSessionRuntimeContext,
      appendUserMessageToInteraction: vi.fn(),
      containsMessageOnActiveBranch: vi.fn(async () => true),
      loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onEvent: (event) => events.push(event),
        onPromptStarted: (_sessionId, _turnToken, promptAttemptId) =>
          promptAttempts.push(promptAttemptId)
      },
      plan: {
        mcpEntryPath: '/unused',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'token' }),
        sessions
      },
      permissionWait: { sessions }
    })
    installPromptPlanTestWorkflow(runtime, {
      authorizeContinuation: vi.fn(async () => restoredPlanProjection('approved', 6)),
      getProjection: vi.fn(async () => restoredPlanProjection(approval, runtimeContext.revision))
    })
    return {
      runtime,
      fakeAgent,
      events,
      promptAttempts,
      readSessionRuntimeContext,
      patchSessionRuntimeContext,
      runtimeContext: () => runtimeContext
    }
  }

  it('dispatches one hidden queued Plan continuation after Session resume and clears it', async () => {
    const fixture = createDurablePlanResumeHarness('queued')

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.fakeAgent.prompts).toHaveLength(1))
    expect(fixture.fakeAgent.prompts[0]?.text).toContain('approved the pending Session Plan')
    expect(fixture.promptAttempts).toEqual([undefined])
    await vi.waitFor(() => expect(fixture.runtimeContext().plan?.continuation).toBeUndefined())
  })

  it('stops retrying a queued Plan claim after the bounded revision-conflict budget', async () => {
    const fixture = createDurablePlanResumeHarness('queued', { claimRevisionConflicts: 10 })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.patchSessionRuntimeContext).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 125))

    expect(fixture.patchSessionRuntimeContext).toHaveBeenCalledTimes(3)
    expect(fixture.fakeAgent.prompts).toHaveLength(0)
    expect(fixture.runtimeContext().plan?.continuation?.state).toBe('queued')
    expect(
      fixture.events.filter((event) => event.title === 'Could not claim the Plan continuation')
    ).toHaveLength(1)
  })

  it('dispatches a queued Plan once after transient claim revision conflicts', async () => {
    const fixture = createDurablePlanResumeHarness('queued', { claimRevisionConflicts: 2 })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.fakeAgent.prompts).toHaveLength(1))
    await vi.waitFor(() => expect(fixture.runtimeContext().plan?.continuation).toBeUndefined())

    expect(fixture.promptAttempts).toEqual([undefined])
    expect(fixture.patchSessionRuntimeContext).toHaveBeenCalledTimes(4)
    expect(
      fixture.events.filter((event) => event.title === 'Could not claim the Plan continuation')
    ).toHaveLength(0)
  })

  it('dispatches one hidden rejected-Plan continuation after Session resume and clears it', async () => {
    const fixture = createDurablePlanResumeHarness('queued', { kind: 'rejected-plan' })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.fakeAgent.prompts).toHaveLength(1))
    expect(fixture.fakeAgent.prompts[0]?.text).toContain('rejected the pending Session Plan')
    expect(fixture.fakeAgent.prompts[0]?.text).toContain('approval=rejected')
    await vi.waitFor(() => expect(fixture.runtimeContext().plan?.continuation).toBeUndefined())
  })

  it('dispatches persisted Plan review feedback once without duplicating its user Message', async () => {
    const fixture = createDurablePlanResumeHarness('queued', { kind: 'review-feedback' })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.fakeAgent.prompts).toHaveLength(1))
    expect(fixture.fakeAgent.prompts[0]?.text).toContain('Split the analysis by cohort.')
    expect(
      fixture.runtime
        .getSnapshot()
        .events.some((event) => event.kind === 'message' && event.role === 'user')
    ).toBe(false)
    await vi.waitFor(() => expect(fixture.runtimeContext().plan?.continuation).toBeUndefined())
  })

  it('keeps a continuing Plan fail-closed after Session resume without dispatch or writes', async () => {
    const fixture = createDurablePlanResumeHarness('continuing')

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.readSessionRuntimeContext).toHaveBeenCalled())
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(fixture.fakeAgent.prompts).toHaveLength(0)
    expect(fixture.promptAttempts).toEqual([])
    expect(fixture.patchSessionRuntimeContext).not.toHaveBeenCalled()
    expect(fixture.runtimeContext().plan?.continuation?.state).toBe('continuing')
  })

  it('keeps continuing review feedback fail-closed after resume without replay', async () => {
    const fixture = createDurablePlanResumeHarness('continuing', { kind: 'review-feedback' })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() => expect(fixture.readSessionRuntimeContext).toHaveBeenCalled())
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(fixture.fakeAgent.prompts).toHaveLength(0)
    expect(fixture.patchSessionRuntimeContext).not.toHaveBeenCalled()
  })

  it('settles a cancelled hidden approved-Plan continuation as interrupted without replaying it', async () => {
    const fixture = createDurablePlanResumeHarness('queued', { stopReason: 'cancelled' })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() =>
      expect(fixture.runtimeContext().plan?.continuation?.state).toBe('interrupted')
    )
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(fixture.fakeAgent.prompts).toHaveLength(1)
  })

  it('settles cancelled hidden review feedback as interrupted', async () => {
    const fixture = createDurablePlanResumeHarness('queued', {
      kind: 'review-feedback',
      stopReason: 'cancelled'
    })

    await fixture.runtime.resumeSession({
      sessionId: 'restored-plan-session',
      providerSessionId: 'restored-plan-session',
      cwd: '/workspace',
      projectId: 'project-1',
      previousFrameworkId: opencodeFramework.id
    })

    await vi.waitFor(() =>
      expect(fixture.runtimeContext().plan?.continuation).toMatchObject({
        kind: 'review-feedback',
        state: 'interrupted'
      })
    )
  })

  it('activates one interaction before durably approving a restored Plan', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: { onEvent: (event) => events.push(event) }
    })
    const approved = restoredPlanProjection('approved', 5)
    const pending = restoredPlanProjection('pending', 4)
    const respond = vi.fn(async () => ({ projection: approved, changed: true }))
    installPromptPlanTestWorkflow(runtime, {
      respond,
      getProjection: vi.fn(async () => pending)
    })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: 's1',
      text: 'approve and continue',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 4,
        pendingAction: 'approve'
      },
      provenanceContext: {
        promptMessageId: 'approve-message',
        messageAncestry: ['plan-origin', 'approve-message']
      }
    })

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'approved',
        interactionIsLive: true,
        expectedRevision: 4
      })
    )
    expect(fakeAgent.prompts[0]?.text).toContain('approval=approved lifecycle=approved')
    expect(fakeAgent.prompts[0]?.text).not.toContain('artifact_version_id=')
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'plan',
        planProjection: expect.objectContaining({ approval: 'approved', revision: 5 })
      })
    )
  })

  it('injects restored pending Plan context into a fresh feedback interaction without authority', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })
    const pending = restoredPlanProjection('pending', 4)
    const getProjection = vi.fn(async () => pending)
    const respond = vi.fn()
    installPromptPlanTestWorkflow(runtime, { getProjection, respond })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: 's1',
      text: 'Split the analysis by cohort.',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 4,
        pendingAction: 'review'
      },
      provenanceContext: {
        promptMessageId: 'feedback-message',
        messageAncestry: ['plan-origin', 'feedback-message']
      }
    })

    expect(getProjection).toHaveBeenCalledWith('project-1', 's1', {
      interactionIsLive: false
    })
    expect(respond).not.toHaveBeenCalled()
    expect(fakeAgent.prompts[0]?.text).toContain('approval=pending')
    expect(fakeAgent.prompts[0]?.text).toContain('Split the analysis by cohort.')

    await expect(
      runtime.sendPrompt({
        sessionId: 's1',
        text: 'Use stale feedback.',
        planContinuation: {
          projectId: 'project-1',
          artifactVersionId: 'version-1',
          expectedRevision: 3,
          pendingAction: 'review'
        },
        provenanceContext: {
          promptMessageId: 'stale-feedback-message',
          messageAncestry: ['plan-origin', 'stale-feedback-message']
        }
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(fakeAgent.prompts).toHaveLength(1)
  })

  it('activates a fresh interaction before rejecting a restored Plan', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })
    const rejected = restoredPlanProjection('rejected', 5)
    const pending = restoredPlanProjection('pending', 4)
    const respond = vi.fn(async () => ({ projection: rejected, changed: true }))
    installPromptPlanTestWorkflow(runtime, {
      respond,
      getProjection: vi.fn(async () => pending)
    })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: 's1',
      text: 'Dismiss the current Plan.',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 4,
        pendingAction: 'reject'
      },
      provenanceContext: {
        promptMessageId: 'reject-message',
        messageAncestry: ['plan-origin', 'reject-message']
      }
    })

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'rejected',
        interactionIsLive: true,
        expectedRevision: 4
      })
    )
    expect(fakeAgent.prompts[0]?.text).toContain('approval=rejected')
  })

  it('gives OpenCode stable underscore names for app-owned action MCPs on create and resume', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['opencode-session'], { supportsResume: true })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4568',
          token: 'skill'
        })
      }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: created.sessionId, text: 'Use every app tool' })
    await runtime.resumeSession({ sessionId: 'resumed-opencode-session', cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'resumed-opencode-session', text: 'Continue with tools' })

    const expectedServerNames = [
      'open_science_artifacts',
      'open_science_notebook',
      'open_science_skills'
    ]
    expect(
      fakeAgent.newSessions[0].mcpServers.map((server) => (server as { name: string }).name)
    ).toEqual(expectedServerNames)
    expect(
      fakeAgent.resumedSessions[0].mcpServers.map((server) => (server as { name: string }).name)
    ).toEqual(expectedServerNames)

    for (const prompt of fakeAgent.prompts) {
      expect(prompt.text).not.toContain('`open_science_activity_begin_activity_group`')
      expect(prompt.text).toContain('`open_science_artifacts_write_artifact_file`')
      expect(prompt.text).toContain('`open_science_notebook_ask_user_question`')
      expect(prompt.text).toContain('`open_science_notebook_notebook_execute`')
      expect(prompt.text).toContain('open_science_skills_request_skill_import')
      expect(prompt.text).not.toContain('`open-science-')
    }
  })

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

  const terminalGenerationActions = [
    ['disconnect', async (runtime: AcpRuntime) => void (await runtime.disconnect())],
    ['synchronous shutdown', (runtime: AcpRuntime) => runtime.shutdown()],
    [
      'unexpected close cleanup',
      (runtime: AcpRuntime) =>
        (
          runtime as unknown as {
            connectionClose: { handleUnexpectedClose: () => void }
          }
        ).connectionClose.handleUnexpectedClose()
    ],
    [
      'failed deferred disconnect recovery',
      (runtime: AcpRuntime) =>
        (
          runtime as unknown as {
            connectionClose: { recoverFailedDeferredDisconnect: () => void }
          }
        ).connectionClose.recoverFailedDeferredDisconnect()
    ]
  ] satisfies ReadonlyArray<readonly [string, (runtime: AcpRuntime) => void | Promise<void>]>

  it.each(terminalGenerationActions)(
    'clears backend usage credentials on %s',
    async (_name, terminate) => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, [])
      const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
      const runtime = new AcpRuntime({
        appVersion: '0.2.0',
        defaultCwd: '/workspace',
        framework,
        resolveBackend: () => ({
          framework,
          executablePath: '/bin/opencode',
          env: {},
          opencodeUsageApi: {
            baseUrl: 'http://127.0.0.1:4242',
            authorization: 'Basic generation-secret'
          }
        })
      })

      await runtime.connect({ cwd: '/workspace' })
      expect(openCodeUsageApiForTest(runtime)).toBeDefined()

      await terminate(runtime)

      expect(openCodeUsageApiForTest(runtime)).toBeUndefined()
    }
  )

  it('retains backend usage credentials when disconnect rolls back a live connection', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      framework,
      resolveBackend: () => ({
        framework,
        executablePath: '/bin/opencode',
        env: {},
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic generation-secret'
        }
      })
    })
    await runtime.connect({ cwd: '/workspace' })
    vi.spyOn(connectionCloseForTest(runtime), 'disconnectCurrent').mockRejectedValueOnce(
      new Error('disconnect teardown failed')
    )

    await expect(runtime.disconnect()).rejects.toThrow('disconnect teardown failed')

    expect(openCodeUsageApiForTest(runtime)).toBeDefined()
    runtime.shutdown()
  })

  it('clears backend usage credentials when disconnect fails after detaching', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['usage-session'])
    const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      framework,
      resolveBackend: () => ({
        framework,
        executablePath: '/bin/opencode',
        env: {},
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic generation-secret'
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('session dispose failed')
      })

    try {
      await expect(runtime.disconnect()).rejects.toThrow('session dispose failed')
    } finally {
      disposeSpy.mockRestore()
    }

    expect(openCodeUsageApiForTest(runtime)).toBeUndefined()
  })

  it('kills the agent process synchronously on shutdown so it cannot outlive the app', async () => {
    const process = new FakeAgentProcess()
    const { lease, release } = createBackendLeaseHarness()
    startFakeAgent(process, ['shutdown-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: lease
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(process.killed).toBe(false)

    // shutdown() is synchronous (will-quit cannot await): the child must be signalled before it returns.
    runtime.shutdown()
    expect(process.killed).toBe(true)

    // Calling it again after the process is gone is a no-op, not a crash.
    expect(() => runtime.shutdown()).not.toThrow()
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })

  it('cancels delayed state publication before synchronous shutdown releases the runtime', () => {
    vi.useFakeTimers()
    try {
      const onStateChanged = vi.fn()
      const runtime = new AcpRuntime({
        appVersion: '0.2.0',
        defaultCwd: '/workspace',
        callbacks: { onStateChanged }
      })

      publicationForTest(runtime).pushEvent({
        kind: 'message',
        level: 'info',
        role: 'assistant',
        text: 'buffered state'
      })
      expect(onStateChanged).not.toHaveBeenCalled()

      runtime.shutdown()
      vi.advanceTimersByTime(33)

      expect(onStateChanged).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('does not report an in-flight prompt as a connection failure once quit teardown starts', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['quit-active-prompt-session'], {
      onPrompt: () => promptGate.promise
    })
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'stay pending' })
    void prompt.catch(() => undefined)
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    await runtime.shutdownForQuit()

    expect(events).not.toContainEqual(expect.objectContaining({ text: 'ACP connection closed' }))
    promptGate.resolve()
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

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    process.stdout.end()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    await vi.waitFor(() => expect(process.killed).toBe(true))
    expect(runtime.getSnapshot().sessionIds).toEqual([])
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]?.selectedProfile).toBe('ask')
    expect(runtime.getSessionFramework(session.sessionId)).toBe('claude-code')
  })

  it('publishes reattached sessions in their new attachment order', async () => {
    const initialProcess = new FakeAgentProcess()
    const resumedProcess = new FakeAgentProcess()
    startFakeAgent(initialProcess, ['session-a', 'session-b'])
    startFakeAgent(resumedProcess, [])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(spawnCount++ === 0 ? initialProcess : resumedProcess)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.createSession({ cwd: '/workspace' })
    expect(runtime.getSnapshot().sessionIds).toEqual(['session-a', 'session-b'])

    await runtime.disconnect()
    await runtime.resumeSession({ sessionId: 'session-b', cwd: '/workspace' })
    await runtime.resumeSession({ sessionId: 'session-a', cwd: '/workspace' })

    expect(runtime.getSnapshot().sessionIds).toEqual(['session-b', 'session-a'])
  })

  it('moves a context-reset session to its new attachment order', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-a', 'session-b', 'replacement-a'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.createSession({ cwd: '/workspace' })
    expect(runtime.getSnapshot().sessionIds).toEqual(['session-a', 'session-b'])

    await runtime.resetSessionContext({ sessionId: 'session-a', cwd: '/workspace' })

    expect(runtime.getSnapshot().sessionIds).toEqual(['session-b', 'session-a'])
  })

  it('keeps active ordering stable when resume only refreshes metadata', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-a', 'session-b'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({ sessionId: 'session-a', cwd: '/updated-workspace' })

    expect(runtime.getSnapshot().sessionIds).toEqual(['session-a', 'session-b'])
    expect(fakeAgent.resumedSessions).toEqual([])
  })

  it('releases the backend lease exactly once after an unexpected protocol close', async () => {
    const process = new FakeAgentProcess()
    const { lease, release } = createBackendLeaseHarness()
    startFakeAgent(process, ['unexpected-close-lease-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: lease
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.stdout.end()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())

    runtime.shutdown()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the backend lease once when synchronous shutdown overlaps protocol close', async () => {
    const process = new FakeAgentProcess()
    const { lease, release } = createBackendLeaseHarness()
    startFakeAgent(process, ['overlapping-close-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: lease
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    process.stdout.end()
    runtime.shutdown()

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(process.killed).toBe(true)
  })

  it('releases notebook RPC capabilities after an unexpected protocol close', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['unexpected-close-session'])
    const releaseSessionCapabilities = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        releaseSessionCapabilities
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    process.stdout.end()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(session.sessionId)
  })

  it('emits a terminal failure for every in-flight prompt before an unexpected close clears state', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['unexpected-close-session'], {
      onPrompt: () => promptGate.promise
    })
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'stay pending' })
    void prompt.catch(() => undefined)
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    process.stdout.end()

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        sessionId: session.sessionId,
        title: ACP_PROMPT_FAILED_EVENT_TITLE,
        text: 'ACP connection closed'
      })
    )
    promptGate.resolve()
  })

  it('does not attribute a resumed session event to a prompt from a closed connection', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000'
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const oldPromptGate = createDeferred()
    const oldAgent = startFakeAgent(oldProcess, [sessionId], {
      onPrompt: () => oldPromptGate.promise
    })
    startFakeAgent(newProcess, [])
    const events: AcpRuntimeEvent[] = []
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(spawnCount++ === 0 ? oldProcess : newProcess),
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime
      .sendPrompt({
        sessionId: session.sessionId,
        text: 'stay pending',
        provenanceContext: { promptMessageId: 'closed-prompt-message' }
      })
      .catch(() => undefined)
    await vi.waitFor(() => expect(oldAgent.prompts).toHaveLength(1))

    oldProcess.stdout.end()
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))

    await runtime.resumeSession({ sessionId, cwd: '/workspace' })
    const resumedEvent = events.filter((event) => event.title === 'Session resumed').at(-1)
    expect(resumedEvent).toMatchObject({ kind: 'system', sessionId })
    expect(resumedEvent?.promptMessageId).toBeUndefined()

    oldPromptGate.resolve()
    await prompt
    await runtime.disconnect()
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
    vi.mocked(terminateProcessTree).mockImplementationOnce(async (child) => {
      child?.kill()
      return { reaped: false }
    })
    let gatePromise: Promise<{ reaped: boolean }> | undefined
    let spawnCount = 0
    const reconnectSpawns: FakeAgentProcess[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => {
        spawnCount += 1
        if (spawnCount === 1) {
          // Model the update gate landing while a connect is inside provider spawn: start the gate
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
    expect(outcome).toEqual({ reaped: false })
    // The mid-spawn child was reaped, not left orphaned holding the install dir open.
    expect(midSpawn.killed).toBe(true)

    // Non-latching: once the gate resolves, a fresh connect succeeds (no lasting shutting-down latch).
    await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toBeDefined()
    expect(reconnectSpawns).toHaveLength(1)
  })

  it('shutdownForUpdateGate never latches shutting-down, so an abandoned (hung) teardown still reconnects', async () => {
    // Models the P2 timeout shape: the gate's in-flight connect hangs inside provider spawn, so the
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

  it('mounts Literature before a linked-PDF prompt when the earlier link could not reach a live runtime session', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const registerLiterature = vi.fn()
    const mcpHttpHost = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerLiterature,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      mcpHttpHost,
      literature: {
        isEnabled: vi.fn(async () => false),
        readDocument: vi.fn()
      }
    })
    vi.spyOn(promptContentLifecycle(runtime), 'prepare').mockResolvedValue({
      content: [{ type: 'text', text: 'linked PDF route' }],
      historyImageCount: 0,
      close: vi.fn(async () => undefined)
    })

    await runtime.enableLiteratureContext('remote-session-1')
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: '全文总结一下',
      referencedArtifacts: [
        {
          id: 'pdf-1',
          name: 'paper.pdf',
          source: 'upload',
          path: 'upload-version:project-1/source-session/version-1',
          versionId: 'version-1',
          mimeType: 'application/pdf',
          pdfReadingPosition: { pageNumber: 5, pageCount: 14 }
        }
      ]
    })

    expect(fakeAgent.resumedSessions).toHaveLength(1)
    expect(fakeAgent.resumedSessions[0].mcpServers).toEqual([
      expect.objectContaining({ type: 'http', name: 'open-science-literature' })
    ])
    expect(registerLiterature).toHaveBeenCalledOnce()
    expect(fakeAgent.prompts).toHaveLength(1)
  })

  it('provisions Literature on the first provider Session without requiring a Codex rollout', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      resumeInternalErrorDetails: 'no rollout found for thread id remote-session-1'
    })
    const registerLiterature = vi.fn()
    const mcpHttpHost = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerLiterature,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      mcpHttpHost,
      literature: {
        isEnabled: vi.fn(async () => false),
        readDocument: vi.fn()
      }
    })
    vi.spyOn(promptContentLifecycle(runtime), 'prepare').mockResolvedValue({
      content: [{ type: 'text', text: 'linked PDF route' }],
      historyImageCount: 0,
      close: vi.fn(async () => undefined)
    })

    const session = await runtime.createSession({
      cwd: '/workspace',
      projectId: 'project-1',
      literatureContext: true
    })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: '全文总结一下',
      referencedArtifacts: [
        {
          id: 'pdf-1',
          name: 'paper.pdf',
          source: 'upload',
          path: 'upload-version:project-1/source-session/version-1',
          versionId: 'version-1',
          mimeType: 'application/pdf',
          pdfReadingPosition: { pageNumber: 5, pageCount: 14 }
        }
      ]
    })

    expect(fakeAgent.newSessions).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers).toEqual([
      expect.objectContaining({ type: 'http', name: 'open-science-literature' })
    ])
    expect(fakeAgent.resumedSessions).toEqual([])
    expect(registerLiterature).toHaveBeenCalledTimes(2)
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'remote-session-1', text: 'linked PDF route' }])
  })

  it('reconfigures an idle provider Session without Literature after the final PDF is unlinked', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const mcpHttpHost = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerLiterature: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      mcpHttpHost,
      literature: {
        isEnabled: vi.fn(async () => false),
        readDocument: vi.fn()
      }
    })
    const reconfigure = vi.spyOn(
      (
        runtime as unknown as {
          providerSessionResumer: {
            reconfigure: (request: { memoryEnabled?: boolean }) => Promise<unknown>
          }
        }
      ).providerSessionResumer,
      'reconfigure'
    )
    const session = await runtime.createSession({
      cwd: '/workspace',
      projectId: 'project-1',
      memoryEnabled: false
    })

    await runtime.enableLiteratureContext(session.sessionId)
    await runtime.disableLiteratureContext(session.sessionId)

    expect(fakeAgent.resumedSessions).toHaveLength(2)
    expect(fakeAgent.resumedSessions[0].mcpServers).toEqual([
      expect.objectContaining({ type: 'http', name: 'open-science-literature' })
    ])
    expect(fakeAgent.resumedSessions[1].mcpServers).toEqual([])
    expect(reconfigure.mock.calls.map(([request]) => request.memoryEnabled)).toEqual([false, false])
  })

  it('adds the hidden Plan mode context only to the requested turn and preserves user Messages', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Analyze this dataset',
      turnIntent: 'plan-first'
    })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Here are more details' })

    const planPrompt = fakeAgent.prompts[0].text
    expect(planPrompt).toContain('## Plan mode (ACTIVE — MANDATORY)')
    expect(planPrompt).toContain(
      'Review the Skills available in the current session to confirm the catalog covers the task.'
    )
    expect(planPrompt).toContain('complete revised plan')
    expect(planPrompt).toContain('short exact `title`')
    expect(planPrompt).toContain('Execution starts only after approval.')
    expect(planPrompt).not.toContain('The plan is presented to the user for review')
    for (const forbidden of [
      'search_skills',
      'ask_user',
      'read_file',
      'save_artifacts',
      'end_turn',
      'agent framework'
    ]) {
      expect(planPrompt).not.toContain(forbidden)
    }
    expect(planPrompt).toContain('Analyze this dataset')
    expect(fakeAgent.prompts[1].text).toBe('Here are more details')
    expect(
      events
        .filter((event) => event.kind === 'message' && event.role === 'user')
        .map((event) => event.text)
    ).toEqual(['Analyze this dataset', 'Here are more details'])
  })

  it('keeps a text-only prompt free of omitted ambient context', async () => {
    const root = await createTemporaryRoot()
    const ambientSecret = 'AMBIENT_FILE_MUST_NOT_ENTER_PROMPT'
    await writeFile(join(root, 'ambient-secret.txt'), ambientSecret, 'utf8')
    const uploadRepository = new UploadRepository(root)
    const finalizeUploads = vi.spyOn(uploadRepository, 'finalizePendingSessionUploads')
    const resolveManagedUpload = vi.spyOn(uploadRepository, 'resolveManagedUploadPath')
    const resolveSessionUpload = vi.spyOn(uploadRepository, 'resolveSessionUploadPath')
    const registerTurnInputs = vi.fn(async () => undefined)
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: root,
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1/notebook', token: 'nb' }),
        registerTurnInputs
      }
    })

    const session = await runtime.createSession({ cwd: root })
    finalizeUploads.mockClear()
    resolveManagedUpload.mockClear()
    resolveSessionUpload.mockClear()
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'summarize without context' })

    expect(receivedPrompts).toEqual([[{ type: 'text', text: 'summarize without context' }]])
    expect(JSON.stringify(receivedPrompts)).not.toContain(ambientSecret)
    expect(finalizeUploads).not.toHaveBeenCalled()
    expect(resolveManagedUpload).not.toHaveBeenCalled()
    expect(resolveSessionUpload).not.toHaveBeenCalled()
    expect(registerTurnInputs).not.toHaveBeenCalled()
  })

  it('advertises form elicitation and resumes the prompt with a structured answer', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['elicitation-session'], {
      elicitationForPrompt: ({ sessionId }) => ({
        mode: 'form',
        sessionId,
        toolCallId: 'tool-ask-1',
        message: 'Choose an approach',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              title: 'Approach',
              enum: ['minimal', 'expanded']
            }
          },
          required: ['question_0']
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onStateChanged: (snapshot) => {
          const request = snapshot.pendingElicitations?.[0]
          if (!request) return
          runtime.respondToElicitation({
            requestId: request.requestId,
            action: 'accept',
            answers: [{ fieldId: 'question_0', value: 'minimal' }]
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'ask me' })

    expect(fakeAgent.initializeRequests[0].clientCapabilities).toMatchObject({
      elicitation: { form: {} }
    })
    expect(fakeAgent.elicitationResponses).toEqual([
      { action: 'accept', content: { question_0: 'minimal' } }
    ])
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          toolCallId: 'tool-ask-1',
          elicitation: expect.objectContaining({
            state: 'answered',
            answers: [{ fieldId: 'question_0', value: 'minimal' }]
          })
        })
      ])
    )
  })

  it('makes a provider-native AskUserQuestion form durable for restore and revision', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['native-choice-session'], {
      elicitationForPrompt: ({ sessionId }) => ({
        mode: 'form',
        sessionId,
        toolCallId: 'tool-native-choice',
        message: 'Please answer the following questions.',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              title: 'Scope',
              description: 'Which scope should I use?',
              oneOf: [
                { const: 'Focused', title: 'Focused' },
                { const: 'Broad', title: 'Broad' }
              ]
            },
            question_0_custom: {
              type: 'string',
              title: 'Other',
              description: 'Type your own answer instead of choosing an option above (optional).'
            },
            question_1: {
              type: 'string',
              title: 'Output',
              description: 'Which output should I produce?',
              oneOf: [
                { const: 'CLI', title: 'CLI' },
                { const: 'App', title: 'App' }
              ]
            },
            question_1_custom: {
              type: 'string',
              title: 'Other',
              description: 'Type your own answer instead of choosing an option above (optional).'
            }
          }
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onStateChanged: (snapshot) => {
          const request = snapshot.pendingElicitations?.[0]
          if (!request) return
          runtime.respondToElicitation({
            requestId: request.requestId,
            action: 'accept',
            answers: [
              { fieldId: 'question_0', value: 'Focused' },
              { fieldId: 'question_1', value: 'CLI' }
            ]
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Help me choose a direction first',
      provenanceContext: { promptMessageId: 'prompt-native-choice' }
    })

    expect(fakeAgent.elicitationResponses).toEqual([
      {
        action: 'accept',
        content: { question_0: 'Focused', question_1: 'CLI' }
      }
    ])
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'tool-native-choice',
          elicitation: expect.objectContaining({
            state: 'answered',
            durable: {
              kind: 'agent-user-choice',
              requestId: expect.any(String),
              promptMessageId: 'prompt-native-choice'
            }
          })
        })
      ])
    )
  })

  it('silently accepts Codex MCP approval for the trusted user-choice tool', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-choice-approval-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      codexMcpToolCallBeforeElicitation: {
        toolCallId: 'call-ask-user-question',
        server: 'open-science-notebook',
        tool: 'ask_user_question'
      },
      elicitationForPrompt: ({ sessionId }) => ({
        mode: 'form',
        sessionId,
        toolCallId: 'call-ask-user-question',
        message: 'Allow the open-science-notebook MCP server to run ask_user_question?',
        requestedSchema: {
          type: 'object',
          properties: {
            persist: {
              type: 'string',
              title: 'Approval scope',
              oneOf: [
                { const: 'once', title: 'Allow once' },
                { const: 'session', title: 'Allow for this session' },
                { const: 'always', title: "Allow and don't ask again" }
              ]
            }
          },
          required: ['persist']
        },
        _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }
      })
    })
    let publishedApprovalCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onStateChanged: (snapshot) => {
          const request = snapshot.pendingElicitations?.[0]
          if (!request) return
          publishedApprovalCount += 1
          runtime.respondToElicitation({
            requestId: request.requestId,
            action: 'accept',
            answers: [{ fieldId: 'persist', value: 'once' }]
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'ask me to choose' })

    expect(publishedApprovalCount).toBe(0)
    expect(fakeAgent.elicitationResponses).toEqual([{ action: 'accept' }])
  })

  it.each([
    {
      decision: 'allows',
      optionKind: 'allow_once',
      expectedResponse: { action: 'accept' as const }
    },
    {
      decision: 'denies',
      optionKind: 'reject_once',
      expectedResponse: { action: 'decline' as const }
    }
  ])(
    'routes Codex MCP approval elicitations through permission controls when the user $decision',
    async ({ optionKind, expectedResponse }) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['codex-notebook-approval-session'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
        codexMcpToolCallBeforeElicitation: {
          toolCallId: 'call-notebook-state',
          server: 'open-science-notebook',
          tool: 'notebook_state'
        },
        elicitationForPrompt: ({ sessionId }) => ({
          mode: 'form',
          sessionId,
          toolCallId: 'call-notebook-state',
          message: 'Allow the open-science-notebook MCP server to run notebook_state?',
          requestedSchema: {
            type: 'object',
            properties: {
              persist: {
                type: 'string',
                title: 'Approval scope',
                oneOf: [
                  { const: 'once', title: 'Allow once' },
                  { const: 'session', title: 'Allow for this session' },
                  { const: 'always', title: "Allow and don't ask again" }
                ]
              }
            },
            required: ['persist']
          },
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }
        })
      })
      const permissionRequests: AcpPermissionRequest[] = []
      let publishedElicitationCount = 0
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework: codexFramework,
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
        },
        callbacks: {
          onPermissionRequest: (request) => {
            permissionRequests.push(request)
            const selectedOption = request.options.find((option) => option.kind === optionKind)
            if (!selectedOption) throw new Error(`Missing ${optionKind} permission option`)
            void runtime.respondToPermission({
              requestId: request.requestId,
              optionId: selectedOption.optionId
            })
          },
          onStateChanged: (snapshot) => {
            const request = snapshot.pendingElicitations?.[0]
            if (!request) return
            publishedElicitationCount += 1
            runtime.respondToElicitation({ requestId: request.requestId, action: 'decline' })
          }
        }
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'inspect the notebook' })

      expect(publishedElicitationCount).toBe(0)
      expect(permissionRequests).toHaveLength(1)
      expect(permissionRequests[0]).toMatchObject({
        sessionId: session.sessionId,
        toolCallId: 'call-notebook-state',
        providerToolName: 'notebook_state',
        isMcp: true
      })
      expect(fakeAgent.elicitationResponses).toEqual([expectedResponse])
    }
  )

  it.each([
    {
      label: 'REPL execution',
      toolCallId: 'call-large-repl',
      tool: 'repl_execute',
      arguments: { code: 'A'.repeat(8_500) },
      expectedPermissionInput: {
        language: 'javascript',
        code: 'A'.repeat(7_500),
        inputTruncated: true
      }
    },
    {
      label: 'skill edit',
      toolCallId: 'call-large-skill-edit',
      tool: 'host.skills.edit',
      arguments: { path: 'pubmed-trend-piechart/SKILL.md', content: 'A'.repeat(8_500) },
      expectedPermissionInput: undefined
    }
  ])(
    'routes an oversized Codex MCP $label through permission controls without publishing it',
    async ({ toolCallId, tool, arguments: toolArguments, expectedPermissionInput }) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['codex-large-approval-session'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
        codexMcpToolCallBeforeElicitation: {
          toolCallId,
          server: 'open-science-notebook',
          tool,
          arguments: toolArguments
        },
        elicitationForPrompt: ({ sessionId }) => ({
          mode: 'form',
          sessionId,
          toolCallId,
          message: `Allow the open-science-notebook MCP server to run ${tool}?`,
          requestedSchema: {
            type: 'object',
            properties: {
              persist: { type: 'string', title: 'Approval scope', enum: ['once'] }
            },
            required: ['persist']
          },
          _meta: { codex_approval_kind: 'mcp_tool_call' }
        })
      })
      const permissionRequests: AcpPermissionRequest[] = []
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework: codexFramework,
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
        },
        callbacks: {
          onPermissionRequest: (request) => {
            permissionRequests.push(request)
            const allowOnce = request.options.find((option) => option.kind === 'allow_once')
            if (!allowOnce) throw new Error('Missing allow_once permission option')
            void runtime.respondToPermission({
              requestId: request.requestId,
              optionId: allowOnce.optionId
            })
          }
        }
      })

      const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: `run a large ${tool} input` })

      expect(permissionRequests).toHaveLength(1)
      expect(permissionRequests[0]).toMatchObject({ toolCallId, providerToolName: tool })
      expect(permissionRequests[0]?.rawInput).toEqual(expectedPermissionInput)
      expect(
        runtime.getSnapshot().events.find((event) => event.toolCallId === toolCallId)?.rawInput
      ).toBeUndefined()
      expect(fakeAgent.elicitationResponses).toEqual([{ action: 'accept' }])
    },
    30_000
  )

  it('cancels a Codex MCP elicitation when its permission flow is cancelled', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-cancelled-approval-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      codexMcpToolCallBeforeElicitation: {
        toolCallId: 'call-cancelled-repl',
        server: 'open-science-notebook',
        tool: 'repl_execute',
        arguments: { code: '1 + 1' }
      },
      elicitationForPrompt: ({ sessionId }) => ({
        mode: 'form',
        sessionId,
        toolCallId: 'call-cancelled-repl',
        message: 'Allow the open-science-notebook MCP server to run repl_execute?',
        requestedSchema: {
          type: 'object',
          properties: {
            persist: { type: 'string', title: 'Approval scope', enum: ['once'] }
          },
          required: ['persist']
        },
        _meta: { codex_approval_kind: 'mcp_tool_call' }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          void runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'cancel this approval' })

    expect(fakeAgent.elicitationResponses).toEqual([{ action: 'cancel' }])
  })

  it('cancels a repeated Codex MCP approval after its correlation is consumed', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-choice-replay-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      codexMcpToolCallBeforeElicitation: {
        toolCallId: 'call-ask-user-question',
        server: 'open-science-notebook',
        tool: 'ask_user_question'
      },
      elicitationRepeatCount: 2,
      elicitationForPrompt: ({ sessionId }) => ({
        mode: 'form',
        sessionId,
        toolCallId: 'call-ask-user-question',
        message: 'Allow the open-science-notebook MCP server to run ask_user_question?',
        requestedSchema: {
          type: 'object',
          properties: {
            persist: {
              type: 'string',
              title: 'Approval scope',
              enum: ['once']
            }
          },
          required: ['persist']
        },
        _meta: { codex_approval_kind: 'mcp_tool_call' }
      })
    })
    let publishedApprovalCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onStateChanged: (snapshot) => {
          const request = snapshot.pendingElicitations?.[0]
          if (!request) return
          publishedApprovalCount += 1
          runtime.respondToElicitation({
            requestId: request.requestId,
            action: 'accept',
            answers: [{ fieldId: 'persist', value: 'once' }]
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'replay approval' })

    expect(publishedApprovalCount).toBe(0)
    expect(fakeAgent.elicitationResponses).toEqual([{ action: 'accept' }, { action: 'cancel' }])
  })

  it('acknowledges an app-owned MCP choice and silently continues after the user answers', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['user-choice-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.requestUserInput({
        sessionId: session.sessionId,
        questions: [
          {
            question: 'Which implementation should I use?',
            header: 'Approach',
            options: [
              { label: 'Minimal', description: 'Make the smallest focused change.' },
              { label: 'Expanded', description: 'Include optional extensions.' }
            ]
          }
        ]
      })
    ).resolves.toEqual({ action: 'pending' })

    const request = runtime.getSnapshot().pendingElicitations?.[0]
    expect(request).toMatchObject({
      sessionId: session.sessionId,
      durable: { kind: 'agent-user-choice', requestId: expect.any(String) }
    })

    const accepted = await runtime.respondToElicitation({
      requestId: request!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    })
    expect(accepted.promptInFlightSessionIds).toContain(session.sessionId)

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(fakeAgent.prompts[0]).toMatchObject({
      sessionId: 'user-choice-session',
      text: expect.stringContaining('Minimal')
    })
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
    )

    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          elicitation: expect.objectContaining({
            state: 'answered',
            answers: [{ fieldId: 'question_0', value: 'Minimal' }]
          })
        })
      ])
    )
  })

  it('preserves Session reference guidance and authority across an app-owned choice', async () => {
    const process = new FakeAgentProcess()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    let appSessionId = ''
    let continuationAuthorized = false
    const fakeAgent = startFakeAgent(process, ['referenced-user-choice-session'], {
      onPrompt: async ({ text }) => {
        if (text.includes('start the referenced workflow')) {
          await runtime.requestUserInput({
            sessionId: appSessionId,
            questions: [
              {
                question: 'Which implementation should I use?',
                options: [{ label: 'Minimal' }, { label: 'Expanded' }]
              }
            ]
          })
          return
        }
        continuationAuthorized = (
          runtime as unknown as {
            sessionInteractions: {
              isSessionReferenceAllowed(sessionId: string, referencedSessionId: string): boolean
            }
          }
        ).sessionInteractions.isSessionReferenceAllowed(appSessionId, 'referenced-session')
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    appSessionId = session.sessionId
    await runtime.sendPrompt({
      sessionId: appSessionId,
      text: 'start the referenced workflow',
      referencedSessions: [
        { type: 'session', sessionId: 'referenced-session', title: 'Prior analysis' }
      ]
    })

    const request = runtime.getSnapshot().pendingElicitations?.[0]
    expect(request).toBeDefined()
    await runtime.respondToElicitation({
      requestId: request!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))
    expect(fakeAgent.prompts[1].text).toContain('sessionId="referenced-session"')
    expect(continuationAuthorized).toBe(true)
  })

  it('preserves the originating Agent Frame when an app-owned choice continues the turn', async () => {
    const storageRoot = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const observedProvenance: Array<{
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      messageBranchAncestry: string[]
      messageAncestry: string[]
      runtimeSegmentId: string
      promptMessageId: string
    }> = []
    let currentRunFile = ''
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(storageRoot)
      }
    })
    const fakeAgent = startFakeAgent(process, ['user-choice-frame-session'], {
      onPrompt: async ({ sessionId, text }) => {
        const currentRun = JSON.parse(await readFile(currentRunFile, 'utf8')) as {
          rootFrameId: string
          agentFrameId: string
          messageBranchId: string
          messageBranchAncestry: string[]
          messageAncestry: string[]
          runtimeSegmentId: string
          promptMessageId: string
        }
        observedProvenance.push({
          rootFrameId: currentRun.rootFrameId,
          agentFrameId: currentRun.agentFrameId,
          messageBranchId: currentRun.messageBranchId,
          messageBranchAncestry: currentRun.messageBranchAncestry,
          messageAncestry: currentRun.messageAncestry,
          runtimeSegmentId: currentRun.runtimeSegmentId,
          promptMessageId: currentRun.promptMessageId
        })
        if (text === 'begin the framed workflow') {
          await runtime.requestUserInput({
            sessionId,
            questions: [
              {
                question: 'Which implementation should I use?',
                options: [{ label: 'Minimal' }, { label: 'Expanded' }]
              }
            ]
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    currentRunFile = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
    )
    const expectedProvenance = {
      rootFrameId: 'durable-root-frame',
      agentFrameId: 'originating-agent-frame',
      messageBranchId: 'durable-root-branch',
      messageBranchAncestry: ['durable-root-branch'],
      messageAncestry: ['originating-prompt-message'],
      runtimeSegmentId: 'durable-runtime-segment',
      promptMessageId: 'originating-prompt-message'
    }
    const originatingProvenance = structuredClone(expectedProvenance)
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'begin the framed workflow',
      provenanceContext: originatingProvenance
    })

    const choice = runtime.getSnapshot().pendingElicitations?.[0]
    expect(choice).toBeDefined()
    originatingProvenance.rootFrameId = 'mutated-after-the-originating-turn'
    originatingProvenance.messageBranchAncestry.push('mutated-branch')
    originatingProvenance.messageAncestry.push('mutated-message')
    await runtime.respondToElicitation({
      requestId: choice!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    })
    await vi.waitFor(() => expect(observedProvenance).toHaveLength(2))

    expect(observedProvenance).toEqual([expectedProvenance, expectedProvenance])
  })

  it('waits for every queued app-owned choice before continuing with all answers', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['queued-user-choice-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestUserInput({
      sessionId: session.sessionId,
      questions: [
        {
          question: 'Which stack should I use?',
          options: [{ label: 'Python' }, { label: 'R' }]
        }
      ]
    })
    await runtime.requestUserInput({
      sessionId: session.sessionId,
      questions: [
        {
          question: 'Which output should I produce?',
          options: [{ label: 'Notebook' }, { label: 'Report' }]
        }
      ]
    })

    const [request] = runtime.getSnapshot().pendingElicitations ?? []
    expect(runtime.getSnapshot().pendingElicitations).toHaveLength(1)
    expect(request.fields).toMatchObject([
      { id: 'question_0', description: 'Which stack should I use?' },
      { id: 'question_0_custom' },
      { id: 'question_1', description: 'Which output should I produce?' },
      { id: 'question_1_custom' }
    ])
    expect(
      runtime
        .getSnapshot()
        .events.filter((event) => event.kind === 'tool' && event.elicitation?.state === 'pending')
        .at(-1)?.elicitation?.fields
    ).toMatchObject(request.fields)
    runtime.respondToElicitation({
      requestId: request.requestId,
      action: 'accept',
      answers: [
        { fieldId: 'question_0', value: 'Python' },
        { fieldId: 'question_1', value: 'Report' }
      ]
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(fakeAgent.prompts[0].text).toContain('Which stack should I use?')
    expect(fakeAgent.prompts[0].text).toContain('Python')
    expect(fakeAgent.prompts[0].text).toContain('Which output should I produce?')
    expect(fakeAgent.prompts[0].text).toContain('Report')
  })

  it('aggregates usage across repeated app-owned choices for the originating user turn', async () => {
    const process = new FakeAgentProcess()
    const usageForText = (text: string): NonNullable<PromptResponse['usage']> =>
      text === 'begin the workflow'
        ? {
            totalTokens: 17,
            inputTokens: 10,
            cachedReadTokens: 2,
            cachedWriteTokens: 1,
            outputTokens: 4
          }
        : text.includes('Answer: Minimal')
          ? {
              totalTokens: 31,
              inputTokens: 20,
              cachedReadTokens: 4,
              cachedWriteTokens: 1,
              outputTokens: 6
            }
          : {
              totalTokens: 45,
              inputTokens: 30,
              cachedReadTokens: 5,
              cachedWriteTokens: 2,
              outputTokens: 8
            }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const fakeAgent = startFakeAgent(process, ['repeated-user-choice-session'], {
      onPrompt: async ({ sessionId, text }) => {
        if (text === 'begin the workflow') {
          await runtime.requestUserInput({
            sessionId,
            questions: [
              {
                question: 'Which implementation should I use?',
                options: [{ label: 'Minimal' }, { label: 'Expanded' }]
              }
            ]
          })
        } else if (text.includes('Answer: Minimal')) {
          await runtime.requestUserInput({
            sessionId,
            questions: [
              {
                question: 'Which output should I produce?',
                options: [{ label: 'Report' }, { label: 'Notebook' }]
              }
            ]
          })
        }
        return { stopReason: 'end_turn', usage: usageForText(text) }
      },
      claudeTurnCountForPrompt: (text) =>
        text === 'begin the workflow' ? 1 : text.includes('Answer: Minimal') ? 2 : 3
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const promptMessageId = 'originating-user-message'
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'begin the workflow',
      provenanceContext: { promptMessageId }
    })

    const firstChoice = runtime.getSnapshot().pendingElicitations?.[0]
    expect(firstChoice).toBeDefined()
    runtime.respondToElicitation({
      requestId: firstChoice!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))
    await vi.waitFor(() => expect(runtime.getSnapshot().pendingElicitations).toHaveLength(1))

    const secondChoice = runtime.getSnapshot().pendingElicitations?.[0]
    runtime.respondToElicitation({
      requestId: secondChoice!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Report' }]
    })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(3))
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
    )

    const stops = runtime
      .getSnapshot()
      .events.filter((event) => event.kind === 'stop' && event.promptMessageId === promptMessageId)
    expect(stops).toHaveLength(3)
    expect(stops.at(-1)?.turnUsage).toEqual({
      inputTokens: 60,
      cacheTokens: 15,
      cachedReadTokens: 11,
      cachedWriteTokens: 4,
      outputTokens: 18,
      turnCount: 6
    })
  })

  it('publishes one multi-question choice and continues only after every answer', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['batched-user-choice-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestUserInput({
      sessionId: session.sessionId,
      questions: [
        {
          question: 'Which stack should I use?',
          options: [{ label: 'Python' }, { label: 'R' }]
        },
        {
          question: 'Which output should I produce?',
          options: [{ label: 'Notebook' }, { label: 'Report' }]
        }
      ]
    })

    const [request] = runtime.getSnapshot().pendingElicitations ?? []
    expect(runtime.getSnapshot().pendingElicitations).toHaveLength(1)
    expect(request.fields).toMatchObject([
      { id: 'question_0', description: 'Which stack should I use?' },
      { id: 'question_0_custom' },
      { id: 'question_1', description: 'Which output should I produce?' },
      { id: 'question_1_custom' }
    ])
    expect(fakeAgent.prompts).toHaveLength(0)

    runtime.respondToElicitation({
      requestId: request.requestId,
      action: 'accept',
      answers: [
        { fieldId: 'question_0', value: 'Python' },
        { fieldId: 'question_1', value: 'Report' }
      ]
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(fakeAgent.prompts[0].text).toContain('Which stack should I use?')
    expect(fakeAgent.prompts[0].text).toContain('Python')
    expect(fakeAgent.prompts[0].text).toContain('Which output should I produce?')
    expect(fakeAgent.prompts[0].text).toContain('Report')
  })

  it('keeps the asking turn normal after publishing an app-owned choice', async () => {
    const process = new FakeAgentProcess()
    const cancelledSessions: string[] = []

    acp
      .agent({ name: 'ordered-user-choice-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'ordered-choice-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'choice-intro',
            content: { type: 'text', text: 'I need one detail before I continue.' }
          }
        })
        await runtime.requestUserInput({
          sessionId: ctx.params.sessionId,
          questions: [
            {
              question: 'Which stack should I use?',
              options: [{ label: 'Python' }, { label: 'R' }]
            }
          ]
        })
        return {
          stopReason: cancelledSessions.includes(ctx.params.sessionId) ? 'cancelled' : 'end_turn'
        }
      })
      .onNotification(acp.methods.agent.session.cancel, (ctx) => {
        cancelledSessions.push(ctx.params.sessionId)
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

    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'build a useful skill' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(cancelledSessions).toEqual([])
    const events = runtime.getSnapshot().events
    const introIndex = events.findIndex(
      (event) => event.kind === 'message' && event.text === 'I need one detail before I continue.'
    )
    const choiceIndex = events.findIndex(
      (event) => event.kind === 'tool' && event.elicitation?.state === 'pending'
    )
    expect(introIndex).toBeGreaterThanOrEqual(0)
    expect(choiceIndex).toBeGreaterThan(introIndex)
  })

  it('rehydrates a persisted app-owned choice before silently continuing', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    let artifactContext: Record<string, unknown> | undefined
    const fakeAgent = startFakeAgent(process, ['restored-choice-session'], {
      onPrompt: async () => {
        const [artifactSessionId] = await readdir(join(root, 'artifacts', 'project-1'))
        artifactContext = JSON.parse(
          await readFile(
            join(root, 'artifacts', 'project-1', artifactSessionId, '.pending', 'current-run.json'),
            'utf8'
          )
        ) as Record<string, unknown>
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js'
      },
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(),
          patchSessionRuntimeContext: vi.fn(),
          containsMessageOnActiveBranch: vi.fn(),
          loadSessionForContinuation: vi.fn(async () =>
            addPendingRestoredChoice(
              createRestoredContinuationSession(
                'prompt-restored-1',
                'restored-choice-session',
                'project-1'
              )
            )
          )
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    const request = {
      requestId: 'choice-restored-1',
      sessionId: session.sessionId,
      toolCallId: 'tool-choice-restored-1',
      message: 'Renderer-forged question',
      fields: [
        {
          id: 'question_0',
          label: 'Renderer-forged field',
          kind: 'text' as const
        }
      ],
      durable: {
        kind: 'agent-user-choice' as const,
        requestId: 'choice-restored-1',
        promptMessageId: 'prompt-restored-1',
        provenanceContext: {
          rootFrameId: 'durable-root-frame',
          agentFrameId: 'durable-root-frame',
          messageBranchId: 'durable-root-branch',
          runtimeSegmentId: 'durable-runtime-segment',
          promptMessageId: 'prompt-restored-1'
        }
      }
    }

    await runtime.respondToElicitation({
      requestId: request.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Expanded' }],
      historyReplay: { historyPreamble: 'Renderer-forged conversation context.' },
      request
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    await vi.waitFor(() => expect(artifactContext).toBeDefined())
    expect(artifactContext).toMatchObject({
      rootFrameId: 'root-frame-pending-session',
      agentFrameId: 'root-frame-pending-session',
      messageBranchId: 'message-branch-pending-session',
      runtimeSegmentId: 'runtime-segment-pending-session',
      promptMessageId: 'prompt-restored-1'
    })
    expect(fakeAgent.prompts[0].text).toContain('Expanded')
    expect(fakeAgent.prompts[0].text).toContain('Choose an approach')
    expect(fakeAgent.prompts[0].text).not.toContain('Renderer-forged question')
    expect(fakeAgent.prompts[0].text).not.toContain('Renderer-forged conversation context.')
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'tool-choice-restored-1',
          promptMessageId: 'prompt-restored-1',
          elicitation: expect.objectContaining({
            state: 'answered',
            durable: expect.objectContaining({
              kind: 'agent-user-choice',
              requestId: 'choice-restored-1',
              promptMessageId: 'prompt-restored-1'
            })
          })
        })
      ])
    )
  })

  it('validates a revised choice against the durable fork before continuing', async () => {
    const process = new FakeAgentProcess()
    const journal: string[] = []
    const fakeAgent = startFakeAgent(process, ['restored-choice-session'], {
      onPrompt: () => {
        journal.push('provider-prompt')
      }
    })
    let persistedSession = createRestoredChoiceRevisionSession()
    const appendUserMessageToInteraction = vi.fn(
      async (
        command: Parameters<SessionPersistenceCoordinator['appendUserMessageToInteraction']>[0]
      ) => {
        command.beforePersist?.(structuredClone(persistedSession))
        const revisedPrompt: PersistedChatSession['messages'][number] = {
          id: 'prompt-revision',
          role: 'user',
          content: command.content,
          status: 'complete',
          responseToMessageId: command.interactionId,
          eventIds: [],
          createdAt: 4,
          updatedAt: 4
        }
        persistedSession = {
          ...persistedSession,
          messages: [...persistedSession.messages, revisedPrompt],
          conversationGraph: synchronizeActiveConversationMessages(
            persistedSession.conversationGraph!,
            [...persistedSession.messages, revisedPrompt],
            4
          ),
          updatedAt: 4
        }
        return structuredClone(revisedPrompt)
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(),
          patchSessionRuntimeContext: vi.fn(),
          containsMessageOnActiveBranch: vi.fn(),
          loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession)),
          appendUserMessageToInteraction
        },
        onContinuationSessionUpdated: (session) => {
          expect(session.messages.at(-1)).toMatchObject({ id: 'prompt-revision' })
          journal.push('session-published')
        }
      }
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.respondToElicitation({
      requestId: 'choice-restored-1',
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Expanded' }],
      replacePreviousAnswer: true,
      request: {
        requestId: 'choice-restored-1',
        sessionId: 'restored-choice-session',
        toolCallId: 'renderer-generated-revision-tool',
        message: 'Renderer-forged question',
        fields: [{ id: 'question_0', label: 'Renderer-forged field', kind: 'text' }],
        durable: {
          kind: 'agent-user-choice',
          requestId: 'choice-restored-1',
          promptMessageId: 'prompt-restored-1'
        }
      }
    })

    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    expect(journal).toEqual(['session-published', 'provider-prompt'])
    expect(appendUserMessageToInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'restored-choice-session',
        interactionId: 'agent-question-preamble',
        content: expect.stringContaining('Approach: Expanded')
      })
    )
    expect(fakeAgent.prompts[0].text).toContain('Expanded')
    expect(fakeAgent.prompts[0].text).not.toContain('Renderer-forged question')
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          toolCallId: expect.stringMatching(/^ask-user-question-revision-/),
          promptMessageId: 'prompt-revision',
          elicitation: expect.objectContaining({ state: 'answered' })
        })
      ])
    )
  })

  it.each(RESTORED_CONTINUATION_FRAMEWORKS)(
    'builds restored choice replay through %s from Main-owned Session history after context reset',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      const receivedPrompts: ContentBlock[][] = []
      const fakeAgent = startFakeAgent(process, ['adopted-provider-session'], {
        resumeNotFound: true,
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {}),
        onPrompt: ({ prompt }) => {
          receivedPrompts.push(prompt)
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const messages: PersistedChatSession['messages'] = [
        {
          id: 'prompt-earlier',
          role: 'user',
          content: 'Main-owned earlier request.',
          status: 'complete',
          images: [
            {
              id: 'choice-replay-image',
              mimeType: 'image/png',
              data: createPngBytes('choice-replay').toString('base64'),
              byteLength: createPngBytes('choice-replay').byteLength
            }
          ],
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'reply-earlier',
          role: 'agent',
          content: 'Main-owned earlier response.',
          status: 'complete',
          responseToMessageId: 'prompt-earlier',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'prompt-restored-1',
          role: 'user',
          content: 'Choose an approach.',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ]
      const persistedSession: PersistedChatSession = {
        id: 'restored-choice-session',
        projectId: 'project-1',
        title: 'Restored choice',
        cwd: '/workspace',
        status: 'waiting-for-user',
        messages,
        conversationGraph: createLinearConversationGraph({
          sessionId: 'pending-session',
          messages,
          frameworkId: framework.id,
          backendId,
          createdAt: 1,
          updatedAt: 3
        }),
        createdAt: 1,
        updatedAt: 3
      }
      addPendingRestoredChoice(persistedSession)
      const loadSessionForContinuation = vi.fn(async () => structuredClone(persistedSession))
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        permissionWait: {
          sessions: {
            readSessionRuntimeContext: vi.fn(),
            patchSessionRuntimeContext: vi.fn(),
            containsMessageOnActiveBranch: vi.fn(),
            loadSessionForContinuation
          }
        },
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          contextWindow: 200_000,
          supportsImageInput: true,
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      await expect(
        runtime.resumeSession({
          sessionId: 'restored-choice-session',
          cwd: '/workspace',
          projectId: 'project-1'
        })
      ).resolves.toMatchObject({ sessionId: 'restored-choice-session', contextReset: true })
      await runtime.respondToElicitation({
        requestId: 'choice-restored-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }],
        historyReplay: { historyPreamble: 'Renderer-forged conversation context.' },
        request: {
          requestId: 'choice-restored-1',
          sessionId: 'restored-choice-session',
          toolCallId: 'tool-choice-restored-1',
          message: 'Choose an approach',
          fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
          durable: {
            kind: 'agent-user-choice',
            requestId: 'choice-restored-1',
            promptMessageId: 'prompt-restored-1'
          }
        }
      })

      await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
      expect(loadSessionForContinuation).toHaveBeenCalledWith(
        'project-1',
        'restored-choice-session'
      )
      expect(fakeAgent.prompts[0].text).toContain('Main-owned earlier request.')
      expect(fakeAgent.prompts[0].text).not.toContain('Renderer-forged conversation context.')
      expect(receivedPrompts[0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'image' })])
      )
    }
  )

  it('rejects a mismatched restored choice without leaving a pending request', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['mismatched-choice-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(
      runtime.respondToElicitation({
        requestId: 'outer-choice-id',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Minimal' }],
        request: {
          requestId: 'inner-choice-id',
          sessionId: session.sessionId,
          toolCallId: 'tool-choice-mismatch',
          message: 'Choose an approach',
          fields: [
            {
              id: 'question_0',
              label: 'Approach',
              kind: 'single-select',
              options: [
                { value: 'Minimal', label: 'Minimal' },
                { value: 'Expanded', label: 'Expanded' }
              ]
            }
          ],
          durable: { kind: 'agent-user-choice', requestId: 'inner-choice-id' }
        }
      })
    ).rejects.toThrow('Restored structured input request id does not match the response')
    expect(runtime.getSnapshot().pendingElicitations).toEqual([])
  })

  it('rejects a restored choice missing from the active graph without caching it', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['restored-choice-session'])
    const persistedSession = createRestoredContinuationSession(
      'prompt-active',
      'restored-choice-session'
    )
    persistedSession.messages.push({
      id: 'prompt-inactive',
      role: 'user',
      content: 'Use the abandoned approach.',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    })
    addPendingRestoredChoice(persistedSession, { promptMessageId: 'prompt-inactive' })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(),
          patchSessionRuntimeContext: vi.fn(),
          containsMessageOnActiveBranch: vi.fn(),
          loadSessionForContinuation: vi.fn(async () => structuredClone(persistedSession))
        }
      }
    })
    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await expect(
      runtime.respondToElicitation({
        requestId: 'choice-restored-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }],
        request: {
          requestId: 'choice-restored-1',
          sessionId: 'restored-choice-session',
          toolCallId: 'tool-choice-restored-1',
          message: 'Choose an approach',
          fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
          durable: {
            kind: 'agent-user-choice',
            requestId: 'choice-restored-1',
            promptMessageId: 'prompt-inactive'
          }
        }
      })
    ).rejects.toThrow('pending Session activity')
    expect(runtime.getSnapshot().pendingElicitations).toEqual([])
    await expect(
      runtime.respondToElicitation({
        requestId: 'choice-restored-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }]
      })
    ).rejects.toThrow('Unknown structured input request')
  })

  it('waits for the asking turn to stop before silently continuing with the answer', async () => {
    const process = new FakeAgentProcess()
    const firstPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['queued-choice-session'], {
      onPrompt: async ({ text }) => {
        if (text === 'Ask before continuing') await firstPrompt.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const askingTurn = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Ask before continuing'
    })
    await vi.waitFor(() => expect(runtime.getSnapshot().promptInFlight).toBe(true))
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    await runtime.requestUserInput({
      sessionId: session.sessionId,
      questions: [
        {
          question: 'Which implementation should I use?',
          options: [{ label: 'Minimal' }, { label: 'Expanded' }]
        }
      ]
    })
    const request = runtime.getSnapshot().pendingElicitations?.[0]
    runtime.respondToElicitation({
      requestId: request!.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    })
    await runtime.requestProviderReconnect()

    expect(fakeAgent.prompts).toHaveLength(1)

    firstPrompt.resolve()
    await askingTurn
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))
    expect(fakeAgent.prompts[1].text).toContain('Minimal')
    await vi.waitFor(() => expect(process.killed).toBe(true))
  })

  it('sends staged uploads as ACP prompt content blocks', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
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

  it('preserves prompt content order across replay images, uploads, and references', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const [historyUpload, currentUpload, mentionedUpload] = await stageUploadFixtures(
      uploadRepository,
      {
        files: [
          {
            name: 'history.txt',
            mimeType: 'text/plain',
            content: Buffer.from('history upload').toString('base64')
          },
          {
            name: 'current.txt',
            mimeType: 'text/plain',
            content: Buffer.from('current upload').toString('base64')
          },
          {
            name: 'mentioned.txt',
            mimeType: 'text/plain',
            content: Buffer.from('mentioned upload').toString('base64')
          }
        ]
      }
    )
    const [mentionedReference] = await uploadRepository.finalizePendingSessionUploads(
      'remote-session-1',
      [mentionedUpload]
    )
    const managedUploads = new Map(
      [historyUpload, currentUpload, mentionedReference].map((upload) => [upload.id, upload])
    )
    const openLatest = vi.fn(({ fileId }: { fileId: string }) => {
      const upload = managedUploads.get(fileId)
      if (!upload) throw new Error(`Missing managed upload fixture: ${fileId}`)
      const path =
        upload === mentionedReference
          ? upload.path
          : join(root, 'uploads', 'default-project', 'remote-session-1', upload.originalName)
      return createManagedReadLease({
        source: 'upload',
        projectId: 'default-project',
        sessionId: 'remote-session-1',
        fileId,
        path,
        name: upload.originalName,
        mimeType: upload.mimeType
      })
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
        projectId: 'default-project',
        mcpEntryPath: '/unused',
        managedFileVersions: { openLatest } as never
      }
    })
    const historyImageData = Buffer.from('history-image').toString('base64')

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'inspect all context',
      historyImages: [
        {
          mimeType: 'image/png',
          data: historyImageData,
          byteLength: Buffer.byteLength('history-image')
        }
      ],
      historyAttachments: [historyUpload],
      attachments: [currentUpload],
      referencedArtifacts: [
        {
          id: mentionedReference.id,
          name: mentionedReference.originalName,
          path: mentionedReference.path,
          source: 'upload',
          sourceFileId: mentionedReference.id,
          mimeType: mentionedReference.mimeType
        }
      ]
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0]).toMatchObject([
      { type: 'text', text: 'inspect all context' },
      { type: 'image', mimeType: 'image/png', data: historyImageData },
      { type: 'resource_link', name: 'history.txt' },
      { type: 'resource', resource: { text: 'current upload' } },
      { type: 'resource', resource: { text: 'mentioned upload' } }
    ])
  })

  it('keeps ordinary ZIPs on provider-safe references and marks only Skill packages eligible', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const skillArchive = buildStoredSkillArchive('Example Package')
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
      files: [
        {
          name: 'ordinary-data.zip',
          mimeType: 'application/zip',
          content: Buffer.from('zip-bytes').toString('base64')
        },
        {
          name: 'ordinary-data.bin',
          mimeType: ' Application/ZIP ; charset=binary ',
          content: Buffer.from('zip-bytes').toString('base64')
        },
        {
          name: 'example-package.skill',
          mimeType: 'application/octet-stream',
          content: skillArchive.toString('base64')
        },
        {
          name: 'renamed-garbage.skill',
          mimeType: 'application/octet-stream',
          content: Buffer.from('not a Skill archive').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    const onSkillImportAttachmentEligible = vi.fn()
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
      callbacks: { onSkillImportAttachmentEligible }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'import this Skill',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*ordinary-data\.zip[\s\S]*"skillImportEligible":false/
      )
    })
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*ordinary-data\.bin[\s\S]*"skillImportEligible":false/
      )
    })
    expect(receivedPrompts[0][3]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_skill_package>[\s\S]*example-package\.skill[\s\S]*"skillImportEligible":true[\s\S]*"skillImportTurnToken":"[0-9a-f-]{36}"/
      )
    })
    expect(receivedPrompts[0][4]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*renamed-garbage\.skill[\s\S]*"skillImportEligible":false/
      )
    })
    expect(onSkillImportAttachmentEligible).toHaveBeenCalledOnce()
    expect(onSkillImportAttachmentEligible).toHaveBeenCalledWith(
      session.sessionId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.stringMatching(/example-package\.skill$/)
    )
  })

  it('keeps Skill packages as ordinary archive references when conversation import is disabled', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
      files: [
        {
          name: 'example-package.skill',
          mimeType: 'application/octet-stream',
          content: buildStoredSkillArchive('Example Package').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    const onSkillImportAttachmentEligible = vi.fn()
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
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        isEnabled: async () => false,
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'secret' })
      },
      callbacks: { onSkillImportAttachmentEligible }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'inspect this archive',
      attachments: stagedAttachments
    })

    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*example-package\.skill[\s\S]*"skillImportEligible":false/
      )
    })
    expect(JSON.stringify(receivedPrompts[0])).not.toContain('skillImportTurnToken')
    expect(onSkillImportAttachmentEligible).not.toHaveBeenCalled()
  })

  it('inlines an image attachment as pixels when the browser sent no usable MIME type', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // Some drag/drop and paste sources omit the MIME (undefined) or send a generic octet-stream; the
    // runtime must still recognize these as images by extension and send real pixels, not a file link.
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
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
    const [attachment] = await stageUploadFixtures(uploadRepository, {
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
      stageUploadFixtures(uploadRepository, {
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

  it('keeps image bytes charged when later prompt content preparation fails', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
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
      inlineImageBudgetBytes: 15
    })
    const stageImage = (name: string): Promise<UploadedAttachment[]> =>
      stageUploadFixtures(uploadRepository, {
        files: [
          { name, mimeType: 'image/png', content: Buffer.from('png-bytes').toString('base64') }
        ]
      })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'first image then invalid reference',
        attachments: await stageImage('first.png'),
        referencedArtifacts: [
          {
            id: 'missing-artifact',
            name: 'missing.txt',
            path: '/not-configured/missing.txt',
            source: 'artifact',
            mimeType: 'text/plain'
          }
        ]
      })
    ).rejects.toThrow('File reference source is not configured: artifact')
    expect(receivedPrompts).toHaveLength(0)

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'second image',
      attachments: await stageImage('second.png')
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'resource_link',
      name: 'second.png',
      title: 'second.png',
      mimeType: 'image/png',
      uri: expect.stringContaining('second.png')
    })
    expect(JSON.stringify(receivedPrompts[0])).not.toContain(
      Buffer.from('png-bytes').toString('base64')
    )
  })

  it('registers every finalized prompt Upload Version with the trusted Notebook bridge', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const [historyUpload, currentUpload] = await stageUploadFixtures(uploadRepository, {
      files: [
        { name: 'history.csv', mimeType: 'text/csv', content: 'group\nA\n' },
        { name: 'current.csv', mimeType: 'text/csv', content: 'group\nB\n' }
      ]
    })
    const finalize = uploadRepository.finalizePendingSessionUploads.bind(uploadRepository)
    vi.spyOn(uploadRepository, 'finalizePendingSessionUploads').mockImplementation(
      async (...args) =>
        (await finalize(...args)).map((attachment, index) => ({
          ...attachment,
          versionId: `upload-version-${index + 1}`,
          versionNumber: 1,
          checksum: String(index + 1).repeat(64),
          createdAt: '2026-07-27T10:00:00.000Z'
        }))
    )
    const registerTurnInputs = vi.fn(async () => undefined)
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1/notebook', token: 'nb' }),
        registerTurnInputs
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'analyze groups',
      provenanceContext: { promptMessageId: 'message-user-1' },
      historyAttachments: [historyUpload],
      attachments: [currentUpload]
    })

    expect(registerTurnInputs).toHaveBeenCalledWith({
      projectId: 'default-project',
      appSessionId: 'remote-session-1',
      promptMessageId: 'message-user-1',
      uploads: [
        expect.objectContaining({ id: historyUpload.id, versionId: 'upload-version-1' }),
        expect.objectContaining({ id: currentUpload.id, versionId: 'upload-version-2' })
      ],
      references: []
    })
  })

  it('sends compute files as bounded local references without ACP file blocks', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // A >512 KB CSV: a unique marker after the preview window must never reach the prompt.
    const header = 'id,name,value\n'
    const filler = Array.from({ length: 60_000 }, (_, i) => `${i},row,${i}`).join('\n')
    const tailMarker = '\nSENTINEL_PAST_PREVIEW_WINDOW'
    const csvBody = `${header}${filler}${tailMarker}`
    expect(Buffer.byteLength(csvBody, 'utf8')).toBeGreaterThan(512 * 1024)
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
      files: [
        { name: 'big.csv', mimeType: 'text/csv', content: Buffer.from(csvBody).toString('base64') },
        {
          name: 'matrix.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          content: Buffer.from('workbook-bytes').toString('base64')
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
      text: 'analyze this table',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    const [prompt] = receivedPrompts
    // Order is preserved: user text, then the file's preview notice and local reference.
    expect(prompt[0]).toEqual({ type: 'text', text: 'analyze this table' })
    const notice = prompt[1] as Extract<ContentBlock, { type: 'text' }>
    expect(notice.type).toBe('text')
    expect(notice.text).toContain('big.csv')
    expect(notice.text).toContain('too large to include in full')
    expect(notice.text).toContain('id,name,value')
    expect(notice.text).toContain('<attached_local_file>')
    expect(notice.text).toContain('/uploads/default-project/remote-session-1/big.csv')
    const datasetNotice = prompt[2] as Extract<ContentBlock, { type: 'text' }>
    expect(datasetNotice.text).toContain('matrix.xlsx')
    expect(datasetNotice.text).toContain('<attached_local_file>')
    expect(prompt).toHaveLength(3)
    // ACP file/resource blocks can be eagerly hydrated downstream, so only bounded text ships.
    expect(prompt.some((block) => block.type === 'resource_link')).toBe(false)
    expect(prompt.some((block) => block.type === 'resource')).toBe(false)
    expect(JSON.stringify(prompt)).not.toContain('SENTINEL_PAST_PREVIEW_WINDOW')
  })

  it('does not send DOCX attachments as unsupported provider file parts', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const [document, historyPending] = await stageUploadFixtures(uploadRepository, {
      files: [
        {
          name: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: Buffer.from('document-bytes').toString('base64')
        },
        {
          name: 'history-report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: Buffer.from('history-document-bytes').toString('base64')
        }
      ]
    })
    const [historyDocument] = await uploadRepository.finalizePendingSessionUploads(
      'source-session',
      [historyPending]
    )
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
        const unsupportedDocument = prompt.find(
          (block) =>
            block.type === 'resource_link' &&
            block.mimeType ===
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
        if (unsupportedDocument) {
          throw new Error(
            "'file part media typeapplication/vnd.openxmlformats-officedocument.wordprocessingml.document' functionality not supported"
          )
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(
      runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'summarize this document',
        attachments: [document]
      })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    await expect(
      runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'summarize the earlier document',
        historyAttachments: [historyDocument]
      })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(receivedPrompts).toHaveLength(2)
    for (const prompt of receivedPrompts) {
      expect(prompt.some((block) => block.type === 'resource_link')).toBe(false)
      const descriptor = prompt.find(
        (block) => block.type === 'text' && block.text.includes('<attached_local_file>')
      )
      expect(descriptor).toMatchObject({ type: 'text' })
      if (descriptor?.type !== 'text') throw new Error('Expected a local file text descriptor.')
      expect(descriptor.text).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
      expect(descriptor.text).toContain('do not send the binary file directly to the model')
    }
  })

  it('adopts a fresh agent session under the same app id on a context reset', async () => {
    const root = await createTemporaryRoot()
    const connectorCall = vi.fn(async () => ({ ok: true }))
    const notebookService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const notebookRpcServer = new NotebookLocalRpcServer(notebookService, {
      transport: 'tcp',
      token: 'control-token',
      connectorService: { call: connectorCall }
    })
    temporaryDisconnections.push(() => notebookRpcServer.close())
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    // A second agent session id is available for the fresh adoption that the reset performs.
    const fakeAgent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: ({ sessionId, projectId }) =>
          notebookRpcServer.issueSessionConnection(sessionId, projectId, `root-frame-${sessionId}`),
        registerSessionAlias: (aliasSessionId, sessionId) =>
          notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
        releaseSessionCapabilities: (sessionId) =>
          notebookRpcServer.releaseSessionCapabilities(sessionId)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const initialNotebookServer = fakeAgent.newSessions[0]?.mcpServers[0]
    const initialEndpoint = getEnvValue(initialNotebookServer, 'OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT')
    const initialToken = getEnvValue(initialNotebookServer, 'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN')
    const reset = await runtime.resetSessionContext({
      sessionId: session.sessionId,
      cwd: '/workspace'
    })
    const replacementNotebookServer = fakeAgent.newSessions[1]?.mcpServers[0]
    const replacementToken = getEnvValue(
      replacementNotebookServer,
      'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN'
    )

    // The app-facing id stays attached (a brand-new agent session now backs it), and the caller is told
    // to replay a transcript because the agent-side context was dropped.
    expect(reset.contextReset).toBe(true)
    expect(reset.sessionId).toBe(session.sessionId)
    expect(runtime.getSnapshot().sessionIds).toContain(session.sessionId)

    // The fresh session still accepts prompts, so the conversation continues after the reset.
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue after compaction' })
    expect(receivedPrompts.at(-1)).toBeDefined()

    const callConnector = (token: string): Promise<Response> =>
      fetch(initialEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'mcpCall',
          params: { server: 'pubmed', method: 'search', args: {} }
        })
      })

    expect(replacementToken).not.toBe(initialToken)
    await expect(callConnector(initialToken)).resolves.toMatchObject({ status: 401 })
    await expect(callConnector(replacementToken)).resolves.toMatchObject({ status: 200 })
    expect(connectorCall).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'releases each Notebook capability generation exactly once across context reset and delete (replacement release: %s)',
    async (replacementProvidesRelease) => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
      const capabilityReleases: Array<ReturnType<typeof vi.fn> | undefined> = []
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => {
            const release =
              capabilityReleases.length === 0 || replacementProvidesRelease ? vi.fn() : undefined
            capabilityReleases.push(release)
            return {
              endpoint: 'http://127.0.0.1:4567',
              token: `notebook-token-${capabilityReleases.length}`,
              ...(release ? { release } : {})
            }
          }
        }
      })

      try {
        const session = await runtime.createSession({ cwd: '/workspace' })
        expect(capabilityReleases).toHaveLength(1)
        expect(capabilityReleases[0]).toBeDefined()
        expect(capabilityReleases[0]).not.toHaveBeenCalled()

        await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
        expect(capabilityReleases).toHaveLength(2)
        expect(capabilityReleases[0]).toHaveBeenCalledOnce()
        if (replacementProvidesRelease) {
          expect(capabilityReleases[1]).not.toHaveBeenCalled()
        } else {
          expect(capabilityReleases[1]).toBeUndefined()
        }

        await runtime.deleteSession({ sessionId: session.sessionId })
        expect(capabilityReleases[0]).toHaveBeenCalledOnce()
        if (replacementProvidesRelease) {
          expect(capabilityReleases[1]).toHaveBeenCalledOnce()
        }
      } finally {
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('uses the framework native command to compact without adding command output to chat events', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const resetPromptContent = vi.spyOn(promptContentLifecycle(runtime), 'resetSession')
    contextUsageMap(runtime).set(session.sessionId, { used: 180_000, size: 200_000 })
    expect(runtime.getSnapshot().nativeContextCompactionSessionIds).toEqual([session.sessionId])
    await runtime.compactSession({ sessionId: session.sessionId })

    expect(agent.prompts).toEqual([{ sessionId: 'remote-session-1', text: '/compact' }])
    expect(resetPromptContent).toHaveBeenCalledOnce()
    expect(resetPromptContent).toHaveBeenCalledWith(session.sessionId)
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})
    expect(
      runtime
        .getSnapshot()
        .events.filter((event) => event.kind === 'message' || event.kind === 'thought')
    ).toEqual([])
  })

  it.each([
    ['Claude Code', claudeCodeFramework, 'claude-anthropic', 'claude-code:provider-a'],
    ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
    ['Codex Responses', codexFramework, 'codex-responses', 'codex:provider-a'],
    ['Codex Bridge', codexFramework, 'codex-bridge', 'codex:provider-a']
  ] as const)(
    'accepts a zero usage update from the %s native compaction turn',
    async (_name, framework, modelRoute, backendId) => {
      const process = new FakeAgentProcess()
      const agent = startFakeAgent(process, ['remote-session-1'], {
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {}),
        usageForPrompt: (text) => {
          if (text.includes('establish positive usage')) return { used: 120_000, size: 200_000 }
          if (text === '/compact') return { used: 0, size: 200_000 }
          return undefined
        }
      })
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        })
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'establish positive usage' })
      expect(runtime.getSnapshot().contextUsageBySession[session.sessionId]).toMatchObject({
        used: 120_000,
        size: 200_000
      })

      await runtime.compactSession({ sessionId: session.sessionId })

      expect(agent.prompts.at(-1)).toEqual({ sessionId: 'remote-session-1', text: '/compact' })
      expect(runtime.getSnapshot().contextUsageBySession[session.sessionId]).toMatchObject({
        used: 0,
        size: 200_000
      })
    }
  )

  it('keeps compaction successful when a hidden usage update state callback throws', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      usageForPrompt: (text) => (text === '/compact' ? { used: 24_000, size: 200_000 } : undefined)
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      callbacks: {
        onStateChanged: (snapshot) => {
          if (Object.values(snapshot.contextUsageBySession).some(({ used }) => used === 24_000)) {
            throw new Error('state listener failed')
          }
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(runtime.compactSession({ sessionId: session.sessionId })).resolves.toEqual({
      stopReason: 'end_turn'
    })

    expect(runtime.getSnapshot().contextUsageBySession[session.sessionId]).toMatchObject({
      used: 24_000,
      size: 200_000
    })
    expect(
      runtime
        .getSnapshot()
        .events.filter((event) => event.kind === 'compaction')
        .map(({ status }) => status)
    ).toEqual(['in_progress', 'completed'])
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
  })

  it('serializes prompts and compaction per session without blocking another session', async () => {
    const process = new FakeAgentProcess()
    const firstPromptGate = createDeferred<PromptResponse>()
    const secondCompactionGate = createDeferred<PromptResponse>()
    const agent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'], {
      onPrompt: ({ sessionId, text }) => {
        if (sessionId === 'remote-session-1' && text === 'first prompt') {
          return firstPromptGate.promise
        }
        if (sessionId === 'remote-session-2' && text === '/compact') {
          return secondCompactionGate.promise
        }
        return undefined
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })
    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })

    // Claim compaction first to retain the public snapshot's historical grouping: prompt sessions
    // precede compaction sessions regardless of the cross-kind claim order.
    const compacting = runtime.compactSession({ sessionId: second.sessionId })
    await vi.waitFor(() =>
      expect(agent.prompts).toContainEqual({ sessionId: 'remote-session-2', text: '/compact' })
    )
    await expect(
      runtime.setPermissionProfile({ sessionId: second.sessionId, profile: 'full' })
    ).rejects.toThrow(/compacting/)
    const promptAfterCompaction = runtime.sendPrompt({
      sessionId: second.sessionId,
      text: 'prompt after compaction'
    })
    await vi.waitFor(() => expect(agent.cancelledSessions).toContain('remote-session-2'))
    expect(agent.prompts).not.toContainEqual({
      sessionId: 'remote-session-2',
      text: 'prompt after compaction'
    })

    const prompting = runtime.sendPrompt({ sessionId: first.sessionId, text: 'first prompt' })
    await vi.waitFor(() =>
      expect(agent.prompts).toContainEqual({
        sessionId: 'remote-session-1',
        text: 'first prompt'
      })
    )
    await expect(runtime.compactSession({ sessionId: first.sessionId })).rejects.toThrow(
      /already running/
    )
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([
      first.sessionId,
      second.sessionId
    ])
    expect(runtime.getSnapshot().agentPromptInFlightSessionIds).toEqual([first.sessionId])

    firstPromptGate.resolve({ stopReason: 'end_turn' })
    secondCompactionGate.resolve({ stopReason: 'end_turn' })
    await expect(Promise.all([prompting, compacting, promptAfterCompaction])).resolves.toHaveLength(
      3
    )
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(runtime.getSnapshot().agentPromptInFlightSessionIds).toEqual([])
  })

  it('reactivates the target CodeBuddy session before compacting in a shared process', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['codebuddy-session-1', 'codebuddy-session-2'], {
      supportsResume: true
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codeBuddyFramework
    })
    const first = await runtime.createSession({ cwd: '/workspace/first' })
    await runtime.createSession({ cwd: '/workspace/second' })

    await runtime.compactSession({ sessionId: first.sessionId })

    expect(agent.resumedSessions.at(-1)).toMatchObject({
      sessionId: 'codebuddy-session-1',
      cwd: resolve('/workspace/first')
    })
    expect(agent.prompts.at(-1)).toEqual({
      sessionId: 'codebuddy-session-1',
      text: '/compact'
    })
  })

  it('serializes CodeBuddy compaction behind a prompt in another session', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred<PromptResponse>()
    const agent = startFakeAgent(process, ['codebuddy-session-1', 'codebuddy-session-2'], {
      supportsResume: true,
      onPrompt: ({ sessionId, text }) =>
        sessionId === 'codebuddy-session-1' && text.endsWith('long prompt')
          ? promptGate.promise
          : undefined
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codeBuddyFramework
    })
    const first = await runtime.createSession({ cwd: '/workspace/first' })
    const second = await runtime.createSession({ cwd: '/workspace/second' })

    const prompting = runtime.sendPrompt({ sessionId: first.sessionId, text: 'long prompt' })
    await vi.waitFor(() =>
      expect(
        agent.prompts.some(
          ({ sessionId, text }) =>
            sessionId === 'codebuddy-session-1' && text.endsWith('long prompt')
        )
      ).toBe(true)
    )
    const compacting = runtime.compactSession({ sessionId: second.sessionId })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(agent.prompts).not.toContainEqual({
      sessionId: 'codebuddy-session-2',
      text: '/compact'
    })

    promptGate.resolve({ stopReason: 'end_turn' })
    await expect(prompting).resolves.toEqual({ stopReason: 'end_turn' })
    await expect(compacting).resolves.toEqual({ stopReason: 'end_turn' })
    expect(agent.prompts.at(-1)).toEqual({
      sessionId: 'codebuddy-session-2',
      text: '/compact'
    })
  })

  it('drops estimated pre-compaction categories when no fresh usage update arrives', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'discarded history before compaction'
    })
    handleSessionUpdate(runtime, {
      sessionId: session.sessionId,
      update: { sessionUpdate: 'usage_update', used: 180_000, size: 200_000 }
    })
    expect(
      runtime.getSnapshot().contextUsageBySession[session.sessionId]?.breakdown?.categories
    ).toContainEqual(expect.objectContaining({ key: 'messages' }))

    await runtime.compactSession({ sessionId: session.sessionId })
    handleSessionUpdate(runtime, {
      sessionId: session.sessionId,
      update: { sessionUpdate: 'usage_update', used: 10, size: 200_000 }
    })

    expect(
      runtime.getSnapshot().contextUsageBySession[session.sessionId]?.breakdown?.categories
    ).not.toContainEqual(expect.objectContaining({ key: 'messages' }))
  })

  it('settles a cancelled native command without reporting compaction failure', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ text }) =>
        text === '/compact' ? { stopReason: 'cancelled' as const } : undefined
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const resetPromptContent = vi.spyOn(promptContentLifecycle(runtime), 'resetSession')

    await expect(runtime.compactSession({ sessionId: session.sessionId })).resolves.toMatchObject({
      stopReason: 'cancelled'
    })

    expect(resetPromptContent).not.toHaveBeenCalled()
    expect(
      runtime
        .getSnapshot()
        .events.filter((event) => event.kind === 'compaction')
        .map(({ status, title, text }) => ({ status, title, text }))
    ).toEqual([
      { status: 'in_progress', title: 'Compacting context', text: undefined },
      {
        status: 'cancelled',
        title: 'Context compaction cancelled',
        text: undefined
      }
    ])
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
  })

  it('preserves the image budget when the adapter reports native compaction failure as output', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      replyForPrompt: (text) =>
        text === '/compact' ? '\n\nCompacting failed: media_unstrippable' : 'reply'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const resetPromptContent = vi.spyOn(promptContentLifecycle(runtime), 'resetSession')

    await expect(runtime.compactSession({ sessionId: session.sessionId })).rejects.toThrow(
      'Compacting failed: media_unstrippable'
    )

    expect(resetPromptContent).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().events).toContainEqual(
      expect.objectContaining({
        kind: 'compaction',
        status: 'failed',
        text: 'Compacting failed: media_unstrippable'
      })
    )
  })

  it('keeps overflow-recovery compaction locked while the failed prompt finishes unwinding', async () => {
    const root = await createTemporaryRoot()
    const repository = new ArtifactRepository(root)
    const releaseFailedCleanup = createDeferred()
    vi.spyOn(repository, 'listPendingRunFiles').mockImplementation(async () => {
      await releaseFailedCleanup.promise
      return []
    })
    const process = new FakeAgentProcess()
    const compactTurn = createDeferred<PromptResponse>()
    const retryTurn = createDeferred<PromptResponse>()
    const overflowObserved = createDeferred()
    let cancelTimer:
      | {
          active: boolean
          fire: () => void
        }
      | undefined
    const agent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ text }) => {
        if (text === '/compact') return compactTurn.promise
        if (text === 'retry after overflow') return retryTurn.promise
        throw acp.RequestError.internalError({ errorKind: 'request_too_large' }, 'Internal error')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      cancelTimeoutMs: 5,
      setTimer: (callback) => {
        const timer = {
          active: true,
          fire: (): void => {
            if (timer.active) callback()
          }
        }
        cancelTimer = timer
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (handle) => {
        const timer = handle as unknown as { active: boolean }
        timer.active = false
      },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'error' && event.recoverable === 'context-overflow') {
            overflowObserved.resolve()
          }
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const failedPrompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'oversized prompt'
    })
    void failedPrompt.catch(() => undefined)
    await overflowObserved.promise

    await expect(runtime.compactSession({ sessionId: session.sessionId })).rejects.toThrow(
      /already running/
    )
    const compacting = runtime.compactSession({
      sessionId: session.sessionId,
      reason: 'overflow-recovery'
    })
    await vi.waitFor(() => expect(agent.prompts.at(-1)?.text).toBe('/compact'))

    // Ownership moved away from the failed prompt, but native compaction still keeps the session
    // unavailable to another user turn until the framework control turn stops.
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])
    await runtime.cancelPrompt({ sessionId: session.sessionId })
    expect(agent.cancelledSessions).toEqual([session.sessionId])

    compactTurn.resolve({ stopReason: 'end_turn' })
    await compacting
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(cancelTimer?.active).toBe(false)
    const retry = runtime.sendPrompt({ sessionId: session.sessionId, text: 'retry after overflow' })
    await vi.waitFor(() => expect(agent.prompts.at(-1)?.text).toBe('retry after overflow'))

    cancelTimer?.fire()
    expect(runtime.getSnapshot().status).toBe('connected')

    // The failed prompt can finish cleanup only after the retry owns the same stable App Session.
    // Its stale finally must not clear the replacement interaction.
    releaseFailedCleanup.resolve()
    await expect(failedPrompt).rejects.toThrow()
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])

    retryTurn.resolve({ stopReason: 'end_turn' })
    await expect(retry).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('automatically invokes native compaction after a turn reaches the framework threshold', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1'], {
      usageForPrompt: (text) =>
        text === '/compact' ? { used: 24_000, size: 200_000 } : { used: 180_000, size: 200_000 }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'analyze the results' })

    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2))
    expect(agent.prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'analyze the results' },
      { sessionId: 'remote-session-1', text: '/compact' }
    ])
    expect(runtime.getSnapshot().contextUsageBySession[session.sessionId]).toMatchObject({
      used: 24_000,
      size: 200_000
    })
  })

  it('exposes manual compaction without duplicating framework-owned automatic compaction', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1'], {
      usageForPrompt: () => ({ used: 180_000, size: 200_000 })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: {
        ...claudeCodeFramework,
        contextCompaction: { kind: 'native-command', command: '/compact' }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'analyze the results' })

    expect(agent.prompts).toEqual([{ sessionId: 'remote-session-1', text: 'analyze the results' }])

    await runtime.compactSession({ sessionId: session.sessionId })
    expect(agent.prompts.at(-1)).toEqual({ sessionId: 'remote-session-1', text: '/compact' })
  })

  it('keeps the native compaction control command exact when a durable Plan is unfinished', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })
    const projection = {
      artifactId: 'artifact-1',
      artifactVersionId: 'version-2',
      artifactChecksum: 'a'.repeat(64),
      revision: 7,
      approval: 'approved',
      lifecycle: 'blocked',
      requiresExplicitContinuation: true,
      document: {
        schema_version: 1,
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Main Agent',
                steps: [{ title: 'Analyze', description: 'Analyze the data.' }]
              }
            ]
          }
        ],
        desired_outputs: ['Result'],
        feasibility: { confidence: 'high', rationale: 'Ready.' }
      },
      stepStatuses: { Analyze: { status: 'blocked', updatedAt: 42, notes: 'Input missing' } },
      stepStates: { Analyze: { status: 'blocked', notes: 'Input missing' } },
      counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
    } satisfies ActivePlanProjection
    installPromptPlanTestWorkflow(runtime, {
      getProjection: vi.fn(async () => projection)
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.compactSession({ sessionId: session.sessionId })

    expect(agent.prompts.at(-1)?.text).toBe('/compact')
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

  it('drops stale permission tool context when resetting the provider session', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    observePermissionToolContext(runtime, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'reused-call-id',
        title: 'open-science-notebook_notebook_execute',
        kind: 'other',
        status: 'pending',
        rawInput: { language: 'python', code: 'print(1)' }
      }
    })
    expect(opencodeMcpToolInputsMap(runtime).has(session.sessionId)).toBe(true)

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })

    expect(opencodeMcpToolInputsMap(runtime).has(session.sessionId)).toBe(false)
  })

  it('does not carry OpenCode input across an explicit tool title change', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    observePermissionToolContext(runtime, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'retitled-call',
        title: 'open-science-notebook_notebook_status',
        kind: 'other',
        status: 'pending',
        rawInput: { language: 'python', code: 'print(1)' }
      }
    })
    observePermissionToolContext(runtime, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'retitled-call',
        title: 'open-science-notebook_notebook_execute',
        status: 'in_progress',
        rawInput: {}
      }
    })

    expect(opencodeMcpToolInputsMap(runtime).get(session.sessionId)?.get('retitled-call')).toEqual({
      title: 'open-science-notebook_notebook_execute',
      providerToolName: 'open-science-notebook_notebook_execute',
      mcpIdentity: 'open-science-notebook/notebook_execute'
    })
  })

  it('accepts a reused OpenCode tool call id after resetting provider context', async () => {
    const process = new FakeAgentProcess()
    const sessionIds = ['opencode-before-reset', 'opencode-after-reset']
    const permissionRequests: AcpPermissionRequest[] = []
    const permissionResponses: acp.RequestPermissionResponse[] = []
    let promptIndex = 0

    acp
      .agent({ name: 'opencode-reset-reused-call-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: sessionIds.shift()! }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const toolCallId = 'reused-after-reset'
        if (promptIndex++ === 0) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: 'open_science_notebook_notebook_execute',
              kind: 'other',
              status: 'pending',
              rawInput: { language: 'python', code: 'print(1)' }
            }
          })
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'completed'
            }
          })
          return { stopReason: 'end_turn' }
        }

        const pendingPermission = ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId,
            title: 'open_science_notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
          ]
        })
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open_science_notebook_notebook_execute',
            kind: 'other',
            status: 'in_progress',
            rawInput: { language: 'r', code: 'print(2)' }
          }
        })
        permissionResponses.push(await pendingPermission)
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
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          const sessionOptionId = request.options.find(
            (option) => option.scope === 'session'
          )?.optionId
          if (!sessionOptionId) throw new Error('Missing conversation permission option')
          runtime.respondToPermission({ requestId: request.requestId, optionId: sessionOptionId })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run before reset' })
    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run after reset' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].rawInput).toEqual({ language: 'r', code: 'print(2)' })
    expect(permissionResponses).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }])
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

  it('does not dispatch a superseded prompt after its preparation finishes', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const namesGate = createDeferred<string[]>()
    const namesForIds = vi.fn(() => namesGate.promise)
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      skills: {
        needForceLoad: vi.fn(async () => []),
        namesForIds
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const stalePrompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'stale turn',
      forcedSkillIds: ['research']
    })
    await vi.waitFor(() => expect(namesForIds).toHaveBeenCalledTimes(1))

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
    namesGate.resolve(['research'])
    await expect(stalePrompt).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(agent.prompts).toHaveLength(0)

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'replacement turn' })
    expect(agent.prompts).toHaveLength(1)
    expect(agent.prompts[0]?.text).toContain('replacement turn')
  })

  it('does not dispatch after reset wins during an asynchronous provider probe', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const probeStarted = createDeferred()
    const releaseProbe = createDeferred()
    let usageFetchCount = 0
    const opencodeUsageFetch = vi.fn(async () => {
      usageFetchCount += 1
      if (usageFetchCount === 1) {
        probeStarted.resolve()
        await releaseProbe.promise
      }
      return new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework,
        executablePath: '/bin/opencode',
        env: {},
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic test'
        }
      }),
      framework,
      opencodeUsageFetch
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const stalePrompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'stale turn' })
    await probeStarted.promise

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
    releaseProbe.resolve()
    await expect(stalePrompt).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(agent.prompts).toHaveLength(0)
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
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    // The lock is claimed synchronously at turn start, so no polling is needed to observe it.
    const failedTurn = runtime
      .sendPrompt({
        sessionId: session.sessionId,
        text: 'oversized turn',
        provenanceContext: { promptMessageId: 'old-prompt-message' }
      })
      .catch(() => undefined)
    expect(runtime.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

    // Reset abandons the failed turn (its finally now blocks on the gated listPendingRunFiles — before it
    // reaches its own lock cleanup) and frees the lock so the replay can start.
    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
    expect(runtime.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)

    // The replay turn re-claims the lock for the same app session id while the abandoned turn's finally is
    // still parked in listPendingRunFiles.
    const replayTurn = runtime
      .sendPrompt({
        sessionId: session.sessionId,
        text: 'replayed turn',
        provenanceContext: { promptMessageId: 'replacement-prompt-message' }
      })
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
    expect(
      events
        .filter((event) => event.kind === 'error' || event.kind === 'stop')
        .map((event) => ({
          kind: event.kind,
          promptMessageId: event.promptMessageId
        }))
    ).toEqual([{ kind: 'stop', promptMessageId: 'replacement-prompt-message' }])
  })

  it('sends PDFs as extracted text, never as an inlined base64 file', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // Non-PDF bytes make extraction fail deterministically; the block must still be text, not the file.
    const stagedAttachments = await stageUploadFixtures(uploadRepository, {
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
  })

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
        projectId: 'default-project',
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

  it('publishes app-side artifact writes as durable Provenance Versions', async () => {
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => promptGate.promise
    })
    const version = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      createdAt: '2026-07-28T00:00:00.000Z',
      projectId: 'project-1',
      sessionId: 'remote-session-1',
      runId: 'artifact-run-1',
      name: 'aspirin.mol',
      path: join(root, 'immutable-content'),
      fileUrl: 'file:///immutable-content',
      mimeType: 'chemical/x-mdl-molfile',
      size: 3,
      mtimeMs: 1
    }
    const versions: (typeof version)[] = []
    const provenance = {
      writeAppGeneratedVersion: vi.fn(async () => {
        versions.push(version)
        return version
      }),
      listRunVersions: vi.fn(async () => versions)
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/unused',
        repository: artifactRepository,
        provenance
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'preview aspirin' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    const artifact = await runtime.writeArtifactForCurrentRun(session.sessionId, {
      filename: 'aspirin.mol',
      content: 'mol',
      mimeType: 'chemical/x-mdl-molfile',
      producer: {
        kind: 'connector',
        connectorId: 'molecule',
        toolId: 'preview_molecule',
        invocationId: 'connector-call-1',
        implementationVersion: '1',
        normalizedArguments: { filename: 'aspirin.mol' }
      }
    })

    expect(artifact).toMatchObject({ id: 'version-1', versionId: 'version-1' })
    expect(provenance.writeAppGeneratedVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        producer: expect.objectContaining({
          kind: 'connector',
          connectorId: 'molecule',
          invocationId: 'connector-call-1'
        })
      })
    )
    promptGate.resolve()
    await prompt
    expect(runtime.getSnapshot().events).toContainEqual(
      expect.objectContaining({
        kind: 'artifact',
        artifacts: [expect.objectContaining({ versionId: 'version-1' })]
      })
    )
  })

  it('appends referenced artifacts as content blocks by file type', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const artifactRepository = new ArtifactRepository(root)

    // A referenced upload (an already-staged file) resolves through the upload path validator.
    const [uploadRef] = await stageUploadFixtures(uploadRepository, {
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
      projectId: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'chart.png',
      mimeType: 'image/png',
      source: createPngInlineSource('runtime referenced image')
    })

    // A referenced binary output has no rich representation, so it falls through to a resource link.
    const binaryArtifact = await artifactRepository.writePendingFile({
      projectId: 'default-project',
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

    // An artifact-backed Skill package is not owned by the upload-only import tool, so the prompt
    // must retain it as an ordinary resource instead of advertising an unusable import URI.
    const skillArtifact = await artifactRepository.writePendingFile({
      projectId: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'generated.skill',
      mimeType: 'application/octet-stream',
      source: {
        kind: 'inline',
        content: Buffer.from('skill-archive-bytes').toString('base64'),
        encoding: 'base64'
      }
    })
    const managedFiles = new Map<
      string,
      {
        source: 'artifact' | 'upload'
        path: string
        name: string
        mimeType?: string
      }
    >([
      [
        uploadRef.id,
        {
          source: 'upload',
          path: uploadRef.path,
          name: uploadRef.originalName,
          mimeType: uploadRef.mimeType
        }
      ],
      [
        imageArtifact.id,
        {
          source: 'artifact',
          path: imageArtifact.path,
          name: imageArtifact.name,
          mimeType: imageArtifact.mimeType
        }
      ],
      [
        binaryArtifact.id,
        {
          source: 'artifact',
          path: binaryArtifact.path,
          name: binaryArtifact.name,
          mimeType: binaryArtifact.mimeType
        }
      ],
      [
        skillArtifact.id,
        {
          source: 'artifact',
          path: skillArtifact.path,
          name: skillArtifact.name,
          mimeType: skillArtifact.mimeType
        }
      ]
    ])
    const openLatest = vi.fn(
      async ({
        source,
        projectId,
        fileId
      }: {
        source: 'artifact' | 'upload'
        projectId: string
        fileId: string
      }) => {
        const file = managedFiles.get(fileId)
        if (!file) throw new Error(`Missing managed fixture: ${fileId}`)
        return createManagedReadLease({
          source,
          projectId,
          sessionId: 'remote-session-1',
          fileId,
          path: file.path,
          name: file.name,
          mimeType: file.mimeType
        })
      }
    )

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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository,
        managedFileVersions: { openLatest } as never
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
          sourceFileId: uploadRef.id,
          mimeType: uploadRef.mimeType
        },
        {
          id: 'a1',
          name: imageArtifact.name,
          path: imageArtifact.path,
          source: 'artifact',
          sourceFileId: imageArtifact.id,
          mimeType: imageArtifact.mimeType
        },
        {
          id: 'a2',
          name: binaryArtifact.name,
          path: binaryArtifact.path,
          source: 'artifact',
          sourceFileId: binaryArtifact.id,
          mimeType: binaryArtifact.mimeType
        },
        {
          id: 'a3',
          name: skillArtifact.name,
          path: skillArtifact.path,
          source: 'artifact',
          sourceFileId: skillArtifact.id,
          mimeType: skillArtifact.mimeType
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
        uri: expect.stringMatching(/^file:.*\.txt$/u)
      }
    })
    // Referenced image artifact -> base64 image block.
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: createPngBytes('runtime referenced image').toString('base64'),
      uri: expect.stringMatching(/^file:.*\.png$/u)
    })
    // Referenced binary artifact -> provider-neutral local file descriptor.
    expect(receivedPrompts[0][3]).toMatchObject({ type: 'text' })
    const binaryDescriptor = receivedPrompts[0][3]
    if (binaryDescriptor.type !== 'text') throw new Error('Expected a local file text descriptor.')
    expect(binaryDescriptor.text).toContain('data.bin')
    expect(binaryDescriptor.text).toContain('application/octet-stream')
    expect(binaryDescriptor.text).toContain('<attached_local_file>')
    expect(binaryDescriptor.text).toContain('do not send the binary file directly to the model')
    // Artifact-backed Skill package -> provider-safe ordinary archive reference, never the
    // current-session import wrapper.
    expect(receivedPrompts[0][4]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*generated\.skill[\s\S]*"skillImportEligible":false/
      )
    })
  })

  it('resolves a version-backed artifact mention before sending the prompt', async () => {
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    const immutablePath = join(root, 'provenance', 'artifact-version-1', 'content')
    await mkdir(join(root, 'provenance', 'artifact-version-1'), { recursive: true })
    await writeFile(immutablePath, 'version-backed artifact')

    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const openLatest = vi.fn(async () => ({
      path: immutablePath,
      size: Buffer.byteLength('version-backed artifact'),
      read: vi.fn(async () => Buffer.from('version-backed artifact')),
      readRange: vi.fn(async (offset: number, length: number) =>
        Buffer.from('version-backed artifact').subarray(offset, offset + length)
      ),
      copyTo: vi.fn(async (destinationPath: string) =>
        writeFile(destinationPath, 'version-backed artifact', { flag: 'wx' })
      ),
      verifyUnchanged: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      logicalFile: {
        source: 'artifact' as const,
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'source-session',
        displayName: 'report.txt',
        currentVersionId: 'artifact-version-2'
      },
      version: {
        id: 'artifact-version-2',
        fileId: 'artifact-1',
        versionNumber: 2,
        state: 'finalized' as const,
        originKind: 'user_edit' as const,
        basedOnVersionId: 'artifact-version-1',
        storageTag: 'vabc12345',
        storedFilename: 'vabc12345_report.txt',
        writeOperationId: 'operation-2',
        contentStorageKey: 'opaque:artifact-version-2',
        filename: 'report.txt',
        contentType: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength('version-backed artifact')),
        checksum: '2'.repeat(64),
        createdAt: new Date('2026-08-24T00:00:00.000Z')
      },
      versionToken: 2,
      snapshot: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n }
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/unused',
        repository: artifactRepository,
        provenance: {
          listRunVersions: vi.fn(async () => []),
          writeAppGeneratedVersion: vi.fn()
        },
        managedFileVersions: { openLatest } as never
      }
    })

    const session = await runtime.createSession({
      cwd: '/workspace',
      projectId: 'project-1'
    })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'inspect this artifact',
      referencedArtifacts: [
        {
          id: 'artifact-version-1',
          name: 'report.txt',
          path: createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'source-session',
            artifactId: 'artifact-1',
            versionId: 'artifact-version-1'
          }),
          source: 'artifact',
          mimeType: 'text/plain'
        }
      ]
    })

    expect(openLatest).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        text: 'version-backed artifact',
        uri: expect.stringMatching(/^file:.*\.txt$/)
      }
    })
  })

  it('advertises only current-session upload references to the Skill importer', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const currentSkillArchive = buildStoredSkillArchive('Current Skill')
    const staged = await stageUploadFixtures(uploadRepository, {
      files: [
        {
          name: 'current.skill',
          mimeType: 'application/octet-stream',
          content: currentSkillArchive.toString('base64')
        },
        {
          name: 'other.skill',
          mimeType: 'application/octet-stream',
          content: Buffer.from('other skill bytes').toString('base64')
        }
      ]
    })
    const [currentSessionUpload] = await uploadRepository.finalizePendingSessionUploads(
      'remote-session-1',
      [staged[0]]
    )
    const [otherSessionUpload] = await uploadRepository.finalizePendingSessionUploads(
      'remote-session-2',
      [staged[1]]
    )
    const skillUploads = new Map([
      [currentSessionUpload.id, currentSessionUpload],
      [otherSessionUpload.id, otherSessionUpload]
    ])
    const openLatest = vi.fn(
      async ({ projectId, fileId }: { projectId: string; fileId: string }) => {
        const attachment = skillUploads.get(fileId)
        if (!attachment) throw new Error(`Missing managed fixture: ${fileId}`)
        return createManagedReadLease({
          source: 'upload',
          projectId,
          sessionId: attachment.sessionId,
          fileId,
          path: attachment.path,
          name: attachment.originalName,
          mimeType: attachment.mimeType
        })
      }
    )

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
        projectId: 'default-project',
        mcpEntryPath: '/unused',
        managedFileVersions: { openLatest } as never
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const resolvedCurrentUpload = await uploadRepository.resolveSessionUploadPath(
      session.sessionId,
      { path: currentSessionUpload.path }
    )
    expect(resolvedCurrentUpload.endsWith(join('remote-session-1', 'current.skill'))).toBe(true)
    await expect(
      uploadRepository.resolveSessionUploadPath(session.sessionId, {
        path: otherSessionUpload.path
      })
    ).rejects.toThrow(/different (?:project or )?session/)
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'compare these packages',
      referencedArtifacts: [
        {
          id: 'current',
          name: currentSessionUpload.originalName,
          path: currentSessionUpload.path,
          source: 'upload',
          sourceFileId: currentSessionUpload.id,
          mimeType: currentSessionUpload.mimeType
        },
        {
          id: 'other',
          name: otherSessionUpload.originalName,
          path: otherSessionUpload.path,
          source: 'upload',
          sourceFileId: otherSessionUpload.id,
          mimeType: otherSessionUpload.mimeType
        }
      ]
    })

    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_skill_package>[\s\S]*current\.skill[\s\S]*"skillImportTurnToken":"[0-9a-f-]{36}"/
      )
    })
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /<attached_local_archive>[\s\S]*other\.skill[\s\S]*"skillImportEligible":false/
      )
    })
  })

  it('imports a managed current-turn Skill attachment through its advertised Version locator', async () => {
    const root = await realpath(await createTemporaryRoot())
    const legacyUploads = new UploadRepository(root)
    const archive = buildStoredSkillArchive('Paper Finder')
    const [staged] = await stageUploadFixtures(legacyUploads, {
      files: [
        {
          name: 'paper-finder.skill',
          mimeType: 'application/zip',
          content: archive.toString('base64')
        }
      ]
    })
    const [attachment] = await legacyUploads.finalizePendingSessionUploads('current-session', [
      staged
    ])
    const managedContentPath = join(root, 'managed-paper-finder.skill')
    await writeFile(managedContentPath, archive)
    const openLatest = vi.fn(({ projectId, fileId }: { projectId: string; fileId: string }) =>
      createManagedReadLease({
        source: 'upload',
        projectId,
        sessionId: 'current-session',
        fileId,
        path: managedContentPath,
        name: attachment.originalName,
        mimeType: attachment.mimeType
      })
    )
    let importLease: Awaited<ReturnType<typeof createManagedReadLease>> | undefined
    const openVersion = vi.fn(
      async ({ projectId, fileId }: { projectId: string; fileId: string }, versionId: string) => {
        if (versionId !== `version-${fileId}`)
          throw new Error('Unexpected managed Version fixture.')
        importLease = await createManagedReadLease({
          source: 'upload',
          projectId,
          sessionId: 'current-session',
          fileId,
          path: managedContentPath,
          name: attachment.originalName,
          mimeType: attachment.mimeType
        })
        return importLease
      }
    )
    const client = createProjectDbClient(root)
    temporaryDisconnections.push(() => client.$disconnect())
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'current-session' }
    })
    const uploads = new UploadRepository(root, {
      getClient: () => Promise.resolve(client)
    })
    const approvalBroker = new SkillImportApprovalBroker({
      generateId: () => 'approval-1',
      broadcast: vi.fn()
    })
    const importer = new ConversationSkillImporter({
      uploads,
      managedFileVersions: { openVersion } as never,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        approvalBroker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle: async () => ({
        previews: [
          {
            subPath: 'paper-finder',
            name: 'Paper Finder',
            description: 'Finds papers.',
            metadata: {},
            body: 'Follow the workflow.',
            files: ['SKILL.md'],
            alreadyImported: false
          }
        ],
        skipped: []
      }),
      importBundle: async (_bundle, items) =>
        items.map((item) => ({
          subPath: item.subPath,
          outcome: { status: 'imported' as const, id: 'imported-paper-finder' }
        })),
      requestApproval: async (request) => ({
        id: 'approval-1',
        items: [{ subPath: request.previews[0].subPath }]
      })
    })
    let importResult: Awaited<ReturnType<ConversationSkillImporter['request']>> | undefined
    let activeTurnToken: string | undefined
    let advertisedAttachmentUri: string | undefined
    let promptError: unknown
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['current-session'], {
      onPrompt: async ({ prompt }) => {
        try {
          if (!activeTurnToken) throw new Error('Expected an active Skill import turn token.')
          const reference = prompt.find(
            (block) => block.type === 'text' && block.text.includes('<attached_skill_package>')
          )
          if (reference?.type !== 'text') {
            throw new Error('Expected an import-eligible Skill package reference.')
          }
          advertisedAttachmentUri = (JSON.parse(reference.text.split('\n')[1]) as { uri: string })
            .uri
          importResult = await importer.request({
            sessionId: 'current-session',
            turnToken: activeTurnToken,
            attachmentUri: advertisedAttachmentUri
          })
        } catch (error) {
          promptError = error
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploads },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'project-1',
        mcpEntryPath: '/unused',
        managedFileVersions: { openLatest } as never
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        authorizeReferencedUploads: (projectId, sessionId, paths) =>
          importer.authorizeReferencedUploads(projectId, sessionId, paths)
      },
      callbacks: {
        onPromptStarted: (sessionId, turnToken) => {
          activeTurnToken = turnToken
          approvalBroker.beginSessionTurn(sessionId, turnToken)
        },
        onPromptEnded: (sessionId, turnToken) =>
          approvalBroker.endSessionTurn(sessionId, turnToken),
        onSkillImportAttachmentEligible: (sessionId, turnToken, attachmentUri) =>
          approvalBroker.allowSessionTurnAttachment(sessionId, turnToken, attachmentUri)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'import the attached Paper Finder Skill',
      attachments: [attachment]
    })

    expect(promptError).toBeUndefined()
    expect(importResult).toEqual({
      status: 'imported',
      skills: [{ id: 'imported-paper-finder', name: 'Paper Finder', status: 'imported' }]
    })
    if (!advertisedAttachmentUri) throw new Error('Expected an advertised Skill attachment URI.')
    expect(openVersion).toHaveBeenCalledWith(
      { source: 'upload', projectId: 'project-1', fileId: attachment.id },
      `version-${attachment.id}`
    )
    expect(importLease?.close).toHaveBeenCalledOnce()
    approvalBroker.beginSessionTurn(session.sessionId, 'retry-turn')
    approvalBroker.allowSessionTurnAttachment(
      session.sessionId,
      'retry-turn',
      advertisedAttachmentUri
    )
    await expect(
      importer.request({
        sessionId: session.sessionId,
        turnToken: 'retry-turn',
        attachmentUri: advertisedAttachmentUri
      })
    ).rejects.toThrow(/not authorized/)
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
    const sourcePng = createPngBytes('runtime notebook image')
    await writeFile(join(notebookDataDir, 'sine.png'), sourcePng)

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
              projectId: 'default-project',
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
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
    await expect(readFile(writtenPath as string)).resolves.toEqual(sourcePng)
  })

  it('writes a run-scoped Artifact RPC capability into the handoff and revokes it after the turn', async () => {
    const root = await createTemporaryRoot()
    const artifactRepository = new ArtifactRepository(root)
    const issuedBindings: unknown[] = []
    const revokedTokens: string[] = []
    let capturedContext: Record<string, unknown> | undefined
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async () => {
        const projectDir = join(root, 'artifacts', 'default-project')
        const [artifactSessionId] = await readdir(projectDir)
        const currentRunFile = join(projectDir, artifactSessionId, '.pending', 'current-run.json')
        capturedContext = JSON.parse(await readFile(currentRunFile, 'utf8')) as Record<
          string,
          unknown
        >
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository,
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'global' }),
        issueRpcCapability: (binding) => {
          issuedBindings.push(binding)
          return 'run-capability-1'
        },
        revokeRpcCapability: (token) => {
          revokedTokens.push(token)
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'plot a sine wave',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1'
      }
    })

    expect(capturedContext).toMatchObject({
      artifactRunId: expect.stringMatching(/^artifact-run-/u),
      appSessionId: session.sessionId,
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-user-1',
      rpcCapabilityToken: 'run-capability-1'
    })
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        projectId: 'default-project',
        appSessionId: session.sessionId,
        artifactRunId: capturedContext?.artifactRunId,
        rootFrameId: 'root-frame-1',
        allowedMethods: [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      })
    ])
    expect(revokedTokens).toEqual(['run-capability-1'])
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
        projectId: 'default-project',
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
    expect(fakeAgent.prompts[0].text).toContain('producerRunId')
    expect(fakeAgent.prompts[0].text).toContain('Only claim a generated file is available after')
    expect(fakeAgent.prompts[0].text).not.toContain('Pass only the filename')
    expect(fakeAgent.prompts[0].text).not.toContain('<open_science_skill_privacy_instructions>')
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
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer bridge-token' }
        }
      }),
      framework: codexFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
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
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer bridge-token' }
        }
      }),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
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
      '<open_science_notebook_instructions>\nGuidance only applies when using open-science-notebook tools.'
    )
    expect(fakeAgent.prompts[0].text).toContain('`ask_user_question`')
    expect(fakeAgent.prompts[0].text).toContain('app-owned `ask_user_question`')
    expect(fakeAgent.prompts[0].text).not.toContain('<open_science_artifact_instructions>')
  })

  it('gives native Codex the blocking choice tool without relying on Plan mode', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-native-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Ask me to choose' })

    expect(
      fakeAgent.newSessions[0].mcpServers.map((server) => (server as { name: string }).name)
    ).toEqual(['open-science-notebook'])
    expect(fakeAgent.prompts[0].text).toContain('`ask_user_question`')
    expect(fakeAgent.prompts[0].text).toContain('app-owned `ask_user_question`')
  })

  it('does not tell Codex to skip the native SKILL.md read required for progressive loading', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Search PubMed' })

    expect(fakeAgent.prompts[0].text).toContain('Search PubMed')
    expect(fakeAgent.prompts[0].text).not.toContain('<open_science_skill_privacy_instructions>')
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

  it('delivers resolved connector guidance to Claude session metadata on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], { supportsResume: true })
    const connectorInstructions =
      'Load the matching `mcp-*` skill before using a connector, then call host.mcp(...).'
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        systemPromptAppends: [connectorInstructions]
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({ sessionId: 'remote-session-2', cwd: '/workspace' })

    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: { append: expect.stringContaining(connectorInstructions) }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: { append: expect.stringContaining(connectorInstructions) }
    })
  })

  it('preloads a routed CodeBuddy PubMed Skill before Notebook execution', async () => {
    const events: AcpRuntimeEvent[] = []
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codebuddy-session-1'], { supportsResume: true })
    const runtimeRoot = join(await createTemporaryRoot(), 'codebuddy', 'skill-runtime')
    const pubmedPath = join(runtimeRoot, '.claude', 'skills', 'mcp-pubmed', 'SKILL.md')
    await mkdir(join(runtimeRoot, '.claude', 'skills', 'mcp-pubmed'), { recursive: true })
    await writeFile(
      pubmedPath,
      '---\nname: mcp-pubmed\ndescription: Search PubMed literature.\nsource: connector\n---\n\nPUBMED_RUNTIME_ROUTE_SENTINEL\n'
    )
    const pubmed = {
      name: 'mcp-pubmed',
      description: 'Search PubMed literature.',
      path: pubmedPath,
      source: 'connector' as const
    }
    const selectSkills = vi.fn(async () => [pubmed])
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:4567',
      token: 'session-token'
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codeBuddyFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codebuddy',
        env: {},
        persistentSystemPrompt:
          'Load `mcp-pubmed`, then call host.mcp("pubmed", "search_articles", args).',
        providerTransportLease: {
          setTarget: () => false,
          selectSkills,
          release: async () => undefined
        },
        sessionOptions: {
          [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
            command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
            entryPath: '/app/out/main/index.js',
            root: runtimeRoot
          }
        }
      }),
      notebook: {
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science',
        getRpcConnection
      },
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        descriptorsForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [pubmed]
      },
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const created = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await runtime.sendPrompt({
      sessionId: created.sessionId,
      text: 'Find recent peer-reviewed papers on immune checkpoint resistance.'
    })
    await runtime.resumeSession({ sessionId: 'codebuddy-session-2', cwd: '/workspace' })

    for (const servers of [
      fakeAgent.newSessions[0].mcpServers,
      fakeAgent.resumedSessions[1].mcpServers
    ]) {
      expect(servers.map((server) => (server as { name: string }).name)).toEqual([
        'open-science-notebook'
      ])
    }
    const routedServers = fakeAgent.resumedSessions[0].mcpServers
    expect(routedServers.map((server) => (server as { name: string }).name)).toEqual([
      'open-science-notebook'
    ])
    expect(selectSkills).toHaveBeenCalledOnce()
    expect(fakeAgent.prompts[0].text).toContain('already loaded by Open Science')
    expect(fakeAgent.prompts[0].text).toContain('PUBMED_RUNTIME_ROUTE_SENTINEL')
    expect(fakeAgent.prompts[0].text).not.toContain(
      'Before any Notebook or Connector call, call `mcp__skills__load_skill`'
    )
    expect(fakeAgent.prompts[0].text).toContain('Do not use Notebook `host.skills`')
    expect(fakeAgent.prompts[0].text).not.toContain('Use the following skill(s)')
    const skillEvents = events.filter((event) => event.providerToolName === 'skill')
    expect(skillEvents.map(({ title, status }) => ({ title, status }))).toEqual([
      { title: 'Loaded skill: mcp-pubmed', status: 'in_progress' },
      { title: 'Loaded skill: mcp-pubmed', status: 'completed' }
    ])
    expect(JSON.stringify(skillEvents)).not.toContain(pubmedPath)
    expect(JSON.stringify(skillEvents)).not.toContain('PUBMED_RUNTIME_ROUTE_SENTINEL')
    expect(fakeAgent.resumedSessions.map((session) => session.sessionId)).toEqual([
      'codebuddy-session-1',
      'codebuddy-session-2'
    ])
    expect(getRpcConnection).toHaveBeenCalledTimes(2)
  })

  it('projects CodeBuddy inline thinking separately from visible assistant content', async () => {
    const events: AcpRuntimeEvent[] = []
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['codebuddy-session-1'], {
      replyForPrompt: () => '<think>private analysis</think>Visible answer.'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codeBuddyFramework,
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: created.sessionId, text: 'Summarize the result.' })

    const generated = events.filter(
      (event) =>
        event.kind === 'thought' || (event.kind === 'message' && event.role === 'assistant')
    )
    expect(generated).toMatchObject([
      { kind: 'thought', text: 'private analysis', raw: undefined },
      { kind: 'message', text: 'Visible answer.', raw: undefined }
    ])
    expect(
      generated
        .filter((event) => event.kind === 'message')
        .map((event) => event.text)
        .join('')
    ).not.toContain('private analysis')
  })

  it('retains CodeBuddy Plan arguments supplied by the permission request', async () => {
    const process = new FakeAgentProcess()
    const toolCallId = 'codebuddy-plan-call'
    const permissionRequests: AcpPermissionRequest[] = []
    const planInput = {
      task_summary: 'Prepare a research package',
      phases: [
        {
          name: 'Research',
          delegations: [
            {
              name: 'Evidence',
              steps: [{ title: 'Review sources', description: 'Assess the available evidence.' }]
            }
          ]
        }
      ],
      desired_outputs: ['Research package'],
      feasibility: { confidence: 'high', rationale: 'The required sources are available.' }
    }
    startPermissionProbeAgent(process, {
      newSessionId: 'codebuddy-plan-session',
      toolCallId,
      toolTitle: 'open-science-plan/generate_plan',
      toolKind: 'other',
      permissionRawInput: planInput,
      providerToolName: 'open-science-plan/generate_plan',
      announceToolCall: true,
      announcedProviderToolName: 'open-science-plan/generate_plan'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codeBuddyFramework,
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          void runtime.respondToPermission({
            requestId: request.requestId,
            optionId: request.options[0]?.optionId
          })
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Create a plan.' })

    expect(permissionRequests).toContainEqual(expect.objectContaining({ rawInput: planInput }))
    expect(runtime.getSnapshot().events).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolCallId, rawInput: planInput })
    )
  })

  it('fails the CodeBuddy turn closed when Skill discovery is unavailable', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codebuddy-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codeBuddyFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codebuddy',
        env: {},
        providerTransportLease: {
          setTarget: () => false,
          selectSkills: async () => {
            throw new Error('Skill selection failed (missing-function-call).')
          },
          release: async () => undefined
        }
      }),
      skills: {
        needForceLoad: async () => [],
        namesForIds: async () => [],
        descriptorsForIds: async () => [],
        catalogForCodeBuddyRoot: async () => [
          {
            name: 'literature-review',
            description: 'Search and review literature.',
            path: '/skills/literature-review/SKILL.md'
          }
        ]
      }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    await expect(
      runtime.sendPrompt({ sessionId: created.sessionId, text: 'find recent cancer papers' })
    ).rejects.toThrow('CodeBuddy Skill routing failed (selector-error).')
    expect(fakeAgent.prompts).toHaveLength(0)
  })

  it('keeps backend-persistent Codex guidance out while adding current turn scope', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['codex-session'], {
      modes: {
        currentModeId: 'agent',
        availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
      }
    })
    const persistentInstructions = 'Stable Codex developer instructions.'
    let resolvedContext: { forcedSkillIds: string[]; systemPromptAppends?: string[] } | undefined
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: (context) => {
        resolvedContext = context
        return {
          framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/codex-acp',
          env: {},
          persistentSystemPrompt: persistentInstructions
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'search PubMed' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'summarize the results' })

    expect(resolvedContext?.systemPromptAppends).toEqual(
      expect.arrayContaining([expect.stringContaining('open_science_large_file_instructions')])
    )
    expect(fakeAgent.prompts.map(({ text }) => text)).toEqual([
      expect.stringMatching(/Current agent: Main Agent\.[\s\S]+search PubMed$/),
      expect.stringMatching(/Current agent: Main Agent\.[\s\S]+summarize the results$/)
    ])
    expect(fakeAgent.prompts.every(({ text }) => !text.includes(persistentInstructions))).toBe(true)
  })

  it('forwards resolved Claude session options on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], { supportsResume: true })
    const sessionOptions = {
      settings: { apiKeyHelper: '/app/claude/api-key-helper' },
      plugins: [{ type: 'local', path: '/app/claude' }]
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
      claudeCode: {
        options: {
          plugins: [{ type: 'local', path: '/app/claude' }],
          settingSources: ['user'],
          settings: {
            apiKeyHelper: '/app/claude/api-key-helper',
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
          }
        }
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      claudeCode: {
        options: {
          plugins: [{ type: 'local', path: '/app/claude' }],
          settingSources: ['user'],
          settings: {
            apiKeyHelper: '/app/claude/api-key-helper',
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
          }
        }
      }
    })
  })

  it('keeps backend-persistent OpenCode guidance out while adding current turn scope', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    let resolvedContext: { forcedSkillIds: string[]; systemPromptAppends?: string[] } | undefined
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: (context) => {
        resolvedContext = context
        return {
          framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/opencode',
          env: {},
          persistentSystemPrompt: 'Stable OpenCode instructions.'
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello opencode' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue' })

    expect(fakeAgent.newSessions[0]._meta).toBeUndefined()
    expect(resolvedContext?.systemPromptAppends).toEqual(
      expect.arrayContaining([expect.stringContaining('open_science_large_file_instructions')])
    )
    expect(fakeAgent.prompts.map(({ text }) => text)).toEqual([
      expect.stringMatching(/Current agent: Main Agent\.[\s\S]+hello opencode$/),
      expect.stringMatching(/Current agent: Main Agent\.[\s\S]+continue$/)
    ])
    expect(
      fakeAgent.prompts.every(({ text }) => !text.includes('Stable OpenCode instructions.'))
    ).toBe(true)
  })

  it('waits for session-scoped MCP capability readiness before creating the agent session', async () => {
    const httpHost = {
      ensureStarted: vi.fn(async () => ({
        endpoint: 'http://127.0.0.1:4321',
        token: 'host-token'
      })),
      registerNotebook: vi.fn(),
      urlFor: vi.fn(
        (kind: string, routingId: string) =>
          `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
      ),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['http-session'])
    const capabilityRequested = createDeferred()
    const capabilityReady = createDeferred<{ endpoint: string; token: string }>()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      mcpHttpHost: httpHost,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => {
          capabilityRequested.resolve()
          return capabilityReady.promise
        }
      }
    })

    try {
      const creating = runtime.createSession({ cwd: '/workspace' })
      await capabilityRequested.promise

      // The backend must not observe a session whose advertised Notebook MCP endpoint/token is not
      // ready yet. This ordering is part of the runtime composition contract, not an HTTP-host detail.
      expect(fakeAgent.newSessions).toEqual([])

      capabilityReady.resolve({ endpoint: 'http://127.0.0.1:4567', token: 'notebook-token' })
      await expect(creating).resolves.toMatchObject({ sessionId: 'http-session' })
      expect(fakeAgent.newSessions).toHaveLength(1)
      expect(fakeAgent.newSessions[0].mcpServers).toEqual([
        expect.objectContaining({
          type: 'http',
          name: 'open_science_notebook',
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/notebook\//)
        })
      ])
    } finally {
      capabilityReady.resolve({ endpoint: 'http://127.0.0.1:4567', token: 'notebook-token' })
      await runtime.disconnect()
    }
  })

  it('serves app MCP tools over the http host for an http-only framework', async () => {
    const root = await createTemporaryRoot()
    const httpHost = new AgentMcpHttpHost()
    const closeHttpHost = vi.spyOn(httpHost, 'close')
    const unregisterHttpSession = vi.spyOn(httpHost, 'unregister')
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1/notebook', token: 'nb' })
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1/skill-import',
          token: 'skill'
        })
      }
    })

    try {
      const session = await runtime.createSession({ cwd: '/workspace' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'install this skill' })

      const servers = fakeAgent.newSessions[0].mcpServers as Array<{
        type?: string
        name?: string
        url?: string
        headers?: Array<{ name: string; value: string }>
      }>

      // opencode gets http MCP configs (not stdio) pointing at the local host, with bearer auth.
      expect(servers.map((server) => server.type)).toEqual(['http', 'http', 'http'])
      expect(servers.map((server) => server.name)).toEqual(
        expect.arrayContaining([
          'open_science_artifacts',
          'open_science_notebook',
          'open_science_skills'
        ])
      )
      const artifactServer = servers.find((server) => server.name === 'open_science_artifacts')
      expect(artifactServer?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/artifact\//)
      expect(artifactServer?.headers?.[0]).toMatchObject({ name: 'authorization' })
      const skillImportServer = servers.find((server) => server.name === 'open_science_skills')
      expect(skillImportServer?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/skill-import\//)
      expect(fakeAgent.prompts[0].text).toContain('request_skill_import')

      const skillImportRoutingId = decodeURIComponent(
        new URL(skillImportServer?.url ?? '').pathname.split('/').at(-1) ?? ''
      )
      await runtime.deleteSession({ sessionId: session.sessionId })
      expect(unregisterHttpSession).toHaveBeenCalledWith(skillImportRoutingId)

      await runtime.requestRetirement()
      expect(closeHttpHost).toHaveBeenCalledOnce()
    } finally {
      await httpHost.close()
    }
  })

  it('cleans provisional http MCP routes when fresh adoption collides', async () => {
    const root = await createTemporaryRoot()
    const httpHost = {
      ensureStarted: vi.fn(async () => ({
        endpoint: 'http://127.0.0.1:4321',
        token: 'host-token'
      })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn(
        (kind: string, routingId: string) =>
          `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
      ),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const process = new FakeAgentProcess()
    const reviewerModeStarted = createDeferred()
    const releaseReviewerMode = createDeferred()
    const fakeAgent = startFakeAgent(
      process,
      ['reserved-provider-session', 'reserved-provider-session'],
      {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        onSetMode: async () => {
          reviewerModeStarted.resolve()
          await releaseReviewerMode.promise
        }
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...codexFramework,
          acceptsStdioMcp: false,
          spawn: () => asAgentProcess(process)
        },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      mcpHttpHost: httpHost,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4568',
          token: 'skill'
        })
      }
    })
    const reviewer = runtime.buildReviewerSession({
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
    await reviewerModeStarted.promise

    try {
      await expect(
        runtime.resumeSession({ sessionId: 'stable-app-session', cwd: '/workspace' })
      ).rejects.toThrow(
        'Primary session id collision with pending reviewer: reserved-provider-session'
      )
      expect(fakeAgent.newSessions).toHaveLength(2)
      expect(httpHost.registerArtifact).toHaveBeenCalledWith(
        'stable-app-session',
        expect.any(Object)
      )
      expect(httpHost.registerNotebook).toHaveBeenCalledWith(
        'stable-app-session',
        expect.any(Object)
      )
      expect(httpHost.registerSkillImport).toHaveBeenCalledWith(
        'stable-app-session',
        expect.any(Object)
      )
      expect(httpHost.unregister).toHaveBeenCalledOnce()
      expect(httpHost.unregister).toHaveBeenCalledWith('stable-app-session')
    } finally {
      releaseReviewerMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('cleans partial provisional routes without replacing the startup error', async () => {
    const root = await createTemporaryRoot()
    const startupFailure = new Error('notebook capability setup failed')
    let unregisterAttempt = 0
    const unregister = vi.fn((routingId: string) => {
      void routingId
      unregisterAttempt += 1
      if (unregisterAttempt === 1) {
        throw new Error('first provisional route cleanup failed')
      }
    })
    const httpHost = {
      ensureStarted: vi.fn(async () => ({
        endpoint: 'http://127.0.0.1:4321',
        token: 'host-token'
      })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn(
        (kind: string, routingId: string) =>
          `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
      ),
      unregister,
      clear: vi.fn(),
      close: vi.fn(async () => undefined)
    } as unknown as AgentMcpHttpHost
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      mcpHttpHost: httpHost,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => {
          throw startupFailure
        }
      },
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4568',
          token: 'skill'
        })
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(startupFailure)

    expect(httpHost.registerArtifact).toHaveBeenCalledOnce()
    expect(httpHost.registerNotebook).not.toHaveBeenCalled()
    expect(httpHost.registerSkillImport).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledTimes(3)
    expect(new Set(unregister.mock.calls.map(([routingId]) => routingId)).size).toBe(3)
  })

  it.each(['notebook alias', 'skill alias', 'specialist registration', 'event', 'state'] as const)(
    'keeps published http MCP ownership when the %s callback throws',
    async (failingCallback) => {
      const httpHost = {
        ensureStarted: vi.fn(async () => ({
          endpoint: 'http://127.0.0.1:4321',
          token: 'host-token'
        })),
        registerNotebook: vi.fn(),
        registerSkillImport: vi.fn(),
        urlFor: vi.fn(
          (kind: string, routingId: string) =>
            `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn(async () => undefined)
      } as unknown as AgentMcpHttpHost
      const release = vi.fn()
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['published-session'])
      let observerFailurePending = true
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework: { ...opencodeFramework, acceptsStdioMcp: false },
        mcpHttpHost: httpHost,
        callbacks: {
          onEvent: (event) => {
            if (
              observerFailurePending &&
              failingCallback === 'event' &&
              event.sessionId === 'published-session'
            ) {
              observerFailurePending = false
              throw new Error('event callback failed')
            }
          },
          onStateChanged: (snapshot) => {
            if (
              observerFailurePending &&
              failingCallback === 'state' &&
              snapshot.sessionIds.includes('published-session')
            ) {
              observerFailurePending = false
              throw new Error('state callback failed')
            }
          }
        },
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({
            endpoint: 'http://127.0.0.1:4567',
            token: 'notebook-token',
            release
          }),
          registerSessionAlias: () => {
            if (failingCallback === 'notebook alias') {
              throw new Error('notebook alias callback failed')
            }
          },
          registerSessionSpecialist: () => {
            if (failingCallback === 'specialist registration') {
              throw new Error('specialist registration callback failed')
            }
          }
        },
        skillImport: {
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({
            endpoint: 'http://127.0.0.1:4568',
            token: 'skill-import-token'
          }),
          registerSessionAlias: () => {
            if (failingCallback === 'skill alias') {
              throw new Error('skill alias callback failed')
            }
          }
        }
      })

      try {
        await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toMatchObject({
          sessionId: 'published-session'
        })
        expect(runtime.getSnapshot().sessionIds).toEqual(['published-session'])
        expect(httpHost.unregister).not.toHaveBeenCalled()
        expect(release).not.toHaveBeenCalled()

        await runtime.sendPrompt({ sessionId: 'published-session', text: 'still usable' })
        expect(fakeAgent.prompts.at(-1)).toMatchObject({
          sessionId: 'published-session',
          text: expect.stringContaining('still usable')
        })

        await runtime.deleteSession({ sessionId: 'published-session' })
        expect(release).toHaveBeenCalledOnce()
      } finally {
        if (runtime.getSnapshot().sessionIds.includes('published-session')) {
          await runtime.deleteSession({ sessionId: 'published-session' }).catch(() => undefined)
        }
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

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
      {
        sessionId: 'remote-session-1',
        providerSessionId: 'remote-session-1',
        cwd: resolve('/workspace'),
        frameworkId: 'claude-code'
      },
      {
        sessionId: 'remote-session-2',
        providerSessionId: 'remote-session-2',
        cwd: resolve('/workspace'),
        frameworkId: 'claude-code'
      }
    ])
    expect(spawnCount).toBe(1)
    expect(runtime.getSnapshot().sessionIds).toEqual(['remote-session-1', 'remote-session-2'])
  })

  it('does not reuse a superseded connection while its replacement connect is starting', async () => {
    const oldProcess = new FakeAgentProcess()
    const replacementProcess = new FakeAgentProcess()
    const oldAgent = startFakeAgent(oldProcess, ['old-session', 'wrong-old-session'])
    const replacementAgent = startFakeAgent(replacementProcess, ['replacement-session'])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(spawnCount++ === 0 ? oldProcess : replacementProcess)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const reconnect = runtime.connect({ cwd: '/workspace' })
    const successor = runtime.createSession({ cwd: '/workspace' })
    const [, session] = await Promise.all([reconnect, successor])

    expect(session.sessionId).toBe('replacement-session')
    expect(oldAgent.newSessions).toHaveLength(1)
    expect(replacementAgent.newSessions).toHaveLength(1)
    expect(spawnCount).toBe(2)
  })

  it('releases a spawned resource superseded immediately before owner attach', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const { lease, release } = createBackendLeaseHarness()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: lease
      })
    })
    const internal = runtime as unknown as { connectionAdapter: AcpAgentConnectionAdapter }
    const openConnection = internal.connectionAdapter.open.bind(internal.connectionAdapter)
    let disconnect: Promise<unknown> | undefined
    vi.spyOn(internal.connectionAdapter, 'open').mockImplementation(async (input, hooks) => {
      const candidate = await openConnection(input, hooks)
      disconnect = runtime.disconnect()
      return candidate
    })

    await expect(runtime.connect({ cwd: '/workspace' })).rejects.toThrow(/superseded/i)
    await disconnect

    expect(process.killed).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    expect(runtime.getSnapshot().sessionIds).toEqual([])
    expect(
      infoLogSpy.mock.calls.find(([message]) => message === 'agent process exit')?.[1]
    ).toMatchObject({ expected: true })
  })

  it('drops the process candidate immediately after transfer to the resource owner', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const internal = runtime as unknown as { connectionAdapter: AcpAgentConnectionAdapter }
    const openCandidate = internal.connectionAdapter.open.bind(internal.connectionAdapter)
    const candidateDispose = vi.fn(async () => undefined)
    vi.spyOn(internal.connectionAdapter, 'open').mockImplementation(async (input, hooks) => {
      const candidate = await openCandidate(input, hooks)
      return Object.freeze({
        transferTo: candidate.transferTo,
        dispose: candidateDispose
      })
    })

    await runtime.connect({ cwd: '/workspace' })
    await runtime.disconnect()

    expect(candidateDispose).not.toHaveBeenCalled()
    expect(process.killed).toBe(true)
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
      providerSessionId: 'remote-session-2',
      cwd: resolve('/second-workspace'),
      frameworkId: 'claude-code'
    })
    expect(spawnCount).toBe(2)
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionIds: ['remote-session-2']
    })
  })

  it('does not commit connected after an initialized-event callback disconnects', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['reentrant-disconnect-session'])
    const statuses: string[] = []
    let disconnect: Promise<unknown> | undefined
    const callbacks: { disconnectRuntime?: () => Promise<unknown> } = {}
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          if (event.title === 'Agent initialized') disconnect = callbacks.disconnectRuntime?.()
        },
        onStateChanged: (snapshot) => statuses.push(snapshot.status)
      }
    })
    callbacks.disconnectRuntime = () => runtime.disconnect()

    await expect(runtime.connect({ cwd: '/workspace' })).rejects.toThrow(
      'ACP connection was superseded.'
    )
    expect(disconnect).toBeDefined()
    await disconnect

    expect(runtime.getSnapshot()).toMatchObject({ status: 'closed', sessionIds: [] })
    expect(statuses.at(-1)).toBe('closed')
    expect(statuses).not.toContain('connected')
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

  it('keeps a durable permission wait active for Session safety but excludes it from quit warnings', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = createDeferred<AcpPermissionRequest>()
    startPermissionProbeAgent(process, {
      newSessionId: 'durable-permission-session',
      toolCallId: 'durable-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions'])
    })
    let runtimeContext: SessionRuntimeContext = { version: 1, revision: 0 }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionSeen.resolve(request) },
      permissionWait: {
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(runtimeContext)),
          patchSessionRuntimeContext: vi.fn(
            async (command: {
              patch: { permission?: SessionRuntimeContext['permission'] }
              expectedRevision: number
            }) => {
              expect(command.expectedRevision).toBe(runtimeContext.revision)
              runtimeContext = {
                ...runtimeContext,
                ...command.patch,
                revision: runtimeContext.revision + 1
              }
              return structuredClone(runtimeContext)
            }
          ),
          containsMessageOnActiveBranch: vi.fn(async () => true),
          loadSessionForContinuation: vi.fn(async () => {
            throw new Error('Unexpected permission replay load')
          })
        }
      }
    })
    const session = await runtime.createSession({
      cwd: '/workspace',
      projectId: 'project-1',
      permissionProfile: 'ask'
    })
    const prompting = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'run a command',
      provenanceContext: { promptMessageId: 'prompt-1' }
    })
    const permission = await permissionSeen.promise

    expect(permission.durable).toBe(true)
    expect(runtime.getActivePromptSessions()).toEqual([
      { projectId: 'project-1', sessionId: session.sessionId }
    ])
    expect(runtime.getQuitBlockingPromptSessions()).toEqual([])

    await runtime.respondToPermission({ requestId: permission.requestId, cancelled: true })
    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('changes permission profile while a prompt is waiting and releases the eligible request', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = createDeferred<AcpPermissionRequest>()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionSeen.resolve(request) }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    const prompting = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    await permissionSeen.promise
    const snapshot = await runtime.setPermissionProfile({
      sessionId: session.sessionId,
      profile: 'full'
    })

    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(snapshot.pendingPermissions).toEqual([])
    expect(snapshot.permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId: 'bypassPermissions'
    })
  })

  it('enforces a requested downgrade while the provider mode change is in flight', async () => {
    const process = new FakeAgentProcess()
    const askModeEntered = createDeferred()
    const releaseAskMode = createDeferred()
    const permissionSeen = createDeferred<AcpPermissionRequest>()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onSetMode: async ({ modeId, notifyCurrentMode }) => {
        if (modeId === 'default') {
          await notifyCurrentMode('bypassPermissions')
          askModeEntered.resolve()
          await releaseAskMode.promise
        }
      },
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionSeen.resolve(request) }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })

    const selectingAsk = runtime.setPermissionProfile({
      sessionId: session.sessionId,
      profile: 'ask'
    })
    await askModeEntered.promise
    const prompting = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    const permission = await permissionSeen.promise

    expect(permissionResponse).toBeUndefined()
    releaseAskMode.resolve()
    await expect(selectingAsk).resolves.toBeDefined()
    runtime.respondToPermission({ requestId: permission.requestId, cancelled: true })
    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('restores the committed profile when the provider mode change fails', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = vi.fn()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onSetMode: ({ modeId }) => {
        if (modeId === 'default') throw new Error('set mode failed')
      },
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: permissionSeen }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })

    await expect(
      runtime.setPermissionProfile({ sessionId: session.sessionId, profile: 'ask' })
    ).rejects.toMatchObject({ data: { details: 'set mode failed' } })
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(permissionSeen).not.toHaveBeenCalled()
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full'
    })
  })

  it('uses the committed profile after replacing the provider session', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = vi.fn()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: permissionSeen }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.setPermissionProfile({ sessionId: session.sessionId, profile: 'full' })

    await runtime.resetSessionContext({
      sessionId: session.sessionId,
      cwd: '/workspace',
      permissionProfile: 'full'
    })
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(permissionSeen).not.toHaveBeenCalled()
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it('refreshes the live profile when resuming an attached session', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = createDeferred<AcpPermissionRequest>()
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionSeen.resolve(request) }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    await runtime.setPermissionProfile({ sessionId: session.sessionId, profile: 'full' })

    await runtime.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      permissionProfile: 'ask'
    })
    const prompting = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    const permission = await permissionSeen.promise

    expect(permissionResponse).toBeUndefined()
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'ask',
      effectiveProfile: 'ask'
    })
    runtime.respondToPermission({ requestId: permission.requestId, cancelled: true })
    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('lets the latest overlapping profile change commit without releasing pending permission', async () => {
    const process = new FakeAgentProcess()
    const permissionSeen = createDeferred<AcpPermissionRequest>()
    const fullModeEntered = createDeferred()
    const releaseFullMode = createDeferred()
    const modeChanges: string[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'live-permission-session',
      toolCallId: 'live-permission-tool',
      toolTitle: 'Run command',
      modes: createModes(['default', 'bypassPermissions']),
      onSetMode: async ({ modeId }) => {
        modeChanges.push(modeId)
        if (modeId === 'bypassPermissions') {
          fullModeEntered.resolve()
          await releaseFullMode.promise
        }
      },
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionSeen.resolve(request) }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    const prompting = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a command' })
    const permission = await permissionSeen.promise

    const selectingFull = runtime.setPermissionProfile({
      sessionId: session.sessionId,
      profile: 'full'
    })
    await fullModeEntered.promise
    const selectingAsk = runtime.setPermissionProfile({
      sessionId: session.sessionId,
      profile: 'ask'
    })
    releaseFullMode.resolve()

    await expect(selectingFull).resolves.toBeDefined()
    const snapshot = await selectingAsk
    expect(modeChanges).toEqual(['bypassPermissions', 'default'])
    expect(permissionResponse).toBeUndefined()
    expect(snapshot.pendingPermissions).toHaveLength(1)
    expect(snapshot.permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId: 'default'
    })

    runtime.respondToPermission({ requestId: permission.requestId, cancelled: true })
    await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('audits OpenCode MCP calls with canonical identities without logging raw tool titles', async () => {
    infoLogSpy.mockClear()
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
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
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: 'remote-session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-mcp',
            title: 'open_science_artifacts_write_artifact_file',
            kind: 'other',
            status: 'pending',
            rawInput: { filename: 'result.md', content: '# Result' }
          }
        })
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: 'remote-session-1',
          toolCall: {
            toolCallId: 'tool-mcp',
            title: 'open_science_artifacts_write_artifact_file',
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
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: 'remote-session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-failed',
            title: 'open_science_artifacts_write_artifact_file',
            kind: 'other',
            status: 'failed',
            _meta: { toolName: 'open_science_artifacts_write_artifact_file' }
          }
        })
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: 'remote-session-1',
          toolCall: {
            toolCallId: 'tool-error',
            title: 'open_science_artifacts_delete_artifact',
            kind: 'other',
            status: 'pending',
            _meta: { toolName: 'open_science_artifacts_delete_artifact' }
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
      framework: opencodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          if (request.title === 'open_science_artifacts_delete_artifact') {
            throw new Error('permission callback failed')
          }
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'allow-once' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'trigger permission audit' })
    ).rejects.toThrow('Internal error')

    const auditCalls = infoLogSpy.mock.calls.filter(
      ([message]) => message === 'permission request received'
    )
    expect(auditCalls).toHaveLength(3)

    const dataFor = (toolCallId: string): Record<string, unknown> =>
      auditCalls.find(
        ([, data]) => (data as { toolCallId?: string }).toolCallId === toolCallId
      )?.[1] as Record<string, unknown>

    // OpenCode's model-facing identity is classified as MCP but logged with the canonical identity.
    expect(dataFor('tool-mcp').isMcp).toBe(true)
    expect(dataFor('tool-mcp').tool).toBe('open-science-artifacts/write_artifact_file')
    expect(dataFor('tool-fetch').isMcp).toBe(false)

    const failureAudit = warnLogSpy.mock.calls.find(([message]) => message === 'tool call failed')
    expect(failureAudit?.[1]).toMatchObject({
      tool: 'open-science-artifacts/write_artifact_file',
      toolCallId: 'tool-failed'
    })

    const errorAudit = errorLogSpy.mock.calls.find(
      ([message]) => message === 'permission request failed'
    )
    expect(errorAudit?.[1]).toMatchObject({
      tool: 'open-science-artifacts/delete_artifact',
      toolCallId: 'tool-error'
    })

    // No audit payload may carry the raw model-facing title or WebFetch URL.
    for (const [, data] of [
      ...auditCalls,
      ...(failureAudit ? [failureAudit] : []),
      ...(errorAudit ? [errorAudit] : [])
    ]) {
      const serialized = JSON.stringify(data)
      expect(serialized).not.toContain('example.com')
      expect(serialized).not.toContain('open_science_artifacts_write_artifact_file')
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
      options: Array<{ optionId: string; scope?: string }>
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          const sessionOptionId = request.options.find(
            (option) => option.scope === 'session'
          )?.optionId
          if (!sessionOptionId) throw new Error('Missing Open Science session permission option')
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId: sessionOptionId
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
      options: [
        { optionId: 'allow_once', scope: 'once' },
        { optionId: 'decline' },
        { scope: 'session' }
      ]
    })
    expect(permissionResponses).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    ])
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        kind: 'mcp',
        label: 'Notebook REPL (Python)',
        scope: 'session'
      }
    ])
  })

  it('silently allows OpenCode native skill loading without publishing a permission request', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'opencode-skill-session',
      toolCallId: 'opencode-skill-call',
      toolTitle: 'skill',
      toolKind: 'other',
      toolRawInput: { name: 'mcp-pubmed' },
      announceToolCall: true,
      permissionOptions: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onPermissionRequest: (request) => permissionRequests.push(request)
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'load a skill' })

    expect(permissionRequests).toEqual([])
    expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([])
  })

  it('does not trust an isolated OpenCode permission title as native Skill identity', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'opencode-untrusted-skill-session',
      toolCallId: 'opencode-untrusted-skill-call',
      toolTitle: 'skill',
      toolKind: 'other',
      toolRawInput: {},
      permissionOptions: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'reject' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'request an unknown tool' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({ title: 'skill', providerToolName: undefined })
    expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  })

  it('does not use the OpenCode Skill fallback when tool metadata names a different tool', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'opencode-explicit-tool-session',
      toolCallId: 'opencode-explicit-tool-call',
      toolTitle: 'skill',
      toolKind: 'other',
      toolRawInput: { name: 'mcp-pubmed' },
      announceToolCall: true,
      announcedProviderToolName: 'Bash',
      permissionOptions: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'reject' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run a non-Skill tool' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  })

  it('restores OpenCode MCP inputs before separating notebook grants by language', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    const permissionResponses: unknown[] = []
    const executionAuthorizations: Array<{
      sessionId: string
      toolCallId: string
      promptMessageId: string
      method: string
    }> = []
    const toolInputs = [
      { code: 'x = 1', language: 'python' },
      { code: 'x = 1', language: 'python' },
      { code: 'x = 1', language: 'python' },
      { code: 'x <- 1\n'.repeat(2_000), language: 'r' }
    ] as const
    const permissionInputs = [{}, {}, { code: 'x <- provider', language: 'r' }, {}]
    let promptIndex = 0

    acp
      .agent({ name: 'opencode-mcp-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'opencode-mcp-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const currentPromptIndex = promptIndex
        const toolInput = toolInputs[currentPromptIndex]
        const permissionInput = permissionInputs[currentPromptIndex]
        const toolCallId = `opencode-notebook-${currentPromptIndex + 1}`
        promptIndex += 1

        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open_science_notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        })

        const requestPermission = (): Promise<acp.RequestPermissionResponse> =>
          ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              title: 'open_science_notebook_notebook_execute',
              kind: 'other',
              status: 'pending',
              locations: [],
              rawInput: permissionInput
            },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
            ]
          })
        const notifyRunningTool = (): Promise<void> =>
          ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'in_progress',
              rawInput: toolInput
            }
          })

        let response: acp.RequestPermissionResponse
        if (currentPromptIndex === 0 || currentPromptIndex === 3) {
          // OpenCode can put the permission request on the wire before the SDK has dispatched the
          // immediately preceding running update. The runtime must rendezvous them by toolCallId.
          const pendingPermission = requestPermission()
          await notifyRunningTool()
          response = await pendingPermission
        } else {
          await notifyRunningTool()
          response = await requestPermission()
        }
        permissionResponses.push(response)

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
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' }),
        authorizeExecution: (authorization) => {
          executionAuthorizations.push(authorization)
          return `invocation-${authorization.toolCallId}`
        }
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          const sessionOptionId = request.options.find(
            (option) => option.scope === 'session'
          )?.optionId
          if (!sessionOptionId) {
            throw new Error('Expected Open Science to provide a conversation permission option')
          }
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId: sessionOptionId
          })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    expect(mcpServerNamesFor(runtime, session.sessionId)).toContain('open-science-notebook')

    for (const [index, toolInput] of toolInputs.entries()) {
      await runtime.sendPrompt({
        sessionId: session.sessionId,
        text: `run ${toolInput.language}`,
        provenanceContext: { promptMessageId: `prompt-${index + 1}` }
      })
    }

    expect(permissionRequests).toHaveLength(2)
    expect(permissionRequests.map((request) => request.rawInput)).toEqual([
      { code: 'x = 1', language: 'python' },
      { code: 'x <- provider', language: 'r' }
    ])
    expect(permissionResponses).toEqual(
      toolInputs.map(() => ({ outcome: { outcome: 'selected', optionId: 'once' } }))
    )
    // Calls 2 and 3 are app-remembered Python grants, while call 4 establishes the R grant. Every
    // released OpenCode call still creates a fresh one-shot execution identity.
    expect(executionAuthorizations.map(({ toolCallId }) => toolCallId)).toEqual([
      'opencode-notebook-1',
      'opencode-notebook-2',
      'opencode-notebook-3',
      'opencode-notebook-4'
    ])
    expect(executionAuthorizations[3]).toMatchObject({ rawInput: toolInputs[3] })
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        kind: 'mcp',
        label: 'Notebook REPL (Python)',
        scope: 'session'
      },
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:r',
        kind: 'mcp',
        label: 'Notebook REPL (R)',
        scope: 'session'
      }
    ])
  })

  it('maps an OpenCode underscore MCP permission to a canonical notebook grant', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'opencode-underscore-notebook-session',
      toolCallId: 'opencode-underscore-notebook-call',
      toolTitle: 'open_science_notebook_notebook_execute',
      toolRawInput: { code: 'print(1)', language: 'python' },
      permissionOptions: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          const sessionOptionId = request.options.find(
            (option) => option.scope === 'session'
          )?.optionId
          if (!sessionOptionId) throw new Error('Missing conversation permission option')
          runtime.respondToPermission({ requestId: request.requestId, optionId: sessionOptionId })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run notebook code' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({
      title: 'open_science_notebook_notebook_execute',
      isMcp: true,
      rawInput: { code: 'print(1)', language: 'python' }
    })
    expect(permissionResponse).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        kind: 'mcp',
        label: 'Notebook REPL (Python)',
        scope: 'session'
      }
    ])
  })

  it('auto-allows the app-owned Artifact save without emitting a renderer permission', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []

    acp
      .agent({ name: 'opencode-artifact-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'opencode-artifact-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const toolCallId = 'opencode-artifact-1'
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open_science_artifacts_write_artifact_file',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        })

        const pendingPermission = ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId,
            title: 'open_science_artifacts_write_artifact_file',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
          ]
        })
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            rawInput: { path: 'results/report.md', content: '# Results' }
          }
        })

        return { stopReason: 'end_turn', response: await pendingPermission }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, optionId: 'once' })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'write artifact' })

    expect(permissionRequests).toHaveLength(0)
  })

  it('auto-allows a Codex Artifact save restored from its sparse MCP approval', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'codex-artifact-session',
      toolCallId: 'codex-artifact-1',
      toolTitle: 'unused-by-sparse-codex-approval',
      sparseCodexMcpApproval: true,
      codexMcpIdentity: {
        server: 'open-science-artifacts',
        tool: 'write_artifact_file',
        arguments: {
          filename: 'results.md',
          mimeType: 'text/markdown',
          content: '# Results'
        }
      },
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'save results.md' })

    expect(permissionRequests).toHaveLength(0)
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it.each([
    { name: 'without the Codex MCP marker', codexMcpMarker: false },
    {
      name: 'with a mismatched qualified title',
      codexMcpTitle: 'mcp.open-science-artifacts.unrelated_tool'
    }
  ])('does not auto-allow a Codex Artifact save $name', async (probeOptions) => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'untrusted-codex-artifact-session',
      toolCallId: 'untrusted-codex-artifact-1',
      toolTitle: 'unused-by-sparse-codex-approval',
      sparseCodexMcpApproval: true,
      codexMcpIdentity: {
        server: 'open-science-artifacts',
        tool: 'write_artifact_file'
      },
      ...probeOptions,
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'save results.md' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionResponse).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('auto-allows a Claude Code Artifact save identified by its qualified MCP title', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'claude-artifact-session',
      toolCallId: 'call_00_artifact_save',
      toolTitle: 'mcp__open-science-artifacts__write_artifact_file',
      toolKind: 'other',
      toolRawInput: { localPath: 'sin.png', filename: 'sin.png', mimeType: 'image/png' },
      announceToolCall: true,
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ],
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const root = await createTemporaryRoot()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'save sin.png' })

    expect(permissionRequests).toHaveLength(0)
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it('cancels an OpenCode permission that arrives after cancellation', async () => {
    const process = new FakeAgentProcess()
    const permissionResponses: acp.RequestPermissionResponse[] = []
    const requestPermissionGate = createDeferred()

    acp
      .agent({ name: 'opencode-cancelled-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'opencode-cancel-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const toolCallId = 'opencode-cancelled-notebook'
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open-science-notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        })
        await requestPermissionGate.promise
        permissionResponses.push(
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              title: 'open-science-notebook_notebook_execute',
              kind: 'other',
              status: 'pending',
              rawInput: {}
            },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
            ]
          })
        )
        return { stopReason: 'cancelled' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => undefined)
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const onPermissionRequest = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: { onPermissionRequest }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run python' })

    await vi.waitFor(() =>
      expect(opencodeMcpToolInputsMap(runtime).get(session.sessionId)?.size).toBe(1)
    )
    expect(opencodeMcpToolInputWaitersMap(runtime).has(session.sessionId)).toBe(false)
    await runtime.cancelPrompt({ sessionId: session.sessionId })
    requestPermissionGate.resolve()
    await prompt

    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }])
    expect(opencodeMcpToolInputWaitersMap(runtime).has(session.sessionId)).toBe(false)
  })

  it('does not miss OpenCode input received while registering its waiter', async () => {
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(new FakeAgentProcess()),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: vi.fn()
    })
    const toolInputs = new Map<string, unknown>()
    const readToolInput = toolInputs.get.bind(toolInputs)
    let readCount = 0

    vi.spyOn(toolInputs, 'get').mockImplementation((toolCallId) => {
      const input = readToolInput(toolCallId)
      if (readCount === 0) {
        readCount += 1
        toolInputs.set(toolCallId, {
          title: 'open-science-notebook_notebook_execute',
          rawInput: { code: 'print(1)' }
        })
        return undefined
      }
      return input
    })
    opencodeMcpToolInputsMap(runtime).set('session-1', toolInputs)

    const outcome = waitForOpenCodeMcpToolInput(runtime, 'session-1', 'tool-1')

    await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('ready')
    expect(opencodeMcpToolInputWaitersMap(runtime).has('session-1')).toBe(false)
  })

  it('cancels an OpenCode permission already waiting for tool context', async () => {
    const process = new FakeAgentProcess()
    const permissionResponses: acp.RequestPermissionResponse[] = []

    acp
      .agent({ name: 'opencode-waiting-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'opencode-wait-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const toolCallId = 'waiting-notebook-call'
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open-science-notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        })
        permissionResponses.push(
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              title: 'open-science-notebook_notebook_execute',
              kind: 'other',
              status: 'pending',
              rawInput: {}
            },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
            ]
          })
        )
        return { stopReason: 'cancelled' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => undefined)
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const onPermissionRequest = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: { onPermissionRequest }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run python' })

    await vi.waitFor(() =>
      expect(opencodeMcpToolInputWaitersMap(runtime).get(session.sessionId)?.size).toBe(1)
    )
    await runtime.cancelPrompt({ sessionId: session.sessionId })
    await prompt

    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }])
    expect(opencodeMcpToolInputWaitersMap(runtime).has(session.sessionId)).toBe(false)
  })

  it('cancels an OpenCode permission when its tool call ends as context restore completes', async () => {
    const process = new FakeAgentProcess()
    const permissionResponses: acp.RequestPermissionResponse[] = []

    acp
      .agent({ name: 'opencode-late-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'opencode-late-session' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const toolCallId = 'completed-notebook-call'
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'open-science-notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: { language: 'python', code: 'print(1)' }
          }
        })
        permissionResponses.push(
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId,
              title: 'open-science-notebook_notebook_execute',
              kind: 'other',
              status: 'pending',
              rawInput: {}
            },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
            ]
          })
        )
        return { stopReason: 'end_turn' }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const onPermissionRequest = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          onPermissionRequest(request)
          void runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })
    const context = permissionContext(runtime)
    const restoreToolCall = context.restoreToolCall.bind(context)
    vi.spyOn(context, 'restoreToolCall').mockImplementation(async (params, restoreContext) => {
      const restored = await restoreToolCall(params, restoreContext)
      observePermissionToolContext(runtime, {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: params.toolCall.toolCallId,
          status: 'completed'
        }
      })
      return restored
    })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run python' })

    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(permissionResponses).toEqual([{ outcome: { outcome: 'cancelled' } }])
  })

  it('shows a sparse Codex command and remembers only its command signature', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: Array<{
      title: string
      rawInput?: unknown
      requestId: string
      options: Array<{ optionId: string; scope?: string }>
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
          const optionId =
            permissionRequests.length === 1
              ? request.options.find((option) => option.scope === 'session')?.optionId
              : request.options.find((option) => option.scope === 'once')?.optionId
          if (!optionId) throw new Error('Missing projected permission option')
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId
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
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    ])
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'shell:npm run lint',
        kind: 'shell',
        label: 'npm run lint',
        scope: 'session'
      }
    ])

    await runtime.resetSessionContext({
      sessionId: session.sessionId,
      cwd: '/workspace',
      permissionProfile: 'ask'
    })
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'shell:npm run lint',
        kind: 'shell',
        label: 'npm run lint',
        scope: 'session'
      }
    ])
  })

  it('strips Codex policy amendments using the Session framework', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: Array<{
      requestId: string
      options: Array<{ optionId: string }>
      commandPrefix?: string[]
    }> = []

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
              kind: 'allow_always',
              _meta: { codex: { execpolicyAmendment: ['./deploy'] } }
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

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'deploy' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].options.map((option) => option.optionId)).toEqual([
      'allow-once',
      'decline',
      expect.stringContaining('open-science:allow-session:')
    ])
    expect(permissionRequests[0].commandPrefix).toEqual(['./deploy'])
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'auto' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'start a turn' })
    await promptStarted.promise

    for (let index = 0; index < 40; index += 1) {
      observePermissionToolContext(runtime, {
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
          },
          _meta: { is_mcp_tool_call: true }
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

  it('records a conversation grant for an app-owned Codex MCP leaf name', async () => {
    const process = new FakeAgentProcess()
    const permissionRequests: AcpPermissionRequest[] = []
    let permissionResponse: unknown
    startPermissionProbeAgent(process, {
      newSessionId: 'codex-leaf-mcp-session',
      toolCallId: 'codex-leaf-execute',
      toolTitle: 'execute',
      toolKind: 'other',
      toolRawInput: { code: 'print(1)', language: 'python' },
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPermissionResponse: (response) => {
        permissionResponse = response
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      },
      callbacks: {
        onPermissionRequest: (request) => {
          permissionRequests.push(request)
          const sessionOptionId = request.options.find(
            (option) => option.scope === 'session'
          )?.optionId
          if (!sessionOptionId) throw new Error('Missing Open Science conversation option')
          runtime.respondToPermission({ requestId: request.requestId, optionId: sessionOptionId })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'run notebook code' })

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({
      title: 'execute',
      isMcp: true,
      rawInput: { code: 'print(1)', language: 'python' },
      options: expect.arrayContaining([
        expect.objectContaining({ name: 'This session', scope: 'session' })
      ])
    })
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(runtime.getSnapshot().permissionGrants[session.sessionId]).toEqual([
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        kind: 'mcp',
        label: 'Notebook REPL (Python)',
        scope: 'session'
      }
    ])
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
        projectId: 'default-project',
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
    expect(mcpServerNamesFor(runtime, 'resumed-session')).toEqual(['open-science-artifacts'])
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
        projectId: 'default-project',
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
    expect(mcpServerNamesFor(runtime, 'switched-session')).toEqual(['open-science-artifacts'])
  })

  it('returns an explicit reviewer role while preserving MCP audit routing', async () => {
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
    const built = await runtime.buildReviewerSession({
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
    const { session } = built
    expect(built.role).toBe('reviewer')
    expect(built.cwd).toMatch(/open-science-reviewer-/)
    expect(session.sessionId).toBe('reviewer-session-1')
    expect(reviewerOwnerProbe(runtime).contextFor('reviewer-session-1')).toEqual({
      frameworkId: 'claude-code',
      mcpServerNames: ['open-science-reviewer'],
      role: 'reviewer'
    })
    expect(mcpServerNamesFor(runtime, 'reviewer-session-1')).toEqual([])
    expect(runtime.getSessionFramework('reviewer-session-1')).toBeUndefined()

    // Drive a tool-call permission request through the reviewer session (auto-approved by the runtime).
    await session.prompt([{ type: 'text', text: 'review this turn' }])

    expect(auditedIsMcp('reviewer-mcp')).toBe(true)

    // Disposing the reviewer session clears only the owner-private invocation context.
    runtime.disposeReviewerSession(session)
    expect(reviewerOwnerProbe(runtime).contextFor('reviewer-session-1')).toBeUndefined()
    expect(mcpServerNamesFor(runtime, 'reviewer-session-1')).toEqual([])
    expect(runtime.getSessionFramework('reviewer-session-1')).toBeUndefined()
  })

  it('keeps reviewer ownership out of public primary state and capability hooks', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['primary-session', 'reviewer-session'])
    const resolveSpecialistIdentity = vi.fn(async () => ({ append: '', prefix: '' }))
    const resolveSpecialistSkills = vi.fn(async () => ({
      kind: 'specialist' as const,
      skillIds: [],
      frameworkNames: [],
      missingSkillIds: []
    }))
    const registerSessionSpecialist = vi.fn()
    const onPermissionRequest = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      resolveSpecialistIdentity,
      resolveSpecialistSkills,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'notebook-token'
        }),
        registerSessionSpecialist
      },
      callbacks: { onPermissionRequest }
    })
    await runtime.createSession({ cwd: '/workspace' })
    resolveSpecialistIdentity.mockClear()
    resolveSpecialistSkills.mockClear()
    registerSessionSpecialist.mockClear()

    const primaryProjection = (): object => {
      const snapshot = runtime.getSnapshot()
      return {
        sessionId: snapshot.sessionId,
        sessionIds: snapshot.sessionIds,
        pendingPermissions: snapshot.pendingPermissions,
        permissionProfiles: snapshot.permissionProfiles,
        permissionGrants: snapshot.permissionGrants,
        contextUsageBySession: snapshot.contextUsageBySession
      }
    }
    const before = primaryProjection()
    const built = await runtime.buildReviewerSession({
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

    expect(primaryProjection()).toEqual(before)
    expect(reviewerOwnerProbe(runtime).snapshot()).toEqual([
      { lifecycle: 'active', role: 'reviewer', sessionId: 'reviewer-session' }
    ])
    expect(reviewerOwnerProbe(runtime).snapshot()[0]).not.toHaveProperty('cwd')
    expect(resolveSpecialistIdentity).not.toHaveBeenCalled()
    expect(resolveSpecialistSkills).not.toHaveBeenCalled()
    expect(registerSessionSpecialist).not.toHaveBeenCalled()
    expect(onPermissionRequest).not.toHaveBeenCalled()

    runtime.disposeReviewerSession(built.session)
    expect(primaryProjection()).toEqual(before)
    await runtime.disconnect()
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

  it.each([
    { tool: 'read_turn', expectedResponse: { action: 'accept' } },
    { tool: 'query_execution_log', expectedResponse: { action: 'accept' } },
    { tool: 'read_artifact', expectedResponse: { action: 'accept' } },
    { tool: 'submit_findings', expectedResponse: { action: 'accept' } },
    { tool: 'run_shell', expectedResponse: { action: 'decline' } }
  ])(
    'handles Codex reviewer MCP tool $tool requested through elicitation/create',
    async ({ tool, expectedResponse }) => {
      const process = new FakeAgentProcess()
      let elicitationResponse: unknown
      startPermissionProbeAgent(process, {
        newSessionId: 'codex-reviewer-elicitation-session',
        toolCallId: `codex-reviewer-elicitation-${tool}`,
        toolTitle: 'unused by Codex approval elicitation',
        codexMcpIdentity: {
          server: 'open-science-reviewer',
          tool,
          arguments: { checks: [] }
        },
        codexMcpApprovalViaElicitation: true,
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        onPermissionResponse: (response) => {
          elicitationResponse = response
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

      expect(elicitationResponse).toEqual(expectedResponse)
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
    expect(runtime.disposeReviewerSession(session)).toEqual({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    })
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
    expect(runtime.disposeReviewerSession(session)).toEqual({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    })
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
    expect(runtime.disposeReviewerSession(session)).toEqual({
      rejectedToolCalls: 1,
      reviewerBridgeScoped: undefined
    })
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

    // dispose returns the final count and clears it atomically — the orchestrator relies on this.
    expect(runtime.disposeReviewerSession(session)).toEqual({
      rejectedToolCalls: 1,
      reviewerBridgeScoped: undefined
    })
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
    ).rejects.toThrow(/app-owned open-science-reviewer/)
    expect(spawnAgent).not.toHaveBeenCalled()
  })

  it('accepts the app-owned Reviewer stdio proxy used by Windows named pipes', async () => {
    const process = new FakeAgentProcess()
    startPermissionProbeAgent(process, {
      newSessionId: 'reviewer-session-pipe',
      toolCallId: 'reviewer-pipe-tool',
      toolTitle: 'Submit review checks',
      providerToolName: 'mcp__open-science-reviewer__submit_findings'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    const built = await runtime.buildReviewerSession({
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'open-science-reviewer',
          command: '/app/open-science',
          args: ['/app/main.js', '--open-science-reviewer-mcp-proxy'],
          env: [
            {
              name: 'OPEN_SCIENCE_REVIEWER_MCP_SOCKET_PATH',
              value: '\\\\.\\pipe\\open-science-reviewer'
            },
            { name: 'OPEN_SCIENCE_REVIEWER_MCP_TOKEN', value: 'reviewer-token' }
          ]
        }
      ]
    })

    expect(built.session.sessionId).toBe('reviewer-session-pipe')
    runtime.disposeReviewerSession(built.session)
  })

  it('reserves a reviewer session id while its permission mode is still starting', async () => {
    const {
      fakeAgent,
      lease,
      runtime,
      reviewer: first,
      request,
      releaseReviewerMode,
      modeRequestCount
    } = await startPendingReviewerRace(['shared-reviewer', 'shared-reviewer'])
    const second = runtime.buildReviewerSession(request)

    try {
      await expect(second).rejects.toThrow('Reviewer session id collision: shared-reviewer')
      expect(modeRequestCount()).toBe(1)
      expect(lease.registerReviewerSession).not.toHaveBeenCalled()

      const duplicateCwd = fakeAgent.newSessions[1]?.cwd
      expect(duplicateCwd).toMatch(/open-science-reviewer-/)
      await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })

      releaseReviewerMode.resolve()
      const winner = await first
      expect(lease.registerReviewerSession).toHaveBeenCalledOnce()
      expect(lease.registerReviewerSession).toHaveBeenCalledWith('shared-reviewer')
      await winner.session.prompt([{ type: 'text', text: 'winner keeps reviewer authority' }])
      expect(fakeAgent.prompts).toEqual([
        { sessionId: 'shared-reviewer', text: 'winner keeps reviewer authority' }
      ])
    } finally {
      releaseReviewerMode.resolve()
      await first.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await second.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
    }
  })

  it.each([
    {
      teardown: 'disconnect',
      runTeardown: (runtime: AcpRuntime) => runtime.disconnect(),
      canStartSuccessor: true
    },
    {
      teardown: 'reconnect',
      runTeardown: (runtime: AcpRuntime) => runtime.connect({ cwd: '/workspace' }),
      canStartSuccessor: true
    }
  ])(
    'invalidates a pending reviewer startup before a failing $teardown can strand it',
    async ({ runTeardown, canStartSuccessor }) => {
      const oldProcess = new FakeAgentProcess()
      const newProcess = new FakeAgentProcess()
      const reviewerModeStarted = createDeferred()
      const releaseReviewerMode = createDeferred()
      let modeRequestCount = 0
      startFakeAgent(oldProcess, ['primary-session', 'stale-reviewer'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        onSetMode: async () => {
          modeRequestCount += 1
          if (modeRequestCount === 2) {
            reviewerModeStarted.resolve()
            await releaseReviewerMode.promise
          }
        }
      })
      startFakeAgent(newProcess, ['stale-reviewer'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      })
      const oldBridge = createBackendLeaseHarness()
      const newBridge = createBackendLeaseHarness()
      let spawnCount = 0
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => {
          const useOld = spawnCount === 0
          spawnCount += 1
          return {
            framework: {
              ...codexFramework,
              spawn: () => asAgentProcess(useOld ? oldProcess : newProcess)
            },
            executablePath: '/bin/codex-acp',
            env: {},
            responsesBridgeLease: useOld ? oldBridge.lease : newBridge.lease
          }
        }
      })
      const primary = await runtime.createSession({ cwd: '/workspace' })
      const activePrimary = activeSessionForTest(runtime, primary.sessionId)!
      const disposePrimary = activePrimary.dispose.bind(activePrimary)
      activePrimary.dispose = vi.fn(() => {
        throw new Error('primary disconnect dispose failed')
      })
      const reviewerRequest: Parameters<AcpRuntime['buildReviewerSession']>[0] = {
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'open-science-reviewer',
            url: 'http://127.0.0.1:1/mcp',
            headers: []
          }
        ]
      }
      const reviewer = runtime.buildReviewerSession(reviewerRequest)
      const reviewerOutcome = reviewer.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      )
      await reviewerModeStarted.promise
      let successor: Awaited<ReturnType<AcpRuntime['buildReviewerSession']>> | undefined

      try {
        expect(pendingReviewerSessionIds(runtime).has('stale-reviewer')).toBe(true)

        await expect(runTeardown(runtime)).rejects.toThrow('primary disconnect dispose failed')

        expect(pendingReviewerSessionIds(runtime).size).toBe(0)
        if (canStartSuccessor) {
          successor = await runtime.buildReviewerSession(reviewerRequest)
          expect(reviewerSessionIds(runtime)).toEqual(new Set(['stale-reviewer']))
        }

        releaseReviewerMode.resolve()
        const staleOutcome = await reviewerOutcome
        expect(staleOutcome.error).toMatchObject({
          message: 'ACP session startup was superseded.'
        })
        if (canStartSuccessor) {
          expect(reviewerSessionIds(runtime)).toEqual(new Set(['stale-reviewer']))
        } else {
          expect(reviewerSessionIds(runtime).size).toBe(0)
        }
        expect(oldBridge.lease.registerReviewerSession).not.toHaveBeenCalled()
        if (canStartSuccessor) {
          expect(newBridge.lease.registerReviewerSession).toHaveBeenCalledWith('stale-reviewer')
        }
      } finally {
        releaseReviewerMode.resolve()
        await reviewer.then(
          ({ session }) => runtime.disposeReviewerSession(session),
          () => undefined
        )
        if (successor) runtime.disposeReviewerSession(successor.session)
        activePrimary.dispose = disposePrimary
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('keeps a successor reviewer active when an older same-id session disposes late', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['shared-reviewer'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const newAgent = startFakeAgent(newProcess, ['shared-reviewer'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const oldBridge = createBackendLeaseHarness()
    const newBridge = createBackendLeaseHarness()
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        const useOld = spawnCount === 0
        spawnCount += 1
        return {
          framework: {
            ...codexFramework,
            spawn: () => asAgentProcess(useOld ? oldProcess : newProcess)
          },
          executablePath: '/bin/codex-acp',
          env: {},
          responsesBridgeLease: useOld ? oldBridge.lease : newBridge.lease
        }
      }
    })
    const request: Parameters<AcpRuntime['buildReviewerSession']>[0] = {
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    }
    const oldReviewer = await runtime.buildReviewerSession(request)
    await runtime.disconnect()
    const successor = await runtime.buildReviewerSession(request)
    const successorCwd = newAgent.newSessions[0]!.cwd

    try {
      runtime.disposeReviewerSession(oldReviewer.session)

      expect(reviewerSessionIds(runtime)).toEqual(new Set(['shared-reviewer']))
      expect(newBridge.lease.unregisterReviewerSession).not.toHaveBeenCalled()
      await expect(stat(successorCwd)).resolves.toBeDefined()
      await successor.session.prompt([{ type: 'text', text: 'successor remains scoped' }])
      expect(newAgent.prompts).toEqual([
        { sessionId: 'shared-reviewer', text: 'successor remains scoped' }
      ])
    } finally {
      runtime.disposeReviewerSession(successor.session)
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('completes unexpected-close cleanup when one reviewer bridge unregister throws', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['reviewer-one', 'reviewer-two'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const { lease, release } = createBackendLeaseHarness()
    lease.unregisterReviewerSession = vi.fn((sessionId: string) => {
      if (sessionId === 'reviewer-one') throw new Error('reviewer unregister failed')
      return false
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
    })
    const reviewerRequest: Parameters<AcpRuntime['buildReviewerSession']>[0] = {
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http',
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    }
    await runtime.buildReviewerSession(reviewerRequest)
    await runtime.buildReviewerSession(reviewerRequest)
    const reviewerCwds = fakeAgent.newSessions.map(({ cwd }) => cwd)
    await runtime.requestProviderReconnect()
    const handleConnectionClosed = (
      runtime as unknown as { connectionClose: { handleUnexpectedClose: () => void } }
    ).connectionClose.handleUnexpectedClose.bind(
      (runtime as unknown as { connectionClose: unknown }).connectionClose
    )

    try {
      expect(handleConnectionClosed).not.toThrow()
      expect(lease.unregisterReviewerSession).toHaveBeenCalledWith('reviewer-one')
      expect(lease.unregisterReviewerSession).toHaveBeenCalledWith('reviewer-two')
      expect(reviewerSessionIds(runtime).size).toBe(0)
      expect(
        (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
      ).toBeUndefined()
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
      for (const reviewerCwd of reviewerCwds) {
        await expect(stat(reviewerCwd)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      lease.unregisterReviewerSession = vi.fn(() => false)
      if (reviewerSessionIds(runtime).size > 0) handleConnectionClosed()
    }
  })

  it('activates reviewer routing before granting responses bridge authority', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['reviewer-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const routingObservedByBridge: Array<{ active: boolean; pending: boolean }> = []
    const { lease } = createBackendLeaseHarness()
    lease.registerReviewerSession = vi.fn((sessionId: string) => {
      routingObservedByBridge.push({
        active: reviewerSessionIds(runtime).has(sessionId),
        pending: pendingReviewerSessionIds(runtime).has(sessionId)
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
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

    expect(routingObservedByBridge).toEqual([{ active: true, pending: false }])
    runtime.disposeReviewerSession(session)
  })

  it('rolls back reviewer activation when responses bridge registration throws', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['reviewer-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const { lease } = createBackendLeaseHarness()
    lease.registerReviewerSession = vi.fn(() => {
      throw new Error('reviewer bridge registration failed')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
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
    ).rejects.toThrow('reviewer bridge registration failed')

    expect(reviewerSessionIds(runtime).size).toBe(0)
    expect(pendingReviewerSessionIds(runtime).size).toBe(0)
    expect(lease.unregisterReviewerSession).toHaveBeenCalledWith('reviewer-session-1')
    await expect(stat(fakeAgent.newSessions[0]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets the first known create identity reservation win while another start is unresolved', async () => {
    const process = new FakeAgentProcess()
    const primaryStartReachedAgent = createDeferred()
    const releasePrimaryStart = createDeferred()
    const fakeAgent = startFakeAgent(process, ['shared-session', 'shared-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onNewSession: async ({ index }) => {
        if (index === 0) {
          primaryStartReachedAgent.resolve()
          await releasePrimaryStart.promise
        }
      }
    })
    const { lease } = createBackendLeaseHarness()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
    })
    await runtime.connect({ cwd: '/workspace' })

    const primary = runtime.createSession({ cwd: '/workspace' })
    await primaryStartReachedAgent.promise
    const reviewer = runtime.buildReviewerSession({
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

    try {
      const winner = await reviewer
      expect(reviewerSessionIds(runtime)).toEqual(new Set(['shared-session']))
      expect(lease.registerReviewerSession).toHaveBeenCalledWith('shared-session')

      releasePrimaryStart.resolve()
      await expect(primary).rejects.toThrow(
        'Primary session id collision with reviewer: shared-session'
      )
      expect(runtime.getSnapshot().sessionIds).toEqual([])
      await winner.session.prompt([{ type: 'text', text: 'first reservation keeps authority' }])
      expect(fakeAgent.prompts).toEqual([
        { sessionId: 'shared-session', text: 'first reservation keeps authority' }
      ])
    } finally {
      releasePrimaryStart.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId }) => runtime.deleteSession({ sessionId }),
        () => undefined
      )
    }
  })

  it('reserves a new primary session id while its permission mode is still starting', async () => {
    const { fakeAgent, lease, runtime, primary, reviewer, releasePrimaryMode, modeRequestCount } =
      await startPendingPrimaryRace(['shared-session', 'shared-session'], (runtime) =>
        runtime.createSession({ cwd: '/workspace' })
      )

    try {
      await expect(reviewer).rejects.toThrow('Reviewer session id collision: shared-session')
      expect(modeRequestCount()).toBe(1)
      expect(lease.registerReviewerSession).not.toHaveBeenCalled()
      const duplicateCwd = fakeAgent.newSessions[1]?.cwd
      expect(duplicateCwd).toMatch(/open-science-reviewer-/)
      await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })

      releasePrimaryMode.resolve()
      const winner = await primary
      expect(runtime.getSnapshot()).toMatchObject({
        sessionIds: ['shared-session'],
        permissionProfiles: {
          'shared-session': {
            selectedProfile: 'ask',
            effectiveProfile: 'ask',
            currentModeId: 'read-only'
          }
        }
      })
      await runtime.sendPrompt({
        sessionId: winner.sessionId,
        text: 'primary keeps normal authority'
      })
      expect(fakeAgent.prompts).toHaveLength(1)
      expect(fakeAgent.prompts[0]).toMatchObject({ sessionId: 'shared-session' })
      expect(fakeAgent.prompts[0]?.text).toContain('primary keeps normal authority')
    } finally {
      releasePrimaryMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId }) => runtime.deleteSession({ sessionId }),
        () => undefined
      )
    }
  })

  it.each([
    {
      teardown: 'disconnect',
      runTeardown: (runtime: AcpRuntime) => runtime.disconnect(),
      canStartSuccessor: true
    },
    {
      teardown: 'reconnect',
      runTeardown: (runtime: AcpRuntime) => runtime.connect({ cwd: '/workspace' }),
      canStartSuccessor: true
    }
  ])(
    'invalidates a pending primary startup before a failing $teardown can strand it',
    async ({ runTeardown, canStartSuccessor }) => {
      const oldProcess = new FakeAgentProcess()
      const newProcess = new FakeAgentProcess()
      const pendingModeStarted = createDeferred()
      const releasePendingMode = createDeferred()
      let modeRequestCount = 0
      startFakeAgent(oldProcess, ['active-primary', 'stale-primary'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        onSetMode: async () => {
          modeRequestCount += 1
          if (modeRequestCount === 2) {
            pendingModeStarted.resolve()
            await releasePendingMode.promise
          }
        }
      })
      startFakeAgent(newProcess, ['stale-primary'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      })
      let spawnCount = 0
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => {
          const useOld = spawnCount === 0
          spawnCount += 1
          return {
            framework: {
              ...codexFramework,
              spawn: () => asAgentProcess(useOld ? oldProcess : newProcess)
            },
            executablePath: '/bin/codex-acp',
            env: {}
          }
        }
      })
      const active = await runtime.createSession({ cwd: '/workspace' })
      const activeSession = activeSessionForTest(runtime, active.sessionId)!
      const disposeActive = activeSession.dispose.bind(activeSession)
      activeSession.dispose = vi.fn(() => {
        throw new Error('active primary disconnect dispose failed')
      })
      const pending = runtime.createSession({ cwd: '/workspace' })
      const pendingOutcome = pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      )
      await pendingModeStarted.promise
      let successor: Awaited<ReturnType<AcpRuntime['createSession']>> | undefined

      try {
        await expect(runTeardown(runtime)).rejects.toThrow(
          'active primary disconnect dispose failed'
        )

        if (canStartSuccessor) {
          successor = await runtime.createSession({ cwd: '/workspace' })
          expect(runtime.getSnapshot().sessionIds).toContain('stale-primary')
        }

        releasePendingMode.resolve()
        const staleOutcome = await pendingOutcome
        expect(staleOutcome.error).toMatchObject({
          message: 'ACP session startup was superseded.'
        })
        if (canStartSuccessor) {
          expect(runtime.getSnapshot().sessionIds).toContain('stale-primary')
        } else {
          expect(runtime.getSnapshot().sessionIds).not.toContain('stale-primary')
        }
      } finally {
        releasePendingMode.resolve()
        await pending.then(
          ({ sessionId }) => runtime.deleteSession({ sessionId }),
          () => undefined
        )
        if (successor) await runtime.deleteSession({ sessionId: successor.sessionId })
        activeSession.dispose = disposeActive
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('does not let a stale primary startup publish specialist or permission state', async () => {
    const process = new FakeAgentProcess()
    const staleModeStarted = createDeferred()
    const releaseStaleMode = createDeferred()
    const fakeAgent = startFakeAgent(process, ['shared-primary', 'shared-primary'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onSetMode: async ({ modeId }) => {
        if (modeId === 'agent-full-access') {
          staleModeStarted.resolve()
          await releaseStaleMode.promise
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      resolveSpecialistIdentity: async (specialistId) => ({
        append: '',
        prefix: `${specialistId} prefix`
      })
    })
    await runtime.connect({ cwd: '/workspace' })
    const disconnectCurrentSpy = vi
      .spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
      .mockRejectedValueOnce(new Error('disconnect teardown failed'))
    const stale = runtime.createSession({
      cwd: '/workspace',
      specialistId: 'stale-specialist',
      permissionProfile: 'full'
    })
    await staleModeStarted.promise
    let successor: Awaited<ReturnType<AcpRuntime['createSession']>> | undefined

    try {
      await expect(runtime.disconnect()).rejects.toThrow('disconnect teardown failed')
      successor = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'ask' })

      releaseStaleMode.resolve()
      await expect(stale).rejects.toThrow('ACP session startup was superseded.')
      expect(runtime.getSnapshot().permissionProfiles['shared-primary']).toMatchObject({
        selectedProfile: 'ask',
        effectiveProfile: 'ask',
        currentModeId: 'read-only'
      })
      await runtime.sendPrompt({ sessionId: 'shared-primary', text: 'successor turn' })
      expect(fakeAgent.prompts.at(-1)?.text).toContain('successor turn')
      expect(fakeAgent.prompts.at(-1)?.text).not.toContain('stale-specialist prefix')
    } finally {
      releaseStaleMode.resolve()
      await stale.catch(() => undefined)
      disconnectCurrentSpy.mockRestore()
      if (successor) await runtime.deleteSession({ sessionId: successor.sessionId })
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('does not let stale permission setup target a same-id successor connection', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const permissionSetupStarted = createDeferred()
    const releasePermissionSetup = createDeferred()
    startFakeAgent(oldProcess, ['shared-primary'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onSetMode: async () => {
        permissionSetupStarted.resolve()
        await releasePermissionSetup.promise
      }
    })
    const newAgent = startFakeAgent(newProcess, ['shared-primary'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        spawnCount += 1
        return {
          framework: {
            ...codexFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/codex-acp',
          env: {}
        }
      }
    })

    const stale = runtime.createSession({
      cwd: '/workspace',
      permissionProfile: 'full'
    })
    await permissionSetupStarted.promise
    let successor: Awaited<ReturnType<AcpRuntime['createSession']>> | undefined

    try {
      await runtime.disconnect()
      successor = await runtime.createSession({
        cwd: '/workspace',
        permissionProfile: 'ask'
      })
      expect(newAgent.modeChanges).toEqual([{ sessionId: 'shared-primary', modeId: 'read-only' }])

      releasePermissionSetup.resolve()
      await expect(stale).rejects.toThrow('ACP session startup was superseded.')
      expect(newAgent.modeChanges).toEqual([{ sessionId: 'shared-primary', modeId: 'read-only' }])
      expect(runtime.getSnapshot().permissionProfiles['shared-primary']).toMatchObject({
        selectedProfile: 'ask',
        effectiveProfile: 'ask',
        currentModeId: 'read-only'
      })
    } finally {
      releasePermissionSetup.resolve()
      await stale.catch(() => undefined)
      if (successor) await runtime.deleteSession({ sessionId: successor.sessionId })
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('disposes a created primary session when teardown invalidates its startup', async () => {
    const process = new FakeAgentProcess()
    const pendingModeStarted = createDeferred()
    const releasePendingMode = createDeferred()
    startFakeAgent(process, ['stale-primary'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onSetMode: async () => {
        pendingModeStarted.resolve()
        await releasePendingMode.promise
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
    await runtime.connect({ cwd: '/workspace' })
    const disposeSpy = vi.spyOn(acp.ActiveSession.prototype, 'dispose')
    const disconnectCurrentSpy = vi
      .spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
      .mockRejectedValueOnce(new Error('disconnect teardown failed'))
    const pending = runtime.createSession({ cwd: '/workspace' })
    await pendingModeStarted.promise

    try {
      await expect(runtime.disconnect()).rejects.toThrow('disconnect teardown failed')
      releasePendingMode.resolve()

      await expect(pending).rejects.toThrow('ACP session startup was superseded.')
      expect(disposeSpy).toHaveBeenCalledOnce()
      expect((disposeSpy.mock.instances[0] as unknown as { sessionId?: string })?.sessionId).toBe(
        'stale-primary'
      )
    } finally {
      releasePendingMode.resolve()
      await pending.catch(() => undefined)
      disconnectCurrentSpy.mockRestore()
      disposeSpy.mockRestore()
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('defers a provider reconnect until a pending primary startup publishes', async () => {
    const process = new FakeAgentProcess()
    const pendingModeStarted = createDeferred()
    const releasePendingMode = createDeferred()
    startFakeAgent(process, ['pending-primary'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onSetMode: async () => {
        pendingModeStarted.resolve()
        await releasePendingMode.promise
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
    const pending = runtime.createSession({ cwd: '/workspace' })
    await pendingModeStarted.promise

    await runtime.requestProviderReconnect()

    expect(process.killed).toBe(false)
    expect(providerReconnectPending(runtime)).toBe(true)

    releasePendingMode.resolve()
    await expect(pending).resolves.toMatchObject({ sessionId: 'pending-primary' })
    await vi.waitFor(() => expect(process.killed).toBe(true))
  })

  it('does not let a startup reserved behind an armed reconnect barrier publish on the old connection', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const secondNewStarted = createDeferred()
    const releaseSecondNew = createDeferred()
    const secondModeStarted = createDeferred()
    const releaseSecondMode = createDeferred()
    let modeRequestCount = 0
    const fakeAgent = startFakeAgent(process, ['first-session', 'barrier-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onNewSession: async ({ index }) => {
        if (index !== 1) return
        secondNewStarted.resolve()
        await releaseSecondNew.promise
      },
      onSetMode: async () => {
        modeRequestCount += 1
        if (modeRequestCount !== 2) return
        secondModeStarted.resolve()
        await releaseSecondMode.promise
      },
      onPrompt: () => promptGate.promise
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
    const first = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: first.sessionId, text: 'stay active' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    const second = runtime.createSession({ cwd: '/workspace' })
    await secondNewStarted.promise

    try {
      await runtime.requestProviderReconnect()
      releaseSecondNew.resolve()
      await secondModeStarted.promise

      promptGate.resolve()
      await prompt
      await vi.waitFor(() => expect(process.killed).toBe(true))

      releaseSecondMode.resolve()
      await expect(second).rejects.toThrow('ACP session startup was superseded.')
      expect(runtime.getSnapshot().sessionIds).not.toContain('barrier-session')
    } finally {
      promptGate.resolve()
      releaseSecondNew.resolve()
      releaseSecondMode.resolve()
      await prompt.catch(() => undefined)
      await second.catch(() => undefined)
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('defers a provider reconnect until a pending reviewer startup activates', async () => {
    const { lease, runtime, reviewer, releaseReviewerMode } = await startPendingReviewerRace([
      'pending-reviewer'
    ])

    try {
      await runtime.requestProviderReconnect()

      expect(providerReconnectPending(runtime)).toBe(true)
      expect(pendingReviewerSessionIds(runtime).has('pending-reviewer')).toBe(true)

      releaseReviewerMode.resolve()
      const activeReviewer = await reviewer
      expect(reviewerSessionIds(runtime)).toEqual(new Set(['pending-reviewer']))
      expect(lease.registerReviewerSession).toHaveBeenCalledWith('pending-reviewer')
      expect(activeReviewer.session.sessionId).toBe('pending-reviewer')
    } finally {
      releaseReviewerMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
    }
  })

  it('resolves an armed reconnect barrier when explicitly disconnected', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['active-reviewer'])
    startFakeAgent(newProcess, ['fresh-primary'])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {}
        }
      }
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
    await runtime.requestProviderReconnect()
    expect(
      (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
    ).toBeDefined()

    await runtime.disconnect()

    expect(
      (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
    ).toBeUndefined()
    expect(providerReconnectPending(runtime)).toBe(false)
    await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toMatchObject({
      sessionId: 'fresh-primary'
    })
  })

  it('fully detaches the old backend when a primary dispose fails during disconnect', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['active-primary'])
    startFakeAgent(newProcess, ['fresh-primary'])
    const oldBridge = createBackendLeaseHarness()
    const newBridge = createBackendLeaseHarness()
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        const useOld = spawnCount === 0
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(useOld ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {},
          responsesBridgeLease: useOld ? oldBridge.lease : newBridge.lease
        }
      }
    })
    const active = await runtime.createSession({ cwd: '/workspace' })
    const activeSession = activeSessionForTest(runtime, active.sessionId)!
    const disposeActive = activeSession.dispose.bind(activeSession)
    activeSession.dispose = vi.fn(() => {
      throw new Error('active primary dispose failed')
    })

    try {
      await expect(runtime.disconnect()).rejects.toThrow('active primary dispose failed')
      expect(oldProcess.killed).toBe(true)
      expect(oldBridge.release).toHaveBeenCalledOnce()
      expect(runtime.getSnapshot().sessionIds).toEqual([])

      await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toMatchObject({
        sessionId: 'fresh-primary'
      })
      expect(spawnCount).toBe(2)
    } finally {
      activeSession.dispose = disposeActive
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('does not let an older teardown complete a newer reconnect intent', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const oldCloseStarted = createDeferred()
    const releaseOldClose = createDeferred()
    const mcpHttpHost = {
      clear: vi.fn(),
      close: vi.fn(async () => {
        oldCloseStarted.resolve()
        await releaseOldClose.promise
      })
    } as unknown as AgentMcpHttpHost
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      mcpHttpHost,
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.connect({ cwd: '/workspace' })
    const oldDisconnect = runtime.disconnect()
    await oldCloseStarted.promise
    const releaseActivity = createDeferred()
    const activity = runtime.withActivity({}, async () => releaseActivity.promise)

    try {
      await runtime.requestProviderReconnect()
      expect(providerReconnectPending(runtime)).toBe(true)
      expect(
        (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
      ).toBeDefined()

      releaseOldClose.resolve()
      await oldDisconnect
      expect(providerReconnectPending(runtime)).toBe(true)
      expect(
        (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
      ).toBeDefined()

      releaseActivity.resolve()
      await activity
      await vi.waitFor(() =>
        expect(
          (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
        ).toBeUndefined()
      )
    } finally {
      releaseOldClose.resolve()
      releaseActivity.resolve()
      await oldDisconnect.catch(() => undefined)
      await activity.catch(() => undefined)
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it('does not let an older disconnect close a successor HTTP MCP host', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['old-http-session'])
    startFakeAgent(newProcess, ['new-http-session'])
    const routes = new Set<string>()
    const close = vi.fn(async () => {
      routes.clear()
    })
    const httpHost = {
      ensureStarted: vi.fn(async () => ({
        endpoint: 'http://127.0.0.1:4321',
        token: 'host-token'
      })),
      registerNotebook: vi.fn((routingId: string) => {
        routes.add(routingId)
      }),
      urlFor: vi.fn(
        (kind: string, routingId: string) =>
          `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
      ),
      unregister: vi.fn((routingId: string) => {
        routes.delete(routingId)
      }),
      clear: vi.fn(() => routes.clear()),
      close
    } as unknown as AgentMcpHttpHost
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        const process = spawnCount === 0 ? oldProcess : newProcess
        spawnCount += 1
        return {
          framework: {
            ...opencodeFramework,
            acceptsStdioMcp: false,
            spawn: () => asAgentProcess(process)
          },
          executablePath: '/bin/agent',
          env: {},
          opencodeUsageApi: {
            baseUrl: 'http://127.0.0.1:4242',
            authorization: process === oldProcess ? 'Basic old' : 'Basic successor'
          }
        }
      },
      mcpHttpHost: httpHost,
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'notebook-token'
        })
      }
    })
    const first = await runtime.createSession({ cwd: '/workspace' })
    const firstRoutingId = [...routes][0]
    expect(first.sessionId).toBe('old-http-session')
    expect(firstRoutingId).toBeDefined()
    const oldKillStarted = createDeferred()
    const releaseOldKill = createDeferred()
    vi.mocked(terminateProcessTree).mockImplementationOnce(async (child) => {
      oldKillStarted.resolve()
      await releaseOldKill.promise
      child?.kill()
      return { reaped: true }
    })
    const oldDisconnect = runtime.disconnect()
    await oldKillStarted.promise

    try {
      const successor = await runtime.createSession({ cwd: '/workspace' })
      const successorRoutingId = [...routes][0]
      expect(successor.sessionId).toBe('new-http-session')
      expect(successorRoutingId).toBeDefined()
      expect(successorRoutingId).not.toBe(firstRoutingId)
      expect(routes.size).toBe(1)
      expect(openCodeUsageApiForTest(runtime)).toMatchObject({
        authorization: 'Basic successor'
      })

      releaseOldKill.resolve()
      await oldDisconnect

      expect(close).not.toHaveBeenCalled()
      expect(routes).toContain(successorRoutingId)
      expect(openCodeUsageApiForTest(runtime)).toMatchObject({
        authorization: 'Basic successor'
      })
      expect(runtime.getSnapshot()).toMatchObject({
        status: 'connected',
        sessionIds: ['new-http-session']
      })
    } finally {
      releaseOldKill.resolve()
      await oldDisconnect.catch(() => undefined)
      await runtime.disconnect().catch(() => undefined)
      expect(close).toHaveBeenCalledOnce()
    }
  })

  it('releases an armed reconnect barrier during synchronous shutdown', async () => {
    const oldProcess = new FakeAgentProcess()
    const abandonedProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['active-reviewer'])
    startFakeAgent(abandonedProcess, ['must-not-publish'])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        const process = spawnCount === 0 ? oldProcess : abandonedProcess
        spawnCount += 1
        return {
          framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent',
          env: {}
        }
      }
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
    await runtime.requestProviderReconnect()
    const blocked = runtime.createSession({ cwd: '/workspace' })

    runtime.shutdown()

    await expect(blocked).rejects.toThrow('ACP runtime is shutting down.')
    expect(
      (runtime as unknown as { reconnectBarrier?: Promise<void> }).reconnectBarrier
    ).toBeUndefined()
    expect(providerReconnectPending(runtime)).toBe(false)
    expect(runtime.getSnapshot().sessionIds).toEqual([])
  })

  it('reserves a resumed primary session id while its permission mode is still starting', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000'
    const { fakeAgent, runtime, primary, reviewer, releasePrimaryMode, modeRequestCount } =
      await startPendingPrimaryRace([sessionId], (runtime) =>
        runtime.resumeSession({ sessionId, cwd: '/workspace' })
      )

    try {
      await expect(reviewer).rejects.toThrow(
        'Reviewer session id collision: 123e4567-e89b-42d3-a456-426614174000'
      )
      expect(modeRequestCount()).toBe(1)
      const duplicateCwd = fakeAgent.newSessions[0]?.cwd
      expect(duplicateCwd).toMatch(/open-science-reviewer-/)
      await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })

      releasePrimaryMode.resolve()
      await expect(primary).resolves.toMatchObject({ sessionId })
      expect(runtime.getSnapshot().sessionIds).toEqual([sessionId])
      await runtime.sendPrompt({ sessionId, text: 'resumed primary remains active' })
      expect(fakeAgent.prompts).toHaveLength(1)
      expect(fakeAgent.prompts[0]).toMatchObject({ sessionId })
      expect(fakeAgent.prompts[0]?.text).toContain('resumed primary remains active')
    } finally {
      releasePrimaryMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId: resumedSessionId }) => runtime.deleteSession({ sessionId: resumedSessionId }),
        () => undefined
      )
    }
  })

  it.each([
    { path: 'resume', previousFrameworkId: undefined, contextReset: undefined },
    { path: 'fresh adoption', previousFrameworkId: 'opencode' as const, contextReset: true }
  ])(
    'does not let a stale $path overwrite its same-id successor projections',
    async ({ previousFrameworkId, contextReset }) => {
      const process = new FakeAgentProcess()
      const staleModeStarted = createDeferred()
      const releaseStaleMode = createDeferred()
      const capabilityReleases: ReturnType<typeof vi.fn>[] = []
      const releaseSessionCapabilities = vi.fn()
      const mcpHttpHost = {
        ensureStarted: vi.fn(async () => ({
          endpoint: 'http://127.0.0.1:4321',
          token: 'host-token'
        })),
        registerNotebook: vi.fn(),
        urlFor: vi.fn(
          (kind: string, routingId: string) =>
            `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn(async () => undefined)
      } as unknown as AgentMcpHttpHost
      const fakeAgent = startFakeAgent(process, ['stale-provider', 'successor-provider'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
        onSetMode: async ({ modeId }) => {
          if (modeId === 'agent-full-access') {
            staleModeStarted.resolve()
            await releaseStaleMode.promise
          }
        }
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: {
            ...codexFramework,
            acceptsStdioMcp: false,
            spawn: () => asAgentProcess(process)
          },
          executablePath: '/bin/codex-acp',
          env: {}
        }),
        mcpHttpHost,
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          releaseSessionCapabilities,
          getRpcConnection: async () => {
            const release = vi.fn()
            capabilityReleases.push(release)
            return {
              endpoint: 'http://127.0.0.1:4567',
              token: `notebook-token-${capabilityReleases.length}`,
              release
            }
          }
        },
        resolveSpecialistIdentity: async (specialistId) => ({
          append: '',
          prefix: `${specialistId} prefix`
        })
      })
      await runtime.connect({ cwd: '/workspace' })
      const disconnectCurrentSpy = vi
        .spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
        .mockRejectedValueOnce(new Error('disconnect teardown failed'))
      const sessionId = '123e4567-e89b-42d3-a456-426614174000'
      const stale = runtime.resumeSession({
        sessionId,
        cwd: '/workspace',
        permissionProfile: 'full',
        specialistId: 'stale-specialist',
        ...(previousFrameworkId ? { previousFrameworkId } : {})
      })
      const staleOutcome = stale.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      )
      await staleModeStarted.promise
      let successor: Awaited<ReturnType<AcpRuntime['resumeSession']>> | undefined

      try {
        await expect(runtime.disconnect()).rejects.toThrow('disconnect teardown failed')
        successor = await runtime.resumeSession({
          sessionId,
          cwd: '/workspace',
          permissionProfile: 'ask',
          ...(previousFrameworkId ? { previousFrameworkId } : {})
        })
        expect(successor.contextReset).toBe(contextReset)

        releaseStaleMode.resolve()
        const outcome = await staleOutcome
        expect(outcome.error).toMatchObject({ message: 'ACP session startup was superseded.' })
        expect(runtime.getSnapshot().permissionProfiles[sessionId]).toMatchObject({
          selectedProfile: 'ask',
          effectiveProfile: 'ask',
          currentModeId: 'read-only'
        })
        await runtime.sendPrompt({ sessionId, text: 'successor turn' })
        expect(fakeAgent.prompts.at(-1)?.text).toContain('successor turn')
        expect(fakeAgent.prompts.at(-1)?.text).not.toContain('stale-specialist prefix')
        expect(runtime.getSnapshot().sessionIds).toEqual([sessionId])
        expect(mcpHttpHost.unregister).not.toHaveBeenCalled()
        expect(capabilityReleases).toHaveLength(2)
        expect(capabilityReleases[0]).toHaveBeenCalledOnce()
        expect(capabilityReleases[1]).not.toHaveBeenCalled()
        expect(releaseSessionCapabilities).not.toHaveBeenCalled()
      } finally {
        releaseStaleMode.resolve()
        await staleOutcome
        disconnectCurrentSpy.mockRestore()
        if (successor) await runtime.deleteSession({ sessionId })
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('does not let a superseded failed resume revoke its same-id successor capability', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000'
    const process = new FakeAgentProcess()
    const staleResumeStarted = createDeferred()
    const releaseStaleResume = createDeferred()
    const releaseSessionCapabilities = vi.fn()
    const fakeAgent = startFakeAgent(process, [], {
      onResumeRequest: async ({ index }) => {
        if (index !== 0) return
        staleResumeStarted.resolve()
        await releaseStaleResume.promise
        throw acp.RequestError.resourceNotFound(sessionId)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'legacy-notebook-token'
        }),
        releaseSessionCapabilities
      }
    })
    await runtime.connect({ cwd: '/workspace' })

    const stale = runtime.resumeSession({ sessionId, cwd: '/workspace' })
    const staleOutcome = stale.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    )
    await staleResumeStarted.promise
    invalidatePendingSessionStartupsForTest(runtime)
    const successor = await runtime.resumeSession({ sessionId, cwd: '/workspace' })

    try {
      releaseStaleResume.resolve()
      const outcome = await staleOutcome
      expect(outcome.error).toMatchObject({ message: 'ACP session startup was superseded.' })
      expect(successor).toMatchObject({ sessionId })
      expect(fakeAgent.newSessions).toHaveLength(0)
      expect(fakeAgent.resumedSessions).toHaveLength(1)
      expect(releaseSessionCapabilities).not.toHaveBeenCalled()
      expect(runtime.getSnapshot().sessionIds).toEqual([sessionId])
    } finally {
      releaseStaleResume.resolve()
      await staleOutcome
      await runtime.deleteSession({ sessionId })
    }
  })

  it('reserves a known resumed app id before provider attach completes', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000'
    const process = new FakeAgentProcess()
    const resumeStarted = createDeferred()
    const releaseResume = createDeferred()
    const fakeAgent = startFakeAgent(process, [sessionId], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onResume: async () => {
        resumeStarted.resolve()
        await releaseResume.promise
      }
    })
    const { lease } = createBackendLeaseHarness()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
    })
    await runtime.connect({ cwd: '/workspace' })

    const primary = runtime.resumeSession({ sessionId, cwd: '/workspace' })
    await resumeStarted.promise
    const reviewer = runtime.buildReviewerSession({
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

    try {
      await expect(reviewer).rejects.toThrow(`Reviewer session id collision: ${sessionId}`)
      await expect(stat(fakeAgent.newSessions[0]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })

      releaseResume.resolve()
      await expect(primary).resolves.toMatchObject({ sessionId })
    } finally {
      releaseResume.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId: resumedSessionId }) => runtime.deleteSession({ sessionId: resumedSessionId }),
        () => undefined
      )
    }
  })

  it('rejects a second primary owner for a pending stable app id', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000'
    const process = new FakeAgentProcess()
    const resumeStarted = createDeferred()
    const releaseResume = createDeferred()
    const fakeAgent = startFakeAgent(process, [], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onResume: async () => {
        resumeStarted.resolve()
        await releaseResume.promise
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
    await runtime.connect({ cwd: '/workspace' })

    const first = runtime.resumeSession({ sessionId, cwd: '/workspace' })
    await resumeStarted.promise

    try {
      await expect(runtime.resumeSession({ sessionId, cwd: '/workspace' })).rejects.toThrow(
        `Primary session id collision: ${sessionId}`
      )
      expect(fakeAgent.resumedSessions).toHaveLength(1)

      releaseResume.resolve()
      await expect(first).resolves.toMatchObject({ sessionId })
    } finally {
      releaseResume.resolve()
      await first.then(
        ({ sessionId: resumedSessionId }) => runtime.deleteSession({ sessionId: resumedSessionId }),
        () => undefined
      )
    }
  })

  it('reserves a fresh adoption app id before the provider session starts', async () => {
    const process = new FakeAgentProcess()
    const adoptionStarted = createDeferred()
    const releaseAdoption = createDeferred()
    const fakeAgent = startFakeAgent(process, ['new-provider-session', 'stable-app-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onNewSession: async ({ index }) => {
        if (index === 0) {
          adoptionStarted.resolve()
          await releaseAdoption.promise
        }
      }
    })
    const { lease } = createBackendLeaseHarness()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
    })
    await runtime.connect({ cwd: '/workspace' })

    const primary = runtime.resumeSession({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })
    await adoptionStarted.promise
    const reviewer = runtime.buildReviewerSession({
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

    try {
      await expect(reviewer).rejects.toThrow('Reviewer session id collision: stable-app-session')
      await expect(stat(fakeAgent.newSessions[1]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })

      releaseAdoption.resolve()
      await expect(primary).resolves.toMatchObject({
        sessionId: 'stable-app-session',
        contextReset: true
      })
    } finally {
      releaseAdoption.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId }) => runtime.deleteSession({ sessionId }),
        () => undefined
      )
    }
  })

  it('reserves a fresh adoption app-facing id while its permission mode is still starting', async () => {
    const { fakeAgent, runtime, primary, reviewer, releasePrimaryMode, modeRequestCount } =
      await startPendingPrimaryRace(['new-provider-session', 'stable-app-session'], (runtime) =>
        runtime.resumeSession({
          sessionId: 'stable-app-session',
          cwd: '/workspace'
        })
      )

    try {
      await expect(reviewer).rejects.toThrow('Reviewer session id collision: stable-app-session')
      expect(modeRequestCount()).toBe(1)
      const duplicateCwd = fakeAgent.newSessions[1]?.cwd
      expect(duplicateCwd).toMatch(/open-science-reviewer-/)
      await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })

      releasePrimaryMode.resolve()
      await expect(primary).resolves.toMatchObject({
        sessionId: 'stable-app-session',
        contextReset: true
      })
      expect(runtime.getSnapshot().sessionIds).toEqual(['stable-app-session'])
      await runtime.sendPrompt({
        sessionId: 'stable-app-session',
        text: 'adopted primary remains active'
      })
      expect(fakeAgent.prompts).toHaveLength(1)
      expect(fakeAgent.prompts[0]).toMatchObject({ sessionId: 'new-provider-session' })
      expect(fakeAgent.prompts[0]?.text).toContain('adopted primary remains active')
    } finally {
      releasePrimaryMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId }) => runtime.deleteSession({ sessionId }),
        () => undefined
      )
    }
  })

  it('reserves a fresh adoption provider id while its permission mode is still starting', async () => {
    const { fakeAgent, runtime, primary, reviewer, releasePrimaryMode, modeRequestCount } =
      await startPendingPrimaryRace(
        ['reserved-provider-session', 'reserved-provider-session'],
        (runtime) =>
          runtime.resumeSession({
            sessionId: 'stable-app-session',
            cwd: '/workspace'
          })
      )

    try {
      await expect(reviewer).rejects.toThrow(
        'Reviewer session id collision: reserved-provider-session'
      )
      expect(modeRequestCount()).toBe(1)
      const duplicateCwd = fakeAgent.newSessions[1]?.cwd
      expect(duplicateCwd).toMatch(/open-science-reviewer-/)
      await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })

      releasePrimaryMode.resolve()
      await expect(primary).resolves.toMatchObject({
        sessionId: 'stable-app-session',
        contextReset: true
      })
      expect(runtime.getSnapshot().sessionIds).toEqual(['stable-app-session'])
      await runtime.sendPrompt({
        sessionId: 'stable-app-session',
        text: 'provider-owned primary remains active'
      })
      expect(fakeAgent.prompts).toHaveLength(1)
      expect(fakeAgent.prompts[0]).toMatchObject({
        sessionId: 'reserved-provider-session'
      })
      expect(fakeAgent.prompts[0]?.text).toContain('provider-owned primary remains active')
    } finally {
      releasePrimaryMode.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await primary.then(
        ({ sessionId }) => runtime.deleteSession({ sessionId }),
        () => undefined
      )
    }
  })

  it('keeps the stable app id reserved while context reset starts a replacement provider session', async () => {
    const process = new FakeAgentProcess()
    const replacementStarted = createDeferred()
    const releaseReplacement = createDeferred()
    const fakeAgent = startFakeAgent(
      process,
      ['stable-app-session', 'replacement-provider-session', 'stable-app-session'],
      {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
        onNewSession: async ({ index }) => {
          if (index === 1) {
            replacementStarted.resolve()
            await releaseReplacement.promise
          }
        }
      }
    )
    const { lease } = createBackendLeaseHarness()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        responsesBridgeLease: lease
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    const reset = runtime.resetSessionContext({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })
    await replacementStarted.promise
    const reviewer = runtime.buildReviewerSession({
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

    try {
      await expect(reviewer).rejects.toThrow('Reviewer session id collision: stable-app-session')
      await expect(stat(fakeAgent.newSessions[2]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })

      releaseReplacement.resolve()
      await expect(reset).resolves.toMatchObject({
        sessionId: 'stable-app-session',
        contextReset: true
      })
      await runtime.sendPrompt({
        sessionId: 'stable-app-session',
        text: 'replacement primary remains active'
      })
      expect(fakeAgent.prompts.at(-1)).toMatchObject({
        sessionId: 'replacement-provider-session'
      })
    } finally {
      releaseReplacement.resolve()
      await reviewer.then(
        ({ session }) => runtime.disposeReviewerSession(session),
        () => undefined
      )
      await reset.catch(() => undefined)
      await runtime.deleteSession({ sessionId: 'stable-app-session' }).catch(() => undefined)
    }
  })

  it('does not let an invalidated context reset replace a same-id successor session', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['stable-app-session'])
    const newAgent = startFakeAgent(newProcess, ['stale-reset-provider-session'])
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => {
        spawnCount += 1
        return {
          framework: {
            ...claudeCodeFramework,
            spawn: () => asAgentProcess(spawnCount === 1 ? oldProcess : newProcess)
          },
          executablePath: '/bin/agent',
          env: {}
        }
      }
    })
    await runtime.createSession({ cwd: '/workspace' })

    const ensureConnectedStarted = createDeferred()
    const replacementConnection = createDeferred<unknown>()
    const internal = runtime as unknown as {
      connection: unknown
      connectionLifecycle: { ensureConnected: (cwd: string) => Promise<unknown> }
    }
    vi.spyOn(internal.connectionLifecycle, 'ensureConnected').mockImplementationOnce(async () => {
      ensureConnectedStarted.resolve()
      return replacementConnection.promise
    })

    const reset = runtime.resetSessionContext({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })
    await ensureConnectedStarted.promise
    await runtime.disconnect()
    const successor = await runtime.resumeSession({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })
    replacementConnection.resolve(internal.connection)

    try {
      await expect(reset).rejects.toThrow('ACP session startup was superseded.')
      expect(successor).toMatchObject({ sessionId: 'stable-app-session' })
      expect(newAgent.newSessions).toHaveLength(0)
      expect(runtime.getSnapshot().sessionIds).toEqual(['stable-app-session'])
      await runtime.sendPrompt({
        sessionId: 'stable-app-session',
        text: 'successor remains active'
      })
      expect(newAgent.prompts.at(-1)).toMatchObject({
        sessionId: 'stable-app-session',
        text: expect.stringContaining('successor remains active')
      })
    } finally {
      replacementConnection.resolve(internal.connection)
      await reset.catch(() => undefined)
      await runtime.deleteSession({ sessionId: 'stable-app-session' }).catch(() => undefined)
      await runtime.disconnect().catch(() => undefined)
    }
  })

  it.each([
    {
      operation: 'new primary session',
      agentSessionIds: ['shared-session', 'shared-session'],
      collisionId: 'shared-session',
      expectedDisposals: 1,
      disposalFailure: 'primary collision dispose failed',
      start: (runtime: AcpRuntime) => runtime.createSession({ cwd: '/workspace' })
    },
    {
      operation: 'fresh adoption app-facing id',
      agentSessionIds: ['stable-app-session', 'new-provider-session'],
      collisionId: 'stable-app-session',
      expectedDisposals: 0,
      start: (runtime: AcpRuntime) =>
        runtime.resumeSession({ sessionId: 'stable-app-session', cwd: '/workspace' })
    },
    {
      operation: 'fresh adoption provider id',
      agentSessionIds: ['reserved-provider-session', 'reserved-provider-session'],
      collisionId: 'reserved-provider-session',
      expectedDisposals: 1,
      disposalFailure: 'adoption collision dispose failed',
      start: (runtime: AcpRuntime) =>
        runtime.resumeSession({ sessionId: 'stable-app-session', cwd: '/workspace' })
    },
    {
      operation: 'resumed primary session',
      agentSessionIds: ['123e4567-e89b-42d3-a456-426614174000'],
      collisionId: '123e4567-e89b-42d3-a456-426614174000',
      expectedDisposals: 0,
      start: (runtime: AcpRuntime) =>
        runtime.resumeSession({
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
          cwd: '/workspace'
        })
    }
  ])(
    'rejects a pending reviewer identity collision from a $operation',
    async ({ agentSessionIds, collisionId, expectedDisposals, disposalFailure, start }) => {
      errorLogSpy.mockClear()
      const { runtime, reviewer, releaseReviewerMode, modeRequestCount } =
        await startPendingReviewerRace(agentSessionIds)
      const disposeSpy = vi.spyOn(acp.ActiveSession.prototype, 'dispose')
      if (disposalFailure) {
        disposeSpy.mockImplementationOnce(() => {
          throw new Error(disposalFailure)
        })
      }
      const primary = start(runtime)

      try {
        await expect(primary).rejects.toThrow(
          'Primary session id collision with pending reviewer: ' + collisionId
        )
        expect(disposeSpy).toHaveBeenCalledTimes(expectedDisposals)
        expect(modeRequestCount()).toBe(1)
        expect(runtime.getSnapshot().sessionIds).toEqual([])
        if (disposalFailure) {
          expect(errorLogSpy).toHaveBeenCalledWith('primary collision session disposal failed', {
            errorCategory: 'error',
            sessionId: collisionId
          })
        }
      } finally {
        disposeSpy.mockRestore()
        await primary.then(
          ({ sessionId }) => runtime.deleteSession({ sessionId }),
          () => undefined
        )
        releaseReviewerMode.resolve()
        await reviewer.then(
          ({ session }) => runtime.disposeReviewerSession(session),
          () => undefined
        )
      }
    }
  )

  it('rejects a reviewer session id that collides with a primary session before authority setup', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['shared-session', 'shared-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

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
    ).rejects.toThrow('Reviewer session id collision: shared-session')

    const reviewerCwd = fakeAgent.newSessions[1]?.cwd
    expect(reviewerCwd).toMatch(/open-science-reviewer-/)
    await expect(stat(reviewerCwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fakeAgent.modeChanges).toEqual([])
    expect(runtime.getSnapshot().sessionIds).toEqual(['shared-session'])
  })

  it('keeps the reviewer collision as primary when the duplicate session cannot dispose', async () => {
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['shared-session', 'shared-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('duplicate dispose failed')
      })

    try {
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
      ).rejects.toThrow('Reviewer session id collision: shared-session')
    } finally {
      disposeSpy.mockRestore()
    }

    const reviewerCwd = fakeAgent.newSessions[1]?.cwd
    await expect(stat(reviewerCwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(errorLogSpy).toHaveBeenCalledWith('reviewer collision session disposal failed', {
      errorCategory: 'error',
      sessionId: 'shared-session'
    })
  })

  it('rejects a reviewer session id that collides with a freshly adopted provider session', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['provider-session', 'provider-session'], {
      resumeNotFound: true
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({ sessionId: 'stable-app-session', cwd: '/workspace' })
    ).resolves.toMatchObject({ sessionId: 'stable-app-session', contextReset: true })

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
    ).rejects.toThrow('Reviewer session id collision: provider-session')

    const reviewerCwd = fakeAgent.newSessions[1]?.cwd
    expect(reviewerCwd).toMatch(/open-science-reviewer-/)
    await expect(stat(reviewerCwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fakeAgent.modeChanges).toEqual([])
    expect(runtime.getSnapshot().sessionIds).toEqual(['stable-app-session'])
  })

  it('rejects a reviewer session id that collides with an existing reviewer', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['reviewer-session', 'reviewer-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const request = {
      cwd: '/workspace',
      mcpServers: [
        {
          type: 'http' as const,
          name: 'open-science-reviewer',
          url: 'http://127.0.0.1:1/mcp',
          headers: []
        }
      ]
    }

    const first = await runtime.buildReviewerSession(request)

    await expect(runtime.buildReviewerSession(request)).rejects.toThrow(
      'Reviewer session id collision: reviewer-session'
    )

    const duplicateCwd = fakeAgent.newSessions[1]?.cwd
    expect(duplicateCwd).toMatch(/open-science-reviewer-/)
    await expect(stat(duplicateCwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    await first.session.prompt([{ type: 'text', text: 'first reviewer remains active' }])
    expect(fakeAgent.prompts).toEqual([
      { sessionId: 'reviewer-session', text: 'first reviewer remains active' }
    ])
    runtime.disposeReviewerSession(first.session)
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
    expect(pendingReviewerSessionIds(runtime).size).toBe(0)
    expect(mcpServerNamesFor(runtime, 'reviewer-session-1')).toEqual([])
  })

  it('keeps setMode failure primary when reviewer startup disposal also fails', async () => {
    errorLogSpy.mockClear()
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
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('startup dispose failed')
      })

    try {
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
      ).rejects.toMatchObject({
        message: 'Internal error',
        data: { details: 'set mode failed' }
      })
    } finally {
      disposeSpy.mockRestore()
    }

    const reviewerCwd = fakeAgent.newSessions[0]?.cwd
    await expect(stat(reviewerCwd!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(errorLogSpy).toHaveBeenCalledWith('reviewer startup session disposal failed', {
      errorCategory: 'error',
      sessionId: 'reviewer-session-1'
    })
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

  it('invalidates context usage when its session is deleted', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    contextUsageMap(runtime).set(session.sessionId, { used: 12_000, size: 128_000 })

    await runtime.deleteSession({ sessionId: session.sessionId })

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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    expect(mcpServerNamesFor(runtime, session.sessionId)).toEqual(['open-science-artifacts'])

    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(mcpServerNamesFor(runtime, session.sessionId)).toEqual([])
  })

  it('releases notebook RPC capabilities when a session is deleted', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const releaseSessionCapabilities = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        releaseSessionCapabilities
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(session.sessionId)
  })

  it('releases notebook RPC capabilities for every session on disconnect', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const releaseSessionCapabilities = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        releaseSessionCapabilities
      }
    })

    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })
    await runtime.disconnect()

    expect(releaseSessionCapabilities).toHaveBeenCalledTimes(2)
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(first.sessionId)
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(second.sessionId)
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(root)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    expect(mcpServerNamesFor(runtime, session.sessionId)).toEqual(['open-science-artifacts'])

    await runtime.disconnect()

    expect(mcpServerNamesFor(runtime, session.sessionId)).toEqual([])
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

  it('allows a deleted adopted provider id to be reused by a new session', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1', 'adopted-session-1'], {
      resumeNotFound: true
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.resumeSession({ sessionId: 'switched-session', cwd: '/workspace' })
    await runtime.deleteSession({ sessionId: 'switched-session' })

    const reused = await runtime.createSession({ cwd: '/workspace' })
    expect(reused.sessionId).toBe('adopted-session-1')
    expect(runtime.getSnapshot().sessionIds).toEqual(['adopted-session-1'])

    await runtime.sendPrompt({ sessionId: reused.sessionId, text: 'reuse provider identity' })
    expect(fakeAgent.prompts.at(-1)).toEqual({
      sessionId: 'adopted-session-1',
      text: 'reuse provider identity'
    })

    await runtime.deleteSession({ sessionId: reused.sessionId })
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

  it('retains only resume affinity after disconnect and removes it on detached delete', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({
      cwd: '/workspace',
      projectId: 'project-1',
      permissionProfile: 'ask'
    })
    // Live routing, Permission projection, and framework affinity are all present while attached.
    expect(runtime.hasLiveSession('project-1', session.sessionId)).toBe(true)
    expect(runtime.isSessionUsingFramework(session.sessionId, 'claude-code')).toBe(true)
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'ask'
    })

    await runtime.disconnect()
    // Connection-owned metadata is gone, while framework affinity survives so a later resume can
    // detect a framework switch without attempting an incompatible provider resume.
    expect(runtime.getSnapshot()).toMatchObject({ sessionIds: [], permissionProfiles: {} })
    expect(runtime.hasLiveSession('project-1', session.sessionId)).toBe(false)
    expect(runtime.isSessionUsingFramework(session.sessionId, 'claude-code')).toBe(true)

    // Deleting the now-detached session must not talk to a torn-down agent and must remove the final
    // affinity record so it cannot later mislead the cross-framework resume check.
    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(runtime.isSessionUsingFramework(session.sessionId, 'claude-code')).toBe(false)
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
        // Every session (new or resumed) is restricted to the app-owned "user" settings scope.
        _meta: {
          claudeCode: {
            emitRawSDKMessages: [{ type: 'assistant' }, { type: 'result' }],
            options: {
              settingSources: ['user'],
              tools: { type: 'preset', preset: 'claude_code' },
              disallowedTools: [
                'Agent',
                'Task',
                'Workflow',
                'SendMessage',
                'TeamCreate',
                'TeamDelete',
                'Bash'
              ],
              managedSettings: {
                disableAgentView: true,
                disableWorkflows: true,
                workflowKeywordTriggerEnabled: false
              },
              env: {
                CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
              },
              settings: {
                env: {
                  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
                }
              }
            }
          },
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: expect.not.stringContaining('open_science_skill_privacy_instructions')
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

  it('releases the notebook RPC capability when resumed-session setup fails', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, [])
    const releaseSessionCapabilities = vi.fn()
    const failure = new Error('resumed permission setup failed')
    const mapPermissionProfile = vi
      .fn(claudeCodeFramework.mapPermissionProfile)
      .mockImplementationOnce(() => {
        throw failure
      })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...claudeCodeFramework, mapPermissionProfile },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'resumed-token'
        }),
        releaseSessionCapabilities
      }
    })
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('resumed-session disposal failed')
      })

    try {
      await expect(
        runtime.resumeSession({ sessionId: 'restored-session', cwd: '/workspace' })
      ).rejects.toBe(failure)

      expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
      expect(releaseSessionCapabilities).toHaveBeenCalledWith('restored-session')

      const recovered = await runtime.resumeSession({
        sessionId: 'restored-session',
        cwd: '/workspace'
      })
      expect(recovered.sessionId).toBe('restored-session')
      await runtime.deleteSession({ sessionId: recovered.sessionId })
    } finally {
      disposeSpy.mockRestore()
    }
  })

  it('releases the notebook RPC capability when fresh-session adoption fails', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['adopted-session', 'adopted-session'])
    const releaseSessionCapabilities = vi.fn()
    const failure = new Error('adopted permission setup failed')
    const mapPermissionProfile = vi
      .fn(claudeCodeFramework.mapPermissionProfile)
      .mockImplementationOnce(() => {
        throw failure
      })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...claudeCodeFramework, mapPermissionProfile },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'adopted-token'
        }),
        releaseSessionCapabilities
      }
    })
    const disposeSpy = vi
      .spyOn(acp.ActiveSession.prototype, 'dispose')
      .mockImplementationOnce(() => {
        throw new Error('adopted-session disposal failed')
      })

    try {
      await expect(
        runtime.resumeSession({
          sessionId: 'switched-session',
          cwd: '/workspace',
          previousFrameworkId: 'codex'
        })
      ).rejects.toBe(failure)

      expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
      expect(releaseSessionCapabilities).toHaveBeenCalledWith('switched-session')

      const recovered = await runtime.resumeSession({
        sessionId: 'switched-session',
        cwd: '/workspace',
        previousFrameworkId: 'codex'
      })
      expect(recovered).toMatchObject({ sessionId: 'switched-session', contextReset: true })
      await runtime.deleteSession({ sessionId: recovered.sessionId })
    } finally {
      disposeSpy.mockRestore()
    }
  })

  it.each([
    {
      path: 'resume event',
      failingObserver: 'event' as const,
      previousFrameworkId: undefined,
      contextReset: undefined,
      providerSessionIds: []
    },
    {
      path: 'resume state',
      failingObserver: 'state' as const,
      previousFrameworkId: undefined,
      contextReset: undefined,
      providerSessionIds: []
    },
    {
      path: 'fresh-adoption state',
      failingObserver: 'state' as const,
      previousFrameworkId: 'opencode' as const,
      contextReset: true,
      providerSessionIds: ['adopted-provider-session']
    }
  ])(
    'keeps a published $path session usable when its observer throws',
    async ({ failingObserver, previousFrameworkId, contextReset, providerSessionIds }) => {
      const sessionId =
        previousFrameworkId === undefined
          ? '123e4567-e89b-42d3-a456-426614174000'
          : 'stable-app-session'
      const httpHost = {
        ensureStarted: vi.fn(async () => ({
          endpoint: 'http://127.0.0.1:4321',
          token: 'host-token'
        })),
        registerNotebook: vi.fn(),
        urlFor: vi.fn(
          (kind: string, routingId: string) =>
            `http://127.0.0.1:4321/mcp/${kind}/${encodeURIComponent(routingId)}`
        ),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn(async () => undefined)
      } as unknown as AgentMcpHttpHost
      const release = vi.fn()
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, [...providerSessionIds], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
      })
      let observerFailurePending = true
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework: { ...codexFramework, acceptsStdioMcp: false },
        mcpHttpHost: httpHost,
        callbacks: {
          onEvent: (event) => {
            if (
              observerFailurePending &&
              failingObserver === 'event' &&
              event.sessionId === sessionId
            ) {
              observerFailurePending = false
              throw new Error('resume event callback failed')
            }
          },
          onStateChanged: (snapshot) => {
            if (
              observerFailurePending &&
              failingObserver === 'state' &&
              snapshot.sessionIds.includes(sessionId)
            ) {
              observerFailurePending = false
              throw new Error('session state callback failed')
            }
          }
        },
        notebook: {
          projectId: 'default-project',
          mcpEntryPath: '/app/out/main/index.js',
          getRpcConnection: async () => ({
            endpoint: 'http://127.0.0.1:4567',
            token: 'notebook-token',
            release
          })
        }
      })

      try {
        await expect(
          runtime.resumeSession({
            sessionId,
            cwd: '/workspace',
            ...(previousFrameworkId ? { previousFrameworkId } : {})
          })
        ).resolves.toMatchObject({ sessionId, ...(contextReset ? { contextReset } : {}) })
        expect(runtime.getSnapshot().sessionIds).toEqual([sessionId])
        expect(httpHost.unregister).not.toHaveBeenCalled()
        expect(release).not.toHaveBeenCalled()

        await runtime.sendPrompt({ sessionId, text: 'still usable' })
        expect(fakeAgent.prompts.at(-1)).toMatchObject({
          sessionId: previousFrameworkId ? 'adopted-provider-session' : sessionId,
          text: expect.stringContaining('still usable')
        })

        await runtime.deleteSession({ sessionId })
        expect(release).toHaveBeenCalledOnce()
      } finally {
        if (runtime.getSnapshot().sessionIds.includes(sessionId)) {
          await runtime.deleteSession({ sessionId }).catch(() => undefined)
        }
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('replaces a failed resume capability without revoking the adopted session capability', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['adopted-session'], { resumeNotFound: true })
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:4567',
      token: 'session-token'
    }))
    const releaseSessionCapabilities = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection,
        releaseSessionCapabilities
      }
    })

    await expect(
      runtime.resumeSession({ sessionId: 'restored-session', cwd: '/workspace' })
    ).resolves.toMatchObject({ sessionId: 'restored-session', contextReset: true })

    expect(getRpcConnection).toHaveBeenCalledTimes(2)
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('restored-session')
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

  it('keeps other Sessions on a shared connection alive when one resume times out', async () => {
    const process = new FakeAgentProcess()
    const resumeReceived = createDeferred()
    const resumeCancelled = createDeferred()
    const fakeAgent = startFakeAgent(process, ['active-session'], {
      onResumeRequest: ({ signal }) => {
        resumeReceived.resolve(undefined)
        signal.addEventListener('abort', () => resumeCancelled.resolve(undefined), { once: true })
        return new Promise<never>(() => {})
      }
    })

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

    await runtime.createSession({ cwd: '/workspace' })
    const resume = runtime.resumeSession({ sessionId: 'stuck-session', cwd: '/workspace' })
    await resumeReceived.promise
    fireResumeTimeout?.()

    await expect(resume).rejects.toThrow(/timed out/i)
    await resumeCancelled.promise
    await expect(
      runtime.sendPrompt({ sessionId: 'active-session', text: 'keep working' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(fakeAgent.prompts).toContainEqual({
      sessionId: 'active-session',
      text: 'keep working'
    })
    expect(process.killed).toBe(false)
  })

  it.each(['session-update', 'claude-sdk-message'] as const)(
    'keeps a pending session/resume alive on %s progress',
    async (progressKind) => {
      const process = new FakeAgentProcess()
      const resumeReceived = createDeferred()
      const emitProgress = createDeferred()
      const progressSent = createDeferred()
      const finishResume = createDeferred<Record<string, never>>()

      acp
        .agent({ name: 'progressing-agent' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { close: {}, resume: {} }
          },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.resume, async (ctx) => {
          resumeReceived.resolve(undefined)
          await emitProgress.promise
          if (progressKind === 'session-update') {
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'restoring history' }
              }
            })
          } else {
            await ctx.client.notify('_claude/sdkMessage', {
              sessionId: ctx.params.sessionId,
              message: { type: 'progress', text: 'restoring history' }
            })
          }
          progressSent.resolve(undefined)
          return finishResume.promise
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      let now = 0
      const timers: Array<{ active: boolean; deadline: number; fire: () => void }> = []
      const advanceBy = (elapsedMs: number): void => {
        now += elapsedMs
        for (const timer of timers) {
          if (timer.active && timer.deadline <= now) {
            timer.active = false
            timer.fire()
          }
        }
      }
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        resumeTimeoutMs: 1000,
        setTimer: (fire, timeoutMs) => {
          const handle = timers.length
          timers.push({ active: true, deadline: now + timeoutMs, fire })
          return handle as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: (handle) => {
          const timer = timers[handle as unknown as number]
          if (timer) timer.active = false
        }
      })

      const resume = runtime.resumeSession({ sessionId: 'streaming-session', cwd: '/workspace' })
      await resumeReceived.promise
      advanceBy(900)
      emitProgress.resolve(undefined)
      await progressSent.promise

      // The original deadline has passed, but provider activity renewed the inactivity budget.
      advanceBy(200)
      finishResume.resolve({})

      await expect(resume).resolves.toMatchObject({ sessionId: 'streaming-session' })
      expect(process.killed).toBe(false)
    }
  )

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
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const messageEvents: Array<{ role?: string; text?: string }> = []
    const peekHandoffContext = vi.fn(() => ({
      executionCount: 2,
      cells: [{ id: 'cell-1', language: 'python' as const, status: 'completed' as const }],
      kernels: [{ kind: 'python' as const, status: 'idle' as const }],
      runtimes: []
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1/notebook',
          token: 'notebook-token'
        }),
        peekHandoffContext
      },
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
    expect(fakeAgent.prompts[0]?.text).toContain('<open_science_notebook_continuity>')
    expect(fakeAgent.prompts[0]?.text).toContain('"executionCount":2')
    expect(fakeAgent.prompts[0]?.text).toContain('keep going')
    // ...but the conversation bubble records only what the user actually typed.
    expect(messageEvents).toEqual([{ role: 'user', text: 'keep going' }])
    expect(
      infoLogSpy.mock.calls.find(
        ([message]) => message === 'session transcript replay dispatched'
      )?.[1]
    ).toMatchObject({
      sessionId: 'switched-session',
      historyTextLength: 43,
      historyAttachmentCount: 0,
      historyImageCount: 0,
      framework: 'claude-code',
      status: 'connected'
    })

    await runtime.sendPrompt({ sessionId: 'switched-session', text: 'ordinary continuation' })
    expect(peekHandoffContext).toHaveBeenCalledOnce()
    expect(fakeAgent.prompts[1]?.text).not.toContain('<open_science_notebook_continuity>')
  })

  it('hands off live Notebook state after a context reset with no replayable transcript', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-1'])
    const peekHandoffContext = vi.fn(() => ({
      executionCount: 1,
      cells: [{ id: 'cell-1', language: 'python' as const, status: 'completed' as const }],
      kernels: [{ kind: 'python' as const, status: 'idle' as const }],
      runtimes: []
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1/notebook',
          token: 'notebook-token'
        }),
        peekHandoffContext
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'session-1',
      text: 'retry the interrupted first turn',
      contextReset: true
    })

    expect(peekHandoffContext).toHaveBeenCalledOnce()
    expect(fakeAgent.prompts[0]?.text).toContain('<open_science_notebook_continuity>')
    expect(fakeAgent.prompts[0]?.text).toContain('"executionCount":1')
    expect(fakeAgent.prompts[0]?.text).not.toContain('Previous conversation')
  })

  it('sends an app-owned continuation without publishing its synthetic text as a user message', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-1'], {
      onPrompt: ({ text }) =>
        text.includes('Captured outer tool completion')
          ? {
              stopReason: 'end_turn',
              usage: {
                totalTokens: 48,
                inputTokens: 31,
                cachedReadTokens: 8,
                cachedWriteTokens: 2,
                outputTokens: 7
              }
            }
          : undefined,
      toolForPrompt: (text) =>
        text.includes('Captured outer tool completion')
          ? { toolCallId: 'continuation-tool-1', title: 'Read continuation input' }
          : undefined
    })
    const messageEvents: Array<{ role?: string; text?: string }> = []
    const runtimeEvents: AcpRuntimeEvent[] = []
    const promptStarts: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          runtimeEvents.push(event)
          if (event.kind === 'message') {
            messageEvents.push({ role: event.role, text: event.text })
          }
        },
        onPromptStarted: (_sessionId, turnToken) => promptStarts.push(turnToken)
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'analyze the dataset' })
    const userEventCount = messageEvents.filter(({ role }) => role === 'user').length
    const syntheticCompletion =
      'Continue after handoff. Captured outer tool completion returned: { rows: 42 }'
    const continuationEventStart = runtimeEvents.length
    await runtime.sendAppContinuation({
      sessionId: session.sessionId,
      text: syntheticCompletion,
      provenanceContext: { promptMessageId: 'originating-user-message-1' }
    })

    expect(fakeAgent.prompts).toEqual([
      { sessionId: session.sessionId, text: 'analyze the dataset' },
      { sessionId: session.sessionId, text: syntheticCompletion }
    ])
    expect(messageEvents.filter(({ role }) => role === 'user')).toEqual([
      { role: 'user', text: 'analyze the dataset' }
    ])
    expect(messageEvents.filter(({ role }) => role === 'user')).toHaveLength(userEventCount)
    expect(messageEvents).not.toContainEqual({ role: 'user', text: syntheticCompletion })
    expect(promptStarts).toHaveLength(2)
    const continuationEvents = runtimeEvents.slice(continuationEventStart)
    expect(
      continuationEvents.filter((event) => event.kind === 'message' && event.role === 'assistant')
    ).toEqual([
      expect.objectContaining({
        promptMessageId: 'originating-user-message-1',
        text: 'reply for session-1'
      })
    ])
    expect(continuationEvents.find((event) => event.kind === 'tool')).toMatchObject({
      promptMessageId: 'originating-user-message-1',
      toolCallId: 'continuation-tool-1'
    })
    expect(continuationEvents.find((event) => event.kind === 'stop')).toMatchObject({
      promptMessageId: 'originating-user-message-1',
      turnUsage: {
        inputTokens: 31,
        cacheTokens: 10,
        cachedReadTokens: 8,
        cachedWriteTokens: 2,
        outputTokens: 7
      }
    })
  })

  it('retains handoff continuity across expected reconnect teardown', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Continue this task after reconnect',
      provenanceContext: { promptMessageId: 'message-1' }
    })

    await runtime.disconnect(false)

    expect(
      runtime.createClaudeCodeContinuationRequest({
        sessionId: session.sessionId,
        switchReadBack: {
          status: 'approved',
          operation: 'switch',
          binding: {
            sessionId: session.sessionId,
            specialistId: 'specialist-1',
            targetName: 'Target Specialist'
          }
        }
      })
    ).toMatchObject({
      sessionId: session.sessionId,
      suppressUserMessage: true,
      provenanceContext: { promptMessageId: 'message-1' }
    })
  })

  it('publishes an explicit provenance prompt as the routed user message identity', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'])
    const messageEvents: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'message') messageEvents.push(event)
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: '[Auditor] Correct the generated file.',
      provenanceContext: { promptMessageId: 'auditor-prompt-1' }
    })

    expect(messageEvents.find((event) => event.role === 'user')).toMatchObject({
      messageId: 'auditor-prompt-1',
      promptMessageId: 'auditor-prompt-1',
      text: '[Auditor] Correct the generated file.'
    })
  })

  it('retains staged Claude replay after failed adoption and commits it after success', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(
      process,
      ['session-1', 'failed-replacement', 'successful-replacement', 'post-commit-replacement'],
      {
        resumeNotFound: true,
        onNewSession: ({ index }) => {
          if (index === 1) throw new Error('replacement startup failed')
        }
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      resolveSpecialistIdentity: async () => ({ append: '', prefix: '' })
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Carry this task through replacement',
      provenanceContext: { promptMessageId: 'message-1' }
    })
    runtime.prepareClaudeCodeHandoffReplay({
      sessionId: session.sessionId,
      capturedCompletion: { kind: 'returned', value: 'approved completion' },
      switchReadBack: {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId: session.sessionId,
          specialistId: 'specialist-1',
          targetName: 'Target Specialist'
        }
      }
    })

    await expect(runtime.switchSpecialist(session.sessionId, 'specialist-1')).rejects.toThrow()
    expect(JSON.stringify(fakeAgent.newSessions[1]?._meta)).toContain(
      'Carry this task through replacement'
    )

    await runtime.resumeSession({ sessionId: session.sessionId, cwd: '/workspace' })
    expect(JSON.stringify(fakeAgent.newSessions[2]?._meta)).toContain(
      'Carry this task through replacement'
    )

    await runtime.switchSpecialist(session.sessionId, 'specialist-1')
    expect(JSON.stringify(fakeAgent.newSessions[3]?._meta)).not.toContain(
      'Carry this task through replacement'
    )
  })

  it('clears handoff continuity when its Session is deleted', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Delete this task' })

    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(() =>
      runtime.createClaudeCodeContinuationRequest({
        sessionId: session.sessionId,
        switchReadBack: {
          status: 'approved',
          operation: 'switch',
          binding: {
            sessionId: session.sessionId,
            specialistId: 'specialist-1',
            targetName: 'Target Specialist'
          }
        }
      })
    ).toThrow('No user task is available')
  })

  it('clears handoff continuity after an unexpected protocol close', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'Interrupted task' })

    process.stdout.end()
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))

    expect(() =>
      runtime.createClaudeCodeContinuationRequest({
        sessionId: session.sessionId,
        switchReadBack: {
          status: 'approved',
          operation: 'switch',
          binding: {
            sessionId: session.sessionId,
            specialistId: 'specialist-1',
            targetName: 'Target Specialist'
          }
        }
      })
    ).toThrow('No user task is available')
  })

  it('preserves a generic Internal resume error as authoritative', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], { resumeInternalError: true })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({
        sessionId: 'restarted-session',
        cwd: '/workspace'
      })
    ).rejects.toMatchObject({ code: -32603, message: 'Internal error' })
    expect(fakeAgent.newSessions).toEqual([])
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

  it('adopts a fresh Codex session when an app-facing id is not a valid Codex UUID', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['019fb8c8-6c66-7f22-9653-17b5b287dbbb'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      resumeInternalErrorDetails:
        'invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `s` at 1'
    })
    const messageEvents: Array<{ sessionId?: string; role?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'message') {
            messageEvents.push({ sessionId: event.sessionId, role: event.role, text: event.text })
          }
        }
      }
    })

    const resumed = await runtime.resumeSession({
      sessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
      cwd: '/workspace',
      previousFrameworkId: 'codex'
    })
    expect(resumed).toMatchObject({
      sessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
      contextReset: true
    })
    expect(fakeAgent.resumedSessions).toEqual([])
    expect(fakeAgent.newSessions).toHaveLength(1)

    await runtime.sendPrompt({
      sessionId: resumed.sessionId,
      text: 'continue the analysis',
      historyPreamble: 'PRIOR CONTEXT: the last result was incomplete.'
    })

    expect(fakeAgent.prompts).toEqual([
      {
        sessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
        text: expect.stringContaining('PRIOR CONTEXT: the last result was incomplete.')
      }
    ])
    expect(messageEvents).toEqual(
      expect.arrayContaining([
        {
          sessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
          role: 'user',
          text: 'continue the analysis'
        },
        {
          sessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
          role: 'assistant',
          text: 'reply for 019fb8c8-6c66-7f22-9653-17b5b287dbbb'
        }
      ])
    )
  })

  it('adopts a fresh Claude session instead of resuming an OpenCode session id', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['claude-session-replacement'], {
      resumeInternalErrorDetails:
        'Claude Code returned an error result: Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_03fed93d1ffe1uw7XFraUNPhun" is not a UUID and does not match any session title.'
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({
        sessionId: 'ses_03fed93d1ffe1uw7XFraUNPhun',
        cwd: '/workspace'
      })
    ).resolves.toMatchObject({
      sessionId: 'ses_03fed93d1ffe1uw7XFraUNPhun',
      frameworkId: 'claude-code',
      contextReset: true
    })
    expect(fakeAgent.resumedSessions).toEqual([])
    expect(fakeAgent.newSessions).toHaveLength(1)
  })

  it.each([
    '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
    'urn:uuid:019fb8c8-6c66-7f22-9653-17b5b287dbbb'
  ])('resumes a valid Codex protocol session id: %s', async (sessionId) => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    await expect(
      runtime.resumeSession({
        sessionId,
        cwd: '/workspace',
        previousFrameworkId: 'codex'
      })
    ).resolves.toMatchObject({ sessionId })
    expect(fakeAgent.resumedSessions).toEqual([
      expect.objectContaining({
        sessionId,
        cwd: resolve('/workspace')
      })
    ])
    expect(fakeAgent.newSessions).toEqual([])
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
      providerSessionId: 'opencode-session-1',
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
      providerSessionId: 'shared-session-1',
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
      providerSessionId: 'isolated-session-1',
      cwd: resolve('/workspace'),
      frameworkId: 'codex',
      backendId: 'codex:codex-isolated',
      contextReset: true
    })
    expect(isolatedAgent.resumedSessions).toEqual([])
    expect(isolatedAgent.newSessions).toHaveLength(1)
    expect(sharedAgent.resumedSessions).toEqual([])
  })

  it('refuses native follow-up while a permission request is pending', async () => {
    const process = new FakeAgentProcess()
    const steeringRequests: unknown[] = []
    startPermissionProbeAgent(process, {
      newSessionId: 's1',
      toolCallId: 'pending-command',
      toolTitle: 'Run command',
      advertiseSteering: true,
      onSteer: (params) => steeringRequests.push(params),
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'request permission' })
    await vi.waitFor(() => expect(runtime.getSnapshot().pendingPermissions).toHaveLength(1))

    const result = await runtime.steerFollowUp({
      sessionId: session.sessionId,
      text: 'follow up at the permission boundary'
    })

    const [pendingPermission] = runtime.getSnapshot().pendingPermissions
    runtime.respondToPermission({ requestId: pendingPermission.requestId, optionId: 'reject' })
    await prompt

    expect(result.injected).toBe(false)
    expect(steeringRequests).toEqual([])
  })

  it('returns detached snapshot collections without collapsing hidden event sequence slots', async () => {
    const process = new FakeAgentProcess()
    startPermissionProbeAgent(process, {
      newSessionId: 's1',
      toolCallId: 'snapshot-permission',
      toolTitle: 'Run nested input',
      toolKind: 'execute',
      toolRawInput: { command: 'npm test', metadata: { source: 'provider' } },
      modes: createModes(['read-only', 'agent'], 'agent'),
      permissionOptions: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'request permission' })
    await vi.waitFor(() => expect(runtime.getSnapshot().pendingPermissions).toHaveLength(1))
    const existingEventCount = runtime.getSnapshot().events.length
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'first' }
      }
    })
    // Usage updates consume their normalized event id before being projected into context state. They
    // intentionally remain absent from the visible event log, so the following message keeps the gap.
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 12, size: 128_000 }
    })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-2',
        content: { type: 'text', text: 'second' }
      }
    })

    const snapshot = runtime.getSnapshot()
    const messageEventIds = snapshot.events
      .slice(existingEventCount)
      .map(({ id }) => Number(id.replace('acp-event-', '')))
    expect(messageEventIds).toHaveLength(2)
    expect(messageEventIds[1] - messageEventIds[0]).toBe(2)
    expect(snapshot.contextUsageBySession).toMatchObject({ s1: { used: 12, size: 128_000 } })

    const retainedEventIds = snapshot.events.map(({ id }) => id)
    const retainedEventTitles = snapshot.events.map(({ title }) => title)
    const messageRaw = snapshot.events.find(({ messageId }) => messageId === 'message-1')?.raw as {
      update: { content: { text: string } }
    }
    const contextCategory = snapshot.contextUsageBySession.s1.breakdown?.categories[0]
    const pendingPermission = snapshot.pendingPermissions[0]
    const pendingRawInput = pendingPermission.rawInput as {
      metadata: { source: string }
    }
    const permissionProfile = snapshot.permissionProfiles.s1
    expect(contextCategory).toBeDefined()
    const retainedContextCategoryTokens = contextCategory!.tokens
    messageRaw.update.content.text = 'mutated outside the runtime'
    if (snapshot.events[0]) snapshot.events[0].title = 'mutated outside the runtime'
    contextCategory!.tokens = 999
    pendingRawInput.metadata.source = 'mutated outside the runtime'
    pendingPermission.options[0].name = 'mutated outside the runtime'
    permissionProfile.availableModeIds[0] = 'mutated outside the runtime'
    snapshot.events.length = 0
    delete snapshot.contextUsageBySession.s1

    const retainedSnapshot = runtime.getSnapshot()
    expect(retainedSnapshot.events.map(({ id }) => id)).toEqual(retainedEventIds)
    expect(retainedSnapshot.events.map(({ title }) => title)).toEqual(retainedEventTitles)
    expect(
      (
        retainedSnapshot.events.find(({ messageId }) => messageId === 'message-1')?.raw as {
          update: { content: { text: string } }
        }
      ).update.content.text
    ).toBe('first')
    expect(retainedSnapshot.contextUsageBySession).toMatchObject({
      s1: { used: 12, size: 128_000 }
    })
    expect(retainedSnapshot.contextUsageBySession.s1.breakdown?.categories[0]?.tokens).toBe(
      retainedContextCategoryTokens
    )
    expect(retainedSnapshot.pendingPermissions[0].rawInput).toEqual({
      command: 'npm test',
      metadata: { source: 'provider' }
    })
    expect(retainedSnapshot.pendingPermissions[0].options[0]).toMatchObject({
      optionId: 'allow-once',
      name: 'Allow once'
    })
    expect(retainedSnapshot.permissionProfiles.s1.availableModeIds).toEqual(['read-only', 'agent'])

    runtime.respondToPermission({
      requestId: retainedSnapshot.pendingPermissions[0].requestId,
      optionId: 'reject'
    })
    await prompt
  })

  it('recombines Codex uncached input and cache read for context usage', async () => {
    const process = new FakeAgentProcess()
    const usageSent = createDeferred()
    const finishPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          // Patched codex-acp recombines its exclusive input and cache-read categories.
          update: { sessionUpdate: 'usage_update', used: 15, size: 128000 }
        })
        usageSent.resolve()
        await finishPrompt.promise

        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 15,
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

    expect(usageWhileGenerating).toMatchObject({
      s1: { used: 15, size: 128000 }
    })
    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 15, size: 128000 }
    })
    expect(usageWhileGenerating.s1.breakdown).toMatchObject({
      source: 'estimated',
      tokenizer: 'o200k_base',
      status: 'reconciled',
      categories: expect.arrayContaining([
        expect.objectContaining({ key: 'system', estimated: true }),
        expect.objectContaining({ key: 'messages', estimated: true })
      ])
    })
  })

  it('keeps an MCP tool category across result-only ACP updates', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-1',
        kind: 'other',
        title: 'mcp__open-science-notebook__notebook_execute',
        status: 'in_progress',
        rawInput: 'run notebook cell'
      }
    })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-1',
        kind: 'other',
        status: 'completed',
        rawOutput: 'notebook result data'
      }
    })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 100, size: 128_000 }
    })

    const categories = runtime.getSnapshot().contextUsageBySession.s1.breakdown?.categories
    expect(categories).toContainEqual(expect.objectContaining({ key: 'mcp', estimated: true }))
    expect(categories).not.toContainEqual(expect.objectContaining({ key: 'tools' }))
  })

  it('estimates the exact Claude system prompt after MCP tool-name rewriting', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const counter: TokenCounter = {
      count: (text) => {
        if (text.includes('Call mcp__open-science-notebook__notebook_execute exactly')) return 101
        if (text.includes('Call notebook_execute exactly')) return 17
        return 0
      }
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      contextUsageTracker: new ContextUsageTracker(counter),
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude-agent-acp',
        env: {},
        systemPromptAppends: ['Call notebook_execute exactly']
      }),
      framework: claudeCodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 150, size: 128_000 }
    })

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.categories).toContainEqual({
      key: 'system',
      tokens: 101,
      estimated: true
    })
  })

  it('omits the retired activity schema from bridge-backed Codex context estimates', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const counter: TokenCounter = {
      count: (text) => {
        if (text.includes('mcp__open_science_activity__begin_activity_group')) return 101
        if (text.includes('mcp.open-science-activity.begin_activity_group')) return 17
        return 0
      }
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      contextUsageTracker: new ContextUsageTracker(counter),
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        providerConfiguration: {
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1234/v1',
          headers: { authorization: 'Bearer bridge' }
        }
      }),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 150, size: 128_000 }
    })

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.categories).not.toContainEqual(
      expect.objectContaining({ key: 'mcp' })
    )
  })

  it('publishes the local estimate while a prompt is still generating', async () => {
    const process = new FakeAgentProcess()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s1'], {
      onPrompt: () => finishPrompt.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode-acp',
        env: {},
        contextWindow: 1_000_000,
        contextUsageModel: 'deepseek-v4-flash'
      }),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'analyze these results' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    const usageWhileGenerating = runtime.getSnapshot().contextUsageBySession.s1
    expect(usageWhileGenerating).toMatchObject({
      used: expect.any(Number),
      size: 1_000_000,
      breakdown: {
        source: 'estimated',
        tokenizer: 'cl100k_base',
        model: 'deepseek-v4-flash',
        status: 'preflight',
        difference: 0
      }
    })
    expect(usageWhileGenerating.used).toBeGreaterThan(0)
    expect(usageWhileGenerating.used).toBe(usageWhileGenerating.breakdown?.estimatedTokens)

    finishPrompt.resolve()
    await prompt
  })

  it('publishes a token-only preflight estimate when the model window is unknown', async () => {
    const process = new FakeAgentProcess()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: () => finishPrompt.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'estimate before first usage' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    expect(runtime.getSnapshot().contextUsageBySession.s1).toMatchObject({
      used: expect.any(Number),
      breakdown: {
        status: 'preflight',
        estimatedTokens: expect.any(Number)
      }
    })
    expect(runtime.getSnapshot().contextUsageBySession.s1.size).toBeUndefined()

    finishPrompt.resolve()
    await prompt
  })

  it('keeps the latest Agent total authoritative while preflight refreshes categories', async () => {
    const process = new FakeAgentProcess()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s1'], {
      onPrompt: () => finishPrompt.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 96_000, size: 128_000 }
    })

    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'continue from this context' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    const usageWhileGenerating = runtime.getSnapshot().contextUsageBySession.s1
    expect(usageWhileGenerating.used).toBe(96_000)
    expect(usageWhileGenerating.size).toBe(128_000)
    expect(usageWhileGenerating.breakdown).toMatchObject({
      status: 'preflight',
      estimatedTokens: expect.any(Number)
    })
    expect(usageWhileGenerating.breakdown?.estimatedTokens).not.toBe(96_000)

    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'live-estimate',
        content: { type: 'text', text: 'streamed output updates the local breakdown' }
      }
    })
    const refreshedUsage = runtime.getSnapshot().contextUsageBySession.s1
    expect(refreshedUsage.used).toBe(96_000)
    expect(refreshedUsage.agentUsed).toBe(96_000)

    finishPrompt.resolve()
    await prompt
  })

  it('restores the last reconciled usage when a turn stops without a fresh usage update', async () => {
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
      update: { sessionUpdate: 'usage_update', used: 96_000, size: 128_000 }
    })
    const usageBeforePrompt = runtime.getSnapshot().contextUsageBySession.s1

    await runtime.sendPrompt({ sessionId: 's1', text: 'continue without a usage update' })

    expect(runtime.getSnapshot().contextUsageBySession.s1).toEqual(usageBeforePrompt)
    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.status).toBe('reconciled')
  })

  it('does not auto-compact from a high local estimate before Agent reconciliation', async () => {
    const process = new FakeAgentProcess()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s1'], {
      onPrompt: () => finishPrompt.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude-agent-acp',
        env: {},
        contextWindow: 10,
        contextUsageModel: 'deepseek-v4-flash'
      }),
      framework: claudeCodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({
      sessionId: 's1',
      text: 'This deliberately long prompt makes the local estimate exceed the tiny test window.'
    })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.status).toBe('preflight')
    expect(fakeAgent.prompts.map(({ text }) => text)).not.toContain('/compact')

    finishPrompt.resolve()
    await prompt

    expect(runtime.getSnapshot().contextUsageBySession.s1).toBeUndefined()
  })

  it('reconciles Codex PromptResponse usage when it equals the local estimate', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: ({ sessionId }) => {
        const estimated = runtime.getSnapshot().contextUsageBySession[sessionId]?.used ?? 0
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: estimated,
            inputTokens: estimated,
            outputTokens: 0
          }
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {},
        contextWindow: 128_000
      }),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'match the local estimate' })

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown).toMatchObject({
      status: 'reconciled',
      difference: 0
    })
  })

  it('removes a prompt-scoped Codex Skill estimate when the next turn omits it', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-context-skill-'))
    const skillPath = join(temporaryRoot, 'skills', 'research', 'SKILL.md')
    await mkdir(join(temporaryRoot, 'skills', 'research'), { recursive: true })
    await writeFile(skillPath, 'research skill instructions')

    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      skills: {
        needForceLoad: vi.fn(async () => []),
        namesForIds: vi.fn(async (ids: string[]) => ids),
        descriptorsForIds: vi.fn(async (ids: string[]) =>
          ids.includes('research') ? [{ name: 'research', path: skillPath }] : []
        ),
        catalogForCodexHome: vi.fn(async () => [])
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 's1',
      text: 'use the research skill',
      forcedSkillIds: ['research']
    })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 100, size: 128_000 }
    })
    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.categories).toContainEqual(
      expect.objectContaining({ key: 'skills' })
    )

    await runtime.sendPrompt({ sessionId: 's1', text: 'continue without a skill' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 120, size: 128_000 }
    })

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown?.categories).not.toContainEqual(
      expect.objectContaining({ key: 'skills' })
    )
  })

  it('tokenizes context with the upstream model instead of the ACP framework default', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: async () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude-agent-acp',
        env: {},
        contextUsageModel: 'deepseek-v4-flash'
      }),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'nb' })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 12, size: 1_000_000 }
    })

    expect(runtime.getSnapshot().contextUsageBySession.s1.breakdown).toMatchObject({
      tokenizer: 'cl100k_base',
      model: 'deepseek-v4-flash',
      categories: expect.arrayContaining([expect.objectContaining({ key: 'mcp', estimated: true })])
    })
  })

  it('rolls back the context estimate when an Agent prompt fails', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      onPrompt: () => {
        throw new Error('provider rejected prompt')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 12, size: 128000 }
    })
    const beforeFailure = runtime.getSnapshot().contextUsageBySession.s1

    await expect(
      runtime.sendPrompt({ sessionId: 's1', text: 'failed prompt content must roll back' })
    ).rejects.toThrow()

    expect(runtime.getSnapshot().contextUsageBySession.s1).toEqual(beforeFailure)
  })

  it('publishes an interrupted Plan after a provider prompt fails and releases the interaction', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      onPrompt: () => {
        throw new Error('provider rejected prompt')
      }
    })
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: { onEvent: (event) => events.push(event) }
    })
    const interruptedProjection = {
      artifactId: 'artifact-version-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'a'.repeat(64),
      revision: 4,
      approval: 'approved',
      lifecycle: 'interrupted',
      requiresExplicitContinuation: true,
      document: {
        schema_version: 1,
        task_summary: 'Analyze one dataset',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: ['Analysis result'],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      stepStatuses: {
        'Analyze the data': { status: 'in_progress', updatedAt: 42 }
      },
      stepStates: { 'Analyze the data': { status: 'in_progress' } },
      counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
    } satisfies ActivePlanProjection
    const getProjection = vi.fn(async () => interruptedProjection)
    installPromptPlanTestWorkflow(runtime, { getProjection })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await expect(runtime.sendPrompt({ sessionId: 's1', text: 'run the plan' })).rejects.toThrow()

    expect(getProjection).toHaveBeenCalledWith('project-1', 's1', {
      interactionIsLive: false
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'plan',
        sessionId: 's1',
        planProjection: expect.objectContaining({ lifecycle: 'interrupted' })
      })
    )
  })

  it.each([
    ['Claude Code', claudeCodeFramework],
    ['Codex', codexFramework],
    ['OpenCode', opencodeFramework]
  ] as const)(
    'binds %s explicit continuation to one durable Plan version and protected context',
    async (_name, framework) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['s1'], {
        modes:
          framework.id === 'codex'
            ? createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
            : undefined
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework
      })
      const active = {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-7',
        artifactChecksum: 'a'.repeat(64),
        originatingPromptMessageId: 'plan-origin',
        revision: 11,
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: false,
        document: {
          schema_version: 1,
          task_summary: 'Analyze one dataset',
          phases: [
            {
              name: 'Analysis',
              delegations: [
                {
                  name: 'Primary agent',
                  steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
                }
              ]
            }
          ],
          desired_outputs: ['Analysis result'],
          feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
        },
        stepStatuses: {},
        stepStates: { 'Analyze data': { status: 'not_started' } },
        counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
      } satisfies ActivePlanProjection
      const authorizeContinuation = vi.fn(async () => active)
      installPromptPlanTestWorkflow(runtime, {
        authorizeContinuation,
        getProjection: vi.fn(async () => active)
      })

      await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
      await runtime.sendPrompt({
        sessionId: 's1',
        text: 'continue',
        planContinuation: {
          projectId: 'project-1',
          artifactVersionId: 'version-7',
          expectedRevision: 11
        },
        provenanceContext: {
          promptMessageId: 'continuation-message',
          messageAncestry: ['plan-origin', 'continuation-message']
        }
      })

      expect(authorizeContinuation).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 's1',
        artifactVersionId: 'version-7',
        expectedRevision: 11
      })
      expect(fakeAgent.prompts[0]?.text).toContain('<open_science_protected_plan_context>')
      expect(fakeAgent.prompts[0]?.text).toContain('approval=approved lifecycle=approved')
      expect(fakeAgent.prompts[0]?.text).not.toContain('artifact_version_id=')
      expect(fakeAgent.prompts[0]?.text).toContain('Analyze data: not_started')
      expect(fakeAgent.prompts[0]?.text).toContain('continue')
    }
  )

  it('rejects an explicit Plan continuation from a sibling Message Branch', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })
    const active = restoredPlanProjection('approved', 4)
    installPromptPlanTestWorkflow(
      runtime,
      { authorizeContinuation: vi.fn(async () => active) },
      durablePlanSessions(['branch-b-root', 'branch-b-message'])
    )

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await expect(
      runtime.sendPrompt({
        sessionId: 's1',
        text: 'continue a sibling plan',
        planContinuation: {
          projectId: 'project-1',
          artifactVersionId: 'version-1',
          expectedRevision: 4
        },
        provenanceContext: {
          promptMessageId: 'branch-b-message',
          messageAncestry: ['plan-origin', 'branch-b-root', 'branch-b-message']
        }
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(fakeAgent.prompts).toHaveLength(0)
  })

  it.each([
    ['Claude Code', claudeCodeFramework],
    ['Codex', codexFramework],
    ['OpenCode', opencodeFramework]
  ] as const)(
    'lets %s finish a Conversation Turn while its Session Plan remains incomplete',
    async (_name, framework) => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, ['s1'], {
        modes:
          framework.id === 'codex'
            ? createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
            : undefined,
        onPrompt: () => ({ stopReason: 'end_turn' })
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework
      })
      const getProjection = vi.fn(async () => null)
      const authorized = {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'a'.repeat(64),
        originatingPromptMessageId: 'plan-origin',
        revision: 2,
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: false,
        document: {
          schema_version: 1,
          task_summary: 'Analyze data',
          phases: [
            {
              name: 'Analysis',
              delegations: [
                {
                  name: 'Main Agent',
                  steps: [{ title: 'Analyze', description: 'Analyze the data.' }]
                }
              ]
            }
          ],
          desired_outputs: ['Result'],
          feasibility: { confidence: 'high', rationale: 'Ready.' }
        },
        stepStatuses: {},
        stepStates: { Analyze: { status: 'not_started' } },
        counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
      } satisfies ActivePlanProjection
      installPromptPlanTestWorkflow(runtime, {
        authorizeContinuation: vi.fn(async () => authorized),
        getProjection
      })

      await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
      await expect(
        runtime.sendPrompt({
          sessionId: 's1',
          text: 'finish this turn',
          planContinuation: {
            projectId: 'project-1',
            artifactVersionId: 'version-1',
            expectedRevision: 2
          },
          provenanceContext: {
            promptMessageId: 'completion-message',
            messageAncestry: ['plan-origin', 'completion-message']
          }
        })
      ).resolves.toMatchObject({ stopReason: 'end_turn' })
    }
  )

  it('lets an unrelated ordinary message finish without resuming an approved Plan', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })
    installPromptPlanTestWorkflow(runtime, {
      getProjection: vi.fn(async () => null)
    })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await expect(
      runtime.sendPrompt({ sessionId: 's1', text: 'What is the weather?' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(fakeAgent.prompts[0]?.text).not.toContain('<open_science_protected_plan_context>')
  })

  it('projects an abnormal provider terminal stop as interrupted', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: () => ({ stopReason: 'max_tokens' })
    })
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      callbacks: { onEvent: (event) => events.push(event) }
    })
    const getProjection = vi.fn(
      async () =>
        ({
          lifecycle: 'interrupted'
        }) as ActivePlanProjection
    )
    installPromptPlanTestWorkflow(runtime, { getProjection })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    await expect(
      runtime.sendPrompt({ sessionId: 's1', text: 'run the plan' })
    ).resolves.toMatchObject({ stopReason: 'max_tokens' })

    expect(getProjection).toHaveBeenCalledWith('project-1', 's1', {
      interactionIsLive: false
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'plan',
        planProjection: expect.objectContaining({ lifecycle: 'interrupted' })
      })
    )
  })

  it('retains partial turn context when an Agent prompt fails after streaming updates', async () => {
    const process = new FakeAgentProcess()
    let promptAttempt = 0
    let secondTurnEstimate: AcpContextUsage['breakdown'] | undefined
    startFakeAgent(process, ['s1'], {
      onPrompt: ({ sessionId }) => {
        promptAttempt += 1
        if (promptAttempt === 1) {
          handleSessionUpdate(runtime, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'partial-reply',
              content: { type: 'text', text: 'partial assistant output retained by the provider' }
            }
          })
          handleSessionUpdate(runtime, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'partial-tool',
              status: 'completed',
              rawOutput: { result: 'partial tool output retained by the provider' }
            }
          })
          throw new Error('provider failed after partial output')
        }

        secondTurnEstimate = runtime.getSnapshot().contextUsageBySession[sessionId]?.breakdown
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 12, size: 128000 }
    })
    const usageBeforeFailure = runtime.getSnapshot().contextUsageBySession.s1

    await expect(
      runtime.sendPrompt({ sessionId: 's1', text: 'fail after using a tool' })
    ).rejects.toThrow()

    expect(runtime.getSnapshot().contextUsageBySession.s1).toEqual(usageBeforeFailure)

    await runtime.sendPrompt({ sessionId: 's1', text: 'continue the retained turn' })

    expect(secondTurnEstimate?.categories).toContainEqual(
      expect.objectContaining({ key: 'tools', estimated: true })
    )
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

      expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
        s1: { used: 15, size: 1_000_000 }
      })
    }
  )

  it('publishes a prompt terminal event exactly once when its callback throws', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'stop') throw new Error('stop callback failed')
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await expect(runtime.sendPrompt({ sessionId: 's1', text: 'hi' })).rejects.toThrow(
      'stop callback failed'
    )

    expect(
      runtime
        .getSnapshot()
        .events.filter((event) => event.kind === 'stop' || event.kind === 'error')
        .map((event) => event.kind)
    ).toEqual(['stop'])
  })

  it.each(['connection close', 'context reset'] as const)(
    'keeps an observed OpenCode stop authoritative through %s during usage collection',
    async (disruption) => {
      const process = new FakeAgentProcess()
      const replacementStarted = createDeferred()
      const releaseReplacement = createDeferred<PromptResponse>()
      let runtime!: AcpRuntime
      const fakeAgent = startFakeAgent(process, ['s1', 's2'], {
        onPrompt: ({ text }) => {
          if (!text.includes('replacement prompt')) return undefined
          replacementStarted.resolve()
          return releaseReplacement.promise
        }
      })
      const finalUsageStarted = createDeferred()
      const releaseFinalUsage = createDeferred()
      let usageFetchCount = 0
      const opencodeUsageFetch = vi.fn(async () => {
        usageFetchCount += 1
        if (usageFetchCount === 2) {
          finalUsageStarted.resolve()
          await releaseFinalUsage.promise
        }
        return new Response(JSON.stringify([]), {
          headers: { 'content-type': 'application/json' }
        })
      })
      const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
      try {
        runtime = new AcpRuntime({
          appVersion: '0.1.0',
          defaultCwd: '/workspace',
          resolveBackend: () => ({
            framework,
            executablePath: '/bin/opencode',
            env: {},
            opencodeUsageApi: {
              baseUrl: 'http://127.0.0.1:4242',
              authorization: 'Basic test'
            }
          }),
          framework,
          opencodeUsageFetch
        })

        await runtime.createSession({ cwd: '/workspace' })
        now.mockReturnValue(1234)
        const prompt = runtime.sendPrompt({
          sessionId: 's1',
          text: 'hi',
          suppressUserMessage: true,
          provenanceContext: { promptMessageId: 'terminal-race-prompt' }
        })
        await finalUsageStarted.promise

        if (disruption === 'connection close') {
          process.stdout.end()
          await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('closed'))
        } else {
          const reset = runtime.resetSessionContext({ sessionId: 's1', cwd: '/workspace' })
          await vi.waitFor(() => expect(fakeAgent.newSessions).toHaveLength(2))
          await reset
        }

        const replacement =
          disruption === 'context reset'
            ? runtime.sendPrompt({ sessionId: 's1', text: 'replacement prompt' })
            : undefined
        if (replacement) {
          await vi.waitFor(() =>
            expect(runtime.getSnapshot().promptInFlightSessionIds).toContain('s1')
          )
          handleSessionUpdate(runtime, {
            sessionId: 's2',
            update: { sessionUpdate: 'usage_update', used: 95, size: 100 }
          })
        }

        now.mockReturnValue(5678)
        releaseFinalUsage.resolve()
        await vi.waitFor(() =>
          expect(
            runtime
              .getSnapshot()
              .events.some(
                (event) => event.promptMessageId === 'terminal-race-prompt' && event.kind === 'stop'
              )
          ).toBe(true)
        )
        await prompt

        expect(
          runtime
            .getSnapshot()
            .events.filter(
              (event) =>
                event.promptMessageId === 'terminal-race-prompt' &&
                (event.kind === 'stop' || event.kind === 'error')
            )
            .map((event) => ({ kind: event.kind, timestamp: event.timestamp }))
        ).toEqual([{ kind: 'stop', timestamp: 1234 }])

        if (replacement) {
          await replacementStarted.promise
          expect(fakeAgent.prompts.some((sent) => sent.text === '/compact')).toBe(false)
          releaseReplacement.resolve({ stopReason: 'end_turn' })
          await replacement
        }
      } finally {
        now.mockRestore()
      }
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
    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 15, size: 200000 }
    })

    sendSecondUsage.resolve()
    await secondUsageSent.promise
    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 24, size: 200000 }
    })

    finishPrompt.resolve()
    await prompt

    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 24, size: 200000 }
    })
    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')).toMatchObject({
      turnUsage: {
        inputTokens: 31,
        cacheTokens: 15,
        outputTokens: 14
      }
    })
  })

  it('attaches Claude SDK model-turn counts to completed turn usage', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      claudeTurnCountForPrompt: () => 3,
      onPrompt: () => ({
        stopReason: 'end_turn',
        usage: {
          totalTokens: 60,
          inputTokens: 31,
          cachedReadTokens: 8,
          cachedWriteTokens: 7,
          outputTokens: 14
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'use tools' })

    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')?.turnUsage).toEqual({
      inputTokens: 31,
      cacheTokens: 15,
      cachedReadTokens: 8,
      cachedWriteTokens: 7,
      outputTokens: 14,
      turnCount: 3
    })
  })

  it('excludes autonomous Claude result lanes from the user prompt model-turn count', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      claudeResultMessagesForPrompt: () => [
        ...['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity'].map(
          (origin) => ({ numTurns: 100, origin })
        ),
        { numTurns: 2, origin: 'human' },
        // Unknown future origins remain eligible so a newly introduced user-driven lane does not
        // silently under-report model turns until Open Science knows its name.
        { numTurns: 3, origin: 'future-user-lane' }
      ],
      onPrompt: () => ({
        stopReason: 'end_turn',
        usage: {
          totalTokens: 60,
          inputTokens: 31,
          cachedReadTokens: 8,
          cachedWriteTokens: 7,
          outputTokens: 14
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'use tools' })

    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')?.turnUsage).toEqual({
      inputTokens: 31,
      cacheTokens: 15,
      cachedReadTokens: 8,
      cachedWriteTokens: 7,
      outputTokens: 14,
      turnCount: 5
    })
  })

  it('falls back to an unpatched Codex latest request usage at stop', async () => {
    const process = new FakeAgentProcess()
    const usageSent = createDeferred()
    const finishPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async ({ sessionId }) => {
        handleSessionUpdate(runtime, {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 15, size: 128000 }
        })
        usageSent.resolve()
        await finishPrompt.promise
        return {
          stopReason: 'end_turn',
          usage: {
            totalTokens: 15,
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
    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 15, size: 128000 }
    })

    finishPrompt.resolve()
    await prompt

    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 15, size: 128000 }
    })
    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')?.turnUsage).toEqual({
      inputTokens: 12,
      cacheTokens: 3,
      cachedReadTokens: 3,
      cachedWriteTokens: 0,
      outputTokens: 3
    })
  })

  it('keeps managed Codex turn totals separate from its latest context snapshot', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: () => ({
        stopReason: 'end_turn',
        usage: {
          totalTokens: 22,
          inputTokens: 19,
          cachedReadTokens: 5,
          outputTokens: 3
        },
        _meta: {
          'open-science/turn-usage': {
            totalTokens: 45,
            inputTokens: 31,
            cachedReadTokens: 8,
            cachedWriteTokens: 7,
            outputTokens: 14
          },
          'open-science/model-turn-count': 2
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'use a tool and summarize' })

    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 24 }
    })
    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')).toMatchObject({
      turnUsage: {
        inputTokens: 31,
        cacheTokens: 15,
        cachedReadTokens: 8,
        cachedWriteTokens: 7,
        outputTokens: 14,
        turnCount: 2
      }
    })
  })

  it('keeps Codex bridge usage visible when the adapter omits whole-turn metadata', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: () => ({
        stopReason: 'end_turn',
        // A Responses bridge still returns standard ACP usage even when its adapter does not publish
        // Open Science's private whole-turn metadata. The footer must not become entirely unavailable.
        usage: {
          totalTokens: 27,
          inputTokens: 19,
          cachedReadTokens: 5,
          outputTokens: 3
        }
      })
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'answer through the bridge' })

    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')).toMatchObject({
      turnUsage: { inputTokens: 19, cacheTokens: 5, outputTokens: 3 }
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

    expect(runtime.getSnapshot().contextUsageBySession).toMatchObject({
      s1: { used: 15, size: 128000 }
    })
  })

  it('sums every OpenCode assistant model step created by one prompt turn', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'], {
      onPrompt: () => ({
        stopReason: 'end_turn',
        // OpenCode ACP currently exposes only the final assistant record here.
        usage: {
          totalTokens: 27,
          inputTokens: 19,
          cachedReadTokens: 5,
          outputTokens: 3
        }
      })
    })
    const messageSnapshots = [
      [{ info: { id: 'old', role: 'assistant' } }],
      [
        { info: { id: 'old', role: 'assistant' } },
        {
          info: {
            id: 'step-1',
            role: 'assistant',
            tokens: { input: 12, output: 2, reasoning: 0, cache: { read: 3, write: 0 } }
          }
        },
        {
          info: {
            id: 'step-2',
            role: 'assistant',
            tokens: { input: 19, output: 3, reasoning: 0, cache: { read: 5, write: 0 } }
          }
        }
      ]
    ]
    const opencodeUsageFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(messageSnapshots.shift() ?? []), {
          headers: { 'content-type': 'application/json' }
        })
    )
    const framework = { ...opencodeFramework, spawn: () => asAgentProcess(process) }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework,
        executablePath: '/bin/opencode',
        env: {},
        opencodeUsageApi: {
          baseUrl: 'http://127.0.0.1:4242',
          authorization: 'Basic test'
        }
      }),
      framework,
      opencodeUsageFetch
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 's1', text: 'use a tool and summarize' })

    expect(opencodeUsageFetch).toHaveBeenCalledTimes(2)
    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')).toMatchObject({
      turnUsage: { inputTokens: 31, cacheTokens: 8, outputTokens: 5 }
    })
  })

  it('defers a provider reconnect until an in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    const usageSent = createDeferred()
    const states: string[] = []
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
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onStateChanged: (snapshot) => states.push(snapshot.status) }
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
    expect(runtime.getSnapshot().status).toBe('idle')
    expect(states).not.toContain('closed')
    expect(runtime.getSnapshot().contextUsageBySession).toEqual({})
  })

  it('does not restore superseded context usage when a prompt fails during provider reconnect', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const failPrompt = createDeferred()
    startFakeAgent(process, ['s1'], {
      onPrompt: async () => {
        promptStarted.resolve()
        await failPrompt.promise
        throw new Error('old provider rejected prompt')
      }
    })
    const snapshots: AcpStateSnapshot[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode-acp',
        env: {},
        contextWindow: 128_000
      }),
      framework: opencodeFramework,
      callbacks: { onStateChanged: (snapshot) => snapshots.push(snapshot as AcpStateSnapshot) }
    })

    await runtime.createSession({ cwd: '/workspace' })
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 6400, size: 128000 }
    })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'continue on old provider' })
    await promptStarted.promise
    await runtime.requestProviderReconnect()
    const clearedSnapshotIndex = snapshots.length - 1
    handleSessionUpdate(runtime, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'superseded-output',
        content: { type: 'text', text: 'late output from old provider' }
      }
    })

    failPrompt.resolve()
    await expect(prompt).rejects.toThrow()

    expect(
      snapshots
        .slice(clearedSnapshotIndex)
        .some((snapshot) => Object.hasOwn(snapshot.contextUsageBySession, 's1'))
    ).toBe(false)
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

  it('lets retirement supersede a deferred provider reconnect exactly once', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const releasePrompt = createDeferred()
    const onRetired = vi.fn()
    const states: string[] = []
    startFakeAgent(process, ['s1'], {
      onPrompt: async () => {
        promptStarted.resolve()
        await releasePrompt.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onRetired,
        onStateChanged: (snapshot) => states.push(snapshot.status)
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })
    await promptStarted.promise
    states.length = 0

    await runtime.requestProviderReconnect()
    await runtime.requestRetirement()
    expect(process.killed).toBe(false)
    expect(onRetired).not.toHaveBeenCalled()

    releasePrompt.resolve()
    await prompt
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce())

    expect(process.killed).toBe(true)
    expect(states).not.toContain('idle')
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
          providerId: 'openai',
          apiType: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          headers: { authorization: 'Bearer bridge' }
        },
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
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

  it('completes reviewer cleanup before propagating a session disposal failure', async () => {
    const process = new FakeAgentProcess()
    const registerReviewerSession = vi.fn()
    const unregisterReviewerSession = vi.fn(() => true)
    const releaseBridge = vi.fn(async () => undefined)
    const fakeAgent = startFakeAgent(process, ['reviewer-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {},
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
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
    const reviewerCwd = fakeAgent.newSessions[0]!.cwd

    await runtime.requestProviderReconnect()
    expect(process.killed).toBe(false)

    vi.spyOn(session, 'dispose').mockImplementationOnce(() => {
      throw new Error('reviewer dispose failed')
    })

    expect(() => runtime.disposeReviewerSession(session)).toThrow('reviewer dispose failed')

    expect(unregisterReviewerSession).toHaveBeenCalledWith('reviewer-session-1')
    await expect(stat(reviewerCwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.waitFor(() => expect(process.killed).toBe(true))
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
          selectSkills: vi.fn(async () => []),
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

  it('keeps a retiring runtime alive until every nested withActivity lease is released', async () => {
    // Nested withActivity calls stack the lease counter; retirement is gated on hasRetirementBlockingActivity
    // which only returns false once every nested lease has run its finally. We probe the counter via the
    // public observable: requestRetirement must not kill the agent process while any inner lease still
    // holds, even after a sibling nest-mate returns.
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const innerStarted = createDeferred()
    const releaseInner = createDeferred()
    const outerStarted = createDeferred()
    const releaseOuter = createDeferred()

    const inner = runtime.withActivity({}, async () => {
      innerStarted.resolve()
      await releaseInner.promise
    })
    await innerStarted.promise

    // Outer enters while inner is still in flight → lease counter is 2.
    const outer = runtime.withActivity({}, async () => {
      outerStarted.resolve()
      await releaseOuter.promise
    })
    await outerStarted.promise

    await runtime.requestRetirement()
    expect(process.killed).toBe(false)

    // Releasing the inner only drops the counter to 1; outer still owns a lease, so retirement must stay
    // deferred. This is the edge the existing single-lease test does not cover.
    releaseInner.resolve()
    await inner
    await new Promise((resolve) => setTimeout(resolve, 0))

    await runtime.requestRetirement()
    expect(process.killed).toBe(false)

    // Both leases released → finally chain on the outer finally drives the deferred retirement, and the
    // agent process is reaped exactly once.
    releaseOuter.resolve()
    await outer
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(process.killed).toBe(true)
  })

  it('releases the withActivity lease through finally when the work function throws', async () => {
    // The lease counter is decremented inside the same try/finally as the awaiting of `work`. A throw
    // must take the finally branch — otherwise the activity would leak leases on every error path and
    // retirement would never fire. We assert the public consequence: once the work promise rejects,
    // requestRetirement can retire the generation immediately.
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const boom = new Error('workflow blew up')
    const activityStarted = createDeferred()
    const activity = runtime.withActivity({}, async () => {
      activityStarted.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      throw boom
    })

    await activityStarted.promise
    await expect(activity).rejects.toBe(boom)

    // The lease must be back to 0 by now — the finally block ran before the rejection surfaced.
    // Retirement therefore fires synchronously here; no second setTimeout is needed.
    await runtime.requestRetirement()
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

  it('resumeSession renews its stable identity after waiting for a pending provider reconnect', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    const resumedSessionId = '123e4567-e89b-42d3-a456-426614174000'
    startFakeAgent(oldProcess, ['s1'], { onPrompt: () => gate.promise })
    const newAgent = startFakeAgent(newProcess, [])

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
    await runtime.requestProviderReconnect()

    const resumed = runtime.resumeSession({ sessionId: resumedSessionId, cwd: '/workspace' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(newAgent.resumedSessions).toEqual([])

    gate.resolve()
    await prompt

    await expect(resumed).resolves.toMatchObject({ sessionId: resumedSessionId })
    expect(newAgent.resumedSessions).toEqual([
      expect.objectContaining({ sessionId: resumedSessionId })
    ])
    expect(spawnCount).toBe(2)
  })

  it('resetSessionContext renews its published app identity after a pending reconnect', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(oldProcess, ['stable-app-session'], { onPrompt: () => gate.promise })
    const newAgent = startFakeAgent(newProcess, ['replacement-provider-session'])

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
    const prompt = runtime.sendPrompt({ sessionId: 'stable-app-session', text: 'hi' })
    await runtime.requestProviderReconnect()

    const reset = runtime.resetSessionContext({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(newAgent.newSessions).toEqual([])

    gate.resolve()
    await prompt

    await expect(reset).resolves.toMatchObject({
      sessionId: 'stable-app-session',
      contextReset: true
    })
    await runtime.sendPrompt({ sessionId: 'stable-app-session', text: 'replacement turn' })
    expect(newAgent.prompts.at(-1)).toMatchObject({
      sessionId: 'replacement-provider-session'
    })
    expect(spawnCount).toBe(2)
  })

  it.each([
    {
      operation: 'resume',
      interruption: 'delete',
      sessionId: '123e4567-e89b-42d3-a456-426614174000'
    },
    {
      operation: 'context reset',
      interruption: 'delete',
      sessionId: 'stable-app-session'
    },
    {
      operation: 'resume',
      interruption: 'disconnect',
      sessionId: '123e4567-e89b-42d3-a456-426614174000'
    },
    {
      operation: 'context reset',
      interruption: 'disconnect',
      sessionId: 'stable-app-session'
    }
  ])(
    'rejects a pending $operation after a second $interruption invalidation',
    async ({ operation, interruption, sessionId }) => {
      const oldProcess = new FakeAgentProcess()
      const newProcess = new FakeAgentProcess()
      const promptGate = createDeferred()
      startFakeAgent(oldProcess, ['stable-app-session'], {
        onPrompt: () => promptGate.promise
      })
      const newAgent = startFakeAgent(newProcess, ['unexpected-provider-session'])

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
      const prompt = runtime.sendPrompt({ sessionId: 'stable-app-session', text: 'hi' })
      await runtime.requestProviderReconnect()

      const connectionReady = createDeferred()
      const releaseEnsureConnected = createDeferred()
      const internal = runtime as unknown as {
        connectionLifecycle: { ensureConnected: (cwd: string) => Promise<unknown> }
      }
      const ensureConnected = internal.connectionLifecycle.ensureConnected.bind(
        internal.connectionLifecycle
      )
      vi.spyOn(internal.connectionLifecycle, 'ensureConnected').mockImplementationOnce(
        async (cwd) => {
          const connection = await ensureConnected(cwd)
          connectionReady.resolve()
          await releaseEnsureConnected.promise
          return connection
        }
      )

      const pending =
        operation === 'context reset'
          ? runtime.resetSessionContext({ sessionId, cwd: '/workspace' })
          : runtime.resumeSession({ sessionId, cwd: '/workspace' })

      promptGate.resolve()
      await prompt
      await connectionReady.promise

      if (interruption === 'delete') {
        await runtime.deleteSession({ sessionId })
        releaseEnsureConnected.resolve()
      } else {
        // Resolving the wrapper queues the startup continuation. disconnect() invalidates its
        // generation and clears the just-returned connection synchronously before yielding.
        releaseEnsureConnected.resolve()
        await runtime.disconnect()
      }

      try {
        await expect(pending).rejects.toThrow('ACP session startup was superseded.')
        expect(newAgent.newSessions).toEqual([])
        expect(newAgent.resumedSessions).toEqual([])
        expect(runtime.getSnapshot().sessionIds).not.toContain(sessionId)
      } finally {
        promptGate.resolve()
        releaseEnsureConnected.resolve()
        await pending.catch(() => undefined)
        await runtime.disconnect().catch(() => undefined)
      }
    }
  )

  it('blocks a same-id reset while deletion is in flight and allows retry after deletion fails', async () => {
    const process = new FakeAgentProcess()
    const closeStarted = createDeferred()
    const releaseClose = createDeferred()
    const deleteFailure = new Error('agent delete failed')
    const fakeAgent = startFakeAgent(
      process,
      ['stable-app-session', 'replacement-provider-session'],
      {
        onClose: async () => {
          closeStarted.resolve()
          await releaseClose.promise
          throw deleteFailure
        }
      }
    )
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const deleting = runtime.deleteSession({ sessionId: 'stable-app-session' })
    await closeStarted.promise
    const resetWhileDeleting = runtime.resetSessionContext({
      sessionId: 'stable-app-session',
      cwd: '/workspace'
    })

    try {
      await expect(resetWhileDeleting).rejects.toThrow(
        'Primary session id collision with deletion in progress: stable-app-session'
      )
      expect(fakeAgent.newSessions).toHaveLength(1)

      releaseClose.resolve()
      await expect(deleting).rejects.toMatchObject({
        code: -32603,
        data: { details: deleteFailure.message }
      })

      await expect(
        runtime.resetSessionContext({
          sessionId: 'stable-app-session',
          cwd: '/workspace'
        })
      ).resolves.toMatchObject({
        sessionId: 'stable-app-session',
        contextReset: true
      })
      expect(fakeAgent.newSessions).toHaveLength(2)
    } finally {
      releaseClose.resolve()
      await deleting.catch(() => undefined)
      await resetWhileDeleting.catch(() => undefined)
      await runtime.deleteSession({ sessionId: 'stable-app-session' }).catch(() => undefined)
      await runtime.disconnect().catch(() => undefined)
    }
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
    const states: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onStateChanged: (snapshot) => states.push(snapshot.status) }
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestProviderReconnect()

    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().status).toBe('idle')
    expect(states).not.toContain('closed')
  })

  it('does not let a stale planned reconnect overwrite a newer connection status', async () => {
    const oldProcess = new FakeAgentProcess()
    const newProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['s1'])
    startFakeAgent(newProcess, ['s2'])
    const teardownStarted = createDeferred()
    const releaseTeardown = createDeferred()
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => asAgentProcess(spawnCount++ === 0 ? oldProcess : newProcess)
        },
        executablePath: '/bin/agent',
        env: {}
      })
    })

    await runtime.createSession({ cwd: '/workspace' })
    vi.mocked(terminateProcessTree).mockImplementationOnce(async (child) => {
      child?.kill()
      teardownStarted.resolve()
      await releaseTeardown.promise
      return { reaped: true }
    })
    const reconnect = runtime.requestProviderReconnect()
    await teardownStarted.promise

    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).resolves.toMatchObject({
        sessionId: 's2'
      })
      expect(runtime.getSnapshot().status).toBe('connected')
    } finally {
      releaseTeardown.resolve()
      await reconnect
    }

    expect(runtime.getSnapshot().status).toBe('connected')
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
        projectId: 'default-project',
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
    // Skill contents are hidden by the UI projection; the agent prompt must not block native loading.
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.not.stringContaining('open_science_skill_privacy_instructions')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.not.stringContaining('open_science_skill_privacy_instructions')
      }
    })
  })

  it('scopes the artifact MCP project to a caller-supplied projectId on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace', projectId: 'project-abc' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace',
      projectId: 'project-xyz'
    })

    // The per-session projectId (not the runtime default) reaches the artifact MCP server config.
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_ID')
    ).toBe('project-abc')
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_ID')
    ).toBe('project-xyz')
  })

  it('falls back to the runtime default projectId when none is supplied', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_ID')
    ).toBe('default-project')
  })

  it('passes notebook MCP server and scoped notebook instructions to new and resumed sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const aliases: Array<{ aliasSessionId: string; sessionId: string }> = []
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token'
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science',
        getRpcConnection,
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
    expect(getRpcConnection).toHaveBeenNthCalledWith(1, {
      sessionId: getEnvValue(
        fakeAgent.newSessions[0].mcpServers[0],
        'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'
      ),
      projectId: 'default-project',
      memoryTools: true
    })
    expect(getRpcConnection).toHaveBeenNthCalledWith(2, {
      sessionId: 'remote-session-2',
      projectId: 'default-project',
      memoryTools: true
    })
    expect(fakeAgent.resumedSessions[0].mcpServers).toHaveLength(1)
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
    ).toBe('remote-session-2')
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining(
          '<open_science_notebook_instructions>\nGuidance only applies when using open-science-notebook tools.'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('writable session workspace')
      }
    })
    const createdSessionMeta = JSON.stringify(fakeAgent.newSessions[0]._meta)
    expect(createdSessionMeta).toContain('mcp__open-science-notebook__ask_user_question')
    expect(createdSessionMeta).toContain('mcp__open-science-notebook__notebook_execute')
    expect(createdSessionMeta).not.toContain('`notebook_execute`')
  })

  it('passes the conversation Skill import tool a session-scoped route', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const aliases: Array<{ aliasSessionId: string; sessionId: string }> = []
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token'
    }))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science',
        getRpcConnection,
        registerSessionAlias: (aliasSessionId, sessionId) => {
          aliases.push({ aliasSessionId, sessionId })
        }
      }
    })

    const createdSession = await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      name: 'open-science-skills',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-skill-import-mcp']
    })
    const aliasSessionId = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_SKILL_IMPORT_SESSION_ID'
    )
    expect(aliasSessionId).toMatch(/^skill-import-session-/)
    expect(getRpcConnection).toHaveBeenCalledWith({ sessionId: aliasSessionId })
    expect(aliases).toEqual([{ aliasSessionId, sessionId: createdSession.sessionId }])
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).toContain(
      'mcp__open-science-skills__request_skill_import'
    )
  })

  it('omits the conversation Skill import MCP and prompt guidance when disabled', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token'
    }))
    const registerSessionAlias = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      skillImport: {
        mcpEntryPath: '/app/out/main/index.js',
        isEnabled: async () => false,
        getRpcConnection,
        registerSessionAlias
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.newSessions[0].mcpServers).toEqual([])
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).not.toContain('request_skill_import')
    expect(getRpcConnection).not.toHaveBeenCalled()
    expect(registerSessionAlias).not.toHaveBeenCalled()
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
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectId: 'default-project',
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
        projectId: 'default-project',
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
        projectId: 'default-project',
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

  it('publishes writable connector files without trusting unsupported or unverified results', async () => {
    const storageRoot = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(storageRoot)
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.newSessions[0].mcpServers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'open-science-artifacts' })])
    )
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining(
          'When a Connector or MCP tool creates or returns a user-facing file as inline content or a local source path accepted by `mcp__open-science-artifacts__write_artifact_file`, and the file has not already been saved or attached as an Artifact, call `mcp__open-science-artifacts__write_artifact_file` in the same turn before telling the user that the result is available.'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining(
          'If an Open Science app-owned Connector result includes an `artifact_id`, do not call `mcp__open-science-artifacts__write_artifact_file` again for that file.'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining(
          "Do not treat a custom MCP server's claim by itself as proof that an Artifact exists."
        )
      }
    })
  })

  it('retries transient Artifact claim preparation in the prompt failure cleanup', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const generatedArtifact = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-02T00:00:00.000Z',
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      name: 'result.txt',
      path: '/managed/result.txt',
      fileUrl: 'file:///managed/result.txt',
      mimeType: 'text/plain',
      size: 6,
      mtimeMs: 1
    }
    let listAttempts = 0
    const listRunVersions = vi.fn(async () => {
      listAttempts += 1
      if (listAttempts === 1) throw new Error('temporary Artifact list failure')
      return [generatedArtifact]
    })
    const terminalEvents: AcpRuntimeEvent[] = []
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository,
        provenance: {
          listRunVersions,
          writeAppGeneratedVersion: async () => generatedArtifact
        }
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact' || event.kind === 'stop') terminalEvents.push(event)
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    warnLogSpy.mockImplementation(() => {
      throw new Error('logger failed')
    })
    try {
      await expect(
        runtime.sendPrompt({ sessionId: session.sessionId, text: 'prepare an Artifact claim' })
      ).rejects.toThrow('temporary Artifact list failure')
    } finally {
      warnLogSpy.mockReset()
    }

    expect(listRunVersions).toHaveBeenCalledTimes(2)
    expect(terminalEvents.map((event) => event.kind)).toEqual(['artifact', 'stop'])
    const claim = resolveArtifactRunClaim(runtime, terminalEvents[0].artifactClaimId!)
    expect(claim.artifactVersionIds).toEqual(['version-1'])
    await expect(
      repository.findRunFinalizationMarker('project-1', claim.runId)
    ).resolves.toMatchObject({ artifactVersionIds: ['version-1'] })
  })

  it('emits an artifact event with pending files before a prompt stops', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      promptMessageId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as {
          artifactRunId: string
          agentName?: string
        }

        expect(context.agentName).toBeTruthy()

        await repository.writePendingFile({
          projectId: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.artifactRunId,
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
        projectId: 'default-project',
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
              promptMessageId: event.promptMessageId,
              artifactClaimId: event.artifactClaimId,
              artifactCount: event.artifacts?.length
            })
          } else if (event.kind === 'stop') {
            events.push({ kind: event.kind, sessionId: event.sessionId })
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
        promptMessageId: expect.stringMatching(/^prompt-artifact-run-/),
        artifactClaimId: expect.stringMatching(/^artifact-claim-/),
        artifactCount: 1
      },
      {
        kind: 'stop',
        sessionId: 'remote-session-1'
      }
    ])
    await expect(
      repository.findRunFinalizationMarker('default-project', events[0].runId!)
    ).resolves.toMatchObject({
      sourceSessionId: getEnvValue(
        fakeAgent.newSessions[0].mcpServers[0],
        'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
      ),
      sessionId: 'remote-session-1',
      provenanceContext: {
        promptMessageId: events[0].promptMessageId
      }
    })
    await expect(
      repository.findRunFinalizationMarker('default-project', events[0].runId!)
    ).resolves.not.toHaveProperty('messageId')
  })

  it('drains an accepted app-side Artifact write before freezing the claim and marker', async () => {
    const storageRoot = await createTemporaryRoot()
    const client = createProjectDbClient(storageRoot)
    temporaryDisconnections.push(() => client.$disconnect())
    await migrateApplicationDatabase(client)
    const repository = new ArtifactRepository(storageRoot)
    const durableProvenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: repository
    })
    const writeStarted = createDeferred()
    const releaseWrite = createDeferred()
    const closeStarted = createDeferred()
    const listRunVersions = vi.fn((request) => durableProvenance.listRunVersions(request))
    let appWrite: ReturnType<AcpRuntime['writeArtifactForCurrentRun']> | undefined
    let artifactClaimId: string | undefined
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        appWrite = runtime.writeArtifactForCurrentRun(sessionId, {
          filename: 'late.txt',
          content: 'accepted before stop',
          mimeType: 'text/plain',
          producer: {
            kind: 'connector',
            connectorId: 'molecule',
            toolId: 'preview_molecule',
            invocationId: 'connector-call-late',
            implementationVersion: '1',
            normalizedArguments: { filename: 'late.txt' }
          }
        })
        await writeStarted.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository,
        provenance: {
          listRunVersions,
          writeAppGeneratedVersion: async (request) => {
            writeStarted.resolve()
            await releaseWrite.promise
            return durableProvenance.writeAppGeneratedVersion(request)
          }
        },
        issueRpcCapability: () => 'run-capability-1',
        revokeRpcCapability: async () => {
          closeStarted.resolve()
        }
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') artifactClaimId = event.artifactClaimId
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    const prompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'save late.txt',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })

    await closeStarted.promise
    expect(listRunVersions).not.toHaveBeenCalled()
    expect(artifactClaimId).toBeUndefined()
    await expect(
      runtime.writeArtifactForCurrentRun(session.sessionId, {
        filename: 'too-late.txt',
        content: 'must be rejected'
      })
    ).rejects.toThrow(/No active assistant turn/i)

    releaseWrite.resolve()
    await appWrite
    await prompt

    expect(artifactClaimId).toBeTruthy()
    const claim = resolveArtifactRunClaim(runtime, artifactClaimId!)
    const version = await client.artifactVersion.findFirstOrThrow({
      where: { artifactRunId: claim.runId }
    })
    expect(version.evidenceJson).not.toBeNull()
    expect(JSON.parse(version.evidenceJson!)).toMatchObject({
      producer: {
        state: 'available',
        kind: 'connector',
        connector_id: 'molecule',
        invocation_id: 'connector-call-late'
      }
    })
    expect(claim.artifactVersionIds).toEqual([version.id])
    await expect(
      repository.findRunFinalizationMarker('project-1', claim.runId)
    ).resolves.toMatchObject({ artifactVersionIds: [version.id] })
  })

  it('drains an authorized Artifact RPC write before freezing the claim and marker', async () => {
    const storageRoot = await createTemporaryRoot()
    const client = createProjectDbClient(storageRoot)
    temporaryDisconnections.push(() => client.$disconnect())
    await migrateApplicationDatabase(client)
    const repository = new ArtifactRepository(storageRoot)
    const durableProvenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: repository
    })
    const rpcWriteStarted = createDeferred()
    const releaseRpcWrite = createDeferred()
    const closeStarted = createDeferred()
    const notebookService = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot)
    })
    const rpcServer = new NotebookLocalRpcServer(notebookService, {
      transport: 'tcp',
      artifactProvenance: {
        createVersion: async (request, signal) => {
          rpcWriteStarted.resolve()
          await releaseRpcWrite.promise
          return durableProvenance.createVersion(request, signal)
        },
        reserveWrite: (request) => durableProvenance.reserveWrite(request),
        releaseWriteReservation: (request) => durableProvenance.releaseWriteReservation(request),
        releaseRunWriteReservations: (request) =>
          durableProvenance.releaseRunWriteReservations(request),
        releaseAllWriteReservations: () => durableProvenance.releaseAllWriteReservations()
      }
    })
    const rpcConnection = await rpcServer.ensureStarted()
    const listRunVersions = vi.fn((request) => durableProvenance.listRunVersions(request))
    let rpcWrite: Promise<Response> | undefined
    let artifactClaimId: string | undefined
    let currentRunFile = ''
    const rpcFilename = 'rpc-late.txt'
    const rpcContent = 'accepted RPC bytes'
    const rpcSizeBytes = Buffer.byteLength(rpcContent)
    const rpcChecksum = createHash('sha256').update(rpcContent).digest('hex')
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as {
          artifactRunId: string
          appSessionId: string
          rootFrameId: string
          agentFrameId: string
          messageBranchId: string
          runtimeSegmentId: string
          promptMessageId: string
          rpcCapabilityToken: string
        }
        const artifactStorageSessionId = getEnvValue(
          fakeAgent.newSessions[0].mcpServers[0],
          'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
        )
        await repository.writePendingFile({
          projectId: 'project-1',
          sessionId: artifactStorageSessionId,
          runId: context.artifactRunId,
          filename: rpcFilename,
          source: { kind: 'inline', content: rpcContent, encoding: 'utf8' }
        })
        const reservationResponse = await fetch(rpcConnection.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.rpcCapabilityToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'artifactReserveWrite',
            params: {
              projectId: 'project-1',
              appSessionId: sessionId,
              artifactStorageSessionId,
              artifactRunId: context.artifactRunId,
              writeOperationId: 'write-rpc-late',
              filename: rpcFilename,
              fileBytes: rpcSizeBytes
            }
          })
        })
        expect(reservationResponse.status).toBe(200)
        const reservation = (await reservationResponse.json()) as { result: { id: string } }
        rpcWrite = fetch(rpcConnection.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.rpcCapabilityToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'artifactCreateVersion',
            params: {
              projectId: 'project-1',
              appSessionId: sessionId,
              artifactStorageSessionId,
              artifactRunId: context.artifactRunId,
              writeOperationId: 'write-rpc-late',
              writeRequestChecksum: 'c'.repeat(64),
              resourceReservationId: reservation.result.id,
              resourceSizeBytes: rpcSizeBytes,
              resourceChecksum: rpcChecksum,
              rootFrameId: context.rootFrameId,
              agentFrameId: context.agentFrameId,
              messageBranchId: context.messageBranchId,
              runtimeSegmentId: context.runtimeSegmentId,
              promptMessageId: context.promptMessageId,
              filename: rpcFilename,
              contentType: 'text/plain'
            }
          })
        })
        await rpcWriteStarted.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository,
        provenance: {
          listRunVersions,
          writeAppGeneratedVersion: (request) => durableProvenance.writeAppGeneratedVersion(request)
        },
        getRpcConnection: () => Promise.resolve(rpcConnection),
        issueRpcCapability: (binding) => rpcServer.issueArtifactRunCapability(binding),
        revokeRpcCapability: async (token) => {
          closeStarted.resolve()
          await rpcServer.revokeArtifactRunCapability(token)
        }
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') artifactClaimId = event.artifactClaimId
        }
      }
    })

    try {
      const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
      currentRunFile = getEnvValue(
        fakeAgent.newSessions[0].mcpServers[0],
        'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
      )
      const prompt = runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'save through RPC',
        provenanceContext: {
          rootFrameId: 'root-frame-1',
          agentFrameId: 'agent-frame-1',
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-1',
          promptMessageId: 'prompt-1'
        }
      })

      await closeStarted.promise
      expect(listRunVersions).not.toHaveBeenCalled()
      expect(artifactClaimId).toBeUndefined()

      releaseRpcWrite.resolve()
      await expect(rpcWrite!.then((response) => response.status)).resolves.toBe(200)
      await prompt

      expect(artifactClaimId).toBeTruthy()
      const claim = resolveArtifactRunClaim(runtime, artifactClaimId!)
      const version = await client.artifactVersion.findFirstOrThrow({
        where: { artifactRunId: claim.runId }
      })
      expect(claim.artifactVersionIds).toEqual([version.id])
      await expect(
        repository.findRunFinalizationMarker('project-1', claim.runId)
      ).resolves.toMatchObject({ artifactVersionIds: [version.id] })
    } finally {
      releaseRpcWrite.resolve()
      await rpcServer.close()
    }
  })

  it('finalizes an Artifact after a restored branch supplies ancestor-only provenance context', async () => {
    const storageRoot = await createTemporaryRoot()
    const client = createProjectDbClient(storageRoot)
    temporaryDisconnections.push(() => client.$disconnect())
    await migrateApplicationDatabase(client)
    const repository = new ArtifactRepository(storageRoot)
    const durableSessionAuthority: { current?: PersistedChatSession } = {}
    const provenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: repository,
      loadSession: async () => durableSessionAuthority.current
    })
    const process = new FakeAgentProcess()
    let artifactClaimId: string | undefined
    let writeError: unknown
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        try {
          await runtime.writeArtifactForCurrentRun(sessionId, {
            filename: 'sin.txt',
            content: 'restored-session-image',
            mimeType: 'text/plain',
            producer: {
              kind: 'connector',
              connectorId: 'molecule',
              toolId: 'preview_molecule',
              invocationId: 'connector-call-restored',
              implementationVersion: '1',
              normalizedArguments: { filename: 'sin.txt' }
            }
          })
        } catch (error) {
          writeError = error
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository,
        provenance
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') artifactClaimId = event.artifactClaimId
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'draw sin again',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-current',
        // Restored conversation graphs describe ancestors separately from the active branch leaf.
        messageBranchAncestry: ['branch-parent'],
        messageAncestry: ['message-parent', 'prompt-current'],
        runtimeSegmentId: 'runtime-segment-restored',
        promptMessageId: 'prompt-current'
      }
    })

    if (writeError) throw writeError
    expect(artifactClaimId).toBeTruthy()
    const claim = resolveArtifactRunClaim(runtime, artifactClaimId!)
    const claimedVersion = await client.artifactVersion.findFirstOrThrow({
      where: { artifactRunId: claim.runId }
    })
    expect(claim.artifactVersionIds).toEqual([claimedVersion.id])
    const createdAt = Date.now()
    const conversationGraph = {
      schemaVersion: 1 as const,
      rootFrameId: 'root-frame-1',
      activeFrameId: 'agent-frame-1',
      frames: [
        {
          id: 'root-frame-1',
          originBindingState: 'root' as const,
          kind: 'root' as const,
          status: 'completed' as const,
          activeBranchId: 'root-branch',
          createdAt,
          completedAt: createdAt
        },
        {
          id: 'agent-frame-1',
          parentFrameId: 'root-frame-1',
          originMessageId: 'message-parent',
          originBindingState: 'validated' as const,
          kind: 'compatibility' as const,
          status: 'completed' as const,
          activeBranchId: 'branch-current',
          createdAt,
          completedAt: createdAt
        }
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root-frame-1',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'branch-parent',
          agentFrameId: 'agent-frame-1',
          headMessageId: 'message-parent',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'branch-current',
          agentFrameId: 'agent-frame-1',
          parentBranchId: 'branch-parent',
          forkMessageId: 'message-parent',
          headMessageId: 'assistant-current',
          createdAt,
          updatedAt: createdAt
        }
      ],
      messages: [
        {
          id: 'message-parent',
          role: 'user' as const,
          content: 'previous prompt',
          status: 'complete' as const,
          eventIds: [],
          createdAt,
          updatedAt: createdAt,
          agentFrameId: 'agent-frame-1',
          introducedOnBranchId: 'branch-parent',
          revisionRootMessageId: 'message-parent',
          runtimeSegmentId: 'runtime-segment-restored'
        },
        {
          id: 'prompt-current',
          role: 'user' as const,
          content: 'draw sin again',
          status: 'complete' as const,
          eventIds: [],
          createdAt: createdAt + 1,
          updatedAt: createdAt + 1,
          agentFrameId: 'agent-frame-1',
          introducedOnBranchId: 'branch-current',
          parentMessageId: 'message-parent',
          revisionRootMessageId: 'prompt-current',
          runtimeSegmentId: 'runtime-segment-restored'
        },
        {
          id: 'assistant-current',
          role: 'agent' as const,
          content: 'saved sin.txt',
          status: 'complete' as const,
          eventIds: [],
          createdAt: createdAt + 2,
          updatedAt: createdAt + 2,
          agentFrameId: 'agent-frame-1',
          introducedOnBranchId: 'branch-current',
          parentMessageId: 'prompt-current',
          runtimeSegmentId: 'runtime-segment-restored'
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: [
        {
          id: 'runtime-segment-restored',
          agentFrameId: 'agent-frame-1',
          frameworkId: 'claude-code' as const,
          startedAt: createdAt
        }
      ]
    }
    durableSessionAuthority.current = {
      id: session.sessionId,
      projectId: 'project-1',
      title: 'Restored session',
      cwd: '/workspace',
      status: 'idle',
      messages: conversationGraph.messages.map(projectConversationMessage),
      conversationGraph,
      createdAt,
      updatedAt: createdAt + 2
    }
    const finalized = await provenance.finalizeRun({
      projectId: claim.projectId,
      appSessionId: claim.sessionId,
      artifactRunId: claim.runId,
      artifactVersionIds: claim.artifactVersionIds!,
      rootFrameId: claim.rootFrameId!,
      agentFrameId: claim.agentFrameId!,
      messageBranchId: claim.messageBranchId!,
      messageBranchAncestry: claim.messageBranchAncestry,
      // The finalize IPC appends the now-known assistant message id to the prompt-time ancestry.
      messageAncestry: [...(claim.messageAncestry ?? []), 'assistant-current'],
      runtimeSegmentId: claim.runtimeSegmentId!,
      promptMessageId: claim.promptMessageId!,
      messageId: 'assistant-current'
    })

    expect(finalized).toEqual([expect.objectContaining({ name: 'sin.txt' })])
    const finalizedVersion = await client.artifactVersion.findFirstOrThrow({
      where: { artifactRunId: claim.runId }
    })
    expect(finalizedVersion).toMatchObject({ state: 'finalized', messageId: 'assistant-current' })
    expect(finalizedVersion.evidenceJson).not.toBeNull()
    expect(JSON.parse(finalizedVersion.evidenceJson!)).toMatchObject({
      producer: {
        state: 'available',
        kind: 'connector',
        invocation_id: 'connector-call-restored'
      }
    })
  })

  it('finalizes a Task-runner Artifact against its durable Runtime Segment', async () => {
    const storageRoot = await createTemporaryRoot()
    const client = createProjectDbClient(storageRoot)
    temporaryDisconnections.push(() => client.$disconnect())
    await migrateApplicationDatabase(client)
    const repository = new ArtifactRepository(storageRoot)
    const durableSessionAuthority: { current?: PersistedChatSession } = {}
    const provenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: repository,
      loadSession: async () => durableSessionAuthority.current
    })
    const process = new FakeAgentProcess()
    let artifactClaimId: string | undefined
    startFakeAgent(process, ['task-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: async ({ sessionId }) => {
        await runtime.writeArtifactForCurrentRun(sessionId, {
          filename: 'plan.json',
          content: '{"title":"Session Plan"}',
          mimeType: 'application/json'
        })
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: codexFramework,
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectId: 'project-1',
        mcpEntryPath: '/app/out/main/index.js',
        repository,
        provenance
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') artifactClaimId = event.artifactClaimId
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
    const taskAgent = createAcpTaskAgentPort(
      {
        getSnapshot: () => runtime.getSnapshot(),
        resumeSession: (request) => runtime.resumeSession(request),
        setPermissionProfile: (request) => runtime.setPermissionProfile(request),
        sendPrompt: (request) => runtime.sendPrompt(request),
        sendPromptObserved: async (request, onProviderPromptAccepted) => {
          onProviderPromptAccepted()
          await runtime.sendPrompt(request)
        },
        cancelPrompt: (request) => runtime.cancelPrompt(request)
      },
      { create: vi.fn() }
    )
    const promptMessage: PersistedChatSession['messages'][number] = {
      id: 'task-prompt-1',
      role: 'user',
      content: 'Generate a Session Plan.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const assistantMessage: PersistedChatSession['messages'][number] = {
      id: 'task-assistant-1',
      role: 'agent',
      content: 'Saved plan.json.',
      status: 'complete',
      responseToMessageId: promptMessage.id,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const promptGraph = createLinearConversationGraph({
      sessionId: session.sessionId,
      messages: [promptMessage],
      frameworkId: codexFramework.id,
      createdAt: 1,
      updatedAt: 1
    })
    const conversationGraph = synchronizeActiveConversationMessages(
      promptGraph,
      [promptMessage, assistantMessage],
      2
    )
    durableSessionAuthority.current = {
      id: session.sessionId,
      projectId: 'project-1',
      title: 'Task runner Plan First',
      cwd: '/workspace',
      status: 'idle',
      messages: conversationGraph.messages.map(projectConversationMessage),
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }

    const taskPrompt = {
      sessionId: session.sessionId,
      promptMessageId: promptMessage.id,
      text: promptMessage.content,
      turnIntent: 'plan-first' as const,
      provenanceContext: getActiveConversationContext(promptGraph, promptMessage.id)
    }
    await taskAgent.prompt(taskPrompt)

    expect(artifactClaimId).toBeTruthy()
    const claim = resolveArtifactRunClaim(runtime, artifactClaimId!)
    let finalized: Awaited<ReturnType<ArtifactProvenanceRepository['finalizeRun']>>
    try {
      finalized = await provenance.finalizeRun({
        projectId: claim.projectId,
        appSessionId: claim.sessionId,
        artifactRunId: claim.runId,
        artifactVersionIds: claim.artifactVersionIds!,
        rootFrameId: claim.rootFrameId!,
        agentFrameId: claim.agentFrameId!,
        messageBranchId: claim.messageBranchId!,
        messageBranchAncestry: claim.messageBranchAncestry,
        messageAncestry: [...(claim.messageAncestry ?? []), assistantMessage.id],
        runtimeSegmentId: claim.runtimeSegmentId!,
        promptMessageId: claim.promptMessageId!,
        messageId: assistantMessage.id
      })
    } catch (error) {
      await expect(
        client.artifactVersion.findFirstOrThrow({ where: { artifactRunId: claim.runId } })
      ).resolves.toMatchObject({ state: 'pending', messageId: null })
      throw error
    }
    expect(finalized).toEqual([expect.objectContaining({ name: 'plan.json' })])
    await expect(
      client.artifactVersion.findFirstOrThrow({ where: { artifactRunId: claim.runId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: assistantMessage.id })
  })

  it('emits an artifact event for pending files even when the prompt fails', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      promptMessageId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async () => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as {
          artifactRunId: string
        }

        await repository.writePendingFile({
          projectId: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.artifactRunId,
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
        projectId: 'default-project',
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
              promptMessageId: event.promptMessageId,
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
        promptMessageId: expect.stringMatching(/^prompt-artifact-run-/),
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
    const revokedTokens: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: blockedStorageRoot,
        dataRoot: blockedStorageRoot,
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4567', token: 'global' }),
        issueRpcCapability: () => 'activation-capability',
        revokeRpcCapability: (token) => {
          revokedTokens.push(token)
        }
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
    expect(revokedTokens).toEqual(['activation-capability'])
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

  it.each([
    ['OpenCode APIError', { errorName: 'APIError' }, 'Invalid API key'],
    [
      'Claude Code explicit 4xx',
      { errorKind: 'unknown' },
      'API Error: 400 Authentication Fails, Your api key: ****e52d is invalid'
    ],
    [
      'Claude Code API connection refused',
      { errorKind: 'unknown' },
      'API Error: Unable to connect to API (ConnectionRefused)'
    ],
    [
      'provider bridge error kind',
      { errorKind: 'provider-error' },
      '{"error":{"message":"Authentication failed","type":"authentication_error"}}'
    ]
  ] as const)(
    'tags a provider-relayed %s prompt failure so the renderer hides Report',
    async (_name, data, message) => {
      const process = new FakeAgentProcess()
      const events: Array<{ kind: string; providerError?: boolean }> = []
      startFakeAgent(process, ['remote-session-1'], {
        onPrompt: () => {
          throw acp.RequestError.internalError(data, message)
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
    }
  )

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

  it('preserves a provider failure and its terminal event when the failure logger throws', async () => {
    const process = new FakeAgentProcess()
    const events: AcpRuntimeEvent[] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: () => {
        throw acp.RequestError.internalError({ errorKind: 'invalid_request' }, 'provider failed')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })

    await runtime.createSession({ cwd: '/workspace' })
    errorLogSpy.mockImplementation(() => {
      throw new Error('logger failed')
    })
    try {
      await expect(
        runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'hi' })
      ).rejects.toMatchObject({ code: -32603, data: { errorKind: 'invalid_request' } })
    } finally {
      errorLogSpy.mockReset()
    }

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', title: ACP_PROMPT_FAILED_EVENT_TITLE })
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
        projectId: 'default-project',
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

  it('fresh-adopts restored sessions when the agent does not advertise resume support', async () => {
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
    ).resolves.toMatchObject({ sessionId: 'remote-session-1', contextReset: true })
    expect(fakeAgent.resumedSessions).toEqual([])
    expect(fakeAgent.newSessions).toHaveLength(1)
  })

  it('keeps a pending permission available when prompt cancellation fails', async () => {
    const process = new FakeAgentProcess()
    const permissionResponses: acp.RequestPermissionResponse[] = []

    acp
      .agent({ name: 'failed-cancel-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        permissionResponses.push(
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId: 'pending-command',
              title: 'Run command',
              kind: 'execute',
              status: 'pending',
              rawInput: { command: 'npm test' }
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
            ]
          })
        )
        return { stopReason: 'end_turn' }
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const permissionRequests: AcpPermissionRequest[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPermissionRequest: (request) => permissionRequests.push(request) }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run tests' })

    await vi.waitFor(() => expect(runtime.getSnapshot().pendingPermissions).toHaveLength(1))
    const connection = (
      runtime as unknown as {
        connection: { agent: { notify: (method: unknown, params: unknown) => Promise<void> } }
      }
    ).connection
    vi.spyOn(connection.agent, 'notify').mockRejectedValueOnce(new Error('cancel write failed'))

    await expect(runtime.cancelPrompt({ sessionId: session.sessionId })).rejects.toThrow(
      'cancel write failed'
    )
    expect(runtime.getSnapshot().pendingPermissions).toHaveLength(1)
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])

    runtime.respondToPermission({
      requestId: permissionRequests[0].requestId,
      optionId: 'reject'
    })
    await prompt

    expect(permissionResponses).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject' } }])
  })

  it('continues a Claude turn with an explicit authorization boundary after permission denial', async () => {
    const process = new FakeAgentProcess()
    const continuationGate = createDeferred<PromptResponse>()
    const prompts: string[] = []
    let promptIndex = 0

    acp
      .agent({ name: 'claude-rejected-permission-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const text = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        prompts.push(text)

        if (promptIndex++ === 0) {
          const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId: 'denied-command',
              title: 'Run command',
              kind: 'execute',
              status: 'pending',
              rawInput: { command: 'ls -la' }
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
            ]
          })
          expect(response).toEqual({
            outcome: { outcome: 'selected', optionId: 'reject-once' }
          })
          return { stopReason: 'cancelled' }
        }

        return continuationGate.promise
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        continuationGate.resolve({ stopReason: 'cancelled' })
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
      framework: claudeCodeFramework,
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onPermissionRequest: (request) => {
          runtime.respondToPermission({
            requestId: request.requestId,
            optionId: 'reject-once'
          })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'inspect the workspace' })

    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(prompts[1]).toContain('The user explicitly denied this operation')
    expect(prompts[1]).toContain('You do not have authorization to perform it')
    expect(prompts[1]).toContain(
      'Do not retry or approximate the denied operation with a different command, tool, or route'
    )
    expect(prompts[1]).toContain('Continue only with independent work that is already permitted')
    expect(runtime.getSnapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          toolCallId: 'denied-command',
          status: 'completed',
          toolDisposition: 'declined'
        })
      ])
    )
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])

    const cancelSnapshot = await runtime.cancelPrompt({ sessionId: session.sessionId })
    expect(cancelSnapshot.promptInFlightSessionIds).toEqual([session.sessionId])
    await vi.waitFor(() => expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([]))
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
          return {
            stopReason: 'cancelled',
            usage: {
              totalTokens: 27,
              inputTokens: 19,
              cachedReadTokens: 5,
              outputTokens: 3
            }
          }
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
    expect(runtime.getSnapshot().events.find((event) => event.kind === 'stop')).toMatchObject({
      turnUsage: { inputTokens: 19, cacheTokens: 5, outputTokens: 3 }
    })
  })
})

describe('ACP runtime skill force-load + nudge', () => {
  const resolveForceLoadSpecialistIdentity = async (): Promise<{
    append: string
    prefix: string
  }> => ({ append: '', prefix: '' })
  const resolveForceLoadSpecialistSkills = async (): Promise<{
    kind: 'specialist'
    skillIds: string[]
    frameworkNames: string[]
    missingSkillIds: string[]
  }> => ({
    kind: 'specialist',
    skillIds: ['research', 'skill-a', 'skill-b'],
    frameworkNames: ['research', 'skill-a', 'skill-b'],
    missingSkillIds: []
  })

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
    descriptors?: Record<string, { name: string; path: string }>
    catalog?: Array<{ name: string; description: string; path: string }>
  }): {
    needForceLoad: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
    namesForIds: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
    descriptorsForIds: ReturnType<
      typeof vi.fn<
        (ids: string[], codexHome: string | undefined) => Promise<{ name: string; path: string }[]>
      >
    >
    catalogForCodexHome: ReturnType<
      typeof vi.fn<
        (
          codexHome: string | undefined
        ) => Promise<Array<{ name: string; description: string; path: string }>>
      >
    >
  } => ({
    needForceLoad: vi.fn<(ids: string[]) => Promise<string[]>>(async () => options.needForceLoad),
    namesForIds: vi.fn<(ids: string[]) => Promise<string[]>>(async (ids: string[]) =>
      ids.map((id) => options.nudgeNames?.[id] ?? id)
    ),
    descriptorsForIds: vi.fn(async (ids: string[]) =>
      ids.flatMap((id) => {
        const descriptor = options.descriptors?.[id]
        return descriptor ? [descriptor] : []
      })
    ),
    catalogForCodexHome: vi.fn(async () => options.catalog ?? [])
  })

  it('does not let a delayed pre-start attempt overwrite a newer active turn', async () => {
    const process = new FakeAgentProcess()
    const skillCheckEntered = createDeferred()
    const releaseSkillCheck = createDeferred()
    const newerPromptEntered = createDeferred()
    const releaseNewerPrompt = createDeferred()
    const onPromptStarted = vi.fn()
    const onPromptEnded = vi.fn()
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ text }) => {
        if (text === 'newer prompt') {
          newerPromptEntered.resolve()
          await releaseNewerPrompt.promise
        }
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onPromptStarted, onPromptEnded },
      resolveSpecialistIdentity: resolveForceLoadSpecialistIdentity,
      resolveSpecialistSkills: resolveForceLoadSpecialistSkills,
      skills: {
        needForceLoad: async () => {
          skillCheckEntered.resolve()
          await releaseSkillCheck.promise
          return ['research']
        },
        namesForIds: async (ids) => ids
      }
    })
    const session = await runtime.createSession({
      cwd: '/workspace',
      specialistId: 'force-load-specialist'
    })

    const delayedPrompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'delayed prompt',
      forcedSkillIds: ['research']
    })
    await skillCheckEntered.promise
    await runtime.cancelPrompt({ sessionId: session.sessionId })

    const newerPrompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'newer prompt'
    })
    await newerPromptEntered.promise
    releaseSkillCheck.resolve()

    await expect(delayedPrompt).rejects.toThrow(/already running/)
    expect(onPromptStarted).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)

    releaseNewerPrompt.resolve()
    await expect(newerPrompt).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(onPromptEnded).toHaveBeenCalledOnce()
    expect(onPromptEnded).toHaveBeenCalledWith(session.sessionId, onPromptStarted.mock.calls[0][1])
  })

  it('passes turn-forced skill ids to backend resolution per runtime instance', async () => {
    const firstSpawner = createFreshAgentSpawner()
    const secondSpawner = createFreshAgentSpawner()
    const firstContexts: Array<
      { forcedSkillIds: string[]; systemPromptAppends?: string[] } | undefined
    > = []
    const secondContexts: Array<
      { forcedSkillIds: string[]; systemPromptAppends?: string[] } | undefined
    > = []
    const createRuntime = (
      spawner: ReturnType<typeof createFreshAgentSpawner>,
      contexts: Array<{ forcedSkillIds: string[]; systemPromptAppends?: string[] } | undefined>
    ): AcpRuntime =>
      new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: (context?: {
          forcedSkillIds: string[]
          systemPromptAppends?: string[]
        }) => {
          contexts.push(context)
          return {
            framework: { ...claudeCodeFramework, spawn: spawner.spawn },
            executablePath: '/bin/agent',
            env: {}
          }
        },
        resolveSpecialistIdentity: resolveForceLoadSpecialistIdentity,
        resolveSpecialistSkills: resolveForceLoadSpecialistSkills,
        skills: {
          needForceLoad: async (ids) => ids,
          namesForIds: async (ids) => ids
        }
      })

    const first = createRuntime(firstSpawner, firstContexts)
    const second = createRuntime(secondSpawner, secondContexts)
    await Promise.all([
      first.createSession({ cwd: '/workspace', specialistId: 'force-load-specialist' }),
      second.createSession({ cwd: '/workspace', specialistId: 'force-load-specialist' })
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

    expect(firstContexts).toEqual(
      expect.arrayContaining([expect.objectContaining({ forcedSkillIds: ['skill-a'] })])
    )
    expect(secondContexts).toEqual(
      expect.arrayContaining([expect.objectContaining({ forcedSkillIds: ['skill-b'] })])
    )
    expect(firstContexts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ forcedSkillIds: ['skill-b'] })])
    )
    expect(secondContexts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ forcedSkillIds: ['skill-a'] })])
    )
  })

  it('respawns and nudges when a picked skill is disabled, then restores after the turn', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({ needForceLoad: ['research'] })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      resolveSpecialistIdentity: resolveForceLoadSpecialistIdentity,
      resolveSpecialistSkills: resolveForceLoadSpecialistSkills,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'force-load-specialist' })
    expect(spawner.spawnCount()).toBe(1)

    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    // The picked skill was scoped to this runtime and the agent respawned before the prompt.
    expect(spawner.spawnCount()).toBe(2)
    expect(spawner.agents[1].resumedSessions).toHaveLength(1)

    // The nudge names the Skill by its stable id (the identifier the agent's Skill tool resolves),
    // NOT its human display name — a display name like "Deep Research" is unknown to the tool.
    expect(spawner.agents[1].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: research.\n\nsummarize the paper'
      }
    ])

    // After the turn the force set is cleared and a planned restore reconnect tears the agent down
    // without advertising an abnormal closed connection to the renderer.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getSnapshot().status).toBe('idle')
  })

  it('restores normal backend preparation after a forced Skill reload fails', async () => {
    const backendContexts: string[][] = []
    let spawnCount = 0
    const spawn = (): ChildProcessWithoutNullStreams => {
      spawnCount += 1
      const process = new FakeAgentProcess()
      startFakeAgent(
        process,
        ['remote-session-1'],
        spawnCount === 2
          ? {
              onResumeRequest: () => {
                throw new Error('provider unavailable')
              }
            }
          : {}
      )
      return asAgentProcess(process)
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: (context) => {
        backendContexts.push([...context.forcedSkillIds])
        return {
          framework: { ...claudeCodeFramework, spawn },
          executablePath: '/bin/agent',
          env: {}
        }
      },
      resolveSpecialistIdentity: resolveForceLoadSpecialistIdentity,
      resolveSpecialistSkills: resolveForceLoadSpecialistSkills,
      skills: {
        needForceLoad: async (ids) => ids,
        namesForIds: async (ids) => ids
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'force-load-specialist' })
    await expect(
      runtime.sendPrompt({
        sessionId: 'remote-session-1',
        text: 'use the disabled skill',
        forcedSkillIds: ['research']
      })
    ).rejects.toThrow()
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('idle'))

    await runtime.resumeSession({
      sessionId: 'remote-session-1',
      cwd: '/workspace',
      specialistId: 'force-load-specialist'
    })
    expect(backendContexts.slice(0, 3)).toEqual([[], ['research'], []])
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

  it('sends a picked Codex Skill as private native-input metadata without changing text', async () => {
    const process = new FakeAgentProcess()
    let receivedPrompt: ContentBlock[] = []
    startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onPrompt: ({ prompt }) => {
        receivedPrompt = prompt
      }
    })
    const skillPath = '/data/codex-subscription/skills/os-research/SKILL.md'
    const hooks = createSkillsHooks({
      needForceLoad: [],
      descriptors: { research: { name: 'research', path: skillPath } }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...codexFramework, buildSessionSetup: () => ({}) },
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'codex-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    expect(receivedPrompt).toEqual([
      {
        type: 'text',
        text: 'summarize the paper',
        _meta: {
          'open-science/skill-inputs': [{ name: 'research', path: skillPath }]
        }
      }
    ])
    expect(hooks.namesForIds).not.toHaveBeenCalled()
  })

  it('selects a bridged Codex Skill from current user text and attaches native-input metadata', async () => {
    const process = new FakeAgentProcess()
    let receivedPrompt: ContentBlock[] = []
    const events: AcpRuntimeEvent[] = []
    startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only'),
      onPrompt: ({ prompt }) => {
        receivedPrompt = prompt
      }
    })
    const skillPath = '/data/codex/skills/os-mcp-pubmed/SKILL.md'
    const catalog = [{ name: 'mcp-pubmed', description: 'Search PubMed.', path: skillPath }]
    const hooks = createSkillsHooks({ needForceLoad: [], catalog })
    const selectSkills = vi.fn(async () => [{ name: 'mcp-pubmed', path: skillPath }])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...codexFramework,
          spawn: () => asAgentProcess(process),
          buildSessionSetup: () => ({ promptPrefix: 'framework guidance' })
        },
        executablePath: '/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex' },
        responsesBridgeLease: {
          selectSkills,
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: vi.fn(async () => undefined)
        }
      }),
      callbacks: { onEvent: (event) => events.push(event) },
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'codex-session-1',
      text: '用 PubMed 搜索肿瘤免疫文章',
      historyPreamble: 'earlier conversation'
    })

    expect(hooks.catalogForCodexHome).toHaveBeenCalledWith('/data/codex')
    expect(selectSkills).toHaveBeenCalledWith(
      '用 PubMed 搜索肿瘤免疫文章',
      catalog,
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(receivedPrompt).toEqual([
      {
        type: 'text',
        text: 'earlier conversation\n\nframework guidance\n\n用 PubMed 搜索肿瘤免疫文章',
        _meta: {
          'open-science/skill-inputs': [{ name: 'mcp-pubmed', path: skillPath }]
        }
      }
    ])
    const skillEvents = events.filter((event) => event.providerToolName === 'skill')
    expect(skillEvents).toEqual([
      expect.objectContaining({
        kind: 'tool',
        title: 'Loaded skill: mcp-pubmed',
        status: 'in_progress'
      }),
      expect.objectContaining({
        kind: 'tool',
        title: 'Loaded skill: mcp-pubmed',
        status: 'completed'
      })
    ])
    expect(skillEvents[0]?.toolCallId).toBe(skillEvents[1]?.toolCallId)
    expect(JSON.stringify(skillEvents)).not.toContain(skillPath)
  })

  it('bypasses bridged Codex Skill selection when the picker supplies an explicit Skill', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const explicitPath = '/data/codex/skills/os-research/SKILL.md'
    const hooks = createSkillsHooks({
      needForceLoad: [],
      descriptors: { research: { name: 'research', path: explicitPath } },
      catalog: [{ name: 'automatic', description: 'Automatic.', path: '/automatic/SKILL.md' }]
    })
    const selectSkills = vi.fn(async () => [{ name: 'automatic', path: '/automatic/SKILL.md' }])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex' },
        responsesBridgeLease: {
          selectSkills,
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: vi.fn(async () => undefined)
        }
      }),
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'codex-session-1',
      text: 'use my explicit choice',
      forcedSkillIds: ['research']
    })

    expect(hooks.descriptorsForIds).toHaveBeenCalledWith(['research'], '/data/codex')
    expect(hooks.catalogForCodexHome).not.toHaveBeenCalled()
    expect(selectSkills).not.toHaveBeenCalled()
  })

  it('keeps native Codex discovery untouched when no responses bridge is active', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const hooks = createSkillsHooks({
      needForceLoad: [],
      catalog: [{ name: 'research', description: 'Research.', path: '/research/SKILL.md' }]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...codexFramework, buildSessionSetup: () => ({}) },
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'codex-session-1', text: 'plain native request' })

    expect(hooks.catalogForCodexHome).not.toHaveBeenCalled()
    expect(agent.prompts).toEqual([{ sessionId: 'codex-session-1', text: 'plain native request' }])
  })

  it('fails open to the ordinary Codex turn when automatic Skill selection rejects', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const hooks = createSkillsHooks({
      needForceLoad: [],
      catalog: [{ name: 'research', description: 'Research.', path: '/research/SKILL.md' }]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...codexFramework,
          spawn: () => asAgentProcess(process),
          buildSessionSetup: () => ({})
        },
        executablePath: '/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex' },
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => Promise.reject(new Error('selector unavailable'))),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: vi.fn(async () => undefined)
        }
      }),
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'codex-session-1', text: 'ordinary request' })

    expect(agent.prompts).toEqual([{ sessionId: 'codex-session-1', text: 'ordinary request' }])
    expect(warnLogSpy).toHaveBeenCalledWith('Codex Skill selection failed', {
      reason: 'selector-error'
    })
  })

  it('cancels bridged Codex Skill selection before submitting the agent prompt', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['codex-session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'read-only')
    })
    const selectorStarted = createDeferred()
    const releaseSelector = createDeferred()
    let selectorWasAborted = false
    const selectSkills = vi.fn(
      async (
        _text: string,
        _catalog: Array<{ name: string; description: string; path: string }>,
        signal?: AbortSignal
      ) => {
        selectorStarted.resolve()
        await releaseSelector.promise
        selectorWasAborted = signal?.aborted ?? false
        return []
      }
    )
    const hooks = createSkillsHooks({
      needForceLoad: [],
      catalog: [{ name: 'research', description: 'Research.', path: '/research/SKILL.md' }]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...codexFramework,
          spawn: () => asAgentProcess(process),
          buildSessionSetup: () => ({})
        },
        executablePath: '/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex' },
        responsesBridgeLease: {
          selectSkills,
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: vi.fn(async () => undefined)
        }
      }),
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    const prompting = runtime.sendPrompt({
      sessionId: 'codex-session-1',
      text: 'select then run'
    })
    await selectorStarted.promise
    await runtime.cancelPrompt({ sessionId: 'codex-session-1' })
    releaseSelector.resolve()

    await expect(prompting).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(selectorWasAborted).toBe(true)
    expect(agent.prompts).toEqual([])
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

describe('ACP runtime Codex Skill activity projection', () => {
  it('emits only the Skill name for a native Codex SKILL.md read lifecycle', async () => {
    const events: AcpRuntimeEvent[] = []
    const codexHome = join('/data', 'codex-subscription')
    const skillPath = join(codexHome, 'skills', 'mcp-pubmed', 'SKILL.md')
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        backendId: 'codex:isolated',
        executablePath: '/data/codex-acp',
        env: { CODEX_HOME: codexHome }
      }),
      callbacks: { onEvent: (event) => events.push(event) }
    })
    await runtime.createSession({ cwd: '/workspace' })

    handleSessionUpdate(runtime, {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-skill-1',
        kind: 'read',
        title: `Read file '${skillPath}'`,
        status: 'in_progress',
        locations: [{ path: skillPath }]
      }
    })
    handleSessionUpdate(runtime, {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-skill-1',
        status: 'completed',
        rawOutput: { formatted_output: 'FULL SKILL BODY', exit_code: 0 }
      }
    })
    handleSessionUpdate(runtime, {
      sessionId: 'session-1',
      update: { sessionUpdate: 'usage_update', used: 100, size: 128000 }
    })

    const skillEvents = events.filter((event) => event.toolCallId === 'read-skill-1')
    expect(skillEvents).toHaveLength(2)
    expect(skillEvents.map((event) => event.title)).toEqual([
      'Loading skill: mcp-pubmed',
      'Loaded skill: mcp-pubmed'
    ])
    expect(JSON.stringify(skillEvents)).not.toContain(skillPath)
    expect(JSON.stringify(skillEvents)).not.toContain('FULL SKILL BODY')
    const categories =
      runtime.getSnapshot().contextUsageBySession['session-1']?.breakdown?.categories
    expect(categories).toContainEqual(expect.objectContaining({ key: 'skills', estimated: true }))
    expect(categories).not.toContainEqual(expect.objectContaining({ key: 'tools' }))
  })

  it('clears sparse Codex Skill correlation when the backend generation disconnects', async () => {
    const events: AcpRuntimeEvent[] = []
    const codexHome = join('/data', 'codex-subscription')
    const skillPath = join(codexHome, 'skills', 'mcp-pubmed', 'SKILL.md')
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-1'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        backendId: 'codex:isolated',
        executablePath: '/data/codex-acp',
        env: { CODEX_HOME: codexHome }
      }),
      callbacks: { onEvent: (event) => events.push(event) }
    })
    await runtime.createSession({ cwd: '/workspace' })

    handleSessionUpdate(runtime, {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-skill-1',
        kind: 'read',
        title: `Read file '${skillPath}'`,
        status: 'in_progress',
        locations: [{ path: skillPath }]
      }
    })
    await runtime.disconnect(false)
    handleSessionUpdate(runtime, {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-skill-1',
        status: 'completed'
      }
    })

    expect(
      events.filter((event) => event.toolCallId === 'read-skill-1').map((event) => event.title)
    ).toEqual(['Loading skill: mcp-pubmed', undefined])
  })
})

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

  it('logs an agent process error event with a safe category and lifecycle context', async () => {
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
    process.emit(
      'error',
      Object.assign(new Error('sensitive pipe failure'), {
        code: 'EPIPE',
        path: '/private/sensitive-socket'
      })
    )

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent process error event')
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      errorCategory: 'system',
      framework: 'claude-code',
      generation: 1,
      status: 'connected'
    })
    expect(JSON.stringify(call?.[1])).not.toMatch(/sensitive pipe failure|sensitive-socket|9090/)
  })

  it.each(PERMISSION_PROJECTION_FRAMEWORKS)(
    'summarizes bursty %s stderr without exposing raw output by default',
    async (_name, framework, modelRoute, backendId) => {
      warnLogSpy.mockClear()
      const process = new FakeAgentProcess()
      const promptResponse = createDeferred<PromptResponse>()
      const fakeAgent = startFakeAgent(process, ['stderr-session'], {
        onPrompt: () => promptResponse.promise,
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const events: AcpRuntimeEvent[] = []
      const bridgeLease =
        modelRoute === 'codex-bridge' ? createBackendLeaseHarness().lease : undefined
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          backendId,
          modelRoute,
          executablePath: '/bin/agent',
          env: {},
          ...(bridgeLease ? { responsesBridgeLease: bridgeLease } : {})
        }),
        callbacks: { onEvent: (event) => events.push(event) }
      })

      const session = await runtime.createSession({ cwd: '/workspace' })
      const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run analysis' })
      await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
      warnLogSpy.mockClear()
      events.length = 0
      vi.useFakeTimers()
      try {
        for (let index = 0; index < 10; index += 1) {
          process.stderr.emit('data', Buffer.from('private-path:/lab/run-42/result.csv'))
        }

        await vi.advanceTimersByTimeAsync(1000)

        expect(warnLogSpy.mock.calls).toEqual([
          [
            'agent stderr summary',
            {
              errorCategory: 'process-stderr',
              framework: framework.id,
              status: 'connected',
              sessionCount: 1,
              chunkCount: 10,
              byteCount: 350,
              windowMs: 1000,
              chunksPerSecond: 10
            }
          ]
        ])
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          kind: 'system',
          level: 'warning',
          sessionId: 'stderr-session',
          title: 'agent',
          text: 'Agent process stderr: 10 chunks, 350 bytes; raw output omitted.'
        })
        expect(JSON.stringify({ logs: warnLogSpy.mock.calls, events })).not.toContain(
          'private-path:/lab/run-42/result.csv'
        )
      } finally {
        vi.useRealTimers()
        promptResponse.resolve({ stopReason: 'end_turn' })
        await prompt
      }
    }
  )

  it('caps explicitly enabled raw stderr samples by UTF-8 bytes', async () => {
    warnLogSpy.mockClear()
    const previousRawStderr = process.env.OPEN_SCIENCE_AGENT_STDERR
    process.env.OPEN_SCIENCE_AGENT_STDERR = 'raw'
    try {
      const agentProcess = new FakeAgentProcess()
      startFakeAgent(agentProcess, ['raw-stderr-session'])
      const events: AcpRuntimeEvent[] = []
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(agentProcess),
        callbacks: { onEvent: (event) => events.push(event) }
      })

      await runtime.createSession({ cwd: '/workspace' })
      warnLogSpy.mockClear()
      events.length = 0
      vi.useFakeTimers()
      agentProcess.stderr.emit('data', Buffer.from('测'.repeat(3000)))

      await vi.advanceTimersByTimeAsync(1000)

      const call = warnLogSpy.mock.calls.find(([message]) => message === 'agent stderr summary')
      expect(call).toBeDefined()
      const data = call?.[1] as {
        byteCount: number
        rawSample: string
        rawSampleTruncated: boolean
      }
      expect(data.byteCount).toBe(9000)
      expect(data.rawSampleTruncated).toBe(true)
      expect(Buffer.byteLength(data.rawSample, 'utf8')).toBeLessThanOrEqual(4096)
      expect(data.rawSample).toMatch(/^测+$/)
      expect(events).toHaveLength(1)
      expect(events[0]?.text).toContain('…[truncated]')
    } finally {
      vi.useRealTimers()
      if (previousRawStderr === undefined) delete process.env.OPEN_SCIENCE_AGENT_STDERR
      else process.env.OPEN_SCIENCE_AGENT_STDERR = previousRawStderr
    }
  })

  it('does not attribute delayed stderr to a later prompt in the same session', async () => {
    warnLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const firstResponse = createDeferred<PromptResponse>()
    const secondResponse = createDeferred<PromptResponse>()
    const responses = [firstResponse, secondResponse]
    const fakeAgent = startFakeAgent(process, ['stderr-session'], {
      onPrompt: () => responses.shift()!.promise
    })
    const events: AcpRuntimeEvent[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: { onEvent: (event) => events.push(event) }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const firstPrompt = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'first analysis'
    })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    events.length = 0
    vi.useFakeTimers()
    let secondPrompt: Promise<PromptResponse> | undefined
    try {
      process.stderr.emit('data', Buffer.from('first prompt diagnostic'))
      firstResponse.resolve({ stopReason: 'end_turn' })
      await firstPrompt

      secondPrompt = runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'second analysis'
      })
      await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(1000)

      const warning = events.find((event) => event.kind === 'system' && event.title === 'agent')
      expect(warning).toBeDefined()
      expect(warning?.sessionId).toBeUndefined()
      expect(warning?.promptMessageId).toBeUndefined()
    } finally {
      vi.useRealTimers()
      secondResponse.resolve({ stopReason: 'end_turn' })
      await secondPrompt
    }
  })

  it('keeps known non-actionable Codex stderr out of runtime warning events', async () => {
    warnLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const promptResponse = createDeferred<PromptResponse>()
    const fakeAgent = startFakeAgent(process, ['stderr-session'], {
      onPrompt: () => promptResponse.promise,
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const events: AcpRuntimeEvent[] = []
    const onCodexWebSocketFallback = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        providerId: 'builtin-codex-subscription',
        backendId: 'codex:builtin-codex-subscription',
        modelRoute: 'codex-responses',
        executablePath: '/bin/codex',
        env: {}
      }),
      callbacks: { onEvent: (event) => events.push(event), onCodexWebSocketFallback }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'run analysis' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    events.length = 0
    vi.useFakeTimers()
    try {
      process.stderr.emit(
        'data',
        Buffer.from(
          [
            'Warning: Skill descriptions were shortened to fit the 2% skills context budget.',
            'Codex can still see every skill, but some descriptions are shorter.',
            'Disable unused skills or plugins to leave more room for the rest.',
            'Warning: Falling back from WebSock'
          ].join('\n')
        )
      )
      process.stderr.emit('data', Buffer.from('ets to HTTPS transport. request timed out'))
      await vi.advanceTimersByTimeAsync(1000)

      expect(warnLogSpy.mock.calls.some(([message]) => message === 'agent stderr summary')).toBe(
        true
      )
      expect(events.some((event) => event.kind === 'system' && event.title === 'agent')).toBe(false)
      expect(onCodexWebSocketFallback).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      promptResponse.resolve({ stopReason: 'end_turn' })
      await prompt
    }
  })

  it('labels a late stderr with the framework captured at bind time, not the current one', async () => {
    warnLogSpy.mockClear()
    const oldProcess = new FakeAgentProcess()
    const replacementProcess = new FakeAgentProcess()
    startFakeAgent(oldProcess, ['old-session'])
    startFakeAgent(replacementProcess, ['replacement-session'])
    const backends = [
      {
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(oldProcess) },
        executablePath: '/bin/claude',
        env: {}
      },
      {
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(replacementProcess) },
        executablePath: '/bin/opencode',
        env: {}
      }
    ]
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => backends.shift()!
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.disconnect()
    await runtime.createSession({ cwd: '/workspace' })
    vi.useFakeTimers()
    try {
      oldProcess.stderr.emit('data', Buffer.from('slow tail output'))
      await vi.advanceTimersByTimeAsync(1000)

      const call = warnLogSpy.mock.calls.find(([message]) => message === 'agent stderr summary')
      expect((call?.[1] as { framework: string }).framework).toBe('claude-code')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ACP runtime — connect failure logging', () => {
  it('logs "agent connection failed" with a safe category and lifecycle context', async () => {
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
    expect(call?.[1]).toEqual({
      errorCategory: 'not-found',
      framework: 'claude-code',
      generation: 1,
      status: 'connecting'
    })
  })

  it('logs "agent connection abandoned" (not failed) when the generation is superseded mid-spawn', async () => {
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const { lease, release } = createBackendLeaseHarness()
    process.pid = 1212
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      // Bump the connection generation synchronously during spawn: the connect that captured the older
      // generation must detect the supersede after the child appears and abandon it.
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            ;(
              runtime as unknown as {
                connectionResources: { supersede: () => number }
              }
            ).connectionResources.supersede()
            return asAgentProcess(process)
          }
        },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: lease
      })
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/superseded/i)
    expect(release).toHaveBeenCalledOnce()

    const abandoned = warnLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection abandoned (superseded or shutting down)'
    )
    expect(abandoned).toBeDefined()
    expect(abandoned?.[1]).toEqual({
      errorCategory: 'error',
      framework: 'claude-code',
      generation: 1,
      status: 'connecting'
    })
    // The supersede path must NOT also emit the error-level "failed" record.
    expect(errorLogSpy.mock.calls.some(([message]) => message === 'agent connection failed')).toBe(
      false
    )
  })

  it('labels a real-backend spawn failure with the resolved (switched) framework, not the old one', async () => {
    errorLogSpy.mockClear()
    const { lease, release } = createBackendLeaseHarness()
    // The runtime defaults to claude-code; this reconnect resolves a *different* backend whose real
    // framework.spawn() throws after resolving opencode, so
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
        env: {},
        responsesBridgeLease: lease
      })
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/opencode ENOENT/)
    expect(release).toHaveBeenCalledOnce()

    const call = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      errorCategory: 'error',
      framework: 'opencode',
      generation: 1,
      status: 'connecting'
    })
  })

  it('logs "agent connection abandoned" when a real async resolveBackend is superseded mid-resolution by a public disconnect()', async () => {
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    const { lease, release } = createBackendLeaseHarness()
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
      // supersedes AFTER the connect is inside the resolver (past the pre-spawn teardown), so the
      // supersede is detected when the resolved backend is prepared, before the child can spawn.
      resolveBackend: async () => {
        signalEntered()
        await backendGate

        return {
          framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent',
          env: {},
          responsesBridgeLease: lease
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

    // The connect detects the supersede before spawning. Key guarantees: the resolved bridge lease is
    // released, the attempt is logged as *abandoned* with safe lifecycle context, and it is NOT also
    // raised as the error-level "failed" record.
    expect(release).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)
    const abandoned = warnLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection abandoned (superseded or shutting down)'
    )
    expect(abandoned).toBeDefined()
    expect(abandoned?.[1]).toEqual({
      errorCategory: 'error',
      framework: 'claude-code',
      generation: 1,
      status: 'closed'
    })
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
    expect(call?.[1]).toEqual({
      errorCategory: 'string',
      framework: 'opencode',
      generation: 1,
      status: 'connecting'
    })
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

describe('ACP runtime — model hot switch', () => {
  const modelOption = (): SessionConfigOption =>
    ({
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'model-a',
      options: ['model-a', 'model-b', 'model-c'].map((value) => ({ value, name: value }))
    }) as SessionConfigOption

  const modelTarget = (
    model: string,
    overrides: Partial<AgentModelChangeTarget> = {}
  ): AgentModelChangeTarget => ({
    frameworkId: 'claude-code',
    backendId: 'claude-code:provider-a',
    route: 'claude-anthropic',
    model,
    sessionModel: model,
    sessionModelRequired: false,
    supportsImageInput: true,
    reasoningEffort: 'default',
    ...overrides
  })

  const createModelRuntime = (
    process: FakeAgentProcess,
    spawn = vi.fn(),
    supportsImageInput = true
  ): { spawn: ReturnType<typeof vi.fn>; runtime: AcpRuntime } => {
    spawn.mockImplementation(() => asAgentProcess(process))
    return {
      spawn,
      runtime: new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...claudeCodeFramework, spawn },
          backendId: 'claude-code:provider-a',
          modelRoute: 'claude-anthropic',
          executablePath: '/bin/claude',
          env: {},
          sessionModel: 'model-a',
          supportsImageInput,
          contextUsageModel: 'model-a'
        })
      })
    }
  }

  it('reports model facts only while the Session has an active attachment', async () => {
    const initialProcess = new FakeAgentProcess()
    const resumedProcess = new FakeAgentProcess()
    startFakeAgent(initialProcess, ['s-model'], { configOptions: [modelOption()] })
    startFakeAgent(resumedProcess, [], { configOptions: [modelOption()] })
    let spawnCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => asAgentProcess(spawnCount++ === 0 ? initialProcess : resumedProcess)
        },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-a',
        supportsImageInput: true,
        contextUsageModel: 'model-a'
      })
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    expect(runtime.captureSessionModel(session.sessionId)).toMatchObject({
      backend: { context: { model: 'model-a' } }
    })

    await runtime.disconnect()
    expect(runtime.captureSessionModel(session.sessionId)).toBeUndefined()

    await runtime.resumeSession({ sessionId: session.sessionId, cwd: '/workspace' })
    expect(runtime.captureSessionModel(session.sessionId)).toMatchObject({
      backend: { context: { model: 'model-a' } }
    })
  })

  it('switches every idle session and the generation default without replacing the process', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-model-1', 's-model-2', 's-model-3'], {
      configOptions: [modelOption()]
    })
    const { runtime, spawn } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await expect(runtime.applyModelChange(modelTarget('model-b'))).resolves.toBe(true)
    await runtime.createSession({ cwd: '/workspace' })

    expect(spawn).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-model-1', configId: 'model', value: 'model-b' },
      { sessionId: 's-model-2', configId: 'model', value: 'model-b' },
      { sessionId: 's-model-3', configId: 'model', value: 'model-b' }
    ])
  })

  it('hot-switches an advertised model across compatible Claude backend identities', async () => {
    const process = new FakeAgentProcess()
    const configOptions = [modelOption()]
    const fakeAgent = startFakeAgent(process, ['s-model'], {
      configOptions,
      onSetConfigOption: ({ value }) => {
        const model = configOptions[0]
        if (model.type === 'select' && typeof value === 'string') model.currentValue = value
      }
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const setTarget = vi.fn(() => true)
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-a',
        supportsImageInput: false,
        contextUsageModel: 'model-a',
        anthropicBridgeLease: {
          setTarget,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await expect(
      runtime.applyModelChange(
        modelTarget('model-b', {
          backendId: 'claude-code:provider-b',
          anthropicBridgeTargetId: 'provider-b/model-b',
          supportsImageInput: false
        })
      )
    ).resolves.toBe(true)
    await expect(
      runtime.applyModelChange(
        modelTarget('model-a', {
          backendId: 'claude-code:provider-a',
          anthropicBridgeTargetId: 'provider-a/model-a',
          supportsImageInput: false
        })
      )
    ).resolves.toBe(true)

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-model', configId: 'model', value: 'model-b' },
      { sessionId: 's-model', configId: 'model', value: 'model-a' }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    expect(setTarget.mock.calls).toEqual([['provider-b/model-b'], ['provider-a/model-a']])
    expect(process.killed).toBe(false)
  })

  it('hot-switches OpenCode across pre-registered provider transports', async () => {
    const process = new FakeAgentProcess()
    const configOptions = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'open-science-a/model-a',
        options: ['open-science-a/model-a', 'open-science-b/model-b'].map((value) => ({
          value,
          name: value
        }))
      } as SessionConfigOption
    ]
    const fakeAgent = startFakeAgent(process, ['s-opencode-provider'], {
      configOptions,
      onSetConfigOption: ({ value }) => {
        const model = configOptions[0]
        if (model.type === 'select' && typeof value === 'string') model.currentValue = value
      }
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const setTarget = vi.fn(() => true)
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn },
        backendId: 'opencode:provider-a',
        modelRoute: 'opencode-openai',
        executablePath: '/bin/opencode',
        env: {},
        sessionModel: 'open-science-a/model-a',
        supportsImageInput: false,
        contextUsageModel: 'model-a',
        providerTransportLease: {
          setTarget,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange({
      frameworkId: 'opencode',
      backendId: 'opencode:provider-b',
      route: 'opencode-openai',
      model: 'model-b',
      sessionModel: 'open-science-b/model-b',
      sessionModelRequired: false,
      supportsImageInput: false,
      reasoningEffort: 'default',
      providerTransportTargetId: JSON.stringify(['opencode', 'provider-b', 'model-b'])
    })

    expect(setTarget).toHaveBeenCalledWith(JSON.stringify(['opencode', 'provider-b', 'model-b']))
    expect(fakeAgent.configChanges).toEqual([
      {
        sessionId: 's-opencode-provider',
        configId: 'model',
        value: 'open-science-b/model-b'
      }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)
  })

  it('falls back when no primary session can verify that the agent advertises the model', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, [], { configOptions: [modelOption()] })
    const { runtime } = createModelRuntime(process)
    await runtime.connect({ cwd: '/workspace' })

    await expect(runtime.applyModelChange(modelTarget('model-b'))).resolves.toBe(false)

    expect(process.killed).toBe(false)
  })

  it('reconnects when switching from a text-only model to an image-capable model', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-model'], { configOptions: [modelOption()] })
    const { runtime } = createModelRuntime(process, vi.fn(), false)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange(modelTarget('model-b'))

    expect(fakeAgent.configChanges).toEqual([])
    expect(process.killed).toBe(true)
  })

  it.each([
    ['OpenCode', opencodeFramework, 'opencode-openai', 'opencode:provider-a'],
    ['native Codex', codexFramework, 'codex-responses', 'codex:provider-a']
  ] as const)(
    'reconnects %s before switching to a text-only model',
    async (_name, framework, route, backendId) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgent(process, ['s-model'], {
        configOptions: [modelOption()],
        ...(framework.id === 'codex'
          ? { modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent') }
          : {})
      })
      const spawn = vi.fn(() => asAgentProcess(process))
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn },
          backendId,
          modelRoute: route,
          executablePath: '/bin/agent',
          env: {},
          sessionModel: 'model-a',
          supportsImageInput: true,
          contextUsageModel: 'model-a'
        })
      })
      await runtime.createSession({ cwd: '/workspace' })
      fakeAgent.configChanges.length = 0

      await runtime.applyModelChange({
        frameworkId: framework.id,
        backendId,
        route,
        model: 'model-b',
        sessionModel: 'model-b',
        sessionModelRequired: false,
        supportsImageInput: false,
        reasoningEffort: 'default'
      })

      expect(fakeAgent.configChanges).toEqual([])
      expect(process.killed).toBe(true)
    }
  )

  it('retargets an image-capable Codex bridge but reconnects before an image downgrade', async () => {
    const process = new FakeAgentProcess()
    const setModelTarget = vi.fn()
    const setProviderTarget = vi.fn(() => true)
    const fakeAgent = startFakeAgent(process, ['s-bridge-model'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn },
        backendId: 'codex:provider-a',
        modelRoute: 'codex-bridge',
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: CODEX_BRIDGE_MODEL,
        supportsImageInput: true,
        contextUsageModel: 'model-a',
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          setModelTarget,
          release: vi.fn(async () => undefined)
        },
        providerTransportLease: {
          setTarget: setProviderTarget,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange({
      frameworkId: 'codex',
      backendId: 'codex:provider-b',
      route: 'codex-bridge',
      model: 'model-b',
      sessionModel: CODEX_BRIDGE_MODEL,
      sessionModelRequired: false,
      supportsImageInput: true,
      reasoningEffort: 'high',
      providerTransportTargetId: JSON.stringify(['codex', 'provider-b', 'model-b']),
      bridge: {
        model: 'model-b',
        vendorId: 'deepseek',
        reasoningEffortTransport: 'deepseek'
      }
    })

    expect(setModelTarget).toHaveBeenCalledWith({
      model: 'model-b',
      vendorId: 'deepseek',
      reasoningEffortTransport: 'deepseek',
      reasoningEffort: 'high'
    })
    expect(setProviderTarget).toHaveBeenCalledWith(
      JSON.stringify(['codex', 'provider-b', 'model-b'])
    )
    expect(fakeAgent.configChanges).toEqual([])
    expect(spawn).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)

    setModelTarget.mockClear()
    await runtime.applyModelChange({
      frameworkId: 'codex',
      backendId: 'codex:provider-a',
      route: 'codex-bridge',
      model: 'model-c',
      sessionModel: CODEX_BRIDGE_MODEL,
      sessionModelRequired: false,
      supportsImageInput: false,
      reasoningEffort: 'default',
      providerTransportTargetId: JSON.stringify(['codex', 'provider-a', 'model-c']),
      bridge: { model: 'model-c' }
    })

    expect(setModelTarget).not.toHaveBeenCalled()
    expect(setProviderTarget).toHaveBeenCalledOnce()
    expect(process.killed).toBe(true)
  })

  it('reconnects native Codex before switching providers that share one model slug', async () => {
    const process = new FakeAgentProcess()
    const setProviderTarget = vi.fn(() => true)
    const fakeAgent = startFakeAgent(process, ['s-native-model'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      configOptions: [modelOption()]
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn },
        backendId: 'codex:provider-a',
        modelRoute: 'codex-responses',
        executablePath: '/bin/codex-acp',
        env: {},
        sessionModel: 'model-a',
        supportsImageInput: true,
        contextUsageModel: 'model-a',
        providerTransportLease: {
          setTarget: setProviderTarget,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange({
      frameworkId: 'codex',
      backendId: 'codex:provider-b',
      route: 'codex-responses',
      model: 'model-a',
      sessionModel: 'model-a',
      sessionModelRequired: false,
      supportsImageInput: false,
      reasoningEffort: 'default',
      providerTransportTargetId: JSON.stringify(['codex', 'provider-b', 'model-a'])
    })

    expect(setProviderTarget).not.toHaveBeenCalled()
    expect(fakeAgent.configChanges).toEqual([])
    expect(process.killed).toBe(true)
  })

  it('clears an advertised effort override when the switched model resolves to default', async () => {
    const process = new FakeAgentProcess()
    const effortOption = {
      type: 'select',
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'high',
      options: ['default', 'high'].map((value) => ({ value, name: value }))
    } as SessionConfigOption
    const fakeAgent = startFakeAgent(process, ['s-default-effort'], {
      configOptions: [modelOption(), effortOption]
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-a',
        sessionEffort: 'high',
        supportsImageInput: true,
        contextUsageModel: 'model-a'
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange(modelTarget('model-b'))

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-default-effort', configId: 'model', value: 'model-b' },
      { sessionId: 's-default-effort', configId: 'effort', value: 'default' }
    ])
    expect(process.killed).toBe(false)
  })

  it('adapts CodeBuddy default effort while hot-switching models', async () => {
    const process = new FakeAgentProcess()
    const effortOption = {
      type: 'select',
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'high',
      options: ['enabled', 'high'].map((value) => ({ value, name: value }))
    } as SessionConfigOption
    const fakeAgent = startFakeAgent(process, ['s-codebuddy-default-effort'], {
      configOptions: [modelOption(), effortOption]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codeBuddyFramework, spawn: () => asAgentProcess(process) },
        backendId: 'codebuddy:provider-a',
        modelRoute: 'codebuddy-openai',
        executablePath: '/bin/codebuddy',
        env: {},
        sessionModel: 'model-a',
        sessionEffort: 'high',
        supportsImageInput: true,
        contextUsageModel: 'model-a'
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    await runtime.applyModelChange(
      modelTarget('model-b', {
        frameworkId: 'codebuddy',
        backendId: 'codebuddy:provider-a',
        route: 'codebuddy-openai'
      })
    )

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-codebuddy-default-effort', configId: 'model', value: 'model-b' },
      { sessionId: 's-codebuddy-default-effort', configId: 'effort', value: 'enabled' }
    ])
    expect(process.killed).toBe(false)
  })

  it('keeps the generating message on its model and applies only the latest queued selection', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-model'], {
      configOptions: [modelOption()],
      onPrompt: async ({ text }) => {
        if (text === 'old-model turn') {
          promptStarted.resolve()
          await finishPrompt.promise
        }
        return { stopReason: 'end_turn' }
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const oldPrompt = runtime.sendPrompt({ sessionId: 's-model', text: 'old-model turn' })
    await promptStarted.promise

    await expect(runtime.applyModelChange(modelTarget('model-b'))).resolves.toBe(true)
    await expect(runtime.applyModelChange(modelTarget('model-c'))).resolves.toBe(true)
    const nextPrompt = runtime.sendPrompt({ sessionId: 's-model', text: 'new-model turn' })

    expect(fakeAgent.configChanges).toEqual([])
    expect(fakeAgent.prompts.map(({ text }) => text)).toEqual(['old-model turn'])

    finishPrompt.resolve()
    await oldPrompt
    await nextPrompt

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-model', configId: 'model', value: 'model-c' }
    ])
    expect(fakeAgent.prompts.map(({ text }) => text)).toEqual(['old-model turn', 'new-model turn'])
  })

  it('holds a new session behind a queued model switch', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-existing', 's-created-after-switch'], {
      configOptions: [modelOption()],
      onPrompt: async () => {
        promptStarted.resolve()
        await finishPrompt.promise
        return { stopReason: 'end_turn' }
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const prompt = runtime.sendPrompt({ sessionId: 's-existing', text: 'old-model turn' })
    await promptStarted.promise
    await runtime.applyModelChange(modelTarget('model-b'))
    const create = runtime.createSession({ cwd: '/workspace' })

    await Promise.resolve()
    expect(fakeAgent.newSessions).toHaveLength(1)

    finishPrompt.resolve()
    await prompt
    await create

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-existing', configId: 'model', value: 'model-b' },
      { sessionId: 's-created-after-switch', configId: 'model', value: 'model-b' }
    ])
  })

  it('includes a session whose creation is in progress when draining a queued model switch', async () => {
    const process = new FakeAgentProcess()
    const creationStarted = createDeferred()
    const finishCreation = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-existing', 's-creating'], {
      configOptions: [modelOption()],
      onNewSession: async ({ index }) => {
        if (index !== 1) return
        creationStarted.resolve()
        await finishCreation.promise
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const create = runtime.createSession({ cwd: '/workspace' })
    await creationStarted.promise
    await runtime.applyModelChange(modelTarget('model-b'))
    expect(fakeAgent.configChanges).toEqual([])

    finishCreation.resolve()
    await create
    await vi.waitFor(() => expect(fakeAgent.configChanges).toHaveLength(2))

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-existing', configId: 'model', value: 'model-b' },
      { sessionId: 's-creating', configId: 'model', value: 'model-b' }
    ])
  })

  it('applies a newer effort change after a queued model switch', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const effortOption = {
      type: 'select',
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'default',
      options: ['default', 'low', 'high'].map((value) => ({ value, name: value }))
    } as SessionConfigOption
    const fakeAgent = startFakeAgent(process, ['s-model-effort'], {
      configOptions: [modelOption(), effortOption],
      onPrompt: async ({ text }) => {
        if (text === 'old-model turn') {
          promptStarted.resolve()
          await finishPrompt.promise
        }
        return { stopReason: 'end_turn' }
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const prompt = runtime.sendPrompt({ sessionId: 's-model-effort', text: 'old-model turn' })
    await promptStarted.promise

    await runtime.applyModelChange(modelTarget('model-b', { reasoningEffort: 'high' }))
    const effortChange = runtime.applyReasoningEffortChange('low')

    finishPrompt.resolve()
    await prompt
    await expect(effortChange).resolves.toBe(true)
    await runtime.sendPrompt({ sessionId: 's-model-effort', text: 'new-model turn' })

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-model-effort', configId: 'model', value: 'model-b' },
      { sessionId: 's-model-effort', configId: 'effort', value: 'high' },
      { sessionId: 's-model-effort', configId: 'effort', value: 'low' }
    ])
  })

  it('waits for a generating Claude message before retargeting its upstream provider', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const setTarget = vi.fn(() => true)
    const configOptions = [modelOption()]
    const fakeAgent = startFakeAgent(process, ['s-provider-switch'], {
      configOptions,
      onPrompt: async () => {
        promptStarted.resolve()
        await finishPrompt.promise
        return { stopReason: 'end_turn' }
      },
      onSetConfigOption: ({ value }) => {
        const model = configOptions[0]
        if (model.type === 'select' && typeof value === 'string') model.currentValue = value
      }
    })
    const spawn = vi.fn(() => asAgentProcess(process))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn },
        backendId: 'claude-code:provider-a',
        modelRoute: 'claude-anthropic',
        executablePath: '/bin/claude',
        env: {},
        sessionModel: 'model-a',
        supportsImageInput: true,
        contextUsageModel: 'model-a',
        anthropicBridgeLease: {
          setTarget,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0
    const prompt = runtime.sendPrompt({
      sessionId: 's-provider-switch',
      text: 'stay on provider a'
    })
    await promptStarted.promise

    await runtime.applyModelChange(
      modelTarget('model-b', {
        backendId: 'claude-code:provider-b',
        anthropicBridgeTargetId: 'provider-b/model-b'
      })
    )

    expect(setTarget).not.toHaveBeenCalled()
    expect(fakeAgent.configChanges).toEqual([])
    expect(process.killed).toBe(false)

    finishPrompt.resolve()
    await prompt
    await vi.waitFor(() => {
      expect(setTarget).toHaveBeenCalledWith('provider-b/model-b')
      expect(fakeAgent.configChanges).toHaveLength(1)
    })

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-provider-switch', configId: 'model', value: 'model-b' }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    expect(process.killed).toBe(false)
  })

  it('cancels a queued switch when the user selects the currently applied model again', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-model'], {
      configOptions: [modelOption()],
      onPrompt: async () => {
        promptStarted.resolve()
        await finishPrompt.promise
        return { stopReason: 'end_turn' }
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0
    const prompt = runtime.sendPrompt({ sessionId: 's-model', text: 'keep model a' })
    await promptStarted.promise

    await runtime.applyModelChange(modelTarget('model-b', { supportsImageInput: false }))
    await runtime.applyModelChange(modelTarget('model-a'))
    finishPrompt.resolve()
    await prompt

    expect(fakeAgent.configChanges).toEqual([])
    expect(process.killed).toBe(false)
  })

  it('waits for the active Claude message before reconnecting for an image downgrade', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-model'], {
      configOptions: [modelOption()],
      onPrompt: async () => {
        promptStarted.resolve()
        await finishPrompt.promise
        return { stopReason: 'end_turn' }
      }
    })
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0
    const prompt = runtime.sendPrompt({ sessionId: 's-model', text: 'finish before downgrade' })
    await promptStarted.promise

    await runtime.applyModelChange(modelTarget('model-b', { supportsImageInput: false }))

    expect(fakeAgent.configChanges).toEqual([])
    expect(process.killed).toBe(false)

    finishPrompt.resolve()
    await prompt
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('idle'))
    expect(process.killed).toBe(true)
    expect(fakeAgent.configChanges).toEqual([])
  })

  it('falls back to a reconnect instead of leaving a partially switched generation', async () => {
    const process = new FakeAgentProcess()
    const agentOptions: Parameters<typeof startFakeAgent>[2] = {
      configOptions: [modelOption()]
    }
    startFakeAgent(process, ['s-model'], agentOptions)
    const { runtime } = createModelRuntime(process)
    await runtime.createSession({ cwd: '/workspace' })
    agentOptions.rejectSetConfigOption = true

    await expect(runtime.applyModelChange(modelTarget('model-b'))).resolves.toBe(true)

    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().status).toBe('idle')
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
    sessionEffort: ModelReasoningEffort | undefined,
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

  it('applies CodeBuddy effort aliases through its framework adapter', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-codebuddy-effort'], {
      configOptions: [thoughtLevelOption(['disabled', 'high', 'enabled'])]
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codeBuddyFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codebuddy',
        env: {},
        sessionEffort: 'none'
      })
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-codebuddy-effort', configId: 'effort', value: 'disabled' }
    ])

    await expect(runtime.applyReasoningEffortChange('default')).resolves.toBe(true)
    expect(fakeAgent.configChanges[1]).toEqual({
      sessionId: 's-codebuddy-effort',
      configId: 'effort',
      value: 'enabled'
    })
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

  it('does not reinterpret an unadvertised model-resolved effort', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort'], {
      configOptions: [thoughtLevelOption(['low', 'medium'])]
    })
    const runtime = createEffortRuntime(process, 'max')

    await runtime.createSession({ cwd: '/workspace' })

    // The Agent layer is only a transport. It must not replace max with medium.
    expect(fakeAgent.configChanges).toEqual([])
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

    // Neither the stale nor the post-switch option set contains the model-resolved max value.
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-effort', configId: 'model', value: 'model-b' }
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

    const applied = await runtime.applyReasoningEffortChange('high')

    // The open session gets the exact model-resolved level over ACP, still on the original process.
    expect(applied).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-live', configId: 'effort', value: 'high' }
    ])

    // Sessions created later in the same process inherit the new level.
    await runtime.createSession({ cwd: '/workspace' })
    expect(fakeAgent.configChanges[1]).toMatchObject({ configId: 'effort', value: 'high' })
  })

  it('keeps an admitted background activity on its original reasoning effort', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['s-effort-activity'], {
      configOptions: [thoughtLevelOption(['default', 'low', 'high'])]
    })
    const runtime = createEffortRuntime(process, 'low')
    const activityStarted = createDeferred()
    const finishActivity = createDeferred()
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const activity = runtime.withActivity({}, async () => {
      activityStarted.resolve()
      await finishActivity.promise
    })
    await activityStarted.promise

    await expect(runtime.applyReasoningEffortChange('high')).resolves.toBe(false)
    expect(fakeAgent.configChanges).toEqual([])

    finishActivity.resolve()
    await activity
  })

  it('keeps a session created concurrently with a live effort change on the new level', async () => {
    const process = new FakeAgentProcess()
    const staleConfigurationStarted = createDeferred()
    const finishStaleConfiguration = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-existing', 's-creating'], {
      configOptions: [thoughtLevelOption(['default', 'low', 'high'])],
      onSetConfigOption: async ({ sessionId, value }) => {
        if (sessionId !== 's-creating' || value !== 'low') return
        staleConfigurationStarted.resolve()
        await finishStaleConfiguration.promise
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {},
        sessionEffort: 'low'
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0

    const create = runtime.createSession({ cwd: '/workspace' })
    await staleConfigurationStarted.promise
    await runtime.applyReasoningEffortChange('high')
    finishStaleConfiguration.resolve()
    await create

    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 's-creating', configId: 'effort', value: 'low' },
      { sessionId: 's-existing', configId: 'effort', value: 'high' },
      { sessionId: 's-creating', configId: 'effort', value: 'high' }
    ])
  })

  it('updates only the runtime-owned Responses bridge with a live effort change', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s-bridge-effort'], {
      configOptions: [thoughtLevelOption(['default', 'high'])]
    })
    const setReasoningEffort = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/claude',
        env: {},
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          setReasoningEffort,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })

    await runtime.applyReasoningEffortChange('high')
    await runtime.applyReasoningEffortChange('default')

    expect(setReasoningEffort).toHaveBeenNthCalledWith(1, 'high')
    expect(setReasoningEffort).toHaveBeenNthCalledWith(2, undefined)
  })

  it('defers a new-model effort while the old provider is waiting to reconnect', async () => {
    const process = new FakeAgentProcess()
    const promptStarted = createDeferred()
    const finishPrompt = createDeferred()
    const fakeAgent = startFakeAgent(process, ['s-old-model'], {
      configOptions: [thoughtLevelOption(['default', 'high', 'max'])],
      onPrompt: async () => {
        promptStarted.resolve()
        await finishPrompt.promise
        return { stopReason: 'end_turn' }
      }
    })
    const setReasoningEffort = vi.fn()
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => asAgentProcess(process)
        },
        executablePath: '/bin/claude',
        env: {},
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          setReasoningEffort,
          release: vi.fn(async () => undefined)
        }
      })
    })
    await runtime.createSession({ cwd: '/workspace' })
    const prompt = runtime.sendPrompt({ sessionId: 's-old-model', text: 'keep working' })
    await promptStarted.promise
    await runtime.requestProviderReconnect()

    await expect(runtime.applyReasoningEffortChange('max')).resolves.toBe(false)
    expect(fakeAgent.configChanges).toEqual([])
    expect(setReasoningEffort).not.toHaveBeenCalled()

    finishPrompt.resolve()
    await prompt
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
    await runtime.applyReasoningEffortChange('high')

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

    // The post-switch set does not expose max, so the transport must not substitute medium.
    expect(applied).toBe(true)
    expect(fakeAgent.configChanges).toEqual([])
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

  it('attempts every remaining open session after a live effort update is rejected', async () => {
    const process = new FakeAgentProcess()
    let rejectLiveUpdate = false
    const fakeAgent = startFakeAgent(process, ['rejected-session', 'updated-session'], {
      configOptions: [thoughtLevelOption(['low', 'high'])],
      onSetConfigOption: ({ sessionId }) => {
        if (rejectLiveUpdate && sessionId === 'rejected-session') {
          throw new Error('live effort rejected')
        }
      }
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
    await runtime.createSession({ cwd: '/workspace' })
    fakeAgent.configChanges.length = 0
    rejectLiveUpdate = true

    const applied = await runtime.applyReasoningEffortChange('high')

    expect(applied).toBe(false)
    expect(fakeAgent.configChanges).toEqual([
      { sessionId: 'rejected-session', configId: 'effort', value: 'high' },
      { sessionId: 'updated-session', configId: 'effort', value: 'high' }
    ])
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
    expect(call?.[1]).toEqual({
      errorCategory: 'request',
      framework: 'opencode',
      generation: 1,
      status: 'connected'
    })
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
      projectId: 'my-project'
    })

    // Helper: fetch a breadcrumb's payload by message.
    const payloadOf = (message: string): Record<string, unknown> | undefined =>
      infoLogSpy.mock.calls.find(([m]) => m === message)?.[1] as Record<string, unknown> | undefined

    // Every stage leaves a breadcrumb, but its payload is a strict lifecycle whitelist.
    for (const message of [
      'createSession: starting',
      'createSession: ensureConnected',
      'createSession: createMcpServers',
      'createSession: buildSession',
      'createSession: configurePermissionProfile',
      'createSession: applySessionModel',
      'createSession: completed successfully',
      'ensureConnected: attempting connection',
      'ensureConnected: connection established'
    ]) {
      expect(payloadOf(message)).toEqual({
        framework: 'claude-code',
        generation: expect.any(Number),
        status: expect.stringMatching(/^(?:idle|connecting|connected)$/)
      })
    }
    expect(session.sessionId).toBe('staged-session')
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
    expect(createFailure?.[1]).toEqual({
      errorCategory: 'error',
      framework: 'claude-code',
      generation: 1,
      status: 'error'
    })
  })

  it('logs a safe category when permission-profile setup throws', async () => {
    errorLogSpy.mockClear()
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['perm-fail-session', 'perm-fail-session'])
    const boom = Object.assign(new Error('permission setup failed'), { code: 'EPERM' })
    const mapPermissionProfile = vi
      .fn(claudeCodeFramework.mapPermissionProfile)
      .mockImplementationOnce(() => {
        throw boom
      })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: { ...claudeCodeFramework, mapPermissionProfile }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(boom)
    const call = errorLogSpy.mock.calls.find(([message]) => message === 'createSession: failed')
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      errorCategory: 'permission',
      framework: 'claude-code',
      generation: 1,
      status: 'connected'
    })

    const recovered = await runtime.createSession({ cwd: '/workspace' })
    expect(recovered.sessionId).toBe('perm-fail-session')
    await runtime.deleteSession({ sessionId: recovered.sessionId })
  })

  it('releases the provisional notebook RPC capability when session creation fails', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['perm-fail-session'])
    const releaseSessionCapabilities = vi.fn()
    const failure = new Error('permission setup failed')
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: {
        ...claudeCodeFramework,
        mapPermissionProfile: () => {
          throw failure
        }
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        releaseSessionCapabilities
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(failure)

    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(
      expect.stringMatching(/^notebook-session-/)
    )
  })

  it('releases owned session metadata after its exact provisional capability fails to publish', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['perm-fail-session'])
    const release = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const failure = new Error('permission setup failed')
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: {
        ...claudeCodeFramework,
        mapPermissionProfile: () => {
          throw failure
        }
      },
      notebook: {
        projectId: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token',
          release
        }),
        releaseSessionCapabilities
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toBe(failure)

    expect(release).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith(
      expect.stringMatching(/^notebook-session-/)
    )
  })

  it('logs backend and spawn success without executable, arguments, env, or pid', async () => {
    infoLogSpy.mockClear()
    const process = new FakeAgentProcess()
    process.pid = 7654
    startFakeAgent(process, ['spawn-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/private/agent-secret/bin/agent',
        env: { ANTHROPIC_AUTH_TOKEN: 'secret-should-not-be-logged', REGION: 'us' },
        args: ['--token=argument-secret']
      })
    })

    await runtime.createSession({ cwd: '/workspace' })

    const resolved = infoLogSpy.mock.calls.find(([message]) => message === 'agent backend resolved')
    expect(resolved).toBeDefined()
    expect(resolved?.[1]).toEqual({
      framework: 'claude-code',
      generation: 1,
      status: 'connecting'
    })
    expect(JSON.stringify(resolved?.[1])).not.toMatch(
      /secret-should-not-be-logged|argument-secret|agent-secret|ANTHROPIC_AUTH_TOKEN/
    )

    const spawned = infoLogSpy.mock.calls.find(([message]) => message === 'agent process spawned')
    expect(spawned?.[1]).toEqual({
      framework: 'claude-code',
      generation: 1,
      status: 'connecting'
    })
    expect(JSON.stringify(spawned?.[1])).not.toContain('7654')
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
    expect(call?.[1]).toEqual({
      errorCategory: 'connection-unavailable',
      framework: 'claude-code',
      generation: 0,
      status: 'idle'
    })
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
    const disconnectSpy = vi.spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
    disconnectSpy.mockResolvedValueOnce(runtime.getSnapshot())
    disconnectSpy.mockRejectedValueOnce(new Error('cleanup boom'))

    // The rejection is the ORIGINAL spawn failure, not the cleanup error.
    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/spawn boom/)

    // Both failures are categorized without retaining their messages, and cleanup never masks the
    // original rejection.
    const failed = errorLogSpy.mock.calls.find(([message]) => message === 'agent connection failed')
    expect((failed?.[1] as { errorCategory: string }).errorCategory).toBe('error')
    const cleanup = errorLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection cleanup failed'
    )
    expect(cleanup).toBeDefined()
    expect(cleanup?.[1]).toEqual({
      errorCategory: 'error',
      framework: 'claude-code',
      generation: 1,
      status: 'connecting'
    })
  })

  it('does not let bridge release and logger failures mask the original spawn error', async () => {
    const release = vi.fn().mockRejectedValue(new Error('bridge release failed'))
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...claudeCodeFramework,
          spawn: () => {
            throw new Error('primary spawn failed')
          }
        },
        executablePath: '/bin/agent',
        env: {},
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => true),
          release
        }
      })
    })

    errorLogSpy.mockImplementation(() => {
      throw new Error('cleanup logger failed')
    })
    try {
      await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(
        'primary spawn failed'
      )
      expect(release).toHaveBeenCalledOnce()
    } finally {
      errorLogSpy.mockReset()
    }
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
    expect((failed?.[1] as { errorCategory: string; framework: string }).framework).toBe(
      'claude-code'
    )
    expect((failed?.[1] as { errorCategory: string }).errorCategory).toBe('error')
    expect(typeof runtime.getSnapshot().error).toBe('string')
  })

  it('does not log request or provider-error secrets during session creation', async () => {
    infoLogSpy.mockClear()
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const requestSecret = 'request-research-secret'
    const providerSecret = 'provider-credential-secret'
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['unused-session'], {
      newSessionError: acp.RequestError.internalError(
        { credential: providerSecret, research: requestSecret },
        `provider rejected ${providerSecret}`
      )
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.createSession({
        cwd: `/private/${requestSecret}`,
        projectId: requestSecret
      })
    ).rejects.toThrow()

    const serializedLogs = JSON.stringify([
      ...infoLogSpy.mock.calls,
      ...warnLogSpy.mock.calls,
      ...errorLogSpy.mock.calls
    ])
    expect(serializedLogs).not.toContain(requestSecret)
    expect(serializedLogs).not.toContain(providerSecret)
    const failure = errorLogSpy.mock.calls.find(([message]) => message === 'createSession: failed')
    expect(failure?.[1]).toEqual({
      errorCategory: 'request',
      framework: 'claude-code',
      generation: 1,
      status: 'connected'
    })
  })

  it('does not log spawn inputs or sensitive spawn-error fields', async () => {
    infoLogSpy.mockClear()
    warnLogSpy.mockClear()
    errorLogSpy.mockClear()
    const spawnSecret = 'spawn-provider-secret'
    const spawnError = Object.assign(new Error(`spawn rejected ${spawnSecret}`), {
      code: 'ENOENT',
      data: { credential: spawnSecret },
      path: `/private/${spawnSecret}`
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: {
          ...opencodeFramework,
          spawn: () => {
            throw spawnError
          }
        },
        executablePath: `/private/${spawnSecret}/agent`,
        env: { PROVIDER_TOKEN: spawnSecret },
        args: [`--credential=${spawnSecret}`]
      })
    })

    await expect(runtime.createSession({ cwd: `/workspace/${spawnSecret}` })).rejects.toBe(
      spawnError
    )

    const serializedLogs = JSON.stringify([
      ...infoLogSpy.mock.calls,
      ...warnLogSpy.mock.calls,
      ...errorLogSpy.mock.calls
    ])
    expect(serializedLogs).not.toContain(spawnSecret)
    const failure = errorLogSpy.mock.calls.find(
      ([message]) => message === 'agent connection failed'
    )
    expect(failure?.[1]).toEqual({
      errorCategory: 'not-found',
      framework: 'opencode',
      generation: 1,
      status: 'connecting'
    })
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

  it('does not overwrite a reentrant failure-event disconnect with error status', async () => {
    const spawnError = new Error('spawn failed before disconnect')
    const statuses: string[] = []
    let disconnect: Promise<unknown> | undefined
    const callbacks: { disconnectRuntime?: () => Promise<unknown> } = {}
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: {
        onEvent: (event) => {
          if (event.title === 'Connection failed') disconnect = callbacks.disconnectRuntime?.()
        },
        onStateChanged: (snapshot) => statuses.push(snapshot.status)
      },
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
    callbacks.disconnectRuntime = () => runtime.disconnect()

    await expect(runtime.connect({ cwd: '/workspace' })).rejects.toBe(spawnError)
    expect(disconnect).toBeDefined()
    await disconnect

    expect(runtime.getSnapshot().status).toBe('closed')
    expect(statuses.at(-1)).toBe('closed')
    expect(statuses).not.toContain('error')
  })

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
    const disconnectSpy = vi.spyOn(connectionCloseForTest(runtime), 'disconnectCurrent')
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
    const boom = new Error('permission setup failed')
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: {
        ...claudeCodeFramework,
        mapPermissionProfile: () => {
          throw boom
        }
      }
    })
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
        ;(
          runtime as unknown as {
            connectionResources: { supersede: () => number }
          }
        ).connectionResources.supersede()
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

describe('Specialist Skill scoping', () => {
  const specialistSkillResolver = (
    specialistId: string
  ): Promise<{
    kind: 'specialist'
    skillIds: string[]
    frameworkNames: string[]
    missingSkillIds: string[]
  }> =>
    Promise.resolve(
      specialistId === 'zero'
        ? { kind: 'specialist' as const, skillIds: [], frameworkNames: [], missingSkillIds: [] }
        : {
            kind: 'specialist' as const,
            skillIds: ['allowed'],
            frameworkNames: ['Allowed Skill'],
            missingSkillIds: []
          }
    )

  it('sends Claude an exact whitelist and rejects an out-of-scope forced chip', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['specialist-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      resolveSpecialistIdentity: async () => ({ append: 'Specialist identity', prefix: '' }),
      resolveSpecialistSkills: async () => ({
        kind: 'specialist',
        skillIds: ['allowed'],
        frameworkNames: ['Allowed Skill'],
        missingSkillIds: []
      })
    })

    const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-1' })
    expect(agent.newSessions[0]?._meta).toMatchObject({
      claudeCode: { options: { skills: ['Allowed Skill'] } }
    })
    await expect(
      runtime.sendPrompt({
        sessionId: session.sessionId,
        text: 'bypass',
        forcedSkillIds: ['blocked']
      })
    ).rejects.toThrow('not available to the active specialist')
    expect(agent.prompts).toHaveLength(0)
  })

  it('invalidates a Specialist preflight when context reset replaces the provider session', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['specialist-session-1', 'specialist-session-2'])
    const promptPreflightEntered = createDeferred()
    const releasePromptPreflight = createDeferred()
    let resolutionCount = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      resolveSpecialistIdentity: async () => ({ append: 'Specialist identity', prefix: '' }),
      resolveSpecialistSkills: async () => {
        resolutionCount += 1
        if (resolutionCount === 2) {
          promptPreflightEntered.resolve()
          await releasePromptPreflight.promise
        }
        return {
          kind: 'specialist' as const,
          skillIds: ['allowed'],
          frameworkNames: ['Allowed Skill'],
          missingSkillIds: []
        }
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-1' })
    const stalePrompt = runtime.sendPrompt({ sessionId: session.sessionId, text: 'stale prompt' })
    void stalePrompt.catch(() => undefined)
    await promptPreflightEntered.promise

    await runtime.resetSessionContext({ sessionId: session.sessionId, cwd: '/workspace' })
    releasePromptPreflight.resolve()

    await expect(stalePrompt).rejects.toThrow(/superseded/)
    expect(agent.prompts).toEqual([])

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'replacement prompt' })
    expect(agent.prompts).toEqual([
      {
        sessionId: 'specialist-session-2',
        text: expect.stringContaining('replacement prompt')
      }
    ])
  })

  it('allows a forced mcp-* connector Skill when the active specialist grants that connector', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['specialist-connector-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      resolveSpecialistIdentity: async () => ({ append: 'Specialist identity', prefix: '' }),
      resolveSpecialistSkills: async () => ({
        kind: 'specialist' as const,
        skillIds: [],
        frameworkNames: ['mcp-biomart'],
        missingSkillIds: []
      })
    })

    const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-1' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'continue with BioMart',
      forcedSkillIds: ['mcp-biomart']
    })

    expect(agent.prompts).toHaveLength(1)
  })

  it('does not carry source forced Skills into a Claude handoff continuation', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['continuation-source-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      skills: {
        needForceLoad: vi.fn(async () => []),
        namesForIds: vi.fn(async (ids: string[]) => ids)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'switch to a specialist',
      forcedSkillIds: ['customize']
    })

    const continuation = runtime.createClaudeCodeContinuationRequest({
      sessionId: session.sessionId,
      switchReadBack: {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId: session.sessionId,
          specialistId: 'target-specialist',
          targetName: 'Target Specialist'
        }
      }
    })

    expect(continuation).not.toHaveProperty('forcedSkillIds')
  })

  it.each([codexFramework, opencodeFramework])(
    'adds allowed-Skill guidance on every %s turn',
    async (framework) => {
      const process = new FakeAgentProcess()
      const agent = startFakeAgent(process, ['guided-session'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework,
        resolveSpecialistIdentity: async () => ({ append: '', prefix: 'Specialist identity' }),
        resolveSpecialistSkills: specialistSkillResolver
      })

      const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-1' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'work' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue' })
      expect(agent.prompts[0]?.text).toContain('<open_science_specialist_skill_scope>')
      expect(agent.prompts[0]?.text).toContain('Allowed Skill')
      expect(agent.prompts[1]?.text).toContain('<open_science_specialist_skill_scope>')
    }
  )

  it.each([codexFramework, opencodeFramework])(
    'revokes the previous Specialist identity and scope after switching %s to Main without reset',
    async (framework) => {
      const process = new FakeAgentProcess()
      const agent = startFakeAgent(process, ['specialist-to-main-session'], {
        modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
      })
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        spawnAgent: () => asAgentProcess(process),
        framework,
        resolveSpecialistIdentity: async () => ({
          append: '',
          prefix: 'Previous Specialist identity'
        }),
        resolveSpecialistSkills: specialistSkillResolver
      })

      const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-1' })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'specialist task' })
      await expect(runtime.switchSpecialist(session.sessionId, undefined)).resolves.toEqual({
        contextReset: false
      })
      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'main task' })

      expect(agent.prompts[0]?.text).toContain('Previous Specialist identity')
      expect(agent.prompts[1]?.text).toContain('Current agent: Main Agent.')
      expect(agent.prompts[1]?.text).toContain('earlier Specialist identity')
      expect(agent.prompts[1]?.text).not.toContain('Previous Specialist identity')
      expect(agent.prompts[1]?.text).not.toContain('<open_science_specialist_skill_scope>')
    }
  )

  it('projects a switched OpenCode Specialist on an app-owned continuation without a second user event', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['opencode-handoff'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent')
    })
    const events: AcpRuntimeEvent[] = []
    const notebookSpecialists: Array<string | undefined> = []
    const startedTurnTokens: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: opencodeFramework,
      callbacks: {
        onEvent: (event) => events.push(event),
        onPromptStarted: (_sessionId, turnToken) => startedTurnTokens.push(turnToken)
      },
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
        prefix: specialistId === 'new' ? 'New Specialist identity' : 'Old Specialist identity'
      }),
      resolveSpecialistSkills: async (specialistId) => ({
        kind: 'specialist',
        skillIds: [`${specialistId}-skill`],
        frameworkNames: [`${specialistId} Skill`, `${specialistId} Connector`],
        missingSkillIds: []
      })
    })
    const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'old' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'analyse these samples' })

    await runtime.switchSpecialist(session.sessionId, 'new')
    events.length = 0
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'analyse these samples',
      continuation: {
        kind: 'specialist-handoff',
        originatingTurnToken: startedTurnTokens[0],
        targetName: 'New Specialist',
        completion: { kind: 'returned', value: { switched: true, afterAwait: 'complete' } }
      }
    })

    expect(agent.prompts[1]?.text).toContain('New Specialist identity')
    expect(agent.prompts[1]?.text).toContain('new Skill')
    expect(agent.prompts[1]?.text).toContain('new Connector')
    expect(agent.prompts[1]?.text).toContain('Captured outer tool result')
    expect(agent.prompts[1]?.text).toContain('"afterAwait":"complete"')
    expect(events.some((event) => event.kind === 'message' && event.role === 'user')).toBe(false)
    expect(notebookSpecialists.at(-1)).toBe('new')
    expect(startedTurnTokens).toEqual([startedTurnTokens[0], startedTurnTokens[0]])
  })

  it('updates Codex native Skill selection to the switched specialist, including mcp-* connectors', async () => {
    const process = new FakeAgentProcess()
    let receivedPrompt: ContentBlock[] = []
    startFakeAgent(process, ['codex-specialist-session'], {
      modes: createModes(['read-only', 'agent', 'agent-full-access'], 'agent'),
      onPrompt: ({ prompt }) => {
        receivedPrompt = prompt
      }
    })
    const oldConnector = {
      name: 'mcp-old-connector',
      description: 'Old specialist connector.',
      path: '/data/codex/skills/mcp-old-connector/SKILL.md'
    }
    const newConnector = {
      name: 'mcp-new-connector',
      description: 'New specialist connector.',
      path: '/data/codex/skills/mcp-new-connector/SKILL.md'
    }
    const catalog = [oldConnector, newConnector]
    // Model a stale selector result that still contains the old connector. The runtime must offer
    // only the new scope and must reject any result outside that offered catalog.
    const selectSkills = vi.fn(async () => catalog)
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: { CODEX_HOME: '/data/codex' },
        responsesBridgeLease: {
          selectSkills,
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: vi.fn(async () => undefined)
        }
      }),
      skills: {
        needForceLoad: vi.fn(async () => []),
        namesForIds: vi.fn(async (ids: string[]) => ids),
        descriptorsForIds: vi.fn(async () => []),
        catalogForCodexHome: vi.fn(async () => catalog)
      },
      resolveSpecialistIdentity: async () => ({ append: '', prefix: '' }),
      resolveSpecialistSkills: async (specialistId) => ({
        kind: 'specialist' as const,
        skillIds: [],
        frameworkNames: specialistId === 'new' ? ['mcp-new-connector'] : ['mcp-old-connector'],
        missingSkillIds: []
      })
    })

    const session = await runtime.createSession({ cwd: '/workspace', specialistId: 'old' })
    await runtime.switchSpecialist(session.sessionId, 'new')
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'use the new connector' })

    expect(selectSkills).toHaveBeenCalledWith(
      'use the new connector',
      [newConnector],
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(receivedPrompt).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('mcp-new-connector'),
        _meta: {
          'open-science/skill-inputs': [newConnector]
        }
      }
    ])
  })

  it('sends the current whitelist on ACP resume, with empty Specialist distinct from Main', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['unused'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      resolveSpecialistIdentity: async () => ({ append: '', prefix: '' }),
      resolveSpecialistSkills: specialistSkillResolver
    })
    await runtime.resumeSession({ sessionId: 'restored', cwd: '/workspace', specialistId: 'zero' })
    expect(agent.resumedSessions[0]?._meta).toMatchObject({
      claudeCode: { options: { skills: [] } }
    })
  })

  it('omits Claude skills only for unbound Main while a zero-Skill Specialist sends []', async () => {
    const process = new FakeAgentProcess()
    const agent = startFakeAgent(process, ['zero-session', 'main-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      framework: claudeCodeFramework,
      resolveSpecialistIdentity: async () => ({ append: '', prefix: '' }),
      resolveSpecialistSkills: specialistSkillResolver
    })
    await runtime.createSession({ cwd: '/workspace', specialistId: 'zero' })
    await runtime.createSession({ cwd: '/workspace' })
    expect(agent.newSessions[0]?._meta).toMatchObject({ claudeCode: { options: { skills: [] } } })
    expect(agent.newSessions[1]?._meta).not.toMatchObject({
      claudeCode: { options: { skills: expect.anything() } }
    })
  })

  it('keeps Artifact provenance writes while the production Plan service reads managed Versions', async () => {
    const root = await createTemporaryRoot()
    const planPath = join(root, 'plan.json')
    let serializedPlan = ''
    const checksum = (value: string): string => createHash('sha256').update(value).digest('hex')
    const provenance = {
      listRunVersions: async (): Promise<ArtifactVersionFile[]> => [],
      writeAppGeneratedVersion: async (
        input: Parameters<ArtifactProvenanceRepository['writeAppGeneratedVersion']>[0]
      ): Promise<ArtifactVersionFile> => {
        serializedPlan = input.content
        await writeFile(planPath, serializedPlan, 'utf8')
        return {
          id: 'version-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          name: input.filename,
          path: planPath,
          fileUrl: `file://${planPath}`,
          mimeType: input.contentType,
          size: Buffer.byteLength(serializedPlan),
          mtimeMs: 1,
          artifactId: 'artifact-1',
          versionId: 'version-1',
          versionNumber: 1,
          checksum: checksum(serializedPlan),
          createdAt: new Date(0).toISOString()
        }
      }
    }
    const openUnpublishedVersion = vi.fn(async () => {
      const content = Buffer.from(serializedPlan)
      return {
        path: planPath,
        size: content.byteLength,
        readRange: vi.fn(async (offset: number, length: number) =>
          content.subarray(offset, offset + length)
        ),
        verifyUnchanged: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        logicalFile: {
          source: 'artifact' as const,
          id: 'artifact-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          displayName: 'plan.json',
          currentVersionId: 'version-1'
        },
        version: { checksum: checksum(serializedPlan) }
      }
    })
    let context: import('../../shared/session-persistence').SessionRuntimeContext = {
      version: 1,
      revision: 0
    }
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectId: 'project-1',
        mcpEntryPath: '/unused',
        repository: new ArtifactRepository(root),
        runRegistry: new ArtifactRunRegistry(),
        provenance,
        managedFileVersions: { openUnpublishedVersion } as never
      },
      plan: {
        mcpEntryPath: '/unused',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'token' }),
        sessions: {
          readSessionRuntimeContext: async () => context,
          patchSessionRuntimeContext: async ({ patch }) => {
            context = { version: 1, revision: context.revision + 1, ...patch }
            return context
          },
          appendUserMessageToInteraction: async () => {
            throw new Error('not used in this test')
          },
          loadSessionForContinuation: async () => {
            throw new Error('not used in this test')
          },
          containsMessageOnActiveBranch: async () => true
        }
      }
    })
    const reservation = owners.sessionInteractions.reservePrompt({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'interaction-1'
    })
    const execution = owners.sessionInteractions.activatePrompt(reservation)
    const turn = await owners.artifactTurns!.openRootExecution({
      executionId: execution.turnToken,
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Main Agent'
    })

    try {
      await expect(
        owners.planService!.generate({
          projectId: 'project-1',
          sessionId: 'session-1',
          executionId: execution.turnToken,
          interactionId: 'interaction-1',
          content: {
            task_summary: 'Analyze one dataset',
            phases: [
              {
                name: 'Analysis',
                delegations: [
                  {
                    name: 'Primary agent',
                    steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
                  }
                ]
              }
            ],
            desired_outputs: ['Analysis result'],
            feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
          }
        })
      ).resolves.toMatchObject({ projection: { artifactVersionId: 'version-1' } })
      expect(openUnpublishedVersion).toHaveBeenCalledWith(
        { source: 'artifact', projectId: 'project-1', fileId: 'artifact-1' },
        'version-1'
      )
    } finally {
      await owners.artifactTurns!.dispose(turn)
      owners.sessionInteractions.release(execution)
    }
  })
})
