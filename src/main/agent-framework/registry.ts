import { claudeCodeFramework } from './claude-code'
import { opencodeFramework } from './opencode'
import type { AgentFramework, AgentFrameworkId } from './types'

const FRAMEWORKS: Record<AgentFrameworkId, AgentFramework> = {
  'claude-code': claudeCodeFramework,
  opencode: opencodeFramework
}

// The default framework until framework selection is wired into settings.
export const DEFAULT_AGENT_FRAMEWORK_ID: AgentFrameworkId = 'claude-code'

// Resolves a framework by id for the runtime/settings; ids come from a fixed union so this is total.
export const getAgentFramework = (id: AgentFrameworkId): AgentFramework => FRAMEWORKS[id]

// Lists every registered framework for the (future) settings selector.
export const listAgentFrameworks = (): AgentFramework[] => Object.values(FRAMEWORKS)
