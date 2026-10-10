import { describe, expect, it, vi } from 'vitest'
import type { ToolContext, ToolDescriptor } from '../../connector-core/types'
import { PATHWAY_COMMONS_TOOLS } from './pathway-commons'

const tool = (id: string): ToolDescriptor => PATHWAY_COMMONS_TOOLS.find((entry) => entry.id === id)!

const context = (fetchText: ToolContext['fetchText']): ToolContext => ({
  credentials: {},
  fetchJson: async () => {
    throw new Error('unused fetchJson')
  },
  fetchText,
  fetchJsonWithHeaders: async () => {
    throw new Error('unused fetchJsonWithHeaders')
  },
  postJson: async () => {
    throw new Error('unused postJson')
  },
  postForm: async () => {
    throw new Error('unused postForm')
  }
})

describe('pathway-commons / search', () => {
  it('encodes repeated filters and normalizes BioPAX search hits', async () => {
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toContain('/pc2/search?')
      expect(url).toContain('q=TP53')
      expect(url).toContain('organism=9606')
      expect(url).toContain('datasource=reactome')
      expect(url).toContain('page=2')
      return JSON.stringify({
        numHits: 1,
        maxHitsPerPage: 100,
        searchHit: [
          {
            uri: 'reactome:R-HSA-123',
            biopaxClass: 'Pathway',
            name: 'TP53 signaling',
            dataSource: ['pc14:reactome'],
            organism: ['bioregistry.io/ncbitaxon:9606'],
            pathway: [],
            numParticipants: 12,
            numProcesses: 8
          }
        ]
      })
    })

    const out = (await tool('pathway_commons_search').run!(context(fetchText), {
      q: 'TP53',
      organism: ['9606'],
      datasource: ['reactome'],
      page: 2
    })) as Record<string, unknown>

    expect(out).toMatchObject({
      tool: 'pathway_commons_search',
      query: 'TP53',
      page: 2,
      total_hits: 1
    })
    expect((out.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      uri: 'reactome:R-HSA-123',
      biopax_class: 'Pathway',
      data_sources: ['pc14:reactome'],
      n_participants: 12
    })
  })

  it('rejects search hits that violate required BioPAX fields', async () => {
    const fetchText = vi.fn(async () =>
      JSON.stringify({ searchHit: [{ name: 'missing URI and class' }] })
    )

    await expect(
      tool('pathway_commons_search').run!(context(fetchText), { q: 'TP53' })
    ).rejects.toThrow('search result 1 uri')
  })
})

