import type { ToolContext, ToolDescriptor } from '../types'

// AlphaFold DB public prediction API (alphafold.ebi.ac.uk). Ported from the upstream
// `alphafold_structures` client/records. Verified live against P04637 (canonical + isoforms):
// model records are camelCase; the protein sequence lives under `uniprotSequence` (the older
// `sequence` key is accepted as a fallback). Status quirks (also verified live): a well-formed
// accession with no prediction answers HTTP 404 with `{}` -> has_model=false (not an error); a
// malformed identifier answers HTTP 400 with `{"error": ...}` -> explicit `error` field.
const AFDB_BASE = 'https://alphafold.ebi.ac.uk/api'

// Batch ceiling per coverage call (mirrors upstream MAX_IDS_PER_CALL): 40 unique accessions at the
// API's polite request rate stays inside the MCP transport budget.
const MAX_IDS_PER_CALL = 40

// Per-accession wall-clock budget for the batch: accessions not reached before it elapses are
// returned in `not_processed` rather than overrunning the transport limit.
const COVERAGE_DEADLINE_MS = 40_000

// One model record from GET /prediction/{accession} (a single accession can carry several:
// canonical + isoforms + community providers). Field names transcribed from the live API.
type AlphaFoldRawModel = {
  modelEntityId?: string
  entryId?: string
  providerId?: string
  toolUsed?: string
  uniprotAccession?: string
  uniprotId?: string
  uniprotDescription?: string
  gene?: string
  organismScientificName?: string
  taxId?: number
  isUniProtReviewed?: boolean
  isReferenceProteome?: boolean
  isComplex?: boolean
  sequence?: string
  uniprotSequence?: string
  uniprotStart?: number
  uniprotEnd?: number
  globalMetricValue?: number
  fractionPlddtVeryLow?: number
  fractionPlddtLow?: number
  fractionPlddtConfident?: number
  fractionPlddtVeryHigh?: number
  latestVersion?: number
  allVersions?: number[]
  modelCreatedDate?: string
  cifUrl?: string
  bcifUrl?: string
  pdbUrl?: string
  paeImageUrl?: string
  paeDocUrl?: string
  plddtDocUrl?: string
  msaUrl?: string
  amAnnotationsUrl?: string
}

// Output URL-block key -> raw model field (mirrors upstream _URL_FIELDS). Payloads are never
// downloaded; only URLs are surfaced.
const URL_FIELDS: ReadonlyArray<readonly [string, keyof AlphaFoldRawModel]> = [
  ['cif', 'cifUrl'],
  ['bcif', 'bcifUrl'],
  ['pdb', 'pdbUrl'],
  ['pae_image', 'paeImageUrl'],
  ['pae_json', 'paeDocUrl'],
  ['plddt_json', 'plddtDocUrl'],
  ['msa', 'msaUrl'],
  ['alphamissense_csv', 'amAnnotationsUrl']
]

// The live API serves the sequence under `uniprotSequence`; the older `sequence` key is a fallback.
function modelSequence(m: AlphaFoldRawModel): string | undefined {
  return m.uniprotSequence ?? m.sequence
}

// Full per-model record (mirrors upstream parse_model).
function parseModel(m: AlphaFoldRawModel, includeSequence: boolean): Record<string, unknown> {
  const seq = modelSequence(m)
  const urls: Record<string, string> = {}
  for (const [key, field] of URL_FIELDS) {
    const v = m[field]
    if (typeof v === 'string' && v) urls[key] = v
  }
  const record: Record<string, unknown> = {
    model_entity_id: m.modelEntityId,
    entry_id: m.entryId,
    provider_id: m.providerId,
    tool_used: m.toolUsed,
    uniprot_accession: m.uniprotAccession,
    uniprot_id: m.uniprotId,
    uniprot_description: m.uniprotDescription,
    gene: m.gene,
    organism_scientific_name: m.organismScientificName,
    tax_id: m.taxId,
    is_uniprot_reviewed: m.isUniProtReviewed,
    is_reference_proteome: m.isReferenceProteome,
    is_complex: m.isComplex,
    sequence_length: seq ? seq.length : null,
    uniprot_start: m.uniprotStart,
    uniprot_end: m.uniprotEnd,
    global_plddt: m.globalMetricValue,
    // Fraction of residues in each pLDDT confidence bin (very_low <50, low 50-70, confident
    // 70-90, very_high >90).
    fraction_plddt: {
      very_low: m.fractionPlddtVeryLow,
      low: m.fractionPlddtLow,
      confident: m.fractionPlddtConfident,
      very_high: m.fractionPlddtVeryHigh
    },
    latest_version: m.latestVersion,
    all_versions: m.allVersions ?? [],
    model_created_date: m.modelCreatedDate,
    urls
  }
  if (includeSequence) record.sequence = seq
  return record
}

