import type { AgentFrameworkId } from '../../shared/settings'

const PRODUCTION_DELEGATED_WORK_FRAMEWORKS: readonly AgentFrameworkId[] = Object.freeze([
  'claude-code',
  'opencode',
  'codex',
  'codebuddy'
])

const productionDelegatedWorkFrameworks = (): readonly AgentFrameworkId[] =>
  PRODUCTION_DELEGATED_WORK_FRAMEWORKS

const isProductionDelegatedWorkFramework = (frameworkId: AgentFrameworkId): boolean =>
  PRODUCTION_DELEGATED_WORK_FRAMEWORKS.includes(frameworkId)

export { isProductionDelegatedWorkFramework, productionDelegatedWorkFrameworks }
