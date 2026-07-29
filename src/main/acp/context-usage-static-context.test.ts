import { describe, expect, it } from 'vitest'

import { contextUsageMcpSections } from './context-usage-static-context'

describe('contextUsageMcpSections', () => {
  it('serializes only the app-owned MCP schemas enabled for the session', () => {
    const sections = contextUsageMcpSections({
      activity: true,
      artifacts: true,
      notebook: true,
      skillImport: false
    })

    expect(sections.map(({ sectionId }) => sectionId)).toEqual([
      'mcp-schema:open-science-activity',
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
      contextUsageMcpSections({
        activity: false,
        artifacts: false,
        notebook: false,
        skillImport: false
      })
    ).toEqual([])
  })

  it('caches each static availability combination', () => {
    const options = { activity: true, artifacts: false, notebook: true, skillImport: false }
    expect(contextUsageMcpSections(options)).toBe(contextUsageMcpSections(options))
  })
})
