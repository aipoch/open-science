import { randomUUID } from 'node:crypto'
import { SessionReproducibilityBatches } from './session-reproducibility'
import { SessionReproducibilityStore } from './session-reproducibility-store'
import {
  validateReproductionContext,
  validateReproductionDiskSpace
} from './reproduction-preflight'
import {
  artifactReproducibilityRecipeMatchesSnapshot,
  prepareArtifactReproducibilityExecutionPlan
} from './artifact-reproducibility-recipe'
import type {
  SessionReproducibilityCommand,
  SessionReproducibilityBatch
} from '../../shared/session-reproducibility'
import { outputComparisonPolicySchema } from '../../shared/output-comparison'

import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type {
  ArtifactReproducibilityCheckComparison,
  ArtifactReproducibilityCheckLog,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState,
  ArtifactReproducibilityReceiptPage,
  ArtifactReproducibilityReceipt,
  ArtifactReproducibilityFailedAttempt,
  CancelArtifactReproducibilityCheckRequest,
  GetArtifactReproducibilityCheckLogRequest,
  GetArtifactReproducibilityCheckRequest,
  ListArtifactReproducibilityReceiptsRequest
} from '../../shared/artifact-reproducibility'
import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import { isChildUnconfirmedError } from '../notebook/provisioner-runtime'
import { createLogger, errorLogFields } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import {
  executeArtifactReproducibility,
  ReproducibilityCleanupError,
  type ArtifactReproducibilityExecutionEvent,
  type ArtifactReproducibilityExecutionResult
} from './artifact-reproducibility-execution'
import type {
  ArtifactReproducibilityCheckLogDraft,
  ArtifactReproducibilityFailedAttemptDraft,
  ArtifactReproducibilityReceiptDraft
} from './artifact-reproducibility-receipts'

const log = createLogger('artifacts:reproducibility')
const REPRODUCIBILITY_LOG_LIMIT_CHARACTERS = 128 * 1024

type ArtifactReproducibilityAttemptOwnerDependencies = {
  storageRoot: string
  processSandbox: NotebookProcessSandbox
  loadExecution: (
    request: ArtifactReproducibilityCheckRequest
  ) => Promise<PersistedArtifactExecutionSnapshot>
  persistReceipt: (
    request: ArtifactReproducibilityCheckRequest,
    receipt: ArtifactReproducibilityReceiptDraft,
    checkLog: ArtifactReproducibilityCheckLogDraft
  ) => Promise<ArtifactReproducibilityReceipt>
  persistFailure: (
    request: ArtifactReproducibilityCheckRequest,
    attempt: ArtifactReproducibilityFailedAttemptDraft,
    checkLog: ArtifactReproducibilityCheckLogDraft
  ) => Promise<ArtifactReproducibilityFailedAttempt>
  listReceipts: (
    request: ListArtifactReproducibilityReceiptsRequest
  ) => Promise<ArtifactReproducibilityReceiptPage>
  getCheckLog: (
    request: GetArtifactReproducibilityCheckLogRequest
  ) => Promise<ArtifactReproducibilityCheckLogRecord | undefined>
  withStorageLease?: <Result>(operation: () => Promise<Result>) => Promise<Result>
  retainOutput?: (request: ArtifactReproducibilityCheckRequest, bytes: Buffer) => Promise<boolean>
  pruneOutputs?: (request: ArtifactReproducibilityCheckRequest) => Promise<void>
  execute?: typeof executeArtifactReproducibility
  createId?: () => string
  now?: () => Date
}

type Attempt = {
  ownerId: number
  controller: AbortController
  recording: boolean
  cleanupError?: unknown
  startedAt: string
  state: ArtifactReproducibilityCheckState
  settled: Promise<void>
  publish: (state: ArtifactReproducibilityCheckState) => void
}

const requestKey = (request: GetArtifactReproducibilityCheckRequest): string =>
  [request.projectId, request.appSessionId, request.artifactId, request.versionId].join('\0')

