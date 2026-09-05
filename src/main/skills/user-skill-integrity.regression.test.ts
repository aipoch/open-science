import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'

import type { FetchLike } from './github-import'
import { UserSkillRepository, type ImportOutcome } from './user-skill-repository'
import type { SkillReference } from '../../shared/settings'

const roots: string[] = []
const fixture = async (): Promise<{ root: string; repo: UserSkillRepository }> => {
  const root = await mkdtemp(join(tmpdir(), 'skill-integrity-'))
  roots.push(root)
  return { root, repo: new UserSkillRepository(root) }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const document = (name = 'demo', body = 'original'): string =>
  `---\nname: ${name}\ndescription: Original description\n---\n${body}\n`
const zip = (files: Record<string, string>): Buffer =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]))
    )
  )
const baseInput = { name: 'demo', description: 'Original description', body: 'original' }
const reference = (path: string, text = 'a,b\n1,2\n'): SkillReference => ({
  path,
  dataBase64: Buffer.from(text).toString('base64')
})

// Only the external GitHub transport is controlled. Both scan and import run their real owners.
const githubFetch =
  (sha: string, body: string): FetchLike =>
  async (url) => {
    const files: Record<string, string> = {
      'SKILL.md': document('demo', body),
      'data.csv': 'a,b\n1,2\n'
    }
    let payload: unknown
    let content = ''
    if (url.includes('/commits/')) payload = { sha }
    else if (url.includes('/git/trees/'))
      payload = { tree: [{ path: 'demo/SKILL.md', type: 'blob' }] }
    else if (url.includes('/contents/'))
      payload = Object.keys(files).map((name) => ({
        type: 'file',
        name,
        path: `demo/${name}`,
        download_url: `https://raw.githubusercontent.com/acme/skills/${sha}/demo/${name}`
      }))
    else if (url.startsWith('https://raw.githubusercontent.com/')) {
      const name = url.split('/').pop()!
      if (!(name in files)) throw new Error(`Unexpected GitHub file: ${url}`)
      content = files[name]
    } else if (/^https:\/\/api.github.com\/repos\/[^/]+\/[^/]+$/.test(url))
      payload = { default_branch: 'main' }
    else throw new Error(`Unexpected GitHub request: ${url}`)
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer
    }
  }

