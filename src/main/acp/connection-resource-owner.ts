import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { AgentFramework, ResolvedAgentBackend } from '../agent-framework'
import type { OpenCodeStoreLease } from './opencode-store'
import type { OpenCodeServiceLease } from './opencode-service'
import type { ResponsesNamespacedTool } from '@aipoch/providers/protocol'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { terminateProcessTree } from '../process-tree'

type ResponsesTransportLease = ResolvedAgentBackend['responsesTransportLease']
type MessagesBridgeLease = ResolvedAgentBackend['messagesBridgeLease']
type ProviderTransportLease = ResolvedAgentBackend['providerTransportLease']
type CleanupFailure = (stage: 'connection' | 'agent-process', error: unknown) => void

const log = createLogger('acp')
const safeLogCleanupError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Physical cleanup and the original failure take precedence over diagnostic sinks.
  }
}

export type AcpConnectionCapabilities = Readonly<{
  close: boolean
  delete: boolean
  resume: boolean
  steering: boolean
}>

export type AcpAttachedConnectionResource = {
  process: ChildProcessWithoutNullStreams
  connection: ClientConnection
  framework: AgentFramework['id']
  bridgeLease: ResponsesTransportLease
  messagesBridgeLease?: MessagesBridgeLease
  providerTransportLease?: ProviderTransportLease
  openCodeService?: OpenCodeServiceLease
  openCodeStore?: OpenCodeStoreLease
}

export type AcpConnectionResourceReadyHandle = Readonly<{
  epoch: number
  connection: ClientConnection
  framework: AgentFramework['id']
  capabilities: AcpConnectionCapabilities
  assertCurrent: () => void
}>

export type AcpConnectionResourceAttempt = Readonly<{
  epoch: number
  attach: (resource: AcpAttachedConnectionResource) => void
  publish: (capabilities: AcpConnectionCapabilities) => AcpConnectionResourceReadyHandle
  assertCurrent: () => void
  owns: (connection: ClientConnection) => boolean
}>

export type AcpUnattachedConnectionResource = Readonly<{
  process?: ChildProcessWithoutNullStreams
  connection?: ClientConnection
  bridgeLease?: ResponsesTransportLease
  messagesBridgeLease?: MessagesBridgeLease
  providerTransportLease?: ProviderTransportLease
  openCodeService?: OpenCodeServiceLease
  openCodeStore?: OpenCodeStoreLease
}>

export type AcpConnectionShutdownHandle = Readonly<{
  finish: () => Promise<{ reaped: boolean }>
}>

type AcpConnectionResourceOwnerOptions = Readonly<{
  closeMcpHost?: () => Promise<void>
}>

type PendingCleanup = {
  resource: AcpUnattachedConnectionResource
  closeConnection: boolean
  processReaped: boolean
  serviceReaped: boolean
  attemptEpoch?: number
  inFlight?: Promise<void>
}

type CurrentResource = AcpAttachedConnectionResource & {
  epoch: number
  capabilities: AcpConnectionCapabilities
}

const EMPTY_CAPABILITIES: AcpConnectionCapabilities = Object.freeze({
  close: false,
  delete: false,
  resume: false,
  steering: false
})

// Owns connection publication, physical resource teardown, process-exit identity, and exclusive
// transfer. Runtime supplies protocol startup plus Session/Permission/Notebook cleanup and projection.
export class AcpConnectionResourceOwner {
  private resourceEpoch = 0
  private provisional: CurrentResource | undefined
  private current: CurrentResource | undefined
  private connectInFlight: Promise<AcpConnectionResourceReadyHandle> | undefined
  private readonly expectedProcessExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly releasedBridgeLeases = new WeakSet<object>()
  private shuttingDown = false
  private readonly pendingCleanup = new Set<PendingCleanup>()

  constructor(private readonly options: AcpConnectionResourceOwnerOptions = {}) {}

  get epoch(): number {
    return this.resourceEpoch
  }

  get connection(): ClientConnection | undefined {
    return this.currentResource()?.connection
  }

  get capabilities(): AcpConnectionCapabilities {
    return this.currentResource()?.capabilities ?? EMPTY_CAPABILITIES
  }

  get bridgeSkillsAvailable(): boolean {
    const resource = this.currentResource()
    return Boolean(
      resource?.bridgeLease?.selectSkills ?? resource?.providerTransportLease?.selectSkills
    )
  }

  get messagesBridgeAvailable(): boolean {
    return Boolean(this.currentResource()?.messagesBridgeLease)
  }

