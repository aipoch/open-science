import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../types'
import { GENES_ENRICHR_TOOLS } from './genes-enrichr'

const listTool = GENES_ENRICHR_TOOLS.find((tool) => tool.id === 'list_enrichr_libraries')!
const enrichTool = GENES_ENRICHR_TOOLS.find((tool) => tool.id === 'enrich_gene_set_enrichr')!

const context = (
  fetchJson: ToolContext['fetchJson'],
  postForm: ToolContext['postForm'],
  fetchText: ToolContext['fetchText'] = async () => {
    throw new Error('unused fetchText')
  },
  postUrlEncodedText: ToolContext['postUrlEncodedText'] = async () => {
    throw new Error('unused postUrlEncodedText')
  }
): ToolContext => ({
  credentials: {},
  fetchJson,
  fetchText,
  fetchJsonWithHeaders: async () => {
    throw new Error('unused fetchJsonWithHeaders')
  },
  postJson: async () => {
    throw new Error('unused postJson')
  },
  postForm,
  postUrlEncodedText
})

describe('genes / list_enrichr_libraries', () => {
  it('normalizes Enrichr library statistics', async () => {
    const fetchJson = vi.fn(async () => ({
      statistics: [
        {
          libraryName: 'ChEA_2022',
          geneCoverage: 18_000,
          genesPerTerm: 120,
          numTerms: 500,
          link: 'https://example.test/chea',
          categoryId: 1,
          appyter: 'abc123'
        }
      ]
    }))
    const out = await listTool.run!(
      context(fetchJson, async () => ({})),
      { organism: 'human' }
    )

    expect(out).toEqual({
      organism: 'human',
      n_libraries: 1,
      libraries: [
        {
          name: 'ChEA_2022',
          gene_coverage: 18_000,
          genes_per_term: 120,
          num_terms: 500,
          link: 'https://example.test/chea',
          category_id: 1,
          appyter: 'abc123'
        }
      ]
    })
    expect(fetchJson).toHaveBeenCalledWith('https://maayanlab.cloud/Enrichr/datasetStatistics')
  })

  it('rejects library statistics without a usable library name', async () => {
    const fetchJson = vi.fn(async () => ({ statistics: [{ libraryName: '' }] }))

    await expect(
      listTool.run!(
        context(fetchJson, async () => ({})),
        { organism: 'human' }
      )
    ).rejects.toThrow('invalid libraryName')
  })

  it('rejects library statistics with invalid numeric metadata', async () => {
    const fetchJson = vi.fn(async () => ({
      statistics: [{ libraryName: 'ChEA_2022', geneCoverage: '18000' }]
    }))

    await expect(
      listTool.run!(
        context(fetchJson, async () => ({})),
        { organism: 'human' }
      )
    ).rejects.toThrow('invalid geneCoverage')
  })
})

