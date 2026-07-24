import { describe, expect, it } from 'vitest'

import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
import { claudeCodeFramework } from './claude-code'
import { codexFramework } from './codex'
import { opencodeFramework } from './opencode'

describe('claudeCodeFramework', () => {
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
        options: { ...sessionOptions, settingSources: ['user'] }
      }
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

    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__notebook_execute`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__repl_execute`')
    expect(systemPrompt.append).toContain('`mcp__open-science-notebook__manage_packages`')
    expect(systemPrompt.append).toContain('`mcp__open-science-artifacts__write_artifact_file`')
    expect(systemPrompt.append).not.toMatch(/`notebook_execute`/)
    expect(systemPrompt.append).not.toMatch(/`write_artifact_file`/)
  })

  it.each([
    ['Codex', codexFramework],
    ['OpenCode', opencodeFramework]
  ])('keeps generic MCP tool references unchanged for %s', (_name, framework) => {
    const append = 'Use `notebook_execute` and then `write_artifact_file`.'

    expect(framework.buildSessionSetup({ systemPromptAppends: [append] }).promptPrefix).toBe(append)
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