  get providerTransportAvailable(): boolean {
    return Boolean(this.currentResource()?.providerTransportLease)
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  connect(
    operation: (attempt: AcpConnectionResourceAttempt) => Promise<AcpConnectionResourceReadyHandle>
  ): Promise<AcpConnectionResourceReadyHandle> {
    if (this.connectInFlight) return this.connectInFlight

    const epoch = this.supersede()
    const attempt = this.createAttempt(epoch)
    let resolveConnect!: (handle: AcpConnectionResourceReadyHandle) => void
    let rejectConnect!: (error: unknown) => void
    const connect = new Promise<AcpConnectionResourceReadyHandle>((resolve, reject) => {
      resolveConnect = resolve
      rejectConnect = reject
    })
    this.connectInFlight = connect
    const clear = (): void => {
      if (this.connectInFlight === connect) this.connectInFlight = undefined
    }
    void connect.then(clear, clear)
    try {
      void operation(attempt).then(resolveConnect, rejectConnect)
    } catch (error) {
      rejectConnect(error)
    }
    return connect
  }

  supersede(): number {
    this.resourceEpoch += 1
    this.connectInFlight = undefined
    return this.resourceEpoch
  }

  restorePublished(expectedEpoch: number): boolean {
    // A teardown may fail before detach transfers the published resource back to Runtime. Restore only
    // that still-owned publication into the teardown epoch; a stale caller, provisional startup, or
    // already-detached resource must never be able to revive a connection.
    if (expectedEpoch !== this.resourceEpoch || !this.current) return false
    this.current.epoch = expectedEpoch
    return true
  }

  async teardown(
    expectedEpoch: number,
    onFailure: CleanupFailure = (stage, error) =>
      safeLogCleanupError(`ACP ${stage} cleanup failed`, error)
  ): Promise<void> {
    if (expectedEpoch !== this.resourceEpoch) return
    // Detached resources remain cleanup-owned until every writer is confirmed reaped. They never
    // become published again and cannot authorize teardown of a successor connection.
    const resource = this.detach(expectedEpoch)
    if (resource) this.retainCleanup(resource, true)
    await Promise.all(
      [...this.pendingCleanup]
        // Successor startup may overlap an older teardown. Shutdown joins all work in finish().
        .filter((cleanup) => !cleanup.inFlight || cleanup.attemptEpoch === expectedEpoch)
        .map((cleanup) => this.cleanResource(cleanup, onFailure))
    )
  }

  async cleanupUnattached(
    resource: AcpUnattachedConnectionResource,
    onFailure: CleanupFailure = (stage, error) =>
      safeLogCleanupError(`unattached ACP ${stage} cleanup failed`, error)
  ): Promise<void> {
    await this.cleanResource(this.retainCleanup(resource, true), onFailure)
  }

  cleanupUnexpectedClose(expectedEpoch: number): void {
    const resource = this.detach(expectedEpoch)
    if (resource) void this.cleanResource(this.retainCleanup(resource, false))
  }

  shutdownSynchronously(onSuperseded: () => void): void {
    this.shuttingDown = true
    const teardownEpoch = this.supersede()
    try {
      onSuperseded()
    } finally {
      const resource = this.detach(teardownEpoch)
      if (resource) {
        const cleanup = this.retainCleanup(resource, true)
        this.closeResourceConnection(cleanup)
        try {
          if (!resource.process.killed) resource.process.kill()
        } catch (error) {
          safeLogCleanupError('agent process kill during shutdown failed', error)
        }
      }
      for (const cleanup of this.pendingCleanup) void this.cleanResource(cleanup)
      void this.closeMcp()
    }
  }

  get cleanupConfirmed(): boolean {
    return (
      !this.current && !this.provisional && !this.connectInFlight && this.pendingCleanup.size === 0
    )
  }

  beginAwaitableShutdown(latch: boolean): AcpConnectionShutdownHandle {
    if (latch) this.shuttingDown = true
    const inFlight = this.connectInFlight

    return Object.freeze({
      finish: async () => {
        if (inFlight) await inFlight.catch(() => undefined)
        await Promise.all([...this.pendingCleanup].map((cleanup) => cleanup.inFlight))
        return { reaped: this.cleanupConfirmed }
      }
    })
  }

  processEventDisposition(
    process: ChildProcessWithoutNullStreams,
    epoch: number
  ): 'current' | 'expected' | 'stale' {
    if (this.expectedProcessExits.has(process)) return 'expected'
    const currentProcess =
      this.currentResource()?.process ??
      (this.provisional?.epoch === this.resourceEpoch ? this.provisional.process : undefined)
    if (currentProcess === process) return 'current'
    // Between spawn and attach the attempt still owns its local process, but it is not yet present in
    // either owner slot. Its epoch is sufficient only while no attached resource occupies the owner.
    return !currentProcess && epoch === this.resourceEpoch ? 'current' : 'stale'
  }

  async closeMcp(expectedEpoch?: number): Promise<void> {
    if (expectedEpoch !== undefined && expectedEpoch !== this.resourceEpoch) return
    try {
      await this.options.closeMcpHost?.()
    } catch (error) {
      safeLogCleanupError('MCP HTTP host close failed', error)
    }
  }

  private detach(expectedEpoch = this.resourceEpoch): CurrentResource | undefined {
    if (expectedEpoch !== this.resourceEpoch) return undefined
    const resource = this.provisional ?? this.current
    this.provisional = undefined
    this.current = undefined
    if (!resource) return undefined
    return resource
  }

  assertCurrentConnection(connection: ClientConnection): void {
    if (this.current?.connection !== connection) {
      throw new Error('ACP session startup was superseded.')
    }
  }

  registerBridgeReviewerSession(sessionId: string): void {
    this.currentResource()?.bridgeLease?.registerReviewerSession(sessionId)
  }

  unregisterBridgeReviewerSession(sessionId: string): boolean | undefined {
    return this.current?.bridgeLease?.unregisterReviewerSession(sessionId)
  }

  registerBridgeMcpSession(
    sessionId: string,
    tools: ResponsesNamespacedTool[],
    namespaces: readonly string[]
  ): void {
    this.currentResource()?.bridgeLease?.registerMcpSession?.(sessionId, tools, namespaces)
  }

  unregisterBridgeMcpSession(sessionId: string): boolean | undefined {
    return this.current?.bridgeLease?.unregisterMcpSession?.(sessionId)
  }

  setBridgeReasoningEffort(
    effort: Parameters<NonNullable<NonNullable<ResponsesTransportLease>['setReasoningEffort']>>[0]
  ): void {
    this.currentResource()?.bridgeLease?.setReasoningEffort?.(effort)
  }

  setBridgeModelTarget(
    target: Parameters<NonNullable<NonNullable<ResponsesTransportLease>['setModelTarget']>>[0]
  ): boolean {
    const setModelTarget = this.currentResource()?.bridgeLease?.setModelTarget
    if (!setModelTarget) return false
    setModelTarget(target)
    return true
  }

  setMessagesBridgeTarget(targetId: string): boolean {
    return this.currentResource()?.messagesBridgeLease?.setTarget(targetId) ?? false
  }

  setProviderTransportTarget(targetId: string): boolean {
    return this.currentResource()?.providerTransportLease?.setTarget(targetId) ?? false
  }

  async selectBridgeSkills(
    text: Parameters<NonNullable<ResponsesTransportLease>['selectSkills']>[0],
    catalog: Parameters<NonNullable<ResponsesTransportLease>['selectSkills']>[1],
    signal?: Parameters<NonNullable<ResponsesTransportLease>['selectSkills']>[2],
    observeUsage?: Parameters<NonNullable<ResponsesTransportLease>['selectSkills']>[3]
  ): Promise<
    Awaited<ReturnType<NonNullable<ResponsesTransportLease>['selectSkills']>> | undefined
  > {
    const resource = this.currentResource()
    const selectSkills =
      resource?.bridgeLease?.selectSkills ?? resource?.providerTransportLease?.selectSkills
    if (!selectSkills) return undefined
    return observeUsage
      ? selectSkills(text, catalog, signal, observeUsage)
      : selectSkills(text, catalog, signal)
  }

  private async reapProcessTree(process: ChildProcessWithoutNullStreams): Promise<boolean> {
    this.expectedProcessExits.add(process)
    const result = await terminateProcessTree(process, undefined, log)
    return result.reaped
  }

  private async releaseBridgeLease(lease: ResponsesTransportLease): Promise<void> {
    if (!lease || this.releasedBridgeLeases.has(lease)) return
    this.releasedBridgeLeases.add(lease)
    try {
      await lease.release()
    } catch (error) {
      safeLogCleanupError('responses bridge lease release failed', error)
    }
  }

  private async releaseMessagesBridgeLease(lease: MessagesBridgeLease): Promise<void> {
    if (!lease || this.releasedBridgeLeases.has(lease)) return
    this.releasedBridgeLeases.add(lease)
    try {
      await lease.release()
    } catch (error) {
      safeLogCleanupError('Anthropic bridge lease release failed', error)
    }
  }

  private async releaseProviderTransportLease(lease: ProviderTransportLease): Promise<void> {
    if (!lease || this.releasedBridgeLeases.has(lease)) return
    this.releasedBridgeLeases.add(lease)
    try {
      await lease.release()
    } catch (error) {
      safeLogCleanupError('provider transport lease release failed', error)
    }
  }

  private async releaseOpenCodeService(lease: OpenCodeServiceLease | undefined): Promise<boolean> {
    if (!lease) return true
    try {
      const result = await lease.release()
      return result.reaped
    } catch (error) {
      safeLogCleanupError('OpenCode HTTP service release failed', error)
      return false
    }
  }

  private retainCleanup(
    resource: AcpUnattachedConnectionResource,
    closeConnection: boolean
  ): PendingCleanup {
    if (resource.process) this.expectedProcessExits.add(resource.process)
    const cleanup: PendingCleanup = {
      resource,
      closeConnection,
      processReaped: !resource.process,
      serviceReaped: !resource.openCodeService
    }
    this.pendingCleanup.add(cleanup)
    return cleanup
  }

  private closeResourceConnection(
    cleanup: PendingCleanup,
    onFailure: CleanupFailure = (stage, error) =>
      safeLogCleanupError(`ACP ${stage} cleanup failed`, error)
  ): void {
    if (!cleanup.closeConnection) return
    cleanup.closeConnection = false
    try {
      cleanup.resource.connection?.close()
    } catch (error) {
      this.reportCleanupFailure(onFailure, 'connection', error)
    }
  }

  private cleanResource(
    cleanup: PendingCleanup,
    onFailure: CleanupFailure = (stage, error) =>
      safeLogCleanupError(`ACP ${stage} cleanup failed`, error)
  ): Promise<void> {
    if (cleanup.inFlight) return cleanup.inFlight
    const completion = Promise.withResolvers<void>()
    cleanup.inFlight = completion.promise
    cleanup.attemptEpoch = this.resourceEpoch
    const clear = (): void => {
      cleanup.inFlight = undefined
    }
    void completion.promise.then(clear, clear)
    void this.performResourceCleanup(cleanup, onFailure).then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async performResourceCleanup(
    cleanup: PendingCleanup,
    onFailure: CleanupFailure
  ): Promise<void> {
    const { resource } = cleanup
    this.closeResourceConnection(cleanup, onFailure)
    if (!cleanup.processReaped && resource.process) {
      try {
        cleanup.processReaped = await this.reapProcessTree(resource.process)
      } catch (error) {
        this.reportCleanupFailure(onFailure, 'agent-process', error)
      }
    }
    await this.releaseBridgeLease(resource.bridgeLease)
    await this.releaseMessagesBridgeLease(resource.messagesBridgeLease)
    await this.releaseProviderTransportLease(resource.providerTransportLease)
    if (!cleanup.serviceReaped) {
      cleanup.serviceReaped = await this.releaseOpenCodeService(resource.openCodeService)
    }
    // Keep storage ownership while either writer may still be alive, including across retries.
    if (cleanup.processReaped && cleanup.serviceReaped) {
      resource.openCodeStore?.release()
      this.pendingCleanup.delete(cleanup)
    }
  }

  private reportCleanupFailure(
    onFailure: CleanupFailure,
    stage: Parameters<CleanupFailure>[0],
    error: unknown
  ): void {
    try {
      onFailure(stage, error)
    } catch (callbackError) {
      safeLogCleanupError('ACP connection cleanup failure callback failed', callbackError)
    }
  }

  private currentResource(): CurrentResource | undefined {
    return this.current?.epoch === this.resourceEpoch ? this.current : undefined
  }

  private createAttempt(epoch: number): AcpConnectionResourceAttempt {
    const assertCurrent = (): void => {
      if (epoch !== this.resourceEpoch) throw new Error('ACP connection was superseded.')
    }

    return Object.freeze({
      epoch,
      assertCurrent,
      attach: (resource) => {
        assertCurrent()
        if (this.provisional || this.current) {
          throw new Error('ACP connection resource is already attached.')
        }
        this.provisional = { ...resource, epoch, capabilities: EMPTY_CAPABILITIES }
      },
      publish: (capabilities) => {
        assertCurrent()
        const resource = this.provisional
        if (!resource || resource.epoch !== epoch) {
          throw new Error('ACP connection resource is not attached.')
        }
        this.provisional = undefined
        this.current = resource
        resource.capabilities = Object.freeze({ ...capabilities })
        const handle: AcpConnectionResourceReadyHandle = Object.freeze({
          epoch,
          connection: resource.connection,
          framework: resource.framework,
          capabilities: resource.capabilities,
          assertCurrent: () => {
            assertCurrent()
            if (this.current !== resource) throw new Error('ACP connection was superseded.')
          }
        })
        return handle
      },
      owns: (connection) =>
        this.currentResource()?.connection === connection ||
        (this.provisional?.epoch === this.resourceEpoch &&
          this.provisional.connection === connection)
    })
  }
}
