import { normalizeExecutionConfinement } from '@aipoch/notebook-network-sandbox'
import { createHash } from 'node:crypto'
import { isAbsolute, normalize, relative, sep } from 'node:path'

import type { NotebookSandboxInvocation } from './process-sandbox'

declare const managedShellExecutionBrand: unique symbol

/** An in-process authority, not a DTO. Serializing or copying it never preserves authority. */
export type ManagedShellExecutionCapability = Readonly<{
  [managedShellExecutionBrand]: true
}>

export type ManagedShellExecutionScope = Readonly<{
  projectId: string
  sessionId: string
  executionInvocationId: string
}>

export type ManagedShellCleanupResult = Readonly<{
  scope: ManagedShellExecutionScope
  runId?: string
  state: 'verified' | 'running' | 'cleanup-pending' | 'unknown'
  reaped: boolean
  proof?: 'never-dispatched' | 'process-owner' | 'startup-recovery'
}>

/** Main-only observations of actual process output. These callbacks confer no execution rights. */
export type ManagedShellOutput = Readonly<{
  runId: string
  stream: 'stdout' | 'stderr'
  text: string
}>

export type ManagedServiceProof = Readonly<{ value: string; path: string }>

export type ManagedShellExecutionPolicy = ManagedShellExecutionScope &
  Readonly<{
    cwd: string
    /** Main-owned publication directory; observed by this Run, never inferred from write grants. */
    outputRoot?: string
    environment: Readonly<Record<string, string>>
    confinement?: NotebookSandboxInvocation['confinement']
    /** Ephemeral lease values. Never fingerprinted, journaled or exposed to observers. */
    privateEnvironment?: Readonly<Record<string, string>>
    secretValues?: readonly string[]
    filesystem: NotebookSandboxInvocation['filesystem']
    fingerprint: string
    signal?: AbortSignal
    onOutput?: (output: ManagedShellOutput) => void
    localService?: Readonly<{
      logicalPort: number
      /** Ephemeral private startup data, excluded from the frozen environment and fingerprint. */
      proof?: ManagedServiceProof
      /** The resource owner journals intent before allocation and retains cleanup authority. */
      prepareSocket(context: { runId: string; signal?: AbortSignal }): Promise<string>
    }>
  }>

type ManagedShellExecutionInput = ManagedShellExecutionScope &
  Omit<
    ManagedShellExecutionPolicy,
    keyof ManagedShellExecutionScope | 'fingerprint' | 'filesystem'
  > & {
    /** Additional immutable material/runtime identity; never replaces the canonical fingerprint. */
    fingerprint?: string
    filesystem: Pick<NotebookSandboxInvocation['filesystem'], 'readOnlyRoots' | 'readWriteRoots'> &
      Partial<Pick<NotebookSandboxInvocation['filesystem'], 'deniedReadRoots' | 'deniedWriteRoots'>>
  }

const policies = new WeakMap<ManagedShellExecutionCapability, ManagedShellExecutionPolicy>()

const absolutePath = (value: string): string => {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    throw new Error('Managed Shell paths must be normalized absolute paths.')
  }
  return value
}

const snapshotRoots = (roots: readonly string[] = []): readonly string[] =>
  Object.freeze([...new Set(roots.map(absolutePath))].sort())

const contains = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

