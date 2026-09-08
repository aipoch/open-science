import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookCell,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunInputFile,
  NotebookRunRecord,
  NotebookRunProvenanceContext,
  NotebookRunSource,
  NotebookRunStatus,
  ShellRuntimeBinding,
  NotebookWorkingFile,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { ExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import type { Logger } from '../logger'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import {
  EnvironmentManifestPublicationError,
  EnvironmentStateTracker,
  type EnvironmentCaptureTarget
} from './environment-state-tracker'
import { detectManagedRuntimeMutation } from './managed-runtime-guard'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import { notebookLaneKey, notebookLaneScope } from './lane-identity'
import { NotebookRunSubmissionConflictError } from './repository'
import type {
  NotebookSessionAggregate,
  NotebookSessionExecutionResult,
  NotebookSessionMcpRpcConnection,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'
import { notebookInterpreterIdentity } from './session-aggregate'
import {
  NotebookShellProcessAdapter,
  buildShellEnv,
  type NotebookShellProcess,
  type NotebookShellResult
} from './shell-process'
import { prepareNotebookWorkloadCache } from './notebook-workload-cache-paths'
import { startWorkingFileObservation } from './working-file-observer'
import type { TransientViewImage } from './host-view-image-service'
import {
  unavailableNotebookDependencyProjection,
  type NotebookDependencyInterpreter,
  type NotebookDependencyProjection
} from './dependency-analysis'
import type { NotebookHelperModuleHost, NotebookHelperModuleScope } from './helper-module-host'
import { getNotebookFileEvidenceLocation } from './repository'
import { getNotebookInputRoot } from './input-staging'
import {
  captureShellRuntimeBinding,
  defaultShellRuntimeBinding,
  shellRuntimePlatform
} from './shell-runtime'

type NotebookControlResult = Pick<
  NotebookSessionExecutionResult,
  'stdout' | 'stderr' | 'traceback' | 'outputs' | 'truncated' | 'workingFiles' | 'fileEvidence'
> & {
  status: Exclude<NotebookRunStatus, 'queued' | 'running'>
  viewImages?: readonly TransientViewImage[]
}

type NotebookControlCompletionInterceptor = {
  intercept<T>(options: {
    context: {
      sessionId: string
      turnId: string
      controlInvocationGeneration: number
      toolInvocationId: string
      originatingTurnId?: string
      originatingUserMessageId?: string
      attachmentIds?: string[]
      artifactIds?: string[]
    }
    execute(): Promise<T>
  }): Promise<{ kind: 'deliver'; result: T } | { kind: 'captured' }>
}

class NotebookControlCompletionCapturedError extends Error {
  constructor() {
    super('Control tool completion was captured for specialist handoff.')
    this.name = 'NotebookControlCompletionCapturedError'
  }
}

type McpRpcConnectionBinding = {
  sessionId: string
  projectId: string
  agentFrameId: string
  attemptId?: string
  executionCwd: string
}
type McpRpcConnectionResolver = (
  binding: McpRpcConnectionBinding
) => Promise<NotebookSessionMcpRpcConnection>

type NotebookExecutionOwnerOptions = {
  configRoot: string
  storageRoot: string
  runTerminalization: NotebookRunTerminalizationOwner
  dataExecutionAdmission: NotebookDataExecutionAdmissionOwner
  environmentStateTracker: Pick<EnvironmentStateTracker, 'prepareRun' | 'captureCompletedRun'>
  createEnvironmentCaptureTarget: (
    language: NotebookLanguage,
    environment: string,
    binding: NotebookSessionRuntimeBinding | undefined,
    resolvedInterpreter: NotebookSessionResolvedInterpreter | undefined,
    runtimeRoot: string
  ) => EnvironmentCaptureTarget
  setKernelStatus: (
    session: NotebookSessionAggregate,
    status: 'running' | 'idle',
    processKey: string
  ) => void
  persistRecoveredKernelIdle: (
    session: NotebookSessionAggregate,
    processKey: string
  ) => Promise<void>
  getMcpRpcConnectionResolver: () => McpRpcConnectionResolver | undefined
  notifyAvailable: (session: NotebookSessionAggregate, source: NotebookRunSource) => void
  projectDependencies: (
    session: NotebookSessionAggregate,
    run: NotebookRunRecord,
    interpreter?: NotebookDependencyInterpreter
  ) => Promise<NotebookDependencyProjection>
  helperModules: Pick<
    NotebookHelperModuleHost,
    'preflight' | 'plan' | 'commitInitialized' | 'loadedEvidence'
  >
  logger: Pick<Logger, 'error'> & Partial<Pick<Logger, 'info'>>
  platform?: NodeJS.Platform
  shellProcess?: NotebookShellProcess
  shellConcurrencyLimit?: number
  shellRuntimeBinding?: ShellRuntimeBinding
}

const errorToExecutionResult = (error: unknown, cwd: string): NotebookSessionExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: 'failed',
    kernelDispatched: false,
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: cwd,
    outputs: [{ type: 'error', message, traceback: message }]
  }
}

const CANCELLED_MESSAGE = 'Run cancelled: the runtime was stopped while this cell was executing.'
const SHELL_CANCELLED_MESSAGE = 'Shell command was cancelled.'
const cancelledExecutionResult = (cwd: string): NotebookSessionExecutionResult => ({
  ...errorToExecutionResult(new Error(CANCELLED_MESSAGE), cwd),
  status: 'cancelled'
})

// Root runtime ownership is Session-scoped, but every durable Run still belongs to the authenticated
// conversation Frame that produced it. A renderer state read may have created the shared owner first.
const runAgentFrameId = (
  session: NotebookSessionAggregate,
  provenanceContext: NotebookRunProvenanceContext | undefined
): string => provenanceContext?.agentFrameId ?? notebookLaneScope(session.lane).agentFrameId

type ImmutableInputIdentity = Pick<
  NotebookRunInputFile,
  | 'inputFileVersionId'
  | 'sourceKind'
  | 'sourceFileId'
  | 'sourceProjectId'
  | 'sourceSessionId'
  | 'filename'
  | 'sizeBytes'
  | 'checksum'
> & {
  sourceVersionNumber: number | null
  contentType: string | null
}

const immutableInputIdentities = (
  inputs: readonly NotebookRunInputFile[] | undefined
): ImmutableInputIdentity[] =>
  (inputs ?? [])
    .map((input) => ({
      inputFileVersionId: input.inputFileVersionId,
      sourceKind: input.sourceKind,
      sourceFileId: input.sourceFileId,
      sourceVersionNumber: input.sourceVersionNumber ?? null,
      sourceProjectId: input.sourceProjectId,
      sourceSessionId: input.sourceSessionId,
      filename: input.filename,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum
    }))
    .sort((left, right) => left.inputFileVersionId.localeCompare(right.inputFileVersionId))

