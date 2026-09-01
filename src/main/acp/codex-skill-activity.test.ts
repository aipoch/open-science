import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { CodexSkillActivityProjector } from './codex-skill-activity'

const toolEvent = (
  overrides: Partial<Extract<AcpRuntimeEvent, { kind: 'tool' }>>
): AcpRuntimeEvent => ({
  id: 'event-1',
  timestamp: 1,
  level: 'info',
  kind: 'tool',
  sessionId: 'session-1',
  toolCallId: 'read-skill-1',
  ...overrides
})

describe('CodexSkillActivityProjector', () => {
  it('projects an exact Codex Skill read lifecycle to name-only activity', () => {
    const codexHome = resolve('/data', 'codex-subscription')
    const skillPath = join(codexHome, 'skills', 'mcp-pubmed', 'SKILL.md')
    const projector = new CodexSkillActivityProjector(join(codexHome, 'skills'))

    const loadingProjection = projector.projectWithContext(
      toolEvent({
        toolKind: 'read',
        title: `Read file '${skillPath}'`,
        status: 'in_progress',
        toolLocations: [{ path: skillPath }],
        rawInput: { command: `cat ${skillPath}` },
        terminalOutput: 'private input',
        raw: { private: true }
      })
    )
    const loadedProjection = projector.projectWithContext(
      toolEvent({
        id: 'event-2',
        status: 'completed',
        rawOutput: { formatted_output: 'FULL SKILL BODY', exit_code: 0 },
        terminalOutput: 'FULL SKILL BODY',
        toolContent: [{ type: 'content', content: { type: 'text', text: 'FULL SKILL BODY' } }]
      })
    )
    const loading = loadingProjection.event
    const loaded = loadedProjection.event

    expect(loadingProjection.skillFile).toEqual({ name: 'mcp-pubmed', path: skillPath })
    expect(loadedProjection.skillFile).toEqual({ name: 'mcp-pubmed', path: skillPath })

    expect(loading).toMatchObject({
      kind: 'tool',
      toolCallId: 'read-skill-1',
      title: 'Loading skill: mcp-pubmed',
      status: 'in_progress'
    })
    expect(loaded).toMatchObject({
      kind: 'tool',
      toolCallId: 'read-skill-1',
      title: 'Loaded skill: mcp-pubmed',
      status: 'completed'
    })
    for (const event of [loading, loaded]) {
      expect(event).not.toHaveProperty('toolLocations')
      expect(event).not.toHaveProperty('rawInput')
      expect(event).not.toHaveProperty('rawOutput')
      expect(event).not.toHaveProperty('terminalOutput')
      expect(event).not.toHaveProperty('terminalExitCode')
      expect(event).not.toHaveProperty('toolContent')
      expect(event).not.toHaveProperty('raw')
      expect(JSON.stringify(event)).not.toContain(skillPath)
      expect(JSON.stringify(event)).not.toContain('FULL SKILL BODY')
    }
  })

  it.each([
    ['sibling path', join('/data', 'other', 'mcp-pubmed', 'SKILL.md')],
    [
      'nested non-Skill document',
      join('/data', 'codex-subscription', 'skills', 'mcp-pubmed', 'references', 'api.md')
    ],
    [
      'nested SKILL.md',
      join('/data', 'codex-subscription', 'skills', 'mcp-pubmed', 'nested', 'SKILL.md')
    ]
  ])('does not classify a %s', (_label, location) => {
    const projector = new CodexSkillActivityProjector(join('/data', 'codex-subscription', 'skills'))
    const original = toolEvent({
      toolKind: 'read',
      title: 'Ordinary read',
      status: 'in_progress',
      toolLocations: [{ path: location }],
      rawInput: { path: location }
    })

    expect(projector.project(original)).toEqual(original)
  })

  it('does not classify an ambiguous multi-location read', () => {
    const skillsRoot = join('/data', 'codex-subscription', 'skills')
    const projector = new CodexSkillActivityProjector(skillsRoot)
    const original = toolEvent({
      toolKind: 'read',
      toolLocations: [
        { path: join(skillsRoot, 'mcp-pubmed', 'SKILL.md') },
        { path: join(skillsRoot, 'other', 'SKILL.md') }
      ]
    })

    expect(projector.project(original)).toEqual(original)
  })

  it('clears tracked lifecycle state when the controlled Skill root changes', () => {
    const skillsRoot = join('/data', 'codex-subscription', 'skills')
    const projector = new CodexSkillActivityProjector(skillsRoot)
    projector.project(
      toolEvent({
        toolKind: 'read',
        status: 'in_progress',
        toolLocations: [{ path: join(skillsRoot, 'mcp-pubmed', 'SKILL.md') }]
      })
    )

    projector.setSkillsRoot(undefined)
    const completion = toolEvent({
      id: 'event-2',
      status: 'completed',
      rawOutput: { formatted_output: 'FULL SKILL BODY' }
    })

    expect(projector.project(completion)).toEqual(completion)
  })

  it('keeps colliding tool-call ids isolated by session', () => {
    const skillsRoot = join('/data', 'codex-subscription', 'skills')
    const projector = new CodexSkillActivityProjector(skillsRoot)

    projector.project(
      toolEvent({
        sessionId: 'session-a',
        toolCallId: 'shared-call-id',
        toolKind: 'read',
        status: 'in_progress',
        toolLocations: [{ path: join(skillsRoot, 'mcp-pubmed', 'SKILL.md') }]
      })
    )
    projector.project(
      toolEvent({
        sessionId: 'session-b',
        toolCallId: 'shared-call-id',
        toolKind: 'read',
        status: 'in_progress',
        toolLocations: [{ path: join(skillsRoot, 'mcp-chemistry', 'SKILL.md') }]
      })
    )

    const chemistryCompletion = projector.project(
      toolEvent({
        sessionId: 'session-b',
        toolCallId: 'shared-call-id',
        status: 'completed',
        rawOutput: { formatted_output: 'CHEMISTRY SKILL BODY' }
      })
    )
    const pubmedCompletion = projector.project(
      toolEvent({
        sessionId: 'session-a',
        toolCallId: 'shared-call-id',
        status: 'completed',
        rawOutput: { formatted_output: 'PUBMED SKILL BODY' }
      })
    )

    expect(chemistryCompletion.title).toBe('Loaded skill: mcp-chemistry')
    expect(pubmedCompletion.title).toBe('Loaded skill: mcp-pubmed')
    expect(chemistryCompletion).not.toHaveProperty('rawOutput')
    expect(pubmedCompletion).not.toHaveProperty('rawOutput')
  })

  it('clears only the deleted Session lifecycle while retaining another Session', () => {
    const skillsRoot = join('/data', 'codex-subscription', 'skills')
    const projector = new CodexSkillActivityProjector(skillsRoot)

    for (const [sessionId, skillName] of [
      ['session-a', 'mcp-pubmed'],
      ['session-b', 'mcp-chemistry']
    ] as const) {
      projector.project(
        toolEvent({
          sessionId,
          toolCallId: 'shared-call-id',
          toolKind: 'read',
          status: 'in_progress',
          toolLocations: [{ path: join(skillsRoot, skillName, 'SKILL.md') }]
        })
      )
    }

    projector.clearSession('session-a')
    const deletedCompletion = projector.project(
      toolEvent({
        sessionId: 'session-a',
        toolCallId: 'shared-call-id',
        status: 'completed'
      })
    )
    const retainedCompletion = projector.project(
      toolEvent({
        sessionId: 'session-b',
        toolCallId: 'shared-call-id',
        status: 'completed'
      })
    )

    expect(deletedCompletion.title).toBeUndefined()
    expect(retainedCompletion.title).toBe('Loaded skill: mcp-chemistry')
  })
})
