import { describe, expect, it } from 'vitest'

import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
import {
  LOAD_SKILL_TOOL_CALLABLE_NAME,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  SKILL_RUNTIME_ALLOWED_NAMES_ENV,
  SKILL_RUNTIME_MCP_SERVER_NAME,
  SKILL_RUNTIME_ROOT_ENV
} from '../skills/runtime-mcp-server'
import { claudeCodeFramework } from './claude-code'
import { codexFramework } from './codex'
import { opencodeFramework } from './opencode'

describe('claudeCodeFramework', () => {
  it('disables native delegation and Bash while keeping the ordinary built-in preset', () => {
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })

    expect(setup.meta).toMatchObject({
      claudeCode: {
        options: {
          tools: { type: 'preset', preset: 'claude_code' },
          disallowedTools: [
            'Agent',
            'Task',
            'Workflow',
            'SendMessage',
            'TeamCreate',
            'TeamDelete',
            'Bash'
          ],
          managedSettings: {
            disableAgentView: true,
            disableWorkflows: true,
            workflowKeywordTriggerEnabled: false
          },
          settings: {
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
          },
          env: {
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
            CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
          }
        }
      }
    })
  })

  it('keeps ordinary background-task controls available', () => {
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })
    const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options

    expect(options.disallowedTools).not.toContain('TaskOutput')
    expect(options.disallowedTools).not.toContain('TaskStop')
  })

  it('does not let backend session options reopen a native delegation bypass', () => {
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: [],
      sessionOptions: {
        disallowedTools: ['CustomDeniedTool'],
        managedSettings: { disableAgentView: false, disableWorkflows: false },
        settings: {
          env: {
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            SAFE_SETTING_VALUE: 'preserved'
          }
        },
        env: {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
          CLAUDE_CODE_DISABLE_WORKFLOWS: '0',
          SAFE_BACKEND_VALUE: 'preserved'
        }
      }
    })
    const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options

    expect(options.disallowedTools).toEqual([
      'CustomDeniedTool',
      'Agent',
      'Task',
      'Workflow',
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      'Bash'
    ])
    expect(options.managedSettings).toMatchObject({
      disableAgentView: true,
      disableWorkflows: true,
      workflowKeywordTriggerEnabled: false
    })
    expect(options.settings).toEqual({
      env: {
        SAFE_SETTING_VALUE: 'preserved',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
      }
    })
    expect(options.env).toEqual({
      SAFE_BACKEND_VALUE: 'preserved',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
    })
  })

  it('rejects unresolved settings paths that could override ACP session policy', () => {
    expect(() =>
      claudeCodeFramework.buildSessionSetup({
        systemPromptAppends: [],
        sessionOptions: { settings: '/app/claude/settings.json' }
      })
    ).toThrow('Claude Code session settings must be resolved before building ACP session metadata.')
  })

  it('injects resolved settings and local plugins into Claude session options', () => {
    const sessionOptions = {
      settings: { apiKeyHelper: '/app/claude/api-key-helper' },
      plugins: [{ type: 'local', path: '/app/claude' }]
    }

    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: [],
      sessionOptions
    })

    expect(setup.meta).toMatchObject({
      claudeCode: {
        emitRawSDKMessages: [{ type: 'assistant' }, { type: 'result' }],
        options: {
          ...sessionOptions,
          settingSources: ['user'],
          tools: { type: 'preset', preset: 'claude_code' }
        }
      }
    })
  })

  it('routes canonical Skill calls through the isolated read-only runtime loader', async () => {
    type PreToolUseCallback = (
      input: unknown,
      toolUseId: string | undefined,
      options: { signal: AbortSignal }
    ) => Promise<{
      hookSpecificOutput?: {
        hookEventName?: string
        permissionDecision?: string
      }
    }>

    const existingPreToolUseHook: PreToolUseCallback = async () => ({})
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: [],
      skillRuntimeScope: 'all',
      sessionOptions: {
        allowedTools: ['Read'],
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [existingPreToolUseHook] }]
        },
        [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
          command: '/app/electron',
          entryPath: '/app/main.js',
          root: '/runtime/revision'
        }
      }
    })
    const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options
    const servers = options.mcpServers as Record<string, Record<string, unknown>>
    const hooks = options.hooks as {
      PreToolUse: Array<{ matcher?: string; hooks: PreToolUseCallback[] }>
    }

    expect(options).not.toHaveProperty(OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION)
    expect(options.toolAliases).toEqual({ Skill: LOAD_SKILL_TOOL_CALLABLE_NAME })
    expect.soft(options.allowedTools).toEqual(['Read'])
    expect(servers[SKILL_RUNTIME_MCP_SERVER_NAME]).toMatchObject({
      type: 'stdio',
      command: '/app/electron',
      args: ['/app/main.js', '--open-science-skill-runtime-mcp'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        [SKILL_RUNTIME_ROOT_ENV]: '/runtime/revision'
      }
    })
    expect(hooks.PreToolUse[0]).toMatchObject({
      matcher: 'Bash',
      hooks: [existingPreToolUseHook]
    })

    const loadSkillHook = hooks.PreToolUse.find(
      (hook) => hook.matcher === LOAD_SKILL_TOOL_CALLABLE_NAME
    )
    expect(loadSkillHook).toBeDefined()

    const decision = await loadSkillHook!.hooks[0](
      {
        hook_event_name: 'PreToolUse',
        tool_name: LOAD_SKILL_TOOL_CALLABLE_NAME,
        tool_input: { name: 'literature-review' },
        tool_use_id: 'tool-use-1'
      },
      'tool-use-1',
      { signal: new AbortController().signal }
    )
    expect(decision).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    })
  })

  it('passes the Specialist Skill whitelist to the runtime loader', () => {
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: [],
      skillWhitelist: ['literature-review'],
      skillRuntimeScope: ['literature-review'],
      sessionOptions: {
        [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
          command: '/app/electron',
          entryPath: '/app/main.js',
          root: '/runtime/revision'
        }
      }
    })
    const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options
    const servers = options.mcpServers as Record<string, { env: Record<string, string> }>

    expect(servers[SKILL_RUNTIME_MCP_SERVER_NAME].env[SKILL_RUNTIME_ALLOWED_NAMES_ENV]).toBe(
      '["literature-review"]'
    )
  })

  it('keeps the backend Skill runtime disabled without explicit primary-session authority', () => {
    const sessionOptions = {
      [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
        command: '/app/electron',
        entryPath: '/app/main.js',
        root: '/runtime/revision'
      }
    }

    for (const skillRuntimeScope of [undefined, []] as const) {
      const setup = claudeCodeFramework.buildSessionSetup({
        systemPromptAppends: [],
        sessionOptions,
        ...(skillRuntimeScope !== undefined ? { skillRuntimeScope: [] } : {})
      })
      const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options

      expect(options).not.toHaveProperty(OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION)
      expect(options).not.toHaveProperty('toolAliases')
      expect(options).not.toHaveProperty('mcpServers')
      expect(options).not.toHaveProperty('allowedTools')
    }
  })

  it('keeps Claude web tools available through the complete built-in tool preset', () => {
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })

    expect(setup.meta).toMatchObject({
      claudeCode: {
        options: {
          tools: { type: 'preset', preset: 'claude_code' }
        }
      }
    })
  })

  it('allows an isolated session to disable tools and user setting sources', () => {
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: ['Reconstruct from inert evidence only.'],
      sessionOptions: {
        tools: [],
        skills: [],
        plugins: [],
        settings: {},
        settingSources: [],
        persistSession: false
      }
    })

    expect(setup.meta).toMatchObject({
      claudeCode: {
        options: {
          tools: [],
          skills: [],
          plugins: [],
          settings: {},
          settingSources: [],
          persistSession: false
        }
      }
    })
  })

  it('preserves an explicit empty Specialist whitelist while Main omits it', () => {
    expect(
      claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [], skillWhitelist: [] }).meta
    ).toMatchObject({ claudeCode: { options: { skills: [] } } })
    expect(
      claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] }).meta
    ).not.toMatchObject({
      claudeCode: { options: { skills: expect.anything() } }
    })
  })

  it('renders Open Science MCP tool references as Claude callable names', () => {
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: [
        NOTEBOOK_SYSTEM_PROMPT_APPEND,
        'Save final files with `write_artifact_file` from `open-science-artifacts`.'
      ]
    })
    const systemPrompt = setup.meta?.systemPrompt as { append: string }

    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__ask_user_question`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__notebook_execute`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__repl_execute`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__inspect_packages`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__manage_packages`')
    expect(systemPrompt.append).toContain('`mcp__open-science-artifacts__write_artifact_file`')
    expect(systemPrompt.append).not.toContain(
      'open-science-artifacts.mcp__open-science-artifacts__write_artifact_file'
    )
    expect(systemPrompt.append).not.toMatch(/`notebook_execute`/)
    expect(systemPrompt.append).not.toMatch(/`write_artifact_file`/)
    expect(setup.persistentSystemPrompt).toBe(systemPrompt.append)
  })

  it('keeps turn-only MCP tool references unchanged for Codex', () => {
    const append = 'Use `notebook_execute` and then `write_artifact_file`.'

    expect(
      codexFramework.buildSessionSetup({
        systemPromptAppends: [],
        turnPromptReminders: [append]
      }).promptPrefix
    ).toBe(append)
  })

  it('renders turn-only MCP tool references as OpenCode callable names', () => {
    const append =
      'Use `notebook_execute` from `open-science-notebook`, then `write_artifact_file`.'

    expect(
      opencodeFramework.buildSessionSetup({
        systemPromptAppends: [],
        turnPromptReminders: [append]
      }).promptPrefix
    ).toBe(
      'Use `open_science_notebook_notebook_execute` from `open_science_notebook`, then `open_science_artifacts_write_artifact_file`.'
    )
  })

  it('keeps already-namespaced Claude MCP tool references unchanged', () => {
    const callableName = 'mcp__open-science-notebook__notebook_execute'
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [callableName] })
    const systemPrompt = setup.meta?.systemPrompt as { append: string }

    expect(systemPrompt.append).toBe(callableName)
  })

  it('renders per-turn reminders with Claude callable tool names', () => {
    const setup = claudeCodeFramework.buildSessionSetup({
      systemPromptAppends: ['Complete session guidance'],
      turnPromptReminders: ['First call `begin_activity_group` with a purpose title.']
    })

    expect(setup.promptPrefix).toBe(
      'First call `mcp__open-science-activity__begin_activity_group` with a purpose title.'
    )
  })
})