/** Only trusted main-process environment owners mint this capability. */
export const createManagedShellExecutionCapability = (
  input: ManagedShellExecutionInput
): ManagedShellExecutionCapability => {
  for (const key of ['projectId', 'sessionId', 'executionInvocationId'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      throw new Error(`Managed Shell requires ${key}.`)
    }
  }
  const cwd = absolutePath(input.cwd)
  const readOnlyRoots = snapshotRoots(input.filesystem.readOnlyRoots)
  const readWriteRoots = snapshotRoots(input.filesystem.readWriteRoots)
  if (!readWriteRoots.some((root) => contains(root, cwd))) {
    throw new Error('Managed Shell working directory requires an explicit write root.')
  }
  const outputRoot = input.outputRoot === undefined ? undefined : absolutePath(input.outputRoot)
  if (
    outputRoot &&
    (!readWriteRoots.some((root) => contains(root, outputRoot)) ||
      readOnlyRoots.some((root) => contains(root, outputRoot)))
  ) {
    throw new Error('Managed Shell output directory requires an explicit writable root.')
  }
  const environment: Record<string, string> = {}
  for (const key of Object.keys(input.environment).sort()) {
    const value = input.environment[key]
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      throw new Error('Managed Shell environment must contain explicit string values.')
    }
    // These values are created only after durable Run admission and must never be frozen on disk.
    if (
      [
        'OPEN_SCIENCE_SERVICE_SOCKET',
        'OPEN_SCIENCE_SERVICE_PORT',
        'OPEN_SCIENCE_SERVICE_PROOF',
        'OPEN_SCIENCE_SERVICE_PROOF_PATH'
      ].includes(key)
    ) {
      throw new Error('Managed Shell service environment is execution-owned.')
    }
    environment[key] = value
  }
  if (
    input.localService &&
    (!Number.isInteger(input.localService.logicalPort) ||
      input.localService.logicalPort < 1 ||
      input.localService.logicalPort > 65535 ||
      typeof input.localService.prepareSocket !== 'function')
  )
    throw new Error('Invalid managed Shell local service policy.')
  if (
    input.localService?.proof &&
    (!/^[a-f0-9]{64}$/.test(input.localService.proof.value) ||
      !/^\/__open_science_proof_[a-f0-9]{32}$/.test(input.localService.proof.path))
  )
    throw new Error('Invalid managed Shell service proof.')
  if (input.onOutput !== undefined && typeof input.onOutput !== 'function')
    throw new Error('Invalid managed Shell output observer.')
  const confinement = input.confinement
    ? normalizeExecutionConfinement(input.confinement)
    : undefined
  const privateEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.privateEnvironment ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      key in environment ||
      key.startsWith('OPEN_SCIENCE_') ||
      /^(?:PATH|HOME|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
        key
      )
    )
      throw new Error('Invalid private managed Shell environment binding.')
    privateEnvironment[key] = value
  }
  const secretValues = Object.freeze(
    [...new Set([...Object.values(privateEnvironment), ...(input.secretValues ?? [])])].filter(
      (value) => typeof value === 'string' && value.length > 0
    )
  )
  if (
    confinement?.mode === 'offline-demo' &&
    (Object.keys(privateEnvironment).length || secretValues.length)
  )
    throw new Error('Offline demonstrations cannot receive private credentials.')
  const filesystem = Object.freeze({
    readOnlyRoots,
    readWriteRoots,
    deniedReadRoots: snapshotRoots(input.filesystem.deniedReadRoots),
    // Explicit read-only inputs remain read-only even when nested below a writable workspace.
    deniedWriteRoots: snapshotRoots([
      ...readOnlyRoots,
      ...(input.filesystem.deniedWriteRoots ?? [])
    ])
  })
  const snapshot = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    executionInvocationId: input.executionInvocationId,
    cwd,
    ...(outputRoot ? { outputRoot } : {}),
    environment: Object.freeze(environment),
    ...(confinement ? { confinement } : {}),
    filesystem
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        ...snapshot,
        materialIdentity: input.fingerprint ?? null,
        localService: input.localService ? { logicalPort: input.localService.logicalPort } : null
      })
    )
    .digest('hex')
  const capability = Object.freeze({}) as ManagedShellExecutionCapability
  policies.set(
    capability,
    Object.freeze({
      ...snapshot,
      fingerprint,
      ...(Object.keys(privateEnvironment).length
        ? { privateEnvironment: Object.freeze(privateEnvironment) }
        : {}),
      ...(secretValues.length ? { secretValues } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      ...(input.localService
        ? {
            localService: Object.freeze({
              ...input.localService,
              ...(input.localService.proof
                ? { proof: Object.freeze({ ...input.localService.proof }) }
                : {})
            })
          }
        : {})
    })
  )
  return capability
}

export const resolveManagedShellExecutionCapability = (
  capability: ManagedShellExecutionCapability,
  scope: { projectId: string; sessionId: string; executionInvocationId?: string },
  allowRevoked = false
): ManagedShellExecutionPolicy => {
  const policy = policies.get(capability)
  if (
    !policy ||
    policy.projectId !== scope.projectId ||
    policy.sessionId !== scope.sessionId ||
    policy.executionInvocationId !== scope.executionInvocationId
  ) {
    throw new Error('Managed Shell capability does not belong to this execution.')
  }
  if (!allowRevoked) policy.signal?.throwIfAborted()
  return policy
}
