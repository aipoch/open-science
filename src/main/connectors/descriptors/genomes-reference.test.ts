import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENOMES_REFERENCE_TOOLS } from './genomes-reference'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): (typeof GENOMES_REFERENCE_TOOLS)[number] => {
  const found = GENOMES_REFERENCE_TOOLS.find((entry) => entry.id === id)
  if (!found) throw new Error(`no tool ${id}`)
  return found
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

describe('ncbi_resolve_taxon', () => {
  it('returns all upstream matches and marks ambiguous names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        total_count: 2,
        reports: [
          { taxonomy: { tax_id: 1, rank: 'SPECIES', current_scientific_name: { name: 'Alpha' } } },
          {
            taxonomy: {
              tax_id: 2,
              rank: 'SPECIES',
              current_scientific_name: { name: 'Beta' },
              curator_common_name: 'beta'
            }
          }
        ]
      })
    )
    const out = await run('ncbi_resolve_taxon', { query: 'ambiguous' }, fetchImpl)
    expect(out).toMatchObject({ query: 'ambiguous', n_matches: 2, ambiguous: true })
    expect((out as { matches: unknown[] }).matches).toHaveLength(2)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/taxonomy/taxon/ambiguous/dataset_report')
  })

  it('rejects an empty query before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(run('ncbi_resolve_taxon', { query: '  ' }, fetchImpl)).rejects.toThrow(
      /must not be empty/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('follows taxon pages before reporting ambiguity and output truncation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          reports: [{ taxonomy: { tax_id: 1, current_scientific_name: { name: 'Alpha' } } }],
          next_page_token: 'next'
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          reports: [{ taxonomy: { tax_id: 2, current_scientific_name: { name: 'Beta' } } }]
        })
      )
    await expect(
      run('ncbi_resolve_taxon', { query: 'shared', max_matches: 1 }, fetchImpl)
    ).resolves.toMatchObject({ n_matches: 2, ambiguous: true, matches_truncated: true })
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page_token=next')
  })
})

describe('ncbi_get_assembly_info', () => {
  it('requires a versioned accession and preserves paired assembly identity', async () => {
    const args = { assembly_accession: 'GCF_000001405.40' }
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        reports: [
          {
            accession: args.assembly_accession,
            current_accession: args.assembly_accession,
            paired_accession: 'GCA_000001405.29',
            organism: { tax_id: 9606, organism_name: 'Homo sapiens', common_name: 'human' },
            assembly_info: {
              assembly_name: 'GRCh38.p14',
              synonym: 'hg38',
              assembly_level: 'Chromosome',
              assembly_status: 'current',
              assembly_type: 'haploid-with-alt-loci',
              refseq_category: 'reference genome',
              release_date: '2022-02-03',
              paired_assembly: { accession: 'GCA_000001405.29' }
            }
          }
        ]
      })
    )
    await expect(run('ncbi_get_assembly_info', args, fetchImpl)).resolves.toMatchObject({
      accession: args.assembly_accession,
      tax_id: 9606,
      synonym: 'hg38',
      paired_accession: 'GCA_000001405.29'
    })
    expect(String(fetchImpl.mock.calls[0][0])).toContain('filters.assembly_version=all_assemblies')
  })

  it('rejects an unversioned accession before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('ncbi_get_assembly_info', { assembly_accession: 'GCF_000001405' }, fetchImpl)
    ).rejects.toThrow(/versioned NCBI accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('normalizes a report that omits current_accession', async () => {
    const accession = 'GCF_000002035.6'
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        reports: [
          {
            accession,
            organism: { tax_id: 7955, organism_name: 'Danio rerio' },
            assembly_info: { synonym: 'danRer11' }
          }
        ]
      })
    )
    await expect(
      run('ncbi_get_assembly_info', { assembly_accession: accession }, fetchImpl)
    ).resolves.toMatchObject({ accession, current_accession: accession, synonym: 'danRer11' })
  })

  it('preserves a newer current accession for a requested historical version', async () => {
    const accession = 'GCF_000002035.6'
    const current = 'GCF_000002035.7'
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        reports: [
          {
            accession,
            current_accession: current,
            organism: { tax_id: 7955, organism_name: 'Danio rerio' },
            assembly_info: { synonym: 'danRer11' }
          }
        ]
      })
    )
    await expect(
      run('ncbi_get_assembly_info', { assembly_accession: accession }, fetchImpl)
    ).resolves.toMatchObject({ accession, current_accession: current })
  })
})

describe('ncbi_get_sequence_aliases', () => {
  it('follows pages, resolves exact aliases, and does not conflate alt contigs', async () => {
    const accession = 'GCF_000001405.40'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          total_count: 1,
          reports: [
            {
              assembly_accession: accession,
              chr_name: '1',
              ucsc_style_name: 'chr1',
              sequence_name: '1',
              refseq_accession: 'NC_000001.11',
              genbank_accession: 'CM000663.2',
              length: 248956422,
              role: 'assembled-molecule'
            },
            {
              assembly_accession: accession,
              chr_name: '1',
              ucsc_style_name: 'chr1_KI270706v1_random',
              sequence_name: 'HSCHR1_CTG1_UNLOCALIZED',
              refseq_accession: 'NT_187361.1',
              length: 175055,
              role: 'unlocalized-scaffold'
            }
          ],
          next_page_token: 'next'
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          reports: [
            {
              assembly_accession: accession,
              chr_name: '2',
              ucsc_style_name: 'chr2',
              sequence_name: '2',
              refseq_accession: 'NC_000002.12',
              length: 242193529,
              role: 'assembled-molecule'
            }
          ]
        })
      )
    const out = (await run(
      'ncbi_get_sequence_aliases',
      { assembly_accession: accession, sequence: '1' },
      fetchImpl
    )) as {
      n_sequences: number
      upstream_total_count: number
      sequences: Array<{ ucsc_style_name: string }>
    }
    expect(out.n_sequences).toBe(3)
    expect(out.upstream_total_count).toBe(1)
    expect((out as unknown as { n_matches: number }).n_matches).toBe(1)
    expect(out.sequences.map((x) => x.ucsc_style_name)).toEqual(['chr1'])
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page_token=next')
  })

  it('keeps a shared chr_name ambiguous when it is not the assembled molecule', async () => {
    const accession = 'GCF_000001405.40'
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        total_count: 1,
        reports: [
          {
            assembly_accession: accession,
            chr_name: '1',
            ucsc_style_name: 'chr1_random',
            sequence_name: 'random',
            length: 10,
            role: 'unlocalized-scaffold'
          }
        ]
      })
    )
    const out = (await run(
      'ncbi_get_sequence_aliases',
      { assembly_accession: accession, sequence: '1' },
      fetchImpl
    )) as {
      sequences: unknown[]
    }
    expect(out.sequences).toHaveLength(0)
  })
})
