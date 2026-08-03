import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookOutput,
  NotebookRunRecord,
  NotebookRunStatus,
  NotebookWorkingFile
} from '../../shared/notebook'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { detectManagedRuntimeMutation } from './managed-runtime-guard'
import type { NotebookRunRepository } from './repository'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import type {
  NotebookSessionAggregate,
  NotebookSessionExecutionResult,
  NotebookSessionMcpRpcConnection
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

type McpRpcConnectionBinding = { sessionId: string; projectId: string }
type McpRpcConnectionResolver = (
  binding: McpRpcConnectionBinding
) => Promise<NotebookSessionMcpRpcConnection>

type NotebookExecutionOwnerOptions = {
  configRoot: string
  repository: Pick<NotebookRunRepository, 'updateKernelStatus'>
  runTerminalization: NotebookRunTerminalizationOwner
  getMcpRpcConnectionResolver: () => McpRpcConnectionResolver | undefined
  notifyAvailable: (session: NotebookSessionAggregate) => void
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
              originatingUserMessageId: request.provenanceContext.promptMessageId
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
    this.options.notifyAvailable(session)
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
                toolInvocationId: runId
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
        status
      })
    } catch {
      // Best effort: status persistence must not replace an execution result.
    }
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }
