import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_CLINVAR_TOOLS } from './variants-clinvar'
import type { ToolDescriptor } from '../types'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): ToolDescriptor => VARIANTS_CLINVAR_TOOLS.find((t) => t.id === id)!

// A rich esummary doc for variation 45122, exercising all three classification axes + gold stars +
// conditions + locations. Modeled on the real db=clinvar esummary shape.
const richDoc = {
  uid: '45122',
  accession: 'VCV000045122',
  accession_version: 'VCV000045122.3',
  title: 'NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)',
  obj_type: 'single nucleotide variant',
  protein_change: 'V600E',
  genes: [{ symbol: 'BRAF', geneid: '673', strand: '-' }],
  molecular_consequence_list: ['missense variant'],
  variation_set: [
    {
      variant_type: 'single nucleotide variant',
      canonical_spdi: 'NC_000007.14:140753335:A:T',
      cdna_change: 'c.1799T>A',
      variation_xrefs: [
        { db_source: 'dbSNP', db_id: '113488022' },
        { db_source: 'OMIM', db_id: '164757.0001' }
      ],
      allele_freq_set: [{ source: 'TOPMED', minor_allele: 'T', value: '0.00001' }],
      variation_loc: [
        {
          status: 'current',
          assembly_name: 'GRCh38',
          chr: '7',
          band: '7q34',
          start: '140753336',
          stop: '140753336',
          ref: 'A',
          alt: 'T'
        },
        {
          status: 'previous',
          assembly_name: 'GRCh37',
          chr: '7',
          start: '140453136',
          stop: '140453136',
          ref: 'A',
          alt: 'T'
        }
      ]
    }
  ],
  supporting_submissions: { scv: ['SCV1', 'SCV2', 'SCV3'], rcv: ['RCV000019428'] },
  germline_classification: {
    description: 'Pathogenic',
    review_status: 'criteria provided, multiple submitters, no conflicts',
    last_evaluated: '2022/10/12 00:00',
    trait_set: [
      {
        trait_name: 'Melanoma',
        trait_xrefs: [{ db_source: 'MedGen', db_id: 'C0025202' }]
      }
    ]
  },
  clinical_impact_classification: {
    description: 'Tier I - Strong',
    review_status: 'reviewed by expert panel',
    last_evaluated: '2023/01/05 00:00',
    fda_recognized_database: 'OncoKB',
    trait_set: [{ trait_name: 'Colorectal cancer', trait_xrefs: [] }]
  },
  oncogenicity_classification: {
    description: 'Oncogenic',
    review_status: 'criteria provided, single submitter',
    last_evaluated: '1/01/01 00:00',
    trait_set: []
  }
}

