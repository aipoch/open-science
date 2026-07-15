import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { BIOMART_TOOLS } from './biomart'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => BIOMART_TOOLS.find((t) => t.id === id)!
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response
const call = (id: string, args: Record<string, unknown>, body: string): Promise<unknown> => {
  const fetchImpl = vi.fn().mockResolvedValue(textRes(body))
  const engine = new ParserEngine({ fetchImpl })
  return engine.call(tool(id), args, {}).then((out) => ({ out, url: fetchImpl.mock.calls[0][0] }))
}

const REGISTRY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MartRegistry>
  <MartURLLocation database="ensembl_mart_115" displayName="Ensembl Genes 115" name="ENSEMBL_MART_ENSEMBL" visible="1" />
  <MartURLLocation database="ensembl_mart_snp_115" displayName="Ensembl Variation 115" name="ENSEMBL_MART_SNP" visible="1" />
  <MartURLLocation database="hidden_mart" displayName="Hidden" name="HIDDEN" visible="0" />
</MartRegistry>`

describe('biomart / list_marts', () => {
  it('parses the registry XML into a name,display_name,description CSV, skipping hidden marts', async () => {
    const { out, url } = (await call('list_marts', {}, REGISTRY_XML)) as {
      out: string
      url: string
    }
    expect(url).toBe('https://www.ensembl.org/biomart/martservice?type=registry')
    expect(out).toBe(
      'name,display_name,description\n' +
        'ENSEMBL_MART_ENSEMBL,Ensembl Genes 115,Ensembl Genes 115\n' +
        'ENSEMBL_MART_SNP,Ensembl Variation 115,Ensembl Variation 115'
    )
  })
})

describe('biomart / list_datasets', () => {
  it('builds the datasets URL and parses TableSet rows into CSV (quoting commas)', async () => {
    const body =
      '\n' +
      'TableSet\thsapiens_gene_ensembl\tHuman genes (GRCh38.p14)\t1\tGRCh38.p14\t200\t50000\tdefault\t2026-04-30\n' +
      'TableSet\tmmusculus_gene_ensembl\tMouse genes, strain\t1\tGRCm39\t200\t50000\tdefault\t2026-04-30\n'
    const { out, url } = (await call('list_datasets', { mart: 'ENSEMBL_MART_ENSEMBL' }, body)) as {
      out: string
      url: string
    }
    expect(url).toBe(
      'https://www.ensembl.org/biomart/martservice?type=datasets&mart=ENSEMBL_MART_ENSEMBL'
    )
    expect(out).toBe(
      'name,display_name,description\n' +
        'hsapiens_gene_ensembl,Human genes (GRCh38.p14),GRCh38.p14\n' +
        'mmusculus_gene_ensembl,"Mouse genes, strain",GRCm39'
    )
  })
})

const ATTRIBUTES_TSV =
  'ensembl_gene_id\tGene stable ID\tStable ID of the Gene\tfeature_page\thtml\ttbl\tkey\n' +
  'cdna_coding_start\tcDNA coding start\t\tfeature_page\thtml\ttbl\tkey\n' +
  'ensembl_gene_id\tGene stable ID\t\tstructure\thtml\ttbl\tkey\n' +
  'mmusculus_homolog_ensembl_gene\tMouse gene stable ID\t\thomologs\thtml\ttbl\tkey\n' +
  'affy_hg_u133_plus_2\tAFFY HG U133 Plus 2 probe\t\tfeature_page\thtml\ttbl\tkey\n'

describe('biomart / list_common_attributes', () => {
  it('keeps only curated common attributes, deduped across pages', async () => {
    const { out, url } = (await call(
      'list_common_attributes',
      { mart: 'ENSEMBL_MART_ENSEMBL', dataset: 'hsapiens_gene_ensembl' },
      ATTRIBUTES_TSV
    )) as { out: string; url: string }
    expect(url).toBe(
      'https://www.ensembl.org/biomart/martservice?type=attributes&dataset=hsapiens_gene_ensembl'
    )
    expect(out).toBe(
      'name,display_name,description\nensembl_gene_id,Gene stable ID,Stable ID of the Gene'
    )
  })
})

describe('biomart / list_all_attributes', () => {
  it('drops homologs and microarray probes, dedupes, and keeps the rest', async () => {
    const { out } = (await call(
      'list_all_attributes',
      { mart: 'ENSEMBL_MART_ENSEMBL', dataset: 'hsapiens_gene_ensembl' },
      ATTRIBUTES_TSV
    )) as { out: string }
    expect(out).toBe(
      'name,display_name,description\n' +
        'ensembl_gene_id,Gene stable ID,Stable ID of the Gene\n' +
        'cdna_coding_start,cDNA coding start,'
    )
  })
})

describe('biomart / list_filters', () => {
  it('parses filters into a name,description CSV', async () => {
    const body =
      'chromosome_name\tChromosome/scaffold name\t[1,2,3]\t\tfilters\ttext\t=\ttbl\tkey\n' +
      'biotype\tGene type\t[protein_coding]\t\tfilters\ttext\t=\ttbl\tkey\n' +
      'chromosome_name\tChromosome/scaffold name\t[1,2,3]\t\tfilters\ttext\t=\ttbl2\tkey\n'
    const { out, url } = (await call(
      'list_filters',
      { mart: 'ENSEMBL_MART_ENSEMBL', dataset: 'hsapiens_gene_ensembl' },
      body
    )) as { out: string; url: string }
    expect(url).toBe(
      'https://www.ensembl.org/biomart/martservice?type=filters&dataset=hsapiens_gene_ensembl'
    )
    expect(out).toBe(
      'name,description\nchromosome_name,Chromosome/scaffold name\nbiotype,Gene type'
    )
  })
})

describe('biomart / get_data', () => {
  it('builds the query XML (attributes + filters) and returns a CSV with an attribute header', async () => {
    const { out, url } = (await call(
      'get_data',
      {
        mart: 'ENSEMBL_MART_ENSEMBL',
        dataset: 'hsapiens_gene_ensembl',
        attributes: ['ensembl_gene_id', 'external_gene_name'],
        filters: { chromosome_name: 'Y', biotype: true }
      },
      'ENSG00000292363\tCRLF2\nENSG00000292344\tPLCXD1\n[success]\n'
    )) as { out: string; url: string }
    expect(url.startsWith('https://www.ensembl.org/biomart/martservice?query=')).toBe(true)
    const xml = decodeURIComponent(url.split('query=')[1])
    expect(xml).toContain('<Dataset name="hsapiens_gene_ensembl" interface="default">')
    expect(xml).toContain('<Attribute name="ensembl_gene_id" />')
    expect(xml).toContain('<Attribute name="external_gene_name" />')
    expect(xml).toContain('<Filter name="chromosome_name" value="Y" />')
    expect(xml).toContain('<Filter name="biotype" value="only" />')
    expect(xml).toContain('completionStamp="1"')
    expect(out).toBe(
      'ensembl_gene_id,external_gene_name\nENSG00000292363,CRLF2\nENSG00000292344,PLCXD1'
    )
  })

  it('returns a header-only CSV when nothing matches', async () => {
    const { out } = (await call(
      'get_data',
      {
        mart: 'ENSEMBL_MART_ENSEMBL',
        dataset: 'hsapiens_gene_ensembl',
        attributes: ['ensembl_gene_id']
      },
      '[success]\n'
    )) as { out: string }
    expect(out).toBe('ensembl_gene_id')
  })

  it('throws on a rejected query (Query ERROR body)', async () => {
    await expect(
      call(
        'get_data',
        { mart: 'ENSEMBL_MART_ENSEMBL', dataset: 'hsapiens_gene_ensembl', attributes: ['bad'] },
        'Query ERROR: caught BioMart::Exception::Usage: bad attribute'
      )
    ).rejects.toThrow(/BioMart query rejected/)
  })

  it('throws on a truncated response missing the completion stamp', async () => {
    await expect(
      call(
        'get_data',
        {
          mart: 'ENSEMBL_MART_ENSEMBL',
          dataset: 'hsapiens_gene_ensembl',
          attributes: ['ensembl_gene_id']
        },
        'ENSG00000141510'
      )
    ).rejects.toThrow(/completion stamp/)
  })
})

describe('biomart / get_translation', () => {
  it('builds a two-attribute query filtered by the source id and returns the mapped value', async () => {
    const { out, url } = (await call(
      'get_translation',
      {
        mart: 'ENSEMBL_MART_ENSEMBL',
        dataset: 'hsapiens_gene_ensembl',
        from_attr: 'hgnc_symbol',
        to_attr: 'ensembl_gene_id',
        target: 'TP53'
      },
      'TP53\tENSG00000141510\n[success]\n'
    )) as { out: string; url: string }
    const xml = decodeURIComponent(url.split('query=')[1])
    expect(xml).toContain('<Filter name="hgnc_symbol" value="TP53" />')
    expect(xml).toContain('<Attribute name="hgnc_symbol" />')
    expect(xml).toContain('<Attribute name="ensembl_gene_id" />')
    expect(out).toBe('ENSG00000141510')
  })

  it('returns a not-found message when the source id has no mapping', async () => {
    const { out } = (await call(
      'get_translation',
      {
        mart: 'ENSEMBL_MART_ENSEMBL',
        dataset: 'hsapiens_gene_ensembl',
        from_attr: 'hgnc_symbol',
        to_attr: 'ensembl_gene_id',
        target: 'NOPE'
      },
      '[success]\n'
    )) as { out: string }
    expect(out).toBe("No translation found for 'NOPE' (hgnc_symbol -> ensembl_gene_id).")
  })
})

describe('biomart / batch_translate', () => {
  it('maps found ids and reports the not-found ones', async () => {
    const { out, url } = (await call(
      'batch_translate',
      {
        mart: 'ENSEMBL_MART_ENSEMBL',
        dataset: 'hsapiens_gene_ensembl',
        from_attr: 'hgnc_symbol',
        to_attr: 'ensembl_gene_id',
        targets: ['TP53', 'BRCA1', 'BRCA2']
      },
      'TP53\tENSG00000141510\nBRCA1\tENSG00000012048\n[success]\n'
    )) as { out: Record<string, unknown>; url: string }
    const xml = decodeURIComponent(url.split('query=')[1])
    expect(xml).toContain('<Filter name="hgnc_symbol" value="TP53,BRCA1,BRCA2" />')
    expect(out).toEqual({
      translations: { TP53: 'ENSG00000141510', BRCA1: 'ENSG00000012048' },
      not_found: ['BRCA2'],
      found_count: 2,
      not_found_count: 1
    })
  })
})
