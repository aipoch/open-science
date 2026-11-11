import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { z } from 'zod'
import { type LiteratureDuplicatePolicy } from '@aipoch/literature-library/contracts'
import {
  literatureIssuedYear,
  LITERATURE_ITEM_TYPES,
  type LiteratureItemType
} from '@aipoch/literature-citations/contracts'
import {
  collectorRequestSchema,
  collectedReferenceSchema,
  ZOTERO_COLLECTION_CONFLICT,
  ZOTERO_CONNECTION_FAILED,
  ZOTERO_PREVIEW_CHANGED,
  ZOTERO_REQUEST_TIMED_OUT,
  ZOTERO_LOCAL_API_DISABLED,
  ZOTERO_TAG_LIMIT,
  type CollectedReference,
  type CollectorRequest,
  type CollectorResult
} from '../../shared/literature-collector'
import { normalizeLiteratureSearchTextV1 } from '../../shared/literature-search-text'
import type { LiteratureCatalog, CollectedReferenceInspection } from './catalog'
import type { ContentRepository } from '../storage/content-repository'
import { attachLiteraturePdf } from './pdf-attachment'

const keySchema = z.string().regex(/^[A-Z0-9]{8}$/)
const itemSchema = z.object({ key: keySchema, data: z.record(z.string(), z.unknown()) })
type ZoteroItem = z.infer<typeof itemSchema>
type Entry = { key: string; reference: CollectedReference; pdfKeys: string[] }
type Snapshot = {
  expires: number
  entries: Entry[]
  failures: CollectorResult['failures']
  server: string
  collectionPaths: string[][]
  reviews: CollectedReferenceInspection[]
  policies: LiteratureDuplicatePolicy[]
  busy?: boolean
  committed?: {
    keys: string[]
    itemIds: string[]
    metadataRevisions: number[]
    completedPdfs: Set<string>
  }
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const isTimeout = (error: unknown): boolean =>
  error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
const emptyResult = (): CollectorResult => ({
  entries: [],
  savedItemIds: [],
  failures: [],
  pdfCount: 0
})

// Never accept a URL, filesystem path, or redirect target from the renderer.
export class LiteratureCollector {
  private snapshots = new Map<string, Snapshot>()
  constructor(
    private readonly options: {
      catalog: Pick<
        LiteratureCatalog,
        'collectReferences' | 'inspectCollectedReferences' | 'attachContent'
      >
      content: Pick<ContentRepository, 'withPublishedContent' | 'sweep' | 'verify'>
      fetch?: typeof fetch
      now?: () => number
    }
  ) {}

  private async request(path: string, server?: string, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted()
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`http://127.0.0.1:23119/api/users/0/${path}`, {
        headers: { 'Zotero-API-Version': '3', ...(server ? { 'Zotero-Server-ID': server } : {}) },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000)
      })
    } catch (cause) {
      signal?.throwIfAborted()
      throw new Error(isTimeout(cause) ? ZOTERO_REQUEST_TIMED_OUT : ZOTERO_CONNECTION_FAILED, {
        cause
      })
    }
    if (signal?.aborted) {
      await response.body?.cancel().catch(() => undefined)
      signal.throwIfAborted()
    }
    if (response.status === 403) throw new Error(ZOTERO_LOCAL_API_DISABLED)
    if (!response.ok)
      throw new Error(
        `Zotero request failed (${response.status}). Enable the local API in Zotero Settings → Advanced.`
      )
    return response
  }

  private async body(
    response: Response,
    maxBytes = 16 * 1024 * 1024,
    signal?: AbortSignal
  ): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Zotero returned an empty response.')
    const chunks: Uint8Array[] = []
    let size = 0
    const cancel = (): void => {
      void reader.cancel(signal?.reason).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      while (true) {
        const { value, done } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > maxBytes)
          throw new Error('Zotero response is too large. Select a smaller collection.')
        chunks.push(value)
      }
    } catch (cause) {
      signal?.throwIfAborted()
      if (isTimeout(cause)) throw new Error(ZOTERO_REQUEST_TIMED_OUT, { cause })
      throw cause
    } finally {
      signal?.removeEventListener('abort', cancel)
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async preview(
    request: Extract<CollectorRequest, { kind: 'zotero-preview' | 'zotero-collections' }>,
    signal?: AbortSignal
  ): Promise<CollectorResult> {
    const collectionKey = request.kind === 'zotero-preview' ? request.collectionKey : undefined
    let responseBytes = 0
    let version: string | null | undefined
    let server: string | null | undefined
    const read = async (path: string): Promise<ZoteroItem[]> => {
      const response = await this.request(`${path}?format=json`, server ?? undefined, signal)
      const nextVersion = response.headers.get('Last-Modified-Version')
      const nextServer = response.headers.get('Zotero-Server-ID')
      if (!nextServer || !nextVersion || !/^\d+$/.test(nextVersion)) {
        throw new Error('Consistent import requires Zotero 10 or later with its local API enabled.')
      }
      if (
        (version !== undefined && version !== nextVersion) ||
        (server !== undefined && server !== nextServer)
      ) {
        throw new Error('Zotero library changed while reading. Preview again.')
      }
      version = nextVersion
      server = nextServer
      const body = await this.body(response, undefined, signal)
      responseBytes += Buffer.byteLength(body)
      if (responseBytes > 16 * 1024 * 1024)
        throw new Error('Zotero selection is too large. Select a smaller collection.')
      return z.array(itemSchema).max(5000).parse(JSON.parse(body))
    }
    const collections = await read('collections')
    const byKey = new Map(collections.map((entry) => [entry.key, entry.data]))
    const collectionOwners = new Map<string, string>()
    const collectionPath = (key: string): string[] => {
      const seen = new Set<string>()
      const path: string[] = []
      const sourceKeys: string[] = []
      while (key) {
        if (seen.has(key) || seen.size >= 20)
          throw new Error('Zotero collection hierarchy is invalid.')
        seen.add(key)
        const data = byKey.get(key)
        if (!data) throw new Error('Zotero collection is unavailable. Preview again.')
        path.unshift(text(data.name))
        sourceKeys.unshift(key)
        key = text(data.parentCollection)
      }
      // Match catalog path identity, including ancestors of external memberships.
      for (let index = 0; request.kind === 'zotero-preview' && index < path.length; index++) {
        const identity = JSON.stringify(
          path.slice(0, index + 1).map(normalizeLiteratureSearchTextV1)
        )
        const owner = collectionOwners.get(identity)
        if (owner !== undefined && owner !== sourceKeys[index])
          throw new Error(ZOTERO_COLLECTION_CONFLICT)
        collectionOwners.set(identity, sourceKeys[index])
      }
      return path
    }
    if (request.kind === 'zotero-collections')
      return {
        ...emptyResult(),
        collections: collections.map(({ key }) => ({ key, path: collectionPath(key) }))
      }
    if (collectionKey && !byKey.has(collectionKey)) throw new Error(ZOTERO_PREVIEW_CHANGED)
    const selectedCollections = collections.filter(({ key }) => {
      if (!collectionKey) return true
      const seen = new Set<string>()
      while (key && !seen.has(key)) {
        if (key === collectionKey) return true
        seen.add(key)
        key = text(byKey.get(key)?.parentCollection)
      }
      return false
    })
    const collectionPaths = selectedCollections.map(({ key }) => collectionPath(key))
    const itemsByKey = new Map<string, ZoteroItem>()
    const paths = collectionKey
      ? selectedCollections.map(({ key }) => `collections/${key}/items`)
      : ['items']
    for (const path of paths) {
      for (const item of await read(path)) itemsByKey.set(item.key, item)
    }
    const items = [...itemsByKey.values()]
    const entries: Entry[] = []
    const failures: CollectorResult['failures'] = []
    let referenceCount = 0
    for (const { key, data } of items) {
      const standalonePdf =
        data.itemType === 'attachment' && data.contentType === 'application/pdf' && !data.parentItem
      if (
        ['note', 'annotation'].includes(text(data.itemType)) ||
        (data.itemType === 'attachment' && !standalonePdf)
      )
        continue
      if (++referenceCount > 1000)
        throw new Error('Select at most 1,000 Zotero references per import.')
      const tags = collectedReferenceSchema.shape.tags.safeParse(
        z
          .array(z.object({ tag: z.string() }))
          .parse(data.tags ?? [])
          .map(({ tag }) => tag)
      )
      if (!tags.success) {
        failures.push({ key, message: ZOTERO_TAG_LIMIT })
        continue
      }
      const type = text(data.itemType)
      const creators = z
        .array(z.record(z.string(), z.unknown()))
        .parse(data.creators ?? [])
        .map((creator) => {
          const role = text(creator.creatorType) || 'author'
          const creatorType = type === 'patent' && role === 'inventor' ? 'author' : role
          return creator.name
            ? {
                nameMode: 'organization',
                literalName: text(creator.name),
                creatorType
              }
            : {
                nameMode: 'person',
                familyName: text(creator.lastName),
                givenName: text(creator.firstName),
                creatorType
              }
        })
      const identifiers = ['DOI', 'ISBN', 'ISSN'].flatMap((field) =>
        text(data[field]) ? [{ scheme: field.toLowerCase(), value: text(data[field]) }] : []
      )
      const itemType = LITERATURE_ITEM_TYPES.includes(type as LiteratureItemType)
        ? type
        : 'document'
      const date = (type === 'patent' ? text(data.issueDate) : '') || text(data.date)
      const publisher =
        text(type === 'thesis' ? data.university : type === 'report' ? data.institution : '') ||
        text(data.publisher)
      const accessDate = text(data.accessDate).trim()
      const accessedAt =
        z.iso.datetime({ offset: true }).safeParse(accessDate).success ||
        z.iso.date().safeParse(accessDate).success
          ? Date.parse(accessDate)
          : NaN
      const reference = collectedReferenceSchema.parse({
        item: {
          itemType,
          title: text(data.title) || (standalonePdf ? text(data.filename) || `${key}.pdf` : ''),
          abstract: text(data.abstractNote),
          issuedText: date,
          issuedYear: literatureIssuedYear(date),
          ...(Number.isFinite(accessedAt) && accessedAt >= 0 ? { accessedAt } : {}),
          containerTitle:
            text(data.publicationTitle) || text(data.bookTitle) || text(data.proceedingsTitle),
          shortTitle: text(data.shortTitle),
          language: text(data.language),
          rights: text(data.rights),
          url: text(data.url),
          extra: text(data.extra),
          creators,
          identifiers,
          typeFields: {
            ...Object.fromEntries(
              ['volume', 'issue', 'pages', 'edition'].flatMap((field) =>
                data[field] ? [[field, data[field]]] : []
              )
            ),
            ...(publisher ? { publisher } : {}),
            ...(text(data.place) ? { publisherPlace: text(data.place) } : {})
          }
        },
        source: {
          provider: 'zotero',
          externalId: `${server}:${key}`,
          sourceUrl: `zotero://select/library/items/${key}`,
          rawMetadata: data
        },
        tags: tags.data,
        collectionPaths: z
          .array(keySchema)
          .parse(data.collections ?? [])
          .map(collectionPath)
      })
      const pdfKeys = items
        .filter(
          ({ data: attachment }) =>
            attachment.parentItem === key && attachment.contentType === 'application/pdf'
        )
        .map(({ key }) => key)
      if (standalonePdf) pdfKeys.unshift(key)
      entries.push({ key, reference, pdfKeys })
    }
    return this.createPreview(
      entries,
      server!,
      collectionPaths,
      signal,
      undefined,
      undefined,
      failures
    )
  }

  private async createPreview(
    entries: Entry[],
    server: string,
    collectionPaths: string[][],
    signal?: AbortSignal,
    policies: LiteratureDuplicatePolicy[] = entries.map(() => 'reuse'),
    replacedId?: string,
    failures: CollectorResult['failures'] = []
  ): Promise<CollectorResult> {
    signal?.throwIfAborted()
    const identities = await this.options.catalog.inspectCollectedReferences(
      entries.map(({ reference }) => reference)
    )
    signal?.throwIfAborted()
    const now = (this.options.now ?? Date.now)()
    // A successful revision replaces its slot before enforcing the capacity limit.
    if (replacedId) this.snapshots.delete(replacedId)
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.expires <= now) this.snapshots.delete(id)
    while (this.snapshots.size >= 4) this.snapshots.delete(this.snapshots.keys().next().value!)
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, {
      entries,
      failures,
      policies,
      reviews: identities,
      expires: now + 10 * 60_000,
      server: server!,
      collectionPaths
    })
    return {
      ...emptyResult(),
      snapshotId,
      failures,
      collectionCount: collectionPaths.length,
      entries: entries.map(({ key, reference, pdfKeys }, index) => ({
        key,
        title: reference.item.title,
        item: reference.item,
        policy: policies[index],
        pdfCount: pdfKeys.length,
        identity: {
          status: identities[index].status,
          reason: identities[index].reason,
          identifiers: identities[index].identifiers,
          matches: identities[index].matches
        }
      }))
    }
  }

  private async copyPdf(
    key: string,
    itemId: string,
    server: string,
    expectedMetadataRevision: number,
    signal?: AbortSignal
  ): Promise<void> {
    const raw = await this.body(
      await this.request(`items/${key}/file/view/url`, server, signal),
      32_768,
      signal
    )
    const url = new URL(raw.trim())
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash)
      throw new Error('Zotero PDF must be a local file.')
    const sourcePath = fileURLToPath(url)
    if (sourcePath.startsWith('//') || sourcePath.startsWith('\\\\'))
      throw new Error('Zotero PDF must be a local file.')
    await attachLiteraturePdf(
      this.options,
      {
        sourcePath,
        itemId,
        expectedMetadataRevision,
        filename: basename(sourcePath),
        maxBytes: 200 * 1024 * 1024
      },
      signal
    )
  }

  async run(input: CollectorRequest, signal?: AbortSignal): Promise<CollectorResult> {
    const request = collectorRequestSchema.parse(input)
    signal?.throwIfAborted()
    if (request.kind === 'zotero-preview' || request.kind === 'zotero-collections')
      return this.preview(request, signal)
    const snapshot = this.snapshots.get(request.snapshotId)
    if (!snapshot || snapshot.expires <= (this.options.now ?? Date.now)())
      throw new Error('Zotero preview expired. Preview again.')
    if (snapshot.busy) throw new Error(ZOTERO_PREVIEW_CHANGED)
    if (request.kind === 'zotero-revise') {
      if (snapshot.committed) throw new Error(ZOTERO_PREVIEW_CHANGED)
      const index = snapshot.entries.findIndex(({ key }) => key === request.key)
      if (index < 0) throw new Error('Zotero selection is invalid.')
      const entries = snapshot.entries.map((entry, position) =>
        position === index && request.item
          ? { ...entry, reference: { ...entry.reference, item: request.item } }
          : entry
      )
      const policies = [...snapshot.policies]
      if (request.policy) policies[index] = request.policy
      snapshot.busy = true
      try {
        const result = await this.createPreview(
          entries,
          snapshot.server,
          snapshot.collectionPaths,
          signal,
          policies,
          request.snapshotId,
          snapshot.failures
        )
        return result
      } finally {
        snapshot.busy = false
      }
    }
    const keys = new Set(request.keys)
    const entries = snapshot.entries.filter(({ key }) => keys.has(key))
    if (entries.length !== request.keys.length) throw new Error('Zotero selection is invalid.')
    const selectedKeys = entries.map(({ key }) => key)
    const policies = snapshot.entries.flatMap(({ key }, index) =>
      keys.has(key) ? [snapshot.policies[index]] : []
    )
    if (
      snapshot.committed &&
      JSON.stringify(selectedKeys) !== JSON.stringify(snapshot.committed.keys)
    )
      throw new Error(ZOTERO_PREVIEW_CHANGED)
    snapshot.busy = true
    try {
      signal?.throwIfAborted()
      // A PDF retry reuses the successful metadata receipt; it never restores or reimports records.
      const committed = snapshot.committed ?? {
        ...(await this.options.catalog.collectReferences(
          entries.map(({ reference }) => reference),
          snapshot.collectionPaths,
          snapshot.entries.flatMap(({ key }, index) =>
            keys.has(key) ? [snapshot.reviews[index]] : []
          ),
          policies
        )),
        keys: selectedKeys,
        completedPdfs: new Set<string>()
      }
      snapshot.committed = committed
      signal?.throwIfAborted()
      const savedItemIds = committed.itemIds
      const result: CollectorResult = {
        ...emptyResult(),
        savedItemIds,
        collectionCount: snapshot.collectionPaths.length
      }
      if (request.includePdfs)
        for (const [index, entry] of entries.entries()) {
          for (const key of entry.pdfKeys) {
            signal?.throwIfAborted()
            const pdfIdentity = JSON.stringify([savedItemIds[index], key])
            if (committed.completedPdfs.has(pdfIdentity)) continue
            try {
              await this.copyPdf(
                key,
                savedItemIds[index],
                snapshot.server,
                committed.metadataRevisions[index],
                signal
              )
              committed.completedPdfs.add(pdfIdentity)
            } catch (error) {
              signal?.throwIfAborted()
              result.failures.push({
                key,
                message: error instanceof Error ? error.message : 'PDF copy failed.'
              })
            }
          }
        }
      signal?.throwIfAborted()
      result.pdfCount = committed.completedPdfs.size
      return result
    } finally {
      snapshot.busy = false
    }
  }
}
