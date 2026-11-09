/**
 * Stable identifier for a compute implementation. Existing execution modes remain valid backend ids;
 * future adapters may add their own identifiers without changing the persisted job status union.
 */
export type ComputeBackendId = string

export type ComputeBackendCapabilities = Readonly<{
  commandExecution: boolean
  sourcePackaging: boolean
  streamingLogs: boolean
  metrics: boolean
  cancellation: boolean
  outputCollection: boolean
  environmentSelection: boolean
}>

export type ComputeBackendCapability = keyof ComputeBackendCapabilities

export class ComputeBackendCapabilityError extends Error {
  constructor(readonly capability: ComputeBackendCapability) {
    super(`Compute backend does not support required capability: ${capability}.`)
    this.name = 'ComputeBackendCapabilityError'
  }
}

export const assertComputeBackendCapabilities = (
  capabilities: ComputeBackendCapabilities,
  required: readonly ComputeBackendCapability[]
): void => {
  for (const capability of required) {
    if (!capabilities[capability]) throw new ComputeBackendCapabilityError(capability)
  }
}

export const requiredComputeBackendCapabilities = (
  request: ComputeBackendSubmissionRequest
): readonly ComputeBackendCapability[] => {
  const required: ComputeBackendCapability[] = ['commandExecution']
  if (request.environment?.trim()) required.push('environmentSelection')
  if (request.inputManifest?.trim()) required.push('sourcePackaging')
  if (request.outputManifest?.trim() || request.harvestConfig?.trim()) {
    required.push('outputCollection')
  }
  return required
}

export const assertComputeBackendCanSubmit = (
  adapter: Pick<ComputeBackendAdapter, 'capabilities'>,
  request: ComputeBackendSubmissionRequest
): void => {
  assertComputeBackendCapabilities(
    adapter.capabilities,
    requiredComputeBackendCapabilities(request)
  )
}

export type ComputeBackendTarget = Readonly<{
  providerId: string
  backendId: ComputeBackendId
}>

export type ComputeBackendSubmissionRequest = Readonly<{
  jobId: string
  target: ComputeBackendTarget
  command: string
  workspaceCwd?: string
  timeoutSeconds?: number
  environment?: string
  resourceRequest?: string
  inputManifest?: string
  outputManifest?: string
  harvestConfig?: string
}>

/**
 * Opaque provider data. The host may persist `value` as a provider-owned serialized descriptor, but
 * callers must not parse it or infer provider behavior from its shape.
 */
export type ComputeBackendHandle = Readonly<{
  backendId: ComputeBackendId
  providerId: string
  value: string
}>

export type ComputeBackendPhase =
  'submitting' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost'

export type ComputeBackendContact =
  'live' | 'unreachable' | 'needs_auth' | 'unreconciled' | 'stopping'

export type ComputeBackendObservation = Readonly<{
  phase: ComputeBackendPhase
  contact: ComputeBackendContact
  exitCode?: number | null
  message?: string
  logCursor?: string
  metrics?: Readonly<Record<string, number>>
}>

export type ComputeBackendObservationDisposition =
  | { kind: 'active'; terminal: false }
  | { kind: 'terminal'; terminal: true }
  | { kind: 'contact_lost'; terminal: false }
  | { kind: 'needs_attention'; terminal: false }

export const classifyComputeBackendObservation = (
  observation: ComputeBackendObservation
): ComputeBackendObservationDisposition => {
  if (observation.contact !== 'live') {
    return { kind: 'contact_lost', terminal: false }
  }
  if (
    observation.phase === 'succeeded' ||
    observation.phase === 'failed' ||
    observation.phase === 'cancelled'
  ) {
    return { kind: 'terminal', terminal: true }
  }
  if (observation.phase === 'lost') {
    return { kind: 'needs_attention', terminal: false }
  }
  return { kind: 'active', terminal: false }
}

export type ComputeBackendValidation = Readonly<{
  valid: boolean
  contact: ComputeBackendContact
  message?: string
}>

export type ComputeBackendCancellation = Readonly<{
  outcome: 'requested' | 'confirmed' | 'unknown'
  message?: string
}>