const dataRunFingerprint = (
  session: NotebookSessionAggregate,
  cell: Readonly<NotebookCell>,
  request: RunNotebookCellRequest,
  helperModuleIds: readonly string[] | undefined
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        lane: notebookLaneKey(session.lane),
        code: cell.code,
        language: cell.language,
        ...(request.background ? { executionMode: 'background' } : {}),
        timeoutMs: request.timeoutMs ?? null,
        source: request.source ?? 'agent',
        inputKind: request.inputKind ?? 'cell',
        provenanceContext: request.provenanceContext ?? null,
        allowedHelperSkillIds: [...(request.registeredHelperSkillIds ?? [])].sort(),
        inputFiles: immutableInputIdentities(request.registeredInputFiles),
        helperModuleIds: helperModuleIds ?? []
      })
    )
    .digest('hex')

const controlRunFingerprint = (
  session: NotebookSessionAggregate,
  request: ExecuteNotebookControlRequest
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        lane: notebookLaneKey(session.lane),
        code: request.code,
        ...(request.background ? { executionMode: 'background' } : {}),
        timeoutMs: request.timeoutMs ?? null,
        provenanceContext: request.provenanceContext ?? null,
        inputFiles: immutableInputIdentities(request.registeredInputFiles)
      })
    )
    .digest('hex')

const shellRunFingerprint = (
  session: NotebookSessionAggregate,
  request: ExecuteShellRequest,
  frozenShellContext: NonNullable<NotebookRunRecord['frozenShellContext']>,
  runtimeBinding: ShellRuntimeBinding
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        lane: notebookLaneKey(session.lane),
        command: request.command,
        ...(request.background ? { executionMode: 'background' } : {}),
        provenanceContext: request.provenanceContext ?? null,
        inputFiles: immutableInputIdentities(request.registeredInputFiles),
        frozenShellContext,
        runtimeBinding
      })
    )
    .digest('hex')

const controlResultFromRun = (run: NotebookRunRecord): NotebookControlResult => {
  if (run.status === 'queued' || run.status === 'running') {
    throw new Error(`REPL Run ${run.runId} has no terminal foreground result.`)
  }
  return {
    status: run.status,
    stdout: run.text.stdout,
    stderr: run.text.stderr,
    traceback: run.text.traceback,
    outputs: run.outputs,
    ...(run.truncated ? { truncated: true } : {}),
    workingFiles: run.workingFiles,
    fileEvidence: run.fileEvidence
  }
}

const publicShellResult = (
  run: Pick<
    NotebookRunRecord,
    'text' | 'exitCode' | 'truncated' | 'shellRuntimeStatus' | 'shellErrorCode'
  >
): NotebookShellResult => ({
  stdout: run.text.stdout,
  stderr: run.text.stderr,
  exitCode: run.exitCode ?? null,
  ...(run.shellRuntimeStatus ? { runtimeStatus: run.shellRuntimeStatus } : {}),
  ...(run.shellErrorCode ? { errorCode: run.shellErrorCode } : {}),
  ...(run.truncated ? { truncated: true } : {})
})

type ShellQueueWaiter = {
  sessionId: string
  signal?: AbortSignal
  resolve: (lease: ShellAdmissionLease) => void
  reject: (reason?: unknown) => void
  abort?: () => void
}

type ShellAdmissionLease = Readonly<{
  slot: number
  limit: number
  release: () => void
}>

class BoundedShellAdmission {
  private readonly activeSlotsByProject = new Map<string, Set<number>>()
  private readonly activeSessionsByProject = new Map<string, Set<string>>()
  private readonly queuedByProject = new Map<string, ShellQueueWaiter[]>()

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Shell concurrency limit must be a positive integer.')
    }
  }

  acquire(
    projectId: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<ShellAdmissionLease> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const activeSlots = this.activeSlotsByProject.get(projectId) ?? new Set<number>()
    const activeSessions = this.activeSessionsByProject.get(projectId) ?? new Set<string>()
    if (activeSlots.size < this.limit && !activeSessions.has(sessionId)) {
      const slot = this.nextAvailableSlot(activeSlots)
      activeSlots.add(slot)
      activeSessions.add(sessionId)
      this.activeSlotsByProject.set(projectId, activeSlots)
      this.activeSessionsByProject.set(projectId, activeSessions)
      return Promise.resolve(this.lease(projectId, sessionId, slot))
    }
    return new Promise<ShellAdmissionLease>((resolve, reject) => {
      const waiter: ShellQueueWaiter = { sessionId, signal, resolve, reject }
      waiter.abort = () => {
        const queue = this.queuedByProject.get(projectId)
        const index = queue?.indexOf(waiter) ?? -1
        if (index >= 0) queue?.splice(index, 1)
        if (queue?.length === 0) this.queuedByProject.delete(projectId)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      const queue = this.queuedByProject.get(projectId) ?? []
      queue.push(waiter)
      this.queuedByProject.set(projectId, queue)
    })
  }

  private nextAvailableSlot(activeSlots: ReadonlySet<number>): number {
    for (let slot = 1; slot <= this.limit; slot += 1) {
      if (!activeSlots.has(slot)) return slot
    }
    throw new Error('Shell concurrency slot accounting exceeded its configured limit.')
  }

  private lease(projectId: string, sessionId: string, slot: number): ShellAdmissionLease {
    return { slot, limit: this.limit, release: this.releaseOnce(projectId, sessionId, slot) }
  }

  private releaseOnce(projectId: string, sessionId: string, slot: number): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const activeSlots = this.activeSlotsByProject.get(projectId)
      const activeSessions = this.activeSessionsByProject.get(projectId)
      activeSlots?.delete(slot)
      activeSessions?.delete(sessionId)
      const queue = this.queuedByProject.get(projectId)
      while (queue && queue.length > 0 && activeSlots && activeSlots.size < this.limit) {
        const index = queue.findIndex((waiter) => !activeSessions?.has(waiter.sessionId))
        if (index < 0) break
        const [waiter] = queue.splice(index, 1)
        if (!waiter) break
        waiter.signal?.removeEventListener('abort', waiter.abort!)
        if (waiter.signal?.aborted) continue
        const nextSlot = this.nextAvailableSlot(activeSlots)
        activeSlots.add(nextSlot)
        activeSessions?.add(waiter.sessionId)
        waiter.resolve(this.lease(projectId, waiter.sessionId, nextSlot))
      }
      if (queue?.length === 0) this.queuedByProject.delete(projectId)
      if (activeSlots?.size === 0) this.activeSlotsByProject.delete(projectId)
      if (activeSessions?.size === 0) this.activeSessionsByProject.delete(projectId)
    }
  }

  capacity(): number {
    return this.limit
  }
}

