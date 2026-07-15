import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_TOOLS } from './genes'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => GENES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('genes / uniprot', () => {
  it('uniprot_get_entry parses accession, name, gene, function', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        primaryAccession: 'P04637',
        proteinDescription: {
          recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } }
        },
        genes: [{ geneName: { value: 'TP53' } }],
        comments: [
          { commentType: 'FUNCTION', texts: [{ value: 'Acts as a tumor suppressor.' }] },
          { commentType: 'SUBUNIT', texts: [{ value: 'Binds DNA as a homotetramer.' }] }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('uniprot_get_entry'),
      { accession: 'P04637' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe('https://rest.uniprot.org/uniprotkb/P04637.json')
    expect(out).toEqual({
      accession: 'P04637',
      name: 'Cellular tumor antigen p53',
      gene: 'TP53',
      function: 'Acts as a tumor suppressor.'
    })
  })

  it('uniprot_get_entry tolerates missing function comment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        primaryAccession: 'P04637',
        proteinDescription: { recommendedName: { fullName: { value: 'p53' } } },
        genes: [{ geneName: { value: 'TP53' } }],
        comments: []
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('uniprot_get_entry'),
      { accession: 'P04637' },
      {}
    )
    expect(out).toEqual({
      accession: 'P04637',
      name: 'p53',
      gene: 'TP53',
      function: undefined
    })
  })
})

describe('genes / mygene', () => {
  it('mygene_query builds the query URL and parses hits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        hits: [
          {
            _id: '7157',
            symbol: 'TP53',
            name: 'tumor protein p53',
            entrezgene: '7157',
            ensembl: { gene: 'ENSG00000141510' }
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('mygene_query'),
      { symbol: 'TP53' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('https://mygene.info/v3/query?q=TP53')
    expect(url).toContain('species=human')
    expect(url).toContain('fields=symbol,name,entrezgene,ensembl.gene')
    expect(out).toEqual([
      {
        symbol: 'TP53',
        name: 'tumor protein p53',
        entrezgene: '7157',
        ensembl: { gene: 'ENSG00000141510' }
      }
    ])
  })

  it('mygene_query returns an empty array when there are no hits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hits: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('mygene_query'),
      { symbol: 'NOPE' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('genes / go', () => {
  it('go_get_term builds the obo_id lookup URL and parses the embedded term', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        _embedded: {
          terms: [
            {
              obo_id: 'GO:0006281',
              label: 'DNA repair',
              description: ['The process of restoring DNA after damage.'],
              ontology_name: 'go'
            }
          ]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('go_get_term'),
      { id: 'GO:0006281' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/ols4/api/ontologies/go/terms?obo_id=GO%3A0006281'
    )
    expect(out).toEqual({
      id: 'GO:0006281',
      label: 'DNA repair',
      definition: 'The process of restoring DNA after damage.',
      ontology: 'go'
    })
  })

  it('go_get_term tolerates an empty terms list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ _embedded: { terms: [] } }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('go_get_term'),
      { id: 'GO:9999999' },
      {}
    )
    expect(out).toEqual({
      id: undefined,
      label: undefined,
      definition: undefined,
      ontology: undefined
    })
  })
})

describe('genes / reactome', () => {
  it('reactome_pathways_for_gene defaults to the UniProt resource and human species', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          stId: 'R-HSA-111448',
          displayName: 'Activation of NOXA and translocation to mitochondria'
        },
        {
          stId: 'R-HSA-139915',
          displayName: 'Activation of PUMA and translocation to mitochondria'
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('reactome_pathways_for_gene'),
      { identifier: 'P04637' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://reactome.org/ContentService/data/mapping/UniProt/P04637/pathways?species=9606'
    )
    expect(out).toEqual([
      { pathway_id: 'R-HSA-111448', name: 'Activation of NOXA and translocation to mitochondria' },
      { pathway_id: 'R-HSA-139915', name: 'Activation of PUMA and translocation to mitochondria' }
    ])
  })

  it('reactome_pathways_for_gene honors an explicit resource and species', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('reactome_pathways_for_gene'),
      { identifier: 'TP53', resource: 'HGNC', species: '10090' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://reactome.org/ContentService/data/mapping/HGNC/TP53/pathways?species=10090'
    )
    expect(out).toEqual([])
  })
})
