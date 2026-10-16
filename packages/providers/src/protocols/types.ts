export type ChatApiEndpoint = 'anthropic' | 'openai' | 'responses'

export type ModelReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export type ResolvedReasoningEffort = ModelReasoningEffort | 'default'

export type CustomReasoningEffortTransport =
  'reasoning-effort' | 'deepseek' | 'minimax' | 'xiaomimimo' | 'openrouter'

export type ReasoningCapability =
  | { readonly supported: false }
  | { readonly supported: true; readonly values: readonly ModelReasoningEffort[] }
