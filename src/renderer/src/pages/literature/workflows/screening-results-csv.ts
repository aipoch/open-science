import type {
  LiteratureCatalogSearchRequest,
  LiteratureCollectionView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type {
  SmartCollectionRow,
  SmartCollectionView
} from '@aipoch/literature-screening/contracts'
import type { LiteratureCatalogSearchPage } from '../../../../../shared/literature'

export class ScreeningExportChanged extends Error {}

export function screeningResultsFilename(name: string): string {
  const stem = name
    .normalize('NFKC')
    .trim()
    // eslint-disable-next-line no-control-regex -- Remove C0 controls from user-supplied filenames.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .slice(0, 60)
    .replace(/[\uD800-\uDBFF]$/u, '')
    .replace(/[. ]+$/u, '')
  return `${stem || 'collection'}-screening-results.csv`
}

type ExportItem = {
  id: string
  item: Pick<LiteratureItemView['item'], 'title' | 'identifiers' | 'issuedYear' | 'creators'>
}

type Snapshot = {
  collection: LiteratureCollectionView
  view: SmartCollectionView
  rows: SmartCollectionRow[]
  items: Map<string, ExportItem>
}

type Reader = {
  search(request: LiteratureCatalogSearchRequest): Promise<LiteratureCatalogSearchPage>
  // The shared selection client assembles transport pages and recovers oversized records.
  readItems(request: LiteratureCatalogSearchRequest): Promise<LiteratureCatalogSearchPage>
  readSmart(offset: number, summaryOnly?: boolean): Promise<SmartCollectionView | undefined>
  check(): void
}

const summaryKey = (view: SmartCollectionView): string =>
  JSON.stringify({ ...view, rows: undefined, nextOffset: undefined })

// This is a stable observed read window, not a database transaction. The caller also rejects
// change/recovery events until all bytes have been assembled and handed to the save operation.
export async function readScreeningExport(collectionId: string, reader: Reader): Promise<Snapshot> {
  const readCollection = async (): Promise<LiteratureCollectionView> => {
    let offset = 0
    for (;;) {
      reader.check()
      const page = await reader.search({ scope: 'collections', limit: 100, offset })
      reader.check()
      const entry = page.entries.find(
        (entry): entry is LiteratureCollectionView =>
          'itemCount' in entry && 'id' in entry && entry.id === collectionId
      )
      if (entry) {
        if (!entry.smart) throw new ScreeningExportChanged()
        return entry
      }
      if (page.nextOffset === undefined) throw new ScreeningExportChanged()
      if (page.nextOffset <= offset) throw new Error('Collection pagination did not advance.')
      offset = page.nextOffset
    }
  }
  const collection = await readCollection()
  const rows: SmartCollectionRow[] = []
  const ids = new Set<string>()
  let offset = 0
  let view: SmartCollectionView | undefined
  for (;;) {
    reader.check()
    const page = await reader.readSmart(offset)
    reader.check()
    if (!page || !page.sourceAvailable) throw new Error('Screening source is unavailable.')
    if (!view) view = page
    if (summaryKey(page) !== summaryKey(view)) throw new ScreeningExportChanged()
    for (const row of page.rows) {
      if (ids.has(row.id)) throw new ScreeningExportChanged()
      ids.add(row.id)
      rows.push(row)
    }
    if (rows.length > view.total) throw new ScreeningExportChanged()
    if (page.nextOffset === undefined) break
    if (!page.rows.length || page.nextOffset !== offset + page.rows.length)
      throw new ScreeningExportChanged()
    offset = page.nextOffset
  }
  if (rows.length !== view.total) throw new ScreeningExportChanged()

  const items = new Map<string, ExportItem>()
  for (let start = 0; start < rows.length; start += 100) {
    const itemIds = rows.slice(start, start + 100).map((row) => row.id)
    const wanted = new Set(itemIds)
    reader.check()
    const page = await reader.readItems({
      scope: 'library',
      lifecycle: 'active',
      itemIds,
      sortBy: 'title',
      sortDirection: 'asc',
      offset: 0,
      limit: 100
    })
    reader.check()
    if (
      page.nextOffset !== undefined ||
      (page.totalCount !== undefined && page.totalCount !== itemIds.length)
    )
      throw new ScreeningExportChanged()
    for (const entry of page.entries) {
      if (!('item' in entry) || !wanted.has(entry.id) || items.has(entry.id))
        throw new ScreeningExportChanged()
      // Retain only CSV inputs across batches; abstracts, attachments and notes are not exported.
      const { title, identifiers, issuedYear, creators } = entry.item
      items.set(entry.id, { id: entry.id, item: { title, identifiers, issuedYear, creators } })
    }
    if (itemIds.some((id) => !items.has(id))) throw new ScreeningExportChanged()
  }
  const finalView = await reader.readSmart(0, true)
  reader.check()
  if (!finalView || summaryKey(finalView) !== summaryKey(view)) throw new ScreeningExportChanged()
  const finalCollection = await readCollection()
  if (JSON.stringify(collection) !== JSON.stringify(finalCollection))
    throw new ScreeningExportChanged()
  reader.check()
  return { collection, view, rows, items }
}

function csvCell(value: string | number | boolean | undefined): string {
  let text = value === undefined ? '' : String(value)
  // Quote every field, and neutralize spreadsheet formulas even after leading whitespace/control
  // characters. Quoting alone does not prevent spreadsheet formula execution.
  // eslint-disable-next-line no-control-regex -- Detect formulas hidden behind whitespace or C0 controls.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`
  return `"${text.replace(/\r\n|\r|\n/g, '\r\n').replaceAll('"', '""')}"`
}

// Column names and enum values are stable technical identifiers. In particular, final_verdict
// includes manual overrides; the contract does not expose an independent original AI verdict.
export function screeningResultsCsv({ collection, view, rows, items }: Snapshot): string {
  const header = [
    'item_id',
    'title',
    'doi',
    'year',
    'authors',
    'final_verdict',
    'manual_decision',
    'decision_source',
    'assessment_current',
    'reason',
    'failure',
    'evidence_coverage',
    'page_start',
    'page_end',
    'evidence_filename',
    'evaluated_at',
    'model',
    'probability_match',
    'probability_no_match',
    'probability_uncertain',
    'rule_revision',
    'current_rule_revision',
    'assessment_rule',
    'collection_rule',
    'collection_id',
    'collection_name',
    'scope_kind',
    'scope_id',
    'evidence_mode'
  ]
  const records = rows.map((row) => {
    const record = items.get(row.id)
    if (!record) throw new Error('Screening metadata is incomplete.')
    const { item } = record
    const assessment = row.assessment
    const evidence = assessment?.evidence
    return [
      row.id,
      item.title,
      item.identifiers
        .filter(({ scheme }) => scheme === 'doi')
        .map(({ value }) => value)
        .join('; '),
      item.issuedYear,
      item.creators
        .filter(({ creatorType }) => creatorType === 'author')
        .map((creator) =>
          creator.nameMode === 'organization'
            ? creator.literalName
            : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
        )
        .join('; '),
      row.verdict,
      row.override,
      row.decisionSource,
      assessment?.current,
      row.reason,
      row.failure,
      evidence?.coverage,
      evidence?.passage?.pageStart,
      evidence?.passage?.pageEnd,
      evidence?.filename,
      assessment ? new Date(assessment.evaluatedAt).toISOString() : undefined,
      assessment?.model,
      assessment?.probabilities?.match,
      assessment?.probabilities?.['no-match'],
      assessment?.probabilities?.uncertain,
      assessment?.ruleRevision,
      view.ruleRevision,
      assessment?.rule,
      collection.description,
      collection.id,
      collection.name,
      view.scope.kind,
      view.scope.kind === 'library' ? undefined : view.scope.id,
      view.evidenceMode
    ]
  })
  return (
    '\uFEFF' + [header, ...records].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  )
}
