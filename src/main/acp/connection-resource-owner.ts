import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { AgentFramework, ResolvedAgentBackend } from '../agent-framework'
import type { ResponsesBridgeNamespacedTool } from '../settings/responses-protocol-types'
import { createLogger, errorLogFields } from '../logger'
import { terminateProcessTree } from '../process-tree'

type ResponsesBridgeLease = ResolvedAgentBackend['responsesBridgeLease']
type AnthropicBridgeLease = ResolvedAgentBackend['anthropicBridgeLease']
type ProviderTransportLease = ResolvedAgentBackend['providerTransportLease']
type ReleasableLease = NonNullable<
  ResponsesBridgeLease | AnthropicBridgeLease | ProviderTransportLease
>
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
  bridgeLease: ResponsesBridgeLease
  anthropicBridgeLease?: AnthropicBridgeLease
  providerTransportLease?: ProviderTransportLease
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
  bridgeLease?: ResponsesBridgeLease
  anthropicBridgeLease?: AnthropicBridgeLease
  providerTransportLease?: ProviderTransportLease
}>

export type AcpConnectionShutdownHandle = Readonly<{
  finish: () => Promise<{ reaped: boolean }>
}>

type AcpConnectionResourceOwnerOptions = Readonly<{
  closeMcpHost?: () => Promise<void>
}>

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
  private readonly pendingConnections = new Set<Promise<AcpConnectionResourceReadyHandle>>()
  private readonly expectedProcessExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly releasedBridgeLeases = new WeakSet<object>()
  private readonly pendingLeases = new Map<ReleasableLease, string>()
  private readonly leaseReleases = new Map<ReleasableLease, Promise<void>>()
  private shuttingDown = false
  // Detaching a connection releases routing authority, not ownership of its still-live tree.
  // Keep exact child handles across generations until a later teardown proves them reaped.
  private readonly pendingProcessTrees = new Set<ChildProcessWithoutNullStreams>()
  private readonly processReaping = new Map<ChildProcessWithoutNullStreams, Promise<void>>()

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

  get anthropicBridgeAvailable(): boolean {
    return Boolean(this.currentResource()?.anthropicBridgeLease)
  }

  get providerTransportAvailable(): boolean {
    return Boolean(this.currentResource()?.providerTransportLease)
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  get hasProcessResources(): boolean {
    return Boolean(
      this.current ||
      this.provisional ||
      this.pendingConnections.size ||
      this.pendingProcessTrees.size ||
      this.pendingLeases.size
    )
  }

  connect(
    operation: (attempt: AcpConnectionResourceAttempt) => Promise<AcpConnectionResourceReadyHandle>
  ): Promise<AcpConnectionResourceReadyHandle> {
    if (this.shuttingDown) return Promise.reject(new Error('ACP runtime is shutting down.'))
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
    this.pendingConnections.add(connect)
    const clear = (): void => {
      this.pendingConnections.delete(connect)
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
    // Ownership transfers synchronously before the first cleanup await, so a successor may attach
    // without an older process or lease remaining reachable through this owner.
    const resource = this.detach(expectedEpoch)
    if (!resource) return
    this.retainLeases(resource)
    this.expectedProcessExits.add(resource.process)

    try {
      resource.connection.close()
    } catch (error) {
      this.reportCleanupFailure(onFailure, 'connection', error)
    }

    try {
      await this.reapProcessTree(resource.process)
    } catch (error) {
      this.reportCleanupFailure(onFailure, 'agent-process', error)
    }
    await this.releaseBridgeLease(resource.bridgeLease)
    await this.releaseAnthropicBridgeLease(resource.anthropicBridgeLease)
    await this.releaseProviderTransportLease(resource.providerTransportLease)
  }

  async cleanupUnattached(
    resource: AcpUnattachedConnectionResource,
    onFailure: CleanupFailure = (stage, error) =>
      safeLogCleanupError(`unattached ACP ${stage} cleanup failed`, error)
  ): Promise<void> {
    this.retainLeases(resource)
    if (resource.process) this.expectedProcessExits.add(resource.process)
    try {
      resource.connection?.close()
    } catch (error) {
      this.reportCleanupFailure(onFailure, 'connection', error)
    }

    if (resource.process) {
      try {
        await this.reapProcessTree(resource.process)
      } catch (error) {
        this.reportCleanupFailure(onFailure, 'agent-process', error)
      }
    }
    await this.releaseBridgeLease(resource.bridgeLease)
    await this.releaseAnthropicBridgeLease(resource.anthropicBridgeLease)
    await this.releaseProviderTransportLease(resource.providerTransportLease)
  }

  cleanupUnexpectedClose(expectedEpoch: number): void {
    const resource = this.detach(expectedEpoch)
    if (!resource) return
    this.retainLeases(resource)
    this.expectedProcessExits.add(resource.process)
    void this.reapProcessTree(resource.process).catch((error) => {
      safeLogCleanupError('agent process cleanup after unexpected close failed', error)
    })
    void this.releaseBridgeLease(resource.bridgeLease)
    void this.releaseAnthropicBridgeLease(resource.anthropicBridgeLease)
    void this.releaseProviderTransportLease(resource.providerTransportLease)
  }

  shutdownSynchronously(onSuperseded: () => void): void {
    this.shuttingDown = true
    const teardownEpoch = this.supersede()
    try {
      onSuperseded()
    } finally {
      const resource = this.detach(teardownEpoch)
      if (resource) this.retainLeases(resource)
      if (resource?.process) this.expectedProcessExits.add(resource.process)
      try {
        resource?.connection.close()
      } catch (error) {
        safeLogCleanupError('ACP connection close during shutdown failed', error)
      }
      if (resource?.process) {
        this.pendingProcessTrees.add(resource.process)
        try {
          if (!resource.process.killed) resource.process.kill()
        } catch (error) {
          safeLogCleanupError('agent process kill during shutdown failed', error)
        }
      }
      void this.releaseBridgeLease(resource?.bridgeLease)
      void this.releaseAnthropicBridgeLease(resource?.anthropicBridgeLease)
      void this.releaseProviderTransportLease(resource?.providerTransportLease)
      void this.closeMcp()
    }
  }

  beginAwaitableShutdown(latch: boolean): AcpConnectionShutdownHandle {
    if (latch) this.shuttingDown = true
    const inFlight = [...this.pendingConnections]
    // Retry only debt that predates this shutdown. A newly failed teardown remains visible to
    // this caller, and can be retried at the next explicit shutdown boundary.
    const recovery = Promise.allSettled([
      ...[...this.pendingProcessTrees].map((process) => this.reapProcessTree(process)),
      ...[...this.pendingLeases].map(([lease, message]) => this.releaseLease(lease, message))
    ])

    return Object.freeze({
      finish: async () => {
        await Promise.allSettled(inFlight)
        await recovery
        // Unexpected close and an in-flight spawn can start cleanup outside disconnect().
        await Promise.allSettled([...this.processReaping.values(), ...this.leaseReleases.values()])
        return { reaped: !this.hasProcessResources }
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
    tools: ResponsesBridgeNamespacedTool[],
    namespaces: readonly string[]
  ): void {
    this.currentResource()?.bridgeLease?.registerMcpSession?.(sessionId, tools, namespaces)
  }

  unregisterBridgeMcpSession(sessionId: string): boolean | undefined {
    return this.current?.bridgeLease?.unregisterMcpSession?.(sessionId)
  }

  setBridgeReasoningEffort(
    effort: Parameters<NonNullable<NonNullable<ResponsesBridgeLease>['setReasoningEffort']>>[0]
  ): void {
    this.currentResource()?.bridgeLease?.setReasoningEffort?.(effort)
  }

  setBridgeModelTarget(
    target: Parameters<NonNullable<NonNullable<ResponsesBridgeLease>['setModelTarget']>>[0]
  ): boolean {
    const setModelTarget = this.currentResource()?.bridgeLease?.setModelTarget
    if (!setModelTarget) return false
    setModelTarget(target)
    return true
  }

  setAnthropicBridgeTarget(targetId: string): boolean {
    return this.currentResource()?.anthropicBridgeLease?.setTarget(targetId) ?? false
  }

  setProviderTransportTarget(targetId: string): boolean {
    return this.currentResource()?.providerTransportLease?.setTarget(targetId) ?? false
  }

  async selectBridgeSkills(
    text: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[0],
    catalog: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[1],
    signal?: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[2],
    observeUsage?: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[3]
  ): Promise<Awaited<ReturnType<NonNullable<ResponsesBridgeLease>['selectSkills']>> | undefined> {
    const resource = this.currentResource()
    const selectSkills =
      resource?.bridgeLease?.selectSkills ?? resource?.providerTransportLease?.selectSkills
    if (!selectSkills) return undefined
    return observeUsage
      ? selectSkills(text, catalog, signal, observeUsage)
      : selectSkills(text, catalog, signal)
  }

  private reapProcessTree(process: ChildProcessWithoutNullStreams): Promise<void> {
    this.expectedProcessExits.add(process)
    this.pendingProcessTrees.add(process)
    const existing = this.processReaping.get(process)
    if (existing) return existing
    const pending = terminateProcessTree(process, undefined, log)
      .then((result) => {
        if (result.reaped) this.pendingProcessTrees.delete(process)
      })
      .finally(() => {
        if (this.processReaping.get(process) === pending) this.processReaping.delete(process)
      })
    this.processReaping.set(process, pending)
    return pending
  }

  private retainLeases(resource: AcpUnattachedConnectionResource): void {
    const leases: Array<readonly [ReleasableLease | undefined, string]> = [
      [resource.bridgeLease, 'responses bridge lease release failed'],
      [resource.anthropicBridgeLease, 'Anthropic bridge lease release failed'],
      [resource.providerTransportLease, 'provider transport lease release failed']
    ]
    for (const [lease, message] of leases) {
      if (lease && !this.releasedBridgeLeases.has(lease)) this.pendingLeases.set(lease, message)
    }
  }

  private releaseBridgeLease(lease: ResponsesBridgeLease): Promise<void> {
    return this.releaseLease(lease, 'responses bridge lease release failed')
  }

  private releaseAnthropicBridgeLease(lease: AnthropicBridgeLease): Promise<void> {
    return this.releaseLease(lease, 'Anthropic bridge lease release failed')
  }

  private releaseProviderTransportLease(lease: ProviderTransportLease): Promise<void> {
    return this.releaseLease(lease, 'provider transport lease release failed')
  }

  private releaseLease(lease: ReleasableLease | undefined, message: string): Promise<void> {
    if (!lease || this.releasedBridgeLeases.has(lease)) return Promise.resolve()
    this.pendingLeases.set(lease, message)
    const existing = this.leaseReleases.get(lease)
    if (existing) return existing
    const pending = Promise.resolve()
      .then(() => lease.release())
      .then(() => {
        this.releasedBridgeLeases.add(lease)
        this.pendingLeases.delete(lease)
      })
      .catch((error) => safeLogCleanupError(message, error))
      .finally(() => {
        if (this.leaseReleases.get(lease) === pending) this.leaseReleases.delete(lease)
      })
    this.leaseReleases.set(lease, pending)
    return pending
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
