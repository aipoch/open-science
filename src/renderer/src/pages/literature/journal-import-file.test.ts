import { expect, it } from 'vitest'
import {
  readJournalFile,
  journalColumns,
  suggestJournalHeader,
  suggestJournalSource,
  suggestJournalYear
} from './journal-import-file'
import { utils, write } from 'styled-exceljs'

const bytes = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer
it('reads independently invented headings, quotes and multiline values without a prescribed schema', async () => {
  const data = await readJournalFile(
    bytes(
      '\uFEFFPublication label,Print code,Appraisal,Editorial band\r\n"Invented, Planetary Review",1234-5679,<0.5,Gold\r\n"Imaginary\nMarine Annals",2345-6787,0,Silver'
    ),
    'fictional.csv'
  )
  expect(data.rows[1]).toEqual(['Invented, Planetary Review', '1234-5679', '<0.5', 'Gold'])
  expect(data.rows[2][0]).toBe('Imaginary\nMarine Annals')
  expect(journalColumns(data.rows, 0).map((column) => column.role)).toEqual([
    'name',
    'issn',
    'ignore',
    'ignore'
  ])
  expect(journalColumns(data.rows, 0)[2].field.kind).toBe('number')
})
it('suggests shifted headers and supports headerless input', async () => {
  const data = await readJournalFile(
    bytes(
      'Export note\n\nPublication label,Print code,Appraisal\nImaginary Sky Review,1234-5679,3'
    ),
    'original.csv'
  )
  expect(suggestJournalHeader(data.rows)).toBe(2)
  const noHeader = await readJournalFile(
    bytes('Imaginary Sky Review\t1234-5679\t3'),
    'original.tsv'
  )
  expect(suggestJournalHeader(noHeader.rows)).toBe(-1)
  expect(journalColumns(noHeader.rows, -1)[1].role).toBe('issn')
})
it('suggests editable import metadata without requiring a fixed schema', () => {
  const rows = [
    ['Publication label', 'Metric year', 'JIF'],
    ['Imaginary Sky Review', '2032', '3.4'],
    ['Imaginary Ocean Review', '2032', '2.1']
  ]
  expect(suggestJournalSource('imaginary-metrics-2032.csv')).toBe('imaginary metrics 2032')
  expect(suggestJournalYear(rows, 0, 'unknown-file.csv')).toBe('2032')
  expect(suggestJournalYear([['Journal label'], ['Imaginary Review']], 0, 'metrics-2033.csv')).toBe(
    '2033'
  )
})
it('suggests namespaced external identifier columns without requiring a fixed header', () => {
  const columns = journalColumns(
    [
      ['Journal label', 'JCR identifier', 'Scopus code', 'Metric'],
      ['Imaginary Review', 'fictional-417', 'fictional-902', '4.2']
    ],
    0
  )
  expect(columns.map(({ role }) => role)).toEqual(['name', 'externalId', 'externalId', 'ignore'])
  expect(columns[1].externalNamespace).toBe('jcr')
  expect(columns[2].externalNamespace).toBe('scopus')
})
it('infers common quartile formats as categorical attributes', () => {
  const columns = journalColumns(
    [
      ['Journal name', 'CAS quartile', 'Emerging quartile', 'JIF'],
      ['Imaginary Review', '1区', 'Q2', '3.2']
    ],
    0
  )
  expect(columns.map(({ role }) => role)).toEqual(['name', 'ignore', 'ignore', 'ignore'])
  expect(columns[1].field.kind).toBe('singleSelect')
  expect(columns[2].field.kind).toBe('singleSelect')
})
it('reads a selected XLSX sheet with cached cell values and preserves identifiers as text', async () => {
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Notes only']]), 'Notes')
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet([
      ['Periodical label', 'Serial code', 'Assessment'],
      ['Imaginary Ocean Review', '0123-4560', 0]
    ]),
    'Observations'
  )
  const encoded = write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const result = await readJournalFile(encoded, 'fictional.xlsx', 'Observations')
  expect(result.names).toEqual(['Notes', 'Observations'])
  expect(result.rows[1]).toEqual(['Imaginary Ocean Review', '0123-4560', '0'])
})
it('rejects malformed CSV and oversized cells instead of silently losing data', async () => {
  await expect(readJournalFile(bytes('"unclosed'), 'fictional.csv')).rejects.toThrow('malformed')
  await expect(readJournalFile(bytes('a'.repeat(8_001)), 'fictional.csv')).rejects.toThrow(
    'too long'
  )
  await expect(readJournalFile(bytes('anything'), 'fictional.xls')).rejects.toThrow('XLSX')
})

it('includes columns appearing after the sample and does not consume headerless journal data as headings', () => {
  const rows = Array.from({ length: 250 }, () => ['Imaginary Journal of Moonlight', '1234-5679'])
  rows[249].push('Silver')
  expect(suggestJournalHeader([['Imaginary Journal of Moonlight']])).toBe(-1)
  expect(suggestJournalHeader(rows)).toBe(-1)
  expect(journalColumns(rows, -1)).toHaveLength(3)
})

it('preserves Excel row and column positions when the used range starts after A1', async () => {
  const workbook = utils.book_new()
  const sheet = utils.aoa_to_sheet([])
  utils.sheet_add_aoa(
    sheet,
    [
      ['Publication label', 'Serial code', 'Signal'],
      ['Imaginary Offset Review', '1234-5679', 0]
    ],
    { origin: 'C4' }
  )
  sheet['!ref'] = 'C4:E5'
  utils.book_append_sheet(workbook, sheet, 'Offset')
  const data = await readJournalFile(
    write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    'offset.xlsx'
  )
  expect(suggestJournalHeader(data.rows)).toBe(3)
  expect(data.rows).toHaveLength(5)
  expect(data.rows[4]).toEqual(['', '', 'Imaginary Offset Review', '1234-5679', '0'])
  expect(journalColumns(data.rows, 3).map(({ role }) => role)).toEqual([
    'ignore',
    'ignore',
    'name',
    'issn',
    'ignore'
  ])
})

it('preserves the most descriptive name suggestion and stable ties in wide headerless sheets', () => {
  const rows = Array.from({ length: 200 }, (_, row) =>
    Array.from({ length: 128 }, (_, column) =>
      column === 80 || column === 81 ? `Imaginary Extensive Periodical ${row}` : `Code ${column}`
    )
  )
  const columns = journalColumns(rows, -1)
  expect(columns.filter(({ role }) => role === 'name').map(({ index }) => index)).toEqual([80])
})
