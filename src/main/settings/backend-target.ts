import type { AgentFrameworkId, ReasoningEffort } from '../../shared/settings'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'

export type ExplicitAgentBackendTarget = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  model: Readonly<{ kind: 'required'; id: string }> | Readonly<{ kind: 'provider-default' }>
  reasoningEffort: ReasoningEffort
  resolvedReasoningEffort?: ResolvedReasoningEffort
}>
