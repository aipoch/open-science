import type { ResolvedAgentBackend, SkillRuntimeRebase, SkillRuntimeView } from './types'

const SKILL_RUNTIME_ROOT_ENVIRONMENT = Object.freeze([
  'OPEN_SCIENCE_SKILL_RUNTIME_ROOT',
  'OPEN_SCIENCE_SKILL_DISCOVERY_ROOT',
  'OPEN_SCIENCE_SKILL_PROJECTION_ROOT'
] as const)

const skillRuntimeEnvironment = (
  skillRuntime: SkillRuntimeView | undefined
): Record<string, string> =>
  skillRuntime
    ? {
        ...skillRuntime.environment,
        OPEN_SCIENCE_SKILL_RUNTIME_ROOT: skillRuntime.discoveryRoot,
        OPEN_SCIENCE_SKILL_DISCOVERY_ROOT: skillRuntime.discoveryRoot,
        OPEN_SCIENCE_SKILL_PROJECTION_ROOT: skillRuntime.projectionRoot
      }
    : {}

// A resolved backend may contain unrelated provider and transport environment. Remove only the keys
// owned by its previous Skill runtime, then install the complete next view. This also drops a runtime
// cache variable if a future adapter stops using it instead of leaking the parent Attempt's path.
const rebaseSkillRuntimeEnvironment = (input: SkillRuntimeRebase): Record<string, string> => {
  const environment = { ...input.environment }
  for (const name of [
    ...Object.keys(input.previous.environment),
    ...SKILL_RUNTIME_ROOT_ENVIRONMENT
  ]) {
    delete environment[name]
  }
  return { ...environment, ...skillRuntimeEnvironment(input.next) }
}

// Delegation crosses this single framework seam so callers never need to know which native config
// surfaces carry Skill paths (for example OpenCode's high-priority JSON environment layer).
const rebaseResolvedAgentBackendSkillRuntime = (
  backend: ResolvedAgentBackend,
  skillRuntime: SkillRuntimeView
): ResolvedAgentBackend =>
  Object.freeze({
    ...backend,
    env: backend.framework.rebaseSkillRuntime({
      environment: backend.env,
      previous: backend.skillRuntime ?? skillRuntime,
      next: skillRuntime
    }),
    skillRuntime
  })

export {
  rebaseResolvedAgentBackendSkillRuntime,
  rebaseSkillRuntimeEnvironment,
  skillRuntimeEnvironment
}
