import { claudeCodeFramework } from './claude-code'
import { codexFramework } from './codex'
import { codeBuddyFramework } from './codebuddy'
import { opencodeFramework } from './opencode'
import type { AgentFramework, AgentFrameworkId } from './types'

const FRAMEWORKS: Record<AgentFrameworkId, AgentFramework> = {
  'claude-code': claudeCodeFramework,
  opencode: opencodeFramework,
  codex: codexFramework,
  codebuddy: codeBuddyFramework
}

// Fallback for settings documents created before framework selection was persisted.
export const DEFAULT_AGENT_FRAMEWORK_ID: AgentFrameworkId = 'claude-code'

// Resolves a framework by id for the runtime/settings; ids come from a fixed union so this is total.
export const getAgentFramework = (id: AgentFrameworkId): AgentFramework => FRAMEWORKS[id]

// Lists every registered framework for Settings and runtime capability projection.
export const listAgentFrameworks = (): AgentFramework[] => Object.values(FRAMEWORKS)