describe('pathway-commons / graph', () => {
  it('returns tabular interaction records for a gene neighborhood', async () => {
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toContain('/pc2/graph?')
      expect(url).toContain('kind=NEIGHBORHOOD')
      expect(url).toContain('format=SIF')
      expect(url).toContain('source=TP53')
      expect(url).toContain('pattern=INTERACTS_WITH')
      return 'MDM2\tinteracts-with\tTP53\nEGFR\tcontrols-expression-of\tTP53\n'
    })

    const out = (await tool('pathway_commons_graph').run!(context(fetchText), {
      source: ['TP53'],
      kind: 'NEIGHBORHOOD',
      format: 'SIF',
      pattern: ['INTERACTS_WITH']
    })) as Record<string, unknown>

    expect(out).toMatchObject({
      tool: 'pathway_commons_graph',
      kind: 'NEIGHBORHOOD',
      format: 'SIF',
      n_records: 2
    })
    expect(out.records).toEqual([
      { source: 'MDM2', interaction: 'interacts-with', targets: ['TP53'] },
      { source: 'EGFR', interaction: 'controls-expression-of', targets: ['TP53'] }
    ])
  })

  it('parses TXT edge and node sections separately', async () => {
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toContain('format=TXT')
      return [
        'PARTICIPANT_A\tINTERACTION_TYPE\tPARTICIPANT_B\tINTERACTION_DATA_SOURCE\tINTERACTION_PUBMED_ID\tPATHWAY_NAMES\tMEDIATOR_IDS',
        'MDM2\tcontrols-state-change-of\tTP53\tReactome\t12345\tp53 signaling\t',
        '',
        'PARTICIPANT\tPARTICIPANT_TYPE\tPARTICIPANT_NAME\tUNIFICATION_XREF\tRELATIONSHIP_XREF',
        'MDM2\tProteinReference\tMDM2\tuniprot:P02649\thgnc.symbol:MDM2;ncbigene:4193'
      ].join('\n')
    })

    const out = (await tool('pathway_commons_graph').run!(context(fetchText), {
      source: ['TP53'],
      format: 'TXT'
    })) as Record<string, unknown>

    expect(out).toMatchObject({ n_records: 1, n_nodes: 1 })
    expect(out.records).toEqual([
      {
        source: 'MDM2',
        interaction: 'controls-state-change-of',
        target: 'TP53',
        data_source: 'Reactome',
        pubmed_id: '12345',
        pathway_names: 'p53 signaling',
        mediator_ids: ''
      }
    ])
    expect(out.nodes).toEqual([
      {
        participant: 'MDM2',
        participant_type: 'ProteinReference',
        participant_name: 'MDM2',
        unification_xrefs: ['uniprot:P02649'],
        relationship_xrefs: ['hgnc.symbol:MDM2', 'ncbigene:4193']
      }
    ])
  })

  it.each([
    ['pathway_commons_graph', ''],
    ['pathway_commons_graph', '\n'],
    ['pathway_commons_graph', '\r\n'],
    ['pathway_commons_export', ''],
    ['pathway_commons_export', '\n'],
    ['pathway_commons_export', '\r\n']
  ])('preserves empty final TXT fields for %s with ending %j', async (id, ending) => {
    const content =
      [
        'PARTICIPANT_A\tINTERACTION_TYPE\tPARTICIPANT_B\tINTERACTION_DATA_SOURCE\tINTERACTION_PUBMED_ID\tPATHWAY_NAMES\tMEDIATOR_IDS',
        'MDM2\tinteracts-with\tTP53\tReactome\t\t\t',
        '',
        'PARTICIPANT\tPARTICIPANT_TYPE\tPARTICIPANT_NAME\tUNIFICATION_XREF\tRELATIONSHIP_XREF',
        'MDM2\tProteinReference\tMDM2\t\t'
      ].join(ending === '\r\n' ? '\r\n' : '\n') + ending
    const args = id === 'pathway_commons_graph' ? { source: ['MDM2'] } : { uri: ['MDM2'] }

    const out = await tool(id).run!(
      context(async () => content),
      { ...args, format: 'TXT' }
    )

    expect(out).toMatchObject({
      n_records: 1,
      records: [{ pubmed_id: '', pathway_names: '', mediator_ids: '' }],
      n_nodes: 1,
      nodes: [
        {
          participant: 'MDM2',
          participant_type: 'ProteinReference',
          participant_name: 'MDM2',
          unification_xrefs: [],
          relationship_xrefs: []
        }
      ]
    })
  })

  it('requires targets for directed paths-from-to queries', async () => {
    await expect(
      tool('pathway_commons_graph').run!(
        context(async () => ''),
        {
          source: ['TP53'],
          kind: 'PATHSFROMTO'
        }
      )
    ).rejects.toThrow('target is required for PATHSFROMTO')
  })
})

describe('pathway-commons / export', () => {
  it('preserves a GSEA GMT export and reports the number of gene sets', async () => {
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toContain('/pc2/get?')
      expect(url).toContain('format=GSEA')
      expect(url).toContain('uri=R-HSA-123')
      return 'pathway one\tR-HSA-123\tTP53\tMDM2\npathway two\tR-HSA-456\tEGFR\n'
    })

    const out = (await tool('pathway_commons_export').run!(context(fetchText), {
      uri: ['R-HSA-123'],
      format: 'GSEA'
    })) as Record<string, unknown>

    expect(out).toMatchObject({ tool: 'pathway_commons_export', format: 'GSEA', n_gene_sets: 2 })
    expect(out.content).toContain('pathway one\tR-HSA-123\tTP53')
  })
})
