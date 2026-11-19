import { performance } from 'node:perf_hooks'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { DEFAULT_NOTEBOOK_MEMORY_POLICY, type NotebookMemoryPolicy } from './memory-policy-config'

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical'
export type MemoryPolicyStatus = 'healthy' | 'pressured' | 'unavailable'
export type MemoryPolicyPlatform = 'win32' | 'darwin' | 'linux'

export type MemoryCgroupConstraint = {
  path: string
  currentBytes: number
  maxBytes?: number
  highBytes?: number
}

export type MemoryPolicyFacts = {
  availableBytes?: number
  totalBytes?: number
  committedBytes?: number
  commitLimitBytes?: number
  overcommitMode?: 0 | 1 | 2
  pressureLevel?: MemoryPressureLevel
  pressureEventSequence?: number
  cgroup?: {
    version: 1 | 2
    constraints: MemoryCgroupConstraint[]
    ancestors: 'complete' | 'certified'
  }
}

export type MemoryPolicySample = {
  platform: MemoryPolicyPlatform
  source: string
  executionScope: string
  facts: MemoryPolicyFacts
}

export type MemoryPolicyReason = {
  code: string
  detail?: string
  // A local limit cannot authorize reclamation in unrelated cgroups.
  pressureScope?: 'host' | 'execution-domain'
  constraintPath?: string
  recoveryRemainingMs?: number
  retryAfterMs?: number
}

export type MemoryPolicyObservation = {
  status: MemoryPolicyStatus
  reason: MemoryPolicyReason
  source: string
  executionScope: string
  sampledAt?: number
  sampleAgeMs?: number
  facts?: MemoryPolicyFacts
}

export class MemoryPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MemoryPolicyError'
  }
}

export type MemoryPolicyInvalidation = {
  reason?: string
  pressureLevel?: MemoryPressureLevel
}

export type MemoryPolicyAdapter = {
  readonly platform: MemoryPolicyPlatform
  readonly defaultExecutionScope?: string
  sample(signal: AbortSignal, executionScope?: string): Promise<MemoryPolicySample>
  isCurrent?(): boolean
  subscribe?(listener: (event?: MemoryPolicyInvalidation) => void): () => void
  dispose?(): void
}

type DomainState = {
  sample?: MemoryPolicySample
  sampledAt?: number
  wallSampledAt?: number
  observation?: MemoryPolicyObservation
  pressure: boolean
  normalSince?: number
  pressureEventSequence: number
  generation: number
  pending?: Promise<MemoryPolicyObservation>
  settling?: Promise<unknown>
  controller?: AbortController
  nextSampleAt: number
}

type Options = {
  adapter: MemoryPolicyAdapter
  policy?: NotebookMemoryPolicy
  now?: () => number
  wallNow?: () => number
  maxAgeMs?: number
  sampleTimeoutMs?: number
}

type Request = {
  signal?: AbortSignal
  executionScope?: string
  force?: boolean
  maxAgeMs?: number
}

const freshForExecutionMs = 2000
const freshForReclamationMs = 10_000
const sampleTimeoutMs = 5000
const errorBackoffMs = 30_000

const validBytes = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0

const unavailable = (code: string, detail?: string): MemoryPolicyReason => ({
  code,
  ...(detail ? { detail } : {})
})

const pressureReason = (code: string, constraintPath?: string): MemoryPolicyReason => ({
  code,
  pressureScope: constraintPath ? 'execution-domain' : 'host',
  ...(constraintPath ? { constraintPath } : {})
})

const abortError = (): Error =>
  Object.assign(new Error('Memory check cancelled.'), { name: 'AbortError' })