const snapshot = (state: ArtifactReproducibilityCheckState): ArtifactReproducibilityCheckState => ({
  ...state,
  request: structuredClone(state.request),
  comparisons: structuredClone(state.comparisons),
  ...(state.logs ? { logs: state.logs.map((entry) => ({ ...entry })) } : {}),
  ...(state.receipt
    ? {
        receipt: {
          ...state.receipt,
          artifactVersion: { ...state.receipt.artifactVersion },
          frontier: { ...state.receipt.frontier },
          recipe: { ...state.receipt.recipe },
          environmentLocks: state.receipt.environmentLocks.map((lock) => ({ ...lock })),
          completedStepIds: [...state.receipt.completedStepIds],
          comparisons: structuredClone(state.receipt.comparisons),
          ...(state.receipt.checkLog ? { checkLog: { ...state.receipt.checkLog } } : {})
        }
      }
    : {})
})

const appendLogs = (
  current: ArtifactReproducibilityCheckLog[] | undefined,
  entries: ArtifactReproducibilityCheckLog[]
): { logs: ArtifactReproducibilityCheckLog[]; truncated: boolean } => {
  const logs = [...(current ?? []), ...entries]
  let characters = logs.reduce((total, entry) => total + entry.text.length, 0)
  let truncated = false
  while (logs.length > 1 && characters > REPRODUCIBILITY_LOG_LIMIT_CHARACTERS) {
    characters -= logs.shift()!.text.length
    truncated = true
  }
  return { logs, truncated }
}

const comparisonState = (
  comparison: ArtifactReproducibilityExecutionEvent & { type: 'output-compared' }
): ArtifactReproducibilityCheckComparison => ({
  relativePath: comparison.comparison.relativePath,
  status: comparison.comparison.status,
  ...(comparison.comparison.reason ? { reason: comparison.comparison.reason } : {})
})

class ArtifactReproducibilityAttemptOwner {
  private readonly maintainingVersions = new Set<string>()

  async withIdleVersion<T>(
    request: GetArtifactReproducibilityCheckRequest,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = requestKey(request)
    if (
      this.disposed ||
      this.stoppingAll ||
      this.attemptIdsByRequest.has(key) ||
      this.maintainingVersions.has(key)
    )
      throw new Error('Wait for the reproducibility operation to finish before clearing outputs.')
    this.maintainingVersions.add(key)
    try {
      return await operation()
    } finally {
      this.maintainingVersions.delete(key)
    }
  }
  private readonly attemptsById = new Map<string, Attempt>()
  private readonly attemptIdsByRequest = new Map<string, string>()
  private readonly stoppingSessions = new Map<string, number>()
  private stoppingAll = 0
  private disposed = false

  private readonly batches: SessionReproducibilityBatches
  private readonly batchPublishers = new Map<
    number,
    (state: ArtifactReproducibilityCheckState) => void
  >()
  constructor(private readonly dependencies: ArtifactReproducibilityAttemptOwnerDependencies) {
    const store = new SessionReproducibilityStore(dependencies.storageRoot)
    this.batches = new SessionReproducibilityBatches({
      store: {
        load: (scope) =>
          dependencies.withStorageLease
            ? dependencies.withStorageLease(() => store.load(scope))
            : store.load(scope),
        save: (state) =>
          dependencies.withStorageLease
            ? dependencies.withStorageLease(() => store.save(state))
            : store.save(state)
      },
      preflight: async (request, signal) => {
        const operation = async (): Promise<{
          recipeId: string
          steps: number
          inputBytes: number
          environmentCount: number
        }> => {
          const execution = await dependencies.loadExecution(request)
          const recipe = execution.reproducibilityRecipe
          if (
            !recipe ||
            !execution.provenanceGraph ||
            !artifactReproducibilityRecipeMatchesSnapshot(recipe, {
              ...execution,
              provenanceGraph: execution.provenanceGraph
            })
          )
            throw new Error('Execution evidence is unavailable.')
          validateReproductionContext(execution, request.frontierId)
          await validateReproductionDiskSpace(recipe, request.frontierId)
          await prepareArtifactReproducibilityExecutionPlan(
            recipe,
            request.frontierId,
            dependencies.storageRoot,
            signal
          )
          const frontier = recipe.frontiers.find((f) => f.frontierId === request.frontierId)!
          const steps = recipe.steps.filter((step) => frontier.stepIds.includes(step.stepId))
          return {
            recipeId: recipe.recipeId,
            steps: steps.length,
            inputBytes: frontier.crossingFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
            environmentCount: new Set(
              steps.flatMap((step) =>
                step.kind === 'notebook-run' && step.environmentRequirementId
                  ? [step.environmentRequirementId]
                  : []
              )
            ).size
          }
        }
        return dependencies.withStorageLease
          ? dependencies.withStorageLease(operation)
          : operation()
      },
      run: async (request, publish, ownerId) => {
        if (this.attemptIdsByRequest.has(requestKey(request)))
          throw new Error('Artifact check is already running.')
        const state = this.start(request, ownerId, (state) => {
          publish(state)
          this.batchPublishers.get(ownerId)?.(state)
        })
        // Evidence loading can be slow; publish its identity immediately so batch cancellation
        // can reach the attempt before the executor emits its first progress event.
        publish(state)
        this.batchPublishers.get(ownerId)?.(state)
        const attempt = this.attemptsById.get(state.attemptId)!
        await attempt.settled
        return snapshot(attempt.state)
      },
      cancel: (attemptId, ownerId) => this.cancel({ attemptId }, ownerId)
    })
  }

