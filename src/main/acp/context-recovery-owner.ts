import { randomUUID } from 'node:crypto'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import type {
  AcpContextRecoveryState,
  AcpCreateSessionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest
} from '../../shared/acp'
import { classifyContextOverflowError } from '../../shared/media-overflow'
import type {
  PersistedChatSession,
  SessionContextRecoveryRecord
} from '../../shared/session-persistence'
import { validateRecoveryContinuationSafety, type RecoveryHandoff } from './recovery-handoff'

export const recoverySourceBranch = (session: PersistedChatSession): string => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const branch = graph?.branches.find(({ id }) => id === frame?.activeBranchId)
  return JSON.stringify([graph?.activeFrameId, frame?.activeBranchId, branch?.headMessageId])
}

export type RecoveryResumeDecision =
  | { kind: 'normal' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'restored'; response: AcpCreateSessionResponse }

export type ContextRecoveryDependencies = {
  load: (sessionId: string) => Promise<PersistedChatSession>
  ensureRuntime?: (session: PersistedChatSession, assertCurrent: () => void) => Promise<void>
  save: (
    sessionId: string,
    record: SessionContextRecoveryRecord,
    providerSessionId: string | undefined,
    expectedRecoveryId: string | null
  ) => Promise<void>
  prepare: (
    session: PersistedChatSession,
    request?: AcpPromptRequest
  ) => RecoveryHandoff | Promise<RecoveryHandoff>
  adoptExistingCandidate?: (
    request: AcpResumeSessionRequest,
    hooks: {
      assertCurrent: () => void
      onBeforeCommit: (providerSessionId: string) => Promise<void>
      onCommitFailed: (providerSessionId: string, error: unknown) => Promise<void>
    }
  ) => Promise<AcpCreateSessionResponse | void>
  compact: (sessionId: string) => Promise<PromptResponse>
  replace: (
    request: AcpResumeSessionRequest,
    hooks: {
      assertCurrent: () => void
      onCandidateCreated: (providerSessionId: string) => Promise<void>
      onBeforeCommit: (providerSessionId: string) => Promise<void>
      onCommitFailed: (providerSessionId: string, error: unknown) => Promise<void>
    }
  ) => Promise<unknown>
  admitContinuation?: (request: AcpPromptRequest) => Promise<AcpPromptRequest>
  abandonContinuation?: (sessionId: string) => Promise<void>
  rollbackBinding?: (
    sessionId: string,
    record: SessionContextRecoveryRecord,
    providerSessionId: string
  ) => Promise<void>
  continue: (request: AcpPromptRequest) => Promise<PromptResponse>
  changed: () => void
}

/** One episode owns compaction, replacement and dispatch. Concurrent calls join it. Persist-before-
 * dispatch makes a restart fail closed whenever a continuation's execution outcome is unknown. */
export class AcpContextRecoveryOwner {
  private readonly active = new Map<string, { signal: AbortController; promise: Promise<void> }>()
  private readonly reconciliations = new Map<string, Promise<RecoveryResumeDecision>>()
  private readonly reconciliationSignals = new Map<string, AbortController>()
  private readonly states = new Map<string, AcpContextRecoveryState>()
  constructor(private readonly deps: ContextRecoveryDependencies) {}

