import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Papa from 'papaparse'
import { unzipSync } from 'fflate'
import { publishUserFile, type PublishUserFileOptions } from '../../user-file-publisher'
import { publishNoReplace } from '../../uploads/atomic-no-replace-publisher'
import type { ToolContext } from '../types'

export const BASE = 'https://rnasysu.com/encori'
export const REFERENCE = `${BASE}/api/ref/ENCORI_referenceData.zip`
export { type Args } from './runtime'
import { EncoriError, failure, MAX_BYTES, receive, readBytes, success, type Args } from './runtime'

// Check cancellation at each publication commit path, including volumes without hard links.
// Atomic publication already in progress cannot be undone by a later cancellation.
export function publicationOptions(signal?: AbortSignal): PublishUserFileOptions {
  return {
    exclusive: true,
    validateDestination: async () => signal?.throwIfAborted(),
    linkFile: async (source, destination) => {
      signal?.throwIfAborted()
      await link(source, destination)
    },
    copyFileExclusive: async (source, destination) => {
      signal?.throwIfAborted()
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      signal?.throwIfAborted()
    },
    publishNoReplace: async (source, destination) => {
      signal?.throwIfAborted()
      const directory = dirname(destination)
      publishNoReplace(directory, directory, basename(source), basename(destination))
    }
  }
}

export async function outputDirectory(value: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const path =
    typeof value === 'string' && value.trim()
      ? resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
      : join(homedir(), 'OpenScienceConnectorData', 'encori')
  await mkdir(path, { recursive: true })
  signal?.throwIfAborted()
  return path
}

export async function saveRaw(
  raw: Uint8Array,
  endpoint: string,
  directory: unknown,
  signal?: AbortSignal
): Promise<string> {
  const path = join(
    await outputDirectory(directory, signal),
    `${Date.now()}_${endpoint}_${randomUUID()}_official.txt`
  )
  signal?.throwIfAborted()
  await publishUserFile(
    path,
    (temporary) => writeFile(temporary, raw, { flag: 'wx', signal }),
    publicationOptions(signal)
  )
  return path
}

export function checkBody(text: string): void {
  const sample = text.slice(0, 5000)
  if (
    /parameter\s+haven.?t\s+been\s+set\s+correctly|input\s+of\s+.+?parameter\s+is\s+not\s+available/i.test(
      sample
    )
  ) {
    throw new EncoriError(
      'upstream_parameter_error',
      'Official response rejects the supplied parameters.',
      false,
      200
    )
  }
  if (
    /^\s*(?:fatal\s+error|warning\s*:)|<b>(?:Warning|Fatal error)<\/b>|Unable to open file!|^\s*<!doctype\s+html|^\s*<html/i.test(
      sample
    )
  ) {
    throw new EncoriError(
      'upstream_response_error',
      'Official service returned an error page instead of data. Changing query filters is not a recovery step.',
      false,
      200
    )
  }
}

export function parseTable(
  text: string,
  tableName?: string
): {
  columns: string[]
  citation_lines: string[]
  records: Args[]
} {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
  const citation_lines: string[] = []
  while (lines[0]?.trimStart().startsWith('#')) citation_lines.push(lines.shift()!.trim())
  if (!lines.length) throw new Error('ENCORI unexpected_response: missing table header.')
  const parsed = Papa.parse<string[]>(lines.join('\n'), { delimiter: '\t', skipEmptyLines: true })
  if (parsed.errors.length) throw new Error('ENCORI unexpected_response: invalid TSV.')
  const rows = parsed.data
  let columns = rows[0]
  if (columns.length < 2)
    throw new Error('ENCORI unexpected_response: missing tab-delimited header.')
  const knownHeaders = [
    'DataSetId',
    'Species',
    'miRfamilyID',
    'miRfamily',
    'miRNAnum',
    'miRNAcat',
    'Assembly'
  ]
  if (tableName && !columns.some((value) => knownHeaders.includes(value))) {
    if (tableName.endsWith('/degradome_ref.txt'))
      columns = ['dataset_id', 'species', 'assembly', 'seq_type', 'cell_tissue']
    else if (tableName.endsWith('_all_miRNA.txt')) columns = ['mirbase_id', 'mirna_name']
    else if (tableName.includes('fimaly'))
      columns = ['mir_family_id', 'mir_family', 'mirna_count', 'mirna_list']
    else columns = columns.map((_, i) => `column_${i + 1}`)
  } else rows.shift()
  const records = rows.map((row) => ({
    ...Object.fromEntries(columns.map((column, i) => [column, row[i] ?? null])),
    ...(row.length > columns.length ? { __extra_values__: row.slice(columns.length) } : {})
  }))
  return { columns, citation_lines, records }
}

