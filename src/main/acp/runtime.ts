import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  ContentBlock,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeState,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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
import {
  DEFAULT_PERMISSION_PROFILE,
  normalizePermissionProfile,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../shared/permission-profiles'
import { spawnClaudeAgentAcp, type SpawnClaudeAgentAcpOptions } from './agent-process'
import { createLogger } from '../logger'
import {
  extractProviderToolName,
  extractToolFailureText,
  toAcpRuntimeEvent
} from './runtime-events'
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'
import { AcpPermissionBroker } from './permission-broker'
import {
  applyCurrentModeUpdate,
  resolvePermissionProfileApplication
} from './permission-profile-controller'
import { createArtifactMcpServerConfig } from '../artifacts/mcp-server'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import {
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  createNotebookMcpServerConfig,
  type NotebookRpcConnection
} from '../notebook/mcp-server'
import { getNotebookSessionRoot } from '../notebook/repository'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { withDataRootWrite } from '../storage/migration-state'
import type { UploadRepository } from '../uploads/repository'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, ArtifactReference } from '../../shared/artifacts'
import { buildImageContentData, extractPdfText } from '../uploads/attachment-media'

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
  // Resolves the current active-provider spawn config at connect time so switching providers takes
  // effect on reconnect. Ignored when an explicit spawnAgent is provided (tests inject that directly).
  resolveSpawnConfig?: () => Promise<SpawnClaudeAgentAcpOptions> | SpawnClaudeAgentAcpOptions
  artifacts?: AcpRuntimeArtifactOptions
  uploads?: AcpRuntimeUploadOptions
  notebook?: AcpRuntimeNotebookOptions
  skills?: AcpRuntimeSkillsOptions
  // Bounds the network-bound reconnect+resume so Resume always resolves; the fast attached-session
  // path is never timed. Injectable timer mirrors the approval broker so tests stay deterministic.
  resumeTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
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

// Small text uploads are embedded directly; larger files stay as links to avoid huge prompt payloads.
const MAX_EMBEDDED_TEXT_UPLOAD_BYTES = 1024 * 1024

// Converts unknown thrown values into user-visible error text.
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const log = createLogger('acp')

