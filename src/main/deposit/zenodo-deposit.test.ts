import { describe, expect, it, vi } from 'vitest'

import type { ArtifactDepositSource } from './artifact-deposit-owner'
import { completeDepositPreview } from './deposit-provider'
import { createZenodoDepositProvider, parseZenodoDeposit, toZenodoMetadata } from './zenodo-deposit'

const source = (): ArtifactDepositSource => ({
  artifact: {
    projectId: 'project-1',
    sessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    filename: 'report.csv',
    checksum: 'a'.repeat(64),
    sizeBytes: 120,
    contentType: 'text/csv',
    createdAt: '2026-09-10T00:00:00.000Z'
  },
  session: {
    title: 'Climate analysis',
    description: 'Analysis of the 2026 climate observations.'
  },
  contributors: [
    {
      name: 'Ada Lovelace',
      orcid: '0000-0002-1825-0097',
      affiliations: ['Open Science Lab']
    }
  ],
  license: { id: 'cc-by-4.0', name: 'Creative Commons Attribution 4.0' },
  relatedIdentifiers: [
    {
      identifier: '10.1234/example',
      relation: 'references',
      resourceType: 'publication'
    }
  ],
  crate: {
    filename: 'report.csv.ro-crate.zip',
    checksum: 'b'.repeat(64),
    sizeBytes: 2048,
    bytes: new Uint8Array([1, 2, 3])
  }
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('Zenodo deposit provider', () => {
  it('maps complete deposit metadata without including credentials', () => {
    const metadata = toZenodoMetadata(source())
    expect(metadata).toMatchObject({
      title: 'Climate analysis',
      upload_type: 'dataset',
      version: 'v1',
      creators: [
        {
          name: 'Lovelace, Ada',
          orcid: '0000-0002-1825-0097',
          affiliation: 'Open Science Lab'
        }
      ],
      related_identifiers: [
        {
          identifier: '10.1234/example',
          relation: 'references',
          resource_type: 'publication'
        }
      ],
      license: { id: 'cc-by-4.0' },
      notes: 'Open Science artifact version version-1; crate sha256:' + 'b'.repeat(64)
    })
    expect(JSON.stringify(metadata)).not.toContain('token')
  })

  it('previews sandbox endpoints, exact file identity and metadata', () => {
    const provider = createZenodoDepositProvider()
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )
    expect(preview).toMatchObject({
      provider: 'zenodo',
      environment: 'sandbox',
      artifact: { versionId: 'version-1', checksum: 'a'.repeat(64) },
      files: [
        {
          filename: 'report.csv.ro-crate.zip',
          sizeBytes: 2048,
          checksum: 'b'.repeat(64),
          contentType: 'application/zip'
        }
      ],
      metadata: { title: 'Climate analysis' },
      providerMetadata: {
        title: 'Climate analysis',
        creators: [{ name: 'Lovelace, Ada', orcid: '0000-0002-1825-0097' }],
        notes: 'Open Science artifact version version-1; crate sha256:' + 'b'.repeat(64)
      },
      endpoints: [
        {
          purpose: 'create-draft',
          method: 'POST',
          url: 'https://sandbox.zenodo.org/api/deposit/depositions',
          urlKind: 'fixed'
        },
        {
          purpose: 'upload-file',
          method: 'PUT',
          url: '<draft.links.bucket>/<url-encoded-filename>',
          urlKind: 'provider-resolved'
        },
        {
          purpose: 'publish',
          method: 'POST',
          url: '<draft.links.publish>',
          urlKind: 'provider-resolved'
        }
      ]
    })
    expect(preview.warnings.join(' ')).toContain('provider-resolved')
  })

  it('creates, uploads and publishes an exact approved crate once', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          id: 700,
          conceptrecid: '699',
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1',
            publish: 'https://sandbox.zenodo.org/api/deposit/depositions/700/actions/publish'
          }
        })
      )
      .mockResolvedValueOnce(json({ key: 'report.csv.ro-crate.zip' }))
      .mockResolvedValueOnce(
        json({
          id: 700,
          conceptrecid: '699',
          doi: '10.5072/zenodo.700',
          conceptdoi: '10.5072/zenodo.699',
          links: { record_html: 'https://sandbox.zenodo.org/records/700' }
        })
      )
    const provider = createZenodoDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )
    const result = await provider.execute({
      preview,
      source: source(),
      token: 'zenodo-secret-token'
    })

    expect(result).toEqual({
      providerRecordId: '700',
      providerConceptRecordId: '699',
      conceptDoi: '10.5072/zenodo.699',
      versionDoi: '10.5072/zenodo.700',
      landingUrl: 'https://sandbox.zenodo.org/records/700'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://sandbox.zenodo.org/api/deposit/depositions')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer zenodo-secret-token',
        'content-type': 'application/json'
      }
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toMatchObject({
      metadata: { title: 'Climate analysis' }
    })
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://sandbox.zenodo.org/api/files/bucket-1/report.csv.ro-crate.zip'
    )
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({
      method: 'PUT',
      headers: { authorization: 'Bearer zenodo-secret-token' },
      body: source().crate.bytes
    })
    expect(fetchImpl.mock.calls[2]![0]).toBe(
      'https://sandbox.zenodo.org/api/deposit/depositions/700/actions/publish'
    )
    expect(fetchImpl.mock.calls[2]![1]).toMatchObject({ method: 'POST' })
  })

  it('creates a new version and preserves the existing concept DOI', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          id: 700,
          links: {
            latest_draft: 'https://sandbox.zenodo.org/api/deposit/depositions/701'
          }
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 701,
          conceptrecid: '699',
          conceptdoi: '10.5072/zenodo.699',
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-2',
            publish: 'https://sandbox.zenodo.org/api/deposit/depositions/701/actions/publish'
          }
        })
      )
      .mockResolvedValueOnce(json({ key: 'report.csv.ro-crate.zip' }))
      .mockResolvedValueOnce(
        json({
          id: 701,
          conceptrecid: '699',
          doi: '10.5072/zenodo.701',
          conceptdoi: '10.5072/zenodo.699',
          links: { record_html: 'https://sandbox.zenodo.org/records/701' }
        })
      )
    const provider = createZenodoDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({
        source: source(),
        environment: 'sandbox',
        lineage: {
          providerRecordId: '700',
          providerConceptRecordId: '699',
          conceptDoi: '10.5072/zenodo.699'
        }
      })
    )
    const result = await provider.execute({
      preview,
      source: source(),
      token: 'zenodo-secret-token'
    })

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://sandbox.zenodo.org/api/deposit/depositions/700/actions/newversion'
    )
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://sandbox.zenodo.org/api/deposit/depositions/701'
    )
    expect(result.conceptDoi).toBe('10.5072/zenodo.699')
    expect(result.versionDoi).toBe('10.5072/zenodo.701')
  })

  it('reports an unknown outcome on timeout without retrying the mutation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              init.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
            )
          )
        })
    )
    const provider = createZenodoDepositProvider({ fetchImpl, requestTimeoutMs: 5 })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )

    await expect(
      provider.execute({ preview, source: source(), token: 'secret-token' })
    ).rejects.toMatchObject({
      name: 'DepositOutcomeUnknownError',
      reconciliation: { operation: 'create-draft', providerRecordId: undefined }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown outcome when a successful mutation response cannot be parsed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 201 }))
    const provider = createZenodoDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )

    await expect(
      provider.execute({ preview, source: source(), token: 'secret-token' })
    ).rejects.toMatchObject({
      name: 'DepositOutcomeUnknownError',
      reconciliation: { operation: 'create-draft', providerRecordId: undefined }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reconciles an unknown create by matching immutable preview evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        hits: {
          hits: [
            {
              id: 700,
              conceptrecid: '699',
              doi: '10.5072/zenodo.700',
              conceptdoi: '10.5072/zenodo.699',
              metadata: {
                title: 'Climate analysis',
                notes: 'Open Science artifact version version-1; crate sha256:' + 'b'.repeat(64)
              },
              files: [
                {
                  key: 'report.csv.ro-crate.zip',
                  size: 2048,
                  checksum: 'md5:deadbeef'
                }
              ],
              links: { record_html: 'https://sandbox.zenodo.org/records/700' }
            }
          ]
        }
      })
    )
    const provider = createZenodoDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )
    const outcome = {
      provider: 'zenodo' as const,
      environment: 'sandbox' as const,
      operation: 'create-draft' as const,
      previewChecksum: 'c'.repeat(64)
    }
    await expect(provider.reconcile({ preview, outcome, token: 'secret-token' })).resolves.toEqual({
      state: 'published',
      publication: {
        providerRecordId: '700',
        providerConceptRecordId: '699',
        conceptDoi: '10.5072/zenodo.699',
        versionDoi: '10.5072/zenodo.700',
        landingUrl: 'https://sandbox.zenodo.org/records/700'
      }
    })
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/deposit/depositions?q=')
  })

  it('redacts a token echoed by an upstream error', async () => {
    const token = 'secret-token-that-must-not-leak'
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ message: `rejected ${token}` }, 401))
    const provider = createZenodoDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )

    await expect(provider.execute({ preview, source: source(), token })).rejects.toThrowError(
      expect.not.stringContaining(token)
    )
  })

  it('rejects malformed publication responses instead of inventing a DOI', () => {
    expect(() =>
      parseZenodoDeposit({
        id: 700,
        conceptrecid: '699',
        links: { record_html: 'https://sandbox.zenodo.org/records/700' }
      })
    ).toThrow(/concept DOI|version DOI/)
  })
})
