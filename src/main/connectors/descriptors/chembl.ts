import type { ToolContext, ToolDescriptor } from '../types'

// ChEMBL REST (EBI): read-only compound / drug / ADMET / bioactivity / mechanism / target lookups.
const BASE = 'https://www.ebi.ac.uk/chembl/api/data'
const DEFAULT_LIMIT = 20
// Hard ceiling on SMILES similarity/substructure page walks: generic scaffolds match tens of
// thousands of molecules, so cap the walk well above the request limit and disclose truncation.
const SEARCH_WALK_CAP = 10_000
// Popular targets carry ~900 xrefs each; bound the per-component join to keep responses small.
const MAX_XREFS_PER_COMPONENT = 50
// IDs per __in filter, keeping URLs well under length limits.
const BATCH_SIZE = 50
// Lean molecule field set for the indication -> parent join (the full record is fetched only for the page).
const DRUG_FIELDS =
  'molecule_chembl_id,pref_name,max_phase,first_approval,withdrawn_flag,black_box_warning,molecule_type,molecule_hierarchy'
// Only the indication-row fields consumed by the join (drugind_id, parent, best phase, efo term).
const INDICATION_FIELDS = 'drugind_id,parent_molecule_chembl_id,max_phase_for_ind,efo_term'

type Rec = Record<string, unknown>

// ChEMBL emits numerics as strings ("4.0", "1.31"); the original connector emitted them as numbers.
// null/undefined pass through as null; non-numeric strings are left untouched.
const num = (x: unknown): unknown => {
  if (x == null) return null
  if (typeof x === 'number') return x
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x)
    if (!Number.isNaN(n)) return n
  }
  return x
}

// 0/1 (or bool) -> bool; null/undefined -> null.
const bool = (x: unknown): unknown => (x == null ? null : Boolean(x))

// Passthrough that normalises undefined to null so JSON.stringify keeps the key (shape parity).
const nz = (x: unknown): unknown => (x === undefined ? null : x)

// Non-empty array or null (mirrors the upstream `value or None` for list fields).
const listOrNull = (x: unknown): unknown => (Array.isArray(x) && x.length > 0 ? x : null)

