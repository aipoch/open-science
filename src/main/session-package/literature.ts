import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { literatureItemInputSchema } from '../../shared/literature'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { PackageRecords } from './native-snapshot'
import { LiteratureCatalog } from '../literature/catalog'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
export const packageLiteratureSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            itemId: identity,
            metadataRevision: z.number().int().positive(),
            item: literatureItemInputSchema
          })
          .strict()
      )
      .max(10000),
    attachments: z
      .array(z.object({ versionId: identity, attachmentId: identity, itemId: identity }).strict())
      .max(10000)
  })
  .strict()
export type PackageLiterature = z.infer<typeof packageLiteratureSchema>

// Capture explicit dependencies across every stored branch, never the whole Library or collection.
export const sessionLiteratureReferences = (
  session: PersistedChatSession
): {
  versionIds: Set<string>
  items: PackageLiterature['items']
} => {
  const versionIds = new Set<string>()
  const items = new Map<string, PackageLiterature['items'][number]>()
  const bindings = (
    values: Pick<NonNullable<typeof session.runtimeContext>, 'pdfContext'> | undefined
  ): void => {
    for (const binding of values?.pdfContext?.bindings ?? [])
      if (binding.sourceKind === 'literature-attachment-version')
        versionIds.add(binding.sourceVersionId)
  }
  bindings(session.runtimeContext)
  for (const message of session.conversationGraph?.messages ?? session.messages) {
    bindings(message)
    for (const part of message.parts ?? []) {
      if (part.type === 'literature') {
        // Message-local historical snapshots remain in session.json even if the same item has
        // several revisions. This index supplies the latest explicitly mentioned snapshot.
        const previous = items.get(part.itemId)
        if (!previous || previous.metadataRevision < part.metadataRevision)
          items.set(part.itemId, {
            itemId: part.itemId,
            metadataRevision: part.metadataRevision,
            item: part.item
          })
        if (part.attachmentVersionId) versionIds.add(part.attachmentVersionId)
      }
      if (part.type === 'artifact' && part.source === 'literature' && part.versionId)
        versionIds.add(part.versionId)
    }
    for (const annotation of message.annotations ?? [])
      if (
        (annotation.kind === 'pdf' || annotation.kind === 'image-point') &&
        annotation.source.kind === 'literature-attachment-version'
      )
        versionIds.add(annotation.source.versionId)
  }
  return { versionIds, items: [...items.values()] }
}

