import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BundledSkill } from '@aipoch/skills'
import { HostSkillsService } from './host-skills-service'
import type { SkillAuthoringCatalog } from '@aipoch/skills'
import { UserSkillRepository } from '@aipoch/skills'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const makeFixture = async (): Promise<{
  service: HostSkillsService
  root: string
  userSkills: UserSkillRepository
  catalog: SkillAuthoringCatalog
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
    displayName: 'Literature Review',
    description: 'Review literature.',
    source: 'featured',
    updatedAt: '2026-08-09',
    sourceDir: featuredDir
  }
  const userSkills = new UserSkillRepository(root)
  const catalog: SkillAuthoringCatalog = {
    list: async () => [featured, ...(await userSkills.list())],
    withSkillRead: async (id, read) => {
      if (id === featured.id) return read(featured)
      return userSkills.withSkillReadLock(id, read)
    },
    publishPersonalDirectory: (name, sourcePath, overwrite) =>
      userSkills.publishPersonalDirectory(name, sourcePath, overwrite),
    deletePublished: (id) => userSkills.delete(id)
  }
  const approveDelete = vi.fn(async () => true)
  const reload = vi.fn()
  return {
    root,
    userSkills,
    catalog,
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
  it.each(['catalog-refresh'] as const)(
    'reports committed publication after %s fails',
    async (phase) => {
      const { service, reload, userSkills } = await makeFixture()
      await service.dispatch({
        op: 'edit',
        params: {
          name: 'committed',
          path: 'SKILL.md',
          content: '---\nname: committed\ndescription: Test skill.\n---\nInstructions.'
        }
      })
      reload.mockRejectedValueOnce(new Error('refresh failed'))
      await expect(
        service.dispatch({ op: 'publish', params: { name: 'committed' } })
      ).rejects.toThrow(/was published.*failed/)
      const installed = (await userSkills.list()).find((skill) => skill.name === 'committed')!
      expect(installed).toBeDefined()
      await expect(
        service.dispatch({ op: 'read', params: { name: installed.id } })
      ).resolves.toMatchObject({ origin: 'personal' })
      expect(reload).toHaveBeenCalledTimes(phase === 'catalog-refresh' ? 1 : 0)
    }
  )
  it('reports committed deletion when catalog refresh fails', async () => {
    const { service, reload, userSkills } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'committed',
        path: 'SKILL.md',
        content: '---\nname: committed\ndescription: Test skill.\n---\nInstructions.'
      }
    })
    await service.dispatch({ op: 'publish', params: { name: 'committed' } })
    const id = (await userSkills.list()).find((skill) => skill.name === 'committed')!.id
    reload.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(service.dispatch({ op: 'delete', params: { name: id } })).rejects.toThrow(
      `Skill "${id}" was deleted, but catalog refresh failed`
    )
    expect(await userSkills.list()).toEqual([])
  })
  it('creates a draft with exact create/replace semantics, publishes it, and reads it back', async () => {
    const { service, root, userSkills, reload } = await makeFixture()
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

    const draftSkillDocument = join(root, 'skills', 'drafts', 'analysis-helper', 'SKILL.md')
    reload.mockImplementationOnce(async () => {
      await expect(userSkills.list()).resolves.toContainEqual(
        expect.objectContaining({ id: 'personal-analysis-helper' })
      )
      await expect(readFile(draftSkillDocument)).rejects.toMatchObject({ code: 'ENOENT' })
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
    await expect(readFile(draftSkillDocument)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('deletes an explicit draft without deleting its published Personal Skill', async () => {
    const { service, root, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'disposable',
      description: 'Delete me.',
      body: 'Published body.'
    })
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'personal-disposable',
        path: 'SKILL.md',
        old_string: 'Published body.',
        content: 'Draft body.'
      }
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'draft-disposable' } })
    ).resolves.toMatchObject({ name: 'disposable', origin: 'draft' })
    await expect(
      service.dispatch({ op: 'delete', params: { name: 'disposable' } }, { sessionId: 'session-1' })
    ).rejects.toThrow('ambiguous')
    expect(approveDelete).not.toHaveBeenCalled()
    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'draft-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'deleted', operation: 'delete', name: 'disposable' })

    expect(approveDelete).toHaveBeenCalledWith(
      { name: 'disposable', origin: 'draft' },
      { sessionId: 'session-1' }
    )
    expect(await userSkills.list()).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    await expect(
      readFile(join(root, 'skills', 'drafts', 'disposable', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects an unqualified delete when a published display name matches a draft name', async () => {
    const { service, catalog, root, approveDelete } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'shared-name',
        path: 'SKILL.md',
        content: '---\nname: shared-name\ndescription: Draft.\n---\nDraft body.\n'
      }
    })
    const listPublished = catalog.list
    catalog.list = async () => [
      ...(await listPublished()),
      {
        id: 'custom-package-id',
        name: 'shared-name',
        displayName: 'Shared name',
        description: 'Published alias.',
        source: 'imported',
        updatedAt: '2026-08-09',
        sourceDir: root
      }
    ]

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'shared-name' } },
        { sessionId: 'session-1' }
      )
    ).rejects.toThrow('ambiguous')
    expect(approveDelete).not.toHaveBeenCalled()
  })
  it('requires approval for delete and reports a decline as a normal result', async () => {
    const { service, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'disposable',
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

    reload.mockImplementationOnce(async () => {
      await expect(userSkills.list()).resolves.toHaveLength(0)
    })
    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'personal-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'deleted', operation: 'delete', name: 'disposable' })
    expect(await userSkills.list()).toHaveLength(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
