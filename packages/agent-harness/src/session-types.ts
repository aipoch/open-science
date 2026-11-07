import type { CompactionOutcome } from './compaction'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** References are resolved/authorized by the host adapter, never fetched by the core. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'file' | 'audio' | 'video'
      mimeType: string
      source: Json
      filename?: string
    }

export type ToolCall = { id: string; name: string; arguments: Json }
export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'summary'
  content: ContentBlock[]
  /** Stable model-facing tool preview; content retains the complete original result. */
  modelContent?: ContentBlock[]
  calls?: ToolCall[]
  invocationId?: string
  isError?: boolean
  /** Opaque reasoning/signatures are only replayed to the exact adapter that produced them. */
  providerState?: { adapterId: string; value: Json }
}

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
export type ToolDefinition = {
  name: string
  version: string
  description: string
  parameters: Json
}
export type ModelRequest = {
  requestId: string
  instructions: string
  messages: AgentMessage[]
  tools: ToolDefinition[]
  maxOutputTokens: number
}
export type ModelEvent =
  | { type: 'text-delta' | 'reasoning-delta'; text: string }
  | { type: 'tool-delta'; index: number; arguments: string; name?: string; id?: string }
  | {
      type: 'finish'
      content: ContentBlock[]
      calls?: ToolCall[]
      providerState?: Json
      usage?: ModelUsage
      reason: 'complete' | 'tools' | 'length'
    }

/** Transport, credentials, native protocol conversion and retry policy belong to the adapter. */
export type AgentModel = {
  id: string
  capabilities: {
    tools: boolean
    images: boolean
    files: boolean
    audio?: boolean
    video?: boolean
  }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}
export type ToolResult = { content: ContentBlock[]; isError?: boolean }
export type ToolOutcome = ToolResult | { waiting: Json }
export type ToolContext = {
  sessionId: string
  runId: string
  invocationId: string
  signal: AbortSignal
  /** Ephemeral progress only; ignored after execution settles or is cancelled. */
  update(content: ContentBlock[]): void
}
export type AgentTool = ToolDefinition & {
  /** Host-only scheduling metadata; never exposed in model tool schemas. */
  scheduling?: 'parallel' | 'exclusive'
  validate(input: Json): Json
  /** Mandatory even for read-only tools; the host decides its policy and approval UI. */
  authorize(args: Json, context: ToolContext): Promise<boolean>
  /** Throw means effects are uncertain. Return isError for an acknowledged tool failure. */
  execute(args: Json, context: ToolContext): Promise<ToolOutcome>
}
/** Host invariants run after authorization. Only abstention permits execution to proceed. */
export type ToolGuard = (
  args: Json,
  context: ToolContext,
  definition: ToolDefinition
) => 'deny' | 'abstain' | Promise<'deny' | 'abstain'>
export type RunStatus =
  'running' | 'complete' | 'budget' | 'cancelled' | 'failed' | 'waiting' | 'blocked'
export type PendingTool = {
  invocationId: string
  call: ToolCall
  definition?: ToolDefinition
  status: 'planned' | 'started' | 'waiting' | 'unknown'
  interaction?: Json
}
export type AgentCheckpoint = {
  version: 1
  sessionId: string
  revision: number
  messages: AgentMessage[]
  compactions: {
    sourceIds: string[]
    summary: AgentMessage
    preservedUserMessages?: AgentMessage[]
  }[]
  requests: {
    id: string
    runId: string
    modelId: string
    status: 'started' | 'completed' | 'failed' | 'interrupted'
    usage?: ModelUsage
    purpose?: 'compaction'
  }[]
  pending: PendingTool[]
  /** Follow-up messages submitted while a turn is active. */
  inbox?: { id: string; content: ContentBlock[] }[]
  run?: { id: string; kind: 'turn' | 'compaction' | 'recovery'; status: RunStatus }
}
/** A store-backed operational read without messages, compactions or queued prompt content. */
export type AgentSessionInspection = Pick<
  AgentCheckpoint,
  'sessionId' | 'revision' | 'run' | 'pending'
> & {
  requestCount: number
  /** Empty unless requestsFrom was supplied; includes pending and terminal request receipts. */
  requests: AgentCheckpoint['requests']
}
export type AgentStore = {
  load(sessionId: string): Promise<AgentCheckpoint | undefined>
  /** Atomic CAS. null means create-only. Durable adapters must persist before returning true.
   * Throw on an uncertain write; never retry it. */
  commit(
    sessionId: string,
    expectedRevision: number | null,
    next: AgentCheckpoint
  ): Promise<boolean>
}
export type AgentEvent =
  | ({
      type: 'compaction'
      sessionId: string
      runId: string
      compactionId: string
    } & (
      | { status: 'started' | 'failed' | 'cancelled' }
      | { status: 'finished'; outcome: CompactionOutcome }
    ))
  | {
      type: 'model'
      sessionId: string
      runId: string
      requestId: string
      purpose?: 'compaction'
      event: ModelEvent
    }
  | { type: 'checkpoint'; checkpoint: AgentCheckpoint }
  | {
      type: 'tool-update'
      sessionId: string
      runId: string
      invocationId: string
      content: ContentBlock[]
    }
export type AgentConfiguration = {
  model: AgentModel
  tools?: readonly AgentTool[]
  instructions?: string
}
export type AutomaticCompactionOptions = {
  /** Full-request threshold; the host must include output reserve and safety margin in measurement. */
  inputBudget: number
  keepRecentItems: number
  /** Recent history target; defaults to 20% of usable input space, capped at 20k. */
  keepRecentTokens?: number
  measure(request: ModelRequest): number
  maxOutputTokens: number
  /** Additional evidence-retention guidance; the built-in summary contract always applies. */
  instructions?: string
  /** Admission for the summary request, including its output reserve and appended instructions. */
  admit?: (request: ModelRequest) => void | Promise<void>
}
export type AgentSessionOptions = AgentConfiguration & {
  sessionId: string
  /** Defaults to a private in-memory store. Supply a durable store for process recovery. */
  store?: AgentStore
  compaction?: AutomaticCompactionOptions
  /** Enable bounded tool previews and the session-local read_tool_result capability. Requires compaction measurement. */
  toolResults?: { authorize: AgentTool['authorize'] }
  maxSteps: number
  /** Maximum number of host-approved parallel-safe tools in one batch. */
  maxParallelTools?: number
  maxOutputTokens: number
  /** Optional wall-clock limit includes tools/approval. Cleanup is awaited, not raced away. */
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
  onObserverError?: (error: unknown) => void
  /** Per-step request projection only; frozen input, balanced tool history, no stored edits. */
  transformContext?: (
    messages: readonly AgentMessage[],
    signal: AbortSignal
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>
  /** Snapshotted at open. Denial, exceptions and invalid responses all prevent execution. */
  guards?: readonly ToolGuard[]
  /** Admission prices the entire request (instructions, schemas, media, output reserve). */
  admit?: (request: ModelRequest) => void | Promise<void>
}
