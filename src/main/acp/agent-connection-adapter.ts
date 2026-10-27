import { bindMainAgentConnection, spawnMainAgentProcess } from './main-agent-process-ownership'
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
import { StringDecoder } from 'node:string_decoder'

import type { AgentFramework, AgentProcessSpawner, ResolvedAgentBackend } from '../agent-framework'
import {
  startOpenCodeService,
  OpenCodeServiceCleanupError,
  type OpenCodeServiceLease
} from './opencode-service'
import { acquireOpenCodeStore, type OpenCodeStoreLease } from './opencode-store'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { onProcessTreeReaped, terminateProcessTree } from '../process-tree'
import type {
  AcpBackendGenerationAttempt,
  AcpBackendGenerationView
} from './backend-generation-owner'
import type { AcpConnectionResourceAttempt } from './connection-resource-owner'
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'

type ResponsesTransportLease = ResolvedAgentBackend['responsesTransportLease']
type MessagesBridgeLease = ResolvedAgentBackend['messagesBridgeLease']
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
    listGrantedRoots?: () => Promise<readonly Pick<GrantedLocalRoot, 'path' | 'access'>[]>
  }>
  onBackendResolved: (framework: AgentFramework['id']) => void
  onProcessSpawned: (framework: AgentFramework['id']) => void
  onBackendPublished: (backend: AcpBackendGenerationView) => void
  onProcessTreeReaped: (reaped: boolean) => void
  markProcessExitExpected: (process: ChildProcessWithoutNullStreams, epoch: number) => void
  onProcessStderr: (text: string, context: AcpProcessEventContext) => void
  onProcessStderrEnd?: (context: AcpProcessEventContext) => void
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
  spawnProcess?: AgentProcessSpawner
  registerOpenCodeStoreRelease?: (release: () => void) => void
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
    let bridgeLease: ResponsesTransportLease
    let messagesBridgeLease: MessagesBridgeLease
    let providerTransportLease: ProviderTransportLease
    let openCodeService: OpenCodeServiceLease | undefined
    let openCodeStore: OpenCodeStoreLease | undefined
    let backendAttempt: AcpBackendGenerationAttempt | undefined
    let cleanupUnconfirmed = false
    let framework: AgentFramework['id'] = 'claude-code'
    let opening = true
    let storeWriters = 0
    const releaseRecoveredStore = (): void => {
      if (!opening && storeWriters === 0) openCodeStore?.release()
    }
    const retainStoreWriter = (): (() => void) | undefined => {
      if (!openCodeStore) return undefined
      storeWriters++
      return () => {
        storeWriters--
        releaseRecoveredStore()
      }
    }

    const reportCleanupFailure = (stage: CandidateCleanupStage, error: unknown): void => {
      try {
        hooks.reportCleanupFailure(stage, error, framework, input.epoch)
      } catch {
        // Cleanup and the original failure take precedence over diagnostic sinks.
      }
    }
    const cleanup = async (): Promise<void> => {
      let reaped = !cleanupUnconfirmed
      if (!reaped) hooks.onProcessTreeReaped(false)
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
          reaped = reaped && result.reaped
          hooks.onProcessTreeReaped(result.reaped)
        } catch (error) {
          reaped = false
          hooks.onProcessTreeReaped(false)
          reportCleanupFailure('agent-process', error)
        }
      }
      if (openCodeService) {
        try {
          const result = await openCodeService.release()
          reaped = reaped && result.reaped
          hooks.onProcessTreeReaped(result.reaped)
        } catch (error) {
          reaped = false
          hooks.onProcessTreeReaped(false)
          reportCleanupFailure('agent-process', error)
        }
      }
      if (reaped) openCodeStore?.release()
      if (bridgeLease) {
        try {
          await bridgeLease.release()
        } catch (error) {
          reportCleanupFailure('bridge-lease', error)
        }
      }
      if (messagesBridgeLease) {
        try {
          await messagesBridgeLease.release()
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
      let backend = await input.resolveBackend()
      framework = backend.framework.id
      bridgeLease = backend.responsesTransportLease
      messagesBridgeLease = backend.messagesBridgeLease
      providerTransportLease = backend.providerTransportLease
      if (backend.framework.id === 'opencode' && backend.opencodeMajorVersion) {
        openCodeStore = await acquireOpenCodeStore(
          backend.env.XDG_DATA_HOME,
          backend.opencodeMajorVersion
        )
        input.registerOpenCodeStoreRelease?.(openCodeStore.release)
      }
      let serviceExited = false
      if (backend.framework.id === 'opencode' && backend.opencodeMajorVersion === 2) {
        const service = await startOpenCodeService(
          backend,
          () => {
            serviceExited = true
            if (process && input.isCurrent()) {
              process.emit('error', new Error('OpenCode HTTP service exited unexpectedly.'))
              process.kill()
            }
          },
          input.spawnProcess,
          retainStoreWriter()
        )
        openCodeService = service
        backend = { ...backend, opencodeUsageApi: service.api }
      }
      if (input.isShuttingDown()) throw new Error('ACP runtime is shutting down.')
      if (!input.isCurrent()) throw new Error('ACP connection superseded during preparation.')
      if (serviceExited) throw new Error('OpenCode HTTP service exited during preparation.')
      backendAttempt = input.prepareBackend(backend)
      hooks.onBackendResolved(framework)
      if (serviceExited) throw new Error('OpenCode HTTP service exited during preparation.')
      const writerReaped = retainStoreWriter()
      const trackWriter = (
        child: ChildProcessWithoutNullStreams
      ): ChildProcessWithoutNullStreams => {
        if (writerReaped) onProcessTreeReaped(child, writerReaped)
        return child
      }
      let spawnAttempted = Boolean(input.spawnAgent)
      try {
        process = input.spawnAgent
          ? trackWriter(input.spawnAgent())
          : await spawnMainAgentProcess(framework, (spawnProcess) => {
              spawnAttempted = !spawnProcess
              return trackWriter(
                backend.framework.spawn({
                  executablePath: backend.executablePath,
                  env: backend.env,
                  args: backend.args ?? [],
                  proxyEnvironmentMode: backend.proxyEnvironmentMode,
                  spawnProcess: spawnProcess
                    ? (...args) => {
                        spawnAttempted = true
                        return spawnProcess(...args)
                      }
                    : undefined
                })
              )
            })
      } catch (error) {
        // A native spawn can throw after recording a starting receipt; only cancel before admission.
        if (!spawnAttempted) writerReaped?.()
        else cleanupUnconfirmed = true
        throw error
      }
      hooks.onProcessSpawned(framework)
      if (serviceExited) throw new Error('OpenCode HTTP service exited during spawn.')
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
      const stderrDecoder = new StringDecoder('utf8')
      const stderrContext = { process: spawnedProcess, framework, epoch: input.epoch }
      let stderrEnded = false
      spawnedProcess.stderr.on('data', (data: Buffer) => {
        if (!stderrEnded) hooks.onProcessStderr(stderrDecoder.write(data), stderrContext)
      })
      const finishStderr = (): void => {
        if (stderrEnded) return
        stderrEnded = true
        const tail = stderrDecoder.end()
        if (tail) hooks.onProcessStderr(tail, stderrContext)
        hooks.onProcessStderrEnd?.(stderrContext)
      }
      spawnedProcess.stderr.once('end', finishStderr)
      spawnedProcess.stderr.once('close', finishStderr)
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
      bindMainAgentConnection(connection, spawnedProcess)
    } catch (error) {
      if (error instanceof OpenCodeServiceCleanupError) cleanupUnconfirmed = true
      backendAttempt?.fail()
      await cleanup()
      throw error
    } finally {
      // Recovery may settle after this candidate has transferred or failed startup.
      opening = false
      releaseRecoveredStore()
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
          messagesBridgeLease,
          providerTransportLease,
          openCodeService,
          openCodeStore
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
      .onRequest(acp.methods.client.fs.readTextFile, async (context) =>
        readWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params,
          [...hooks.filesystem.protectedReadRoots()],
          (await hooks.filesystem.listGrantedRoots?.()) ?? []
        )
      )
      .onRequest(acp.methods.client.fs.writeTextFile, async (context) =>
        writeWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params,
          (await hooks.filesystem.listGrantedRoots?.()) ?? []
        )
      )
      .connect(stream)
  }
}

export { AcpAgentConnectionAdapter }
export type { AcpAgentConnectionCandidate, AcpAgentConnectionHooks }
