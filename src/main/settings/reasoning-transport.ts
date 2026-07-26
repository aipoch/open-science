import type { OfficialVendorId } from '../../shared/provider-registry'
import type { ModelReasoningEffort } from '../../shared/reasoning-effort'

export type ChatReasoningTransport = {
  reasoningEffort?: ModelReasoningEffort
  thinking?: { type: 'adaptive' | 'disabled' | 'enabled' }
  reasoning?: { effort?: ModelReasoningEffort; enabled?: boolean }
}

// Model profiles describe the values the user may select; this resolver describes how an official
// provider expects that value on its Chat Completions wire. `none` is especially non-portable:
// GLM accepts it as reasoning_effort, while DeepSeek/MiniMax/MiMo use a thinking switch and
// OpenRouter uses its normalized reasoning object. Custom providers stay literal because the user
// explicitly chose their capability preset and may expose an OpenAI-compatible effort parameter.
export const resolveChatReasoningTransport = (
  vendorId: OfficialVendorId | undefined,
  model: string | undefined,
  effort: ModelReasoningEffort
): ChatReasoningTransport => {
  if (vendorId === 'openrouter') {
    // Qwen 3.7 Max exposes a hybrid-thinking toggle but no continuous effort levels in OpenRouter's
    // public model metadata. Other curated OpenRouter models use the gateway's normalized effort.
    if (model === 'qwen/qwen3.7-max') {
      return { reasoning: { enabled: effort !== 'none' } }
    }
    return effort === 'none' ? { reasoning: { enabled: false } } : { reasoning: { effort } }
  }

  if (vendorId === 'minimax') {
    return { thinking: { type: effort === 'none' ? 'disabled' : 'adaptive' } }
  }

  if (vendorId === 'xiaomimimo') {
    return { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
  }

  if (vendorId === 'deepseek') {
    return effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { reasoningEffort: effort, thinking: { type: 'enabled' } }
  }

  return { reasoningEffort: effort }
}
