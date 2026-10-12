import type { LiteratureJobsResult } from '@aipoch/literature-discovery/jobs'
import type { LiteratureCatalogSearchRequest } from '../contracts.js'
import { literatureItemViewSchema } from '../contracts.js'
import { oversizedLiteratureReference } from '../export.js'
import type { LibraryClientApi, LibraryPage } from './ports.js'
export type LiteratureClient<Page extends LibraryPage> = {
  readLiteratureDisplayPage: (
    request: LiteratureCatalogSearchRequest,
    isCurrent?: () => boolean,
    recoverOversized?: boolean
  ) => Promise<Page>
  readLiteratureSelectionPage: (
    request: LiteratureCatalogSearchRequest,
    isCurrent?: () => boolean
  ) => Promise<Page>
  readLiteratureJobPages: (result: LiteratureJobsResult) => Promise<LiteratureJobsResult>
  readLiteratureRecord: (itemId: string) => Promise<string>
  readMatchingCandidateIds: (
    wanted: ReadonlySet<string>,
    inboxState: 'pending' | 'dismissed',
    isActive?: () => boolean
  ) => Promise<Set<string>>
}

export function createLiteratureClient<Page extends LibraryPage>(
  api: LibraryClientApi<Page>
): LiteratureClient<Page> {
  // Transport pages may be smaller than the user's selected display page. Assemble that logical
  // page before publishing it, so a byte boundary cannot skip references in numbered navigation.
  async function readLiteratureDisplayPage(
    request: LiteratureCatalogSearchRequest,
    isCurrent: () => boolean = () => true,
    recoverOversized = false
  ): Promise<Page> {
    const read = recoverOversized ? readSelectionTransportPage : api.search
    const first = await read(request)
    if (
      (request.scope !== 'library' && request.scope !== 'global-search') ||
      request.allItemIds ||
      request.countOnly
    )
      return first
    const entries = [...first.entries]
    const limit = request.limit ?? 50
    let nextOffset = first.nextOffset
    let offset = request.offset ?? 0
    while (nextOffset !== undefined && entries.length < limit && isCurrent()) {
      if (nextOffset <= offset) throw new Error('Literature pagination did not advance.')
      offset = nextOffset
      const page = await read({
        ...request,
        offset,
        limit: limit - entries.length
      })
      entries.push(...page.entries)
      nextOffset = page.nextOffset
    }
    return { ...first, entries, nextOffset }
  }

  // Selection consumers retain complete metadata snapshots. Recover exceptional records through
  // the existing digest-checked chunk transfer instead of substituting a partial item.
  async function readLiteratureSelectionPage(
    request: LiteratureCatalogSearchRequest,
    isCurrent: () => boolean = () => true
  ): Promise<Page> {
    return readLiteratureDisplayPage(request, isCurrent, true)
  }

  async function readSelectionTransportPage(
    request: LiteratureCatalogSearchRequest
  ): Promise<Page> {
    try {
      return await api.search(request)
    } catch (error) {
      const itemId = oversizedLiteratureReference(error)
      if (
        !itemId ||
        (request.scope !== 'library' && request.scope !== 'global-search') ||
        request.allItemIds ||
        request.countOnly
      )
        throw error
      const item = literatureItemViewSchema.parse(JSON.parse(await readLiteratureRecord(itemId)))
      if (item.id !== itemId) throw new Error('Reference changed while reading search results.')
      const { totalCount } = await api.search({ ...request, countOnly: true })
      if (totalCount === undefined) throw new Error('Literature count is unavailable.')
      const next = (request.offset ?? 0) + 1
      return {
        entries: [item],
        totalCount,
        nextOffset: next < totalCount ? next : undefined
      } as Page
    }
  }

  async function readLiteratureJobPages(
    result: LiteratureJobsResult
  ): Promise<LiteratureJobsResult> {
    const first = result.jobs[0]
    if (!first || first.nextRowOffset === undefined) return result
    const rows = [...first.rows]
    let offset = first.rowOffset ?? 0
    let next: number | undefined = first.nextRowOffset
    while (next !== undefined) {
      if (next <= offset) throw new Error('Literature task pagination did not advance.')
      offset = next
      const page = await api.jobs({
        action: 'get',
        jobId: first.id,
        rowOffset: offset,
        expectedUpdatedAt: first.updatedAt
      })
      const job = page.jobs[0]
      if (!job || job.updatedAt !== first.updatedAt || job.rowOffset !== offset)
        throw new Error('Literature task changed while reading its results. Try again.')
      rows.push(...job.rows)
      next = job.nextRowOffset
    }
    if (rows.length !== first.totalRows || new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error('Literature task results are incomplete.')
    return { ...result, jobs: [{ ...first, rows, nextRowOffset: undefined }] }
  }

  async function readLiteratureRecord(itemId: string): Promise<string> {
    const chunks: string[] = []
    let offset = 0
    let digest: string | undefined
    for (;;) {
      const result = await api.exportRecord({ itemId, offset, digest })
      if (digest && result.digest !== digest) throw new Error('Reference changed during export.')
      digest = result.digest
      chunks.push(result.chunk)
      if (result.nextOffset === undefined) break
      if (result.nextOffset <= offset) throw new Error('Reference export did not advance.')
      offset = result.nextOffset
    }
    return chunks.join('')
  }

  /** Read current catalog authority after an uncertain candidate transaction receipt. */
  async function readMatchingCandidateIds(
    wanted: ReadonlySet<string>,
    inboxState: 'pending' | 'dismissed',
    isActive: () => boolean = () => true
  ): Promise<Set<string>> {
    const matching = new Set<string>()
    let offset = 0
    while (isActive()) {
      const page = await api.search({
        scope: 'inbox',
        inboxState,
        limit: 100,
        offset
      })
      for (const entry of page.entries) {
        if (
          'candidate' in entry &&
          'state' in entry &&
          'id' in entry &&
          typeof entry.id === 'string' &&
          wanted.has(entry.id)
        )
          matching.add(entry.id)
      }
      if (matching.size === wanted.size || page.nextOffset === undefined) return matching
      if (page.nextOffset <= offset) throw new Error('Inbox pagination did not advance.')
      offset = page.nextOffset
    }
    // An abandoned read cannot authorize discarding an Undo entry.
    throw new Error('Inbox reconciliation was cancelled.')
  }

  return {
    readLiteratureDisplayPage,
    readLiteratureSelectionPage,
    readLiteratureJobPages,
    readLiteratureRecord,
    readMatchingCandidateIds
  }
}