function resultRows(
  url: string,
  parsed: ReturnType<typeof parseTable>,
  max: number,
  rawPath: string | null,
  warnings: string[] = []
): Args {
  const complete = parsed.records.length <= max
  if (!complete)
    warnings.push(
      'The displayed rows are a preview. Read raw_response_path before making claims about the complete result distribution.'
    )
  return {
    ...success(url),
    columns: parsed.columns,
    citation_lines: parsed.citation_lines,
    records: parsed.records.slice(0, max),
    total_records: parsed.records.length,
    returned_records: Math.min(max, parsed.records.length),
    is_complete: complete,
    result_scope: complete ? 'complete' : 'partial',
    raw_response_path: rawPath,
    completeness_note: rawPath
      ? 'total_records counts data rows in this official response. The unmodified full response is saved locally.'
      : 'All rows of the selected reference table are returned. No local file was saved.',
    warnings
  }
}

export async function query(
  ctx: ToolContext,
  args: Args,
  endpoint: string,
  mapping: Record<string, string>
): Promise<Args> {
  const params = Object.fromEntries(
    Object.entries(mapping).map(([key, upstream]) => [upstream, String(args[key]).trim()])
  )
  if (endpoint === 'miRNATarget') {
    const programs = params.program.split(',').map((value) => value.trim())
    if (
      programs.some(
        (value) =>
          !['PITA', 'RNA22', 'miRmap', 'DIANA-microT', 'miRanda', 'PicTar', 'TargetScan'].includes(
            value
          )
      )
    ) {
      throw new Error(
        'ENCORI invalid_arguments: program must contain supported prediction programs; all is not supported.'
      )
    }
    params.program = programs.join(',')
  }
  if (endpoint === 'RBPMotifScan') params.motif = params.motif.toUpperCase()
  const url = `${BASE}/api/${endpoint}/?${new URLSearchParams(params)}`
  try {
    const raw = await receive(url, ctx, {}, readBytes)
    const text = new TextDecoder().decode(raw)
    checkBody(text)
    // Save before parsing, so malformed upstream data still has an exact local copy.
    const path = await saveRaw(raw, endpoint, args.output_dir, ctx.signal)
    if (endpoint === 'bindingSite') {
      const records: Args[] = [],
        removed: string[] = [],
        citations: string[] = []
      const columns = ['chromosome', 'start', 'end', 'name', 'score', 'strand']
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        if (line.trimStart().startsWith('#')) {
          citations.push(line.trim())
          continue
        }
        if (/^[^\t]+\t\d+\t\d+\t[^\t]+\t[^\t]+\t[+\-.](?:\t.*)?$/.test(line)) {
          const values = line.split('\t')
          records.push({
            ...Object.fromEntries(columns.map((key, i) => [key, values[i]])),
            ...(values.length > 6 ? { extra_values: values.slice(6) } : {})
          })
        } else if (
          !records.length &&
          /^\s*(?:SELECT\s|FROM\s|WHERE\s|AND\s|ORDER BY\s|LIMIT\s)/i.test(line)
        )
          removed.push(line)
        else
          throw new Error(
            `ENCORI unexpected_response: invalid BED row; official response saved at ${path}`
          )
      }
      if (!records.length)
        throw new Error(
          `ENCORI unexpected_response: no valid BED rows; official response saved at ${path}`
        )
      return {
        ...resultRows(
          url,
          { columns, records, citation_lines: citations },
          Number(args.max_records ?? 100),
          path,
          removed.length
            ? ['Known SQL prefix removed from parsed BED only; raw_response_path is unmodified.']
            : []
        ),
        query: params,
        removed_prefix_lines: removed
      }
    }
    const parsed = parseTable(text)
    const warnings: string[] = []
    if (
      endpoint === 'ceRNA' &&
      parsed.records.some(
        (row) =>
          String(row.hitMiRNAFamilyNum ?? '0') !== '0' && !String(row.hitMiRNAFamily ?? '').trim()
      )
    ) {
      warnings.push(
        'Official results provide family counts without family names. No family names have been inferred.'
      )
    }
    if (endpoint === 'RBPMotifScan')
      warnings.push(
        'QueryMotif and IdentifiedMotif are independent official fields. No reverse complement or sequence transformation was performed; do not infer that relationship.'
      )
    return {
      ...resultRows(url, parsed, Number(args.max_records ?? 20), path, warnings),
      query: params
    }
  } catch (error) {
    ctx.signal?.throwIfAborted()
    throw failure(error, url)
  }
}

