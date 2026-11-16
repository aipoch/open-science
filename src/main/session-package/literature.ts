import type { PersistedChatSession } from '../../shared/session-persistence'
import type { PackageLiteratureSource } from './literature-source'
import type { PackageLiterature } from './literature-contract'
import { packageLiteratureSchema } from './literature-contract'
import type { PackageRecords } from './records-contract'
import type { PersistedToolActivity } from '../../shared/session-message-contract'
import {
  collectLiteratureSourceCitationHrefs,
  createLiteratureSourceCitationHref,
  parseLiteratureSourceCitationHref,
  type LiteratureSourceCitation
} from '../../shared/literature-source-citation'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
export { packageLiteratureSchema, type PackageLiterature } from './literature-contract'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const citationActivity = (
  activity: PersistedToolActivity,
  prompts: ReadonlySet<string>
): boolean => {
  const name = activity.providerToolName ?? activity.title
  const identity = resolveCanonicalMcpToolIdentity(name, ['open-science-library']) ?? name
  return (
    activity.status === 'completed' &&
    !!activity.promptMessageId &&
    prompts.has(activity.promptMessageId) &&
    [
      'search_library',
      'search_library_full_text',
      'read_library_abstract',
      'read_library_pdf'
    ].some((tool) => identity === `open-science-library/${tool}`)
  )
}

// Only the first application presentation in a completed built-in tool can issue receipts.
// Preserve prose and unrelated tool payloads; their embedded URLs are not dependencies.
const visitCitationReceipts = (value: unknown, visit: (href: string) => string): unknown => {
  let found = false
  const walk = (entry: unknown, depth = 0): unknown => {
    if (depth > 8) return entry
    if (typeof entry === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(entry)
      } catch {
        return entry
      }
      const mapped = walk(parsed, depth + 1)
      return mapped === parsed ? entry : JSON.stringify(mapped)
    }
    if (Array.isArray(entry)) {
      const mapped = entry.map((child) => walk(child, depth + 1))
      return mapped.some((child, index) => child !== entry[index]) ? mapped : entry
    }
    if (!record(entry)) return entry
    let mapped = entry
    const set = (key: string, next: unknown): void => {
      if (next !== entry[key]) mapped = { ...mapped, [key]: next }
    }
    const presentation = entry.openScienceLiteraturePresentation
    if (!found && record(presentation)) {
      found = true
      const hrefs = collectLiteratureSourceCitationHrefs(presentation.sourceCitationHrefs)
      const next = hrefs.map(visit)
      if (next.some((href, index) => href !== hrefs[index]))
        set('openScienceLiteraturePresentation', { ...presentation, sourceCitationHrefs: next })
    }
    for (const key of ['structuredContent', 'result'])
      if (entry[key] !== undefined) set(key, walk(entry[key], depth + 1))
    if (Array.isArray(entry.content) || entry.type === 'content')
      set('content', walk(entry.content, depth + 1))
    if (entry.type === 'text') set('text', walk(entry.text, depth + 1))
    return mapped
  }
  return walk(value)
}

const sessionCitationActivities = (session: PersistedChatSession): PersistedToolActivity[] => {
  const messages = session.conversationGraph?.messages ?? session.messages
  const prompts = new Set(messages.filter((message) => message.role === 'user').map(({ id }) => id))
  return (session.conversationGraph?.activities ?? session.activities ?? []).filter((activity) =>
    citationActivity(activity, prompts)
  )
}

const sessionSourceCitations = (session: PersistedChatSession): LiteratureSourceCitation[] => {
  const citations = new Map<string, LiteratureSourceCitation>()
  for (const activity of sessionCitationActivities(session))
    visitCitationReceipts(activity.toolContent, (href) => {
      citations.set(href, parseLiteratureSourceCitationHref(href)!)
      return href
    })
  return [...citations.values()]
}

