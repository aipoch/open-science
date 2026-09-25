import type { ToolContext, ToolDescriptor } from '../types'

const ENRICHR_BASE = 'https://maayanlab.cloud'
const SPEEDRICHR_BASE = `${ENRICHR_BASE}/speedrichr/api`
const ORGANISMS = ['human', 'fly', 'yeast', 'worm', 'fish'] as const
type Organism = (typeof ORGANISMS)[number]
const ORGANISM_BASES: Record<Organism, string> = {
  human: `${ENRICHR_BASE}/Enrichr`,
  fly: `${ENRICHR_BASE}/FlyEnrichr`,
  yeast: `${ENRICHR_BASE}/YeastEnrichr`,
  worm: `${ENRICHR_BASE}/WormEnrichr`,
  fish: `${ENRICHR_BASE}/FishEnrichr`
}

type Dict = Record<string, unknown>
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })

const asRecord = (value: unknown, label: string): Dict => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Enrichr returned an invalid ${label} record`)
  }
  return value as Dict
}

const optionalFiniteNumber = (value: unknown, label: string): number | null => {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Enrichr library statistics contains an invalid ${label}`)
  }
  return value
}

const cleanList = (value: unknown, label: string, max: number): string[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  const values = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '' || hasControlCharacter(entry)) {
      throw new Error(`${label} must contain only non-empty strings`)
    }
    return entry.trim()
  })
  if (values.length === 0) throw new Error(`${label} must contain at least one value`)
  if (values.length > max) throw new Error(`${label} must contain at most ${max} values`)
  return values
}

const uniqueList = (value: unknown, label: string, max: number): string[] => [
  ...new Set(cleanList(value, label, max))
]

const optionalList = (value: unknown, label: string, max: number): string[] | null =>
  value == null ? null : uniqueList(value, label, max)

const organismId = (value: unknown): Organism => {
  const organism = typeof value === 'string' ? value.trim() : ''
  if (!ORGANISMS.includes(organism as Organism)) {
    throw new Error(`organism must be one of: ${ORGANISMS.join(', ')}`)
  }
  return organism as Organism
}

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  return body
}

function parseEnrichrJson(text: string): unknown {
  let normalized = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      normalized += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      normalized += character
      continue
    }
    const remainder = text.slice(index)
    if (remainder.startsWith('-Infinity')) {
      normalized += '"-Infinity"'
      index += '-Infinity'.length - 1
    } else if (remainder.startsWith('Infinity')) {
      normalized += '"Infinity"'
      index += 'Infinity'.length - 1
    } else if (remainder.startsWith('NaN')) {
      normalized += '"NaN"'
      index += 'NaN'.length - 1
    } else {
      normalized += character
    }
  }
  return JSON.parse(normalized)
}

const postEnrichrForm = async (ctx: ToolContext, url: string, body: FormData): Promise<unknown> =>
  ctx.postFormText
    ? parseEnrichrJson(await ctx.postFormText(url, body))
    : await ctx.postForm(url, body)

const postEnrichrUrlEncoded = async (
  ctx: ToolContext,
  url: string,
  body: URLSearchParams
): Promise<unknown> => {
  if (!ctx.postUrlEncodedText) {
    throw new Error('Connector runtime does not support URL-encoded Enrichr requests')
  }
  return parseEnrichrJson(await ctx.postUrlEncodedText(url, body))
}

const fetchEnrichrJson = async (ctx: ToolContext, url: string): Promise<unknown> =>
  parseEnrichrJson(await ctx.fetchText(url, 'application/json'))

const uploadedListId = (value: unknown): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new Error('Enrichr response has no valid userListId')
}

const uploadedBackgroundId = (value: unknown): number | string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '' && !hasControlCharacter(value)) {
    return value.trim()
  }
  throw new Error('Enrichr response has no valid backgroundid')
}

function uploadedList(raw: unknown): { userListId: number; shortId: string | null } {
  const response = asRecord(raw, 'gene-list upload')
  return {
    userListId: uploadedListId(response.userListId),
    shortId: typeof response.shortId === 'string' ? response.shortId : null
  }
}

function uploadedBackground(raw: unknown): number | string {
  const response = asRecord(raw, 'background upload')
  return uploadedBackgroundId(response.backgroundid ?? response.backgroundId)
}

function libraryRows(raw: unknown, library: string): unknown[][] {
  const response = asRecord(raw, `${library} enrichment`)
  const rows = response[library]
  if (!Array.isArray(rows)) {
    throw new Error(`Enrichr response has no result list for library ${library}`)
  }
  return rows.map((row, index) => {
    if (!Array.isArray(row)) {
      throw new Error(`Enrichr returned an invalid result row ${index + 1} for library ${library}`)
    }
    return row
  })
}

