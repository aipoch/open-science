import type { ToolContext, ToolDescriptor } from '../types'

// EMDB REST API (EBI, cryo-EM 3D maps). Metadata only — map volumes are never downloaded.
// The /entry document feeds the headline record and every detailed section; /analysis backs the
// validation extension; /search (compact CSV via wt=csv, honours the fl field list) is
// count-verified against the released-only /facet route. See run_search_spec for the REL/OBS
// asymmetry the search route exposes.
const BASE = 'https://www.ebi.ac.uk/emdb/api'

// Compact field list for the search route; current_status is always present so rows split by status.
const DEFAULT_FL =
  'emdb_id,title,resolution,structure_determination_method,fitted_pdbs,current_status,release_date'
const PAGE_ROWS = 200

// Numeric validation blocks lifted verbatim (when present) from /analysis/{id}; JPEG/asset blocks in
// the same payload are deliberately dropped (presentation only).
const VALIDATION_SCALAR_BLOCKS = [
  'recommended_contour_level',
  'predicated_contour_level',
  'rawmap_contour_level',
  'model_map_ratio',
  'model_volume',
  'mask_volume',
  'surfaces',
  'surface_ratio',
  'feature_assessment',
  'relion_mask_coverage'
] as const

// ---- small helpers --------------------------------------------------------------------------

// Narrows an unknown to a plain object; anything else (array, scalar, null) becomes {}.
const asObj = (x: unknown): Record<string, unknown> =>
  x != null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}

// Many EMDB v3 fields are {valueOf_: x, units: u, ...}; unwrap to x (pass scalars/arrays through).
function unwrap(node: unknown): unknown {
  if (node != null && typeof node === 'object' && !Array.isArray(node) && 'valueOf_' in node) {
    return (node as Record<string, unknown>).valueOf_
  }
  return node
}

function asFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

// '2020-08-20T00:00:00' -> '2020-08-20'; null for empty/absent.
function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v).slice(0, 10)
}

// null/undefined -> []; an array passes through; a scalar/object becomes a single-element list.
function listify(node: unknown): unknown[] {
  if (node === null || node === undefined) return []
  return Array.isArray(node) ? node : [node]
}

// {valueOf_: x, units: u} -> {value: number|null, units}. Non-objects -> {value: asFloat(node)}.
function unitValue(node: unknown): { value: number | null; units: unknown } {
  if (node != null && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>
    const raw = o.valueOf_
    return {
      value: raw !== null && raw !== undefined && raw !== '' ? asFloat(raw) : null,
      units: o.units ?? null
    }
  }
  return { value: asFloat(node), units: null }
}

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// Accept 'EMD-1234', 'emd-1234' or '1234' and return canonical 'EMD-1234'; throws on non-numeric.
function normalizeEmdbId(emdbId: string): string {
  let s = String(emdbId).trim().toUpperCase()
  if (s.startsWith('EMD-')) s = s.slice(4)
  if (!/^\d+$/.test(s)) throw new Error(`not a valid EMDB accession: ${JSON.stringify(emdbId)}`)
  return `EMD-${s}`
}

// The engine surfaces the EMDB 404 (unknown accession) as a generic "HTTP 404" error.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 404')
}

// ---- CSV parsing (RFC 4180; EMDB quotes any field containing a comma) ------------------------

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Parses a CSV table into header-keyed row objects (DictReader-equivalent).
function parseCsv(text: string): Record<string, string>[] {
  if (!text.trim()) return []
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []
  const header = rows[0]
  const out: Record<string, string>[] = []
  for (let r = 1; r < rows.length; r++) {
    const rec: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) rec[header[c]] = rows[r][c] ?? ''
    out.push(rec)
  }
  return out
}

// ---- headline record extractor ---------------------------------------------------------------