export type ComputeBackendLogChunk = Readonly<{
  cursor?: string
  stdout: string
  stderr: string
  complete: boolean
}>

export type ComputeBackendHarvest = Readonly<{
  outcome: 'pending' | 'partial' | 'complete' | 'failed' | 'abandoned'
  message?: string
}>

export type ComputeBackendCleanup = Readonly<{
  outcome: 'cleaned' | 'abandoned' | 'unknown'
  message?: string
}>

export type ComputeBackendAdapter = Readonly<{
  id: ComputeBackendId
  capabilities: ComputeBackendCapabilities
  validateTarget(
    target: ComputeBackendTarget,
    signal?: AbortSignal
  ): Promise<ComputeBackendValidation>
  probe(target: ComputeBackendTarget, signal?: AbortSignal): Promise<ComputeBackendObservation>
  submit(
    request: ComputeBackendSubmissionRequest,
    signal?: AbortSignal
  ): Promise<ComputeBackendHandle>
  recover(
    request: ComputeBackendSubmissionRequest,
    handle: ComputeBackendHandle,
    signal?: AbortSignal
  ): Promise<ComputeBackendHandle | null>
  observe(handle: ComputeBackendHandle, signal?: AbortSignal): Promise<ComputeBackendObservation>
  cancel(handle: ComputeBackendHandle, signal?: AbortSignal): Promise<ComputeBackendCancellation>
  collectLogs(
    handle: ComputeBackendHandle,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<ComputeBackendLogChunk>
  harvest(handle: ComputeBackendHandle, signal?: AbortSignal): Promise<ComputeBackendHarvest>
  cleanup(handle: ComputeBackendHandle, signal?: AbortSignal): Promise<ComputeBackendCleanup>
}>

export type ComputeBackendDescriptor = Readonly<{
  id: ComputeBackendId
  capabilities: ComputeBackendCapabilities
}>

const LEGACY_CAPABILITIES: ComputeBackendCapabilities = Object.freeze({
  commandExecution: true,
  sourcePackaging: true,
  streamingLogs: true,
  metrics: false,
  cancellation: true,
  outputCollection: true,
  environmentSelection: true
})

/**
 * Compatibility metadata for the existing execution modes. It is intentionally descriptive only;
 * the current dispatcher and lifecycle owners remain the implementation of these modes.
 */
export const LEGACY_COMPUTE_BACKENDS: readonly ComputeBackendDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'direct_ssh',
    capabilities: LEGACY_CAPABILITIES
  }),
  Object.freeze({
    id: 'slurm',
    capabilities: LEGACY_CAPABILITIES
  })
])

export class ComputeBackendCatalog {
  private readonly descriptors: ReadonlyMap<ComputeBackendId, ComputeBackendDescriptor>

  constructor(descriptors: readonly ComputeBackendDescriptor[] = LEGACY_COMPUTE_BACKENDS) {
    const entries = descriptors.map((descriptor) => [descriptor.id, descriptor] as const)
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error('Compute backend ids must be unique.')
    }
    this.descriptors = new Map(entries)
  }

  get(id: ComputeBackendId): ComputeBackendDescriptor | undefined {
    return this.descriptors.get(id)
  }

  list(): readonly ComputeBackendDescriptor[] {
    return [...this.descriptors.values()]
  }
}

export class ComputeBackendAdapterRegistry {
  private readonly adapters: ReadonlyMap<ComputeBackendId, ComputeBackendAdapter>

  constructor(adapters: readonly ComputeBackendAdapter[] = []) {
    const entries = adapters.map((adapter) => [adapter.id, adapter] as const)
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error('Compute backend adapter ids must be unique.')
    }
    this.adapters = new Map(entries)
  }

  get(id: ComputeBackendId): ComputeBackendAdapter | undefined {
    return this.adapters.get(id)
  }

  requireAdapter(id: ComputeBackendId): ComputeBackendAdapter {
    const adapter = this.get(id)
    if (!adapter) throw new Error(`No compute backend adapter registered for "${id}".`)
    return adapter
  }

  list(): readonly ComputeBackendAdapter[] {
    return [...this.adapters.values()]
  }
}
