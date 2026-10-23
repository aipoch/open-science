import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  bibliographicRecordSchema,
  normalizeLiteratureIdentifierValue,
  createLiteratureIdentifierUrl
} from '@aipoch/literature-citations/contracts'
import type { DiscoveryReference } from './contracts.js'
import {
  literatureRelatedRequestSchema,
  literatureRelatedResultSchema,
  type LiteratureRelatedRequest,
  type LiteratureRelatedResult,
  type LiteratureRelatedRecord
} from './related-contracts.js'

const text = z.string().max(100_000).nullish()
const paperSchema = z.object({
  paperId: z.string().regex(/^[a-f0-9]{40}$/i),
  title: z.string().trim().min(1).max(10000),
  abstract: text,
  venue: text,
  year: z.number().int().min(0).max(9999).nullish(),
  publicationDate: text,
  authors: z
    .array(z.object({ name: z.string().trim().min(1).max(1000) }))
    .max(2000)
    .nullish(),
  externalIds: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullish(),
  journal: z.object({ name: text, volume: text, pages: text }).nullish(),
  publicationTypes: z.array(z.string()).nullish()
})
const fields =
  'title,abstract,authors,year,venue,externalIds,publicationDate,journal,publicationTypes'
const schemes = { DOI: 'doi', PubMed: 'pmid', PubMedCentral: 'pmcid', ArXiv: 'arxiv' } as const
function record(raw: unknown): LiteratureRelatedRecord {
  const paper = paperSchema.parse(raw)
  const identifiers = Object.entries(schemes).flatMap(([key, scheme]) => {
    const raw = paper.externalIds?.[key]
    if (raw == null) return []
    const value = normalizeLiteratureIdentifierValue(scheme, String(raw))
    return createLiteratureIdentifierUrl(scheme, value) ? [{ scheme, value }] : []
  })
  return {
    paperId: paper.paperId,
    item: bibliographicRecordSchema.parse({
      itemType: paper.publicationTypes?.includes('Review')
        ? 'review'
        : paper.publicationTypes?.includes('Conference')
          ? 'conferencePaper'
          : paper.journal?.name || paper.venue
            ? 'journalArticle'
            : 'document',
      title: paper.title,
      abstract: paper.abstract ?? '',
      issuedYear: paper.year ?? undefined,
      issuedText: paper.publicationDate ?? (paper.year ? String(paper.year) : ''),
      containerTitle: paper.journal?.name ?? paper.venue ?? '',
      url: `https://www.semanticscholar.org/paper/${paper.paperId}`,
      // Preserve unsplit provider names rather than guessing given/family boundaries.
      creators: (paper.authors ?? []).map(({ name }) => ({
        nameMode: 'organization',
        literalName: name,
        creatorType: 'author'
      })),
      identifiers,
      typeFields: {
        ...(paper.journal?.volume ? { volume: paper.journal.volume } : {}),
        ...(paper.journal?.pages ? { pages: paper.journal.pages } : {})
      }
    })
  }
}
class SourceError extends Error {
  constructor(
    readonly issue: NonNullable<LiteratureRelatedResult['issue']>,
    readonly retryAt?: number
  ) {
    super(issue)
  }
}
type Resolution = {
  itemId: string
  revision: number
  seed: LiteratureRelatedRecord
  expires: number
}
export class LiteratureRelatedFinder {
  private readonly resolutions = new Map<string, Resolution>()
  private nextRequest = 0
  private readonly cooldowns = new Map<string, number>()
  private readonly cooldownIdentitySalt = randomBytes(32)
  constructor(
    private readonly options: {
      catalog: {
        get(id: string): Promise<DiscoveryReference | undefined>
        sources(id: string): Promise<readonly { provider: string; externalId?: string }[]>
      }
      fetch: typeof fetch
      apiKey?: () => Promise<string | undefined>
    }
  ) {}

