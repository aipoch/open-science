import * as acp from '@agentclientprotocol/sdk'
import type { ClientConnection } from '@agentclientprotocol/sdk'

import type { AcpRuntimeEventInput, AcpStateSnapshot } from '../../shared/acp'
import type { AcpAppContinuationOwner } from './app-continuation-owner'
import type { ContextUsageTracker } from './context-usage-tracker'
import type { AcpElicitationOwner } from './elicitation-owner'
import type { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import type { AcpPermissionContext } from './permission-context'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { AcpSessionCapabilityOwner } from './session-capability-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpSessionRegistry, AcpSessionRegistryEntry } from './session-registry'
import type { AcpSessionUpdateProjector } from './session-update-projector'

type SessionDeletedEvent = AcpRuntimeEventInput
type OperationLease = <Result>(work: () => Promise<Result>) => Promise<Result>

type AcpSessionDeletionWorkflowDependencies = Readonly<{
  registry: Pick<AcpSessionRegistry, 'beginDelete' | 'lookup' | 'detach'>
  withOperation: OperationLease
  currentConnection: () => ClientConnection | undefined
  supportsSessionDelete: () => boolean
  supportsSessionClose: () => boolean
  permission: Pick<AcpPermissionContext, 'cancelForSession' | 'clearSession'>
  elicitation: Pick<AcpElicitationOwner, 'cancelForSession'>
  clearUserChoiceProvenanceForSession: (sessionId: string) => void
  appContinuations: Pick<AcpAppContinuationOwner, 'delete'>
  interactions: Pick<AcpSessionInteractionOwner, 'supersedeCurrent'>
  capabilities: Pick<AcpSessionCapabilityOwner, 'revokeSession'>
  promptContent: Pick<AcpPromptContentOwner, 'resetSession'>
  handoff: Pick<AcpHandoffContinuityOwner, 'clearSession'>
  contextUsage: Pick<ContextUsageTracker, 'deleteSession'>
  projector: Pick<AcpSessionUpdateProjector, 'clearSession'>
  pushEvent: (event: SessionDeletedEvent) => void
  emitState: () => void
  getSnapshot: () => AcpStateSnapshot
}>

// Statelessly sequences provider teardown and app-keyed cleanup. The Registry owns identity,
// deletion epochs, and selection; each injected owner cleans only the state it created.
class AcpSessionDeletionWorkflow {
  constructor(private readonly deps: AcpSessionDeletionWorkflowDependencies) {}

  async delete(appSessionId: string): Promise<AcpStateSnapshot> {
    // Begin synchronously before a reconnect/model barrier can delay the operation lease. This keeps
    // same-ID startup blocked for the entire queued deletion, not only after provider work begins.
    const deletion = this.deps.registry.beginDelete(appSessionId)
    try {
      return await this.deps.withOperation(() => this.deleteWithLease(appSessionId, deletion))
    } finally {
      deletion.finish()
    }
  }

  private async deleteWithLease(
    appSessionId: string,
    deletion: ReturnType<AcpSessionRegistry['beginDelete']>
  ): Promise<AcpStateSnapshot> {
    const target = this.deps.registry.lookup(appSessionId)
    const attachment = target?.attachment

    this.deps.permission.cancelForSession(appSessionId)
    this.deps.clearUserChoiceProvenanceForSession(appSessionId)
    this.deps.elicitation.cancelForSession(appSessionId)
    this.deps.appContinuations.delete(appSessionId)
    if (attachment) await this.deleteProviderSession(attachment.session.sessionId)

    if (attachment) {
      attachment.session.dispose()
      this.deps.registry.detach(attachment, 'provider')
    }

    // No await occurs between this ownership check and local cleanup. A stale captured generation
    // may dispose its own provider object, but cannot erase app-keyed state owned by a replacement.
    if (!this.stillOwnsTarget(appSessionId, target)) {
      deletion.finish(target)
      return this.deps.getSnapshot()
    }

    this.deps.permission.clearSession(appSessionId)
    this.deps.interactions.supersedeCurrent(appSessionId)
    this.deps.capabilities.revokeSession(appSessionId)
    const removal = deletion.finish(target)
    this.deps.promptContent.resetSession(appSessionId)
    this.deps.handoff.clearSession(appSessionId)
    this.deps.contextUsage.deleteSession(appSessionId)
    this.deps.projector.clearSession(appSessionId)

    if (removal.wasActive) {
      this.deps.pushEvent({
        kind: 'system',
        level: 'info',
        sessionId: appSessionId,
        title: 'Session deleted'
      })
      this.deps.emitState()
    }

    return this.deps.getSnapshot()
  }

  private async deleteProviderSession(providerSessionId: string): Promise<void> {
    const connection = this.deps.currentConnection()
    if (connection && this.deps.supportsSessionDelete()) {
      await connection.agent.request(acp.methods.agent.session.delete, {
        sessionId: providerSessionId
      })
    } else if (connection && this.deps.supportsSessionClose()) {
      await connection.agent.request(acp.methods.agent.session.close, {
        sessionId: providerSessionId
      })
    } else {
      await connection?.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: providerSessionId
      })
    }
  }

  private stillOwnsTarget(
    appSessionId: string,
    target: AcpSessionRegistryEntry | undefined
  ): boolean {
    const current = this.deps.registry.lookup(appSessionId)
    return target ? current?.generation === target.generation : current === undefined
  }
}

export { AcpSessionDeletionWorkflow }
export type { AcpSessionDeletionWorkflowDependencies }