describe('variants-clinvar', () => {
  it('clinvar_search: esearch -> esummary, full record shape, etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '1', idlist: ['45122'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc, uids: ['45122'] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRAF V600E', max_records: 50 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      term: string
      total: number
      truncated: boolean
      records: Array<Record<string, unknown>>
    }

    // esearch db=clinvar with etiquette; esummary follows.
    expect(fetchImpl.mock.calls[0][0]).toContain('esearch.fcgi?db=clinvar')
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(fetchImpl.mock.calls[1][0]).toContain('esummary.fcgi?db=clinvar')
    expect(out.total).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.records).toHaveLength(1)
    const r = out.records[0]
    expect(r.variation_id).toBe(45122)
    expect(r.accession).toBe('VCV000045122')
    expect(r.rsids).toEqual(['rs113488022'])
    expect(r.other_xrefs).toEqual([{ db: 'OMIM', id: '164757.0001' }])
    expect(r.n_submissions).toBe(3)
    expect(r.canonical_spdi).toBe('NC_000007.14:140753335:A:T')
    expect(r.molecular_consequences).toEqual(['missense variant'])
    // germline: gold_stars 2, date normalized, condition xrefs preserved.
    expect(r.germline_classification).toEqual({
      description: 'Pathogenic',
      review_status: 'criteria provided, multiple submitters, no conflicts',
      gold_stars: 2,
      last_evaluated: '2022-10-12',
      fda_recognized_database: null,
      conditions: [{ name: 'Melanoma', xrefs: [{ db: 'MedGen', id: 'C0025202' }] }]
    })
    // clinical_impact: gold_stars 3, fda db surfaced.
    expect(r.clinical_impact_classification).toMatchObject({
      description: 'Tier I - Strong',
      gold_stars: 3,
      fda_recognized_database: 'OncoKB'
    })
    // oncogenicity: single submitter -> 1 star; the 1/01/01 sentinel -> null date.
    expect(r.oncogenicity_classification).toMatchObject({
      description: 'Oncogenic',
      gold_stars: 1,
      last_evaluated: null
    })
    // GRCh38 + GRCh37 locations both present.
    expect(r.locations).toEqual([
      {
        status: 'current',
        assembly: 'GRCh38',
        chrom: '7',
        band: '7q34',
        start: 140753336,
        stop: 140753336,
        ref: 'A',
        alt: 'T'
      },
      {
        status: 'previous',
        assembly: 'GRCh37',
        chrom: '7',
        band: null,
        start: 140453136,
        stop: 140453136,
        ref: 'A',
        alt: 'T'
      }
    ])
  })

  it('clinvar_search: truncation flagged when total > returned page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '250', idlist: ['45122'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRCA1', max_records: 1 },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; truncated: boolean; records: unknown[] }
    expect(out.total).toBe(250)
    expect(out.truncated).toBe(true)
    expect(out.records).toHaveLength(1)
  })

  it('clinvar_search: no match -> total 0, empty records, no throw', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '0', idlist: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'zzzznomatch' },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; records: unknown[] }
    expect(out.total).toBe(0)
    expect(out.records).toEqual([])
    // esummary is never called when there are no UIDs.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('clinvar_search: dropped summary doc -> missing_uids, not a truncation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['45122', '99999'] } }))
      .mockResolvedValueOnce(
        jsonRes({
          result: { '45122': richDoc, '99999': { uid: '99999', error: 'cannot get document' } }
        })
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRAF' },
      { ncbiEmail: 'x@y.org' }
    )) as { truncated: boolean; missing_uids: string[]; records: unknown[] }
    expect(out.records).toHaveLength(1)
    expect(out.missing_uids).toEqual(['99999'])
    // count == idlist length -> not truncated, even though a doc was dropped.
    expect(out.truncated).toBe(false)
  })

  it('clinvar_get_records: VCV/RCV/bare-id forms, requested_as, not_found for unknown RCV', async () => {
    const rcvDoc = { ...richDoc, uid: '12345', accession: 'VCV000012345' }
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      // RCV resolution esearch calls: RCV000019428 -> variation 45122; RCV000099999 -> nothing.
      if (url.includes('esearch.fcgi')) {
        if (url.includes('RCV000019428'))
          return Promise.resolve(jsonRes({ esearchresult: { idlist: ['45122'] } }))
        return Promise.resolve(jsonRes({ esearchresult: { idlist: [] } }))
      }
      // esummary for the two resolved UIDs (45122 from VCV+RCV, 12345 from bare id).
      return Promise.resolve(jsonRes({ result: { '45122': richDoc, '12345': rcvDoc } }))
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['VCV000045122.3', 'RCV000019428', '12345', 'RCV000099999'] },
      { ncbiEmail: 'x@y.org' }
    )) as {
      n_requested: number
      records: Array<Record<string, unknown>>
      not_found: string[]
      not_processed: string[]
    }
    expect(out.n_requested).toBe(4)
    expect(out.not_found).toEqual(['RCV000099999'])
    expect(out.not_processed).toEqual([])
    // Sorted by variation_id; VCV + RCV both map to 45122 (one record, two requested_as).
    expect(out.records.map((r) => r.variation_id)).toEqual([12345, 45122])
    const merged = out.records.find((r) => r.variation_id === 45122)!
    expect(merged.requested_as).toEqual(['VCV000045122.3', 'RCV000019428'])
    expect(out.records.find((r) => r.variation_id === 12345)!.requested_as).toEqual(['12345'])
  })

  it('clinvar_get_records: dedupe by unique set + duplicate count', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['45122', 'VCV000045122', '45122'] },
      { ncbiEmail: 'x@y.org' }
    )) as { n_requested: number; n_unique: number; n_duplicate_skipped: number; records: unknown[] }
    expect(out.n_requested).toBe(3)
    expect(out.n_unique).toBe(2)
    expect(out.n_duplicate_skipped).toBe(1)
    expect(out.records).toHaveLength(1)
  })

  it('clinvar_get_records: missing_uids distinct from not_found (VCV summary dropped)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ result: { '45122': { uid: '45122', error: 'dropped' } } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['VCV000045122'] },
      { ncbiEmail: 'x@y.org' }
    )) as { records: unknown[]; missing_uids: string[]; not_found: string[] }
    expect(out.records).toEqual([])
    expect(out.missing_uids).toEqual(['VCV000045122'])
    expect(out.not_found).toEqual([])
  })

  it('clinvar_get_records: rsID input is rejected (throws)', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('clinvar_get_records'),
        { accessions: ['rs121913529'] },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/rsID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clinvar_variant_by_rsid: one rsID -> all VCVs, lowercased, etiquette', async () => {
    const doc2 = { ...richDoc, uid: '45123', accession: 'VCV000045123' }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['45122', '45123'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc, '45123': doc2 } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_variant_by_rsid'),
      { rsid: 'RS121913529' },
      { ncbiEmail: 'x@y.org' }
    )) as {
      rsid: string
      total: number
      truncated: boolean
      records: Array<Record<string, unknown>>
    }
    // rsID lowercased into the esearch term.
    expect(fetchImpl.mock.calls[0][0]).toContain('term=rs121913529')
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(out.rsid).toBe('rs121913529')
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.records.map((r) => r.variation_id)).toEqual([45122, 45123])
  })

  it('clinvar_variant_by_rsid: total 0 means no ClinVar record, no throw', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '0', idlist: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_variant_by_rsid'),
      { rsid: 'rs999999999' },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; records: unknown[] }
    expect(out.total).toBe(0)
    expect(out.records).toEqual([])
  })

  it('clinvar_variant_by_rsid: non-rsID input throws', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('clinvar_variant_by_rsid'),
        { rsid: 'VCV000045122' },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/not an rsID/)
  })

  it('contact_email_required: no ncbiEmail -> structured result, never a throw, no fetch', async () => {
    const fetchImpl = vi.fn()
    for (const [id, args] of [
      ['clinvar_search', { query: 'BRCA1' }],
      ['clinvar_get_records', { accessions: ['VCV000045122'] }],
      ['clinvar_get_submissions', { accession: 'VCV000045122' }],
      ['clinvar_variant_by_rsid', { rsid: 'rs7412' }]
    ] as const) {
      const out = (await new ParserEngine({ fetchImpl }).call(tool(id), args, {})) as {
        error: string
        message: string
      }
      expect(out.error).toBe('contact_email_required')
      expect(out.message).toMatch(/contact email/i)
    }
    // Gate fires before any network call across all direct ClinVar tools.
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Small source-shaped fixtures keep aggregate citations separate from submitted evidence.
const scvXml = (version = 2, classification = 'GermlineClassification'): string => `
<ClinicalAssertion ContributesToAggregateClassification="false">
  <ClinVarAccession Accession="SCV000000001" Version="${version}"
    SubmitterName="Lab &amp; Center" OrgID="123" OrganizationCategory="laboratory"/>
  <RecordStatus>current</RecordStatus>
  <Classification DateLastEvaluated="2025-01-02">
    <ReviewStatus>criteria provided, single submitter</ReviewStatus>
    <${classification} ClinicalImpactAssertionType="diagnostic"
      ClinicalImpactClinicalSignificance="supports diagnosis">Pathogenic</${classification}>
    <Comment>Evidence &amp; rationale</Comment>
    <Citation><ID Source="PubMed">12345</ID></Citation>
    <Citation><ID Source="PubMed">12345</ID></Citation>
  </Classification>
  <AttributeSet><Attribute Type="AssertionMethod">ACMG Guidelines, 2015</Attribute>
    <Citation><URL>https://example.org/criteria</URL><CitationText>Criteria</CitationText></Citation>
  </AttributeSet>
  <TraitSet Type="Disease" multipleConditionExplanation="Uncertain"><Trait Type="Disease">
    <Name><ElementValue Type="Preferred">Condition A</ElementValue></Name>
    <XRef DB="MedGen" ID="C1"/>
  </Trait></TraitSet>
  <ObservedInList><ObservedIn><Sample><Origin>germline</Origin></Sample>
    <Method><MethodType>clinical testing</MethodType></Method>
    <ObservedData><Attribute Type="Description">Functional evidence</Attribute>
      <Citation><ID Source="PubMed">67890</ID></Citation>
    </ObservedData>
  </ObservedIn></ObservedInList>
</ClinicalAssertion>`
const vcvXml = (assertions: string, version = 20): string => `
<ClinVarResult-Set><VariationArchive Accession="VCV000045122" Version="${version}" VariationID="45122">
<RecordStatus>current</RecordStatus><ClassifiedRecord>
<Classifications><Citation><ID Source="PubMed">aggregate-only</ID></Citation></Classifications>
<ClinicalAssertionList>${assertions}</ClinicalAssertionList>
</ClassifiedRecord></VariationArchive></ClinVarResult-Set>`
const xmlRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

async function getSubmissions(
  xml: string,
  args: Record<string, unknown> = { accession: 'VCV000045122' }
): Promise<Record<string, unknown>> {
  return new ParserEngine({ fetchImpl: vi.fn().mockResolvedValue(xmlRes(xml)) }).call(
    tool('clinvar_get_submissions'),
    args,
    { ncbiEmail: 'x@y.org' }
  ) as Promise<Record<string, unknown>>
}

describe('clinvar_get_submissions', () => {
  it('uses EFetch VCV XML with etiquette and preserves the requested version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(xmlRes(vcvXml(scvXml(), 3)))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_submissions'),
      { accession: 'vcv000045122.3' },
      { ncbiEmail: 'x@y.org', ncbiApiKey: 'test-key' }
    )
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('efetch.fcgi?db=clinvar&rettype=vcv&retmode=xml&id=VCV000045122.3')
    expect(url).toContain('email=x%40y.org')
    expect(url).toContain('api_key=test-key')
    expect(out).toMatchObject({ accession_version: 'VCV000045122.3', n_submissions: 1 })
  })

  it('parses submitter, disease, classifications, date, rationale and citations from each SCV', async () => {
    const out = await getSubmissions(vcvXml(scvXml()))
    expect(out).toMatchObject({ n_returned: 1, truncated: false, missing_record: false })
    expect(out.submissions).toEqual([
      expect.objectContaining({
        accession_version: 'SCV000000001.2',
        submitter: { name: 'Lab & Center', org_id: '123', category: 'laboratory' },
        contributes_to_aggregate_classification: false,
        last_evaluated: '2025-01-02',
        review_status: 'criteria provided, single submitter',
        classifications: [expect.objectContaining({ type: 'germline', description: 'Pathogenic' })],
        conditions: [
          {
            type: 'Disease',
            names: [{ type: 'Preferred', value: 'Condition A' }],
            xrefs: [{ db: 'MedGen', id: 'C1' }]
          }
        ],
        assertion_methods: [
          {
            xrefs: [],
            comments: [],
            description: 'ACMG Guidelines, 2015',
            citations: [
              { type: null, ids: [], url: 'https://example.org/criteria', title: 'Criteria' }
            ]
          }
        ],
        classification_comments: [{ type: null, text: 'Evidence & rationale' }],
        observed_in: [
          expect.objectContaining({
            origins: ['germline'],
            methods: ['clinical testing'],
            descriptions: ['Functional evidence']
          })
        ],
        citations: [
          { type: null, ids: [{ source: 'PubMed', id: '12345' }], url: null, title: null },
          { type: null, ids: [], url: 'https://example.org/criteria', title: 'Criteria' },
          { type: null, ids: [{ source: 'PubMed', id: '67890' }], url: null, title: null }
        ]
      })
    ])
  })

  it.each([
    ['SomaticClinicalImpact', 'clinical_impact'],
    ['OncogenicityClassification', 'oncogenicity']
  ])('preserves the %s classification axis', async (tag, type) => {
    const out = await getSubmissions(vcvXml(scvXml(2, tag)))
    expect(out.submissions).toEqual([
      expect.objectContaining({
        classifications: [
          expect.objectContaining({
            type,
            assertion_type: 'diagnostic',
            clinical_significance: 'supports diagnosis'
          })
        ]
      })
    ])
  })

  it('deduplicates SCVs by numeric version, sorts, and flags capped output', async () => {
    const other = scvXml().replace('SCV000000001', 'SCV000000002')
    const out = await getSubmissions(vcvXml(other + scvXml(2) + scvXml(10) + scvXml(10)), {
      accession: '45122',
      max_submissions: 1
    })
    expect(out).toMatchObject({
      n_submissions: 2,
      n_duplicate_skipped: 2,
      n_returned: 1,
      truncated: true
    })
    expect(out.submissions).toEqual([
      expect.objectContaining({ accession_version: 'SCV000000001.10' })
    ])
    expect(out.next_page).toEqual({ accession: 'VCV000045122.20', offset: 1, max_submissions: 1 })
    const next = await getSubmissions(
      vcvXml(other + scvXml(10)),
      out.next_page as Record<string, unknown>
    )
    expect(next).toMatchObject({ n_returned: 1, offset: 1, truncated: false, next_page: null })
    expect(next.submissions).toEqual([expect.objectContaining({ accession: 'SCV000000002' })])
  })

  it('sets variation-ID mode and normalizes bare IDs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(xmlRes(vcvXml(scvXml())))
    await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_submissions'),
      { accession: '0045122' },
      { ncbiEmail: 'x@y.org' }
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('id=45122&is_variationid=true')
  })

  it('keeps absent source fields null/empty and supports historical classification syntax', async () => {
    const out = await getSubmissions(
      vcvXml(`<ClinicalAssertion>
      <ClinVarAccession Accession="SCV000000001"/>
      <ClinicalSignificance><Description>Uncertain significance</Description></ClinicalSignificance>
    </ClinicalAssertion>`)
    )
    expect(out.submissions).toEqual([
      expect.objectContaining({
        version: null,
        submitter: { name: null, org_id: null, category: null },
        last_evaluated: null,
        conditions: [],
        assertion_methods: [],
        citations: [],
        classifications: [
          expect.objectContaining({ type: 'germline', description: 'Uncertain significance' })
        ]
      })
    ])
  })

  it('does not equate missing XML with an empty classified submission list', async () => {
    expect(await getSubmissions('<ClinVarResult-Set/>')).toEqual({
      requested_as: 'VCV000045122',
      missing_record: true,
      submissions: []
    })
    await expect(getSubmissions(vcvXml(''))).rejects.toThrow('empty submission list')
  })

  it.each([
    'rs7412',
    'RCV000019428',
    'SCV000000001',
    '0',
    'VCV000000000',
    'VCV000045122.0',
    '45122&x=1'
  ])('rejects unsupported input %s before fetching', async (accession) => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('clinvar_get_submissions'),
        { accession },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow('Expected a VCV')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    '<html>upstream outage</html>',
    '<ClinVarResult-Set><ERROR>unavailable</ERROR></ClinVarResult-Set>',
    '<ClinVarResult-Set><VariationArchive></ClinVarResult-Set>',
    vcvXml('<ClinicalAssertion/>'),
    vcvXml('').replace('VCV000045122', 'VCV000045123')
  ])('rejects erroneous or malformed XML', async (xml) => {
    await expect(getSubmissions(xml)).rejects.toThrow()
  })

  it('rejects an upstream version mismatch rather than silently returning the latest', async () => {
    await expect(getSubmissions(vcvXml(''), { accession: 'VCV000045122.3' })).rejects.toThrow(
      'different accession or version'
    )
  })
})

