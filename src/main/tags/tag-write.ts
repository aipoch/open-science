import type { Prisma, Tag } from '@prisma/client'
import { TAG_NAME_MAX_LENGTH, type CreateTagRequest } from '../../shared/tags'

type TagWriter = Pick<Prisma.TransactionClient, 'tag'>

export const cleanTagName = (input: string): string =>
  input.normalize('NFKC').trim().replace(/\s+/gu, ' ')
export const tagNameKey = (name: string): string => cleanTagName(name).toLowerCase()

export function tagNameIdentity(input: string): { name: string; nameKey: string } {
  const name = cleanTagName(input)
  const nameKey = tagNameKey(name)
  if (!name) throw new Error('Tag name is required.')
  if (name.length > TAG_NAME_MAX_LENGTH || nameKey.length > TAG_NAME_MAX_LENGTH)
    throw new Error('Tag name is too long.')
  return { name, nameKey }
}

// Use the supplied client so imports can share their enclosing metadata transaction.
export async function createTag(client: TagWriter, request: CreateTagRequest): Promise<Tag> {
  const identity = tagNameIdentity(request.name)
  const last = await client.tag.findFirst({ orderBy: { sortOrder: 'desc' } })
  return client.tag.create({
    data: {
      ...identity,
      iconKey: request.iconKey,
      colorKey: request.colorKey,
      sortOrder: (last?.sortOrder ?? 0) + 1
    }
  })
}

export async function ensureTag(client: TagWriter, input: string): Promise<Tag> {
  const { name, nameKey } = tagNameIdentity(input)
  return (
    (await client.tag.findUnique({ where: { nameKey } })) ??
    createTag(client, { name, iconKey: 'tag', colorKey: 'gray' })
  )
}