// Classified outcome of one prediction GET: the model list, a benign no-prediction (404), or a
// malformed-identifier rejection (400). Transport/5xx errors are re-thrown, not classified.
type PredictionFetch =
  | { status: 'ok'; models: AlphaFoldRawModel[] }
  | { status: 'not_found' }
  | { status: 'invalid'; message: string }

// GET /prediction/{accession}, mapping the API's status quirks to a discriminated result. The
// engine surfaces non-ok responses as `Error("HTTP <status> for <url>")`; 404 and 400 are the
// documented AlphaFold cases and fail fast (not retried), so the status is recoverable from the
// message. Anything else (transport, retried 5xx) propagates.
async function getPrediction(ctx: ToolContext, accession: string): Promise<PredictionFetch> {
  try {
    const raw = await ctx.fetchJson(`${AFDB_BASE}/prediction/${encodeURIComponent(accession)}`)
    return { status: 'ok', models: Array.isArray(raw) ? (raw as AlphaFoldRawModel[]) : [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = Number(/HTTP (\d+)/.exec(message)?.[1])
    if (code === 404) return { status: 'not_found' }
    if (code === 400) return { status: 'invalid', message }
    throw err
  }
}

// AlphaFold DB predicted-structure lookups: full per-model records and a compact batch coverage
// triage. Both run-based (the 404/400 branching cannot be expressed as a declarative url+parse).
export const STRUCTURES_ALPHAFOLD_TOOLS: ToolDescriptor[] = [
  {
    id: 'alphafold_get_prediction',
    connector: 'structures',
    description:
      "AlphaFold DB predicted-structure metadata for one UniProt accession. Returns has_model, n_models and per-model records. A single accession can carry several models (canonical + isoforms like 'P04637-9', and community providers beyond the Google DeepMind monomer pipeline — provider_id / tool_used identify them). Each model: entry id, UniProt annotation (id, description, gene, organism, taxid, reviewed flags), sequence coordinates and length, global pLDDT (global_plddt, 0-100) plus the fraction of residues per pLDDT confidence bin (very_low <50, low 50-70, confident 70-90, very_high >90), model version info and creation date, and download URLs (cif/bcif/pdb coordinates, PAE JSON + image, per-residue pLDDT JSON, MSA, AlphaMissense CSV where available) — URLs only, payloads are never downloaded; fetch them yourself if needed. Accessions without a prediction return has_model=false (not an error); malformed identifiers return an explicit `error` field. include_sequence=true adds the model sequence (protein one-letter).",
    input: {
      type: 'object',
      properties: {
        uniprot_accession: { type: 'string' },
        include_sequence: { type: 'boolean', default: false }
      },
      required: ['uniprot_accession']
    },
    required: ['uniprot_accession'],
    returns:
      '`{ uniprot_accession, has_model, n_models, models:[{ model_entity_id, entry_id, provider_id, tool_used, uniprot_accession, uniprot_id, uniprot_description, gene, organism_scientific_name, tax_id, is_uniprot_reviewed, is_reference_proteome, is_complex, sequence_length, uniprot_start, uniprot_end, global_plddt, fraction_plddt:{very_low, low, confident, very_high}, latest_version, all_versions, model_created_date, urls:{cif, bcif, pdb, pae_image, pae_json, plddt_json, msa, alphamissense_csv}, sequence? }] }`. No prediction -> `{ uniprot_accession, has_model:false, n_models:0, models:[] }`; malformed accession -> same shape plus an `error` field. `urls` only carries the keys the API supplied.',
    example:
      'result = host.mcp("structures", "alphafold_get_prediction", {"uniprot_accession": "P04637"})',
    run: async (ctx, a) => {
      const accession = String(a.uniprot_accession).trim()
      const includeSequence = a.include_sequence === true
      const res = await getPrediction(ctx, accession)
      if (res.status === 'not_found') {
        return { uniprot_accession: accession, has_model: false, n_models: 0, models: [] }
      }
      if (res.status === 'invalid') {
        return {
          uniprot_accession: accession,
          has_model: false,
          n_models: 0,
          models: [],
          error: `invalid_accession: ${res.message}`
        }
      }
      const models = res.models.map((m) => parseModel(m, includeSequence))
      return {
        uniprot_accession: accession,
        has_model: models.length > 0,
        n_models: models.length,
        models
      }
    }
  },
  {
    id: 'alphafold_check_coverage',
    connector: 'structures',
    description:
      "Batch AlphaFold DB coverage check (max 40 unique UniProt accessions). Blank entries and duplicates are stripped before the batch cap applies, and disclosed: n_requested == n_unique + n_blank_skipped + n_duplicate_skipped always reconciles. One compact record per unique accession, in input order: has_model, n_models, and the primary (first-listed) model's model_entity_id, latest_version, global_plddt and sequence_length. Accessions with no prediction report has_model=false; malformed ones carry an explicit `error` field — never silently dropped. Use to triage which proteins of a set have usable predicted structures before pulling full records with alphafold_get_prediction.",
    input: {
      type: 'object',
      properties: {
        uniprot_accessions: { type: 'array', items: { type: 'string' } }
      },
      required: ['uniprot_accessions']
    },
    required: ['uniprot_accessions'],
    returns:
      '`{ n_requested, n_unique, n_blank_skipped, n_duplicate_skipped, not_processed:[...], records:[{ uniprot_accession, has_model, n_models?, model_entity_id?, latest_version?, global_plddt?, sequence_length? }] }`. n_requested == n_unique + n_blank_skipped + n_duplicate_skipped. No-prediction records carry `has_model:false`; malformed ones add an `error` field. `not_processed` holds accessions dropped for the per-call time budget.',
    example:
      'result = host.mcp("structures", "alphafold_check_coverage", {"uniprot_accessions": ["P04637", "P38398", "Q9Y6K9"]})',
    run: async (ctx, a) => {
      const requested = Array.isArray(a.uniprot_accessions)
        ? (a.uniprot_accessions as unknown[])
        : []
      // Strip blanks and duplicates before the batch cap; disclose both counts so the caller's
      // request count reconciles (n_unique + skipped == n_requested).
      const cleaned: string[] = []
      const seen = new Set<string>()
      let nBlank = 0
      let nDuplicate = 0
      for (const raw of requested) {
        const acc = String(raw).trim()
        if (!acc) nBlank++
        else if (seen.has(acc)) nDuplicate++
        else {
          seen.add(acc)
          cleaned.push(acc)
        }
      }
      if (cleaned.length > MAX_IDS_PER_CALL) {
        throw new Error(
          `${cleaned.length} unique accessions requested; max ${MAX_IDS_PER_CALL} per call — split the batch`
        )
      }

      const records: Record<string, unknown>[] = []
      const notProcessed: string[] = []
      const deadline = Date.now() + COVERAGE_DEADLINE_MS
      for (const acc of cleaned) {
        if (Date.now() >= deadline) {
          notProcessed.push(acc)
          continue
        }
        const res = await getPrediction(ctx, acc)
        if (res.status === 'not_found') {
          records.push({ uniprot_accession: acc, has_model: false })
          continue
        }
        if (res.status === 'invalid') {
          records.push({
            uniprot_accession: acc,
            has_model: false,
            error: `invalid_accession: ${res.message}`
          })
          continue
        }
        const primary = res.models[0]
        const seq = primary ? modelSequence(primary) : undefined
        records.push({
          uniprot_accession: acc,
          has_model: res.models.length > 0,
          n_models: res.models.length,
          model_entity_id: primary?.modelEntityId,
          latest_version: primary?.latestVersion,
          global_plddt: primary?.globalMetricValue,
          sequence_length: seq ? seq.length : null
        })
      }

      return {
        n_requested: requested.length,
        n_unique: cleaned.length,
        n_blank_skipped: nBlank,
        n_duplicate_skipped: nDuplicate,
        not_processed: notProcessed,
        records
      }
    }
  }
]
