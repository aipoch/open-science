import type { NotebookKernelMetadata, NotebookLanguage } from '../../shared/notebook'
import type { ProvisionProgress } from '../../shared/notebook-env'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import { notebookLaneKey, type NotebookLaneIdentity } from './lane-identity'
import { EnvironmentLeaseManager, type EnvironmentLeaseMode } from './environment-lease-manager'
import type { NotebookRecoveryCoordinator } from './recovery-coordinator'
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
  readonly lane: NotebookLaneIdentity
  runtimeBinding(language: NotebookLanguage): NotebookSessionRuntimeBinding | undefined
  setRuntimeBinding(language: NotebookLanguage, binding: NotebookSessionRuntimeBinding): void
  kernelStatus(processKey: string): NotebookKernelMetadata['lastKnownStatus'] | undefined
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
  private readonly repairBlocks = new Set<string>()
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
    await this.track('provision', input.environment, async () => {
      try {
        if (input.language === 'r') await provisioner.provisionR(report)
        else await provisioner.provisionPython(report)
      } catch (error) {
        const message = `Could not prepare ${input.environment}: ${
          error instanceof Error ? error.message : String(error)
        }`
        report({ phase: 'error', diagnostic: message, progress: 0, language: input.language })
        throw new Error(message, { cause: error })
      }
    })
  }

  runShared<T>(
    kind: Extract<EnvironmentOperationKind, 'execution' | 'inspection'>,
    environment: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withLease(kind, environment, 'shared', operation)
  }

  runMutation<T>(environment: string, operation: () => Promise<T>): Promise<T> {
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
      if (!binding || binding.runtimeId !== runtimeId) continue
      const status = session.kernelStatus(processKey(language, runEnvironment(session, language)))
      if (status === 'running') usage.running += 1
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
    // A pending selection can enter or leave this runtime. Match after the lane's earlier binding
    // writes settle, rather than omitting a not-yet-published selection from revocation.
    const targetSessions = Array.from(this.options.sessions())
    await this.options.bindings.runWrites(
      targetSessions.map((session) => notebookLaneKey(session.lane)),
      async () => {
        for (const session of targetSessions) {
          if (!Array.from(this.options.sessions()).includes(session)) continue
          const revocation = await this.options.bindings.revoke(
            session,
            language,
            runtimeId,
            () => {
              const environment = runEnvironment(session, language)
              return { environment, processKey: processKey(language, environment) }
            }
          )
          if (!revocation) continue

          const { environment, processKey: revokedProcessKey } = revocation
          this.options.notifyChanged(session)
          if (options.force) {
            if (session.kernelStatus(revokedProcessKey) === 'running') {
              session.markForceStopped(revokedProcessKey)
            }
            await session.terminateExecutor(language === 'r' ? 'r' : 'python', environment)
            await this.options.clearKernelTermination(session, revokedProcessKey)
            session.clearProcessState(revokedProcessKey)
            this.options.notifyChanged(session)
            continue
          }

          const drain = this.track('revocation', environment, async () => {
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
          this.revocationDrains.add(drain)
          void drain.finally(() => this.revocationDrains.delete(drain))
        }
      }
    )
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
}
