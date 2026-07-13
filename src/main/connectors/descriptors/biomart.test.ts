import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { BIOMART_TOOLS } from './biomart'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => BIOMART_TOOLS.find((t) => t.id === id)!
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

const REGISTRY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MartRegistry>
  <MartURLLocation database="ensembl_mart_115" default="1" displayName="Ensembl Genes 115" host="www.ensembl.org" name="ENSEMBL_MART_ENSEMBL" path="/biomart/martservice" port="443" serverVirtualSchema="default" visible="1" />
  <MartURLLocation database="ensembl_mart_snp_115" default="0" displayName="Ensembl Variation 115" host="www.ensembl.org" name="ENSEMBL_MART_SNP" path="/biomart/martservice" port="443" serverVirtualSchema="default" visible="1" />
</MartRegistry>`

describe('biomart / list_marts', () => {
  it('parses the registry XML into name/displayName records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes(REGISTRY_XML))
    const out = await new ParserEngine({ fetchImpl }).call(tool('biomart_list_marts'), {}, {})
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ensembl.org/biomart/martservice?type=registry'
    )
    expect(out).toEqual([
      { name: 'ENSEMBL_MART_ENSEMBL', displayName: 'Ensembl Genes 115' },
      { name: 'ENSEMBL_MART_SNP', displayName: 'Ensembl Variation 115' }
    ])
  })

  it('returns an empty array when the registry has no marts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(textRes('<?xml version="1.0"?><MartRegistry></MartRegistry>'))
    const out = await new ParserEngine({ fetchImpl }).call(tool('biomart_list_marts'), {}, {})
    expect(out).toEqual([])
  })
})

describe('biomart / query', () => {
  it('builds a GET query URL and parses sorted TSV rows', async () => {
    const raw = 'ENSG00000141510\tTP53\nENSG00000012048\tBRCA1\n[success]\n'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(raw))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('biomart_query'),
      { dataset: 'hsapiens_gene_ensembl', attributes: ['ensembl_gene_id', 'external_gene_name'] },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url.startsWith('https://www.ensembl.org/biomart/martservice?query=')).toBe(true)
    const xml = decodeURIComponent(url.split('query=')[1])
    expect(xml).toContain('<Dataset name="hsapiens_gene_ensembl" interface="default">')
    expect(xml).toContain('<Attribute name="ensembl_gene_id" />')
    expect(xml).toContain('<Attribute name="external_gene_name" />')
    expect(xml).toContain('formatter="TSV"')
    expect(xml).toContain('completionStamp="1"')
    expect(out).toEqual({
      dataset: 'hsapiens_gene_ensembl',
      columns: ['ensembl_gene_id', 'external_gene_name'],
      rows: [
        ['ENSG00000012048', 'BRCA1'],
        ['ENSG00000141510', 'TP53']
      ]
    })
  })

  it('includes filters in the query XML', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('[success]\n'))
    await new ParserEngine({ fetchImpl }).call(
      tool('biomart_query'),
      {
        dataset: 'hsapiens_gene_ensembl',
        attributes: ['ensembl_gene_id'],
        filters: { chromosome_name: '17', biotype: true }
      },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    const xml = decodeURIComponent(url.split('query=')[1])
    expect(xml).toContain('<Filter name="chromosome_name" value="17" />')
    expect(xml).toContain('<Filter name="biotype" value="only" />')
  })

  it('throws on a rejected query (Query ERROR body)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(textRes('Query ERROR: caught BioMart::Exception::Usage: bad attribute'))
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('biomart_query'),
        { dataset: 'hsapiens_gene_ensembl', attributes: ['ensembl_gene_id'] },
        {}
      )
    ).rejects.toThrow(/BioMart query rejected/)
  })

  it('throws on a truncated response missing the completion stamp', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('ENSG00000141510'))
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('biomart_query'),
        { dataset: 'hsapiens_gene_ensembl', attributes: ['ensembl_gene_id'] },
        {}
      )
    ).rejects.toThrow(/completion stamp/)
  })
})
