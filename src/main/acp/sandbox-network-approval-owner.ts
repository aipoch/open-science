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

// Owns only destination authority. The provider permission slot and its tool replay stay separate.
export class SandboxNetworkApprovalOwner {
  private readonly liveRequests = new Map<
    string,
    { abort: AbortController; settled: Promise<void> }
  >()
  private readonly cancellationStates = new Map<string, { active: boolean }>()
  private readonly globalDecisions = new Map<
    string,
    {
      projectId: string
      sessionId: string
      abort: AbortController
      isCommitted: () => boolean
      done: Promise<void>
      rollbackFailure?: AggregateError
    }
  >()

  constructor(
    private readonly sessions?: PermissionWaitSessions,
    private readonly publish?: PublishPermissionWaitSession,
    private readonly allowDomain?: (
      hostname: string,
      assertCurrent?: () => Promise<void>,
      finalize?: () => Promise<void>
    ) => Promise<unknown>
  ) {}

  async request(
    input: AppPermissionRequest,
    promptMessageId: string | undefined,
    send: (input: AppPermissionRequest) => Promise<string | undefined>,
    isCurrent: () => boolean = () => !input.signal?.aborted
  ): Promise<string | undefined> {
    const network = input.networkApproval
    if (!network || !this.sessions || !promptMessageId || input.signal?.aborted) return undefined
    const current = this.cancellationGuard(network.projectId, input.sessionId, isCurrent)
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
        current
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
      current
    )
    if (!current() || input.signal?.aborted) {
      await this.patch(network.projectId, input.sessionId, (context) =>
        (context.networkApprovals ?? []).filter(({ requestId }) => requestId !== approval.requestId)
      )
      return undefined
    }
    // The durable row exists before the broker exposes its request to any client.
    const request = sandboxNetworkApprovalRequest(approval)
    let admitted = false
    const recoveryAbort = new AbortController()
    const settled = Promise.withResolvers<void>()
    this.liveRequests.set(approval.requestId, { abort: recoveryAbort, settled: settled.promise })
    try {
      return await send({
        ...input,
        signal: input.signal
          ? AbortSignal.any([input.signal, recoveryAbort.signal])
          : recoveryAbort.signal,
        onAdmitted: () => {
          input.onAdmitted?.()
          admitted = true
        },
        ...request,
        durable: true,
        beforeRespond: async (optionId) => {
          if (optionId === 'always-allow') {
            await this.grantGlobal(network.projectId, approval, false, current)
            return
          }
          await this.patch(
            network.projectId,
            input.sessionId,
            (context) => {
              if (
                context.networkApprovals?.some(
                  (candidate) =>
                    candidate.requestId === approval.requestId &&
                    candidate.decision === 'always-allow'
                )
              )
                throw new Error('Network approval was already answered.')
              return (context.networkApprovals ?? []).flatMap((candidate) =>
                candidate.requestId !== approval.requestId
                  ? [candidate]
                  : optionId === 'allow-once' &&
                      !input.signal?.aborted &&
                      input.canResume?.() === false
                    ? [{ ...candidate, state: 'continuing' as const }]
                    : []
              )
            },
            optionId === 'allow-once' ? approval : undefined
          )
        }
      })
    } finally {
      this.liveRequests.delete(approval.requestId)
      settled.resolve()
      if (!admitted) {
        await this.patch(network.projectId, input.sessionId, (context) =>
          (context.networkApprovals ?? []).filter(
            (candidate) =>
              candidate.requestId !== approval.requestId || candidate.state !== 'pending'
          )
        )
      }
    }
  }

  async respondRestored(response: AcpPermissionResponse, projectId: string): Promise<boolean> {
    if (!this.sessions || !response.restored || response.restored.projectId !== projectId)
      return false
    const isCurrent = this.cancellationGuard(projectId, response.restored.sessionId)
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
      await this.grantGlobal(projectId, approval, true, isCurrent)
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
      true,
      isCurrent
    )
    return true
  }

  // Called by host Session hydration, without creating a provider connection or replaying a tool.
  async recoverSession(session: PersistedChatSession): Promise<PersistedChatSession> {
    if (
      !this.sessions ||
      !session.runtimeContext?.networkApprovals?.some(
        (approval) => approval.state === 'continuing' && approval.decision === 'always-allow'
      )
    )
      return session
    const context = await this.sessions.readSessionRuntimeContext(session.projectId, session.id)
    for (const approval of context.networkApprovals ?? []) {
      if (approval.state !== 'continuing' || approval.decision !== 'always-allow') continue
      const live = this.globalDecisions.get(approval.requestId)
      if (live && !live.rollbackFailure) {
        // Never take over a live choice. Concurrent recovery readers may join an already saved one.
        if (live.isCommitted()) await live.done
        continue
      }
      await this.grantGlobal(session.projectId, approval, true, () => true, true)
      const request = this.liveRequests.get(approval.requestId)
      if (request) {
        // A failed live Settings rollback may have left its broker wait pending. Recovery only
        // finishes authorization: settle that old operation through the broker's existing abort
        // path, which publishes settlement and requires an explicit command retry.
        request.abort.abort()
        await request.settled
      }
    }
    return this.sessions.loadSessionForContinuation(session.projectId, session.id)
  }

  async cancel(projectId: string, sessionId: string): Promise<void> {
    if (!this.sessions) return
    const cancellation = { active: true }
    this.cancellationStates.set(JSON.stringify([projectId, sessionId]), cancellation)
    try {
      const decisions = [...this.globalDecisions.values()].filter(
        (decision) => decision.projectId === projectId && decision.sessionId === sessionId
      )
      for (const decision of decisions) {
        if (!decision.isCommitted()) decision.abort.abort()
      }
      // Settings owns a serialized write/rollback transaction. Do not finish cancellation while
      // a revoked decision can still persist or hot-apply authority.
      const results = await Promise.allSettled(decisions.map(({ done }) => done))
      for (const result of results) {
        // A rejected decision normally means revocation succeeded. Failed Settings rollback is
        // different: preserve its durable row and surface the failure instead of claiming a Stop.
        if (result.status === 'rejected' && result.reason instanceof AggregateError)
          throw result.reason
      }
      let context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
      if (!context.networkApprovals?.length) return
      if (context.networkApprovals.some((approval) => approval.decision === 'always-allow')) {
        // A decision saved by a prior process is already consent, not an unanswered request.
        await this.recoverSession(
          await this.sessions.loadSessionForContinuation(projectId, sessionId)
        )
        context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
        if (!context.networkApprovals?.length) return
      }
      await this.patch(projectId, sessionId, () => [], undefined, true)
    } finally {
      cancellation.active = false
    }
  }

  private cancellationGuard(
    projectId: string,
    sessionId: string,
    isCurrent: () => boolean = () => true
  ): () => boolean {
    const key = JSON.stringify([projectId, sessionId])
    const generation = this.cancellationStates.get(key)
    const admitted = !generation?.active
    return () => admitted && this.cancellationStates.get(key) === generation && isCurrent()
  }

  private assertBound(session: PersistedChatSession, approval: SandboxNetworkApproval): void {
    if (
      !activeSandboxNetworkApprovals({
        ...materializeSessionConversationGraph(session),
        runtimeContext: { networkApprovals: [approval] }
      }).length
    )
      throw new Error('Network approval is not on the active Message Branch.')
  }

  private grantGlobal(
    projectId: string,
    approval: SandboxNetworkApproval,
    restored = false,
    isCurrent: () => boolean = () => true,
    recovering = false
  ): Promise<void> {
    const previous = this.globalDecisions.get(approval.requestId)
    if (previous && !previous.rollbackFailure)
      return Promise.reject(new Error('Network approval is already being saved.'))
    const abort = new AbortController()
    let committed = recovering
    let rollbackFailure: AggregateError | undefined
    const done = this.commitGlobal(
      projectId,
      approval,
      restored,
      () => !abort.signal.aborted && isCurrent(),
      () => {
        committed = true
      },
      recovering
    )
      .catch((error: unknown) => {
        if (error instanceof AggregateError) rollbackFailure = error
        throw error
      })
      .finally(() => {
        const decision = this.globalDecisions.get(approval.requestId)
        if (decision?.done !== done) return
        // A repeated Stop must not erase evidence of an unsuccessful rollback. Session hydration
        // can retry the saved Global decision and reconcile both durable stores.
        if (rollbackFailure) decision.rollbackFailure = rollbackFailure
        else this.globalDecisions.delete(approval.requestId)
      })
    this.globalDecisions.set(approval.requestId, {
      projectId,
      sessionId: approval.sessionId,
      abort,
      isCommitted: () => committed,
      done
    })
    return done
  }

  private async commitGlobal(
    projectId: string,
    approval: SandboxNetworkApproval,
    restored: boolean,
    isCurrent: () => boolean,
    markCommitted: () => void,
    recovering: boolean
  ): Promise<void> {
    if (!this.allowDomain) throw new Error('Network settings are unavailable.')
    // A recovery resumes saved consent; a live response first claims an unanswered request.
    if (!recovering)
      await this.patch(
        projectId,
        approval.sessionId,
        (context) => {
          const current = context.networkApprovals?.find(
            ({ requestId }) => requestId === approval.requestId
          )
          if (current?.state !== 'pending')
            throw new Error('Network approval is no longer pending.')
          return context.networkApprovals!.map((candidate) =>
            candidate.requestId === approval.requestId
              ? { ...candidate, state: 'continuing' as const, decision: 'always-allow' as const }
              : candidate
          )
        },
        approval,
        restored,
        isCurrent
      )
    const alreadySettled = new Error('Saved network approval was already settled.')
    let authorityValidated = !recovering
    try {
      await this.allowDomain(
        approval.hostname,
        async () => {
          if (!isCurrent()) throw new Error('Network approval execution is no longer current.')
          const session = await this.sessions!.loadSessionForContinuation(
            projectId,
            approval.sessionId
          )
          // The raw durable decision is authoritative, including after process loss.
          const context = await this.sessions!.readSessionRuntimeContext(
            projectId,
            approval.sessionId
          )
          const current = context.networkApprovals?.find(
            ({ requestId }) => requestId === approval.requestId
          )
          if (current?.state !== 'continuing' || current.decision !== 'always-allow') {
            // A catalog snapshot may outlive another reader's completed transaction. The Settings
            // owner runs this first guard before writing; never resurrect that settled decision.
            if (!authorityValidated) throw alreadySettled
            throw new Error('Network approval is no longer current.')
          }
          if (!isCurrent()) throw new Error('Network approval is no longer current.')
          authorityValidated = true
          if (!recovering) this.assertBound(session, approval)
        },
        async () => {
          await this.patch(
            projectId,
            approval.sessionId,
            (context) =>
              (context.networkApprovals ?? []).filter(
                ({ requestId }) => requestId !== approval.requestId
              ),
            recovering ? undefined : approval,
            recovering ? 'preserve' : restored,
            isCurrent
          )
          if (!isCurrent()) throw new Error('Network approval execution is no longer current.')
          // This synchronous fence is the commit point. Later Stop preserves completed consent.
          markCommitted()
        }
      )
    } catch (error) {
      if (error === alreadySettled) return
      try {
        await this.patch(
          projectId,
          approval.sessionId,
          (context) => {
            const retry: SandboxNetworkApproval =
              recovering || error instanceof AggregateError
                ? { ...approval, state: 'continuing', decision: 'always-allow' }
                : { ...approval, state: 'pending' }
            const approvals = context.networkApprovals ?? []
            if (!approvals.some(({ requestId }) => requestId === approval.requestId)) {
              if (approvals.length >= 32) throw new Error('Too many pending network approvals.')
              return [...approvals, retry]
            }
            return approvals.map((candidate) => {
              if (
                candidate.requestId !== approval.requestId ||
                candidate.decision !== 'always-allow'
              )
                return candidate
              if (retry.decision === 'always-allow') return retry
              const { decision: _decision, ...rest } = retry
              void _decision
              return rest
            })
          },
          undefined,
          recovering ? 'preserve' : restored
        )
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Could not restore the network approval.')
      }
      throw error
    }
  }

  private async patch(
    projectId: string,
    sessionId: string,
    update: (context: SessionRuntimeContext) => readonly SandboxNetworkApproval[],
    authority?: SandboxNetworkApproval,
    restored: boolean | 'preserve' = false,
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
            restored === 'preserve'
              ? undefined
              : next.some(({ state }) => state === 'pending') ||
                  context.permission?.state === 'pending'
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
