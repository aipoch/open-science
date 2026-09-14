import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { WasmCitationEngine } from 'citeme-engine-wasm'
import { z } from 'zod'

import {
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CITATION_STYLES,
  LITERATURE_RECORD_IMPORT_MAX_RECORDS,
  type LiteratureCitationLocale,
  type LiteratureCitationStyle,
  type LiteratureItemInput,
  type LiteratureRecordImportEntry,
  type LiteratureRecordImportFormat
} from '../../shared/literature'
import { fromCslItem, toCslItem } from '../../shared/literature-csl'
import { exportRisFields, importRisFields, normalizeBibtexEntry } from './citation-exchange'
import {
  citationResourceDirectory,
  type LiteratureCitationStyleLibrary
} from './citation-style-library'

const require = createRequire(import.meta.url)

// Keep imported keys and the established LaTeX fallback stable across export paths.
const citationKey = (id: string, item: LiteratureItemInput): string => {
  const stored = item.citationKey?.trim()
  if (stored && /^[A-Za-z0-9][A-Za-z0-9_:.+-]{0,127}$/u.test(stored)) return stored
  return id
}

type CitationOutputFormat = 'bibtex' | 'ris'
type FormattedReference = Readonly<{ itemId: string; reference: string; inText: string }>
type CitationReference = Readonly<{ id: string; item: LiteratureItemInput }>
type CitationImportError = Readonly<{ preview: string; error: string }>
type ParsedCitationRecords = Readonly<{
  format: LiteratureRecordImportFormat
  items: LiteratureItemInput[]
  errors: CitationImportError[]
  warnings?: LiteratureRecordImportEntry['warnings'][]
  truncated: boolean
  scannedEntries: number
}>

type NbibRecord = Array<{ field: string; value: string }>

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

const nbibValues = (record: NbibRecord, field: string): string[] =>
  record.filter((entry) => entry.field === field).map(({ value }) => value)
const nbibText = (record: NbibRecord, field: string): string =>
  nbibValues(record, field).join(' ').replace(/\s+/gu, ' ').trim()

const parseNbibRecords = (input: string): NbibRecord[] | undefined => {
  if (!/^PMID\s*-\s*\S+/mu.test(input)) return undefined
  const records: NbibRecord[] = []
  let record: NbibRecord | undefined
  for (const line of input.replaceAll('\r\n', '\n').split('\n')) {
    const field = /^([A-Z0-9]{2,4})\s*-\s*(.*)$/u.exec(line)
    if (field) {
      const [, name, value] = field
      if (name === 'PMID' && record?.length) {
        records.push(record)
        record = []
      }
      record ??= []
      record.push({ field: name!, value: value!.trim() })
      continue
    }
    const continuation = /^\s{2,}(\S.*)$/u.exec(line)
    const previous = record?.at(-1)
    if (continuation && previous) previous.value = `${previous.value} ${continuation[1]}`.trim()
  }
  if (record?.length) records.push(record)
  return records
}

const nbibCreators = (
  record: NbibRecord
): {
  creators: LiteratureItemInput['creators']
  uncertain: string[]
} => {
  const authors = record.filter(({ field }) => ['FAU', 'AU', 'CN'].includes(field))
  const creators: LiteratureItemInput['creators'] = []
  const uncertain: string[] = []
  for (let index = 0; index < authors.length; index += 1) {
    let { field, value } = authors[index]!
    if (field === 'CN') {
      creators.push({ nameMode: 'organization', literalName: value, creatorType: 'author' })
      continue
    }
    // MEDLINE emits FAU followed by AU for the same person. Pair locally, never
    // deduplicate all names: two different authors can have identical initials.
    const next = authors[index + 1]
    const full = field === 'FAU' ? value : next?.field === 'FAU' ? next.value : undefined
    const short = field === 'AU' ? value : next?.field === 'AU' ? next.value : undefined
    const family = full?.split(',')[0]?.trim()
    const abbreviatedFamily = short
      ? /^(.*?)\s+[A-Z]+(?:\s+(?:Jr|Sr|II|III|IV))?$/u.exec(short)?.[1]
      : undefined
    const fullInitials = full
      ?.split(',')[1]
      ?.trim()
      .replace(/\s+(?:Jr|Sr|II|III|IV)$/u, '')
      .match(/\p{L}+/gu)
      ?.map((part) => part[0].toUpperCase())
      .join('')
    const shortInitials = short
      ? /\s+([A-Z]+)(?:\s+(?:Jr|Sr|II|III|IV))?$/u.exec(short)?.[1]
      : undefined
    if (
      next &&
      full?.includes(',') &&
      family === abbreviatedFamily &&
      fullInitials === shortInitials
    ) {
      if (field === 'AU') ({ field, value } = next)
      index += 1
    }
    const comma = value.indexOf(',')
    const abbreviated =
      field === 'AU' ? /^(.*?)\s+([A-Z]+(?:\s+(?:Jr|Sr|II|III|IV))?)$/u.exec(value) : null
    const familyName = comma >= 0 ? value.slice(0, comma).trim() : (abbreviated?.[1] ?? value)
    const givenName =
      comma >= 0
        ? value.slice(comma + 1).trim()
        : (abbreviated?.[2]?.replace(/^[A-Z]+/u, (initials) =>
            [...initials].map((initial) => `${initial}.`).join(' ')
          ) ?? '')
    if (comma < 0 && !abbreviated) uncertain.push(`${field} - ${value}`)
    creators.push({ nameMode: 'person', familyName, givenName, creatorType: 'author' })
  }
  return { creators, uncertain }
}