// Flatten one EMDB /entry document into a structured map-metadata record. Handles: no fitted PDB
// (pdb_list null -> []), obsolete entries (status OBS -> is_obsolete + superseded_by), and entries
// with no reported resolution (resolution/resolution_method null, e.g. raw tomograms).
function extractEntryRecord(entry: Record<string, unknown>): Record<string, unknown> {
  const admin = asObj(entry.admin)
  const xref = asObj(entry.crossreferences)
  const sample = asObj(entry.sample)
  const mapBlock = asObj(entry.map)

  // status / obsolescence
  const statusNode = asObj(admin.current_status)
  const statusCode = unwrap(statusNode.code) ?? null
  const supersededSet = new Set<string>()
  for (const item of listify(asObj(admin.obsolete_list).entry)) {
    const repl = asObj(item).entry
    if (repl) supersededSet.add(String(repl))
  }
  const supersededBy = Array.from(supersededSet).sort()

  const keyDates = asObj(admin.key_dates)

  // structure determination / resolution
  const sdList = listify(asObj(entry.structure_determination_list).structure_determination)
  const sd = asObj(sdList[0])
  const method = sd.method ?? null
  const aggregationState = sd.aggregation_state ?? null
  let resolution: number | null = null
  let resolutionMethod: unknown = null
  const imageProcessing = listify(sd.image_processing)
  if (imageProcessing.length) {
    const final = asObj(asObj(imageProcessing[0]).final_reconstruction)
    const resNode = final.resolution
    if (resNode !== null && resNode !== undefined) resolution = asFloat(unwrap(resNode))
    resolutionMethod = final.resolution_method ?? null
  }

  // sample / macromolecule + supramolecule name lists
  const sampleName = sample.name ? unwrap(sample.name) : null
  const macromolecules: string[] = []
  for (const m of listify(asObj(sample.macromolecule_list).macromolecule)) {
    const name = unwrap(asObj(m).name)
    if (name) macromolecules.push(String(name))
  }
  const supramolecules: string[] = []
  for (const s of listify(asObj(sample.supramolecule_list).supramolecule)) {
    const name = unwrap(asObj(s).name)
    if (name) supramolecules.push(String(name))
  }

  // fitted PDB models (pdb_list is null when no model is fitted)
  const fittedSet = new Set<string>()
  for (const ref of listify(asObj(xref.pdb_list).pdb_reference)) {
    const r = asObj(ref)
    if (r.pdb_id) fittedSet.add(String(r.pdb_id).toLowerCase())
  }
  const fittedPdbIds = Array.from(fittedSet).sort()

  // primary citation
  const citation: Record<string, unknown> = {
    title: null,
    journal: null,
    year: null,
    published: null,
    doi: null,
    pmid: null,
    first_author: null,
    author_count: 0
  }
  const primary = asObj(asObj(xref.citation_list).primary_citation)
  let inner: Record<string, unknown> | null = null
  if ('external_references' in primary || 'author' in primary) {
    inner = primary
  } else {
    const firstVal = Object.values(primary)[0]
    if (firstVal != null && typeof firstVal === 'object' && !Array.isArray(firstVal)) {
      inner = firstVal as Record<string, unknown>
    }
  }
  if (inner) {
    const title = String(inner.title ?? '').trim()
    citation.title = title !== '' ? title : null
    citation.journal = inner.journal_abbreviation ?? inner.journal ?? null
    const year = inner.year
    citation.year =
      year !== null && year !== undefined && year !== '' ? parseInt(String(year), 10) : null
    citation.published =
      inner.published !== null && inner.published !== undefined ? Boolean(inner.published) : null
    const names: string[] = []
    for (const a of listify(inner.author)) {
      const nm = unwrap(a)
      if (nm) names.push(String(nm))
    }
    citation.author_count = names.length
    citation.first_author = names.length ? names[0] : null
    for (const ref of listify(inner.external_references)) {
      const r = asObj(ref)
      const refType = String(r.type_ ?? '').toUpperCase()
      const val = String(unwrap(ref) ?? '')
      if (refType === 'DOI' && citation.doi === null) {
        citation.doi = val.toLowerCase().startsWith('doi:') ? val.slice(4) : val
      } else if (refType === 'PUBMED' && citation.pmid === null) {
        citation.pmid = val
      }
    }
  }

  // map geometry (metadata only)
  const dims = asObj(mapBlock.dimensions)
  const pixelSpacing = asObj(mapBlock.pixel_spacing)
  const axis = (ax: string): { value: number | null; units: unknown } => {
    const node = asObj(pixelSpacing[ax])
    return { value: asFloat(unwrap(node)), units: node.units ?? null }
  }

  return {
    emdb_id: entry.emdb_id ?? null,
    title: admin.title ?? null,
    status: statusCode,
    is_obsolete: statusCode === 'OBS',
    superseded_by: supersededBy,
    obsolete_date: dateOnly(keyDates.obsolete),
    method,
    aggregation_state: aggregationState,
    resolution_angstrom: resolution,
    resolution_method: resolutionMethod,
    deposition_date: dateOnly(keyDates.deposition),
    header_release_date: dateOnly(keyDates.header_release),
    map_release_date: dateOnly(keyDates.map_release),
    update_date: dateOnly(keyDates.update),
    sample_name: sampleName,
    macromolecule_names: macromolecules,
    supramolecule_names: supramolecules,
    fitted_pdb_ids: fittedPdbIds,
    has_fitted_model: fittedPdbIds.length > 0,
    citation,
    map: {
      file: mapBlock.file ?? null,
      size_kbytes: mapBlock.size_kbytes ?? null,
      dimensions: { col: dims.col ?? null, row: dims.row ?? null, sec: dims.sec ?? null },
      voxel_size_angstrom: { x: axis('x'), y: axis('y'), z: axis('z') }
    }
  }
}

