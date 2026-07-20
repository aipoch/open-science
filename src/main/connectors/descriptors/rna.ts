import { createHash } from 'node:crypto'
import type { ToolContext, ToolDescriptor } from '../types'

// Rfam REST API (https://rfam.org): read-only RNA family data. Mirrors the 9 upstream
// tooluniverse/rfam methods — family metadata, seed alignment (Stockholm/FASTA), covariance
// model, phylogenetic tree, sequence regions, PDB structure mapping, accession<->id conversion,
// and async single-sequence cmscan search. Every /family route resolves an accession (RF00005)
// or a family id (tRNA) interchangeably.
const RFAM = 'https://rfam.org'

// Default text-payload cap: alignment/CM texts of large families (e.g. tRNA) run to multiple MB
// and blow past the notebook transport limit — omit the body past this size but keep metadata.
const DEFAULT_MAX_BYTES = 400_000

// Rfam accession shape (RF + 5 digits); id_to_accession validates the resolved value against it.
const ACC_RE = /^RF\d{5}$/

// Encode one argument as a single URL path segment (upstream uses urllib.quote(safe="")).
const seg = (value: unknown): string => encodeURIComponent(String(value))

const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const toInt = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

const toFloat = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// rfam.org /family JSON wraps the record under a top-level "rfam" key.
type RfamFamilyPayload = {
  rfam?: Record<string, unknown>
} & Record<string, unknown>

// Flatten the /family JSON envelope into a stable record. Field names mirror the upstream
// family_record(); gathering/trusted/noise cutoffs are read from cm.cutoffs (the live shape).
function familyRecord(payload: RfamFamilyPayload): Record<string, unknown> {
  const rfam = (payload.rfam ?? payload) as Record<string, unknown>
  const cur = (rfam.curation ?? {}) as Record<string, unknown>
  const cm = (rfam.cm ?? {}) as Record<string, unknown>
  const rel = (rfam.release ?? {}) as Record<string, unknown>
  const clan = (rfam.clan ?? {}) as Record<string, unknown>
  const cutoffs = (cm.cutoffs ?? {}) as Record<string, unknown>
  const threshold = (cm.threshold ?? {}) as Record<string, unknown>
  return {
    rfam_acc: rfam.acc,
    rfam_id: rfam.id,
    description: rfam.description,
    comment: rfam.comment,
    clan_acc: clan.acc,
    clan_id: clan.id,
    rna_type: cur.type,
    structure_source: cur.structure_source,
    num_seed: toInt(cur.num_seed),
    num_full: toInt(cur.num_full),
    num_species: toInt(cur.num_species),
    gathering_cutoff: toFloat(cutoffs.gathering ?? threshold.gathering ?? cur.ga),
    trusted_cutoff: toFloat(cutoffs.trusted ?? threshold.trusted ?? cur.tc),
    noise_cutoff: toFloat(cutoffs.noise ?? threshold.noise ?? cur.nc),
    release_number: rel.number,
    release_date: rel.date
  }
}

// Unique sequence names from a Stockholm alignment, in first-seen order.
function parseStockholmSeqNames(text: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const name = line.split(/\s+/, 1)[0]
    if (name && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

// Sequence names from an aligned-FASTA alignment (the token after ">").
function parseFastaSeqNames(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.slice(1).trim().split(/\s+/, 1)[0])
}

const CM_HEADER_KEYS = new Set([
  'NAME',
  'ACC',
  'DESC',
  'STATES',
  'NODES',
  'CLEN',
  'W',
  'ALPH',
  'GA',
  'TC',
  'NC'
])
const CM_INT_KEYS = ['STATES', 'NODES', 'CLEN', 'W'] as const

// Key header fields from an Infernal CM file (1.1.x). Reads only the leading header block,
// stopping at the "CM" model-section marker; first occurrence of each wanted key wins.
function parseCmHeader(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    if (line.trim() === 'CM') break
    const idx = line.search(/\s/)
    if (idx <= 0) continue
    const key = line.slice(0, idx)
    if (CM_HEADER_KEYS.has(key) && !(key in fields)) {
      fields[key] = line.slice(idx).trim()
    }
  }
  for (const k of CM_INT_KEYS) {
    if (k in fields) {
      const n = Number(fields[k])
      if (Number.isFinite(n)) fields[k] = Math.trunc(n)
    }
  }
  return fields
}

