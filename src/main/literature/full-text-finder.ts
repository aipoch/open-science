import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  LiteratureFullTextCandidate,
  LiteratureFullTextTransfer,
  LiteratureFullTextRequest,
  LiteratureFullTextResult,
  LiteratureItemView
} from '../../shared/literature'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue
} from '../../shared/literature'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'
import { findPmcPdfs, findUnpaywallPdfs, readFullTextProvider } from './full-text-sources'
import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { downloadFullText, FullTextRateLimitError, fullTextUrl } from './full-text-download'

const optionalText = z.string().nullish()
const europeRecord = z.object({
  id: optionalText,
  source: optionalText,
  pmcid: optionalText,
  doi: optionalText,
  fullTextUrlList: z
    .object({
      fullTextUrl: z
        .array(
          z.object({
            availabilityCode: optionalText,
            documentStyle: optionalText,
            site: optionalText,
            url: z.string()
          })
        )
        .default([])
    })
    .optional()
})
const location = z.object({
  is_oa: z.boolean().optional(),
  pdf_url: optionalText,
  landing_page_url: optionalText,
  license: optionalText,
  version: optionalText,
  source: z.object({ display_name: optionalText }).nullish()
})
const openAlexWork = z.object({
  doi: optionalText,
  best_oa_location: location.nullish(),
  locations: z.array(location).optional()
})
type SearchResult = Extract<LiteratureFullTextResult, { mode: 'search' }>
type Candidate = Omit<LiteratureFullTextCandidate, 'id'>
type Options = {
  catalog: Pick<LiteratureCatalog, 'get' | 'attachContent'>
  content: Pick<ContentRepository, 'publish'>
  openAlexKey: () => Promise<string | undefined>
  contactEmail?: () => Promise<string | undefined>
  fetch?: typeof fetch
  download?: typeof downloadFullText
  pageCount?: typeof inspectPdfPageCount
}

class LiteratureFullTextFinder {
  private readonly candidates = new Map<
    string,
    { candidate: Candidate; itemId: string; revision: number; expires: number }
  >()
  private readonly transfers = new Map<
    string,
    { snapshot: LiteratureFullTextTransfer; settledAt?: number }
  >()

  private pruneTransfers(): void {
    const settled = [...this.transfers]
      .filter(([, task]) => task.settledAt !== undefined)
      .sort((a, b) => a[1].settledAt! - b[1].settledAt!)
    for (const [index, [itemId, task]] of settled.entries()) {
      if (task.settledAt! < Date.now() - 15 * 60_000 || index < settled.length - 128)
        this.transfers.delete(itemId)
    }
  }
  constructor(private readonly options: Options) {}

  async discover(item: LiteratureItemView['item']): Promise<SearchResult> {
    return this.search({
      id: randomUUID(),
      item,
      metadataRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attachments: [],
      collectionIds: [],
      projectIds: []
    })
  }

  async run(request: LiteratureFullTextRequest): Promise<LiteratureFullTextResult> {
    this.pruneTransfers()
    const task = this.transfers.get(request.itemId)?.snapshot
    if (request.mode === 'transfer') {
      if (task && request.acknowledgeId === task.id && task.status !== 'running') {
        this.transfers.delete(request.itemId)
        return { mode: 'transfer' }
      }
      const item =
        task?.status === 'succeeded'
          ? await this.options.catalog.get(request.itemId).catch(() => undefined)
          : undefined
      return {
        mode: 'transfer',
        transfer: task ? { ...task } : undefined,
        ...(item?.id === request.itemId ? { item } : {})
      }
    }
    if (request.mode === 'progress') {
      return {
        mode: 'progress',
        ...(task?.status === 'running' && task.candidate.id === request.candidateId
          ? { progress: task.progress }
          : {})
      }
    }
    const item = await this.options.catalog.get(request.itemId)
    if (!item || item.id !== request.itemId) throw new Error('Literature Item is unavailable.')
    return request.mode === 'search' ? this.search(item) : this.attach(item, request.candidateId)
  }

  private async json(url: string): Promise<unknown> {
    const raw = await readFullTextProvider(url, this.options.fetch)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  private async search(item: LiteratureItemView): Promise<SearchResult> {
    const identifiers = new Map(
      item.item.identifiers.map(({ scheme, value }) => [
        scheme,
        normalizeLiteratureIdentifierValue(scheme, value)
      ])
    )
    const doi = identifiers.get('doi')?.toLowerCase()
    const pmid = identifiers.get('pmid')
    const pmcid = identifiers.get('pmcid')
    const arxivPage = createLiteratureIdentifierUrl('arxiv', identifiers.get('arxiv') ?? '')
    if (!doi && !pmid && !pmcid && !arxivPage)
      return { mode: 'search', candidates: [], notices: ['missing-identifiers'] }
    const found: Candidate[] = []
    const notices: SearchResult['notices'] = []
    // Independent sources start together; append their results in a stable order below.
    const unpaywall = (async (): Promise<Candidate[]> => {
      if (!doi) return []
      try {
        const email = (await this.options.contactEmail?.())?.trim()
        if (!email || !z.string().email().safeParse(email).success) {
          notices.push('unpaywall-not-configured')
          return []
        }
        return await findUnpaywallPdfs(doi, email, this.options.fetch)
      } catch {
        notices.push('unpaywall-unavailable')
        return []
      }
    })()
    const pmc = findPmcPdfs({ doi, pmid, pmcid }, this.options.fetch)
      .then((result) => {
        if (result.noRecord && (doi || pmid || pmcid)) notices.push('pmc-no-record')
        return result.candidates
      })
      .catch(() => {
        notices.push('pmc-unavailable')
        return []
      })
    const add = (candidate: Candidate): void => {
      try {
        const url = fullTextUrl(candidate.url).href
        let sourceUrl = new URL(url).origin
        try {
          sourceUrl = fullTextUrl(candidate.sourceUrl ?? sourceUrl).href
        } catch {
          // An invalid landing page must not turn a valid PDF into an unsafe browser link.
        }
        if (!found.some((entry) => entry.url === url)) found.push({ ...candidate, url, sourceUrl })
      } catch {
        /* Ignore unsafe provider links; they are never download candidates. */
      }
    }
    const query =
      pmcid && /^PMC\d+$/iu.test(pmcid)
        ? `PMCID:${pmcid}`
        : pmid && /^\d+$/u.test(pmid)
          ? `EXT_ID:${pmid} AND SRC:MED`
          : doi
            ? `DOI:"${doi.replace(/["\\]/gu, '')}"`
            : undefined
    const europe = (async (): Promise<Candidate[]> => {
      const candidates: Candidate[] = []
      if (!query) return candidates
      try {
        const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
        url.search = new URLSearchParams({
          query,
          format: 'json',
          resultType: 'core',
          pageSize: '5'
        }).toString()
        const result = z
          .object({ resultList: z.object({ result: z.array(europeRecord) }) })
          .parse(await this.json(url.href))
        for (const record of result.resultList.result) {
          const pairs = [
            [
              doi,
              record.doi
                ? normalizeLiteratureIdentifierValue('doi', record.doi).toLowerCase()
                : undefined
            ],
            [pmid, record.source === 'MED' ? record.id : undefined],
            [pmcid?.toUpperCase(), record.pmcid?.toUpperCase()]
          ]
          if (
            !pairs.some(([expected, actual]) => expected && expected === actual) ||
            pairs.some(([expected, actual]) => expected && actual && expected !== actual)
          )
            continue
          const links = record.fullTextUrlList?.fullTextUrl ?? []
          for (const link of links) {
            if (
              link.documentStyle?.toLowerCase() === 'pdf' &&
              ['OA', 'F'].includes(link.availabilityCode ?? '')
            ) {
              const page = links.find(
                (entry) =>
                  entry.documentStyle?.toLowerCase() === 'html' &&
                  entry.site &&
                  entry.site === link.site
              )
              const europeArticle =
                /^https:\/\/(?:www\.)?europepmc\.org\/articles\/(PMC\d+)(?:[/?#]|$)/iu.exec(
                  link.url
                )
              candidates.push({
                provider: 'europe-pmc',
                url: link.url,
                sourceUrl:
                  page?.url ??
                  (europeArticle
                    ? `https://europepmc.org/articles/${europeArticle[1]}`
                    : undefined),
                source: link.site?.replace(/_/gu, ' ') || 'Europe PMC'
              })
            }
          }
        }
      } catch {
        notices.push('europe-pmc-unavailable')
      }
      return candidates
    })()
    const openAlex = (async (): Promise<Candidate[]> => {
      const candidates: Candidate[] = []
      if (!doi) return candidates
      try {
        const key = await this.options.openAlexKey()
        if (!key) {
          notices.push('openalex-not-configured')
          return candidates
        }
        const url = new URL('https://api.openalex.org/works')
        url.search = new URLSearchParams({
          filter: `doi:https://doi.org/${doi}`,
          per_page: '5',
          select: 'doi,best_oa_location,locations',
          api_key: key
        }).toString()
        const result = z.object({ results: z.array(openAlexWork) }).parse(await this.json(url.href))
        for (const work of result.results) {
          if (
            !work.doi ||
            normalizeLiteratureIdentifierValue('doi', work.doi).toLowerCase() !== doi
          )
            continue
          for (const entry of [work.best_oa_location, ...(work.locations ?? [])]) {
            if (!entry?.is_oa || !entry.pdf_url) continue
            const version =
              entry.version === 'publishedVersion'
                ? 'published'
                : entry.version === 'acceptedVersion'
                  ? 'accepted'
                  : entry.version === 'submittedVersion'
                    ? 'submitted'
                    : undefined
            candidates.push({
              provider: 'openalex',
              url: entry.pdf_url,
              sourceUrl: entry.landing_page_url || `https://doi.org/${doi}`,
              source: entry.source?.display_name || 'OpenAlex',
              ...(version ? { version } : {}),
              ...(entry.license ? { license: entry.license } : {})
            })
          }
        }
      } catch {
        notices.push('openalex-unavailable')
      }
      return candidates
    })()
    for (const candidates of await Promise.all([europe, openAlex, unpaywall, pmc]))
      candidates.forEach(add)
    if (arxivPage)
      add({
        provider: 'arxiv',
        source: 'arXiv',
        sourceUrl: arxivPage,
        url: arxivPage.replace('/abs/', '/pdf/')
      })
    const shortlist = found.slice(0, 10)
    const arxivCandidate = found.find(({ url }) => url === arxivPage?.replace('/abs/', '/pdf/'))
    // Keep the identified arXiv PDF selectable even when other sources fill the result limit.
    if (arxivCandidate && !shortlist.includes(arxivCandidate)) shortlist[9] = arxivCandidate
    const now = Date.now()
    for (const [id, value] of this.candidates) if (value.expires < now) this.candidates.delete(id)
    const candidates = shortlist.map((candidate) => {
      const id = randomUUID()
      this.candidates.set(id, {
        candidate,
        itemId: item.id,
        revision: item.metadataRevision,
        expires: now + 15 * 60_000
      })
      return { id, ...candidate }
    })
    while (this.candidates.size > 128) this.candidates.delete(this.candidates.keys().next().value!)
    return { mode: 'search', candidates, notices }
  }

  private async attach(
    item: LiteratureItemView,
    candidateId: string
  ): Promise<LiteratureFullTextResult> {
    const selected = this.candidates.get(candidateId)
    if (
      !selected ||
      selected.itemId !== item.id ||
      selected.revision !== item.metadataRevision ||
      selected.expires < Date.now()
    )
      throw new Error('Full-text result expired or the reference changed. Search again.')
    if (this.transfers.get(item.id)?.snapshot.status === 'running')
      throw new Error('A full-text attachment is already being added.')
    const task: { snapshot: LiteratureFullTextTransfer; settledAt?: number } = {
      snapshot: {
        id: randomUUID(),
        itemId: item.id,
        candidate: { ...selected.candidate, id: candidateId },
        status: 'running',
        progress: { receivedBytes: 0, bytesPerSecond: 0, phase: 'downloading' }
      }
    }
    this.transfers.set(item.id, task)
    let directory: string | undefined
    try {
      const bytes = await (this.options.download ?? downloadFullText)(
        selected.candidate.url,
        MAX_AUTO_EXTRACT_PDF_BYTES,
        (value) => {
          task.snapshot.progress = value
        }
      )
      task.snapshot.progress = {
        receivedBytes: bytes.length,
        totalBytes: bytes.length,
        bytesPerSecond: 0,
        phase: 'saving'
      }
      if (
        bytes.length > MAX_AUTO_EXTRACT_PDF_BYTES ||
        bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
      )
        throw new Error('The full-text link did not return a PDF.')
      directory = await mkdtemp(join(tmpdir(), 'open-science-full-text-'))
      const path = join(directory, 'paper.pdf')
      await writeFile(path, bytes, { mode: 0o600 })
      const pageCount = await (this.options.pageCount ?? inspectPdfPageCount)(path)
      const current = await this.options.catalog.get(item.id)
      if (!current || current.id !== item.id || current.metadataRevision !== selected.revision)
        throw new Error('The reference changed during download. Search again.')
      const content = await this.options.content.publish({
        sourcePath: path,
        contentType: 'application/pdf'
      })
      const filename = `${
        item.item.title
          .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
          .trim()
          .slice(0, 120) || 'paper'
      }.pdf`
      const receipt = await this.options.catalog.attachContent({
        itemId: item.id,
        expectedMetadataRevision: selected.revision,
        contentBlobId: content.id,
        filename,
        contentType: 'application/pdf',
        sizeBytes: Number(content.sizeBytes),
        checksum: content.checksum,
        pageCount,
        provenance: {
          provider: selected.candidate.provider,
          source: selected.candidate.source,
          sourceUrl: selected.candidate.sourceUrl ?? new URL(selected.candidate.url).origin,
          acquiredAt: Date.now(),
          version: selected.candidate.version,
          license: selected.candidate.license
        }
      })
      // The receipt is authoritative even if refreshing the item later fails.
      Object.assign(task.snapshot, receipt, { status: 'succeeded' })
      const updated = await this.options.catalog.get(item.id).catch(() => undefined)
      if (updated?.id !== item.id) return { mode: 'transfer', transfer: { ...task.snapshot } }
      return { mode: 'attach', item: updated, transferId: task.snapshot.id }
    } catch (error) {
      if (task.snapshot.status !== 'succeeded') task.snapshot.status = 'failed'
      if (error instanceof FullTextRateLimitError) task.snapshot.retryAt = error.retryAt
      if (error instanceof FullTextRateLimitError)
        return { mode: 'attach-error', reason: 'rate-limited', retryAt: error.retryAt }
      throw error
    } finally {
      task.settledAt = Date.now()
      this.pruneTransfers()
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}

export { LiteratureFullTextFinder }
export type { Options as LiteratureFullTextFinderOptions }
