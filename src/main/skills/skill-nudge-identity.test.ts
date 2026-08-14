import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './frontmatter'
import { SkillRegistry } from './registry'

// The real bundled-skills root shipped with the app.
const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')

// The `/` skill picker stores each pick's manifest id, and the runtime nudge names skills to the agent
// by that id (see AcpRuntime.applySkillNudge). The agent's Skill tool resolves a Skill by its SKILL.md
// frontmatter `name`. So for every bundled Skill the nudge id MUST equal the frontmatter
// name, or the agent fails the pick with "Unknown skill: <id>". This guards that contract for the whole
// bundled set — a new skill whose manifest id drifts from its frontmatter name breaks the picker.
describe('bundled skill nudge identity', () => {
  it('uses only the manifest id as every bundled Skill name', async () => {
    const skills = await new SkillRegistry(skillsRoot).list()
    expect(skills.length).toBeGreaterThan(0)

    for (const skill of skills) {
      const raw = await readFile(join(skill.sourceDir, 'SKILL.md'), 'utf8')
      const fields = parseFrontmatter(raw).fields

      expect(fields.name, `skill "${skill.id}" frontmatter name`).toBe(skill.id)
      expect(fields.displayname, `skill "${skill.id}" displayName`).toBeUndefined()
    }
  })
})
