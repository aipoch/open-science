import { describe, expect, it } from 'vitest'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { ToolActivity } from '@/stores/session-store'

import {
  extractSkillLoadDocument,
  getLoadedSkillName,
  getSkillLoadPermissionSkillName,
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

  it('parses the imperative Load skill title variant', () => {
    expect(getLoadedSkillName(createActivity({ title: 'Load skill: self-awareness' }))).toBe(
      'self-awareness'
    )
    expect(getLoadedSkillName(createActivity({ title: 'Loading skill: pubmed' }))).toBe('pubmed')
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

describe('getSkillLoadPermissionSkillName', () => {
  const createRequest = (overrides: Partial<AcpPermissionRequest>): AcpPermissionRequest => ({
    requestId: 'permission-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'mcp__skills__load_skill',
    isMcp: true,
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    ...overrides
  })

  it('matches the broker-resolved skills/load_skill identity and trims the skill name', () => {
    const request = createRequest({
      title: 'Allow tool?',
      mcpIdentity: 'skills/load_skill',
      rawInput: { skill: ' literature-review ' }
    })

    expect(getSkillLoadPermissionSkillName(request)).toBe('literature-review')
  })

  it('matches provider namespacing in providerToolName and title without an mcpIdentity', () => {
    expect(
      getSkillLoadPermissionSkillName(
        createRequest({
          providerToolName: 'mcp.skills.load_skill',
          title: 'Allow tool?',
          rawInput: { skill: 'pubmed' }
        })
      )
    ).toBe('pubmed')
    expect(
      getSkillLoadPermissionSkillName(
        createRequest({
          title: 'mcp__skills__load_skill',
          rawInput: { skill: 'pubmed' }
        })
      )
    ).toBe('pubmed')
  })

  it('unwraps the Codex arguments envelope', () => {
    const request = createRequest({
      mcpIdentity: 'skills/load_skill',
      rawInput: { arguments: { skill: 'pubmed', args: '--depth full' } }
    })

    expect(getSkillLoadPermissionSkillName(request)).toBe('pubmed')
  })

  it('returns undefined for non-skill requests and skill loads without a usable name', () => {
    expect(
      getSkillLoadPermissionSkillName(
        createRequest({
          title: 'mcp__open-science-notebook__notebook_execute',
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          mcpIdentity: 'open-science-notebook/notebook_execute',
          rawInput: { skill: 'pubmed' }
        })
      )
    ).toBeUndefined()
    expect(
      getSkillLoadPermissionSkillName(
        createRequest({ mcpIdentity: 'skills/load_skill', rawInput: { skill: '  ' } })
      )
    ).toBeUndefined()
    expect(
      getSkillLoadPermissionSkillName(createRequest({ mcpIdentity: 'skills/load_skill' }))
    ).toBeUndefined()
  })
})
