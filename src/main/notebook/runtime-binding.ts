import type { NotebookLanguage } from '../../shared/notebook'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type NotebookRuntimeBinding,
  type NotebookRuntimeBindings,
  type NotebookRuntimeListing,
  type RuntimeBindingUnavailableReason
} from '../../shared/notebook-runtime'
import type { NotebookRuntimeSettings } from '../settings/capabilities'
import {
  defaultDiscoveryDeps,
  discoverInterpreters,
  rscriptFor,
  windowsCondaPrefixForR
} from './environment-discovery'
import { getRuntimeRoot, type NotebookRunRepository } from './repository'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from './runtime-paths'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type {
  NotebookSessionAggregate,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'

type RuntimeBindingSession = Pick<
  NotebookSessionAggregate,
  'runtimeBinding' | 'setRuntimeBinding'
> & {
  readonly projectId: string
  readonly sessionId: string
  readonly lane: NotebookSessionAggregate['lane']
}

type RuntimeBindingRepository = Pick<NotebookRunRepository, 'setRuntimeBindings'>

type NotebookRuntimeBindingOwnerOptions = {
  dataRoot: string
  repository: RuntimeBindingRepository
  runtimeSettings: Pick<NotebookRuntimeSettings, 'getSnapshot'>
  repairPolicy: Pick<NotebookRuntimeRepairPolicy, 'bindingRequirement'>
  discoverRuntimes?: (language: NotebookLanguage) => Promise<DiscoveredInterpreter[]>
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

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

/** Owns Notebook runtime discovery, selection, binding transitions, and durable wire snapshots. */
export class NotebookRuntimeBindingOwner {
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

    let result: Promise<T>
    try {
      // Start the operation synchronously with admission. In particular, ensureSession() must enter
      // the registry before a same-tick global teardown can close registry creation admission.
      result = operation()
    } catch (error) {
      for (const sessionId of sessionIds) this.releaseWrite(sessionId)
      return Promise.reject(error)
    }
    return result.finally(() => {
      for (const sessionId of sessionIds) this.releaseWrite(sessionId)
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
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    const binding = await this.resolveEnabledRuntime(language, runtimeId)
    const existing = session.runtimeBinding(language)
    if (existing && existing.runtimeId !== binding.runtimeId) {
      throw new Error(
        `A ${language} runtime is already bound for this session. Use ` +
          'notebook_switch_runtime to change it (it tears down the current kernel first).'
      )
    }
    if (!existing) await beforeBind?.(binding)
    session.setRuntimeBinding(language, binding)
    await this.persist(session)
    return { bound: this.toWireBinding(binding), bindings: this.snapshot(session) }
  }

  async switch(
    session: RuntimeBindingSession,
    language: NotebookLanguage,
    runtimeId: string,
    beforeReplace: () => Promise<void>
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    const binding = await this.resolveEnabledRuntime(language, runtimeId)
    await beforeReplace()
    session.setRuntimeBinding(language, binding)
    await this.persist(session)
    return { bound: this.toWireBinding(binding), bindings: this.snapshot(session) }
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
      await this.options.repository.setRuntimeBindings(
        session.projectId,
        session.sessionId,
        this.snapshot(session),
        session.lane
      )
    } catch (error) {
      console.error('[notebook] Failed to persist runtime bindings', error)
    }
  }

  async reload(
    session: RuntimeBindingSession,
    persisted: NotebookRuntimeBindings | undefined
  ): Promise<void> {
    if (!persisted) return
    for (const language of ['python', 'r'] as const) {
      const wire = persisted[language]
      if (!wire) continue
      try {
        session.setRuntimeBinding(
          language,
          await this.resolveEnabledRuntime(language, wire.runtimeId)
        )
      } catch {
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
            defaultDiscoveryDeps(getRuntimeRoot(this.options.dataRoot), () => manualInterpreters)
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
