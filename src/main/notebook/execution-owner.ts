import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookCell,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunRecord,
  NotebookRunProvenanceContext,
  NotebookRunSource,
  NotebookRunStatus,
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
import { notebookLaneKey, notebookLaneScope, type NotebookLaneIdentity } from './lane-identity'
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
  type NotebookShellProcess,
  type NotebookShellResult
} from './shell-process'
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

type NotebookControlResult = Pick<
  NotebookSessionExecutionResult,
  | 'status'
  | 'stdout'
  | 'stderr'
  | 'traceback'
  | 'outputs'
  | 'truncated'
  | 'workingFiles'
  | 'fileEvidence'
> & { viewImages?: readonly TransientViewImage[] }

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
  logger: Pick<Logger, 'error'>
  platform?: NodeJS.Platform
  shellProcess?: NotebookShellProcess
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
const cancelledExecutionResult = (cwd: string): NotebookSessionExecutionResult => ({
  ...errorToExecutionResult(new Error(CANCELLED_MESSAGE), cwd),
  status: 'cancelled'
})

const NOTEBOOK_SHELL_MAX_CONCURRENCY = 6
const SHELL_CANCELLED_MESSAGE = 'Shell command was cancelled.'

type ShellAdmissionWaiter = {
  sessionKey: string
  signal?: AbortSignal
  resolve: (release: (() => void) | undefined) => void
  onAbort: () => void
}

type ShellExecutionOperation = {
  controller: AbortController
  promise: Promise<NotebookShellResult>
  sessionKey: string
}

const shellSessionKey = (lane: NotebookLaneIdentity): string => {
  const { projectId, sessionId } = notebookLaneScope(lane)
  return JSON.stringify([projectId, sessionId])
}

class NotebookShellExecutionAdmission {
  private active = 0
  private readonly activeSessions = new Set<string>()
  private readonly waiters: ShellAdmissionWaiter[] = []

  acquire(sessionKey: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index === -1) return
        this.waiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        resolve(undefined)
      }
      const waiter: ShellAdmissionWaiter = { sessionKey, signal, resolve, onAbort }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      else this.dispatch()
    })
  }

  private dispatch(): void {
    while (this.active < NOTEBOOK_SHELL_MAX_CONCURRENCY) {
      const index = this.waiters.findIndex((waiter) => !this.activeSessions.has(waiter.sessionKey))
      if (index === -1) return
      const [waiter] = this.waiters.splice(index, 1)
      if (!waiter) return
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.resolve(undefined)
        continue
      }

      this.active += 1
      this.activeSessions.add(waiter.sessionKey)
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        this.activeSessions.delete(waiter.sessionKey)
        this.dispatch()
      })
    }
  }
}

// Root runtime ownership is Session-scoped, but every durable Run still belongs to the authenticated
// conversation Frame that produced it. A renderer state read may have created the shared owner first.
const runAgentFrameId = (
  session: NotebookSessionAggregate,
  provenanceContext: NotebookRunProvenanceContext | undefined
): string => provenanceContext?.agentFrameId ?? notebookLaneScope(session.lane).agentFrameId

class NotebookExecutionOwner {
  private readonly shellProcess: NotebookShellProcess
  // ponytail: fixed runtime-generation ceiling; add settings only when real workloads need tuning.
  private readonly shellAdmission = new NotebookShellExecutionAdmission()
  private readonly shellOperationsByLane = new Map<string, Set<ShellExecutionOperation>>()
  private readonly shellTeardownLaneKeys = new Set<string>()
  private readonly shellTeardownSessionKeys = new Set<string>()
  private shellTeardownActive = false
  private controlCompletionInterceptor: NotebookControlCompletionInterceptor | undefined

