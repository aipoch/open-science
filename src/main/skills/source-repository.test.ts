import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSkillSource, SkillSourceRepository } from './source-repository'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const setup = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'skill-sources-'))
  roots.push(root)
  return root
}

describe('saved Skill sources', () => {
  it('normalizes equivalent repositories, preserves ref case and supports slash refs', () => {
    expect(normalizeSkillSource('https://github.com/Owner/Repo.git/')).toEqual(
      normalizeSkillSource('owner/repo')
    )
    expect(normalizeSkillSource('https://github.com/Owner/Repo/tree/Release')).toEqual(
      normalizeSkillSource('owner/repo@Release')
    )
    expect(normalizeSkillSource('owner/repo@feature/new').ref).toBe('feature/new')
    expect(normalizeSkillSource('owner/repo@Release').id).not.toBe(
      normalizeSkillSource('owner/repo@release').id
    )
  })
  it.each([
    'https://evil.test/o/r',
    'http://github.com/o/r',
    'https://user:password@github.com/o/r',
    'https://github.com/o/r?token=secret',
    'https://github.com/o/r#readme',
    'https://github.com/o/r/tree/main/folder',
    'https://github.com/o/r/blob/main/SKILL.md',
    '../r',
    'o/r@../secret',
    'o/r@foo.lock',
    'o/r@foo//bar',
    'keyword'
  ])('rejects invalid or ambiguous source %s', (value) => {
    expect(() => normalizeSkillSource(value)).toThrow()
  })
  it('serializes concurrent writes, deduplicates and survives restart without touching installed Skills', async () => {
    const root = await setup()
    const installed = join(root, 'installed-skill.txt')
    await writeFile(installed, 'keep')
    const repository = new SkillSourceRepository(root)
    expect(await repository.list()).toEqual([])
    await Promise.all([
      repository.add({ repository: 'o/one' }),
      repository.add({ repository: 'o/two@main' }),
      repository.add({ repository: 'https://github.com/O/one' })
    ])
    const restarted = new SkillSourceRepository(root)
    const saved = await restarted.list()
    expect(saved).toHaveLength(2)
    await restarted.remove({ id: saved[0].id })
    expect(await new SkillSourceRepository(root).list()).toEqual([saved[1]])
    expect(await readFile(installed, 'utf8')).toBe('keep')
  })
  it.each([
    '{broken',
    '{"version":2,"sources":[]}',
    '{"version":1,"sources":[{"id":"bad","repository":"o/r"}]}'
  ])('preserves unreadable storage and blocks mutations', async (contents) => {
    const root = await setup()
    const file = join(root, 'skill-sources.json')
    await writeFile(file, contents)
    const repository = new SkillSourceRepository(root)
    await expect(repository.list()).rejects.toThrow('preserved')
    await expect(repository.add({ repository: 'o/r' })).rejects.toThrow('preserved')
    expect(await readFile(file, 'utf8')).toBe(contents)
  })
})
