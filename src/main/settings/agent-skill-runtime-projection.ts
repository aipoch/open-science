import { randomUUID } from 'node:crypto'

import type { ResolvedAgentBackend, SkillRuntimeView } from '../agent-framework'
import type { AgentSkillRuntimeLease } from '../skills/agent-skill-runtime'
import type { AgentRuntimeManager, AgentSkillRuntimeAcquireRequest } from './agent-runtime-manager'
import type { StoredSettings } from './types'

type AgentSkillRuntimeResolutionInput = Readonly<{
  forcedSkillIds?: readonly string[]
  skillRuntime?: Readonly<{
    lifecycle?: AgentSkillRuntimeAcquireRequest['lifecycle']
    scope: AgentSkillRuntimeAcquireRequest['scope']
    allowedSkillIds?: AgentSkillRuntimeAcquireRequest['allowedSkillIds']
  }>
}>

const createAgentSkillRuntimeRequest = (
  input: AgentSkillRuntimeResolutionInput
): AgentSkillRuntimeAcquireRequest => {
  const configured = input.skillRuntime
  return {
    lifecycle:
      configured?.lifecycle ??
      Object.freeze({
        sessionId: `backend-${randomUUID()}`,
        agentFrameId: 'root',
        runtimeSegmentId: randomUUID()
      }),
    scope: configured?.scope ?? Object.freeze({ kind: 'main' as const }),
    ...(input.forcedSkillIds?.length
      ? { forcedSkillIds: Object.freeze([...input.forcedSkillIds]) }
      : {}),
    ...(configured?.allowedSkillIds
      ? { allowedSkillIds: Object.freeze([...configured.allowedSkillIds]) }
      : {})
  }
}

const toSkillRuntimeView = (lease: AgentSkillRuntimeLease): SkillRuntimeView =>
  Object.freeze({
    projectionRoot: lease.projectionRoot,
    discoveryRoot: lease.discoveryRoot,
    descriptors: Object.freeze(
      lease.skills.map((skill) =>
        Object.freeze({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.skillDocumentPath
        })
      )
    ),
    environment: lease.env
  })

type AgentBackendSkillRuntimePort = Pick<
  AgentRuntimeManager,
  'acquireAgentSkillRuntime' | 'forkAgentSkillRuntime'
>

type AgentBackendSkillRuntime = Readonly<{
  lease: AgentSkillRuntimeLease
  view: SkillRuntimeView
  fork: NonNullable<ResolvedAgentBackend['skillRuntimeFork']>
}>

class AgentBackendSkillRuntimeOwner {
  constructor(private readonly runtime: AgentBackendSkillRuntimePort) {}

  async acquire(
    settings: StoredSettings,
    input: AgentSkillRuntimeResolutionInput
  ): Promise<AgentBackendSkillRuntime> {
    const request = createAgentSkillRuntimeRequest(input)
    const lease = await this.runtime.acquireAgentSkillRuntime(settings, request)
    const fork: AgentBackendSkillRuntime['fork'] = Object.freeze({
      acquire: async (lifecycle) => {
        const attemptLease = await this.runtime.forkAgentSkillRuntime(
          lease,
          lifecycle,
          request.scope
        )
        return Object.freeze({ view: toSkillRuntimeView(attemptLease), lease: attemptLease })
      }
    })
    return Object.freeze({ lease, view: toSkillRuntimeView(lease), fork })
  }
}

export { AgentBackendSkillRuntimeOwner }
export type { AgentSkillRuntimeResolutionInput }
