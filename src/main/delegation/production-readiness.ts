import type { AgentFrameworkId } from '../../shared/settings'

const PRODUCTION_DELEGATED_WORK_FRAMEWORKS = Object.freeze([
  'claude-code',
  'opencode',
  'codex'
] satisfies AgentFrameworkId[])

const productionDelegatedWorkFrameworks = (): readonly AgentFrameworkId[] =>
  PRODUCTION_DELEGATED_WORK_FRAMEWORKS

const isProductionDelegatedWorkFramework = (frameworkId: AgentFrameworkId): boolean =>
  PRODUCTION_DELEGATED_WORK_FRAMEWORKS.includes(frameworkId)

export { isProductionDelegatedWorkFramework, productionDelegatedWorkFrameworks }
