// Main-process capability only. It is never accepted from RPC or written to a Run/package.
// Owners may compose further trusted checks (intent, lifecycle, cancellation) at these boundaries.
import type { MemoryPolicyObservation, MemoryPolicyService } from './memory-policy'
import { createLogger } from '@aipoch/diagnostics/node'
import { loadNotebookMemoryPolicyConfig } from './memory-policy-config'

export type NotebookMemoryPolicyPort = Pick<MemoryPolicyService, 'getState' | 'currentState'> &
  Partial<
    Pick<
      MemoryPolicyService,
      'matchesDefaultScope' | 'subscribe' | 'setActive' | 'invalidate' | 'dispose'
    >
  >

export const createNotebookMemoryPolicy = async (
  configRoot: string,
  platform?: NodeJS.Platform
): Promise<MemoryPolicyService> => {
  const [{ MemoryPolicyService }, { createPlatformMemoryPolicyAdapter }, config] =
    await Promise.all([
      import('./memory-policy'),
      import('./memory-policy-platform'),
      loadNotebookMemoryPolicyConfig(configRoot)
    ])
  if (config.source === 'fallback') {
    createLogger('notebook:memory-policy').error(
      'Notebook memory policy configuration fell back to defaults',
      {
        source: config.source,
        diagnostic: config.diagnostic
      }
    )
  }
  return new MemoryPolicyService({
    adapter: createPlatformMemoryPolicyAdapter({ platform }),
    policy: config.policy
  })
}

export type NotebookExecutionBoundary = 'submit' | 'create' | 'dispatch' | 'restart'

export type NotebookExecutionAdmission = {
  prepare(boundary: NotebookExecutionBoundary): Promise<void>
  assertCurrent(boundary: NotebookExecutionBoundary): void
  /** Main-only original-owner capability, preserving the same refusal and human-retry authority. */
  withExecutionDomain?(
    policy: NotebookMemoryPolicyPort,
    executionScope: string
  ): NotebookExecutionAdmission
}

const admissionKey = Symbol('Notebook host execution admission')
export const withNotebookExecutionAdmission = <T extends object>(
  request: T,
  admission: NotebookExecutionAdmission
): T => Object.assign({}, request, { [admissionKey]: admission })
export const notebookExecutionAdmission = (
  request: object
): NotebookExecutionAdmission | undefined =>
  (request as { [admissionKey]?: NotebookExecutionAdmission })[admissionKey]

export const prepareNotebookExecution = async (
  request: object,
  boundary: NotebookExecutionBoundary
): Promise<void> => {
  const admission = notebookExecutionAdmission(request)
  await admission?.prepare(boundary)
  admission?.assertCurrent(boundary)
}

export const guardNotebookExecutionAdmission = (
  admission: NotebookExecutionAdmission | undefined,
  signal: AbortSignal | undefined,
  assertHostCurrent: () => void
): NotebookExecutionAdmission | undefined =>
  admission && {
    ...(admission.withExecutionDomain
      ? {
          withExecutionDomain: (policy: NotebookMemoryPolicyPort, scope: string) =>
            guardNotebookExecutionAdmission(
              admission.withExecutionDomain!(policy, scope),
              signal,
              assertHostCurrent
            )!
        }
      : {}),
    prepare: async (boundary) => {
      signal?.throwIfAborted()
      assertHostCurrent()
      await admission.prepare(boundary)
    },
    assertCurrent: (boundary) => {
      signal?.throwIfAborted()
      assertHostCurrent()
      admission.assertCurrent(boundary)
    }
  }

export class NotebookExecutionAdmissionError extends Error {
  readonly recovery = { execution: 'not-started' as const, retryAfter: 'runtime-ready' as const }
  constructor(
    readonly code: string,
    message: string,
    readonly memory?: MemoryPolicyObservation
  ) {
    super(`${code}: ${message}`)
    this.name = 'NotebookExecutionAdmissionError'
  }
}

export const createNotebookExecutionAdmission = (options: {
  policy: () => Promise<NotebookMemoryPolicyPort>
  executionScope?: string
  force?: boolean
  signal?: AbortSignal
  assertHostCurrent?: (boundary: NotebookExecutionBoundary) => void
  onRejected?: (state: MemoryPolicyObservation) => void
}): NotebookExecutionAdmission => {
  let policy: NotebookMemoryPolicyPort | undefined
  const assertMemory = (state: MemoryPolicyObservation): void => {
    if (state.status === 'healthy') return
    // Pressure observations also drive idle reclamation. A fresh macOS warning or
    // normal recovery sample is advisory for new work; critical pressure still blocks.
    if (
      state.status === 'pressured' &&
      state.source === 'darwin-sysctl-dispatch' &&
      state.executionScope === 'darwin:host' &&
      ((state.facts?.pressureLevel === 'warning' && state.reason.code === 'mac-memory-warning') ||
        (state.facts?.pressureLevel === 'normal' && state.reason.code === 'mac-memory-recovering'))
    )
      return
    options.onRejected?.(state)
    throw new NotebookExecutionAdmissionError(
      state.status === 'pressured' ? 'NOTEBOOK_MEMORY_PRESSURE' : 'NOTEBOOK_MEMORY_UNAVAILABLE',
      state.status === 'pressured'
        ? 'Memory is under pressure. Execution was not started. Stop a Notebook session in Compute or free memory, then choose to retry.'
        : 'Notebook memory checking is unavailable. Execution was not started. Check or repair the runtime, then choose to retry.' +
            (state.reason.detail ? ` ${state.reason.detail}` : ''),
      state
    )
  }
  const admission: NotebookExecutionAdmission = {
    withExecutionDomain: (domainPolicy, executionScope) => {
      const guest = createNotebookExecutionAdmission({
        ...options,
        policy: async () => domainPolicy,
        executionScope
      })
      return {
        prepare: async (boundary) => {
          await admission.prepare(boundary)
          await guest.prepare(boundary)
        },
        assertCurrent: (boundary) => {
          admission.assertCurrent(boundary)
          guest.assertCurrent(boundary)
        }
      }
    },
    prepare: async (boundary) => {
      options.signal?.throwIfAborted()
      options.assertHostCurrent?.(boundary)
      let state: MemoryPolicyObservation
      try {
        policy = await options.policy()
        state = await policy.getState({
          signal: options.signal,
          executionScope: options.executionScope,
          force: options.force === true
        })
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error instanceof NotebookExecutionAdmissionError) throw error
        state = {
          status: 'unavailable',
          source: 'memory-policy',
          executionScope: options.executionScope ?? 'unknown',
          reason: { code: 'memory-check-failed' }
        }
      }
      assertMemory(state)
    },
    assertCurrent: (boundary) => {
      options.signal?.throwIfAborted()
      options.assertHostCurrent?.(boundary)
      if (!policy)
        throw new NotebookExecutionAdmissionError(
          'NOTEBOOK_MEMORY_UNAVAILABLE',
          'Notebook memory checking was not prepared. Execution was not started.'
        )
      assertMemory(policy.currentState({ executionScope: options.executionScope }))
    }
  }
  return admission
}
