import { describe, expect, it, vi } from 'vitest'
import { findPmcPdfs, findUnpaywallPdfs, readFullTextProvider } from './full-text-sources'

describe('additional full-text sources', () => {
  it.each(['10.1000/example', 'https://doi.org/10.1000/EXAMPLE'])(
    'uses the Unpaywall contact email only in DOI discovery for %s and separates article and PDF links',
    async (doi) => {
      const fetcher = vi.fn(async () =>
        Response.json({
          doi: '10.1000/example',
          best_oa_location: {
            url_for_pdf: 'https://journal.example/paper.pdf',
            url_for_landing_page: 'https://journal.example/article',
            license: 'cc-by',
            version: 'acceptedVersion'
          },
          oa_locations: [{ url_for_pdf: null }]
        })
      )
      const result = await findUnpaywallPdfs(doi, 'research@lab.org', fetcher)
      expect(result).toEqual([
        expect.objectContaining({
          provider: 'unpaywall',
          url: 'https://journal.example/paper.pdf',
          sourceUrl: 'https://journal.example/article',
          version: 'accepted',
          license: 'cc-by'
        })
      ])
      const url = new URL(vi.mocked<typeof fetch>(fetcher).mock.calls[0]![0]!.toString())
      expect(decodeURIComponent(url.pathname)).toBe('/v2/10.1000/example')
      expect(url.searchParams.get('email')).toBe('research@lab.org')
      expect(JSON.stringify(result)).not.toContain('research@lab.org')
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
  it('treats an unknown DOI as no result and rejects mismatched or invalid lookups', async () => {
    await expect(
      findUnpaywallPdfs(
        '10.1000/example',
        'research@lab.org',
        vi.fn(async () => new Response(null, { status: 404 }))
      )
    ).resolves.toEqual([])
    await expect(
      findUnpaywallPdfs(
        '10.1000/example',
        'research@lab.org',
        vi.fn(async () =>
          Response.json({
            doi: '10.1000/other',
            best_oa_location: { url_for_pdf: 'https://journal.example/wrong.pdf' }
          })
        )
      )
    ).resolves.toEqual([])
    const fetcher = vi.fn()
    await expect(findUnpaywallPdfs('10.1000/example', 'not-email', fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['10.1000/example', 'https://doi.org/10.1000/EXAMPLE'])(
    'resolves DOI %s to PMC and discovers version 2 without assuming version 1 exists',
    async (doi) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.hostname === 'pmc.ncbi.nlm.nih.gov')
          return Response.json({ records: [{ doi: '10.1000/example', pmcid: 'PMC12345' }] })
        if (url.searchParams.has('list-type'))
          return new Response(
            '<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>PMC12345.2/</Prefix></CommonPrefixes></ListBucketResult>'
          )
        expect(url.pathname).toBe('/PMC12345.2/PMC12345.2.json')
        return Response.json({
          pmcid: 'PMC12345',
          version: 2,
          doi: '10.1000/example',
          is_manuscript: true,
          license_code: 'CC BY',
          pdf_url: 's3://pmc-oa-opendata/PMC12345.2/paper.pdf?md5=abc'
        })
      })
      const result = await findPmcPdfs({ doi }, fetcher)
      expect(result).toEqual({
        noRecord: false,
        candidates: [
          {
            provider: 'pmc',
            source: 'PubMed Central',
            url: 'https://pmc-oa-opendata.s3.amazonaws.com/PMC12345.2/paper.pdf?md5=abc',
            sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12345.2/',
            license: 'CC BY',
            version: 'accepted'
          }
        ]
      })
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(fetcher.mock.calls.every(([url]) => !String(url).includes('api_key='))).toBe(true)
    }
  )
  it.each([
    null,
    's3://other-bucket/PMC12345.1/paper.pdf',
    'https://127.0.0.1/paper.pdf',
    'https://pmc-oa-opendata.s3.amazonaws.com/PMC99999.1/paper.pdf'
  ])('does not invent a PDF or accept an unrelated cloud object: %s', async (pdf) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('list-type')
        ? new Response(
            '<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>PMC12345.1/</Prefix></CommonPrefixes></ListBucketResult>'
          )
        : Response.json({ pmcid: 'PMC12345', version: 1, license_code: 'TDM', pdf_url: pdf })
    )
    await expect(findPmcPdfs({ pmcid: 'PMC12345' }, fetcher)).resolves.toEqual({
      candidates: [],
      noRecord: false
    })
  })
  it('does not use a conflicting PMC mapping or report a truncated listing as complete', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ records: [{ doi: '10.1000/other', pmcid: 'PMC12345' }] })
    )
    await expect(findPmcPdfs({ doi: '10.1000/example' }, fetcher)).resolves.toEqual({
      candidates: [],
      noRecord: true
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(
      findPmcPdfs(
        { pmcid: 'PMC12345' },
        vi.fn(
          async () =>
            new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')
        )
      )
    ).rejects.toThrow('incomplete')
  })
  it('bounds metadata responses and distinguishes provider failures from missing articles', async () => {
    await expect(
      readFullTextProvider(
        'https://api.unpaywall.org/v2/test',
        vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
      )
    ).rejects.toThrow('too large')
    await expect(
      readFullTextProvider(
        'https://api.unpaywall.org/v2/test',
        vi.fn(async () => new Response(null, { status: 429 }))
      )
    ).rejects.toThrow('request failed')
  })
})
