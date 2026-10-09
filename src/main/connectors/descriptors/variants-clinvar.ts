import { DOMParser } from '@xmldom/xmldom'
import { ncbiEtiquette } from './ncbi'
import type { ToolContext, ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// These direct-ClinVar tools mandate a contact email (NCBI E-utilities usage policy) — unlike the
// gnomAD/CADD tools, a missing email is a structured result, not a silent keyless call.
const MAX_RETMAX = 200
const MAX_BATCH_ACCESSIONS = 50
// Wall-clock budget for RCV resolution (each RCV costs one esearch). Inputs left unresolved when the
// budget runs out land in not_processed rather than blowing the MCP transport limit.
const RCV_DEADLINE_MS = 40_000

const VCV_RE = /^VCV(\d+)(?:\.\d+)?$/i
const RCV_RE = /^RCV\d+(?:\.\d+)?$/i
const RSID_RE = /^rs\d+$/i

// Structured "contact email required" result (mirrors the upstream _contact_required_result). Run()
// returns this instead of throwing so the message reaches the agent as a clean tool result.
type ContactRequired = { error: 'contact_email_required'; message: string }
function contactRequired(): ContactRequired {
  return {
    error: 'contact_email_required',
    message:
      'This tool talks to NCBI E-utilities, which require a contact email per their usage policy. ' +
      "Enable 'Share contact email with research data services' in Settings → Privacy to " +
      'provide one, then retry (the connector picks up the setting automatically).'
  }
}

// -- esummary db=clinvar document shape (only the fields the canonical record reads) --------------

type XrefRaw = { db_source?: string; db_id?: string }
type TraitRaw = { trait_name?: string; trait_xrefs?: XrefRaw[] }
type ClassificationBlockRaw = {
  description?: string
  review_status?: string
  last_evaluated?: string
  fda_recognized_database?: string
  trait_set?: TraitRaw[]
}
type VariationLocRaw = {
  status?: string
  assembly_name?: string
  chr?: string
  band?: string
  start?: string
  stop?: string
  ref?: string
  alt?: string
}
type VariationSetRaw = {
  variant_type?: string
  canonical_spdi?: string
  cdna_change?: string
  variation_xrefs?: XrefRaw[]
  allele_freq_set?: Array<{ source?: string; minor_allele?: string; value?: string }>
  variation_loc?: VariationLocRaw[]
}
type ClinVarSummaryDoc = {
  uid?: string
  error?: string
  accession?: string
  accession_version?: string
  title?: string
  obj_type?: string
  protein_change?: string
  genes?: Array<{ symbol?: string; geneid?: string; strand?: string }>
  molecular_consequence_list?: string[]
  variation_set?: VariationSetRaw[]
  supporting_submissions?: { scv?: string[]; rcv?: string[] }
  germline_classification?: ClassificationBlockRaw
  clinical_impact_classification?: ClassificationBlockRaw
  oncogenicity_classification?: ClassificationBlockRaw
}

// Official ClinVar review-status -> gold-star mapping
// (https://www.ncbi.nlm.nih.gov/clinvar/docs/review_status/). Both the current "conflicting
// classifications" wording and the pre-2024 "conflicting interpretations" wording are mapped.
const GOLD_STARS: Record<string, number> = {
  'practice guideline': 4,
  'reviewed by expert panel': 3,
  'criteria provided, multiple submitters, no conflicts': 2,
  'criteria provided, multiple submitters': 2,
  'criteria provided, conflicting classifications': 1,
  'criteria provided, conflicting interpretations': 1,
  'criteria provided, single submitter': 1,
  'no assertion criteria provided': 0,
  'no classification provided': 0,
  'no classification for the individual variant': 0,
  'no classifications from unflagged records': 0,
  'no assertion provided': 0
}

// esummary's "absent date" sentinel.
const NO_DATE = '1/01/01 00:00'

function goldStars(reviewStatus: string): number | null {
  const key = (reviewStatus || '').trim().toLowerCase()
  return key in GOLD_STARS ? GOLD_STARS[key] : null
}

// `2022/10/12 00:00` -> `2022-10-12`; the 1/01/01 sentinel (and empty) -> null.
function parseDate(raw: string | undefined): string | null {
  const s = (raw || '').trim()
  if (!s || s === NO_DATE) return null
  return s.split(' ')[0].replace(/\//g, '-')
}

// Normalize one of the three esummary classification blocks; null when absent or empty (no
// description AND no review status).
function classification(block: ClassificationBlockRaw | undefined): Record<string, unknown> | null {
  if (!block) return null
  const description = (block.description || '').trim()
  const reviewStatus = (block.review_status || '').trim()
  if (!description && !reviewStatus) return null
  const conditions: Array<{ name: string; xrefs: Array<{ db?: string; id?: string }> }> = []
  for (const trait of block.trait_set ?? []) {
    const name = (trait.trait_name || '').trim()
    const xrefs = (trait.trait_xrefs ?? []).map((x) => ({ db: x.db_source, id: x.db_id }))
    if (name || xrefs.length) conditions.push({ name, xrefs })
  }
  return {
    description,
    review_status: reviewStatus,
    gold_stars: goldStars(reviewStatus),
    last_evaluated: parseDate(block.last_evaluated),
    fda_recognized_database: (block.fda_recognized_database || '').trim() || null,
    conditions
  }
}

function locations(variationSet: VariationSetRaw[]): Array<Record<string, unknown>> {
  const locs: Array<Record<string, unknown>> = []
  for (const vs of variationSet) {
    for (const loc of vs.variation_loc ?? []) {
      locs.push({
        status: loc.status,
        assembly: loc.assembly_name,
        chrom: loc.chr,
        band: loc.band || null,
        start: loc.start ? Number(loc.start) : null,
        stop: loc.stop ? Number(loc.stop) : null,
        ref: loc.ref || null,
        alt: loc.alt || null
      })
    }
  }
  return locs
}

// One esummary db=clinvar document -> the canonical record. Keeps everything gnomAD's ClinVar mirror
// lacks: the three classification axes (review status / gold stars / last-evaluated / condition
// xrefs), SCV counts, canonical SPDI, and per-assembly locations.
function parseSummaryDoc(doc: ClinVarSummaryDoc): Record<string, unknown> {
  const variationSet = doc.variation_set ?? []
  const vs0 = variationSet[0] ?? {}
  const xrefs = vs0.variation_xrefs ?? []
  const rsids = xrefs.filter((x) => x.db_source === 'dbSNP' && x.db_id).map((x) => `rs${x.db_id}`)
  const otherXrefs = xrefs
    .filter((x) => x.db_source !== 'dbSNP')
    .map((x) => ({ db: x.db_source, id: x.db_id }))
  const scv = doc.supporting_submissions?.scv ?? []
  const rcv = doc.supporting_submissions?.rcv ?? []
  const freqs = (vs0.allele_freq_set ?? []).map((f) => ({
    source: f.source,
    minor_allele: f.minor_allele,
    value: f.value
  }))
  return {
    variation_id: Number(doc.uid),
    accession: doc.accession,
    accession_version: doc.accession_version,
    title: doc.title,
    obj_type: doc.obj_type,
    variant_type: vs0.variant_type,
    canonical_spdi: vs0.canonical_spdi || null,
    cdna_change: vs0.cdna_change || null,
    protein_change: doc.protein_change || null,
    rsids,
    other_xrefs: otherXrefs,
    genes: (doc.genes ?? []).map((g) => ({
      symbol: g.symbol,
      gene_id: g.geneid,
      strand: g.strand
    })),
    molecular_consequences: doc.molecular_consequence_list ?? [],
    locations: locations(variationSet),
    allele_frequencies: freqs,
    germline_classification: classification(doc.germline_classification),
    clinical_impact_classification: classification(doc.clinical_impact_classification),
    oncogenicity_classification: classification(doc.oncogenicity_classification),
    n_submissions: scv.length,
    supporting_submissions: { scv, rcv }
  }
}

// -- E-utilities steps -----------------------------------------------------------------------------

type ESearchResult = { count?: string; idlist?: string[] }

// esearch db=clinvar -> the esearchresult dict (count is the API's own total as a string; idlist the
// page of variation-ID UIDs). Empty/absent -> count 0, no ids (never throws on no match).
async function esearch(
  ctx: ToolContext,
  q: string,
  term: string,
  retmax: number
): Promise<ESearchResult> {
  const body = (await ctx.fetchJson(
    `${EUTILS}/esearch.fcgi?db=clinvar&retmode=json&retmax=${retmax}&term=${encodeURIComponent(term)}${q}`
  )) as { esearchresult?: ESearchResult }
  return body.esearchresult ?? {}
}

// Batch esummary -> parsed records in input UID order (esearch order is ClinVar's relevance/recency
// ranking). UIDs whose summary doc is absent or error-flagged are appended to `missing` (by source
// accession when known via `sources`).
async function summaries(
  ctx: ToolContext,
  q: string,
  uids: string[],
  missing: string[],
  sources?: Record<string, string[]>
): Promise<Array<Record<string, unknown>>> {
  if (!uids.length) return []
  const body = (await ctx.fetchJson(
    `${EUTILS}/esummary.fcgi?db=clinvar&retmode=json&id=${uids.join(',')}${q}`
  )) as { result?: Record<string, ClinVarSummaryDoc> }
  const result = body.result ?? {}
  const records: Array<Record<string, unknown>> = []
  for (const uid of uids) {
    const doc = result[uid]
    if (!doc || typeof doc !== 'object' || doc.error) {
      missing.push(...(sources?.[uid] ?? [uid]))
      continue
    }
    const rec = parseSummaryDoc(doc)
    if (sources) rec.requested_as = sources[uid] ?? []
    records.push(rec)
  }
  return records
}

// Reads an integer arg, applying a default when unset and clamping into [1, MAX_RETMAX].
function clampRetmax(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(MAX_RETMAX, Math.max(1, base))
}

const uniqueSorted = (xs: string[]): string[] => Array.from(new Set(xs)).sort()

// Keep XML reads scoped to their owner: descendant text would mix classifications and evidence.
function xmlChildren(parent: Element, tag: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (node): node is Element => node.nodeType === 1 && (node as Element).tagName === tag
  )
}

function xmlText(element: Element | undefined): string | null {
  return element?.textContent?.trim() || null
}

function xmlAttr(element: Element | undefined, name: string): string | null {
  return element?.getAttribute(name) || null
}

function xmlComments(parent: Element): Array<{ type: string | null; text: string | null }> {
  return xmlChildren(parent, 'Comment').map((comment) => ({
    type: xmlAttr(comment, 'Type'),
    text: xmlText(comment)
  }))
}

function functionalTerm(element: Element): Record<string, unknown> {
  return {
    value: xmlText(element),
    source: xmlAttr(element, 'Source'),
    id: xmlAttr(element, 'Id')
  }
}

function xmlVersion(element: Element | undefined): number | null {
  const value = xmlAttr(element, 'Version')
  if (value === null) return null
  const version = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid ClinVar record version')
  }
  return version
}