  constructor(private readonly options: NotebookExecutionOwnerOptions) {
    this.shellProcess = options.shellProcess ?? new NotebookShellProcessAdapter(options.platform)
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

  setControlCompletionInterceptor(
    interceptor: NotebookControlCompletionInterceptor | undefined
  ): void {
    this.controlCompletionInterceptor = interceptor
  }
  async executeDataCell(
    session: NotebookSessionAggregate,
    request: RunNotebookCellRequest,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[]
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    const cell = session.cellView(request.cellId)
    if (session.isCellReceiving(cell.id)) {
      throw new Error(`Notebook cell is still receiving code: ${cell.id}`)
    }
    const route = this.options.dataExecutionAdmission.route(session, cell.language)
    return session.enqueueExecution(
      route.processKey,
      () => this.executeDataCellExclusive(session, cell, request, signal, helperModuleIds),
      signal
    )
  }
  private async executeDataCellExclusive(
    session: NotebookSessionAggregate,
    cell: Readonly<NotebookCell>,
    request: RunNotebookCellRequest,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[]
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    this.options.notifyAvailable(session, request.source ?? 'agent')
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const startedAt = Date.now()
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
    const kernelWasTerminated =
      session.isKernelTerminated(processKey) ||
      kernelStatusBefore === 'terminated' ||
      session.hasDurableKernelTermination(processKey)
    const kernelEpoch = session.kernelEpoch(
      processKey,
      kernelWasTerminated,
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
    session.markCellRunning(cell.id, runId, executionCount)
    const runningRun: NotebookRunRecord = {
      runId,
      kernelEpochId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: cell.id,
      source: request.source ?? 'agent',
      inputKind: request.inputKind ?? 'cell',
      kernelKind: cell.language,
      script: cell.code,
      status: 'running',
      startedAt,
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
    if (!existsSync(cwdBefore)) {
      this.options.logger.error('session working directory is missing before execution', {
        sessionId: session.sessionId
      })
    }
    const kernelMarkedRunning = admission.rejection === undefined
    if (kernelMarkedRunning) {
      session.clearKernelTerminated(processKey)
      this.options.setKernelStatus(session, 'running', processKey)
    }
    let executedOnLiveKernel = true
    let reachedExecutor = false
    const { run } = await this.options.runTerminalization.run({
      session,
      runningRun,
      invoke: () =>
        this.options.dataExecutionAdmission.runShared(session, admission, async (rejection) => {
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
            environmentRunStart = await this.options.environmentStateTracker.prepareRun(target)
          } catch (error) {
            executedOnLiveKernel = false
            return errorToExecutionResult(error, cwdBefore)
          }
          reachedExecutor = true
          let executionResult = await session
            .execute({
              runId,
              code: cell.code,
              ...(helperPlan.injections.length ? { helperModules: helperPlan.injections } : {}),
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
              return { ...errorToExecutionResult(error, cwdBefore), kernelDispatched: true }
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
                state: capture.manifest.captureStatus === 'complete' ? 'available' : 'partial',
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
        }),
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
  }
  async executeControl(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    const { runId: controlInvocationId, sequence: controlInvocationGeneration } =
      this.options.runTerminalization.allocateRunIdentity()
    const rawRun = session.enqueueControl(() =>
      this.executeControlExclusive(
        session,
        request,
        controlInvocationId,
        controlInvocationGeneration,
        signal
      )
    )

    try {
      // The completion gate deliberately stays outside enqueueControl: an approved continuation may
      // re-enter this same Session and must not deadlock behind the old invocation's handoff.
      const interceptor = this.controlCompletionInterceptor
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
    runId: string,
    controlInvocationGeneration: number,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    this.options.notifyAvailable(session, 'agent')
    const runningRun: NotebookRunRecord = {
      runId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `repl-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'repl',
      script: request.code,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }

    // The Session Aggregate caches the capability for its lifetime. One invocation lease then wraps
    // exactly the raw control dispatch and is released before completion interception begins.
    const mcpRpc = await session.resolveMcpRpcConnection(this.options.getMcpRpcConnectionResolver())
    const blockedMutation = detectManagedRuntimeMutation({
      source: request.code,
      surface: 'repl',
      runtimeRoot: session.runtimeRoot,
      cwd: session.cwd,
      platform: this.options.platform
    })
    const replStatusBefore = session.kernelStatus('repl')
    const replWasTerminated =
      !blockedMutation &&
      (replStatusBefore === 'terminated' || session.hasDurableKernelTermination('repl'))
    const replEpochId = blockedMutation
      ? undefined
      : session.kernelEpochId('repl', replWasTerminated)
    if (!blockedMutation) {
      session.clearKernelTerminated('repl')
      this.setReplStatus(session, 'running')
    }

    let executedOnLiveKernel = !blockedMutation
    let reachedExecutor = false
    const { result } = await this.options.runTerminalization.run({
      session,
      runningRun,
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
      replWasTerminated &&
      session.currentKernelEpochId('repl') === replEpochId &&
      session.kernelStatus('repl') === 'idle' &&
      !session.isKernelTerminated('repl')
    ) {
      await this.options.persistRecoveredKernelIdle(session, 'repl')
    }

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

  executeShell(
    lane: NotebookLaneIdentity,
    request: ExecuteShellRequest,
    loadSession: () => Promise<NotebookSessionAggregate>,
    signal?: AbortSignal
  ): Promise<NotebookShellResult> {
    const laneKey = notebookLaneKey(lane)
    const sessionKey = shellSessionKey(lane)
    if (
      this.shellTeardownActive ||
      this.shellTeardownLaneKeys.has(laneKey) ||
      this.shellTeardownSessionKeys.has(sessionKey)
    ) {
      return Promise.resolve({ stdout: '', stderr: SHELL_CANCELLED_MESSAGE, exitCode: null })
    }

    const controller = new AbortController()
    const executionSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const cancelled = (): NotebookShellResult => ({
      stdout: '',
      stderr: SHELL_CANCELLED_MESSAGE,
      exitCode: null
    })
    // Enqueue before loadSession so overlapping same-Session calls keep call order. The waiter
    // resolves inside executeShellRun after the queued Run exists.
    const admission = this.shellAdmission.acquire(sessionKey, executionSignal)
    const promise = Promise.resolve().then(async () => {
      let handedOff = false
      try {
        if (executionSignal.aborted) return cancelled()
        const session = await loadSession()
        if (executionSignal.aborted) return cancelled()
        handedOff = true
        return await this.executeShellRun(session, request, executionSignal, admission)
      } finally {
        if (!handedOff) (await admission)?.()
      }
    })
    const operation = { controller, promise, sessionKey }
    const operations = this.shellOperationsByLane.get(laneKey) ?? new Set<ShellExecutionOperation>()
    operations.add(operation)
    this.shellOperationsByLane.set(laneKey, operations)
    void promise
      .finally(() => {
        operations.delete(operation)
        if (operations.size === 0 && this.shellOperationsByLane.get(laneKey) === operations) {
          this.shellOperationsByLane.delete(laneKey)
        }
      })
      .catch(() => undefined)
    return promise
  }

  async withShellLaneTeardown<Result>(
    lane: NotebookLaneIdentity,
    teardown: () => Promise<Result>
  ): Promise<Result> {
    const laneKey = notebookLaneKey(lane)
    const ownsGate = !this.shellTeardownLaneKeys.has(laneKey)
    this.shellTeardownLaneKeys.add(laneKey)
    try {
      return await this.drainShellOperations(
        Array.from(this.shellOperationsByLane.get(laneKey) ?? []),
        teardown
      )
    } finally {
      if (ownsGate) this.shellTeardownLaneKeys.delete(laneKey)
    }
  }

  async withShellSessionTeardown<Result>(
    lane: NotebookLaneIdentity,
    teardown: () => Promise<Result>
  ): Promise<Result> {
    const sessionKey = shellSessionKey(lane)
    const ownsGate = !this.shellTeardownSessionKeys.has(sessionKey)
    this.shellTeardownSessionKeys.add(sessionKey)
    try {
      return await this.drainShellOperations(
        Array.from(this.shellOperationsByLane.values()).flatMap((operations) =>
          Array.from(operations).filter((operation) => operation.sessionKey === sessionKey)
        ),
        teardown
      )
    } finally {
      if (ownsGate) this.shellTeardownSessionKeys.delete(sessionKey)
    }
  }

  async withShellTeardown<Result>(teardown: () => Promise<Result>): Promise<Result> {
    const ownsGate = !this.shellTeardownActive
    this.shellTeardownActive = true
    try {
      return await this.drainShellOperations(
        Array.from(this.shellOperationsByLane.values()).flatMap((operations) => [...operations]),
        teardown
      )
    } finally {
      if (ownsGate) this.shellTeardownActive = false
    }
  }

  private async drainShellOperations<Result>(
    operations: ShellExecutionOperation[],
    teardown: () => Promise<Result>
  ): Promise<Result> {
    const reason = new Error('Notebook Session is shutting down.')
    for (const operation of operations) operation.controller.abort(reason)
    await Promise.allSettled(operations.map((operation) => operation.promise))
    return teardown()
  }

  private async executeShellRun(
    session: NotebookSessionAggregate,
    request: ExecuteShellRequest,
    signal: AbortSignal,
    admission: Promise<(() => void) | undefined>
  ): Promise<NotebookShellResult> {
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const queuedRun: NotebookRunRecord = {
      runId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `bash-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'bash',
      script: request.command,
      status: 'queued',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }

    try {
      const { result } = await this.options.runTerminalization.run({
        session,
        runningRun: queuedRun,
        invoke: async (markRunning) => {
          const release = await admission
          if (!release || signal?.aborted) {
            release?.()
            return {
              status: 'cancelled' as const,
              stdout: '',
              stderr: SHELL_CANCELLED_MESSAGE,
              traceback: '',
              cwdAfter: session.cwd,
              outputs: [
                { type: 'stream' as const, name: 'stderr' as const, text: SHELL_CANCELLED_MESSAGE }
              ],
              workingFiles: [],
              exitCode: null
            }
          }

          try {
            await markRunning()
            const workingFileObservation = await startWorkingFileObservation({
              dataRoot: session.dataRoot,
              notebookSessionRoot: session.notebookSessionRoot,
              ...this.fileEvidenceLocation(session),
              runId,
              signal
            })
            let workingFiles: NotebookWorkingFile[] = []
            let fileEvidence: ExecutionFileEvidenceSummary | undefined
            const blockedMutation = detectManagedRuntimeMutation({
              source: request.command,
              surface: this.options.platform === 'win32' ? 'powershell' : 'bash',
              runtimeRoot: session.runtimeRoot,
              cwd: session.cwd,
              platform: this.options.platform
            })
            let shellResult: NotebookShellResult | undefined
            try {
              shellResult = await (blockedMutation
                ? Promise.resolve<NotebookShellResult>({
                    stdout: '',
                    stderr: `MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`,
                    exitCode: 1
                  })
                : this.shellProcess.execute({
                    command: request.command,
                    cwd: session.cwd,
                    handoffDir: join(session.notebookSessionRoot, 'handoff'),
                    runtimeRoot: session.runtimeRoot,
                    notebookSessionRoot: session.notebookSessionRoot,
                    inputRoot: this.inputRoot(session),
                    protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
                    sessionId: session.sessionId,
                    projectId: session.projectId,
                    timeoutMs: request.timeoutMs,
                    signal
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
            const status: NotebookRunStatus = shellResult.cancelled
              ? 'cancelled'
              : shellResult.exitCode === 0
                ? 'completed'
                : shellResult.exitCode === null
                  ? 'timeout'
                  : 'failed'
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
              cwdAfter: session.cwd,
              outputs,
              truncated: shellResult.truncated,
              workingFiles,
              fileEvidence,
              exitCode: shellResult.exitCode
            }
          } finally {
            release()
          }
        }
      })

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.truncated ? { truncated: true } : {})
      }
    } finally {
      ;(await admission)?.()
    }
  }

  private setReplStatus(session: NotebookSessionAggregate, status: 'running' | 'idle'): void {
    session.setKernelStatus('repl', status)
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }
