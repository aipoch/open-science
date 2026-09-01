import type { NotebookKernelMetadata, NotebookLanguage } from '../../shared/notebook'
import type { ProvisionProgress } from '../../shared/notebook-env'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import type { NotebookLaneIdentity } from './lane-identity'
import { EnvironmentLeaseManager, type EnvironmentLeaseMode } from './environment-lease-manager'
import type { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { managedRuntimeIdentity } from './runtime-target'
import { errorLogFields } from '../logger'
import {
  boundedRuntimeDiagnostic,
  redactRuntimeDiagnosticValue,
  runtimeChildProcessErrorFields,
  type RuntimeDiagnosticLogger
} from './runtime-diagnostics'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  pythonReady,
  rReady
} from './runtime-paths'

type EnvironmentOperationKind = 'execution' | 'inspection' | 'mutation' | 'provision' | 'revocation'

type EnvironmentOperationSession = {
  readonly projectId: string
  readonly sessionId: string
  readonly runtimeRoot?: string
  readonly lane: NotebookLaneIdentity
  runtimeBinding(language: NotebookLanguage): NotebookSessionRuntimeBinding | undefined
  setRuntimeBinding(language: NotebookLanguage, binding: NotebookSessionRuntimeBinding): void
  kernelStatus(processKey: string): NotebookKernelMetadata['lastKnownStatus'] | undefined
  hasPendingExecution?(processKey: string): boolean
  markForceStopped(processKey: string): void
  drainExecution(processKey: string): Promise<void>
  terminateExecutor(kind: 'python' | 'r', env: string): Promise<void>
  clearProcessState(processKey: string): void
}

type EnvironmentOperationBindingOwner = {
  runWrites<T>(sessionIds: Iterable<string>, operation: () => Promise<T>): Promise<T>
  revoke<Context>(
    session: EnvironmentOperationSession,
    language: NotebookLanguage,
    runtimeId: string,
    beforeRevoke: (binding: NotebookSessionRuntimeBinding) => Context
  ): Promise<Context | undefined>
}

export type DefaultEnvProvisioner = {
  provisionPython: (onProgress: (progress: ProvisionProgress) => void) => Promise<void>
  provisionR: (onProgress: (progress: ProvisionProgress) => void) => Promise<void>
}

export type NotebookEnvironmentOperationDiagnostic = Readonly<{
  level: 'info' | 'warn' | 'error'
  message: string
  fields: Record<string, unknown>
}>

export type NotebookEnvironmentOperationsSnapshot = Readonly<{
  disposed: boolean
  active: ReadonlyArray<{
    kind: EnvironmentOperationKind
    environment: string
    startedAt: number
  }>
  progress?: ProvisionProgress
  restartRecommendedEnvironments: readonly string[]
  revocationDrains: number
  repairBlockedEnvironments: readonly string[]
  diagnostic?: NotebookEnvironmentOperationDiagnostic
  leases: ReturnType<EnvironmentLeaseManager['snapshot']>
  recovery: ReturnType<NotebookRecoveryCoordinator['snapshot']>
}>

type NotebookEnvironmentOperationsOptions = {
  recovery: NotebookRecoveryCoordinator
  bindings: EnvironmentOperationBindingOwner
  sessions: () => Iterable<EnvironmentOperationSession>
  clearKernelTermination: (
    session: EnvironmentOperationSession,
    processKey: string
  ) => Promise<void>
  notifyChanged: (session: EnvironmentOperationSession) => void
  logger?: RuntimeDiagnosticLogger
  now?: () => number
}

type PackageDiagnostic = {
  operationId: string
  operation: 'create' | 'install' | 'uninstall' | 'update'
  language: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  packages: string[]
  durationMs: number
}

type PackageResultDiagnostic = PackageDiagnostic & {
  result: {
    ok: boolean
    needsRestart: boolean
    log: string
    method?: string
    fallbackUsed?: boolean
    repairRequired?: boolean
    prefix?: string
    error?: string
  }
}

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

const processKey = (language: NotebookLanguage, environment: string): string =>
  `${language === 'r' ? 'r' : 'python'}:${environment}`

const runEnvironment = (
  session: EnvironmentOperationSession,
  language: NotebookLanguage
): string => {
  const binding = session.runtimeBinding(language)
  if (binding?.source === 'managed' && binding.envName) return binding.envName
  return defaultEnvironment(language)
}

const implicitManagedRuntimeTarget = (
  session: EnvironmentOperationSession,
  language: NotebookLanguage,
  runtimeId: string
): { environment: string; processKey: string } | undefined => {
  if (session.runtimeBinding(language) !== undefined || session.runtimeRoot === undefined) {
    return undefined
  }
  const environment = defaultEnvironment(language)
  if (managedRuntimeIdentity(session.runtimeRoot, language, environment).runtimeId !== runtimeId) {
    return undefined
  }
  return { environment, processKey: processKey(language, environment) }
}

const cloneDiagnosticValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneDiagnosticValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, cloneDiagnosticValue(nested)])
  )
}

const cloneDiagnosticFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  cloneDiagnosticValue(fields) as Record<string, unknown>

/** Owns process-global Notebook environment operation admission and transient operation state. */
export class NotebookEnvironmentOperations {
  private readonly leases = new EnvironmentLeaseManager()
  private readonly active = new Map<
    symbol,
    NotebookEnvironmentOperationsSnapshot['active'][number]
  >()
  private readonly restartRecommendations = new Set<string>()
  private readonly revocationDrains = new Set<Promise<void>>()
  private readonly revocationReservations = new Map<string, Set<Promise<void>>>()
  private readonly executionReservations = new Map<string, Set<Promise<void>>>()
  private readonly repairBlocks = new Set<string>()
  private readonly removals = new Set<string>()
  // A separate reservation avoids holding a shared env lease while the provisioner later takes its
  // exclusive prefix lease. Closing the removal barrier makes this set finite before it is drained.
  private readonly provisionDrains = new Map<string, Set<Promise<void>>>()
  private provisioner: DefaultEnvProvisioner | undefined
  private reportProvisionProgress: (progress: ProvisionProgress) => void = () => undefined
  private progress: ProvisionProgress | undefined
  private diagnostic: NotebookEnvironmentOperationDiagnostic | undefined
  private disposed = false

  constructor(private readonly options: NotebookEnvironmentOperationsOptions) {}

  setDefaultEnvProvisioner(
    provisioner: DefaultEnvProvisioner,
    onProgress: (progress: ProvisionProgress) => void = () => undefined
  ): void {
    this.provisioner = provisioner
    this.reportProvisionProgress = onProgress
  }

  async ensureDefaultEnvironmentReady(input: {
    language: NotebookLanguage
    environment: string
    runtimeRoot: string
    sessionId: string
    ensureRecovered: () => Promise<void>
    assertRecoverable: () => void
    assertCreationAllowed?: () => Promise<void> | void
  }): Promise<void> {
    const provisioner = this.provisioner
    if (!provisioner) return
    if (input.environment !== DEFAULT_PY_ENV && input.environment !== DEFAULT_R_ENV) return

    await input.ensureRecovered()
    input.assertRecoverable()
    const ready =
      input.language === 'r'
        ? rReady(input.runtimeRoot, DEFAULT_ENV_VERSION)
        : pythonReady(input.runtimeRoot, DEFAULT_ENV_VERSION)
    if (ready) return
    await input.assertCreationAllowed?.()

    const report = (progress: ProvisionProgress): void => {
      const scoped = { ...progress, scope: input.language, sessionId: input.sessionId }
      this.progress = scoped
      this.reportProvisionProgress(scoped)
    }
    await this.runProvisionAdmission(input.environment, async () => {
      try {
        if (input.language === 'r') await provisioner.provisionR(report)
        else await provisioner.provisionPython(report)
      } catch (error) {
        const message = `Could not prepare ${input.environment}: ${
          error instanceof Error ? error.message : String(error)
        }`
        report({ phase: 'error', message, progress: 0, language: input.language })
        throw new Error(message, { cause: error })
      }
    })
  }

  runShared<T>(
    kind: Extract<EnvironmentOperationKind, 'execution' | 'inspection'>,
    environment: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.removals.has(environment)) return Promise.reject(this.removalInProgress(environment))
    return this.withLease(kind, environment, 'shared', async () => {
      if (this.removals.has(environment)) throw this.removalInProgress(environment)
      return operation()
    })
  }

  runExecutionAdmission<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    if (this.removals.has(environment)) return Promise.reject(this.removalInProgress(environment))

    let resolveDrain!: () => void
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve
    })
    const drains = this.executionReservations.get(environment) ?? new Set<Promise<void>>()
    drains.add(drain)
    this.executionReservations.set(environment, drains)
    const release = (): void => {
      drains.delete(drain)
      if (drains.size === 0) this.executionReservations.delete(environment)
      resolveDrain()
    }

    try {
      if (this.removals.has(environment)) throw this.removalInProgress(environment)
      return operation().finally(release)
    } catch (error) {
      release()
      return Promise.reject(error)
    }
  }

  runMutation<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    return this.withLease('mutation', environment, 'exclusive', operation)
  }

  runPackageMutation<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    if (this.removals.has(environment)) return Promise.reject(this.removalInProgress(environment))
    return this.withLease('mutation', environment, 'exclusive', async () => {
      if (this.removals.has(environment)) throw this.removalInProgress(environment)
      return operation()
    })
  }

  async withRemovalBarrier<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    if (this.removals.has(environment)) throw this.removalInProgress(environment)
    this.removals.add(environment)
    try {
      const admittedExecutions = this.executionReservations.get(environment)
      if (admittedExecutions) await Promise.all(admittedExecutions)
      const admittedProvisions = this.provisionDrains.get(environment)
      if (admittedProvisions) await Promise.all(admittedProvisions)
      const admittedRevocations = this.revocationReservations.get(environment)
      if (admittedRevocations) await Promise.all(admittedRevocations)
      return await operation()
    } finally {
      this.removals.delete(environment)
    }
  }

  runRemoval<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    if (!this.removals.has(environment)) {
      return Promise.reject(
        new Error(
          `RUNTIME_ENVIRONMENT_REMOVAL_BARRIER_REQUIRED: Runtime Environment "${environment}" ` +
            'cannot be removed without first closing operation admission.'
        )
      )
    }
    return this.withLease('mutation', environment, 'exclusive', operation)
  }

  describeRuntimeUsage(
    language: NotebookLanguage,
    runtimeId: string
  ): {
    running: number
    idle: number
    dormant: number
  } {
    const usage = { running: 0, idle: 0, dormant: 0 }
    for (const session of this.options.sessions()) {
      const binding = session.runtimeBinding(language)
      const environment = runEnvironment(session, language)
      const matchesBinding = binding?.runtimeId === runtimeId
      const matchesImplicitManagedDefault =
        implicitManagedRuntimeTarget(session, language, runtimeId) !== undefined
      if (!matchesBinding && !matchesImplicitManagedDefault) continue
      const targetProcessKey = processKey(language, environment)
      const status = session.kernelStatus(targetProcessKey)
      if (session.hasPendingExecution?.(targetProcessKey) || status === 'running')
        usage.running += 1
      else if (status !== undefined) usage.idle += 1
      else usage.dormant += 1
    }
    return usage
  }

  async revokeRuntime(
    language: NotebookLanguage,
    runtimeId: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const targetSessions = Array.from(this.options.sessions()).filter((session) => {
      const binding = session.runtimeBinding(language)
      return (
        (binding?.runtimeId === runtimeId && binding.status !== 'unavailable') ||
        implicitManagedRuntimeTarget(session, language, runtimeId) !== undefined
      )
    })
    const reservation = this.reserveRevocations(
      targetSessions.map((session) => runEnvironment(session, language))
    )
    const backgroundDrains: Promise<void>[] = []
    try {
      await this.options.bindings.runWrites(
        targetSessions.map((session) => session.sessionId),
        async () => {
          for (const session of targetSessions) {
            const current = Array.from(this.options.sessions()).find(
              (candidate) => candidate.sessionId === session.sessionId
            )
            if (current !== session) continue
            const bindingRevocation = await this.options.bindings.revoke(
              session,
              language,
              runtimeId,
              () => {
                const environment = runEnvironment(session, language)
                return { environment, processKey: processKey(language, environment) }
              }
            )
            const revocation =
              bindingRevocation ?? implicitManagedRuntimeTarget(session, language, runtimeId)
            if (!revocation) continue

            const { environment, processKey: revokedProcessKey } = revocation
            if (bindingRevocation) this.options.notifyChanged(session)
            if (options.force) {
              if (session.kernelStatus(revokedProcessKey) === 'running') {
                session.markForceStopped(revokedProcessKey)
              }
              // Start termination before waiting for the exclusive lease: an in-flight execution owns
              // a shared lease until the killed executor settles. The revocation reservation prevents
              // uninstall from crossing this handoff, and final teardown runs under the same exclusive
              // lease used by removal.
              const termination = session.terminateExecutor(
                language === 'r' ? 'r' : 'python',
                environment
              )
              await this.withLease('revocation', environment, 'exclusive', async () => {
                await termination
                await this.options.clearKernelTermination(session, revokedProcessKey)
                session.clearProcessState(revokedProcessKey)
                this.options.notifyChanged(session)
              })
              continue
            }

            // Revocation teardown and every prefix mutation share the environment's exclusive lease.
            // Whichever request arrives first completes its executor teardown/remove before the other
            // can proceed, so uninstall never deletes a prefix while this drain still owns a process.
            const drain = this.withLease('revocation', environment, 'exclusive', async () => {
              try {
                await session.drainExecution(revokedProcessKey)
                await session.terminateExecutor(language === 'r' ? 'r' : 'python', environment)
                await this.options.clearKernelTermination(session, revokedProcessKey)
                session.clearProcessState(revokedProcessKey)
                this.options.notifyChanged(session)
              } catch (error) {
                this.options.logger?.error('failed to drain or close a revoked runtime', {
                  ...errorLogFields(error),
                  environment
                })
              }
            })
            backgroundDrains.push(drain)
            this.revocationDrains.add(drain)
            void drain.finally(() => this.revocationDrains.delete(drain))
          }
        }
      )
    } finally {
      if (backgroundDrains.length > 0) {
        void Promise.all(backgroundDrains).then(reservation.release, reservation.release)
      } else {
        reservation.release()
      }
    }
  }

  waitForRevocationDrains(): Promise<void> {
    return Promise.all(Array.from(this.revocationDrains)).then(() => undefined)
  }

  recommendRestart(language: NotebookLanguage, environment: string): void {
    this.restartRecommendations.add(processKey(language, environment))
  }

  clearRestartRecommendations(processKeys: Iterable<string>): void {
    for (const key of processKeys) this.restartRecommendations.delete(key)
  }

  isRestartRecommended(environmentProcessKey: string): boolean {
    return this.restartRecommendations.has(environmentProcessKey)
  }

  isRepairBlocked(environmentKey: string): boolean {
    return this.repairBlocks.has(environmentKey)
  }

  blockRepair(environmentKey: string): void {
    this.repairBlocks.add(environmentKey)
  }

  clearRepair(environmentKey: string): void {
    this.repairBlocks.delete(environmentKey)
  }

  logPackageResult(input: PackageResultDiagnostic): void {
    try {
      const redacted = redactRuntimeDiagnosticValue({
        operationId: input.operationId,
        operation: input.operation,
        language: input.language,
        environmentName: input.environmentName,
        runtimeSource: input.runtimeSource,
        packages: input.packages,
        ok: input.result.ok,
        needsRestart: input.result.needsRestart,
        method: input.result.method,
        fallbackUsed: input.result.fallbackUsed,
        repairRequired: input.result.repairRequired,
        prefix: input.result.prefix,
        error: input.result.error,
        durationMs: input.durationMs,
        installerLog: boundedRuntimeDiagnostic(input.result.log)
      })
      const fields =
        redacted && typeof redacted === 'object' && !Array.isArray(redacted)
          ? (redacted as Record<string, unknown>)
          : { value: redacted }
      const level = input.result.ok ? 'info' : 'warn'
      this.recordDiagnostic(level, 'package installer completed', fields)
    } catch {
      // Diagnostics are best-effort and must never replace the installer result.
    }
  }

  logPackageFailure(input: PackageDiagnostic & { error: unknown }): void {
    try {
      const fields = {
        ...runtimeChildProcessErrorFields(input.error),
        operationId: input.operationId,
        operation: input.operation,
        language: input.language,
        environmentName: input.environmentName,
        runtimeSource: input.runtimeSource,
        packages: redactRuntimeDiagnosticValue(input.packages),
        durationMs: input.durationMs
      }
      this.recordDiagnostic('error', 'package installer threw', fields)
    } catch {
      // Diagnostics are best-effort and must never replace the installer failure.
    }
  }

  snapshot(): NotebookEnvironmentOperationsSnapshot {
    return {
      disposed: this.disposed,
      active: Array.from(this.active.values(), (operation) => ({ ...operation })).sort(
        (left, right) => left.startedAt - right.startedAt
      ),
      progress: this.progress
        ? {
            ...this.progress,
            download: this.progress.download ? { ...this.progress.download } : undefined
          }
        : undefined,
      restartRecommendedEnvironments: Array.from(this.restartRecommendations).sort(),
      revocationDrains: this.revocationDrains.size,
      repairBlockedEnvironments: Array.from(this.repairBlocks).sort(),
      diagnostic: this.diagnostic
        ? { ...this.diagnostic, fields: cloneDiagnosticFields(this.diagnostic.fields) }
        : undefined,
      leases: this.leases.snapshot(),
      recovery: this.options.recovery.snapshot()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leases.dispose()
  }

  private async withLease<T>(
    kind: EnvironmentOperationKind,
    environment: string,
    mode: EnvironmentLeaseMode,
    operation: () => Promise<T>
  ): Promise<T> {
    const lease = await this.leases.acquire(environment, mode).granted
    try {
      return await this.track(kind, environment, operation)
    } finally {
      lease.release()
    }
  }

  runProvisionAdmission<T>(environment: string, operation: () => Promise<T>): Promise<T> {
    if (this.removals.has(environment)) return Promise.reject(this.removalInProgress(environment))

    let resolveDrain!: () => void
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve
    })
    const drains = this.provisionDrains.get(environment) ?? new Set<Promise<void>>()
    drains.add(drain)
    this.provisionDrains.set(environment, drains)

    return this.track('provision', environment, operation).finally(() => {
      drains.delete(drain)
      if (drains.size === 0) this.provisionDrains.delete(environment)
      resolveDrain()
    })
  }

  private reserveRevocations(environments: Iterable<string>): { release: () => void } {
    const unique = Array.from(new Set(environments))
    for (const environment of unique) {
      if (this.removals.has(environment)) throw this.removalInProgress(environment)
    }
    if (unique.length === 0) return { release: () => undefined }

    let resolveDrain!: () => void
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve
    })
    for (const environment of unique) {
      const drains = this.revocationReservations.get(environment) ?? new Set<Promise<void>>()
      drains.add(drain)
      this.revocationReservations.set(environment, drains)
    }

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        for (const environment of unique) {
          const drains = this.revocationReservations.get(environment)
          drains?.delete(drain)
          if (drains?.size === 0) this.revocationReservations.delete(environment)
        }
        resolveDrain()
      }
    }
  }

  private async track<T>(
    kind: EnvironmentOperationKind,
    environment: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const identity = Symbol(kind)
    this.active.set(identity, { kind, environment, startedAt: (this.options.now ?? Date.now)() })
    try {
      return await operation()
    } finally {
      this.active.delete(identity)
    }
  }

  private recordDiagnostic(
    level: NotebookEnvironmentOperationDiagnostic['level'],
    message: string,
    fields: Record<string, unknown>
  ): void {
    try {
      this.diagnostic = { level, message, fields }
      this.options.logger?.[level](message, fields)
    } catch {
      // Diagnostics are best-effort and must never replace the installer result.
    }
  }

  private removalInProgress(environment: string): Error {
    return new Error(
      `RUNTIME_ENVIRONMENT_REMOVING: Runtime Environment "${environment}" is being uninstalled.`
    )
  }
}
