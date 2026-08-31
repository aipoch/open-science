import { describe, expect, it } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

import {
  BASH_EXECUTE_DOC,
  buildShellExecuteDoc,
  NOTEBOOK_SYSTEM_PROMPT_APPEND
} from '../notebook/mcp-server'
import type { AgentFrameworkId } from '../agent-framework/types'
import { contextUsageMcpSections } from './context-usage-static-context'

describe('contextUsageMcpSections', () => {
  it('uses OpenCode MCP tool names in its serialized schema baseline', () => {
    const sections = contextUsageMcpSections('opencode', {
      artifacts: true,
      notebook: true,
      skillImport: true
    })

    const text = sections.map((section) => section.text).join('\n')
    expect(text).not.toContain('open_science_activity_begin_activity_group')
    expect(text).toContain('open_science_artifacts_write_artifact_file')
    expect(text).toContain('open_science_notebook_notebook_execute')
    expect(text).toContain('open_science_skills_request_skill_import')
    expect(text).not.toContain('open-science-activity_begin_activity_group')
    expect(text).not.toContain('open-science-artifacts_write_artifact_file')
    expect(text).not.toContain('open-science-notebook_notebook_execute')
    expect(text).not.toContain('open-science-skills_request_skill_import')
    expect(text).not.toContain('mcp__open_science_notebook__notebook_execute')
  })

  it('uses Codex MCP tool names in its serialized schema baseline', () => {
    const sections = contextUsageMcpSections('codex', {
      artifacts: false,
      notebook: true,
      skillImport: false
    })

    const text = sections.map((section) => section.text).join('\n')
    expect(text).toContain('mcp.open-science-notebook.notebook_execute')
    expect(text).not.toContain('mcp__open_science_notebook__notebook_execute')
  })

  it('keeps the notebook schema plus scoped guidance within the static context budget', () => {
    const tokenizer = new Tiktoken(cl100kBase)
    const tokenCount = (text: string): number => tokenizer.encode(text).length
    // bash_execute embeds a platform-specific shell contract. Windows PowerShell docs are the
    // largest variant, so a POSIX host must still count that extra or Windows full-suite CI
    // is the first place the budget regresses.
    const bashHeadroom = Math.max(
      0,
      ...(['win32', 'linux', 'darwin'] as const).map(
        (platform) => tokenCount(buildShellExecuteDoc(platform)) - tokenCount(BASH_EXECUTE_DOC)
      )
    )
    const frameworks: Array<{
      frameworkId: AgentFrameworkId
      codexBridgeAliases?: boolean
    }> = [
      { frameworkId: 'codex' },
      { frameworkId: 'codex', codexBridgeAliases: true },
      { frameworkId: 'claude-code' },
      { frameworkId: 'opencode' }
    ]

    // Baseline before deduplication was about 5.2k cl100k tokens (3.6k schema + 1.6k prompt).
    // Project Memory adds three bounded tools and their structured analysis contract (~305 tokens).
    // Network approval adds one bounded tool plus its denial/retry contract (~200 tokens).
    for (const { frameworkId, codexBridgeAliases } of frameworks) {
      const [{ text: schema }] = contextUsageMcpSections(frameworkId, {
        artifacts: false,
        notebook: true,
        skillImport: false,
        ...(codexBridgeAliases ? { codexBridgeAliases } : {})
      })
      expect(
        tokenCount(`${NOTEBOOK_SYSTEM_PROMPT_APPEND}\n${schema}`) + bashHeadroom,
        `${frameworkId}${codexBridgeAliases ? ' (bridge aliases)' : ''}`
      ).toBeLessThanOrEqual(4_175)
    }
  })

  it('uses bridge aliases for Codex MCP tools delivered through a compatibility proxy', () => {
    const sections = contextUsageMcpSections('codex', {
      artifacts: false,
      notebook: true,
      skillImport: false,
      codexBridgeAliases: true
    })

    const text = sections.map((section) => section.text).join('\n')
    expect(text).toContain('mcp__open_science_notebook__notebook_execute')
    expect(text).not.toContain('mcp.open-science-notebook.notebook_execute')
  })

  it('serializes only the app-owned MCP schemas enabled for the session', () => {
    const sections = contextUsageMcpSections('claude-code', {
      artifacts: true,
      notebook: true,
      skillImport: false
    })

    expect(sections.map(({ sectionId }) => sectionId)).toEqual([
      'mcp-schema:open-science-artifacts',
      'mcp-schema:open-science-notebook'
    ])
    expect(sections.map(({ text }) => text).join('\n')).toContain(
      'mcp__open_science_notebook__notebook_execute'
    )
    expect(sections.map(({ text }) => text).join('\n')).not.toContain('request_skill_import')
  })

  it('returns no baseline when app MCP tooling is unavailable', () => {
    expect(
      contextUsageMcpSections('claude-code', {
        artifacts: false,
        notebook: false,
        skillImport: false
      })
    ).toEqual([])
  })

  it('caches each static availability combination', () => {
    const options = { artifacts: false, notebook: true, skillImport: false }
    expect(contextUsageMcpSections('claude-code', options)).toBe(
      contextUsageMcpSections('claude-code', options)
    )
  })
})
