import Papa from 'papaparse'
import { unzipSync } from 'fflate'
import {
  JOURNAL_IMPORT_MAX_BYTES,
  JOURNAL_IMPORT_MAX_ROWS,
  inferJournalFieldKind,
  missingJournalValue,
  normalizeIssn,
  type JournalField
} from '../../../../shared/journal-attributes'

export type JournalSheet = {
  names: string[]
  selected: string
  rows: string[][]
  /** Cached once during parsing so rendering never scans every imported row for its width. */
  width?: number
}
export type JournalColumn = {
  index: number
  label: string
  role: 'ignore' | 'name' | 'alias' | 'issn' | 'externalId' | 'attribute'
  externalNamespace?: string
  customExternalNamespace?: boolean
  field: JournalField
}
const MAX_CELLS = 2_000_000

export async function readJournalFile(
  bytes: ArrayBuffer,
  name: string,
  sheet?: string
): Promise<JournalSheet> {
  if (bytes.byteLength > JOURNAL_IMPORT_MAX_BYTES) throw new Error('Journal import is too large.')
  let rows: string[][] = []
  let names: string[] = []
  let selected = ''
  if (/\.xlsx$/i.test(name)) {
    let expanded = 0
    unzipSync(new Uint8Array(bytes), {
      filter: (entry) => {
        expanded += entry.originalSize
        if (expanded > 64 * 1024 * 1024) throw new Error('Journal import is too large.')
        return false
      }
    })
    const spreadsheet = await import('styled-exceljs')
    const workbook = spreadsheet.read(bytes, {
      type: 'array',
      cellFormula: false,
      cellHTML: false,
      cellText: true,
      bookVBA: false,
      dense: true
    })
    names = workbook.SheetNames
    selected = sheet ?? names[0]
    const worksheet = workbook.Sheets[selected]
    if (!worksheet) throw new Error('Select a worksheet containing journal data.')
    const range = spreadsheet.utils.decode_range(worksheet['!ref'] ?? 'A1')
    if (
      range.e.r >= JOURNAL_IMPORT_MAX_ROWS + 100 ||
      range.e.c >= 256 ||
      (range.e.r + 1) * (range.e.c + 1) > MAX_CELLS
    )
      throw new Error('Journal import is too large.')
    rows = spreadsheet.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      // Keep physical Excel coordinates for column mapping and preview row numbers.
      range: { s: { r: 0, c: 0 }, e: range.e },
      raw: false,
      defval: '',
      blankrows: true
    })
  } else if (/\.(csv|tsv|txt)$/i.test(name)) {
    let cells = 0
    Papa.parse<string[]>(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
      skipEmptyLines: false,
      step: (result, parser) => {
        cells += result.data.length
        if (
          rows.length >= JOURNAL_IMPORT_MAX_ROWS + 100 ||
          result.data.length > 256 ||
          cells > MAX_CELLS
        ) {
          parser.abort()
          throw new Error('Journal import is too large.')
        }
        if (result.errors.some((error) => error.code !== 'UndetectableDelimiter'))
          throw new Error('The journal file contains malformed rows.')
        rows.push(result.data)
      }
    })
  } else throw new Error('Choose an XLSX, CSV or TSV file.')
  rows = rows.map((row) => row.map((value) => String(value ?? '').trim()))
  if (rows.some((row) => row.some((value) => value.length > 8_000)))
    throw new Error('A journal cell is too long.')
  while (rows.length && !rows.at(-1)!.some(Boolean)) rows.pop()
  if (!rows.length) throw new Error('The journal file is empty.')
  return {
    rows,
    names,
    selected,
    width: rows.reduce((width, row) => Math.max(width, row.length), 0)
  }
}

export function suggestJournalHeader(rows: string[][]): number {
  const scores = rows
    .slice(0, 20)
    .map((row) =>
      row.some((value) => normalizeIssn(value))
        ? 0
        : row.filter((value) =>
            /^(?:(?:print |electronic |online |p-?|e-?)?issn|(?:journal|publication|periodical)(?: title| name| label)?|期刊(?:名称|名)?|刊名|revue|zeitschrift|revista)$/i.test(
              value
            )
          ).length
    )
  const best = Math.max(...scores)
  return best ? scores.indexOf(best) : -1
}

