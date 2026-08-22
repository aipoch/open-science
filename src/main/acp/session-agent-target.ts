import type { AcpSessionAgentTarget } from '../../shared/acp'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../shared/settings'

type SessionAgentTargetResolver = (
  configuration?: SessionAgentConfiguration
) => Promise<AcpSessionAgentTarget | undefined>

type DefaultSessionAgentTargetResolver = () => Promise<AcpSessionAgentTarget>

const toAcpSessionAgentTarget = (
  frameworkId: AgentFrameworkId,
  configuration?: SessionAgentConfiguration
): AcpSessionAgentTarget | undefined =>
  configuration ? { frameworkId, ...configuration } : undefined

const toSessionAgentConfiguration = ({
  providerId,
  model,
  reasoningEffort
}: AcpSessionAgentTarget): SessionAgentConfiguration => ({
  providerId,
  ...(model ? { model } : {}),
  reasoningEffort
})

export { toAcpSessionAgentTarget, toSessionAgentConfiguration }
export type { DefaultSessionAgentTargetResolver, SessionAgentTargetResolver }