function xmlBoolean(element: Element, name: string): boolean | null {
  const value = xmlAttr(element, name)
  if (value === null) return null
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`Invalid ClinVar boolean: ${name}`)
}

function xmlXrefs(parent: Element): Array<Record<string, unknown>> {
  return xmlChildren(parent, 'XRef').map((xref) => ({
    db: xmlAttr(xref, 'DB'),
    id: xmlAttr(xref, 'ID'),
    type: xmlAttr(xref, 'Type'),
    url: xmlAttr(xref, 'URL')
  }))
}

function xmlCitations(parent: Element): Array<Record<string, unknown>> {
  const citations = Array.from(parent.getElementsByTagName('Citation')).map((citation) => ({
    type: xmlAttr(citation, 'Type'),
    ids: xmlChildren(citation, 'ID').map((id) => ({
      source: xmlAttr(id, 'Source'),
      id: xmlText(id)
    })),
    url: xmlText(xmlChildren(citation, 'URL')[0]),
    title: xmlText(xmlChildren(citation, 'CitationText')[0])
  }))
  return Array.from(
    new Map(citations.map((citation) => [JSON.stringify(citation), citation])).values()
  )
}

function parseSubmission(assertion: Element): Record<string, unknown> {
  const accession = xmlChildren(assertion, 'ClinVarAccession')[0]
  const classification =
    xmlChildren(assertion, 'Classification')[0] ?? xmlChildren(assertion, 'ClinicalSignificance')[0]
  if (!classification) throw new Error('ClinVar submission is missing its classification block')
  const classifications: Array<Record<string, unknown>> = []
  if (classification) {
    for (const [tag, type] of [
      ['GermlineClassification', 'germline'],
      ['SomaticClinicalImpact', 'clinical_impact'],
      ['OncogenicityClassification', 'oncogenicity'],
      ['Description', 'germline'],
      ['NoClassification', 'no_classification']
    ]) {
      for (const value of xmlChildren(classification, tag)) {
        classifications.push({
          type,
          description: xmlText(value),
          assertion_type: xmlAttr(value, 'ClinicalImpactAssertionType'),
          clinical_significance: xmlAttr(value, 'ClinicalImpactClinicalSignificance'),
          drug: xmlAttr(value, 'DrugForTherapeuticAssertion')
        })
      }
    }
  }
  const traitSet = xmlChildren(assertion, 'TraitSet')[0]
  const conditions = traitSet
    ? xmlChildren(traitSet, 'Trait').map((trait) => ({
        type: xmlAttr(trait, 'Type'),
        names: xmlChildren(trait, 'Name').flatMap((name) =>
          xmlChildren(name, 'ElementValue').map((value) => ({
            type: xmlAttr(value, 'Type'),
            value: xmlText(value)
          }))
        ),
        xrefs: xmlChildren(trait, 'XRef').map((xref) => ({
          db: xmlAttr(xref, 'DB'),
          id: xmlAttr(xref, 'ID')
        }))
      }))
    : []
  const assertionMethods = xmlChildren(assertion, 'AttributeSet').flatMap((set) =>
    xmlChildren(set, 'Attribute')
      .filter((attribute) => xmlAttr(attribute, 'Type') === 'AssertionMethod')
      .map((attribute) => ({
        description: xmlText(attribute),
        citations: xmlCitations(set),
        xrefs: xmlXrefs(set),
        comments: xmlComments(set)
      }))
  )
  const observedIn = Array.from(assertion.getElementsByTagName('ObservedIn')).map((observed) => ({
    origins: Array.from(observed.getElementsByTagName('Origin')).map(xmlText),
    methods: Array.from(observed.getElementsByTagName('MethodType')).map(xmlText),
    descriptions: Array.from(observed.getElementsByTagName('Attribute'))
      .filter((attribute) => xmlAttr(attribute, 'Type') === 'Description')
      .map(xmlText),
    evidence: xmlChildren(observed, 'ObservedData').map((data) => ({
      attributes: xmlChildren(data, 'Attribute').map((attribute) => ({
        value: xmlText(attribute),
        attributes: Object.fromEntries(
          Array.from(attribute.attributes).map((attr) => [attr.name, attr.value])
        )
      })),
      citations: xmlCitations(data),
      xrefs: xmlXrefs(data),
      comments: xmlComments(data)
    })),
    functional_data: xmlChildren(observed, 'FunctionalData').map((data) => {
      const effect = xmlChildren(data, 'FunctionalEffect')[0]
      const link = xmlChildren(data, 'LinkToExternalDatabase')[0]
      return {
        effect: effect ? functionalTerm(effect) : null,
        consequences: xmlChildren(data, 'FunctionalConsequence').map(functionalTerm),
        consequence_comment: xmlText(xmlChildren(data, 'FunctionalConsequenceComment')[0]),
        result: xmlText(xmlChildren(data, 'Result')[0]),
        external_link: link ? { url: xmlText(link), name: xmlAttr(link, 'linkName') } : null
      }
    }),
    comments: xmlComments(observed),
    citations: xmlCitations(observed)
  }))
  const scv = xmlAttr(accession, 'Accession')
  const version = xmlVersion(accession)
  return {
    accession: scv,
    version,
    accession_version: scv && version ? `${scv}.${version}` : scv,
    submitter: {
      name: xmlAttr(accession, 'SubmitterName'),
      org_id: xmlAttr(accession, 'OrgID'),
      category: xmlAttr(accession, 'OrganizationCategory')
    },
    record_status: xmlText(xmlChildren(assertion, 'RecordStatus')[0]),
    contributes_to_aggregate_classification: xmlBoolean(
      assertion,
      'ContributesToAggregateClassification'
    ),
    last_evaluated: xmlAttr(classification, 'DateLastEvaluated'),
    review_status: classification ? xmlText(xmlChildren(classification, 'ReviewStatus')[0]) : null,
    classifications,
    conditions,
    multiple_condition_explanation: xmlAttr(traitSet, 'multipleConditionExplanation'),
    assertion_methods: assertionMethods,
    classification_explanation: classification
      ? xmlText(xmlChildren(classification, 'ExplanationOfClassification')[0])
      : null,
    classification_comments: classification ? xmlComments(classification) : [],
    submission_comments: xmlComments(assertion),
    observed_in: observedIn,
    citations: xmlCitations(assertion)
  }
}

