import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest
} from '../../../../shared/literature'
import type { LiteratureJobsResult } from '../../../../shared/literature-jobs'

// Transport pages may be smaller than the user's selected display page. Assemble that logical
// page before publishing it, so a byte boundary cannot skip references in numbered navigation.
export async function readLiteratureDisplayPage(
  request: LiteratureCatalogSearchRequest,
  isCurrent: () => boolean = () => true
): Promise<LiteratureCatalogSearchPage> {
  const first = await window.api.literature.search(request)
  if (request.scope !== 'library' || request.allItemIds) return first
  const entries = [...first.entries]
  const limit = request.limit ?? 50
  let nextOffset = first.nextOffset
  let offset = request.offset ?? 0
  while (nextOffset !== undefined && entries.length < limit && isCurrent()) {
    if (nextOffset <= offset) throw new Error('Literature pagination did not advance.')
    offset = nextOffset
    const page = await window.api.literature.search({
      ...request,
      offset,
      limit: limit - entries.length
    })
    entries.push(...page.entries)
    nextOffset = page.nextOffset
  }
  return { ...first, entries, nextOffset }
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

export async function downloadLiteratureRecord(itemId: string): Promise<void> {
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
  const data = new TextEncoder().encode(chunks.join(''))
  await window.api.saveBlobFile({
    suggestedName: 'reference.json',
    mimeType: 'application/json',
    data: data.buffer
  })
}
