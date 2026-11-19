import type { NotebookMemoryPolicyPort } from './execution-admission'
import { createNotebookExecutionAdmission } from './execution-admission'
import type { MemoryPolicyObservation } from './memory-policy'

// Explicit policy boundary for tests whose subject is another Notebook behavior.
export const healthyNotebookMemoryPolicy = (): NotebookMemoryPolicyPort => {
  const current: NotebookMemoryPolicyPort['currentState'] = (
    request = {}
  ): MemoryPolicyObservation => ({
    status: 'healthy',
    reason: { code: 'healthy' },
    source: 'test-policy',
    executionScope: request.executionScope ?? 'test:host',
    sampleAgeMs: 0
  })
  return {
    getState: async (request) => current(request),
    currentState: current,
    subscribe: () => () => undefined,
    setActive: () => undefined,
    dispose: () => undefined
  }
}

export const healthyNotebookExecutionAdmission = (
  signal?: AbortSignal
): ReturnType<typeof createNotebookExecutionAdmission> =>
  createNotebookExecutionAdmission({ policy: async () => healthyNotebookMemoryPolicy(), signal })
