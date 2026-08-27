import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'
import { toUnpackedAsarPath } from './resource-path'

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
  it('resolves packaged Skill resources outside app.asar without consulting the cwd', () => {
    expect(
      toUnpackedAsarPath(
        '/Applications/Open Science.app/Contents/Resources/app.asar/resources/skills'
      )
    ).toBe('/Applications/Open Science.app/Contents/Resources/app.asar.unpacked/resources/skills')
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

  it('lists skills merging manifest metadata with SKILL.md description', async () => {
    const registry = new SkillRegistry(await seedRoot())
    const skills = await registry.list()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      id: 'demo',
      name: 'demo',
      displayName: 'Demo',
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

  it('uses an optional SKILL.md displayName instead of the manifest presentation name', async () => {
    const root = await seedRoot()
    await writeFile(
      join(root, 'demo', 'SKILL.md'),
      [
        '---',
        'name: demo',
        'displayName: Demo Skill',
        'description: A demo skill.',
        '---',
        '',
        '# Demo body'
      ].join('\n'),
      'utf8'
    )

    expect((await new SkillRegistry(root).list())[0]?.displayName).toBe('Demo Skill')
  })

  it('sorts bundled skills by presentation name instead of invocation name', async () => {
    const root = await seedRoot()
    await mkdir(join(root, 'alpha'), { recursive: true })
    await writeFile(
      join(root, 'alpha', 'SKILL.md'),
      '---\nname: zebra\ndescription: Another skill.\n---\nBody.',
      'utf8'
    )
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { id: 'demo', name: 'Zebra', source: 'featured', updatedAt: '2026-01-01' },
          { id: 'alpha', name: 'Alpha', source: 'featured', updatedAt: '2026-01-01' }
        ]
      }),
      'utf8'
    )

    expect((await new SkillRegistry(root).list()).map((skill) => skill.id)).toEqual([
      'alpha',
      'demo'
    ])
  })

  it('returns the SKILL.md body via body(id)', async () => {
    const registry = new SkillRegistry(await seedRoot())
    expect(await registry.body('demo')).toContain('# Demo body')
  })

  it('marks internal bundled Skills without changing their runtime source', async () => {
    const root = await seedRoot()
    const manifestPath = join(root, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        skills: [
          {
            id: 'demo',
            name: 'Demo',
            source: 'featured',
            exposure: 'internal',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    )

    expect((await new SkillRegistry(root).list())[0]).toMatchObject({
      id: 'demo',
      source: 'featured',
      exposure: 'internal'
    })
  })

  it('derives a stable compatibility identity from bundled Skill content', async () => {
    const root = await seedRoot()
    const before = (await new SkillRegistry(root).list())[0]?.compatibility

    expect(before).toMatch(/^sha256:[a-f0-9]{64}$/)

    await writeFile(join(root, 'demo', 'SKILL.md'), '# Changed bundled Skill\n', 'utf8')
    const after = (await new SkillRegistry(root).list())[0]?.compatibility
    expect(after).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(after).not.toBe(before)
  })

  it('normalizes a bundled registered-helper descriptor without exposing its source', async () => {
    const root = await seedRoot()
    await writeFile(join(root, 'demo', 'kernel.py'), 'def public_demo():\n    return 1\n')
    await writeFile(
      join(root, 'demo', 'open-science.json'),
      JSON.stringify({
        schemaVersion: 1,
        helpers: [
          {
            id: 'demo-helper',
            language: 'python',
            interfaceRevision: 1,
            implementation: 'kernel.py',
            exports: ['public_demo'],
            dependencies: []
          }
        ]
      })
    )

    expect((await new SkillRegistry(root).list())[0]?.helpers).toEqual([
      {
        id: 'demo-helper',
        language: 'python',
        interfaceRevision: 1,
        implementation: 'kernel.py',
        exports: ['public_demo'],
        dependencies: []
      }
    ])
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