// ---- section extractors ----------------------------------------------------------------------

// One citation node -> a full publication record (complete ordered author list + external refs).
function citationRecord(node: unknown): Record<string, unknown> | null {
  const citationNode = asObj(node)
  if (Object.keys(citationNode).length === 0) return null
  let inner = citationNode
  if (!('external_references' in inner) && !('author' in inner)) {
    const firstVal = Object.values(citationNode)[0]
    if (firstVal != null && typeof firstVal === 'object' && !Array.isArray(firstVal)) {
      inner = firstVal as Record<string, unknown>
    } else {
      return null
    }
  }
  const authors: { name: string; order: unknown }[] = []
  for (const a of listify(inner.author)) {
    const name = unwrap(a)
    if (name) authors.push({ name: String(name), order: asObj(a).order ?? null })
  }
  // order nulls last, otherwise ascending by order value
  authors.sort((x, y) => {
    const xn = x.order === null || x.order === undefined
    const yn = y.order === null || y.order === undefined
    if (xn !== yn) return xn ? 1 : -1
    return Number(x.order) - Number(y.order)
  })
  const refs: Record<string, string | null> = { doi: null, pmid: null, issn: null, csd: null }
  for (const ref of listify(inner.external_references)) {
    const r = asObj(ref)
    const refType = String(r.type_ ?? '').toUpperCase()
    const val = String(unwrap(ref) ?? '')
    if (refType === 'DOI') refs.doi = val.toLowerCase().startsWith('doi:') ? val.slice(4) : val
    else if (refType === 'PUBMED') refs.pmid = val
    else if (refType === 'ISSN') refs.issn = val
    else if (refType === 'CSD') refs.csd = val
  }
  const year = inner.year
  const title = String(inner.title ?? '').trim()
  return {
    title: title !== '' ? title : null,
    authors,
    journal: inner.journal_abbreviation ?? inner.journal ?? null,
    journal_full: inner.journal ?? null,
    volume: inner.volume ?? null,
    first_page: inner.first_page ?? null,
    last_page: inner.last_page ?? null,
    year: year !== null && year !== undefined && year !== '' ? parseInt(String(year), 10) : null,
    country: inner.country ?? null,
    published:
      inner.published !== null && inner.published !== undefined ? Boolean(inner.published) : null,
    external_references: refs
  }
}

function extractPublications(entry: Record<string, unknown>): Record<string, unknown> {
  const citList = asObj(asObj(entry.crossreferences).citation_list)
  const primary = citationRecord(citList.primary_citation)
  const secondary: Record<string, unknown>[] = []
  for (const [key, node] of Object.entries(citList)) {
    if (key === 'primary_citation') continue
    for (const item of listify(node)) {
      const rec = citationRecord(item)
      if (rec) secondary.push(rec)
    }
  }
  return {
    emdb_id: entry.emdb_id ?? null,
    primary_citation: primary,
    secondary_citations: secondary
  }
}

