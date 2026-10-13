import type { ReasoningEffort, ResolvedReasoningEffort } from '@aipoch/providers/catalog'

import type { AgentFrameworkId } from '../../shared/settings'

export type ExplicitAgentBackendTarget = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  model: Readonly<{ kind: 'required'; id: string }> | Readonly<{ kind: 'provider-default' }>
  reasoningEffort: ReasoningEffort
  resolvedReasoningEffort?: ResolvedReasoningEffort
}>