  sessionCommand(
    request: SessionReproducibilityCommand,
    ownerId: number,
    publish?: (state: ArtifactReproducibilityCheckState) => void
  ): Promise<SessionReproducibilityBatch | undefined> {
    if (
      (request.action === 'prepare' || request.action === 'start') &&
      (this.disposed ||
        this.stoppingAll ||
        this.stoppingSessions.has(JSON.stringify([request.projectId, request.appSessionId])))
    )
      throw new Error('Reproducibility checks are shutting down.')
    if (publish) this.batchPublishers.set(ownerId, publish)
    return this.batches.command(request, ownerId)
  }

  start(
    request: ArtifactReproducibilityCheckRequest,
    ownerId: number,
    publish: (state: ArtifactReproducibilityCheckState) => void
  ): ArtifactReproducibilityCheckState {
    if (request.comparisonPolicy) {
      request = {
        ...request,
        comparisonPolicy: outputComparisonPolicySchema.parse(request.comparisonPolicy)
      }
    }
    if (this.disposed || this.stoppingAll) {
      throw new Error('Reproducibility checks are shutting down.')
    }
    if (this.stoppingSessions.has(JSON.stringify([request.projectId, request.appSessionId]))) {
      throw new Error('The Session is being deleted.')
    }
    if (
      [...this.attemptsById.values()].some(
        (attempt) =>
          attempt.cleanupError &&
          attempt.state.request.projectId === request.projectId &&
          attempt.state.request.appSessionId === request.appSessionId
      )
    ) {
      throw new Error('Reproducibility worker shutdown could not be confirmed. Restart the app.')
    }
    const key = requestKey(request)
    if (this.maintainingVersions.has(key)) throw new Error('Reproduced outputs are being cleared.')
    const activeId = this.attemptIdsByRequest.get(key)
    const active = activeId ? this.attemptsById.get(activeId) : undefined
    if (active) {
      if (
        active.ownerId !== ownerId ||
        active.state.request.frontierId !== request.frontierId ||
        JSON.stringify(active.state.request.comparisonPolicy) !==
          JSON.stringify(request.comparisonPolicy)
      ) {
        throw new Error('A reproducibility check is already running for this Artifact Version.')
      }
      return snapshot(active.state)
    }

    const attemptId = (this.dependencies.createId ?? randomUUID)()
    const startedAt = (this.dependencies.now ?? (() => new Date()))().toISOString()
    const attempt: Attempt = {
      ownerId,
      controller: new AbortController(),
      recording: false,
      startedAt,
      state: {
        attemptId,
        startedAt,
        request: { ...request },
        revision: 0,
        status: 'running',
        phase: 'loading-evidence',
        completedSteps: 0,
        totalSteps: 0,
        completedEnvironments: 0,
        totalEnvironments: 0,
        totalComparisons: 0,
        comparisons: []
      },
      settled: Promise.resolve(),
      publish
    }
    this.attemptsById.set(attemptId, attempt)
    this.attemptIdsByRequest.set(key, attemptId)
    attempt.settled = this.run(attempt).finally(() => {
      // Keep uncertain workers visible to subsequent deletion and shutdown gates.
      if (attempt.cleanupError) return
      if (this.attemptsById.get(attemptId) === attempt) this.attemptsById.delete(attemptId)
      if (this.attemptIdsByRequest.get(key) === attemptId) this.attemptIdsByRequest.delete(key)
    })
    return snapshot(attempt.state)
  }

  getCheck(
    request: GetArtifactReproducibilityCheckRequest,
    ownerId: number
  ): ArtifactReproducibilityCheckState | undefined {
    const id = this.attemptIdsByRequest.get(requestKey(request))
    const attempt = id ? this.attemptsById.get(id) : undefined
    return attempt?.ownerId === ownerId ? snapshot(attempt.state) : undefined
  }

  cancel(request: CancelArtifactReproducibilityCheckRequest, ownerId: number): void {
    const attempt = this.attemptsById.get(request.attemptId)
    if (!attempt) return
    if (attempt.ownerId !== ownerId) {
      throw new Error('A reproducibility check can only be cancelled by its owner.')
    }
    if (attempt.recording) return
    attempt.controller.abort(new Error('Reproduction cancelled.'))
  }

  cancelOwner(ownerId: number): void {
    this.batchPublishers.delete(ownerId)
    void this.batches
      .stopWhere((_scope, owner) => owner === ownerId)
      .catch((error) => {
        log.error('Session check shutdown failed', errorLogFields(error))
      })
    for (const attempt of this.attemptsById.values()) {
      if (attempt.ownerId === ownerId && !attempt.recording) {
        attempt.controller.abort(new Error('Reproduction cancelled.'))
      }
    }
  }

  listReceipts(
    request: ListArtifactReproducibilityReceiptsRequest
  ): Promise<ArtifactReproducibilityReceiptPage> {
    const operation = (): Promise<ArtifactReproducibilityReceiptPage> =>
      this.dependencies.listReceipts(request)
    return this.dependencies.withStorageLease
      ? this.dependencies.withStorageLease(operation)
      : operation()
  }

  getCheckLog(
    request: GetArtifactReproducibilityCheckLogRequest
  ): Promise<ArtifactReproducibilityCheckLogRecord | undefined> {
    const operation = (): Promise<ArtifactReproducibilityCheckLogRecord | undefined> =>
      this.dependencies.getCheckLog(request)
    return this.dependencies.withStorageLease
      ? this.dependencies.withStorageLease(operation)
      : operation()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.shutdownAll()
  }

  getActiveSessions(): { projectId: string; sessionId: string }[] {
    const sessions = [...this.attemptsById.values()].map(({ state }) => ({
      projectId: state.request.projectId,
      sessionId: state.request.appSessionId
    }))
    return [
      ...new Map(
        [...sessions, ...this.batches.activeSessions()].map((scope) => [
          JSON.stringify(scope),
          scope
        ])
      ).values()
    ]
  }

  async cancelSession(projectId: string, sessionId: string): Promise<void> {
    const batches = this.batches.stopWhere(
      (scope) => scope.projectId === projectId && scope.appSessionId === sessionId
    )
    const attempts = this.drain(
      [...this.attemptsById.values()].filter(
        ({ state }) =>
          state.request.projectId === projectId && state.request.appSessionId === sessionId
      )
    )
    await Promise.all([batches, attempts])
  }

  async cancelProject(projectId: string): Promise<void> {
    const batches = this.batches.stopWhere((scope) => scope.projectId === projectId)
    const attempts = this.drain(
      [...this.attemptsById.values()].filter(({ state }) => state.request.projectId === projectId)
    )
    await Promise.all([batches, attempts])
  }

