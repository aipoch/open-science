import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { PROTEIN_ANNOTATION_TOOLS } from './protein-annotation'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => PROTEIN_ANNOTATION_TOOLS.find((t) => t.id === id)!

// Map a URL to a mock Response; .json()/.text() mirror real fetch (empty body → 204-style null/'').
type MockEntry = { json?: unknown; text?: string; status?: number }
function mockFetch(routes: Record<string, MockEntry>): typeof fetch {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k))
    const r = key ? routes[key] : { text: '' }
    const status = r.status ?? 200
    const body = 'json' in r ? JSON.stringify(r.json) : (r.text ?? '')
    return {
      ok: status < 400,
      status,
      json: async () => {
        if ('json' in r) return r.json
        if (!r.text) throw new SyntaxError('Unexpected end of JSON input')
        return JSON.parse(r.text)
      },
      text: async () => body
    } as Response
  }) as unknown as typeof fetch
}

const engine = (fetchImpl: typeof fetch): ParserEngine => new ParserEngine({ fetchImpl })
const calls = (fetchImpl: typeof fetch): unknown[][] =>
  (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls

describe('protein_annotation / tool set', () => {
  it('exposes exactly the 13 upstream tool ids and drops the old string_* ids', () => {
    expect(PROTEIN_ANNOTATION_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'get_domain_architecture',
        'get_interpro_entry',
        'get_pfam_clan',
        'get_pfam_family_proteins',
        'get_pfam_family_proteomes',
        'get_protein_atlas_gene',
        'get_string_best_similarity_hits',
        'get_string_network',
        'get_string_similarity_scores',
        'map_string_ids',
        'search_interpro_entries',
        'search_pfam_clans',
        'search_protein_atlas'
      ].sort()
    )
    const ids = PROTEIN_ANNOTATION_TOOLS.map((t) => t.id)
    expect(ids).not.toContain('string_interaction_partners')
    expect(ids).not.toContain('string_network')
    expect(PROTEIN_ANNOTATION_TOOLS.every((t) => t.connector === 'protein_annotation')).toBe(true)
  })
})

