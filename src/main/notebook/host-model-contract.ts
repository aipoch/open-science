import type { RestrictedInferenceResult } from '../acp/restricted-inference-contract'

export type HostLlmRequest = string | Readonly<{ prompt: string }>

export type HostLlmUsage = Readonly<{
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  turnCount?: number
}>

export type HostLlmResult = Readonly<{
  text: string
  model: string
  stopReason: RestrictedInferenceResult['stopReason']
  usage?: HostLlmUsage
}>

export type HostLlmBatchItem = HostLlmResult | Readonly<{ error: string }>

export type HostLlmCallInput =
  | Readonly<{ request: HostLlmRequest }>
  | Readonly<{
      requests: readonly HostLlmRequest[]
      options?: Readonly<{ max_concurrency?: number }>
    }>
