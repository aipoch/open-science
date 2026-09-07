import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createEngine, resultShapeVersion, type WasmCitationEngine } from 'citeme-engine-wasm'
import { z } from 'zod'

import {
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CITATION_STYLES,
  LITERATURE_RECORD_IMPORT_MAX_RECORDS,
  type LiteratureCitationLocale,
  type LiteratureCitationStyle,
  type LiteratureItemInput,
  type LiteratureRecordImportFormat
} from '../../shared/literature'
import { fromCslItem, toCslItem } from '../../shared/literature-csl'
import {
  citationResourceDirectory,
  type LiteratureCitationStyleLibrary
} from './citation-style-library'

const require = createRequire(import.meta.url)

type CitationOutputFormat = 'bibtex' | 'ris'
type FormattedReference = Readonly<{ itemId: string; reference: string; inText: string }>
type CitationReference = Readonly<{ id: string; item: LiteratureItemInput }>
type CitationImportError = Readonly<{ preview: string; error: string }>
type ParsedCitationRecords = Readonly<{
  format: LiteratureRecordImportFormat
  items: LiteratureItemInput[]
  errors: CitationImportError[]
  truncated: boolean
  scannedEntries: number
}>

type NbibRecord = Map<string, string[]>

const citationStyleExample: LiteratureItemInput = {
  itemType: 'journalArticle',
  title: 'Genome Editing in Human Cells',
  abstract: '',
  issuedText: '2024',
  issuedYear: 2024,
  containerTitle: 'Nature',
  shortTitle: '',
  language: 'en',
  rights: '',
  url: '',
  extra: '',
  typeFields: { volume: '1', issue: '2', pages: '10-20' },
  creators: [
    { nameMode: 'person', givenName: 'Alex', familyName: 'Rivera', creatorType: 'author' },
    { nameMode: 'person', givenName: 'Wei', familyName: 'Chen', creatorType: 'author' }
  ],
  identifiers: []
}

const nbibValues = (record: NbibRecord, field: string): string[] => record.get(field) ?? []
const nbibText = (record: NbibRecord, field: string): string =>
  nbibValues(record, field).join(' ').replace(/\s+/gu, ' ').trim()

const parseNbibRecords = (input: string): NbibRecord[] | undefined => {
  if (!/^PMID\s*-\s*\S+/mu.test(input)) return undefined
  const records: NbibRecord[] = []
  let record: NbibRecord | undefined
  let lastField: string | undefined
  for (const line of input.replaceAll('\r\n', '\n').split('\n')) {
    const field = /^([A-Z0-9]{2,4})\s*-\s*(.*)$/u.exec(line)
    if (field) {
      const [, name, value] = field
      if (name === 'PMID' && record?.size) {
        records.push(record)
        record = new Map()
      }
      record ??= new Map()
      const values = record.get(name!) ?? []
      values.push(value!.trim())
      record.set(name!, values)
      lastField = name
      continue
    }
    const continuation = /^\s{2,}(\S.*)$/u.exec(line)
    if (!continuation || !record || !lastField) continue
    const values = record.get(lastField)
    if (!values?.length) continue
    values[values.length - 1] = `${values.at(-1)} ${continuation[1]}`.trim()
  }
  if (record?.size) records.push(record)
  return records
}

const nbibCreator = (name: string): LiteratureItemInput['creators'][number] => {
  const comma = name.indexOf(',')
  if (comma < 0) {
    return { nameMode: 'organization', literalName: name.trim(), creatorType: 'author' }
  }
  return {
    nameMode: 'person',
    familyName: name.slice(0, comma).trim(),
    givenName: name.slice(comma + 1).trim(),
    creatorType: 'author'
  }
}

