import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { fullTextUrl } from './full-text-download.js'
import type { DiscoveryReference } from './contracts.js'
import {
  getSupplementDoi,
  normalizeSupplementDoi,
  literatureSupplementRequestSchema,
  literatureSupplementResultSchema,
  literatureSupplementRecordSchema,
  type LiteratureSupplementRequest,
  type LiteratureSupplementResult,
  type LiteratureSupplementRecord,
  type LiteratureSupplementProvider
} from './supplement-contracts.js'
import { parseSupplementXml } from './supplement-xml.js'
import { boundedLiteraturePage } from './response-page.js'

const optionalText = z.string().nullish()
const relation = z.object({
  identifier: optionalText,
  identifier_type: optionalText,
  relation: optionalText
})
const figshareRecord = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  doi: optionalText,
  url_public_html: optionalText,
  related_materials: z.array(relation).nullish(),
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        download_url: optionalText,
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish()
      })
    )
    .nullish(),
  license: z.object({ name: optionalText }).nullish()
})
const dataciteRecord = z.object({
  id: z.string(),
  attributes: z.object({
    doi: optionalText,
    titles: z.array(z.object({ title: z.string() })),
    relatedIdentifiers: z
      .array(
        z.object({
          relatedIdentifier: optionalText,
          relatedIdentifierType: optionalText,
          relationType: optionalText
        })
      )
      .nullish(),
    rightsList: z.array(z.object({ rights: optionalText })).nullish()
  })
})
const plain = (text: string): string => {
  let output = ''
  let pending = ''
  let inTag = false
  for (const character of text) {
    if (character === '<') {
      output += pending
      pending = ''
      inTag = true
    } else if (character === '>') {
      pending = ''
      inTag = false
    } else if (inTag) pending += character
    else output += character
  }
  return (output + pending).replace(/\s+/gu, ' ').trim().slice(0, 2048)
}
const literal = (doi: string): string => `"${doi.replace(/[\\"]/gu, '\\$&')}"`
type Issue = LiteratureSupplementResult['issues'][number]
class SourceError extends Error {
  constructor(
    readonly issue: Issue,
    readonly retryAt?: number
  ) {
    super(issue)
  }
}

type SupplementDownload = {
  itemId: string
  revision: number
  doi: string
  provider: LiteratureSupplementProvider
  filename: string
  url: string
  archiveEntry?: string
  sourceUrl: string
  expires: number
}

export class LiteratureSupplementFinder {
  private readonly downloads = new Map<string, SupplementDownload>()
  getDownload(id: string, itemId: string, revision: number): Readonly<SupplementDownload> {
    const entry = this.downloads.get(id)
    if (
      !entry ||
      entry.itemId !== itemId ||
      entry.revision !== revision ||
      entry.expires < Date.now()
    )
      throw new Error('Supplement result expired or the reference changed. Search again.')
    return entry
  }
  private rememberDownload(entry: Omit<SupplementDownload, 'expires'>): string | undefined {
    try {
      fullTextUrl(entry.url)
    } catch {
      return undefined
    }
    for (const [id, value] of this.downloads)
      if (value.expires < Date.now()) this.downloads.delete(id)
    while (this.downloads.size >= 10000) this.downloads.delete(this.downloads.keys().next().value!)
    const id = randomUUID()
    this.downloads.set(id, { ...entry, expires: Date.now() + 15 * 60_000 })
    return id
  }
  private readonly retryAfter = new Map<LiteratureSupplementProvider, number>()
  constructor(
    private readonly options: {
      catalog: { get(id: string): Promise<DiscoveryReference | undefined> }
      fetch: typeof fetch
    }
  ) {}