/** Rebind only issued display snapshots; short citation IDs and source text stay immutable. */
export const remapSessionLiteratureCitations = (
  session: PersistedChatSession,
  identities: Readonly<Record<string, string>>
): PersistedChatSession => {
  const activities = new Set(sessionCitationActivities(session).map(({ id }) => id))
  const replacements = new Map<string, string>()
  const remapActivity = <T extends PersistedToolActivity>(activity: T): T => {
    if (!activities.has(activity.id)) return activity
    const toolContent = visitCitationReceipts(activity.toolContent, (href) => {
      const citation = parseLiteratureSourceCitationHref(href)!
      const mapped = createLiteratureSourceCitationHref({
        ...citation,
        itemId: identities[citation.itemId] ?? citation.itemId,
        ...(citation.source
          ? {
              source: {
                ...citation.source,
                attachmentId:
                  identities[citation.source.attachmentId] ?? citation.source.attachmentId,
                versionId: identities[citation.source.versionId] ?? citation.source.versionId
              }
            }
          : {})
      })
      if (mapped !== href) replacements.set(href, mapped)
      return mapped
    }) as T['toolContent']
    return toolContent === activity.toolContent ? activity : { ...activity, toolContent }
  }
  const mappedActivities = session.activities?.map(remapActivity)
  const graphActivities = session.conversationGraph?.activities.map(remapActivity)
  const remapMessage = <T extends PersistedChatSession['messages'][number]>(message: T): T => {
    if (message.role !== 'agent' || !replacements.size) return message
    const rewrite = (text: string): string => {
      for (const [previous, next] of replacements) text = text.replaceAll(previous, next)
      return text
    }
    return {
      ...message,
      content: rewrite(message.content),
      ...(message.parts
        ? {
            parts: message.parts.map((part) =>
              part.type === 'text' ? { ...part, text: rewrite(part.text) } : part
            )
          }
        : {})
    }
  }
  return {
    ...session,
    ...(mappedActivities ? { activities: mappedActivities } : {}),
    messages: session.messages.map(remapMessage),
    ...(session.conversationGraph
      ? {
          conversationGraph: {
            ...session.conversationGraph,
            activities: graphActivities!,
            messages: session.conversationGraph.messages.map(remapMessage)
          }
        }
      : {})
  }
}

export const canonicalizeSessionLiteratureCitations = async (
  source: PackageLiteratureSource | undefined,
  session: PersistedChatSession
): Promise<PersistedChatSession> => {
  if (!source?.resolveItemId) return session
  const identities: Record<string, string> = {}
  const itemIds = new Set(
    sessionSourceCitations(session)
      .filter(({ source }) => source)
      .map(({ itemId }) => itemId)
  )
  for (const itemId of itemIds) {
    const current = await source.resolveItemId(itemId)
    if (current && current !== itemId) identities[itemId] = current
  }
  return Object.keys(identities).length
    ? remapSessionLiteratureCitations(session, identities)
    : session
}

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
  for (const citation of sessionSourceCitations(session))
    if (citation.source) versionIds.add(citation.source.versionId)
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
  source: PackageLiteratureSource | undefined,
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
  if (localVersionIds.length && !source) throw new Error('Literature source is unavailable.')
  const rows = localVersionIds.length ? await source!.readVersions(localVersionIds) : []
  if (
    rows.length !== localVersionIds.length ||
    new Set(rows.map(({ id }) => id)).size !== rows.length ||
    rows.some(({ id }) => !localVersionIds.includes(id))
  )
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
      records.tables.UploadVersion.some((version) => version.id === row.id) ||
      records.tables.ArtifactVersion.some((version) => version.id === row.id)
    )
      throw new Error('Literature PDF Version identity collides with file evidence.')
    if (!literature.items.some((item) => item.itemId === row.itemId)) {
      const view = await source!.readItem(row.itemId)
      if (!view || view.itemId !== row.itemId)
        throw new Error('Literature metadata is unavailable.')
      literature.items.push({
        itemId: view.itemId,
        metadataRevision: view.metadataRevision,
        item: view.item
      })
    }
    literature.attachments.push({
      versionId: row.id,
      attachmentId: row.attachmentId,
      itemId: row.itemId
    })
    const storageKey = `uploads/${session.projectId}/${session.id}/${row.attachmentId}/versions/${row.id}/content`
    sources.set(storageKey, row.storageKey)
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
  validatePackageLiteratureSession(
    records,
    await canonicalizeSessionLiteratureCitations(source, session)
  )
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
  const citations = sessionSourceCitations(session).filter((citation) => citation.source)
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
    if (hasFileReference || citations.length)
      throw new Error('Literature PDF reference has no packaged Version.')
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
  for (const citation of citations) {
    const source = citation.source!
    const entry = entries.get(source.versionId)
    const version = versions.get(source.versionId)
    if (
      !entry ||
      entry.itemId !== citation.itemId ||
      entry.attachmentId !== source.attachmentId ||
      version?.checksum !== source.checksum
    )
      throw new Error('Literature citation content identity mismatch.')
  }
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