function extractMapInfo(entry: Record<string, unknown>): Record<string, unknown> {
  const mapBlock = asObj(entry.map)
  const dims = asObj(mapBlock.dimensions)
  const origin = asObj(mapBlock.origin)
  const spacing = asObj(mapBlock.spacing)
  const axisOrder = asObj(mapBlock.axis_order)
  const pixel = asObj(mapBlock.pixel_spacing)
  const cell = asObj(mapBlock.cell)
  const stats = asObj(mapBlock.statistics)
  const contours: Record<string, unknown>[] = []
  for (const c of listify(asObj(mapBlock.contour_list).contour)) {
    const cc = asObj(c)
    if (Object.keys(cc).length) {
      contours.push({
        level: asFloat(cc.level),
        primary: cc.primary !== null && cc.primary !== undefined ? Boolean(cc.primary) : null,
        source: cc.source ?? null
      })
    }
  }
  const sym = asObj(mapBlock.symmetry)
  return {
    emdb_id: entry.emdb_id ?? null,
    file: mapBlock.file ?? null,
    format: mapBlock.format ?? null,
    size_kbytes: mapBlock.size_kbytes ?? null,
    data_type: mapBlock.data_type ?? null,
    dimensions: { col: dims.col ?? null, row: dims.row ?? null, sec: dims.sec ?? null },
    origin: { col: origin.col ?? null, row: origin.row ?? null, sec: origin.sec ?? null },
    spacing: { x: spacing.x ?? null, y: spacing.y ?? null, z: spacing.z ?? null },
    axis_order: {
      fast: axisOrder.fast ?? null,
      medium: axisOrder.medium ?? null,
      slow: axisOrder.slow ?? null
    },
    pixel_spacing_angstrom: { x: unitValue(pixel.x), y: unitValue(pixel.y), z: unitValue(pixel.z) },
    cell: {
      a: unitValue(cell.a),
      b: unitValue(cell.b),
      c: unitValue(cell.c),
      alpha: unitValue(cell.alpha),
      beta: unitValue(cell.beta),
      gamma: unitValue(cell.gamma)
    },
    statistics: {
      minimum: asFloat(stats.minimum),
      maximum: asFloat(stats.maximum),
      average: asFloat(stats.average),
      std: asFloat(stats.std)
    },
    contour_levels: contours,
    space_group: Object.keys(sym).length ? (unwrap(sym.space_group) ?? null) : null,
    label: mapBlock.label ?? null
  }
}

function weightBlock(node: unknown): Record<string, unknown> | null {
  const o = asObj(node)
  if (Object.keys(o).length === 0) return null
  const out: Record<string, unknown> = {}
  if (o.theoretical !== null && o.theoretical !== undefined)
    out.theoretical = unitValue(o.theoretical)
  if (o.experimental !== null && o.experimental !== undefined)
    out.experimental = unitValue(o.experimental)
  return Object.keys(out).length ? out : null
}

function sourceBlock(node: unknown): Record<string, unknown> | null {
  const o = asObj(node)
  if (Object.keys(o).length === 0) return null
  const organism = o.organism
  return {
    organism: organism ? String(unwrap(organism)) : null,
    ncbi_taxid: asObj(organism).ncbi ?? null
  }
}

function extractSampleInfo(entry: Record<string, unknown>): Record<string, unknown> {
  const sample = asObj(entry.sample)
  const macromolecules: Record<string, unknown>[] = []
  for (const m of listify(asObj(sample.macromolecule_list).macromolecule)) {
    const mm = asObj(m)
    if (Object.keys(mm).length === 0) continue
    const seq = asObj(mm.sequence)
    const extRefs: Record<string, unknown>[] = []
    for (const ref of listify(seq.external_references)) {
      const r = asObj(ref)
      extRefs.push({ type: r.type_ ?? null, id: String(unwrap(ref) ?? '') || null })
    }
    macromolecules.push({
      id: mm.macromolecule_id ?? null,
      type: mm.instance_type ?? null,
      name: String(unwrap(mm.name) ?? '') || null,
      molecular_weight: weightBlock(mm.molecular_weight),
      number_of_copies: mm.number_of_copies ?? null,
      ec_number: listify(mm.ec_number).map(unwrap).filter(Boolean).map(String),
      enantiomer: mm.enantiomer ?? null,
      natural_source: sourceBlock(mm.natural_source),
      recombinant_expression:
        mm.recombinant_expression !== null && mm.recombinant_expression !== undefined
          ? Boolean(mm.recombinant_expression)
          : null,
      sequence_external_references: extRefs
    })
  }
  const supramolecules: Record<string, unknown>[] = []
  for (const s of listify(asObj(sample.supramolecule_list).supramolecule)) {
    const sm = asObj(s)
    if (Object.keys(sm).length === 0) continue
    const mmList = asObj(sm.macromolecule_list)
    const ids = listify(mmList.macromolecule_id)
    supramolecules.push({
      id: sm.supramolecule_id ?? null,
      type: sm.instance_type ?? null,
      name: String(unwrap(sm.name) ?? '') || null,
      parent: sm.parent ?? null,
      molecular_weight: weightBlock(sm.molecular_weight),
      natural_source: sourceBlock(sm.natural_source),
      macromolecule_ids: ids.length ? ids : listify(mmList.macromolecule)
    })
  }
  return {
    emdb_id: entry.emdb_id ?? null,
    name: String(unwrap(sample.name) ?? '') || null,
    macromolecules,
    supramolecules
  }
}

