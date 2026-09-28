import type { ModelReasoningEffort } from '../../shared/reasoning-effort'
import type { ResolvedAgentBackend } from '../agent-framework'
import { openAiCompletionsBase } from './base-url'
import type { ProviderRuntimeTarget } from './provider-accounts'
import type {
  ResponsesBridge,
  ResponsesBridgeOptions,
  ResponsesBridgeTarget
} from './responses-bridge'

type SelectorPort = Pick<ResponsesBridge, 'close' | 'selectSkills'>
type ProviderTransportLease = NonNullable<ResolvedAgentBackend['providerTransportLease']>

export type ProviderResponsesBridgePort = Pick<
  ResponsesBridge,
  | 'start'
  | 'close'
  | 'selectSkills'
  | 'registerReviewerSession'
  | 'unregisterReviewerSession'
  | 'registerToolLessSession'
  | 'unregisterToolLessSession'
  | 'registerHostMessageSession'
  | 'unregisterHostMessageSession'
  | 'setReasoningEffort'
  | 'setModelTarget'
  | 'setTarget'
> &
  Partial<Pick<ResponsesBridge, 'registerMcpSession' | 'unregisterMcpSession'>>

export function createCodeBuddySkillSelectorTransport(input: {
  activeTarget: ProviderRuntimeTarget
  reasoningEffort?: ModelReasoningEffort
  createSelector: (target: ResponsesBridgeTarget, options?: ResponsesBridgeOptions) => SelectorPort
}): Readonly<{
  providerTransportLease?: ProviderTransportLease
  release: () => Promise<void>
}> {
  const provider = input.activeTarget.provider
  const baseUrl = openAiCompletionsBase(provider)
  const model = input.activeTarget.effectiveModel ?? provider.model
  if (!baseUrl || !model) return Object.freeze({ release: async () => undefined })
  const selector = input.createSelector(
    {
      baseUrl,
      model,
      ...(provider.key ? { key: provider.key } : {}),
      ...(provider.vendorId ? { vendorId: provider.vendorId } : {}),
      ...(provider.reasoningEffortTransport
        ? { reasoningEffortTransport: provider.reasoningEffortTransport }
        : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    },
    { skillSelectorFailureMode: 'throw' }
  )
  let releasePromise: Promise<void> | undefined
  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise
    const pending = Promise.resolve()
      .then(() => selector.close())
      .catch((error) => {
        if (releasePromise === pending) releasePromise = undefined
        throw error
      })
    releasePromise = pending
    return pending
  }
  return Object.freeze({
    providerTransportLease: {
      setTarget: () => false,
      selectSkills: (text, catalog, signal, observeUsage) =>
        selector.selectSkills(text, catalog, signal, observeUsage),
      release
    },
    release
  })
}
