import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UserSkillSpecialistPackageAdapter } from './specialist-package-adapter'

describe('Specialist package source adapters', () => {
  it('reads a complete stable Skill directory for export without sidecar metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-export-snapshot-'))
    try {
      const skill = join(root, 'skills', 'personal', 'analysis-tools')
      await mkdir(join(skill, 'references'), { recursive: true })
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse the tools.'
      )
      await writeFile(join(skill, 'references', 'guide.md'), 'Complete reference.')
      await writeFile(
        join(skill, '.specialist-package.json'),
        JSON.stringify({
          id: 'analysis-tools',
          version: '1.2.3',
          contentHash: 'stale-sidecar-hash',
          standalone: false,
          ownerIds: ['research-synth']
        })
      )

      const adapter = new UserSkillSpecialistPackageAdapter(root)
      const snapshot = await adapter.exportSnapshot(['analysis-tools'])

      expect(snapshot).toEqual([
        expect.objectContaining({
          localId: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          files: [
            expect.objectContaining({ path: 'references/guide.md' }),
            expect.objectContaining({ path: 'SKILL.md' })
          ]
        })
      ])
      expect(snapshot[0].files.map((file) => file.path)).not.toContain('.specialist-package.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports a Personal Skill with its immutable name instead of the storage source prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-export-snapshot-'))
    try {
      const skill = join(root, 'skills', 'personal', 'literature-review')
      await mkdir(skill, { recursive: true })
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: literature-review\ndescription: Review literature\n---\nReview.'
      )

      const adapter = new UserSkillSpecialistPackageAdapter(root)
      const snapshot = await adapter.exportSnapshot(['personal-literature-review'])

      expect(snapshot).toEqual([
        expect.objectContaining({
          localId: 'personal-literature-review',
          name: 'literature-review'
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