function submissionRecord(
  xml: string,
  requested: string,
  maxSubmissions: number,
  offset: number
): Record<string, unknown> {
  let invalid = false
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true
      },
      error: () => {
        invalid = true
      },
      fatalError: () => {
        invalid = true
      }
    }
  }).parseFromString(xml, 'text/xml')
  if (invalid || !doc.documentElement || /<!DOCTYPE/i.test(xml)) {
    throw new Error('Invalid ClinVar EFetch XML')
  }
  const error = doc.getElementsByTagName('ERROR')[0]
  if (error) throw new Error(`ClinVar EFetch: ${xmlText(error)}`)
  if (!['ClinVarResult-Set', 'ClinVarVariationRelease'].includes(doc.documentElement.tagName)) {
    throw new Error('Unexpected ClinVar EFetch XML format')
  }
  const archives = xmlChildren(doc.documentElement, 'VariationArchive')
  if (!archives.length) return { requested_as: requested, missing_record: true, submissions: [] }
  if (archives.length !== 1) throw new Error('Expected one ClinVar variation record')
  const archive = archives[0]
  const accession = xmlAttr(archive, 'Accession')
  if (!accession || !/^VCV\d+$/.test(accession)) {
    throw new Error('ClinVar VCV record is missing its accession')
  }
  const version = xmlVersion(archive)
  if (version === null) throw new Error('ClinVar VCV record is missing its version')
  const accessionVersion = accession && version ? `${accession}.${version}` : accession
  const expected = /^(VCV\d+)(?:\.(\d+))?$/i.exec(requested)
  if (
    (expected &&
      (accession !== expected[1].toUpperCase() ||
        (expected[2] && String(version) !== expected[2]))) ||
    (!expected && xmlAttr(archive, 'VariationID') !== requested)
  ) {
    throw new Error('ClinVar EFetch returned a different accession or version')
  }
  const classified = xmlChildren(archive, 'ClassifiedRecord')[0]
  const included = xmlChildren(archive, 'IncludedRecord')[0]
  if ((!classified && !included) || (classified && included)) {
    throw new Error('ClinVar VCV record has an invalid record structure')
  }
  const recordInfo = {
    requested_as: requested,
    variation_id: xmlAttr(archive, 'VariationID'),
    accession,
    accession_version: accessionVersion,
    record_status: xmlText(xmlChildren(archive, 'RecordStatus')[0]),
    missing_record: false
  }
  if (included) {
    const list = xmlChildren(included, 'SubmittedClassificationList')[0]
    const variants = xmlChildren(included, 'ClassifiedVariationList')[0]
    if (!list || !variants)
      throw new Error('ClinVar included record is missing its reference lists')
    if (!xmlChildren(list, 'SCV').length || !xmlChildren(variants, 'ClassifiedVariation').length) {
      throw new Error('ClinVar included record has an empty reference list')
    }
    return {
      ...recordInfo,
      record_type: 'included',
      direct_evidence_available: false,
      submissions: [],
      referenced_submissions: list
        ? xmlChildren(list, 'SCV').map((scv) => ({
            accession: xmlAttr(scv, 'Accession'),
            version: xmlVersion(scv)
          }))
        : [],
      classified_variations: variants
        ? xmlChildren(variants, 'ClassifiedVariation').map((variant) => ({
            variation_id: xmlAttr(variant, 'VariationID'),
            accession: xmlAttr(variant, 'Accession'),
            version: xmlVersion(variant)
          }))
        : []
    }
  }
  const list = xmlChildren(classified!, 'ClinicalAssertionList')[0]
  if (!list) throw new Error('ClinVar classified record is missing its submission list')
  const assertions = xmlChildren(list, 'ClinicalAssertion')
  if (!assertions.length) throw new Error('ClinVar classified record has an empty submission list')
  const byScv = new Map<string, Record<string, unknown>>()
  for (const assertion of assertions) {
    const row = parseSubmission(assertion)
    const scv = row.accession as string | null
    if (!scv || !/^SCV\d+$/.test(scv))
      throw new Error('ClinVar submission is missing its SCV accession')
    const previous = byScv.get(scv)
    // The greatest SCV version present in this VCV snapshot wins; never fetch a newer snapshot.
    if (!previous || Number(row.version) > Number(previous.version)) byScv.set(scv, row)
  }
  const rows = Array.from(byScv.values()).sort((a, b) =>
    String(a.accession).localeCompare(String(b.accession))
  )
  const page = rows.slice(offset, offset + maxSubmissions)
  const nextOffset = offset + page.length
  return {
    ...recordInfo,
    record_type: 'classified',
    direct_evidence_available: true,
    n_submissions: rows.length,
    n_duplicate_skipped: assertions.length - rows.length,
    n_returned: page.length,
    offset,
    truncated: nextOffset < rows.length,
    next_page:
      nextOffset < rows.length
        ? { accession: accessionVersion, offset: nextOffset, max_submissions: maxSubmissions }
        : null,
    submissions: page
  }
}

