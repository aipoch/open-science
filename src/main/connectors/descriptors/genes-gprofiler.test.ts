import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../types'
import { GENES_GPROFILER_TOOLS } from './genes-gprofiler'

const listTool = GENES_GPROFILER_TOOLS.find((tool) => tool.id === 'list_enrichment_sources')!
const enrichTool = GENES_GPROFILER_TOOLS.find((tool) => tool.id === 'enrich_gene_set')!

const context = (
  fetchJson: ToolContext['fetchJson'],
  postJson: ToolContext['postJson']
): ToolContext => ({
  credentials: {},
  fetchJson,
  fetchText: async () => {
    throw new Error('unused fetchText')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('unused fetchJsonWithHeaders')
  },
  postJson,
  postForm: async () => {
    throw new Error('unused postForm')
  }
})

describe('genes / list_enrichment_sources', () => {
  it('combines organism namespaces with source data versions', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes('/organisms_list/')) {
        return [
          {
            display_name: 'Human',
            id: 'hsapiens',
            scientific_name: 'Homo sapiens',
            taxonomy_id: '9606',
            version: 'GRCh38.p14',
            nonnumeric_namespaces: ['ENSG', 'HGNC'],
            numeric_namespaces: ['ENTREZGENE_ACC']
          }
        ]
      }
      return {
        organism: 'hsapiens',
        gprofiler_version: 'e114_eg62_p19_27110d83',
        sources: {
          'GO:BP': { name: 'biological process', version: '2026-01-23' },
          REAC: { name: 'Reactome', version: '2026-3-20' }
        }
      }
    })
    const out = await listTool.run!(
      context(fetchJson, async () => ({})),
      { organism: 'hsapiens' }
    )

    expect(out).toMatchObject({
      organism: 'hsapiens',
      taxonomy_id: '9606',
      gprofiler_version: 'e114_eg62_p19_27110d83',
      sources: [
        { id: 'GO:BP', name: 'biological process', version: '2026-01-23' },
        { id: 'REAC', name: 'Reactome', version: '2026-3-20' }
      ]
    })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('genes / enrich_gene_set', () => {
  it('submits an explicit custom background and preserves mapping metadata', async () => {
    const postJson = vi.fn(async (_url: string, body: unknown) => {
      expect(body).toMatchObject({
        organism: 'hsapiens',
        query: ['TP53', 'NOSUCH'],
        sources: ['GO:BP', 'REAC'],
        background: ['TP53', 'EGFR', 'BRCA1'],
        domain_scope: 'custom',
        significance_threshold_method: 'fdr',
        output: 'json'
      })
      return {
        result: [
          {
            source: 'GO:BP',
            native: 'GO:0006260',
            name: 'DNA replication',
            p_value: 0.001,
            significant: true,
            intersection_size: 1,
            term_size: 300,
            query_size: 1,
            effective_domain_size: 3
          }
        ],
        meta: {
          genes_metadata: {
            failed: ['NOSUCH'],
            ambiguous: {},
            duplicates: [],
            query: {
              query_1: { mapping: { TP53: ['ENSG00000141510'] }, ensgs: ['ENSG00000141510'] }
            }
          }
        }
      }
    })
    const out = (await enrichTool.run!(
      context(async () => ({}), postJson),
      {
        genes: ['TP53', 'NOSUCH'],
        organism: 'hsapiens',
        sources: ['GO:BP', 'REAC'],
        background_genes: ['TP53', 'EGFR', 'BRCA1'],
        correction_method: 'fdr'
      }
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      tool: 'enrich_gene_set',
      n_input: 2,
      n_mapped: 1,
      n_unmapped: 1,
      unmapped_genes: ['NOSUCH'],
      background_size: 3,
      domain_scope: 'custom',
      correction_method: 'fdr',
      n_results: 1
    })
  })

  it.each([
    [{ background_genes: ['EGFR'], domain_scope: 'annotated' }, /requires a custom domain_scope/],
    [{ domain_scope: 'custom' }, /requires background_genes/],
    [{ domain_scope: 'custom_known', background_genes: ['EGFR'] }, /domain_scope must be one of/],
    [{ correction_method: 'invalid' }, /correction_method must be one of/]
  ])('rejects invalid background or correction settings (%s)', async (extra, error) => {
    await expect(
      enrichTool.run!(
        context(
          async () => ({}),
          async () => ({})
        ),
        {
          genes: ['TP53'],
          organism: 'hsapiens',
          ...extra
        }
      )
    ).rejects.toThrow(error)
  })

  it('preserves duplicate input identifiers reported by g:Profiler', async () => {
    const postJson = vi.fn(async (_url: string, body: unknown) => {
      expect(body).toMatchObject({ query: ['TP53', 'TP53'] })
      return {
        result: [],
        meta: {
          genes_metadata: {
            failed: [],
            ambiguous: {},
            duplicates: ['TP53'],
            query: {
              query_1: { mapping: { TP53: ['ENSG00000141510'] }, ensgs: ['ENSG00000141510'] }
            }
          }
        }
      }
    })
    const out = (await enrichTool.run!(
      context(async () => ({}), postJson),
      { genes: ['TP53', 'TP53'], organism: 'hsapiens' }
    )) as Record<string, unknown>
    expect(out).toMatchObject({ n_input: 2, n_mapped: 1, duplicate_genes: ['TP53'] })
    expect(postJson).toHaveBeenCalledTimes(1)
  })
})
