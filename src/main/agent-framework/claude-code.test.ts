import { describe, expect, it } from 'vitest'

import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
import { claudeCodeFramework } from './claude-code'
import { codexFramework } from './codex'
import { opencodeFramework } from './opencode'

describe('claudeCodeFramework', () => {
  it('disables every Claude-native delegation path without removing ordinary built-in tools', () => {
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })

    expect(setup.meta).toMatchObject({
      claudeCode: {
        options: {
          tools: { type: 'preset', preset: 'claude_code' },
          disallowedTools: ['Agent', 'Task', 'Workflow', 'SendMessage', 'TeamCreate', 'TeamDelete'],
          managedSettings: {
            disableAgentView: true,
            disableWorkflows: true,
            workflowKeywordTriggerEnabled: false
          },
          env: {
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
        env: {
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
      'TeamDelete'
    ])
    expect(options.managedSettings).toMatchObject({
      disableAgentView: true,
      disableWorkflows: true,
      workflowKeywordTriggerEnabled: false
    })
    expect(options.env).toEqual({
      SAFE_BACKEND_VALUE: 'preserved',
      CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
    })
  })

  it('injects resolved settings and local plugins into Claude session options', () => {
    const sessionOptions = {
      settings: '/app/claude/settings.json',
      plugins: [{ type: 'local', path: '/app/claude', skipMcpDiscovery: true }]
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
