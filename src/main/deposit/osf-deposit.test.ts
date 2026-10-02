import { describe, expect, it, vi } from 'vitest'

import type { ArtifactDepositSource } from './artifact-deposit-owner'
import { completeDepositPreview, DepositOutcomeUnknownError } from './deposit-provider'
import { createOsfDepositProvider, parseOsfDeposit, toOsfRegistration } from './osf-deposit'

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
  session: { title: 'Climate analysis', description: 'Analysis of climate observations.' },
  contributors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }],
  license: { id: 'cc-by-4.0', name: 'Creative Commons Attribution 4.0' },
  relatedIdentifiers: [
    { identifier: '10.1234/example', relation: 'references', resourceType: 'publication' }
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

describe('OSF deposit provider', () => {
  it('maps a registration with contributors, citations and license', () => {
    expect(toOsfRegistration(source())).toMatchObject({
      title: 'Climate analysis',
      description: expect.stringContaining('Analysis of climate observations.'),
      registration_responses: {
        title: 'Climate analysis',
        description: expect.stringContaining('10.1234/example'),
        license: 'cc-by-4.0'
      },
      contributors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }]
    })
  })

  it('previews the OSF sandbox project, upload and registration endpoints', () => {
    const provider = createOsfDepositProvider()
    expect(provider.preview({ source: source(), environment: 'sandbox' })).toMatchObject({
      provider: 'osf',
      environment: 'sandbox',
      providerMetadata: {
        title: 'Climate analysis',
        registration_responses: {
          title: 'Climate analysis',
          description: expect.stringContaining('10.1234/example')
        }
      },
      endpoints: [
        { purpose: 'create-project', method: 'POST', url: 'https://api.test.osf.io/v2/nodes/' },
        {
          purpose: 'upload-file',
          method: 'POST',
          url: '<project.links.files>/osfstorage/'
        },
        {
          purpose: 'create-registration',
          method: 'POST',
          url: '<project.links.registrations>'
        }
      ]
    })
  })

  it('creates a private project, uploads the crate and publishes a DOI-bearing registration', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'node-1',
            type: 'nodes',
            links: {
              files: 'https://api.test.osf.io/v2/nodes/node-1/files/',
              registrations: 'https://api.test.osf.io/v2/nodes/node-1/registrations/'
            }
          }
        })
      )
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'file-1',
            type: 'files',
            links: {
              upload: 'https://files.test.osf.io/v1/resources/node-1/providers/osfstorage/file-1'
            }
          }
        })
      )
      .mockResolvedValueOnce(json({ data: { id: 'file-1' } }))
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'registration-1',
            type: 'registrations',
            attributes: { doi: '10.17605/OSF.IO/ABCDE' },
            links: { html: 'https://osf.io/abcde/' }
          }
        })
      )
    const provider = createOsfDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )
    await expect(
      provider.execute({ preview, source: source(), token: 'osf-secret-token' })
    ).resolves.toEqual({
      providerRecordId: 'registration-1',
      providerConceptRecordId: 'node-1',
      conceptDoi: '10.17605/OSF.IO/ABCDE',
      versionDoi: '10.17605/OSF.IO/ABCDE',
      landingUrl: 'https://osf.io/abcde/'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer osf-secret-token',
        'content-type': 'application/vnd.api+json'
      }
    })
    expect(fetchImpl.mock.calls[2]![0]).toBe(
      'https://files.test.osf.io/v1/resources/node-1/providers/osfstorage/file-1'
    )
    expect(fetchImpl.mock.calls[2]![1]).toMatchObject({
      method: 'PUT',
      body: source().crate.bytes
    })
    expect(fetchImpl.mock.calls[3]![0]).toBe(
      'https://api.test.osf.io/v2/nodes/node-1/registrations/'
    )
  })

  it('rejects a registration response without a DOI', () => {
    expect(() =>
      parseOsfDeposit({
        data: {
          id: 'registration-1',
          type: 'registrations',
          links: { html: 'https://osf.io/abcde/' }
        }
      })
    ).toThrow(/DOI/)
  })

  it('fails closed with an unknown outcome and reconciles through the project when OSF omits the DOI', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'node-1',
            type: 'nodes',
            links: {
              files: 'https://api.test.osf.io/v2/nodes/node-1/files/',
              registrations: 'https://api.test.osf.io/v2/nodes/node-1/registrations/'
            }
          }
        })
      )
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'file-1',
            type: 'files',
            links: {
              upload: 'https://files.test.osf.io/v1/resources/node-1/providers/osfstorage/file-1'
            }
          }
        })
      )
      .mockResolvedValueOnce(json({ data: { id: 'file-1' } }))
      .mockResolvedValueOnce(
        json({
          data: {
            id: 'registration-1',
            type: 'registrations',
            attributes: { title: 'Climate analysis' },
            links: { html: 'https://osf.io/abcde/' }
          }
        })
      )
    const provider = createOsfDepositProvider({ fetchImpl })
    const preview = completeDepositPreview(
      provider.preview({ source: source(), environment: 'sandbox' })
    )

    const executeError = await provider
      .execute({ preview, source: source(), token: 'osf-secret-token' })
      .catch((error: unknown) => error)
    expect(executeError).toBeInstanceOf(DepositOutcomeUnknownError)
    expect(executeError).toMatchObject({
      reconciliation: {
        operation: 'create-registration',
        providerRecordId: 'node-1'
      }
    })

    fetchImpl.mockResolvedValueOnce(
      json({
        data: [
          {
            id: 'registration-1',
            type: 'registrations',
            attributes: { title: 'Climate analysis' },
            links: { html: 'https://osf.io/abcde/' }
          }
        ]
      })
    )
    await expect(
      provider.reconcile({
        preview,
        outcome: (executeError as DepositOutcomeUnknownError).reconciliation,
        token: 'osf-secret-token'
      })
    ).resolves.toMatchObject({ state: 'pending' })
    expect(fetchImpl.mock.calls[4]![0]).toBe(
      'https://api.test.osf.io/v2/nodes/node-1/registrations/'
    )
  })
})