const REGION_COLUMNS = [
  'sequence_accession',
  'bits_score',
  'region_start',
  'region_end',
  'sequence_description',
  'species',
  'ncbi_tax_id'
] as const

// Parse the /regions TSV payload: the "# found N regions" header value plus verbatim data rows
// (comment lines carry a volatile build timestamp and are dropped).
function parseRegions(text: string): {
  declared_count: number | null
  regions: Record<string, string>[]
} {
  let declared: number | null = null
  const regions: Record<string, string>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('#')) {
      const low = line.toLowerCase()
      if (low.includes('found') && low.includes('region')) {
        for (const tok of line.split(/\s+/)) {
          if (/^\d+$/.test(tok)) {
            declared = Number(tok)
            break
          }
        }
      }
      continue
    }
    const parts = line.split('\t')
    const row: Record<string, string> = {}
    REGION_COLUMNS.forEach((col, i) => {
      if (i < parts.length) row[col] = parts[i]
    })
    regions.push(row)
  }
  return { declared_count: declared, regions }
}

type StructureRow = Record<string, unknown>

// Deterministic order for /structures rows (server array order is nondeterministic upstream).
function sortStructureMapping(mapping: StructureRow[]): StructureRow[] {
  const key = (m: StructureRow): [string, string, number, number, number] => [
    String(m.pdb_id),
    String(m.chain),
    toInt(m.pdb_start) ?? 0,
    toInt(m.pdb_end) ?? 0,
    toInt(m.cm_start) ?? 0
  ]
  return [...mapping].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1
      if (ka[i] > kb[i]) return 1
    }
    return 0
  })
}