const parseNbib = (input: string): ParsedCitationRecords | undefined => {
  const records = parseNbibRecords(input)
  if (!records) return undefined
  const limited = records.slice(0, LITERATURE_RECORD_IMPORT_MAX_RECORDS)
  const items: LiteratureItemInput[] = []
  const errors: CitationImportError[] = []
  for (const record of limited) {
    const title = nbibText(record, 'TI')
    const pmid = nbibText(record, 'PMID')
    if (!title) {
      errors.push({ preview: pmid || 'PubMed record', error: 'PubMed record is missing a title.' })
      continue
    }
    const issuedText = nbibText(record, 'DP')
    const publicationTypes = nbibValues(record, 'PT').map((value) => value.toLowerCase())
    const doi = [...nbibValues(record, 'LID'), ...nbibValues(record, 'AID')]
      .map((value) => /^(.*?)\s+\[doi\]$/iu.exec(value)?.[1]?.trim())
      .find(Boolean)
    const pmcid = nbibText(record, 'PMC')
    const issn = nbibValues(record, 'IS')
      .map((value) => value.replace(/\s+\([^)]*\)\s*$/u, '').trim())
      .find(Boolean)
    const identifiers: LiteratureItemInput['identifiers'] = [
      ...(pmid ? [{ scheme: 'pmid' as const, value: pmid, isPrimary: true }] : []),
      ...(doi ? [{ scheme: 'doi' as const, value: doi, isPrimary: !pmid }] : []),
      ...(pmcid ? [{ scheme: 'pmcid' as const, value: pmcid, isPrimary: false }] : []),
      ...(issn ? [{ scheme: 'issn' as const, value: issn, isPrimary: false }] : [])
    ]
    items.push({
      itemType: publicationTypes.includes('review') ? 'review' : 'journalArticle',
      title,
      abstract: nbibText(record, 'AB'),
      issuedText,
      issuedYear: /^\d{4}/u.test(issuedText) ? Number(issuedText.slice(0, 4)) : undefined,
      containerTitle: nbibText(record, 'JT') || nbibText(record, 'TA'),
      shortTitle: nbibText(record, 'TA'),
      language: nbibText(record, 'LA'),
      rights: '',
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/` : '',
      extra: '',
      typeFields: {
        ...(nbibText(record, 'VI') ? { volume: nbibText(record, 'VI') } : {}),
        ...(nbibText(record, 'IP') ? { issue: nbibText(record, 'IP') } : {}),
        ...(nbibText(record, 'PG') ? { pages: nbibText(record, 'PG') } : {})
      },
      creators: (nbibValues(record, 'FAU').length
        ? nbibValues(record, 'FAU')
        : nbibValues(record, 'AU')
      ).map(nbibCreator),
      identifiers
    })
  }
  return {
    format: 'nbib',
    items,
    errors,
    truncated: records.length > limited.length,
    scannedEntries: records.length
  }
}

const formatResultSchema = z.object({ reference: z.string(), inText: z.string() }).strict()
const parseResultSchema = z
  .object({
    entries: z.array(z.record(z.string(), z.unknown())),
    errors: z.array(z.object({ preview: z.string(), error: z.string() }).strict()),
    format: z.string(),
    truncated: z.boolean(),
    scannedEntries: z.number().int().nonnegative()
  })
  .strict()

const loadEngine = async (
  styleLibrary?: LiteratureCitationStyleLibrary
): Promise<WasmCitationEngine> => {
  const wasmPath = require.resolve('citeme-engine-wasm/pkg/citeme_engine_wasm_bg.wasm')
  const engine = await createEngine(await readFile(wasmPath))
  if (resultShapeVersion() !== 1) throw new Error('Unsupported citation engine result shape.')

  const directory = citationResourceDirectory()
  const styles = styleLibrary
    ? await styleLibrary.sources()
    : await Promise.all(
        LITERATURE_CITATION_STYLES.map(async (styleId) => ({
          id: styleId,
          content: await readFile(join(directory, `${styleId}.csl`), 'utf8')
        }))
      )
  await Promise.all([
    ...styles.map(({ id, content }) => {
      try {
        engine.loadStyle(id, content)
      } catch (error) {
        // A broken imported style must not disable the other citation and import workflows.
        if (!id.startsWith('custom:')) throw error
      }
    }),
    ...LITERATURE_CITATION_LOCALES.map(async (locale) =>
      engine.loadLocale(locale, await readFile(join(directory, `locales-${locale}.xml`), 'utf8'))
    )
  ])
  return engine
}

class LiteratureCitationFormatter {
  private enginePromise: Promise<WasmCitationEngine> | undefined

  constructor(private readonly styleLibrary?: LiteratureCitationStyleLibrary) {}

  private engine(): Promise<WasmCitationEngine> {
    this.enginePromise ??= loadEngine(this.styleLibrary).catch((error) => {
      this.enginePromise = undefined
      throw error
    })
    return this.enginePromise
  }

  invalidateStyles(): void {
    this.enginePromise = undefined
  }

  async formatReferences(
    references: readonly CitationReference[],
    style: LiteratureCitationStyle,
    locale: LiteratureCitationLocale
  ): Promise<FormattedReference[]> {
    const engine = await this.engine()
    const result = JSON.parse(
      engine.formatBatchWithOutput(
        JSON.stringify(references.map(({ id, item }) => toCslItem(id, item))),
        style,
        locale,
        false,
        'plain',
        false
      )
    ) as unknown
    const formatted = z.array(formatResultSchema).parse(result)
    if (formatted.length !== references.length) {
      throw new Error('Citation engine returned an unexpected number of references.')
    }
    return references.map(({ id }, index) => ({ itemId: id, ...formatted[index]! }))
  }

  async formatStyleExample(
    style: LiteratureCitationStyle,
    locale: LiteratureCitationLocale = 'en-US'
  ): Promise<Readonly<{ inText: string; reference: string }>> {
    const [example] = await this.formatReferences(
      [{ id: 'citation-style-example', item: citationStyleExample }],
      style,
      locale
    )
    if (!example) throw new Error('Citation engine did not return a style example.')
    return { inText: example.inText, reference: example.reference }
  }

  async exportReferences(
    references: readonly CitationReference[],
    format: CitationOutputFormat
  ): Promise<string> {
    const engine = await this.engine()
    const input = JSON.stringify(references.map(({ id, item }) => toCslItem(id, item)))
    return format === 'bibtex' ? engine.exportBibtex(input) : engine.exportRis(input)
  }

  async parseReferences(input: string): Promise<ParsedCitationRecords> {
    const nbib = parseNbib(input)
    if (nbib) return nbib
    const engine = await this.engine()
    const parsed = parseResultSchema.parse(
      JSON.parse(engine.parseAuto(input, LITERATURE_RECORD_IMPORT_MAX_RECORDS)) as unknown
    )
    if (parsed.format !== 'bibtex' && parsed.format !== 'ris') {
      throw new Error('Selected file must contain BibTeX or RIS references.')
    }
    const errors = [...parsed.errors]
    const items = parsed.entries.flatMap((entry) => {
      try {
        return [fromCslItem(entry)]
      } catch (error) {
        errors.push({
          preview: String(entry.title ?? entry.id ?? '').slice(0, 160),
          error: error instanceof Error ? error.message : String(error)
        })
        return []
      }
    })
    return {
      format: parsed.format,
      items,
      errors,
      truncated: parsed.truncated,
      scannedEntries: parsed.scannedEntries
    }
  }
}

export { LiteratureCitationFormatter }
export type {
  CitationImportError,
  CitationOutputFormat,
  CitationReference,
  FormattedReference,
  ParsedCitationRecords
}