function extractImagingInfo(entry: Record<string, unknown>): Record<string, unknown> {
  const sdList = listify(asObj(entry.structure_determination_list).structure_determination)
  const sd = asObj(sdList[0])

  const sessions: Record<string, unknown>[] = []
  for (const mic of listify(asObj(sd.microscopy_list).microscopy)) {
    const m = asObj(mic)
    if (Object.keys(m).length === 0) continue
    const recordings: Record<string, unknown>[] = []
    for (const rec of listify(asObj(m.image_recording_list).image_recording)) {
      const r = asObj(rec)
      if (Object.keys(r).length === 0) continue
      recordings.push({
        id: r.image_recording_id ?? null,
        detector: String(unwrap(r.film_or_detector_model) ?? '') || null,
        average_electron_dose_per_image: unitValue(r.average_electron_dose_per_image),
        number_real_images: r.number_real_images ?? null,
        average_exposure_time: unitValue(r.average_exposure_time)
      })
    }
    sessions.push({
      id: m.microscopy_id ?? null,
      type: m.instance_type ?? null,
      microscope: m.microscope ?? null,
      acceleration_voltage: unitValue(m.acceleration_voltage),
      electron_source: m.electron_source ?? null,
      illumination_mode: m.illumination_mode ?? null,
      imaging_mode: m.imaging_mode ?? null,
      nominal_cs: unitValue(m.nominal_cs),
      nominal_defocus_min: unitValue(m.nominal_defocus_min),
      nominal_defocus_max: unitValue(m.nominal_defocus_max),
      nominal_magnification: asFloat(unwrap(m.nominal_magnification)),
      specimen_holder_model: m.specimen_holder_model ?? null,
      cooling_holder_cryogen: m.cooling_holder_cryogen ?? null,
      image_recordings: recordings
    })
  }

  const preparations: Record<string, unknown>[] = []
  for (const prep of listify(asObj(sd.specimen_preparation_list).specimen_preparation)) {
    const p = asObj(prep)
    if (Object.keys(p).length === 0) continue
    const buffer = asObj(p.buffer)
    const grid = asObj(p.grid)
    const vit = asObj(p.vitrification)
    preparations.push({
      id: p.preparation_id ?? null,
      type: p.instance_type ?? null,
      buffer: Object.keys(buffer).length
        ? { ph: asFloat(buffer.ph), details: buffer.details ?? null }
        : null,
      grid: Object.keys(grid).length
        ? {
            material: grid.material ?? null,
            mesh: grid.mesh ?? null,
            model: grid.model ?? null,
            pretreatment: asObj(grid.pretreatment).type_ ?? null
          }
        : null,
      vitrification: Object.keys(vit).length
        ? {
            cryogen_name: vit.cryogen_name ?? null,
            instrument: vit.instrument ?? null,
            chamber_humidity: unitValue(vit.chamber_humidity),
            chamber_temperature: unitValue(vit.chamber_temperature)
          }
        : null
    })
  }

  return {
    emdb_id: entry.emdb_id ?? null,
    method: sd.method ?? null,
    microscopy: sessions,
    specimen_preparations: preparations
  }
}

// ---- validation extractor --------------------------------------------------------------------