// Omit a huge text field instead of overflowing the transport limit; metadata + sha256 survive,
// and the caller can re-request with a larger max_bytes.
function capTextPayload(
  result: Record<string, unknown>,
  field: string,
  maxBytes: number
): Record<string, unknown> {
  const text = result[field]
  if (typeof text === 'string' && Buffer.byteLength(text) > maxBytes) {
    const size = Buffer.byteLength(text)
    const out = { ...result }
    delete out[field]
    out[`${field}_omitted`] =
      `${field} is ${size} bytes > max_bytes=${maxBytes}; metadata and sha256 are ` +
      `included — re-call with a larger max_bytes to get the full text`
    if (out.size_bytes == null) out.size_bytes = size
    return out
  }
  return result
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type SearchSubmission = { resultURL?: string; jobId?: string; opened?: string }
type SearchResult = { hits?: Record<string, unknown[]>; searchSequence?: string }

export const RNA_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_family',
    connector: 'rna',
    description:
      'Rfam family metadata for an accession (RF00005) or family id (tRNA) — both resolve. Flattened record plus the full upstream JSON in "raw".',
    input: {
      type: 'object',
      properties: { family: { type: 'string' } },
      required: ['family']
    },
    required: ['family'],
    returns:
      '`{ "rfam_acc": str, "rfam_id": str, "description": str, "comment": str, "clan_acc": str|null, "clan_id": str|null, "rna_type": str, "structure_source": str, "num_seed": int, "num_full": int, "num_species": int, "gathering_cutoff": float, "trusted_cutoff": float, "noise_cutoff": float, "release_number": str, "release_date": str, "raw": {…} }` — flattened metadata; `raw` is the complete upstream `rfam` record. Absent fields are `null`/`undefined`.',
    example: 'const result = await host.mcp("rna", "get_family", {"family": "RF00005"})',
    url: (a) => `${RFAM}/family/${seg(a.family)}?content-type=application/json`,
    parse: (raw) => {
      const payload = raw as RfamFamilyPayload
      const rec = familyRecord(payload)
      rec.raw = payload.rfam ?? payload
      return rec
    }
  },
  {
    id: 'get_seed_alignment',
    connector: 'rna',
    description:
      'Seed alignment of an Rfam family in Stockholm (default, with consensus secondary-structure line) or aligned gapped FASTA.',
    input: {
      type: 'object',
      properties: {
        family: { type: 'string' },
        fmt: { type: 'string', enum: ['stockholm', 'fasta'], default: 'stockholm' },
        max_bytes: { type: 'integer', default: DEFAULT_MAX_BYTES }
      },
      required: ['family']
    },
    required: ['family'],
    format: 'text',
    returns:
      '`{ "family": str, "format": str, "num_sequences": int, "sequence_names": [str], "sha256": str, "alignment": str }` — when the alignment exceeds `max_bytes` (default 400000) "alignment" is dropped and replaced by "alignment_omitted"/"size_bytes"; metadata, counts and sha256 are always present. Raise `max_bytes` to force the full body.',
    example:
      'const result = await host.mcp("rna", "get_seed_alignment", {"family": "RF00162", "fmt": "stockholm"})',
    url: (a) => {
      const fmt = String(a.fmt ?? 'stockholm')
      if (fmt === 'stockholm')
        return `${RFAM}/family/${seg(a.family)}/alignment?content-type=text/plain`
      if (fmt === 'fasta')
        return `${RFAM}/family/${seg(a.family)}/alignment/fasta?content-type=text/plain`
      throw new Error(`unsupported alignment format: ${fmt}`)
    },
    parse: (raw, a) => {
      const text = String(raw)
      const fmt = String(a.fmt ?? 'stockholm')
      const names = fmt === 'fasta' ? parseFastaSeqNames(text) : parseStockholmSeqNames(text)
      const result = {
        family: String(a.family),
        format: fmt,
        num_sequences: names.length,
        sequence_names: names,
        sha256: sha256Text(text),
        alignment: text
      }
      return capTextPayload(result, 'alignment', Number(a.max_bytes ?? DEFAULT_MAX_BYTES))
    }
  },
  {
    id: 'get_covariance_model',
    connector: 'rna',
    description:
      'Infernal covariance model (CM file) of an Rfam family, usable directly with cmsearch/cmscan, plus parsed header fields.',
    input: {
      type: 'object',
      properties: {
        family: { type: 'string' },
        max_bytes: { type: 'integer', default: DEFAULT_MAX_BYTES }
      },
      required: ['family']
    },
    required: ['family'],
    format: 'text',
    returns:
      '`{ "family": str, "header": { "NAME": str, "ACC": str, "STATES": int, "CLEN": int, "W": int, … }, "size_bytes": int, "sha256": str, "cm": str }` — when the CM exceeds `max_bytes` (default 400000) "cm" is dropped for "cm_omitted"; header, size_bytes and sha256 are always present.',
    example: 'const result = await host.mcp("rna", "get_covariance_model", {"family": "RF00162"})',
    url: (a) => `${RFAM}/family/${seg(a.family)}/cm?content-type=text/plain`,
    parse: (raw, a) => {
      const text = String(raw)
      const result = {
        family: String(a.family),
        header: parseCmHeader(text),
        size_bytes: Buffer.byteLength(text),
        sha256: sha256Text(text),
        cm: text
      }
      return capTextPayload(result, 'cm', Number(a.max_bytes ?? DEFAULT_MAX_BYTES))
    }
  },
  {
    id: 'get_tree',
    connector: 'rna',
    description: 'Seed phylogenetic tree of an Rfam family (NHX/Newick text).',
    input: {
      type: 'object',
      properties: { family: { type: 'string' } },
      required: ['family']
    },
    required: ['family'],
    format: 'text',
    returns:
      '`{ "family": str, "num_leaf_labels": int, "sha256": str, "tree": str }` — `tree` is NHX/Newick text; `num_leaf_labels` counts labelled leaves.',
    example: 'const result = await host.mcp("rna", "get_tree", {"family": "RF00162"})',
    url: (a) => `${RFAM}/family/${seg(a.family)}/tree?content-type=text/plain`,
    parse: (raw, a) => {
      const text = String(raw)
      const leaves = text.match(/[(,]\s*[^(),:]+:/g)
      return {
        family: String(a.family),
        num_leaf_labels: leaves ? leaves.length : 0,
        sha256: sha256Text(text),
        tree: text
      }
    }
  },
  {
    id: 'get_sequence_regions',
    connector: 'rna',
    description:
      'All full-region hits of an Rfam family across sequence databases (parsed TSV). Check num_full via get_family first — rfam.org 403s this route for very large families (e.g. RF00005).',
    input: {
      type: 'object',
      properties: { family: { type: 'string' } },
      required: ['family']
    },
    required: ['family'],
    format: 'text',
    returns:
      '`{ "family": str, "declared_count": int|null, "num_regions": int, "regions": [ { "sequence_accession": str, "bits_score": str, "region_start": str, "region_end": str, "sequence_description": str, "species": str, "ncbi_tax_id": str } ] }` — `declared_count` is the server\'s own "# found N regions" header. Very large families surface an HTTP 403 error as-is.',
    example: 'const result = await host.mcp("rna", "get_sequence_regions", {"family": "RF00162"})',
    url: (a) => `${RFAM}/family/${seg(a.family)}/regions?content-type=text/plain`,
    parse: (raw, a) => {
      const parsed = parseRegions(String(raw))
      return {
        family: String(a.family),
        declared_count: parsed.declared_count,
        num_regions: parsed.regions.length,
        regions: parsed.regions
      }
    }
  },
  {
    id: 'get_structure_mapping',
    connector: 'rna',
    description:
      'PDB residue-level structure mappings of an Rfam family, deterministically sorted.',
    input: {
      type: 'object',
      properties: { family: { type: 'string' } },
      required: ['family']
    },
    required: ['family'],
    returns:
      '`{ "family": str, "num_mappings": int, "num_pdb_ids": int, "pdb_ids": [str], "mapping": [ { "pdb_id": str, "chain": str, "pdb_start": int, "pdb_end": int, "cm_start": int, "cm_end": int, "bit_score": float, "evalue_score": str, "rfam_acc": str } ] }` — rows sorted by (pdb_id, chain, pdb_start, pdb_end, cm_start); exact per-row fields follow upstream. `mapping` is `[]` when no structures exist.',
    example: 'const result = await host.mcp("rna", "get_structure_mapping", {"family": "RF00162"})',
    url: (a) => `${RFAM}/family/${seg(a.family)}/structures?content-type=application/json`,
    parse: (raw, a) => {
      const payload = (raw ?? {}) as { mapping?: StructureRow[] }
      const rows = sortStructureMapping(payload.mapping ?? [])
      const pdbIds = [...new Set(rows.map((r) => String(r.pdb_id)))].sort()
      return {
        family: String(a.family),
        num_mappings: rows.length,
        num_pdb_ids: pdbIds.length,
        pdb_ids: pdbIds,
        mapping: rows
      }
    }
  },
  {
    id: 'accession_to_id',
    connector: 'rna',
    description: 'Convert an Rfam accession to its family id (e.g. RF00005 -> "tRNA").',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    format: 'text',
    returns:
      '`{ "accession": str, "rfam_id": str }` — echoes the input accession and its resolved family id.',
    example: 'const result = await host.mcp("rna", "accession_to_id", {"accession": "RF00005"})',
    url: (a) => `${RFAM}/family/${seg(a.accession)}/id?content-type=text/plain`,
    parse: (raw, a) => ({ accession: String(a.accession), rfam_id: String(raw).trim() })
  },
  {
    id: 'id_to_accession',
    connector: 'rna',
    description: 'Convert an Rfam family id to its accession (e.g. "tRNA" -> RF00005).',
    input: {
      type: 'object',
      properties: { family_id: { type: 'string' } },
      required: ['family_id']
    },
    required: ['family_id'],
    format: 'text',
    returns:
      '`{ "rfam_id": str, "accession": str }` — echoes the input id and its resolved RF##### accession. Throws when no accession resolves.',
    example: 'const result = await host.mcp("rna", "id_to_accession", {"family_id": "tRNA"})',
    url: (a) => `${RFAM}/family/${seg(a.family_id)}/acc?content-type=text/plain`,
    parse: (raw, a) => {
      const acc = String(raw).trim()
      if (!ACC_RE.test(acc)) {
        throw new Error(`no accession resolved for ${JSON.stringify(String(a.family_id))}`)
      }
      return { rfam_id: String(a.family_id), accession: acc }
    }
  },
  {
    id: 'search_sequence',
    connector: 'rna',
    description:
      'Search a single RNA/DNA sequence against all Rfam covariance models (async cmscan): submit to rfam.org and poll until done. Known upstream limitation: the job backend may be down (valid submissions return "SearchUnavailable … come back later"; invalid sequences still get a 400) — the error is surfaced as-is.',
    input: {
      type: 'object',
      properties: {
        sequence: { type: 'string' },
        max_wait_s: { type: 'number', default: 300 },
        poll_interval_s: { type: 'number', default: 5 }
      },
      required: ['sequence']
    },
    required: ['sequence'],
    returns:
      '`{ "job_id": str, "num_hits": int, "families": [str], "hits": { family_id: [ { e-value, score, alignment blocks, … } ] }, "search_sequence": str }` — hits grouped by matching family id. Surfaces upstream SearchUnavailable/400/timeout errors as-is; no local fallback.',
    example:
      'const result = await host.mcp("rna", "search_sequence", {"sequence": "GGUUCCGGGAAGGCAGCAGGUGGAAACCUGCCA"})',
    run: async (ctx: ToolContext, a) => {
      const sequence = String(a.sequence)
      const maxWaitS = Number(a.max_wait_s ?? 300)
      const pollIntervalS = Number(a.poll_interval_s ?? 5)
      // Submit the async cmscan job (upstream posts { seq }). The engine surfaces a 400 (invalid
      // sequence) or 5xx (backend down) as an HTTP error, matching the upstream pass-through.
      const sub = (await ctx.postJson(`${RFAM}/search/sequence`, {
        seq: sequence
      })) as SearchSubmission
      const resultUrl = sub.resultURL
      if (!resultUrl)
        throw new Error(`submission response missing resultURL: ${JSON.stringify(sub)}`)
      // Bounded poll loop: rfam.org holds the result behind the submission's resultURL until the
      // job finishes. Cap total polls by max_wait_s / poll_interval_s (and a hard ceiling).
      const deadline = Date.now() + maxWaitS * 1000
      const maxPolls = Math.min(
        Math.max(1, Math.ceil(maxWaitS / Math.max(pollIntervalS, 0.001))),
        120
      )
      let res: SearchResult | null = null
      for (let poll = 0; poll < maxPolls; poll++) {
        const payload = (await ctx.fetchJson(resultUrl)) as SearchResult
        if (payload && typeof payload === 'object' && payload.hits != null) {
          res = payload
          break
        }
        if (Date.now() >= deadline) break
        await delay(pollIntervalS * 1000)
      }
      if (!res || res.hits == null) {
        throw new Error(`Rfam sequence search not finished after ${maxWaitS}s (${resultUrl})`)
      }
      const hits = res.hits ?? {}
      const families = Object.keys(hits).sort()
      const numHits = families.reduce((acc, fam) => acc + (hits[fam]?.length ?? 0), 0)
      return {
        job_id: sub.jobId,
        num_hits: numHits,
        families,
        hits,
        search_sequence: res.searchSequence
      }
    }
  }
]