const numericValue = (
  value: unknown,
  label: string,
  library: string,
  row: number,
  allowNonFinite = false
): number | 'Infinity' | '-Infinity' | 'NaN' | null => {
  if (value == null) return null
  if (allowNonFinite && (value === 'Infinity' || value === '-Infinity' || value === 'NaN')) {
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Enrichr returned an invalid ${label} in row ${row} for library ${library}`)
  }
  return value
}

function normalizeRows(
  raw: unknown,
  library: string,
  maxResults: number
): { results: Array<Dict>; totalResults: number } {
  const rows = libraryRows(raw, library)
  const normalizedRows = rows.map((row, index) => {
    const rowNumber = index + 1
    if (row.length < 7) {
      throw new Error(
        `Enrichr returned an incomplete result row ${rowNumber} for library ${library}`
      )
    }
    if (typeof row[0] !== 'number' || !Number.isFinite(row[0])) {
      throw new Error(`Enrichr returned an invalid rank in row ${rowNumber} for library ${library}`)
    }
    if (typeof row[1] !== 'string') {
      throw new Error(`Enrichr returned an invalid term in row ${rowNumber} for library ${library}`)
    }
    if (!Array.isArray(row[5]) || row[5].some((gene) => typeof gene !== 'string')) {
      throw new Error(
        `Enrichr returned an invalid overlap list in row ${rowNumber} for library ${library}`
      )
    }
    return {
      rank: row[0],
      term: row[1],
      p_value: numericValue(row[2], 'p_value', library, rowNumber),
      odds_ratio: numericValue(row[3], 'odds_ratio', library, rowNumber, true),
      combined_score: numericValue(row[4], 'combined_score', library, rowNumber),
      overlapping_genes: row[5],
      adjusted_p_value: numericValue(row[6], 'adjusted_p_value', library, rowNumber),
      old_p_value: numericValue(row[7], 'old_p_value', library, rowNumber),
      old_adjusted_p_value: numericValue(row[8], 'old_adjusted_p_value', library, rowNumber)
    }
  })
  return { results: normalizedRows.slice(0, maxResults), totalResults: rows.length }
}

const stageError = (ctx: ToolContext, stage: string, error: unknown): Error => {
  if (ctx.signal?.aborted) {
    const reason = ctx.signal.reason
    if (reason instanceof Error) return reason
  }
  if (error instanceof Error && error.name === 'AbortError') return error
  return new Error(
    `Enrichr ${stage} failed: ${error instanceof Error ? error.message : String(error)}`
  )
}

export const GENES_ENRICHR_TOOLS: ToolDescriptor[] = [
  {
    id: 'list_enrichr_libraries',
    connector: 'genes',
    description:
      'List the current Enrichr gene-set libraries and their coverage statistics for one supported Enrichr deployment. The human deployment covers human and mouse libraries; other supported organisms use their dedicated deployments. Use this before enrich_gene_set_enrichr to select libraries for transcription-factor, perturbation, drug, disease, tissue, or cell-type analysis.',
    input: {
      type: 'object',
      properties: { organism: { type: 'string', enum: ORGANISMS, default: 'human' } },
      additionalProperties: false
    },
    required: [],
    returns:
      '{organism, n_libraries, libraries:[{name,gene_coverage,genes_per_term,num_terms,link,category_id,appyter}]}',
    example:
      'const result = await host.mcp("genes", "list_enrichr_libraries", {"organism": "human"})',
    totalTimeoutMs: 30_000,
    run: async (ctx: ToolContext, args) => {
      const organism = organismId(args.organism ?? 'human')
      const response = asRecord(
        await ctx.fetchJson(`${ORGANISM_BASES[organism]}/datasetStatistics`),
        'library statistics'
      )
      if (!Array.isArray(response.statistics)) {
        throw new Error('Enrichr library response has no statistics list')
      }
      const libraries = response.statistics.map((entry) => {
        const row = asRecord(entry, 'library statistics')
        if (
          typeof row.libraryName !== 'string' ||
          row.libraryName.trim() === '' ||
          hasControlCharacter(row.libraryName)
        ) {
          throw new Error('Enrichr library statistics contains an invalid libraryName')
        }
        return {
          name: row.libraryName.trim(),
          gene_coverage: optionalFiniteNumber(row.geneCoverage, 'geneCoverage'),
          genes_per_term: optionalFiniteNumber(row.genesPerTerm, 'genesPerTerm'),
          num_terms: optionalFiniteNumber(row.numTerms, 'numTerms'),
          link: typeof row.link === 'string' ? row.link : null,
          category_id: optionalFiniteNumber(row.categoryId, 'categoryId'),
          appyter: typeof row.appyter === 'string' ? row.appyter : null
        }
      })
      return { organism, n_libraries: libraries.length, libraries }
    }
  },
  {
    id: 'enrich_gene_set_enrichr',
    connector: 'genes',
    description:
      'Run Enrichr enrichment for gene symbols or identifiers accepted by selected Enrichr libraries. This complements g:Profiler with transcription-factor, perturbation, drug, disease, tissue, and cell-type libraries. A custom background uses the Speedrichr API and is currently supported only for the human deployment. Enrichr does not report unmapped identifiers, so mapping_status is always not_reported_by_enrichr. Gene lists are submitted to the external Enrichr service; uploads are temporary external side effects and are not automatically rolled back if a later library request fails.',
    input: {
      type: 'object',
      properties: {
        genes: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 5000
        },
        libraries: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 10
        },
        background_genes: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 20000
        },
        organism: { type: 'string', enum: ORGANISMS, default: 'human' },
        description: { type: 'string', minLength: 1, maxLength: 200 },
        max_results: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
      },
      required: ['genes', 'libraries'],
      additionalProperties: false
    },
    required: ['genes', 'libraries'],
    returns:
      '{tool, organism, mapping_status, n_input, n_unique_input, duplicate_genes, background_size, user_list_id, short_id, background_id, libraries:[{name,n_results,n_total_results,truncated,results:[{rank,term,p_value,odds_ratio:number|"Infinity"|"-Infinity"|"NaN"|null,combined_score,overlapping_genes,adjusted_p_value,old_p_value,old_adjusted_p_value}]}]}',
    example:
      'const result = await host.mcp("genes", "enrich_gene_set_enrichr", {"genes": ["TP53", "EGFR", "BRCA1"], "libraries": ["ChEA_2022", "LINCS_L1000_Chem_Pert_up"]})',
    totalTimeoutMs: 120_000,
    maxResponseBytes: 4_000_000,
    run: async (ctx: ToolContext, args) => {
      const inputGenes = cleanList(args.genes, 'genes', 5000)
      const genes = [...new Set(inputGenes)]
      const libraries = uniqueList(args.libraries, 'libraries', 10)
      const background = optionalList(args.background_genes, 'background_genes', 20000)
      const organism = organismId(args.organism ?? 'human')
      if (background && organism !== 'human') {
        throw new Error(
          'background_genes are currently supported only for the human Enrichr libraries'
        )
      }
      const description =
        typeof args.description === 'string' && args.description.trim() !== ''
          ? args.description.trim()
          : 'Open-Science gene-set enrichment'
      const maxResults =
        typeof args.max_results === 'number' && Number.isInteger(args.max_results)
          ? args.max_results
          : 100
      let uploaded: { userListId: number; shortId: string | null }
      try {
        uploaded = uploadedList(
          await postEnrichrForm(
            ctx,
            background ? `${SPEEDRICHR_BASE}/addList` : `${ORGANISM_BASES[organism]}/addList`,
            form({ list: genes.join('\n'), description })
          )
        )
      } catch (error) {
        throw stageError(ctx, 'gene-list upload', error)
      }
      let backgroundId: number | string | null = null
      if (background) {
        try {
          backgroundId = uploadedBackground(
            await postEnrichrUrlEncoded(
              ctx,
              `${SPEEDRICHR_BASE}/addbackground`,
              new URLSearchParams({ background: background.join('\n') })
            )
          )
        } catch (error) {
          throw stageError(ctx, 'background upload', error)
        }
      }
      const results = []
      for (const library of libraries) {
        try {
          const raw = backgroundId
            ? await postEnrichrUrlEncoded(
                ctx,
                `${SPEEDRICHR_BASE}/backgroundenrich`,
                new URLSearchParams({
                  userListId: String(uploaded.userListId),
                  backgroundid: String(backgroundId),
                  backgroundType: library
                })
              )
            : await fetchEnrichrJson(
                ctx,
                `${ORGANISM_BASES[organism]}/enrich?${new URLSearchParams({
                  userListId: String(uploaded.userListId),
                  backgroundType: library
                }).toString()}`
              )
          const normalized = normalizeRows(raw, library, maxResults)
          results.push({
            name: library,
            n_results: normalized.results.length,
            n_total_results: normalized.totalResults,
            truncated: normalized.totalResults > normalized.results.length,
            results: normalized.results
          })
        } catch (error) {
          throw stageError(ctx, `enrichment for library ${JSON.stringify(library)}`, error)
        }
      }
      return {
        tool: 'enrich_gene_set_enrichr',
        organism,
        mapping_status: 'not_reported_by_enrichr',
        input_genes: inputGenes,
        n_input: inputGenes.length,
        n_unique_input: genes.length,
        duplicate_genes: inputGenes.filter((gene, index) => inputGenes.indexOf(gene) !== index),
        background_size: background?.length ?? null,
        user_list_id: uploaded.userListId,
        short_id: uploaded.shortId,
        background_id: backgroundId,
        libraries: results
      }
    }
  }
]
