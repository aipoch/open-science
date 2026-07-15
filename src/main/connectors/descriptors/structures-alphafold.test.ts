import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_ALPHAFOLD_TOOLS } from './structures-alphafold'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => STRUCTURES_ALPHAFOLD_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// Mirrors the engine's non-ok path: it throws `HTTP <status> for <url>`. 404/400 fail fast (not
// retried), so the tools recover the status from the message.
const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null }
  }) as unknown as Response

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

// One live-shaped AlphaFold model record (fields transcribed from P04637).
const p04637Model = {
  toolUsed: 'AlphaFold Monomer v2.0 pipeline',
  providerId: 'GDM',
  modelEntityId: 'AF-P04637-F1',
  modelCreatedDate: '2025-08-01T00:00:00Z',
  globalMetricValue: 75.06,
  fractionPlddtVeryLow: 0.298,
  fractionPlddtLow: 0.104,
  fractionPlddtConfident: 0.071,
  fractionPlddtVeryHigh: 0.527,
  latestVersion: 6,
  allVersions: [1, 2, 3, 4, 5, 6],
  isUniProtReviewed: true,
  isReferenceProteome: true,
  isComplex: false,
  gene: 'TP53',
  uniprotAccession: 'P04637',
  uniprotId: 'P53_HUMAN',
  uniprotDescription: 'Cellular tumor antigen p53',
  taxId: 9606,
  organismScientificName: 'Homo sapiens',
  uniprotStart: 1,
  uniprotEnd: 393,
  entryId: 'AF-P04637-F1',
  // Live serves the sequence under `uniprotSequence`, not `sequence`.
  uniprotSequence: 'MEEPQSD',
  cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
  bcifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.bcif',
  pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.pdb',
  paeImageUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-predicted_aligned_error_v6.png',
  paeDocUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-predicted_aligned_error_v6.json',
  plddtDocUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-confidence_v6.json',
  msaUrl: 'https://alphafold.ebi.ac.uk/files/msa/AF-P04637-F1-msa_v6.a3m',
  amAnnotationsUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-aa-substitutions.csv'
}

describe('alphafold_get_prediction', () => {
  it('builds the /prediction URL and maps a model with pLDDT bins and URL block', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([p04637Model]))
    const out = (await run(
      'alphafold_get_prediction',
      { uniprot_accession: '  P04637  ' },
      fetchImpl
    )) as {
      uniprot_accession: string
      has_model: boolean
      n_models: number
      models: Array<Record<string, unknown>>
    }
    // Accession is trimmed before the request.
    expect(fetchImpl.mock.calls[0][0]).toBe('https://alphafold.ebi.ac.uk/api/prediction/P04637')
    expect(out.uniprot_accession).toBe('P04637')
    expect(out.has_model).toBe(true)
    expect(out.n_models).toBe(1)
    const m = out.models[0]
    expect(m.model_entity_id).toBe('AF-P04637-F1')
    expect(m.gene).toBe('TP53')
    expect(m.global_plddt).toBe(75.06)
    expect(m.sequence_length).toBe(7) // derived from uniprotSequence 'MEEPQSD'
    expect(m.all_versions).toEqual([1, 2, 3, 4, 5, 6])
    expect(m.fraction_plddt).toEqual({
      very_low: 0.298,
      low: 0.104,
      confident: 0.071,
      very_high: 0.527
    })
    expect(m.urls).toEqual({
      cif: p04637Model.cifUrl,
      bcif: p04637Model.bcifUrl,
      pdb: p04637Model.pdbUrl,
      pae_image: p04637Model.paeImageUrl,
      pae_json: p04637Model.paeDocUrl,
      plddt_json: p04637Model.plddtDocUrl,
      msa: p04637Model.msaUrl,
      alphamissense_csv: p04637Model.amAnnotationsUrl
    })
    // Sequence is not included unless requested.
    expect('sequence' in m).toBe(false)
  })

  it('reports n_models for an accession carrying several models (isoforms/providers)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes([p04637Model, { ...p04637Model, modelEntityId: 'AF-P04637-9-F1', providerId: 'X' }])
      )
    const out = (await run(
      'alphafold_get_prediction',
      { uniprot_accession: 'P04637' },
      fetchImpl
    )) as { n_models: number; models: Array<Record<string, unknown>> }
    expect(out.n_models).toBe(2)
    expect(out.models[1].model_entity_id).toBe('AF-P04637-9-F1')
    expect(out.models[1].provider_id).toBe('X')
  })

  it('include_sequence adds the model sequence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([p04637Model]))
    const out = (await run(
      'alphafold_get_prediction',
      { uniprot_accession: 'P04637', include_sequence: true },
      fetchImpl
    )) as { models: Array<Record<string, unknown>> }
    expect(out.models[0].sequence).toBe('MEEPQSD')
  })

  it('returns has_model=false (not an error) when the accession has no prediction (404)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(404))
    const out = (await run(
      'alphafold_get_prediction',
      { uniprot_accession: 'P00001' },
      fetchImpl
    )) as Record<string, unknown>
    expect(out).toEqual({
      uniprot_accession: 'P00001',
      has_model: false,
      n_models: 0,
      models: []
    })
  })

  it('returns an explicit error field for a malformed accession (400)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(400))
    const out = (await run(
      'alphafold_get_prediction',
      { uniprot_accession: 'Q0Q0Q0Q0Q0' },
      fetchImpl
    )) as { has_model: boolean; models: unknown[]; error: string }
    expect(out.has_model).toBe(false)
    expect(out.models).toEqual([])
    expect(out.error).toMatch(/^invalid_accession: /)
  })
})

