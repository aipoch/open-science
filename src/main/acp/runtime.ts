import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  ContentBlock,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import type {
  AcpCancelPromptRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { getAcpRuntimeEventImage, MAX_ACP_SESSION_IMAGE_BYTES } from '../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  normalizePermissionProfile,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../shared/permission-profiles'
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from '../../shared/settings'
import {
  claudeCodeFramework,
  type AgentFramework,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createLogger, errorLogFields } from '../logger'
import { terminateProcessTree } from '../process-tree'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'
import {
  matchSessionModelOption,
  resolveSessionEffortOption,
  type SessionModelSelection
} from './session-config'
import { describePromptError } from './prompt-error'
import {
  ATTACHMENT_PREVIEW_BYTES,
  MAX_EMBEDDED_TEXT_UPLOAD_BYTES,
  buildOversizedAttachmentNotice,
  imageAttachmentMimeType,
  isTabularAttachment,
  isTextLikeAttachment
} from './attachment-content'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import { AcpPermissionBroker } from './permission-broker'
import { isMcpToolName } from './permission-policy'
import { applyCurrentModeUpdate } from './permission-profile-controller'
import {
  ARTIFACT_MCP_SERVER_NAME,
  createArtifactMcpServerConfig,
  type ArtifactMcpEnvironment,
  type ArtifactRunContext
} from '../artifacts/mcp-server'
import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import {
  NOTEBOOK_MCP_SERVER_NAME,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  createNotebookMcpServerConfig,
  type NotebookMcpEnvironment,
  type NotebookRpcConnection
} from '../notebook/mcp-server'
import { getNotebookDataRoot, getNotebookSessionRoot } from '../notebook/repository'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { withDataRootWrite } from '../storage/migration-state'
import { opencodeStorageDir } from '../agent-framework/opencode'
import type { UploadRepository } from '../uploads/repository'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, ArtifactReference } from '../../shared/artifacts'
import { isMediaOverflowError } from '../../shared/media-overflow'
import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import {
  buildImageContentData,
  canInlineImageInSession,
  consumeInlineImageBudget,
  extractPdfText,
  ImageContentError,
  MAX_SESSION_INLINE_IMAGE_BYTES,
  type InlineImageBudget
} from '../uploads/attachment-media'

type AcpRuntimeCallbacks = {
  onStateChanged?: (state: AcpStateSnapshot) => void
  onEvent?: (event: AcpRuntimeEvent) => void
  onPermissionRequest?: (request: AcpPermissionRequest) => void
}

type AcpRuntimeOptions = {
  appVersion: string
  defaultCwd: string
  callbacks?: AcpRuntimeCallbacks
  spawnAgent?: () => ChildProcessWithoutNullStreams
  // Resolves the active agent backend (framework + spawn inputs) at connect time so a framework or
  // provider switch takes effect on reconnect. Ignored when an explicit spawnAgent is provided (tests
  // inject that directly).
  resolveBackend?: () => Promise<ResolvedAgentBackend> | ResolvedAgentBackend
  artifacts?: AcpRuntimeArtifactOptions
  uploads?: AcpRuntimeUploadOptions
  notebook?: AcpRuntimeNotebookOptions
  skills?: AcpRuntimeSkillsOptions
  // The agent backend to drive. Defaults to Claude Code; selecting another (opencode) swaps only the
  // framework-coupled behavior (spawn, session meta, permission-mode mapping) via AgentFramework.
  framework?: AgentFramework
  // Local http host for the artifact/notebook MCP servers, used for frameworks that reject stdio MCP
  // (opencode). Absent ⇒ those frameworks run without artifact/notebook tooling.
  mcpHttpHost?: AgentMcpHttpHost
  // Bounds the network-bound reconnect+resume so Resume always resolves; the fast attached-session
  // path is never timed. Injectable timer mirrors the approval broker so tests stay deterministic.
  resumeTimeoutMs?: number
  cancelTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  // Per-session cumulative inlined-image budget in base64 bytes. Defaults to MAX_SESSION_INLINE_IMAGE_BYTES;
  // injectable so tests can drive the degrade-to-file path with small fixtures.
  inlineImageBudgetBytes?: number
}

// Turn-scoped skill force-load hooks, wired from the settings service. Optional so tests that construct
// the runtime without them are unaffected; every usage guards on presence.
type AcpRuntimeSkillsOptions = {
  // Returns the subset of forced ids that are currently disabled (i.e. need a respawn to materialize).
  needForceLoad: (ids: string[]) => Promise<string[]>
  // Marks these ids force-loaded for the next spawn's provisioning.
  setTurnForced: (ids: string[]) => void
  // Clears the turn-scoped force-load set so later spawns use the normal enabled set.
  clearTurnForced: () => void
  // Resolves picked ids to display names for the steering nudge.
  namesForIds: (ids: string[]) => Promise<string[]>
}

type AcpRuntimeArtifactOptions = {
  // Config root: where the app-owned claude config dir lives (never relocated).
  configRoot: string
  // Data root: where artifacts/notebooks/runtime live (user-relocatable).
  dataRoot: string
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  repository?: ArtifactRepository
  runRegistry?: ArtifactRunRegistry
}

type AcpRuntimeUploadOptions = {
  repository: UploadRepository
}

type ActiveArtifactRun = {
  runId: string
  artifactSessionId: string
  currentRunFile: string
}

type AcpRuntimeNotebookOptions = {
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection?: () => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
}

type SessionAttachmentResponse = {
  sessionId: string
  modes?: SessionModeState | null
  configOptions?: unknown
  _meta?: unknown
}

type ClientContextSessionAttacher = {
  attachSession: (response: SessionAttachmentResponse) => ActiveSession
}

// Keeps runtime snapshots bounded so long conversations do not grow renderer payloads forever.
const MAX_EVENTS = 500
// Appends artifact tool guidance as system prompt metadata so user prompts stay untouched.
const ARTIFACT_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_artifact_instructions>',
  'When this turn creates or saves local user-facing files such as images, documents, reports, data exports, XML, SVG, HTML, CSV, PDF, or archives, you MUST save them through the MCP tool `write_artifact_file` from the `open-science-artifacts` server.',
  'Do not save generated user-facing files directly into the workspace or current directory unless the user explicitly asks to modify project files.',
  'Pass only the filename, MIME type, and either inline content or a local source path to `write_artifact_file`; the app assigns the project, session, run, and final message location.',
  'After using the tool, mention the generated filename rather than an absolute filesystem path. The app will display the generated file list below your message.',
  'Never write files inside a skill directory — loaded skills are read-only; route any file a skill generates through `write_artifact_file`.',
  '</open_science_artifact_instructions>'
].join('\n')

// Steers the agent away from reading skill definition files, so the permission deny rules that block
// those reads act as a backstop rather than the first line of defense.
const SKILLS_READ_GUARD_SYSTEM_PROMPT_APPEND = [
  '<open_science_skill_privacy_instructions>',
  'Skills are provided for you to load and use through the normal skill mechanism — their definition files are not for inspection.',
  'Do not read, open, cat, print, or otherwise reveal the contents of skill files (`SKILL.md` or any file under the application skills directory). Their contents must never be surfaced into the conversation.',
  'If you need to know what a skill does, rely on its loaded description and the skill system — not on reading its files. Such reads are blocked by policy; do not attempt to work around them.',
  '</open_science_skill_privacy_instructions>'
].join('\n')

// Steers the agent away from reading large attached data files in their entirety, since a single big
// read (esp. under frameworks whose read/bash tools do not hard-cap output) can exceed the provider's
// request-size limit and break the conversation. Framework-neutral: Claude carries it in the system
// prompt preset, opencode as a prompt prefix.
const LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_large_file_instructions>',
  'Large attached data files (CSV, TSV, TXT, JSON, FASTA/FASTQ, VCF, and similar tabular or text data) are provided as a file reference plus a short preview, not as full inline content.',
  'Never read, cat, or print such a file in its entirety — a single large read can exceed the request-size limit and break the conversation.',
  'Inspect structure first (columns, row count, a few sample rows), then read only the specific line ranges, rows, or columns you need.',
  'To analyze, filter, or aggregate over a large file, load it in the notebook (e.g. pandas) and compute there instead of reading its contents into the conversation.',
  '</open_science_large_file_instructions>'
].join('\n')

// Converts unknown thrown values into user-visible error text. Total AND always returns a string: a
// hostile message getter or a throwing String() coercion (e.g. a Proxy-wrapped Error) must not escape,
// and a non-string message (object/bigint/Symbol/undefined) must be coerced — this text flows into the
// state snapshot and event payloads that get structured-cloned to the renderer, where a raw Symbol or
// throwing value would break the broadcast.
const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

// The ACP agent tags a provider-relayed failure with the upstream error type in `data.errorKind`
// (e.g. `request_too_large` for an HTTP 413). Read it so the overflow check can match the slug even
// when the message text comes in a wording the pattern does not cover. Total: any shape but a string
// kind collapses to undefined, and a hostile getter never escapes.
const acpErrorKind = (error: unknown): string | undefined => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind

    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

// Internal wrapper thrown when framework.spawn() fails, carrying the framework the spawn targeted so
// connectFresh can label the failure with the right backend. It never mutates the original throwable
// (which may be a frozen/non-extensible Error, a write-rejecting Proxy, or a non-Error value) and holds
// the original `cause` verbatim so connectFresh can re-throw exactly what was thrown.
class SpawnFailure {
  constructor(
    readonly framework: AgentFramework['id'],
    readonly cause: unknown
  ) {}
}

const log = createLogger('acp')

const REVIEWER_MCP_OPENCODE_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).map((toolName) => `${REVIEWER_MCP_SERVER_NAME}_${toolName}`)
)
const REVIEWER_MCP_PROVIDER_TOOL_NAMES = new Set([
  ...REVIEWER_MCP_OPENCODE_TOOL_NAMES,
  ...Object.values(REVIEWER_MCP_TOOLS).map(
    (toolName) => `mcp__${REVIEWER_MCP_SERVER_NAME}__${toolName}`
  )
])

// Logs an error without ever throwing back into the caller. Used on failure paths where a throwing
// logger (or a hostile payload) must never mask the original error being handled/re-thrown.
const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

const UNRESUMABLE_SESSION_ERROR_KINDS = new Set([
  'session_not_found',
  'conversation_not_found',
  'session_missing',
  'conversation_missing',
  'session_resume_failed',
  'conversation_restore_failed'
])

const isUnresumableSessionErrorKind = (errorKind: unknown): boolean =>
  typeof errorKind === 'string' &&
  UNRESUMABLE_SESSION_ERROR_KINDS.has(
    errorKind
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  )

// Legacy agents may expose only an English diagnostic. Keep this fallback deliberately narrow: a
// false positive silently resets agent-side context, while a false negative leaves the real error
// visible and can be fixed by teaching the backend to emit a machine-readable errorKind.
const describesUnresumableSession = (details: unknown): boolean => {
  if (typeof details !== 'string') return false
  if (
    /\b(?:auth|authentication|authorization|credential|provider|mcp|model|tool|server)\b/i.test(
      details
    )
  )
    return false

  const describesMissingSession =
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+(?:(?:was|is)\s+)?(?:not found|missing|unknown)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+does not exist\b/i.test(details) ||
    /\b(?:no|missing|unknown)\s+(?:saved\s+|previous\s+)?(?:session|conversation)\b/i.test(details)
  const describesFailedResume =
    /\b(?:failed|unable|cannot|can't|could not)\s+to\s+(?:resume|restore|reopen|reattach)\b.{0,80}\b(?:session|conversation)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:failed|was unable)\s+to\s+(?:resume|restore|reopen|reattach)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:could not|cannot|can't)\s+be\s+(?:resumed|restored|reopened|reattached)\b/i.test(
      details
    )

  return describesMissingSession || describesFailedResume
}

// Detects an agent-side resume failure that means the session cannot be reattached, so the thread
// should adopt a fresh agent session instead of dead-ending. A spec-compliant agent returns
// "Resource not found" (-32002) for a session id it no longer holds (e.g. after a provider switch);
// some agents instead return a generic "Internal error" (-32603) after an app restart replaced their
// process. Both mean resume is impossible here. Other failures (invalid params, transport errors)
// still propagate so genuinely fatal problems stay visible.
const isUnresumableSessionError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as {
    code?: number
    message?: string
    data?: { details?: unknown; errorKind?: unknown }
  }
  const message = candidate.message ?? ''

  if (candidate.code === -32002 || /resource not found|session not found/i.test(message))
    return true

  if (candidate.code !== -32603 || !/^internal error\.?$/i.test(message.trim())) return false

  // A structured reason is authoritative and language-independent. Unknown reasons propagate even when
  // their detail happens to look session-related, preventing provider/MCP errors from being swallowed.
  if (candidate.data?.errorKind !== undefined) {
    return isUnresumableSessionErrorKind(candidate.data.errorKind)
  }

  // Detail-free Internal errors keep the existing fallback because some agents discard the cause.
  return (
    candidate.data?.details === undefined || describesUnresumableSession(candidate.data.details)
  )
}

