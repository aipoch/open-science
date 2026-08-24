import * as acp from '@agentclientprotocol/sdk'
import type {
  AuthenticateRequest,
  ClientConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SetProviderRequest,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import type { AgentFramework, ResolvedAgentBackend } from '../agent-framework'
import { terminateProcessTree } from '../process-tree'
import type {
  AcpBackendGenerationAttempt,
  AcpBackendGenerationView
} from './backend-generation-owner'
import type { AcpConnectionResourceAttempt } from './connection-resource-owner'
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'

type ResponsesBridgeLease = ResolvedAgentBackend['responsesBridgeLease']
type AnthropicBridgeLease = ResolvedAgentBackend['anthropicBridgeLease']
type ProviderTransportLease = ResolvedAgentBackend['providerTransportLease']
type CandidateCleanupStage =
  | 'connection'
  | 'agent-process'
  | 'bridge-lease'
  | 'anthropic-bridge-lease'
  | 'provider-transport-lease'
type AcpProcessEventContext = Readonly<{
  process: ChildProcessWithoutNullStreams
  framework: AgentFramework['id']
  epoch: number
}>
type AcpProcessExitContext = AcpProcessEventContext &
  Readonly<{
    pid: number | undefined
  }>

type AcpAgentConnectionHooks = Readonly<{
  createElicitation: (
    request: CreateElicitationRequest
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>
  requestPermission: (
    request: RequestPermissionRequest
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>
  observeSessionUpdate: (notification: SessionNotification) => void
  observeClaudeSdkMessage: (message: Record<string, unknown>) => void
  filesystem: Readonly<{
    resolveSessionCwd: (sessionId: string) => string
    protectedReadRoots: () => readonly string[]
  }>
  onBackendResolved: (framework: AgentFramework['id']) => void
  onProcessSpawned: (framework: AgentFramework['id']) => void
  onBackendPublished: (backend: AcpBackendGenerationView) => void
  onProcessTreeReaped: (reaped: boolean) => void
  markProcessExitExpected: (process: ChildProcessWithoutNullStreams, epoch: number) => void
  onProcessStderr: (text: string, context: AcpProcessEventContext) => void
  onProcessError: (error: unknown, context: AcpProcessEventContext) => void
  onProcessExit: (
    code: number | null,
    signal: NodeJS.Signals | null,
    context: AcpProcessExitContext
  ) => void
  onConnectionClosed: () => void
  reportCleanupFailure: (
    stage: CandidateCleanupStage,
    error: unknown,
    framework: AgentFramework['id'],
    epoch: number
  ) => void
  reportProcessTreeError: (message: string, error?: unknown) => void
}>

type AcpAgentConnectionCandidateInput = Readonly<{
  epoch: number
  resolveBackend: () => Promise<ResolvedAgentBackend>
  prepareBackend: (backend: ResolvedAgentBackend) => AcpBackendGenerationAttempt
  isCurrent: () => boolean
  isShuttingDown: () => boolean
  spawnAgent?: () => ChildProcessWithoutNullStreams
}>

type AcpTransferredAgentConnection = Readonly<{
  backendAttempt: AcpBackendGenerationAttempt
  initialize: (request: InitializeRequest) => Promise<InitializeResponse>
  authenticate: (request: AuthenticateRequest) => Promise<void>
  listProviders: () => Promise<ListProvidersResponse>
  setProvider: (request: SetProviderRequest) => Promise<void>
}>

type AcpAgentConnectionCandidate = Readonly<{
  transferTo: (attempt: AcpConnectionResourceAttempt) => AcpTransferredAgentConnection
  dispose: () => Promise<void>
}>

// Owns one spawned provider process, ACP client/stream, and bridge lease until their single transfer
// to the existing resource owner. Runtime supplies policy/projection hooks but never receives those
// provisional physical resources.
class AcpAgentConnectionAdapter {
  async open(
    input: AcpAgentConnectionCandidateInput,
    hooks: AcpAgentConnectionHooks
  ): Promise<AcpAgentConnectionCandidate> {
    let process: ChildProcessWithoutNullStreams | undefined
    let connection: ReturnType<AcpAgentConnectionAdapter['createClientConnection']> | undefined
    let bridgeLease: ResponsesBridgeLease
    let anthropicBridgeLease: AnthropicBridgeLease
    let providerTransportLease: ProviderTransportLease
    let backendAttempt: AcpBackendGenerationAttempt | undefined
    let framework: AgentFramework['id'] = 'claude-code'

    const reportCleanupFailure = (stage: CandidateCleanupStage, error: unknown): void => {
      try {
        hooks.reportCleanupFailure(stage, error, framework, input.epoch)
      } catch {
        // Cleanup and the original failure take precedence over diagnostic sinks.
      }
    }
    const cleanup = async (): Promise<void> => {
      try {
        connection?.close()
      } catch (error) {
        reportCleanupFailure('connection', error)
      }
      if (process) {
        hooks.markProcessExitExpected(process, input.epoch)
        try {
          const result = await terminateProcessTree(process, undefined, {
            error: (message, error) => hooks.reportProcessTreeError(message, error)
          })
          hooks.onProcessTreeReaped(result.reaped)
        } catch (error) {
          reportCleanupFailure('agent-process', error)
        }
      }
      if (bridgeLease) {
        try {
          await bridgeLease.release()
        } catch (error) {
          reportCleanupFailure('bridge-lease', error)
        }
      }
      if (anthropicBridgeLease) {
        try {
          await anthropicBridgeLease.release()
        } catch (error) {
          reportCleanupFailure('anthropic-bridge-lease', error)
        }
      }
      if (providerTransportLease) {
        try {
          await providerTransportLease.release()
        } catch (error) {
          reportCleanupFailure('provider-transport-lease', error)
        }
      }
    }

    try {
      const backend = await input.resolveBackend()
      framework = backend.framework.id
      bridgeLease = backend.responsesBridgeLease
      anthropicBridgeLease = backend.anthropicBridgeLease
      providerTransportLease = backend.providerTransportLease
      backendAttempt = input.prepareBackend(backend)
      hooks.onBackendResolved(framework)
      process = input.spawnAgent
        ? input.spawnAgent()
        : backend.framework.spawn({
            executablePath: backend.executablePath,
            env: backend.env,
            args: backend.args ?? [],
            proxyEnvironmentMode: backend.proxyEnvironmentMode
          })
      hooks.onProcessSpawned(framework)
      if (input.isShuttingDown() || !input.isCurrent()) {
        throw new Error(
          input.isShuttingDown()
            ? 'ACP runtime is shutting down.'
            : 'ACP connection superseded during spawn.'
        )
      }
      if (!process) throw new Error('ACP agent process did not spawn.')
      const spawnedProcess = process
      hooks.onBackendPublished(backendAttempt.publish())
      spawnedProcess.stderr.on('data', (data: Buffer) => {
        hooks.onProcessStderr(data.toString('utf8').trim(), {
          process: spawnedProcess,
          framework,
          epoch: input.epoch
        })
      })
      spawnedProcess.on('error', (error) => {
        hooks.onProcessError(error, {
          process: spawnedProcess,
          framework,
          epoch: input.epoch
        })
      })
      spawnedProcess.on('exit', (code, signal) => {
        hooks.onProcessExit(code, signal, {
          process: spawnedProcess,
          framework,
          epoch: input.epoch,
          pid: spawnedProcess.pid
        })
      })
      connection = this.createClientConnection(spawnedProcess, hooks)
    } catch (error) {
      backendAttempt?.fail()
      await cleanup()
      throw error
    }

    const openedProcess = process
    const openedConnection = connection
    const openedAttempt = backendAttempt
    if (!openedProcess || !openedConnection || !openedAttempt) {
      throw new Error('ACP agent connection candidate did not open.')
    }
    let state: 'open' | 'transferred' | 'disposed' = 'open'

    return Object.freeze({
      transferTo: (attempt) => {
        if (state === 'disposed') throw new Error('ACP agent connection candidate is disposed.')
        if (state === 'transferred') {
          throw new Error('ACP agent connection candidate was already transferred.')
        }
        if (attempt.epoch !== input.epoch) throw new Error('ACP connection was superseded.')
        attempt.attach({
          process: openedProcess,
          connection: openedConnection,
          framework,
          bridgeLease,
          anthropicBridgeLease,
          providerTransportLease
        })
        state = 'transferred'
        openedConnection.closed.then(() => {
          if (attempt.owns(openedConnection)) hooks.onConnectionClosed()
        })
        return Object.freeze({
          backendAttempt: openedAttempt,
          initialize: (request) =>
            openedConnection.agent.request(acp.methods.agent.initialize, request),
          authenticate: async (request) => {
            await openedConnection.agent.request(acp.methods.agent.authenticate, request)
          },
          listProviders: () => openedConnection.agent.request(acp.methods.agent.providers.list, {}),
          setProvider: async (request) => {
            await openedConnection.agent.request(acp.methods.agent.providers.set, request)
          }
        })
      },
      dispose: async () => {
        if (state !== 'open') return
        state = 'disposed'
        openedAttempt.fail()
        await cleanup()
      }
    })
  }

  private createClientConnection(
    process: ChildProcessWithoutNullStreams,
    hooks: AcpAgentConnectionHooks
  ): ClientConnection {
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>
    )

    return acp
      .client({ name: 'open-science' })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        hooks.requestPermission(context.params)
      )
      .onRequest(acp.methods.client.elicitation.create, (context) =>
        hooks.createElicitation(context.params)
      )
      .onNotification(acp.methods.client.session.update, (context) =>
        hooks.observeSessionUpdate(context.params)
      )
      .onNotification(
        '_claude/sdkMessage',
        (params) => params as Record<string, unknown>,
        (context) => hooks.observeClaudeSdkMessage(context.params)
      )
      .onRequest(acp.methods.client.fs.readTextFile, (context) =>
        readWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params,
          [...hooks.filesystem.protectedReadRoots()]
        )
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (context) =>
        writeWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params
        )
      )
      .connect(stream)
  }
}

export { AcpAgentConnectionAdapter }
export type { AcpAgentConnectionCandidate, AcpAgentConnectionHooks }