describe('protein_annotation / InterPro', () => {
  it('get_domain_architecture walks pages, verifies count, and shapes a deterministic summary', async () => {
    const page2 =
      'https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/P04637/?page_size=200&cursor=x'
    const fetchImpl = mockFetch({
      '/entry/interpro/protein/uniprot/P04637/?page_size=200&cursor=x': {
        json: {
          count: 2,
          next: null,
          results: [
            {
              metadata: {
                accession: 'IPR002117',
                name: 'p53 tumour suppressor family',
                type: 'family',
                member_databases: { pfam: { PF00870: 'P53' } }
              },
              proteins: [
                {
                  accession: 'P04637',
                  protein_length: 393,
                  entry_protein_locations: [{ fragments: [{ start: 95, end: 288 }] }]
                }
              ]
            }
          ]
        }
      },
      '/entry/interpro/protein/uniprot/P04637/?page_size=200': {
        json: {
          count: 2,
          next: page2,
          results: [
            {
              metadata: {
                accession: 'IPR011615',
                name: 'p53, DNA-binding domain',
                type: 'domain',
                member_databases: {}
              },
              proteins: [
                {
                  accession: 'P04637',
                  protein_length: 393,
                  entry_protein_locations: [{ fragments: [{ start: 94, end: 292 }] }]
                }
              ]
            }
          ]
        }
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_domain_architecture'),
      { accessions: ['P04637'] },
      {}
    )) as {
      summaries: Record<string, { protein: string; entry_count: number; entries: unknown[] }>
      stats: { http_requests: number }
    }
    const s = out.summaries.P04637
    expect(s.protein).toBe('P04637')
    expect(s.entry_count).toBe(2)
    // family sorts before domain (type-order rank)
    expect(s.entries.map((e) => (e as { accession: string }).accession)).toEqual([
      'IPR002117',
      'IPR011615'
    ])
    expect((s.entries[0] as { member_db_signatures: unknown[] }).member_db_signatures).toEqual([
      { database: 'pfam', accession: 'PF00870', name: 'P53' }
    ])
    expect(out.stats.http_requests).toBe(2)
  })

  it('get_domain_architecture treats an empty (204) protein as entry_count 0', async () => {
    const fetchImpl = mockFetch({ '/entry/interpro/protein/uniprot/Q00000/': { text: '' } })
    const out = (await engine(fetchImpl).call(
      tool('get_domain_architecture'),
      { accessions: ['Q00000'] },
      {}
    )) as { summaries: Record<string, { entry_count: number; entries: unknown[] }> }
    expect(out.summaries.Q00000.entry_count).toBe(0)
    expect(out.summaries.Q00000.entries).toEqual([])
  })

  it('search_interpro_entries sorts rows by accession and carries the API count', async () => {
    const fetchImpl = mockFetch({
      '/entry/pfam/': {
        json: {
          count: 2,
          next: null,
          results: [
            {
              metadata: {
                accession: 'PF00069',
                name: 'Protein kinase domain',
                type: 'domain',
                source_database: 'pfam',
                integrated: 'IPR000719'
              }
            },
            {
              metadata: {
                accession: 'PF00047',
                name: 'Immunoglobulin domain',
                type: 'domain',
                source_database: 'pfam',
                integrated: null
              }
            }
          ]
        }
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('search_interpro_entries'),
      { query: 'kinase', source_db: 'pfam' },
      {}
    )) as { count: number; results: Array<{ accession: string }> }
    expect(calls(fetchImpl)[0][0]).toContain('/entry/pfam/?search=kinase')
    expect(out.count).toBe(2)
    expect(out.results.map((r) => r.accession)).toEqual(['PF00047', 'PF00069'])
  })

  it('get_interpro_entry routes PF accessions to the pfam endpoint and shapes name/set_info', async () => {
    const fetchImpl = mockFetch({
      '/entry/pfam/PF00069/': {
        json: {
          metadata: {
            accession: 'PF00069',
            name: { name: 'Protein kinase domain', short: 'Pkinase' },
            type: 'domain',
            source_database: 'pfam',
            integrated: 'IPR000719',
            set_info: { accession: 'CL0016' },
            go_terms: [{ identifier: 'GO:0004672' }],
            literature: [{}, {}]
          }
        }
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_interpro_entry'),
      { accession: 'pf00069' },
      {}
    )) as {
      accession: string
      name: { name: string; short: string }
      set_info: unknown
      n_literature_refs: number
    }
    expect(calls(fetchImpl)[0][0]).toContain('/entry/pfam/PF00069/')
    expect(out.accession).toBe('PF00069')
    expect(out.name).toEqual({ name: 'Protein kinase domain', short: 'Pkinase' })
    expect(out.set_info).toEqual({ accession: 'CL0016' })
    expect(out.n_literature_refs).toBe(2)
  })

  it('get_pfam_clan reads relationships.nodes as the sorted member list', async () => {
    const fetchImpl = mockFetch({
      '/set/pfam/CL0016/': {
        json: {
          metadata: {
            accession: 'CL0016',
            name: 'Protein kinase superfamily',
            source_database: 'pfam',
            relationships: {
              nodes: [
                { accession: 'PF00069', name: 'Pkinase', short_name: 'Pkinase', type: 'family' },
                { accession: 'PF00027', name: 'cNMP_binding', short_name: 'cNMP', type: 'family' }
              ]
            }
          }
        }
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_pfam_clan'),
      { clan_accession: 'CL0016' },
      {}
    )) as { member_count: number; members: Array<{ accession: string }> }
    expect(out.member_count).toBe(2)
    expect(out.members.map((m) => m.accession)).toEqual(['PF00027', 'PF00069'])
  })

  it('get_pfam_family_proteins count_only issues one page_size=1 request and returns null results', async () => {
    const fetchImpl = mockFetch({
      '/protein/uniprot/entry/pfam/PF00069/': { json: { count: 1500000, results: [] } }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_pfam_family_proteins'),
      { pfam_accession: 'PF00069', count_only: true },
      {}
    )) as { count: number; results: unknown }
    expect(calls(fetchImpl)[0][0]).toContain('page_size=1')
    expect(out).toEqual({ count: 1500000, results: null })
  })

  it('get_pfam_family_proteomes defaults to count_only', async () => {
    const fetchImpl = mockFetch({
      '/proteome/uniprot/entry/pfam/PF00069/': { json: { count: 4200, results: [] } }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_pfam_family_proteomes'),
      { pfam_accession: 'PF00069' },
      {}
    )) as { count: number; results: unknown }
    expect(calls(fetchImpl)[0][0]).toContain('page_size=1')
    expect(out).toEqual({ count: 4200, results: null })
  })
})

describe('protein_annotation / Human Protein Atlas', () => {
  it('get_protein_atlas_gene resolves a symbol then groups the record into sections', async () => {
    const fetchImpl = mockFetch({
      '/api/search_download.php': {
        json: [{ Gene: 'TP53', Ensembl: 'ENSG00000141510', 'Gene synonym': ['p53'] }]
      },
      '/ENSG00000141510.json': {
        json: {
          Gene: 'TP53',
          Ensembl: 'ENSG00000141510',
          'Subcellular main location': ['Nucleoplasm'],
          'Cancer prognostics - Breast cancer': { prognostic: 'unfavorable' }
        }
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_protein_atlas_gene'),
      { gene: 'TP53' },
      {}
    )) as {
      identity: Record<string, unknown>
      subcellular: Record<string, unknown>
      pathology: { prognostics: Record<string, unknown> }
    }
    expect(out.identity.Gene).toBe('TP53')
    expect(out.subcellular['Subcellular main location']).toEqual(['Nucleoplasm'])
    expect(out.pathology.prognostics['Breast cancer']).toEqual({ prognostic: 'unfavorable' })
  })

  it('get_protein_atlas_gene full=true returns the raw record and skips grouping', async () => {
    const fetchImpl = mockFetch({
      '/ENSG00000141510.json': { json: { Gene: 'TP53', foo: 'bar' } }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_protein_atlas_gene'),
      { gene: 'ENSG00000141510', full: true },
      {}
    )) as Record<string, unknown>
    expect(out).toEqual({ Gene: 'TP53', foo: 'bar' })
  })

  it('search_protein_atlas passes the query/columns and returns the raw rows', async () => {
    const fetchImpl = mockFetch({
      '/api/search_download.php': { json: [{ Gene: 'TP53' }, { Gene: 'TP63' }] }
    })
    const out = (await engine(fetchImpl).call(
      tool('search_protein_atlas'),
      { query: 'kinase', columns: 'g,eg' },
      {}
    )) as Array<{ Gene: string }>
    expect(calls(fetchImpl)[0][0]).toContain('columns=g%2Ceg')
    expect(out.map((r) => r.Gene)).toEqual(['TP53', 'TP63'])
  })
})

describe('protein_annotation / STRING', () => {
  it('map_string_ids partitions input into mapped and unmapped by queryIndex', async () => {
    const fetchImpl = mockFetch({
      '/json/version': {
        json: [{ string_version: '12.0', stable_address: 'https://version-12-0.string-db.org' }]
      },
      '/json/get_string_ids': {
        json: [
          {
            queryIndex: 0,
            stringId: '9606.ENSP00000269305',
            preferredName: 'TP53',
            ncbiTaxonId: 9606
          },
          {
            queryIndex: 2,
            stringId: '9606.ENSP00000275493',
            preferredName: 'EGFR',
            ncbiTaxonId: 9606
          }
        ]
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('map_string_ids'),
      { symbols: ['TP53', 'NOTAGENE', 'EGFR'] },
      {}
    )) as {
      string_version: { string_version: string }
      mapped: Array<{ query: string }>
      unmapped: string[]
    }
    expect(out.string_version.string_version).toBe('12.0')
    expect(out.mapped.map((m) => m.query)).toEqual(['TP53', 'EGFR'])
    expect(out.unmapped).toEqual(['NOTAGENE'])
  })

  it('get_string_network parses the TSV, orients + dedupes edges, and builds nodes/summary', async () => {
    const tsv =
      'stringId_A\tstringId_B\tpreferredName_A\tpreferredName_B\tncbiTaxonId\tscore\tnscore\tfscore\tpscore\tascore\tescore\tdscore\ttscore\n' +
      '9606.ENSP00000258149\t9606.ENSP00000269305\tMDM2\tTP53\t9606\t0.999\t0\t0\t0\t0\t0.9\t0\t0.5\n'
    const fetchImpl = mockFetch({
      '/json/version': { json: [{ string_version: '12.0', stable_address: 'x' }] },
      '/json/get_string_ids': {
        json: [
          {
            queryIndex: 0,
            stringId: '9606.ENSP00000269305',
            preferredName: 'TP53',
            ncbiTaxonId: 9606
          },
          {
            queryIndex: 1,
            stringId: '9606.ENSP00000258149',
            preferredName: 'MDM2',
            ncbiTaxonId: 9606
          }
        ]
      },
      '/tsv/network': { text: tsv }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_string_network'),
      { symbols: ['TP53', 'MDM2'], required_score: 700 },
      {}
    )) as {
      edges: Array<{ a: string; b: string; score: number; evidence: Record<string, number> }>
      nodes: Array<{ name: string; degree: number }>
      summary: { n_edges: number; n_nodes: number }
      unmapped: string[]
    }
    expect(out.edges).toHaveLength(1)
    // oriented so (name_a, id_a) <= (name_b, id_b): MDM2 before TP53
    expect(out.edges[0]).toMatchObject({ a: 'MDM2', b: 'TP53', score: 0.999 })
    expect(out.edges[0].evidence).toEqual({ escore: 0.9, tscore: 0.5 })
    expect(out.summary).toMatchObject({ n_edges: 1, n_nodes: 2 })
    expect(out.nodes.map((n) => n.degree)).toEqual([1, 1])
    expect(out.unmapped).toEqual([])
  })

  it('get_string_similarity_scores canonicalizes homology pairs (id_a <= id_b, self flagged)', async () => {
    const fetchImpl = mockFetch({
      '/json/version': { json: [{ string_version: '12.0' }] },
      '/json/get_string_ids': {
        json: [
          {
            queryIndex: 0,
            stringId: '9606.ENSP00000269305',
            preferredName: 'TP53',
            ncbiTaxonId: 9606
          },
          {
            queryIndex: 1,
            stringId: '9606.ENSP00000258149',
            preferredName: 'MDM2',
            ncbiTaxonId: 9606
          }
        ]
      },
      '/json/homology': {
        json: [
          {
            stringId_A: '9606.ENSP00000269305',
            stringId_B: '9606.ENSP00000269305',
            ncbiTaxonId_A: 9606,
            ncbiTaxonId_B: 9606,
            bitscore: '806.2'
          },
          {
            stringId_A: '9606.ENSP00000269305',
            stringId_B: '9606.ENSP00000258149',
            ncbiTaxonId_A: 9606,
            ncbiTaxonId_B: 9606,
            bitscore: '55.1'
          },
          {
            stringId_A: '9606.ENSP00000258149',
            stringId_B: '9606.ENSP00000269305',
            ncbiTaxonId_A: 9606,
            ncbiTaxonId_B: 9606,
            bitscore: '55.1'
          }
        ]
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_string_similarity_scores'),
      { symbols: ['TP53', 'MDM2'] },
      {}
    )) as {
      n_pairs: number
      n_self: number
      pairs: Array<{ id_a: string; id_b: string; self: boolean; name_a: string }>
    }
    expect(out.n_pairs).toBe(2)
    expect(out.n_self).toBe(1)
    // pairs sorted by (id_a, id_b); ...258149 < ...269305
    expect(out.pairs[0].id_a).toBe('9606.ENSP00000258149')
    expect(out.pairs[0].name_a).toBe('MDM2')
  })

  it('get_string_best_similarity_hits maps hits and sorts by query id', async () => {
    const fetchImpl = mockFetch({
      '/json/version': { json: [{ string_version: '12.0' }] },
      '/json/get_string_ids': {
        json: [
          {
            queryIndex: 0,
            stringId: '9606.ENSP00000269305',
            preferredName: 'TP53',
            ncbiTaxonId: 9606
          }
        ]
      },
      '/json/homology_best': {
        json: [
          {
            stringId_A: '9606.ENSP00000269305',
            stringId_B: '10090.ENSMUSP00000104298',
            ncbiTaxonId_A: 9606,
            ncbiTaxonId_B: 10090,
            bitscore: 598.2
          }
        ]
      }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_string_best_similarity_hits'),
      { symbols: ['TP53'], target_species: 10090 },
      {}
    )) as {
      species_b: number
      n_hits: number
      hits: Array<{ query_name: string; hit_id: string; bitscore: number }>
    }
    expect(calls(fetchImpl).some((c) => String(c[0]).includes('species_b=10090'))).toBe(true)
    expect(out.species_b).toBe(10090)
    expect(out.n_hits).toBe(1)
    expect(out.hits[0]).toMatchObject({
      query_name: 'TP53',
      hit_id: '10090.ENSMUSP00000104298',
      bitscore: 598.2
    })
  })
})

// Live self-tests against the real public endpoints. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)('protein_annotation / LIVE', () => {
  const live = new ParserEngine()

  it('get_domain_architecture P04637 returns InterPro entries with a verified count', async () => {
    const out = (await live.call(
      tool('get_domain_architecture'),
      { accessions: ['P04637'] },
      {}
    )) as {
      summaries: Record<string, { entry_count: number; entries: unknown[]; protein_length: number }>
    }
    const s = out.summaries.P04637
    expect(s.entry_count).toBe(s.entries.length)
    expect(s.protein_length).toBeGreaterThan(300)
  }, 60000)

  it('search_interpro_entries "kinase" returns count-verified rows sorted by accession', async () => {
    const out = (await live.call(
      tool('search_interpro_entries'),
      { query: 'kinase', source_db: 'pfam' },
      {}
    )) as { count: number; results: Array<{ accession: string }> }
    expect(out.results.length).toBe(out.count)
    const accs = out.results.map((r) => r.accession)
    expect([...accs].sort()).toEqual(accs)
  }, 120000)

  it('get_interpro_entry serves both an IPR and a PF accession', async () => {
    const ipr = (await live.call(tool('get_interpro_entry'), { accession: 'IPR000719' }, {})) as {
      accession: string
    }
    const pf = (await live.call(tool('get_interpro_entry'), { accession: 'PF00069' }, {})) as {
      accession: string
    }
    expect(ipr.accession).toBe('IPR000719')
    expect(pf.accession).toBe('PF00069')
  }, 60000)

  it('get_pfam_clan CL0016 lists member families', async () => {
    const out = (await live.call(tool('get_pfam_clan'), { clan_accession: 'CL0016' }, {})) as {
      member_count: number
      members: unknown[]
    }
    expect(out.member_count).toBe(out.members.length)
    expect(out.member_count).toBeGreaterThan(0)
  }, 60000)

  it('get_pfam_family_proteins PF00069 count_only returns a large count', async () => {
    const out = (await live.call(
      tool('get_pfam_family_proteins'),
      { pfam_accession: 'PF00069', count_only: true },
      {}
    )) as { count: number; results: unknown }
    expect(out.results).toBeNull()
    expect(out.count).toBeGreaterThan(1000)
  }, 60000)

  it('get_protein_atlas_gene TP53 groups the record', async () => {
    const out = (await live.call(tool('get_protein_atlas_gene'), { gene: 'TP53' }, {})) as {
      identity: Record<string, unknown>
    }
    expect(String(out.identity.Gene)).toBe('TP53')
  }, 60000)

  it('map_string_ids + get_string_network resolve TP53/BRCA1/EGFR and return edges', async () => {
    const mapped = (await live.call(
      tool('map_string_ids'),
      { symbols: ['TP53', 'BRCA1', 'EGFR'] },
      {}
    )) as {
      mapped: unknown[]
      unmapped: string[]
    }
    expect(mapped.mapped.length).toBe(3)
    expect(mapped.unmapped).toEqual([])
    const net = (await live.call(
      tool('get_string_network'),
      { symbols: ['TP53', 'BRCA1', 'EGFR'] },
      {}
    )) as { nodes: unknown[]; edges: unknown[] }
    expect(net.nodes.length).toBe(3)
    expect(Array.isArray(net.edges)).toBe(true)
  }, 60000)
})