  async run(
    input: LiteratureSupplementRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteratureSupplementResult> {
    const request = literatureSupplementRequestSchema.parse(input)
    const result: LiteratureSupplementResult = {
      itemId: request.itemId,
      metadataRevision: request.expectedMetadataRevision,
      provider: request.provider,
      state: 'complete',
      records: [],
      issues: []
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(callerSignal ? [callerSignal] : [])
    ])
    const checkReference = async (): Promise<DiscoveryReference | undefined> => {
      signal.throwIfAborted()
      const item = await this.options.catalog.get(request.itemId)
      const issue =
        !item || item.deletedAt !== undefined
          ? 'reference-unavailable'
          : item.metadataRevision !== request.expectedMetadataRevision
            ? 'reference-changed'
            : undefined
      if (issue) {
        result.issues = [issue]
        result.records = []
        result.state = 'unavailable'
        return undefined
      }
      return item
    }
    const item = await checkReference()
    if (!item) return result
    const doi = getSupplementDoi(item.item.identifiers)
    if (!doi) return { ...result, state: 'unavailable', issues: ['doi-required'] }
    result.doi = doi
    const issue = (error: unknown): void => {
      const code =
        error instanceof SourceError
          ? error.issue
          : signal.aborted ||
              (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
            ? 'timeout'
            : error instanceof SyntaxError || error instanceof z.ZodError
              ? 'response-invalid'
              : 'unavailable'
      if (!result.issues.includes(code)) result.issues.push(code)
      if (error instanceof SourceError && error.retryAt) result.retryAt = error.retryAt
    }
    const read = async (url: string, body?: object, xml = false): Promise<string> => {
      signal.throwIfAborted()
      const retryAt = this.retryAfter.get(request.provider)
      if (retryAt && retryAt > Date.now()) throw new SourceError('rate-limited', retryAt)
      const response = await this.options.fetch(url, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        credentials: 'omit',
        headers: {
          Accept: xml ? 'application/xml' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 429) {
          const header = response.headers.get('retry-after') ?? ''
          const delay = /^\d+$/u.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          const until =
            Date.now() +
            Math.min(86_400_000, Math.max(1_000, Number.isFinite(delay) ? delay : 60_000))
          this.retryAfter.set(request.provider, until)
          throw new SourceError('rate-limited', until)
        }
        throw new SourceError(
          xml && response.status === 404 ? 'full-text-unavailable' : 'unavailable'
        )
      }
      if (!response.body) throw new SourceError('response-invalid')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > (xml ? 4 : 2) * 1024 * 1024) throw new SourceError('search-incomplete')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    let successfulPages = 0
    const add = (record: LiteratureSupplementRecord): void => {
      if (result.records.length >= 50) throw new SourceError('search-incomplete')
      result.records.push(literatureSupplementRecordSchema.parse(record))
    }
    try {
      if (request.provider === 'figshare') {
        const ids = new Set<number>()
        // Both queries are needed: resource_doi misses records using only related_materials.
        await Promise.all(
          [{ resource_doi: doi }, { search_for: literal(doi) }].map(async (search) => {
            const seen = new Set<number>()
            try {
              for (let page = 1; page <= 2; page++) {
                const rows = z
                  .array(z.object({ id: z.number().int().positive() }))
                  .max(25)
                  .parse(
                    JSON.parse(
                      await read('https://api.figshare.com/v2/articles/search', {
                        ...search,
                        page,
                        page_size: 25
                      })
                    )
                  )
                successfulPages++
                if (rows.length && rows.every(({ id }) => seen.has(id)))
                  throw new SourceError('search-incomplete')
                for (const { id } of rows) {
                  seen.add(id)
                  ids.add(id)
                }
                if (rows.length < 25) return
              }
              throw new SourceError('search-incomplete')
            } catch (error) {
              issue(error)
            }
          })
        )
        if (ids.size > 50) issue(new SourceError('search-incomplete'))
        const pending = [...ids].slice(0, 50)
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (pending.length && !signal.aborted) {
              const id = pending.shift()!
              try {
                const record = figshareRecord.parse(
                  JSON.parse(await read(`https://api.figshare.com/v2/articles/${id}`))
                )
                if (record.id !== id) throw new SourceError('response-invalid')
                if (
                  !record.related_materials?.some(
                    (r) =>
                      r.identifier_type === 'DOI' &&
                      r.relation === 'IsSupplementTo' &&
                      r.identifier &&
                      normalizeSupplementDoi(r.identifier) === doi
                  )
                )
                  continue
                const recordDoi = record.doi ? normalizeSupplementDoi(record.doi) : undefined
                if (recordDoi === doi) continue
                if ((record.files?.length ?? 0) > 100) issue(new SourceError('search-incomplete'))
                add({
                  id: String(id),
                  ...(recordDoi ? { doi: recordDoi } : {}),
                  title: plain(record.title) || String(id),
                  sourceUrl: literatureSupplementRecordSchema.shape.sourceUrl.safeParse(
                    record.url_public_html
                  ).success
                    ? record.url_public_html!
                    : recordDoi
                      ? `https://doi.org/${encodeURIComponent(recordDoi)}`
                      : `https://figshare.com/articles/${id}`,
                  evidence: 'source-declared',
                  ...(record.files
                    ? {
                        files: record.files.slice(0, 100).map((f) => ({
                          name: f.name.slice(0, 2048),
                          ...(f.download_url
                            ? {
                                downloadId: this.rememberDownload({
                                  itemId: item.id,
                                  revision: item.metadataRevision,
                                  doi,
                                  provider: 'figshare',
                                  filename: f.name,
                                  url: f.download_url,
                                  sourceUrl: `https://figshare.com/articles/${id}`
                                })
                              }
                            : {}),
                          ...(f.size != null ? { sizeBytes: f.size } : {})
                        }))
                      }
                    : {}),
                  ...(record.license?.name
                    ? { license: plain(record.license.name) || undefined }
                    : {})
                })
              } catch (error) {
                issue(error)
              }
            }
          })
        )
        if (signal.aborted) issue(new SourceError('timeout'))
      } else if (request.provider === 'datacite') {
        const seen = new Set<string>()
        for (let page = 1; page <= 2; page++) {
          const query = new URLSearchParams({
            query: `relatedIdentifiers.relatedIdentifier:${literal(doi)}`,
            'page[size]': '25',
            'page[number]': String(page)
          })
          const response = z
            .object({ data: z.array(z.unknown()).max(25) })
            .parse(JSON.parse(await read(`https://api.datacite.org/dois?${query}`)))
          successfulPages++
          let fresh = 0
          for (const raw of response.data) {
            try {
              const record = dataciteRecord.parse(raw)
              const id = normalizeSupplementDoi(record.id)
              if (
                !id ||
                (record.attributes.doi && normalizeSupplementDoi(record.attributes.doi) !== id)
              )
                throw new SourceError('response-invalid')
              if (seen.has(id)) continue
              seen.add(id)
              fresh++
              const a = record.attributes
              if (
                id === doi ||
                !a.relatedIdentifiers?.some(
                  (r) =>
                    r.relatedIdentifierType === 'DOI' &&
                    r.relationType === 'IsSupplementTo' &&
                    r.relatedIdentifier &&
                    normalizeSupplementDoi(r.relatedIdentifier) === doi
                )
              )
                continue
              add({
                id,
                doi: id,
                title: plain(a.titles[0]?.title ?? '') || id,
                sourceUrl: `https://doi.org/${encodeURIComponent(id)}`,
                evidence: 'source-declared',
                license:
                  plain(
                    a.rightsList
                      ?.map((r) => r.rights ?? '')
                      .filter(Boolean)
                      .join('; ') ?? ''
                  ) || undefined
              })
            } catch (error) {
              issue(error)
            }
          }
          if (response.data.length && !fresh) throw new SourceError('search-incomplete')
          if (response.data.length < 25) break
          if (page === 2) throw new SourceError('search-incomplete')
        }
      } else {
        const base = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
        const query = new URLSearchParams({
          query: `DOI:${literal(doi)}`,
          format: 'json',
          resultType: 'core',
          pageSize: '5'
        })
        const response = z
          .object({
            hitCount: z.number().int().nonnegative(),
            resultList: z.object({
              result: z.array(z.object({ doi: optionalText, pmcid: optionalText })).max(5)
            })
          })
          .parse(JSON.parse(await read(`${base}/search?${query}`)))
        successfulPages++
        if (response.hitCount > 5) issue(new SourceError('search-incomplete'))
        const matching = response.resultList.result.filter(
          (r) => r.doi && normalizeSupplementDoi(r.doi) === doi
        )
        const ids = [
          ...new Set(
            matching.flatMap((r) => (r.pmcid && /^PMC\d+$/u.test(r.pmcid) ? [r.pmcid] : []))
          )
        ]
        if (matching.length > ids.length) issue(new SourceError('full-text-unavailable'))
        for (const pmcid of ids) {
          try {
            const xml = await read(`${base}/${pmcid}/fullTextXML`, undefined, true)
            let parsed: ReturnType<typeof parseSupplementXml>
            try {
              parsed = parseSupplementXml(xml, doi, pmcid)
            } catch {
              throw new SourceError('response-invalid')
            }
            if (parsed.truncated) issue(new SourceError('search-incomplete'))
            parsed.records.forEach((record) =>
              add({
                ...record,
                files: record.files?.map((file) => ({
                  ...file,
                  downloadId: this.rememberDownload({
                    itemId: item.id,
                    revision: item.metadataRevision,
                    doi,
                    provider: 'europe-pmc',
                    filename: file.name,
                    archiveEntry: file.name,
                    url: `${base}/${pmcid}/supplementaryFiles`,
                    sourceUrl: record.sourceUrl
                  })
                }))
              })
            )
          } catch (error) {
            issue(error)
          }
        }
      }
    } catch (error) {
      issue(error)
    }
    const page = boundedLiteraturePage(result.records)
    result.records = page.entries
    if (page.nextOffset !== undefined) issue(new SourceError('search-incomplete'))
    result.state = !result.issues.length ? 'complete' : successfulPages ? 'partial' : 'unavailable'
    // Do not return results for a deleted or edited reference after network I/O.
    callerSignal?.throwIfAborted()
    const current = await this.options.catalog.get(request.itemId)
    if (
      !current ||
      current.deletedAt !== undefined ||
      current.metadataRevision !== request.expectedMetadataRevision ||
      getSupplementDoi(current.item.identifiers) !== doi
    ) {
      result.records = []
      result.state = 'unavailable'
      result.issues = [
        !current || current.deletedAt !== undefined ? 'reference-unavailable' : 'reference-changed'
      ]
    }
    return literatureSupplementResultSchema.parse(result)
  }
}