describe('clinvar_get_submissions / source edge cases', () => {
  it('preserves classification explanations, submission comments and criteria links', async () => {
    const xml = scvXml()
      .replace(
        '<Comment>Evidence',
        '<ExplanationOfClassification>Evidence code PS3</ExplanationOfClassification><Comment>Evidence'
      )
      .replace(
        '</AttributeSet>',
        '<XRef DB="Lab" ID="criteria" URL="https://example.org/method"/><Comment>Criteria revision 2</Comment></AttributeSet>'
      )
      .replace(
        '</ClinicalAssertion>',
        '<Comment>Submission rationale</Comment></ClinicalAssertion>'
      )
    const out = await getSubmissions(vcvXml(xml))
    expect(out.submissions).toEqual([
      expect.objectContaining({
        classification_explanation: 'Evidence code PS3',
        submission_comments: [{ type: null, text: 'Submission rationale' }],
        assertion_methods: [
          expect.objectContaining({
            xrefs: [{ db: 'Lab', id: 'criteria', type: null, url: 'https://example.org/method' }],
            comments: [{ type: null, text: 'Criteria revision 2' }]
          })
        ]
      })
    ])
  })

  it('keeps numeric observation evidence and citations attached to their source unit', async () => {
    const xml = scvXml().replace(
      '</ObservedIn>',
      `<ObservedData>
      <Attribute Type="VariantAlleles" integerValue="37"/>
      <Citation><ID Source="PubMed">99999</ID></Citation>
      <Comment>Independent cohort</Comment>
    </ObservedData></ObservedIn>`
    )
    const out = await getSubmissions(vcvXml(xml))
    const row = (out.submissions as Array<Record<string, unknown>>)[0]
    expect(row.observed_in).toEqual([
      expect.objectContaining({
        evidence: [
          expect.objectContaining({
            attributes: [{ value: 'Functional evidence', attributes: { Type: 'Description' } }],
            citations: [expect.objectContaining({ ids: [{ source: 'PubMed', id: '67890' }] })]
          }),
          expect.objectContaining({
            attributes: [
              { value: null, attributes: { Type: 'VariantAlleles', integerValue: '37' } }
            ],
            citations: [expect.objectContaining({ ids: [{ source: 'PubMed', id: '99999' }] })],
            comments: [{ type: null, text: 'Independent cohort' }]
          })
        ]
      })
    ])
  })

  it('preserves explicit NoClassification rather than treating it as missing data', async () => {
    const out = await getSubmissions(
      vcvXml(
        scvXml(2, 'NoClassification').replace(
          '>Pathogenic</NoClassification>',
          '>not provided</NoClassification>'
        )
      )
    )
    expect(out.submissions).toEqual([
      expect.objectContaining({
        classifications: [
          expect.objectContaining({ type: 'no_classification', description: 'not provided' })
        ]
      })
    ])
  })

  it('reports included records as indirect references without claiming zero submissions', async () => {
    const xml = `<ClinVarResult-Set><VariationArchive Accession="VCV000045122" Version="20" VariationID="45122">
      <RecordStatus>current</RecordStatus><IncludedRecord>
        <SubmittedClassificationList><SCV Accession="SCV000000001" Version="2"/></SubmittedClassificationList>
        <ClassifiedVariationList><ClassifiedVariation VariationID="999" Accession="VCV000000999" Version="3"/></ClassifiedVariationList>
      </IncludedRecord></VariationArchive></ClinVarResult-Set>`
    const out = await getSubmissions(xml)
    expect(out).toMatchObject({
      record_type: 'included',
      direct_evidence_available: false,
      submissions: [],
      referenced_submissions: [{ accession: 'SCV000000001', version: 2 }],
      classified_variations: [{ variation_id: '999', accession: 'VCV000000999', version: 3 }]
    })
    expect(out).not.toHaveProperty('n_submissions')
    expect(out).not.toHaveProperty('next_page')
  })

  it.each(['true', '1', 'false', '0'])('parses source boolean %s', async (value) => {
    const out = await getSubmissions(
      vcvXml(
        scvXml().replace(
          'ContributesToAggregateClassification="false"',
          `ContributesToAggregateClassification="${value}"`
        )
      )
    )
    expect(out.submissions).toEqual([
      expect.objectContaining({
        contributes_to_aggregate_classification: value === 'true' || value === '1'
      })
    ])
  })

  it.each(['bad', '1.5', '0', '9007199254740992'])(
    'rejects invalid SCV version %s',
    async (value) => {
      await expect(
        getSubmissions(vcvXml(scvXml().replace('Version="2"', `Version="${value}"`)))
      ).rejects.toThrow('Invalid ClinVar record version')
    }
  )

  it('rejects missing VCV identity even when queried by variation ID', async () => {
    await expect(
      getSubmissions(vcvXml(scvXml()).replace('Accession="VCV000045122"', ''), {
        accession: '45122'
      })
    ).rejects.toThrow('missing its accession')
  })

  it('rejects classified records missing their expected list', async () => {
    await expect(
      getSubmissions(
        vcvXml(scvXml()).replace(/<ClinicalAssertionList>[\s\S]*?<\/ClinicalAssertionList>/, '')
      )
    ).rejects.toThrow('missing its submission list')
  })

  it.each(['45122', 'VCV000045122'])(
    'requires a pinned version for subsequent pages of %s',
    async (accession) => {
      const fetchImpl = vi.fn()
      await expect(
        new ParserEngine({ fetchImpl }).call(
          tool('clinvar_get_submissions'),
          { accession, offset: 1 },
          { ncbiEmail: 'x@y.org' }
        )
      ).rejects.toThrow('versioned VCV')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('returns a stable empty page beyond the last SCV', async () => {
    expect(
      await getSubmissions(vcvXml(scvXml()), { accession: 'VCV000045122.20', offset: 5 })
    ).toMatchObject({
      n_submissions: 1,
      n_returned: 0,
      submissions: [],
      next_page: null,
      truncated: false
    })
  })
})

describe('clinvar_get_submissions / functional evidence and incomplete XML', () => {
  it('keeps functional experiments in their observation with source identifiers and links', async () => {
    const xml = scvXml().replace(
      /<ObservedData>[\s\S]*?<\/ObservedData>/,
      `<FunctionalData>
      <FunctionalEffect Source="SO" Id="SO:0002054">loss of function</FunctionalEffect>
      <FunctionalConsequence Source="Lab" Id="assay-1">reduced activity</FunctionalConsequence>
      <FunctionalConsequence>altered localization</FunctionalConsequence>
      <FunctionalConsequenceComment>Two experimental endpoints</FunctionalConsequenceComment>
      <Result>Activity 15% of control</Result>
      <LinkToExternalDatabase linkName="Assay report">https://example.org/assay</LinkToExternalDatabase>
    </FunctionalData><Citation><ID Source="PubMed">67890</ID></Citation>`
    )
    const out = await getSubmissions(vcvXml(xml))
    expect(out.submissions).toEqual([
      expect.objectContaining({
        observed_in: [
          expect.objectContaining({
            evidence: [],
            functional_data: [
              {
                effect: { value: 'loss of function', source: 'SO', id: 'SO:0002054' },
                consequences: [
                  { value: 'reduced activity', source: 'Lab', id: 'assay-1' },
                  { value: 'altered localization', source: null, id: null }
                ],
                consequence_comment: 'Two experimental endpoints',
                result: 'Activity 15% of control',
                external_link: { url: 'https://example.org/assay', name: 'Assay report' }
              }
            ],
            citations: [expect.objectContaining({ ids: [{ source: 'PubMed', id: '67890' }] })]
          })
        ]
      })
    ])
  })

  it('retains comment types in classification, criteria, observation and submission scopes', async () => {
    const xml = scvXml()
      .replace(
        '<Comment>Evidence &amp; rationale</Comment>',
        '<Comment Type="FlaggedComment">Review concern</Comment><Comment Type="public">Submitter rationale</Comment>'
      )
      .replace('</AttributeSet>', '<Comment Type="public">Criteria note</Comment></AttributeSet>')
      .replace('</ObservedData>', '<Comment Type="public">Cohort note</Comment></ObservedData>')
      .replace(
        '</ObservedIn>',
        '<Comment Type="ConvertedByNCBI">Observation note</Comment></ObservedIn>'
      )
      .replace(
        '</ClinicalAssertion>',
        '<Comment Type="public">Submission note</Comment></ClinicalAssertion>'
      )
    const out = await getSubmissions(vcvXml(xml))
    expect(out.submissions).toEqual([
      expect.objectContaining({
        classification_comments: [
          { type: 'FlaggedComment', text: 'Review concern' },
          { type: 'public', text: 'Submitter rationale' }
        ],
        assertion_methods: [
          expect.objectContaining({ comments: [{ type: 'public', text: 'Criteria note' }] })
        ],
        observed_in: [
          expect.objectContaining({
            comments: [{ type: 'ConvertedByNCBI', text: 'Observation note' }],
            evidence: [
              expect.objectContaining({ comments: [{ type: 'public', text: 'Cohort note' }] })
            ]
          })
        ],
        submission_comments: [{ type: 'public', text: 'Submission note' }]
      })
    ])
  })

  it('rejects a missing SCV classification block instead of returning empty classifications', async () => {
    await expect(
      getSubmissions(vcvXml(scvXml().replace(/<Classification[\s\S]*?<\/Classification>/, '')))
    ).rejects.toThrow('missing its classification block')
  })

  it.each([
    '<IncludedRecord/>',
    '<IncludedRecord><SubmittedClassificationList/></IncludedRecord>',
    '<IncludedRecord><SubmittedClassificationList/><ClassifiedVariationList/></IncludedRecord>',
    '<IncludedRecord><SubmittedClassificationList><SCV Accession="SCV000000001" Version="2"/></SubmittedClassificationList><ClassifiedVariationList/></IncludedRecord>'
  ])('rejects missing or empty included-record reference lists %#', async (body) => {
    const xml = `<ClinVarResult-Set><VariationArchive Accession="VCV000045122" Version="20" VariationID="45122">${body}</VariationArchive></ClinVarResult-Set>`
    await expect(getSubmissions(xml)).rejects.toThrow(/reference lists?/)
  })
})
