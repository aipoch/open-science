import { PdfTranslationError, type PdfTranslationApiModel } from '@aipoch/pdf-translation/contracts'
import { pdfTranslationApiModels } from '../../../shared/pdf-translation-models'
import { resolveProviderEffectiveModel } from '../../../shared/provider-reasoning-effort'
import type { SettingsSnapshot } from '../../../shared/settings'
import type { ReasoningEffortProfile } from '../../../shared/reasoning-effort'
import type { ExplicitAgentBackendTarget } from '../../settings/backend-target'
import type { ResolvedProvider } from '../../settings/provider-env'
import type { ProviderTextGenerationTarget } from './text-generation'

export async function capturePdfTranslationApiTarget(
  settings: {
    getSettingsView(): Promise<SettingsSnapshot>
    resolveExplicitDirectProvider(target: ExplicitAgentBackendTarget): Promise<{
      providerId: string
      provider: ResolvedProvider
      reasoningEffortProfile: ReasoningEffortProfile
    }>
  },
  selected?: PdfTranslationApiModel
): Promise<ProviderTextGenerationTarget & { providerName?: string }> {
  const snapshot = await settings.getSettingsView()
  const providerId = selected?.providerId ?? snapshot.activeProviderId
  const provider = snapshot.providers.find((value) => value.id === providerId)
  const modelId = selected?.modelId ?? resolveProviderEffectiveModel(provider, snapshot.activeModel)
  if (
    !pdfTranslationApiModels(snapshot.providers).some(
      (entry) => entry.providerId === providerId && entry.model === modelId
    )
  )
    throw new PdfTranslationError(
      'unsupported-model',
      'Select an available API model for direct translation.'
    )
  const resolved = await settings.resolveExplicitDirectProvider({
    frameworkId: 'opencode',
    providerId: providerId!,
    model: { kind: 'required', id: modelId! },
    reasoningEffort: 'low'
  })
  const direct = resolved.provider
  if (direct.type !== 'custom' && direct.type !== 'official')
    throw new PdfTranslationError(
      'unsupported-model',
      'Select an available API model for direct translation.'
    )
  return {
    providerId: resolved.providerId,
    provider: {
      type: direct.type,
      key: direct.key,
      baseUrl: direct.baseUrl,
      chatCompletionsBaseUrl: direct.chatCompletionsBaseUrl,
      apiEndpoints: direct.apiEndpoints,
      vendorId: direct.vendorId,
      reasoningEffortTransport: direct.reasoningEffortTransport,
      maxOutputTokens: direct.maxOutputTokens
    },
    providerName: provider?.name,
    model: resolved.provider.model,
    reasoningEffort: resolved.reasoningEffortProfile.supported
      ? resolved.reasoningEffortProfile.slots[0]
      : 'default'
  }
}
