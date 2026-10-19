import { encodeStoredModelProtocol } from '../../../shared/model-protocol-storage'
import { createHash } from 'node:crypto'
import { createProvider, ProviderTextGenerationError } from '@aipoch/providers/client'
import type {
  ModelProtocol,
  OfficialVendorId,
  ResolvedReasoningEffort,
  CustomReasoningEffortTransport
} from '@aipoch/providers'
import type { ProviderTokenUsage } from '@aipoch/providers/client'
import { customProviderRequiresKey } from '../../../shared/provider-url-policy'

export type ProviderTextGenerationConfiguration = Readonly<{
  type: 'custom' | 'official'
  key?: string
  baseUrl?: string
  chatCompletionsBaseUrl?: string
  apiEndpoints?: readonly ModelProtocol[]
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
  maxOutputTokens?: number
}>

export type ProviderTextGenerationTarget = Readonly<{
  providerId: string
  model?: string
  reasoningEffort?: ResolvedReasoningEffort
  provider: ProviderTextGenerationConfiguration
}>

export type ProviderTextGenerationRequest = Readonly<{
  target: ProviderTextGenerationTarget
  systemPrompt: string
  prompt: string
  signal: AbortSignal
  maxOutputTokens: number
  outputLimitBytes: number
  onUsage?: (usage: ProviderTokenUsage) => void
}>

/** Stable non-secret identity for resuming work with the same provider configuration. */
export function providerTextGenerationTargetKey(target: ProviderTextGenerationTarget): string {
  // Preserve existing persisted keys, including omitted/default reasoning equivalence.
  const identity = [
    'api',
    target.providerId,
    target.model,
    target.provider.apiEndpoints?.map(encodeStoredModelProtocol),
    target.provider.baseUrl,
    target.provider.chatCompletionsBaseUrl,
    ...(target.reasoningEffort && target.reasoningEffort !== 'default'
      ? [target.reasoningEffort, target.provider.vendorId, target.provider.reasoningEffortTransport]
      : [])
  ]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export class ProviderTextGenerationService {
  constructor(private readonly fetchImpl: typeof fetch) {}
  supportsTarget(target: ProviderTextGenerationTarget): boolean {
    const provider = target.provider
    const hasKey = typeof provider.key === 'string' && provider.key.length > 0
    const hasModel = typeof target.model === 'string' && target.model.length > 0
    return (
      (provider.type === 'custom' || provider.type === 'official') &&
      (hasKey || (provider.type === 'custom' && !customProviderRequiresKey(provider.baseUrl))) &&
      hasModel &&
      createProvider({
        id: provider.vendorId ?? 'custom',
        textGeneration: provider
      }).supportsTextGeneration(target.model!)
    )
  }

  async run(
    input: ProviderTextGenerationRequest
  ): Promise<{ text: string; stopReason: 'end_turn' }> {
    input.signal.throwIfAborted()
    if (!this.supportsTarget(input.target))
      throw new ProviderTextGenerationError('unsupported-target', 'Text generation is unavailable.')
    const provider = input.target.provider
    const model = createProvider({
      id: provider.vendorId ?? 'custom',
      key: provider.key,
      fetch: this.fetchImpl,
      textGeneration: {
        ...provider,
        reasoningEffortTransport: provider.reasoningEffortTransport,
        reasoningEffort: input.target.reasoningEffort,
        maxOutputTokens: provider.maxOutputTokens
      }
    }).textGenerationModel(input.target.model!)
    return model.generate(input)
  }
}
