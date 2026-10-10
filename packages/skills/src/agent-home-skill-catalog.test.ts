import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHomeSkillCatalog } from './agent-home-skill-catalog'
import { UserSkillRepository } from './user-skill-repository'
import { listSkillPackageFiles, skillReferencesFromPackageFiles } from './skill-files'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(): Promise<{
  root: string
  home: string
  skill: string
  repo: UserSkillRepository
  catalog: AgentHomeSkillCatalog
  sources: { source: 'agents'; dir: string }[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'skill-discovery-'))
  roots.push(root)
  const home = join(root, 'agents')
  const skill = join(home, 'example')
  await mkdir(join(skill, 'references'), { recursive: true })
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nRead references/proof.txt.'
  )
  await writeFile(join(skill, 'references/proof.txt'), 'package-only witness')
  const repo = new UserSkillRepository(join(root, 'data'))
  return {
    root,
    home,
    skill,
    repo,
    catalog: new AgentHomeSkillCatalog(repo),
    sources: [{ source: 'agents' as const, dir: home }]
  }
}

it('discovers, previews and imports through an independently supplied repository and roots', async () => {
  const { catalog, repo, sources } = await fixture()
  expect(await catalog.list(sources)).toEqual([
    expect.objectContaining({ name: 'example', alreadyImported: false })
  ])
  const preview = await catalog.previewAgentHomeSkill(sources, {
    source: 'agents',
    slug: 'example'
  })
  expect(preview.sourceLabel).toBe('~/.agents/skills/example')
  expect(preview.files).toContain('references/proof.txt')
  const results = await catalog.importAgentHomeSkills(sources, [
    { source: 'agents', slug: 'example' }
  ])
  expect(results[0].status).toBe('imported')
  expect(await catalog.list(sources)).toEqual([expect.objectContaining({ alreadyImported: true })])
  const [installed] = await repo.list()
  expect(await readFile(join(installed.sourceDir, 'references/proof.txt'), 'utf8')).toBe(
    'package-only witness'
  )
  expect(
    (await catalog.importAgentHomeSkills(sources, [{ source: 'agents', slug: 'example' }]))[0]
      .status
  ).toBe('unchanged')
})

it('collapses allowed-root aliases while rejecting traversal, external and nested symlinks', async () => {
  const { root, home, skill, catalog, sources } = await fixture()
  const alias = join(root, 'claude')
  await mkdir(alias)
  await symlink(skill, join(alias, 'example'), process.platform === 'win32' ? 'junction' : 'dir')
  const both = [...sources, { source: 'claude' as const, dir: alias }]
  expect(await catalog.list(both)).toHaveLength(1)
  await expect(
    catalog.previewAgentHomeSkill(both, { source: 'agents', slug: '../example' })
  ).rejects.toThrow('unsafe slug')
  const external = join(root, 'external')
  await mkdir(external)
  await symlink(external, join(home, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    catalog.previewAgentHomeSkill(both, { source: 'agents', slug: 'escape' })
  ).rejects.toThrow('outside its source')
  await symlink(
    join(skill, 'references'),
    join(alias, 'nested'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(
    catalog.previewAgentHomeSkill(both, { source: 'claude', slug: 'nested' })
  ).rejects.toThrow('top-level')
  const results = await catalog.importAgentHomeSkills(both, [
    { source: 'agents', slug: 'escape' },
    { source: 'claude', slug: 'example' }
  ])
  expect(results[0].error).toContain('outside its source')
  expect(results[1].status).toBe('imported')
})

it('preserves legacy identity reconciliation without host settings or a second writer', async () => {
  const { root, skill, repo, catalog, sources } = await fixture()
  const { id } = await repo.importAgentHomeSkill(skill, { source: 'claude', slug: 'old-alias' })
  const alias = join(root, 'claude')
  await mkdir(alias)
  await symlink(skill, join(alias, 'old-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const both = [...sources, { source: 'claude' as const, dir: alias }]
  await catalog.migrateIdentities(both, [])
  const [installed] = await repo.list()
  expect(installed.id).toBe(id)
  expect((await catalog.list(both))[0].alreadyImported).toBe(true)
  const metadata = JSON.parse(await readFile(join(installed.sourceDir, '.source.json'), 'utf8'))
  expect(metadata.agentHome).toEqual({ source: 'agents', slug: 'example' })
})

it('enumerates only regular package files and preserves reference metadata semantics', async () => {
  const { skill } = await fixture()
  await mkdir(join(skill, 'references/nested'))
  await writeFile(join(skill, 'references/nested/deep.txt'), 'deep')
  await symlink(join(skill, 'SKILL.md'), join(skill, 'alias.md'))
  const files = await listSkillPackageFiles(skill)
  expect(files.map((file) => file.path)).toEqual([
    'references/nested/deep.txt',
    'references/proof.txt',
    'SKILL.md'
  ])
  expect(skillReferencesFromPackageFiles(files)).toEqual([{ path: 'proof.txt', sizeBytes: 20 }])
})

it('keeps a failed legacy migration importable and clears the failure after successful recovery', async () => {
  const { root, skill, repo, catalog, sources } = await fixture()
  const { id } = await repo.importAgentHomeSkill(skill, { source: 'claude', slug: 'old-alias' })
  const alias = join(root, 'claude')
  await mkdir(alias)
  await symlink(skill, join(alias, 'old-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const both = [...sources, { source: 'claude' as const, dir: alias }]
  const failure = vi
    .spyOn(repo, 'importAgentHomeSkill')
    .mockRejectedValueOnce(new Error('promotion failed'))
  try {
    await catalog.migrateIdentities(both, [])
    expect((await catalog.list(both))[0].alreadyImported).toBe(false)
  } finally {
    failure.mockRestore()
  }
  await catalog.migrateIdentities(both, [])
  expect((await catalog.list(both))[0].alreadyImported).toBe(true)
  expect((await repo.list())[0].id).toBe(id)
})