const yearFromValue = (value: string): string | undefined => {
  const match = value.match(/(?:^|\D)((?:18|19|20|21)\d{2})(?:$|\D)/)
  return match?.[1]
}

export function suggestJournalSource(fileName: string): string {
  const baseName =
    fileName
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.[^.]+$/u, '') ?? ''
  return baseName.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 100)
}

export function suggestJournalYear(rows: string[][], header: number, fileName = ''): string {
  const labels = header >= 0 ? (rows[header] ?? []) : []
  const candidates = labels
    .map((label, index) => ({
      index,
      label: label.toLocaleLowerCase(),
      values: rows
        .slice(header + 1, header + 21)
        .map((row) => yearFromValue(row[index] ?? ''))
        .filter((value): value is string => Boolean(value))
    }))
    .filter(({ values }) => values.length > 0)
    .sort((left, right) => {
      const score = (candidate: typeof left): number =>
        (/(?:metric|jcr|impact|quartile|ranking|year|年份|年度|年)/iu.test(candidate.label)
          ? 100
          : 0) + candidate.values.length
      return score(right) - score(left) || left.index - right.index
    })
  return (
    candidates[0]?.values[0] ?? fileName.match(/(?:^|\D)((?:18|19|20|21)\d{2})(?:$|\D)/)?.[1] ?? ''
  )
}

export function journalColumns(
  rows: string[][],
  header: number,
  cachedWidth?: number
): JournalColumn[] {
  const width = cachedWidth ?? rows.reduce((width, row) => Math.max(width, row.length), 0)
  const sample = rows.slice(header + 1, header + 201)
  let hasName = false
  const columns = Array.from({ length: width }, (_, index): JournalColumn => {
    const label = header >= 0 ? rows[header]?.[index] || '' : ''
    const values = sample
      .map((row) => row[index] ?? '')
      .filter((value) => !missingJournalValue(value))
    const issns = values.filter((value) => normalizeIssn(value)).length
    const externalNamespace =
      /(?:^|\b)(?:jcr|journal\s+citation\s+reports)(?:\s|[-_:])*(?:id|identifier|code|accession)?$/i.test(
        label
      ) ||
      /(?:id|identifier|code|accession)[\s_:.-]*(?:jcr|journal\s+citation\s+reports)/i.test(label)
        ? 'jcr'
        : /(?:^|\b)(?:web\s+of\s+science|wos)(?:\s|[-_:])*(?:id|identifier|code|accession)?$/i.test(
              label
            ) || /(?:id|identifier|code|accession)[\s_:.-]*(?:web\s+of\s+science|wos)/i.test(label)
          ? 'wos'
          : /(?:^|\b)scopus(?:\s|[-_:])*(?:id|identifier|code|accession)?$/i.test(label) ||
              /(?:id|identifier|code|accession)[\s_:.-]*scopus/i.test(label)
            ? 'scopus'
            : /(?:^|\b)nlm(?:\s|[-_:])*(?:id|identifier|code|accession|ta)?$/i.test(label) ||
                /(?:id|identifier|code|accession|ta)[\s_:.-]*nlm/i.test(label)
              ? 'nlm'
              : undefined
    const role = externalNamespace
      ? 'externalId'
      : /issn/i.test(label) || (values.length && issns / values.length > 0.8)
        ? 'issn'
        : /alias|abbrev|short|缩写|簡稱/i.test(label)
          ? 'alias'
          : !hasName &&
              /journal|publication|periodical|期刊|刊名|revue|zeitschrift|revista/i.test(label)
            ? 'name'
            : 'ignore'
    if (role === 'name') hasName = true
    return {
      index,
      label,
      role,
      ...(externalNamespace ? { externalNamespace } : {}),
      field: {
        id: crypto.randomUUID(),
        label: label.slice(0, 100),
        kind: inferJournalFieldKind(values),
        colors: {},
        visible: true
      }
    }
  })
  if (!hasName) {
    const candidates = columns
      .filter((column) => column.role === 'ignore' && column.field.kind === 'text')
      .map((column) => ({
        column,
        letters: sample.reduce(
          (sum, row) => sum + ((row[column.index] ?? '').match(/\p{L}/gu)?.length ?? 0),
          0
        )
      }))
    const candidate = candidates.sort((a, b) => b.letters - a.letters)[0]?.column
    if (candidate) candidate.role = 'name'
  }
  return columns
}
