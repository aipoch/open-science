import { describe, expect, it } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

import { NOTEBOOK_SYSTEM_PROMPT_APPEND } from '../notebook/mcp-server'
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
    const [{ text: schema }] = contextUsageMcpSections('codex', {
      artifacts: false,
      notebook: true,
      skillImport: false
    })
    const tokenizer = new Tiktoken(cl100kBase)

    // Baseline before deduplication was about 5.2k cl100k tokens (3.6k schema + 1.6k prompt).
    expect(
      tokenizer.encode(`${NOTEBOOK_SYSTEM_PROMPT_APPEND}\n${schema}`).length
    ).toBeLessThanOrEqual(3_500)
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
