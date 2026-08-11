import type { ResolvedSubagentModelSnapshot } from '../../shared/session-persistence'
import { createDurableDelegatedWork, type DurableDelegatedWork } from './durable-delegated-work'
import type { CreateDurableDelegatedWorkOptions } from './durable-delegated-work-contract'

const TEST_EXECUTION_MODEL: ResolvedSubagentModelSnapshot = Object.freeze({
  frameworkId: 'claude-code',
  providerId: 'test-provider',
  backendId: 'claude-code:test-provider',
  modelRoute: 'claude-anthropic',
  model: 'test-model',
  reasoningEffort: 'default'
})

type TestDurableDelegatedWorkOptions = Omit<
  CreateDurableDelegatedWorkOptions,
  'resolveExecutionModel'
> &
  Partial<Pick<CreateDurableDelegatedWorkOptions, 'resolveExecutionModel'>>

// Tests that do not exercise model admission state their fixture identity here. Executable
// production composition has no fallback and must inject the real originating/fixed resolver.
const createTestDurableDelegatedWork = (
  options: TestDurableDelegatedWorkOptions
): DurableDelegatedWork =>
  createDurableDelegatedWork({
    ...options,
    resolveExecutionModel:
      options.resolveExecutionModel ?? (() => ({ snapshot: TEST_EXECUTION_MODEL }))
  })

export { createTestDurableDelegatedWork, TEST_EXECUTION_MODEL }
