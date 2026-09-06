import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../shared/literature'
import { LiteratureFullTextFinder, type LiteratureFullTextFinderOptions } from './full-text-finder'
import { FullTextRateLimitError } from './full-text-download'

const setup = (): {
  finder: LiteratureFullTextFinder
  options: LiteratureFullTextFinderOptions
  item: LiteratureItemView
} => {
  const item: LiteratureItemView = {
    id: 'item-1',
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    projectIds: [],
    collectionIds: [],
    item: literatureItemInputSchema.parse({
      title: 'Example paper',
      itemType: 'journalArticle',
      identifiers: [{ scheme: 'doi', value: '10.1000/example' }]
    })
  }
  const options: LiteratureFullTextFinderOptions = {
    catalog: {
      get: vi.fn(async () => item),
      attachContent: vi.fn(async () => ({ attachmentId: 'attachment-1', versionId: 'version-1' }))
    },
    content: {
      publish: vi.fn(async ({ sourcePath }) => {
        const bytes = await readFile(sourcePath)
        return {
          id: 'blob-1',
          path: sourcePath,
          storageKey: 'blob-1',
          sizeBytes: BigInt(bytes.length),
          checksum: 'a'.repeat(64),
          contentType: 'application/pdf'
        }
      })
    },
    openAlexKey: vi.fn(async () => undefined),
    fetch: vi.fn(async (input) =>
      new URL(String(input)).hostname === 'pmc.ncbi.nlm.nih.gov'
        ? Response.json({ records: [] })
        : Response.json({
            resultList: {
              result: [
                {
                  doi: '10.1000/example',
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'pdf',
                        site: 'Example journal',
                        url: 'https://journal.example/paper.pdf'
                      },
                      {
                        availabilityCode: 'S',
                        documentStyle: 'pdf',
                        site: 'Subscription',
                        url: 'https://journal.example/paid.pdf'
                      },
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'html',
                        url: 'https://journal.example/paper'
                      }
                    ]
                  }
                },
                {
                  doi: '10.1000/other',
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'pdf',
                        url: 'https://journal.example/other.pdf'
                      }
                    ]
                  }
                }
              ]
            }
          })
    ),
    download: vi.fn(async () => Buffer.from('%PDF-1.7\nexample')),
    pageCount: vi.fn(async () => 8)
  }
  return { finder: new LiteratureFullTextFinder(options), options, item }
}

