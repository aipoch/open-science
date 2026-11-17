import { createRequire } from 'node:module'
import type { WindowsResourceSample } from '@aipoch/process-tree-native'
import { LinuxMemoryPolicyAdapter } from './memory-policy-linux'
import {
  MemoryPolicyError,
  type MemoryPolicyAdapter,
  type MemoryPolicyInvalidation,
  type MemoryPolicySample,
  type MemoryPressureLevel
} from './memory-policy'

const requireNative = createRequire(import.meta.url)

type WindowsBinding = {
  sampleWindowsResources?: (
    includeProcesses: boolean,
    retained: readonly { pid: number; birth: string }[]
  ) => Promise<WindowsResourceSample>
}

type DarwinPressureEvent = { pressureLevel: number; eventSequence: number }
type DarwinBinding = {
  sampleDarwinMemoryPressure?: () => Promise<{
    supported: boolean
    complete: boolean
    pressureLevel?: number
    eventSequence: number
    pressureEventSequence?: number
    error?: number
  }>
  subscribeDarwinMemoryPressure?: (listener: (event: DarwinPressureEvent) => void) => object | null
  stopDarwinMemoryPressureSubscription?: (subscription: object) => void
  darwinMemoryPressureEventSequence?: () => number
}

function missingComponent(): never {
  throw new MemoryPolicyError(
    'memory-component-unavailable',
    'The memory checking component is incompatible or missing. Update or repair the installation before running Notebook code.'
  )
}

const verifyHost = (requested: string | undefined, platform: string): void => {
  if (requested && requested !== `${platform}:host`) {
    throw new MemoryPolicyError(
      'execution-domain-unavailable',
      'The requested execution domain has no verified memory sampler. Update or repair the runtime.'
    )
  }
}

const validBytes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class WindowsMemoryPolicyAdapter implements MemoryPolicyAdapter {
  readonly platform = 'win32'
  readonly defaultExecutionScope = 'windows:host'

  constructor(private readonly native: WindowsBinding = {}) {}

  async sample(signal: AbortSignal, requestedScope?: string): Promise<MemoryPolicySample> {
    const executionScope = requestedScope ?? this.defaultExecutionScope
    verifyHost(executionScope, 'windows')
    signal.throwIfAborted()
    if (typeof this.native.sampleWindowsResources !== 'function') missingComponent()
    const result = await this.native.sampleWindowsResources(false, [])
    signal.throwIfAborted()
    if (!result.supported || !result.system || result.system.totalPhysicalBytes === undefined)
      missingComponent()
    const system = result.system
    if (
      !result.complete ||
      result.systemError !== undefined ||
      !validBytes(system.totalPhysicalBytes) ||
      system.totalPhysicalBytes === 0 ||
      !validBytes(system.availableBytes) ||
      system.availableBytes > system.totalPhysicalBytes ||
      !validBytes(system.commitLimitBytes) ||
      system.commitLimitBytes === 0 ||
      !validBytes(system.committedBytes) ||
      system.committedBytes > system.commitLimitBytes
    ) {
      throw new MemoryPolicyError(
        'windows-memory-unavailable',
        'The Windows physical/commit snapshot is incomplete or invalid.'
      )
    }
    return {
      platform: this.platform,
      source: 'windows-performance-info',
      executionScope,
      facts: {
        totalBytes: system.totalPhysicalBytes,
        availableBytes: system.availableBytes,
        commitLimitBytes: system.commitLimitBytes,
        committedBytes: system.committedBytes
      }
    }
  }
}

const pressureLevel = (value: number | undefined): MemoryPressureLevel | undefined => {
  if (value === 1) return 'normal'
  if (value === 2) return 'warning'
  if (value === 4) return 'critical'
  return undefined
}

export class DarwinMemoryPolicyAdapter implements MemoryPolicyAdapter {
  readonly platform = 'darwin'
  readonly defaultExecutionScope = 'darwin:host'
  private subscription?: object
  private readonly listeners = new Set<(event?: MemoryPolicyInvalidation) => void>()
  private lastSequence?: number
  private closed = false

