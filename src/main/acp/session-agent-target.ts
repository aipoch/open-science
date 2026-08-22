import type { AcpSessionAgentTarget } from '../../shared/acp'
import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'
import { resolveSessionAgentConfiguration } from '../../shared/session-agent-configuration'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  canonicalSessionProviderId,
  type AgentFrameworkId,
  type SessionAgentConfiguration,
  type SettingsSnapshot
} from '../../shared/settings'

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
  const providerId = canonicalSessionProviderId(
    source.agentBackendId.slice(separator < 0 ? 0 : separator + 1).trim()
  )
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

const SESSION_AGENT_TARGET_UNAVAILABLE = 'Session agent target is unavailable'

const shouldPersistSessionAgentConfiguration = (
  current: SessionAgentConfiguration | undefined,
  target: AcpSessionAgentTarget
): boolean => {
  const next = toSessionAgentConfiguration(target)
  return (
    current?.providerId !== next.providerId ||
    current?.model !== next.model ||
    current?.reasoningEffort !== next.reasoningEffort
  )
}

const resolveValidatedSessionAgentTarget = (
  source: SessionAgentTargetSource,
  settings: SettingsSnapshot
): AcpSessionAgentTarget => {
  const framework = settings.agentFrameworks.find(
    (candidate) => candidate.id === settings.agentFrameworkId
  )
  const catalog = buildConfiguredModelCatalog({
    providers: settings.providers,
    activeProviderId: settings.activeProviderId,
    claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
    includeAllClaudeSubscriptions: true,
    frameworkId: settings.agentFrameworkId,
    frameworkEndpoints: framework?.supportedApiTypes ?? ['anthropic']
  })
  const resolution = resolveSessionAgentConfiguration({
    session: source,
    catalog,
    activeProviderId: settings.activeProviderId,
    activeModel: settings.activeModel,
    activeReasoningEffort: settings.reasoningEffort
  })
  if (resolution.status !== 'ready') {
    throw new Error(SESSION_AGENT_TARGET_UNAVAILABLE)
  }
  const target = toAcpSessionAgentTarget(settings.agentFrameworkId, resolution.configuration)
  if (!target) throw new Error(SESSION_AGENT_TARGET_UNAVAILABLE)
  return target
}

export {
  materializeSessionAgentConfiguration,
  resolveValidatedSessionAgentTarget,
  shouldPersistSessionAgentConfiguration,
  toAcpSessionAgentTarget,
  toSessionAgentConfiguration
}
export type {
  DefaultSessionAgentTargetResolver,
  SessionAgentTargetResolver,
  SessionAgentTargetSource
}
