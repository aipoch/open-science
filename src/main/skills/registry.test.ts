import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from '@aipoch/skills'
import { toUnpackedAsarPath } from './resource-path'

describe('SkillRegistry', () => {
  it('resolves packaged Skill resources outside app.asar without consulting the cwd', () => {
    expect(
      toUnpackedAsarPath(
        '/Applications/Open-Science.app/Contents/Resources/app.asar/resources/skills'
      )
    ).toBe('/Applications/Open-Science.app/Contents/Resources/app.asar.unpacked/resources/skills')
    expect(toUnpackedAsarPath('/workspace/resources/skills')).toBe('/workspace/resources/skills')
  })

  it('discovers the bundled figure helper descriptors from the production manifest', async () => {
    const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')
    const skills = await new SkillRegistry(skillsRoot).list()
    const figureSkills = skills.filter(({ id }) =>
      ['figure-style', 'figure-composer', 'paper-narrative'].includes(id)
    )

    expect(figureSkills.map(({ id }) => id).sort()).toEqual([
      'figure-composer',
      'figure-style',
      'paper-narrative'
    ])
    for (const skill of figureSkills) {
      expect(skill).toMatchObject({ source: 'featured' })
      expect(skill.helpers).toEqual([
        expect.objectContaining({
          id: skill.id,
          language: 'python',
          implementation: 'kernel.py',
          exports: expect.any(Array)
        })
      ])
      expect(skill.helpers?.[0]?.exports.length).toBeGreaterThan(0)
      expect(skill.helpers?.[0]).not.toHaveProperty('source')
    }
  })

  it('marks exactly the application-required Skills always-on in the production manifest', async () => {
    const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')
    const skills = await new SkillRegistry(skillsRoot).list()

    expect(
      skills
        .filter((skill) => skill.activationPolicy === 'always-on')
        .map((skill) => skill.id)
        .sort()
    ).toEqual([
      'compute-env-setup',
      'customize',
      'env-management',
      'remote-compute-ssh',
      'self-awareness',
      'skill-creator'
    ])
  })
})
