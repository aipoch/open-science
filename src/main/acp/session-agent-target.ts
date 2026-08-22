import type { AcpSessionAgentTarget } from '../../shared/acp'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../shared/settings'

type SessionAgentTargetResolver = (
  configuration?: SessionAgentConfiguration
) => Promise<AcpSessionAgentTarget | undefined>

const toAcpSessionAgentTarget = (
  frameworkId: AgentFrameworkId,
  configuration?: SessionAgentConfiguration
): AcpSessionAgentTarget | undefined =>
  configuration ? { frameworkId, ...configuration } : undefined

export { toAcpSessionAgentTarget }
export type { SessionAgentTargetResolver }
