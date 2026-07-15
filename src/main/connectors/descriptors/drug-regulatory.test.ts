import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { DRUG_REGULATORY_TOOLS } from './drug-regulatory'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => DRUG_REGULATORY_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
// openFDA answers a zero-hit search with HTTP 404 (the engine turns that into an "HTTP 404" error).
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

// Drives a tool through a real ParserEngine with a queue of mocked responses, returning the parsed
// output and the sequence of requested URLs.
const run = async (
  id: string,
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: unknown; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = await new ParserEngine({ fetchImpl }).call(tool(id), args, {})
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const APP = 'https://api.fda.gov/drug/drugsfda.json'
const LBL = 'https://api.fda.gov/drug/label.json'

const LIPITOR: Record<string, unknown> = {
  application_number: 'NDA020702',
  sponsor_name: 'UPJOHN',
  products: [
    {
      brand_name: 'LIPITOR',
      active_ingredients: [{ name: 'ATORVASTATIN CALCIUM', strength: 'EQ 80MG BASE' }],
      dosage_form: 'TABLET',
      route: 'ORAL',
      marketing_status: 'Prescription',
      te_code: 'AB'
    }
  ],
  submissions: [{ submission_type: 'ORIG', submission_status: 'AP' }],
  openfda: {
    generic_name: ['ATORVASTATIN CALCIUM'],
    substance_name: ['ATORVASTATIN CALCIUM TRIHYDRATE'],
    route: ['ORAL'],
    manufacturer_name: ['Viatris Specialty LLC'],
    product_type: ['HUMAN PRESCRIPTION DRUG']
  }
}

describe('drug_regulatory / search_drug_applications', () => {
  it('builds an ANDed search with a date range and shapes flattened openfda fields', async () => {
    const { out, urls } = await run(
      'search_drug_applications',
      {
        generic: 'ATORVASTATIN CALCIUM',
        marketing_status: 'Prescription',
        submission_date_from: '2000-01-01',
        max_records: 10
      },
      [okJson({ meta: { last_updated: '2026-07-14', results: { total: 1 } }, results: [LIPITOR] })]
    )
    expect(urls[0]).toBe(
      `${APP}?search=${encodeURIComponent(
        '(products.marketing_status:"Prescription" AND openfda.generic_name:"ATORVASTATIN CALCIUM") AND submissions.submission_status_date:[20000101 TO 30001231]'
      )}&limit=10&skip=0`
    )
    expect(out).toEqual({
      total: 1,
      n_returned: 1,
      truncated: false,
      last_updated: '2026-07-14',
      records: [
        {
          application_number: 'NDA020702',
          sponsor_name: 'UPJOHN',
          products: LIPITOR.products,
          submissions: LIPITOR.submissions,
          openfda_generic_name: ['ATORVASTATIN CALCIUM'],
          openfda_pharm_class_epc: [],
          openfda_pharm_class_moa: [],
          openfda_pharm_class_cs: [],
          openfda_pharm_class_pe: [],
          openfda_substance_name: ['ATORVASTATIN CALCIUM TRIHYDRATE'],
          openfda_route: ['ORAL'],
          openfda_manufacturer_name: ['Viatris Specialty LLC'],
          openfda_product_type: ['HUMAN PRESCRIPTION DRUG']
        }
      ]
    })
  })

  it('sets truncated when fewer records than the total are returned', async () => {
    const { out } = await run('search_drug_applications', { sponsor: 'UPJOHN', max_records: 1 }, [
      okJson({ meta: { results: { total: 5 } }, results: [LIPITOR] })
    ])
    expect(out).toMatchObject({ total: 5, n_returned: 1, truncated: true })
  })

  it('serves a broad search truncated with the true total instead of raising', async () => {
    const { out } = await run('search_drug_applications', { dosage_form: 'TABLET' }, [
      okJson({ meta: { results: { total: 40000 } }, results: [LIPITOR] })
    ])
    expect(out).toMatchObject({ total: 40000, n_returned: 1, truncated: true })
  })

  it('raises only when asked for more records than openFDA can page to', async () => {
    await expect(
      run('search_drug_applications', { max_records: 30000 }, [
        okJson({ meta: { results: { total: 40000 } }, results: [] })
      ])
    ).rejects.toThrow(/narrow with submission_date_from/)
  })

  it('honours an OR search_type and a verbatim raw_search override', async () => {
    const { urls } = await run(
      'search_drug_applications',
      { brand: 'LIPITOR', sponsor: 'UPJOHN', search_type: 'or', max_records: 1 },
      [okJson({ meta: { results: { total: 1 } }, results: [LIPITOR] })]
    )
    expect(decodeURIComponent(urls[0])).toContain(
      'products.brand_name:"LIPITOR" OR sponsor_name:"UPJOHN"'
    )
    const raw = await run(
      'search_drug_applications',
      { raw_search: 'sponsor_name:"PFIZER"', brand: 'IGNORED', max_records: 1 },
      [okJson({ meta: { results: { total: 1 } }, results: [LIPITOR] })]
    )
    expect(decodeURIComponent(raw.urls[0])).toContain('sponsor_name:"PFIZER"')
    expect(decodeURIComponent(raw.urls[0])).not.toContain('IGNORED')
  })
})

describe('drug_regulatory / get_drug_application', () => {
  it('fetches one application by number', async () => {
    const { out, urls } = await run('get_drug_application', { application_number: 'NDA020702' }, [
      okJson({ meta: { results: { total: 1 } }, results: [LIPITOR] })
    ])
    expect(urls[0]).toBe(
      `${APP}?search=${encodeURIComponent('application_number:"NDA020702"')}&limit=1`
    )
    expect(out).toEqual({ application_number: 'NDA020702', found: true, record: LIPITOR })
  })

  it('returns found:false and a null record on a 404 not-found', async () => {
    const { out } = await run('get_drug_application', { application_number: 'NDA999999' }, [
      notFound()
    ])
    expect(out).toEqual({ application_number: 'NDA999999', found: false, record: null })
  })
})

describe('drug_regulatory / count_drug_applications', () => {
  it('resolves a friendly count field, sums buckets, and reports the api field', async () => {
    const { out, urls } = await run('count_drug_applications', { count_field: 'dosage_form' }, [
      okJson({
        results: [
          { term: 'TABLET', count: 10710 },
          { term: 'INJECTABLE', count: 5411 }
        ]
      })
    ])
    expect(urls[0]).toBe(
      `${APP}?count=${encodeURIComponent('products.dosage_form.exact')}&limit=100`
    )
    expect(out).toEqual({
      count_field: 'dosage_form',
      api_field: 'products.dosage_form.exact',
      n_buckets: 2,
      bucket_sum: 16121,
      buckets: [
        { term: 'TABLET', count: 10710 },
        { term: 'INJECTABLE', count: 5411 }
      ]
    })
  })

  it('ANDs an optional filter into the count search and caps max_buckets at 1000', async () => {
    const { urls } = await run(
      'count_drug_applications',
      { count_field: 'products.te_code', marketing_status: 'Prescription', max_buckets: 5000 },
      [okJson({ results: [{ term: 'AB', count: 1 }] })]
    )
    expect(urls[0]).toBe(
      `${APP}?search=${encodeURIComponent('products.marketing_status:"Prescription"')}` +
        `&count=${encodeURIComponent('products.te_code')}&limit=1000`
    )
  })
})

describe('drug_regulatory / get_drug_statistics', () => {
  it('assembles corpus stats from a base query plus four count queries', async () => {
    const { out, urls } = await run('get_drug_statistics', {}, [
      okJson({
        meta: { last_updated: '2026-07-14', results: { total: 29207 } },
        results: [LIPITOR]
      }),
      okJson({
        results: [
          { term: 'Discontinued', count: 14750 },
          { term: 'Prescription', count: 13338 }
        ]
      }),
      okJson({
        results: [
          { term: 'TABLET', count: 10710 },
          { term: 'INJECTABLE', count: 5411 }
        ]
      }),
      okJson({ results: [{ term: 'ORAL', count: 17491 }] }),
      okJson({ results: [{ term: 'WATSON LABS', count: 902 }] })
    ])
    expect(urls[0]).toBe(`${APP}?limit=1`)
    expect(urls[1]).toBe(`${APP}?count=products.marketing_status&limit=1000`)
    expect(urls[2]).toBe(
      `${APP}?count=${encodeURIComponent('products.dosage_form.exact')}&limit=1000`
    )
    expect(urls[3]).toBe(`${APP}?count=${encodeURIComponent('products.route.exact')}&limit=1000`)
    expect(urls[4]).toBe(`${APP}?count=sponsor_name&limit=25`)
    expect(out).toMatchObject({
      total_applications: 29207,
      last_updated: '2026-07-14',
      marketing_status: [
        { term: 'Discontinued', count: 14750 },
        { term: 'Prescription', count: 13338 }
      ],
      dosage_form_distinct: 2,
      route_distinct: 1,
      sponsor_top: [{ term: 'WATSON LABS', count: 902 }]
    })
  })
})

describe('drug_regulatory / list_pharmacologic_classes', () => {
  it('counts the harmonized pharm-class field for the chosen class type', async () => {
    const { out, urls } = await run(
      'list_pharmacologic_classes',
      { class_type: 'moa', max_buckets: 2 },
      [
        okJson({
          results: [
            { term: 'Corticosteroid Hormone Receptor Agonists [MoA]', count: 329 },
            { term: 'Cyclooxygenase Inhibitors [MoA]', count: 238 }
          ]
        })
      ]
    )
    expect(urls[0]).toBe(
      `${APP}?count=${encodeURIComponent('openfda.pharm_class_moa.exact')}&limit=2`
    )
    expect(out).toEqual({
      class_type: 'moa',
      n_classes: 2,
      classes: [
        { term: 'Corticosteroid Hormone Receptor Agonists [MoA]', count: 329 },
        { term: 'Cyclooxygenase Inhibitors [MoA]', count: 238 }
      ]
    })
  })

  it('defaults to the epc class type', async () => {
    const { out, urls } = await run('list_pharmacologic_classes', {}, [okJson({ results: [] })])
    expect(urls[0]).toBe(
      `${APP}?count=${encodeURIComponent('openfda.pharm_class_epc.exact')}&limit=100`
    )
    expect(out).toMatchObject({ class_type: 'epc', n_classes: 0, classes: [] })
  })
})

describe('drug_regulatory / get_generic_equivalents', () => {
  it('resolves the brand, extracts the ingredient set, and keeps exact-set matches', async () => {
    const generic: Record<string, unknown> = {
      application_number: 'ANDA076543',
      sponsor_name: 'GENERIC CO',
      products: [
        {
          brand_name: 'ATORVASTATIN CALCIUM',
          active_ingredients: [{ name: 'ATORVASTATIN CALCIUM' }],
          te_code: 'AB',
          marketing_status: 'Prescription'
        }
      ]
    }
    // A combination product shares the ingredient but has an extra one, so its set must not match.
    const combo: Record<string, unknown> = {
      application_number: 'NDA021540',
      products: [
        {
          brand_name: 'CADUET',
          active_ingredients: [{ name: 'AMLODIPINE BESYLATE' }, { name: 'ATORVASTATIN CALCIUM' }]
        }
      ]
    }
    const { out, urls } = await run('get_generic_equivalents', { brand: 'Lipitor' }, [
      okJson({ results: [LIPITOR] }),
      okJson({ results: [LIPITOR, generic, combo] })
    ])
    expect(urls[0]).toBe(
      `${APP}?search=${encodeURIComponent('products.brand_name:"Lipitor"')}&limit=100`
    )
    expect(urls[1]).toBe(
      `${APP}?search=${encodeURIComponent('products.active_ingredients.name:"ATORVASTATIN CALCIUM"')}&limit=1000`
    )
    expect(out).toEqual({
      brand: 'Lipitor',
      reference_applications: ['NDA020702'],
      active_ingredient_sets: [['ATORVASTATIN CALCIUM']],
      equivalents: [LIPITOR, generic]
    })
  })

  it('returns empty sets and equivalents when the brand is unknown (404)', async () => {
    const { out } = await run('get_generic_equivalents', { brand: 'NOPEDRUG' }, [notFound()])
    expect(out).toEqual({
      brand: 'NOPEDRUG',
      reference_applications: [],
      active_ingredient_sets: [],
      equivalents: []
    })
  })
})

describe('drug_regulatory / search_drug_labels', () => {
  const TYLENOL: Record<string, unknown> = {
    set_id: '015a6179-bacb-452d-b594-4de628ddc11d',
    version: 11,
    effective_time: '20241107',
    warnings: ['Some warning text.'],
    indications_and_usage: ['Uses temporarily relieves minor aches and pains.'],
    openfda: {
      brand_name: ['TYLENOL Extra Strength'],
      generic_name: ['ACETAMINOPHEN'],
      substance_name: ['ACETAMINOPHEN'],
      manufacturer_name: ['Kenvue Brands LLC'],
      route: ['ORAL'],
      product_type: ['HUMAN OTC DRUG'],
      application_number: ['M013']
    }
  }

  it('builds the label search and returns the default structured record', async () => {
    const { out, urls } = await run(
      'search_drug_labels',
      { brand_name: 'Tylenol', max_records: 5 },
      [okJson({ meta: { results: { total: 118 } }, results: [TYLENOL] })]
    )
    expect(urls[0]).toBe(
      `${LBL}?search=${encodeURIComponent('openfda.brand_name:"Tylenol"')}&limit=5&skip=0`
    )
    expect(out).toEqual({
      search: 'openfda.brand_name:"Tylenol"',
      total: 118,
      n_returned: 1,
      truncated: true,
      records: [
        {
          identification: {
            set_id: '015a6179-bacb-452d-b594-4de628ddc11d',
            spl_version: 11,
            effective_time: '20241107',
            brand_name: ['TYLENOL Extra Strength'],
            generic_name: ['ACETAMINOPHEN'],
            substance_name: ['ACETAMINOPHEN'],
            manufacturer: ['Kenvue Brands LLC'],
            route: ['ORAL'],
            product_type: ['HUMAN OTC DRUG'],
            application_number: ['M013']
          },
          has_boxed_warning: false,
          warning_sections: ['warnings'],
          indications_and_usage: 'Uses temporarily relieves minor aches and pains.'
        }
      ]
    })
  })

  it('queries .exact fields when exact is set', async () => {
    const { urls } = await run(
      'search_drug_labels',
      { active_ingredient: 'ACETAMINOPHEN', exact: true, max_records: 1 },
      [okJson({ meta: { results: { total: 1 } }, results: [TYLENOL] })]
    )
    expect(decodeURIComponent(urls[0])).toContain('openfda.substance_name.exact:"ACETAMINOPHEN"')
  })

  it('extracts requested raw sections instead of the default record', async () => {
    const { out } = await run(
      'search_drug_labels',
      { brand_name: 'Tylenol', sections: ['warnings', 'indications_and_usage'], max_records: 1 },
      [okJson({ meta: { results: { total: 1 } }, results: [TYLENOL] })]
    )
    expect(out).toMatchObject({
      records: [
        {
          set_id: '015a6179-bacb-452d-b594-4de628ddc11d',
          brand_name: ['TYLENOL Extra Strength'],
          generic_name: ['ACETAMINOPHEN'],
          sections: {
            warnings: 'Some warning text.',
            indications_and_usage: 'Uses temporarily relieves minor aches and pains.'
          }
        }
      ]
    })
  })
})
