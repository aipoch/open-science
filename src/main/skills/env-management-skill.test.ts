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

  it('uses package inspection for version questions without adding an install preflight', async () => {
    const body = await new SkillRegistry(skillsRoot).body('env-management')

    expect(body).toContain('inspect_packages')
    expect(body).toMatch(/external runtime.*notebook_execute/)
    expect(body).toMatch(/version/i)
    expect(body).toMatch(/do not.*preflight|not.*preflight/i)
    expect(body).toMatch(/missing.*manage_packages/i)
  })

  it('uses canonical create receipts and verifies imports separately from package metadata', async () => {
    const body = await new SkillRegistry(skillsRoot).body('env-management')

    expect(body).toMatch(/created\.runnable.*created\.runtimeId/i)
    expect(body).toMatch(/create does not select/i)
    expect(body).toMatch(/no existing.*notebook_bind_runtime/i)
    expect(body).toMatch(/existing.*notebook_switch_runtime/i)
    expect(body).toContain('target receipt')
    expect(body).toContain('selection:"unresolved"')
    expect(body).toMatch(/failed bind or switch.*bindingChanged.*target/i)
    expect(body).toMatch(/only.*action:"list".*full.*snapshot/i)
    expect(body).toMatch(/create.*remove.*do not return.*snapshot/i)
    expect(body).toMatch(/unchanged.*distribution metadata/i)
    expect(body).toMatch(/notebook_execute.*import/i)
  })
})