const parseNbib = (input: string): ParsedCitationRecords | undefined => {
  const records = parseNbibRecords(input)
  if (!records) return undefined
  const limited = records.slice(0, LITERATURE_RECORD_IMPORT_MAX_RECORDS)
  const items: LiteratureItemInput[] = []
  const errors: CitationImportError[] = []
  const warnings: LiteratureRecordImportEntry['warnings'][] = []
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
    const authors = nbibCreators(record)
    warnings.push(authors.uncertain.length ? ['uncertain-author-name'] : [])
    items.push({
      itemType: publicationTypes.includes('preprint')
        ? 'preprint'
        : publicationTypes.includes('review')
          ? 'review'
          : 'journalArticle',
      title,
      abstract: nbibText(record, 'AB'),
      issuedText,
      issuedYear: /^\d{4}/u.test(issuedText) ? Number(issuedText.slice(0, 4)) : undefined,
      containerTitle: nbibText(record, 'JT') || nbibText(record, 'TA'),
      shortTitle: '',
      language: nbibText(record, 'LA'),
      rights: '',
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/` : '',
      extra: authors.uncertain.join('\n'),
      typeFields: {
        ...(nbibText(record, 'TA') ? { journalAbbreviation: nbibText(record, 'TA') } : {}),
        ...(nbibText(record, 'VI') ? { volume: nbibText(record, 'VI') } : {}),
        ...(nbibText(record, 'IP') ? { issue: nbibText(record, 'IP') } : {}),
        ...(nbibText(record, 'PG') ? { pages: nbibText(record, 'PG') } : {})
      },
      creators: authors.creators,
      identifiers
    })
  }
  return {
    format: 'nbib',
    warnings,
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
  const { createEngine, resultShapeVersion } = await import('citeme-engine-wasm')
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
    locale: LiteratureCitationLocale,
    output: 'plain' | 'html' = 'plain'
  ): Promise<FormattedReference[]> {
    const engine = await this.engine()
    const result = JSON.parse(
      engine.formatBatchWithOutput(
        JSON.stringify(references.map(({ id, item }) => toCslItem(id, item))),
        style,
        locale,
        false,
        output,
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
    if (format === 'ris') {
      return references
        .map(({ id, item }) => {
          const csl = toCslItem(id, item)
          return engine
            .exportRis(JSON.stringify([csl]))
            .replace(/^ER {2}-.*$/mu, () => `${exportRisFields(csl)}ER  - `)
        })
        .join('\n')
    }
    // The engine silently renames duplicate IDs in a batch. Export records independently so the
    // complete-output owner (Library export or LaTeX bundle) can reject collisions without renaming.
    return references
      .map(({ id, item }) => {
        const fallback = /^[A-Za-z0-9][A-Za-z0-9_:.+-]{0,127}$/u.test(id)
          ? id
          : `os${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
        const csl = toCslItem(citationKey(fallback, item), item)
        return engine
          .exportBibtex(
            JSON.stringify({
              ...csl,
              ...(csl.arXiv ? { custom: { eprint: { id: csl.arXiv, type: 'arxiv' } } } : {})
            })
          )
          .trim()
      })
      .join('\n\n')
  }

  async parseReferences(input: string): Promise<ParsedCitationRecords> {
    const nbib = parseNbib(input)
    if (nbib) return nbib
    const engine = await this.engine()
    let parsed = parseResultSchema.parse(
      JSON.parse(engine.parseAuto(input, LITERATURE_RECORD_IMPORT_MAX_RECORDS)) as unknown
    )
    if (parsed.format !== 'bibtex' && parsed.format !== 'ris') {
      throw new Error('Selected file must contain BibTeX or RIS references.')
    }
    const format = parsed.format
    if (format === 'ris') {
      // Parse each source record independently so rejected records cannot shift supplemental fields.
      const records = input
        .split(/(?=^[ \t]*TY[ \t]+-)/mu)
        .filter((record) => /^[ \t]*TY[ \t]+-/mu.test(record))
      const entries: Record<string, unknown>[] = []
      const recordErrors: CitationImportError[] = []
      for (const record of records.slice(0, LITERATURE_RECORD_IMPORT_MAX_RECORDS)) {
        const result = parseResultSchema.parse(JSON.parse(engine.parseAuto(record, 1)))
        recordErrors.push(...result.errors)
        for (const entry of result.entries) entries.push(importRisFields(record, entry))
      }
      parsed = { ...parsed, entries, errors: recordErrors }
    }
    const errors = [...parsed.errors]
    const items = parsed.entries.flatMap((entry) => {
      try {
        return [fromCslItem(format === 'bibtex' ? normalizeBibtexEntry(entry) : entry)]
      } catch (error) {
        errors.push({
          preview: String(entry.title ?? entry.id ?? '').slice(0, 160),
          error: error instanceof Error ? error.message : String(error)
        })
        return []
      }
    })
    return {
      format,
      items,
      errors,
      truncated: parsed.truncated,
      scannedEntries: parsed.scannedEntries
    }
  }
}

export { citationKey, LiteratureCitationFormatter }
export type {
  CitationImportError,
  CitationOutputFormat,
  CitationReference,
  FormattedReference,
  ParsedCitationRecords
}