describe('genes / enrich_gene_set_enrichr', () => {
  it('uploads a gene list and normalizes selected library results', async () => {
    const postForm = vi.fn(async (url: string, body: FormData) => {
      expect(url).toBe('https://maayanlab.cloud/Enrichr/addList')
      expect(body.get('list')).toBe('TP53\nEGFR')
      expect(body.get('description')).toBe('Open-Science gene-set enrichment')
      return { userListId: 42, shortId: 'short-id' }
    })
    const fetchText = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://maayanlab.cloud/Enrichr/enrich?userListId=42&backgroundType=ChEA_2022'
      )
      return JSON.stringify({
        ChEA_2022: [[1, 'TP53 targets', 0.001, 2.5, 17.2, ['TP53'], 0.01, 0.002, 0.02]]
      })
    })
    const out = (await enrichTool.run!(
      context(async () => ({}), postForm, fetchText),
      {
        genes: ['TP53', 'TP53', 'EGFR'],
        libraries: ['ChEA_2022']
      }
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      tool: 'enrich_gene_set_enrichr',
      organism: 'human',
      n_input: 3,
      n_unique_input: 2,
      duplicate_genes: ['TP53'],
      user_list_id: 42,
      short_id: 'short-id',
      background_id: null,
      libraries: [
        {
          name: 'ChEA_2022',
          n_results: 1,
          results: [
            {
              rank: 1,
              term: 'TP53 targets',
              p_value: 0.001,
              odds_ratio: 2.5,
              combined_score: 17.2,
              overlapping_genes: ['TP53'],
              adjusted_p_value: 0.01
            }
          ]
        }
      ]
    })
    expect(postForm).toHaveBeenCalledTimes(1)
  })

  it('fails when the response does not contain the requested library', async () => {
    const postForm = vi.fn(async () => ({ userListId: 42, shortId: 'short-id' }))
    const fetchText = vi.fn(async () => JSON.stringify({ OtherLibrary: [] }))

    await expect(
      enrichTool.run!(
        context(async () => ({}), postForm, fetchText),
        { genes: ['TP53'], libraries: ['ChEA_2022'] }
      )
    ).rejects.toThrow('enrichment for library "ChEA_2022" failed')
  })

  it('preserves a non-finite odds ratio emitted by Enrichr', async () => {
    const postForm = vi.fn(async () => ({ userListId: 42, shortId: 'short-id' }))
    const fetchText = vi.fn(
      async () => '{"ChEA_2022":[[1,"complete overlap",0.001,Infinity,2,["TP53"],0.01]]}'
    )

    const out = (await enrichTool.run!(
      context(async () => ({}), postForm, fetchText),
      { genes: ['TP53'], libraries: ['ChEA_2022'] }
    )) as { libraries: Array<{ results: Array<{ odds_ratio: unknown }> }> }

    expect(out.libraries[0].results[0].odds_ratio).toBe('Infinity')
  })

  it('rejects control characters before submitting a gene list', async () => {
    const postForm = vi.fn(async () => ({ userListId: 42, shortId: 'short-id' }))

    await expect(
      enrichTool.run!(
        context(async () => ({}), postForm),
        { genes: ['TP53\nEGFR'], libraries: ['ChEA_2022'] }
      )
    ).rejects.toThrow('genes must contain only non-empty strings')
    expect(postForm).not.toHaveBeenCalled()
  })

  it('preserves cancellation errors during an upload', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancelled')
    controller.abort(cancellation)
    const postForm = vi.fn(async () => {
      throw new Error('upload should not run')
    })
    const ctx = { ...context(async () => ({}), postForm), signal: controller.signal }

    await expect(enrichTool.run!(ctx, { genes: ['TP53'], libraries: ['ChEA_2022'] })).rejects.toBe(
      cancellation
    )
  })

  it('uses Speedrichr for a human background and preserves its upload id', async () => {
    const calls: string[] = []
    const postForm = vi.fn(async (url: string, body: FormData) => {
      calls.push(url)
      if (url.endsWith('/addList')) {
        expect(body.get('list')).toBe('TP53\nEGFR')
        return { userListId: 7, shortId: 'bg-short' }
      }
      return {
        LINCS_L1000_Chem_Pert_up: [[1, 'Drug signature', 0.02, -1.2, 4.3, ['TP53'], 0.04]]
      }
    })
    const postUrlEncodedText = vi.fn(async (url: string, body: URLSearchParams) => {
      calls.push(url)
      if (url.endsWith('/addbackground')) {
        expect(body.get('background')).toBe('TP53\nEGFR\nBRCA1')
        return JSON.stringify({ backgroundid: 9 })
      }
      expect(url).toBe('https://maayanlab.cloud/speedrichr/api/backgroundenrich')
      expect(body.get('userListId')).toBe('7')
      expect(body.get('backgroundid')).toBe('9')
      expect(body.get('backgroundType')).toBe('LINCS_L1000_Chem_Pert_up')
      return JSON.stringify({
        LINCS_L1000_Chem_Pert_up: [[1, 'Drug signature', 0.02, -1.2, 4.3, ['TP53'], 0.04]]
      })
    })
    const out = (await enrichTool.run!(
      context(async () => ({}), postForm, undefined, postUrlEncodedText),
      {
        genes: ['TP53', 'EGFR'],
        libraries: ['LINCS_L1000_Chem_Pert_up'],
        background_genes: ['TP53', 'EGFR', 'BRCA1']
      }
    )) as Record<string, unknown>

    expect(calls).toEqual([
      'https://maayanlab.cloud/speedrichr/api/addList',
      'https://maayanlab.cloud/speedrichr/api/addbackground',
      'https://maayanlab.cloud/speedrichr/api/backgroundenrich'
    ])
    expect(out).toMatchObject({ background_size: 3, background_id: 9, user_list_id: 7 })
  })

  it('rejects custom backgrounds for non-human libraries', async () => {
    await expect(
      enrichTool.run!(
        context(
          async () => ({}),
          async () => ({})
        ),
        {
          genes: ['TP53'],
          libraries: ['GO_Biological_Process_2023'],
          organism: 'fly',
          background_genes: ['TP53']
        }
      )
    ).rejects.toThrow('supported only for the human Enrichr libraries')
  })
})
