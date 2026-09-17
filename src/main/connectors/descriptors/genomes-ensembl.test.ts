import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ParserEngine } from '../engine'
import { GENOMES_ENSEMBL_TOOLS } from './genomes-ensembl'

// Mock Response factories: 200 JSON, and a non-ok status the engine turns into `HTTP <n> for <url>`.
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const tool = (id: string): (typeof GENOMES_ENSEMBL_TOOLS)[number] => {
  const t = GENOMES_ENSEMBL_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retries: 0
  }).call(tool(id), args, {})

describe('ensembl_lookup', () => {
  it.each([undefined, 'auto'])(
    'keeps ID-first symbol fallback when query_type is %s',
    async (queryType) => {
      const record = { id: 'ENSMUSG00000059552', species: 'mus_musculus' }
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: "ID 'Trp53' not found" }, { status: 400 }))
        .mockResolvedValueOnce(Response.json(record))
      expect(
        await run(
          'ensembl_lookup',
          {
            query: 'Trp53',
            species: 'mus_musculus',
            query_type: queryType
          },
          fetchImpl
        )
      ).toEqual({ found: true, query: 'Trp53', species: 'mus_musculus', record })
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        'https://rest.ensembl.org/lookup/id/Trp53?expand=0',
        'https://rest.ensembl.org/lookup/symbol/mus_musculus/Trp53?expand=0'
      ])
    }
  )

  it.each(['Trp53', 'FBgn9999999'])(
    'does not reinterpret a missing explicit ID %s as a symbol',
    async (query) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: `ID '${query}' not found` }, { status: 400 }))
      expect(await run('ensembl_lookup', { query, query_type: 'id' }, fetchImpl)).toEqual({
        found: false,
        query,
        species: 'homo_sapiens',
        record: null
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(String(fetchImpl.mock.calls[0][0])).toBe(
        `https://rest.ensembl.org/lookup/id/${query}?expand=0`
      )
    }
  )

  it('normalizes versioned explicit IDs while preserving their actual species', async () => {
    const record = { id: 'ENSMUSG00000059552', species: 'mus_musculus' }
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(record))
    expect(
      await run(
        'ensembl_lookup',
        {
          query: 'ENSMUSG00000059552.1',
          query_type: 'id',
          species: 'homo_sapiens',
          expand: true
        },
        fetchImpl
      )
    ).toEqual({
      found: true,
      query: 'ENSMUSG00000059552.1',
      species: 'mus_musculus',
      record
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://rest.ensembl.org/lookup/id/ENSMUSG00000059552?expand=1'
    )
  })

  it.each(['Trp53', 'ENSMUSG00000059552.1'])(
    'routes explicit symbol %s directly without ID normalization or probing',
    async (query) => {
      const record = { id: 'ENSMUSG00000059552', species: 'mus_musculus' }
      const fetchImpl = vi.fn(async (input) => {
        if (String(input).includes('/lookup/id/')) throw new Error('ID endpoint unavailable')
        return Response.json(record)
      })
      expect(
        await run(
          'ensembl_lookup',
          {
            query,
            query_type: 'symbol',
            species: 'mus_musculus',
            expand: true
          },
          fetchImpl
        )
      ).toEqual({ found: true, query, species: 'mus_musculus', record })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(String(fetchImpl.mock.calls[0][0])).toBe(
        `https://rest.ensembl.org/lookup/symbol/mus_musculus/${query}?expand=1`
      )
    }
  )

  it('returns absence after a single explicit symbol miss', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'No valid lookup found for symbol NOSUCHGENE' }, { status: 400 })
      )
    expect(
      await run(
        'ensembl_lookup',
        {
          query: 'NOSUCHGENE',
          query_type: 'symbol'
        },
        fetchImpl
      )
    ).toEqual({
      found: false,
      query: 'NOSUCHGENE',
      species: 'homo_sapiens',
      record: null
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/lookup/symbol/homo_sapiens/NOSUCHGENE')
  })

  it('reports an invalid species in explicit symbol mode', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Can not find internal name for species 'mus_musculuss'" },
          { status: 400 }
        )
      )
    await expect(
      run(
        'ensembl_lookup',
        {
          query: 'Trp53',
          query_type: 'symbol',
          species: 'mus_musculuss'
        },
        fetchImpl
      )
    ).rejects.toThrow('Can not find internal name for species')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['guess', '', null, 1])(
    'rejects invalid query_type %s before HTTP',
    async (queryType) => {
      const fetchImpl = vi.fn()
      await expect(
        run(
          'ensembl_lookup',
          {
            query: 'Trp53',
            query_type: queryType
          },
          fetchImpl
        )
      ).rejects.toThrow('query_type must be auto, id, or symbol')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['FBgn0002778', 'drosophila_melanogaster'],
    ['WBGene00006763', 'caenorhabditis_elegans'],
    ['YBR160W', 'saccharomyces_cerevisiae']
  ])('resolves non-ENS ID %s without using the symbol endpoint', async (query, species) => {
    const record = { id: query, species }
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(record))
    expect(await run('ensembl_lookup', { query }, fetchImpl)).toEqual({
      found: true,
      query,
      species,
      record
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/lookup/id/${query}?expand=0`)
  })

  it('does not fall back to a symbol for a missing canonical ID', async () => {
    const query = 'ENSG99999999999'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: `ID '${query}' not found` }, { status: 400 }))
    expect(await run('ensembl_lookup', { query }, fetchImpl)).toMatchObject({
      found: false,
      record: null
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports invalid species rather than a missing gene', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "ID 'Trp53' not found" }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: "Can not find internal name for species 'mus_musculuss'" },
          { status: 400 }
        )
      )
    await expect(
      run('ensembl_lookup', { query: 'Trp53', species: 'mus_musculuss' }, fetchImpl)
    ).rejects.toThrow('Can not find internal name for species')
  })

  it.each([
    Response.json({ error: 'Invalid expand parameter' }, { status: 400 }),
    Response.json({ error: "ID 'OTHER' not found" }, { status: 400 }),
    new Response('<html>Bad request</html>', { status: 400 }),
    Response.json({}, { status: 400 }),
    Response.json({ id: 'ENSG00000157764', species: 'homo_sapiens' }, { status: 400 }),
    Response.json({ error: 'service unavailable' }, { status: 503 })
  ])(
    'does not convert other error responses into absence or retry as a symbol',
    async (response) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response)
      await expect(run('ensembl_lookup', { query: 'BRAF' }, fetchImpl)).rejects.toThrow()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { status: 400, body: { id: 'ENSG00000157764', species: 'homo_sapiens' } },
    { status: 400, body: { error: 'Invalid expand parameter' } },
    { status: 200, body: { error: 'No valid lookup found for symbol BRAF' } }
  ])('rejects an unexpected symbol response ($status)', async ({ status, body }) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "ID 'BRAF' not found" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(body, { status }))
    await expect(run('ensembl_lookup', { query: 'BRAF' }, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not treat an absence message on HTTP 200 as permission to fall back', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ error: "ID 'BRAF' not found" }))
    await expect(run('ensembl_lookup', { query: 'BRAF' }, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('routes a true stable ID to /lookup/id (species ignored)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENSG00000157764', species: 'homo_sapiens' }))
    const out = (await run(
      'ensembl_lookup',
      { query: 'ENSG00000157764', species: 'mus_musculus', expand: true },
      fetchImpl
    )) as { found: boolean; species: string; record: { id: string } }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/lookup/id/ENSG00000157764?expand=1')
    expect(url).not.toContain('/lookup/symbol/')
    expect(out.found).toBe(true)
    expect(out.record.id).toBe('ENSG00000157764')
    expect(out.species).toBe('homo_sapiens')
  })

  it.each([undefined, 'homo_sapiens'])(
    'returns the mouse record species when the requested species is %s',
    async (species) => {
      const record = {
        id: 'ENSMUSG00000059552',
        species: 'mus_musculus',
        assembly_name: 'GRCm39',
        seq_region_name: '11',
        start: 69469669,
        end: 69482701
      }
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(record))
      const out = await run(
        'ensembl_lookup',
        { query: record.id, ...(species ? { species } : {}) },
        fetchImpl
      )

      expect(String(fetchImpl.mock.calls[0][0])).toContain(`/lookup/id/${record.id}?expand=0`)
      expect(out).toEqual({ found: true, query: record.id, species: 'mus_musculus', record })
    }
  )

  it.each([undefined, null, '', '   ', 9606])(
    'rejects a successful lookup with invalid record species %s',
    async (species) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ id: 'ENSMUSG00000059552', species }))

      await expect(
        run('ensembl_lookup', { query: 'ENSMUSG00000059552' }, fetchImpl)
      ).rejects.toThrow('Ensembl lookup returned a record without a valid species')
    }
  )

  it('routes an "ENS"-prefixed SYMBOL (ENSA / ENSAP1) to /lookup/symbol', async () => {
    for (const sym of ['ENSA', 'ENSAP1']) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: `ID '${sym}' not found` }, { status: 400 }))
        .mockResolvedValueOnce(jsonRes({ id: 'ENSG00000143420', species: 'homo_sapiens' }))
      await run('ensembl_lookup', { query: sym }, fetchImpl)
      expect(String(fetchImpl.mock.calls[0][0])).toContain(`/lookup/id/${sym}?expand=0`)
      expect(String(fetchImpl.mock.calls[1][0])).toContain(
        `/lookup/symbol/homo_sapiens/${sym}?expand=0`
      )
    }
  })

  it.each([
    { query: 'BRAF', species: 'homo_sapiens', id: 'ENSG00000157764' },
    { query: 'Trp53', species: 'mus_musculus', id: 'ENSMUSG00000059552' }
  ])('preserves the species for symbol lookup $query', async ({ query, species, id }) => {
    const record = { id, species }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: `ID '${query}' not found` }, { status: 400 }))
      .mockResolvedValueOnce(jsonRes(record))
    const out = await run('ensembl_lookup', { query, species }, fetchImpl)

    expect(String(fetchImpl.mock.calls[1][0])).toContain(`/lookup/symbol/${species}/${query}`)
    expect(out).toEqual({ found: true, query, species, record })
  })

  it('removes an Ensembl version suffix before calling the stable-ID endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENST00000422447', species: 'homo_sapiens' }))

    await run('ensembl_lookup', { query: 'ENST00000422447.8' }, fetchImpl)

    expect(String(fetchImpl.mock.calls[0][0])).toContain('/lookup/id/ENST00000422447?expand=0')
  })

  it('keeps an LRG id unchanged on the stable-ID route', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'LRG_299', species: 'homo_sapiens' }))

    await run('ensembl_lookup', { query: 'LRG_299' }, fetchImpl)

    expect(String(fetchImpl.mock.calls[0][0])).toContain('/lookup/id/LRG_299?expand=0')
  })

  it('returns not found only after explicit ID and symbol misses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "ID 'NOSUCHGENE' not found" }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({ error: 'No valid lookup found for symbol NOSUCHGENE' }, { status: 400 })
      )
    const out = (await run('ensembl_lookup', { query: 'NOSUCHGENE' }, fetchImpl)) as {
      found: boolean
      record: unknown
    }
    expect(out.found).toBe(false)
    expect(out.record).toBeNull()
  })
})

describe('ensembl_xrefs', () => {
  it('removes an Ensembl version suffix before calling the stable-ID endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([]))

    const out = (await run('ensembl_xrefs', { stable_id: 'ENST00000422447.8' }, fetchImpl)) as {
      stable_id: string
    }

    expect(String(fetchImpl.mock.calls[0][0])).toContain('/xrefs/id/ENST00000422447?')
    expect(out.stable_id).toBe('ENST00000422447.8')
  })

  it('sorts by (dbname, primary_id) and passes external_db through', async () => {
    const rows = [
      { dbname: 'HGNC', primary_id: 'HGNC:1097', display_id: 'BRAF' },
      { dbname: 'EntrezGene', primary_id: '673', display_id: 'BRAF' },
      { dbname: 'EntrezGene', primary_id: '100', display_id: 'X' }
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(rows))
    const out = (await run(
      'ensembl_xrefs',
      { stable_id: 'ENSG00000157764', external_db: 'HGNC' },
      fetchImpl
    )) as { n_xrefs: number; xrefs: Array<Record<string, unknown>> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('external_db=HGNC')
    expect(out.n_xrefs).toBe(3)
    expect(out.xrefs.map((x) => `${x.dbname}:${x.primary_id}`)).toEqual([
      'EntrezGene:100',
      'EntrezGene:673',
      'HGNC:HGNC:1097'
    ])
  })

  it('maps an unknown-id 400 to n_xrefs:0 (does not throw)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(400))
    const out = (await run('ensembl_xrefs', { stable_id: 'NOTANID' }, fetchImpl)) as {
      n_xrefs: number
      xrefs: unknown[]
    }
    expect(out.n_xrefs).toBe(0)
    expect(out.xrefs).toEqual([])
  })
})

describe('ensembl_vep_variant', () => {
  const vepResult = {
    input: 'rs7412',
    assembly_name: 'GRCh38',
    seq_region_name: '19',
    start: 44908822,
    end: 44908822,
    strand: 1,
    allele_string: 'C/T',
    most_severe_consequence: 'missense_variant',
    colocated_variants: [{ id: 'rs7412', allele_string: 'C/T', somatic: 0, clin_sig: ['benign'] }],
    regulatory_feature_consequences: [{ x: 1 }],
    transcript_consequences: [
      { transcript_id: 't1', gene_id: 'G1', gene_symbol: 'APOE', impact: 'MODIFIER' },
      { transcript_id: 't2', gene_id: 'G1', gene_symbol: 'APOE', impact: 'MODERATE' },
      { transcript_id: 't3', gene_id: 'G2', gene_symbol: 'TOMM40', impact: 'HIGH' },
      { transcript_id: 't4', gene_id: 'G2', gene_symbol: 'TOMM40', impact: 'LOW' }
    ]
  }

  it('sorts most-severe-first, truncates, and summarizes per-gene worst impact', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([vepResult]))
    const out = (await run(
      'ensembl_vep_variant',
      { variant_id: 'rs7412', max_consequences: 2 },
      fetchImpl
    )) as {
      query: string
      n_results: number
      results: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/vep/homo_sapiens/id/rs7412')
    expect(out.query).toBe('rs7412')
    const r = out.results[0]
    // Top-2 by severity: HIGH then MODERATE.
    const tcs = r.transcript_consequences as Array<Record<string, unknown>>
    expect(tcs.map((t) => t.impact)).toEqual(['HIGH', 'MODERATE'])
    expect(r.n_transcript_consequences).toBe(4)
    expect(r.transcript_consequences_truncated).toBe(true)
    // Per-gene worst impact over the FULL list, sorted by severity.
    expect(r.genes).toEqual([
      { gene_id: 'G2', gene_symbol: 'TOMM40', worst_impact: 'HIGH', n_transcripts: 2 },
      { gene_id: 'G1', gene_symbol: 'APOE', worst_impact: 'MODERATE', n_transcripts: 2 }
    ])
    expect(r.n_regulatory_feature_consequences).toBe(1)
    expect(r.n_motif_feature_consequences).toBe(0)
    expect((r.colocated_variants as unknown[]).length).toBe(1)
  })

  it.each([1, 10])(
    'preserves allele-specific predictions and counts unique transcripts with cap %i',
    async (cap) => {
      const rows = [
        {
          transcript_id: 't1',
          gene_id: 'G1',
          variant_allele: 'A',
          impact: 'LOW',
          sift_prediction: 'tolerated'
        },
        {
          transcript_id: 't1',
          gene_id: 'G1',
          variant_allele: 'T',
          impact: 'MODERATE',
          sift_prediction: 'deleterious'
        },
        { transcript_id: 't2', gene_id: 'G1', variant_allele: 'A', impact: 'MODIFIER' },
        { transcript_id: 't3', gene_id: 'G2', variant_allele: 'T', impact: 'LOW' }
      ]
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonRes([{ ...vepResult, allele_string: 'G/A/T', transcript_consequences: rows }])
        )
      const out = (await run(
        'ensembl_vep_variant',
        { variant_id: 'rs-test', max_consequences: cap },
        fetchImpl
      )) as { results: Array<Record<string, unknown>> }
      const r = out.results[0]
      const kept = r.transcript_consequences as Array<Record<string, unknown>>
      expect(r.genes).toEqual([
        { gene_id: 'G1', gene_symbol: undefined, worst_impact: 'MODERATE', n_transcripts: 2 },
        { gene_id: 'G2', gene_symbol: undefined, worst_impact: 'LOW', n_transcripts: 1 }
      ])
      expect(r.n_transcript_consequences).toBe(4)
      expect(r.transcript_consequences_truncated).toBe(cap < 4)
      expect(kept).toHaveLength(Math.min(cap, 4))
      expect(kept[0]).toMatchObject({
        transcript_id: 't1',
        variant_allele: 'T',
        sift_prediction: 'deleterious'
      })
      if (cap >= 4) {
        expect(
          kept.find((row) => row.transcript_id === 't1' && row.variant_allele === 'A')
        ).toMatchObject({ sift_prediction: 'tolerated' })
      }
    }
  )

  it('builds the region+allele route and reports the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([{ ...vepResult, input: 'region' }]))
    const out = (await run(
      'ensembl_vep_variant',
      { region: '7:140753336-140753336', allele: 'T' },
      fetchImpl
    )) as { query: string }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/vep/homo_sapiens/region/7:140753336-140753336:1/T'
    )
    expect(out.query).toBe('7:140753336-140753336 T')
  })

  it.each([
    ['19:44908822-44908822:-1', 'A', '19:44908822-44908822:1', 'T'],
    ['19:44908822-44908823:-1', 'gt', '19:44908822-44908823:1', 'AC'],
    ['19:44908823-44908822:-1', 'GT', '19:44908823-44908822:1', 'AC'],
    ['19:44908822-44908823:-1', '-', '19:44908822-44908823:1', '-']
  ])(
    'matches equivalent forward output for %s / %s',
    async (region, allele, forwardRegion, forwardAllele) => {
      const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
        expect(url).toContain(`/region/${forwardRegion}/${forwardAllele}`)
        return jsonRes([{ ...vepResult, allele_string: `C/${forwardAllele}` }])
      })
      const args = { region, allele, allele_orientation: 'region', species: 'mus_musculus' }
      const negative = (await run('ensembl_vep_variant', args, fetchImpl)) as Record<
        string,
        unknown
      >
      const positive = (await run(
        'ensembl_vep_variant',
        {
          region: forwardRegion,
          allele: forwardAllele,
          species: 'mus_musculus'
        },
        fetchImpl
      )) as Record<string, unknown>
      expect(negative.results).toEqual(positive.results)
      expect(negative.query).toBe(`${region} ${allele}`)
      expect(negative.normalization).toEqual({
        original: { region, allele, allele_orientation: 'region' },
        forward: { region: forwardRegion, allele: forwardAllele },
        reverse_complemented: allele !== '-'
      })
      expect(args).toEqual({
        region,
        allele,
        allele_orientation: 'region',
        species: 'mus_musculus'
      })
      expect(String(fetchImpl.mock.calls[0][0])).toContain('/vep/mus_musculus/')
    }
  )

  it.each([undefined, 'forward'])(
    'preserves the existing forward allele contract (%s)',
    async (orientation) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonRes([vepResult]))
      const out = (await run(
        'ensembl_vep_variant',
        {
          region: '19:44908822-44908822:-1',
          allele: 'T',
          allele_orientation: orientation
        },
        fetchImpl
      )) as Record<string, unknown>
      expect(String(fetchImpl.mock.calls[0][0])).toContain('/region/19:44908822-44908822:1/T')
      expect(out.normalization).toMatchObject({
        reverse_complemented: false,
        original: { allele_orientation: 'forward' }
      })
    }
  )

  it.each(['19:44908822-44908822', '19:44908822-44908822:1', '19:44908822-44908822:+1'])(
    'does not complement forward region %s in region orientation',
    async (region) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonRes([vepResult]))
      await run(
        'ensembl_vep_variant',
        { region, allele: 't', allele_orientation: 'region' },
        fetchImpl
      )
      expect(String(fetchImpl.mock.calls[0][0])).toContain('/region/19:44908822-44908822:1/T')
    }
  )

  it.each(['INS', 'DUP', 'DEL', 'TDUP'])(
    'preserves symbolic %s in forward orientation',
    async (allele) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonRes([vepResult]))
      await run('ensembl_vep_variant', { region: '19:10-20:-1', allele }, fetchImpl)
      expect(String(fetchImpl.mock.calls[0][0])).toContain(`/region/19:10-20:1/${allele}`)
    }
  )

  it.each([
    { region: '19:10-10:-1', allele: 'DUP', allele_orientation: 'region' },
    { region: '19:10-10:-1', allele: 'N', allele_orientation: 'region' },
    { region: '19:10-10:-1', allele: 'A/C', allele_orientation: 'region' },
    { region: '19:10-10:-1', allele: 'A', allele_orientation: 'unknown' },
    { region: '19:10-10:-2', allele: 'A' },
    { region: '19:12-10:-1', allele: 'A' },
    { region: '19:1-0:-1', allele: 'A' },
    { region: '19:0-10', allele: '-' },
    { region: '19:9007199254740992-9007199254740992', allele: 'A' },
    { region: '19:10-10:-1?strand=1', allele: 'A' }
  ])('rejects ambiguous or invalid region input before fetching: %j', async (args) => {
    const fetchImpl = vi.fn()
    await expect(run('ensembl_vep_variant', args, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps ID precedence and the existing ID result shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([vepResult]))
    const out = (await run(
      'ensembl_vep_variant',
      {
        variant_id: 'rs7412',
        region: 'ignored:-1',
        allele: 'not a sequence',
        allele_orientation: 'region'
      },
      fetchImpl
    )) as Record<string, unknown>
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/id/rs7412')
    expect(out.query).toBe('rs7412')
    expect(out).not.toHaveProperty('normalization')
  })

  it('throws when neither variant_id nor region+allele is supplied', async () => {
    const fetchImpl = vi.fn()
    await expect(run('ensembl_vep_variant', { region: '7:1-1' }, fetchImpl)).rejects.toThrow(
      /variant_id or both region and allele/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_homology', () => {
  it('resolves a symbol to a stable ID first, then queries /homology/id and sorts rows', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/lookup/symbol/')) {
        return Promise.resolve(jsonRes({ id: 'ENSG00000157764' }))
      }
      return Promise.resolve(
        jsonRes({
          data: [
            {
              homologies: [
                { species: 'mus_musculus', id: 'ENSMUSG2', type: 'ortholog_one2one' },
                { species: 'mus_musculus', id: 'ENSMUSG1', type: 'ortholog_one2one' },
                { species: 'gallus_gallus', id: 'ENSGALG1', type: 'ortholog_one2one' }
              ]
            }
          ]
        })
      )
    })
    const out = (await run(
      'ensembl_homology',
      { gene_symbol: 'BRAF', target_species: 'mus_musculus', max_homologies: 2 },
      fetchImpl
    )) as {
      gene_id: string
      n_total: number
      homologies_truncated: boolean
      homologies: Array<Record<string, unknown>>
    }
    const homologyUrl = String(
      fetchImpl.mock.calls.find((c) => String(c[0]).includes('/homology/id/'))![0]
    )
    expect(homologyUrl).toContain('/homology/id/homo_sapiens/ENSG00000157764')
    expect(homologyUrl).toContain('format=condensed')
    expect(homologyUrl).toContain('target_species=mus_musculus')
    expect(out.gene_id).toBe('ENSG00000157764')
    expect(out.n_total).toBe(3)
    expect(out.homologies_truncated).toBe(true)
    // Sorted by (species, id), then capped at 2.
    expect(out.homologies.map((h) => h.id)).toEqual(['ENSGALG1', 'ENSMUSG1'])
  })

  it('throws when both gene_symbol and gene_id (or neither) are provided', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('ensembl_homology', { gene_symbol: 'BRAF', gene_id: 'ENSG1' }, fetchImpl)
    ).rejects.toThrow(/exactly one/)
    await expect(run('ensembl_homology', {}, fetchImpl)).rejects.toThrow(/exactly one/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_sequence', () => {
  it('removes an Ensembl version suffix before calling the stable-ID endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENST00000422447', molecule: 'dna', seq: 'ACGT' }))

    const out = (await run(
      'ensembl_sequence',
      { stable_id: 'ENST00000422447.8', seq_type: 'cdna' },
      fetchImpl
    )) as { query: string }

    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/id/ENST00000422447?type=cdna')
    expect(out.query).toBe('ENST00000422447.8')
  })

  it('computes length + sha256 for a stable-ID sequence', async () => {
    const seq = 'ACGTACGTAC'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENSG1', desc: 'chr7', molecule: 'dna', seq }))
    const out = (await run(
      'ensembl_sequence',
      { stable_id: 'ENSG1', seq_type: 'genomic' },
      fetchImpl
    )) as { length: number; sha256: string; seq?: string; seq_omitted?: boolean }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/id/ENSG1?type=genomic')
    expect(out.length).toBe(seq.length)
    expect(out.sha256).toBe(createHash('sha256').update(seq, 'utf8').digest('hex'))
    expect(out.seq).toBe(seq)
    expect(out.seq_omitted).toBeUndefined()
  })

  it('omits seq (keeps length/sha256) past max_bytes', async () => {
    const seq = 'ACGTACGTAC'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENSG1', desc: 'chr7', molecule: 'dna', seq }))
    const out = (await run(
      'ensembl_sequence',
      { stable_id: 'ENSG1', max_bytes: 5 },
      fetchImpl
    )) as { length: number; sha256: string; seq?: string; seq_omitted?: boolean }
    expect(out.seq).toBeUndefined()
    expect(out.seq_omitted).toBe(true)
    expect(out.length).toBe(seq.length)
    expect(out.sha256).toBe(createHash('sha256').update(seq, 'utf8').digest('hex'))
  })

  it('uses the region route (always genomic) and ignores seq_type', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ id: 'chromosome:GRCh38:7:1:10:1', molecule: 'dna', seq: 'ACGTACGTAC' })
      )
    const out = (await run(
      'ensembl_sequence',
      { region: '7:1-10', species: 'homo_sapiens', seq_type: 'protein' },
      fetchImpl
    )) as { seq_type: string }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/region/homo_sapiens/7:1-10')
    expect(out.seq_type).toBe('genomic')
  })

  it.each(['ENSG00000000000', 'ENSG00000000000.2'])(
    'maps an explicit absence response for %s to found:false',
    async (stableId) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "ID 'ENSG00000000000' not found" }, { status: 400 })
        )
      const out = await run('ensembl_sequence', { stable_id: stableId }, fetchImpl)
      expect(out).toEqual({
        found: false,
        query: stableId,
        seq_type: 'genomic',
        id: null,
        description: null,
        molecule: null,
        length: 0,
        sha256: null
      })
      expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/id/ENSG00000000000?')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'Requesting a gene and type not equal to "genomic" can result in multiple sequences. 40 sequences detected. Please rerun your request and specify the multiple_sequences parameter',
    'No sequences returned, please check the type specified is compatible with the object requested',
    "ID 'OTHER' not found"
  ])('preserves an upstream sequence error instead of reporting absence: %s', async (error) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ error }, { status: 400 }))
    await expect(
      run('ensembl_sequence', { stable_id: 'ENSG00000141510', seq_type: 'cdna' }, fetchImpl)
    ).rejects.toThrow(`Ensembl sequence failed: ${error}`)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([{}, null, [], { error: null }, { seq: 'ACGT' }])(
    'rejects an unrecognized HTTP 400 body: %j',
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(body, { status: 400 }))
      await expect(
        run('ensembl_sequence', { stable_id: 'ENSG00000141510' }, fetchImpl)
      ).rejects.toThrow('unrecognized HTTP 400')
    }
  )

  it('does not turn a non-JSON HTTP 400 response into absence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>Bad request</html>', { status: 400 }))
    await expect(
      run('ensembl_sequence', { stable_id: 'ENSG00000141510' }, fetchImpl)
    ).rejects.toThrow()
  })

  it.each([404, 429, 500, 503])(
    'propagates HTTP %s instead of reporting absence',
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "ID 'ENSG00000141510' not found" }, { status })
        )
      await expect(
        run('ensembl_sequence', { stable_id: 'ENSG00000141510' }, fetchImpl)
      ).rejects.toThrow(`HTTP ${status}`)
    }
  )

  it('throws when neither stable_id nor region is provided', async () => {
    const fetchImpl = vi.fn()
    await expect(run('ensembl_sequence', {}, fetchImpl)).rejects.toThrow(/stable_id or region/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_overlap_region', () => {
  it('sorts by (start, id), caps, and reports n_total', async () => {
    const rows = [
      { id: 'ENSG_B', start: 200, biotype: 'protein_coding' },
      { id: 'ENSG_A', start: 100, biotype: 'protein_coding' },
      { id: 'ENSG_C', start: 100, biotype: 'lincRNA' }
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(rows))
    const out = (await run(
      'ensembl_overlap_region',
      { region: '7:1-1000', feature: 'gene', max_features: 2 },
      fetchImpl
    )) as { n_total: number; features_truncated: boolean; features: Array<Record<string, unknown>> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/overlap/region/homo_sapiens/7:1-1000?feature=gene'
    )
    expect(out.n_total).toBe(3)
    expect(out.features_truncated).toBe(true)
    // Sorted (start asc, then id): A(100), C(100), B(200) -> capped to first 2.
    expect(out.features.map((f) => f.id)).toEqual(['ENSG_A', 'ENSG_C'])
  })

  it('returns n_total:0 for an empty region', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([]))
    const out = (await run(
      'ensembl_overlap_region',
      { region: '7:1-2', feature: 'regulatory' },
      fetchImpl
    )) as { n_total: number; features: unknown[] }
    expect(out.n_total).toBe(0)
    expect(out.features).toEqual([])
  })
})
