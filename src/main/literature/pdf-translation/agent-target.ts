import { PdfTranslationError, type PdfTranslationAgentModel } from '../../../shared/pdf-translation'
import { pdfTranslationAgentModels } from '../../../shared/pdf-translation-models'
import type { SettingsSnapshot } from '../../../shared/settings'
import type { ExplicitAgentBackendTarget } from '../../settings/backend-target'

export async function capturePdfTranslationAgentTarget(
  settings: {
    getSettingsView(): Promise<SettingsSnapshot>
    captureActiveExplicitAgentBackendTarget(): Promise<ExplicitAgentBackendTarget>
  },
  selected?: PdfTranslationAgentModel
): Promise<ExplicitAgentBackendTarget & { providerName?: string }> {
  if (!selected) {
    const target = await settings.captureActiveExplicitAgentBackendTarget()
    const snapshot = await settings.getSettingsView()
    return {
      ...target,
      providerName: snapshot.providers.find(({ id }) => id === target.providerId)?.name
    }
  }
  const snapshot = await settings.getSettingsView()
  const framework = snapshot.agentFrameworks.find(({ id }) => id === selected.frameworkId)
  const available =
    framework &&
    pdfTranslationAgentModels({
      providers: snapshot.providers,
      activeProviderId: snapshot.activeProviderId,
      claudeSubscriptionProviderId: snapshot.claudeSubscriptionProviderId,
      frameworkId: selected.frameworkId,
      frameworkEndpoints: framework?.supportedApiTypes ?? []
    }).some(
      (entry) =>
        entry.selectable &&
        entry.providerId === selected.providerId &&
        entry.model === (selected.modelId ?? '')
    )
  if (!available)
    throw new PdfTranslationError(
      'unsupported-model',
      'Select an available Agent model for translation.'
    )
  return {
    frameworkId: selected.frameworkId,
    providerId: selected.providerId,
    providerName: snapshot.providers.find(({ id }) => id === selected.providerId)?.name,
    model: selected.modelId
      ? { kind: 'required', id: selected.modelId }
      : { kind: 'provider-default' },
    reasoningEffort: selected.reasoningEffort
  }
}
