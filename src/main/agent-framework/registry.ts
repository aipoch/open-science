import type { AgentFrameworkId } from '../../shared/settings'
import { claudeCodeFramework } from './claude-code'
import { codeBuddyFramework } from './codebuddy'
import { codexFramework } from './codex'
import { opencodeFramework } from './opencode'
import { createPiFramework } from './pi'
import { assertPiAdapter } from './pi-runtime'
import { resolvePermissionProfileApplication } from '../acp/permission-profile-controller'
import {
  createSkillRuntimeAcpServerConfig,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
} from '../skills/runtime-mcp-server'
import type { AgentFramework } from './types'

const FRAMEWORKS: Record<AgentFrameworkId, AgentFramework> = {
  'claude-code': claudeCodeFramework,
  opencode: opencodeFramework,
  codex: codexFramework,
  codebuddy: codeBuddyFramework,
  pi: createPiFramework({
    assertApprovedAdapter: assertPiAdapter,
    mapPermissionProfile: (profile, modes) =>
      resolvePermissionProfileApplication(profile, modes, { brokerEnforcesFullAccess: true }),
    skillRuntime: {
      sessionOptionKey: OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
      createServer: createSkillRuntimeAcpServerConfig
    }
  })
}

// Fallback for settings documents created before framework selection was persisted.
export const DEFAULT_AGENT_FRAMEWORK_ID: AgentFrameworkId = 'claude-code'

// Resolves a framework by id for the runtime/settings; ids come from a fixed union so this is total.
export const getAgentFramework = (id: AgentFrameworkId): AgentFramework => FRAMEWORKS[id]

// Lists every registered framework for Settings and runtime capability projection.
export const listAgentFrameworks = (): AgentFramework[] => Object.values(FRAMEWORKS)