describe('alphafold_check_coverage', () => {
  it('strips blanks/duplicates so n_requested reconciles, and emits per-accession records', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/prediction/P04637')) return Promise.resolve(jsonRes([p04637Model]))
      if (url.includes('/prediction/P00001')) return Promise.resolve(errRes(404))
      if (url.includes('/prediction/Q0Q0Q0Q0Q0')) return Promise.resolve(errRes(400))
      return Promise.resolve(errRes(404))
    })
    const out = (await run(
      'alphafold_check_coverage',
      { uniprot_accessions: ['P04637', 'P04637', '', '   ', 'P00001', 'Q0Q0Q0Q0Q0'] },
      fetchImpl
    )) as {
      n_requested: number
      n_unique: number
      n_blank_skipped: number
      n_duplicate_skipped: number
      not_processed: string[]
      records: Array<Record<string, unknown>>
    }
    // Reconciliation invariant.
    expect(out.n_requested).toBe(6)
    expect(out.n_unique).toBe(3)
    expect(out.n_blank_skipped).toBe(2)
    expect(out.n_duplicate_skipped).toBe(1)
    expect(out.n_requested).toBe(out.n_unique + out.n_blank_skipped + out.n_duplicate_skipped)
    expect(out.not_processed).toEqual([])
    // One record per unique accession, in input order.
    expect(out.records.map((r) => r.uniprot_accession)).toEqual(['P04637', 'P00001', 'Q0Q0Q0Q0Q0'])
    expect(out.records[0]).toEqual({
      uniprot_accession: 'P04637',
      has_model: true,
      n_models: 1,
      model_entity_id: 'AF-P04637-F1',
      latest_version: 6,
      global_plddt: 75.06,
      sequence_length: 7
    })
    // No prediction -> has_model=false, no error.
    expect(out.records[1]).toEqual({ uniprot_accession: 'P00001', has_model: false })
    // Malformed -> explicit error field, never dropped.
    expect(out.records[2].has_model).toBe(false)
    expect(out.records[2].error).toMatch(/^invalid_accession: /)
  })

  it('throws when more than 40 unique accessions are requested', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([p04637Model]))
    const many = Array.from({ length: 41 }, (_, i) => `ACC${i}`)
    await expect(
      run('alphafold_check_coverage', { uniprot_accessions: many }, fetchImpl)
    ).rejects.toThrow(/max 40 per call/)
  })
})