class NotebookExecutionOwner {
  private readonly shellProcess: NotebookShellProcess
  private readonly shellAdmission: BoundedShellAdmission
  private readonly shellRuntimeBinding: ShellRuntimeBinding
  private controlCompletionInterceptor: NotebookControlCompletionInterceptor | undefined
  private readonly activeDataSubmissions = new Map<
    string,
    {
      fingerprint: string
      admitted: Promise<NotebookRunRecord>
      promise: Promise<{
        run: NotebookRunRecord
        dependencyProjection: NotebookDependencyProjection
      }>
    }
  >()
  private readonly activeControlSubmissions = new Map<
    string,
    {
      fingerprint: string
      admitted: Promise<NotebookRunRecord>
      promise: Promise<NotebookControlResult>
    }
  >()
  // Keeps only the latest terminal foreground result per REPL lane. Durable Run history remains the
  // canonical result; this bounded transient copy preserves view-image blocks when a lost local-RPC
  // response retries the same authorized submission during the active app lifetime.
  private readonly completedControlSubmissions = new Map<
    string,
    {
      submissionIdentity: string
      fingerprint: string
      result: NotebookControlResult
    }
  >()
  private readonly activeShellSubmissions = new Map<
    string,
    {
      fingerprint: string
      admitted: Promise<NotebookRunRecord>
      promise: Promise<NotebookShellResult>
    }
  >()
  private readonly liveShellRuns = new Map<
    string,
    {
      projectId: string
      sessionId: string
      laneKey: string
      controller: AbortController
      settled: Promise<boolean>
      requestCancellation: (reason: unknown) => Promise<void>
    }
  >()
  private shellAdmissionGlobalFences = 0
  private readonly shellAdmissionProjectFences = new Map<string, number>()
  private readonly shellAdmissionSessionFences = new Map<string, number>()
  private readonly shellAdmissionLaneFences = new Map<string, number>()

  constructor(private readonly options: NotebookExecutionOwnerOptions) {
    this.shellProcess = options.shellProcess ?? new NotebookShellProcessAdapter(options.platform)
    this.shellAdmission = new BoundedShellAdmission(options.shellConcurrencyLimit ?? 6)
    this.shellRuntimeBinding = captureShellRuntimeBinding(
      options.shellRuntimeBinding ?? defaultShellRuntimeBinding(options.platform)
    )
  }

  private inputRoot(session: NotebookSessionAggregate): string {
    return getNotebookInputRoot(this.options.storageRoot, session.projectId, session.sessionId)
  }

  private fileEvidenceLocation(session: NotebookSessionAggregate): {
    fileEvidenceStorageRoot: string
    fileEvidenceRoot: string
    fileEvidenceStoragePrefix: string
  } {
    const location = getNotebookFileEvidenceLocation(
      this.options.storageRoot,
      session.projectId,
      session.sessionId,
      session.lane
    )
    return {
      fileEvidenceStorageRoot: this.options.storageRoot,
      fileEvidenceRoot: location.root,
      fileEvidenceStoragePrefix: location.storageKeyPrefix
    }
  }

  fenceShellRuns(scope: {
    projectId?: string
    sessionId?: string
    laneKey?: string
    global?: boolean
  }): () => void {
    if (scope.global) {
      this.shellAdmissionGlobalFences += 1
      let released = false
      return () => {
        if (released) return
        released = true
        this.shellAdmissionGlobalFences -= 1
      }
    }
    const entry = scope.laneKey
      ? ([this.shellAdmissionLaneFences, scope.laneKey] as const)
      : scope.sessionId
        ? ([this.shellAdmissionSessionFences, scope.sessionId] as const)
        : scope.projectId
          ? ([this.shellAdmissionProjectFences, scope.projectId] as const)
          : undefined
    if (!entry) throw new Error('Shell admission fence requires a scope.')
    const [fences, key] = entry
    fences.set(key, (fences.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (fences.get(key) ?? 1) - 1
      if (remaining === 0) fences.delete(key)
      else fences.set(key, remaining)
    }
  }

  private assertShellAdmissionAvailable(session: NotebookSessionAggregate): void {
    if (
      this.shellAdmissionGlobalFences > 0 ||
      this.shellAdmissionProjectFences.has(session.projectId) ||
      this.shellAdmissionSessionFences.has(session.sessionId) ||
      this.shellAdmissionLaneFences.has(notebookLaneKey(session.lane))
    ) {
      throw new Error('Notebook Shell admission is closed for teardown.')
    }
  }

  async cancelShellRuns(
    scope: { projectId?: string; sessionId?: string; laneKey?: string },
    reason: unknown
  ): Promise<{ reaped: boolean }> {
    const runs = Array.from(this.liveShellRuns.values()).filter(
      (run) =>
        (scope.projectId === undefined || run.projectId === scope.projectId) &&
        (scope.sessionId === undefined || run.sessionId === scope.sessionId) &&
        (scope.laneKey === undefined || run.laneKey === scope.laneKey)
    )
    const cancellationWrites = await Promise.allSettled(
      runs.map((run) => run.requestCancellation(reason))
    )
    for (const run of runs) run.controller.abort(reason)
    const settlements = await Promise.allSettled(runs.map((run) => run.settled))
    const failures = cancellationWrites.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Shell cancellation intent could not be persisted.')
    }
    return {
      reaped: settlements.every((result) => result.status === 'fulfilled' && result.value)
    }
  }

  setControlCompletionInterceptor(
    interceptor: NotebookControlCompletionInterceptor | undefined
  ): void {
    this.controlCompletionInterceptor = interceptor
  }
  async executeDataCell(
    session: NotebookSessionAggregate,
    request: RunNotebookCellRequest,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[],
    onAdmitted?: (run: NotebookRunRecord) => void
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    // Snapshot caller-owned inputs before the first queue/preparation/persistence wait.
    // The host-owned input lease stays live so resolver access reaches the completed run.
    const { registeredInputFiles, ...submittedRequest } = request
    const executionRequest = { ...structuredClone(submittedRequest), registeredInputFiles }
    const executionHelperIds = helperModuleIds?.slice()
    return session.withCellExecution(executionRequest.cellId, async (cell) => {
      const submissionFingerprint = dataRunFingerprint(
        session,
        cell,
        executionRequest,
        executionHelperIds
      )
      let runId: string | undefined
      const submissionIdentity =
        executionRequest.executionInvocationId ??
        (runId = this.options.runTerminalization.allocateRunIdentity().runId)
      const submissionKey = `${notebookLaneKey(session.lane)}:${submissionIdentity}`
      const active = this.activeDataSubmissions.get(submissionKey)
      if (active) {
        if (active.fingerprint !== submissionFingerprint) {
          throw new NotebookRunSubmissionConflictError(submissionIdentity)
        }
        if (onAdmitted) void active.admitted.then(onAdmitted, () => undefined)
        return active.promise
      }
      let resolveAdmitted!: (run: NotebookRunRecord) => void
      let rejectAdmitted!: (error: unknown) => void
      const admitted = new Promise<NotebookRunRecord>((resolve, reject) => {
        resolveAdmitted = resolve
        rejectAdmitted = reject
      })
      // The admission promise is an internal replay seam. The primary execution promise remains the
      // public error surface, so admission failures must not become unhandled when no retry is waiting.
      void admitted.catch(() => undefined)
      const promise = (async () => {
        if (executionRequest.executionInvocationId) {
          const existing = await this.options.runTerminalization.findSubmission(
            session,
            submissionIdentity
          )
          if (existing) {
            if (existing.submissionFingerprint !== submissionFingerprint) {
              throw new NotebookRunSubmissionConflictError(submissionIdentity)
            }
            resolveAdmitted(existing)
            onAdmitted?.(existing)
            const dependencyProjection = await this.options
              .projectDependencies(session, existing)
              .catch(() => unavailableNotebookDependencyProjection([existing]))
            return { run: existing, dependencyProjection }
          }
        }
        runId ??= this.options.runTerminalization.allocateRunIdentity().runId
        return this.executeDataCellDurable(
          session,
          cell,
          executionRequest,
          runId,
          submissionIdentity,
          submissionFingerprint,
          signal,
          executionHelperIds,
          (run) => {
            resolveAdmitted(run)
            onAdmitted?.(run)
          }
        )
      })().catch((error) => {
        rejectAdmitted(error)
        throw error
      })
      const entry = { fingerprint: submissionFingerprint, admitted, promise }
      this.activeDataSubmissions.set(submissionKey, entry)
      try {
        return await promise
      } finally {
        if (this.activeDataSubmissions.get(submissionKey) === entry) {
          this.activeDataSubmissions.delete(submissionKey)
        }
      }
    })
  }