  snapshot(): Record<string, AcpContextRecoveryState> {
    return Object.fromEntries(this.states)
  }
  activeSessionIds(): string[] {
    return [...new Set([...this.active.keys(), ...this.reconciliations.keys()])]
  }
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.reconciliations.has(sessionId)
  }
  cancel(sessionId: string): void {
    this.active.get(sessionId)?.signal.abort()
    this.reconciliationSignals.get(sessionId)?.abort()
  }
  cancelAll(): void {
    for (const id of this.activeSessionIds()) this.cancel(id)
  }

  recover(
    sessionId: string,
    failure?: { error: unknown; request: AcpPromptRequest }
  ): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing) return existing.promise
    const signal = new AbortController()
    const promise = this.run(sessionId, signal.signal, failure).finally(() => {
      if (this.active.get(sessionId)?.signal === signal) {
        this.active.delete(sessionId)
        this.deps.changed()
      }
    })
    this.active.set(sessionId, { signal, promise })
    return promise
  }

  assertContinuationAllowed(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (
      !this.active.has(sessionId) &&
      state &&
      ['blocked', 'failed', 'cancelled'].includes(state.phase)
    ) {
      throw new Error(
        state.reason ?? 'Context recovery must complete before continuing the interrupted turn.'
      )
    }
  }

  async prepareUserPrompt(request: AcpPromptRequest): Promise<AcpPromptRequest> {
    if (this.isActive(request.sessionId))
      throw new Error('Context recovery is already running for this session.')
    const session = await this.deps.load(request.sessionId)
    if (session.runtimeContext?.contextRecovery?.phase !== 'ready') return request
    const prepared = await this.deps.prepare(session, request)
    if (prepared.status === 'blocked') throw new Error(prepared.reason)
    return {
      ...request,
      historyPreamble: prepared.historyText,
      contextReset: true,
      attachments: [...(request.attachments ?? []), ...(prepared.uploads ?? [])]
    }
  }

  async completeUserPrompt(sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) return
    const session = await this.deps.load(sessionId)
    const record = session.runtimeContext?.contextRecovery
    if (record?.phase === 'ready') await this.persist(sessionId, { ...record, phase: 'completed' })
  }

  reconcile(sessionId: string, owned = false): Promise<RecoveryResumeDecision> {
    const existing = this.reconciliations.get(sessionId)
    if (existing) return existing
    const controller = new AbortController()
    this.reconciliationSignals.set(sessionId, controller)
    const promise = this.reconcileRecord(sessionId, owned, controller.signal).finally(() => {
      if (this.reconciliations.get(sessionId) === promise) {
        this.reconciliations.delete(sessionId)
        this.reconciliationSignals.delete(sessionId)
        this.deps.changed()
      }
    })
    this.reconciliations.set(sessionId, promise)
    return promise
  }

  private async reconcileRecord(
    sessionId: string,
    owned: boolean,
    signal: AbortSignal
  ): Promise<RecoveryResumeDecision> {
    if (!owned && this.active.has(sessionId))
      return { kind: 'blocked', reason: 'Context recovery is already running for this session.' }
    const session = await this.deps.load(sessionId)
    const record = session.runtimeContext?.contextRecovery
    if (!record) return { kind: 'normal' }
    if (
      record.candidateProviderSessionId &&
      (record.phase === 'replacing' || record.phase === 'ready')
    ) {
      try {
        if (!this.deps.adoptExistingCandidate)
          throw new Error('Existing candidate adoption is unavailable.')
        if (record.phase === 'replacing' && recoverySourceBranch(session) !== record.sourceBranch)
          throw new Error('The conversation changed before candidate adoption.')
        const assertSource = async (): Promise<void> => {
          signal.throwIfAborted()
          if (
            record.phase === 'replacing' &&
            recoverySourceBranch(await this.deps.load(sessionId)) !== record.sourceBranch
          )
            throw new Error('The conversation changed before candidate adoption.')
        }
        const response = await this.deps.adoptExistingCandidate(
          {
            sessionId,
            projectId: session.projectId,
            cwd: session.cwd,
            providerSessionId: record.candidateProviderSessionId,
            permissionProfile: session.permissionProfile,
            memoryEnabled: session.memoryEnabled,
            specialistId: session.specialistId,
            previousFrameworkId: session.agentFrameworkId,
            previousBackendId: session.agentBackendId,
            ...(session.agentConfiguration
              ? { agentTarget: { frameworkId: 'opencode', ...session.agentConfiguration } }
              : {})
          },
          {
            assertCurrent: () => signal.throwIfAborted(),
            onBeforeCommit: async (id) => {
              await assertSource()
              if (record.phase === 'replacing')
                await this.persist(sessionId, { ...record, phase: 'ready', reason: undefined }, id)
            },
            onCommitFailed: async (id) => {
              if (record.phase === 'replacing')
                await this.deps.rollbackBinding?.(sessionId, record, id)
            }
          }
        )
        this.project(sessionId, { ...record, phase: 'ready', reason: undefined })
        return {
          kind: 'restored',
          response: response ?? {
            sessionId,
            providerSessionId: record.candidateProviderSessionId,
            cwd: session.cwd,
            frameworkId: 'opencode'
          }
        }
      } catch (error) {
        await this.persist(sessionId, {
          ...record,
          phase: 'blocked',
          reason: `The recorded recovery candidate could not be safely adopted: ${error instanceof Error ? error.message : String(error)}`
        })
      }
      return {
        kind: 'blocked',
        reason: this.states.get(sessionId)?.reason ?? 'Recovery candidate adoption failed.'
      }
    }
    if (['compacting', 'preparing', 'replacing', 'continuing'].includes(record.phase)) {
      const reason =
        record.phase === 'continuing'
          ? 'Recovery continuation outcome is unknown. Verify completed operations before continuing.'
          : 'Context recovery was interrupted. Recover the session explicitly to continue.'
      await this.persist(sessionId, { ...record, phase: 'blocked', reason })
      return { kind: 'blocked', reason }
    }
    this.project(sessionId, record)
    if (
      record.phase === 'blocked' &&
      (record.reason?.startsWith('The recorded recovery candidate could not be safely adopted:') ||
        record.reason?.startsWith('Recovery continuation outcome is unknown'))
    )
      return { kind: 'blocked', reason: record.reason ?? 'Context recovery is blocked.' }
    return { kind: 'normal' }
  }

  private project(sessionId: string, record: SessionContextRecoveryRecord): void {
    this.states.set(sessionId, {
      phase: record.phase,
      canRetry:
        record.phase === 'blocked' &&
        record.reason ===
          'Context recovery was interrupted. Recover the session explicitly to continue.',
      ...(record.reason ? { reason: record.reason } : {})
    })
    this.deps.changed()
  }
  private async persist(
    sessionId: string,
    record: SessionContextRecoveryRecord,
    providerSessionId?: string,
    expectedRecoveryId: string | null = record.id
  ): Promise<void> {
    await this.deps.save(sessionId, record, providerSessionId, expectedRecoveryId)
    this.project(sessionId, record)
  }

  private async run(
    sessionId: string,
    signal: AbortSignal,
    failure?: { error: unknown; request: AcpPromptRequest }
  ): Promise<void> {
    let session = await this.deps.load(sessionId)
    if (session.runtimeContext?.contextRecovery?.phase === 'replacing') {
      await this.reconcile(sessionId, true)
      session = await this.deps.load(sessionId)
    }
    if (session.agentFrameworkId !== 'opencode')
      throw new Error('Context recovery is only supported for OpenCode sessions.')
    const previous = session.runtimeContext?.contextRecovery
    if (
      previous?.reason?.startsWith('The recorded recovery candidate could not be safely adopted:')
    ) {
      this.project(sessionId, previous)
      return
    }
    if (
      !failure &&
      previous?.phase === 'ready' &&
      previous.sourceBranch === recoverySourceBranch(session)
    ) {
      this.project(sessionId, previous)
      return
    }
    // Never infer that an interrupted dispatch failed. Explicit recovery also cannot replay it.
    if (
      previous?.phase === 'continuing' ||
      previous?.reason?.startsWith('Recovery continuation outcome is unknown')
    ) {
      await this.persist(sessionId, {
        ...previous,
        phase: 'blocked',
        reason:
          'Recovery continuation outcome is unknown. Verify completed operations before continuing.'
      })
      return
    }
    if (
      failure &&
      previous?.failedPromptMessageId &&
      previous.failedPromptMessageId === failure.request.provenanceContext?.promptMessageId
    ) {
      this.project(sessionId, previous)
      return
    }
    let record: SessionContextRecoveryRecord = {
      version: 1,
      id: randomUUID(),
      sourceBranch: recoverySourceBranch(session),
      sourceRevision: session.revision ?? 0,
      compactAttempts: 0,
      replacementAttempts: 0,
      oldProviderSessionId: session.providerSessionId ?? session.id,
      failedPromptMessageId: failure?.request.provenanceContext?.promptMessageId,
      phase: 'preparing'
    }
    const assertCurrent = (): void => signal.throwIfAborted()
    const checkpoint = async (): Promise<void> => {
      assertCurrent()
      if (recoverySourceBranch(await this.deps.load(sessionId)) !== record.sourceBranch)
        throw new Error('The conversation branch changed during context recovery.')
      assertCurrent()
    }
    const update = async (
      patch: Partial<SessionContextRecoveryRecord>,
      binding?: string
    ): Promise<void> => {
      record = { ...record, ...patch }
      await this.persist(sessionId, record, binding)
    }
    let continuationAdmitted = false
    let continuationDispatched = false
    try {
      await this.persist(sessionId, record, undefined, previous?.id ?? null)
      await this.deps.ensureRuntime?.(session, assertCurrent)
      await checkpoint()
      let compacted = false
      const classification = failure
        ? classifyContextOverflowError(failure.error)
        : 'compaction-exhausted'
      if (classification === 'context-overflow') {
        await update({ phase: 'compacting', compactAttempts: 1 })
        try {
          compacted = (await this.deps.compact(sessionId)).stopReason === 'end_turn'
        } catch {
          /* One unsuccessful native attempt permits one replacement. */
        }
        await checkpoint()
      }
      const prepared: RecoveryHandoff = compacted
        ? (validateRecoveryContinuationSafety(session) ?? {
            status: 'ready' as const,
            text: failure?.request.text ?? '',
            historyText: '',
            estimatedTokens: 0
          })
        : await this.deps.prepare(session, failure?.request)
      if (prepared.status === 'blocked') {
        await update({ phase: 'blocked', reason: prepared.reason })
        return
      }
      await checkpoint()
      if (!compacted) {
        await update({ phase: 'replacing', replacementAttempts: 1 })
        await this.deps.replace(
          {
            sessionId,
            projectId: session.projectId,
            cwd: session.cwd,
            providerSessionId: session.providerSessionId,
            previousFrameworkId: session.agentFrameworkId,
            previousBackendId: session.agentBackendId,
            permissionProfile: session.permissionProfile,
            memoryEnabled: session.memoryEnabled,
            specialistId: session.specialistId,
            ...(session.agentConfiguration
              ? { agentTarget: { frameworkId: 'opencode', ...session.agentConfiguration } }
              : {})
          },
          {
            assertCurrent,
            onCandidateCreated: async (id) => {
              await update({ candidateProviderSessionId: id })
              await checkpoint()
            },
            onBeforeCommit: async (id) => {
              await checkpoint()
              await update({ candidateProviderSessionId: id, phase: 'ready' }, id)
              assertCurrent()
            },
            onCommitFailed: async (id, error) => {
              record = {
                ...record,
                phase: signal.aborted ? 'cancelled' : 'failed',
                reason: error instanceof Error ? error.message : String(error)
              }
              await this.deps.rollbackBinding?.(sessionId, record, id)
            }
          }
        )
        await checkpoint()
      }
      const promptMessageId =
        failure?.request.provenanceContext?.promptMessageId ?? prepared.pendingPromptMessageId
      if (!promptMessageId) {
        await update({ phase: 'ready' })
        return
      }
      await update({ phase: 'continuing', failedPromptMessageId: promptMessageId })
      await checkpoint()
      let continuation: AcpPromptRequest = {
        ...failure?.request,
        sessionId,
        text: compacted
          ? `Continue the interrupted task using the retained context and verified completed results.\n\n${failure?.request.text ?? ''}`
          : prepared.text,
        contextReset: !compacted,
        attachments: [...(failure?.request.attachments ?? []), ...(prepared.uploads ?? [])],
        historyPreamble: undefined,
        historyAttachments: undefined,
        historyImages: undefined,
        resumeFallback: undefined,
        permissionPrompts: failure?.request.permissionPrompts,
        memoryEnabled: session.memoryEnabled,
        provenanceContext: failure?.request.provenanceContext ?? { promptMessageId }
      }
      if (this.deps.admitContinuation) {
        continuation = await this.deps.admitContinuation(continuation)
        continuationAdmitted = true
      }
      assertCurrent()
      continuationDispatched = true
      const response = await this.deps.continue(continuation)
      await update({
        phase:
          response.stopReason === 'cancelled'
            ? 'cancelled'
            : response.stopReason === 'end_turn'
              ? 'completed'
              : 'failed',
        ...(response.stopReason !== 'end_turn' && response.stopReason !== 'cancelled'
          ? { reason: `Recovery continuation stopped: ${response.stopReason}` }
          : {})
      })
    } catch (error) {
      if (continuationAdmitted && !continuationDispatched)
        await this.deps.abandonContinuation?.(sessionId)
      await update({
        phase: continuationDispatched ? 'blocked' : signal.aborted ? 'cancelled' : 'failed',
        reason: continuationDispatched
          ? 'Recovery continuation outcome is unknown. Verify completed operations before continuing.'
          : error instanceof Error
            ? error.message
            : String(error)
      })
    }
  }
}