// Splits an id list into __in-sized chunks.
const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Lexical comparator matching Python's default string `<` ordering.
const byString = (a: unknown, b: unknown): number => {
  const x = String(a ?? '')
  const y = String(b ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}

// Clamps limit to [1, 1000] with a default of 20; `get(..., default)` semantics (limit=0 -> 1, not 20).
const clampLimit = (raw: unknown): number => {
  const n = raw == null ? DEFAULT_LIMIT : Math.trunc(Number(raw))
  return Math.max(1, Math.min(1000, Number.isNaN(n) ? DEFAULT_LIMIT : n))
}

// Builds a ChEMBL REST URL, dropping null/empty params and percent-encoding the rest.
const buildUrl = (path: string, params: Rec): string => {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${BASE}${path}${qs ? `?${qs}` : ''}`
}

// Extracts the record list, verified total_count, and `next` cursor from one paged ChEMBL envelope.
const pageItems = (
  raw: unknown,
  key: string
): { items: Rec[]; total: number | null; next: unknown } => {
  const p = (raw ?? {}) as Rec
  const meta = (p.page_meta ?? {}) as Rec
  return {
    items: (p[key] as Rec[]) ?? [],
    total: (meta.total_count as number) ?? null,
    next: meta.next
  }
}

// Walks a paged ChEMBL resource via limit/offset; stops at maxRecords (returns the true total_count).
async function paginate(
  ctx: ToolContext,
  path: string,
  itemsKey: string,
  params: Rec,
  opts: { pageSize?: number; maxRecords?: number } = {}
): Promise<{ records: Rec[]; total: number | null }> {
  const pageSize = opts.pageSize ?? 1000
  const records: Rec[] = []
  let total: number | null = null
  let offset = 0
  for (;;) {
    const raw = await ctx.fetchJson(buildUrl(path, { ...params, limit: pageSize, offset }))
    const { items, total: t, next } = pageItems(raw, itemsKey)
    total = t
    records.push(...items)
    if (opts.maxRecords != null && records.length >= opts.maxRecords) {
      return { records: records.slice(0, opts.maxRecords), total }
    }
    if (!next || items.length === 0) break
    offset += items.length
  }
  return { records, total }
}

// Molecule records for explicit IDs (batched __in, tolerant of missing), returned in input order.
async function getMolecules(ctx: ToolContext, ids: string[], only?: string): Promise<Rec[]> {
  const found = new Map<unknown, Rec>()
  for (const chunk of chunks(ids, BATCH_SIZE)) {
    const params: Rec = { molecule_chembl_id__in: chunk.join(',') }
    if (only) params.only = only
    const { records } = await paginate(ctx, '/molecule.json', 'molecules', params)
    for (const r of records) found.set(r.molecule_chembl_id, r)
  }
  return ids.filter((i) => found.has(i)).map((i) => found.get(i) as Rec)
}

// Withdrawal / black-box warning records for parent molecules (batched by parent id).
async function drugWarnings(ctx: ToolContext, ids: string[]): Promise<Rec[]> {
  const out: Rec[] = []
  for (const chunk of chunks(ids, BATCH_SIZE)) {
    const { records } = await paginate(ctx, '/drug_warning.json', 'drug_warnings', {
      parent_molecule_chembl_id__in: chunk.join(',')
    })
    out.push(...records)
  }
  return out
}

// De-duplicated, sorted (warning_type, warning_class, warning_country, warning_year) summary.
function summarizeWarnings(warnings: Rec[]): Rec[] {
  const seen = new Map<string, [unknown, unknown, unknown, unknown]>()
  for (const w of warnings) {
    const tuple: [unknown, unknown, unknown, unknown] = [
      w.warning_type ?? null,
      w.warning_class ?? null,
      w.warning_country ?? null,
      w.warning_year ?? null
    ]
    seen.set(JSON.stringify(tuple), tuple)
  }
  const tuples = [...seen.values()].sort((a, b) => {
    for (let i = 0; i < 4; i++) {
      const c = byString(a[i] == null ? '' : a[i], b[i] == null ? '' : b[i])
      if (c !== 0) return c
    }
    return 0
  })
  return tuples.map(([t, c, co, y]) => ({
    warning_type: t,
    warning_class: c,
    warning_country: co,
    warning_year: y
  }))
}

// 16-key molecule_properties block; `molecular_formula` renames REST `full_molformula`, and the two
// legacy fields (med_chem_friendly, molecular_species) pass through as their absent null.
function moleculePropertiesBlock(raw: unknown): Rec | null {
  if (raw == null) return null
  const mp = raw as Rec
  return {
    alogp: num(mp.alogp),
    aromatic_rings: nz(mp.aromatic_rings),
    full_mwt: num(mp.full_mwt),
    hba: nz(mp.hba),
    hbd: nz(mp.hbd),
    heavy_atoms: nz(mp.heavy_atoms),
    psa: num(mp.psa),
    rtb: nz(mp.rtb),
    ro3_pass: nz(mp.ro3_pass),
    num_ro5_violations: nz(mp.num_ro5_violations),
    qed_weighted: num(mp.qed_weighted),
    molecular_formula: nz(mp.full_molformula),
    mw_freebase: num(mp.mw_freebase),
    np_likeness_score: num(mp.np_likeness_score),
    med_chem_friendly: nz(mp.med_chem_friendly),
    molecular_species: nz(mp.molecular_species)
  }
}

// Raw /molecule (or /similarity, /substructure) record -> the original connector's compound shape.
function compoundRecord(m: Rec): Rec {
  const structures = (m.molecule_structures ?? {}) as Rec
  const atc = Array.isArray(m.atc_classifications) ? (m.atc_classifications as unknown[]) : []
  const score = 'similarity' in m ? m.similarity : m.score
  const atcOut = atc.map((code) => ({
    level1: null,
    level1_description: null,
    level2: null,
    level2_description: null,
    level3: null,
    level3_description: null,
    level4: null,
    level4_description: null,
    level5: code
  }))
  return {
    molecule_chembl_id: nz(m.molecule_chembl_id),
    pref_name: nz(m.pref_name),
    molecule_type: nz(m.molecule_type),
    max_phase: num(m.max_phase),
    first_approval: nz(m.first_approval),
    oral: bool(m.oral),
    parenteral: bool(m.parenteral),
    topical: bool(m.topical),
    black_box_warning: bool(m.black_box_warning),
    therapeutic_flag: bool(m.therapeutic_flag),
    natural_product: bool(m.natural_product),
    withdrawn_flag: bool(m.withdrawn_flag),
    molecule_properties: moleculePropertiesBlock(m.molecule_properties),
    smiles: nz(structures.canonical_smiles),
    inchi: nz(structures.standard_inchi),
    inchi_key: nz(structures.standard_inchi_key),
    synonyms: ((m.molecule_synonyms ?? []) as Rec[]).map((s) => nz(s.molecule_synonym)),
    availability_type: nz(m.availability_type),
    chirality: nz(m.chirality),
    chemical_probe: nz(m.chemical_probe),
    dosed_ingredient: bool(m.dosed_ingredient),
    first_in_class: nz(m.first_in_class),
    helm_notation: nz(m.helm_notation),
    inorganic_flag: nz(m.inorganic_flag),
    orphan: nz(m.orphan),
    polymer_flag: nz(m.polymer_flag),
    prodrug: nz(m.prodrug),
    structure_type: nz(m.structure_type),
    usan_stem: nz(m.usan_stem),
    usan_stem_definition: nz(m.usan_stem_definition),
    usan_substem: nz(m.usan_substem),
    usan_year: nz(m.usan_year),
    veterinary: nz(m.veterinary),
    score: num(score),
    cross_references: listOrNull(m.cross_references),
    atc_classifications: atcOut.length > 0 ? atcOut : null,
    molecule_hierarchy: nz(m.molecule_hierarchy)
  }
}

// { count, total (verified upstream total), compounds, truncated }.
function compoundSearchResponse(records: Rec[], total: number | null): Rec {
  const compounds = records.map(compoundRecord)
  const t = total == null ? compounds.length : total
  return { count: compounds.length, total: t, compounds, truncated: compounds.length < t }
}

// Full /molecule record (+ the indication-join dict) -> the original connector's drug shape. The
// type oddities (topical / black_box_warning as 0/1 ints, the rest as bools) reproduce the capture.
function drugRecord(m: Rec, joined: Rec): Rec {
  return {
    molecule_chembl_id: nz(m.molecule_chembl_id),
    pref_name: nz(m.pref_name),
    molecule_type: nz(m.molecule_type),
    max_phase: num(m.max_phase),
    first_approval: nz(m.first_approval),
    oral: bool(m.oral),
    parenteral: bool(m.parenteral),
    therapeutic_flag: bool(m.therapeutic_flag),
    indications: nz(m.indications),
    applicants: nz(m.applicants),
    atc_code_description: nz(m.atc_code_description),
    availability_type: nz(m.availability_type),
    biotherapeutic: nz(m.biotherapeutic),
    black_box: nz(m.black_box),
    black_box_warning: m.black_box_warning != null ? Math.trunc(Number(m.black_box_warning)) : null,
    chirality: nz(m.chirality),
    drug_type: nz(m.drug_type),
    first_in_class: nz(m.first_in_class),
    helm_notation: nz(m.helm_notation),
    molecule_properties: moleculePropertiesBlock(m.molecule_properties),
    molecule_structures: nz(m.molecule_structures),
    molecule_synonyms: nz(m.molecule_synonyms),
    ob_patent: nz(m.ob_patent),
    sc_patent: nz(m.sc_patent),
    prodrug: nz(m.prodrug),
    research_codes: nz(m.research_codes),
    rule_of_five: nz(m.rule_of_five),
    synonyms: nz(m.synonyms),
    topical: m.topical != null ? Math.trunc(Number(m.topical)) : null,
    usan_stem: nz(m.usan_stem),
    usan_stem_definition: nz(m.usan_stem_definition),
    usan_stem_substem: nz(m.usan_stem_substem),
    usan_year: nz(m.usan_year),
    withdrawn_flag: bool(m.withdrawn_flag),
    // Indication-join context: matched drug_indication rows, best phase for THIS indication, warnings.
    best_phase_for_ind: joined.best_phase_for_ind ?? null,
    efo_terms: joined.efo_terms ?? null,
    indication_rows: joined.indication_rows ?? null,
    warning_summary: joined.warning_summary ?? null
  }
}

// { count, total, drugs, truncated, indication_query, total_indication_rows }.
function drugSearchResponse(
  pairs: [Rec, Rec][],
  total: number,
  indicationQuery: Rec,
  totalIndicationRows: number | null
): Rec {
  const drugs = pairs.map(([m, joined]) => drugRecord(m, joined))
  return {
    count: drugs.length,
    total,
    drugs,
    truncated: drugs.length < total,
    indication_query: indicationQuery,
    total_indication_rows: totalIndicationRows
  }
}

// Raw /molecule properties -> the ADMET calculated-property subset; found:false when absent.
function admetResponse(molecule: Rec | null, molId: string): Rec {
  if (molecule == null) {
    return { found: false, properties: null, message: `No molecule found for ${molId}` }
  }
  const mp = (molecule.molecule_properties ?? {}) as Rec
  return {
    found: true,
    properties: {
      molecule_chembl_id: nz(molecule.molecule_chembl_id),
      alogp: num(mp.alogp),
      molecular_weight: num(mp.full_mwt),
      mw_freebase: num(mp.mw_freebase),
      psa: num(mp.psa),
      hba: nz(mp.hba),
      hbd: nz(mp.hbd),
      rtb: nz(mp.rtb),
      aromatic_rings: nz(mp.aromatic_rings),
      heavy_atoms: nz(mp.heavy_atoms),
      num_ro5_violations: nz(mp.num_ro5_violations),
      ro3_pass: nz(mp.ro3_pass),
      qed_weighted: num(mp.qed_weighted),
      molecular_formula: nz(mp.full_molformula)
    }
  }
}

// Raw /activity record -> the original's 45-key shape (numeric strings become numbers).
function activityRecord(a: Rec): Rec {
  let le = a.ligand_efficiency
  if (le != null && typeof le === 'object' && !Array.isArray(le)) {
    le = Object.fromEntries(Object.entries(le as Rec).map(([k, v]) => [k, num(v)]))
  }
  return {
    activity_id: nz(a.activity_id),
    molecule_chembl_id: nz(a.molecule_chembl_id),
    target_chembl_id: nz(a.target_chembl_id),
    target_pref_name: nz(a.target_pref_name),
    target_organism: nz(a.target_organism),
    standard_type: nz(a.standard_type),
    standard_relation: nz(a.standard_relation),
    standard_value: num(a.standard_value),
    standard_units: nz(a.standard_units),
    pchembl_value: num(a.pchembl_value),
    assay_chembl_id: nz(a.assay_chembl_id),
    assay_description: nz(a.assay_description),
    assay_type: nz(a.assay_type),
    data_validity_comment: nz(a.data_validity_comment),
    activity_comment: nz(a.activity_comment),
    activity_properties: listOrNull(a.activity_properties),
    action_type: nz(a.action_type),
    bao_endpoint: nz(a.bao_endpoint),
    bao_format: nz(a.bao_format),
    bao_label: nz(a.bao_label),
    canonical_smiles: nz(a.canonical_smiles),
    data_validity_description: nz(a.data_validity_description),
    document_chembl_id: nz(a.document_chembl_id),
    document_journal: nz(a.document_journal),
    document_year: nz(a.document_year),
    ligand_efficiency: le ?? null,
    molecule_pref_name: nz(a.molecule_pref_name),
    parent_molecule_chembl_id: nz(a.parent_molecule_chembl_id),
    potential_duplicate: nz(a.potential_duplicate),
    qudt_units: nz(a.qudt_units),
    uo_units: nz(a.uo_units),
    record_id: nz(a.record_id),
    src_id: nz(a.src_id),
    toid: nz(a.toid),
    standard_flag: nz(a.standard_flag),
    standard_text_value: nz(a.standard_text_value),
    standard_upper_value: num(a.standard_upper_value),
    target_tax_id: nz(a.target_tax_id),
    text_value: nz(a.text_value),
    type: nz(a.type),
    units: nz(a.units),
    upper_value: num(a.upper_value),
    value: num(a.value),
    relation: nz(a.relation),
    assay_variant_accession: nz(a.assay_variant_accession),
    assay_variant_mutation: nz(a.assay_variant_mutation)
  }
}

// One-line "most potent activities" digest over the pChEMBL-scored records (top 3).
function activitySummary(activities: Rec[]): string {
  const scored = activities.filter((a) => a.pchembl_value != null)
  scored.sort((a, b) => {
    const pa = Number(a.pchembl_value)
    const pb = Number(b.pchembl_value)
    if (pb !== pa) return pb - pa
    const sa = a.standard_value != null ? Number(a.standard_value) : 0
    const sb = b.standard_value != null ? Number(b.standard_value) : 0
    return sa - sb
  })
  const top = scored.slice(0, 3)
  if (top.length === 0) return 'No pChEMBL-scored activities in this result set'
  const parts = top.map(
    (a) =>
      `${a.target_pref_name}: ${a.standard_type}=${a.standard_value}${a.standard_units ?? ''} ` +
      `(pChEMBL=${Number(a.pchembl_value).toFixed(2)})`
  )
  return 'Most potent activities: ' + parts.join('; ')
}

// { count, total, activities, summary, truncated }.
function bioactivityResponse(raw: Rec[], total: number | null): Rec {
  const activities = raw.map(activityRecord)
  const t = total == null ? activities.length : total
  return {
    count: activities.length,
    total: t,
    activities,
    summary: activitySummary(activities),
    truncated: activities.length < t
  }
}

// Raw /mechanism record -> original shape (direct_interaction / disease_efficacy become bools).
function mechanismRecord(m: Rec): Rec {
  return {
    mec_id: nz(m.mec_id),
    molecule_chembl_id: nz(m.molecule_chembl_id),
    mechanism_of_action: nz(m.mechanism_of_action),
    target_chembl_id: nz(m.target_chembl_id),
    action_type: nz(m.action_type),
    direct_interaction: bool(m.direct_interaction),
    disease_efficacy: bool(m.disease_efficacy),
    mechanism_comment: nz(m.mechanism_comment),
    binding_site_comment: nz(m.binding_site_comment),
    selectivity_comment: nz(m.selectivity_comment),
    molecular_mechanism: nz(m.molecular_mechanism),
    max_phase: nz(m.max_phase),
    parent_molecule_chembl_id: nz(m.parent_molecule_chembl_id),
    record_id: nz(m.record_id),
    site_id: nz(m.site_id),
    mechanism_refs: nz(m.mechanism_refs),
    variant_sequence: nz(m.variant_sequence)
  }
}

// { count, total, mechanisms, summary (action-type histogram), truncated }.
function mechanismResponse(raw: Rec[], total: number | null): Rec {
  const mechanisms = raw.map(mechanismRecord)
  const t = total == null ? mechanisms.length : total
  const counts = new Map<string, number>()
  for (const m of mechanisms) {
    const at = m.action_type
    if (at) counts.set(String(at), (counts.get(String(at)) ?? 0) + 1)
  }
  let summary: string
  if (counts.size > 0) {
    const ordered = [...counts.entries()].sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : byString(a[0], b[0])
    )
    summary = 'Primary action types: ' + ordered.map(([type, n]) => `${type} (${n})`).join(', ')
  } else {
    summary = 'No mechanism of action records found'
  }
  return {
    count: mechanisms.length,
    total: t,
    mechanisms,
    summary,
    truncated: mechanisms.length < t
  }
}

// Raw /target record -> original shape: gene_symbol from the first GENE_SYMBOL synonym, xrefs bounded.
function targetRecord(t: Rec): Rec {
  const components: Rec[] = []
  for (const raw of (t.target_components ?? []) as Rec[]) {
    const synonyms = (raw.target_component_synonyms ?? []) as Rec[]
    const geneSymbol =
      (synonyms.find((s) => s.syn_type === 'GENE_SYMBOL')?.component_synonym as unknown) ?? null
    const xrefs = (raw.target_component_xrefs ?? []) as Rec[]
    const component: Rec = {
      component_id: nz(raw.component_id),
      component_type: nz(raw.component_type),
      accession: nz(raw.accession),
      component_description: nz(raw.component_description),
      gene_symbol: geneSymbol,
      relationship: nz(raw.relationship),
      target_component_xrefs: xrefs.slice(0, MAX_XREFS_PER_COMPONENT).map((x) => ({
        xref_id: nz(x.xref_id),
        xref_name: nz(x.xref_name),
        xref_src_db: nz(x.xref_src_db),
        xref_src_url: nz(x.xref_src_url)
      }))
    }
    if (xrefs.length > MAX_XREFS_PER_COMPONENT) component.xrefs_truncated_from = xrefs.length
    components.push(component)
  }
  return {
    target_chembl_id: nz(t.target_chembl_id),
    pref_name: nz(t.pref_name),
    target_type: nz(t.target_type),
    organism: nz(t.organism),
    tax_id: nz(t.tax_id),
    components,
    species_group_flag: bool(t.species_group_flag),
    cross_references: listOrNull(t.cross_references),
    score: num(t.score)
  }
}

// { count, total, targets, truncated }.
function targetSearchResponse(raw: Rec[], total: number | null): Rec {
  const targets = raw.map(targetRecord)
  const t = total == null ? targets.length : total
  return { count: targets.length, total: t, targets, truncated: targets.length < t }
}

// Indication -> distinct parents -> molecule (lean) + warning join; the drug-search core step.
async function searchDrugsByIndication(
  ctx: ToolContext,
  indication: string,
  onlyApproved: boolean,
  maxDrugs: number | null
): Promise<{
  indicationQuery: Rec
  totalIndicationRows: number | null
  totalParents: number
  drugs: Rec[]
}> {
  const params: Rec = { efo_term__icontains: indication, only: INDICATION_FIELDS }
  if (onlyApproved) params.max_phase_for_ind = 4
  const { records: rows, total } = await paginate(
    ctx,
    '/drug_indication.json',
    'drug_indications',
    params
  )

  // Best phase per distinct parent molecule.
  const phaseByParent = new Map<string, number>()
  for (const r of rows) {
    const p = r.parent_molecule_chembl_id as string | undefined
    if (!p) continue
    const ph = r.max_phase_for_ind != null ? Number(r.max_phase_for_ind) : -1
    if (ph > (phaseByParent.has(p) ? (phaseByParent.get(p) as number) : -2))
      phaseByParent.set(p, ph)
  }
  // Most clinically advanced first (best phase desc), ChEMBL id as the deterministic tiebreak.
  const allParents = [...phaseByParent.keys()].sort((a, b) => {
    const pa = phaseByParent.get(a) as number
    const pb = phaseByParent.get(b) as number
    return pb !== pa ? pb - pa : byString(a, b)
  })
  const parents = maxDrugs == null ? allParents : allParents.slice(0, maxDrugs)

  const molById = new Map<unknown, Rec>()
  if (parents.length > 0) {
    for (const m of await getMolecules(ctx, parents, DRUG_FIELDS))
      molById.set(m.molecule_chembl_id, m)
  }
  const warningsByParent = new Map<unknown, Rec[]>()
  if (parents.length > 0) {
    for (const w of await drugWarnings(ctx, parents)) {
      const k = w.parent_molecule_chembl_id
      const list = warningsByParent.get(k) ?? []
      list.push(w)
      warningsByParent.set(k, list)
    }
  }

  const drugs = parents.map((parent) => {
    const mol = molById.get(parent) ?? {}
    const myRows = rows.filter((r) => r.parent_molecule_chembl_id === parent)
    const phases = myRows
      .filter((r) => r.max_phase_for_ind != null)
      .map((r) => Number(r.max_phase_for_ind))
    return {
      parent_molecule_chembl_id: parent,
      pref_name: mol.pref_name ?? null,
      max_phase: mol.max_phase ?? null,
      first_approval: mol.first_approval ?? null,
      withdrawn_flag: mol.withdrawn_flag ?? null,
      black_box_warning: mol.black_box_warning ?? null,
      molecule_type: mol.molecule_type ?? null,
      indication_rows: myRows.map((r) => r.drugind_id),
      best_phase_for_ind: phases.length > 0 ? Math.max(...phases) : null,
      efo_terms: [...new Set(myRows.map((r) => r.efo_term).filter(Boolean) as string[])].sort(
        byString
      ),
      warning_summary: summarizeWarnings(warningsByParent.get(parent) ?? [])
    }
  })

  return {
    indicationQuery: { term: indication, match_field: 'efo', only_approved: onlyApproved },
    totalIndicationRows: total,
    totalParents: allParents.length,
    drugs
  }
}

const COMPOUND_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description:
        'Compound name or synonym (case-insensitive substring). Primary search criterion.'
    },
    chembl_id: { type: 'string', description: "ChEMBL identifier, e.g. 'CHEMBL25' for aspirin." },
    smiles: { type: 'string', description: 'SMILES structure for similarity/substructure search.' },
    similarity_threshold: {
      type: 'integer',
      minimum: 70,
      maximum: 100,
      description: 'Similarity cutoff % (70-100). Only with smiles; omit for a substructure search.'
    },
    max_phase: {
      type: 'integer',
      enum: [0, 1, 2, 3, 4],
      description: 'Filter by clinical phase. 4 = approved.'
    },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 }
  }
}

export const CHEMBL_TOOLS: ToolDescriptor[] = [
  {
    id: 'compound_search',
    connector: 'chembl',
    description:
      'Search ChEMBL chemical compounds by name (default), ChEMBL id, or molecular structure. By name: case-insensitive synonym substring match (falls back to a preferred-name match). By chembl_id: direct record lookup. By smiles: Tanimoto similarity search when similarity_threshold is set, else a substructure search (structure walks are capped and disclose walk_truncated/upstream_total). Optional max_phase filters by clinical stage. Pass at least one of name, chembl_id, or smiles. Use drug_search instead when searching by therapeutic indication.',
    input: COMPOUND_INPUT,
    returns:
      '`{ count, total (verified upstream total_count), truncated, compounds: [ { molecule_chembl_id, pref_name, molecule_type, max_phase, first_approval, oral, parenteral, topical, black_box_warning, therapeutic_flag, natural_product, withdrawn_flag, molecule_properties: { alogp, aromatic_rings, full_mwt, hba, hbd, heavy_atoms, psa, rtb, ro3_pass, num_ro5_violations, qed_weighted, molecular_formula, mw_freebase, np_likeness_score, med_chem_friendly, molecular_species }, smiles, inchi, inchi_key, synonyms: [str], chirality, score, atc_classifications, molecule_hierarchy, ... } ] }`. Structure searches may add `walk_truncated` + `upstream_total`.',
    example: 'result = host.mcp("chembl", "compound_search", {"name": "aspirin", "limit": 5})',
    run: async (ctx, a) => {
      if (!a.name && !a.chembl_id && !a.smiles) {
        throw new Error('compound_search requires at least one of name, chembl_id, or smiles.')
      }
      const limit = clampLimit(a.limit)
      const maxPhase = a.max_phase

      // By ChEMBL id: direct record lookup, client-side max_phase filter, total = matches kept.
      if (a.chembl_id) {
        const { records } = await paginate(
          ctx,
          '/molecule.json',
          'molecules',
          { molecule_chembl_id__in: a.chembl_id },
          { pageSize: limit, maxRecords: limit }
        )
        let recs = records
        if (maxPhase != null) {
          recs = recs.filter((m) => m.max_phase != null && Number(m.max_phase) === Number(maxPhase))
        }
        return compoundSearchResponse(recs.slice(0, limit), recs.length)
      }

      // By structure: similarity (threshold set) or substructure; walk is capped and deterministically sorted.
      if (a.smiles) {
        const enc = encodeURIComponent(String(a.smiles))
        const threshold = a.similarity_threshold
        let walk: { records: Rec[]; total: number | null }
        if (threshold != null) {
          walk = await paginate(
            ctx,
            `/similarity/${enc}/${Number(threshold)}.json`,
            'molecules',
            {},
            { maxRecords: SEARCH_WALK_CAP }
          )
          walk.records = [...walk.records].sort((x, y) => {
            const sx = Number(x.similarity ?? 0) || 0
            const sy = Number(y.similarity ?? 0) || 0
            return sy !== sx ? sy - sx : byString(x.molecule_chembl_id, y.molecule_chembl_id)
          })
        } else {
          walk = await paginate(
            ctx,
            `/substructure/${enc}.json`,
            'molecules',
            {},
            { maxRecords: SEARCH_WALK_CAP }
          )
          walk.records = [...walk.records].sort((x, y) =>
            byString(x.molecule_chembl_id, y.molecule_chembl_id)
          )
        }
        const walkTruncated = walk.total != null && walk.total > walk.records.length
        let recs = walk.records
        if (maxPhase != null) {
          recs = recs.filter((m) => m.max_phase != null && Number(m.max_phase) === Number(maxPhase))
        }
        const resp = compoundSearchResponse(recs.slice(0, limit), recs.length)
        if (walkTruncated) {
          resp.walk_truncated = true
          resp.upstream_total = walk.total
        }
        return resp
      }

      // By name: synonym substring match, then a preferred-name fallback; server-side max_phase filter.
      const params: Rec = { molecule_synonyms__molecule_synonym__icontains: a.name }
      if (maxPhase != null) params.max_phase = maxPhase
      let res = await paginate(ctx, '/molecule.json', 'molecules', params, {
        pageSize: limit,
        maxRecords: limit
      })
      if (res.records.length === 0) {
        const fallback: Rec = { pref_name__icontains: a.name }
        if (maxPhase != null) fallback.max_phase = maxPhase
        res = await paginate(ctx, '/molecule.json', 'molecules', fallback, {
          pageSize: limit,
          maxRecords: limit
        })
      }
      return compoundSearchResponse(res.records, res.total)
    }
  },
  {
    id: 'drug_search',
    connector: 'chembl',
    description:
      'Search approved drugs and clinical candidates by therapeutic indication (EFO term, partial match). Joins drug_indication rows to distinct parent molecules, then to molecule records and withdrawal/black-box warnings. only_approved restricts to phase 4. Optional post-filters molecule_chembl_id, drug_name (preferred-name substring), and max_phase (>=) narrow the joined set. Use compound_search for name/id/structure lookups.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        indication: {
          type: 'string',
          description:
            "Disease indication, e.g. 'hypertension', 'cancer'. Primary search criterion."
        },
        drug_name: {
          type: 'string',
          description: 'Filter joined drugs by preferred-name substring.'
        },
        molecule_chembl_id: {
          type: 'string',
          description: 'Filter joined drugs to this parent molecule id.'
        },
        max_phase: {
          type: 'integer',
          enum: [0, 1, 2, 3, 4],
          description: 'Keep drugs whose max_phase is >= this value.'
        },
        only_approved: {
          type: 'boolean',
          default: false,
          description: 'Only approved drugs (phase 4).'
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 }
      },
      required: ['indication']
    },
    required: ['indication'],
    returns:
      '`{ count, total (distinct parents, or filtered count when a post-filter is set), truncated, indication_query: { term, match_field, only_approved }, total_indication_rows, drugs: [ { molecule_chembl_id, pref_name, molecule_type, max_phase, first_approval, oral, parenteral, therapeutic_flag, black_box_warning (0/1), topical (0/1), withdrawn_flag, molecule_properties, molecule_structures, molecule_synonyms, best_phase_for_ind, efo_terms: [str], indication_rows: [drugind_id], warning_summary: [ { warning_type, warning_class, warning_country, warning_year } ], ... } ] }`.',
    example:
      'result = host.mcp("chembl", "drug_search", {"indication": "hypertension", "only_approved": True, "limit": 10})',
    run: async (ctx, a) => {
      const limit = clampLimit(a.limit)
      // Post-filters need the full parent set joined; otherwise bound the join to the first page.
      const postFiltered = Boolean(a.molecule_chembl_id || a.drug_name || a.max_phase != null)
      const res = await searchDrugsByIndication(
        ctx,
        String(a.indication),
        Boolean(a.only_approved),
        postFiltered ? null : limit
      )
      let drugs = res.drugs
      if (a.molecule_chembl_id) {
        drugs = drugs.filter((d) => d.parent_molecule_chembl_id === a.molecule_chembl_id)
      }
      if (a.drug_name) {
        const needle = String(a.drug_name).toLowerCase()
        drugs = drugs.filter((d) =>
          String(d.pref_name ?? '')
            .toLowerCase()
            .includes(needle)
        )
      }
      if (a.max_phase != null) {
        const wanted = Number(a.max_phase)
        drugs = drugs.filter((d) => d.max_phase != null && Number(d.max_phase) >= wanted)
      }
      const total = postFiltered ? drugs.length : res.totalParents
      const page = drugs.slice(0, limit)
      // Re-join full molecule records for the page by id (never zip-by-position), tolerating gaps.
      const molById = new Map<unknown, Rec>()
      if (page.length > 0) {
        const full = await getMolecules(
          ctx,
          page.map((d) => d.parent_molecule_chembl_id as string)
        )
        for (const m of full) molById.set(m.molecule_chembl_id, m)
      }
      const pairs = page.map(
        (d) => [molById.get(d.parent_molecule_chembl_id) ?? {}, d] as [Rec, Rec]
      )
      return drugSearchResponse(pairs, total, res.indicationQuery, res.totalIndicationRows)
    }
  },
  {
    id: 'get_admet',
    connector: 'chembl',
    description:
      'Retrieve ChEMBL calculated molecular properties for drug-likeness / ADMET assessment of one molecule (ALogP, molecular weight, PSA, HBA/HBD, rotatable bonds, aromatic rings, heavy atoms, Rule-of-5 violations, Rule-of-3 pass, QED, molecular formula). These are computed from structure, not experimental measurements.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        molecule_chembl_id: {
          type: 'string',
          description:
            "ChEMBL molecule id, e.g. 'CHEMBL941'. Use compound_search first if you only have a name."
        }
      },
      required: ['molecule_chembl_id']
    },
    required: ['molecule_chembl_id'],
    returns:
      '`{ found: bool, properties: { molecule_chembl_id, alogp, molecular_weight, mw_freebase, psa, hba, hbd, rtb, aromatic_rings, heavy_atoms, num_ro5_violations, ro3_pass, qed_weighted, molecular_formula } | null, message? }`. When the id is unknown, `found` is false, `properties` null, and `message` explains.',
    example: 'result = host.mcp("chembl", "get_admet", {"molecule_chembl_id": "CHEMBL25"})',
    run: async (ctx, a) => {
      const molId = String(a.molecule_chembl_id)
      const { records } = await paginate(
        ctx,
        '/molecule.json',
        'molecules',
        { molecule_chembl_id__in: molId },
        { pageSize: 1, maxRecords: 1 }
      )
      return admetResponse(records[0] ?? null, molId)
    }
  },
  {
    id: 'get_bioactivity',
    connector: 'chembl',
    description:
      'Retrieve ChEMBL bioactivity measurements (IC50, Ki, Kd, EC50, ...) for compound-target interactions. Filter by molecule_chembl_id and/or target_chembl_id, activity_type (standard_type), a pChEMBL floor (min_pchembl), a standard_value range (min_value/max_value), and unit (standard_units). Returns one page ordered by activity_id with a most-potent summary.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        molecule_chembl_id: { type: 'string', description: "ChEMBL molecule id, e.g. 'CHEMBL25'." },
        target_chembl_id: {
          type: 'string',
          description: "ChEMBL target id, e.g. 'CHEMBL240' (hERG)."
        },
        activity_type: {
          type: 'string',
          enum: ['IC50', 'EC50', 'Ki', 'Kd', 'AC50', 'GI50', 'ED50', 'Potency'],
          description: 'standard_type to filter on.'
        },
        min_pchembl: {
          type: 'number',
          minimum: 0,
          maximum: 14,
          description: 'Minimum pChEMBL value.'
        },
        min_value: { type: 'number', description: 'Minimum standard_value (in unit).' },
        max_value: { type: 'number', description: 'Maximum standard_value (in unit).' },
        unit: {
          type: 'string',
          enum: ['nM', 'uM', 'mM', 'pM', 'M'],
          description: 'standard_units filter.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 }
      }
    },
    returns:
      '`{ count, total (verified upstream total_count), truncated, summary, activities: [ { activity_id, molecule_chembl_id, target_chembl_id, target_pref_name, standard_type, standard_relation, standard_value, standard_units, pchembl_value, assay_chembl_id, assay_type, ligand_efficiency, document_chembl_id, ... 45 keys } ] }`.',
    example:
      'result = host.mcp("chembl", "get_bioactivity", {"molecule_chembl_id": "CHEMBL25", "activity_type": "IC50", "limit": 10})',
    run: async (ctx, a) => {
      const limit = clampLimit(a.limit)
      const params: Rec = {}
      if (a.molecule_chembl_id) params.molecule_chembl_id = a.molecule_chembl_id
      if (a.target_chembl_id) params.target_chembl_id = a.target_chembl_id
      if (a.activity_type) params.standard_type = a.activity_type
      if (a.min_pchembl != null) params.pchembl_value__gte = a.min_pchembl
      if (a.min_value != null) params.standard_value__gte = a.min_value
      if (a.max_value != null) params.standard_value__lte = a.max_value
      if (a.unit) params.standard_units = a.unit
      const raw = await ctx.fetchJson(
        buildUrl('/activity.json', { ...params, limit, offset: 0, order_by: 'activity_id' })
      )
      const { items, total } = pageItems(raw, 'activities')
      return bioactivityResponse(items, total)
    }
  },
  {
    id: 'get_mechanism',
    connector: 'chembl',
    description:
      'Retrieve ChEMBL mechanism-of-action records for approved drugs and clinical candidates. Filter by molecule_chembl_id, target_chembl_id, and/or action_type. When a molecule id yields nothing, retries against the parent molecule so salt-form ids resolve. Returns one page ordered by mec_id with an action-type summary.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        molecule_chembl_id: { type: 'string', description: "ChEMBL molecule id, e.g. 'CHEMBL25'." },
        target_chembl_id: { type: 'string', description: "ChEMBL target id, e.g. 'CHEMBL1824'." },
        action_type: {
          type: 'string',
          enum: [
            'INHIBITOR',
            'AGONIST',
            'ANTAGONIST',
            'BLOCKER',
            'MODULATOR',
            'OPENER',
            'ACTIVATOR',
            'POSITIVE ALLOSTERIC MODULATOR',
            'NEGATIVE ALLOSTERIC MODULATOR',
            'PARTIAL AGONIST',
            'INVERSE AGONIST'
          ],
          description: 'Mechanism action type.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 }
      }
    },
    returns:
      '`{ count, total, truncated, summary, mechanisms: [ { mec_id, molecule_chembl_id, mechanism_of_action, target_chembl_id, action_type, direct_interaction (bool), disease_efficacy (bool), mechanism_comment, binding_site_comment, selectivity_comment, molecular_mechanism, max_phase, parent_molecule_chembl_id, mechanism_refs, ... } ] }`.',
    example: 'result = host.mcp("chembl", "get_mechanism", {"molecule_chembl_id": "CHEMBL25"})',
    run: async (ctx, a) => {
      const limit = clampLimit(a.limit)
      const params: Rec = {}
      if (a.target_chembl_id) params.target_chembl_id = a.target_chembl_id
      if (a.action_type) params.action_type = a.action_type
      const molId = a.molecule_chembl_id
      if (molId) params.molecule_chembl_id = molId
      let raw = await ctx.fetchJson(
        buildUrl('/mechanism.json', { ...params, limit, offset: 0, order_by: 'mec_id' })
      )
      let { items, total } = pageItems(raw, 'mechanisms')
      // Mechanisms may be stored under the salt form; retry matching the parent molecule.
      if (items.length === 0 && molId) {
        const parentParams: Rec = { ...params }
        delete parentParams.molecule_chembl_id
        parentParams.parent_molecule_chembl_id = molId
        raw = await ctx.fetchJson(
          buildUrl('/mechanism.json', { ...parentParams, limit, offset: 0, order_by: 'mec_id' })
        )
        ;({ items, total } = pageItems(raw, 'mechanisms'))
      }
      return mechanismResponse(items, total)
    }
  },
  {
    id: 'target_search',
    connector: 'chembl',
    description:
      'Search ChEMBL biological targets (proteins, complexes, families, organisms). Filter by target_chembl_id, gene_symbol (exact component-synonym match), target_name (preferred-name substring), organism (substring), and/or target_type. Each result carries its components with UniProt accessions, a gene_symbol, and bounded cross-reference lists.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_name: { type: 'string', description: "Target name / partial name, e.g. 'kinase'." },
        gene_symbol: { type: 'string', description: "Gene symbol (exact), e.g. 'EGFR', 'BRAF'." },
        target_chembl_id: { type: 'string', description: "ChEMBL target id, e.g. 'CHEMBL203'." },
        organism: { type: 'string', description: "Organism, e.g. 'Homo sapiens'." },
        target_type: {
          type: 'string',
          enum: [
            'SINGLE PROTEIN',
            'PROTEIN COMPLEX',
            'PROTEIN FAMILY',
            'ORGANISM',
            'TISSUE',
            'CELL-LINE',
            'NUCLEIC-ACID',
            'SUBCELLULAR'
          ],
          description: 'Target type filter.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 20 }
      }
    },
    returns:
      '`{ count, total (verified upstream total_count), truncated, targets: [ { target_chembl_id, pref_name, target_type, organism, tax_id, species_group_flag, cross_references, score, components: [ { component_id, component_type, accession, component_description, gene_symbol, relationship, target_component_xrefs: [ { xref_id, xref_name, xref_src_db, xref_src_url } ], xrefs_truncated_from? } ] } ] }`.',
    example:
      'result = host.mcp("chembl", "target_search", {"gene_symbol": "EGFR", "organism": "Homo sapiens", "limit": 5})',
    run: async (ctx, a) => {
      const limit = clampLimit(a.limit)
      const params: Rec = {}
      if (a.target_chembl_id) params.target_chembl_id = a.target_chembl_id
      if (a.gene_symbol) {
        params['target_components__target_component_synonyms__component_synonym__iexact'] =
          a.gene_symbol
      }
      if (a.target_name) params.pref_name__icontains = a.target_name
      if (a.organism) params.organism__icontains = a.organism
      if (a.target_type) params.target_type = a.target_type
      const { records, total } = await paginate(ctx, '/target.json', 'targets', params, {
        pageSize: limit,
        maxRecords: limit
      })
      return targetSearchResponse(records, total)
    }
  }
]