  constructor(private readonly native: DarwinBinding = {}) {}

  subscribe(listener: (event?: MemoryPolicyInvalidation) => void): () => void {
    this.listeners.add(listener)
    this.ensureSubscription()
    return () => this.listeners.delete(listener)
  }

  async sample(signal: AbortSignal, requestedScope?: string): Promise<MemoryPolicySample> {
    verifyHost(requestedScope, 'darwin')
    signal.throwIfAborted()
    if (
      this.closed ||
      !this.ensureSubscription() ||
      !this.native.sampleDarwinMemoryPressure ||
      !this.native.darwinMemoryPressureEventSequence
    )
      missingComponent()
    const result = await this.native.sampleDarwinMemoryPressure()
    signal.throwIfAborted()
    const level = pressureLevel(result.pressureLevel)
    if (
      !result.supported ||
      !result.complete ||
      result.error !== undefined ||
      !level ||
      !Number.isSafeInteger(result.pressureEventSequence)
    ) {
      throw new MemoryPolicyError(
        'mac-memory-unavailable',
        'The current macOS pressure level could not be authenticated. Update or repair the runtime for this macOS version.'
      )
    }
    const currentSequence = this.native.darwinMemoryPressureEventSequence()
    if (!Number.isSafeInteger(result.eventSequence) || result.eventSequence !== currentSequence) {
      throw new MemoryPolicyError(
        'mac-memory-event-race',
        'The macOS pressure level changed while its snapshot was being read.'
      )
    }
    this.lastSequence = result.eventSequence
    return {
      platform: this.platform,
      source: 'darwin-sysctl-dispatch',
      executionScope: 'darwin:host',
      facts: { pressureLevel: level, pressureEventSequence: result.pressureEventSequence }
    }
  }

  isCurrent(): boolean {
    if (
      this.closed ||
      this.lastSequence === undefined ||
      !this.native.darwinMemoryPressureEventSequence
    )
      return false
    try {
      return this.native.darwinMemoryPressureEventSequence() === this.lastSequence
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.subscription) this.native.stopDarwinMemoryPressureSubscription?.(this.subscription)
    this.subscription = undefined
    this.listeners.clear()
  }

  private ensureSubscription(): boolean {
    if (this.closed) return false
    if (this.subscription) return true
    if (
      !this.native.subscribeDarwinMemoryPressure ||
      !this.native.stopDarwinMemoryPressureSubscription
    )
      return false
    try {
      this.subscription =
        this.native.subscribeDarwinMemoryPressure((event) => {
          this.lastSequence = undefined
          for (const listener of this.listeners)
            listener({
              reason: 'mac-memory-event',
              pressureLevel: pressureLevel(event.pressureLevel)
            })
        }) ?? undefined
    } catch {
      return false
    }
    return Boolean(this.subscription)
  }
}

// Desktop and standalone runtimes load the same Node-API package. No Electron-only
// sampler and no command-spawning fallback can silently authorize another domain.
export const createPlatformMemoryPolicyAdapter = (
  options: {
    platform?: NodeJS.Platform
    native?: WindowsBinding & DarwinBinding
    linux?: ConstructorParameters<typeof LinuxMemoryPolicyAdapter>[0]
  } = {}
): MemoryPolicyAdapter => {
  const platform = options.platform ?? process.platform
  if (platform === 'linux') return new LinuxMemoryPolicyAdapter(options.linux)
  let native = options.native
  if (!native) {
    try {
      native = requireNative('@aipoch/process-tree-native')
    } catch {
      native = {}
    }
  }
  if (platform === 'win32') return new WindowsMemoryPolicyAdapter(native)
  if (platform === 'darwin') return new DarwinMemoryPolicyAdapter(native)
  return {
    platform: 'linux',
    async sample() {
      throw new MemoryPolicyError(
        'platform-unavailable',
        'Notebook memory checks are unsupported on this platform.'
      )
    }
  }
}
