import { describe, it, expect } from 'vitest'
import { renderSkillDoc } from './skill-doc'

describe('renderSkillDoc', () => {
  it('renders frontmatter, conventions, and each tool', () => {
    const md = renderSkillDoc('chemistry')
    expect(md).toContain('name: mcp-chemistry')
    expect(md).toContain('source: connector')
    expect(md).toContain('host.mcp(')
    expect(md).toContain('pubchem_get_properties')
    expect(md).toContain('rate-limited') // rate warning present
  })
  it('uses the trigger-style useWhen as the frontmatter description for auto-discovery', () => {
    const md = renderSkillDoc('chemistry')
    // The frontmatter description is what Claude Code matches a plain user question against.
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toMatch(/description: ".*Use when.*"/)
    expect(md).toContain('## When to Use')
  })
  it('throws for an unknown connector', () => {
    expect(() => renderSkillDoc('nope')).toThrow()
  })
})