describe('Literature full-text discovery and attachment', () => {
  it.each([
    ['10.1000/example', '10.1000/example'],
    ['https://doi.org/10.1000/EXAMPLE', '10.1000/example'],
    ['10.1000/example', 'https://doi.org/10.1000/EXAMPLE']
  ])(
    'matches DOI %s against %s across all providers and attaches only the selected candidate',
    async (inputDoi, providerDoi) => {
      const { finder, options, item } = setup()
      item.item.identifiers = [{ scheme: 'doi', value: inputDoi, isPrimary: false }]
      options.openAlexKey = vi.fn(async () => 'test-key')
      options.contactEmail = vi.fn(async () => 'research@lab.org')
      const originalFetch = options.fetch!
      options.fetch = vi.fn(async (input, init) => {
        const url = new URL(String(input))
        if (url.hostname === 'api.unpaywall.org')
          return Response.json({
            doi: providerDoi,
            oa_locations: [
              { url_for_pdf: 'https://journal.example/paper.pdf' },
              {
                url_for_pdf: 'https://repository.example/manuscript.pdf',
                url_for_landing_page: 'https://repository.example/article'
              }
            ]
          })
        if (url.hostname === 'api.openalex.org')
          return Response.json({
            results: [
              {
                doi: providerDoi,
                best_oa_location: {
                  is_oa: true,
                  pdf_url: 'https://repository.example/openalex.pdf'
                }
              }
            ]
          })
        if (url.hostname === 'pmc.ncbi.nlm.nih.gov')
          return Response.json({ records: [{ doi: providerDoi, pmcid: 'PMC12345' }] })
        if (url.hostname === 'pmc-oa-opendata.s3.amazonaws.com')
          return url.searchParams.has('list-type')
            ? new Response(
                '<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>PMC12345.1/</Prefix></CommonPrefixes></ListBucketResult>'
              )
            : Response.json({
                pmcid: 'PMC12345',
                doi: providerDoi,
                version: 1,
                pdf_url: 's3://pmc-oa-opendata/PMC12345.1/paper.pdf'
              })
        const response = await originalFetch(input, init)
        const body = await response.json()
        body.resultList.result[0].doi = providerDoi
        return Response.json(body)
      })
      const result = await finder.run({ mode: 'search', itemId: item.id })
      if (result.mode !== 'search') throw new Error('Expected search')
      expect(result.candidates.map(({ provider }) => provider)).toEqual([
        'europe-pmc',
        'openalex',
        'unpaywall',
        'pmc'
      ])
      const requests = vi.mocked(options.fetch!).mock.calls.map(([input]) => new URL(String(input)))
      expect(requests.find((url) => url.hostname === 'api.unpaywall.org')?.pathname).toBe(
        '/v2/10.1000%2Fexample'
      )
      expect(
        requests.find((url) => url.hostname === 'pmc.ncbi.nlm.nih.gov')?.searchParams.get('ids')
      ).toBe('10.1000/example')
      expect(
        requests.find((url) => url.hostname === 'api.openalex.org')?.searchParams.get('filter')
      ).toBe('doi:https://doi.org/10.1000/example')
      expect(
        requests.find((url) => url.hostname === 'www.ebi.ac.uk')?.searchParams.get('query')
      ).toBe('DOI:"10.1000/example"')
      expect(options.download).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('research@lab.org')
      await finder.run({ mode: 'attach', itemId: item.id, candidateId: result.candidates[3].id })
      expect(options.download).toHaveBeenCalledWith(
        'https://pmc-oa-opendata.s3.amazonaws.com/PMC12345.1/paper.pdf',
        expect.any(Number),
        expect.any(Function)
      )
      expect(options.catalog.attachContent).toHaveBeenCalledTimes(1)
    }
  )
  it('exposes progress only for the matching active transfer and clears it after completion', async () => {
    const { finder, options, item } = setup()
    const result = await finder.run({ mode: 'search', itemId: item.id })
    if (result.mode !== 'search') throw new Error('Expected search')
    const candidateId = result.candidates[0].id
    let release!: (bytes: Buffer) => void
    options.download = async (_url, _limit, report) => {
      report?.({ receivedBytes: 5, totalBytes: 10, bytesPerSecond: 2, phase: 'downloading' })
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const attaching = finder.run({ mode: 'attach', itemId: item.id, candidateId })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(
      finder.run({ mode: 'progress', itemId: item.id, candidateId })
    ).resolves.toMatchObject({ progress: { receivedBytes: 5, bytesPerSecond: 2 } })
    await expect(finder.run({ mode: 'progress', itemId: 'other', candidateId })).resolves.toEqual({
      mode: 'progress'
    })
    release(Buffer.from('%PDF-1.7\nexample'))
    await attaching
    await expect(finder.run({ mode: 'progress', itemId: item.id, candidateId })).resolves.toEqual({
      mode: 'progress'
    })
  })
  it('returns a source cooldown without publishing an attachment and clears its progress', async () => {
    const { finder, options, item } = setup()
    const result = await finder.run({ mode: 'search', itemId: item.id })
    if (result.mode !== 'search') throw new Error('Expected search')
    const candidateId = result.candidates[0].id
    const retryAt = Date.now() + 60_000
    options.download = vi.fn().mockRejectedValue(new FullTextRateLimitError(retryAt))
    await expect(finder.run({ mode: 'attach', itemId: item.id, candidateId })).resolves.toEqual({
      mode: 'attach-error',
      reason: 'rate-limited',
      retryAt
    })
    expect(options.content.publish).not.toHaveBeenCalled()
    await expect(finder.run({ mode: 'progress', itemId: item.id, candidateId })).resolves.toEqual({
      mode: 'progress'
    })
  })
  it('only offers matching free PDFs and writes nothing until the selected candidate is confirmed', async () => {
    const { finder, options, item } = setup()
    const result = await finder.run({ mode: 'search', itemId: item.id })
    if (result.mode !== 'search') throw new Error('Expected search')
    expect(result.candidates).toHaveLength(1)
    expect(result.notices.toSorted()).toEqual([
      'openalex-not-configured',
      'pmc-no-record',
      'unpaywall-not-configured'
    ])
    expect(options.download).not.toHaveBeenCalled()
    expect(options.catalog.attachContent).not.toHaveBeenCalled()
    await expect(
      finder.run({ mode: 'attach', itemId: item.id, candidateId: result.candidates[0].id })
    ).resolves.toEqual({ mode: 'attach', item })
    expect(options.catalog.attachContent).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: item.id,
        pageCount: 8,
        filename: 'Example paper.pdf',
        checksum: 'a'.repeat(64)
      })
    )
    const path = vi.mocked(options.content.publish).mock.calls[0][0].sourcePath
    await expect(readFile(path)).rejects.toThrow()
  })
  it.each([
    ['https://europepmc.org/articles/PMC3077217', 'https://europepmc.org/articles/PMC3077217'],
    [undefined, 'https://europepmc.org/articles/PMC3077217'],
    ['javascript:alert(1)', 'https://europepmc.org']
  ])(
    'uses the official Europe PMC article page independently of the download URL: %s',
    async (page, expected) => {
      const { finder, options, item } = setup()
      const pdf = 'https://europepmc.org/articles/PMC3077217?pdf=render'
      vi.mocked(options.fetch!).mockImplementation(async (input) =>
        new URL(String(input)).hostname === 'pmc.ncbi.nlm.nih.gov'
          ? Response.json({ records: [] })
          : Response.json({
              resultList: {
                result: [
                  {
                    doi: '10.1000/example',
                    fullTextUrlList: {
                      fullTextUrl: [
                        {
                          availabilityCode: 'F',
                          documentStyle: 'pdf',
                          site: 'Europe_PMC',
                          url: pdf
                        },
                        ...(page
                          ? [
                              {
                                availabilityCode: 'F',
                                documentStyle: 'html',
                                site: 'Europe_PMC',
                                url: page
                              }
                            ]
                          : [])
                      ]
                    }
                  }
                ]
              }
            })
      )
      const result = await finder.run({ mode: 'search', itemId: item.id })
      if (result.mode !== 'search') throw new Error('Expected search')
      expect(result.candidates[0]).toMatchObject({ url: pdf, sourceUrl: expected })
      await finder.run({ mode: 'attach', itemId: item.id, candidateId: result.candidates[0].id })
      expect(options.download).toHaveBeenCalledWith(pdf, expect.any(Number), expect.any(Function))
    }
  )

  it('rejects foreign, expired, and stale results without downloading', async () => {
    const { finder, options, item } = setup()
    const result = await finder.run({ mode: 'search', itemId: item.id })
    if (result.mode !== 'search') throw new Error('Expected search')
    await expect(
      finder.run({ mode: 'attach', itemId: item.id, candidateId: 'invented-token' })
    ).rejects.toThrow('expired')
    vi.mocked(options.catalog.get).mockResolvedValue({ ...item, id: 'item-2' })
    await expect(
      finder.run({ mode: 'attach', itemId: 'item-2', candidateId: result.candidates[0].id })
    ).rejects.toThrow('expired')
    vi.mocked(options.catalog.get).mockResolvedValue({ ...item, metadataRevision: 2 })
    await expect(
      finder.run({ mode: 'attach', itemId: item.id, candidateId: result.candidates[0].id })
    ).rejects.toThrow('reference changed')
    vi.mocked(options.catalog.get).mockResolvedValue(item)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000)
    try {
      await expect(
        finder.run({ mode: 'attach', itemId: item.id, candidateId: result.candidates[0].id })
      ).rejects.toThrow('expired')
    } finally {
      now.mockRestore()
    }
    expect(options.download).not.toHaveBeenCalled()
  })

  it('leaves attachments unchanged for HTML, malformed PDFs, and references edited during download', async () => {
    const { finder, options, item } = setup()
    const result = await finder.run({ mode: 'search', itemId: item.id })
    if (result.mode !== 'search') throw new Error('Expected search')
    const request = {
      mode: 'attach' as const,
      itemId: item.id,
      candidateId: result.candidates[0].id
    }
    vi.mocked(options.download!).mockResolvedValueOnce(Buffer.from('<html>Sign in</html>'))
    await expect(finder.run(request)).rejects.toThrow('did not return a PDF')
    vi.mocked(options.pageCount!).mockRejectedValueOnce(new Error('Invalid PDF'))
    await expect(finder.run(request)).rejects.toThrow('Invalid PDF')
    vi.mocked(options.download!).mockImplementationOnce(async () => {
      vi.mocked(options.catalog.get).mockResolvedValue({ ...item, metadataRevision: 2 })
      return Buffer.from('%PDF-1.7\nexample')
    })
    await expect(finder.run(request)).rejects.toThrow('changed during download')
    expect(options.content.publish).not.toHaveBeenCalled()
    expect(options.catalog.attachContent).not.toHaveBeenCalled()
  })

  it('uses configured OpenAlex credentials only for its API and keeps results when another provider fails', async () => {
    const { finder, options, item } = setup()
    vi.mocked(options.openAlexKey).mockResolvedValue('test-api-key')
    vi.mocked(options.fetch!).mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.hostname !== 'api.openalex.org') return new Response('', { status: 503 })
      expect(url.searchParams.get('api_key')).toBe('test-api-key')
      return Response.json({
        results: [
          {
            doi: 'https://doi.org/10.1000/example',
            best_oa_location: {
              is_oa: true,
              pdf_url: 'https://journal.example/paper.pdf',
              landing_page_url: 'https://journal.example/articles/paper',
              license: 'cc-by',
              version: 'acceptedVersion'
            },
            locations: [
              { is_oa: true, pdf_url: 'https://journal.example/paper.pdf' },
              { is_oa: false, pdf_url: 'https://journal.example/paid.pdf' }
            ]
          },
          {
            doi: '10.1000/wrong',
            locations: [{ is_oa: true, pdf_url: 'https://journal.example/wrong.pdf' }]
          }
        ]
      })
    })
    const result = await finder.run({ mode: 'search', itemId: item.id })
    expect(result).toEqual({
      mode: 'search',
      notices: expect.arrayContaining([
        'europe-pmc-unavailable',
        'pmc-unavailable',
        'unpaywall-not-configured'
      ]),
      candidates: [
        expect.objectContaining({
          provider: 'openalex',
          version: 'accepted',
          license: 'cc-by',
          url: 'https://journal.example/paper.pdf',
          sourceUrl: 'https://journal.example/articles/paper'
        })
      ]
    })
    expect(options.fetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error' })
    )
    expect(JSON.stringify(result)).not.toContain('test-api-key')
  })

  it('requires an identifier and rejects conflicting PubMed matches', async () => {
    const { finder, options, item } = setup()
    vi.mocked(options.catalog.get).mockResolvedValueOnce({
      ...item,
      item: { ...item.item, identifiers: [] }
    })
    expect(await finder.run({ mode: 'search', itemId: item.id })).toEqual({
      mode: 'search',
      candidates: [],
      notices: ['missing-identifiers']
    })
    expect(options.fetch).not.toHaveBeenCalled()
    item.item.identifiers.push({ scheme: 'pmid', value: '12345', isPrimary: false })
    vi.mocked(options.fetch!).mockImplementation(async (input) =>
      new URL(String(input)).hostname === 'pmc.ncbi.nlm.nih.gov'
        ? Response.json({ records: [] })
        : Response.json({
            resultList: {
              result: [
                {
                  id: '99999',
                  source: 'MED',
                  doi: '10.1000/example',
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'pdf',
                        url: 'https://journal.example/wrong.pdf'
                      }
                    ]
                  }
                }
              ]
            }
          })
    )
    expect(await finder.run({ mode: 'search', itemId: item.id })).toMatchObject({ candidates: [] })
  })
})
