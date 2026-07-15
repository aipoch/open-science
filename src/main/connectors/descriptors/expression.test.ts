import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { EXPRESSION_TOOLS } from './expression'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => EXPRESSION_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// Wraps a list of rows in the standard GTEx paged envelope.
const paged = (data: unknown[], total = data.length, numberOfPages = 1, page = 0): unknown => ({
  data,
  paging_info: { numberOfPages, page, maxItemsPerPage: 1000, totalNumberOfItems: total }
})

// Single-response call helper: returns the parsed output plus the first request URL.
const call = (
  id: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ out: unknown; url: string }> => {
  const fetchImpl = vi.fn().mockResolvedValue(jsonRes(body))
  return new ParserEngine({ fetchImpl })
    .call(tool(id), args, {})
    .then((out) => ({ out, url: fetchImpl.mock.calls[0][0] as string }))
}

// Multi-response call helper: hands each queued body to successive fetches and returns every URL.
const callSeq = (
  id: string,
  args: Record<string, unknown>,
  bodies: unknown[]
): Promise<{ out: unknown; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const b of bodies) fetchImpl.mockResolvedValueOnce(jsonRes(b))
  return new ParserEngine({ fetchImpl })
    .call(tool(id), args, {})
    .then((out) => ({ out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }))
}

describe('expression / gtex_tissue_sites', () => {
  it('builds the tissueSiteDetail URL and maps tissues + verified total', async () => {
    const { out, url } = await call(
      'gtex_tissue_sites',
      { dataset_id: 'gtex_v8' },
      paged(
        [
          {
            tissueSiteDetailId: 'Adipose_Subcutaneous',
            tissueSiteDetail: 'Adipose - Subcutaneous',
            tissueSite: 'Adipose Tissue',
            tissueSiteDetailAbbr: 'ADPSBQ',
            colorHex: 'FF6600',
            colorRgb: '255,102,0',
            eGeneCount: 15607,
            sGeneCount: 5113,
            expressedGeneCount: 28830,
            rnaSeqSampleSummary: { totalCount: 663 },
            eqtlSampleSummary: { totalCount: 581 },
            ontologyId: 'UBERON:0002190'
          }
        ],
        54
      )
    )
    expect(url).toBe(
      'https://gtexportal.org/api/v2/dataset/tissueSiteDetail?datasetId=gtex_v8&itemsPerPage=1000'
    )
    expect(out).toEqual({
      total: 54,
      tissues: [
        {
          tissue_site_detail_id: 'Adipose_Subcutaneous',
          tissue_site_detail: 'Adipose - Subcutaneous',
          tissue_site: 'Adipose Tissue',
          abbreviation: 'ADPSBQ',
          color_hex: 'FF6600',
          color_rgb: '255,102,0',
          egene_count: 15607,
          sgene_count: 5113,
          expressed_gene_count: 28830,
          rnaseq_sample_count: 663,
          eqtl_sample_count: 581,
          ontology_id: 'UBERON:0002190'
        }
      ]
    })
  })
})

describe('expression / gtex_dataset_info', () => {
  it('parses the bare-array metadata/dataset response', async () => {
    const { out, url } = await call('gtex_dataset_info', {}, [
      {
        datasetId: 'gtex_v8',
        displayName: 'GTEx Analysis v8',
        gencodeVersion: 'v26',
        genomeBuild: 'GRCh38/hg38',
        dbSnpBuild: 151,
        organization: 'GTEx Consortium',
        rnaSeqSampleCount: 17382,
        rnaSeqAndGenotypeSampleCount: 15201,
        subjectCount: 948,
        eqtlSubjectCount: 838,
        eqtlTissuesCount: 49,
        tissueCount: 54,
        description: 'Current GTEx Release.'
      }
    ])
    expect(url).toBe('https://gtexportal.org/api/v2/metadata/dataset')
    expect(out).toEqual([
      {
        dataset_id: 'gtex_v8',
        display_name: 'GTEx Analysis v8',
        gencode_version: 'v26',
        genome_build: 'GRCh38/hg38',
        dbsnp_build: 151,
        organization: 'GTEx Consortium',
        rnaseq_sample_count: 17382,
        rnaseq_and_genotype_sample_count: 15201,
        subject_count: 948,
        eqtl_subject_count: 838,
        eqtl_tissue_count: 49,
        tissue_count: 54,
        description: 'Current GTEx Release.'
      }
    ])
  })
})

