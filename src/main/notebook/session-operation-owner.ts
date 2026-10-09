import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ReconcilePendingArtifactsRequest } from '../../shared/artifacts'
import { redactSensitiveText } from '../../shared/diagnostic-redaction'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { NotebookRunProvenanceContext } from '../../shared/notebook'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { ArtifactTurnOwner, ArtifactTurnHandle } from '../acp/artifact-turn-owner'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type {
  RuntimeSessionOwner,
  RuntimeSessionTurnScope
} from '../session-persistence/runtime-session-owner'
import {
  readDurableJsonFile,
  writeDurableJsonFile,
  DurableJsonRecoveryBarrierError
} from '../storage/durable-json-file'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import type { NotebookRunRepository } from './repository'
import {
  createManagedExecutionOutputWriter,
  type ManagedExecutionOutput,
  type ManagedExecutionRecoveryOutput,
  type ManagedExecutionRecoveredOutput
} from './managed-execution-output'

import {
  saveAuxiliaryOutput,
  type AuxiliaryOutput,
  type AuxiliaryOutputResult
} from './managed-auxiliary-output'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const scopeSchema = z
  .object({ projectId: identity, sessionId: identity, requestId: identity })
  .strict()
const provenanceSchema = z
  .object({
    rootFrameId: identity,
    agentFrameId: identity,
    messageBranchId: identity,
    runtimeSegmentId: identity,
    promptMessageId: identity
  })
  .strict()
