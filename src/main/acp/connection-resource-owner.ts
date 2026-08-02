import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { AgentFramework, ResolvedAgentBackend } from '../agent-framework'

type ResponsesBridgeLease = ResolvedAgentBackend['responsesBridgeLease']

export type AcpConnectionCapabilities = Readonly<{
  close: boolean
  delete: boolean
  resume: boolean
}>

export type AcpAttachedConnectionResource = {
  process: ChildProcessWithoutNullStreams
  connection: ClientConnection
  framework: AgentFramework['id']
  bridgeLease: ResponsesBridgeLease
}

export type AcpDetachedConnectionResource = AcpAttachedConnectionResource & {
  capabilities: AcpConnectionCapabilities
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

type CurrentResource = AcpAttachedConnectionResource & {
  epoch: number
  capabilities: AcpConnectionCapabilities
}

const EMPTY_CAPABILITIES: AcpConnectionCapabilities = Object.freeze({
  close: false,
  delete: false,
  resume: false
})

// Owns connection publication, identity, and exclusive resource transfer. Runtime ports still perform
// spawn/initialize and physical teardown in A9.1a1; attach/detach prevents either side from retaining a
// second mutable owner while those effects move behind this module in A9.1a2.
export class AcpConnectionResourceOwner {
  private resourceEpoch = 0
  private provisional: CurrentResource | undefined
  private current: CurrentResource | undefined
  private connectInFlight: Promise<AcpConnectionResourceReadyHandle> | undefined

  get epoch(): number {
    return this.resourceEpoch
  }

  get connection(): ClientConnection | undefined {
    return this.currentResource()?.connection
  }

  get capabilities(): AcpConnectionCapabilities {
    return this.currentResource()?.capabilities ?? EMPTY_CAPABILITIES
  }

  get inFlight(): Promise<AcpConnectionResourceReadyHandle> | undefined {
    return this.connectInFlight
  }

  get bridgeSkillsAvailable(): boolean {
    return Boolean(this.currentResource()?.bridgeLease?.selectSkills)
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

  detach(expectedEpoch = this.resourceEpoch): AcpDetachedConnectionResource | undefined {
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

  setBridgeReasoningEffort(
    effort: Parameters<NonNullable<NonNullable<ResponsesBridgeLease>['setReasoningEffort']>>[0]
  ): void {
    this.currentResource()?.bridgeLease?.setReasoningEffort?.(effort)
  }

  async selectBridgeSkills(
    text: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[0],
    catalog: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[1],
    signal?: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[2]
  ): Promise<Awaited<ReturnType<NonNullable<ResponsesBridgeLease>['selectSkills']>> | undefined> {
    return this.currentResource()?.bridgeLease?.selectSkills(text, catalog, signal)
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
