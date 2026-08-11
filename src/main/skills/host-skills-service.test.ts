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
  catalog: HostSkillsCatalog
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
  it('validates a draft through the same frontmatter contract used by publish', async () => {
    const { service } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'analysis-helper',
        path: 'SKILL.md',
        content: '---\nname: analysis-helper\ndescription: Analyze data.\n---\nBody.\n'
      }
    })

    await expect(
      service.dispatch({ op: 'validate', params: { name: 'analysis-helper' } })
    ).resolves.toEqual({ valid: true, name: 'analysis-helper', origin: 'draft' })
  })

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
    await expect(
      readFile(join(root, 'skills', 'drafts', 'analysis-helper', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
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
    ).rejects.toThrow('host.skills.edit: unsafe path')

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

  it('serializes publish and delete across the complete draft mutation', async () => {
    const { service, catalog } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'concurrent',
        path: 'SKILL.md',
        content: '---\nname: concurrent\ndescription: Concurrent draft.\n---\nBody.\n'
      }
    })

    const publishDirectory = catalog.publishPersonalDirectory
    let releasePublish!: () => void
    let publishStarted!: () => void
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const started = new Promise<void>((resolve) => {
      publishStarted = resolve
    })
    catalog.publishPersonalDirectory = async (...args) => {
      publishStarted()
      await publishGate
      return publishDirectory(...args)
    }

    const publishing = service.dispatch({ op: 'publish', params: { name: 'concurrent' } })
    await started
    let deleteSettled = false
    const deleting = service.dispatch({ op: 'delete', params: { name: 'draft-concurrent' } })
    void deleting.then(
      () => {
        deleteSettled = true
      },
      () => {
        deleteSettled = true
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    const deleteWaitedForPublish = !deleteSettled
    releasePublish()
    const results = await Promise.allSettled([publishing, deleting])

    expect(deleteWaitedForPublish).toBe(true)
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('Unknown draft') })
    })
  })

  it('rejects extra SKILL.md frontmatter fields before publish', async () => {
    const { service, userSkills } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'extra-metadata',
        path: 'SKILL.md',
        content:
          '---\nname: extra-metadata\ndescription: Invalid extra metadata.\nlicense: MIT\n---\nBody.\n'
      }
    })

    await expect(
      service.dispatch({ op: 'publish', params: { name: 'extra-metadata' } })
    ).rejects.toThrow('frontmatter must contain exactly name and description')
    expect(await userSkills.list()).toHaveLength(0)
  })

  it('deletes an explicit draft without deleting its published Personal Skill', async () => {
    const { service, root, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'Disposable',
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

  it('edits a draft by the stable id returned from list', async () => {
    const { service, userSkills } = await makeFixture()
    await userSkills.createPersonal({
      name: 'Editable',
      description: 'Edit me.',
      body: 'Published body.'
    })
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'personal-editable',
        path: 'SKILL.md',
        old_string: 'Published body.',
        content: 'Draft body.'
      }
    })
    const drafts = (await service.dispatch({ op: 'list' })) as Array<{
      id: string
      origin: string
    }>
    const draftId = drafts.find(({ origin }) => origin === 'draft')?.id

    await service.dispatch({
      op: 'edit',
      params: {
        name: draftId,
        path: 'SKILL.md',
        old_string: 'Draft body.',
        content: 'Second draft.'
      }
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'draft-editable' } })
    ).resolves.toMatchObject({ content: expect.stringContaining('Second draft.') })
  })

  it('allows a new Skill slug to start with the draft prefix', async () => {
    const { service } = await makeFixture()

    await expect(
      service.dispatch({
        op: 'edit',
        params: {
          name: 'draft-review',
          path: 'SKILL.md',
          content: '---\nname: draft-review\ndescription: Review drafts.\n---\nBody.\n'
        }
      })
    ).resolves.toMatchObject({ status: 'edited', name: 'draft-review' })
    await expect(service.dispatch({ op: 'list' })).resolves.toContainEqual(
      expect.objectContaining({ id: 'draft-draft-review', name: 'draft-review' })
    )
  })

  it('resolves an exact published stable id before colliding public slugs', async () => {
    const { service, userSkills } = await makeFixture()
    await userSkills.createPersonal({ name: 'Foo', description: 'Exact id.', body: 'Exact body.' })
    await userSkills.createPersonal({
      name: 'Personal Foo',
      description: 'Colliding slug.',
      body: 'Collision body.'
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'personal-foo' } })
    ).resolves.toMatchObject({ name: 'Foo', content: expect.stringContaining('Exact body.') })
  })

  it('rejects an unqualified delete when a published display name matches a draft slug', async () => {
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

  it('rejects reserved Skill slugs before creating a draft', async () => {
    const { service } = await makeFixture()

    for (const name of ['os-review', 'mcp-review']) {
      await expect(
        service.dispatch({
          op: 'edit',
          params: {
            name,
            path: 'SKILL.md',
            content: `---\nname: ${name}\ndescription: Reserved.\n---\nBody.\n`
          }
        })
      ).rejects.toThrow('os- or mcp-')
    }
    await expect(service.dispatch({ op: 'list' })).resolves.toHaveLength(1)
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