function extractValidationRecord(
  payload: Record<string, unknown>,
  emdbId: string
): Record<string, unknown> {
  const parts = emdbId.split('-')
  const num = parts.length > 1 ? parts.slice(1).join('-') : emdbId
  const inner = asObj(payload[num])
  const record: Record<string, unknown> = {
    emdb_id: `EMD-${num}`,
    has_validation_analysis: Object.keys(inner).length > 0,
    resolution_angstrom: asFloat(asObj(inner.resolution).value),
    qscore_average: asFloat(asObj(inner.qscore).allmodels_average_qscore),
    atom_inclusion_average: asFloat(asObj(inner.atom_inclusion_by_level).average_ai_allmodels),
    available_blocks: Object.keys(inner).sort()
  }
  for (const block of VALIDATION_SCALAR_BLOCKS) {
    const v = inner[block]
    record[block] = v != null && typeof v === 'object' && !Array.isArray(v) ? v : null
  }
  return record
}

// ---- complete paged search with released-count verification ----------------------------------

// Released-entry count for `query` via the /facet route (facet/yearly index released entries only).
async function searchCount(ctx: ToolContext, query: string): Promise<number> {
  const facet = asObj(
    await ctx.fetchJson(`${BASE}/facet/${encodeURIComponent(query)}?field=current_status`)
  )
  const counts = asObj(facet.current_status)
  let sum = 0
  for (const v of Object.values(counts)) sum += Number(v) || 0
  return sum
}

