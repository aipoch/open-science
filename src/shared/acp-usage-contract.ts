import type { PromptResponse } from '@agentclientprotocol/sdk'

export type AcpContextUsageCategoryKey =
  'system' | 'tools' | 'messages' | 'mcp' | 'skills' | 'other'

export type AcpContextUsageCategory = {
  key: AcpContextUsageCategoryKey
  tokens: number
  // `estimated` distinguishes locally tokenized content from the residual needed to reconcile the
  // category sum with the authoritative Agent total.
  estimated: boolean
}

export type AcpContextUsageBreakdown = {
  source: 'estimated' | 'native'
  // Stable tokenizer/profile id for diagnostics. Native framework reports have no local tokenizer.
  tokenizer?: 'anthropic' | 'o200k_base' | 'cl100k_base'
  model?: string
  // Sum of locally attributable categories before the Agent total is applied.
  estimatedTokens: number
  // Zero while preflight has no Agent comparison. Once reconciled, signed Agent total minus local
  // estimate: positive values become `other`; negative drift stays visible rather than being scaled.
  difference: number
  status: 'preflight' | 'reconciled'
  categories: AcpContextUsageCategory[]
}

// Current agent-context usage projected onto its logical app session. `used` remains the latest Agent
// model-input total once one exists; before the first Agent report it is the local preflight estimate.
// During later preflight updates, `agentUsed` preserves that latest authoritative reading while the
// independent breakdown keeps changing. Cache reads and writes are input, counted once; output is
// excluded. `size` is omitted until the selected model window is known, then remains bound to that
// same agent-context generation. Both expire when that context disconnects or is replaced. Monetary cost is deliberately
// excluded.
export type AcpContextUsage = {
  used: number
  agentUsed?: number
  size?: number
  breakdown?: AcpContextUsageBreakdown
}

// Provider-reported totals for one completed prompt turn. Input excludes the cache categories;
// inputTokens + cacheTokens is the full input. `cacheTokens` stays as the comparable
// provider-neutral total. Read/write details are present as a pair only when the adapter reports both
// categories separately.
export type AcpTurnTokenUsage = {
  inputTokens: number
  cacheTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  outputTokens: number
  // Number of model inference turns performed during this completed agent run. Optional because
  // ACP adapters do not all expose a reliable request count.
  turnCount?: number
}

export type AcpModelStepTokenUsage = Omit<AcpTurnTokenUsage, 'turnCount'>

export type AcpModelCallUsage = AcpModelStepTokenUsage & {
  id: string
  index: number
  sourceInvocationId?: string
  contextUsedTokens?: number
  contextWindowSize?: number
}

export type AcpPromptStopReason = PromptResponse['stopReason']

export type AcpPromptTermination =
  { kind: 'stop'; stopReason: AcpPromptStopReason } | { kind: 'error' }

export type AcpContextWindowSampleSource =
  'provider-response' | 'provider-update' | 'local-estimate'

// Frozen context facts for one visible prompt execution. Main publishes this with the terminal
// runtime event before context cleanup can restore a checkpoint; Renderer later supplies durable
// event/runtime identity when binding it to the owning user Message.
export type AcpTerminalContextWindow = {
  termination: AcpPromptTermination
  contextWindow: AcpContextUsage
  modelStepUsage?: AcpModelStepTokenUsage
  source: AcpContextWindowSampleSource
}

// Branch-bound terminal sample persisted on the user Message. This is a last-model-step context
// snapshot, never a sum across model steps; whole-turn totals remain in `AcpTurnTokenUsage`.
export type AcpContextWindowSample = AcpTerminalContextWindow & {
  id: string
  timestamp: number
  runtimeSegmentId?: string
}
