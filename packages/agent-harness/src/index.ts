/** A step settles one model request and all of its tool results before returning. */
export type AgentStep = (signal: AbortSignal, index: number) => Promise<'continue' | 'complete'>
export type TurnOutcome = 'complete' | 'budget' | 'cancelled'

/** One runner per execution domain. Hosts retain messages, permissions and durable state. */
export function createAgentRunner({ maxSteps }: { maxSteps: number }): {
  run(step: AgentStep): Promise<TurnOutcome>
  cancel(): void
  dispose(): Promise<void>
} {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('Invalid step budget')
  let active: { controller: AbortController; settled: Promise<void> } | undefined
  let unusable = false
  let disposed = false
  return {
    async run(step) {
      if (disposed) throw new Error('Agent runner is disposed')
      if (active) throw new Error('Session is busy')
      if (unusable) throw new Error('Create a new runner after failure or cancellation')
      const controller = new AbortController()
      let settle!: () => void
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      active = { controller, settled }
      try {
        for (let index = 0; index < maxSteps; index++) {
          controller.signal.throwIfAborted()
          const result = await step(controller.signal, index)
          controller.signal.throwIfAborted()
          if (result === 'complete') return 'complete'
          if (result !== 'continue') throw new Error('Invalid step outcome')
        }
        return 'budget'
      } catch (error) {
        // shortcut: until a host recovery contract exists, incomplete history cannot be reused.
        unusable = true
        if (controller.signal.aborted) return 'cancelled'
        throw error
      } finally {
        active = undefined
        settle()
      }
    },
    cancel() {
      active?.controller.abort()
    },
    async dispose() {
      disposed = true
      const current = active
      current?.controller.abort()
      // Keep ownership until the host acknowledges cancellation and settles its resources.
      await current?.settled
    }
  }
}

export { compactContext } from './compaction'
export { executeToolCall } from './tool-execution'
export type { ToolExecutionReceipt } from './tool-execution'
export type {
  ContextItem,
  ContextSnapshot,
  CompactionOptions,
  CompactionOutcome,
  CompactionProposal
} from './compaction'

export { openAgentSession } from './session'
export { createMemoryAgentStore } from './memory-store'
export { createJsonFileAgentStore } from './file-store'
export type { JsonFileAgentStoreOptions } from './file-store'
export { createJournalAgentStore } from './journal-store'
export type { JournalAgentStoreOptions } from './journal-store'
export type { AgentSession } from './session'
export type {
  Json,
  ContentBlock,
  ToolCall,
  AgentMessage,
  ModelUsage,
  ToolDefinition,
  ModelRequest,
  ModelEvent,
  AgentModel,
  ToolResult,
  ToolOutcome,
  ToolContext,
  AgentTool,
  ToolGuard,
  RunStatus,
  PendingTool,
  AgentCheckpoint,
  AgentSessionInspection,
  AgentStore,
  AgentEvent,
  AgentConfiguration,
  AgentSessionOptions,
  AutomaticCompactionOptions
} from './session-types'

export { ToolValidationError } from './tool-validation'
export { createDelegationTool } from './delegation'
export type { DelegatedAgent, DelegationOptions } from './delegation'

export type { ToolResultPage } from './tool-results'
