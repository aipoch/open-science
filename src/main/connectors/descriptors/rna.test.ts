import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ParserEngine } from '../engine'
import { RNA_TOOLS } from './rna'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => RNA_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('rna / rfam', () => {
  it('exposes exactly the 9 upstream tool ids', () => {
    expect(RNA_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'accession_to_id',
        'get_covariance_model',
        'get_family',
        'get_seed_alignment',
        'get_sequence_regions',
        'get_structure_mapping',
        'get_tree',
        'id_to_accession',
        'search_sequence'
      ].sort()
    )
    expect(RNA_TOOLS.every((t) => t.connector === 'rna')).toBe(true)
    expect(RNA_TOOLS.every((t) => t.returns && t.example)).toBe(true)
  })

  it('get_family flattens the envelope, reads cm.cutoffs, and keeps raw', async () => {
    const rfam = {
      acc: 'RF00005',
      id: 'tRNA',
      description: 'tRNA',
      comment: 'Transfer RNA',
      clan: { id: null, acc: null },
      curation: {
        type: 'Gene; tRNA;',
        num_seed: '954',
        num_full: '5335975',
        num_species: '14413',
        structure_source: 'Published; PMID:8256282'
      },
      cm: { cutoffs: { trusted: 29.0, gathering: 29.0, noise: 28.9 } },
      release: { number: '15.1', date: '2026-01-16' }
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ rfam }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_family'),
      { family: 'RF00005' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00005?content-type=application/json'
    )
    expect(out).toMatchObject({
      rfam_acc: 'RF00005',
      rfam_id: 'tRNA',
      description: 'tRNA',
      comment: 'Transfer RNA',
      clan_acc: null,
      clan_id: null,
      rna_type: 'Gene; tRNA;',
      structure_source: 'Published; PMID:8256282',
      num_seed: 954,
      num_full: 5335975,
      num_species: 14413,
      gathering_cutoff: 29.0,
      trusted_cutoff: 29.0,
      noise_cutoff: 28.9,
      release_number: '15.1',
      release_date: '2026-01-16'
    })
    // raw carries the whole upstream rfam record
    expect(out.raw).toEqual(rfam)
  })

  it('get_family accepts a family id and tolerates missing sub-objects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ rfam: { acc: 'RF00005', id: 'tRNA', description: 'tRNA' } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_family'),
      { family: 'tRNA' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/tRNA?content-type=application/json'
    )
    expect(out).toMatchObject({
      rfam_acc: 'RF00005',
      rfam_id: 'tRNA',
      num_seed: null,
      gathering_cutoff: null,
      trusted_cutoff: null,
      noise_cutoff: null
    })
  })

  it('get_seed_alignment (stockholm) returns names, counts and sha256', async () => {
    const align = '# STOCKHOLM 1.0\n#=GF AC RF00162\nSEQ1 ACGU\nSEQ2 ACGA\nSEQ1 UUUU\n//\n'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(align))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_seed_alignment'),
      { family: 'RF00162' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/alignment?content-type=text/plain'
    )
    expect(out).toEqual({
      family: 'RF00162',
      format: 'stockholm',
      num_sequences: 2,
      sequence_names: ['SEQ1', 'SEQ2'],
      sha256: sha(align),
      alignment: align
    })
  })

  it('get_seed_alignment (fasta) hits the /fasta route and parses > names', async () => {
    const align = '>AF027868.1/5245-5154 desc\nACGU\n>X12345.1/1-4\nUGCA\n'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(align))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_seed_alignment'),
      { family: 'RF00162', fmt: 'fasta' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/alignment/fasta?content-type=text/plain'
    )
    expect(out.format).toBe('fasta')
    expect(out.sequence_names).toEqual(['AF027868.1/5245-5154', 'X12345.1/1-4'])
    expect(out.num_sequences).toBe(2)
  })

  it('get_seed_alignment omits the body past max_bytes but keeps sha256/counts', async () => {
    const align = 'SEQ1 ' + 'A'.repeat(5000) + '\nSEQ2 ' + 'C'.repeat(5000) + '\n'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(align))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_seed_alignment'),
      { family: 'RF00005', max_bytes: 1000 },
      {}
    )) as Record<string, unknown>
    expect(out.alignment).toBeUndefined()
    expect(out.alignment_omitted).toContain('max_bytes=1000')
    expect(out.size_bytes).toBe(Buffer.byteLength(align))
    expect(out.sha256).toBe(sha(align))
    expect(out.num_sequences).toBe(2)
    expect(out.sequence_names).toEqual(['SEQ1', 'SEQ2'])
  })

  it('get_covariance_model parses the header and always returns size_bytes/sha256', async () => {
    const cm = [
      'INFERNAL1/a [1.1.4 | Dec 2020]',
      'NAME     SAM',
      'ACC      RF00162',
      'DESC     SAM riboswitch',
      'STATES   338',
      'NODES    85',
      'CLEN     108',
      'W        186',
      'ALPH     RNA',
      'CM',
      '  [ model matrix ]',
      '//'
    ].join('\n')
    const fetchImpl = vi.fn().mockResolvedValue(textRes(cm))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_covariance_model'),
      { family: 'RF00162' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/cm?content-type=text/plain'
    )
    expect(out.header).toEqual({
      NAME: 'SAM',
      ACC: 'RF00162',
      DESC: 'SAM riboswitch',
      STATES: 338,
      NODES: 85,
      CLEN: 108,
      W: 186,
      ALPH: 'RNA'
    })
    expect(out.size_bytes).toBe(Buffer.byteLength(cm))
    expect(out.sha256).toBe(sha(cm))
    expect(out.cm).toBe(cm)
  })

  it('get_covariance_model omits cm past max_bytes, header/size/sha256 survive', async () => {
    const cm = 'NAME  SAM\nACC   RF00162\nCLEN  108\nCM\n' + 'x'.repeat(5000)
    const fetchImpl = vi.fn().mockResolvedValue(textRes(cm))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_covariance_model'),
      { family: 'RF00162', max_bytes: 500 },
      {}
    )) as Record<string, unknown>
    expect(out.cm).toBeUndefined()
    expect(out.cm_omitted).toContain('max_bytes=500')
    expect(out.size_bytes).toBe(Buffer.byteLength(cm))
    expect(out.sha256).toBe(sha(cm))
    expect(out.header).toMatchObject({ NAME: 'SAM', ACC: 'RF00162', CLEN: 108 })
  })

  it('get_tree counts leaf labels and returns sha256', async () => {
    const tree = '((A:0.1,B:0.2)0.9:0.3,C:0.4);'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(tree))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_tree'),
      { family: 'RF00162' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/tree?content-type=text/plain'
    )
    expect(out.num_leaf_labels).toBe(3)
    expect(out.sha256).toBe(sha(tree))
    expect(out.tree).toBe(tree)
  })

  it('get_sequence_regions parses declared_count and TSV rows', async () => {
    const tsv = [
      '# Rfam regions for family SAM (RF00162)',
      '# file built 05:11:37 15-Jul-2026 using Rfam version 15.1',
      '# found 9625 regions',
      '# columns: ...',
      'FOYF01000003.1\t108.7\t195245\t195351\tBacillus sp. cl95\tBacillus sp. cl95\t1761761',
      'CP042243.1\t108.1\t950145\t950256\tCrassaminicella\tCrassaminicella thermophila\t2599308'
    ].join('\n')
    const fetchImpl = vi.fn().mockResolvedValue(textRes(tsv))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_sequence_regions'),
      { family: 'RF00162' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/regions?content-type=text/plain'
    )
    expect(out.declared_count).toBe(9625)
    expect(out.num_regions).toBe(2)
    expect((out.regions as Record<string, string>[])[0]).toEqual({
      sequence_accession: 'FOYF01000003.1',
      bits_score: '108.7',
      region_start: '195245',
      region_end: '195351',
      sequence_description: 'Bacillus sp. cl95',
      species: 'Bacillus sp. cl95',
      ncbi_tax_id: '1761761'
    })
  })

  it('get_sequence_regions surfaces an upstream 403 as-is', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Headers() })
    await expect(
      new ParserEngine({ fetchImpl, retries: 0 }).call(
        tool('get_sequence_regions'),
        { family: 'RF00005' },
        {}
      )
    ).rejects.toThrow('HTTP 403')
  })

  it('get_structure_mapping sorts rows deterministically and collects pdb ids', async () => {
    const mapping = [
      { pdb_id: '5fkf', chain: 'A', pdb_start: 1, pdb_end: 93, cm_start: 1, cm_end: 108 },
      { pdb_id: '3gx5', chain: 'A', pdb_start: 1, pdb_end: 93, cm_start: 1, cm_end: 108 },
      { pdb_id: '3gx5', chain: 'B', pdb_start: 1, pdb_end: 93, cm_start: 1, cm_end: 108 }
    ]
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ mapping }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_structure_mapping'),
      { family: 'RF00162' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00162/structures?content-type=application/json'
    )
    expect(out.num_mappings).toBe(3)
    expect(out.num_pdb_ids).toBe(2)
    expect(out.pdb_ids).toEqual(['3gx5', '5fkf'])
    // sorted by (pdb_id, chain, ...): 3gx5/A, 3gx5/B, 5fkf/A
    expect((out.mapping as Record<string, unknown>[]).map((m) => `${m.pdb_id}/${m.chain}`)).toEqual(
      ['3gx5/A', '3gx5/B', '5fkf/A']
    )
  })

  it('get_structure_mapping tolerates an empty mapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({}))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_structure_mapping'),
      { family: 'RF99999' },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({ num_mappings: 0, num_pdb_ids: 0, pdb_ids: [], mapping: [] })
  })

  it('accession_to_id resolves RF##### -> id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('tRNA\n'))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('accession_to_id'),
      { accession: 'RF00005' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00005/id?content-type=text/plain'
    )
    expect(out).toEqual({ accession: 'RF00005', rfam_id: 'tRNA' })
  })

  it('id_to_accession resolves id -> RF##### and validates the shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('RF00005\n'))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('id_to_accession'),
      { family_id: 'tRNA' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/tRNA/acc?content-type=text/plain'
    )
    expect(out).toEqual({ rfam_id: 'tRNA', accession: 'RF00005' })
  })

  it('id_to_accession throws when no accession resolves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('not-an-accession\n'))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('id_to_accession'), { family_id: 'nope' }, {})
    ).rejects.toThrow('no accession resolved')
  })

  it('search_sequence submits then polls until hits are present', async () => {
    const hits = {
      SAM: [{ E: 1e-10, score: 80 }],
      tRNA: [
        { E: 1e-5, score: 40 },
        { E: 2e-5, score: 38 }
      ]
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ jobId: 'job-1', resultURL: 'https://rfam.org/search/result/job-1' })
      )
      .mockResolvedValueOnce(jsonRes({ status: 'PEND' }))
      .mockResolvedValueOnce(jsonRes({ searchSequence: 'GGUUCC', hits }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('search_sequence'),
      { sequence: 'GGUUCC', poll_interval_s: 0, max_wait_s: 5 },
      {}
    )) as Record<string, unknown>
    // First call POSTs the sequence, subsequent calls poll the resultURL
    expect(fetchImpl.mock.calls[0][0]).toBe('https://rfam.org/search/sequence')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(fetchImpl.mock.calls[1][0]).toBe('https://rfam.org/search/result/job-1')
    expect(out).toEqual({
      job_id: 'job-1',
      num_hits: 3,
      families: ['SAM', 'tRNA'],
      hits,
      search_sequence: 'GGUUCC'
    })
  })

  it('search_sequence surfaces a submit-side error as-is (backend down)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers() })
    await expect(
      new ParserEngine({ fetchImpl, retries: 0 }).call(
        tool('search_sequence'),
        { sequence: 'GGUUCC' },
        {}
      )
    ).rejects.toThrow('HTTP 500')
  })
})
