import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

export const TAG_NAME_MAX_LENGTH = 64
export const TAG_RESOURCE_ID_MAX_LENGTH = 256
export const FAVORITE_TAG_SYSTEM_KEY = 'favorite' as const
export const FAVORITE_TAG_ID = 'tag-favorite' as const

export const TAG_RESOURCE_TYPES = [
  'catalog.skill',
  'catalog.connector',
  'catalog.specialist'
] as const
export const TAG_ICON_KEYS = [
  'tag',
  'star',
  'bookmark',
  'flask-conical',
  'book-open',
  'database',
  'code-2',
  'bot'
] as const
export const TAG_COLOR_KEYS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'blue',
  'purple',
  'pink'
] as const

export const tagResourceTypeSchema = z.enum(TAG_RESOURCE_TYPES)
export const tagIconKeySchema = z.enum(TAG_ICON_KEYS)
export const tagColorKeySchema = z.enum(TAG_COLOR_KEYS)

const tagSystemViewSchema = z
  .object({
    id: z.string().min(1),
    systemKey: z.literal(FAVORITE_TAG_SYSTEM_KEY),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .strict()

const tagCustomViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(TAG_NAME_MAX_LENGTH),
    iconKey: tagIconKeySchema,
    colorKey: tagColorKeySchema,
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .strict()

export const tagViewSchema = z.union([tagSystemViewSchema, tagCustomViewSchema])
export const tagResourceRefSchema = z
  .object({
    resourceType: tagResourceTypeSchema,
    resourceId: z.string().trim().min(1).max(TAG_RESOURCE_ID_MAX_LENGTH)
  })
  .strict()
export const tagAssignmentViewSchema = tagResourceRefSchema
  .extend({
    tagId: z.string().min(1),
    createdAt: z.number().finite()
  })
  .strict()
export const tagSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tags: z.array(tagViewSchema),
    assignments: z.array(tagAssignmentViewSchema)
  })
  .strict()

export const createTagRequestSchema = z
  .object({
    name: z.string().max(TAG_NAME_MAX_LENGTH),
    iconKey: tagIconKeySchema,
    colorKey: tagColorKeySchema
  })
  .strict()
export const updateTagRequestSchema = createTagRequestSchema
  .extend({ id: z.string().min(1) })
  .strict()
export const deleteTagRequestSchema = z.object({ id: z.string().min(1) }).strict()
export const setTagAssignmentRequestSchema = tagResourceRefSchema
  .extend({ tagId: z.string().min(1), assigned: z.boolean() })
  .strict()
export const reorderTagsRequestSchema = z.object({ tagIds: z.array(z.string().min(1)) }).strict()

export type TagResourceType = z.infer<typeof tagResourceTypeSchema>
export type TagIconKey = z.infer<typeof tagIconKeySchema>
export type TagColorKey = z.infer<typeof tagColorKeySchema>
export type TagView = z.infer<typeof tagViewSchema>
export type TagResourceRef = z.infer<typeof tagResourceRefSchema>
export type TagAssignmentView = z.infer<typeof tagAssignmentViewSchema>
export type TagSnapshot = z.infer<typeof tagSnapshotSchema>
export type CreateTagRequest = z.infer<typeof createTagRequestSchema>
export type UpdateTagRequest = z.infer<typeof updateTagRequestSchema>
export type DeleteTagRequest = z.infer<typeof deleteTagRequestSchema>
export type SetTagAssignmentRequest = z.infer<typeof setTagAssignmentRequestSchema>
export type ReorderTagsRequest = z.infer<typeof reorderTagsRequestSchema>
export type TagsChangedEvent = Readonly<{ revision: number }>

export const tagApplicationCommandContracts = Object.freeze({
  snapshot: defineApplicationCommandContract(
    validationCodec(z.tuple([])),
    validationCodec(tagSnapshotSchema)
  ),
  create: defineApplicationCommandContract(
    validationCodec(z.tuple([createTagRequestSchema])),
    validationCodec(tagSnapshotSchema)
  ),
  update: defineApplicationCommandContract(
    validationCodec(z.tuple([updateTagRequestSchema])),
    validationCodec(tagSnapshotSchema)
  ),
  delete: defineApplicationCommandContract(
    validationCodec(z.tuple([deleteTagRequestSchema])),
    validationCodec(tagSnapshotSchema)
  ),
  reorder: defineApplicationCommandContract(
    validationCodec(z.tuple([reorderTagsRequestSchema])),
    validationCodec(tagSnapshotSchema)
  ),
  setAssignment: defineApplicationCommandContract(
    validationCodec(z.tuple([setTagAssignmentRequestSchema])),
    validationCodec(tagSnapshotSchema)
  )
})
