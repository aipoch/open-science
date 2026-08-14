import type { AcpBackendGenerationView } from './backend-generation-owner'
import type { SessionEstimateInput } from './context-usage-tracker'
import { contextUsageMcpSections } from './context-usage-static-context'
import type { AcpSessionToolingAvailability } from './session-presentation-policy'

type AcpContextUsagePolicyOptions = Readonly<{
  backend: () => AcpBackendGenerationView
  appliedModel: (sessionId: string) => string | undefined
  systemPromptAppends: () => readonly string[]
  tooling: () => AcpSessionToolingAvailability
}>

type AcpContextUsageResolution = Readonly<{
  estimateInput: SessionEstimateInput
  selectedWindow?: number
}>

// Interprets one published backend generation into the stable inputs shared by prompt preparation,
// compaction, model changes, and Session update projection. ContextUsageTracker remains the writer.
class AcpContextUsagePolicy {
  constructor(private readonly options: AcpContextUsagePolicyOptions) {}

  resolve(sessionId?: string): AcpContextUsageResolution {
    const backend = this.options.backend()
    const appliedModel = sessionId ? this.options.appliedModel(sessionId) : undefined
    // OpenCode applies its requested model through optional ACP config. Until the Session confirms
    // that model, neither its tokenizer nor the provider-derived window is trustworthy.
    const selectionConfirmed = !(
      backend.framework.id === 'opencode' &&
      backend.session.model &&
      !appliedModel
    )
    const model = selectionConfirmed ? (backend.context.model ?? appliedModel) : undefined
    const sessionSetup = backend.framework.buildSessionSetup({
      systemPromptAppends: backend.prompt.persistentSystemPrompt
        ? []
        : [...this.options.systemPromptAppends()],
      sessionOptions: backend.session.options,
      ...(backend.skillRuntime ? { skillRuntime: backend.skillRuntime } : {})
    })
    const persistentSystemPrompt =
      backend.prompt.persistentSystemPrompt ?? sessionSetup.persistentSystemPrompt
    const persistentSections = contextUsageMcpSections(backend.framework.id, {
      ...this.options.tooling(),
      codexBridgeAliases: backend.adapter.bridgeMcpAliasesEnabled
    }).map(({ sectionId, text }) => ({ sectionId, category: 'mcp' as const, text }))

    return Object.freeze({
      estimateInput: Object.freeze({
        frameworkId: backend.framework.id,
        ...(model ? { model } : {}),
        ...(persistentSystemPrompt ? { persistentSystemPrompt: [persistentSystemPrompt] } : {}),
        ...(persistentSections.length > 0 ? { persistentSections } : {})
      }),
      ...(selectionConfirmed && backend.context.window
        ? { selectedWindow: backend.context.window }
        : {})
    })
  }
}

export { AcpContextUsagePolicy }
export type { AcpContextUsagePolicyOptions, AcpContextUsageResolution }