  private async executeDataCellDurable(
    session: NotebookSessionAggregate,
    cell: Readonly<NotebookCell>,
    request: RunNotebookCellRequest,
    runId: string,
    submissionIdentity: string,
    submissionFingerprint: string,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[],
    onAdmitted?: (run: NotebookRunRecord) => void
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    const admittedAt = Date.now()
    const executionCount = session.nextExecutionCount()
    const cwdBefore = session.cwd
    const admission = await this.options.dataExecutionAdmission.admit(
      session,
      cell,
      (request.source ?? 'agent') === 'agent'
    )
    const { environment, processKey } = admission.route
    const { binding, resolvedInterpreter } = admission
    const kernelStatusBefore = session.kernelStatus(processKey)
    const kernelWasTerminatedAtAdmission =
      session.isKernelTerminated(processKey) ||
      kernelStatusBefore === 'terminated' ||
      session.hasDurableKernelTermination(processKey)
    const kernelEpoch = session.kernelEpoch(
      processKey,
      kernelWasTerminatedAtAdmission,
      notebookInterpreterIdentity(resolvedInterpreter)
    )
    const kernelEpochId = kernelEpoch.id
    const helperModuleScope: NotebookHelperModuleScope = {
      projectId: request.projectId,
      sessionId: request.sessionId,
      ...(request.executionInvocationId && request.registeredHelperSkillIds
        ? { allowedSkillIds: request.registeredHelperSkillIds }
        : {})
    }
    const helperRequest = await this.options.helperModules.preflight(
      cell.language,
      helperModuleIds,
      kernelEpoch,
      helperModuleScope
    )
    const helperPlan = await this.options.helperModules.plan(kernelEpoch, helperRequest)
    const queuedRun: NotebookRunRecord = {
      runId,
      executionMode: request.background ? 'background' : 'foreground',
      submissionIdentity,
      submissionFingerprint,
      admittedAt,
      kernelEpochId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: cell.id,
      source: request.source ?? 'agent',
      inputKind: request.inputKind ?? 'cell',
      kernelKind: cell.language,
      script: cell.code,
      status: 'queued',
      startedAt: admittedAt,
      cwdBefore,
      executionCount,
      environment,
      ...(binding?.source === 'external' ? { runtimeId: binding.runtimeId } : {}),
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }
    queuedRun.frozenPermissionScope = {
      allowedHelperSkillIds: [...(request.registeredHelperSkillIds ?? [])].sort()
    }
    queuedRun.frozenRuntimeTarget = {
      language: cell.language,
      environment,
      processKey,
      ...(binding?.runtimeId ? { runtimeId: binding.runtimeId } : {}),
      ...(binding?.source ? { source: binding.source } : {}),
      ...(binding?.interpreterPath ? { interpreterPath: binding.interpreterPath } : {}),
      ...(resolvedInterpreter?.command ? { command: resolvedInterpreter.command } : {}),
      ...(resolvedInterpreter?.args ? { args: [...resolvedInterpreter.args] } : {}),
      ...(resolvedInterpreter?.condaPrefix ? { condaPrefix: resolvedInterpreter.condaPrefix } : {})
    }
    if (!existsSync(cwdBefore)) {
      this.options.logger.error('session working directory is missing before execution', {
        sessionId: session.sessionId
      })
    }
    signal?.throwIfAborted()
    const durableAdmission = await this.options.runTerminalization.admit({
      session,
      queuedRun,
      signal
    })
    if (!durableAdmission.admitted) {
      onAdmitted?.(durableAdmission.run)
      const dependencyProjection = await this.options
        .projectDependencies(session, durableAdmission.run, resolvedInterpreter)
        .catch(() => unavailableNotebookDependencyProjection([durableAdmission.run]))
      return { run: durableAdmission.run, dependencyProjection }
    }
    onAdmitted?.(durableAdmission.run)
    this.options.notifyAvailable(session, request.source ?? 'agent')

    try {
      return await session.enqueueExecution(
        processKey,
        async () => {
          const kernelWasTerminated =
            kernelWasTerminatedAtAdmission ||
            session.isKernelTerminated(processKey) ||
            session.kernelStatus(processKey) === 'terminated' ||
            session.hasDurableKernelTermination(processKey)
          const kernelMarkedRunning = admission.rejection === undefined
          let executedOnLiveKernel = true
          let reachedExecutor = false
          const terminalized = await this.options.runTerminalization.runAdmitted({
            session,
            // Admission freezes the exact Version identities. The request-owned copies retain only
            // the monotonic access association gathered while that frozen Version is resolved.
            queuedRun: { ...durableAdmission.run, inputFiles: queuedRun.inputFiles },
            startLive: () => {
              session.markCellRunning(cell.id, runId, executionCount)
              if (kernelMarkedRunning) {
                session.clearKernelTerminated(processKey)
                this.options.setKernelStatus(session, 'running', processKey)
              }
            },
            invoke: () =>
              this.options.dataExecutionAdmission.runShared(
                session,
                admission,
                async (rejection) => {
                  if (rejection !== undefined) {
                    executedOnLiveKernel = false
                    return errorToExecutionResult(rejection, cwdBefore)
                  }
                  const target = this.options.createEnvironmentCaptureTarget(
                    cell.language,
                    environment,
                    binding,
                    resolvedInterpreter,
                    session.runtimeRoot
                  )
                  let environmentRunStart
                  try {
                    environmentRunStart =
                      await this.options.environmentStateTracker.prepareRun(target)
                  } catch (error) {
                    executedOnLiveKernel = false
                    return errorToExecutionResult(error, cwdBefore)
                  }
                  reachedExecutor = true
                  let executionResult = await session
                    .execute({
                      runId,
                      code: durableAdmission.run.script,
                      ...(helperPlan.injections.length
                        ? { helperModules: helperPlan.injections }
                        : {}),
                      cwd: cwdBefore,
                      language: cell.language,
                      environment,
                      notebookSessionRoot: session.notebookSessionRoot,
                      inputRoot: this.inputRoot(session),
                      dataRoot: session.dataRoot,
                      ...this.fileEvidenceLocation(session),
                      runtimeRoot: session.runtimeRoot,
                      protectedDirs: [
                        getAppClaudeConfigDir(this.options.configRoot),
                        ...helperPlan.protectedGenerationRoots
                      ],
                      timeoutMs: request.timeoutMs,
                      signal,
                      resolvedInterpreter,
                      sessionId: session.sessionId,
                      projectId: session.projectId,
                      inputRunLeaseId: request.inputRunLeaseId
                    })
                    .catch((error: unknown) => {
                      executedOnLiveKernel = false
                      const fallback =
                        session.consumeForceStopped(processKey) || signal?.aborted
                          ? cancelledExecutionResult(cwdBefore)
                          : errorToExecutionResult(error, cwdBefore)
                      return { ...fallback, kernelDispatched: true }
                    })
                  const forceStopped = session.consumeForceStopped(processKey)
                  if (forceStopped && executionResult.status !== 'completed') {
                    executionResult = {
                      ...cancelledExecutionResult(cwdBefore),
                      kernelDispatched: executionResult.kernelDispatched ?? true
                    }
                  }
                  this.options.helperModules.commitInitialized(
                    kernelEpoch,
                    executionResult.helperModulesInitialized ?? []
                  )
                  const resultWithEvidence = {
                    ...executionResult,
                    ...this.options.helperModules.loadedEvidence(kernelEpoch)
                  }
                  const result =
                    resultWithEvidence.kernelDispatched === undefined
                      ? { ...resultWithEvidence, kernelDispatched: true }
                      : resultWithEvidence
                  if (result.status !== 'completed') return result
                  try {
                    const capture = await this.options.environmentStateTracker.captureCompletedRun(
                      target,
                      result.environmentOverlay,
                      environmentRunStart
                    )
                    return {
                      ...result,
                      environmentCapture: {
                        state:
                          capture.manifest.captureStatus === 'complete' ? 'available' : 'partial',
                        manifestChecksum: capture.checksum,
                        ...(capture.manifest.warnings?.length
                          ? { warnings: [...capture.manifest.warnings] }
                          : {})
                      },
                      environmentManifest: capture.manifest,
                      environmentManifestChecksum: capture.checksum
                    }
                  } catch (error) {
                    return {
                      ...result,
                      environmentCapture: {
                        state: 'unavailable',
                        reason:
                          error instanceof EnvironmentManifestPublicationError
                            ? 'environment-manifest-publication-failed'
                            : 'environment-capture-failed'
                      }
                    }
                  }
                }
              ),
            settleLive: (result) => {
              session.completeCellRun(cell.id, result.status, result.cwdAfter ?? cwdBefore)
              // Live activity ends even if either Run write fails. Only settle this process epoch's
              // running state; lifecycle transitions (termination, restart, error) own their own status.
              if (
                kernelMarkedRunning &&
                session.currentKernelEpochId(processKey) === kernelEpochId &&
                session.kernelStatus(processKey) === 'running' &&
                !session.isKernelTerminated(processKey) &&
                (executedOnLiveKernel || !reachedExecutor)
              ) {
                if (!reachedExecutor && kernelWasTerminated) {
                  session.markKernelTerminated(processKey)
                  session.setKernelStatus(processKey, 'terminated')
                } else if (!reachedExecutor && kernelStatusBefore === 'error') {
                  session.setKernelStatus(processKey, 'error')
                } else {
                  this.options.setKernelStatus(session, 'idle', processKey)
                }
              }
            }
          })
          const run = terminalized.run
          if (
            kernelWasTerminated &&
            session.currentKernelEpochId(processKey) === kernelEpochId &&
            session.kernelStatus(processKey) === 'idle' &&
            !session.isKernelTerminated(processKey)
          ) {
            await this.options.persistRecoveredKernelIdle(session, processKey)
          }
          const dependencyProjection = await this.options
            .projectDependencies(session, run, resolvedInterpreter)
            .catch(() => unavailableNotebookDependencyProjection([run]))
          return { run, dependencyProjection }
        },
        signal
      )
    } catch (error) {
      if (!signal?.aborted) throw error
      const run = await this.options.runTerminalization.cancelQueued(
        session,
        durableAdmission.run,
        signal.reason
      )
      if (run.status === 'queued' || run.status === 'running') {
        throw new Error(`Notebook queued cancellation lost its terminal race: ${run.runId}`)
      }
      session.markCellRunning(cell.id, runId, executionCount)
      session.completeCellRun(cell.id, run.status, run.cwdAfter ?? cwdBefore)
      if (!request.background) throw signal.reason
      const dependencyProjection = await this.options
        .projectDependencies(session, run, resolvedInterpreter)
        .catch(() => unavailableNotebookDependencyProjection([run]))
      return { run, dependencyProjection }
    }
  }
  async executeControl(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    signal?: AbortSignal,
    onAdmitted?: (run: NotebookRunRecord) => void
  ): Promise<NotebookControlResult> {
    const submissionFingerprint = controlRunFingerprint(session, request)
    const initialIdentity = request.executionInvocationId
      ? undefined
      : this.options.runTerminalization.allocateRunIdentity()
    const submissionIdentity = request.executionInvocationId ?? initialIdentity!.runId
    const laneKey = notebookLaneKey(session.lane)
    const submissionKey = `${laneKey}:${submissionIdentity}`
    const active = this.activeControlSubmissions.get(submissionKey)
    if (active) {
      if (active.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      if (onAdmitted) void active.admitted.then(onAdmitted, () => undefined)
      return active.promise
    }
    const completed = this.completedControlSubmissions.get(laneKey)
    if (
      !request.background &&
      request.executionInvocationId &&
      completed?.submissionIdentity === submissionIdentity
    ) {
      if (completed.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      return completed.result
    }

    let resolveAdmitted!: (run: NotebookRunRecord) => void
    let rejectAdmitted!: (error: unknown) => void
    const admitted = new Promise<NotebookRunRecord>((resolve, reject) => {
      resolveAdmitted = resolve
      rejectAdmitted = reject
    })
    void admitted.catch(() => undefined)
    const promise = (async () => {
      if (request.executionInvocationId) {
        const existing = await this.options.runTerminalization.findSubmission(
          session,
          submissionIdentity
        )
        if (existing) {
          if (existing.submissionFingerprint !== submissionFingerprint) {
            throw new NotebookRunSubmissionConflictError(submissionIdentity)
          }
          resolveAdmitted(existing)
          onAdmitted?.(existing)
          return controlResultFromRun(existing)
        }
      }
      const identity = initialIdentity ?? this.options.runTerminalization.allocateRunIdentity()
      return this.executeControlDurable(
        session,
        request,
        identity.runId,
        identity.sequence,
        submissionIdentity,
        submissionFingerprint,
        signal,
        (run) => {
          resolveAdmitted(run)
          onAdmitted?.(run)
        }
      )
    })().catch((error) => {
      rejectAdmitted(error)
      throw error
    })
    const entry = { fingerprint: submissionFingerprint, admitted, promise }
    this.activeControlSubmissions.set(submissionKey, entry)
    try {
      const result = await promise
      if (!request.background && request.executionInvocationId) {
        this.completedControlSubmissions.set(laneKey, {
          submissionIdentity,
          fingerprint: submissionFingerprint,
          result
        })
      }
      return result
    } finally {
      if (this.activeControlSubmissions.get(submissionKey) === entry) {
        this.activeControlSubmissions.delete(submissionKey)
      }
    }
  }

  private async executeControlDurable(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    controlInvocationId: string,
    controlInvocationGeneration: number,
    submissionIdentity: string,
    submissionFingerprint: string,
    signal?: AbortSignal,
    onAdmitted?: (run: NotebookRunRecord) => void
  ): Promise<NotebookControlResult> {
    const admittedAt = Date.now()
    const replWasTerminated =
      session.kernelStatus('repl') === 'terminated' || session.hasDurableKernelTermination('repl')
    const kernelEpochId = session.kernelEpoch('repl', replWasTerminated).id
    const queuedRun: NotebookRunRecord = {
      runId: controlInvocationId,
      executionMode: request.background ? 'background' : 'foreground',
      submissionIdentity,
      submissionFingerprint,
      admittedAt,
      kernelEpochId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `repl-${controlInvocationId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'repl',
      script: request.code,
      status: 'queued',
      startedAt: admittedAt,
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }
    queuedRun.frozenRuntimeTarget = {
      language: 'repl',
      environment: 'control-plane',
      processKey: 'repl'
    }

    // Resolve and retain the Session-owned Host SDK capability before the durable admission point.
    // The per-invocation scope is opened only when this FIFO entry actually dispatches.
    signal?.throwIfAborted()
    const mcpRpc = await session.resolveMcpRpcConnection(this.options.getMcpRpcConnectionResolver())
    signal?.throwIfAborted()
    const blockedMutation = detectManagedRuntimeMutation({
      source: request.code,
      surface: 'repl',
      runtimeRoot: session.runtimeRoot,
      cwd: session.cwd,
      platform: this.options.platform
    })
    const durableAdmission = await this.options.runTerminalization.admit({
      session,
      queuedRun,
      signal
    })
    onAdmitted?.(durableAdmission.run)
    if (!durableAdmission.admitted) return controlResultFromRun(durableAdmission.run)
    this.options.notifyAvailable(session, 'agent')

    const rawRun = (async (): Promise<NotebookControlResult> => {
      try {
        return await session.enqueueControl(
          () =>
            this.executeControlExclusive(
              session,
              request,
              durableAdmission.run,
              controlInvocationGeneration,
              replWasTerminated,
              mcpRpc,
              blockedMutation,
              signal
            ),
          signal
        )
      } catch (error) {
        if (!signal?.aborted || error !== signal.reason) throw error
        const run = await this.options.runTerminalization.cancelQueued(
          session,
          durableAdmission.run,
          signal.reason
        )
        return controlResultFromRun(run)
      }
    })()

    try {
      // The completion gate deliberately stays outside enqueueControl: an approved continuation may
      // re-enter this same Session and must not deadlock behind the old invocation's handoff.
      const interceptor = request.background ? undefined : this.controlCompletionInterceptor
      let result: NotebookControlResult
      if (!interceptor) {
        result = await rawRun
      } else {
        const outcome = await interceptor.intercept({
          context: {
            sessionId: session.sessionId,
            turnId: controlInvocationId,
            toolInvocationId: controlInvocationId,
            controlInvocationGeneration,
            ...(request.provenanceContext
              ? {
                  originatingTurnId: request.provenanceContext.promptMessageId,
                  originatingUserMessageId:
                    request.provenanceContext.originMessageId ??
                    request.provenanceContext.promptMessageId
                }
              : {}),
            attachmentIds:
              request.registeredInputFiles
                ?.filter((input) => input.sourceKind === 'upload-version')
                .map((input) => input.sourceFileId) ?? [],
            artifactIds:
              request.registeredInputFiles
                ?.filter((input) => input.sourceKind === 'artifact-version')
                .map((input) => input.sourceFileId) ?? []
          },
          execute: () => rawRun
        })
        if (outcome.kind === 'captured') throw new NotebookControlCompletionCapturedError()
        result = outcome.result
      }
      if (result.status !== 'completed') {
        session.discardControlInvocation(controlInvocationId)
        return result
      }
      const viewImages = await session.completeControlInvocation(controlInvocationId)
      return viewImages.length > 0 ? { ...result, viewImages } : result
    } catch (error) {
      session.discardControlInvocation(controlInvocationId)
      throw error
    }
  }

  private async executeControlExclusive(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    queuedRun: NotebookRunRecord,
    controlInvocationGeneration: number,
    replWasTerminated: boolean,
    mcpRpc: NotebookSessionMcpRpcConnection | undefined,
    blockedMutation: ReturnType<typeof detectManagedRuntimeMutation>,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    const replStatusBefore = session.kernelStatus('repl')
    const runId = queuedRun.runId
    const kernelEpochId = queuedRun.kernelEpochId
    const replEpochId = blockedMutation ? undefined : kernelEpochId
    let executedOnLiveKernel = !blockedMutation
    let reachedExecutor = false
    const terminalized = await this.options.runTerminalization.runAdmitted({
      session,
      queuedRun,
      startLive: () => {
        if (!blockedMutation) {
          session.clearKernelTerminated('repl')
          this.setReplStatus(session, 'running')
        }
      },
      invoke: () =>
        (blockedMutation
          ? Promise.resolve(
              errorToExecutionResult(
                new Error(`MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`),
                session.cwd
              )
            )
          : (() => {
              const releaseControlInvocation = mcpRpc?.beginControlInvocation?.({
                turnId: runId,
                controlInvocationGeneration,
                toolInvocationId: runId,
                executionMode: request.background ? 'background' : 'foreground',
                ...(request.provenanceContext
                  ? {
                      originatingTurnId: request.provenanceContext.promptMessageId,
                      originatingUserMessageId:
                        request.provenanceContext.originMessageId ??
                        request.provenanceContext.promptMessageId
                    }
                  : {}),
                attachmentIds:
                  request.registeredInputFiles
                    ?.filter((input) => input.sourceKind === 'upload-version')
                    .map((input) => input.sourceFileId) ?? [],
                artifactIds:
                  request.registeredInputFiles
                    ?.filter((input) => input.sourceKind === 'artifact-version')
                    .map((input) => input.sourceFileId) ?? []
              })
              reachedExecutor = true
              return session
                .execute({
                  runId,
                  kernelEpochId,
                  code: request.code,
                  kind: 'repl',
                  cwd: session.cwd,
                  notebookSessionRoot: session.notebookSessionRoot,
                  inputRoot: this.inputRoot(session),
                  dataRoot: session.dataRoot,
                  ...this.fileEvidenceLocation(session),
                  runtimeRoot: session.runtimeRoot,
                  protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
                  timeoutMs: request.timeoutMs,
                  signal,
                  mcpRpcEndpoint: mcpRpc?.endpoint,
                  mcpRpcSocketPath: mcpRpc?.socketPath,
                  mcpRpcToken: mcpRpc?.token,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  workspaceCwd: request.workspaceCwd,
                  inputRunLeaseId: request.inputRunLeaseId,
                  controlInvocationId: runId
                })
                .finally(() => releaseControlInvocation?.())
            })()
        ).catch((error: unknown) => {
          executedOnLiveKernel = false
          return errorToExecutionResult(error, session.cwd)
        }),
      settleLive: () => {
        if (
          executedOnLiveKernel &&
          session.currentKernelEpochId('repl') === replEpochId &&
          session.kernelStatus('repl') === 'running' &&
          !session.isKernelTerminated('repl')
        ) {
          if (!reachedExecutor && replWasTerminated) {
            session.markKernelTerminated('repl')
            session.setKernelStatus('repl', 'terminated')
          } else if (!reachedExecutor && replStatusBefore === 'error') {
            session.setKernelStatus('repl', 'error')
          } else {
            this.setReplStatus(session, 'idle')
          }
        }
      }
    })

    // Clear durable termination only after the recovered Run commits; ordinary activity is volatile.
    if (
      terminalized.dispatched &&
      replWasTerminated &&
      session.currentKernelEpochId('repl') === replEpochId &&
      session.kernelStatus('repl') === 'idle' &&
      !session.isKernelTerminated('repl')
    ) {
      await this.options.persistRecoveredKernelIdle(session, 'repl')
    }

    const result = terminalized.result
    if (!result) return controlResultFromRun(terminalized.run)

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      traceback: result.traceback,
      outputs: result.outputs,
      ...(result.truncated ? { truncated: true } : {}),
      workingFiles: result.workingFiles,
      fileEvidence: result.fileEvidence
    }
  }

  async executeShell(
    session: NotebookSessionAggregate,
    request: ExecuteShellRequest,
    signal?: AbortSignal,
    onAdmitted?: (run: NotebookRunRecord) => void
  ): Promise<NotebookShellResult> {
    const runtimeBinding = captureShellRuntimeBinding(
      request.shellRuntime ?? this.shellRuntimeBinding
    )
    this.assertShellAdmissionAvailable(session)
    const platform = this.options.platform ?? process.platform
    const runtimeRoot = session.runtimeRoot
    const handoffDir = join(session.notebookSessionRoot, 'handoff')
    const inputRoot = this.inputRoot(session)
    const protectedDirs = [getAppClaudeConfigDir(this.options.configRoot)]
    const environment = buildShellEnv(
      handoffDir,
      shellRuntimePlatform(runtimeBinding, platform),
      process.env,
      runtimeRoot,
      prepareNotebookWorkloadCache(runtimeRoot)
    )
    const frozenShellContext: NonNullable<NotebookRunRecord['frozenShellContext']> = {
      cwd: session.cwd,
      handoffDir,
      runtimeRoot,
      notebookSessionRoot: session.notebookSessionRoot,
      inputRoot,
      protectedDirs,
      environment: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      timeoutMs: request.timeoutMs ?? 120_000,
      platform
    }
    const submissionFingerprint = shellRunFingerprint(
      session,
      request,
      frozenShellContext,
      runtimeBinding
    )
    let runId: string | undefined
    const submissionIdentity =
      request.executionInvocationId ??
      (runId = this.options.runTerminalization.allocateRunIdentity().runId)
    const submissionKey = `${notebookLaneKey(session.lane)}:${submissionIdentity}`
    const active = this.activeShellSubmissions.get(submissionKey)
    if (active) {
      if (active.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      if (onAdmitted) void active.admitted.then(onAdmitted, () => undefined)
      return active.promise
    }
    let resolveAdmitted!: (run: NotebookRunRecord) => void
    let rejectAdmitted!: (error: unknown) => void
    const admitted = new Promise<NotebookRunRecord>((resolve, reject) => {
      resolveAdmitted = resolve
      rejectAdmitted = reject
    })
    // The admission promise is an internal replay seam. The primary execution promise remains the
    // public error surface, so admission failures must not become unhandled when no retry is waiting.
    void admitted.catch(() => undefined)
    const promise = (async (): Promise<NotebookShellResult> => {
      if (request.executionInvocationId) {
        const existing = await this.options.runTerminalization.findSubmission(
          session,
          submissionIdentity
        )
        if (existing) {
          if (existing.submissionFingerprint !== submissionFingerprint) {
            throw new NotebookRunSubmissionConflictError(submissionIdentity)
          }
          resolveAdmitted(existing)
          onAdmitted?.(existing)
          return publicShellResult(existing)
        }
      }
      // A teardown may have fenced this scope while an idempotency lookup was awaiting storage.
      this.assertShellAdmissionAvailable(session)
      runId ??= this.options.runTerminalization.allocateRunIdentity().runId
      const admittedAt = Date.now()
      const queuedRun: NotebookRunRecord = {
        runId,
        executionMode: request.background ? 'background' : 'foreground',
        submissionIdentity,
        submissionFingerprint,
        admittedAt,
        frozenShellContext,
        shellConcurrency: { limit: this.shellAdmission.capacity() },
        ...(request.executionInvocationId
          ? { executionInvocationId: request.executionInvocationId }
          : {}),
        cellId: `bash-${runId}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'bash',
        shellRuntime: runtimeBinding,
        script: request.command,
        status: 'queued',
        startedAt: admittedAt,
        cwdBefore: frozenShellContext.cwd,
        ...request.provenanceContext,
        agentFrameId: runAgentFrameId(session, request.provenanceContext),
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
      }
      const lifecycleController = new AbortController()
      const lifecycleSignal = signal
        ? AbortSignal.any([signal, lifecycleController.signal])
        : lifecycleController.signal
      let settleLifecycle!: (reaped: boolean) => void
      const lifecycleSettled = new Promise<boolean>((resolve) => {
        settleLifecycle = resolve
      })
      let ownedTreeReaped = true
      let lifecycleFinished = false
      const finishLifecycle = (): void => {
        if (lifecycleFinished) return
        lifecycleFinished = true
        this.liveShellRuns.delete(runId!)
        settleLifecycle(ownedTreeReaped)
      }
      const liveRun = {
        projectId: session.projectId,
        sessionId: session.sessionId,
        laneKey: notebookLaneKey(session.lane),
        controller: lifecycleController,
        settled: lifecycleSettled,
        requestCancellation: async (reason: unknown): Promise<void> => {
          void reason
        }
      }
      this.liveShellRuns.set(runId, liveRun)
      const shellProcessRequest = {
        runId,
        executionReference: runId,
        runtimeBinding,
        command: request.command,
        cwd: frozenShellContext.cwd,
        handoffDir: frozenShellContext.handoffDir,
        runtimeRoot: frozenShellContext.runtimeRoot,
        notebookSessionRoot: frozenShellContext.notebookSessionRoot,
        inputRoot: frozenShellContext.inputRoot,
        protectedDirs: frozenShellContext.protectedDirs,
        environment: frozenShellContext.environment,
        sessionId: session.sessionId,
        projectId: session.projectId,
        timeoutMs: frozenShellContext.timeoutMs
      }
      let preparedShell:
        Awaited<ReturnType<NonNullable<NotebookShellProcess['prepare']>>> | undefined
      let lease: ShellAdmissionLease | undefined
      try {
        let durableAdmission: Awaited<ReturnType<NotebookRunTerminalizationOwner['admit']>>
        try {
          if (lifecycleSignal.aborted) throw lifecycleSignal.reason
          // Production freezes sandbox roots, trust material, network decision state, and one-shot
          // grants before durable admission. Injected test adapters may keep the legacy execute port.
          preparedShell = await this.shellProcess.prepare?.(shellProcessRequest)
          durableAdmission = await this.options.runTerminalization.admit({ session, queuedRun })
        } catch (error) {
          rejectAdmitted(error)
          throw error
        }
        resolveAdmitted(durableAdmission.run)
        onAdmitted?.(durableAdmission.run)
        if (!durableAdmission.admitted) {
          return publicShellResult(durableAdmission.run)
        }
        liveRun.requestCancellation = async (reason: unknown) => {
          await this.options.runTerminalization.requestCancellation(
            session,
            durableAdmission.run,
            reason
          )
        }
        if (lifecycleSignal.aborted) {
          await liveRun.requestCancellation(lifecycleSignal.reason)
        }
        this.options.notifyAvailable(session, 'agent')
        try {
          lease = await this.shellAdmission.acquire(
            session.projectId,
            session.sessionId,
            lifecycleSignal
          )
        } catch {
          const cancelled = await this.options.runTerminalization.cancelQueued(
            session,
            durableAdmission.run,
            new Error(SHELL_CANCELLED_MESSAGE)
          )
          const result = {
            stdout: cancelled.text.stdout,
            stderr: cancelled.text.stderr,
            exitCode: null,
            ...(cancelled.truncated ? { truncated: true } : {})
          }
          return result
        }
        {
          const terminalized = await this.options.runTerminalization.runAdmitted({
            session,
            queuedRun: {
              ...durableAdmission.run,
              inputFiles: queuedRun.inputFiles,
              shellConcurrency: { limit: lease.limit, slot: lease.slot }
            },
            invoke: async () => {
              const workingFileObservation = await startWorkingFileObservation({
                dataRoot: session.dataRoot,
                notebookSessionRoot: frozenShellContext.notebookSessionRoot,
                ...this.fileEvidenceLocation(session),
                runId: runId!,
                signal: lifecycleSignal
              })
              let workingFiles: NotebookWorkingFile[] = []
              let fileEvidence: ExecutionFileEvidenceSummary | undefined
              const blockedMutation = detectManagedRuntimeMutation({
                source: request.command,
                surface: runtimeBinding.kind === 'powershell' ? 'powershell' : 'bash',
                runtimeRoot: frozenShellContext.runtimeRoot,
                cwd: frozenShellContext.cwd,
                platform: shellRuntimePlatform(runtimeBinding)
              })
              let shellResult: NotebookShellResult | undefined
              try {
                shellResult = await (blockedMutation
                  ? Promise.resolve<NotebookShellResult>({
                      stdout: '',
                      stderr: `MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`,
                      exitCode: 1
                    })
                  : preparedShell
                    ? preparedShell.execute(lifecycleSignal)
                    : this.shellProcess.execute({
                        ...shellProcessRequest,
                        signal: lifecycleSignal
                      }))
              } finally {
                const observation = await workingFileObservation.finish(
                  shellResult === undefined ||
                    signal?.aborted ||
                    shellResult.cancelled ||
                    shellResult.exitCode === null
                    ? AbortSignal.abort()
                    : signal
                )
                workingFiles = observation.workingFiles
                fileEvidence = observation.fileEvidence
              }
              if (!shellResult)
                throw new Error('Notebook shell execution completed without a result.')
              ownedTreeReaped =
                shellResult.ownedTreeReaped !== false &&
                shellResult.errorCode !== 'shell-cleanup-incomplete'
              const status: NotebookRunStatus =
                shellResult.errorCode === 'shell-cleanup-incomplete'
                  ? 'failed'
                  : shellResult.cancelled
                    ? 'cancelled'
                    : shellResult.runtimeStatus === 'unavailable'
                      ? 'failed'
                      : shellResult.exitCode === 0
                        ? 'completed'
                        : shellResult.exitCode === null
                          ? 'timeout'
                          : 'failed'
              this.options.logger.info?.('shell execution completed', {
                executionId: runId,
                runtime: runtimeBinding.kind,
                ...(runtimeBinding.kind === 'wsl2-bash'
                  ? { profileReference: runtimeBinding.profileId }
                  : {}),
                stage: shellResult.runtimeStatus === 'unavailable' ? 'sandbox-prepare' : 'execution',
                status,
                terminationReason:
                  shellResult.errorCode === 'shell-cleanup-incomplete'
                    ? 'cleanup-incomplete'
                    : shellResult.cancelled
                      ? 'cancel'
                      : shellResult.exitCode === null
                        ? 'timeout'
                        : 'exit',
                cleanupState:
                  shellResult.errorCode === 'shell-cleanup-incomplete' ? 'incomplete' : 'complete',
                exitCode: shellResult.exitCode,
                stdoutByteCount: Buffer.byteLength(shellResult.stdout, 'utf8'),
                stderrByteCount: Buffer.byteLength(shellResult.stderr, 'utf8'),
                outputByteCount: Buffer.byteLength(shellResult.stdout + shellResult.stderr, 'utf8'),
                truncated: shellResult.truncated === true
              })
              const outputs: NotebookOutput[] = [
                ...(shellResult.stdout
                  ? [{ type: 'stream' as const, name: 'stdout' as const, text: shellResult.stdout }]
                  : []),
                ...(shellResult.stderr
                  ? [{ type: 'stream' as const, name: 'stderr' as const, text: shellResult.stderr }]
                  : [])
              ]

              return {
                status,
                stdout: shellResult.stdout,
                stderr: shellResult.stderr,
                traceback: '',
                cwdAfter: frozenShellContext.cwd,
                outputs,
                truncated: shellResult.truncated,
                workingFiles,
                fileEvidence,
                exitCode: shellResult.exitCode,
                runtimeStatus: shellResult.runtimeStatus,
                errorCode: shellResult.errorCode
              }
            }
          })
          const result = terminalized.result
          if (!result) {
            return publicShellResult(terminalized.run)
          }
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(result.runtimeStatus ? { runtimeStatus: result.runtimeStatus } : {}),
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            ...(result.truncated ? { truncated: true } : {})
          }
        }
      } finally {
        try {
          preparedShell?.dispose()
        } finally {
          lease?.release()
          finishLifecycle()
        }
      }
    })()
    // Fail duplicate callers waiting for admission even when an error occurs before durable admit.
    void promise.catch(rejectAdmitted)
    const entry = { fingerprint: submissionFingerprint, admitted, promise }
    this.activeShellSubmissions.set(submissionKey, entry)
    try {
      return await promise
    } finally {
      if (this.activeShellSubmissions.get(submissionKey) === entry) {
        this.activeShellSubmissions.delete(submissionKey)
      }
    }
  }

  private setReplStatus(session: NotebookSessionAggregate, status: 'running' | 'idle'): void {
    session.setKernelStatus('repl', status)
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }
