import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { ENCORI_TOOLS } from './encori'
import { defaultFileDurability } from '../../storage/file-durability'
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../skills/net-fetch', () => ({ netFetchStandard: fetchMock }))
let directory: string
const call = (id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const descriptor = ENCORI_TOOLS.find((tool) => tool.id === id)!
  return new ParserEngine({ retries: 0 }).call(descriptor, args, {}) as Promise<
    Record<string, unknown>
  >
}
const mirnaArgs = {
  assembly: 'hg38',
  gene_type: 'mRNA',
  mirna: 'all',
  clip_exp_num: 1,
  degra_exp_num: 0,
  pancancer_num: 0,
  program_num: 1,
  program: 'TargetScan',
  target: 'PDCD4',
  cell_type: 'HeLa'
}
const response = '# official citation\ngeneName\tcellType\nPDCD4\tHeLa\nTP53\tHeLa\nMYC\tHeLa\n'
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'encori-test-'))
  fetchMock.mockReset()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('ENCORI official response contracts', () => {
  it.each([
    ["parameter haven't been set correctly", 'upstream_parameter_error'],
    ['<b>Warning</b>: missing reference file. Unable to open file!', 'upstream_response_error'],
    ['<!doctype html><html>Service unavailable</html>', 'upstream_response_error']
  ])('distinguishes parameter rejection from a service error: %s', async (body, code) => {
    fetchMock.mockResolvedValue(new Response(body))
    const result = await call('query_mirna_targets', { ...mirnaArgs, output_dir: directory })
    expect(result).toMatchObject({ ok: false, error: { code, status_code: 200 } })
    expect(await readdir(directory)).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('does not publish a raw response when cancelled during the file durability barrier', async () => {
    const controller = new AbortController()
    const syncFile = defaultFileDurability.syncFile
    vi.spyOn(defaultFileDurability, 'syncFile').mockImplementation(async (path) => {
      await syncFile(path)
      controller.abort(new Error('cancel raw response'))
    })
    fetchMock.mockResolvedValue(new Response(response))
    const descriptor = ENCORI_TOOLS.find((tool) => tool.id === 'query_mirna_targets')!
    await expect(
      new ParserEngine().call(
        descriptor,
        { ...mirnaArgs, output_dir: directory },
        {},
        controller.signal
      )
    ).rejects.toThrow('cancel raw response')
    // The engine rejects immediately; wait for its descriptor to finish private-file cleanup.
    await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]))
  })
  it.each([
    [
      'query_rna_rna_interactions',
      {
        assembly: 'hg38',
        gene_type: 'mRNA',
        rna: 'TP53',
        inter_num: 1,
        exp_num: 1,
        cell_type: 'all'
      },
      { RNA: 'TP53', cellType: 'all', interNum: '1', expNum: '1' }
    ],
    [
      'query_rbp_targets',
      {
        assembly: 'hg38',
        gene_type: 'mRNA',
        rbp: 'all',
        clip_exp_num: 1,
        pancancer_num: 0,
        target: 'TP53',
        cell_type: 'HeLa'
      },
      { RBP: 'all', cellType: 'HeLa', target: 'TP53' }
    ],
    [
      'query_rbp_disease',
      { assembly: 'hg38', rbp: 'all', tissue: 'breast', disease: 'carcinoma', target: 'MYC' },
      { tissue: 'breast', disease: 'carcinoma', target: 'MYC' }
    ]
  ] as const)('preserves official request parameters for %s', async (method, args, expected) => {
    fetchMock.mockResolvedValue(new Response(response))
    await call(method, { ...args, output_dir: directory })
    const params = new URL(fetchMock.mock.calls[0][0]).searchParams
    for (const [key, value] of Object.entries(expected)) expect(params.get(key)).toBe(value)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('makes one query, preserves all and HeLa, and saves exact bytes even when previewed', async () => {
    const bytes = Buffer.from('\uFEFF' + response)
    fetchMock.mockResolvedValue(new Response(bytes))
    const result = await call('query_mirna_targets', {
      ...mirnaArgs,
      max_records: 2,
      output_dir: directory
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.searchParams.get('miRNA')).toBe('all')
    expect(url.searchParams.get('cellType')).toBe('HeLa')
    expect(url.searchParams.get('program')).toBe('TargetScan')
    expect(result.total_records).toBe(3)
    expect(result.returned_records).toBe(2)
    expect(result.is_complete).toBe(false)
    expect(await readFile(String(result.raw_response_path))).toEqual(bytes)
  })
  it('returns header-only zero rows without widening the query', async () => {
    fetchMock.mockResolvedValue(new Response('geneName\tcellType\n'))
    const result = await call('query_mirna_targets', { ...mirnaArgs, output_dir: directory })
    expect(result.total_records).toBe(0)
    expect(result.is_complete).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readFile(String(result.raw_response_path), 'utf8')).toBe('geneName\tcellType\n')
  })
  it('still saves the complete original response for an ordinary query', async () => {
    fetchMock.mockResolvedValue(new Response(response))
    const result = await call('query_mirna_targets', { ...mirnaArgs, output_dir: directory })
    expect(result).toMatchObject({
      ok: true,
      total_records: 3,
      returned_records: 3,
      is_complete: true
    })
    expect(await readFile(String(result.raw_response_path), 'utf8')).toBe(response)
    expect(result.completeness_note).toContain('saved locally')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it.each([
    new Response('failure', { status: 503 }),
    new Response("Parameter haven't been set correctly"),
    new Response('<html>error</html>'),
    new Response('<br />\n<b>Warning</b>: fopen(): missing file\nUnable to open file!')
  ])('does not report an upstream failure as an empty success', async (reply) => {
    fetchMock.mockImplementation(async () => reply.clone())
    expect(
      await call('query_mirna_targets', { ...mirnaArgs, output_dir: directory })
    ).toMatchObject({
      ok: false,
      error: {
        code: expect.any(String),
        retryable: expect.any(Boolean),
        status_code: expect.anything()
      }
    })
  })
  it('rejects unsupported prediction programs before contacting the server', async () => {
    expect(await call('query_mirna_targets', { ...mirnaArgs, program: 'all' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('retains official motif order and independent sequence fields', async () => {
    fetchMock.mockResolvedValue(
      new Response('Rank\tQueryMotif\tIdentifiedMotif\n2\tUGCAUG\tTGCATG\n1\tUGCAUG\tOTHER\n')
    )
    const result = await call('scan_rbp_motifs', {
      assembly: 'hg38',
      length: 'short',
      motif: 'UGCAUG',
      rank_limit: 10,
      output_dir: directory
    })
    expect(result.records).toEqual([
      { Rank: '2', QueryMotif: 'UGCAUG', IdentifiedMotif: 'TGCATG' },
      { Rank: '1', QueryMotif: 'UGCAUG', IdentifiedMotif: 'OTHER' }
    ])
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('No reverse complement')])
    )
  })
  it('does not invent ceRNA family names or change probabilities', async () => {
    fetchMock.mockResolvedValue(
      new Response('hitMiRNAFamilyNum\thitMiRNAFamily\tpval\tfdr\n3\t\t0.0004\t0.002\n')
    )
    const result = await call('query_cerna_network', {
      assembly: 'hg38',
      gene_type: 'mRNA',
      cerna: 'MYC',
      mirna_num: 1,
      family: 'all',
      pval: 0.01,
      fdr: 0.01,
      pancancer_num: 0,
      output_dir: directory
    })
    expect(result.records).toEqual([
      { hitMiRNAFamilyNum: '3', hitMiRNAFamily: '', pval: '0.0004', fdr: '0.002' }
    ])
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('No family names')])
    )
  })
  it('removes only known SQL prefix from BED and retains exact raw content', async () => {
    const raw =
      'SELECT DISTINCT `DataSetId` FROM `hg38_clipRef`#please cite:\nchr1\t10\t20\tSBDH2131\t5\t+\n'
    fetchMock.mockResolvedValue(new Response(raw))
    const result = await call('get_binding_sites', {
      assembly: 'hg38',
      dataset_id: 'SBDH2131',
      output_dir: directory
    })
    expect(result.total_records).toBe(1)
    expect(result.removed_prefix_lines).toEqual([
      'SELECT DISTINCT `DataSetId` FROM `hg38_clipRef`#please cite:'
    ])
    expect(await readFile(String(result.raw_response_path), 'utf8')).toBe(raw)
  })
  it.each(['unexpected prefix\nchr1\t10\t20\tx\t1\t+\n', 'chr1\t10\t20\tx\t1\t+\nbroken row\n'])(
    'rejects unexplained or trailing malformed BED content',
    async (raw) => {
      fetchMock.mockResolvedValue(new Response(raw))
      expect(
        await call('get_binding_sites', {
          assembly: 'hg38',
          dataset_id: 'SBDH2131',
          output_dir: directory
        })
      ).toMatchObject({ ok: false, error: { code: 'unexpected_response' } })
    }
  )
  it('lists exact online reference names and reads a headerless degradome table in a fresh call', async () => {
    const table =
      '\uFEFFSBDH1\thuman\thg19\tdegradome\tHeLa\r\nSBDH2\tmouse\tmm10\tdegradome\tliver\r\n'
    const zip = zipSync({ 'reference_data/degradome_ref.txt': strToU8(table) })
    fetchMock.mockImplementation(async () => new Response(Buffer.from(zip)))
    const listing = await call('get_reference_tables', {})
    expect(listing.table_names).toEqual(['reference_data/degradome_ref.txt'])
    expect(listing.records).toEqual([])
    const result = await call('get_reference_tables', {
      table_name: 'reference_data/degradome_ref.txt',
      max_records: 1,
      output_dir: directory
    })
    expect(result.total_records).toBe(2)
    expect(result.records).toEqual([
      {
        dataset_id: 'SBDH1',
        species: 'human',
        assembly: 'hg19',
        seq_type: 'degradome',
        cell_tissue: 'HeLa'
      }
    ])
    expect(await readFile(String(result.raw_response_path), 'utf8')).toBe(table)
    expect(result).toMatchObject({
      is_complete: false,
      returned_records: 1,
      result_scope: 'partial'
    })
    expect(result.saved_path).toBe(result.raw_response_path)
    expect(await readFile(String(result.raw_response_path))).toEqual(Buffer.from(table))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('reads a complete reference table with an unusable output directory but fails if truncation requires saving', async () => {
    const selected = 'reference_data/degradome_ref.txt'
    const table = 'SBDH1\thuman\thg19\tdegradome\tHeLa\nSBDH2\tmouse\tmm10\tdegradome\tliver\n'
    const zip = zipSync({ [selected]: strToU8(table) })
    const output = join(directory, 'existing-file')
    await writeFile(output, 'preserve this file')
    fetchMock.mockImplementation(async () => new Response(Buffer.from(zip)))
    const result = await call('get_reference_tables', {
      table_name: selected,
      max_records: 2,
      output_dir: output
    })
    expect(result).toMatchObject({
      ok: true,
      total_records: 2,
      returned_records: 2,
      is_complete: true,
      result_scope: 'complete',
      raw_response_path: null,
      saved_path: null,
      warnings: []
    })
    expect(result.records).toHaveLength(2)
    expect(result.completeness_note).toContain('No local file was saved')
    expect(
      await call('get_reference_tables', {
        table_name: selected,
        max_records: 1,
        output_dir: output
      })
    ).toMatchObject({ ok: false, error: { code: 'file_write_error' } })
    expect(await readFile(output, 'utf8')).toBe('preserve this file')
    expect(await readdir(directory)).toEqual(['existing-file'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['<html>Service unavailable</html>', 'upstream_response_error'],
    ['invalid reference table', 'unexpected_response']
  ])('rejects invalid reference content without saving it: %s', async (table, code) => {
    const selected = 'reference_data/degradome_ref.txt'
    const zip = zipSync({ [selected]: strToU8(table) })
    fetchMock.mockResolvedValue(new Response(Buffer.from(zip)))
    expect(
      await call('get_reference_tables', {
        table_name: selected,
        max_records: 1,
        output_dir: directory
      })
    ).toMatchObject({ ok: false, error: { code } })
    expect(await readdir(directory)).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('rejects oversized query replies before reading them', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { headers: { 'content-length': String(65 * 1024 ** 2) } })
    )
    expect(
      await call('query_mirna_targets', { ...mirnaArgs, output_dir: directory })
    ).toMatchObject({ ok: false, error: { code: 'response_too_large' } })
  })
  it('lists reference metadata and reads one table without inflating an oversized unrelated entry', async () => {
    const selected = 'reference_data/degradome_ref.txt'
    const other = 'reference_data/large.txt'
    const table = 'SBDH1\thuman\thg19\tdegradome\tHeLa\n'
    const zip = Buffer.from(zipSync({ [selected]: strToU8(table), [other]: strToU8('unused') }))
    // Advertise a large uncompressed entry without allocating its contents in this fixture.
    for (let offset = 0; offset + 46 <= zip.length; offset++) {
      if (zip.readUInt32LE(offset) !== 0x02014b50) continue
      const nameLength = zip.readUInt16LE(offset + 28)
      if (zip.toString('utf8', offset + 46, offset + 46 + nameLength) === other)
        zip.writeUInt32LE(65 * 1024 ** 2, offset + 24)
    }
    fetchMock.mockImplementation(async () => new Response(zip))
    const listing = await call('get_reference_tables', {})
    expect(listing).toMatchObject({ ok: true, table_names: [selected, other], records: [] })
    expect(listing.files).toContainEqual(
      expect.objectContaining({ table_name: other, size_bytes: 65 * 1024 ** 2 })
    )
    expect(await readdir(directory)).toEqual([])
    const result = await call('get_reference_tables', {
      table_name: selected,
      output_dir: directory
    })
    expect(result).toMatchObject({
      ok: true,
      total_records: 1,
      raw_response_path: null,
      saved_path: null
    })
    expect(await readdir(directory)).toEqual([])
    expect(await call('get_reference_tables', { table_name: other })).toMatchObject({
      ok: false,
      error: { code: 'response_too_large' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
