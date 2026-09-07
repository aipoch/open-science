import { isDeepStrictEqual } from 'node:util'
import type { NotebookLanguage } from '../../shared/notebook'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type NotebookRuntimeBinding,
  type RuntimeBindingOperationResult,
  type NotebookRuntimeBindings,
  type NotebookRuntimeListing,
  type RuntimeBindingUnavailableReason,
  type RuntimeTargetReceipt
} from '../../shared/notebook-runtime'
import type { NotebookRuntimeSettings } from '../settings/capabilities'
import { createLogger, diagnosticErrorFields } from '../logger'
import {
  defaultDiscoveryDeps,
  discoverInterpreters,
  rscriptFor,
  windowsCondaPrefixForR
} from './environment-discovery'
import { getRuntimeRoot, type NotebookRunRepository } from './repository'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from './runtime-paths'
import { runtimeTargetReceipt } from './runtime-target'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type {
  NotebookSessionAggregate,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'
import { historicalPosixManagedEnvironment } from './posix-runtime-binding'
import {
  historicalWindowsManagedEnvironment,
  managedRuntimeEnvironmentNamesMatch,
  managedRuntimeIdsDiffer
} from './windows-runtime-binding'

const log = createLogger('notebook:runtime-binding')

type RuntimeBindingSession = Pick<
  NotebookSessionAggregate,
  'runtimeBinding' | 'setRuntimeBinding'
> & {
  readonly projectId: string
  readonly sessionId: string
  readonly lane: NotebookSessionAggregate['lane']
}

type RuntimeBindingRepository = Pick<NotebookRunRepository, 'setRuntimeBindings' | 'findExisting'>

type NotebookRuntimeBindingOwnerOptions = {
  dataRoot: string
  repository: RuntimeBindingRepository
  runtimeSettings: Pick<NotebookRuntimeSettings, 'getSnapshot'> &
    Partial<Pick<NotebookRuntimeSettings, 'setEnvironmentEnabled'>>
  repairPolicy: Pick<NotebookRuntimeRepairPolicy, 'bindingRequirement'>
  discoverRuntimes?: (language: NotebookLanguage) => Promise<DiscoveredInterpreter[]>
  waitForEnvironmentStartup?: () => Promise<void>
  platform?: NodeJS.Platform
}

type AdmissionGate = {
  promise: Promise<void>
  release: () => void
}

const admissionGate = (): AdmissionGate => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const defaultEnvironment = (
  language: NotebookLanguage
): typeof DEFAULT_PY_ENV | typeof DEFAULT_R_ENV =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

/** Owns Notebook runtime discovery, selection, binding transitions, and durable wire snapshots. */
export class NotebookRuntimeBindingOwner {
  private readonly pendingWrites = new Map<string, AdmissionGate>()
  private activeWrites = 0
  private readonly activeWritesBySession = new Map<string, number>()
  private globalWriteGate: AdmissionGate | undefined
  private readonly sessionWriteGates = new Map<string, AdmissionGate>()
  private readonly allWriteDrainWaiters = new Set<() => void>()
  private readonly sessionWriteDrainWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly options: NotebookRuntimeBindingOwnerOptions) {}

  /**
   * Admits one complete binding write, including session creation and durable persistence. The lease
   * is session-scoped so unrelated notebook sessions retain their existing independent lifecycle.
   */
  runWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.runWrites([sessionId], operation)
  }

  runWrites<T>(sessionIds: Iterable<string>, operation: () => Promise<T>): Promise<T> {
    const admittedSessionIds = Array.from(new Set(sessionIds)).sort()
    return this.runWritesWhenAdmitted(admittedSessionIds, operation)
  }

  private runWritesWhenAdmitted<T>(sessionIds: string[], operation: () => Promise<T>): Promise<T> {
    const blockedBy = this.writeAdmissionGate(sessionIds)
    if (blockedBy) {
      return blockedBy.promise.then(() => this.runWritesWhenAdmitted(sessionIds, operation))
    }
    this.acquireWrites(sessionIds)

    // Reserve every affected lane together. Revocation, repair and explicit selections all mutate
    // the same binding snapshot; their read/modify/write sequences must share this queue.
    const predecessors = sessionIds.flatMap((id) => {
      const pending = this.pendingWrites.get(id)
      return pending ? [pending.promise] : []
    })
    const gate = admissionGate()
    for (const id of sessionIds) this.pendingWrites.set(id, gate)

    let result: Promise<T>
    try {
      // Start the operation synchronously with admission. In particular, ensureSession() must enter
      // the registry before a same-tick global teardown can close registry creation admission.
      result = predecessors.length > 0 ? Promise.all(predecessors).then(operation) : operation()
    } catch (error) {
      result = Promise.reject(error)
    }
    return result.finally(() => {
      for (const sessionId of sessionIds) {
        if (this.pendingWrites.get(sessionId) === gate) this.pendingWrites.delete(sessionId)
        this.releaseWrite(sessionId)
      }
      gate.release()
    })
  }

  /** Closes all binding writes while every session generation is torn down. */
  async withGlobalTeardown<T>(teardown: () => Promise<T>): Promise<T> {
    while (this.globalWriteGate) await this.globalWriteGate.promise
    const gate = admissionGate()
    this.globalWriteGate = gate
    try {
      return await teardown()
    } finally {
      if (this.globalWriteGate === gate) this.globalWriteGate = undefined
      gate.release()
    }
  }

  /** Closes only one session's binding writes while that generation is removed. */
  async withSessionTeardown<T>(sessionId: string, teardown: () => Promise<T>): Promise<T> {
    while (true) {
      const globalGate = this.globalWriteGate
      if (globalGate) {
        await globalGate.promise
        continue
      }
      const existing = this.sessionWriteGates.get(sessionId)
      if (existing) {
        await existing.promise
        continue
      }
      break
    }

    const gate = admissionGate()
    this.sessionWriteGates.set(sessionId, gate)
    try {
      return await teardown()
    } finally {
      if (this.sessionWriteGates.get(sessionId) === gate) {
        this.sessionWriteGates.delete(sessionId)
      }
      gate.release()
    }
  }

  waitForWrites(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      if (this.activeWrites === 0) return Promise.resolve()
      return new Promise<void>((resolve) => this.allWriteDrainWaiters.add(resolve))
    }
    if (!this.activeWritesBySession.has(sessionId)) return Promise.resolve()
    const waiters = this.sessionWriteDrainWaiters.get(sessionId) ?? new Set<() => void>()
    this.sessionWriteDrainWaiters.set(sessionId, waiters)
    return new Promise<void>((resolve) => waiters.add(resolve))
  }

  async list(session: RuntimeBindingSession): Promise<{
    runtimes: NotebookRuntimeListing[]
    bindings: NotebookRuntimeBindings
  }> {
    const runtimes: NotebookRuntimeListing[] = []
    for (const language of ['python', 'r'] as const) {
      const bound = session.runtimeBinding(language)
      for (const env of await this.listEnabledInterpreters(language)) {
        const binding = this.toInternalBinding(env)
        runtimes.push({
          language: binding.language,
          runtimeId: binding.runtimeId,
          source: binding.source,
          provenance: binding.provenance,
          interpreterPath: binding.interpreterPath,
          label: binding.label,
          version: binding.version,
          runnable: env.runnable,
          detail: env.detail,
          bound: bound?.runtimeId === binding.runtimeId
        })
      }
    }
    return { runtimes, bindings: this.snapshot(session) }
  }

  async dependencyInterpreter(
    language: NotebookLanguage,
    runtimeId: string
  ): Promise<
    Pick<NotebookSessionResolvedInterpreter, 'command' | 'args' | 'condaPrefix'> | undefined
  > {
    try {
      const binding = await this.resolveEnabledRuntime(language, runtimeId)
      const interpreter = binding.source === 'external' ? binding.resolvedInterpreter : undefined
      return interpreter
        ? {
            command: interpreter.command,
            ...(interpreter.args ? { args: interpreter.args } : {}),
            ...(interpreter.condaPrefix ? { condaPrefix: interpreter.condaPrefix } : {})
          }
        : undefined
    } catch {
      return undefined
    }
  }

  async bind(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    runtimeId: string,
    beforeBind?: (binding: NotebookSessionRuntimeBinding) => Promise<void>
  ): Promise<RuntimeBindingOperationResult> {
    return this.change(session, language, runtimeId, false, beforeBind)
  }

  async switch(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    runtimeId: string,
    beforeReplace: () => Promise<void>
  ): Promise<RuntimeBindingOperationResult> {
    return this.change(session, language, runtimeId, true, beforeReplace)
  }

  private async change(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    runtimeId: string,
    replace: boolean,
    beforeChange?: (binding: NotebookSessionRuntimeBinding) => Promise<void>
  ): Promise<RuntimeBindingOperationResult> {
    let binding: NotebookSessionRuntimeBinding
    try {
      binding = await this.resolveEnabledRuntime(language, runtimeId)
      const existing = session.runtimeBinding(language)
      if (!replace && existing && existing.runtimeId !== binding.runtimeId) {
        throw new Error(
          `A ${language} runtime is already bound for this session. Use ` +
            'notebook_switch_runtime to change it (it tears down the current kernel first).'
        )
      }
      if (replace || !existing) await beforeChange?.(binding)
    } catch (error) {
      return this.failureResult(session, language, error)
    }
    // Keep reconciliation failures outside the validation catch: an unreadable commit must not
    // be turned into a fabricated bindingChanged:false receipt.
    return this.commitBinding(session, binding)
  }

  private async commitBinding(
    session: RuntimeBindingSession,
    binding: NotebookSessionRuntimeBinding
  ): Promise<RuntimeBindingOperationResult> {
    const language = binding.language
    const previous = this.snapshot(session)
    const candidate = this.toWireBinding(binding)
    try {
      await this.options.repository.setRuntimeBindings(
        session.projectId,
        session.sessionId,
        { ...previous, [language]: candidate },
        session.lane
      )
    } catch (error) {
      // A rename may have succeeded before directory sync or cache refresh failed. Read the exact
      // lane back before deciding whether the old or the candidate binding is authoritative.
      try {
        const document = await this.options.repository.findExisting(
          session.projectId,
          session.sessionId,
          session.lane
        )
        if (!document) throw new Error('Notebook document is missing.')
        const wire = document.runtimeBindings?.[language]
        const stored = wire ? this.toWireBinding(wire) : undefined
        if (isDeepStrictEqual(stored, candidate)) {
          session.setRuntimeBinding(language, binding)
        } else if (!isDeepStrictEqual(stored, previous[language])) {
          throw new Error('Stored runtime binding differs from both attempted bindings.')
        }
      } catch (readError) {
        throw new Error(
          `Could not confirm stored runtime binding after ${String(error)}: ${String(readError)}`,
          { cause: error }
        )
      }
      return this.failureResult(
        session,
        language,
        error,
        !isDeepStrictEqual(previous[language], this.snapshot(session)[language])
      )
    }
    session.setRuntimeBinding(language, binding)
    return { bound: candidate, bindings: this.snapshot(session) }
  }

  private async failureResult(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    error: unknown,
    bindingChanged = false
  ): Promise<RuntimeBindingOperationResult> {
    return {
      ok: false,
      bindingChanged,
      error: error instanceof Error ? error.message : String(error),
      bindings: this.snapshot(session),
      target: await this.effectiveTarget(session, language)
    }
  }

  private async effectiveTarget(
    session: RuntimeBindingSession,
    language: NotebookLanguage
  ): Promise<RuntimeTargetReceipt> {
    const current = session.runtimeBinding(language)
    if (current) {
      return runtimeTargetReceipt({
        runtimeRoot: getRuntimeRoot(this.options.dataRoot),
        language,
        selection: 'explicit-binding',
        binding: current
      })
    }

    const environmentName = defaultEnvironment(language)
    const enabled = await this.listEnabledInterpreters(language)
    const implicit = enabled
      .map((environment) => this.toInternalBinding(environment))
      .find((binding) => binding.source === 'managed' && binding.envName === environmentName)
    return implicit
      ? runtimeTargetReceipt({
          runtimeRoot: getRuntimeRoot(this.options.dataRoot),
          language,
          selection: 'implicit-default',
          binding: implicit
        })
      : { language, selection: 'unresolved' }
  }

  async revoke<Context>(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    runtimeId: string,
    beforeRevoke: (binding: NotebookSessionRuntimeBinding) => Context
  ): Promise<Context | undefined> {
    const binding = session.runtimeBinding(language)
    if (!binding || binding.runtimeId !== runtimeId || binding.status === 'unavailable') {
      return undefined
    }
    const context = beforeRevoke(binding)
    const unavailable: NotebookSessionRuntimeBinding = {
      ...binding,
      status: 'unavailable',
      reason: 'disabled'
    }
    session.setRuntimeBinding(language, unavailable)
    await this.persist(session)
    return context
  }

  markUnavailable(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    reason: RuntimeBindingUnavailableReason
  ): boolean {
    const binding = session.runtimeBinding(language)
    if (!binding) return false
    session.setRuntimeBinding(language, { ...binding, status: 'unavailable', reason })
    return true
  }

  markAvailable(session: RuntimeBindingSession, language: NotebookLanguage): boolean {
    const binding = session.runtimeBinding(language)
    if (!binding || binding.status === 'active') return false
    session.setRuntimeBinding(language, { ...binding, status: 'active', reason: undefined })
    return true
  }

  snapshot(session: RuntimeBindingSession): NotebookRuntimeBindings {
    const python = session.runtimeBinding('python')
    const r = session.runtimeBinding('r')
    return {
      python: python ? this.toWireBinding(python) : undefined,
      r: r ? this.toWireBinding(r) : undefined
    }
  }

  async persist(session: RuntimeBindingSession): Promise<void> {
    try {
      await this.persistStrict(session)
    } catch (error) {
      log.error('failed to persist runtime bindings', {
        sessionId: session.sessionId,
        ...diagnosticErrorFields(error)
      })
    }
  }

  async persistStrict(session: RuntimeBindingSession): Promise<void> {
    await this.options.repository.setRuntimeBindings(
      session.projectId,
      session.sessionId,
      this.snapshot(session),
      session.lane
    )
  }

  async requireManagedDefault(
    language: NotebookLanguage,
    expectedRuntimeId?: string
  ): Promise<NotebookSessionRuntimeBinding> {
    const environment = defaultEnvironment(language)
    const settings = await this.runtimeSettingsSnapshot(language)
    const discovered = await this.discover(language, settings?.manualInterpreters ?? [])
    const match = discovered.find(
      (env) =>
        env.provenance === 'app-managed' &&
        env.condaEnv === environment &&
        (expectedRuntimeId === undefined || env.envId === expectedRuntimeId)
    )
    // A user-triggered reinstall must accept the exact discovered app-managed default even when its
    // interpreter is broken. The identity/provenance/env-name checks above still prove ownership;
    // only post-repair discovery (no expectedRuntimeId) requires the replacement to be runnable.
    if (!match || (expectedRuntimeId === undefined && !match.runnable)) {
      throw new Error(
        expectedRuntimeId === undefined
          ? `The app-managed ${language} runtime is not runnable.`
          : `The selected runtime is no longer the app-managed ${language} default. Recheck runtimes and try again.`
      )
    }
    return this.toInternalBinding(match)
  }

  async reload(
    session: RuntimeBindingSession,
    persisted: NotebookRuntimeBindings | undefined
  ): Promise<void> {
    if (!persisted) return
    // A relocated managed prefix is rebuilt asynchronously from envs.lock during application startup.
    // Do not classify its old-root binding as missing while that restore is still in flight: the live
    // aggregate would otherwise remain unavailable even after the replacement interpreter appears.
    if (Object.values(persisted).some((binding) => binding?.source === 'managed')) {
      await this.options.waitForEnvironmentStartup?.()
    }
    let migratedHistoricalBinding = false
    for (const language of ['python', 'r'] as const) {
      const wire = persisted[language]
      if (!wire) continue
      try {
        session.setRuntimeBinding(
          language,
          await this.resolveEnabledRuntime(language, wire.runtimeId)
        )
      } catch {
        const migrated = await this.historicalManagedEnvironmentReplacement(language, wire)
        if (migrated) {
          session.setRuntimeBinding(language, migrated)
          migratedHistoricalBinding = true
          continue
        }
        const settings = await this.runtimeSettingsSnapshot(language)
        const discovered = await this.discover(language, settings?.manualInterpreters ?? [])
        const stillDetected = discovered.some((env) => env.envId === wire.runtimeId)
        session.setRuntimeBinding(language, {
          language,
          runtimeId: wire.runtimeId,
          source: wire.source,
          provenance: wire.provenance,
          interpreterPath: wire.interpreterPath,
          label: wire.label,
          version: wire.version,
          status: 'unavailable',
          reason: stillDetected ? 'disabled' : 'missing'
        })
      }
    }
    if (migratedHistoricalBinding) {
      // Persist once after both languages are restored so migrating one binding never temporarily
      // drops the other. A later launch must not rediscover the old-root prefix as missing.
      await this.persistStrict(session)
    }
  }

  private async historicalManagedEnvironmentReplacement(
    language: NotebookLanguage,
    wire: NotebookRuntimeBinding
  ): Promise<NotebookSessionRuntimeBinding | undefined> {
    const platform = this.options.platform ?? process.platform
    const historical =
      historicalWindowsManagedEnvironment({ language, platform, wire }) ??
      historicalPosixManagedEnvironment({ language, platform, wire })
    if (!historical) return undefined

    const settings = await this.runtimeSettingsSnapshot(language)
    const discovered = await this.discover(language, settings?.manualInterpreters ?? [])
    const previousEnablement = settings?.runtimeEnablement.enabled[wire.runtimeId]
    const wasDisabled =
      previousEnablement === false ||
      (previousEnablement === undefined && wire.reason === 'disabled')
    const replacement = discovered.find(
      (env) =>
        env.provenance === wire.provenance &&
        managedRuntimeEnvironmentNamesMatch({
          platform,
          candidate: env.condaEnv,
          expected: historical.environment
        }) &&
        env.runnable &&
        managedRuntimeIdsDiffer({
          platform,
          candidate: env.envId,
          previous: historical.interpreterKey
        }) &&
        (wasDisabled || isEnvEnabled(env, settings?.runtimeEnablement))
    )
    if (!replacement) return undefined

    const binding = this.toInternalBinding(replacement)
    if (wasDisabled) {
      const setEnvironmentEnabled = this.options.runtimeSettings.setEnvironmentEnabled
      if (!setEnvironmentEnabled) return undefined
      try {
        await setEnvironmentEnabled(language, replacement.envId, false)
      } catch {
        return undefined
      }
      return { ...binding, status: 'unavailable', reason: 'disabled' }
    }
    return this.options.repairPolicy.bindingRequirement(
      language,
      binding.envName ?? historical.environment,
      binding
    ).required
      ? { ...binding, status: 'unavailable', reason: 'repair-required' }
      : binding
  }

  private async discover(
    language: NotebookLanguage,
    manualInterpreters: string[]
  ): Promise<DiscoveredInterpreter[]> {
    try {
      const injected = this.options.discoverRuntimes
      return injected
        ? await injected(language)
        : discoverInterpreters(
            language,
            defaultDiscoveryDeps(getRuntimeRoot(this.options.dataRoot), () => manualInterpreters, {
              platform: this.options.platform
            })
          )
    } catch {
      return []
    }
  }

  private async listEnabledInterpreters(
    language: NotebookLanguage
  ): Promise<DiscoveredInterpreter[]> {
    const settings = await this.runtimeSettingsSnapshot(language)
    const discovered = await this.discover(language, settings?.manualInterpreters ?? [])
    return discovered.filter((env) => isEnvEnabled(env, settings?.runtimeEnablement))
  }

  private async resolveEnabledRuntime(
    language: NotebookLanguage,
    runtimeId: string
  ): Promise<NotebookSessionRuntimeBinding> {
    const enabled = await this.listEnabledInterpreters(language)
    const match = enabled.find((env) => env.envId === runtimeId)
    if (!match) {
      throw new Error(
        `"${runtimeId}" is not an enabled ${language} runtime. Use list_notebook_runtimes to see the ` +
          'available runtimes, or enable it in Settings → Runtimes first (disabled and unknown ' +
          'runtimes are refused).'
      )
    }
    const binding = this.toInternalBinding(match)
    const environment = binding.envName ?? defaultEnvironment(language)
    return this.options.repairPolicy.bindingRequirement(language, environment, binding).required
      ? { ...binding, status: 'unavailable', reason: 'repair-required' }
      : binding
  }

  private toInternalBinding(env: DiscoveredInterpreter): NotebookSessionRuntimeBinding {
    const source = env.provenance === 'user-own' ? 'external' : 'managed'
    const externalRCondaPrefix =
      source === 'external' && env.language === 'r'
        ? windowsCondaPrefixForR(env.interpreterPath, this.options.platform ?? process.platform)
        : undefined
    return {
      language: env.language,
      runtimeId: env.envId,
      source,
      provenance: env.provenance,
      interpreterPath: env.interpreterPath,
      label: env.label,
      version: env.version,
      status: 'active',
      resolvedInterpreter:
        source === 'external'
          ? {
              command: env.language === 'r' ? rscriptFor(env.interpreterPath) : env.interpreterPath,
              ...(externalRCondaPrefix ? { condaPrefix: externalRCondaPrefix } : {})
            }
          : undefined,
      envName: source === 'managed' ? (env.condaEnv ?? defaultEnvironment(env.language)) : undefined
    }
  }

  private toWireBinding(binding: NotebookSessionRuntimeBinding): NotebookRuntimeBinding {
    return {
      language: binding.language,
      runtimeId: binding.runtimeId,
      source: binding.source,
      provenance: binding.provenance,
      interpreterPath: binding.interpreterPath,
      label: binding.label,
      version: binding.version,
      status: binding.status ?? 'active',
      reason: binding.reason
    }
  }

  private async runtimeSettingsSnapshot(
    language: NotebookLanguage
  ): Promise<Awaited<ReturnType<NotebookRuntimeSettings['getSnapshot']>> | undefined> {
    try {
      return await this.options.runtimeSettings.getSnapshot(language)
    } catch {
      return undefined
    }
  }

  private writeAdmissionGate(sessionIds: string[]): AdmissionGate | undefined {
    return (
      this.globalWriteGate ??
      sessionIds
        .map((sessionId) => this.sessionWriteGates.get(sessionId))
        .find((gate): gate is AdmissionGate => gate !== undefined)
    )
  }

  private acquireWrites(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.activeWrites += 1
      this.activeWritesBySession.set(
        sessionId,
        (this.activeWritesBySession.get(sessionId) ?? 0) + 1
      )
    }
  }

  private releaseWrite(sessionId: string): void {
    this.activeWrites -= 1
    const remaining = (this.activeWritesBySession.get(sessionId) ?? 1) - 1
    if (remaining === 0) {
      this.activeWritesBySession.delete(sessionId)
      const waiters = this.sessionWriteDrainWaiters.get(sessionId)
      if (waiters) {
        this.sessionWriteDrainWaiters.delete(sessionId)
        for (const resolve of waiters) resolve()
      }
    } else {
      this.activeWritesBySession.set(sessionId, remaining)
    }
    if (this.activeWrites === 0) {
      for (const resolve of this.allWriteDrainWaiters) resolve()
      this.allWriteDrainWaiters.clear()
    }
  }
}