export async function references(ctx: ToolContext, args: Args): Promise<Args> {
  try {
    const raw = await receive(REFERENCE, ctx, {}, readBytes)
    ctx.signal?.throwIfAborted()
    const selected = args.table_name ? String(args.table_name) : null
    const entries: Array<{ name: string; size: number }> = []
    // Read central-directory metadata for every table, but decompress only the selected one.
    const archive = unzipSync(raw, {
      filter: (entry) => {
        ctx.signal?.throwIfAborted()
        if (entry.name.endsWith('/')) return false
        entries.push({ name: entry.name, size: entry.originalSize })
        if (entry.name !== selected) return false
        if (entry.originalSize > MAX_BYTES)
          throw new EncoriError(
            'response_too_large',
            'Selected reference table exceeds the size limit.'
          )
        return true
      }
    })
    const names = entries.map((entry) => entry.name)
    const files = entries.map(({ name, size }) => ({
      table_name: name,
      size_bytes: size,
      purpose: name.endsWith('degradome_ref.txt')
        ? 'Degradome datasets, species, assemblies and cell/tissue references'
        : name.endsWith('_all_miRNA.txt')
          ? 'miRNA identifiers and names'
          : name.includes('fimaly')
            ? 'miRNA families and member lists'
            : 'Official reference table; inspect its columns to determine its contents'
    }))
    if (!args.table_name)
      return {
        ...success(REFERENCE),
        files,
        table_names: names,
        returned_files: files.length,
        selected_table: null,
        records: [],
        total_records: 0,
        returned_records: 0,
        is_complete: true,
        result_scope: 'complete',
        raw_response_path: null,
        warnings: []
      }
    const name = String(args.table_name)
    if (!Object.hasOwn(archive, name))
      throw new Error(
        'ENCORI invalid_arguments: table_name must exactly match an official reference table.'
      )
    const content = archive[name]
    const text = new TextDecoder().decode(content)
    checkBody(text)
    const parsed = parseTable(text, name)
    const max = Number(args.max_records ?? 50)
    const path =
      parsed.records.length > max
        ? await saveRaw(content, 'reference', args.output_dir, ctx.signal)
        : null
    return {
      ...resultRows(REFERENCE, parsed, max, path),
      files,
      table_names: names,
      returned_files: files.length,
      selected_table: name,
      saved_path: path
    }
  } catch (error) {
    ctx.signal?.throwIfAborted()
    throw failure(error, REFERENCE)
  }
}
