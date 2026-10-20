import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadSkillDocumentContent, readSkillRuntimeCatalog } from './runtime-document'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('reads caller-selected directories and applies caller metadata budgets independently of MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-reader-'))
  roots.push(root)
  const skillsDirectory = join(root, 'custom-catalog')
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(skillsDirectory, name), { recursive: true })
    await writeFile(
      join(skillsDirectory, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Example document\n---\nRead $ARGUMENTS.`
    )
  }
  const environment = { root, skillsDirectory }
  expect(await loadSkillDocumentContent(environment, 'alpha', 'witness')).toContain('Read witness.')
  const policy = {
    maxEntries: 10,
    maxDescriptionLength: 7,
    maxMetadataBytes: 1,
    measureEntry: () => 1
  }
  expect(await readSkillRuntimeCatalog(environment, policy)).toEqual({
    entries: [{ name: 'alpha', description: 'Example' }],
    truncated: true
  })
  expect(
    await readSkillRuntimeCatalog({ ...environment, allowedNames: new Set(['beta']) }, policy)
  ).toEqual({ entries: [{ name: 'beta', description: 'Example' }], truncated: false })
  await expect(
    loadSkillDocumentContent({ root, skillsDirectory: join(root, '..') }, 'alpha')
  ).rejects.toThrow()
  await expect(loadSkillDocumentContent(environment, '../alpha')).rejects.toThrow()
})

it('accepts the name length boundary and rejects long near-matches without overlapping quantifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-name-bound-'))
  roots.push(root)
  const skillsDirectory = join(root, 'catalog')
  const name = '0'.repeat(128)
  await mkdir(join(skillsDirectory, name), { recursive: true })
  await writeFile(
    join(skillsDirectory, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Boundary\n---\nReadable`
  )
  expect(await loadSkillDocumentContent({ root, skillsDirectory }, name)).toContain('Readable')
  for (const invalid of ['0'.repeat(129), '0'.repeat(100_000) + '!', '_leading']) {
    await expect(loadSkillDocumentContent({ root, skillsDirectory }, invalid)).rejects.toThrow(
      'Unknown skill'
    )
  }
})
