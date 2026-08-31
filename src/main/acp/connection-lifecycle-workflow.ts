import * as acp from '@agentclientprotocol/sdk'
import type { ClientConnection, SetProviderRequest } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'

import type { AcpConnectRequest, AcpRuntimeEventInput, AcpStateSnapshot } from '../../shared/acp'
import type { AgentFramework, AgentProviderConfiguration } from '../agent-framework'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { AcpAgentConnectionCandidate } from './agent-connection-adapter'
import type {
  AcpConnectionResourceAttempt,
  AcpConnectionResourceOwner,
  AcpConnectionResourceReadyHandle
} from './connection-resource-owner'
import { retainInitializeCapabilities } from './native-follow-up'

type LifecycleEvent = AcpRuntimeEventInput
type TransferredConnection = ReturnType<AcpAgentConnectionCandidate['transferTo']>

const resolveFallbackProviderConfiguration = async (
  connection: TransferredConnection,
  requested: AgentProviderConfiguration
): Promise<SetProviderRequest | undefined> => {
  const { providers } = await connection.listProviders()
  const exact = providers.find(
    (provider) =>
      provider.providerId === requested.providerId && provider.supported.includes(requested.apiType)
  )
  if (exact) return undefined

  const compatible = providers.filter((provider) => provider.supported.includes(requested.apiType))
  return compatible.length === 1
    ? { ...requested, providerId: compatible[0].providerId }
    : undefined
}

type AcpConnectionLifecycleWorkflowOptions = Readonly<{
  appVersion: string
  defaultCwd: string
  currentConnection: () => ClientConnection | undefined
  currentStatus: () => AcpStateSnapshot['status']
  currentGeneration: () => number
  currentFramework: () => AgentFramework['id']
  reconnectBarrier: () => Promise<void> | undefined
  connect?: (request: AcpConnectRequest) => Promise<AcpStateSnapshot>
  getSnapshot: () => AcpStateSnapshot
  connectResources: Pick<AcpConnectionResourceOwner, 'connect'>
  invalidatePendingSessionStartups: () => void
  disconnectCurrent: (
    emitClosedStatus: boolean,
    teardownGeneration: number
  ) => Promise<AcpStateSnapshot>
  updateCwd: (cwd: string) => void
  updateError: (error: string | undefined) => void
  setStatus: (status: AcpStateSnapshot['status']) => void
  pushEvent: (event: LifecycleEvent) => void
  transitionStatus: (status: AcpStateSnapshot['status']) => void
  emitState: () => void
  diagnosticContext: (
    framework?: AgentFramework['id'],
    generation?: number
  ) => { framework: AgentFramework['id']; generation: number; status: AcpStateSnapshot['status'] }
  openCandidate: (
    attempt: AcpConnectionResourceAttempt,
    onFrameworkResolved: (framework: AgentFramework['id']) => void
  ) => Promise<AcpAgentConnectionCandidate>
}>

const log = createLogger('acp')

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, error)
  } catch {
    return
  }
}

const safeLogWarning = (message: string, data: unknown): void => {
  try {
    log.warn(message, data)
  } catch {
    return
  }
}

const errorMessage = (error: unknown): string => {
  try {
    const message = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof message === 'string' ? message : String(message)
  } catch {
    return 'unknown error'
  }
}

class AcpConnectionLifecycleWorkflow {
  constructor(private readonly options: AcpConnectionLifecycleWorkflowOptions) {}

  async connect(request: AcpConnectRequest = {}): Promise<AcpStateSnapshot> {
    await this.options.connectResources.connect((attempt) => this.connectFresh(request, attempt))
    return this.options.getSnapshot()
  }

  async ensureConnected(cwd: string): Promise<ClientConnection> {
    const barrier = this.options.reconnectBarrier()
    if (barrier) await barrier

    const connection = this.options.currentConnection()
    if (connection && this.options.currentStatus() === 'connected') return connection

    log.info('ensureConnected: attempting connection', this.options.diagnosticContext())
    try {
      await (this.options.connect?.({ cwd }) ?? this.connect({ cwd }))
    } catch (error) {
      safeLogError('ensureConnected: connect failed', {
        ...diagnosticErrorFields(error),
        ...this.options.diagnosticContext()
      })
      throw error
    }

    const connected = this.options.currentConnection()
    if (!connected) {
      const error = new Error('ACP connection failed')
      safeLogError('ensureConnected: connection is null after connect', {
        ...this.options.diagnosticContext(),
        errorCategory: 'connection-unavailable'
      })
      throw error
    }
    log.info('ensureConnected: connection established', this.options.diagnosticContext())
    return connected
  }

