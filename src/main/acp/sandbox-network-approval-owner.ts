import { randomUUID } from 'node:crypto'
import type { AcpPermissionResponse } from '../../shared/acp'
import {
  activeSandboxNetworkApprovals,
  sandboxNetworkApprovalRequest,
  type SandboxNetworkApproval
} from '../../shared/sandbox-network-approval'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type { AppPermissionRequest } from './permission-broker'
import type { PermissionWaitSessions, PublishPermissionWaitSession } from './permission-wait-owner'

export type SandboxNetworkApprovalInput = Readonly<{
  projectId: string
  executionId: string
  commandFingerprint: string
  hostname: string
  port: number
  runtime: 'bash'
}>

// Owns only destination authority. The provider permission slot and its tool replay stay separate.
export class SandboxNetworkApprovalOwner {
  constructor(
    private readonly sessions?: PermissionWaitSessions,
    private readonly publish?: PublishPermissionWaitSession,
    private readonly allowDomain?: (hostname: string) => Promise<unknown>
  ) {}

  async request(
    input: AppPermissionRequest,
    promptMessageId: string | undefined,
    send: (input: AppPermissionRequest) => Promise<string | undefined>,
    isCurrent: () => boolean = () => !input.signal?.aborted
  ): Promise<string | undefined> {
    const network = input.networkApproval
    if (!network || !this.sessions || !promptMessageId || input.signal?.aborted) return undefined
    const session = materializeSessionConversationGraph(
      await this.sessions.loadSessionForContinuation(network.projectId, input.sessionId)
    )
    const graph = session.conversationGraph
    const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
    if (!frame) return undefined
    const approval: SandboxNetworkApproval = {
      ...network,
      version: 1,
      kind: 'sandbox-network',
      state: 'pending',
      requestId: randomUUID(),
      sessionId: input.sessionId,
      originatingPromptMessageId: promptMessageId,
      agentFrameId: frame.id,
      messageBranchId: frame.activeBranchId,
      createdAt: Date.now()
    }
    const sameDestination = (candidate: SandboxNetworkApproval): boolean =>
      candidate.commandFingerprint === network.commandFingerprint &&
      candidate.hostname === network.hostname &&
      candidate.port === network.port
    const grant = activeSandboxNetworkApprovals(session).find(
      (candidate) =>
        candidate.state === 'continuing' &&
        candidate.decision !== 'always-allow' &&
        sameDestination(candidate)
    )
    if (grant) {
      await this.patch(
        network.projectId,
        input.sessionId,
        (context) => {
          if (!context.networkApprovals?.some(({ requestId }) => requestId === grant.requestId))
            throw new Error('Network approval was already consumed.')
          return context.networkApprovals.filter(({ requestId }) => requestId !== grant.requestId)
        },
        grant,
        false,
        isCurrent
      )
      return input.signal?.aborted ? undefined : 'allow-once'
    }
    await this.patch(
      network.projectId,
      input.sessionId,
      (context) => {
        if ((context.networkApprovals?.length ?? 0) >= 32)
          throw new Error('Too many pending network approvals.')
        return [...(context.networkApprovals ?? []), approval]
      },
      approval,
      false,
      isCurrent
    )
    if (!isCurrent() || input.signal?.aborted) {
      await this.patch(network.projectId, input.sessionId, (context) =>
        (context.networkApprovals ?? []).filter(({ requestId }) => requestId !== approval.requestId)
      )
      return undefined
    }
    // The durable row exists before the broker exposes its request to any client.
    const request = sandboxNetworkApprovalRequest(approval)
    return send({
      ...input,
      ...request,
      durable: true,
      beforeRespond: async (optionId) => {
        if (optionId === 'always-allow') {
          await this.grantGlobal(network.projectId, approval)
          return
        }
        await this.patch(
          network.projectId,
          input.sessionId,
          (context) =>
            (context.networkApprovals ?? []).flatMap((candidate) =>
              candidate.requestId !== approval.requestId
                ? [candidate]
                : optionId === 'allow-once' &&
                    !input.signal?.aborted &&
                    input.canResume?.() === false
                  ? [{ ...candidate, state: 'continuing' as const }]
                  : []
            ),
          optionId === 'allow-once' ? approval : undefined
        )
      }
    })
  }

