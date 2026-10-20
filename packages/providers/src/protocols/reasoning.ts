import type { CustomReasoningEffortTransport, ModelReasoningEffort } from './types'

const isMiniMaxM31Model = (vendorId: string | undefined, model: string | undefined): boolean =>
  vendorId === 'minimax' &&
  (model === 'MiniMax-M3.1-Flash' || model === 'MiniMax-M3.1-Flash-Preview')

export type ChatReasoningTransport = {
  reasoningEffort?: ModelReasoningEffort
  thinking?: { type: 'adaptive' | 'disabled' | 'enabled' }
  reasoning?: { effort?: ModelReasoningEffort; enabled?: boolean }
}

// Model profiles describe the values the user may select; this resolver describes how an official
// provider expects that value on its Chat Completions wire. `none` is especially non-portable:
// GLM accepts it as reasoning_effort, while DeepSeek/MiniMax/MiMo use a thinking switch and
// OpenRouter uses its normalized reasoning object. Apodex exposes thinking only on Anthropic
// Messages, so its OpenAI-compatible Chat requests omit reasoning controls. Custom providers select
// one of the same request shapes explicitly; absence remains the backwards-compatible literal
// reasoning_effort field.
export const resolveChatReasoningTransport = (
  vendorId: string | undefined,
  model: string | undefined,
  effort: ModelReasoningEffort,
  customTransport?: CustomReasoningEffortTransport
): ChatReasoningTransport => {
  const transport = vendorId ?? customTransport

  if (transport === 'apodex') return {}

  if (transport === 'openrouter') {
    // Qwen 3.7 Max exposes a hybrid-thinking toggle but no continuous effort levels in OpenRouter's
    // public model metadata. Keep that model-name lookup scoped to the built-in provider catalog;
    // custom gateways select only a request shape and are never inferred from user-entered ids.
    if (vendorId === 'openrouter' && model === 'qwen/qwen3.7-max') {
      return { reasoning: { enabled: effort !== 'none' } }
    }
    return effort === 'none' ? { reasoning: { enabled: false } } : { reasoning: { effort } }
  }

  if (transport === 'minimax') {
    if (isMiniMaxM31Model(vendorId, model)) {
      // M3.1 always thinks. Auxiliary callers requesting no thinking use its lowest tier;
      // sending `none` or disabled thinking would fail with HTTP 400.
      // https://platform.minimax.io/docs/api-reference/text-openai-api
      return {
        reasoningEffort: effort === 'none' ? 'low' : effort,
        thinking: { type: 'adaptive' }
      }
    }
    return { thinking: { type: effort === 'none' ? 'disabled' : 'adaptive' } }
  }

  if (transport === 'xiaomimimo') {
    return { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
  }

  if (transport === 'deepseek') {
    return effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { reasoningEffort: effort, thinking: { type: 'enabled' } }
  }

  return { reasoningEffort: effort }
}

type MessagesReasoningTransport = {
  thinking?: { type: 'adaptive' | 'disabled' }
  outputConfig?: { effort: ModelReasoningEffort }
}

export const resolveMessagesReasoningTransport = (
  vendorId: string | undefined,
  model: string | undefined,
  effort: ModelReasoningEffort,
  customTransport?: CustomReasoningEffortTransport
): MessagesReasoningTransport => {
  if (isMiniMaxM31Model(vendorId, model)) {
    return {
      thinking: { type: 'adaptive' },
      outputConfig: { effort: effort === 'none' ? 'low' : effort }
    }
  }
  // Known Claude models that allow disabling thinking. Unknown / always-on models keep
  // their declared lowest effort instead of receiving an unsupported disable request.
  const disableClaudeThinking =
    vendorId === 'anthropic' &&
    /^claude-(?:opus-(?:4-[5-8]|5)|sonnet-(?:4-[5-6]|5))(?:\[1m\]|-\d{8})?$/.test(model ?? '')
  if (effort === 'none' || (effort === 'low' && disableClaudeThinking)) {
    return { thinking: { type: 'disabled' } }
  }
  return vendorId === 'minimax' || customTransport === 'minimax'
    ? { thinking: { type: 'adaptive' } }
    : { outputConfig: { effort } }
}

export const resolveResponsesReasoningTransport = (
  vendorId: string | undefined,
  model: string | undefined,
  effort: ModelReasoningEffort
): { reasoning: { effort: ModelReasoningEffort } } => ({
  reasoning: { effort: effort === 'none' && isMiniMaxM31Model(vendorId, model) ? 'low' : effort }
})