// NCBI E-utilities in JSON mode against db=clinvar (esearch -> esummary). Direct-ClinVar complement to
// the gnomAD ClinVar mirror: adds review status + gold stars per classification axis, last-evaluated
// dates, SCV counts, condition xrefs, and the somatic clinical-impact + oncogenicity classifications.
export const VARIANTS_CLINVAR_TOOLS: ToolDescriptor[] = [
  {
    id: 'clinvar_search',
    connector: 'variants',
    description:
      'Search ClinVar directly (live NCBI, not gnomAD\'s snapshot) and return matching variation records with clinical significance, review status and gold stars. Requires a contact email (Settings → Privacy → \'Share contact email with research data services\') per NCBI E-utilities usage policy. Args: query (a ClinVar Entrez query — free text like "TP53 R175H" or an HGVS string works, and fielded terms compose with AND/OR/NOT, e.g. BRCA1[gene], pathogenic[CLIN_SIG], "Lynch syndrome"[dis], single_nucleotide_variant[Type of variation]; an rsID also works but clinvar_variant_by_rsid returns fuller records), max_records (page cap 1-200, default 50). The match TOTAL is always reported; when total > max_records the list is a capped prefix (ClinVar relevance/recency order) and truncated is true. NCBI E-utilities intermittently return HTTP 500 under load — retry once a few seconds later if that surfaces.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_records: { type: 'integer', default: 50 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ term, total, n_returned, truncated, missing_uids, records }` — `total` is the true ClinVar match count (may exceed the returned list); `truncated` flags a capped page; `missing_uids` lists matched IDs whose summary doc NCBI dropped (rare, transient — distinct from truncation; retry to recover). Each record: `{ variation_id, accession (VCV), accession_version, title, obj_type, variant_type, canonical_spdi, cdna_change, protein_change, rsids, other_xrefs, genes, molecular_consequences, locations (GRCh38+GRCh37), allele_frequencies, germline_classification, clinical_impact_classification, oncogenicity_classification (each: description, review_status, gold_stars 0-4, last_evaluated, fda_recognized_database, conditions with ontology xrefs; null when ClinVar has no classification on that axis), n_submissions (SCV count), supporting_submissions }`. When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'const result = await host.mcp("variants", "clinvar_search", {"query": "BRCA1 pathogenic[CLIN_SIG]", "max_records": 50})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const q = ncbiEtiquette(ctx.credentials)
      const retmax = clampRetmax(a.max_records, 50)
      const term = String(a.query)
      const res = await esearch(ctx, q, term, retmax)
      const total = Number(res.count ?? 0)
      const uids = res.idlist ?? []
      const missing: string[] = []
      const records = await summaries(ctx, q, uids, missing)
      return {
        term,
        total,
        n_returned: records.length,
        // Capped page (total > the UID page) vs. a dropped summary doc are different conditions.
        truncated: total > uids.length,
        missing_uids: missing,
        records
      }
    }
  },
  {
    id: 'clinvar_get_records',
    connector: 'variants',
    description:
      "Fetch full ClinVar records for a batch of VCV/RCV accessions or bare variation IDs. Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy. Args: accessions (up to 50 identifiers, mixed forms accepted — VCV000045122 (versioned VCV000045122.3 ok; resolved locally, free), RCV000019428 (each RCV costs one extra esearch), or a bare ClinVar variation ID (45122). rsIDs are rejected — use clinvar_variant_by_rsid. An RCV (one variant-condition pair) resolves to its parent VCV variation record). Never silently drops an input.",
    input: {
      type: 'object',
      properties: {
        accessions: {
          type: ['string', 'array'],
          items: { type: 'string' }
        }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      '`{ n_requested, n_unique, n_duplicate_skipped, records, not_found, missing_uids, not_processed }`. Records carry the full shape documented in `clinvar_search` plus `requested_as` (which input(s) mapped to the record), sorted by variation_id. `not_found` lists unknown accessions (definitive absence — RCVs that esearch proves unknown); `missing_uids` lists inputs whose summary NCBI dropped or error-flagged (for a just-resolved RCV this is a transient drop — the record EXISTS, retry; for a VCV/numeric input it is a transient drop OR a nonexistent id — retry to disambiguate, never conclude absence from one call); `not_processed` lists RCVs skipped because the per-call time budget ran out (re-request just those — VCV/numeric inputs always resolve, they never land there). When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'const result = await host.mcp("variants", "clinvar_get_records", {"accessions": ["VCV000045122", "RCV000019428", "45123"]})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const q = ncbiEtiquette(ctx.credentials)
      const raw = (Array.isArray(a.accessions) ? a.accessions : [a.accessions]).map((x) =>
        String(x).trim()
      )
      const cleaned = raw.filter((x) => x !== '')
      // Cap on the UNIQUE set: the esummary/esearch fan-out is keyed to unique accessions, so a batch
      // whose raw count exceeds the cap but whose unique count is within it must not be rejected.
      const pending = Array.from(new Set(cleaned))
      const nDuplicateSkipped = cleaned.length - pending.length
      if (pending.length > MAX_BATCH_ACCESSIONS) {
        throw new Error(
          `too many accessions (${pending.length} unique); max ${MAX_BATCH_ACCESSIONS} per call`
        )
      }
      const uidSources: Record<string, string[]> = {}
      const notFound: string[] = []
      const notProcessed: string[] = []
      const rcvs: string[] = []
      const addSource = (uid: string, acc: string): void => {
        ;(uidSources[uid] ??= []).push(acc)
      }
      // Pass 1 — local-only resolution (VCV/numeric: the UID is the VCV number) + input validation.
      for (const acc of pending) {
        const m = VCV_RE.exec(acc)
        if (m) {
          addSource(String(Number(m[1])), acc)
          continue
        }
        if (/^\d+$/.test(acc)) {
          addSource(String(Number(acc)), acc)
          continue
        }
        if (RCV_RE.test(acc)) {
          rcvs.push(acc)
          continue
        }
        if (RSID_RE.test(acc)) throw new Error(`'${acc}' is an rsID — use clinvar_variant_by_rsid`)
        throw new Error(
          `unrecognized accession '${acc}' (expected VCVnnn, RCVnnn, or a bare ClinVar variation ID)`
        )
      }
      // Pass 2 — RCVs (one esearch each); only these can trip the wall-clock deadline.
      const t0 = Date.now()
      for (let i = 0; i < rcvs.length; i++) {
        if (Date.now() - t0 > RCV_DEADLINE_MS) {
          notProcessed.push(...rcvs.slice(i))
          break
        }
        const acc = rcvs[i]
        const res = await esearch(ctx, q, acc.toUpperCase().split('.')[0], 5)
        const uids = res.idlist ?? []
        if (!uids.length) notFound.push(acc)
        for (const uid of uids) addSource(uid, acc)
      }
      const missingUids: string[] = []
      const uids = Object.keys(uidSources).filter((u) => u !== '')
      const records = await summaries(ctx, q, uids, missingUids, uidSources)
      // Order is undefined for a batch lookup: sort for determinism.
      records.sort((x, y) => (x.variation_id as number) - (y.variation_id as number))
      return {
        n_requested: cleaned.length,
        n_unique: pending.length,
        n_duplicate_skipped: nDuplicateSkipped,
        records,
        not_found: uniqueSorted(notFound),
        missing_uids: uniqueSorted(missingUids),
        not_processed: notProcessed
      }
    }
  },
  {
    id: 'clinvar_get_submissions',
    connector: 'variants',
    description:
      'Fetch individual SCV submission evidence from official ClinVar VCV XML. Requires the same contact email as clinvar_search. Pass accession: a VCV accession (optional .version is honored) or a positive variation ID. Unversioned input retrieves the latest VCV. RCV, SCV and rsIDs are not accepted. Returns submitted classifications separately for germline, somatic clinical impact and oncogenicity, conditions, submitter, evaluation date, assertion methods, public classification comments, observed evidence and citations where provided. Missing source fields stay null/empty. Compare submissions within the same classification type and condition; this tool does not infer conflicts. max_submissions sets page size (1-200, default 200); offset defaults to 0. For later pages, pass the returned next_page arguments, which pin the VCV version; offset > 0 requires a versioned VCV. Each page re-fetches the complete XML; there is no result cache. Included records contain indirect references rather than direct SCV evidence. Duplicate SCVs retain the highest version present in the requested snapshot.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string' },
        max_submissions: { type: 'integer', minimum: 1, maximum: 200, default: 200 },
        offset: { type: 'integer', minimum: 0, default: 0 }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ requested_as, variation_id, accession, accession_version, record_status, record_type, direct_evidence_available, missing_record, n_submissions, n_duplicate_skipped, n_returned, offset, truncated, next_page, submissions }`. Each submission has `{ accession, version, accession_version, submitter: { name, org_id, category }, record_status, contributes_to_aggregate_classification, last_evaluated, review_status, classifications: [{ type, description, assertion_type, clinical_significance, drug }], conditions: [{ type, names, xrefs }], multiple_condition_explanation, assertion_methods (description, citations, xrefs, comments), classification_explanation, classification_comments, submission_comments, observed_in (origins, methods, descriptions, evidence with source attributes/citations/xrefs/comments, functional_data with effect/consequences/result/external_link), citations }`. Included records return record_type: "included", direct_evidence_available: false, submissions: [], referenced_submissions and classified_variations; submission counts and pagination are omitted because no direct evidence is provided. Classification type no_classification preserves explicit NoClassification values. The aggregate-contribution flag is boolean|null. Comment arrays preserve { type, text }, including FlaggedComment, without inferring its meaning. Missing classification blocks or included-record reference lists throw. Citations preserve source IDs, URLs and text; assertion-method citations are also attached to their method. Empty upstream XML returns `{ requested_as, missing_record: true, submissions: [] }`, not definitive absence. Upstream errors, malformed XML and accession/version mismatches throw. Missing contact email returns `{ error: "contact_email_required", message }`.',
    example:
      'const result = await host.mcp("variants", "clinvar_get_submissions", {"accession": "VCV000045122"})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const raw = String(a.accession).trim().toUpperCase()
      if (!/^VCV0*[1-9]\d*(?:\.[1-9]\d*)?$/.test(raw) && !/^0*[1-9]\d*$/.test(raw)) {
        throw new Error('Expected a VCV accession (optional version) or positive variation ID')
      }
      const vcv = /^VCV(\d+)(\.\d+)?$/.exec(raw)
      const accession = vcv
        ? `VCV${vcv[1].replace(/^0+/, '').padStart(9, '0')}${vcv[2] ?? ''}`
        : raw.replace(/^0+/, '')
      const offset = a.offset ?? 0
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('offset must be a non-negative safe integer')
      }
      if (offset > 0 && !vcv?.[2]) {
        throw new Error('Later pages require a versioned VCV accession from next_page')
      }
      const idMode = /^\d+$/.test(accession) ? '&is_variationid=true' : ''
      const xml = await ctx.fetchText(
        `${EUTILS}/efetch.fcgi?db=clinvar&rettype=vcv&retmode=xml&id=${encodeURIComponent(accession)}${idMode}${ncbiEtiquette(ctx.credentials)}`,
        'application/xml'
      )
      return submissionRecord(xml, accession, clampRetmax(a.max_submissions, 200), offset)
    }
  },
  {
    id: 'clinvar_variant_by_rsid',
    connector: 'variants',
    description:
      "All ClinVar variation records that reference a dbSNP rsID, with full classifications (an rsID can map to several VCVs — one per alternate allele, e.g. rs121913529 covers KRAS G12D/G12V/G12A). Requires a contact email (Settings → Privacy → 'Share contact email with research data services') per NCBI E-utilities usage policy. Args: rsid (dbSNP reference SNP ID, e.g. rs7412; case-insensitive, must match rs<digits>), max_records (cap 1-200, default 50). total always carries the true match count and truncated flags a capped listing; total == 0 means ClinVar has no record for the rsID.",
    input: {
      type: 'object',
      properties: {
        rsid: { type: 'string', description: 'dbSNP rsID, e.g. rs7412 (case-insensitive).' },
        max_records: { type: 'integer', default: 50 }
      },
      required: ['rsid']
    },
    required: ['rsid'],
    returns:
      '`{ rsid, total, n_returned, truncated, missing_uids, records }` with the full record shape documented in `clinvar_search` (review status, gold stars, last-evaluated dates, SCV counts — the fields gnomAD’s ClinVar mirror lacks). Records come in ClinVar relevance order; `missing_uids` lists matches whose summary NCBI dropped (transient). `total == 0` means ClinVar has no record for the rsID. When no contact email is set, returns `{ error: "contact_email_required", message }` instead.',
    example:
      'const result = await host.mcp("variants", "clinvar_variant_by_rsid", {"rsid": "rs121913529", "max_records": 50})',
    run: async (ctx, a): Promise<Record<string, unknown> | ContactRequired> => {
      if (!ctx.credentials.ncbiEmail) return contactRequired()
      const rsid = String(a.rsid).trim()
      if (!RSID_RE.test(rsid)) throw new Error(`not an rsID: '${rsid}' (expected e.g. rs7412)`)
      const q = ncbiEtiquette(ctx.credentials)
      const retmax = clampRetmax(a.max_records, 50)
      const term = rsid.toLowerCase()
      const res = await esearch(ctx, q, term, retmax)
      const total = Number(res.count ?? 0)
      const uids = res.idlist ?? []
      const missing: string[] = []
      const records = await summaries(ctx, q, uids, missing)
      return {
        rsid: term,
        total,
        n_returned: records.length,
        truncated: total > uids.length,
        missing_uids: missing,
        records
      }
    }
  }
]
