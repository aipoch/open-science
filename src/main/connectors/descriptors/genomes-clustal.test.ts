import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../types'
import { GENOMES_CLUSTAL_TOOLS } from './genomes-clustal'

const [submit, status, results] = GENOMES_CLUSTAL_TOOLS
const credentials = { ncbiEmail: 'tests+clustal@example.org', ncbiApiKey: 'PRIVATE_KEY' }
const unused = async (): Promise<never> => {
  throw new Error('unexpected transport')
}
const ctx: ToolContext = {
  credentials,
  fetchJson: unused,
  fetchText: unused,
  fetchJsonWithHeaders: unused,
  postJson: unused,
  postForm: unused
}
const fasta = '>human\nMKTAYIAK\n>mouse\nMRTAYIAK\n>rat\nMRTAYIAK\n'
const jobId = 'clustalo-I20240923-000000-0000-0000000-p1m'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Clustal Omega submission', () => {
  it('submits a uniquely named FASTA set and returns a resumable job id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${jobId}\n`))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(submit.run!(ctx, { sequence: fasta, stype: 'protein' })).resolves.toEqual({
      job_id: jobId,
      status: 'QUEUED',
      ready: false,
      sequence_count: 3,
      sequence_type: 'protein',
      requested_format: 'clustal_num',
      poll_after_seconds: 10
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://www.ebi.ac.uk/Tools/services/rest/clustalo/run')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const body = new URLSearchParams(init!.body as string)
    expect(body.get('email')).toBe(credentials.ncbiEmail)
    expect(body.get('stype')).toBe('protein')
    expect(body.get('outfmt')).toBe('clustal_num')
    expect(body.get('sequence')).toBe(fasta)
    expect(body.toString()).not.toContain(credentials.ncbiApiKey)
  })

  it('requires a contact email before creating a remote job', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(
      submit.run!({ ...ctx, credentials: {} }, { sequence: fasta, stype: 'protein' })
    ).rejects.toThrow('contact_email_required')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['fewer than three records', '>a\nAAA\n>b\nAAA\n', 'at least three'],
    ['duplicate names', '>a\nAAA\n>a\nAAA\n>c\nAAA\n', 'unique'],
    ['raw sequence or identifiers', 'AAACCC,GGGTTT', 'FASTA'],
    ['empty FASTA line', '>a\nAAA\n\n>b\nAAA\n>c\nAAA\n', 'empty lines']
  ])('rejects %s locally', async (_label, sequence, message) => {
    const fetchImpl = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(submit.run!(ctx, { sequence, stype: 'dna' })).rejects.toThrow(message)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not echo credentials or resubmit after an uncertain response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${credentials.ncbiEmail} ${credentials.ncbiApiKey}`))
    vi.stubGlobal('fetch', fetchImpl)
    const error = await submit.run!(ctx, { sequence: fasta, stype: 'protein' }).catch(
      (value) => value
    )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('expected an Error')
    expect(error.message).toContain('clustalo_submission_unknown')
    expect(error.message).not.toContain(credentials.ncbiEmail)
    expect(error.message).not.toContain(credentials.ncbiApiKey)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reports an explicit HTTP rejection without calling it an uncertain submission', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 }))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(submit.run!(ctx, { sequence: fasta, stype: 'protein' })).rejects.toThrow(
      'clustalo_submission_rejected'
    )
  })
})

describe('Clustal Omega status and alignment results', () => {
  it.each(['QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'FAILURE', 'NOT_FOUND'])(
    'parses %s status without polling',
    async (value) => {
      const fetchText = vi.fn().mockResolvedValue(value)
      const out = await status.run!({ ...ctx, fetchText }, { job_id: jobId })
      expect(out).toMatchObject({ job_id: jobId, status: value, ready: value === 'FINISHED' })
      expect(fetchText).toHaveBeenCalledOnce()
    }
  )

  it('uses the exact result type and returns a file-ready alignment', async () => {
    const alignment =
      'CLUSTAL O(1.2.4) multiple sequence alignment\n\n' +
      'human  MKTAYIAK\nmouse  MRTAYIAK\nrat    MRTAYIAK\n'
    const fetchText = vi.fn().mockResolvedValue(alignment)
    const out = await results.run!({ ...ctx, fetchText }, { job_id: jobId, outfmt: 'clustal_num' })
    expect(out).toEqual({
      job_id: jobId,
      status: 'FINISHED',
      ready: true,
      format: 'clustal_num',
      filename: `clustalo-${jobId}.aln`,
      size_bytes: new TextEncoder().encode(alignment).byteLength,
      alignment
    })
    expect(fetchText).toHaveBeenCalledWith(
      `https://www.ebi.ac.uk/Tools/services/rest/clustalo/result/${jobId}/aln-clustal_num`,
      expect.stringContaining('text/plain'),
      { retry: false }
    )
  })

  it('rejects an HTML error page returned in place of an alignment', async () => {
    const fetchText = vi.fn().mockResolvedValue('<html><body>job failed</body></html>')
    await expect(
      results.run!({ ...ctx, fetchText }, { job_id: jobId, outfmt: 'clustal_num' })
    ).rejects.toThrow('invalid or error response')
  })

  it('returns a retryable status when the result endpoint is not ready', async () => {
    const fetchText = vi.fn().mockResolvedValue('RUNNING\n')
    await expect(
      results.run!({ ...ctx, fetchText }, { job_id: jobId, outfmt: 'clustal_num' })
    ).resolves.toEqual({
      job_id: jobId,
      status: 'RUNNING',
      ready: false,
      format: 'clustal_num',
      retry_after_seconds: 10
    })
  })

  it('does not report a provider failure as an alignment', async () => {
    const fetchText = vi.fn().mockResolvedValue('FAILURE\n')
    await expect(
      results.run!({ ...ctx, fetchText }, { job_id: jobId, outfmt: 'clustal_num' })
    ).rejects.toThrow('status FAILURE')
  })
})