  async withSessionStopped<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const key = JSON.stringify([projectId, sessionId])
    this.stoppingSessions.set(key, (this.stoppingSessions.get(key) ?? 0) + 1)
    try {
      await this.cancelSession(projectId, sessionId)
      return await operation()
    } finally {
      const remaining = this.stoppingSessions.get(key)! - 1
      if (remaining) this.stoppingSessions.set(key, remaining)
      else this.stoppingSessions.delete(key)
    }
  }

  async shutdownAll(): Promise<void> {
    this.stoppingAll++
    try {
      await Promise.all([
        this.batches.stopWhere(() => true),
        this.drain([...this.attemptsById.values()])
      ])
    } finally {
      this.stoppingAll--
    }
  }

  private async drain(attempts: Attempt[]): Promise<void> {
    for (const attempt of attempts) {
      if (!attempt.recording) attempt.controller.abort(new Error('Reproduction cancelled.'))
    }
    await Promise.all(attempts.map((attempt) => attempt.settled))
    const unsafe = attempts.find((attempt) => attempt.cleanupError)
    if (unsafe) throw unsafe.cleanupError
  }

  private update(
    attempt: Attempt,
    patch: Partial<Omit<ArtifactReproducibilityCheckState, 'attemptId' | 'request' | 'revision'>>
  ): void {
    attempt.state = {
      ...attempt.state,
      ...patch,
      revision: attempt.state.revision + 1
    }
    try {
      attempt.publish(snapshot(attempt.state))
    } catch {
      attempt.controller.abort(new Error('Reproduction cancelled.'))
    }
  }

  private onExecutionEvent(attempt: Attempt, event: ArtifactReproducibilityExecutionEvent): void {
    switch (event.type) {
      case 'attempt-started':
        this.update(attempt, {
          phase: 'materializing-inputs',
          totalEnvironments: event.totalEnvironments,
          totalSteps: event.totalSteps,
          totalComparisons: event.totalComparisons
        })
        return
      case 'inputs-materialized':
        this.update(attempt, { phase: 'restoring-environments' })
        return
      case 'environment-progress':
        this.update(attempt, {
          phase: 'restoring-environments',
          completedEnvironments:
            event.stage === 'completed'
              ? Math.max(attempt.state.completedEnvironments, event.index + 1)
              : attempt.state.completedEnvironments,
          activeEnvironment:
            event.stage === 'completed'
              ? undefined
              : {
                  kernelKind: event.kernelKind,
                  index: event.index,
                  total: event.total,
                  stage: event.stage
                }
        })
        return
      case 'environment-output': {
        const recordedAt = (this.dependencies.now ?? (() => new Date()))().toISOString()
        const appended = appendLogs(attempt.state.logs, [
          { ...event.entry, recordedAt: event.entry.recordedAt ?? recordedAt }
        ])
        this.update(attempt, {
          logs: appended.logs,
          logsTruncated: attempt.state.logsTruncated || appended.truncated
        })
        return
      }
      case 'environments-restored':
        this.update(attempt, {
          phase: 'executing',
          completedEnvironments: event.count,
          totalEnvironments: event.count,
          activeEnvironment: undefined
        })
        return
      case 'step-started':
        this.update(attempt, {
          phase: 'executing',
          completedSteps: event.index,
          totalSteps: event.total
        })
        return
      case 'step-output': {
        const recordedAt = (this.dependencies.now ?? (() => new Date()))().toISOString()
        const appended = appendLogs(
          attempt.state.logs,
          event.entries.map((entry) => ({ ...entry, recordedAt: entry.recordedAt ?? recordedAt }))
        )
        this.update(attempt, {
          logs: appended.logs,
          logsTruncated: attempt.state.logsTruncated || appended.truncated
        })
        return
      }
      case 'step-completed':
        this.update(attempt, {
          completedSteps: event.index + 1,
          totalSteps: event.total
        })
        return
      case 'output-compared':
        this.update(attempt, {
          phase:
            attempt.state.completedSteps >= attempt.state.totalSteps
              ? 'comparing'
              : attempt.state.phase,
          comparisons: [...attempt.state.comparisons, comparisonState(event)]
        })
        return
      case 'attempt-completed':
        return
    }
  }

  private finish(
    attempt: Attempt,
    result: ArtifactReproducibilityExecutionResult,
    receipt: ArtifactReproducibilityReceipt
  ): void {
    this.update(attempt, {
      status: result.matched ? 'matched' : 'different',
      phase: undefined,
      activeEnvironment: undefined,
      completedSteps: result.completedStepIds.length,
      comparisons: result.comparisons.map((comparison) => ({
        relativePath: comparison.relativePath,
        status: comparison.status,
        ...(comparison.reason ? { reason: comparison.reason } : {})
      })),
      receipt
    })
  }

  private receiptDraft(
    attempt: Attempt,
    execution: PersistedArtifactExecutionSnapshot,
    result: ArtifactReproducibilityExecutionResult
  ): ArtifactReproducibilityReceiptDraft {
    const recipe = execution.reproducibilityRecipe
    const frontier = recipe?.frontiers.find(
      (candidate) => candidate.frontierId === attempt.state.request.frontierId
    )
    if (!recipe || !frontier) {
      throw new Error('Artifact reproduction receipt identity is unavailable.')
    }
    const stepIds = new Set(frontier.stepIds)
    const requirementIds = new Set(
      recipe.steps.flatMap((step) =>
        stepIds.has(step.stepId) && step.kind === 'notebook-run' && step.environmentRequirementId
          ? [step.environmentRequirementId]
          : []
      )
    )
    const environmentRequirements = recipe.environmentRequirements.filter((requirement) =>
      requirementIds.has(requirement.requirementId)
    )
    if (environmentRequirements.length !== requirementIds.size) {
      throw new Error('Artifact reproduction receipt environment identity is unavailable.')
    }
    return {
      schemaVersion: 2,
      receiptId: attempt.state.attemptId,
      startedAt: attempt.startedAt,
      completedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      outcome: result.matched ? 'matched' : 'different',
      artifactVersion: {
        projectId: attempt.state.request.projectId,
        appSessionId: attempt.state.request.appSessionId,
        artifactId: attempt.state.request.artifactId,
        versionId: attempt.state.request.versionId,
        targetChecksum: recipe.targetChecksum
      },
      frontier: {
        frontierId: frontier.frontierId,
        claimScope: frontier.claimScope
      },
      recipe: {
        recipeId: recipe.recipeId,
        graphChecksum: recipe.graphChecksum
      },
      environmentLocks: environmentRequirements.map((requirement) => ({
        requirementId: requirement.requirementId,
        kernelKind: requirement.kernelKind,
        ...(requirement.environmentName ? { environmentName: requirement.environmentName } : {}),
        lockChecksum: requirement.lockChecksum
      })),
      completedStepIds: [...result.completedStepIds],
      comparisons: result.comparisons.map((comparison) => ({ ...comparison }))
    }
  }

  private async run(attempt: Attempt): Promise<void> {
    const diagnostic = startDiagnosticOperation(log, {
      operation: 'artifact-reproducibility-check',
      operationId: attempt.state.attemptId
    })
    let loggedPhase = attempt.state.phase
    diagnostic.phase('loading-evidence')
    try {
      const operation = async (): Promise<{
        result: ArtifactReproducibilityExecutionResult
        receipt: ArtifactReproducibilityReceipt
      }> => {
        const execution = await this.dependencies.loadExecution(attempt.state.request)
        if (
          attempt.state.request.expectedRecipeId &&
          execution.reproducibilityRecipe?.recipeId !== attempt.state.request.expectedRecipeId
        )
          throw new Error('Execution evidence changed after preflight. Prepare the check again.')
        const frontier = execution.reproducibilityRecipe?.frontiers.find(
          (candidate) => candidate.frontierId === attempt.state.request.frontierId
        )
        this.update(attempt, { totalSteps: frontier?.stepIds.length ?? 0 })
        if (attempt.controller.signal.aborted) {
          throw attempt.controller.signal.reason ?? new Error('Reproduction cancelled.')
        }
        const result = await (this.dependencies.execute ?? executeArtifactReproducibility)({
          execution,
          frontierId: attempt.state.request.frontierId,
          storageRoot: this.dependencies.storageRoot,
          processSandbox: this.dependencies.processSandbox,
          signal: attempt.controller.signal,
          comparisonPolicy: attempt.state.request.comparisonPolicy,
          retainOutput: this.dependencies.retainOutput
            ? (bytes) => this.dependencies.retainOutput!(attempt.state.request, bytes)
            : undefined,
          onEvent: (event) => {
            this.onExecutionEvent(attempt, event)
            if (attempt.state.phase && attempt.state.phase !== loggedPhase) {
              loggedPhase = attempt.state.phase
              diagnostic.phase(loggedPhase, {
                completedSteps: attempt.state.completedSteps,
                totalSteps: attempt.state.totalSteps,
                completedEnvironments: attempt.state.completedEnvironments,
                totalEnvironments: attempt.state.totalEnvironments
              })
            }
          }
        })
        if (attempt.controller.signal.aborted) {
          throw attempt.controller.signal.reason ?? new Error('Reproduction cancelled.')
        }
        attempt.recording = true
        diagnostic.phase('recording-result')
        const receipt = await this.dependencies.persistReceipt(
          attempt.state.request,
          this.receiptDraft(attempt, execution, result),
          {
            entries: attempt.state.logs ?? [],
            truncated: Boolean(attempt.state.logsTruncated)
          }
        )
        return { result, receipt }
      }
      const withOutputCleanup = async (): ReturnType<typeof operation> => {
        const prune = async (): Promise<void> => {
          await this.dependencies.pruneOutputs?.(attempt.state.request).catch((error) => {
            log.warn('unreferenced reproduced outputs could not be removed', errorLogFields(error))
          })
        }
        await prune()
        try {
          return await operation()
        } finally {
          await prune()
        }
      }
      const completed = await (this.dependencies.withStorageLease
        ? this.dependencies.withStorageLease(withOutputCleanup)
        : withOutputCleanup())
      this.finish(attempt, completed.result, completed.receipt)
      diagnostic.complete({
        matched: completed.result.matched,
        completedSteps: completed.result.completedStepIds.length,
        comparisonCount: completed.result.comparisons.length,
        logsTruncated: Boolean(attempt.state.logsTruncated)
      })
    } catch (error) {
      if (isChildUnconfirmedError(error)) attempt.cleanupError = error
      if (
        attempt.controller.signal.aborted &&
        !attempt.cleanupError &&
        !(error instanceof ReproducibilityCleanupError)
      ) {
        diagnostic.cancel({ completedSteps: attempt.state.completedSteps })
        this.update(attempt, {
          status: 'cancelled',
          phase: undefined,
          activeEnvironment: undefined
        })
        return
      }
      diagnostic.fail(error, {
        completedSteps: attempt.state.completedSteps,
        completedEnvironments: attempt.state.completedEnvironments,
        recording: attempt.recording,
        workerCleanupUnconfirmed: Boolean(attempt.cleanupError)
      })
      const persistFailure = (): Promise<ArtifactReproducibilityFailedAttempt> =>
        this.dependencies.persistFailure(
          attempt.state.request,
          {
            attemptId: attempt.state.attemptId,
            startedAt: attempt.startedAt,
            completedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
            artifactVersion: {
              projectId: attempt.state.request.projectId,
              appSessionId: attempt.state.request.appSessionId,
              artifactId: attempt.state.request.artifactId,
              versionId: attempt.state.request.versionId
            },
            frontierId: attempt.state.request.frontierId,
            ...(attempt.state.phase ? { phase: attempt.state.phase } : {})
          },
          {
            entries: attempt.state.logs ?? [],
            truncated: Boolean(attempt.state.logsTruncated)
          }
        )
      await (
        this.dependencies.withStorageLease
          ? this.dependencies.withStorageLease(persistFailure)
          : persistFailure()
      ).catch((persistenceError) => {
        log.error('failed reproducibility attempt could not be recorded', {
          attemptId: attempt.state.attemptId,
          ...errorLogFields(persistenceError)
        })
      })
      this.update(attempt, {
        status: 'failed',
        ...(attempt.recording ? { phase: undefined } : {}),
        activeEnvironment: undefined
      })
    }
  }
}

export { ArtifactReproducibilityAttemptOwner }
export type { ArtifactReproducibilityAttemptOwnerDependencies }
