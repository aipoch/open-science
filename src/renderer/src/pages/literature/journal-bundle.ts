import {
  JOURNAL_IMPORT_MAX_BYTES,
  journalBundleSchema,
  type JournalBundle,
  type JournalDataset,
  type JournalImportRow,
  type JournalRequest,
  type JournalResult
} from '../../../../shared/journal-attributes'

type JournalApi = (request: JournalRequest) => Promise<JournalResult>
const checkCancelled = (cancelled: () => boolean): void => {
  if (cancelled()) throw new Error('Import cancelled')
}

export function readJournalBundle(bytes: ArrayBuffer): JournalBundle {
  if (bytes.byteLength > JOURNAL_IMPORT_MAX_BYTES) throw new Error('Journal import is too large.')
  return journalBundleSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
}

export async function exportJournalBundle(
  api: JournalApi,
  dataset: JournalDataset,
  cancelled: () => boolean
): Promise<Uint8Array<ArrayBuffer>> {
  const definition = {
    name: dataset.name,
    source: dataset.source,
    year: dataset.year,
    fields: dataset.fields.map(({ id, label, kind, colors, visible }) => ({
      id,
      label,
      kind,
      colors,
      visible
    }))
  }
  const encoder = new TextEncoder()
  const rows: JournalImportRow[] = []
  let bytes = encoder.encode(JSON.stringify(definition)).length
  let after: string | undefined
  let snapshot: string | undefined
  do {
    checkCancelled(cancelled)
    const { exportPage: page } = await api({
      action: 'export',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      after,
      snapshot
    })
    if (!page) throw new Error('Missing journal export page')
    snapshot = page.snapshot
    for (const row of page.rows) {
      const portable = { ...row, row: rows.length + 1 }
      bytes += encoder.encode(JSON.stringify(portable)).length + 1
      if (bytes > JOURNAL_IMPORT_MAX_BYTES) throw new Error('Journal import is too large.')
      rows.push(portable)
    }
    after = page.next
  } while (after)
  checkCancelled(cancelled)
  const bundle = journalBundleSchema.parse({
    format: 'open-science-journals',
    version: 1,
    dataset: definition,
    rows
  })
  const result = encoder.encode(JSON.stringify(bundle))
  if (result.byteLength > JOURNAL_IMPORT_MAX_BYTES) throw new Error('Journal import is too large.')
  return result
}

export async function importJournalBundle(
  api: JournalApi,
  bundle: JournalBundle,
  cancelled: () => boolean,
  onCommit: () => void = () => {}
): Promise<JournalResult> {
  checkCancelled(cancelled)
  const { token } = await api({ action: 'begin', definition: bundle.dataset, policy: 'fill' })
  if (!token) throw new Error('Missing journal import token')
  let committed = false
  try {
    let offset = 0
    while (offset < bundle.rows.length) {
      checkCancelled(cancelled)
      const rows: JournalImportRow[] = []
      let bytes = 0
      for (const row of bundle.rows.slice(offset, offset + 100)) {
        const size = new TextEncoder().encode(JSON.stringify(row)).length
        if (rows.length && bytes + size > 512 * 1024) break
        bytes += size
        rows.push(row)
      }
      await api({ action: 'append', token, offset, rows })
      offset += rows.length
    }
    checkCancelled(cancelled)
    const preview = await api({ action: 'preview', token, offset: 0 })
    if (preview.problems || preview.ready !== bundle.rows.length || !preview.digest)
      throw new Error('Journal bundle contains invalid or conflicting rows.')
    checkCancelled(cancelled)
    onCommit()
    const result = await api({
      action: 'commit',
      token,
      digest: preview.digest,
      skipProblems: false
    })
    committed = true
    return result
  } finally {
    if (!committed) await api({ action: 'discard', token }).catch(() => {})
  }
}