  async respondRestored(response: AcpPermissionResponse, projectId: string): Promise<boolean> {
    if (!this.sessions || !response.restored || response.restored.projectId !== projectId)
      return false
    const session = await this.sessions.loadSessionForContinuation(
      projectId,
      response.restored.sessionId
    )
    const approval = session.runtimeContext?.networkApprovals?.find(
      ({ requestId }) => requestId === response.requestId
    )
    if (!approval) return false
    if (approval.state !== 'pending') throw new Error('Network approval was already answered.')
    const optionId = response.cancelled ? undefined : response.optionId
    if (
      optionId &&
      !sandboxNetworkApprovalRequest(approval).options.some(
        (option) => option.optionId === optionId
      )
    )
      throw new Error('Invalid network approval option.')
    if (optionId === 'always-allow') {
      await this.grantGlobal(projectId, approval, true)
      return true
    }
    await this.patch(
      projectId,
      approval.sessionId,
      (context) => {
        const current = context.networkApprovals?.find(
          ({ requestId }) => requestId === approval.requestId
        )
        if (current?.state !== 'pending') throw new Error('Network approval was already answered.')
        return (context.networkApprovals ?? []).flatMap((candidate) =>
          candidate.requestId !== approval.requestId
            ? [candidate]
            : optionId === 'allow-once'
              ? [{ ...candidate, state: 'continuing' as const }]
              : []
        )
      },
      optionId === 'allow-once' ? approval : undefined,
      true
    )
    return true
  }

  async cancel(projectId: string, sessionId: string): Promise<void> {
    if (!this.sessions) return
    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    if (!context.networkApprovals?.length) return
    await this.patch(projectId, sessionId, () => [], undefined, true)
  }

  private assertBound(session: PersistedChatSession, approval: SandboxNetworkApproval): void {
    if (
      !activeSandboxNetworkApprovals({
        ...materializeSessionConversationGraph(session),
        runtimeContext: { version: 1, revision: 0, networkApprovals: [approval] }
      }).length
    )
      throw new Error('Network approval is not on the active Message Branch.')
  }

  private async grantGlobal(
    projectId: string,
    approval: SandboxNetworkApproval,
    restored = false
  ): Promise<void> {
    if (!this.allowDomain) throw new Error('Network settings are unavailable.')
    // This guarded Session commit is the decision's linearization point. Claim before mutating
    // settings so duplicate or stale responses cannot grant authority after cancellation.
    await this.patch(
      projectId,
      approval.sessionId,
      (context) => {
        const current = context.networkApprovals?.find(
          ({ requestId }) => requestId === approval.requestId
        )
        if (current?.state !== 'pending') throw new Error('Network approval is no longer pending.')
        return context.networkApprovals!.map((candidate) =>
          candidate.requestId === approval.requestId
            ? { ...candidate, state: 'continuing' as const, decision: 'always-allow' as const }
            : candidate
        )
      },
      approval
    )
    try {
      await this.allowDomain(approval.hostname)
      await this.patch(
        projectId,
        approval.sessionId,
        (context) =>
          (context.networkApprovals ?? []).filter(
            ({ requestId }) => requestId !== approval.requestId
          ),
        undefined,
        restored
      )
    } catch (error) {
      await this.patch(projectId, approval.sessionId, (context) =>
        (context.networkApprovals ?? []).map((candidate) => {
          if (candidate.requestId !== approval.requestId || candidate.decision !== 'always-allow')
            return candidate
          const { decision: _decision, ...rest } = candidate
          void _decision
          return { ...rest, state: 'pending' as const }
        })
      )
      throw error
    }
  }

  private async patch(
    projectId: string,
    sessionId: string,
    update: (context: SessionRuntimeContext) => readonly SandboxNetworkApproval[],
    authority?: SandboxNetworkApproval,
    restored = false,
    isCurrent?: () => boolean
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const context = await this.sessions!.readSessionRuntimeContext(projectId, sessionId)
      const next = update(context)
      try {
        await this.sessions!.patchSessionRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: context.revision,
          patch: { networkApprovals: next.length ? next : undefined },
          sessionStatus:
            next.some(({ state }) => state === 'pending') || context.permission?.state === 'pending'
              ? 'waiting-permission'
              : restored
                ? 'idle'
                : 'running',
          ...(authority
            ? {
                beforePersist: (session: PersistedChatSession) => {
                  if (isCurrent?.() === false)
                    throw new Error('Network approval execution is no longer current.')
                  this.assertBound(session, authority)
                }
              }
            : {})
        })
        await this.publish?.(await this.sessions!.loadSessionForContinuation(projectId, sessionId))
        return
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'revision-conflict'
          ) ||
          attempt === 4
        )
          throw error
      }
    }
  }
}
