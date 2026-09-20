import { literatureItemViewSchema } from '../../../../shared/literature'
import { oversizedLiteratureReference } from '../../../../shared/literature-export'
import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest
} from '../../../../shared/literature'
import type { LiteratureJobsResult } from '../../../../shared/literature-jobs'

// Transport pages may be smaller than the user's selected display page. Assemble that logical
// page before publishing it, so a byte boundary cannot skip references in numbered navigation.
export async function readLiteratureDisplayPage(
  request: LiteratureCatalogSearchRequest,
  isCurrent: () => boolean = () => true,
  recoverOversized = false
): Promise<LiteratureCatalogSearchPage> {
  const read = recoverOversized ? readSelectionTransportPage : window.api.literature.search
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
export async function readLiteratureSelectionPage(
  request: LiteratureCatalogSearchRequest,
  isCurrent: () => boolean = () => true
): Promise<LiteratureCatalogSearchPage> {
  return readLiteratureDisplayPage(request, isCurrent, true)
}

async function readSelectionTransportPage(
  request: LiteratureCatalogSearchRequest
): Promise<LiteratureCatalogSearchPage> {
  try {
    return await window.api.literature.search(request)
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
    const { totalCount } = await window.api.literature.search({ ...request, countOnly: true })
    if (totalCount === undefined) throw new Error('Literature count is unavailable.')
    const next = (request.offset ?? 0) + 1
    return { entries: [item], totalCount, nextOffset: next < totalCount ? next : undefined }
  }
}

export async function readLiteratureJobPages(
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
    const page = await window.api.literature.jobs({
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
    const result = await window.api.literature.exportRecord({ itemId, offset, digest })
    if (digest && result.digest !== digest) throw new Error('Reference changed during export.')
    digest = result.digest
    chunks.push(result.chunk)
    if (result.nextOffset === undefined) break
    if (result.nextOffset <= offset) throw new Error('Reference export did not advance.')
    offset = result.nextOffset
  }
  return chunks.join('')
}

export async function downloadLiteratureRecord(itemId: string): Promise<void> {
  const data = new TextEncoder().encode(await readLiteratureRecord(itemId))
  await window.api.saveBlobFile({
    suggestedName: 'reference.json',
    mimeType: 'application/json',
    data: data.buffer
  })
}
