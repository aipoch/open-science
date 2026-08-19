import { Prisma, type PrismaClient, type Tag as PrismaTag } from '@prisma/client'

import {
  FAVORITE_TAG_ID,
  FAVORITE_TAG_SYSTEM_KEY,
  TAG_NAME_MAX_LENGTH,
  type CreateTagRequest,
  type SetTagAssignmentRequest,
  type TagColorKey,
  type TagIconKey,
  type TagAssignmentView,
  type TagResourceRef,
  type TagSnapshot,
  type TagView,
  type UpdateTagRequest
} from '../../shared/tags'
import type { TagResourceCatalogSnapshot } from './resource-catalog'

type TagClient = Pick<PrismaClient, 'tag' | 'tagAssignment'>
type TagClientProvider = () => Promise<TagClient>

const cleanTagName = (input: string): string => input.normalize('NFKC').trim().replace(/\s+/gu, ' ')

const tagNameKey = (name: string): string => cleanTagName(name).toLowerCase()

const toTagView = (row: PrismaTag): TagView => {
  const timestamps = { createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() }
  if (row.systemKey === FAVORITE_TAG_SYSTEM_KEY) {
    return { id: row.id, systemKey: FAVORITE_TAG_SYSTEM_KEY, ...timestamps }
  }
  if (!row.name || !row.iconKey || !row.colorKey) {
    throw new Error(`Tag ${row.id} has an invalid persisted shape.`)
  }
  return {
    id: row.id,
    name: row.name,
    iconKey: row.iconKey as TagIconKey,
    colorKey: row.colorKey as TagColorKey,
    ...timestamps
  }
}

const duplicateNameError = (error: unknown): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new Error('A Tag with this name already exists.')
  }
  throw error
}

class TagRepository {
  constructor(private readonly getClient: TagClientProvider) {}

  private async ensureFavorite(client: TagClient): Promise<void> {
    await client.tag.upsert({
      where: { systemKey: FAVORITE_TAG_SYSTEM_KEY },
      create: {
        id: FAVORITE_TAG_ID,
        systemKey: FAVORITE_TAG_SYSTEM_KEY,
        updatedAt: new Date()
      },
      update: {}
    })
  }

  async snapshot(revision: number): Promise<TagSnapshot> {
    const client = await this.getClient()
    await this.ensureFavorite(client)
    const [tags, assignments] = await Promise.all([
      client.tag.findMany({ orderBy: [{ systemKey: 'desc' }, { nameKey: 'asc' }, { id: 'asc' }] }),
      client.tagAssignment.findMany({
        orderBy: [{ createdAt: 'asc' }, { tagId: 'asc' }, { resourceType: 'asc' }]
      })
    ])
    return {
      revision,
      tags: tags.map(toTagView),
      assignments: assignments.map((row): TagAssignmentView => ({
        tagId: row.tagId,
        resourceType: row.resourceType as TagAssignmentView['resourceType'],
        resourceId: row.resourceId,
        createdAt: row.createdAt.getTime()
      }))
    }
  }

  async create(request: CreateTagRequest): Promise<void> {
    const name = cleanTagName(request.name)
    if (!name) throw new Error('Tag name is required.')
    if (name.length > TAG_NAME_MAX_LENGTH) throw new Error('Tag name is too long.')
    const nameKey = tagNameKey(name)
    if (nameKey.length > TAG_NAME_MAX_LENGTH) throw new Error('Tag name is too long.')
    try {
      const client = await this.getClient()
      await client.tag.create({
        data: {
          name,
          nameKey,
          iconKey: request.iconKey,
          colorKey: request.colorKey
        }
      })
    } catch (error) {
      duplicateNameError(error)
    }
  }

  async update(request: UpdateTagRequest): Promise<void> {
    const name = cleanTagName(request.name)
    if (!name) throw new Error('Tag name is required.')
    if (name.length > TAG_NAME_MAX_LENGTH) throw new Error('Tag name is too long.')
    const nameKey = tagNameKey(name)
    if (nameKey.length > TAG_NAME_MAX_LENGTH) throw new Error('Tag name is too long.')
    const client = await this.getClient()
    const current = await client.tag.findUnique({ where: { id: request.id } })
    if (!current) throw new Error('Tag not found.')
    if (current.systemKey) throw new Error('System Tags cannot be edited.')
    try {
      await client.tag.update({
        where: { id: request.id },
        data: {
          name,
          nameKey,
          iconKey: request.iconKey,
          colorKey: request.colorKey
        }
      })
    } catch (error) {
      duplicateNameError(error)
    }
  }

  async delete(id: string): Promise<void> {
    const client = await this.getClient()
    const current = await client.tag.findUnique({ where: { id } })
    if (!current) throw new Error('Tag not found.')
    if (current.systemKey) throw new Error('System Tags cannot be deleted.')
    await client.tag.delete({ where: { id } })
  }

  async setAssignment(request: SetTagAssignmentRequest): Promise<void> {
    const client = await this.getClient()
    const resourceId = request.resourceId.trim()
    if (request.assigned) {
      await client.tagAssignment.upsert({
        where: {
          tagId_resourceType_resourceId: {
            tagId: request.tagId,
            resourceType: request.resourceType,
            resourceId
          }
        },
        create: { tagId: request.tagId, resourceType: request.resourceType, resourceId },
        update: {}
      })
      return
    }
    await client.tagAssignment.deleteMany({
      where: { tagId: request.tagId, resourceType: request.resourceType, resourceId }
    })
  }

  async removeResourceAssignments(resources: readonly TagResourceRef[]): Promise<number> {
    if (resources.length === 0) return 0
    const client = await this.getClient()
    const result = await client.tagAssignment.deleteMany({
      where: {
        OR: resources.map(({ resourceType, resourceId }) => ({ resourceType, resourceId }))
      }
    })
    return result.count
  }

  async pruneStaleAssignments(resources: TagResourceCatalogSnapshot): Promise<number> {
    const client = await this.getClient()
    const assignments = await client.tagAssignment.findMany({
      select: { tagId: true, resourceType: true, resourceId: true }
    })
    const stale = assignments.filter((assignment) => {
      const ids = resources[assignment.resourceType as keyof TagResourceCatalogSnapshot]
      return !ids?.has(assignment.resourceId)
    })
    if (stale.length === 0) return 0
    const result = await client.tagAssignment.deleteMany({
      where: {
        OR: stale.map(({ tagId, resourceType, resourceId }) => ({
          tagId,
          resourceType,
          resourceId
        }))
      }
    })
    return result.count
  }
}

export { TagRepository, cleanTagName, tagNameKey }
