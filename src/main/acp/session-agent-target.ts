import type { AcpSessionAgentTarget } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../shared/settings'

type SessionAgentTargetSource = Pick<
  PersistedChatSession,
  'agentBackendId' | 'agentModel' | 'agentConfiguration'
>

type SessionAgentTargetResolver = (
  source: SessionAgentTargetSource
) => Promise<AcpSessionAgentTarget | undefined>

type DefaultSessionAgentTargetResolver = () => Promise<AcpSessionAgentTarget>

const toAcpSessionAgentTarget = (
  frameworkId: AgentFrameworkId,
  configuration?: SessionAgentConfiguration
): AcpSessionAgentTarget | undefined =>
  configuration ? { frameworkId, ...configuration } : undefined

const materializeSessionAgentConfiguration = (
  source: SessionAgentTargetSource,
  reasoningEffort: SessionAgentConfiguration['reasoningEffort']
): SessionAgentConfiguration | undefined => {
  if (source.agentConfiguration) return source.agentConfiguration
  if (!source.agentBackendId) return undefined
  const separator = source.agentBackendId.indexOf(':')
  const providerId = source.agentBackendId.slice(separator < 0 ? 0 : separator + 1).trim()
  if (!providerId) return undefined
  return {
    providerId,
    ...(source.agentModel ? { model: source.agentModel } : {}),
    reasoningEffort
  }
}

const toSessionAgentConfiguration = ({
  providerId,
  model,
  reasoningEffort
}: AcpSessionAgentTarget): SessionAgentConfiguration => ({
  providerId,
  ...(model ? { model } : {}),
  reasoningEffort
})

export {
  materializeSessionAgentConfiguration,
  toAcpSessionAgentTarget,
  toSessionAgentConfiguration
}
export type {
  DefaultSessionAgentTargetResolver,
  SessionAgentTargetResolver,
  SessionAgentTargetSource
}
