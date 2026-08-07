import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { SkillRegistry } from '../skills/registry'
import { SettingsRepository } from './repository'
import { SkillCatalogModule } from './skill-catalog'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createCatalog = async (): Promise<SkillCatalogModule> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'settings-skill-catalog-'))
  const bundleRoot = await mkdtemp(join(tmpdir(), 'settings-skill-bundle-'))
  roots.push(storageRoot, bundleRoot)
  await mkdir(join(bundleRoot, 'demo'), { recursive: true })
  await writeFile(
    join(bundleRoot, 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill.\n---\n\ndemo body\n'
  )
  await writeFile(
    join(bundleRoot, 'manifest.json'),
    JSON.stringify({
      version: 1,
      skills: [
        { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    })
  )
  return new SkillCatalogModule({
    repository: new SettingsRepository(storageRoot),
    storageRoot,
    skillRegistry: new SkillRegistry(bundleRoot),
    userClaudeDir: join(storageRoot, 'user-claude'),
    userCodexDir: join(storageRoot, 'user-codex'),
    userAgentsDir: join(storageRoot, 'user-agents')
  })
}

describe('SkillCatalogModule', () => {
  it('exposes the stable compatibility identity for builtin Specialist dependencies', async () => {
    const catalog = await createCatalog()

    expect((await catalog.listSpecialistSkillCatalog())[0]?.compatibility).toMatch(
      /^sha256:[a-f0-9]{64}$/
    )
  })

  it('owns catalog projection, enablement, detail, and personal CRUD', async () => {
    const catalog = await createCatalog()

    expect(await catalog.listSkills()).toEqual([
      expect.objectContaining({ id: 'demo', description: 'A demo skill.', enabled: true })
    ])
    expect((await catalog.setSkillEnabled({ id: 'demo', enabled: false }))[0].enabled).toBe(false)
    expect(await catalog.listSpecialistSkillCatalog()).toEqual([
      {
        id: 'demo',
        frameworkName: 'demo',
        displayName: 'Demo',
        source: 'featured',
        mainEnabled: false,
        available: true,
        compatibility: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    ])
    expect((await catalog.getSkillDetail('demo')).body).toContain('demo body')

    const runtimeRoot = await mkdtemp(join(tmpdir(), 'settings-skill-runtime-'))
    roots.push(runtimeRoot)
    await catalog.materializeSkills(runtimeRoot, ['demo'])
    await expect(
      readFile(join(runtimeRoot, 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).rejects.toThrow()
    await catalog.materializeSkills(runtimeRoot, ['demo'], new Set(['demo']))
    await expect(
      readFile(join(runtimeRoot, 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).resolves.toContain('demo body')
    expect((await catalog.listSkills())[0].enabled).toBe(false)
    await chmod(join(runtimeRoot, 'skills', 'os-demo'), 0o755)
    await expect(
      catalog.codexSkillCatalog(join(tmpdir(), 'untrusted-codex-home'), async () => {
        throw new Error('untrusted homes must not resolve catalog extensions')
      })
    ).resolves.toEqual([])
    expect(
      (await catalog.createSkill({ name: 'My Skill', description: 'Mine.', body: '# Mine' })).map(
        (skill) => skill.id
      )
    ).toEqual(['demo', 'personal-my-skill'])
    expect(
      (
        await catalog.updateSkill({
          id: 'personal-my-skill',
          name: 'My Skill',
          description: 'Edited.',
          body: '# Edited'
        })
      ).find((skill) => skill.id === 'personal-my-skill')
    ).toMatchObject({ description: 'Edited.' })
    expect(
      (await catalog.deleteSkill({ id: 'personal-my-skill' })).map((skill) => skill.id)
    ).toEqual(['demo'])
  })

  it('exports a personal Skill as a portable ZIP archive', async () => {
    const catalog = await createCatalog()
    await catalog.createSkill({
      name: 'My Skill',
      description: 'Mine.',
      body: '# Mine',
      references: [
        { path: 'example.txt', dataBase64: Buffer.from('example reference').toString('base64') }
      ]
    })

    const exported = await catalog.buildSkillExport('personal-my-skill')
    const files = unzipSync(exported.archiveBytes)

    expect(exported.fileName).toBe('my-skill.zip')
    expect(strFromU8(files['SKILL.md'])).toContain('# Mine')
    expect(strFromU8(files['references/example.txt'])).toBe('example reference')
    expect((await catalog.buildSkillExport('personal-my-skill')).archiveBytes).toEqual(
      exported.archiveBytes
    )
  })

  it('omits imported-Skill provenance from the exported ZIP archive', async () => {
    const catalog = await createCatalog()
    const importedZip = zipSync({
      'SKILL.md': strToU8(
        ['---', 'name: Imported Skill', 'description: Imported.', '---', '', '# Imported'].join(
          '\n'
        )
      )
    })
    const imported = await catalog.importSkillZip({
      dataBase64: Buffer.from(importedZip).toString('base64')
    })

    const exported = await catalog.buildSkillExport(imported.id)
    const files = unzipSync(exported.archiveBytes)

    expect(Object.keys(files)).toEqual(['SKILL.md'])
  })

  it('refuses to export built-in and unknown Skills', async () => {
    const catalog = await createCatalog()

    await expect(catalog.buildSkillExport('demo')).rejects.toThrow(
      'Built-in Skills cannot be exported.'
    )
    await expect(catalog.buildSkillExport('missing')).rejects.toThrow('Unknown skill: missing')
  })

  it('owns active-framework agent-home discovery and batch import', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-agent-home-catalog-'))
    const bundleRoot = await mkdtemp(join(tmpdir(), 'settings-agent-home-bundle-'))
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'settings-agent-home-claude-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'settings-agent-home-agents-'))
    roots.push(storageRoot, bundleRoot, userClaudeDir, userAgentsDir)
    await writeFile(join(bundleRoot, 'manifest.json'), JSON.stringify({ version: 1, skills: [] }))
    const seed = async (home: string, slug: string): Promise<void> => {
      await mkdir(join(home, 'skills', slug), { recursive: true })
      await writeFile(
        join(home, 'skills', slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: Test ${slug}\n---\nBody\n`
      )
    }
    await seed(userAgentsDir, 'shared')
    await seed(userClaudeDir, 'claude-only')
    const repository = new SettingsRepository(storageRoot)
    await repository.setAgentFramework('claude-code')
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      userClaudeDir,
      userAgentsDir,
      userCodexDir: join(storageRoot, 'user-codex'),
      skillRegistry: new SkillRegistry(bundleRoot)
    })

    expect(
      (await catalog.listAgentHomeSkills()).map(({ source, slug }) => ({ source, slug }))
    ).toEqual([
      { source: 'agents', slug: 'shared' },
      { source: 'claude', slug: 'claude-only' }
    ])
    expect(
      (
        await catalog.importAgentHomeSkills({
          skills: [{ source: 'agents', slug: 'shared' }]
        })
      ).results
    ).toEqual([{ source: 'agents', slug: 'shared', status: 'imported', id: 'imported-shared' }])

    const preview = await catalog.previewAgentHomeSkill({ source: 'claude', slug: 'claude-only' })
    expect(preview.sourceLabel).toBe('~/.claude/skills/claude-only')
    expect(JSON.stringify(preview)).not.toContain(userClaudeDir)

    expect(
      (
        await catalog.importAgentHomeSkills({
          skills: [{ source: 'agents', slug: '../escape' }]
        })
      ).results
    ).toEqual([
      {
        source: 'agents',
        slug: '../escape',
        error: 'Refusing to import installed skill with unsafe slug: ../escape'
      }
    ])
  })
})
