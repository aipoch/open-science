import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CELLGUIDE_TOOLS } from './cellguide'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CELLGUIDE_TOOLS.find((t) => t.id === id)!

const SNAPSHOT = '1763135102'
const ACINAR_METADATA = {
  'CL:0000622': {
    name: 'acinar cell',
    id: 'CL:0000622',
    clDescription: 'A secretory cell that ... releases zymogen granules.',
    synonyms: ['acinic cell', 'acinous cell']
  }
}
// Live shape confirmed against the CDN (2026-07-12): {tissue, symbol, name, publication,
// publication_titles} — no marker_score/groupby_dims (those only exist on
// computational_marker_genes; client.py's shared formatter assumes them incorrectly).
const CANONICAL_MARKERS = [
  {
    tissue: 'pancreas',
    symbol: 'PRSS1',
    name: 'trypsinogen',
    publication: '',
    publication_titles: ''
  },
  {
    tissue: 'pancreas',
    symbol: 'CPA1',
    name: 'carboxypeptidase A1',
    publication: 'PMID:12345',
    publication_titles: 'Some paper title'
  }
]

// Maps a URL substring to a canned response; throws for anything unexpected so tests can assert
// exactly which calls were made (e.g. "not found" must short-circuit before description/markers).
function mockFetch(
  responses: Record<string, { text?: string; json?: unknown; status?: number }>
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(responses).find((k) => url.includes(k))
    if (!key) throw new Error(`unexpected fetch: ${url}`)
    const r = responses[key]
    const status = r.status ?? 200
    return {
      ok: status < 400,
      status,
      // Mirror real fetch: .json() on an empty body throws (no 'json' provided means "parse the
      // text field"), matching the CDN's 200-with-empty-body response for uncurated cell types.
      json: async () => {
        if ('json' in r) return r.json
        if (!r.text) throw new SyntaxError('Unexpected end of JSON input')
        return JSON.parse(r.text)
      },
      text: async () => r.text ?? ''
    } as Response
  }) as unknown as typeof fetch
}

describe('cellguide / cellguide_cell_type', () => {
  it('fetches snapshot, metadata, description, and canonical markers for a CL id', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': {
        json: { description: 'Acinar cells secrete digestive enzymes.', references: ['PMID:123'] }
      },
      '/canonical_marker_genes/CL_0000622.json': { json: CANONICAL_MARKERS }
    })
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:0000622' },
      {}
    )
    expect(out).toEqual({
      id: 'CL:0000622',
      name: 'acinar cell',
      synonyms: ['acinic cell', 'acinous cell'],
      ontologyDescription: 'A secretory cell that ... releases zymogen granules.',
      description: 'Acinar cells secrete digestive enzymes.',
      descriptionSource: 'validated',
      references: ['PMID:123'],
      canonicalMarkerGenes: [
        {
          symbol: 'PRSS1',
          name: 'trypsinogen',
          tissue: 'pancreas',
          publication: undefined,
          publicationTitle: undefined
        },
        {
          symbol: 'CPA1',
          name: 'carboxypeptidase A1',
          tissue: 'pancreas',
          publication: 'PMID:12345',
          publicationTitle: 'Some paper title'
        }
      ]
    })
  })

  it('builds the CDN urls with snapshot id and URL-format (underscore) cell id', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': { json: { description: 'x', references: [] } },
      '/canonical_marker_genes/CL_0000622.json': { json: [] }
    })
    await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:0000622' },
      {}
    )
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls[0]).toBe('https://cellguide.cellxgene.cziscience.com/latest_snapshot_identifier')
    expect(calls[1]).toBe(
      `https://cellguide.cellxgene.cziscience.com/${SNAPSHOT}/celltype_metadata.json`
    )
    expect(calls[2]).toBe(
      'https://cellguide.cellxgene.cziscience.com/validated_descriptions/CL_0000622.json'
    )
    expect(calls[3]).toBe(
      `https://cellguide.cellxgene.cziscience.com/${SNAPSHOT}/canonical_marker_genes/CL_0000622.json`
    )
  })

  it('returns an error and skips further fetches when the cell type is not in metadata', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA }
    })
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:9999999' },
      {}
    )
    expect(out).toEqual({ error: "Cell type 'CL:9999999' not found" })
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('falls back to the GPT description when no validated description exists', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': { status: 404 },
      '/gpt_descriptions/CL_0000622.json': { json: 'A GPT-generated description.' },
      '/canonical_marker_genes/CL_0000622.json': { json: [] }
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:0000622' },
      {}
    )) as { description: string; descriptionSource: string; references: unknown[] }
    expect(out.description).toBe('A GPT-generated description.')
    expect(out.descriptionSource).toBe('gpt')
    expect(out.references).toEqual([])
  })

  it('returns an empty marker list when the canonical markers file is missing (404)', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': { json: { description: 'x', references: [] } },
      '/canonical_marker_genes/CL_0000622.json': { status: 404 }
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:0000622' },
      {}
    )) as { canonicalMarkerGenes: unknown[] }
    expect(out.canonicalMarkerGenes).toEqual([])
  })

  it('returns an empty marker list on a 200 with an empty body (live CDN behavior for cell types with no curated canonical markers)', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': { json: { description: 'x', references: [] } },
      // json: undefined -> JSON.stringify(undefined) is not valid JSON; simulate the real CDN's
      // empty-string body, whose .json() parse throws and is swallowed by tryFetchJson.
      '/canonical_marker_genes/CL_0000622.json': { text: '' }
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL:0000622' },
      {}
    )) as { canonicalMarkerGenes: unknown[] }
    expect(out.canonicalMarkerGenes).toEqual([])
  })

  it('normalizes CL_ and bare-digit id formats to CL: for lookup', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: ACINAR_METADATA },
      '/validated_descriptions/CL_0000622.json': { json: { description: 'x', references: [] } },
      '/canonical_marker_genes/CL_0000622.json': { json: [] }
    })
    const out1 = (await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: 'CL_0000622' },
      {}
    )) as { id: string }
    expect(out1.id).toBe('CL:0000622')

    const out2 = (await new ParserEngine({ fetchImpl }).call(
      tool('cellguide_cell_type'),
      { cellType: '0000622' },
      {}
    )) as { id: string }
    expect(out2.id).toBe('CL:0000622')
  })
})
