import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookCell,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunFileEvidence,
  NotebookRunRecord,
  NotebookRunProvenanceContext,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookWorkingFile,
  RunNotebookCellRequest
} from '../../shared/notebook'
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
import { notebookLaneScope } from './lane-identity'
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

const CANCELLED_MESSAGE =
  'Run cancelled: the runtime was disabled (stop running work) while this cell was executing.'
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

class NotebookExecutionOwner {
  private readonly shellProcess: NotebookShellProcess
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
    const admission = await this.options.dataExecutionAdmission.admit(session, cell)
    const { environment, processKey } = admission.route
    const { binding, resolvedInterpreter } = admission
    const kernelWasTerminated =
      session.isKernelTerminated(processKey) ||
      session.kernelStatus(processKey) === 'terminated' ||
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
      artifacts: [],
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
          const executionResult = await session
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
              const fallback = session.consumeForceStopped(processKey)
                ? cancelledExecutionResult(cwdBefore)
                : errorToExecutionResult(error, cwdBefore)
              return { ...fallback, kernelDispatched: true }
            })
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
      }
    })
    if (
      !session.isKernelTerminated(processKey) &&
      (executedOnLiveKernel || (kernelMarkedRunning && !reachedExecutor))
    ) {
      this.options.setKernelStatus(session, 'idle', processKey)
      if (kernelWasTerminated) {
        await this.options.persistRecoveredKernelIdle(session, processKey)
      }
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
      artifacts: [],
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
      cwd: session.cwd
    })
    const replWasTerminated =
      !blockedMutation &&
      (session.kernelStatus('repl') === 'terminated' || session.hasDurableKernelTermination('repl'))
    if (!blockedMutation) {
      session.clearKernelTerminated('repl')
      this.setReplStatus(session, 'running')
    }

    let executedOnLiveKernel = !blockedMutation
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
        })
    })

    if (executedOnLiveKernel && !session.isKernelTerminated('repl')) {
      this.setReplStatus(session, 'idle')
      // A terminated status is durable; clear it once, while ordinary running/idle transitions stay
      // in memory and do not rewrite the whole run.json document.
      if (replWasTerminated) {
        await this.options.persistRecoveredKernelIdle(session, 'repl')
      }
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

  async executeShell(
    session: NotebookSessionAggregate,
    request: ExecuteShellRequest,
    signal?: AbortSignal
  ): Promise<NotebookShellResult> {
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const runningRun: NotebookRunRecord = {
      runId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `bash-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'bash',
      script: request.command,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }

    // No per-Session queue; the repository serializes only the durable run writes.
    const { result } = await this.options.runTerminalization.run({
      session,
      runningRun,
      invoke: async () => {
        const workingFileObservation = await startWorkingFileObservation({
          dataRoot: session.dataRoot,
          notebookSessionRoot: session.notebookSessionRoot,
          ...this.fileEvidenceLocation(session),
          runId,
          signal
        })
        let workingFiles: NotebookWorkingFile[] = []
        let fileEvidence: NotebookRunFileEvidence | undefined
        const blockedMutation = detectManagedRuntimeMutation({
          source: request.command,
          surface: this.options.platform === 'win32' ? 'powershell' : 'bash',
          runtimeRoot: session.runtimeRoot,
          cwd: session.cwd
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
        if (!shellResult) throw new Error('Notebook shell execution completed without a result.')
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
      }
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(result.truncated ? { truncated: true } : {})
    }
  }

  private setReplStatus(session: NotebookSessionAggregate, status: 'running' | 'idle'): void {
    session.setKernelStatus('repl', status)
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }
