import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookCell,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunRecord,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookWorkingFile,
  RunNotebookCellRequest
} from '../../shared/notebook'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import {
  EnvironmentManifestPublicationError,
  EnvironmentStateTracker,
  type EnvironmentCaptureTarget
} from './environment-state-tracker'
import { detectManagedRuntimeMutation } from './managed-runtime-guard'
import type { NotebookRunRepository } from './repository'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import { notebookLaneScope } from './lane-identity'
import type {
  NotebookSessionAggregate,
  NotebookSessionExecutionResult,
  NotebookSessionMcpRpcConnection,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'
import {
  NotebookShellProcessAdapter,
  type NotebookShellProcess,
  type NotebookShellResult
} from './shell-process'
import { startWorkingFileObservation } from './working-file-observer'

type NotebookControlResult = Pick<
  NotebookSessionExecutionResult,
  'status' | 'stdout' | 'stderr' | 'traceback' | 'outputs' | 'workingFiles'
>

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
}
type McpRpcConnectionResolver = (
  binding: McpRpcConnectionBinding
) => Promise<NotebookSessionMcpRpcConnection>

type NotebookExecutionOwnerOptions = {
  configRoot: string
  repository: Pick<NotebookRunRepository, 'updateKernelStatus'>
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
  persistKernelStatus: (
    session: NotebookSessionAggregate,
    status: 'running' | 'idle',
    processKey: string
  ) => Promise<void>
  getMcpRpcConnectionResolver: () => McpRpcConnectionResolver | undefined
  notifyAvailable: (session: NotebookSessionAggregate, source: NotebookRunSource) => void
  platform?: NodeJS.Platform
  shellProcess?: NotebookShellProcess
}

const errorToExecutionResult = (error: unknown, cwd: string): NotebookSessionExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: 'failed',
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
class NotebookExecutionOwner {
  private readonly shellProcess: NotebookShellProcess
  private controlCompletionInterceptor: NotebookControlCompletionInterceptor | undefined

  constructor(private readonly options: NotebookExecutionOwnerOptions) {
    this.shellProcess = options.shellProcess ?? new NotebookShellProcessAdapter(options.platform)
  }

  setControlCompletionInterceptor(
    interceptor: NotebookControlCompletionInterceptor | undefined
  ): void {
    this.controlCompletionInterceptor = interceptor
  }
  async executeDataCell(
    session: NotebookSessionAggregate,
    request: RunNotebookCellRequest
  ): Promise<NotebookRunRecord> {
    const cell = session.cellView(request.cellId)
    if (session.isCellReceiving(cell.id)) {
      throw new Error(`Notebook cell is still receiving code: ${cell.id}`)
    }
    const route = this.options.dataExecutionAdmission.route(session, cell.language)
    return session.enqueueExecution(route.processKey, () =>
      this.executeDataCellExclusive(session, cell, request)
    )
  }
  private async executeDataCellExclusive(
    session: NotebookSessionAggregate,
    cell: Readonly<NotebookCell>,
    request: RunNotebookCellRequest
  ): Promise<NotebookRunRecord> {
    this.options.notifyAvailable(session, request.source ?? 'agent')
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const startedAt = Date.now()
    const executionCount = session.nextExecutionCount()
    const cwdBefore = session.cwd
    const admission = await this.options.dataExecutionAdmission.admit(session, cell)
    const { environment, processKey } = admission.route
    const { binding, resolvedInterpreter } = admission
    session.markCellRunning(cell.id, runId, executionCount)
    const runningRun: NotebookRunRecord = {
      runId,
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
      ...request.provenanceContext,
      agentFrameId: notebookLaneScope(session.lane).agentFrameId,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }
    if (!existsSync(cwdBefore)) {
      console.error(
        `[notebook] Session cwd is missing before execution, the kernel may run in an unexpected directory: ${cwdBefore}`
      )
    }
    const kernelMarkedRunning = admission.rejection === undefined
    if (kernelMarkedRunning) {
      session.clearKernelTerminated(processKey)
      await this.options.persistKernelStatus(session, 'running', processKey)
    }
    let executedOnLiveKernel = true
    let reachedExecutor = false
    const { run } = await this.options.runTerminalization.run({
      session,
      runningRun,
      invoke: () =>
        this.options.dataExecutionAdmission.runShared(admission, async (rejection) => {
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
          const result = await session
            .execute({
              code: cell.code,
              cwd: cwdBefore,
              language: cell.language,
              environment,
              notebookSessionRoot: session.notebookSessionRoot,
              dataRoot: session.dataRoot,
              runtimeRoot: session.runtimeRoot,
              protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
              timeoutMs: request.timeoutMs,
              resolvedInterpreter,
              inputRunLeaseId: request.inputRunLeaseId
            })
            .catch((error: unknown) => {
              executedOnLiveKernel = false
              return session.consumeForceStopped(processKey)
                ? cancelledExecutionResult(cwdBefore)
                : errorToExecutionResult(error, cwdBefore)
            })
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
      postCommit: (result) => {
        session.completeCellRun(cell.id, result.status, result.cwdAfter ?? cwdBefore)
      }
    })
    if (
      !session.isKernelTerminated(processKey) &&
      (executedOnLiveKernel || (kernelMarkedRunning && !reachedExecutor))
    ) {
      await this.options.persistKernelStatus(session, 'idle', processKey)
    }
    return run
  }
  async executeControl(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest
  ): Promise<NotebookControlResult> {
    const { runId: controlInvocationId, sequence: controlInvocationGeneration } =
      this.options.runTerminalization.allocateRunIdentity()
    const rawRun = session.enqueueControl(() =>
      this.executeControlExclusive(
        session,
        request,
        controlInvocationId,
        controlInvocationGeneration
      )
    )

    // The completion gate deliberately stays outside enqueueControl: an approved continuation may
    // re-enter this same Session and must not deadlock behind the old invocation's handoff.
    const interceptor = this.controlCompletionInterceptor
    if (!interceptor) return rawRun

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
    return outcome.result
  }

  private async executeControlExclusive(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    runId: string,
    controlInvocationGeneration: number
  ): Promise<NotebookControlResult> {
    this.options.notifyAvailable(session, 'agent')
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: `repl-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'repl',
      script: request.code,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: notebookLaneScope(session.lane).agentFrameId,
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
    if (!blockedMutation) {
      session.clearKernelTerminated('repl')
      await this.persistReplStatus(session, 'running')
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
                  code: request.code,
                  kind: 'repl',
                  cwd: session.cwd,
                  notebookSessionRoot: session.notebookSessionRoot,
                  dataRoot: session.dataRoot,
                  runtimeRoot: session.runtimeRoot,
                  protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
                  timeoutMs: request.timeoutMs,
                  mcpRpcEndpoint: mcpRpc?.endpoint,
                  mcpRpcSocketPath: mcpRpc?.socketPath,
                  mcpRpcToken: mcpRpc?.token,
                  sessionId: session.sessionId,
                  projectName: session.projectName,
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
      await this.persistReplStatus(session, 'idle')
    }

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      traceback: result.traceback,
      outputs: result.outputs,
      workingFiles: result.workingFiles
    }
  }

  async executeShell(
    session: NotebookSessionAggregate,
    request: ExecuteShellRequest
  ): Promise<NotebookShellResult> {
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: `bash-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'bash',
      script: request.command,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: notebookLaneScope(session.lane).agentFrameId,
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
        const workingFileObservation = await startWorkingFileObservation(session)
        let workingFiles: NotebookWorkingFile[] = []
        const blockedMutation = detectManagedRuntimeMutation({
          source: request.command,
          surface: this.options.platform === 'win32' ? 'powershell' : 'bash',
          runtimeRoot: session.runtimeRoot,
          cwd: session.cwd
        })
        const shellResult = await (
          blockedMutation
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
                timeoutMs: request.timeoutMs
              })
        ).finally(async () => {
          workingFiles = await workingFileObservation.finish()
        })
        const status: NotebookRunStatus =
          shellResult.exitCode === 0
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
          workingFiles,
          exitCode: shellResult.exitCode
        }
      }
    })

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  private async persistReplStatus(
    session: NotebookSessionAggregate,
    status: 'running' | 'idle'
  ): Promise<void> {
    session.setKernelStatus('repl', status)
    try {
      await this.options.repository.updateKernelStatus({
        projectName: session.projectName,
        sessionId: session.sessionId,
        lane: session.lane,
        status
      })
    } catch {
      // Best effort: status persistence must not replace an execution result.
    }
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }
