import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { TENX_GENOMICS_TOOLS } from './tenx-genomics'

const tool = (id: string): (typeof TENX_GENOMICS_TOOLS)[number] =>
  TENX_GENOMICS_TOOLS.find((candidate) => candidate.id === id)!
const call = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const hit = {
  slug: 'pbmc-1k-v3',
  title: '1k PBMC v3',
  description: 'Human peripheral blood mononuclear cells',
  platformNameStr: 'Chromium',
  productName: 'Chromium Single Cell 3’',
  species: ['Homo sapiens'],
  publishedAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-03T00:00:00Z'
}

describe('10x Genomics connector', () => {
  it('maps dataset search parameters and parses only stable catalog fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ hits: [{ ...hit, internal: true }], total: 1 }))
    const result = await call('search_datasets', { query: 'pbmc', offset: 20 }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.10xgenomics.com/api/search?document=dataset&search=pbmc&sort=publishedAt+DESC&offset=20',
      expect.any(Object)
    )
    expect(result).toEqual({
      datasets: [
        {
          slug: 'pbmc-1k-v3',
          title: '1k PBMC v3',
          description: 'Human peripheral blood mononuclear cells',
          platform: 'Chromium',
          product: 'Chromium Single Cell 3’',
          species: ['Homo sapiens'],
          published_at: '2026-01-02T00:00:00Z',
          updated_at: '2026-01-03T00:00:00Z',
          landing_url: 'https://www.10xgenomics.com/datasets/pbmc-1k-v3'
        }
      ],
      total: 1
    })
  })

  it('resolves one dataset by slug and supports pipeline metadata catalogs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ results: [hit] }))
      .mockResolvedValueOnce(
        jsonRes({
          items: [
            {
              slug: 'cellranger-9',
              title: 'Cell Ranger 9 pipeline',
              description: 'Pipeline release notes',
              publishedAt: '2026-02-01T00:00:00Z'
            }
          ]
        })
      )

    await expect(call('get_dataset', { slug: 'pbmc-1k-v3' }, fetchImpl)).resolves.toMatchObject({
      slug: 'pbmc-1k-v3',
      title: '1k PBMC v3'
    })
    await expect(call('list_pipelines', { offset: 0 }, fetchImpl)).resolves.toEqual({
      pipelines: [
        {
          slug: 'cellranger-9',
          title: 'Cell Ranger 9 pipeline',
          description: 'Pipeline release notes',
          platform: null,
          product: null,
          species: [],
          published_at: '2026-02-01T00:00:00Z',
          updated_at: null,
          landing_url: 'https://www.10xgenomics.com/pipelines/cellranger-9'
        }
      ],
      total: 1
    })
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://www.10xgenomics.com/api/search?document=pipeline&search=&sort=publishedAt+DESC&offset=0'
    )
  })

  it('fails closed when a dataset cannot be resolved and preserves HTTP failures', async () => {
    await expect(
      call('get_dataset', { slug: 'missing' }, vi.fn().mockResolvedValue(jsonRes({ hits: [] })))
    ).rejects.toThrow(/not found/)
    await expect(
      call('search_datasets', {}, vi.fn().mockResolvedValue(jsonRes({}, 429)))
    ).rejects.toThrow(/HTTP 429/)
    await expect(
      call('search_datasets', {}, vi.fn().mockResolvedValue(jsonRes({ hits: [{}] })))
    ).rejects.toThrow(/missing slug/)
  })
})
