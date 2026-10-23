import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { GENOMES_ENSEMBL_TOOLS } from './genomes-ensembl'

const registry = createConnectorRegistry(GENOMES_ENSEMBL_TOOLS)
const tool = registry.getDescriptor('genomes', 'ensembl_recode_variant')!
const args = { variant: 'rs699', max_notations: 1 }
const allele = {
  input: 'rs699',
  id: ['rs699', 'COSV64184214'],
  hgvsg: ['NC_000001.11:g.230710048A>G'],
  hgvsc: ['ENST00000366667.6:c.776T>C', 'ENST00000679684.1:c.776T>C'],
  hgvsp: ['ENSP00000355627.5:p.Met259Thr'],
  spdi: ['NC_000001.11:230710047:A:G']
}
async function call(
  response: Response,
  input: Record<string, unknown> = args
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () => response)
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
  return { result, fetchImpl }
}

describe('ensembl_recode_variant', () => {
  it('preserves accession versions, SPDI coordinates and full counts when truncating', async () => {
    const { result, fetchImpl } = await call(Response.json([{ G: allele }]))
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://rest.ensembl.org/variant_recoder/homo_sapiens/rs699?content-type=application/json'
    )
    expect(result).toMatchObject({
      input: 'rs699',
      species: 'homo_sapiens',
      reference_versions_validated: false,
      total_alleles: 1,
      n_returned: 1,
      truncated: true,
      alleles: [
        {
          input_allele: 'G',
          counts: { id: 2, hgvsg: 1, hgvsc: 2, hgvsp: 1, spdi: 1 },
          truncated: true,
          notations: {
            id: ['rs699'],
            hgvsg: allele.hgvsg,
            hgvsc: [allele.hgvsc[0]],
            hgvsp: allele.hgvsp,
            spdi: allele.spdi
          }
        }
      ]
    })
  })
  it('keeps alternate alleles separate, including multiple genomic references and non-rs aliases', async () => {
    const groups = {
      G: allele,
      T: {
        input: 'rs699',
        id: ['rs699', 'CM920010'],
        hgvsg: ['NC_000001.11:g.230710048A>T', 'NG_008836.1:g.15406A>T']
      }
    }
    expect((await call(Response.json([groups]), { variant: 'rs699' })).result).toMatchObject({
      total_alleles: 2,
      n_returned: 2,
      truncated: false,
      alleles: [
        { input_allele: 'G', notations: { id: allele.id } },
        {
          input_allele: 'T',
          notations: { id: groups.T.id, hgvsg: groups.T.hgvsg, hgvsc: [], hgvsp: [], spdi: [] },
          counts: { hgvsg: 2, hgvsc: 0 }
        }
      ]
    })
  })
  it.each(['ENST00000366667.6:c.803C>T', 'NC_000001.11:230710020:G:A'])(
    'encodes %s and does not relabel transcript-oriented alleles',
    async (variant) => {
      const { result, fetchImpl } = await call(
        Response.json([{ T: { input: variant, hgvsg: ['NC_000001.11:g.230710021G>A'] } }]),
        { variant }
      )
      expect(fetchImpl.mock.calls[0]![0]).toBe(
        `https://rest.ensembl.org/variant_recoder/homo_sapiens/${encodeURIComponent(variant)}?content-type=application/json`
      )
      expect(result).toMatchObject({
        input: variant,
        alleles: [{ input_allele: 'T', notations: { hgvsg: ['NC_000001.11:g.230710021G>A'] } }]
      })
    }
  )
  it('bounds allele groups while retaining their total count', async () => {
    const groups = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`A${i}`, allele]))
    expect((await call(Response.json([groups]))).result).toMatchObject({
      total_alleles: 11,
      n_returned: 10,
      truncated: true
    })
  })
  it.each([
    {},
    { variant: '' },
    { variant: 'rs699\n' },
    { variant: 'rs 699' },
    { variant: 'x'.repeat(501) },
    { ...args, max_notations: 0 },
    { ...args, max_notations: 101 },
    { ...args, max_notations: 1.5 },
    { ...args, species: 'mouse' }
  ])('rejects invalid arguments: %j', (input) => {
    expect(() => registry.validateToolArguments(tool, input)).toThrow()
  })
  it.each([
    null,
    {},
    [],
    [{}],
    [{ G: { input: 'rs699' } }],
    [{ G: { ...allele, input: 'rs700' } }],
    [{ G: { ...allele, spdi: 'not-an-array' } }],
    [{ G: { ...allele, id: [''] } }],
    [{ '': allele }],
    [{ G: allele }, { T: allele }]
  ])('rejects malformed, empty or substituted results: %j', async (raw) => {
    await expect(call(Response.json(raw))).rejects.toThrow()
  })
  it.each([200, 400])('preserves provider error details with HTTP %i', async (status) => {
    await expect(
      call(Response.json({ error: "No variant found with ID 'unknown'" }, { status }))
    ).rejects.toThrow("No variant found with ID 'unknown'")
  })
  it('rejects an unrecognized HTTP 400 body', async () => {
    await expect(call(Response.json([{ G: allele }], { status: 400 }))).rejects.toThrow(
      'unrecognized HTTP 400'
    )
  })
  it.each([404, 429, 503])('keeps upstream HTTP %i as an error', async (status) => {
    await expect(call(Response.json({}, { status }))).rejects.toThrow(`HTTP ${status}`)
  })
  it('rejects HTML and enforces the response budget', async () => {
    await expect(call(new Response('<html>maintenance</html>'))).rejects.toThrow()
    await expect(call(new Response(' '.repeat(tool.maxResponseBytes! + 1)))).rejects.toThrow()
  })
  it('honors cancellation without making a request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, args, {}, controller.signal)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
