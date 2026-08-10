import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'

const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')

describe('self-awareness bundled Skill', () => {
  it('is an internal runtime Skill with host.capabilities trigger metadata', async () => {
    const skill = (await new SkillRegistry(skillsRoot).list()).find(
      (entry) => entry.id === 'self-awareness'
    )

    expect(skill).toMatchObject({
      id: 'self-awareness',
      name: 'Self-awareness',
      source: 'featured',
      exposure: 'internal'
    })
    expect(skill?.description).toContain('host.capabilities()')
    expect(skill?.description).toMatch(/JavaScript control REPL/i)
  })

  it('documents only the shipped four-key JavaScript contract and its maintenance rule', async () => {
    const body = await new SkillRegistry(skillsRoot).body('self-awareness')

    for (const phrase of [
      'repl_execute',
      'await host.capabilities()',
      '`mcp`',
      '`compute`',
      '`agents`',
      '`skills`',
      'caps.compute === true',
      'fresh frozen projection',
      'same feature change'
    ]) {
      expect(body).toContain(phrase)
    }
    expect(body).not.toMatch(/host\.(query|frames|artifacts)/)
  })
})