describe('reported Skill integrity regressions through UserSkillRepository', () => {
  it.each(['数据.csv', 'my data.csv'])(
    'SK01 saves a new reference named %s without losing it',
    async (name) => {
      const { root, repo } = await fixture()
      expect(await repo.createPersonal({ ...baseInput, references: [reference(name)] })).toBe(
        'personal-demo'
      )
      await expect(
        readFile(join(root, 'skills/personal/demo/references', name), 'utf8')
      ).resolves.toBe('a,b\n1,2\n')
    }
  )

  it.each(['数据.csv', 'my data.csv'])(
    'SK01 preserves an existing name-only reference %s on body save',
    async (name) => {
      const { root, repo } = await fixture()
      const id = await repo.createPersonal(baseInput)
      const references = join(root, 'skills/personal/demo/references')
      await mkdir(references)
      await writeFile(join(references, name), 'keep me')
      const names = await repo.withSkillReadLock(id, (skill) =>
        readdir(join(skill.sourceDir, 'references'))
      )
      expect(names).toEqual([name])
      await repo.updatePersonal(id, {
        ...baseInput,
        body: 'body edited',
        references: names!.map((path) => ({ path }))
      })
      expect(await repo.body(id)).toContain('body edited')
      await expect(readFile(join(references, name), 'utf8')).resolves.toBe('keep me')
    }
  )

  it('SK01 control: explicitly removing a reference still removes only that file', async () => {
    const { root, repo } = await fixture()
    const id = await repo.createPersonal({
      ...baseInput,
      references: [reference('keep.csv'), reference('delete.csv')]
    })
    await repo.updatePersonal(id, { ...baseInput, references: [{ path: 'keep.csv' }] })
    expect(await readdir(join(root, 'skills/personal/demo/references'))).toEqual(['keep.csv'])
  })

  it.each(['agent-home', 'zip', 'github'] as const)(
    'SK02 repairs a missing installed file when reimporting %s',
    async (source) => {
      const { root, repo } = await fixture()
      const home = join(root, 'external', 'demo')
      await mkdir(home, { recursive: true })
      await writeFile(join(home, 'SKILL.md'), document())
      await writeFile(join(home, 'data.csv'), 'a,b\n1,2\n')
      const bytes = zip({ 'demo/SKILL.md': document(), 'demo/data.csv': 'a,b\n1,2\n' })
      const identity = { source: 'agents' as const, slug: 'demo' }
      const importSkill = (): Promise<ImportOutcome> =>
        source === 'agent-home'
          ? repo.importAgentHomeSkill(home, identity)
          : source === 'zip'
            ? repo.importFromZip(bytes)
            : repo.importFromGitHub(
                'https://github.com/acme/skills/tree/main/demo',
                githubFetch('a'.repeat(40), 'original')
              )
      const first = await importSkill()
      expect(first).toEqual({ status: 'imported', id: 'imported-demo' })
      const installedFile = join(root, 'skills/imported/demo/data.csv')
      expect(await readFile(installedFile, 'utf8')).toBe('a,b\n1,2\n')
      expect((await importSkill()).status).toBe('unchanged')
      await rm(installedFile)
      if (source === 'agent-home') {
        const [match] = await repo.matchImportedAgentHomeSkills([
          { sourcePath: home, canonical: identity, aliases: [identity] }
        ])
        expect(match.identityImported).toBe(false)
      }
      const repaired = await importSkill()
      expect.soft(repaired).toEqual({ status: 'updated', id: first.id })
      await expect(readFile(installedFile, 'utf8')).resolves.toBe('a,b\n1,2\n')
    }
  )

  it.each(['foreign-id', 'personal-victim'])(
    'SK03 ordinary wrapped ZIP cannot adopt external installation ID %s',
    async (externalId) => {
      const { repo } = await fixture()
      const victim = await repo.createPersonal({ ...baseInput, name: 'victim' })
      const result = await repo
        .importFromZip(
          zip({
            'wrapped/SKILL.md': document('external'),
            'wrapped/.specialist-package.json': JSON.stringify({
              id: externalId,
              version: '1.0.0',
              contentHash: 'external',
              standalone: false,
              ownerIds: ['absent-owner']
            })
          })
        )
        .then(
          (outcome) => ({ outcome }),
          (error: unknown) => ({ error })
        )
      const catalog = await repo.list()
      expect(await repo.body(victim)).toContain('original')
      // Either rejecting reserved metadata or stripping it is acceptable; accepting its identity is not.
      expect.soft(catalog.filter((skill) => skill.id === victim)).toHaveLength(1)
      if ('outcome' in result) {
        expect.soft(catalog.find((skill) => skill.name === 'external')?.id).toBe(result.outcome.id)
        await expect(repo.delete(result.outcome.id)).resolves.toBeUndefined()
      } else expect(String(result.error)).toMatch(/reserved|metadata/i)
      expect(await repo.body(victim)).toContain('original')
    }
  )

  it('SK03 control: archive-root metadata is already filtered', async () => {
    const { repo } = await fixture()
    const result = await repo.importFromZip(
      zip({
        'SKILL.md': document('external'),
        '.specialist-package.json': JSON.stringify({
          id: 'foreign-id',
          version: '1',
          contentHash: 'external',
          standalone: false,
          ownerIds: ['absent-owner']
        })
      })
    )
    expect((await repo.list())[0].id).toBe(result.id)
    await expect(repo.delete(result.id)).resolves.toBeUndefined()
  })

  it('SK07 preserves local identity when the same GitHub source advances to another pinned commit', async () => {
    const { repo } = await fixture()
    const firstFetch = githubFetch('a'.repeat(40), 'revision A')
    const [firstCandidate] = await repo.scanRepo('acme/skills', firstFetch)
    expect(firstCandidate.url).toContain('a'.repeat(40))
    const first = await repo.importFromGitHub(firstCandidate.url, firstFetch)
    const secondFetch = githubFetch('b'.repeat(40), 'revision B')
    const [secondCandidate] = await repo.scanRepo('acme/skills', secondFetch)
    expect(secondCandidate.url).toContain('b'.repeat(40))
    const second = await repo.importFromGitHub(secondCandidate.url, secondFetch)
    expect.soft(second).toEqual({ status: 'updated', id: first.id })
    expect.soft(await repo.list()).toHaveLength(1)
    expect(await repo.body(first.id)).toContain('revision B')
  })

  it('SK07 does not label a same-named skill from another GitHub repository as already imported', async () => {
    const { repo } = await fixture()
    const fetch = githubFetch('a'.repeat(40), 'revision A')
    const [candidate] = await repo.scanRepo('acme/skills', fetch)
    await repo.importFromGitHub(candidate.url, fetch)
    const [other] = await repo.scanRepo('other/skills', fetch)
    expect(other.alreadyImported).toBe(false)
  })
})