const recordSchema = scopeSchema
  .extend({
    schemaVersion: z.literal(1),
    operationId: identity,
    requestFingerprint: digest,
    requestText: z.string().min(1).max(32768),
    status: z.enum([
      'admitting',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    ]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    provenance: provenanceSchema.optional(),
    notebookRunIds: z.array(identity).max(1000),
    artifactVersionIds: z.array(identity).max(1000),
    artifactRunId: identity.optional(),
    resultText: z.string().max(32768).optional(),
    error: z.string().max(4096).optional(),
    recoveryPending: z.boolean().optional()
  })
  .strict()

export type SessionOperationScope = z.infer<typeof scopeSchema>
export type SessionOperationSnapshot = z.infer<typeof recordSchema>
export type SessionOperationOutput = ManagedExecutionOutput
export type SessionOperationContext = Readonly<{
  operationId: string
  projectId: string
  sessionId: string
  workspaceCwd: string
  notebookDataDir: string
  provenanceContext: Readonly<NotebookRunProvenanceContext>
  recordRun(runId: string): Promise<void>
  saveOutput(output: SessionOperationOutput): Promise<ArtifactVersionFile>
  /** Main-owned optional inline evidence; failures are explicit and still fully drained. */
  saveAuxiliaryOutput?(output: AuxiliaryOutput): Promise<AuxiliaryOutputResult>
  recoverOutput(output: ManagedExecutionRecoveryOutput): Promise<ManagedExecutionRecoveredOutput>
}>
export type StartSessionOperation = SessionOperationScope & {
  // Main computes this from the validated operation, never from a caller-supplied digest alone.
  requestFingerprint: string
  requestText: string
  // A trusted composition adapter: it must drain its owned work before settling this promise.
  execute(
    context: SessionOperationContext,
    signal: AbortSignal
  ): Promise<{
    text: string
    /** Trusted execution outcome, independent of whether this owner initiated cancellation. */
    status?: 'completed' | 'failed' | 'cancelled'
  }>
}
export type SessionOperationDependencies = {
  dataRoot: string
  sessions: {
    read(
      scope: Pick<SessionOperationScope, 'projectId' | 'sessionId'>
    ): Promise<PersistedChatSession | undefined>
    mutate(
      scope: Pick<SessionOperationScope, 'projectId' | 'sessionId'>,
      change: (session: PersistedChatSession) => PersistedChatSession
    ): Promise<PersistedChatSession>
  }
  runtimeSessions: Pick<
    RuntimeSessionOwner,
    'begin' | 'accept' | 'flush' | 'publish' | 'commitTerminal'
  >
  artifactTurns: Pick<ArtifactTurnOwner, 'openExecution' | 'snapshot' | 'finalize' | 'dispose'>
  artifacts: Pick<ArtifactProvenanceRepository, 'saveVersion' | 'replayVersion' | 'listRunVersions'>
  notebooks: Pick<NotebookRunRepository, 'readSessionDocuments'>
  // Composition owns admission against ACP, deletion, export and application shutdown.
  reserveSession(
    scope: Pick<SessionOperationScope, 'projectId' | 'sessionId'>,
    onCancel?: () => void
  ): Promise<() => void>
  // Reuses Notebook process receipts. Rejection preserves recoveryPending and blocks new work.
  recoverNotebookOperations(
    scope: Pick<SessionOperationScope, 'projectId' | 'sessionId'>
  ): Promise<void>
  retryArtifactFinalization(request: ReconcilePendingArtifactsRequest): Promise<unknown>
  onChanged?(snapshot: SessionOperationSnapshot): void
  now?: () => number
}

type LiveOperation = {
  record: SessionOperationSnapshot
  controller: AbortController
  publication: AbortController
  completion: Promise<void>
  writes: Promise<void>
}
const terminal = (status: SessionOperationSnapshot['status']): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const operationKey = (scope: SessionOperationScope): string =>
  hash(JSON.stringify([scope.projectId, scope.sessionId, scope.requestId]))
const errorText = (error: unknown): string =>
  redactSensitiveText(
    error instanceof Error ? error.message : 'Managed Session operation failed.'
  ).slice(0, 4096)

/** Main-owned ordinary Session operations. No provider, model or independent Session kind. */
export class SessionOperationOwner {
  private readonly live = new Map<string, LiveOperation>()
  private readonly admissions = new Map<string, Promise<unknown>>()
  private readonly admissionScopes = new Map<string, SessionOperationScope>()
  private closed = false
  private quiescing?: Promise<void>
  private readonly admissionControllers = new Map<
    string,
    { scope: SessionOperationScope; controller: AbortController }
  >()
  private readonly cancelledSessions = new Set<string>()
  private recovering?: Promise<void>

  constructor(private readonly dependencies: SessionOperationDependencies) {}

  private path(scope: SessionOperationScope): string {
    return join(this.dependencies.dataRoot, 'session-operations', `${operationKey(scope)}.json`)
  }

  private async read(scope: SessionOperationScope): Promise<SessionOperationSnapshot | undefined> {
    const result = await readDurableJsonFile(
      this.path(scope),
      (text) => {
        const parsed = recordSchema.safeParse(JSON.parse(text))
        if (!parsed.success)
          throw new DurableJsonRecoveryBarrierError('Invalid Session operation receipt.')
        if (operationKey(parsed.data) !== operationKey(scope))
          throw new DurableJsonRecoveryBarrierError('Session operation receipt identity mismatch.')
        return parsed.data
      },
      {},
      { maxBytes: 1024 * 1024 }
    )
    return result.status === 'found' ? result.value : undefined
  }

  private async write(record: SessionOperationSnapshot): Promise<void> {
    await writeDurableJsonFile(this.path(record), JSON.stringify(recordSchema.parse(record)))
    try {
      this.dependencies.onChanged?.(structuredClone(record))
    } catch {
      /* Observers do not own execution. */
    }
  }

  private update(
    live: LiveOperation,
    patch:
      | Partial<SessionOperationSnapshot>
      | ((record: SessionOperationSnapshot) => Partial<SessionOperationSnapshot>)
  ): Promise<void> {
    const work = live.writes.then(async () => {
      const change = typeof patch === 'function' ? patch(live.record) : patch
      const next = { ...live.record, ...change, updatedAt: this.dependencies.now?.() ?? Date.now() }
      await this.write(next)
      live.record = next
    })
    live.writes = work.catch(() => undefined)
    return work
  }

  async start(request: StartSessionOperation): Promise<SessionOperationSnapshot> {
    const scope = scopeSchema.parse({
      projectId: request.projectId,
      sessionId: request.sessionId,
      requestId: request.requestId
    })
    digest.parse(request.requestFingerprint)
    z.string().min(1).max(32768).parse(request.requestText)
    if (this.recovering) throw new Error('Session operation recovery is in progress.')
    const key = operationKey(scope)
    // Serialize the admission, not the execution. Retries return its durable identity immediately.
    const previous = this.admissions.get(key) ?? Promise.resolve()
    const admitted = previous.catch(() => undefined).then(() => this.admit(request))
    this.admissions.set(key, admitted)
    this.admissionScopes.set(
      key,
      scopeSchema.parse({
        projectId: request.projectId,
        sessionId: request.sessionId,
        requestId: request.requestId
      })
    )
    try {
      return await admitted
    } finally {
      if (this.admissions.get(key) === admitted) {
        this.admissions.delete(key)
        this.admissionScopes.delete(key)
      }
    }
  }

  private async admit(request: StartSessionOperation): Promise<SessionOperationSnapshot> {
    if (this.closed || this.quiescing) throw new Error('Session operation owner is unavailable.')
    if (this.cancelledSessions.has(JSON.stringify([request.projectId, request.sessionId])))
      throw new Error('Session operation admission is cancelled.')
    const existing = this.live.get(operationKey(request))?.record ?? (await this.read(request))
    if (existing) {
      if (
        existing.requestFingerprint !== request.requestFingerprint ||
        existing.requestText !== request.requestText
      )
        throw new Error('Session operation requestId was already used for a different request.')
      return structuredClone(existing)
    }
    if (
      this.closed ||
      this.quiescing ||
      this.cancelledSessions.has(JSON.stringify([request.projectId, request.sessionId]))
    )
      throw new Error('Session operation admission is unavailable.')
    const controller = new AbortController()
    const admissionKey = operationKey(request)
    this.admissionControllers.set(admissionKey, { scope: request, controller })
    let release = (): void => undefined
    let live: LiveOperation | undefined
    try {
      release = await this.dependencies.reserveSession(request, () =>
        controller.abort(new Error('Session operation admission was cancelled.'))
      )
      controller.signal.throwIfAborted()
      await assertResearchSessionWritable(
        this.dependencies.dataRoot,
        request.projectId,
        request.sessionId
      )
      const settledCancellationPrompts = new Set<string>()
      for (const previous of await this.receipts()) {
        if (
          previous.projectId === request.projectId &&
          previous.sessionId === request.sessionId &&
          (!terminal(previous.status) || previous.recoveryPending)
        )
          throw new Error(
            'Session has an unsettled managed operation. Recover it before starting new work.'
          )
        if (
          previous.projectId === request.projectId &&
          previous.sessionId === request.sessionId &&
          previous.status === 'cancelled' &&
          !previous.recoveryPending &&
          previous.provenance
        )
          settledCancellationPrompts.add(previous.provenance.promptMessageId)
      }
      const session = await this.dependencies.sessions.read(request)
      this.assertAvailable(session, settledCancellationPrompts)
      const now = this.dependencies.now?.() ?? Date.now()
      const record: SessionOperationSnapshot = {
        schemaVersion: 1,
        projectId: request.projectId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        requestFingerprint: request.requestFingerprint,
        requestText: request.requestText,
        operationId: `operation-${randomUUID()}`,
        status: 'admitting',
        createdAt: now,
        updatedAt: now,
        notebookRunIds: [],
        artifactVersionIds: []
      }
      controller.signal.throwIfAborted()
      await this.write(record)
      live = {
        record,
        controller,
        publication: new AbortController(),
        writes: Promise.resolve(),
        completion: Promise.resolve()
      }
      this.live.set(operationKey(request), live)
      const admitted = await this.dependencies.sessions.mutate(request, (latest) => {
        controller.signal.throwIfAborted()
        this.assertAvailable(latest, settledCancellationPrompts)
        const current = materializeSessionConversationGraph(latest)
        const graph = current.conversationGraph!
        const frame = graph.frames.find(({ id }) => id === graph.rootFrameId)!
        const branch = graph.branches.find(({ id }) => id === frame.activeBranchId)!
        return applySessionConversationCommands(current, [
          {
            id: `${record.operationId}-request`,
            timestamp: now,
            kind: 'append-user',
            branchId: branch.id,
            parentMessageId: branch.headMessageId,
            message: {
              id: `${record.operationId}-prompt`,
              role: 'user',
              content: request.requestText,
              createdAt: now,
              updatedAt: now,
              status: 'complete',
              eventIds: []
            }
          },
          {
            id: `${record.operationId}-start`,
            timestamp: now,
            kind: 'start-run',
            run: {
              promptMessageId: `${record.operationId}-prompt`,
              startedAt: Math.max(now, (current.runtimeTranscriptLastRun?.startedAt ?? 0) + 1)
            }
          }
        ])
      })
      const graph = admitted.conversationGraph!
      const prompt = graph.messages.find(({ id }) => id === `${record.operationId}-prompt`)!
      const provenance = provenanceSchema.parse({
        rootFrameId: graph.rootFrameId,
        agentFrameId: prompt.agentFrameId,
        messageBranchId: prompt.introducedOnBranchId,
        runtimeSegmentId: prompt.runtimeSegmentId,
        promptMessageId: prompt.id
      })
      await this.update(live, { provenance })
      const turn = this.turnScope(live.record)
      await this.dependencies.runtimeSessions.begin(turn, { reviewOwner: 'task' })
      await this.update(live, { status: live.controller.signal.aborted ? 'cancelling' : 'running' })
      const running = live
      running.completion = this.execute(running, admitted, request).finally(() => {
        this.live.delete(operationKey(request))
        release()
      })
      // Admission returns before the trusted executor starts; its exceptions are recorded, not unhandled.
      void running.completion.catch(() => undefined)
      return structuredClone(running.record)
    } catch (error) {
      try {
        if (live) {
          let recoveryPending = true
          try {
            const durable = await this.dependencies.sessions.read(request)
            recoveryPending = !!durable?.conversationGraph?.messages.some(
              ({ id }) => id === `${live!.record.operationId}-prompt`
            )
          } catch {
            /* Unreadable authority must retain the recovery fence. */
          }
          await this.update(live, {
            status: recoveryPending ? 'interrupted' : 'failed',
            error: errorText(error),
            recoveryPending
          })
        }
      } finally {
        this.live.delete(operationKey(request))
        release()
      }
      throw error
    } finally {
      this.admissionControllers.delete(admissionKey)
    }
  }

  private assertAvailable(
    session: PersistedChatSession | undefined,
    settledCancellationPrompts: ReadonlySet<string>
  ): asserts session is PersistedChatSession {
    if (!session) throw new Error('Session not found.')
    if (session.packageOrigin) throw new Error('Imported research history is read-only.')
    if (session.archivedAt != null) throw new Error('Archived Session is not writable.')
    const recovery = session.resumeRecovery
    // A new request may follow this owner's fully settled cancellation. Unknown/provider recovery
    // remains fenced; start-run consumes only the old marker and retains the prior turn outcome.
    const settledCancellation =
      recovery?.cause === 'cancelled' &&
      !!recovery.promptMessageId &&
      settledCancellationPrompts.has(recovery.promptMessageId) &&
      (session.conversationGraph?.messages ?? session.messages).find(
        ({ id }) => id === recovery.promptMessageId
      )?.turnOutcome?.kind === 'cancelled'
    if (
      session.activeRun ||
      session.status === 'running' ||
      session.promptPreparation ||
      (recovery && !settledCancellation) ||
      session.runtimeContext?.permission?.state === 'pending' ||
      session.runtimeContext?.plan?.approval === 'pending'
    )
      throw new Error('Session has active or unsettled work.')
  }

  private turnScope(record: SessionOperationSnapshot): RuntimeSessionTurnScope {
    if (!record.provenance) throw new Error('Session operation has no admitted provenance.')
    return {
      ...record.provenance,
      projectId: record.projectId,
      sessionId: record.sessionId,
      executionId: record.operationId
    }
  }

  private async execute(
    live: LiveOperation,
    session: PersistedChatSession,
    request: StartSessionOperation
  ): Promise<void> {
    let handle: ArtifactTurnHandle | undefined
    let executionError: unknown
    let executionFailed = false
    let resultText = ''
    let reportedStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
    const scope = this.turnScope(live.record)
    const provenance = live.record.provenance!
    const pending = new Set<Promise<unknown>>()
    let accepting = true
    let outputError: unknown
    let outputFailed = false
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(new Error('Session operation has already settled.'))
      const work = Promise.resolve().then(operation)
      pending.add(work)
      void work.then(
        () => pending.delete(work),
        (error) => {
          pending.delete(work)
          if (!outputFailed) outputError = error
          outputFailed = true
        }
      )
      return work
    }
    try {
      live.controller.signal.throwIfAborted()
      const graph = session.conversationGraph!
      const messageAncestry = resolveMessageBranchPath(graph, provenance.messageBranchId).map(
        ({ id }) => id
      )
      handle = await this.dependencies.artifactTurns.openExecution({
        executionId: live.record.operationId,
        appSessionId: session.id,
        artifactStorageSessionId: session.id,
        projectId: session.projectId,
        workspaceCwd: session.cwd,
        agentName: 'External controller',
        provenanceContext: { ...provenance, messageAncestry }
      })
      const artifactRunId = this.dependencies.artifactTurns.snapshot(handle).runId
      await this.update(live, { artifactRunId })
      const writer = createManagedExecutionOutputWriter(
        this.dependencies,
        {
          projectId: session.projectId,
          sessionId: session.id,
          operationId: live.record.operationId,
          workspaceCwd: session.cwd,
          artifactRunId,
          artifactStorageSessionId: session.id,
          writeNamespace: live.record.operationId,
          provenanceContext: provenance,
          messageAncestry
        },
        live.publication.signal,
        {
          onRun: (runId) =>
            this.update(live, (record) => ({
              notebookRunIds: [...new Set([...record.notebookRunIds, runId])]
            })),
          onArtifact: (artifact) =>
            this.update(live, (record) => ({
              artifactVersionIds: [...new Set([...record.artifactVersionIds, artifact.versionId])]
            }))
        }
      )
      const context: SessionOperationContext = Object.freeze({
        operationId: live.record.operationId,
        projectId: session.projectId,
        sessionId: session.id,
        workspaceCwd: session.cwd,
        notebookDataDir: writer.notebookDataDir,
        provenanceContext: Object.freeze({ ...provenance }),
        recordRun: (runId: string) => track(() => writer.recordRun(runId)),
        saveOutput: (output: SessionOperationOutput) => track(() => writer.saveOutput(output)),
        saveAuxiliaryOutput: (output: AuxiliaryOutput) =>
          track(() => saveAuxiliaryOutput(output, (value) => writer.saveOutput(value))),
        recoverOutput: (output: ManagedExecutionRecoveryOutput) =>
          track(() => writer.recoverOutput(output))
      })
      const result = await request.execute(context, live.controller.signal)
      resultText = z.string().max(32768).parse(result.text)
      reportedStatus = z
        .enum(['completed', 'failed', 'cancelled'])
        .parse(result.status ?? 'completed')
      if (reportedStatus !== 'completed') {
        executionFailed = true
        executionError = new Error(resultText || 'Managed operation did not complete.')
      }
      live.controller.signal.throwIfAborted()
    } catch (error) {
      executionError = error
      executionFailed = true
    } finally {
      accepting = false
      await Promise.allSettled([...pending])
      if (!executionFailed && outputFailed) {
        executionError = outputError
        executionFailed = true
      }
    }
    try {
      const status = executionFailed
        ? live.controller.signal.aborted || reportedStatus === 'cancelled'
          ? 'cancelled'
          : 'failed'
        : 'completed'
      const text = executionFailed
        ? status === 'cancelled'
          ? 'Managed operation cancelled.'
          : 'Managed operation failed.'
        : resultText || 'Managed operation completed.'
      this.dependencies.runtimeSessions.accept({
        id: `${scope.executionId}-result`,
        timestamp: Date.now(),
        kind: 'message',
        level: 'info',
        sessionId: session.id,
        promptMessageId: scope.promptMessageId,
        promptExecutionId: scope.executionId,
        messageId: `${scope.executionId}-result`,
        role: 'assistant',
        text
      })
      await this.dependencies.runtimeSessions.flush(session.id, scope.promptMessageId)
      if (handle) {
        const publication = await this.dependencies.artifactTurns.finalize(handle)
        if (publication)
          await this.dependencies.runtimeSessions.publish({
            ...publication,
            executionId: scope.executionId
          })
        await this.dependencies.artifactTurns.dispose(handle)
        handle = undefined
      }
      await this.finishTurn(live.record, status)
      await this.update(live, {
        status,
        resultText: text,
        ...(executionFailed ? { error: errorText(executionError) } : {})
      })
    } catch (error) {
      await this.update(live, {
        status: 'interrupted',
        recoveryPending: true,
        error: errorText(error)
      })
    } finally {
      live.publication.abort(new Error('Session operation publication settled.'))
      if (handle) await this.dependencies.artifactTurns.dispose(handle).catch(() => undefined)
    }
  }

  private async finishTurn(
    record: SessionOperationSnapshot,
    status: 'completed' | 'failed' | 'cancelled'
  ): Promise<void> {
    const failed = status === 'failed'
    const scope = this.turnScope(record)
    const event: AcpRuntimeEvent = {
      id: `${record.operationId}-terminal`,
      timestamp: Date.now(),
      kind: failed ? 'error' : 'stop',
      level: failed ? 'error' : 'info',
      sessionId: record.sessionId,
      promptMessageId: scope.promptMessageId,
      promptExecutionId: record.operationId,
      title: failed
        ? 'Managed operation failed'
        : status === 'cancelled'
          ? 'Managed operation cancelled'
          : 'Managed operation completed',
      // Use the existing ACP stop reason so the persisted turn and its UI retain cancellation.
      text: failed
        ? 'Managed operation did not complete.'
        : status === 'cancelled'
          ? 'cancelled'
          : 'end_turn'
    }
    await this.dependencies.runtimeSessions.commitTerminal(event, () => undefined)
    await this.dependencies.runtimeSessions.flush(record.sessionId, scope.promptMessageId)
    const current = await this.dependencies.sessions.read(record)
    if (current?.activeRun?.promptMessageId === scope.promptMessageId)
      throw new Error('Session operation terminal state is not durably committed.')
  }

  async get(scope: SessionOperationScope): Promise<SessionOperationSnapshot | undefined> {
    scopeSchema.parse(scope)
    return structuredClone(this.live.get(operationKey(scope))?.record ?? (await this.read(scope)))
  }

  async wait(scope: SessionOperationScope): Promise<SessionOperationSnapshot | undefined> {
    scopeSchema.parse(scope)
    await this.admissions.get(operationKey(scope))?.catch(() => undefined)
    await this.live.get(operationKey(scope))?.completion
    return this.get(scope)
  }

  async cancel(scope: SessionOperationScope): Promise<SessionOperationSnapshot | undefined> {
    scopeSchema.parse(scope)
    await this.admissions.get(operationKey(scope))?.catch(() => undefined)
    const live = this.live.get(operationKey(scope))
    if (live && !terminal(live.record.status)) {
      live.controller.abort(new Error('Managed operation cancelled.'))
      await this.update(live, (record) => (terminal(record.status) ? {} : { status: 'cancelling' }))
    }
    return this.get(scope)
  }

  private async receipts(): Promise<SessionOperationSnapshot[]> {
    const records: SessionOperationSnapshot[] = []
    const directory = join(this.dependencies.dataRoot, 'session-operations')
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
      const receipt = await readDurableJsonFile(
        join(directory, entry.name),
        (text) => {
          const parsed = recordSchema.safeParse(JSON.parse(text))
          if (!parsed.success)
            throw new DurableJsonRecoveryBarrierError('Invalid Session operation receipt.')
          return parsed.data
        },
        {},
        { maxBytes: 1024 * 1024 }
      )
      if (receipt.status === 'missing') continue
      const record = receipt.value
      if (`${operationKey(record)}.json` !== entry.name)
        throw new Error('Session operation receipt identity mismatch.')
      records.push(record)
    }
    return records
  }

  private async recoverArtifacts(record: SessionOperationSnapshot): Promise<void> {
    if (!record.artifactRunId) return
    const versions = await this.dependencies.artifacts.listRunVersions({
      projectId: record.projectId,
      appSessionId: record.sessionId,
      artifactRunId: record.artifactRunId
    })
    if (!versions.length) {
      if (record.artifactVersionIds.length)
        throw new Error('Managed operation Artifact Versions are unavailable.')
      return
    }
    const expected = new Set(versions.map(({ versionId }) => versionId))
    if (record.artifactVersionIds.some((id) => !expected.has(id)))
      throw new Error('Managed operation Artifact Versions are incomplete.')
    const session = await this.dependencies.sessions.read(record)
    if (!session) throw new Error('Artifact recovery requires its original Session.')
    const messages = session.conversationGraph?.messages ?? []
    const linked = messages.filter((message) => message.artifactIds?.some((id) => expected.has(id)))
    const owners = linked.length
      ? linked
      : messages.filter(
          (message) =>
            message.role === 'agent' &&
            message.responseToMessageId === record.provenance?.promptMessageId &&
            message.agentFrameId === record.provenance?.agentFrameId &&
            message.runtimeSegmentId === record.provenance?.runtimeSegmentId
        )
    // The existing publisher durably stages the owner Message before finalization. Without that
    // proof, preserve the versions for repair; never invent a Message or silently discard evidence.
    if (owners.length !== 1)
      throw new Error(
        'Artifact publication has no unique durable owner Message; recovery is required.'
      )
    const message = owners[0]
    await this.dependencies.retryArtifactFinalization({
      projectId: record.projectId,
      sessionId: record.sessionId,
      messageId: message.id,
      pendingPaths: versions.map(({ path }) => path),
      artifactVersionIds: [...expected]
    })
    const published = await this.dependencies.artifacts.listRunVersions({
      projectId: record.projectId,
      appSessionId: record.sessionId,
      artifactRunId: record.artifactRunId
    })
    const recovered = await this.dependencies.sessions.read(record)
    const attachedIds = recovered?.messages.find(({ id }) => id === message.id)?.artifactIds ?? []
    const attached = (recovered?.artifacts ?? []).filter(({ id }) => attachedIds.includes(id))
    if (
      [...expected].some(
        (id) =>
          !published.some((version) => version.versionId === id && version.isPublished) ||
          !attached.some(
            (artifact) =>
              artifact.versionId === id &&
              !artifact.path?.replaceAll('\\', '/').includes('/.pending/')
          )
      )
    )
      throw new Error('Artifact publication remains unconfirmed after recovery.')
  }

  recover(): Promise<void> {
    if (!this.recovering) {
      const recovery = Promise.allSettled([...this.admissions.values()]).then(() =>
        this.recoverReceipts()
      )
      this.recovering = recovery.finally(() => {
        this.recovering = undefined
      })
    }
    return this.recovering
  }

  private async recoverReceipts(): Promise<void> {
    for (let record of await this.receipts()) {
      if (
        this.live.has(operationKey(record)) ||
        (terminal(record.status) && !record.recoveryPending)
      )
        continue
      let recoveryPending = true
      let error =
        'Open Science stopped before this operation settled. The command was not replayed.'
      try {
        await this.dependencies.recoverNotebookOperations(record)
        await this.recoverArtifacts(record)
        const session = await this.dependencies.sessions.read(record)
        // Admission may have committed the prompt immediately before its receipt write was lost.
        const graph = session?.conversationGraph
        const prompt = graph?.messages.find(({ id }) => id === `${record.operationId}-prompt`)
        if (!record.provenance && graph && prompt) {
          record = {
            ...record,
            provenance: provenanceSchema.parse({
              rootFrameId: graph.rootFrameId,
              agentFrameId: prompt.agentFrameId,
              messageBranchId: prompt.introducedOnBranchId,
              runtimeSegmentId: prompt.runtimeSegmentId,
              promptMessageId: prompt.id
            })
          }
        }
        if (record.provenance) {
          const runs = (
            await this.dependencies.notebooks.readSessionDocuments(
              record.projectId,
              record.sessionId
            )
          ).flatMap(({ runs }) => runs)
          record = {
            ...record,
            notebookRunIds: [
              ...new Set([
                ...record.notebookRunIds,
                ...runs
                  .filter((run) =>
                    Object.entries(record.provenance!).every(
                      ([key, value]) => run[key as keyof z.infer<typeof provenanceSchema>] === value
                    )
                  )
                  .map(({ runId }) => runId)
              ])
            ]
          }
        }
        if (
          record.provenance &&
          session?.activeRun?.promptMessageId === record.provenance.promptMessageId
        ) {
          await this.dependencies.runtimeSessions.begin(this.turnScope(record), {
            reviewOwner: 'task'
          })
          await this.finishTurn(record, 'failed')
        }
        recoveryPending = false
      } catch (failure) {
        error = errorText(failure)
      }
      await this.write({
        ...record,
        status: 'interrupted',
        recoveryPending,
        error,
        updatedAt: Date.now()
      })
    }
  }

  async cancelSession(
    scope: Pick<SessionOperationScope, 'projectId' | 'sessionId'>
  ): Promise<void> {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    this.cancelledSessions.add(key)
    const matches = (other: Pick<SessionOperationScope, 'projectId' | 'sessionId'>): boolean =>
      other.projectId === scope.projectId && other.sessionId === scope.sessionId
    try {
      const admissions = [...this.admissions]
        .filter(([requestKey]) => {
          const pendingScope = this.admissionScopes.get(requestKey)
          return !!pendingScope && matches(pendingScope)
        })
        .map(([, work]) => work)
      for (const [requestKey, admission] of this.admissionControllers) {
        if (!matches(admission.scope)) continue
        admission.controller.abort(new Error('Session operation cancelled.'))
        const pending = this.admissions.get(requestKey)
        if (pending) admissions.push(pending)
      }
      for (const live of this.live.values())
        if (matches(live.record)) live.controller.abort(new Error('Session operation cancelled.'))
      await Promise.allSettled(admissions)
      await Promise.allSettled(
        [...this.live.values()]
          .filter((live) => matches(live.record))
          .map((live) => live.completion)
      )
    } finally {
      this.cancelledSessions.delete(key)
    }
  }

  async quiesce(): Promise<void> {
    if (this.quiescing) return this.quiescing
    const work = Promise.resolve().then(async () => {
      for (const { controller } of this.admissionControllers.values())
        controller.abort(new Error('Session operations are quiescing.'))
      for (const live of this.live.values())
        live.controller.abort(new Error('Session operations are quiescing.'))
      await Promise.allSettled([...this.admissions.values()])
      await Promise.allSettled([...this.live.values()].map((live) => live.completion))
    })
    this.quiescing = work
    try {
      await work
    } finally {
      if (this.quiescing === work) this.quiescing = undefined
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.quiesce()
  }
}