// Owns the agent process, protocol connection, and all active protocol sessions.
class AcpRuntime {
  private status: AcpStateSnapshot['status'] = 'idle'
  private cwd: string
  private error: string | undefined
  private events: AcpRuntimeEvent[] = []
  private eventSequence = 0
  private agentProcess: ChildProcessWithoutNullStreams | undefined
  // Latched by shutdown() on app quit. A connect can be mid-spawn (resolveSpawnConfig is async) when
  // quit fires, so this lets the post-spawn path kill a child that was created after killAgentProcess ran.
  private shuttingDown = false
  // AND-accumulated reaped result of the tree kills performed during the current teardown. Reset to true
  // at the start of shutdownForQuit/shutdownForUpdateGate, then narrowed by each terminateProcessTree so
  // those methods can report whether the agent tree was cleanly reaped (vs a degraded taskkill fallback).
  private lastTreeKillReaped = true
  private connection: ClientConnection | undefined
  private connectInFlight: Promise<AcpStateSnapshot> | undefined
  private connectionGeneration = 0
  private currentSessionId: string | undefined
  private supportsSessionClose = false
  private supportsSessionDelete = false
  private supportsSessionResume = false
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly sessionCwds = new Map<string, string>()
  // Running total of base64 image bytes this session has inlined. The agent replays full history each
  // turn, so this accumulates; once it nears the request ceiling further images degrade to file links
  // (see canInlineImageInSession) so a long conversation can never overflow the request or break
  // compaction with `media_unstrippable`. Cleared on session delete and on disconnect.
  private readonly sessionInlineImageBytes = new Map<string, number>()
  // Per-session names of the MCP servers the agent was actually given (from createMcpServers), so
  // MCP-originated tool calls can be recognized across frameworks (Claude's mcp__<server>__<tool> vs
  // opencode's <server>_<tool>) and never conservatively auto-approved. Derived per session rather
  // than hardcoded so it can't drift from what createMcpServers wires up.
  private readonly sessionMcpServerNames = new Map<string, string[]>()
  // Ephemeral background reviewer sessions (built via buildReviewerSession). They are deliberately kept
  // out of `this.sessions` — not tracked in the snapshot, not user-facing. Their permission requests are
  // handled by a strict allowlist: only the scope-bounded reviewer MCP is approved; every built-in tool is
  // rejected. Each session also gets an empty temporary cwd so ungated read-only tools see no project data.
  private readonly reviewerSessionIds = new Set<string>()
  private readonly reviewerSessionDirectories = new Map<string, string>()
  // A replaced agent's own session id -> the app-facing id it was adopted under (after a provider
  // switch), so agent-origin events/permissions relabel into the conversation the renderer tracks.
  private readonly agentToAppSessionId = new Map<string, string>()
  // Per-session artifact/notebook storage project; keeps run activation and claims in the same subtree.
  private readonly sessionProjectNames = new Map<string, string>()
  // The framework each session last ran under. Deliberately NOT cleared on disconnect so a framework
  // switch (which disconnects) can still tell that an existing session belongs to the other framework
  // and skip a doomed resume. Cleaned per-session on delete.
  private readonly sessionFrameworks = new Map<string, string>()
  // Like sessionFrameworks, retained across disconnects. A provider/profile switch can keep the same
  // framework while moving to a different on-disk session store, where the old id is not resumable.
  private readonly sessionBackendIds = new Map<string, string>()
  private readonly promptInFlightSessionIds = new Set<string>()
  // Monotonic per-turn token and the token of the turn that currently owns each app session id. When an
  // overflow-recovery replay reuses a session id, its start bumps the token; the abandoned turn's finally
  // then sees a newer owner and leaves the replay's shared state (lock, artifact run) untouched.
  private promptTurnSequence = 0
  private readonly currentPromptTurnBySession = new Map<string, number>()
  private readonly permissionProfiles = new Map<string, SessionPermissionProfileState>()
  // A provider change requested while a prompt was running, applied when the session next goes idle.
  private pendingProviderReconnect = false
  private pendingSkillsReload = false
  private expectedProcessExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly permissionBroker: AcpPermissionBroker
  private readonly callbacks: AcpRuntimeCallbacks
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly skillsHooks: AcpRuntimeSkillsOptions | undefined
  // Mutable: refreshed from resolveBackend on each connect so a framework switch applies on reconnect.
  private framework: AgentFramework
  private backendId: string | undefined
  private readonly mcpHttpHost: AgentMcpHttpHost | undefined
  // A Chat Completions provider uses the local Responses bridge. The app-owned notebook MCP has an
  // explicit namespaced bridge mapping; other app MCP tools still require native Responses.
  private nativeMcpEnabled = true
  private bridgeMcpAliasesEnabled = false
  // Model to apply per session via the ACP model configOption (opencode); undefined for env-driven
  // frameworks (Claude). Refreshed from the resolved backend on each connect.
  private pendingSessionModel: string | undefined
  private pendingSessionModelRequired = false
  // Reasoning-effort level to apply per session via the ACP thought_level configOption; undefined
  // means "don't override" (the agent keeps its own default). Refreshed on each connect.
  private pendingSessionEffort: ReasoningEffort | undefined
  // The latest configOptions each session reported — seeded from session/new and refreshed after a
  // model switch (effort rungs are model-dependent, so the original set goes stale). The live effort
  // path resolves against this, never against the possibly-outdated session/new response.
  private readonly latestSessionConfigOptions = new Map<
    string,
    SessionConfigOption[] | null | undefined
  >()
  // One-shot ACP authentication material resolved alongside the spawn config. It is cleared after
  // initialize so the decrypted key is not retained by the runtime longer than necessary.
  private pendingAuthentication: ResolvedAgentBackend['authentication']
  private pendingProviderConfiguration: ResolvedAgentBackend['providerConfiguration']
  // Bounded resume network timeout + injectable timers (defaults to real setTimeout/clearTimeout).
  private readonly resumeTimeoutMs: number
  private readonly cancelTimeoutMs: number
  private readonly inlineImageBudgetBytes: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly notebookOptions: AcpRuntimeNotebookOptions | undefined
  private readonly artifactRepository: ArtifactRepository | undefined
  private readonly artifactRunRegistry: ArtifactRunRegistry | undefined
  private readonly uploadRepository: UploadRepository | undefined
  private readonly artifactSessionIds = new Map<string, string>()
  // app session id -> the notebook routing id registered with the http MCP host, so it can be
  // unregistered on session delete (the artifact routing id is tracked in artifactSessionIds).
  private readonly notebookRoutingIds = new Map<string, string>()
  private artifactSessionSequence = 0
  private artifactRunSequence = 0
  private notebookSessionSequence = 0
  // The in-flight artifact run keyed by app session id, so app-side tools (e.g. molecule preview)
  // attach a generated file to the run of the session that triggered the call. Parallel sessions each
  // keep their own entry — a single global field would let one session's turn capture another's write.
  // An entry is set while that session's prompt is active and cleared in the prompt's finally.
  private readonly activeArtifactRuns = new Map<string, ActiveArtifactRun>()

  // Wires runtime dependencies and forwards permission prompts into the event stream.
  constructor(private readonly options: AcpRuntimeOptions) {
    this.cwd = resolve(options.defaultCwd)
    this.callbacks = options.callbacks ?? {}
    this.spawnAgent = options.spawnAgent
    this.skillsHooks = options.skills
    this.framework = options.framework ?? claudeCodeFramework
    this.mcpHttpHost = options.mcpHttpHost
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000
    this.inlineImageBudgetBytes = options.inlineImageBudgetBytes ?? MAX_SESSION_INLINE_IMAGE_BYTES
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.artifactOptions = options.artifacts
    this.notebookOptions = options.notebook
    this.artifactRepository = options.artifacts
      ? (options.artifacts.repository ?? new ArtifactRepository(options.artifacts.dataRoot))
      : undefined
    this.artifactRunRegistry = options.artifacts
      ? (options.artifacts.runRegistry ?? new ArtifactRunRegistry())
      : undefined
    this.uploadRepository = options.uploads?.repository
    this.permissionBroker = new AcpPermissionBroker((request) => {
      // Relabel to the app-facing id when this session was adopted onto a replaced agent.
      const sessionId = this.agentToAppSessionId.get(request.sessionId) ?? request.sessionId
      const routed = sessionId === request.sessionId ? request : { ...request, sessionId }

      this.pushEvent({
        kind: 'permission',
        level: 'warning',
        sessionId: routed.sessionId,
        toolCallId: routed.toolCallId,
        title: 'Permission requested',
        text: routed.title,
        raw: routed
      })
      this.callbacks.onPermissionRequest?.(routed)
      this.emitState()
    })
  }

  // Returns an immutable renderer-facing view of connection and session state.
  getSnapshot(): AcpStateSnapshot {
    const sessionIds = Array.from(this.sessions.keys())
    const promptInFlightSessionIds = Array.from(this.promptInFlightSessionIds)

    return {
      status: this.status,
      cwd: this.cwd,
      sessionId: this.currentSessionId,
      sessionIds,
      error: this.error,
      events: [...this.events],
      pendingPermissions: this.permissionBroker.getPendingRequests(),
      permissionProfiles: Object.fromEntries(this.permissionProfiles),
      permissionGrants: Object.fromEntries(
        sessionIds.map((sessionId) => [sessionId, this.permissionBroker.listGrants(sessionId)])
      ),
      promptInFlight: promptInFlightSessionIds.length > 0,
      promptInFlightSessionIds
    }
  }