function emdSortKey(id: string | undefined): number {
  const n = parseInt(
    String(id ?? '')
      .toUpperCase()
      .replace('EMD-', ''),
    10
  )
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

// Run one search spec to completion: sweep every page (compact CSV via wt=csv), split rows by status,
// verify released rows against the facet count. The search route returns REL AND OBS; facet counts
// released only — so obsoleted rows are reported explicitly, never folded into the released count.
async function runSearchSpec(
  ctx: ToolContext,
  query: string,
  maxRows: number
): Promise<Record<string, unknown>> {
  const numFoundReleased = await searchCount(ctx, query)
  const flParam = encodeURIComponent(DEFAULT_FL)
  const raw: Record<string, string>[] = []
  let page = 1
  while (raw.length < maxRows) {
    const url = `${BASE}/search/${encodeURIComponent(query)}?rows=${PAGE_ROWS}&page=${page}&fl=${flParam}&wt=csv`
    const rows = parseCsv(await ctx.fetchText(url))
    if (rows.length === 0) break
    raw.push(...rows)
    if (rows.length < PAGE_ROWS) break
    page += 1
  }
  // de-duplicate defensively and sort by accession for deterministic output
  const seen = new Set<string | undefined>()
  const unique: Record<string, string>[] = []
  for (const row of raw) {
    const key = row.emdb_id
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  unique.sort((a, b) => emdSortKey(a.emdb_id) - emdSortKey(b.emdb_id))
  const statusCounts: Record<string, number> = {}
  for (const row of unique) {
    const st = row.current_status || 'UNKNOWN'
    statusCounts[st] = (statusCounts[st] ?? 0) + 1
  }
  const releasedRows = statusCounts['REL'] ?? 0
  const rowsByStatus: Record<string, number> = {}
  for (const k of Object.keys(statusCounts).sort()) rowsByStatus[k] = statusCounts[k]
  return {
    query,
    num_found_released: numFoundReleased,
    rows_retrieved: unique.length,
    rows_by_status: rowsByStatus,
    released_complete: releasedRows === numFoundReleased,
    records: unique
  }
}

// Coerces the emdb_ids arg to a string list.
const idList = (a: Record<string, unknown>): string[] =>
  Array.isArray(a.emdb_ids) ? (a.emdb_ids as unknown[]).map((x) => String(x)) : []

const SECTION_EXTRACTORS: Record<string, (e: Record<string, unknown>) => Record<string, unknown>> =
  {
    publications: extractPublications,
    map: extractMapInfo,
    sample: extractSampleInfo,
    imaging: extractImagingInfo
  }

// ---- the 4 tools -----------------------------------------------------------------------------

export const STRUCTURES_EMDB_TOOLS: ToolDescriptor[] = [
  {
    id: 'emdb_get_entries',
    connector: 'structures',
    description:
      'Fetch structured metadata records for EMDB cryo-EM 3D map entries. Accepts accessions as \'EMD-1234\', \'emd-1234\' or \'1234\'. Each record carries title, structure determination method (singleParticle / helical / tomography / subtomogramAveraging / electronCrystallography), resolution in Angstrom (null for entries with no reported resolution, e.g. raw tomograms) and the resolution method, deposition/release dates, sample and macromolecule/supramolecule names, fitted PDB model IDs (empty list when no model is fitted), primary citation (journal, year, first author, DOI, PMID), map dimensions and voxel size, and status. Obsolete entries report is_obsolete=true plus superseded_by accessions. Unknown accessions come back as {"emdb_id", "error": "not_found"} — never silently dropped. Metadata only; map volumes are never downloaded.',
    input: {
      type: 'object',
      properties: {
        emdb_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['emdb_ids']
    },
    required: ['emdb_ids'],
    returns:
      '{n_requested, records:[{emdb_id, title, status, is_obsolete, superseded_by, obsolete_date, method, aggregation_state, resolution_angstrom, resolution_method, deposition_date, header_release_date, map_release_date, update_date, sample_name, macromolecule_names, supramolecule_names, fitted_pdb_ids, has_fitted_model, citation:{title, journal, year, published, doi, pmid, first_author, author_count}, map:{file, size_kbytes, dimensions:{col,row,sec}, voxel_size_angstrom:{x,y,z:{value,units}}}} | {emdb_id, error:"not_found"}]}.',
    example:
      'result = host.mcp("structures", "emdb_get_entries", {"emdb_ids": ["EMD-11638", "emd-3061", "1234"]})',
    run: async (ctx, a) => {
      const ids = idList(a)
      const records: Record<string, unknown>[] = []
      for (const raw of ids) {
        const norm = normalizeEmdbId(raw)
        try {
          const entry = asObj(await ctx.fetchJson(`${BASE}/entry/${norm}`))
          records.push(extractEntryRecord(entry))
        } catch (err) {
          if (isNotFound(err)) {
            records.push({ emdb_id: norm, error: 'not_found' })
            continue
          }
          throw err
        }
      }
      return { n_requested: ids.length, records }
    }
  },
  {
    id: 'emdb_search_entries',
    connector: 'structures',
    description:
      "Search EMDB with a Solr-style query; complete paged retrieval of compact rows. Query examples: 'title:\"apoferritin\" AND resolution:[0 TO 1.5]', 'structure_determination_method:\"singleParticle\"', 'current_status:\"REL\" AND release_date:[2024-01-01T00:00:00Z TO *]'. Args: query (Solr query string); max_rows (row cap, default 1000). Returns num_found_released (the API's own released-entry count from the facet route — ground truth), rows_retrieved, rows_by_status (REL vs OBS — the search route returns obsolete entries too but they are NOT counted as released), released_complete (true iff every released match was retrieved; false means max_rows truncated the sweep or the counts disagree), and records: compact per-entry rows (emdb_id, title, resolution, structure_determination_method, current_status, release_date, fitted_pdbs) sorted by EMD accession.",
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_rows: { type: 'integer', default: 1000 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{query, num_found_released (facet-route released count), rows_retrieved (REL+OBS, deduped), rows_by_status (e.g. {"OBS":19,"REL":890}), released_complete, records:[{emdb_id, title, resolution, structure_determination_method, fitted_pdbs, current_status, release_date}], max_rows}.',
    example:
      'result = host.mcp("structures", "emdb_search_entries", {"query": "title:\\"apoferritin\\" AND resolution:[0 TO 1.5]", "max_rows": 500})',
    run: async (ctx, a) => {
      const query = String(a.query)
      const maxRows = clampInt(a.max_rows, 1000, 1, 100_000)
      const result = await runSearchSpec(ctx, query, maxRows)
      return { ...result, max_rows: maxRows }
    }
  },
  {
    id: 'emdb_get_entry_section',
    connector: 'structures',
    description:
      "Fetch one detailed metadata section for EMDB entries. Sections: 'publications' — primary citation with complete ordered author list, auxiliary citations, external references (PMID/DOI/ISSN/CSD); 'map' — file, format, data type, dimensions, voxel spacing, origin, axis order, cell, voxel statistics, contour levels, symmetry; 'sample' — per-macromolecule records (type, molecular weight, copies, EC number, source organism + NCBI taxid, sequence cross-refs) and per-supramolecule records; 'imaging' — microscope, voltage, electron source, detector, dose, imaging modes, defocus range, magnification, Cs, cryogen, grid/buffer/vitrification conditions (one record per microscopy session — entries can carry several). Args: emdb_ids (accession list, any of EMD-1234/emd-1234/1234); section (one of publications/map/sample/imaging). Unknown accessions are reported with \"error\": \"not_found\". Use emdb_get_entries first when you only need the headline record.",
    input: {
      type: 'object',
      properties: {
        emdb_ids: { type: 'array', items: { type: 'string' } },
        section: { type: 'string', enum: ['publications', 'map', 'sample', 'imaging'] }
      },
      required: ['emdb_ids', 'section']
    },
    required: ['emdb_ids', 'section'],
    returns:
      '{n_requested, section, records:[<section record> | {emdb_id, error:"not_found"}]}. Section record shapes: publications -> {emdb_id, primary_citation, secondary_citations}; map -> {emdb_id, file, format, dimensions, pixel_spacing_angstrom, cell, statistics, contour_levels, space_group, ...}; sample -> {emdb_id, name, macromolecules[...], supramolecules[...]}; imaging -> {emdb_id, method, microscopy[...], specimen_preparations[...]}.',
    example:
      'result = host.mcp("structures", "emdb_get_entry_section", {"emdb_ids": ["EMD-11638"], "section": "imaging"})',
    run: async (ctx, a) => {
      const ids = idList(a)
      const section = String(a.section)
      const extract = SECTION_EXTRACTORS[section]
      if (!extract) {
        throw new Error(
          `unknown section '${section}'; expected one of imaging, map, publications, sample`
        )
      }
      const records: Record<string, unknown>[] = []
      for (const raw of ids) {
        const norm = normalizeEmdbId(raw)
        try {
          const entry = asObj(await ctx.fetchJson(`${BASE}/entry/${norm}`))
          records.push(extract(entry))
        } catch (err) {
          if (isNotFound(err)) {
            records.push({ emdb_id: norm, error: 'not_found' })
            continue
          }
          throw err
        }
      }
      return { n_requested: ids.length, section, records }
    }
  },
  {
    id: 'emdb_get_validation',
    connector: 'structures',
    description:
      'Fetch numeric validation-analysis metrics for EMDB entries. Per entry (from the EMDB /analysis route): Q-score, atom inclusion, recommended/predicted/rawmap contour levels, model/mask volumes, model-map ratio, surface metrics — where the validation pipeline has computed them. available_blocks lists every block the validation service returned; sparse payloads (tomograms, model-free or historical entries) yield explicit nulls. Entries with no validation analysis report has_validation_analysis=false — never silently dropped.',
    input: {
      type: 'object',
      properties: {
        emdb_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['emdb_ids']
    },
    required: ['emdb_ids'],
    returns:
      '{n_requested, records:[{emdb_id, has_validation_analysis, resolution_angstrom, qscore_average, atom_inclusion_average, available_blocks:[...], recommended_contour_level, predicated_contour_level, rawmap_contour_level, model_map_ratio, model_volume, mask_volume, surfaces, surface_ratio, feature_assessment, relion_mask_coverage}]} — scalar blocks are the raw numeric objects or null; unknown accessions get has_validation_analysis=false + error:"not_found".',
    example:
      'result = host.mcp("structures", "emdb_get_validation", {"emdb_ids": ["EMD-11638", "EMD-3061"]})',
    run: async (ctx, a) => {
      const ids = idList(a)
      const records: Record<string, unknown>[] = []
      for (const raw of ids) {
        const norm = normalizeEmdbId(raw)
        try {
          const payload = asObj(await ctx.fetchJson(`${BASE}/analysis/${norm}`))
          records.push(extractValidationRecord(payload, norm))
        } catch (err) {
          if (isNotFound(err)) {
            records.push({ emdb_id: norm, has_validation_analysis: false, error: 'not_found' })
            continue
          }
          throw err
        }
      }
      return { n_requested: ids.length, records }
    }
  }
]
