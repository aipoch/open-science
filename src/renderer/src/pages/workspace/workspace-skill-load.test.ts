import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import {
  extractSkillLoadDocument,
  getLoadedSkillName,
  isSkillLoadActivity
} from './workspace-skill-load'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('workspace skill load helpers', () => {
  it('detects the load_skill tool identity across provider namespacing', () => {
    expect(
      isSkillLoadActivity(createActivity({ providerToolName: 'mcp__skills__load_skill' }))
    ).toBe(true)
    expect(isSkillLoadActivity(createActivity({ providerToolName: 'mcp.skills.load_skill' }))).toBe(
      true
    )
    expect(isSkillLoadActivity(createActivity({ title: 'mcp__skills__load_skill' }))).toBe(true)
    expect(
      isSkillLoadActivity(createActivity({ providerToolName: 'mcp__skills__list_skills' }))
    ).toBe(false)
  })

  it('prefers the projected lifecycle title when reading the loaded Skill name', () => {
    const activity = createActivity({
      providerToolName: 'mcp__skills__load_skill',
      title: 'Loaded skill: pubmed',
      rawInput: { skill: 'mcp-pubmed' }
    })

    expect(getLoadedSkillName(activity)).toBe('pubmed')
  })

  it('strips the base-directory prefix and YAML frontmatter from a skill document', () => {
    const output =
      'Base directory for this skill: /repo/.claude/skills/mcp-pubmed\n\n' +
      '---\nname: mcp-pubmed\ndescription: Search PubMed\n---\n\n' +
      '# mcp-pubmed\n\nSearch PubMed articles.'

    expect(extractSkillLoadDocument(output)).toBe('# mcp-pubmed\n\nSearch PubMed articles.')
  })

  it('keeps a skill document that has no frontmatter', () => {
    const output = 'Base directory for this skill: /repo/.claude/skills/plain\n\n# Plain\n\nBody.'

    expect(extractSkillLoadDocument(output)).toBe('# Plain\n\nBody.')
  })

  it('handles CRLF documents', () => {
    const output =
      'Base directory for this skill: C:\\skills\\win\r\n\r\n---\r\nname: win\r\n---\r\n# Win'

    expect(extractSkillLoadDocument(output)).toBe('# Win')
  })

  it('rejects outputs without the skill-document prefix or without a body', () => {
    expect(extractSkillLoadDocument('Unknown skill: nope')).toBeUndefined()
    expect(extractSkillLoadDocument('Base directory for this skill: /x\n\n   ')).toBeUndefined()
  })
})