// Package-owned immutable copies reuse Upload storage/publication/deletion. The Literature
// section preserves their real source identity; no Library rows are installed on import.
export const capturePackageLiterature = async (
  client: PrismaClient,
  session: PersistedChatSession,
  records: PackageRecords,
  additionalVersionIds: readonly string[] = []
): Promise<Map<string, string>> => {
  const references = sessionLiteratureReferences(session)
  for (const id of additionalVersionIds) references.versionIds.add(id)
  const sources = new Map<string, string>()
  if (!references.versionIds.size && !references.items.length && !records.literature) return sources
  // Forks retain packaged Library metadata without installing it into the live Library.
  // Their PDF Versions already exist as native Upload rows and must not be queried as live attachments.
  const literature: PackageLiterature = {
    items: [
      ...new Map(
        [...(records.literature?.items ?? []), ...references.items].map((item) => [
          item.itemId,
          item
        ])
      ).values()
    ],
    attachments: [...(records.literature?.attachments ?? [])]
  }
  const localVersionIds = [...references.versionIds].filter(
    (id) => !literature.attachments.some((entry) => entry.versionId === id)
  )
  const catalog = new LiteratureCatalog(async () => client)
  const rows = await client.literatureAttachmentVersion.findMany({
    where: { id: { in: localVersionIds } },
    include: { attachment: { include: { item: true } }, contentBlob: true },
    orderBy: [{ attachmentId: 'asc' }, { versionNumber: 'asc' }]
  })
  if (rows.length !== localVersionIds.length)
    throw new Error('Literature PDF Version is unavailable.')
  if (
    rows.length &&
    !records.tables.FileOriginSession.some(
      (row) => row.projectId === session.projectId && row.sessionId === session.id
    )
  ) {
    records.tables.FileOriginSession.push({
      projectId: session.projectId,
      sessionId: session.id,
      titleSnapshot: session.title,
      state: 'active',
      deletedAt: null,
      deletionOperationId: null,
      retainedReviewIdsJson: null,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString()
    })
  }
  for (const row of rows) {
    if (
      row.attachment.item.deletedAt ||
      row.contentBlob.state !== 'available' ||
      row.contentType !== 'application/pdf' ||
      row.checksum !== row.contentBlob.checksum ||
      row.sizeBytes !== row.contentBlob.sizeBytes
    )
      throw new Error('Literature PDF content identity is invalid.')
    if (
      records.tables.UploadVersion.some((version) => version.id === row.id) ||
      records.tables.ArtifactVersion.some((version) => version.id === row.id)
    )
      throw new Error('Literature PDF Version identity collides with file evidence.')
    if (!literature.items.some((item) => item.itemId === row.attachment.itemId)) {
      const view = await catalog.get(row.attachment.itemId)
      if (!view || view.id !== row.attachment.itemId)
        throw new Error('Literature metadata is unavailable.')
      literature.items.push({
        itemId: view.id,
        metadataRevision: view.metadataRevision,
        item: view.item
      })
    }
    literature.attachments.push({
      versionId: row.id,
      attachmentId: row.attachmentId,
      itemId: row.attachment.itemId
    })
    const storageKey = `uploads/${session.projectId}/${session.id}/${row.attachmentId}/versions/${row.id}/content`
    sources.set(storageKey, row.contentBlob.storageKey)
    const timestamp = row.createdAt.toISOString()
    let file = records.tables.UploadFile.find((file) => file.id === row.attachmentId)
    if (
      file &&
      !literature.attachments.some(
        (entry) => entry.attachmentId === file!.id && entry.versionId !== row.id
      )
    )
      throw new Error('Literature Attachment identity collides with an Upload.')
    if (!file) {
      file = {
        id: row.attachmentId,
        projectId: session.projectId,
        sessionId: session.id,
        filename: row.filename,
        originalFilename: row.filename,
        currentVersionId: row.id,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      records.tables.UploadFile.push(file)
    }
    file.currentVersionId = row.id
    records.tables.UploadVersion.push({
      id: row.id,
      uploadFileId: row.attachmentId,
      versionNumber: row.versionNumber,
      state: 'ready',
      originKind: 'user_upload',
      basedOnVersionId: null,
      storageTag: null,
      storedFilename: null,
      writeOperationId: null,
      contentStorageKey: storageKey,
      filename: row.filename,
      originalFilename: row.filename,
      contentType: row.contentType,
      sizeBytes: String(row.sizeBytes),
      checksum: row.checksum,
      createdAt: timestamp,
      registeredAt: timestamp,
      updatedAt: timestamp
    })
  }
  records.literature = packageLiteratureSchema.parse(literature)
  validatePackageLiteratureSession(records, session)
  return sources
}

export const validatePackageLiterature = (records: PackageRecords): void => {
  if (!records.literature) return
  const literature = packageLiteratureSchema.parse(records.literature)
  const unique = (ids: string[]): boolean => new Set(ids).size === ids.length
  if (
    !unique(literature.items.map((item) => item.itemId)) ||
    !unique(literature.attachments.map((entry) => entry.versionId))
  )
    throw new Error('Duplicate Literature package identity.')
  for (const entry of literature.attachments) {
    const version = records.tables.UploadVersion.find((row) => row.id === entry.versionId)
    const file = records.tables.UploadFile.find((row) => row.id === entry.attachmentId)
    if (
      !version ||
      !file ||
      version.uploadFileId !== entry.attachmentId ||
      version.contentType !== 'application/pdf' ||
      version.state !== 'ready' ||
      !literature.items.some((item) => item.itemId === entry.itemId) ||
      version.contentStorageKey !==
        `uploads/${file.projectId}/${file.sessionId}/${file.id}/versions/${version.id}/content`
    )
      throw new Error('Literature package attachment ownership is invalid.')
  }
}

// Archive hashes prove bytes, not that a Session points at those bytes. Apply this contract
// on both export and import, including bindings retained on inactive conversation branches.
export const validatePackageLiteratureSession = (
  records: PackageRecords,
  session: PersistedChatSession
): void => {
  const messages = session.conversationGraph?.messages ?? session.messages
  if (!records.literature) {
    // Historical exporters retained attachment-bearing Literature mentions as metadata, but
    // could not export live Literature PDF bindings or file evidence. Preserve only that case.
    const hasFileReference =
      [session.runtimeContext, ...messages].some((context) =>
        context?.pdfContext?.bindings.some(
          (binding) => binding.sourceKind === 'literature-attachment-version'
        )
      ) ||
      messages.some(
        (message) =>
          message.parts?.some((part) => part.type === 'artifact' && part.source === 'literature') ||
          message.annotations?.some(
            (annotation) =>
              (annotation.kind === 'pdf' || annotation.kind === 'image-point') &&
              annotation.source.kind === 'literature-attachment-version'
          )
      )
    if (hasFileReference) throw new Error('Literature PDF reference has no packaged Version.')
    return
  }
  const references = sessionLiteratureReferences(session)
  const entries = new Map(records.literature?.attachments.map((entry) => [entry.versionId, entry]))
  const versions = new Map(records.tables.UploadVersion.map((version) => [version.id, version]))
  for (const versionId of references.versionIds)
    if (!entries.has(versionId))
      throw new Error('Literature PDF reference has no packaged Version.')
  for (const item of references.items)
    if (!records.literature.items.some((entry) => entry.itemId === item.itemId))
      throw new Error('Literature reference metadata is missing.')
  for (const context of [session.runtimeContext, ...messages])
    for (const binding of context?.pdfContext?.bindings ?? []) {
      if (binding.sourceKind !== 'literature-attachment-version') continue
      const entry = entries.get(binding.sourceVersionId),
        version = versions.get(binding.sourceVersionId)
      if (
        !entry ||
        !version ||
        binding.sourceFileId !== entry.attachmentId ||
        binding.checksum !== version.checksum ||
        binding.sizeBytes !== Number(version.sizeBytes)
      )
        throw new Error('Literature PDF binding identity mismatch.')
    }
  for (const message of messages) {
    for (const part of message.parts ?? [])
      if (
        part.type === 'literature' &&
        part.attachmentVersionId &&
        entries.get(part.attachmentVersionId)?.itemId !== part.itemId
      )
        throw new Error('Literature reference attachment ownership mismatch.')
    for (const annotation of message.annotations ?? [])
      if (
        (annotation.kind === 'pdf' || annotation.kind === 'image-point') &&
        annotation.source.kind === 'literature-attachment-version' &&
        versions.get(annotation.source.versionId)?.checksum !== annotation.source.checksum
      )
        throw new Error('Literature annotation content identity mismatch.')
  }
}
