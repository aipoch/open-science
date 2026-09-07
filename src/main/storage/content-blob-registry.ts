import type { Prisma } from '@prisma/client'

type ContentBlobRegistration = {
  id: string
  storageKey: string
  checksum: string
  sizeBytes: bigint
  contentType?: string | null
  state?: 'staging' | 'available'
  createdAt?: Date
  verifiedAt?: Date
}

type ContentBlobIdentity = Pick<
  ContentBlobRegistration,
  'id' | 'storageKey' | 'checksum' | 'sizeBytes'
>

const contentBlobIdForVersion = (
  ownerKind: 'upload-version' | 'artifact-version' | 'literature-attachment-version',
  versionId: string
): string => `${ownerKind}:${versionId}`

const assertMatchingContent = (
  existing: {
    id: string
    storageKey: string
    checksum: string
    sizeBytes: bigint
    contentType: string | null
  },
  input: ContentBlobRegistration
): void => {
  if (
    existing.id !== input.id ||
    existing.storageKey !== input.storageKey ||
    existing.checksum !== input.checksum ||
    existing.sizeBytes !== input.sizeBytes ||
    existing.contentType !== (input.contentType ?? null)
  ) {
    throw new Error(`Content blob identity conflicts with immutable bytes: ${input.storageKey}`)
  }
}

const registerContentBlob = async (
  transaction: Prisma.TransactionClient,
  input: ContentBlobRegistration
): Promise<void> => {
  const existing = await transaction.contentBlob.findFirst({
    where: { OR: [{ id: input.id }, { storageKey: input.storageKey }] }
  })
  if (existing) {
    assertMatchingContent(existing, input)
    if (existing.state === 'quarantined') {
      throw new Error(`Quarantined content blob cannot acquire a new owner: ${existing.id}`)
    }
    return
  }
  await transaction.contentBlob.create({
    data: {
      id: input.id,
      storageKey: input.storageKey,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      state: input.state ?? 'staging',
      createdAt: input.createdAt,
      verifiedAt: input.verifiedAt
    }
  })
}

const markContentBlobAvailable = async (
  transaction: Prisma.TransactionClient,
  input: ContentBlobIdentity,
  verifiedAt = new Date()
): Promise<void> => {
  const existing = await transaction.contentBlob.findUnique({ where: { id: input.id } })
  if (!existing) throw new Error(`Content blob authority is missing: ${input.id}`)
  assertMatchingContent(existing, { ...input, contentType: existing.contentType })
  if (existing.state === 'quarantined') {
    throw new Error(`Quarantined content blob cannot be published: ${input.id}`)
  }
  await transaction.contentBlob.update({
    where: { id: input.id },
    data: { state: 'available', verifiedAt }
  })
}

const deleteStagingContentBlob = async (
  transaction: Prisma.TransactionClient,
  id: string
): Promise<void> => {
  await transaction.contentBlob.deleteMany({ where: { id, state: 'staging' } })
}

export {
  contentBlobIdForVersion,
  deleteStagingContentBlob,
  markContentBlobAvailable,
  registerContentBlob
}
export type { ContentBlobIdentity, ContentBlobRegistration }
