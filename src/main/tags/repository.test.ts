import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { TagRepository, cleanTagName, tagNameKey } from './repository'

describe('TagRepository', () => {
  let root: string
  let client: PrismaClient
  let repository: TagRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-tags-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new TagRepository(async () => client)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('seeds the protected Favorites Tag and keeps nameKey private', async () => {
    const snapshot = await repository.snapshot(0)

    expect(snapshot.tags).toEqual([
      expect.objectContaining({ id: 'tag-favorite', systemKey: 'favorite' })
    ])
    expect(snapshot.tags[0]).not.toHaveProperty('nameKey')
    await expect(repository.delete('tag-favorite')).rejects.toThrow(
      'System Tags cannot be deleted.'
    )
  })

  it('normalizes custom names for comparison while preserving cleaned display input', async () => {
    await repository.create({ name: '  Ｒesearch   Notes  ', iconKey: 'tag', colorKey: 'blue' })

    const snapshot = await repository.snapshot(1)
    expect(snapshot.tags).toContainEqual(
      expect.objectContaining({ name: 'Research Notes', iconKey: 'tag', colorKey: 'blue' })
    )
    await expect(
      repository.create({ name: 'research notes', iconKey: 'star', colorKey: 'amber' })
    ).rejects.toThrow('A Tag with this name already exists.')
  })

  it('appends new Tags and persists a validated global custom order', async () => {
    await repository.create({ name: 'Alpha', iconKey: 'tag', colorKey: 'blue' })
    await repository.create({ name: 'Beta', iconKey: 'bookmark', colorKey: 'green' })
    const before = await repository.snapshot(1)
    const custom = before.tags.filter((tag) => !('systemKey' in tag))

    expect(before.tags[0]).toMatchObject({ systemKey: 'favorite' })
    expect(custom.map((tag) => ('name' in tag ? tag.name : 'system'))).toEqual(['Alpha', 'Beta'])

    await repository.reorder({ tagIds: [custom[1]!.id, custom[0]!.id] })
    const after = await repository.snapshot(2)
    expect(after.tags[0]).toMatchObject({ systemKey: 'favorite' })
    expect(after.tags.slice(1).map((tag) => ('name' in tag ? tag.name : 'system'))).toEqual([
      'Beta',
      'Alpha'
    ])
    await expect(repository.reorder({ tagIds: [custom[0]!.id] })).rejects.toThrow(
      'Tag order must include every custom Tag exactly once.'
    )
    await expect(repository.reorder({ tagIds: [custom[0]!.id, 'tag-favorite'] })).rejects.toThrow(
      'Tag order must include every custom Tag exactly once.'
    )

    await repository.delete(custom[1]!.id)
    await expect(
      client.tag.findUniqueOrThrow({ where: { id: custom[0]!.id } })
    ).resolves.toMatchObject({ sortOrder: 1 })
  })

  it('rejects names whose normalized comparison key exceeds the storage limit', async () => {
    const expandingName = 'İ'.repeat(64)

    await expect(
      repository.create({ name: expandingName, iconKey: 'tag', colorKey: 'blue' })
    ).rejects.toThrow('Tag name is too long.')

    await repository.create({ name: 'Research', iconKey: 'tag', colorKey: 'blue' })
    const tag = (await repository.snapshot(0)).tags.find(
      (candidate) => 'name' in candidate && candidate.name === 'Research'
    )!
    await expect(
      repository.update({
        id: tag.id,
        name: expandingName,
        iconKey: 'tag',
        colorKey: 'blue',
        expectedUpdatedAt: tag.updatedAt
      })
    ).rejects.toThrow('Tag name is too long.')
  })

  it('rejects an update from a stale Tag snapshot without overwriting the winner', async () => {
    await repository.create({ name: 'Research', iconKey: 'tag', colorKey: 'blue' })
    const staleTag = (await repository.snapshot(0)).tags.find(
      (candidate) => 'name' in candidate && candidate.name === 'Research'
    )!

    repository = new TagRepository(
      async () => client,
      () => staleTag.updatedAt
    )
    await repository.update({
      id: staleTag.id,
      name: 'Current research',
      iconKey: 'book-open',
      colorKey: 'green',
      expectedUpdatedAt: staleTag.updatedAt
    })

    await expect(
      repository.update({
        id: staleTag.id,
        name: 'Research',
        iconKey: 'star',
        colorKey: 'amber',
        expectedUpdatedAt: staleTag.updatedAt
      })
    ).rejects.toThrow('Tag changed since it was loaded.')
    const currentTag = (await repository.snapshot(1)).tags.find(
      (candidate) => candidate.id === staleTag.id
    )!
    expect(currentTag).toEqual(
      expect.objectContaining({
        id: staleTag.id,
        name: 'Current research',
        iconKey: 'book-open',
        colorKey: 'green',
        updatedAt: staleTag.updatedAt + 1
      })
    )
  })

  it('rejects an out-of-range update timestamp with a domain error', async () => {
    await repository.create({ name: 'Research', iconKey: 'tag', colorKey: 'blue' })
    const tag = (await repository.snapshot(0)).tags.find(
      (candidate) => 'name' in candidate && candidate.name === 'Research'
    )!

    await expect(
      repository.update({
        id: tag.id,
        name: 'Updated research',
        iconKey: 'book-open',
        colorKey: 'green',
        expectedUpdatedAt: 8_640_000_000_000_001
      })
    ).rejects.toThrow('Tag update timestamp is invalid.')
  })

  it('stores many-to-many assignments and cascades custom Tag deletion', async () => {
    await repository.create({ name: 'Methods', iconKey: 'flask-conical', colorKey: 'green' })
    const tag = (await repository.snapshot(0)).tags.find(
      (candidate) => 'name' in candidate && candidate.name === 'Methods'
    )!
    await repository.setAssignment({
      tagId: tag.id,
      resourceType: 'catalog.skill',
      resourceId: 'analysis',
      assigned: true
    })
    await repository.setAssignment({
      tagId: tag.id,
      resourceType: 'catalog.connector',
      resourceId: 'pubmed',
      assigned: true
    })

    expect((await repository.snapshot(1)).assignments).toHaveLength(2)
    await repository.delete(tag.id)
    expect((await repository.snapshot(2)).assignments).toEqual([])
  })

  it('prunes assignments whose catalog resource disappeared', async () => {
    await repository.setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.specialist',
      resourceId: 'deleted-specialist',
      assigned: true
    })

    await expect(
      repository.pruneStaleAssignments({
        'catalog.skill': new Set(),
        'catalog.connector': new Set(),
        'catalog.specialist': new Set()
      })
    ).resolves.toBe(1)
    expect((await repository.snapshot(1)).assignments).toEqual([])
  })

  it('removes assignments at the resource deletion boundary', async () => {
    await repository.setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'deleted-skill',
      assigned: true
    })

    await expect(
      repository.removeResourceAssignments([
        { resourceType: 'catalog.skill', resourceId: 'deleted-skill' }
      ])
    ).resolves.toBe(1)
    expect((await repository.snapshot(1)).assignments).toEqual([])
  })

  it('uses NFKC and deterministic lowercase for the comparison key', () => {
    expect(cleanTagName('  Ａnalysis\tNotes ')).toBe('Analysis Notes')
    expect(tagNameKey('ＡNALYSIS')).toBe('analysis')
  })
})
