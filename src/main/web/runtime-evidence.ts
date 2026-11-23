import type { PersistedChatSession } from '../../shared/session-persistence'
import type { WebResult } from '../../shared/web-tools'
import type { WebInvocationBinding, WebInvocationScope } from './invocation-store'
import { webEvidenceScope } from './evidence-lifecycle'
import type { WebFetchContext, WebService } from './service'

type Options = {
  service: Pick<WebService, 'fetch' | 'commitSnapshot'>
  loadSession: (binding: WebInvocationBinding) => Promise<PersistedChatSession>
  ensureBranchOwnership: (session: PersistedChatSession, branchId: string) => Promise<void>
}

/** Binds execution evidence to its durable message branch, independently of session admission. */
export class WebRuntimeEvidence {
  constructor(private readonly options: Options) {}

  private async current(scope: WebInvocationScope): Promise<PersistedChatSession> {
    const session = await this.options.loadSession(scope)
    const graph = session.conversationGraph
    const frame = graph?.frames.find((entry) => entry.id === graph.activeFrameId)
    if (
      session.id !== scope.sessionId ||
      session.projectId !== scope.projectId ||
      session.packageOrigin ||
      !frame ||
      frame.kind !== 'root' ||
      frame.id !== scope.agentFrameId ||
      frame.activeBranchId !== scope.branchId
    )
      throw new Error('Web evidence belongs to another active Session branch')
    return session
  }

  async fetch(
    scope: WebInvocationScope,
    input: unknown,
    context: WebFetchContext
  ): Promise<WebResult> {
    context.signal?.throwIfAborted()
    const session = await this.current(scope)
    await this.options.ensureBranchOwnership(session, scope.branchId)
    // Adopting legacy references may yield to a branch switch or Session deletion.
    await this.current(scope)
    context.signal?.throwIfAborted()
    return this.options.service.fetch(
      webEvidenceScope(scope.projectId, scope.sessionId, scope.branchId),
      input,
      {
        ...context,
        sessionSlotKey: webEvidenceScope(scope.projectId, scope.sessionId)
      }
    )
  }

  async commit(
    scope: WebInvocationScope,
    snapshotId: string,
    authorize: () => Promise<boolean>
  ): Promise<void> {
    await this.current(scope)
    await this.options.service.commitSnapshot(
      webEvidenceScope(scope.projectId, scope.sessionId, scope.branchId),
      snapshotId,
      authorize
    )
  }
}
