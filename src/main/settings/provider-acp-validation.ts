import { redactSensitiveText } from '@aipoch/diagnostics'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { runtimeMetadata } from '../runtime-metadata'
import { DEFAULT_AGENT_FRAMEWORK_ID, type ValidateProviderResult } from '../../shared/settings'
import type { AgentBackendResolver } from './backend-resolver'
import type { ResolvedProvider } from './provider-env'
import type { StoredSettings } from './types'

const ACP_VALIDATION_TIMEOUT_MS = 60_000

// One disposable inference per failed HTTP probe. No provider drafts or test conversations are saved.
export class ProviderAcpValidator {
  private readonly active = new Set<RestrictedInferenceRunner>()
  private disposed = false

  constructor(
    private readonly configRoot: string,
    private readonly resolveBackend: AgentBackendResolver['resolveValidationTarget']
  ) {}

  async validate(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): Promise<ValidateProviderResult> {
    if (this.disposed) return { ok: false, category: 'unknown', message: 'ACP: shutting down' }
    const frameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    let testedTarget: ValidateProviderResult['testedTarget']
    const runner = new RestrictedInferenceRunner({
      appVersion: runtimeMetadata().version,
      configRoot: this.configRoot,
      profileNamespace: 'provider-validation',
      taskOnly: true,
      preserveModelRoute: true,
      resolveTarget: async (_target, context) => {
        const backend = await this.resolveBackend(provider, settings, context.storageRoot)
        testedTarget = { model: provider.model, frameworkId, route: backend.modelRoute }
        return backend
      }
    })
    this.active.add(runner)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ACP_VALIDATION_TIMEOUT_MS)
    try {
      await runner.sweepStaleProfiles()
      const result = await runner.run({
        target: {
          frameworkId,
          providerId: 'validation',
          reasoningEffort: 'default',
          model: provider.model
            ? { kind: 'required', id: provider.model }
            : { kind: 'provider-default' }
        },
        agentName: 'connection-validation',
        description: 'Provider connection validation',
        systemPrompt: 'Reply with exactly OK and nothing else. Do not use any tools.',
        prompt: 'Reply with OK.',
        outputLimitBytes: 4096,
        signal: controller.signal
      })
      if (result.stopReason !== 'end_turn' || result.text.trim() !== 'OK')
        throw new Error('ACP: no completed model response')
      return { ok: true, category: 'ok', testedTarget }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const redacted = redactSensitiveText(
        provider.key ? message.split(provider.key).join('[redacted]') : message
      )
      return {
        ok: false,
        category: controller.signal.aborted ? 'timeout' : 'unknown',
        message: redacted.slice(0, 600)
      }
    } finally {
      clearTimeout(timer)
      await runner.shutdown()
      this.active.delete(runner)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.active].map((runner) => runner.shutdown()))
  }
}
