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
  private current: CurrentResource | undefined
  private connectInFlight: Promise<AcpConnectionResourceReadyHandle> | undefined

  get epoch(): number {
    return this.resourceEpoch
  }

  get connection(): ClientConnection | undefined {
    return this.current?.connection
  }

  get capabilities(): AcpConnectionCapabilities {
    return this.current?.capabilities ?? EMPTY_CAPABILITIES
  }

  get inFlight(): Promise<AcpConnectionResourceReadyHandle> | undefined {
    return this.connectInFlight
  }

  get bridgeSkillsAvailable(): boolean {
    return Boolean(this.current?.bridgeLease?.selectSkills)
  }

  connect(
    operation: (
      attempt: AcpConnectionResourceAttempt
    ) => Promise<AcpConnectionResourceReadyHandle>
  ): Promise<AcpConnectionResourceReadyHandle> {
    if (this.connectInFlight) return this.connectInFlight

    const epoch = this.supersede()
    const attempt = this.createAttempt(epoch)
    const connect = Promise.resolve().then(() => operation(attempt))
    this.connectInFlight = connect
    const clear = (): void => {
      if (this.connectInFlight === connect) this.connectInFlight = undefined
    }
    void connect.then(clear, clear)
    return connect
  }

  supersede(): number {
    this.resourceEpoch += 1
    this.connectInFlight = undefined
    return this.resourceEpoch
  }

  detach(expectedEpoch = this.resourceEpoch): AcpDetachedConnectionResource | undefined {
    if (expectedEpoch !== this.resourceEpoch) return undefined
    const resource = this.current
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
    this.current?.bridgeLease?.registerReviewerSession(sessionId)
  }

  unregisterBridgeReviewerSession(sessionId: string): boolean | undefined {
    return this.current?.bridgeLease?.unregisterReviewerSession(sessionId)
  }

  setBridgeReasoningEffort(
    effort: Parameters<
      NonNullable<NonNullable<ResponsesBridgeLease>['setReasoningEffort']>
    >[0]
  ): void {
    this.current?.bridgeLease?.setReasoningEffort?.(effort)
  }

  async selectBridgeSkills(
    text: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[0],
    catalog: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[1],
    signal?: Parameters<NonNullable<ResponsesBridgeLease>['selectSkills']>[2]
  ): Promise<Awaited<ReturnType<NonNullable<ResponsesBridgeLease>['selectSkills']>> | undefined> {
    return this.current?.bridgeLease?.selectSkills(text, catalog, signal)
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
        if (this.current) throw new Error('ACP connection resource is already attached.')
        this.current = { ...resource, epoch, capabilities: EMPTY_CAPABILITIES }
      },
      publish: (capabilities) => {
        assertCurrent()
        const resource = this.current
        if (!resource || resource.epoch !== epoch) {
          throw new Error('ACP connection resource is not attached.')
        }
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
        epoch === this.resourceEpoch && this.current?.connection === connection
    })
  }
}