// Detects an agent-side resume failure that means the session cannot be reattached, so the thread
// should adopt a fresh agent session instead of dead-ending. A spec-compliant agent returns
// "Resource not found" (-32002) for a session id it no longer holds (e.g. after a provider switch);
// some agents instead return a generic "Internal error" (-32603) after an app restart replaced their
// process. Both mean resume is impossible here. Other failures (invalid params, transport errors)
// still propagate so genuinely fatal problems stay visible.
const isUnresumableSessionError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as { code?: number; message?: string }
  const message = candidate.message ?? ''

  return (
    candidate.code === -32002 ||
    candidate.code === -32603 ||
    /resource not found|internal error/i.test(message)
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
  private connection: ClientConnection | undefined
  private connectInFlight: Promise<AcpStateSnapshot> | undefined
  private connectionGeneration = 0
  private currentSessionId: string | undefined
  private supportsSessionClose = false
  private supportsSessionResume = false
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly sessionCwds = new Map<string, string>()
  // Ephemeral background reviewer sessions (built via buildReviewerSession). They are deliberately kept
  // out of `this.sessions` — not tracked in the snapshot, not user-facing — but their tool calls still
  // trigger permission requests over the shared agent connection. This set lets the permission handler
  // recognise them and auto-approve without prompting (design §3: background review, no user interaction).
  private readonly reviewerSessionIds = new Set<string>()
  // A replaced agent's own session id -> the app-facing id it was adopted under (after a provider
  // switch), so agent-origin events/permissions relabel into the conversation the renderer tracks.
  private readonly agentToAppSessionId = new Map<string, string>()
  // Per-session artifact/notebook storage project; keeps run activation and claims in the same subtree.
  private readonly sessionProjectNames = new Map<string, string>()
  private readonly promptInFlightSessionIds = new Set<string>()
  private readonly permissionProfiles = new Map<string, SessionPermissionProfileState>()
  // A provider change requested while a prompt was running, applied when the session next goes idle.
  private pendingProviderReconnect = false
  private pendingSkillsReload = false
  private expectedProcessExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly permissionBroker: AcpPermissionBroker
  private readonly callbacks: AcpRuntimeCallbacks
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly skillsHooks: AcpRuntimeSkillsOptions | undefined
  // Bounded resume network timeout + injectable timers (defaults to real setTimeout/clearTimeout).
  private readonly resumeTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly notebookOptions: AcpRuntimeNotebookOptions | undefined
  private readonly artifactRepository: ArtifactRepository | undefined
  private readonly artifactRunRegistry: ArtifactRunRegistry | undefined
  private readonly uploadRepository: UploadRepository | undefined
  private readonly artifactSessionIds = new Map<string, string>()
  private artifactSessionSequence = 0
  private artifactRunSequence = 0
  private notebookSessionSequence = 0
  // The in-flight turn's artifact run, tracked so app-side tools (e.g. molecule preview) can attach a
  // generated file to the current run. Set while a prompt is active, cleared in the prompt's finally.
  private activeArtifactRun: { sessionId: string; run: ActiveArtifactRun } | undefined

  // Wires runtime dependencies and forwards permission prompts into the event stream.
  constructor(private readonly options: AcpRuntimeOptions) {
    this.cwd = resolve(options.defaultCwd)
    this.callbacks = options.callbacks ?? {}
    this.spawnAgent = options.spawnAgent
    this.skillsHooks = options.skills
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000
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

  // Resolves an application profile against per-session ACP capabilities and applies the real Agent
  // mode before any prompt is sent. The selected/effective projection is then shared with the UI and
  // the conservative fallback reviewer.
  private async configurePermissionProfile(
    appSessionId: string,
    session: ActiveSession,
    profile: PermissionProfileId
  ): Promise<void> {
    const application = resolvePermissionProfileApplication(profile, session.modes)

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
    await this.disconnectCurrent(false)
    this.assertCurrentConnectionGeneration(generation)

    this.cwd = resolve(request.cwd || this.options.defaultCwd)
    this.error = undefined
    this.setStatus('connecting')
    log.info('connecting agent', { cwd: this.cwd, generation })

    try {
      const agentProcess = await this.spawnAgentProcess()

      // spawnAgentProcess resolves the provider config asynchronously, so the app may have begun
      // quitting during the spawn. If shutdown() already ran, its killAgentProcess() saw no process
      // yet — kill this freshly-spawned child now and abort, or it would outlive the app as an orphan.
      if (this.shuttingDown) {
        agentProcess.kill()
        throw new Error('ACP runtime is shutting down.')
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
      this.supportsSessionClose = Boolean(initResult.agentCapabilities?.sessionCapabilities?.close)
      this.supportsSessionResume = Boolean(
        initResult.agentCapabilities?.sessionCapabilities?.resume
      )
      this.assertCurrentConnectionGeneration(generation)

      log.info('agent initialized', {
        protocolVersion: initResult.protocolVersion,
        supportsSessionClose: this.supportsSessionClose,
        supportsSessionResume: this.supportsSessionResume
      })

      this.pushEvent({
        kind: 'system',
        level: 'info',
        title: 'Agent initialized',
        text: `ACP protocol ${initResult.protocolVersion}`
      })
      this.setStatus('connected')
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        throw error
      }

      this.error = errorMessage(error)
      log.error('agent connection failed', error)
      this.pushEvent({
        kind: 'error',
        level: 'error',
        title: 'Connection failed',
        text: this.error
      })
      await this.disconnectCurrent(false)
      this.status = 'error'
      this.emitState()
      throw error
    }

    return this.getSnapshot()
  }

  // Creates a protocol session, injects artifact tooling, and uses the returned id as the app session id.
  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    const sessionCwd = resolve(request.cwd || this.cwd || this.options.defaultCwd)
    const projectName = this.normalizeProjectName(request.projectName)
    const connection = await this.ensureConnected(sessionCwd)
    const artifactSessionId = this.createArtifactSessionId()
    const notebookSessionId = this.createNotebookSessionId()

    const session = await connection.agent
      .buildSession({
        cwd: sessionCwd,
        mcpServers: await this.createMcpServers({
          artifactSessionId,
          notebookSessionId,
          sessionCwd,
          projectName
        }),
        ...this.createSessionMeta()
      })
      .start()

    try {
      await this.configurePermissionProfile(
        session.sessionId,
        session,
        normalizePermissionProfile(request.permissionProfile)
      )
    } catch (error) {
      session.dispose()
      throw error
    }

    this.sessions.set(session.sessionId, session)
    this.sessionCwds.set(session.sessionId, sessionCwd)
    this.sessionProjectNames.set(session.sessionId, projectName)
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

    return { sessionId: session.sessionId, cwd: sessionCwd }
  }

  // Registers a freshly-built agent session under an app-facing id (used when adopting a conversation
  // onto a replaced agent after a provider switch). Remaps the agent's own id so later updates and
  // permission requests relabel into the same conversation.
  private adoptSession(
    appSessionId: string,
    session: ActiveSession,
    cwd: string,
    projectName: string
  ): void {
    this.sessions.set(appSessionId, session)

    if (session.sessionId !== appSessionId) {
      this.agentToAppSessionId.set(session.sessionId, appSessionId)
    }

    this.sessionCwds.set(appSessionId, cwd)
    this.sessionProjectNames.set(appSessionId, projectName)
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

      return { sessionId: request.sessionId, cwd: sessionCwd }
    }

    // The reconnect + session/resume handshake spawns a fresh agent and is network-bound, so it is
    // wrapped in a bounded timeout that tears down the half-open connection if the agent stalls.
    return this.resumeSessionWithTimeout(request, sessionCwd, projectName)
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
    // Resume is optional in ACP, so fail early when the agent did not advertise it.
    if (!this.supportsSessionResume) {
      throw new Error('ACP agent does not support session resume.')
    }

    // Resumed sessions already have stable ids, so the artifact session mirrors the runtime session id.
    let resumeResponse
    try {
      resumeResponse = await connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: request.sessionId,
        cwd: sessionCwd,
        mcpServers: await this.createMcpServers({
          artifactSessionId: request.sessionId,
          notebookSessionId: request.sessionId,
          sessionCwd,
          projectName
        }),
        ...this.createSessionMeta()
      })
    } catch (error) {
      if (!isUnresumableSessionError(error)) throw error

      // The agent could not resume this session (it was replaced by a provider switch, or an app
      // restart spawned a fresh agent process that no longer holds it — surfacing as -32002 not-found
      // or a generic -32603 Internal error). Rather than dead-end the thread, adopt a brand-new agent
      // session under the SAME app id so the user can keep chatting — earlier turns stay visible; only
      // agent-side context resets, which is expected after a restart or model switch.
      log.info('resumed session adopted after unrecoverable resume error', {
        sessionId: request.sessionId,
        reason: error instanceof Error ? error.message : String(error)
      })

      const adopted = await connection.agent
        .buildSession({
          cwd: sessionCwd,
          mcpServers: await this.createMcpServers({
            artifactSessionId: request.sessionId,
            notebookSessionId: request.sessionId,
            sessionCwd,
            projectName
          }),
          ...this.createSessionMeta()
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

      this.adoptSession(request.sessionId, adopted, sessionCwd, projectName)
      this.emitState()

      return { sessionId: request.sessionId, cwd: sessionCwd }
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

    this.sessions.set(request.sessionId, session)
    this.sessionCwds.set(request.sessionId, sessionCwd)
    this.sessionProjectNames.set(request.sessionId, projectName)
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

    return { sessionId: request.sessionId, cwd: sessionCwd }
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
    this.permissionBroker.cancelAll()
    this.promptInFlightSessionIds.clear()

    for (const session of this.sessions.values()) {
      session.dispose()
    }

    this.sessions.clear()
    this.sessionCwds.clear()
    this.sessionProjectNames.clear()
    this.permissionProfiles.clear()
    this.artifactSessionIds.clear()
    this.agentToAppSessionId.clear()
    this.currentSessionId = undefined
    this.supportsSessionClose = false
    this.supportsSessionResume = false
    this.connection?.close()
    this.connection = undefined

    this.killAgentProcess()

    if (emitClosedStatus) {
      this.setStatus('closed')
    }

    return this.getSnapshot()
  }

  // Signals the current agent child to exit and marks the exit expected so the stderr/error/exit
  // handlers stay quiet. Shared by the async disconnect teardown and the synchronous quit shutdown.
  private killAgentProcess(): void {
    if (this.agentProcess) {
      this.expectedProcessExits.add(this.agentProcess)

      if (!this.agentProcess.killed) {
        this.agentProcess.kill()
      }
    }

    this.agentProcess = undefined
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
  // current active-provider spawn config so each reconnect uses up-to-date credentials.
  private async spawnAgentProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.spawnAgent) {
      return this.spawnAgent()
    }

    const config = this.options.resolveSpawnConfig
      ? await this.options.resolveSpawnConfig()
      : undefined

    if (!config) {
      throw new Error('ACP agent spawn configuration is not available.')
    }

    return spawnClaudeAgentAcp(config)
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
        await this.resumeSession({
          sessionId: request.sessionId,
          cwd: sessionCwd,
          projectName,
          permissionProfile
        })

        const reloaded = this.sessions.get(request.sessionId)
        if (!reloaded) {
          throw new Error(`ACP session not found after force-load: ${request.sessionId}`)
        }
        activeSession = reloaded
      }
    }

    this.currentSessionId = request.sessionId
    this.promptInFlightSessionIds.add(request.sessionId)
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
      this.activeArtifactRun = artifactRun
        ? { sessionId: request.sessionId, run: artifactRun }
        : undefined
      // Prepend a short steering nudge naming the picked skills. It goes only into the content sent to
      // the agent; the user-facing message event keeps the original text (which already shows /Name).
      const promptText = await this.applySkillNudge(request.text, forced)
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

        log.debug('session update', { sessionId: request.sessionId })
        // Route the update under the app-facing id so a session adopted onto a new agent (after a
        // provider switch) still streams into the same conversation the renderer is watching.
        this.handleSessionUpdate(message.notification, request.sessionId)
      }
    } catch (error) {
      log.error('prompt failed', { sessionId: request.sessionId, error })
      this.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId: request.sessionId,
        title: 'Prompt failed',
        text: errorMessage(error)
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
            error
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
      this.activeArtifactRun = undefined
      this.promptInFlightSessionIds.delete(request.sessionId)
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
      await this.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: activeSession.sessionId
      })
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
      if (this.connection && this.supportsSessionClose) {
        await this.connection.agent.request(acp.methods.agent.session.close, {
          sessionId: request.sessionId
        })
      } else {
        await this.connection?.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: request.sessionId
        })
      }

      session.dispose()
      this.permissionBroker.cancelForSession(request.sessionId)
      this.sessions.delete(request.sessionId)
      this.sessionCwds.delete(request.sessionId)
      this.sessionProjectNames.delete(request.sessionId)
      this.permissionProfiles.delete(request.sessionId)
      this.artifactSessionIds.delete(request.sessionId)
      this.promptInFlightSessionIds.delete(request.sessionId)
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
    const attachments = request.attachments ?? []
    const referencedArtifacts = request.referencedArtifacts ?? []

    if (attachments.length === 0 && referencedArtifacts.length === 0) return request.text

    const contentBlocks: ContentBlock[] = request.text.trim()
      ? [{ type: 'text', text: request.text }]
      : []

    // Staged uploads own the durable session id here, so finalize before turning them into blocks.
    if (attachments.length > 0) {
      if (!this.uploadRepository) throw new Error('Upload storage is not configured.')

      const finalizedAttachments = await this.uploadRepository.finalizePendingSessionUploads(
        sessionId,
        attachments
      )

      // Keep the user's text first, then append files in the same order they were added.
      for (const attachment of finalizedAttachments) {
        contentBlocks.push(await this.createAttachmentContentBlock(attachment))
      }
    }

    // `@`-mentioned artifacts reuse the same per-type block builder as uploads, in mention order.
    for (const reference of referencedArtifacts) {
      contentBlocks.push(await this.createReferencedArtifactContentBlock(reference))
    }

    return contentBlocks
  }

  // Converts one managed upload into the richest ACP content block that is safe for its type.
  private async createAttachmentContentBlock(
    attachment: UploadedAttachment
  ): Promise<ContentBlock> {
    if (!this.uploadRepository) throw new Error('Upload storage is not configured.')

    const filePath = await this.uploadRepository.resolveManagedUploadPath({ path: attachment.path })

    return this.buildFileContentBlock({
      absolutePath: filePath,
      uri: pathToFileURL(filePath).href,
      name: attachment.originalName || attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size
    })
  }

  // Converts one `@`-mentioned artifact into the same content block an equivalent upload produces.
  private async createReferencedArtifactContentBlock(
    reference: ArtifactReference
  ): Promise<ContentBlock> {
    const filePath = await this.resolveReferencedArtifactPath(reference)
    const { size } = await stat(filePath)

    return this.buildFileContentBlock({
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
    absolutePath: string
    uri: string
    name: string
    mimeType?: string
    size: number
  }): Promise<ContentBlock> {
    const { absolutePath, uri, name, mimeType, size } = descriptor

    // Images are embedded as base64 so vision-capable agents receive the actual pixels.
    // Large images are downscaled/re-encoded first so one file cannot overflow the request.
    if (mimeType?.startsWith('image/')) {
      const { data, mimeType: outMimeType } = await buildImageContentData(
        absolutePath,
        mimeType,
        size
      )

      return { type: 'image', data, mimeType: outMimeType, uri }
    }

    // PDFs are never inlined as base64 (a 20MB file overflows the 32MB request limit); instead we
    // extract selectable text so the model reads readable content. Page images are a future option.
    if (this.isPdfFile(name, mimeType)) {
      return this.createPdfContentBlock(name, absolutePath, uri)
    }

    // Small text-like files are embedded for direct reading; oversized text falls through to a link.
    if (
      (mimeType?.startsWith('text/') || mimeType === 'application/json') &&
      size <= MAX_EMBEDDED_TEXT_UPLOAD_BYTES
    ) {
      return {
        type: 'resource',
        resource: {
          uri,
          mimeType,
          text: await readFile(absolutePath, 'utf8')
        }
      }
    }

    // Binary and large files are passed as resource links so agents can decide how to fetch them.
    return {
      type: 'resource_link',
      uri,
      name,
      title: name,
      mimeType,
      size
    }
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

    await this.connect({ cwd })

    if (!this.connection) {
      throw new Error('ACP connection failed')
    }

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

  // App-owned directories the agent's Read tool must never read: the CLAUDE_CONFIG_DIR holds the
  // materialized skill files, whose (bundled/MCP) contents must not be surfaced into the conversation.
  private protectedReadRoots(): string[] {
    return this.artifactOptions ? [getAppClaudeConfigDir(this.artifactOptions.configRoot)] : []
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

  // Provides the agent with exactly one artifact MCP server scoped to this session's storage context.
  private createArtifactMcpServers(
    artifactSessionId: string,
    notebookSessionId: string,
    sessionCwd: string,
    projectName: string
  ): McpServer[] {
    if (!this.artifactOptions || !artifactSessionId) return []

    const allowedImportRoots = [
      sessionCwd,
      ...(this.notebookOptions && notebookSessionId
        ? [getNotebookSessionRoot(this.artifactOptions.dataRoot, projectName, notebookSessionId)]
        : [])
    ]

    return [
      createArtifactMcpServerConfig({
        command: this.artifactOptions.mcpCommand ?? process.execPath,
        entryPath: this.artifactOptions.mcpEntryPath,
        storageRoot: this.artifactOptions.dataRoot,
        projectName,
        sessionId: artifactSessionId,
        currentRunFile: this.getArtifactCurrentRunFile(artifactSessionId, projectName),
        allowedImportRoots
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
    if (!this.notebookOptions || !notebookSessionId || notebookSessionId === sessionId) return

    this.notebookOptions.registerSessionAlias?.(notebookSessionId, sessionId)
  }

  // Provides the agent with a notebook MCP server scoped to this session's runtime route.
  private async createNotebookMcpServers(
    notebookSessionId: string,
    sessionCwd: string,
    projectName: string
  ): Promise<McpServer[]> {
    if (!this.notebookOptions || !notebookSessionId) return []

    const connection = await this.resolveNotebookRpcConnection()

    return [
      createNotebookMcpServerConfig({
        command: this.notebookOptions.mcpCommand ?? process.execPath,
        entryPath: this.notebookOptions.mcpEntryPath,
        endpoint: connection.endpoint,
        token: connection.token,
        projectName,
        sessionId: notebookSessionId,
        workspaceCwd: sessionCwd
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
    const servers = [
      ...this.createArtifactMcpServers(
        artifactSessionId,
        notebookSessionId,
        sessionCwd,
        projectName
      ),
      ...(await this.createNotebookMcpServers(notebookSessionId, sessionCwd, projectName))
    ]

    // Log the MCP server launch specs (command + args, no secrets) — a bad command/entry path in a
    // packaged build can make the agent stall while it waits on an MCP server that never starts.
    log.info('session MCP servers', {
      count: servers.length,
      servers: servers.map((server) => {
        const record = server as { name?: string; command?: string; args?: unknown }
        return { name: record.name, command: record.command, args: record.args }
      })
    })

    return servers
  }

  // Builds Claude-specific session metadata: system-prompt guidance for artifact/notebook tooling, plus
  // a settingSources restriction to the "user" scope (our app-owned CLAUDE_CONFIG_DIR). This is required:
  // the "project"/"local" scopes are read from the workspace cwd's `.claude`, and when the cwd is under
  // the home tree that resolves to the user's own ~/.claude — whose `env` block (e.g. a proxy
  // ANTHROPIC_BASE_URL) would otherwise override the active provider's endpoint. Restricting to "user"
  // loads only the clean app dir's settings + the app's own skills/plugins/commands.
  private createSessionMeta(): { _meta: Record<string, unknown> } {
    const appendSections = [
      // The skill-privacy guardrail always applies — skills are materialized whenever the app runs.
      SKILLS_READ_GUARD_SYSTEM_PROMPT_APPEND,
      ...(this.artifactOptions ? [ARTIFACT_FILE_SYSTEM_PROMPT_APPEND] : []),
      ...(this.notebookOptions ? [NOTEBOOK_SYSTEM_PROMPT_APPEND] : [])
    ]

    const meta: Record<string, unknown> = {
      claudeCode: { options: { settingSources: ['user'] } }
    }

    if (appendSections.length > 0) {
      meta.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: appendSections.join('\n\n')
      }
    }

    return { _meta: meta }
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
    const currentRunFile = this.getArtifactCurrentRunFile(
      artifactSessionId,
      this.resolveSessionProjectName(sessionId)
    )
    const artifactRun = {
      runId: `artifact-run-${Date.now()}-${this.artifactRunSequence}`,
      artifactSessionId,
      currentRunFile
    }

    await mkdir(dirname(currentRunFile), { recursive: true })
    await writeFile(currentRunFile, `${JSON.stringify({ runId: artifactRun.runId })}\n`, 'utf8')

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
  async writeArtifactForCurrentRun(input: {
    filename: string
    content: string
    mimeType?: string
  }): Promise<ArtifactFile> {
    const active = this.activeArtifactRun
    if (!active || !this.artifactRepository) {
      throw new Error('No active assistant turn to attach a generated file to.')
    }

    return this.artifactRepository.writePendingFile({
      projectName: this.resolveSessionProjectName(active.sessionId),
      sessionId: active.run.artifactSessionId,
      runId: active.run.runId,
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
    // originated elsewhere. Debug level keeps it out of normal runs. Log the tool identity (name/kind),
    // never the title — a WebFetch title is the full URL with query params (user data).
    log.debug('permission request received', {
      tool: extractProviderToolName(params.toolCall) ?? params.toolCall?.kind,
      toolCallId: params.toolCall?.toolCallId,
      sessionId: params.sessionId,
      optionCount: params.options?.length
    })

    try {
      // Background reviewer sessions run unattended with a restricted toolset: auto-approve their tool
      // calls instead of routing to the renderer (which never sees these sessions) or throwing "Unknown
      // ACP session" because they are intentionally not in `this.sessions`. See design §3.
      if (this.reviewerSessionIds.has(params.sessionId)) {
        return this.autoApproveReviewerPermission(params)
      }

      const appSessionId = this.agentToAppSessionId.get(params.sessionId) ?? params.sessionId

      if (!this.sessions.has(appSessionId)) {
        throw new Error(`Unknown ACP session: ${appSessionId}`)
      }

      const profileState = this.permissionProfiles.get(appSessionId)

      return await this.permissionBroker.requestPermission(
        appSessionId === params.sessionId ? params : { ...params, sessionId: appSessionId },
        {
          profile: profileState?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          autoReviewStrategy: profileState?.autoReviewStrategy,
          cwd: this.sessionCwds.get(appSessionId)
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

  // Selects an allow option for an unattended reviewer tool call. Prefers a one-shot allow (the reviewer
  // session is ephemeral, so remembering an "always" grant is pointless) and falls back to allow_always,
  // then the first option. A request with no allow option is cancelled rather than left hanging.
  private autoApproveReviewerPermission(
    params: RequestPermissionRequest
  ): RequestPermissionResponse {
    const allowOption =
      params.options.find((option) => option.kind === 'allow_once') ??
      params.options.find((option) => option.kind === 'allow_always') ??
      params.options[0]

    if (!allowOption) {
      log.warn('reviewer permission request had no allow option; cancelling', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId
      })
      return { outcome: { outcome: 'cancelled' } }
    }

    log.debug('auto-approving reviewer tool call', {
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
    agentProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim()

      // Always capture agent stderr in the log — it's the primary clue when a turn stalls or the
      // agent misbehaves (auth loops, MCP connection failures, tool errors) in a packaged build.
      if (text) log.warn('agent stderr', { text })

      if (this.expectedProcessExits.has(agentProcess)) {
        return
      }

      if (text) {
        this.pushEvent({
          kind: 'system',
          level: 'warning',
          title: 'claude-agent-acp',
          text
        })
      }
    })

    agentProcess.on('error', (error) => {
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
    this.permissionBroker.cancelAll()
    this.sessions.clear()
    this.sessionCwds.clear()
    this.sessionProjectNames.clear()
    this.artifactSessionIds.clear()
    this.agentToAppSessionId.clear()
    this.currentSessionId = undefined
    this.supportsSessionClose = false
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
    const runtimeEvent: AcpRuntimeEvent = {
      id: event.id ?? this.nextEventId(),
      timestamp: event.timestamp ?? Date.now(),
      level: event.level ?? 'info',
      kind: event.kind,
      sessionId: event.sessionId,
      messageId: event.messageId,
      role: event.role,
      text: event.text,
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
      raw: event.raw
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

  // Creates an ephemeral reviewer ACP session using the existing agent connection. The reviewer
  // session is isolated from main agent sessions: it is not tracked in this.sessions, does not
  // appear in the snapshot, and callers are responsible for disposing it. This allows background
  // review to run in parallel with the main session without affecting the main state machine.
  async buildReviewerSession(request: {
    cwd: string
    mcpServers: McpServer[]
    systemPromptAppend?: string
  }): Promise<import('@agentclientprotocol/sdk').ActiveSession> {
    const connection = await this.ensureConnected(request.cwd)

    const meta: Record<string, unknown> = {
      claudeCode: { options: { settingSources: ['user'] } }
    }

    if (request.systemPromptAppend) {
      meta.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: request.systemPromptAppend
      }
    }

    const session = await connection.agent
      .buildSession({
        cwd: request.cwd,
        mcpServers: request.mcpServers,
        _meta: meta
      })
      .start()

    // Register so the permission handler recognises this session and auto-approves its tool calls.
    // The orchestrator must call disposeReviewerSession() to unregister and tear it down.
    this.reviewerSessionIds.add(session.sessionId)

    return session
  }

  // Disposes an ephemeral reviewer session and unregisters it from the auto-approve set. Safe to call
  // even if the session was never registered (e.g. it failed before start).
  disposeReviewerSession(session: import('@agentclientprotocol/sdk').ActiveSession): void {
    this.reviewerSessionIds.delete(session.sessionId)
    session.dispose()
  }
}

export { AcpRuntime }
