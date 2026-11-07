import { isDeepStrictEqual } from 'node:util'
import {
  resolveMessageBranchPath,
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../../shared/conversation-graph'
import {
  harnessRequestReceiptSchema,
  harnessTurnJournalSchema,
  harnessTurnScopeSchema,
  harnessAssistantMessageSchema,
  harnessToolReceiptSchema,
  type HarnessToolReceipt,
  type HarnessTurnJournal,
  type HarnessTurnScope
} from '../../shared/harness-turn-contract'
import type { PersistedChatSession, PersistedChatMessage } from '../../shared/session-persistence'
import type { HarnessModelObservation } from './harness-model-request'
import { projectHarnessTurnUsage } from './harness-turn-usage'
import type { CompactionProposal } from '@aipoch/agent-harness'
import { buildHarnessContext } from './harness-context'

type MutationPort = {
  mutateRuntimeSession(
    scope: { projectId: string; sessionId: string },
    mutate: (session: PersistedChatSession) => PersistedChatSession
  ): Promise<PersistedChatSession>
}

/** Writes through the Session authority; it owns no independent cache or file. */
export class HarnessTurnJournalOwner {
  private readonly scope: HarnessTurnScope
  private readonly attempts = new Set<string>()

  constructor(
    private readonly persistence: MutationPort,
    scope: HarnessTurnScope
  ) {
    this.scope = harnessTurnScopeSchema.parse(scope)
  }

  private update(
    active: boolean,
    change: (message: PersistedChatMessage, session: PersistedChatSession) => void
  ): Promise<PersistedChatSession> {
    return this.persistence.mutateRuntimeSession(this.scope, (session) => {
      const scope = this.scope
      const graph = session.conversationGraph
      const frame = graph?.frames.find(({ id }) => id === scope.agentFrameId)
      const branch = graph?.branches.find(({ id }) => id === scope.messageBranchId)
      if (
        session.projectId !== scope.projectId ||
        session.id !== scope.sessionId ||
        !graph ||
        !frame ||
        branch?.agentFrameId !== frame.id
      )
        throw new Error('Harness Session scope is unavailable')
      const path = resolveMessageBranchPath(graph, branch.id)
      const index = path.findIndex(({ id }) => id === scope.messageId)
      const message = graph.messages.find(({ id }) => id === scope.messageId)
      if (
        index < 0 ||
        !message ||
        message.role !== 'agent' ||
        message.agentFrameId !== frame.id ||
        message.introducedOnBranchId !== branch.id ||
        message.usageOrigin ||
        path.slice(0, index).findLast(({ role }) => role === 'user')?.id !== scope.promptMessageId
      )
        throw new Error('Harness Message scope is unavailable')
      if (
        active &&
        (graph.activeFrameId !== frame.id ||
          frame.activeBranchId !== branch.id ||
          branch.headMessageId !== message.id)
      )
        throw new Error('Harness branch is no longer active')
      if (message.harnessTurnInvalid) throw new Error('Harness request journal is invalid')
      change(message, session)
      return {
        ...session,
        messages: resolveActiveConversationMessages(graph).map(projectConversationMessage)
      }
    })
  }

  private journal(message: PersistedChatMessage): HarnessTurnJournal {
    const journal = harnessTurnJournalSchema.parse(message.harnessTurn)
    if (!isDeepStrictEqual(journal.scope, this.scope)) throw new Error('Stale harness generation')
    return journal
  }

  begin(): Promise<PersistedChatSession> {
    return this.update(true, (message) => {
      if (message.harnessTurn) {
        if (this.journal(message).status !== 'running')
          throw new Error('Harness turn already settled')
        return
      }
      if (message.status !== 'streaming' || message.turnUsage || message.modelCallUsage)
        throw new Error('Harness requires a new agent Message')
      message.harnessTurn = {
        schemaVersion: 1,
        scope: this.scope,
        status: 'running',
        attemptedRequests: 0,
        requests: []
      }
    })
  }

  async observe(
    input: HarnessModelObservation,
    purpose: 'answer' | 'summary' = 'answer'
  ): Promise<void> {
    const event = harnessRequestReceiptSchema.parse(input)
    if (!isDeepStrictEqual(event.route, this.scope.route))
      throw new Error('Mismatched harness route')
    if (event.status === 'started') this.attempts.add(event.requestId)
    await this.update(event.status === 'started', (message) => {
      const journal = this.journal(message)
      const index = journal.requests.findIndex(({ requestId }) => requestId === event.requestId)
      const existing = journal.requests[index]
      if (
        existing &&
        (journal.summaryRequestIds?.includes(event.requestId) ?? false) !== (purpose === 'summary')
      )
        throw new Error('Harness request purpose changed')
      if (existing && isDeepStrictEqual(existing, event)) return
      if (journal.status !== 'running') throw new Error('Harness turn already settled')
      if (existing) {
        if (
          existing.status !== 'started' ||
          event.status === 'started' ||
          !isDeepStrictEqual(
            { ...existing, status: event.status, usage: event.usage, httpStatus: event.httpStatus },
            { ...event, usage: event.usage, httpStatus: event.httpStatus }
          )
        )
          throw new Error('Invalid harness request transition')
        journal.requests[index] = event
      } else {
        if (event.status !== 'started') throw new Error('Harness request has no durable start')
        journal.requests.push(event)
        if (purpose === 'summary') (journal.summaryRequestIds ??= []).push(event.requestId)
      }
      journal.attemptedRequests = Math.max(
        journal.attemptedRequests,
        this.attempts.size,
        journal.requests.length
      )
      message.harnessTurn = harnessTurnJournalSchema.parse(journal)
    })
  }

  async recordResponse(requestId: string, input: unknown): Promise<void> {
    const response = { requestId, message: harnessAssistantMessageSchema.parse(input) }
    await this.update(false, (message) => {
      const journal = this.journal(message)
      const existing = journal.transcript?.responses.find((item) => item.requestId === requestId)
      if (existing && isDeepStrictEqual(existing, response)) return
      if (existing || journal.status !== 'running')
        throw new Error('Harness response is already settled')
      journal.transcript ??= { responses: [], tools: [] }
      journal.transcript.responses.push(response)
      journal.contextRevision = (journal.contextRevision ?? 0) + 1
      message.harnessTurn = harnessTurnJournalSchema.parse(journal)
      if (response.message.content) message.content += response.message.content
    })
  }

  async recordTool(input: HarnessToolReceipt): Promise<void> {
    const receipt = harnessToolReceiptSchema.parse(input)
    await this.update(receipt.status === 'started' || receipt.status === 'denied', (message) => {
      const journal = this.journal(message)
      const transcript = journal.transcript
      if (!transcript) throw new Error('Harness tool has no durable response')
      const index = transcript.tools.findIndex((tool) => tool.callId === receipt.callId)
      const existing = transcript.tools[index]
      // A repeated start must never authorize a second execution, even after an ambiguous write.
      if (existing && receipt.status !== 'started' && isDeepStrictEqual(existing, receipt)) return
      if (journal.status !== 'running') throw new Error('Harness turn already settled')
      if (existing) {
        if (
          existing.status !== 'started' ||
          existing.requestId !== receipt.requestId ||
          !['completed', 'unknown'].includes(receipt.status)
        )
          throw new Error('Invalid harness tool transition')
        transcript.tools[index] = receipt
      } else {
        if (!['started', 'denied'].includes(receipt.status))
          throw new Error('Harness tool has no durable intent')
        transcript.tools.push(receipt)
      }
      journal.contextRevision = (journal.contextRevision ?? 0) + 1
      message.harnessTurn = harnessTurnJournalSchema.parse(journal)
    })
  }

  async commitCompaction(proposal: CompactionProposal, signal: AbortSignal): Promise<boolean> {
    let committed = false
    await this.update(false, (message, session) => {
      if (signal.aborted) return
      const journal = this.journal(message)
      if (journal.status !== 'running') return
      let current
      try {
        current = buildHarnessContext(session, this.scope)
      } catch {
        return
      }
      if (!isDeepStrictEqual(current, proposal.expected)) return
      const source = current.items.slice(0, proposal.sourceIds.length)
      if (
        !source.length ||
        source.length >= current.items.length ||
        source.some((item, index) => item.id !== proposal.sourceIds[index]) ||
        proposal.replacement.kind !== 'summary' ||
        !proposal.replacement.text.trim() ||
        current.items.some((item) => item.id === proposal.replacement.id) ||
        !isDeepStrictEqual(proposal.items, [
          proposal.replacement,
          ...current.items.slice(source.length)
        ]) ||
        proposal.afterTokens >= proposal.beforeTokens
      )
        throw new Error('Invalid harness compaction proposal')
      const pending = new Set<string>()
      for (const item of source) {
        if (item.kind === 'tool-call') pending.add(item.callId)
        if (item.kind === 'tool-result') pending.delete(item.callId)
      }
      if (pending.size) throw new Error('Harness compaction splits a tool call')
      ;(journal.compactions ??= []).push({
        id: proposal.replacement.id,
        text: proposal.replacement.text,
        sourceIds: [...proposal.sourceIds],
        sourceRevision: current.revision,
        beforeTokens: proposal.beforeTokens,
        afterTokens: proposal.afterTokens
      })
      journal.contextRevision = (journal.contextRevision ?? 0) + 1
      message.harnessTurn = harnessTurnJournalSchema.parse(journal)
      committed = true
    })
    return committed
  }

  settle(status: Exclude<HarnessTurnJournal['status'], 'running'>): Promise<PersistedChatSession> {
    return this.update(false, (message) => {
      const journal = this.journal(message)
      if (journal.status !== 'running' && journal.status !== status)
        throw new Error('Harness turn already settled')
      if (journal.status === status) return
      journal.status = status
      journal.attemptedRequests = Math.max(journal.attemptedRequests, this.attempts.size)
      if (
        status === 'complete' &&
        (journal.requests.length !== journal.attemptedRequests ||
          journal.requests.some((request) => request.status !== 'completed'))
      )
        throw new Error('Harness completion has unsettled requests')
      if (status === 'complete') {
        const { responses, tools } = journal.transcript ?? { responses: [], tools: [] }
        const answerRequests = journal.requests.filter(
          (request) => !journal.summaryRequestIds?.includes(request.requestId)
        )
        const lastId = [...answerRequests].sort((a, b) => a.step - b.step).at(-1)?.requestId
        const last = responses.find((response) => response.requestId === lastId)
        if (
          responses.length !== answerRequests.length ||
          !last ||
          last.message.tool_calls?.length ||
          responses.some((response) =>
            response.message.tool_calls?.some(
              (call) =>
                !tools.some(
                  (tool) => tool.callId === call.id && ['completed', 'denied'].includes(tool.status)
                )
            )
          )
        )
          throw new Error('Harness completion has unsettled tools or responses')
      }
      message.harnessTurn = harnessTurnJournalSchema.parse(journal)
      message.status = status === 'complete' ? 'complete' : 'error'
      if (status === 'complete') message.completedAt = Date.now()
      else message.failedAt = Date.now()
      Object.assign(
        message,
        journal.requests.length
          ? projectHarnessTurnUsage({
              turnId: journal.requests[0].turnId,
              route: journal.scope.route,
              requestCount: journal.attemptedRequests,
              observations: journal.requests
            })
          : { turnUsage: undefined, modelCallUsage: undefined, turnUsageUnavailable: true }
      )
    })
  }
}
