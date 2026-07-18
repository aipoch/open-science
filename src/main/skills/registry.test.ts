import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'

const seedRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'skills-reg-'))
  await mkdir(join(root, 'demo'), { recursive: true })
  await writeFile(
    join(root, 'demo', 'SKILL.md'),
    [
      '---',
      'name: demo',
      'description: A demo skill.',
      'author: Test Author',
      'license: Test License',
      'third-party: Weights — Example (CC-BY-4.0)',
      'category: biomodels',
      'requirements: [gpu]',
      '---',
      '',
      '# Demo body'
    ].join('\n'),
    'utf8'
  )
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: 1,
      skills: [
        { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }),
    'utf8'
  )
  return root
}

describe('SkillRegistry', () => {
  it('lists skills merging manifest metadata with SKILL.md description', async () => {
    const registry = new SkillRegistry(await seedRoot())
    const skills = await registry.list()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      id: 'demo',
      name: 'Demo',
      description: 'A demo skill.',
      source: 'featured',
      author: 'Test Author',
      license: 'Test License',
      thirdParty: 'Weights — Example (CC-BY-4.0)',
      category: 'biomodels',
      // `requirements: [gpu]` is a YAML list; the flat frontmatter reader joins it to a string. The
      // materializer only substring-matches gpu/compute, so this stays equivalent.
      requirements: 'gpu'
    })
  })

  it('returns the SKILL.md body via body(id)', async () => {
    const registry = new SkillRegistry(await seedRoot())
    expect(await registry.body('demo')).toContain('# Demo body')
  })

  it('skips manifest entries whose SKILL.md is missing', async () => {
    const root = await seedRoot()
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'ghost', name: 'Ghost', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
        ]
      }),
      'utf8'
    )
    const skills = await new SkillRegistry(root).list()
    expect(skills.map((skill) => skill.id)).toEqual(['demo'])
  })

  it('returns empty list when the manifest is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-empty-'))
    expect(await new SkillRegistry(root).list()).toEqual([])
  })

  it('sorts featured skills alphabetically by name regardless of manifest order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-sort-'))
    const seed = [
      { id: 'charlie', name: 'Charlie' },
      { id: 'alpha', name: 'Alpha' },
      { id: 'bravo', name: 'Bravo' }
    ]
    for (const { id, name } of seed) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(
        join(root, id, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${name} skill.`, '---', '', `# ${name}`].join('\n'),
        'utf8'
      )
    }
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: seed.map(({ id, name }) => ({
          id,
          name,
          source: 'featured',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }))
      }),
      'utf8'
    )
    const skills = await new SkillRegistry(root).list()
    expect(skills.map((skill) => skill.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })
})
