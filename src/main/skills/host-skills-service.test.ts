import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BundledSkill } from './registry'
import { HostSkillsService, type HostSkillsCatalog } from './host-skills-service'
import { UserSkillRepository } from './user-skill-repository'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const makeFixture = async (): Promise<{
  service: HostSkillsService
  root: string
  userSkills: UserSkillRepository
  approveDelete: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'host-skills-'))
  roots.push(root)
  const featuredDir = join(root, 'featured', 'literature-review')
  await mkdir(featuredDir, { recursive: true })
  await writeFile(
    join(featuredDir, 'SKILL.md'),
    '---\nname: literature-review\ndescription: Review literature.\n---\nFeatured body.\n'
  )
  const featured: BundledSkill = {
    id: 'literature-review',
    name: 'literature-review',
    description: 'Review literature.',
    source: 'featured',
    updatedAt: '2026-08-09',
    sourceDir: featuredDir
  }
  const userSkills = new UserSkillRepository(root)
  const catalog: HostSkillsCatalog = {
    list: async () => [featured, ...(await userSkills.list())],
    withSkillRead: async (id, read) => {
      if (id === featured.id) return read(featured)
      return userSkills.withSkillReadLock(id, read)
    },
    publishPersonalDirectory: (slug, sourcePath, overwrite) =>
      userSkills.publishPersonalDirectory(slug, sourcePath, overwrite),
    deletePublished: (id) => userSkills.delete(id)
  }
  const approveDelete = vi.fn(async () => true)
  const reload = vi.fn()
  return {
    root,
    userSkills,
    approveDelete,
    reload,
    service: new HostSkillsService({
      storageRoot: root,
      catalog,
      approveDelete,
      onPublishedSkillsChanged: reload
    })
  }
}

describe('HostSkillsService', () => {
  it('creates a draft with exact create/replace semantics, publishes it, and reads it back', async () => {
    const { service, root, reload } = await makeFixture()
    const manifest =
      '---\nname: analysis-helper\ndescription: Analyze a dataset.\n---\nUse the script.\n'

    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'analysis-helper', path: 'SKILL.md', content: manifest }
      })
    ).resolves.toMatchObject({ status: 'edited', name: 'analysis-helper', origin: 'draft' })
    await service.dispatch({
      op: 'edit',
      params: { name: 'analysis-helper', path: 'scripts/run.js', content: 'console.log("v1")\n' }
    })
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'analysis-helper', path: 'SKILL.md', content: 'replacement' }
      })
    ).rejects.toThrow('already exists')
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'analysis-helper',
        path: 'scripts/run.js',
        old_string: 'v1',
        content: 'v2'
      }
    })

    await expect(
      service.dispatch({ op: 'publish', params: { name: 'analysis-helper' } })
    ).resolves.toEqual({
      status: 'published',
      id: 'personal-analysis-helper',
      name: 'analysis-helper',
      origin: 'personal'
    })
    await expect(
      service.dispatch({
        op: 'read',
        params: { name: 'personal-analysis-helper', path: 'scripts/run.js' }
      })
    ).resolves.toEqual({
      name: 'analysis-helper',
      path: 'scripts/run.js',
      content: 'console.log("v2")\n',
      origin: 'personal'
    })
    await expect(readFile(join(root, 'skills', 'drafts', 'analysis-helper', 'SKILL.md'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('lists drafts and installed Skills without exposing host paths', async () => {
    const { service } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'new-skill',
        path: 'SKILL.md',
        content: '---\nname: new-skill\ndescription: New skill.\n---\nBody.\n'
      }
    })

    const result = await service.dispatch({ op: 'list' })
    expect(result).toEqual([
      {
        id: 'literature-review',
        name: 'literature-review',
        description: 'Review literature.',
        origin: 'featured',
        editable: false
      },
      {
        id: 'draft-new-skill',
        name: 'new-skill',
        description: 'New skill.',
        origin: 'draft',
        editable: true
      }
    ])
    expect(JSON.stringify(result)).not.toContain('/tmp/')
  })

  it('rejects path traversal and ambiguous or non-unique replacements', async () => {
    const { service } = await makeFixture()
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'bad', path: '../outside', content: 'x' }
      })
    ).rejects.toThrow('unsafe path')

    await service.dispatch({
      op: 'edit',
      params: { name: 'bad', path: 'SKILL.md', content: 'same same' }
    })
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'bad', path: 'SKILL.md', old_string: 'same', content: 'new' }
      })
    ).rejects.toThrow('exactly once')
  })

  it('requires approval for delete and reports a decline as a normal result', async () => {
    const { service, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'Disposable',
      description: 'Delete me.',
      body: 'Body.'
    })
    approveDelete.mockResolvedValueOnce(false)

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'personal-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'declined', operation: 'delete' })
    expect(await userSkills.list()).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'personal-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'deleted', operation: 'delete', name: 'Disposable' })
    expect(await userSkills.list()).toHaveLength(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
