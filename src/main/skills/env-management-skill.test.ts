import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'

// The real bundled-skills root shipped with the app. The registry reads manifest.json + each SKILL.md.
const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')

describe('env-management bundled skill', () => {
  it('is discovered by the registry with a Use-when trigger description', async () => {
    const skills = await new SkillRegistry(skillsRoot).list()
    const skill = skills.find((entry) => entry.id === 'env-management')

    expect(skill).toBeDefined()
    expect(skill?.description).toMatch(/use when/i)
    // Trigger must fire on the install/missing-package situations this skill governs.
    expect(skill?.description.toLowerCase()).toContain('manage_packages')
  })

  it('guides both python and r installs and states the forbidden paths and restart rule', async () => {
    const body = await new SkillRegistry(skillsRoot).body('env-management')
    for (const phrase of [
      'manage_packages',
      'notebook_restart',
      'install.packages(',
      '%pip',
      '!pip'
    ]) {
      expect(body).toContain(phrase)
    }
    // Language routing and the stop-and-report boundary are both present.
    expect(body).toMatch(/python/i)
    expect(body).toMatch(/\bR\b/)
    expect(body).toMatch(/manage_environments/)
  })
})