describe('expression / gtex_resolve_genes', () => {
  it('sends repeated geneId params with the release GENCODE version and maps records', async () => {
    const { out, url } = await call(
      'gtex_resolve_genes',
      { genes: ['GAPDH', 'BRCA2'] },
      paged(
        [
          {
            geneSymbol: 'GAPDH',
            gencodeId: 'ENSG00000111640.14',
            gencodeVersion: 'v26',
            genomeBuild: 'GRCh38/hg38',
            chromosome: 'chr12',
            start: 6533927,
            end: 6538374,
            strand: '+',
            entrezGeneId: 2597,
            geneType: 'protein coding',
            description: 'glyceraldehyde-3-phosphate dehydrogenase'
          }
        ],
        1
      )
    )
    expect(url).toBe(
      'https://gtexportal.org/api/v2/reference/gene?itemsPerPage=1000&geneId=GAPDH&geneId=BRCA2&gencodeVersion=v26'
    )
    expect(out).toEqual({
      total: 1,
      genes: [
        {
          gene_symbol: 'GAPDH',
          gencode_id: 'ENSG00000111640.14',
          ensembl_id: 'ENSG00000111640',
          gencode_version: 'v26',
          genome_build: 'GRCh38/hg38',
          chromosome: 'chr12',
          start: 6533927,
          end: 6538374,
          strand: '+',
          entrez_gene_id: 2597,
          gene_type: 'protein coding',
          description: 'glyceraldehyde-3-phosphate dehydrogenase'
        }
      ]
    })
  })
})

describe('expression / gtex_median_expression', () => {
  it('walks all pages and count-verifies (gene, tissue) rows', async () => {
    const page0 = paged(
      [
        {
          gencodeId: 'ENSG00000111640.14',
          geneSymbol: 'GAPDH',
          tissueSiteDetailId: 'Liver',
          median: 512.029,
          unit: 'TPM'
        }
      ],
      2,
      2,
      0
    )
    const page1 = paged(
      [
        {
          gencodeId: 'ENSG00000111640.14',
          geneSymbol: 'GAPDH',
          tissueSiteDetailId: 'Whole_Blood',
          median: 1773.91,
          unit: 'TPM'
        }
      ],
      2,
      2,
      1
    )
    const { out, urls } = await callSeq(
      'gtex_median_expression',
      { gencode_ids: ['ENSG00000111640.14'], tissue_site_detail_ids: ['Liver', 'Whole_Blood'] },
      [page0, page1]
    )
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/expression/medianGeneExpression?datasetId=gtex_v8&gencodeId=ENSG00000111640.14&tissueSiteDetailId=Liver&tissueSiteDetailId=Whole_Blood&page=0&itemsPerPage=1000'
    )
    expect(urls[1]).toContain('page=1')
    expect(out).toEqual({
      total: 2,
      returned: 2,
      rows: [
        {
          gencode_id: 'ENSG00000111640.14',
          gene_symbol: 'GAPDH',
          tissue_site_detail_id: 'Liver',
          median_tpm: 512.029,
          unit: 'TPM'
        },
        {
          gencode_id: 'ENSG00000111640.14',
          gene_symbol: 'GAPDH',
          tissue_site_detail_id: 'Whole_Blood',
          median_tpm: 1773.91,
          unit: 'TPM'
        }
      ]
    })
  })
})

describe('expression / gtex_expression_summary', () => {
  it('auto-resolves the symbol, then ranks tissues by descending median TPM', async () => {
    const ref = paged(
      [
        {
          geneSymbol: 'GAPDH',
          gencodeId: 'ENSG00000111640.14',
          gencodeVersion: 'v26',
          genomeBuild: 'GRCh38/hg38'
        }
      ],
      1
    )
    const medians = paged([
      { tissueSiteDetailId: 'Liver', median: 512.029, unit: 'TPM' },
      { tissueSiteDetailId: 'Whole_Blood', median: 1773.91, unit: 'TPM' }
    ])
    const { out, urls } = await callSeq('gtex_expression_summary', { gene: 'GAPDH' }, [
      ref,
      medians
    ])
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/reference/gene?geneId=GAPDH&gencodeVersion=v26'
    )
    expect(urls[1]).toContain(
      'expression/medianGeneExpression?datasetId=gtex_v8&gencodeId=ENSG00000111640.14'
    )
    const res = out as { gene: { gencode_id: string }; total_tissues: number; tissues: unknown[] }
    expect(res.gene.gencode_id).toBe('ENSG00000111640.14')
    expect(res.total_tissues).toBe(2)
    // Whole_Blood (1773.91) must rank above Liver (512.029).
    expect(res.tissues).toEqual([
      { tissue_site_detail_id: 'Whole_Blood', median_tpm: 1773.91, unit: 'TPM' },
      { tissue_site_detail_id: 'Liver', median_tpm: 512.029, unit: 'TPM' }
    ])
  })

  it('throws when the gene is not in the GTEx reference', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(paged([], 0)))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('gtex_expression_summary'), { gene: 'NOPE' }, {})
    ).rejects.toThrow(/not found/)
  })
})

describe('expression / gtex_gene_expression', () => {
  it('builds the geneExpression URL and returns per-tissue TPM arrays with n_samples', async () => {
    const { out, url } = await call(
      'gtex_gene_expression',
      { gencode_id: 'ENSG00000111640.14', tissue_site_detail_ids: ['Whole_Blood'] },
      paged([
        {
          data: [1774.0, 1647.0, 3016.0],
          tissueSiteDetailId: 'Whole_Blood',
          gencodeId: 'ENSG00000111640.14',
          geneSymbol: 'GAPDH',
          unit: 'TPM'
        }
      ])
    )
    expect(url).toBe(
      'https://gtexportal.org/api/v2/expression/geneExpression?datasetId=gtex_v8&gencodeId=ENSG00000111640.14&tissueSiteDetailId=Whole_Blood&itemsPerPage=1000'
    )
    expect(out).toEqual([
      {
        tissue_site_detail_id: 'Whole_Blood',
        gencode_id: 'ENSG00000111640.14',
        gene_symbol: 'GAPDH',
        unit: 'TPM',
        n_samples: 3,
        expression: [1774.0, 1647.0, 3016.0]
      }
    ])
  })
})

describe('expression / gtex_top_expressed_genes', () => {
  it('caps at n across pages and reports the full ranking size', async () => {
    const page0 = paged(
      [
        { gencodeId: 'ENSG00000244734.3', geneSymbol: 'HBB', median: 267405.0, unit: 'TPM' },
        { gencodeId: 'ENSG00000206172.8', geneSymbol: 'HBA1', median: 100000.0, unit: 'TPM' }
      ],
      56163,
      28082,
      0
    )
    const { out, urls } = await callSeq(
      'gtex_top_expressed_genes',
      { tissue_site_detail_id: 'Whole_Blood', n: 2 },
      [page0]
    )
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/expression/topExpressedGene?datasetId=gtex_v8&tissueSiteDetailId=Whole_Blood&filterMtGene=true&page=0&itemsPerPage=1000'
    )
    // n=2 satisfied by the first page → no second request.
    expect(urls).toHaveLength(1)
    expect(out).toEqual({
      tissue_site_detail_id: 'Whole_Blood',
      total_genes_in_ranking: 56163,
      returned: 2,
      genes: [
        { gencode_id: 'ENSG00000244734.3', gene_symbol: 'HBB', median_tpm: 267405.0, unit: 'TPM' },
        { gencode_id: 'ENSG00000206172.8', gene_symbol: 'HBA1', median_tpm: 100000.0, unit: 'TPM' }
      ]
    })
  })

  it('honors filter_mt_gene=false', async () => {
    const { urls } = await callSeq(
      'gtex_top_expressed_genes',
      { tissue_site_detail_id: 'Liver', n: 1, filter_mt_gene: false },
      [paged([{ gencodeId: 'x', geneSymbol: 'MT-CO1', median: 1, unit: 'TPM' }], 100)]
    )
    expect(urls[0]).toContain('filterMtGene=false')
  })
})

describe('expression / gtex_eqtl_genes', () => {
  it('walks pages, count-verifies the eGene total, and truncates at max_genes', async () => {
    const page0 = paged(
      [
        {
          gencodeId: 'ENSG00000227232.5',
          geneSymbol: 'WASH7P',
          empiricalPValue: 0.000432357,
          pValue: 5.78285e-7,
          pValueThreshold: 0.000212424,
          qValue: 0.000656924,
          log2AllelicFoldChange: 0.77278
        }
      ],
      9660,
      9660,
      0
    )
    const { out, urls } = await callSeq(
      'gtex_eqtl_genes',
      { tissue_site_detail_id: 'Pancreas', max_genes: 1 },
      [page0]
    )
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/association/egene?datasetId=gtex_v8&tissueSiteDetailId=Pancreas&page=0&itemsPerPage=1000'
    )
    expect(out).toEqual({
      total: 9660,
      returned: 1,
      truncated: true,
      genes: [
        {
          gencode_id: 'ENSG00000227232.5',
          gene_symbol: 'WASH7P',
          empirical_p_value: 0.000432357,
          p_value: 5.78285e-7,
          p_value_threshold: 0.000212424,
          q_value: 0.000656924,
          log2_allelic_fold_change: 0.77278
        }
      ]
    })
  })
})

describe('expression / gtex_single_tissue_eqtls', () => {
  it('requires gencode_id and/or variant_id', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('gtex_single_tissue_eqtls'), {}, {})
    ).rejects.toThrow(/gencode_id and\/or variant_id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('builds the URL from gencode_id and maps significant associations', async () => {
    const { out, urls } = await callSeq(
      'gtex_single_tissue_eqtls',
      { gencode_id: 'ENSG00000111640.14' },
      [
        paged([
          {
            gencodeId: 'ENSG00000111640.14',
            geneSymbol: 'GAPDH',
            variantId: 'chr12_6452899_G_A_b38',
            snpId: 'rs2286721',
            chromosome: 'chr12',
            pos: 6452899,
            tissueSiteDetailId: 'Heart_Left_Ventricle',
            pValue: 3.88343e-5,
            nes: -0.162677
          }
        ])
      ]
    )
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/association/singleTissueEqtl?datasetId=gtex_v8&gencodeId=ENSG00000111640.14&page=0&itemsPerPage=1000'
    )
    expect(out).toEqual({
      total: 1,
      returned: 1,
      truncated: false,
      eqtls: [
        {
          gencode_id: 'ENSG00000111640.14',
          gene_symbol: 'GAPDH',
          variant_id: 'chr12_6452899_G_A_b38',
          snp_id: 'rs2286721',
          chromosome: 'chr12',
          pos: 6452899,
          tissue_site_detail_id: 'Heart_Left_Ventricle',
          p_value: 3.88343e-5,
          nes: -0.162677
        }
      ]
    })
  })
})

describe('expression / gtex_multi_tissue_eqtls', () => {
  it('maps METASOFT rows and renames per-tissue metric blocks', async () => {
    const { out, urls } = await callSeq(
      'gtex_multi_tissue_eqtls',
      { gencode_id: 'ENSG00000111640.14' },
      [
        paged([
          {
            gencodeId: 'ENSG00000111640.14',
            variantId: 'chr12_6496645_G_A_b38',
            metaP: 4.13541e-47,
            tissues: { Thyroid: { mValue: 1.0, pValue: 1.2817e-8, se: 0.0267655, nes: -0.154811 } }
          }
        ])
      ]
    )
    expect(urls[0]).toBe(
      'https://gtexportal.org/api/v2/association/metasoft?datasetId=gtex_v8&gencodeId=ENSG00000111640.14&page=0&itemsPerPage=1000'
    )
    expect(out).toEqual({
      total: 1,
      returned: 1,
      variants: [
        {
          gencode_id: 'ENSG00000111640.14',
          variant_id: 'chr12_6496645_G_A_b38',
          meta_p: 4.13541e-47,
          tissues: {
            Thyroid: { m_value: 1.0, nes: -0.154811, p_value: 1.2817e-8, se: 0.0267655 }
          }
        }
      ]
    })
  })
})

describe('expression / gtex_calculate_eqtl', () => {
  it('builds the dyneqtl URL and sorts samples by (genotype, expression)', async () => {
    const { out, url } = await call(
      'gtex_calculate_eqtl',
      {
        gencode_id: 'ENSG00000111640.14',
        variant_id: 'chr12_6452899_G_A_b38',
        tissue_site_detail_id: 'Whole_Blood'
      },
      {
        gencodeId: 'ENSG00000111640.14',
        geneSymbol: 'GAPDH',
        variantId: 'chr12_6452899_G_A_b38',
        tissueSiteDetailId: 'Whole_Blood',
        pValue: 0.5128,
        nes: -0.0122,
        tStatistic: -0.6548,
        maf: 0.1642,
        homoRefCount: 470,
        hetCount: 180,
        homoAltCount: 20,
        // Deliberately unsorted upstream order.
        genotypes: [1, 0, 1, 0],
        data: [5.0, 9.0, 2.0, 3.0]
      }
    )
    expect(url).toBe(
      'https://gtexportal.org/api/v2/association/dyneqtl?datasetId=gtex_v8&gencodeId=ENSG00000111640.14&variantId=chr12_6452899_G_A_b38&tissueSiteDetailId=Whole_Blood'
    )
    expect(out).toEqual({
      gencode_id: 'ENSG00000111640.14',
      gene_symbol: 'GAPDH',
      variant_id: 'chr12_6452899_G_A_b38',
      tissue_site_detail_id: 'Whole_Blood',
      p_value: 0.5128,
      nes: -0.0122,
      t_statistic: -0.6548,
      maf: 0.1642,
      hom_ref_count: 470,
      het_count: 180,
      hom_alt_count: 20,
      n_samples: 4,
      samples: [
        { genotype: 0, expression: 3.0 },
        { genotype: 0, expression: 9.0 },
        { genotype: 1, expression: 2.0 },
        { genotype: 1, expression: 5.0 }
      ]
    })
  })
})

describe('expression / gtex_sample_info', () => {
  it('builds a filtered /dataset/sample URL and caps at max_samples with truncation', async () => {
    const row = {
      sampleId: 'GTEX-1192X-0526-SM-5H12P',
      subjectId: 'GTEX-1192X',
      tissueSiteDetailId: 'Liver',
      tissueSiteDetail: 'Liver',
      dataType: 'RNASEQ',
      sex: 'male',
      ageBracket: '60-69',
      hardyScale: 0,
      ischemicTime: 889,
      rin: 7.2,
      autolysisScore: 1,
      pathologyNotes: 'cirrhosis',
      uberonId: 'UBERON:0002107'
    }
    const { out, url } = await call(
      'gtex_sample_info',
      {
        tissue_site_detail_id: 'Liver',
        data_type: 'RNASEQ',
        max_samples: 1,
        dataset_id: 'gtex_v8'
      },
      paged([row, { ...row, sampleId: 'GTEX-OTHER' }], 251)
    )
    expect(url).toContain('/dataset/sample?datasetId=gtex_v8')
    expect(url).toContain('tissueSiteDetailId=Liver')
    expect(url).toContain('dataType=RNASEQ')
    expect(out).toMatchObject({
      total: 251,
      returned: 1,
      truncated: true,
      samples: [
        {
          sample_id: 'GTEX-1192X-0526-SM-5H12P',
          subject_id: 'GTEX-1192X',
          tissue_site_detail_id: 'Liver',
          data_type: 'RNASEQ',
          hardy_scale: 0,
          rin: 7.2
        }
      ]
    })
  })
})

describe('expression / dataset pinning (dataset_id honoured)', () => {
  it('gtex_resolve_genes maps dataset_id gtex_v10 to gencodeVersion v39', async () => {
    const { url } = await call(
      'gtex_resolve_genes',
      { genes: ['GAPDH'], dataset_id: 'gtex_v10' },
      paged([])
    )
    expect(url).toContain('gencodeVersion=v39')
  })
  it('gtex_median_expression passes dataset_id through to the query', async () => {
    const { urls } = await callSeq(
      'gtex_median_expression',
      { gencode_ids: ['ENSG00000111640.14'], dataset_id: 'gtex_v10' },
      [paged([])]
    )
    expect(urls[0]).toContain('datasetId=gtex_v10')
  })
})

describe('expression / gtex_expression_summary exact match', () => {
  it('selects the exact gene symbol among multiple reference hits', async () => {
    const { out } = await callSeq('gtex_expression_summary', { gene: 'GAPDH' }, [
      paged([
        { geneSymbol: 'GAPDHS', gencodeId: 'ENSG00000105679.12', gencodeVersion: 'v26' },
        { geneSymbol: 'GAPDH', gencodeId: 'ENSG00000111640.14', gencodeVersion: 'v26' }
      ]),
      paged([{ tissueSiteDetailId: 'Liver', median: 500, unit: 'TPM' }])
    ])
    expect(out).toMatchObject({
      gene: { gene_symbol: 'GAPDH', gencode_id: 'ENSG00000111640.14' },
      total_tissues: 1
    })
  })
})

describe('expression / count verification', () => {
  it('raises when an uncapped walk under-delivers vs the API total', async () => {
    await expect(
      callSeq('gtex_median_expression', { gencode_ids: ['ENSG00000111640.14'] }, [
        paged([{ tissueSiteDetailId: 'Liver', median: 1, unit: 'TPM' }], 5, 1)
      ])
    ).rejects.toThrow(/count mismatch/)
  })
})