  private async read(
    path: string,
    query: Record<string, string>,
    signal: AbortSignal
  ): Promise<unknown> {
    for (const [identity, until] of this.cooldowns)
      if (until <= Date.now()) this.cooldowns.delete(identity)
    const readCredentials = async (): Promise<{ apiKey: string | undefined; identity: string }> => {
      const apiKey = await this.options.apiKey?.()
      // Derive only temporary cooldown identities; credential storage belongs to the host.
      const identity = await new Promise<string>((resolve, reject) => {
        scrypt(apiKey ?? '', this.cooldownIdentitySalt, 32, (error, fingerprint) => {
          if (error) reject(error)
          else resolve(fingerprint.toString('hex'))
        })
      })
      const retryAt = this.cooldowns.get(identity)
      if (retryAt && retryAt > Date.now()) throw new SourceError('rate-limited', retryAt)
      return { apiKey, identity }
    }
    await readCredentials()
    const slot = Math.max(Date.now(), this.nextRequest)
    if (slot - Date.now() > 10_000) throw new SourceError('rate-limited', slot)
    this.nextRequest = slot + 1000
    await delay(Math.max(0, slot - Date.now()), undefined, { signal })
    const { apiKey, identity } = await readCredentials()
    const response = await this.options.fetch(
      `https://api.semanticscholar.org/graph/v1/${path}?${new URLSearchParams(query)}`,
      {
        redirect: 'error',
        credentials: 'omit',
        signal,
        headers: { Accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
      }
    )
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429) {
        const value = response.headers.get('retry-after') ?? ''
        const wait = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
        const retryAt =
          Date.now() + Math.min(300_000, Math.max(1000, Number.isFinite(wait) ? wait : 60_000))
        this.cooldowns.set(identity, retryAt)
        throw new SourceError('rate-limited', retryAt)
      }
      throw new SourceError(
        response.status === 404
          ? 'no-match'
          : [401, 403].includes(response.status)
            ? 'authentication'
            : 'unavailable'
      )
    }
    if (!response.body) throw new SourceError('response-invalid')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 2 * 1024 * 1024) throw new SourceError('response-invalid')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async run(
    input: LiteratureRelatedRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteratureRelatedResult> {
    const request = literatureRelatedRequestSchema.parse(input)
    const result: LiteratureRelatedResult = {
      itemId: request.itemId,
      metadataRevision: request.expectedMetadataRevision,
      direction: request.direction,
      state: 'ready',
      records: []
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(callerSignal ? [callerSignal] : [])
    ])
    const check = async (): Promise<DiscoveryReference> => {
      signal.throwIfAborted()
      const item = await this.options.catalog.get(request.itemId)
      if (
        !item ||
        item.id !== request.itemId ||
        item.deletedAt !== undefined ||
        item.metadataRevision !== request.expectedMetadataRevision
      )
        throw new SourceError('reference-changed')
      return item
    }
    try {
      const item = await check()
      for (const [token, value] of this.resolutions)
        if (value.expires < Date.now()) this.resolutions.delete(token)
      let resolution = request.resolutionToken
        ? this.resolutions.get(request.resolutionToken)
        : undefined
      if (
        request.resolutionToken &&
        (!resolution ||
          resolution.itemId !== item.id ||
          resolution.revision !== item.metadataRevision)
      )
        throw new SourceError('expired')
      if (!resolution) {
        if (request.offset) throw new SourceError('expired')
        const source = (await this.options.catalog.sources(item.id)).find(
          (s) => s.provider === 'semantic-scholar' && /^[a-f0-9]{40}$/i.test(s.externalId ?? '')
        )
        let id: string | undefined
        for (const scheme of ['doi', 'pmid', 'pmcid', 'arxiv'] as const) {
          if (id) break
          const values = [
            ...new Set(
              item.item.identifiers
                .filter((i) => i.scheme === scheme)
                .map((i) => normalizeLiteratureIdentifierValue(scheme, i.value))
            )
          ]
          if (values.length === 1 && createLiteratureIdentifierUrl(scheme, values[0]))
            id = `${scheme.toUpperCase()}:${scheme === 'pmcid' ? values[0].replace(/^PMC/i, '') : values[0]}`
        }
        id ??= source?.externalId
        let seed: LiteratureRelatedRecord
        if (id)
          seed = record(await this.read(`paper/${encodeURIComponent(id)}`, { fields }, signal))
        else {
          const match = z
            .object({ data: z.array(z.unknown()).max(1) })
            .parse(
              await this.read(
                'paper/search/match',
                { query: item.item.title.slice(0, 1000), fields },
                signal
              )
            )
          if (!match.data.length) throw new SourceError('no-match')
          seed = record(match.data[0])
          result.state = 'match-required'
        }
        const token = randomUUID()
        resolution = {
          itemId: item.id,
          revision: item.metadataRevision,
          seed,
          expires: Date.now() + 15 * 60_000
        }
        while (this.resolutions.size >= 200)
          this.resolutions.delete(this.resolutions.keys().next().value!)
        this.resolutions.set(token, resolution)
        result.resolutionToken = token
      } else result.resolutionToken = request.resolutionToken
      result.seed = resolution.seed
      if (result.state !== 'match-required') {
        const page = z
          .object({
            offset: z.number().int().nonnegative(),
            next: z.number().int().nonnegative().optional(),
            data: z.array(z.unknown()).max(20)
          })
          .parse(
            await this.read(
              `paper/${resolution.seed.paperId}/${request.direction}`,
              { fields, limit: '20', offset: String(request.offset) },
              signal
            )
          )
        if (
          page.offset !== request.offset ||
          (page.next !== undefined && page.next <= request.offset)
        )
          throw new SourceError('response-invalid')
        const seen = new Set<string>()
        for (const raw of page.data) {
          const row = z.record(z.string(), z.unknown()).parse(raw)
          const nested = row[request.direction === 'references' ? 'citedPaper' : 'citingPaper']
          if (!nested || !(nested as { paperId?: unknown }).paperId) {
            result.omitted = (result.omitted ?? 0) + 1
            continue
          }
          const entry = record(nested)
          if (!seen.has(entry.paperId)) result.records.push(entry)
          seen.add(entry.paperId)
        }
        if (page.next !== undefined) result.nextOffset = page.next
      }
      await check()
    } catch (error) {
      callerSignal?.throwIfAborted()
      return {
        ...result,
        state: 'unavailable',
        records: [],
        nextOffset: undefined,
        issue:
          error instanceof SourceError
            ? error.issue
            : signal.aborted
              ? 'timeout'
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? 'response-invalid'
                : 'unavailable',
        retryAt: error instanceof SourceError ? error.retryAt : undefined
      }
    }
    return literatureRelatedResultSchema.parse(result)
  }
}