  private async connectFresh(
    request: AcpConnectRequest,
    attempt: AcpConnectionResourceAttempt
  ): Promise<AcpConnectionResourceReadyHandle> {
    const generation = attempt.epoch
    attempt.assertCurrent()
    const cwd = resolve(request.cwd || this.options.defaultCwd)
    let candidate: AcpAgentConnectionCandidate | undefined
    let transferred: TransferredConnection | undefined
    let spawnedFramework = this.options.currentFramework()

    try {
      this.options.invalidatePendingSessionStartups()
      await this.options.disconnectCurrent(false, generation)
      attempt.assertCurrent()

      this.options.updateCwd(cwd)
      this.options.updateError(undefined)
      this.options.setStatus('connecting')
      log.info('connecting agent', this.options.diagnosticContext(spawnedFramework, generation))

      candidate = await this.options.openCandidate(attempt, (framework) => {
        spawnedFramework = framework
      })
      transferred = candidate.transferTo(attempt)
      candidate = undefined

      const initResult = await transferred.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: 'open-science',
          version: this.options.appVersion
        },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          session: { configOptions: { boolean: {} } },
          plan: {},
          elicitation: { form: {} }
        }
      })
      attempt.assertCurrent()

      const initializeMaterial = transferred.backendAttempt.consumeInitializeMaterial()
      if (initializeMaterial?.authentication) {
        await transferred.authenticate(initializeMaterial.authentication)
        attempt.assertCurrent()
      }
      if (initializeMaterial?.providerConfiguration) {
        try {
          await transferred.setProvider(initializeMaterial.providerConfiguration)
          attempt.assertCurrent()
        } catch (cause) {
          if (!(cause instanceof acp.RequestError) || cause.code !== -32602) throw cause
          attempt.assertCurrent()
          // Codex ACP 1.1.4 advertises `custom-gateway`; 1.6.2 advertises `openai`.
          // Retry only when the adapter itself exposes one unambiguous compatible slot.
          const fallback = await resolveFallbackProviderConfiguration(
            transferred,
            initializeMaterial.providerConfiguration
          )
          if (!fallback) throw cause
          attempt.assertCurrent()
          await transferred.setProvider(fallback)
          attempt.assertCurrent()
        }
      }

      const handle = attempt.publish(retainInitializeCapabilities(initResult, spawnedFramework))
      log.info('agent initialized', {
        protocolVersion: initResult.protocolVersion,
        supportsSessionClose: handle.capabilities.close,
        supportsSessionDelete: handle.capabilities.delete,
        supportsSessionResume: handle.capabilities.resume,
        supportsSteering: handle.capabilities.steering
      })
      this.options.pushEvent({
        kind: 'system',
        level: 'info',
        title: 'Agent initialized',
        text: `ACP protocol ${initResult.protocolVersion}`
      })
      handle.assertCurrent()
      this.options.setStatus('connected')
      return handle
    } catch (cause) {
      try {
        transferred?.backendAttempt.fail()
      } catch (error) {
        safeLogError('ACP backend attempt cleanup failed', diagnosticErrorFields(error))
      }
      try {
        await candidate?.dispose()
      } catch (error) {
        safeLogError('ACP connection candidate cleanup failed', diagnosticErrorFields(error))
      }

      const current = generation === this.options.currentGeneration()
      try {
        if (current) {
          this.options.updateError(errorMessage(cause))
          safeLogError('agent connection failed', {
            ...diagnosticErrorFields(cause),
            ...this.options.diagnosticContext(spawnedFramework, generation)
          })
          try {
            this.options.pushEvent({
              kind: 'error',
              level: 'error',
              title: 'Connection failed',
              text: errorMessage(cause)
            })
          } catch (error) {
            safeLogError('agent connection failure notification failed', {
              ...diagnosticErrorFields(error),
              ...this.options.diagnosticContext(spawnedFramework, generation)
            })
          }
          try {
            await this.options.disconnectCurrent(false, generation)
          } catch (error) {
            safeLogError('agent connection cleanup failed', {
              ...diagnosticErrorFields(error),
              ...this.options.diagnosticContext(spawnedFramework, generation)
            })
          }
          if (generation === this.options.currentGeneration()) {
            this.options.transitionStatus('error')
            try {
              this.options.emitState()
            } catch (error) {
              safeLogError('agent connection emitState failed', error)
            }
          }
        } else {
          safeLogWarning('agent connection abandoned (superseded or shutting down)', {
            ...diagnosticErrorFields(cause),
            ...this.options.diagnosticContext(spawnedFramework, generation)
          })
        }
      } catch (error) {
        safeLogError('error while handling agent connection failure', {
          ...diagnosticErrorFields(error),
          ...this.options.diagnosticContext(spawnedFramework, generation)
        })
      }
      throw cause
    }
  }
}

export { AcpConnectionLifecycleWorkflow }
export type { AcpConnectionLifecycleWorkflowOptions }
