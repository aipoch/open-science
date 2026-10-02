import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ConnectorCredentials } from '../types'
import { BENCHLING_TOOLS } from './benchling'

const credentials: ConnectorCredentials = {
  oauthTokens: { benchling: 'benchling-token' }
}
const tool = (id: string): (typeof BENCHLING_TOOLS)[number] =>
  BENCHLING_TOOLS.find((candidate) => candidate.id === id)!
const call = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    credentials
  )

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const entry = {
  id: 'etr_8rVKW0g7',
  name: 'Protein Concentration Assay',
  displayId: 'EXP-2025-0042',
  createdAt: '2025-01-15T10:30:00Z',
  modifiedAt: '2025-01-15T14:22:00Z',
  archived: false,
  folder: { id: 'lib_abc123' },
  schema: { id: 'entsch_x9Kp2mQ4' },
  versionMetadata: { versionId: 'etrver_Ax7b2kR9' },
  parts: 'https://api.benchling.com/api/v3/entry/etr_8rVKW0g7/parts/items'
}

describe('Benchling connector', () => {
  it('maps authenticated reads and parses the stable entry identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(entry))
    const result = await call('get_entry', { entry_id: 'etr_8rVKW0g7' }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.benchling.com/api/v3/entry/etr_8rVKW0g7',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer benchling-token' })
      })
    )
    expect(result).toEqual({
      id: 'etr_8rVKW0g7',
      name: 'Protein Concentration Assay',
      display_id: 'EXP-2025-0042',
      created_at: '2025-01-15T10:30:00Z',
      modified_at: '2025-01-15T14:22:00Z',
      archived: false,
      folder_id: 'lib_abc123',
      schema_id: 'entsch_x9Kp2mQ4',
      version_id: 'etrver_Ax7b2kR9',
      parts_url: 'https://api.benchling.com/api/v3/entry/etr_8rVKW0g7/parts/items'
    })
  })

  it('maps entity and results pagination without leaking unknown upstream fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          customEntities: [
            { id: 'bfi_ELstHqON', name: 'Sample 1', schemaId: 'ts_A', ignored: true }
          ],
          nextToken: 'entity-next'
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          assayResults: [
            { id: 'res_1', schemaId: 'assaysch_A', projectId: 'src_A', fields: { ct: 11.1 } }
          ],
          nextToken: null
        })
      )

    await expect(
      call(
        'list_custom_entities',
        { name: 'Sample 1', schema_id: 'ts_A', page_size: 25, next_token: 'entity-cursor' },
        fetchImpl
      )
    ).resolves.toEqual({
      items: [{ id: 'bfi_ELstHqON', name: 'Sample 1', schema_id: 'ts_A' }],
      next_token: 'entity-next'
    })
    await expect(
      call('list_assay_results', { schema_id: 'assaysch_A' }, fetchImpl)
    ).resolves.toEqual({
      items: [{ id: 'res_1', schema_id: 'assaysch_A', project_id: 'src_A', fields: { ct: 11.1 } }],
      next_token: null
    })

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.benchling.com/api/v2/custom-entities?name=Sample+1&schemaId=ts_A&pageSize=25&nextToken=entity-cursor'
    )
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.benchling.com/api/v2/assay-results?schemaId=assaysch_A&pageSize=50'
    )
  })

  it('maps write-back request bodies and marks only mutation descriptors', async () => {
    expect(
      BENCHLING_TOOLS.filter((candidate) => candidate.approvalClass === 'write-back').map(
        (candidate) => candidate.id
      )
    ).toEqual(['create_entry', 'update_entry', 'create_assay_results'])
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(entry))
      .mockResolvedValueOnce(jsonRes({ ...entry, name: 'Updated entry' }))
      .mockResolvedValueOnce(jsonRes({ assayResults: [{ id: 'res_1', schemaId: 'assaysch_A' }] }))

    await call(
      'create_entry',
      {
        name: 'Protein Concentration Assay',
        folder_id: 'lib_abc123',
        parts: [{ contentType: 'section', title: 'Results' }]
      },
      fetchImpl
    )
    await call('update_entry', { entry_id: 'etr_8rVKW0g7', name: 'Updated entry' }, fetchImpl)
    await call(
      'create_assay_results',
      { schema_id: 'assaysch_A', project_id: 'src_A', fields: { ct: 11.1 } },
      fetchImpl
    )

    expect(fetchImpl.mock.calls[0]).toEqual([
      'https://api.benchling.com/api/v3/entry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Protein Concentration Assay',
          folderId: 'lib_abc123',
          parts: [{ contentType: 'section', title: 'Results' }]
        })
      })
    ])
    expect(fetchImpl.mock.calls[1]).toEqual([
      'https://api.benchling.com/api/v3/entry/etr_8rVKW0g7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Updated entry' }) })
    ])
    expect(fetchImpl.mock.calls[2]).toEqual([
      'https://api.benchling.com/api/v2/assay-results',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          assayResults: [{ schemaId: 'assaysch_A', projectId: 'src_A', fields: { ct: 11.1 } }]
        })
      })
    ])
  })

  it('fails closed on missing tokens, malformed payloads, and rate limits', async () => {
    const noAuth = new ParserEngine({ fetchImpl: vi.fn() })
    await expect(noAuth.call(tool('get_entry'), { entry_id: 'etr_x' }, {})).rejects.toThrow(
      /connector_unauthenticated/
    )

    await expect(
      call('get_entry', { entry_id: 'etr_x' }, vi.fn().mockResolvedValue(jsonRes({ id: 'etr_x' })))
    ).rejects.toThrow(/missing entry name/)
    await expect(
      call('get_entry', { entry_id: 'etr_x' }, vi.fn().mockResolvedValue(jsonRes({}, 429)))
    ).rejects.toThrow(/HTTP 429/)
  })
})
