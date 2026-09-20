import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { validateToolArguments } from '../registry'
import { ConnectorService } from '../service'
import { renderSkillDoc } from '../skill-doc'
import type { ToolDescriptor } from '../types'
import { VARIANTS_GNOMAD_TOOLS } from './variants-gnomad'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): ToolDescriptor => VARIANTS_GNOMAD_TOOLS.find((t) => t.id === id)!

// Runs a tool against a single mocked GraphQL POST, returning the parsed output plus the POSTed
// {query, variables} body for dispatch/pin assertions.
async function run(
  id: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ out: unknown; url: string; query: string; variables: Record<string, unknown> }> {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
  const out = await new ParserEngine({ fetchImpl }).call(tool(id), args, {})
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
  const parsed = JSON.parse(init.body as string) as {
    query: string
    variables: Record<string, unknown>
  }
  expect(init.method).toBe('POST')
  return { out, url, query: parsed.query, variables: parsed.variables }
}

describe('variants-gnomad', () => {
  it.each([
    ['region_variants', 'start', 'stop', { chrom: '1' }],
    ['mitochondrial_variants', 'region_start', 'region_stop', {}]
  ] as const)(
    '%s enforces the upstream coordinate ceiling',
    async (id, startKey, stopKey, extra) => {
      const valid = { ...extra, [startKey]: 999_999_999, [stopKey]: 999_999_999 }
      expect(() => validateToolArguments(tool(id), valid)).not.toThrow()
      const { variables } = await run(id, valid, {
        data: { region: { variants: [], mitochondrial_variants: [] } }
      })
      expect(variables).toMatchObject({ start: 999_999_999, stop: 999_999_999 })

      for (const key of [startKey, stopKey]) {
        const invalid = { ...valid, [key]: 1_000_000_000 }
        expect(() => validateToolArguments(tool(id), invalid)).toThrow(/999999999/)
        const fetchImpl = vi.fn()
        await expect(new ParserEngine({ fetchImpl }).call(tool(id), invalid, {})).rejects.toThrow(
          /between 1 and 999999999/
        )
        expect(fetchImpl).not.toHaveBeenCalled()
      }
    }
  )

  const referenceBuildCases = [
    ['exac', 'GRCh37'],
    ['gnomad_r2_1', 'GRCh37'],
    ['gnomad_r2_1_controls', 'GRCh37'],
    ['gnomad_r2_1_non_cancer', 'GRCh37'],
    ['gnomad_r2_1_non_neuro', 'GRCh37'],
    ['gnomad_r2_1_non_topmed', 'GRCh37'],
    ['gnomad_r3', 'GRCh38'],
    ['gnomad_r3_controls_and_biobanks', 'GRCh38'],
    ['gnomad_r3_non_cancer', 'GRCh38'],
    ['gnomad_r3_non_neuro', 'GRCh38'],
    ['gnomad_r3_non_topmed', 'GRCh38'],
    ['gnomad_r3_non_v2', 'GRCh38'],
    ['gnomad_r4', 'GRCh38'],
    ['gnomad_r4_non_ukb', 'GRCh38']
  ] as const

  it.each(referenceBuildCases)(
    'uses the reference build for %s in gene and region queries',
    async (dataset, referenceGenome) => {
      for (const [id, args] of [
        ['gene_variants', { gene_symbol: 'APOE', dataset }],
        ['region_variants', { chrom: '19', start: 45411941, stop: 45411941, dataset }]
      ] as const) {
        const result = await run(id, args, { data: { gene: null, region: null } })
        expect(result.variables).toMatchObject({ dataset, referenceGenome })
        expect(result.query).toContain('$referenceGenome: ReferenceGenomeId!')
        expect(result.query).toContain('reference_genome: $referenceGenome')
        expect(result.query).not.toContain('reference_genome: GRCh38')
      }
    }
  )

  it.each([
    ['gnomad_sv_r2_1', 'GRCh37'],
    ['gnomad_sv_r4', 'GRCh38']
  ])('uses the reference build for structural dataset %s', async (dataset, referenceGenome) => {
    const result = await run(
      'structural_variants',
      { gene_symbol: 'APOE', dataset },
      { data: { gene: null } }
    )
    expect(result.variables).toMatchObject({ dataset, referenceGenome })
    expect(result.query).toContain('$referenceGenome: ReferenceGenomeId!')
    expect(result.query).toContain('reference_genome: $referenceGenome')
  })

  it('exports the 10 tools in order, all under the variants connector', () => {
    expect(VARIANTS_GNOMAD_TOOLS.map((t) => t.id)).toEqual([
      'get_variant',
      'search_variants',
      'gene_variants',
      'gene_constraint',
      'region_variants',
      'liftover_variant',
      'clinvar_variants',
      'structural_variants',
      'get_structural_variant',
      'mitochondrial_variants'
    ])
    expect(VARIANTS_GNOMAD_TOOLS.every((t) => t.connector === 'variants')).toBe(true)
  })

  // ---- get_variant --------------------------------------------------------------------------

  it('get_variant: dispatches the Variant query, pins gnomad_r4, shapes exome/genome blocks', async () => {
    const { out, url, query, variables } = await run(
      'get_variant',
      { variant_id: '19-44908822-C-T' },
      {
        data: {
          variant: {
            variant_id: '19-44908822-C-T',
            reference_genome: 'GRCh38',
            chrom: '19',
            pos: 44908822,
            ref: 'C',
            alt: 'T',
            rsids: ['rs7412'],
            exome: {
              ac: 102550,
              an: 1388698,
              af: 0.0738,
              homozygote_count: 4063,
              hemizygote_count: 0,
              filters: []
            },
            genome: {
              ac: 11840,
              an: 152112,
              af: 0.0778,
              homozygote_count: 546,
              hemizygote_count: 0,
              filters: []
            }
          }
        }
      }
    )
    expect(url).toBe('https://gnomad.broadinstitute.org/api')
    expect(query).toContain('query Variant(')
    expect(variables).toEqual({ variantId: '19-44908822-C-T', dataset: 'gnomad_r4' })
    expect(out).toMatchObject({
      found: true,
      variant_id: '19-44908822-C-T',
      dataset: 'gnomad_r4',
      variant: {
        variant_id: '19-44908822-C-T',
        dataset: 'gnomad_r4',
        reference_genome: 'GRCh38',
        rsids: ['rs7412'],
        exome: {
          ac: 102550,
          an: 1388698,
          af: 0.0738,
          homozygote_count: 4063,
          hemizygote_count: 0,
          filters: []
        },
        genome: {
          ac: 11840,
          an: 152112,
          af: 0.0778,
          homozygote_count: 546,
          hemizygote_count: 0,
          filters: []
        }
      }
    })
  })

  it('get_variant: found=false with a null variant when the entity is absent (data null)', async () => {
    const { out } = await run('get_variant', { variant_id: '1-1-A-T' }, { data: { variant: null } })
    expect(out).toEqual({
      found: false,
      variant_id: '1-1-A-T',
      dataset: 'gnomad_r4',
      variant: null
    })
  })

  it('get_variant: a "variant not found" GraphQL error resolves to found=false, not a throw', async () => {
    const { out } = await run(
      'get_variant',
      { variant_id: '1-1-A-T', dataset: 'gnomad_r3' },
      { data: { variant: null }, errors: [{ message: 'Variant not found' }] }
    )
    expect(out).toMatchObject({ found: false, dataset: 'gnomad_r3', variant: null })
  })

  it('get_variant: honors an explicit dataset pin', async () => {
    const { variables } = await run(
      'get_variant',
      { variant_id: '1-1-A-T', dataset: 'exac' },
      { data: { variant: null } }
    )
    expect(variables.dataset).toBe('exac')
  })

  it('get_variant: rejects an unknown dataset (usage error)', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('get_variant'),
        { variant_id: 'x', dataset: 'nope' },
        {}
      )
    ).rejects.toThrow(/unknown dataset/)
  })

  it('get_variant: keeps the original query and response when populations are not requested', async () => {
    const frequency = { ac: 1, an: 100, af: 0.01, filters: [] }
    const body = {
      data: {
        variant: {
          variant_id: '19-44908822-C-T',
          exome: { ...frequency, populations: [{ id: 'eas', ac: 1, an: 20 }] },
          genome: null
        }
      }
    }
    const omitted = await run('get_variant', { variant_id: '19-44908822-C-T' }, body)
    const disabled = await run(
      'get_variant',
      { variant_id: '19-44908822-C-T', include_populations: false },
      body
    )
    expect(disabled).toEqual(omitted)
    expect(omitted.query).toBe(`
query Variant($variantId: String!, $dataset: DatasetId!) {
  variant(variantId: $variantId, dataset: $dataset) {
    variant_id reference_genome chrom pos ref alt rsids
    exome { ac an af homozygote_count hemizygote_count filters }
    genome { ac an af homozygote_count hemizygote_count filters }
  }
}
`)
    expect(omitted.out).toMatchObject({ variant: { exome: frequency, genome: null } })
    expect((omitted.out as { variant: { exome: unknown } }).variant.exome).toEqual(frequency)
  })

  it('get_variant: derives population AF from counts and preserves original group IDs and filters', async () => {
    const body = {
      data: {
        variant: {
          variant_id: '19-44908822-C-T',
          exome: {
            ac: 10,
            an: 1000,
            af: 0.01,
            filters: ['RF', 'AC0'],
            populations: [
              { id: 'nfe', ac: 1, an: 3_000_000, homozygote_count: 0, hemizygote_count: 0 },
              { id: 'eas_XX', ac: 1, an: 100 },
              null,
              { id: 'eas', ac: 1, an: 300, af: 0.9 }
            ]
          },
          genome: {
            ac: 2,
            an: 200,
            af: 0.01,
            filters: [],
            populations: [
              { id: 'hgdp:Han', ac: 1, an: 10 },
              { id: '1kg:CHB', ac: 0, an: 20 }
            ]
          }
        }
      }
    }
    const original = structuredClone(body)
    const result = await run(
      'get_variant',
      { variant_id: '19-44908822-C-T', include_populations: true },
      body
    )
    // Real VariantPopulation exposes counts, not af. A mock containing af must not hide a bad query.
    const selections = [...result.query.matchAll(/populations\s*\{([^}]+)\}/g)]
    expect(selections).toHaveLength(2)
    for (const [, fields] of selections) {
      expect(fields.trim().split(/\s+/)).toEqual([
        'id',
        'ac',
        'an',
        'homozygote_count',
        'hemizygote_count'
      ])
    }
    expect(result.variables).toEqual({ variantId: '19-44908822-C-T', dataset: 'gnomad_r4' })
    const { variant } = result.out as {
      variant: { exome: Record<string, unknown>; genome: Record<string, unknown> }
    }
    expect(variant.exome).toEqual({
      ac: 10,
      an: 1000,
      af: 0.01,
      filters: ['AC0', 'RF'],
      populations: [
        { id: 'eas', ac: 1, an: 300, af: 1 / 300, homozygote_count: null, hemizygote_count: null },
        { id: 'eas_XX', ac: 1, an: 100, af: 0.01, homozygote_count: null, hemizygote_count: null },
        {
          id: 'nfe',
          ac: 1,
          an: 3_000_000,
          af: 1 / 3_000_000,
          homozygote_count: 0,
          hemizygote_count: 0
        }
      ]
    })
    expect(variant.genome.populations).toEqual([
      { id: '1kg:CHB', ac: 0, an: 20, af: 0, homozygote_count: null, hemizygote_count: null },
      { id: 'hgdp:Han', ac: 1, an: 10, af: 0.1, homozygote_count: null, hemizygote_count: null }
    ])
    expect(body).toEqual(original)
  })

  it.each([
    [0, 100, 0],
    [0, 0, null],
    [1, 0, null],
    [null, 100, null],
    [undefined, 100, null],
    [1, null, null],
    [1, undefined, null],
    [-1, 100, null],
    [2, 1, null]
  ])('get_variant: population counts ac=%s an=%s yield af=%s', async (ac, an, af) => {
    const { out } = await run(
      'get_variant',
      { variant_id: '19-44908822-C-T', include_populations: true },
      {
        data: {
          variant: {
            variant_id: '19-44908822-C-T',
            genome: { populations: [{ id: 'eas', ac, an }] }
          }
        }
      }
    )
    expect(out).toMatchObject({
      variant: { genome: { populations: [{ id: 'eas', ac: ac ?? null, an: an ?? null, af }] } }
    })
  })

  it.each([undefined, null, []])(
    'get_variant: preserves unavailable or empty populations (%j)',
    async (populations) => {
      const { out } = await run(
        'get_variant',
        { variant_id: '19-44908822-C-T', include_populations: true },
        {
          data: { variant: { variant_id: '19-44908822-C-T', genome: { populations }, exome: null } }
        }
      )
      expect(out).toMatchObject({
        variant: { exome: null, genome: { populations: populations ?? null } }
      })
    }
  )

  it.each([
    ['gnomad_r4', '19-44908822-C-T', 'exome'],
    ['gnomad_r4_non_ukb', '19-44908822-C-T', 'exome'],
    ['gnomad_r3', '19-44908822-C-T', 'genome'],
    ['gnomad_r2_1', '19-45412079-C-T', 'exome'],
    ['exac', '19-45412079-C-T', 'exome']
  ])(
    'get_variant: population requests preserve dataset/build routing for %s',
    async (dataset, variantId, kind) => {
      const { out, variables } = await run(
        'get_variant',
        { variant_id: variantId, dataset, include_populations: true },
        {
          data: {
            variant: {
              variant_id: variantId,
              [kind]: { populations: [{ id: 'eas', ac: 0, an: 100 }] }
            }
          }
        }
      )
      expect(variables).toEqual({ variantId, dataset })
      expect(out).toMatchObject({
        dataset,
        variant: {
          [kind]: { populations: [{ id: 'eas', af: 0 }] },
          [kind === 'exome' ? 'genome' : 'exome']: null
        }
      })
    }
  )

  it('get_variant: population requests retain not-found and upstream-error behavior', async () => {
    const args = { variant_id: '19-44908822-C-T', include_populations: true }
    const { out } = await run('get_variant', args, { errors: [{ message: 'Variant not found' }] })
    expect(out).toMatchObject({ found: false, variant: null })
    await expect(
      run('get_variant', args, {
        data: { variant: { variant_id: args.variant_id, exome: { ac: 1, an: 10 } } },
        errors: [{ message: 'population lookup failed' }]
      })
    ).rejects.toThrow('population lookup failed')
  })

  it('get_variant: validates the opt-in parameter and documents it in the generated skill', () => {
    const descriptor = tool('get_variant')
    for (const include_populations of [true, false]) {
      expect(() =>
        validateToolArguments(descriptor, { variant_id: '19-44908822-C-T', include_populations })
      ).not.toThrow()
    }
    for (const include_populations of ['false', 1, null]) {
      expect(() =>
        validateToolArguments(descriptor, { variant_id: '19-44908822-C-T', include_populations })
      ).toThrow(/include_populations.*boolean/)
    }
    for (const other of VARIANTS_GNOMAD_TOOLS.filter(
      (descriptor) => descriptor.id !== 'get_variant'
    )) {
      expect(other.input.properties).not.toHaveProperty('include_populations')
    }
    const skill = renderSkillDoc('variants')
    expect(skill).toContain('"include_populations":{"type":"boolean","default":false')
    expect(skill).toContain('Set `include_populations: true` when ancestry-specific')
    expect(descriptor.example).not.toContain('include_populations')
    expect(skill).toContain(descriptor.example)
    expect(skill).toContain('do not sum rows')
    expect(skill).toContain('rarity alone does not establish pathogenicity')
  })

  describe('get_variant population boundary contracts', () => {
    const args = { variant_id: '19-44908822-C-T', include_populations: true }
    const context = { origin: 'agent' as const, sessionId: 'population-contract-session' }
    const payload = {
      data: {
        variant: {
          variant_id: args.variant_id,
          exome: null,
          genome: {
            ac: 1,
            an: 3_000_000,
            af: 1 / 3_000_000,
            filters: [],
            populations: [{ id: 'eas', ac: 1, an: 3_000_000, homozygote_count: 0 }]
          }
        }
      }
    }
    const response = (): Response => Response.json(payload)

    it.each([undefined, false, true])(
      'preserves the opt-in shape through service validation and JSON transport (%s)',
      async (includePopulations) => {
        const fetchImpl = vi.fn().mockImplementation(async () => response())
        const settings = {
          enabledIds: ['variants'],
          autoAllowIds: ['variants'],
          blockedToolIds: [] as string[]
        }
        const service = new ConnectorService({
          engine: new ParserEngine({ fetchImpl }),
          getConnectors: () => settings,
          resolveApiKey: () => undefined
        })
        const input = {
          variant_id: args.variant_id,
          ...(includePopulations === undefined ? {} : { include_populations: includePopulations })
        }
        const result = await service.call('variants', 'get_variant', input, context)
        const wireResult = JSON.parse(JSON.stringify(result))
        expect(wireResult.variant.exome).toBeNull()
        expect(wireResult.variant.genome).toEqual({
          ac: 1,
          an: 3_000_000,
          af: 1 / 3_000_000,
          filters: [],
          ...(includePopulations
            ? {
                populations: [
                  {
                    id: 'eas',
                    ac: 1,
                    an: 3_000_000,
                    af: 1 / 3_000_000,
                    homozygote_count: 0,
                    hemizygote_count: null
                  }
                ]
              }
            : {})
        })
        expect(fetchImpl).toHaveBeenCalledOnce()
        const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
        expect(request.query.includes('populations {')).toBe(includePopulations === true)
        expect(request.variables).toEqual({ variantId: args.variant_id, dataset: 'gnomad_r4' })

        for (const invalid of ['false', 1, null]) {
          await expect(
            service.call(
              'variants',
              'get_variant',
              { ...args, include_populations: invalid },
              context
            )
          ).rejects.toThrow(/include_populations.*boolean/)
        }
        settings.blockedToolIds.push('variants/get_variant')
        await expect(service.call('variants', 'get_variant', args, context)).rejects.toThrow(
          'tool blocked by policy: variants/get_variant'
        )
        expect(fetchImpl).toHaveBeenCalledOnce()
      }
    )

    it('retries a transient 429 with the same population query and returns the complete result', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(response())
      const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
      const result = await engine.call(tool('get_variant'), args, {})
      expect(result).toMatchObject({
        found: true,
        variant: { genome: { populations: [{ id: 'eas', af: 1 / 3_000_000 }] } }
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(fetchImpl.mock.calls[1][1].body).toBe(fetchImpl.mock.calls[0][1].body)
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body).query).toContain('populations {')
    })

    it('surfaces a long Retry-After without retrying or silently falling back to overall frequencies', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '3600' } }))
      const engine = new ParserEngine({ fetchImpl, totalTimeoutMs: 1000, retryBackoffMs: 0 })
      await expect(engine.call(tool('get_variant'), args, {})).rejects.toThrow(
        /HTTP 429.*Retry after/
      )
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('surfaces a population-field GraphQL error without retrying the lean query', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        Response.json({
          ...payload,
          errors: [{ message: 'Cannot return null for non-nullable field VariantPopulation.ac.' }]
        })
      )
      const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
      await expect(engine.call(tool('get_variant'), args, {})).rejects.toThrow(
        /gnomAD GraphQL error:.*VariantPopulation.ac/
      )
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('aborts a timed-out population request without retrying or returning an empty result', async () => {
      vi.useFakeTimers()
      try {
        const fetchImpl = vi.fn(
          async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
            new Promise((_, reject) => {
              const signal = init?.signal
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
        )
        const engine = new ParserEngine({ fetchImpl, timeoutMs: 30, retryBackoffMs: 0 })
        const rejected = expect(engine.call(tool('get_variant'), args, {})).rejects.toMatchObject({
          name: 'ConnectorRequestTimeoutError'
        })
        await vi.advanceTimersByTimeAsync(30)
        await rejected
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ---- search_variants ----------------------------------------------------------------------

  it('search_variants: dispatches VariantSearch and returns sorted, counted ids', async () => {
    const { out, query, variables } = await run(
      'search_variants',
      { query: 'rs7412' },
      { data: { variant_search: [{ variant_id: '19-44908822-C-T' }, { variant_id: '1-100-A-G' }] } }
    )
    expect(query).toContain('query VariantSearch(')
    expect(variables).toEqual({ query: 'rs7412', dataset: 'gnomad_r4' })
    expect(out).toEqual({
      query: 'rs7412',
      dataset: 'gnomad_r4',
      n_matches: 2,
      variant_ids: ['1-100-A-G', '19-44908822-C-T']
    })
  })

  it('search_variants: empty match list yields n_matches 0', async () => {
    const { out } = await run('search_variants', { query: 'zzz' }, { data: { variant_search: [] } })
    expect(out).toMatchObject({ n_matches: 0, variant_ids: [] })
  })

  // ---- gene_variants ------------------------------------------------------------------------

  it.each([{ gene_symbol: 'APOE' }, { gene_id: 'ENSG00000130203' }])(
    'gene_variants: keeps r2 APOE bounds and variant data on GRCh37 for %j',
    async (geneQuery) => {
      // Reduced from the live gnomAD r2.1 APOE response checked on 2026-09-15.
      // Keep one real row, not the full 637-row listing. The old GRCh38 parent returned
      // bounds 44905791–44909393 alongside this GRCh37 variant, placing it outside the gene.
      const variant = {
        variant_id: '19-45409055-A-G',
        pos: 45409055,
        ref: 'A',
        alt: 'G',
        rsids: ['rs1447504749'],
        exome: { ac: 1, an: 141070, af: 0.000007088679379031686 },
        genome: null
      }
      const { out, query, variables } = await run(
        'gene_variants',
        { ...geneQuery, dataset: 'gnomad_r2_1' },
        {
          data: {
            gene: {
              gene_id: 'ENSG00000130203',
              symbol: 'APOE',
              chrom: '19',
              start: 45409011,
              stop: 45412650,
              variants: [variant]
            }
          }
        }
      )
      // Assert the request as well as the fixture output: replay alone cannot prove
      // that the connector selected the correct upstream reference genome.
      expect(query).toContain('reference_genome: $referenceGenome')
      expect(variables).toEqual({
        symbol: geneQuery.gene_symbol ?? null,
        geneId: geneQuery.gene_id ?? null,
        dataset: 'gnomad_r2_1',
        referenceGenome: 'GRCh37'
      })
      expect(out).toEqual({
        gene_id: 'ENSG00000130203',
        symbol: 'APOE',
        chrom: '19',
        start: 45409011,
        stop: 45412650,
        dataset: 'gnomad_r2_1',
        n_variants: 1,
        variants: [variant]
      })
      const result = out as { start: number; stop: number; variants: Array<{ pos: number }> }
      expect(result.variants.filter((v) => v.pos < result.start || v.pos > result.stop)).toEqual([])
    }
  )

  it('gene_variants: dispatches GeneVariants, sorts rows by pos, shapes lean freq blocks + rsids', async () => {
    const { out, query, variables } = await run(
      'gene_variants',
      { gene_symbol: 'APOE' },
      {
        data: {
          gene: {
            gene_id: 'ENSG00000130203',
            symbol: 'APOE',
            chrom: '19',
            start: 44905791,
            stop: 44909393,
            variants: [
              {
                variant_id: '19-44908822-C-T',
                pos: 44908822,
                ref: 'C',
                alt: 'T',
                rsids: ['rs7412'],
                exome: { ac: 5, an: 100, af: 0.05 },
                genome: null
              },
              {
                variant_id: '19-44905000-A-G',
                pos: 44905000,
                ref: 'A',
                alt: 'G',
                rsids: null,
                exome: null,
                genome: null
              }
            ]
          }
        }
      }
    )
    expect(query).toContain('query GeneVariants(')
    expect(query).toContain('variants(dataset: $dataset)')
    expect(variables).toEqual({
      symbol: 'APOE',
      geneId: null,
      dataset: 'gnomad_r4',
      referenceGenome: 'GRCh38'
    })
    expect(out).toMatchObject({
      gene_id: 'ENSG00000130203',
      symbol: 'APOE',
      dataset: 'gnomad_r4',
      n_variants: 2
    })
    const rows = (
      out as {
        variants: Array<{ variant_id: string; rsids: string[]; exome: unknown; genome: unknown }>
      }
    ).variants
    // Sorted by pos ascending.
    expect(rows.map((r) => r.variant_id)).toEqual(['19-44905000-A-G', '19-44908822-C-T'])
    // rsids defaults to [], null freq blocks stay null.
    expect(rows[0]).toMatchObject({ rsids: [], exome: null, genome: null })
    expect(rows[1]).toMatchObject({
      rsids: ['rs7412'],
      exome: { ac: 5, an: 100, af: 0.05 },
      genome: null
    })
  })

  it('gene_variants: absent gene returns a compact empty result (gene_id null), no throw', async () => {
    const { out } = await run('gene_variants', { gene_symbol: 'NOPE' }, { data: { gene: null } })
    expect(out).toMatchObject({ gene_id: null, symbol: 'NOPE', n_variants: 0, variants: [] })
  })

  it('gene_variants: passes gene_id through as the geneId variable', async () => {
    const { variables } = await run(
      'gene_variants',
      { gene_id: 'ENSG00000130203' },
      { data: { gene: null } }
    )
    expect(variables).toEqual({
      symbol: null,
      geneId: 'ENSG00000130203',
      dataset: 'gnomad_r4',
      referenceGenome: 'GRCh38'
    })
  })

  it('gene_variants: throws when both gene_symbol and gene_id are given (usage error)', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('gene_variants'),
        { gene_symbol: 'APOE', gene_id: 'ENSG00000130203' },
        {}
      )
    ).rejects.toThrow(/exactly one of gene_symbol \/ gene_id/)
  })

  it('gene_variants: throws when neither gene_symbol nor gene_id is given', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(tool('gene_variants'), {}, {})
    ).rejects.toThrow(/exactly one of gene_symbol \/ gene_id/)
  })

  // ---- gene_constraint ----------------------------------------------------------------------

  it('gene_constraint: dispatches GeneConstraint and builds the full constraint record', async () => {
    const { out, query, variables } = await run(
      'gene_constraint',
      { gene_symbol: 'TP53' },
      {
        data: {
          gene: {
            gene_id: 'ENSG00000141510',
            symbol: 'TP53',
            canonical_transcript_id: 'ENST00000269305',
            chrom: '17',
            start: 7661779,
            stop: 7687538,
            strand: '-',
            gnomad_constraint: {
              obs_lof: 12,
              exp_lof: 46.4,
              oe_lof: 0.258,
              oe_lof_upper: 0.418,
              pli: 0.9996
            }
          }
        }
      }
    )
    expect(query).toContain('query GeneConstraint(')
    expect(variables).toEqual({ symbol: 'TP53', geneId: null })
    const record = out as { found: boolean; constraint: Record<string, unknown> }
    expect(record.found).toBe(true)
    // All 20 constraint keys present; unselected ones default to null.
    expect(record.constraint).toMatchObject({
      obs_lof: 12,
      pli: 0.9996,
      oe_lof_upper: 0.418,
      syn_z: null
    })
    expect(Object.keys(record.constraint)).toHaveLength(19)
  })

  it('gene_constraint: absent gene returns found=false with a null constraint', async () => {
    const { out } = await run('gene_constraint', { gene_symbol: 'NOPE' }, { data: { gene: null } })
    expect(out).toMatchObject({ found: false, gene_id: null, constraint: null })
  })

  // ---- region_variants ----------------------------------------------------------------------

  it('region_variants: dispatches RegionVariants with chrom/start/stop/dataset and sorts rows', async () => {
    const { out, query, variables } = await run(
      'region_variants',
      { chrom: '1', start: 55039475, stop: 55064852 },
      {
        data: {
          region: {
            variants: [
              {
                variant_id: '1-55064000-A-G',
                pos: 55064000,
                ref: 'A',
                alt: 'G',
                rsids: [],
                exome: null,
                genome: null
              },
              {
                variant_id: '1-55039774-C-T',
                pos: 55039774,
                ref: 'C',
                alt: 'T',
                rsids: [],
                exome: { ac: 1, an: 10, af: 0.1 },
                genome: null
              }
            ]
          }
        }
      }
    )
    expect(query).toContain('query RegionVariants(')
    expect(variables).toEqual({
      chrom: '1',
      start: 55039475,
      stop: 55064852,
      dataset: 'gnomad_r4',
      referenceGenome: 'GRCh38'
    })
    const rows = out as { n_variants: number; variants: Array<{ variant_id: string }> }
    expect(rows.n_variants).toBe(2)
    expect(rows.variants.map((r) => r.variant_id)).toEqual(['1-55039774-C-T', '1-55064000-A-G'])
  })

  it('region_variants: throws when the window exceeds the 1 Mb cap (usage error)', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('region_variants'),
        { chrom: '1', start: 1, stop: 1_000_002 },
        {}
      )
    ).rejects.toThrow(/exceeds 1000000 bp/)
  })

  it('region_variants: allows a window exactly at the 1 Mb cap', async () => {
    const { variables } = await run(
      'region_variants',
      { chrom: '1', start: 1, stop: 1_000_001 },
      { data: { region: { variants: [] } } }
    )
    expect(variables).toMatchObject({ start: 1, stop: 1_000_001 })
  })

  it.each([
    ['chr1', '1'],
    ['CHR22', '22'],
    ['x', 'X'],
    [' chrY ', 'Y']
  ])('region_variants: normalizes chromosome %j to %s', async (chrom, expected) => {
    const { variables, out } = await run(
      'region_variants',
      { chrom, start: 1, stop: 100 },
      { data: { region: { variants: [] } } }
    )
    expect(variables.chrom).toBe(expected)
    expect(out).toMatchObject({ chrom: expected })
  })

  it.each(['23', 'chrUn', ''])(
    'region_variants: rejects invalid chromosome %j before dispatch',
    async (chrom) => {
      const fetchImpl = vi.fn()
      await expect(
        new ParserEngine({ fetchImpl }).call(
          tool('region_variants'),
          { chrom, start: 1, stop: 100 },
          {}
        )
      ).rejects.toThrow(/chrom must identify chromosome 1-22, X, or Y/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each(['M', 'MT', 'chrM'])(
    'region_variants: directs mitochondrial chromosome %j to the dedicated tool',
    async (chrom) => {
      const fetchImpl = vi.fn()
      await expect(
        new ParserEngine({ fetchImpl }).call(
          tool('region_variants'),
          { chrom, start: 1, stop: 100 },
          {}
        )
      ).rejects.toThrow(/use mitochondrial_variants/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([
    [{ chrom: '1', start: 0, stop: 100 }, /start must be an integer between 1/],
    [{ chrom: '1', start: 101, stop: 100 }, /start must be less than or equal to stop/],
    [{ chrom: '1', start: 1.5, stop: 100 }, /start must be an integer between 1/]
  ])('region_variants: rejects invalid coordinates before dispatch', async (args, error) => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('region_variants'), args, {})
    ).rejects.toThrow(error)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // ---- liftover_variant ---------------------------------------------------------------------

  it('liftover_variant: maps source_build to the rg variable (directionality) and sorts results', async () => {
    const { out, query, variables } = await run(
      'liftover_variant',
      { variant_id: '1-55516888-G-GA', source_build: 'GRCh37' },
      {
        data: {
          liftover: [
            {
              source: { variant_id: '1-55516888-G-GA', reference_genome: 'GRCh37' },
              liftover: { variant_id: '1-55051215-G-GA', reference_genome: 'GRCh38' },
              datasets: ['gnomad_r4', 'gnomad_r2_1']
            }
          ]
        }
      }
    )
    expect(query).toContain('query Liftover(')
    expect(variables).toEqual({ source: '1-55516888-G-GA', rg: 'GRCh37' })
    expect(out).toMatchObject({
      source_variant_id: '1-55516888-G-GA',
      source_build: 'GRCh37',
      n_results: 1
    })
    const results = (out as { results: Array<{ datasets: string[] }> }).results
    expect(results[0].datasets).toEqual(['gnomad_r2_1', 'gnomad_r4'])
  })

  it('liftover_variant: defaults source_build to GRCh37', async () => {
    const { variables } = await run(
      'liftover_variant',
      { variant_id: '1-1-A-T' },
      { data: { liftover: [] } }
    )
    expect(variables.rg).toBe('GRCh37')
  })

  it('liftover_variant: wrong-direction ID yields n_results 0, not an error', async () => {
    const { out } = await run(
      'liftover_variant',
      { variant_id: '1-55051215-G-GA', source_build: 'GRCh37' },
      { data: { liftover: [] } }
    )
    expect(out).toMatchObject({ n_results: 0, results: [] })
  })

  // ---- clinvar_variants ---------------------------------------------------------------------

  it('clinvar_variants: dispatches ClinvarVariants, pins clinvar_release_date, sorts rows', async () => {
    const { out, query, variables } = await run(
      'clinvar_variants',
      { gene_symbol: 'BRCA1' },
      {
        data: {
          meta: { clinvar_release_date: '2024-01-01' },
          gene: {
            gene_id: 'ENSG00000012048',
            symbol: 'BRCA1',
            clinvar_variants: [
              {
                variant_id: '17-100-A-G',
                clinical_significance: 'Pathogenic',
                gold_stars: 2,
                pos: 100,
                in_gnomad: true
              },
              {
                variant_id: '17-50-C-T',
                clinical_significance: 'Benign',
                gold_stars: 1,
                pos: 50,
                in_gnomad: false
              }
            ]
          }
        }
      }
    )
    expect(query).toContain('query ClinvarVariants(')
    expect(variables).toEqual({ symbol: 'BRCA1', geneId: null })
    expect(out).toMatchObject({
      gene_id: 'ENSG00000012048',
      symbol: 'BRCA1',
      clinvar_release_date: '2024-01-01',
      n_variants: 2
    })
    const rows = (out as { variants: Array<{ variant_id: string }> }).variants
    expect(rows.map((r) => r.variant_id)).toEqual(['17-50-C-T', '17-100-A-G'])
  })

  it('clinvar_variants: absent gene still surfaces clinvar_release_date with an empty list', async () => {
    const { out } = await run(
      'clinvar_variants',
      { gene_symbol: 'NOPE' },
      { data: { meta: { clinvar_release_date: '2024-01-01' }, gene: null } }
    )
    expect(out).toMatchObject({
      gene_id: null,
      clinvar_release_date: '2024-01-01',
      n_variants: 0,
      variants: []
    })
  })

  // ---- structural_variants ------------------------------------------------------------------

  it('structural_variants: dispatches the gene SV query, pins gnomad_sv_r4, sorts + sorts filters', async () => {
    const { out, query, variables } = await run(
      'structural_variants',
      { gene_symbol: 'TP53' },
      {
        data: {
          gene: {
            gene_id: 'ENSG00000141510',
            symbol: 'TP53',
            structural_variants: [
              { variant_id: 'BND_chr5_9b3f8636', type: 'BND', ac: 1625, filters: ['PASS'] },
              {
                variant_id: 'BND_chr3_0f54dfa6',
                type: 'BND',
                ac: 1,
                filters: ['UNRESOLVED', 'LOW_CALL_RATE']
              }
            ]
          }
        }
      }
    )
    expect(query).toContain('query StructuralVariantsGene(')
    expect(variables).toEqual({
      symbol: 'TP53',
      geneId: null,
      dataset: 'gnomad_sv_r4',
      referenceGenome: 'GRCh38'
    })
    const rows = out as {
      dataset: string
      variants: Array<{ variant_id: string; filters: string[] }>
    }
    expect(rows.dataset).toBe('gnomad_sv_r4')
    // Sorted by variant_id; filters sorted within each row.
    expect(rows.variants.map((r) => r.variant_id)).toEqual([
      'BND_chr3_0f54dfa6',
      'BND_chr5_9b3f8636'
    ])
    expect(rows.variants[0].filters).toEqual(['LOW_CALL_RATE', 'UNRESOLVED'])
  })

  it('structural_variants: rejects a non-SV dataset pin', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('structural_variants'),
        { gene_symbol: 'TP53', dataset: 'gnomad_r4' },
        {}
      )
    ).rejects.toThrow(/unknown dataset/)
  })

  // ---- get_structural_variant ---------------------------------------------------------------

  it('get_structural_variant: shapes consequences/algorithms/evidence and appends the dataset', async () => {
    const { out, query, variables } = await run(
      'get_structural_variant',
      { sv_id: 'BND_chr3_0f54dfa6' },
      {
        data: {
          structural_variant: {
            variant_id: 'BND_chr3_0f54dfa6',
            type: 'BND',
            filters: ['UNRESOLVED'],
            qual: 198,
            consequences: [{ consequence: 'promoter', genes: ['WRAP53', 'TP53'] }],
            algorithms: ['manta'],
            evidence: ['SR', 'PE']
          }
        }
      }
    )
    expect(query).toContain('query StructuralVariant(')
    expect(variables).toEqual({ variantId: 'BND_chr3_0f54dfa6', dataset: 'gnomad_sv_r4' })
    const rec = out as {
      found: boolean
      structural_variant: {
        consequences: Array<{ genes: string[] }>
        evidence: string[]
        dataset: string
      }
    }
    expect(rec.found).toBe(true)
    expect(rec.structural_variant.dataset).toBe('gnomad_sv_r4')
    // genes and evidence sorted for determinism.
    expect(rec.structural_variant.consequences[0].genes).toEqual(['TP53', 'WRAP53'])
    expect(rec.structural_variant.evidence).toEqual(['PE', 'SR'])
  })

  it('get_structural_variant: found=false with a null record when absent', async () => {
    const { out } = await run(
      'get_structural_variant',
      { sv_id: 'MISSING', dataset: 'gnomad_sv_r2_1' },
      { data: { structural_variant: null }, errors: [{ message: 'Structural variant not found' }] }
    )
    expect(out).toEqual({
      found: false,
      sv_id: 'MISSING',
      dataset: 'gnomad_sv_r2_1',
      structural_variant: null
    })
  })

  // ---- mitochondrial_variants ---------------------------------------------------------------

  it('mitochondrial_variants: gene path dispatches the gene query and shapes heteroplasmy rows', async () => {
    const { out, query, variables } = await run(
      'mitochondrial_variants',
      { gene_symbol: 'MT-TL1' },
      {
        data: {
          gene: {
            gene_id: 'ENSG00000209082',
            symbol: 'MT-TL1',
            mitochondrial_variants: [
              {
                variant_id: 'M-3232-T-A',
                pos: 3232,
                ac_het: 0,
                ac_hom: 0,
                an: 56433,
                max_heteroplasmy: 0,
                filters: ['No passing genotype']
              },
              {
                variant_id: 'M-3230-G-A',
                pos: 3230,
                ac_het: 1,
                ac_hom: 2,
                an: 56433,
                max_heteroplasmy: 0.5,
                filters: []
              }
            ]
          }
        }
      }
    )
    expect(query).toContain('query MitochondrialVariantsGene(')
    expect(variables).toEqual({ symbol: 'MT-TL1', geneId: null, dataset: 'gnomad_r4' })
    const rows = out as {
      gene_id: string
      n_variants: number
      variants: Array<{ variant_id: string; ac_het: number }>
    }
    expect(rows.gene_id).toBe('ENSG00000209082')
    expect(rows.variants.map((r) => r.variant_id)).toEqual(['M-3230-G-A', 'M-3232-T-A'])
  })

  it('mitochondrial_variants: region path dispatches the chrM region query and echoes the region', async () => {
    const { out, query, variables } = await run(
      'mitochondrial_variants',
      { region_start: 3200, region_stop: 3300 },
      { data: { region: { mitochondrial_variants: [] } } }
    )
    expect(query).toContain('query MitochondrialVariantsRegion(')
    expect(query).toContain('chrom: "M"')
    expect(variables).toEqual({ start: 3200, stop: 3300, dataset: 'gnomad_r4' })
    expect(out).toMatchObject({
      region: 'M:3200-3300',
      dataset: 'gnomad_r4',
      n_variants: 0,
      variants: []
    })
  })

  it('mitochondrial_variants: throws when a gene and a region are both given', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('mitochondrial_variants'),
        { gene_symbol: 'MT-TL1', region_start: 1, region_stop: 100 },
        {}
      )
    ).rejects.toThrow(/gene OR region, not both/)
  })

  it('mitochondrial_variants: throws when only one region bound is given', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('mitochondrial_variants'),
        { region_start: 3200 },
        {}
      )
    ).rejects.toThrow(/region_start and region_stop together/)
  })

  it.each([
    [{ region_start: 0, region_stop: 100 }, /region_start must be an integer between 1/],
    [
      { region_start: 101, region_stop: 100 },
      /region_start must be less than or equal to region_stop/
    ]
  ])(
    'mitochondrial_variants: rejects invalid region coordinates before dispatch',
    async (args, error) => {
      const fetchImpl = vi.fn()
      await expect(
        new ParserEngine({ fetchImpl }).call(tool('mitochondrial_variants'), args, {})
      ).rejects.toThrow(error)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('mitochondrial_variants: absent gene returns a compact empty result', async () => {
    const { out } = await run(
      'mitochondrial_variants',
      { gene_symbol: 'NOPE' },
      { data: { gene: null } }
    )
    expect(out).toMatchObject({ gene_id: null, symbol: 'NOPE', n_variants: 0, variants: [] })
  })

  // ---- shared error handling ----------------------------------------------------------------

  it('throws on a non-not-found GraphQL error (schema/complexity)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'query complexity too high' }] }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('gene_variants'), { gene_symbol: 'TTN' }, {})
    ).rejects.toThrow(/query complexity too high/)
  })
})