  // Lists sessions with an in-flight prompt, for the pre-migration active-session warning.
  getActivePromptSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.promptInFlightSessionIds, (sessionId) => ({
      projectName: this.resolveSessionProjectName(sessionId),
      sessionId
    }))
  }

  // Run ids of turns currently in flight, from live in-memory state (not the persisted current-run
  // handoff, which survives a crash). The artifact orphan scan uses this to exclude files a running
  // turn is still writing, while a crashed run — absent here — correctly surfaces as orphaned.
  getActiveArtifactRunIds(): string[] {
    return Array.from(this.activeArtifactRuns.values(), (run) => run.runId)
  }

  // Resolves an application profile against per-session ACP capabilities and applies the real Agent
  // mode before any prompt is sent. The selected/effective projection is then shared with the UI and
  // the conservative fallback reviewer.
  private async configurePermissionProfile(
    appSessionId: string,
    session: ActiveSession,
    profile: PermissionProfileId
  ): Promise<void> {
    const application = this.framework.mapPermissionProfile(profile, session.modes)

    if (application.modeId && application.modeId !== session.modes?.currentModeId) {
      if (!this.connection) throw new Error('ACP connection is not available.')

      await this.connection.agent.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: application.modeId
      })
    }

    this.permissionProfiles.set(appSessionId, application.state)
    log.info('permission profile applied', {
      sessionId: appSessionId,
      selectedProfile: profile,
      effectiveMode: application.state.currentModeId,
      autoReviewStrategy: application.state.autoReviewStrategy
    })
  }

  // Applies the active model to a freshly built/resumed session via the ACP model configOption, for
  // frameworks that select the model over the protocol (opencode). No-op for env-driven frameworks
  // (pendingSessionModel undefined). Optional selections keep the agent default when no matching option
  // exists or application fails; required selections fail visibly rather than silently running another
  // model. Returns the agent's post-application configOptions when it reports them — effort levels are
  // model-dependent, so callers resolving further options must use the set from AFTER the model switch.
  private async applySessionModel(
    session: ActiveSession
  ): Promise<SessionConfigOption[] | null | undefined> {
    if (!this.pendingSessionModel || !this.connection) return undefined

    const configOptions = (
      session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } }
    ).newSessionResponse?.configOptions
    const selection = matchSessionModelOption(configOptions, this.pendingSessionModel)

    if (!selection) {
      log.info('no matching session model option', { desiredModel: this.pendingSessionModel })
      if (this.pendingSessionModelRequired) {
        session.dispose()
        throw new Error(
          `The selected model "${this.pendingSessionModel}" is not available for this Codex account.`
        )
      }
      return undefined
    }

    try {
      const response = (await this.connection.agent.request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId: session.sessionId,
          configId: selection.configId,
          value: selection.value
        }
      )) as { configOptions?: SessionConfigOption[] | null }
      log.info('session model applied', { sessionId: session.sessionId, model: selection.value })
      // The model switch rebuilds the agent's options (effort rungs are model-dependent). The
      // caller commits the fresh set to latestSessionConfigOptions once the session is registered,
      // so the map never holds an entry for a session that failed to attach.
      return response?.configOptions ?? configOptions
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('set session model failed', {
        sessionId: session.sessionId,
        error: message
      })
      if (this.pendingSessionModelRequired) {
        session.dispose()
        throw new Error(
          `The selected model "${this.pendingSessionModel}" could not be applied: ${message}`
        )
      }
      return undefined
    }
  }

  // Applies the user's reasoning-effort preference to a freshly built/resumed session via the ACP
  // thought_level configOption. No-op when no explicit level is set (pendingSessionEffort undefined —
  // the agent then keeps its own default) or when the agent advertises no effort option. The desired
  // level is resolved to the closest advertised one, so a level the model lacks still lands on its
  // nearest rung. `configOptions` should be the agent's latest option set (e.g. returned by a model
  // switch just before); falls back to the session's original response. Best-effort: a failure is
  // logged, never fatal to the session.
  private async applySessionEffort(
    session: ActiveSession,
    configOptions?: SessionConfigOption[] | null
  ): Promise<void> {
    if (!this.pendingSessionEffort || !this.connection) return

    const effectiveOptions =
      configOptions ??
      (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
        .newSessionResponse?.configOptions
    const selection = resolveSessionEffortOption(effectiveOptions, this.pendingSessionEffort)

    if (!selection) {
      log.info('no session effort option to apply', { desiredEffort: this.pendingSessionEffort })
      return
    }

    await this.sendSessionEffort(session, selection)
  }

  // Live-applies a reasoning-effort change to every open session — the ACP equivalent of a model
  // switch, no respawn. Returns false when the active framework only carries effort in its baked
  // spawn config (opencode advertises no thought_level option), or when applying to a session
  // genuinely failed — the caller then falls back to the provider-switch reconnect rather than
  // leaving the UI showing a level the agent never received. All sessions are attempted even after
  // a failure, so the set never straddles two levels longer than the reconnect takes. Sessions that
  // simply advertise no effort option are skipped (a reconnect could not give their model one
  // either). On success pendingSessionEffort tracks the new level, so sessions created later in
  // this process inherit it; the persisted setting covers the next respawn.
  async applyReasoningEffortChange(effort: ReasoningEffort): Promise<boolean> {
    if (!this.framework.supportsLiveEffortChange) return false

    this.pendingSessionEffort = effort === DEFAULT_REASONING_EFFORT ? undefined : effort
    if (!this.connection) return true

    let allApplied = true
    let appliedToAny = false

    for (const session of this.sessions.values()) {
      const configOptions =
        this.latestSessionConfigOptions.get(session.sessionId) ??
        (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
          .newSessionResponse?.configOptions
      const selection = resolveSessionEffortOption(configOptions, effort)

      if (!selection) {
        log.info('no session effort option to apply', {
          desiredEffort: effort,
          sessionId: session.sessionId
        })
        continue
      }

      if (!(await this.sendSessionEffort(session, selection))) {
        allApplied = false
      } else {
        appliedToAny = true
      }
    }

    // No open session could take the level over ACP. For Claude there is no other channel — the
    // model simply doesn't support effort, and a respawn can't change that. Codex also bakes the
    // level into its spawn config (model_reasoning_effort), so a reconnect DOES deliver it: report
    // failure rather than leaving the UI showing a level the running session never received.
    if (!appliedToAny && this.sessions.size > 0 && this.framework.id === 'codex') return false

    return allApplied
  }

  // Sends one resolved effort selection to a session. Best-effort: a failure is logged (never
  // thrown) and reported as false, so live callers can escalate while build-time callers stay
  // non-fatal.
  private async sendSessionEffort(
    session: ActiveSession,
    selection: SessionModelSelection
  ): Promise<boolean> {
    try {
      await this.connection?.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: selection.configId,
        value: selection.value
      })
      log.info('session effort applied', { sessionId: session.sessionId, effort: selection.value })
      return true
    } catch (error) {
      log.warn('set session effort failed', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  // Starts a fresh agent process connection and initializes protocol capabilities.
  async connect(request: AcpConnectRequest = {}): Promise<AcpStateSnapshot> {
    if (this.connectInFlight) {
      return this.connectInFlight
    }

    const generation = this.nextConnectionGeneration()
    const connectPromise = this.connectFresh(request, generation)
    this.connectInFlight = connectPromise

    try {
      return await connectPromise
    } finally {
      if (this.connectInFlight === connectPromise) {
        this.connectInFlight = undefined
      }
    }
  }

  private async connectFresh(
    request: AcpConnectRequest = {},
    generation: number
  ): Promise<AcpStateSnapshot> {
    // Resolved up front (not this.cwd, which the pre-connect teardown below may still be mutating) so the
    // failure log always names the target workspace even if we throw before assigning this.cwd.
    const cwd = resolve(request.cwd || this.options.defaultCwd)
    // Captured at function scope so the catch can log the spawned child's pid/killed state on *every*
    // failure path — including "superseded during spawn", where the process is deliberately never
    // assigned to this.agentProcess.
    let agentProcess: ChildProcessWithoutNullStreams | undefined
    // The framework THIS connect spawned under, bound atomically to the spawn (spawnAgentProcess returns
    // it alongside the process, and tags a spawn-throw with it) rather than re-read from the mutable
    // this.framework, which an overlapping reconnect can move before the failure log is written. Seeded
    // with the current value in case we throw before spawning at all (e.g. a pre-spawn teardown failure).
    let spawnedFramework = this.framework.id

    try {
      // Inside the try so a teardown throw or the generation assertion (a supersede race) also produces
      // an enriched failure record instead of propagating silently.
      await this.disconnectCurrent(false)
      this.assertCurrentConnectionGeneration(generation)

      this.cwd = cwd
      this.error = undefined
      this.setStatus('connecting')
      log.info('connecting agent', { cwd: this.cwd, generation })

      const spawned = await this.spawnAgentProcess()
      agentProcess = spawned.process
      spawnedFramework = spawned.framework

      // spawnAgentProcess resolves the provider config asynchronously, so the connection may have been
      // torn down or superseded during the spawn: a quit latched shuttingDown, or any teardown/reconnect
      // bumped the generation past ours (e.g. the pre-update-install gate calls disconnect()). Either way
      // this freshly-spawned child was never assigned, so the teardown that ran saw no process to reap —
      // tree-kill it now and abort, or it would outlive that teardown as an orphan holding file handles.
      // Keying off the generation (not just shuttingDown) lets the NON-LATCHING update gate collect a
      // late spawn without holding a shuttingDown latch it might never release if it is itself abandoned
      // on timeout. Awaited (not a bare kill) so a teardown that awaits this in-flight connect does not
      // resolve before the child's whole tree is reaped on Windows.
      if (this.shuttingDown || generation !== this.connectionGeneration) {
        const result = await terminateProcessTree(agentProcess, undefined, log)
        this.lastTreeKillReaped = this.lastTreeKillReaped && result.reaped
        throw new Error(
          this.shuttingDown
            ? 'ACP runtime is shutting down.'
            : 'ACP connection superseded during spawn.'
        )
      }

      this.agentProcess = agentProcess
      this.attachAgentProcessEvents(this.agentProcess)

      const stream = acp.ndJsonStream(
        Writable.toWeb(this.agentProcess.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>
      )

      this.connection = this.createClientConnection(stream)
      this.connection.closed.then(() => {
        if (
          this.connectionGeneration === generation &&
          (this.status === 'connected' || this.status === 'connecting')
        ) {
          this.handleConnectionClosed()
        }
      })

      // Initialization tells the agent which client-side services this app can handle.
      const initResult = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: 'open-science',
          version: this.options.appVersion
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          },
          session: {
            configOptions: {
              boolean: {}
            }
          },
          plan: {}
        }
      })
      if (this.pendingAuthentication) {
        const authentication = this.pendingAuthentication
        this.pendingAuthentication = undefined
        await this.connection.agent.request(acp.methods.agent.authenticate, authentication)
      }
      if (this.pendingProviderConfiguration) {
        const providerConfiguration = this.pendingProviderConfiguration
        this.pendingProviderConfiguration = undefined
        await this.connection.agent.request(acp.methods.agent.providers.set, providerConfiguration)
      }
      this.supportsSessionClose = Boolean(initResult.agentCapabilities?.sessionCapabilities?.close)
      this.supportsSessionDelete = Boolean(
        initResult.agentCapabilities?.sessionCapabilities?.delete
      )
      this.supportsSessionResume = Boolean(
        initResult.agentCapabilities?.sessionCapabilities?.resume
      )
      this.assertCurrentConnectionGeneration(generation)

      log.info('agent initialized', {
        protocolVersion: initResult.protocolVersion,
        supportsSessionClose: this.supportsSessionClose,
        supportsSessionDelete: this.supportsSessionDelete,
        supportsSessionResume: this.supportsSessionResume
      })

      this.pushEvent({
        kind: 'system',
        level: 'info',
        title: 'Agent initialized',
        text: `ACP protocol ${initResult.protocolVersion}`
      })
      this.setStatus('connected')
    } catch (thrown) {
      // A spawn failure arrives wrapped so it can name the framework it targeted without mutating the
      // original throwable; unwrap to the real cause (logged and re-thrown) and prefer its framework
      // (the process never returned to update spawnedFramework). `instanceof` is guarded because a
      // hostile thrown value's getPrototypeOf trap could otherwise throw here. Every other failure is
      // its own cause.
      let spawnFailure: SpawnFailure | undefined
      try {
        if (thrown instanceof SpawnFailure) spawnFailure = thrown
      } catch {
        spawnFailure = undefined
      }
      const cause = spawnFailure ? spawnFailure.cause : thrown

      // The entire failure-handling body is best-effort: logging, notification sinks (pushEvent/
      // emitState), and cleanup are each isolated so that whatever throws — a hostile error value, a
      // renderer broadcast, or a teardown hook — the original `cause` is still re-thrown below and never
      // replaced by a handling-time error.
      try {
        // Shared process context so both the abandoned and the failed paths name the child — including
        // the superseded-during-spawn case, where the local `agentProcess` holds the child
        // this.agentProcess never received.
        const processFields = {
          cwd,
          generation,
          currentGeneration: this.connectionGeneration,
          framework: spawnFailure ? spawnFailure.framework : spawnedFramework,
          shuttingDown: this.shuttingDown,
          agentProcessPid: agentProcess?.pid,
          agentProcessKilled: agentProcess?.killed
        }

        if (generation !== this.connectionGeneration) {
          // Superseded (a newer reconnect bumped the generation) or shutting down: the fast-path re-throw
          // skips the error handling below, so log here too — these late-spawn/teardown races are exactly
          // the failures that are otherwise invisible.
          try {
            log.warn('agent connection abandoned (superseded or shutting down)', {
              ...errorLogFields(cause),
              ...processFields
            })
          } catch {
            /* a throwing logger must not mask the cause */
          }
        } else {
          this.error = errorMessage(cause)
          safeLogError('agent connection failed', { ...errorLogFields(cause), ...processFields })
          // A notification sink that throws synchronously must not skip cleanup or the re-throw.
          try {
            this.pushEvent({
              kind: 'error',
              level: 'error',
              title: 'Connection failed',
              text: this.error
            })
          } catch (notifyError) {
            safeLogError(
              'agent connection failure notification failed',
              errorLogFields(notifyError)
            )
          }
          // Cleanup must not mask the original failure: a throw from session.dispose(),
          // connection.close(), or a teardown hook is logged with context but never replaces `cause`.
          try {
            await this.disconnectCurrent(false)
          } catch (cleanupError) {
            safeLogError('agent connection cleanup failed', {
              ...errorLogFields(cleanupError),
              ...processFields
            })
          }
          this.status = 'error'
          try {
            this.emitState()
          } catch (notifyError) {
            safeLogError('agent connection emitState failed', errorLogFields(notifyError))
          }
        }
      } catch (handlingError) {
        // Last-resort guard: even the logger threw. Swallow it (best-effort re-log) so the original
        // cause below is what propagates.
        try {
          log.error('error while handling agent connection failure', errorLogFields(handlingError))
        } catch {
          /* nothing more we can safely do */
        }
      }

      throw cause
    }

    return this.getSnapshot()
  }

  // Creates a protocol session, injects artifact tooling, and uses the returned id as the app session id.
  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    try {
      log.info('createSession: starting', { request })
      const sessionCwd = resolve(request.cwd || this.cwd || this.options.defaultCwd)
      const projectName = this.normalizeProjectName(request.projectName)
      log.info('createSession: ensureConnected', { sessionCwd, projectName })
      const connection = await this.ensureConnected(sessionCwd)
      const artifactSessionId = this.createArtifactSessionId()
      const notebookSessionId = this.createNotebookSessionId()

      log.info('createSession: createMcpServers', { artifactSessionId, notebookSessionId })
      const mcpServers = await this.createMcpServers({
        artifactSessionId,
        notebookSessionId,
        sessionCwd,
        projectName
      })
      log.info('createSession: buildSession', { mcpServersCount: mcpServers.length })
      const session = await connection.agent
        .buildSession({
          cwd: sessionCwd,
          mcpServers,
          ...this.buildSessionMetaArg()
        })
        .start()

      log.info('createSession: configurePermissionProfile', { sessionId: session.sessionId })
      try {
        await this.configurePermissionProfile(
          session.sessionId,
          session,
          normalizePermissionProfile(request.permissionProfile)
        )
      } catch (error) {
        safeLogError('createSession: configurePermissionProfile failed', errorLogFields(error))
        session.dispose()
        throw error
      }

      log.info('createSession: applySessionModel', { sessionId: session.sessionId })
      const updatedConfigOptions = await this.applySessionModel(session)
      await this.applySessionEffort(session, updatedConfigOptions)

      this.sessions.set(session.sessionId, session)
      // Committed only now: the options map must never hold an entry for a session that failed to
      // attach (a throw between apply and registration would orphan it).
      if (updatedConfigOptions) {
        this.latestSessionConfigOptions.set(session.sessionId, updatedConfigOptions)
      }
      this.sessionCwds.set(session.sessionId, sessionCwd)
      this.sessionMcpServerNames.set(session.sessionId, this.mcpServerNamesOf(mcpServers))
      this.sessionProjectNames.set(session.sessionId, projectName)
      this.sessionFrameworks.set(session.sessionId, this.framework.id)
      if (this.backendId) this.sessionBackendIds.set(session.sessionId, this.backendId)
      this.rememberArtifactSession(session.sessionId, artifactSessionId)
      this.rememberNotebookSession(session.sessionId, notebookSessionId)
      this.currentSessionId = session.sessionId
      this.cwd = sessionCwd
      this.pushEvent({
        kind: 'system',
        level: 'info',
        sessionId: session.sessionId,
        title: 'Session created',
        text: sessionCwd
      })
      this.emitState()

      log.info('createSession: completed successfully', { sessionId: session.sessionId })
      return {
        sessionId: session.sessionId,
        cwd: sessionCwd,
        frameworkId: this.framework.id,
        ...(this.backendId ? { backendId: this.backendId } : {})
      }
    } catch (error) {
      safeLogError('createSession: failed', errorLogFields(error))
      throw error
    }
  }

  // Registers a freshly-built agent session under an app-facing id (used when adopting a conversation
  // onto a replaced agent after a provider switch). Remaps the agent's own id so later updates and
  // permission requests relabel into the same conversation.
  private adoptSession(
    appSessionId: string,
    session: ActiveSession,
    cwd: string,
    projectName: string,
    mcpServerNames: string[]
  ): void {
    this.sessions.set(appSessionId, session)

    if (session.sessionId !== appSessionId) {
      this.agentToAppSessionId.set(session.sessionId, appSessionId)
    }

    this.sessionCwds.set(appSessionId, cwd)
    this.sessionMcpServerNames.set(appSessionId, mcpServerNames)
    this.sessionProjectNames.set(appSessionId, projectName)
    this.sessionFrameworks.set(appSessionId, this.framework.id)
    if (this.backendId) this.sessionBackendIds.set(appSessionId, this.backendId)
    this.rememberArtifactSession(appSessionId, appSessionId)
    this.rememberNotebookSession(appSessionId, appSessionId)
    this.currentSessionId = appSessionId
    this.cwd = cwd
  }

  // Reattaches a persisted protocol session after an app restart so later prompts can stream.
  async resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const sessionCwd = resolve(request.cwd || this.cwd || this.options.defaultCwd)
    const projectName = this.normalizeProjectName(request.projectName)

    // If the runtime already attached this session, only refresh routing metadata.
    const attachedSession = this.sessions.get(request.sessionId)

    if (attachedSession) {
      await this.configurePermissionProfile(
        request.sessionId,
        attachedSession,
        normalizePermissionProfile(
          request.permissionProfile ??
            this.permissionProfiles.get(request.sessionId)?.selectedProfile ??
            DEFAULT_PERMISSION_PROFILE
        )
      )
      this.currentSessionId = request.sessionId
      this.cwd = sessionCwd
      this.sessionCwds.set(request.sessionId, sessionCwd)
      this.sessionProjectNames.set(request.sessionId, projectName)
      this.emitState()

      return {
        sessionId: request.sessionId,
        cwd: sessionCwd,
        frameworkId: this.framework.id,
        ...(this.backendId ? { backendId: this.backendId } : {})
      }
    }

    // The reconnect + session/resume handshake spawns a fresh agent and is network-bound, so it is
    // wrapped in a bounded timeout that tears down the half-open connection if the agent stalls.
    return this.resumeSessionWithTimeout(request, sessionCwd, projectName)
  }

  // Forcibly drops the agent-side context for a session whose accumulated history can no longer be sent
  // — chiefly when inlined media pushed the request past the provider's size limit and the backend's own
  // compaction fails with `media_unstrippable`. Disposes the current agent session and adopts a brand-new
  // one under the SAME app id, resetting the per-session inline-image budget so a replayed text-only
  // transcript starts clean. Returns contextReset so the caller replays a bounded transcript into the
  // next prompt (the app-level equivalent of compaction, which — unlike the backend's — drops all media).
  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const sessionCwd = resolve(request.cwd || this.cwd || this.options.defaultCwd)
    const projectName = this.normalizeProjectName(request.projectName)
    const connection = await this.ensureConnected(sessionCwd)

    // Tear down the currently attached agent session (if any) before adopting a replacement, dropping
    // its reverse routing so late events from the old agent session can no longer target this app id.
    const attached = this.sessions.get(request.sessionId)

    if (attached) {
      attached.dispose()
      this.agentToAppSessionId.delete(attached.sessionId)
      this.sessions.delete(request.sessionId)
      this.latestSessionConfigOptions.delete(attached.sessionId)
      this.latestSessionConfigOptions.delete(request.sessionId)
    }

    // The fresh agent session holds no history, so the accumulated media is gone; start its budget clean.
    this.sessionInlineImageBytes.delete(request.sessionId)

    // Release the failed turn's in-flight lock now. Its own `finally` clears it too, but that runs only
    // after async artifact cleanup, so the recovery resend that follows this reset would otherwise race
    // it and be rejected with "An ACP prompt is already running for this session".
    this.promptInFlightSessionIds.delete(request.sessionId)

    return this.adoptFreshSession(connection, request, sessionCwd, projectName)
  }

  // Races the network-bound resume against a timeout so a stalled agent handshake cannot hang Resume
  // forever. On timeout the half-open connection is torn down so the next Resume reconnects cleanly.
  private async resumeSessionWithTimeout(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string
  ): Promise<AcpCreateSessionResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimer(() => {
        timedOut = true
        reject(new Error('ACP session resume timed out.'))
      }, this.resumeTimeoutMs)
    })

    try {
      return await Promise.race([
        this.resumeSessionNetwork(request, sessionCwd, projectName),
        timeout
      ])
    } catch (error) {
      if (timedOut) {
        await this.disconnect(false)
      }

      throw error
    } finally {
      if (timer !== undefined) {
        this.clearTimer(timer)
      }
    }
  }

  // Performs the connect + session/resume handshake for a session the runtime does not yet hold.
  private async resumeSessionNetwork(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string
  ): Promise<AcpCreateSessionResponse> {
    const connection = await this.ensureConnected(sessionCwd)
    // A session created under a different framework can never be resumed by the current agent — each
    // framework keeps its own session store, so the request is guaranteed to fail and only makes the
    // agent log a scary internal error. Skip straight to adopting a fresh session (context still
    // resets, so the caller replays the transcript) when we know it last ran under another framework.
    const priorFramework =
      this.sessionFrameworks.get(request.sessionId) ?? request.previousFrameworkId
    const priorBackend = this.sessionBackendIds.get(request.sessionId) ?? request.previousBackendId

    if (
      (priorFramework && priorFramework !== this.framework.id) ||
      (priorBackend && this.backendId && priorBackend !== this.backendId)
    ) {
      log.info('skipping incompatible backend resume; adopting a fresh session', {
        sessionId: request.sessionId,
        fromFramework: priorFramework,
        toFramework: this.framework.id,
        fromBackend: priorBackend,
        toBackend: this.backendId
      })

      return this.adoptFreshSession(connection, request, sessionCwd, projectName)
    }

    // Resume is optional in ACP. A cross-framework session was handled above and can always be
    // adopted fresh; same-framework sessions require the advertised resume capability.
    if (!this.supportsSessionResume) {
      throw new Error('ACP agent does not support session resume.')
    }

    // Resumed sessions already have stable ids, so the artifact session mirrors the runtime session id.
    const mcpServers = await this.createMcpServers({
      artifactSessionId: request.sessionId,
      notebookSessionId: request.sessionId,
      sessionCwd,
      projectName
    })
    let resumeResponse
    try {
      resumeResponse = await connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: request.sessionId,
        cwd: sessionCwd,
        mcpServers,
        ...this.buildSessionMetaArg()
      })
    } catch (error) {
      if (!isUnresumableSessionError(error)) throw error

      // The agent could not resume this session (an app restart spawned a fresh agent process that no
      // longer holds it — surfacing as -32002 not-found or a generic -32603 Internal error). Rather
      // than dead-end the thread, adopt a brand-new agent session under the SAME app id.
      log.info('resumed session adopted after unrecoverable resume error', {
        sessionId: request.sessionId,
        ...errorLogFields(error)
      })

      return this.adoptFreshSession(connection, request, sessionCwd, projectName)
    }
    // The SDK exposes public helpers for new sessions only. The runtime keeps this adapter
    // narrow so resume can reuse the same update routing surface as newly-created sessions.
    const session = (connection.agent as unknown as ClientContextSessionAttacher).attachSession({
      sessionId: request.sessionId,
      ...resumeResponse
    })

    try {
      await this.configurePermissionProfile(
        request.sessionId,
        session,
        normalizePermissionProfile(request.permissionProfile)
      )
    } catch (error) {
      session.dispose()
      throw error
    }

    const updatedConfigOptions = await this.applySessionModel(session)
    await this.applySessionEffort(session, updatedConfigOptions)

    this.sessions.set(request.sessionId, session)
    if (updatedConfigOptions) {
      this.latestSessionConfigOptions.set(request.sessionId, updatedConfigOptions)
    }
    this.sessionCwds.set(request.sessionId, sessionCwd)
    this.sessionMcpServerNames.set(request.sessionId, this.mcpServerNamesOf(mcpServers))
    this.sessionProjectNames.set(request.sessionId, projectName)
    this.sessionFrameworks.set(request.sessionId, this.framework.id)
    if (this.backendId) this.sessionBackendIds.set(request.sessionId, this.backendId)
    this.rememberArtifactSession(request.sessionId, request.sessionId)
    this.currentSessionId = request.sessionId
    this.cwd = sessionCwd
    this.pushEvent({
      kind: 'system',
      level: 'info',
      sessionId: request.sessionId,
      title: 'Session resumed',
      text: sessionCwd
    })
    this.emitState()

    return {
      sessionId: request.sessionId,
      cwd: sessionCwd,
      frameworkId: this.framework.id,
      ...(this.backendId ? { backendId: this.backendId } : {})
    }
  }

  // Builds a brand-new agent session under the SAME app id when a resume cannot reattach the original
  // (a cross-framework switch, or an unresumable restart). Earlier turns stay visible; only agent-side
  // context is gone, so contextReset is returned to let the caller replay a transcript into the next
  // prompt. Shared by the cross-framework skip and the unrecoverable-error fallback.
  private async adoptFreshSession(
    connection: ClientConnection,
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string
  ): Promise<AcpCreateSessionResponse> {
    const mcpServers = await this.createMcpServers({
      artifactSessionId: request.sessionId,
      notebookSessionId: request.sessionId,
      sessionCwd,
      projectName
    })
    const adopted = await connection.agent
      .buildSession({
        cwd: sessionCwd,
        mcpServers,
        ...this.buildSessionMetaArg()
      })
      .start()

    try {
      await this.configurePermissionProfile(
        request.sessionId,
        adopted,
        normalizePermissionProfile(request.permissionProfile)
      )
    } catch (error) {
      adopted.dispose()
      throw error
    }

    const updatedConfigOptions = await this.applySessionModel(adopted)
    await this.applySessionEffort(adopted, updatedConfigOptions)
    this.adoptSession(
      request.sessionId,
      adopted,
      sessionCwd,
      projectName,
      this.mcpServerNamesOf(mcpServers)
    )
    // Keyed by the agent session id, matching the live-effort lookup over this.sessions values:
    // an adopted session's agent id differs from the app id it is registered under.
    if (updatedConfigOptions) {
      this.latestSessionConfigOptions.set(adopted.sessionId, updatedConfigOptions)
    }
    this.emitState()

    return {
      sessionId: request.sessionId,
      cwd: sessionCwd,
      frameworkId: this.framework.id,
      ...(this.backendId ? { backendId: this.backendId } : {}),
      contextReset: true
    }
  }

  // Changes approval behavior only while the conversation is idle. Applying the ACP mode before the
  // next prompt guarantees Full access cannot show a first-tool permission race.
  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    const session = this.sessions.get(request.sessionId)

    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    if (this.promptInFlightSessionIds.has(request.sessionId)) {
      throw new Error('Permission profile cannot be changed while the Agent is running.')
    }
    if (this.permissionBroker.hasPendingForSession(request.sessionId)) {
      throw new Error('Resolve the pending permission request before changing profiles.')
    }

    await this.configurePermissionProfile(request.sessionId, session, request.profile)
    this.emitState()

    return this.getSnapshot()
  }

  // Revokes a remembered "Always" grant for a session so the next matching tool call prompts again.
  revokePermissionGrant(request: AcpRevokePermissionGrantRequest): AcpStateSnapshot {
    this.permissionBroker.revokeGrant(request.sessionId, request.categoryKey)
    this.emitState()

    return this.getSnapshot()
  }

  // Tears down every local session route and closes the underlying agent process.
  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    this.nextConnectionGeneration()
    this.connectInFlight = undefined

    return this.disconnectCurrent(emitClosedStatus)
  }

  // Synchronously terminates the agent child for app shutdown. Electron's `will-quit` cannot await, so
  // this does only the synchronous work of signalling the child to exit — an agent left running after
  // the app is gone would be an orphaned process still holding its network connection open. The OS
  // reclaims the remaining connection/session state as the process exits.
  shutdown(): void {
    this.shuttingDown = true
    this.nextConnectionGeneration()
    this.connectInFlight = undefined
    this.connection?.close()
    this.connection = undefined
    this.killAgentProcess()
  }

  // Awaitable quit/relaunch teardown. Latches shuttingDown FIRST so a connect that is mid-spawn when
  // quit lands self-aborts and kills its freshly-spawned child (see connectFresh). Unlike shutdown(),
  // this can be awaited, so a caller that follows it with app.exit(0) is guaranteed no orphaned agent
  // remains — assigned, connecting, or mid-spawn. Returns { reaped } so the caller can tell a clean
  // teardown from a degraded one (taskkill fallback left grandchildren) before committing to app.exit.
  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.lastTreeKillReaped = true
    this.shuttingDown = true
    // Capture the in-flight connect before disconnect() clears it.
    const inFlight = this.connectInFlight
    // Kill the currently-assigned agent tree right away. Do NOT wait on the in-flight connect first: it
    // may be stalled on ACP initialize with the child already assigned, and waiting would let
    // shutdownBackends time out and app.exit orphan it. disconnect() reaps that child's tree and closes
    // the connection, which also unblocks (rejects) the stalled connect.
    await this.disconnect(false)
    // Cover the child that had not been assigned yet when disconnect ran: a connect still mid-spawn hits
    // the shutting-down check and tree-kills its freshly-spawned child. Await it (swallowing its
    // rejection, bounded by shutdownBackends' timeout) so that kill completes before we resolve.
    if (inFlight) await inFlight.catch(() => undefined)
    return { reaped: this.lastTreeKillReaped }
  }

  // Teardown for the pre-update-install gate. Reaps the current agent tree (so the NSIS installer can
  // delete files the agent held) but, unlike shutdownForQuit, does NOT latch shuttingDown: a refused
  // install (degraded or timed-out teardown) must leave the runtime able to lazily reconnect. Crucially
  // it does not rely on a latch to catch a connect racing inside spawnAgentProcess either — this teardown
  // can itself be abandoned by its caller (runBounded) once the budget elapses, and a latch set here
  // would then never clear, wedging every future connect. Instead disconnect() bumps the connection
  // generation, and connectFresh reaps any freshly-spawned child whose generation is now stale,
  // independent of shuttingDown. Awaiting the in-flight connect here only sharpens the returned reaped
  // signal (so a degraded reap makes the caller refuse the install); if that await is abandoned on
  // timeout the caller refuses on !completed and the stale-generation self-reap still collects the child.
  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.lastTreeKillReaped = true
    // Capture the in-flight connect before disconnect() clears it. disconnect() bumps the generation, so
    // a connect still mid-spawn will self-reap on the stale-generation check regardless of this await.
    const inFlight = this.connectInFlight
    await this.disconnect(false)
    // Await so the mid-spawn child's kill settles before we report the reaped signal.
    if (inFlight) await inFlight.catch(() => undefined)
    return { reaped: this.lastTreeKillReaped }
  }

  // Applies an active-provider change without interrupting the user. The agent bakes its provider env in
  // at spawn, so a new provider needs a reconnect — but if a prompt is running we defer the reconnect
  // until the session goes idle. Because every provider shares one config dir, the reconnect resumes the
  // conversation on the new provider with full context. Called when the active provider changes.
  async requestProviderReconnect(): Promise<void> {
    if (this.promptInFlightSessionIds.size > 0) {
      this.pendingProviderReconnect = true
      return
    }

    this.pendingProviderReconnect = false
    await this.disconnect()
  }

  // If a provider reconnect was deferred while a prompt ran, apply it once nothing is in flight.
  private maybeApplyPendingProviderReconnect(): void {
    if (this.promptInFlightSessionIds.size > 0) return

    if (this.pendingProviderReconnect) {
      this.pendingProviderReconnect = false
      void this.disconnect()
      return
    }

    if (this.pendingSkillsReload) {
      this.pendingSkillsReload = false
      void this.disconnect()
    }
  }

  // Re-materializes the agent's skills on the next reconnect: a disconnect makes the next prompt spawn a
  // fresh agent, whose provisioning copies the current enabled set into the config dir before the session
  // resumes with full context. Defers past an in-flight prompt exactly like a provider switch. Called
  // when a skill is toggled in settings.
  async requestSkillsReload(): Promise<void> {
    if (this.promptInFlightSessionIds.size > 0) {
      this.pendingSkillsReload = true
      return
    }

    this.pendingSkillsReload = false
    await this.disconnect()
  }

  private async disconnectCurrent(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    for (const timer of this.cancelTimers.values()) this.clearTimer(timer)
    this.cancelTimers.clear()
    this.permissionBroker.cancelAll()
    this.clearReviewerSessionState()
    this.promptInFlightSessionIds.clear()

    for (const session of this.sessions.values()) {
      session.dispose()
    }

    this.sessions.clear()
    this.sessionCwds.clear()
    this.sessionInlineImageBytes.clear()
    this.currentPromptTurnBySession.clear()
    this.latestSessionConfigOptions.clear()
    this.sessionMcpServerNames.clear()
    this.sessionProjectNames.clear()
    this.permissionProfiles.clear()
    this.artifactSessionIds.clear()
    this.notebookRoutingIds.clear()
    this.mcpHttpHost?.clear()
    this.agentToAppSessionId.clear()
    this.currentSessionId = undefined
    this.supportsSessionClose = false
    this.supportsSessionDelete = false
    this.supportsSessionResume = false
    this.connection?.close()
    this.connection = undefined

    await this.killAgentProcessTree()

    if (emitClosedStatus) {
      this.setStatus('closed')
    }

    return this.getSnapshot()
  }

  // Signals the current agent child to exit and marks the exit expected so the stderr/error/exit
  // handlers stay quiet. Synchronous: used by the will-quit backstop (shutdown()), which Electron
  // cannot await. It only signals the immediate child — the awaited disconnect path below reaps the
  // whole tree.
  private killAgentProcess(): void {
    if (this.agentProcess) {
      this.expectedProcessExits.add(this.agentProcess)

      if (!this.agentProcess.killed) {
        this.agentProcess.kill()
      }
    }

    this.agentProcess = undefined
  }

  // Awaitable tree teardown for the async disconnect path: marks the exit expected, then hands the
  // whole process tree to terminateProcessTree so a Windows grandchild (taskkill /T) is reaped before
  // the caller (before-quit shutdownBackends) proceeds to app.exit.
  private async killAgentProcessTree(): Promise<void> {
    const child = this.agentProcess
    this.agentProcess = undefined
    if (!child) return
    this.expectedProcessExits.add(child)
    const result = await terminateProcessTree(child, undefined, log)
    // Narrow the current teardown's reaped accumulator (reset by shutdownForQuit/shutdownForUpdateGate).
    this.lastTreeKillReaped = this.lastTreeKillReaped && result.reaped
  }

  private nextConnectionGeneration(): number {
    this.connectionGeneration += 1
    return this.connectionGeneration
  }

  private assertCurrentConnectionGeneration(generation: number): void {
    if (generation !== this.connectionGeneration) {
      throw new Error('ACP connection was superseded.')
    }
  }

  // Creates the agent process, preferring an injected spawner (tests) and otherwise resolving the
  // active agent backend so each reconnect uses the current framework + up-to-date credentials. Returns
  // the child paired with the framework it was spawned under so the caller labels lifecycle/failure logs
  // atomically — never by re-reading the mutable this.framework, which an overlapping reconnect can move.
  private async spawnAgentProcess(): Promise<{
    process: ChildProcessWithoutNullStreams
    framework: AgentFramework['id']
  }> {
    if (this.spawnAgent) {
      return { process: this.spawnAgent(), framework: this.framework.id }
    }

    const backend = this.options.resolveBackend ? await this.options.resolveBackend() : undefined

    if (!backend) {
      throw new Error('ACP agent spawn configuration is not available.')
    }

    // Adopt the framework this reconnect resolved so session meta, permission mapping, and the spawn
    // itself all agree with the current selection.
    this.framework = backend.framework
    this.backendId = backend.backendId
    this.nativeMcpEnabled =
      backend.framework.id !== 'codex' || backend.providerConfiguration === undefined
    this.bridgeMcpAliasesEnabled =
      backend.framework.id === 'codex' && backend.providerConfiguration !== undefined
    this.pendingSessionModel = backend.sessionModel
    this.pendingSessionModelRequired = backend.sessionModelRequired ?? false
    this.pendingSessionEffort = backend.sessionEffort
    this.pendingAuthentication = backend.authentication
    this.pendingProviderConfiguration = backend.providerConfiguration

    // Surfaces which backend + model this connect uses, so a fallback to the framework's own default
    // model (e.g. opencode with no app model to inject) is diagnosable in the log rather than silent.
    log.info('agent backend resolved', {
      framework: backend.framework.id,
      backendId: backend.backendId ?? '(unspecified)',
      sessionModel: backend.sessionModel ?? '(framework default)',
      sessionEffort: backend.sessionEffort ?? '(agent default)',
      args: backend.args ?? [],
      executablePath: backend.executablePath,
      // Log env keys but not values (may contain credentials)
      envKeys: Object.keys(backend.env ?? {})
    })

    let process: ChildProcessWithoutNullStreams
    try {
      process = this.framework.spawn({
        executablePath: backend.executablePath,
        env: backend.env,
        args: backend.args ?? []
      })
    } catch (error) {
      // Wrap (never mutate) the failure with the framework this spawn targeted: the connect-level catch
      // would otherwise fall back to this.framework.id, which an overlapping reconnect could move before
      // the log is written. connectFresh unwraps this and re-throws the original `error` value.
      throw new SpawnFailure(backend.framework.id, error)
    }

    log.info('agent process spawned', {
      framework: backend.framework.id,
      pid: process.pid
    })

    return { process, framework: backend.framework.id }
  }

  // Sends one prompt turn to the targeted session and streams updates until stop.
  async sendPrompt(request: AcpPromptRequest): Promise<PromptResponse> {
    return withDataRootWrite(() => this.sendPromptTurn(request))
  }

  private async sendPromptTurn(request: AcpPromptRequest): Promise<PromptResponse> {
    let activeSession = this.sessions.get(request.sessionId)

    if (!activeSession) {
      throw new Error(`ACP session not found: ${request.sessionId}`)
    }

    if (this.promptInFlightSessionIds.has(request.sessionId)) {
      throw new Error('An ACP prompt is already running for this session')
    }

    // Turn-scoped skill force-load: a skill the user picked but has toggled off must run this turn only.
    // If any pick is currently disabled, mark the picks forced and respawn the agent (drop the connection,
    // then resume the same session) so the fresh spawn's provisioning materializes them with full context
    // restored. Picks that are already enabled need no respawn. Restored to the normal set after the turn.
    const forced = request.forcedSkillIds ?? []
    let didForceReload = false

    if (this.skillsHooks && forced.length > 0) {
      const toForce = await this.skillsHooks.needForceLoad(forced)

      if (toForce.length > 0) {
        // Capture routing before the disconnect clears it, so the resume lands on the same conversation.
        const sessionCwd = this.sessionCwds.get(request.sessionId) ?? this.cwd
        const projectName = this.resolveSessionProjectName(request.sessionId)
        const permissionProfile =
          this.permissionProfiles.get(request.sessionId)?.selectedProfile ??
          DEFAULT_PERMISSION_PROFILE
        this.skillsHooks.setTurnForced(forced)
        didForceReload = true
        await this.disconnect(false)
        const reloadResume = await this.resumeSession({
          sessionId: request.sessionId,
          cwd: sessionCwd,
          projectName,
          permissionProfile
        })
        if (reloadResume.contextReset) {
          request.historyPreamble = request.resumeFallback?.historyPreamble
          request.historyAttachments = request.resumeFallback?.historyAttachments
          request.historyImages = request.resumeFallback?.historyImages
        }

        const reloaded = this.sessions.get(request.sessionId)
        if (!reloaded) {
          throw new Error(`ACP session not found after force-load: ${request.sessionId}`)
        }
        activeSession = reloaded
      }
    }

    this.currentSessionId = request.sessionId
    // Claim ownership of this session's shared turn state so a superseded turn's later finally can tell it
    // no longer owns the lock/artifact run (see the guarded cleanup in this turn's finally).
    const promptTurn = ++this.promptTurnSequence
    this.promptInFlightSessionIds.add(request.sessionId)
    this.currentPromptTurnBySession.set(request.sessionId, promptTurn)
    this.emitState()
    log.info('prompt start', {
      sessionId: request.sessionId,
      textLength: request.text?.length ?? 0
    })
    let artifactRun: ActiveArtifactRun | undefined
    let artifactEmitted = false

    try {
      // Create a fresh run context before prompting so MCP writes can be attributed to this turn.
      artifactRun = await this.activateArtifactRun(request.sessionId)
      if (artifactRun) {
        this.activeArtifactRuns.set(request.sessionId, artifactRun)
      } else {
        this.activeArtifactRuns.delete(request.sessionId)
      }
      // Prepend a short steering nudge naming the picked skills. It goes only into the content sent to
      // the agent; the user-facing message event keeps the original text (which already shows /Name).
      // Framework-neutral delivery of the system-prompt guidance: Claude carries it in session _meta so
      // the prefix is empty and the prompt is unchanged; opencode has no preset, so its guidance rides as
      // a prompt prefix here, ahead of the skill nudge and the user's text.
      const { promptPrefix } = this.framework.buildSessionSetup({
        systemPromptAppends: this.getSystemPromptAppends()
      })
      const nudgedText = await this.applySkillNudge(request.text, forced)
      // A history preamble (transcript replayed after a context reset) leads, then the framework guidance
      // prefix, then the nudged user text. Absent segments drop out so the normal turn is unchanged.
      const promptText = [request.historyPreamble, promptPrefix, nudgedText]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n')
      const promptContent = await this.createPromptContent(request.sessionId, {
        ...request,
        text: promptText
      })

      this.pushEvent({
        kind: 'message',
        level: 'info',
        sessionId: request.sessionId,
        role: 'user',
        text: request.text
      })

      // Start the prompt and race it against routed updates from the active session queue.
      const promptFailure = new Promise<never>((_, reject) => {
        activeSession.prompt(promptContent).catch(reject)
      })

      for (;;) {
        const message = await Promise.race([activeSession.nextUpdate(), promptFailure])

        if (message.kind === 'stop') {
          // Emit artifact metadata before stop so the renderer can attach files to the finished message.
          await this.emitArtifactRunEvent(request.sessionId, artifactRun)
          artifactEmitted = true
          log.info('prompt stopped', {
            sessionId: request.sessionId,
            stopReason: message.stopReason
          })
          this.pushEvent({
            kind: 'stop',
            level: 'info',
            sessionId: request.sessionId,
            title: 'Prompt stopped',
            text: message.stopReason,
            raw: message.response
          })
          return message.response
        }

        // Route the update under the app-facing id so a session adopted onto a new agent (after a
        // provider switch) still streams into the same conversation the renderer is watching. (No
        // per-update log line here: it fires once per streamed chunk and floods the console for no
        // signal — 'prompt start'/'prompt stopped' already bracket the turn.)
        this.handleSessionUpdate(message.notification, request.sessionId)
      }
    } catch (error) {
      // errorLogFields keeps the RequestError message/code/data visible in the file log — a raw Error
      // nested in the payload serializes without its (non-enumerable) message, which once hid the
      // provider's real rejection reason from the log.
      log.error('prompt failed', { sessionId: request.sessionId, ...errorLogFields(error) })
      const text = describePromptError(error, { model: this.pendingSessionModel })
      // Tag a request-size overflow as recoverable so the renderer compacts-and-retries (reset context +
      // replay a text transcript) instead of dead-ending; the error still throws to drive that recovery.
      // The structured errorKind slug is checked alongside the message text: providers relay the same
      // overflow in different wordings, and a slug-only match needs no message at all.
      const recoverable =
        isMediaOverflowError(text) ||
        isMediaOverflowError(errorMessage(error)) ||
        isMediaOverflowError(acpErrorKind(error))
          ? 'context-overflow'
          : undefined
      this.pushEvent({
        kind: 'error',
        level: 'error',
        recoverable,
        sessionId: request.sessionId,
        title: 'Prompt failed',
        text
      })
      throw error
    } finally {
      // A turn that fails or is aborted never reaches the stop branch; still surface any files it
      // wrote so they are attached to a message instead of being orphaned in the pending directory.
      if (!artifactEmitted) {
        try {
          await this.emitArtifactRunEvent(request.sessionId, artifactRun)
        } catch (error) {
          log.error('artifact emit after prompt failure failed', {
            sessionId: request.sessionId,
            ...errorLogFields(error)
          })
        }
      }
      try {
        await this.clearArtifactRun(artifactRun)
      } catch (error) {
        this.pushEvent({
          kind: 'error',
          level: 'error',
          sessionId: request.sessionId,
          title: 'Artifact cleanup failed',
          text: errorMessage(error)
        })
      }
      // Only clear shared turn state if a newer turn hasn't taken over this app session id. An
      // overflow-recovery replay reuses the id: after resetSessionContext releases this (failed) turn's
      // lock and the renderer starts the replay, this stale finally must not delete the replay's in-flight
      // lock (which would reopen same-session sends and misreport prompt-in-flight) or clear its active
      // artifact run. Identity/token comparisons scope each clear to the turn that still owns the state.
      if (artifactRun && this.activeArtifactRuns.get(request.sessionId) === artifactRun) {
        this.activeArtifactRuns.delete(request.sessionId)
      }
      if (this.currentPromptTurnBySession.get(request.sessionId) === promptTurn) {
        const cancelTimer = this.cancelTimers.get(request.sessionId)
        if (cancelTimer) this.clearTimer(cancelTimer)
        this.cancelTimers.delete(request.sessionId)
        this.currentPromptTurnBySession.delete(request.sessionId)
        this.promptInFlightSessionIds.delete(request.sessionId)
      }
      this.emitState()
      // A disabled skill forced for this turn is restored now: clear the force set, then schedule a
      // reconnect so the NEXT prompt respawns with the normal enabled set. Ordering matters — the clear
      // must happen before the reconnect is applied so the fresh spawn no longer sees the forced ids.
      if (didForceReload && this.skillsHooks) {
        this.skillsHooks.clearTurnForced()
        this.pendingSkillsReload = true
      }
      // A provider switch requested mid-turn is applied now that the session is idle.
      this.maybeApplyPendingProviderReconnect()
    }
  }

  // Requests cancellation without clearing in-flight state before the agent stops.
  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    const activeSession = this.sessions.get(request.sessionId)

    if (this.connection && activeSession) {
      const priorTimer = this.cancelTimers.get(request.sessionId)
      if (priorTimer) this.clearTimer(priorTimer)
      this.cancelTimers.set(
        request.sessionId,
        this.setTimer(() => {
          if (!this.promptInFlightSessionIds.has(request.sessionId)) return
          this.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId: request.sessionId,
            title: 'Prompt cancellation timed out',
            text: 'The agent did not stop, so its process was stopped and will restart on the next prompt.'
          })
          void this.disconnect()
        }, this.cancelTimeoutMs)
      )
      try {
        await this.connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: activeSession.sessionId
        })
      } catch (error) {
        const timer = this.cancelTimers.get(request.sessionId)
        if (timer) this.clearTimer(timer)
        this.cancelTimers.delete(request.sessionId)
        throw error
      }
      this.permissionBroker.cancelForSession(request.sessionId)
      this.pushEvent({
        kind: 'system',
        level: 'warning',
        sessionId: activeSession.sessionId,
        title: 'Prompt cancellation requested'
      })
      this.emitState()
    }

    return this.getSnapshot()
  }

  // Closes the agent-side session when supported, then removes local routing state.
  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    const session = this.sessions.get(request.sessionId)

    if (session) {
      // Talk to the agent using its own session id: for an adopted session the underlying
      // agent id (session.sessionId) differs from the app-facing request.sessionId.
      if (this.connection && this.supportsSessionDelete) {
        await this.connection.agent.request(acp.methods.agent.session.delete, {
          sessionId: session.sessionId
        })
      } else if (this.connection && this.supportsSessionClose) {
        await this.connection.agent.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId
        })
      } else {
        await this.connection?.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: session.sessionId
        })
      }

      session.dispose()
      // Drop the reverse (underlying agent id -> app id) mapping an adopted session registered, so a
      // reused agent id or a late agent event can no longer route to this deleted app session.
      this.agentToAppSessionId.delete(session.sessionId)
      // The options cache is keyed by the agent session id (differs from the app id when adopted).
      this.latestSessionConfigOptions.delete(session.sessionId)
    }

    // App-session-keyed cleanup runs whether or not a live session is attached. A framework switch
    // disconnects (clearing this.sessions and most maps) but deliberately KEEPS sessionFrameworks, so
    // deleting a session that was never re-adopted under the new framework would leak that entry —
    // later misleading the cross-framework-resume check. These deletes are no-ops when the id is absent.
    this.permissionBroker.cancelForSession(request.sessionId)
    const cancelTimer = this.cancelTimers.get(request.sessionId)
    if (cancelTimer) this.clearTimer(cancelTimer)
    this.cancelTimers.delete(request.sessionId)
    // Drop this session's http MCP host registrations (no-op when no host / stdio framework).
    this.unregisterHttpMcpSession(request.sessionId)
    this.sessions.delete(request.sessionId)
    this.sessionCwds.delete(request.sessionId)
    this.sessionInlineImageBytes.delete(request.sessionId)
    this.currentPromptTurnBySession.delete(request.sessionId)
    this.latestSessionConfigOptions.delete(request.sessionId)
    this.sessionMcpServerNames.delete(request.sessionId)
    this.sessionProjectNames.delete(request.sessionId)
    this.sessionFrameworks.delete(request.sessionId)
    this.sessionBackendIds.delete(request.sessionId)
    this.permissionProfiles.delete(request.sessionId)
    this.artifactSessionIds.delete(request.sessionId)
    this.notebookRoutingIds.delete(request.sessionId)
    this.promptInFlightSessionIds.delete(request.sessionId)

    // Only announce a deletion and shift the current session when something was actually attached; a
    // detached cleanup (post-switch) must not emit a spurious event or move currentSessionId.
    if (session) {
      this.currentSessionId =
        this.currentSessionId === request.sessionId
          ? Array.from(this.sessions.keys())[0]
          : this.currentSessionId
      this.pushEvent({
        kind: 'system',
        level: 'info',
        sessionId: request.sessionId,
        title: 'Session deleted'
      })
      this.emitState()
    }

    return this.getSnapshot()
  }

  // Resolves or cancels one pending permission request from the renderer.
  respondToPermission(response: AcpPermissionResponse): AcpStateSnapshot {
    const handled = this.permissionBroker.respond(response)

    this.pushEvent({
      kind: 'permission',
      level: handled ? 'info' : 'warning',
      title: handled ? 'Permission response sent' : 'Permission request not found',
      text: response.cancelled ? 'cancelled' : response.optionId
    })
    this.emitState()

    return this.getSnapshot()
  }

  // Prepends a one-line steering nudge naming the picked skills to the prompt text. No-op when no skills
  // were picked or no hooks are wired. It is prompt text, not a system directive, per the design.
  private async applySkillNudge(text: string, forcedSkillIds: string[]): Promise<string> {
    if (!this.skillsHooks || forcedSkillIds.length === 0) return text

    const names = await this.skillsHooks.namesForIds(forcedSkillIds)
    if (names.length === 0) return text

    return `Use the following skill(s) for this task: ${names.join(', ')}.\n\n${text}`
  }

  // Turns the renderer prompt plus upload references into the ACP prompt payload.
  private async createPromptContent(
    sessionId: string,
    request: AcpPromptRequest
  ): Promise<string | ContentBlock[]> {
    const attachments = [...(request.historyAttachments ?? []), ...(request.attachments ?? [])]
    const referencedArtifacts = request.referencedArtifacts ?? []

    if (
      attachments.length === 0 &&
      referencedArtifacts.length === 0 &&
      (request.historyImages?.length ?? 0) === 0
    )
      return request.text

    const contentBlocks: ContentBlock[] = request.text.trim()
      ? [{ type: 'text', text: request.text }]
      : []
    let imageBudget: InlineImageBudget = { imageCount: 0, base64Bytes: 0 }
    const appendBlock = (block: ContentBlock, overflowFallback?: ContentBlock): void => {
      if (block.type === 'image') {
        try {
          imageBudget = consumeInlineImageBudget(imageBudget, {
            data: block.data,
            mimeType: block.mimeType
          })
        } catch (error) {
          if (error instanceof ImageContentError && error.code === 'IMAGE_TOTAL_BUDGET_EXCEEDED') {
            if (overflowFallback) contentBlocks.push(overflowFallback)
            return
          }
          throw error
        }
      }
      contentBlocks.push(block)
    }
    for (const image of request.historyImages ?? []) {
      appendBlock({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
    if ((request.historyImages?.length ?? 0) > 0) {
      this.sessionInlineImageBytes.set(sessionId, imageBudget.base64Bytes)
    }

    // Staged uploads own the durable session id here, so finalize before turning them into blocks.
    if (attachments.length > 0) {
      if (!this.uploadRepository) throw new Error('Upload storage is not configured.')

      const finalizedAttachments = await this.uploadRepository.finalizePendingSessionUploads(
        sessionId,
        attachments
      )

      // Keep the user's text first, then append files in the same order they were added. A file may
      // expand to several blocks (an oversized text file becomes a preview notice + a resource link);
      // route each through appendBlock so image blocks still honor the per-request inline budget.
      for (const attachment of finalizedAttachments) {
        const blocks = await this.createAttachmentContentBlock(sessionId, attachment)
        for (const block of blocks) {
          appendBlock(
            block,
            this.imageOverflowResourceLink(block, attachment.originalName, attachment.size)
          )
        }
      }
    }

    // `@`-mentioned artifacts reuse the same per-type block builder as uploads, in mention order.
    for (const reference of referencedArtifacts) {
      const blocks = await this.createReferencedArtifactContentBlock(sessionId, reference)
      for (const block of blocks) {
        appendBlock(block, this.imageOverflowResourceLink(block, reference.name))
      }
    }

    return contentBlocks
  }

  private imageOverflowResourceLink(
    block: ContentBlock,
    name: string,
    size?: number
  ): ContentBlock | undefined {
    if (block.type !== 'image' || !block.uri) return undefined

    return {
      type: 'resource_link',
      uri: block.uri,
      name,
      title: name,
      mimeType: block.mimeType,
      size
    }
  }

  // Converts one managed upload into the richest ACP content block that is safe for its type.
  private async createAttachmentContentBlock(
    sessionId: string,
    attachment: UploadedAttachment
  ): Promise<ContentBlock[]> {
    if (!this.uploadRepository) throw new Error('Upload storage is not configured.')

    const filePath = await this.uploadRepository.resolveManagedUploadPath({ path: attachment.path })
    const { size } = await stat(filePath)

    return this.buildFileContentBlock({
      sessionId,
      absolutePath: filePath,
      uri: pathToFileURL(filePath).href,
      name: attachment.originalName || attachment.name,
      mimeType: attachment.mimeType,
      size
    })
  }

  // Converts one `@`-mentioned artifact into the same content block an equivalent upload produces.
  private async createReferencedArtifactContentBlock(
    sessionId: string,
    reference: ArtifactReference
  ): Promise<ContentBlock[]> {
    const filePath = await this.resolveReferencedArtifactPath(reference)
    const { size } = await stat(filePath)

    return this.buildFileContentBlock({
      sessionId,
      absolutePath: filePath,
      uri: pathToFileURL(filePath).href,
      name: reference.name,
      mimeType: reference.mimeType,
      size
    })
  }

  // Resolves a referenced file through the managed-path validator for its owning repository.
  private async resolveReferencedArtifactPath(reference: ArtifactReference): Promise<string> {
    if (reference.source === 'upload') {
      if (!this.uploadRepository) throw new Error('Upload storage is not configured.')
      return this.uploadRepository.resolveManagedUploadPath({ path: reference.path })
    }

    if (!this.artifactRepository) throw new Error('Artifact storage is not configured.')
    return this.artifactRepository.resolveManagedFilePath({ path: reference.path })
  }

  // Builds the richest ACP content block that is safe for a resolved file, shared by uploads and
  // `@`-mentioned artifacts so both reach the agent through identical per-type logic.
  private async buildFileContentBlock(descriptor: {
    sessionId: string
    absolutePath: string
    uri: string
    name: string
    mimeType?: string
    size: number
  }): Promise<ContentBlock[]> {
    const { sessionId, absolutePath, uri, name, mimeType, size } = descriptor

    // Images are embedded as base64 so vision-capable agents receive the actual pixels.
    // Large images are downscaled/re-encoded first so one file cannot overflow the request. Detection
    // falls back to the file extension so a `.png` with a missing/generic MIME (some drag/drop and paste
    // sources omit it) is still inlined as pixels instead of degrading to a bare file link.
    const imageMimeType = imageAttachmentMimeType(name, mimeType)

    if (imageMimeType) {
      const { data, mimeType: outMimeType } = await buildImageContentData(
        absolutePath,
        imageMimeType,
        size
      )

      // Inlined images accumulate over a conversation's replayed history. Once this session's running
      // total nears the request ceiling, degrade further images to a file reference (like large binary
      // uploads) instead of base64, so the conversation never overflows the request or breaks
      // compaction with `media_unstrippable`. The file stays reachable to the agent via its uri.
      const alreadyInlined = this.sessionInlineImageBytes.get(sessionId) ?? 0

      if (!canInlineImageInSession(alreadyInlined, data.length, this.inlineImageBudgetBytes)) {
        return [{ type: 'resource_link', uri, name, title: name, mimeType: imageMimeType, size }]
      }

      this.sessionInlineImageBytes.set(sessionId, alreadyInlined + data.length)

      return [{ type: 'image', data, mimeType: outMimeType, uri }]
    }

    // PDFs are never inlined as base64 (a 20MB file overflows the 32MB request limit); instead we
    // extract selectable text so the model reads readable content. Page images are a future option.
    if (this.isPdfFile(name, mimeType)) {
      return [await this.createPdfContentBlock(name, absolutePath, uri)]
    }

    if (isTextLikeAttachment(name, mimeType)) {
      // Small text-like files are embedded for direct reading.
      if (size <= MAX_EMBEDDED_TEXT_UPLOAD_BYTES) {
        return [
          {
            type: 'resource',
            resource: { uri, mimeType, text: await readFile(absolutePath, 'utf8') }
          }
        ]
      }

      // Oversized text/tabular files are never inlined — a full read is the main request-size overflow
      // source. Send a bounded preview (structure + a few rows) plus a link so the agent reads only what
      // it needs instead of loading the whole file into context.
      const preview = await readBoundedManagedFilePreview(
        absolutePath,
        { path: absolutePath, maxBytes: ATTACHMENT_PREVIEW_BYTES, encoding: 'utf8' },
        'Attachment preview requires UTF-8 encoding.'
      )

      return [
        {
          type: 'text',
          text: buildOversizedAttachmentNotice({
            name,
            size,
            preview: preview.content,
            truncated: preview.truncated,
            tabular: isTabularAttachment(name, mimeType)
          })
        },
        { type: 'resource_link', uri, name, title: name, mimeType, size }
      ]
    }

    // Binary and large files are passed as resource links so agents can decide how to fetch them.
    return [
      {
        type: 'resource_link',
        uri,
        name,
        title: name,
        mimeType,
        size
      }
    ]
  }

  // Recognizes PDFs by MIME type or extension since the renderer does not always send a MIME type.
  private isPdfFile(name: string, mimeType?: string): boolean {
    if (mimeType === 'application/pdf') return true

    return name.toLowerCase().endsWith('.pdf')
  }

  // Turns a PDF into a text resource block, degrading to an explanatory note when extraction fails
  // or yields nothing (e.g. scanned/image-only PDFs) rather than ever inlining the raw file.
  private async createPdfContentBlock(
    name: string,
    filePath: string,
    uri: string
  ): Promise<ContentBlock> {
    const toResource = (text: string): ContentBlock => ({
      type: 'resource',
      resource: { uri, mimeType: 'text/plain', text }
    })

    try {
      const { text, pageCount, truncated } = await extractPdfText(filePath)

      if (!text) {
        return toResource(
          `[No selectable text could be extracted from "${name}" (${pageCount} page(s)). It may be a scanned or image-only PDF.]`
        )
      }

      const header = `[PDF text extracted from "${name}" — ${pageCount} page(s)${
        truncated ? ', truncated' : ''
      }]`

      return toResource(`${header}\n\n${text}`)
    } catch (error) {
      return toResource(
        `[Failed to extract text from "${name}": ${errorMessage(error)}. The PDF was not sent to avoid exceeding the request size limit.]`
      )
    }
  }

  // Lazily initializes the process connection before session creation.
  private async ensureConnected(cwd: string): Promise<ClientConnection> {
    if (this.connection && this.status === 'connected') {
      return this.connection
    }

    log.info('ensureConnected: attempting connection', { cwd, status: this.status })

    try {
      await this.connect({ cwd })
    } catch (error) {
      safeLogError('ensureConnected: connect failed', { cwd, ...errorLogFields(error) })
      throw error
    }

    if (!this.connection) {
      safeLogError('ensureConnected: connection is null after connect', {
        cwd,
        status: this.status
      })
      throw new Error('ACP connection failed')
    }

    log.info('ensureConnected: connection established', { cwd })
    return this.connection
  }

  // Registers client-side protocol handlers exposed to the agent process.
  private createClientConnection(stream: acp.Stream): ClientConnection {
    return acp
      .client({ name: 'open-science' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermissionRequest(ctx.params)
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        readWorkspaceTextFile(
          this.resolveSessionCwd(ctx.params.sessionId),
          ctx.params,
          this.protectedReadRoots()
        )
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        writeWorkspaceTextFile(this.resolveSessionCwd(ctx.params.sessionId), ctx.params)
      )
      .connect(stream)
  }

  // Looks up the workspace root bound to a session for filesystem operations.
  private resolveSessionCwd(sessionId: string): string {
    const sessionCwd = this.sessionCwds.get(sessionId)

    if (!this.sessions.has(sessionId) || !sessionCwd) {
      throw new Error(`Unknown ACP session: ${sessionId}`)
    }

    return sessionCwd
  }

  // App-owned directories the agent's Read tool must never read: framework config dirs hold
  // materialized skills plus provider/auth configuration whose contents must not be surfaced.
  private protectedReadRoots(): string[] {
    if (!this.artifactOptions) return []

    const root = this.artifactOptions.configRoot

    return [
      getAppClaudeConfigDir(root),
      opencodeStorageDir(root),
      codexStorageDir(root),
      codexSubscriptionStorageDir(root)
    ]
  }

  // Creates an app-owned artifact session id so new ACP sessions never decide their storage directory.
  private createArtifactSessionId(): string {
    if (!this.artifactOptions) return ''

    this.artifactSessionSequence += 1

    return `artifact-session-${Date.now()}-${this.artifactSessionSequence}`
  }

  // Maps protocol session ids to artifact session ids for later prompt turns and cleanup.
  private rememberArtifactSession(sessionId: string, artifactSessionId: string): void {
    if (!artifactSessionId) return

    this.artifactSessionIds.set(sessionId, artifactSessionId)
  }

  // Builds the artifact MCP environment for one session, shared by the stdio config and the http host.
  private buildArtifactEnvironment(
    artifactSessionId: string,
    sessionCwd: string,
    projectName: string
  ): ArtifactMcpEnvironment | undefined {
    if (!this.artifactOptions || !artifactSessionId) return undefined

    // Only the session workspace is a static import root. The notebook session root is intentionally
    // NOT added here: at session creation we only hold the pre-start alias, and authorizing the alias
    // dir would let stale-alias absolute paths pass the allow-root check. The authoritative notebook
    // root (keyed by the final ACP session id) is supplied per turn via the current-run.json handoff.
    return {
      storageRoot: this.artifactOptions.dataRoot,
      projectName,
      sessionId: artifactSessionId,
      currentRunFile: this.getArtifactCurrentRunFile(artifactSessionId, projectName),
      allowedImportRoots: [sessionCwd]
    }
  }

  // Provides the agent with exactly one artifact MCP server scoped to this session's storage context.
  private createArtifactMcpServers(
    artifactSessionId: string,
    sessionCwd: string,
    projectName: string
  ): McpServer[] {
    const environment = this.buildArtifactEnvironment(artifactSessionId, sessionCwd, projectName)

    if (!environment || !this.artifactOptions) return []

    return [
      createArtifactMcpServerConfig({
        command: this.artifactOptions.mcpCommand ?? process.execPath,
        entryPath: this.artifactOptions.mcpEntryPath,
        ...environment
      })
    ]
  }

  // Creates an app-owned notebook session alias for new ACP sessions whose real id is not known yet.
  private createNotebookSessionId(): string {
    if (!this.notebookOptions) return ''

    this.notebookSessionSequence += 1

    return `notebook-session-${Date.now()}-${this.notebookSessionSequence}`
  }

  // Lets the local notebook RPC layer map pre-start aliases to the final ACP session id.
  private rememberNotebookSession(sessionId: string, notebookSessionId: string): void {
    if (!this.notebookOptions || !notebookSessionId) return

    // Record the routing id the http MCP host was registered under, for later unregister.
    this.notebookRoutingIds.set(sessionId, notebookSessionId)

    if (notebookSessionId === sessionId) return

    this.notebookOptions.registerSessionAlias?.(notebookSessionId, sessionId)
  }

  // Builds the notebook MCP environment for one session, shared by the stdio config and the http host.
  private async buildNotebookEnvironment(
    notebookSessionId: string,
    sessionCwd: string,
    projectName: string
  ): Promise<NotebookMcpEnvironment | undefined> {
    if (!this.notebookOptions || !notebookSessionId) return undefined

    const connection = await this.resolveNotebookRpcConnection()

    return {
      endpoint: connection.endpoint,
      token: connection.token,
      projectName,
      sessionId: notebookSessionId,
      workspaceCwd: sessionCwd
    }
  }

  // Provides the agent with a notebook MCP server scoped to this session's runtime route.
  private async createNotebookMcpServers(
    notebookSessionId: string,
    sessionCwd: string,
    projectName: string
  ): Promise<McpServer[]> {
    const environment = await this.buildNotebookEnvironment(
      notebookSessionId,
      sessionCwd,
      projectName
    )

    if (!environment || !this.notebookOptions) return []

    return [
      createNotebookMcpServerConfig({
        command: this.notebookOptions.mcpCommand ?? process.execPath,
        entryPath: this.notebookOptions.mcpEntryPath,
        ...environment
      })
    ]
  }

  // Resolves either a static test connection or the real app-local RPC server connection.
  private async resolveNotebookRpcConnection(): Promise<NotebookRpcConnection> {
    if (!this.notebookOptions) {
      throw new Error('Notebook runtime is not configured.')
    }

    if (this.notebookOptions.getRpcConnection) {
      return this.notebookOptions.getRpcConnection()
    }

    throw new Error('Notebook runtime RPC connection is not configured.')
  }

  // Combines every MCP config that should be visible to the agent for one session.
  private async createMcpServers({
    artifactSessionId,
    notebookSessionId,
    sessionCwd,
    projectName
  }: {
    artifactSessionId: string
    notebookSessionId: string
    sessionCwd: string
    projectName: string
  }): Promise<McpServer[]> {
    // Bridge-backed Codex receives the app-owned notebook schemas as namespaced Chat aliases while the
    // actual tool remains attached here as MCP. Codex therefore keeps ownership of dispatch, approval,
    // and execution. The artifact server stays gated on native Responses; non-bridge sessions get both.
    const artifactEnabled = this.nativeMcpEnabled || this.bridgeMcpAliasesEnabled

    // The artifact/notebook servers are stdio. A framework that only accepts http/sse MCP (opencode)
    // gets them over the http host when one is wired; without a host it gets none so a basic turn still
    // runs instead of failing on an unsupported stdio server config.
    const servers = this.framework.acceptsStdioMcp
      ? [
          ...(artifactEnabled
            ? this.createArtifactMcpServers(artifactSessionId, sessionCwd, projectName)
            : []),
          ...(await this.createNotebookMcpServers(notebookSessionId, sessionCwd, projectName))
        ]
      : await this.createHttpMcpServers(
          artifactSessionId,
          notebookSessionId,
          sessionCwd,
          projectName
        )

    if (!artifactEnabled) {
      log.info(
        'artifact MCP server disabled for Responses bridge; notebook server kept for host.mcp'
      )
    }

    // Log the MCP server launch specs (command/url, no secrets) — a bad command/entry path or an
    // unstarted host can make the agent stall while it waits on an MCP server that never responds.
    log.info('session MCP servers', {
      count: servers.length,
      servers: servers.map((server) => {
        const record = server as { name?: string; command?: string; url?: string; args?: unknown }
        return { name: record.name, command: record.command, url: record.url, args: record.args }
      })
    })

    return servers
  }

  // Extracts the names of the MCP servers handed to a session so MCP-origin tool calls can be
  // recognized later (see sessionMcpServerNames). Both stdio and http McpServer configs carry a name.
  private mcpServerNamesOf(servers: McpServer[]): string[] {
    return servers
      .map((server) => (server as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
  }

  // Drops one session's artifact/notebook registrations from the http MCP host (no-op without a host).
  private unregisterHttpMcpSession(appSessionId: string): void {
    if (!this.mcpHttpHost) return

    const artifactRoutingId = this.artifactSessionIds.get(appSessionId)
    if (artifactRoutingId) this.mcpHttpHost.unregister(artifactRoutingId)

    const notebookRoutingId = this.notebookRoutingIds.get(appSessionId)
    if (notebookRoutingId) this.mcpHttpHost.unregister(notebookRoutingId)
  }

  // Serves the artifact/notebook MCP over the local http host for frameworks that reject stdio MCP.
  // Registers each session's environment under its app-owned id and returns http McpServer configs
  // pointing at the host, authenticated with the host token. No host wired ⇒ no servers (basic turn).
  private async createHttpMcpServers(
    artifactSessionId: string,
    notebookSessionId: string,
    sessionCwd: string,
    projectName: string
  ): Promise<McpServer[]> {
    if (!this.mcpHttpHost) return []

    const { token } = await this.mcpHttpHost.ensureStarted()
    const authHeader = { name: 'authorization', value: `Bearer ${token}` }
    const servers: McpServer[] = []

    const artifactEnvironment = this.buildArtifactEnvironment(
      artifactSessionId,
      sessionCwd,
      projectName
    )

    if (artifactEnvironment) {
      this.mcpHttpHost.registerArtifact(artifactSessionId, artifactEnvironment)
      servers.push({
        type: 'http',
        name: ARTIFACT_MCP_SERVER_NAME,
        url: this.mcpHttpHost.urlFor('artifact', artifactSessionId),
        headers: [authHeader]
      })
    }

    const notebookEnvironment = await this.buildNotebookEnvironment(
      notebookSessionId,
      sessionCwd,
      projectName
    )

    if (notebookEnvironment) {
      this.mcpHttpHost.registerNotebook(notebookSessionId, notebookEnvironment)
      servers.push({
        type: 'http',
        name: NOTEBOOK_MCP_SERVER_NAME,
        url: this.mcpHttpHost.urlFor('notebook', notebookSessionId),
        headers: [authHeader]
      })
    }

    return servers
  }

  // Collects the system-prompt guidance appended to every session: the skill-privacy guardrail (always
  // — skills are materialized whenever the app runs), plus artifact/notebook tooling instructions when
  // those services are wired. The active framework decides how these are delivered (Claude's preset
  // append vs opencode's prompt prefix).
  // Whether the local MCP transport can carry app tooling at all: the framework takes stdio MCP
  // directly (Claude, Codex) or an http host is wired (opencode). Must match createMcpServers so the
  // guidance is only sent for tools actually wired.
  private mcpTransportAvailable(): boolean {
    return this.framework.acceptsStdioMcp || Boolean(this.mcpHttpHost)
  }

  // Notebook tooling is wired even for bridge-backed Codex (see createMcpServers), so its guidance is
  // gated only on the transport + notebook config, not on full native MCP.
  private notebookToolingAvailable(): boolean {
    return this.mcpTransportAvailable() && Boolean(this.notebookOptions)
  }

  // The artifact write tool is only wired when full native MCP is enabled (off for the bridge), so its
  // guidance follows that flag.
  private artifactToolingAvailable(): boolean {
    return (
      (this.nativeMcpEnabled || this.bridgeMcpAliasesEnabled) &&
      this.mcpTransportAvailable() &&
      Boolean(this.artifactOptions)
    )
  }

  private getSystemPromptAppends(): string[] {
    // Each append names MCP tools that only exist when that tooling is actually wired for this session;
    // omit it otherwise so the agent isn't told to use tools it wasn't given.
    return [
      SKILLS_READ_GUARD_SYSTEM_PROMPT_APPEND,
      LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND,
      ...(this.artifactToolingAvailable() ? [ARTIFACT_FILE_SYSTEM_PROMPT_APPEND] : []),
      ...(this.notebookToolingAvailable() ? [NOTEBOOK_SYSTEM_PROMPT_APPEND] : [])
    ]
  }

  // Builds the ACP `_meta` argument for session/new and session/resume, delegating the framework-specific
  // shape to the active framework. For Claude this is the claudeCode.settingSources restriction (pins the
  // app-owned config dir so a workspace ~/.claude env block can't override the active provider endpoint)
  // plus the system-prompt preset carrying the appends; opencode returns no meta and delivers the appends
  // as a prompt prefix instead.
  private buildSessionMetaArg(): { _meta?: Record<string, unknown> } {
    const setup = this.framework.buildSessionSetup({
      systemPromptAppends: this.getSystemPromptAppends()
    })

    return setup.meta ? { _meta: setup.meta } : {}
  }

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectName(sessionId: string): string {
    return this.sessionProjectNames.get(sessionId) ?? this.artifactOptions?.projectName ?? ''
  }

  // Normalizes a requested project name, falling back to the runtime default when absent.
  private normalizeProjectName(requestedProjectName: string | undefined): string {
    return requestedProjectName?.trim() || (this.artifactOptions?.projectName ?? '')
  }

  // Resolves the per-session handoff file that tells the MCP process which run is active.
  private getArtifactCurrentRunFile(artifactSessionId: string, projectName: string): string {
    if (!this.artifactOptions) {
      throw new Error('Artifact storage is not configured.')
    }

    return getArtifactCurrentRunFilePath(
      this.artifactOptions.dataRoot,
      projectName,
      artifactSessionId
    )
  }

  // Marks a new assistant turn as the active artifact run before the model can call the MCP tool.
  private async activateArtifactRun(sessionId: string): Promise<ActiveArtifactRun | undefined> {
    if (!this.artifactOptions || !this.artifactRepository) return undefined

    this.artifactRunSequence += 1
    const artifactSessionId = this.artifactSessionIds.get(sessionId) ?? sessionId
    const projectName = this.resolveSessionProjectName(sessionId)
    const currentRunFile = this.getArtifactCurrentRunFile(artifactSessionId, projectName)
    const artifactRun = {
      runId: `artifact-run-${Date.now()}-${this.artifactRunSequence}`,
      artifactSessionId,
      currentRunFile
    }

    // Notebook kernels are keyed by the FINAL ACP session id (the notebook RPC layer rewrites the
    // pre-start alias to it before touching disk). This handoff runs per turn with that final id, so
    // it — not the session-creation env, which only had the alias — is the correct place to pin the
    // kernel's data dir + session root for relative/bare artifact imports.
    const runContext: ArtifactRunContext =
      this.notebookOptions && this.artifactOptions
        ? {
            runId: artifactRun.runId,
            notebookDataDir: getNotebookDataRoot(
              this.artifactOptions.dataRoot,
              projectName,
              sessionId
            ),
            notebookSessionRoot: getNotebookSessionRoot(
              this.artifactOptions.dataRoot,
              projectName,
              sessionId
            )
          }
        : { runId: artifactRun.runId }

    await mkdir(dirname(currentRunFile), { recursive: true })
    await writeFile(currentRunFile, `${JSON.stringify(runContext)}\n`, 'utf8')

    return artifactRun
  }

  // Clears the handoff file after the prompt so late MCP writes cannot attach to a completed turn.
  private async clearArtifactRun(artifactRun: ActiveArtifactRun | undefined): Promise<void> {
    if (!artifactRun) return

    await writeFile(artifactRun.currentRunFile, `${JSON.stringify({})}\n`, 'utf8')
  }

  // Writes an inline file into the in-flight turn's pending artifact run so it attaches to the resulting
  // message and surfaces to the renderer like any generated artifact. Used by app-side connector tools
  // (e.g. molecule preview). Throws when no assistant turn is active (e.g. a user-run notebook cell).
  async writeArtifactForCurrentRun(
    sessionId: string,
    input: {
      filename: string
      content: string
      mimeType?: string
    }
  ): Promise<ArtifactFile> {
    // Attribute the write to the run of the session that triggered it, resolved from the caller's
    // session id — never a global "current" run, so a parallel session's in-flight turn cannot capture
    // this file. Fail closed when the session has no active run.
    const run = sessionId ? this.activeArtifactRuns.get(sessionId) : undefined
    if (!run || !this.artifactRepository) {
      throw new Error('No active assistant turn to attach a generated file to.')
    }

    return this.artifactRepository.writePendingFile({
      projectName: this.resolveSessionProjectName(sessionId),
      sessionId: run.artifactSessionId,
      runId: run.runId,
      filename: input.filename,
      mimeType: input.mimeType,
      source: { kind: 'inline', content: input.content, encoding: 'utf8' }
    })
  }

  // Publishes pending files as a claim event; the renderer later supplies the final message id.
  private async emitArtifactRunEvent(
    sessionId: string,
    artifactRun: ActiveArtifactRun | undefined
  ): Promise<void> {
    if (
      !this.artifactOptions ||
      !this.artifactRepository ||
      !this.artifactRunRegistry ||
      !artifactRun
    ) {
      return
    }

    const sessionProjectName = this.resolveSessionProjectName(sessionId)
    const artifacts = await this.artifactRepository.listPendingRunFiles({
      projectName: sessionProjectName,
      sessionId: artifactRun.artifactSessionId,
      runId: artifactRun.runId
    })

    if (artifacts.length === 0) return

    const artifactClaimId = this.artifactRunRegistry.register({
      projectName: sessionProjectName,
      artifactSessionId: artifactRun.artifactSessionId,
      sessionId,
      runId: artifactRun.runId
    })

    this.pushEvent({
      kind: 'artifact',
      level: 'info',
      sessionId,
      title: 'Generated files',
      runId: artifactRun.runId,
      artifactSessionId: artifactRun.artifactSessionId,
      artifactClaimId,
      artifacts
    })
  }

  // Hands permission requests to the broker so the renderer can answer later. Any failure is logged with
  // its real message before it propagates: the ACP SDK collapses a thrown handler error into a bare
  // -32603 "Internal error" (real detail buried in `data.details`), so this is the only place the true
  // cause is captured in the app log. The error is rethrown unchanged to preserve protocol behavior.
  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    // Fork point: a WebFetch/server-side tool that never reaches this line means the "Internal error"
    // originated elsewhere. Info level so it's a visible audit line (one per prompt): if an MCP call
    // runs without this appearing, the agent never asked (e.g. an un-gated permission config). Log the
    // tool identity (name/kind) and whether it looks like MCP — never the title (a WebFetch title is the
    // full URL with query params, i.e. user data).
    const appSessionId = this.agentToAppSessionId.get(params.sessionId) ?? params.sessionId
    const mcpServerNames = this.sessionMcpServerNames.get(appSessionId) ?? []
    const toolName = extractProviderToolName(params.toolCall)
    const isMcp =
      isMcpToolName(params.toolCall?.title, mcpServerNames) ||
      isMcpToolName(toolName, mcpServerNames)
    log.info('permission request received', {
      tool: toolName ?? params.toolCall?.kind,
      isMcp,
      toolCallId: params.toolCall?.toolCallId,
      sessionId: params.sessionId,
      optionCount: params.options?.length
    })

    try {
      // Background reviewer sessions run unattended and are intentionally absent from `this.sessions`.
      // Approve only their dedicated, scope-bounded MCP. Bash, filesystem, network, other MCP servers,
      // and unknown tools are rejected without involving the renderer.
      if (this.reviewerSessionIds.has(params.sessionId)) {
        return this.resolveReviewerPermission(
          params,
          mcpServerNames,
          this.sessionFrameworks.get(params.sessionId)
        )
      }

      if (!this.sessions.has(appSessionId)) {
        throw new Error(`Unknown ACP session: ${appSessionId}`)
      }

      const profileState = this.permissionProfiles.get(appSessionId)

      return await this.permissionBroker.requestPermission(
        appSessionId === params.sessionId ? params : { ...params, sessionId: appSessionId },
        {
          profile: profileState?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          autoReviewStrategy: profileState?.autoReviewStrategy,
          cwd: this.sessionCwds.get(appSessionId),
          mcpServerNames
        }
      )
    } catch (error) {
      log.error('permission request failed', {
        message: errorMessage(error),
        tool: extractProviderToolName(params.toolCall) ?? params.toolCall?.kind,
        toolCallId: params.toolCall?.toolCallId,
        sessionId: params.sessionId
      })
      throw error
    }
  }

  // Grants only the dedicated reviewer MCP. The old implementation selected the first available option
  // for every reviewer request, which effectively approved Bash/network/filesystem tools. A denied call
  // uses a one-shot reject when offered and otherwise cancels; it never falls through to an allow option.
  private resolveReviewerPermission(
    params: RequestPermissionRequest,
    mcpServerNames: readonly string[],
    frameworkId: string | undefined
  ): RequestPermissionResponse {
    const toolName = extractProviderToolName(params.toolCall)
    const reportedTitle = params.toolCall.title
    const opencodeToolName =
      toolName == null &&
      frameworkId === 'opencode' &&
      typeof reportedTitle === 'string' &&
      REVIEWER_MCP_OPENCODE_TOOL_NAMES.has(reportedTitle)
        ? reportedTitle
        : undefined
    const isReviewerMcp =
      mcpServerNames.length === 1 &&
      mcpServerNames[0] === REVIEWER_MCP_SERVER_NAME &&
      ((toolName != null && REVIEWER_MCP_PROVIDER_TOOL_NAMES.has(toolName)) ||
        opencodeToolName != null)

    if (!isReviewerMcp) {
      const rejectOption =
        params.options.find((option) => option.kind === 'reject_once') ??
        params.options.find((option) => option.kind === 'reject_always')

      log.warn('rejecting non-reviewer tool requested by background reviewer', {
        sessionId: params.sessionId,
        tool: toolName ?? params.toolCall.kind,
        toolCallId: params.toolCall?.toolCallId
      })

      return rejectOption
        ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }

    const allowOption =
      params.options.find((option) => option.kind === 'allow_once') ??
      params.options.find((option) => option.kind === 'allow_always')

    if (!allowOption) {
      log.warn('reviewer MCP permission request had no allow option; cancelling', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId
      })
      return { outcome: { outcome: 'cancelled' } }
    }

    log.debug('approving scope-bounded reviewer MCP tool call', {
      sessionId: params.sessionId,
      toolCallId: params.toolCall?.toolCallId,
      optionId: allowOption.optionId
    })

    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
  }

  // Normalizes low-level session notifications into runtime/workspace events.
  private handleSessionUpdate(notification: SessionNotification, appSessionId?: string): void {
    // When a session was adopted onto a replaced agent, the agent labels updates with its own id;
    // relabel to the app-facing id so events land in the conversation the renderer tracks.
    const routed =
      appSessionId && appSessionId !== notification.sessionId
        ? { ...notification, sessionId: appSessionId }
        : notification

    if (routed.update.sessionUpdate === 'current_mode_update') {
      const profileState = this.permissionProfiles.get(routed.sessionId)

      if (profileState) {
        this.permissionProfiles.set(
          routed.sessionId,
          applyCurrentModeUpdate(profileState, routed.update.currentModeId)
        )
        this.emitState()
      }
    }

    const event = toAcpRuntimeEvent(routed, this.nextEventId())

    // Tool results (e.g. WebFetch's claude.ai domain-safety preflight, a failed Bash command) stream as
    // tool_call_update content, which the session-update log omits — so a tool that runs and fails leaves
    // no trace. Surface failures with the tool name and a bounded, text-only reason; never the arguments,
    // raw output, or the URL/command-bearing title, to keep user data out of the log.
    if (event.kind === 'tool' && event.status === 'failed') {
      log.warn('tool call failed', {
        tool: event.providerToolName ?? event.toolKind,
        toolCallId: event.toolCallId,
        sessionId: event.sessionId,
        reason: extractToolFailureText(event.toolContent)
      })
    }

    if ((event.kind === 'message' || event.kind === 'thought') && !event.text) {
      return
    }

    this.pushEvent(event)
  }

  // Captures process stderr/errors/exits and converts unexpected ones to events.
  private attachAgentProcessEvents(agentProcess: ChildProcessWithoutNullStreams): void {
    // Bind the framework this process was spawned under now. During a reconnect the runtime's
    // this.framework may already point at a new backend, so reading it inside the async handlers would
    // mislabel a late stderr/exit from the old process.
    const framework = this.framework.id

    agentProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()

      // Always capture agent stderr in the log — it's the primary clue when a turn stalls or the
      // agent misbehaves (auth loops, MCP connection failures, tool errors) in a packaged build.
      if (text) {
        log.warn('agent stderr', {
          text,
          framework,
          status: this.status,
          sessionCount: this.sessions.size
        })
      }

      if (this.expectedProcessExits.has(agentProcess)) {
        return
      }

      if (text) {
        // Attribute stderr to a session only when exactly one prompt is in flight — then it's
        // unambiguously that turn's. With zero or multiple concurrent prompts, omit the sessionId
        // rather than risk pinning it to the wrong conversation's waiting indicator.
        const inFlight = Array.from(this.promptInFlightSessionIds)
        this.pushEvent({
          kind: 'system',
          level: 'warning',
          sessionId: inFlight.length === 1 ? inFlight[0] : undefined,
          title: 'agent',
          text
        })
      }
    })

    agentProcess.on('error', (error) => {
      log.error('agent process error event', {
        ...errorLogFields(error),
        framework,
        status: this.status,
        pid: agentProcess.pid
      })

      if (this.expectedProcessExits.has(agentProcess)) {
        return
      }

      this.error = errorMessage(error)
      this.pushEvent({
        kind: 'error',
        level: 'error',
        title: 'Agent process error',
        text: this.error
      })
      this.setStatus('error')
    })

    agentProcess.on('exit', (code, signal) => {
      log.info('agent process exit', {
        code,
        signal,
        framework,
        status: this.status,
        expected: this.expectedProcessExits.has(agentProcess),
        sessionCount: this.sessions.size,
        pid: agentProcess.pid
      })

      if (this.expectedProcessExits.has(agentProcess)) {
        return
      }

      if (this.status === 'connected' || this.status === 'connecting') {
        this.pushEvent({
          kind: 'system',
          level: code === 0 ? 'info' : 'warning',
          title: 'Agent process exited',
          text: signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
        })
      }
    })
  }

  // Clears local state after the protocol connection closes unexpectedly.
  private handleConnectionClosed(): void {
    const orphanedProcess = this.agentProcess
    if (orphanedProcess) {
      this.expectedProcessExits.add(orphanedProcess)
      void terminateProcessTree(orphanedProcess, undefined, log)
    }
    for (const timer of this.cancelTimers.values()) this.clearTimer(timer)
    this.cancelTimers.clear()
    this.permissionBroker.cancelAll()
    this.clearReviewerSessionState()
    this.sessions.clear()
    this.sessionCwds.clear()
    this.sessionInlineImageBytes.clear()
    this.currentPromptTurnBySession.clear()
    this.latestSessionConfigOptions.clear()
    this.sessionMcpServerNames.clear()
    this.sessionProjectNames.clear()
    this.artifactSessionIds.clear()
    this.notebookRoutingIds.clear()
    this.mcpHttpHost?.clear()
    this.agentToAppSessionId.clear()
    this.currentSessionId = undefined
    this.supportsSessionClose = false
    this.supportsSessionDelete = false
    this.connection = undefined
    this.agentProcess = undefined
    this.promptInFlightSessionIds.clear()
    this.setStatus('closed')
  }

  // Updates connection status and broadcasts the new snapshot.
  private setStatus(status: AcpStateSnapshot['status']): void {
    this.status = status
    this.emitState()
  }

  // Adds a bounded event entry and notifies all renderer listeners.
  private pushEvent(
    event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>
  ): void {
    let image = event.image
    let raw = event.raw
    let text = event.text
    if (image && event.sessionId) {
      const retainedBytes = this.events
        .filter((candidate) => candidate.sessionId === event.sessionId)
        .reduce(
          (total, candidate) => total + (getAcpRuntimeEventImage(candidate)?.byteLength ?? 0),
          0
        )
      if (retainedBytes + image.byteLength > MAX_ACP_SESSION_IMAGE_BYTES) {
        image = undefined
        raw = undefined
        text = 'Agent image omitted because the session image budget was reached.'
      }
    }

    const runtimeEvent: AcpRuntimeEvent = {
      id: event.id ?? this.nextEventId(),
      timestamp: event.timestamp ?? Date.now(),
      level: event.level ?? 'info',
      kind: event.kind,
      recoverable: event.recoverable,
      sessionId: event.sessionId,
      messageId: event.messageId,
      role: event.role,
      text,
      image,
      title: event.title,
      status: event.status,
      toolCallId: event.toolCallId,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      runId: event.runId,
      artifactSessionId: event.artifactSessionId,
      artifactClaimId: event.artifactClaimId,
      artifacts: event.artifacts,
      raw
    }

    this.events = [...this.events, runtimeEvent].slice(-MAX_EVENTS)
    this.callbacks.onEvent?.(runtimeEvent)
    this.emitState()
  }

  // Generates monotonically increasing event ids for this runtime instance.
  private nextEventId(): string {
    this.eventSequence += 1
    return `acp-event-${this.eventSequence}`
  }

  // Broadcasts the latest runtime snapshot if a listener is registered.
  private emitState(): void {
    this.callbacks.onStateChanged?.(this.getSnapshot())
  }

  private clearReviewerSessionState(): void {
    for (const [sessionId, reviewerCwd] of this.reviewerSessionDirectories) {
      this.removeReviewerDirectory(reviewerCwd)
      this.sessionFrameworks.delete(sessionId)
    }
    this.reviewerSessionDirectories.clear()
    this.reviewerSessionIds.clear()
  }

  private removeReviewerDirectory(reviewerCwd: string): void {
    try {
      rmSync(reviewerCwd, { recursive: true, force: true })
    } catch (error) {
      log.warn('failed to remove temporary reviewer directory', {
        reviewerCwd,
        error: errorMessage(error)
      })
    }
  }

  // Creates an ephemeral reviewer ACP session using the existing agent connection. The reviewer
  // session is isolated from main agent sessions: it is not tracked in this.sessions, does not
  // appear in the snapshot, and callers are responsible for disposing it. This allows background
  // review to run in parallel with the main session without affecting the main state machine.
  async buildReviewerSession(request: {
    // Used only to establish/reuse the shared agent connection. The reviewer session itself runs in an
    // app-created empty temporary directory so built-in read tools cannot see the audited workspace.
    cwd: string
    mcpServers: McpServer[]
    systemPromptAppend?: string
  }): Promise<{
    session: import('@agentclientprotocol/sdk').ActiveSession
    // Framework-neutral rubric delivery: Claude carries the append in session _meta (empty prefix),
    // opencode has no preset so the rubric rides back as a prompt prefix the caller must prepend.
    promptPrefix?: string
  }> {
    const mcpServerNames = this.mcpServerNamesOf(request.mcpServers)
    const reviewerMcp = request.mcpServers[0]
    const reviewerMcpHttp =
      reviewerMcp && 'type' in reviewerMcp && reviewerMcp.type === 'http' ? reviewerMcp : undefined
    let reviewerMcpUrl: URL | undefined
    try {
      reviewerMcpUrl = reviewerMcpHttp ? new URL(reviewerMcpHttp.url) : undefined
    } catch {
      reviewerMcpUrl = undefined
    }
    if (
      request.mcpServers.length !== 1 ||
      mcpServerNames.length !== 1 ||
      mcpServerNames[0] !== REVIEWER_MCP_SERVER_NAME ||
      !reviewerMcpHttp ||
      reviewerMcpUrl?.protocol !== 'http:' ||
      reviewerMcpUrl.hostname !== '127.0.0.1'
    ) {
      throw new Error(
        `Reviewer sessions require exactly one loopback HTTP ${REVIEWER_MCP_SERVER_NAME} MCP server.`
      )
    }

    const connection = await this.ensureConnected(request.cwd)
    const reviewerCwd = await mkdtemp(join(tmpdir(), 'open-science-reviewer-'))

    const setup = this.framework.buildSessionSetup({
      systemPromptAppends: request.systemPromptAppend ? [request.systemPromptAppend] : []
    })
    const reviewerMeta: Record<string, unknown> = {
      ...(setup.meta ?? {}),
      // claude-agent-acp's framework-neutral legacy switch; harmless to agents that ignore it.
      disableBuiltInTools: true
    }
    if (this.framework.id === 'claude-code') {
      const claudeCode =
        typeof reviewerMeta.claudeCode === 'object' && reviewerMeta.claudeCode !== null
          ? (reviewerMeta.claudeCode as Record<string, unknown>)
          : {}
      const claudeOptions =
        typeof claudeCode.options === 'object' && claudeCode.options !== null
          ? (claudeCode.options as Record<string, unknown>)
          : {}
      reviewerMeta.claudeCode = {
        ...claudeCode,
        options: { ...claudeOptions, tools: [] }
      }
    }

    try {
      const session = await connection.agent
        .buildSession({
          cwd: reviewerCwd,
          mcpServers: request.mcpServers,
          _meta: reviewerMeta
        })
        .start()

      try {
        // Apply the framework's Ask baseline before prompting. The dedicated reviewer MCP is
        // then selectively approved by resolveReviewerPermission; all other permission requests fail.
        const permission = this.framework.mapPermissionProfile('ask', session.modes)
        if (permission.modeId && permission.modeId !== session.modes?.currentModeId) {
          await connection.agent.request(acp.methods.agent.session.setMode, {
            sessionId: session.sessionId,
            modeId: permission.modeId
          })
        }
      } catch (error) {
        session.dispose()
        throw error
      }

      this.reviewerSessionIds.add(session.sessionId)
      this.reviewerSessionDirectories.set(session.sessionId, reviewerCwd)
      this.sessionMcpServerNames.set(session.sessionId, mcpServerNames)
      this.sessionFrameworks.set(session.sessionId, this.framework.id)

      return { session, promptPrefix: setup.promptPrefix }
    } catch (error) {
      this.removeReviewerDirectory(reviewerCwd)
      throw error
    }
  }

  // Disposes an ephemeral reviewer session and unregisters it from the auto-approve set. Safe to call
  // even if the session was never registered (e.g. it failed before start).
  disposeReviewerSession(session: import('@agentclientprotocol/sdk').ActiveSession): void {
    this.reviewerSessionIds.delete(session.sessionId)
    this.sessionMcpServerNames.delete(session.sessionId)
    this.sessionFrameworks.delete(session.sessionId)
    const reviewerCwd = this.reviewerSessionDirectories.get(session.sessionId)
    this.reviewerSessionDirectories.delete(session.sessionId)
    session.dispose()
    if (reviewerCwd) this.removeReviewerDirectory(reviewerCwd)
  }
}

export { AcpRuntime }