// This owner holds only runtime policy state. It neither starts execution nor releases resources.
export class MemoryPolicyService {
  private readonly domains = new Map<string, DomainState>()
  private readonly listeners = new Set<(state: MemoryPolicyObservation) => void>()
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly policy: NotebookMemoryPolicy
  private readonly maxAgeMs: number
  private readonly timeoutMs: number
  private readonly unsubscribe?: () => void
  private active = false
  private closed = false
  private notificationFailureLogged = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.policy = options.policy ?? DEFAULT_NOTEBOOK_MEMORY_POLICY
    this.maxAgeMs = Math.min(options.maxAgeMs ?? freshForExecutionMs, freshForReclamationMs)
    this.timeoutMs = Math.min(options.sampleTimeoutMs ?? sampleTimeoutMs, sampleTimeoutMs)
    this.unsubscribe = options.adapter.subscribe?.((event) => this.invalidate(event))
  }

  matchesDefaultScope(executionScope: string): boolean {
    const defaultScope = this.options.adapter.defaultExecutionScope
    return (
      !this.closed &&
      (executionScope === defaultScope ||
        executionScope === this.domains.get(defaultScope ?? 'default')?.observation?.executionScope)
    )
  }

  getState(request: Request = {}): Promise<MemoryPolicyObservation> {
    if (request.signal?.aborted) return Promise.reject(abortError())
    const key = request.executionScope ?? this.options.adapter.defaultExecutionScope ?? 'default'
    const state = this.domain(key)
    if (this.closed) return Promise.resolve(this.unavailableState(key, 'disposed'))
    const current = this.currentState(request)
    if (!request.force && current.reason.code !== 'sample-expired' && state.sample) {
      return Promise.resolve(current)
    }
    if (state.pending) return this.waitFor(state.pending, request)
    // A forced user check bypasses only the error backoff. It never overlaps a timed-out read.
    if (state.settling || (!request.force && this.now() < state.nextSampleAt)) {
      const next = state.observation ?? this.unavailableState(key, 'sample-pending')
      return Promise.resolve({
        ...next,
        reason: {
          ...next.reason,
          retryAfterMs: Math.max(0, state.nextSampleAt - this.now())
        }
      })
    }
    const work = this.sample(key, state, request.executionScope)
    state.pending = work
    void work.finally(() => {
      if (state.pending === work) state.pending = undefined
      this.schedule()
    })
    return this.waitFor(work, request)
  }

  // Call immediately before a synchronous dispatch/teardown commit, after all async gates.
  currentState(
    request: Pick<Request, 'executionScope' | 'maxAgeMs'> = {}
  ): MemoryPolicyObservation {
    const key = request.executionScope ?? this.options.adapter.defaultExecutionScope ?? 'default'
    const state = this.domain(key)
    if (this.closed) return this.unavailableState(key, 'disposed')
    if (!state.sample || state.sampledAt === undefined) {
      return state.observation ?? this.unavailableState(key, 'sample-missing')
    }
    if (this.options.adapter.isCurrent?.() === false) {
      this.invalidate('platform-event')
      return this.unavailableState(key, 'platform-event')
    }
    const age = Math.max(0, this.now() - state.sampledAt)
    const wallAge = this.wallNow() - (state.wallSampledAt ?? this.wallNow())
    const allowedAge = Math.min(request.maxAgeMs ?? this.maxAgeMs, freshForReclamationMs)
    if (age > allowedAge || wallAge < 0 || wallAge > allowedAge)
      return this.unavailableState(key, 'sample-expired', age)
    return { ...state.observation!, sampleAgeMs: age }
  }

  subscribe(listener: (state: MemoryPolicyObservation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) {
      clearTimeout(this.timer)
      this.timer = undefined
    } else {
      this.schedule(true)
    }
  }

  invalidate(event: MemoryPolicyInvalidation | string = 'invalidated'): void {
    const code = typeof event === 'string' ? event : (event.reason ?? 'platform-event')
    for (const [key, state] of this.domains) {
      state.generation++
      state.sample = undefined
      state.normalSince = undefined
      if (typeof event !== 'string' && event.pressureLevel && event.pressureLevel !== 'normal') {
        state.pressure = true
      }
      state.controller?.abort()
      state.observation = this.unavailableState(key, code)
      this.publish(state.observation)
    }
    this.schedule(true)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.active = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    for (const state of this.domains.values()) {
      state.generation++
      state.controller?.abort()
    }
    this.options.adapter.dispose?.()
    this.listeners.clear()
  }

  private domain(key: string): DomainState {
    let state = this.domains.get(key)
    if (!state) {
      state = { pressure: false, pressureEventSequence: 0, generation: 0, nextSampleAt: -Infinity }
      this.domains.set(key, state)
    }
    return state
  }

  private async sample(
    key: string,
    state: DomainState,
    requestedScope?: string
  ): Promise<MemoryPolicyObservation> {
    const generation = state.generation
    const started = this.now()
    const wallStarted = this.wallNow()
    const controller = new AbortController()
    state.controller = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    let abort: (() => void) | undefined
    const work = Promise.resolve().then(() =>
      this.options.adapter.sample(controller.signal, requestedScope)
    )
    state.settling = work
    void work
      .finally(() => {
        if (state.settling === work) state.settling = undefined
      })
      .catch(() => undefined)
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(
              new MemoryPolicyError(
                expired ? 'sample-timeout' : 'sample-invalidated',
                'The memory sample was invalidated before it completed.'
              )
            )
          controller.signal.addEventListener('abort', abort, { once: true })
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true
            controller.abort()
            reject(
              new MemoryPolicyError('sample-timeout', 'Memory sampling exceeded its deadline.')
            )
          }, this.timeoutMs)
        })
      ])
      if (expired || this.closed || state.generation !== generation || controller.signal.aborted) {
        return this.unavailableState(key, this.closed ? 'disposed' : 'sample-invalidated')
      }
      if (this.now() - started > this.timeoutMs) {
        throw new MemoryPolicyError('sample-timeout', 'Memory sampling exceeded its deadline.')
      }
      const reason = this.evaluate(state, result)
      state.sample = result
      state.sampledAt = started
      state.wallSampledAt = wallStarted
      state.nextSampleAt = -Infinity
      state.observation = {
        status: state.pressure ? 'pressured' : 'healthy',
        reason,
        source: result.source,
        executionScope: result.executionScope,
        sampledAt: state.sampledAt,
        sampleAgeMs: Math.max(0, this.now() - started),
        facts: result.facts
      }
      this.publish(this.currentState({ executionScope: key }))
      return state.observation
    } catch (error) {
      if (this.closed || state.generation !== generation) {
        return this.unavailableState(key, this.closed ? 'disposed' : 'sample-invalidated')
      }
      state.sample = undefined
      state.normalSince = undefined
      state.nextSampleAt = this.now() + errorBackoffMs
      state.observation = this.unavailableState(
        key,
        error instanceof MemoryPolicyError ? error.code : 'sample-failed',
        undefined,
        error instanceof MemoryPolicyError ? error.message : undefined
      )
      this.publish(state.observation)
      return state.observation
    } finally {
      clearTimeout(timer)
      if (abort) controller.signal.removeEventListener('abort', abort)
      if (state.controller === controller) state.controller = undefined
    }
  }

  private evaluate(state: DomainState, sample: MemoryPolicySample): MemoryPolicyReason {
    if (
      sample.platform !== this.options.adapter.platform ||
      !sample.source ||
      !sample.executionScope
    ) {
      throw new MemoryPolicyError(
        'sample-invalid',
        'The memory sample has no verified execution domain.'
      )
    }
    const facts = sample.facts
    if (sample.platform === 'darwin') {
      if (
        !Number.isSafeInteger(facts.pressureEventSequence) ||
        (facts.pressureEventSequence ?? -1) < state.pressureEventSequence
      ) {
        throw new MemoryPolicyError(
          'sample-invalid',
          'The macOS pressure event history is incomplete.'
        )
      }
      if (facts.pressureEventSequence! > state.pressureEventSequence) {
        state.pressure = true
        state.normalSince = undefined
        state.pressureEventSequence = facts.pressureEventSequence!
      }
      if (!['normal', 'warning', 'critical'].includes(facts.pressureLevel ?? '')) {
        throw new MemoryPolicyError(
          'sample-invalid',
          'The current macOS pressure level is unavailable.'
        )
      }
      if (facts.pressureLevel !== 'normal') {
        state.pressure = true
        state.normalSince = undefined
        return pressureReason(
          facts.pressureLevel === 'critical' ? 'mac-memory-critical' : 'mac-memory-warning'
        )
      }
      if (!state.pressure) return { code: 'healthy' }
      const now = this.now()
      if (state.sampledAt === undefined || now - state.sampledAt > freshForReclamationMs) {
        state.normalSince = undefined
      }
      state.normalSince ??= now
      const remaining = this.policy.macNormalRecoveryMs - (now - state.normalSince)
      if (remaining > 0)
        return { ...pressureReason('mac-memory-recovering'), recoveryRemainingMs: remaining }
      state.pressure = false
      state.normalSince = undefined
      return { code: 'healthy' }
    }

    const signals: Array<{ ratio: number; reason: MemoryPolicyReason; high?: boolean }> = []
    if (
      !validBytes(facts.totalBytes) ||
      facts.totalBytes === 0 ||
      !validBytes(facts.availableBytes) ||
      facts.availableBytes > facts.totalBytes
    ) {
      throw new MemoryPolicyError(
        'sample-invalid',
        'Physical memory counters are incomplete or invalid.'
      )
    }
    signals.push({
      ratio: facts.availableBytes / facts.totalBytes,
      reason: pressureReason(
        sample.platform === 'win32' ? 'windows-physical-low' : 'linux-memory-low'
      )
    })
    if (sample.platform === 'win32' || facts.overcommitMode === 2) {
      if (
        !validBytes(facts.commitLimitBytes) ||
        facts.commitLimitBytes === 0 ||
        !validBytes(facts.committedBytes) ||
        (sample.platform === 'win32' && facts.committedBytes > facts.commitLimitBytes)
      ) {
        throw new MemoryPolicyError(
          'sample-invalid',
          'Applicable commit memory counters are incomplete or invalid.'
        )
      }
      signals.push({
        ratio: (facts.commitLimitBytes - facts.committedBytes) / facts.commitLimitBytes,
        reason: pressureReason(
          sample.platform === 'win32' ? 'windows-commit-low' : 'linux-commit-low'
        )
      })
    }
    if (sample.platform === 'linux') {
      if (![0, 1, 2].includes(facts.overcommitMode ?? -1)) {
        throw new MemoryPolicyError('sample-invalid', 'Linux overcommit applicability is unknown.')
      }
      if (facts.cgroup) {
        if (!['complete', 'certified'].includes(facts.cgroup.ancestors)) {
          throw new MemoryPolicyError(
            'sample-invalid',
            'The cgroup ancestor limits are not visible.'
          )
        }
        for (const constraint of facts.cgroup.constraints) {
          if (!validBytes(constraint.currentBytes)) {
            throw new MemoryPolicyError('sample-invalid', 'A cgroup usage counter is invalid.')
          }
          for (const [kind, limit] of [
            ['max', constraint.maxBytes],
            ['high', constraint.highBytes]
          ] as const) {
            if (limit === undefined) continue
            if (!validBytes(limit))
              throw new MemoryPolicyError('sample-invalid', 'A cgroup limit is invalid.')
            signals.push({
              ratio: limit === 0 ? -Infinity : (limit - constraint.currentBytes) / limit,
              reason: pressureReason(
                kind === 'high' ? 'linux-cgroup-high' : 'linux-cgroup-low',
                constraint.path
              ),
              high: kind === 'high'
            })
          }
        }
      }
    }
    const enter =
      sample.platform === 'win32' ? this.policy.windowsEnterRatio : this.policy.linuxEnterRatio
    const exit =
      sample.platform === 'win32' ? this.policy.windowsExitRatio : this.policy.linuxExitRatio
    const entering = signals.find((signal) => signal.ratio <= (signal.high ? 0 : enter))
    if (entering) {
      state.pressure = true
      return entering.reason
    }
    if (state.pressure) {
      const holding = signals.find((signal) => signal.ratio <= (signal.high ? 0.2 : exit))
      if (holding) return holding.reason
    }
    state.pressure = false
    return { code: 'healthy' }
  }

  private unavailableState(
    key: string,
    code: string,
    age?: number,
    detail?: string
  ): MemoryPolicyObservation {
    const state = this.domains.get(key)
    return {
      status: 'unavailable',
      reason: unavailable(code, detail),
      source: state?.sample?.source ?? this.options.adapter.platform,
      executionScope: state?.observation?.executionScope ?? key,
      ...(state?.sampledAt === undefined ? {} : { sampledAt: state.sampledAt }),
      ...(age === undefined ? {} : { sampleAgeMs: age })
    }
  }

  private waitFor(
    work: Promise<MemoryPolicyObservation>,
    request: Request
  ): Promise<MemoryPolicyObservation> {
    const current = work.then((observation) =>
      observation.status === 'unavailable' ? observation : this.currentState(request)
    )
    const { signal } = request
    if (!signal) return current
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        reject(abortError())
      }
      signal.addEventListener('abort', abort, { once: true })
      void current.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private publish(observation: MemoryPolicyObservation): void {
    if (this.closed) return
    for (const listener of this.listeners) {
      try {
        listener(observation)
      } catch (error) {
        if (this.notificationFailureLogged) continue
        this.notificationFailureLogged = true
        try {
          createLogger('notebook:memory-policy').warn(
            'Memory policy notification failed; further notification errors will be suppressed',
            errorLogFields(error)
          )
        } catch {
          // Notification and diagnostic failures cannot change sampled memory facts.
        }
      }
    }
  }

  private schedule(immediate = false): void {
    if (!this.active || this.closed || this.timer) return
    const states = [...this.domains.values()]
    const pressured = states.some((state) => state.pressure)
    const delay = immediate ? 0 : pressured ? 5000 : 10_000
    this.timer = setTimeout(() => {
      this.timer = undefined
      const keys = this.domains.size ? [...this.domains.keys()] : ['default']
      void Promise.all(
        keys.map((key) =>
          this.getState({
            ...(key === 'default' ? {} : { executionScope: key }),
            force: true
          })
        )
      ).finally(() => this.schedule())
    }, delay)
    this.timer.unref()
  }
}
