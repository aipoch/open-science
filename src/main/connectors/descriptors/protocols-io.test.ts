import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ConnectorCredentials } from '../types'
import { PROTOCOLS_IO_TOOLS } from './protocols-io'

const credentials: ConnectorCredentials = { oauthTokens: { 'protocols-io': 'protocols-token' } }
const tool = (id: string): (typeof PROTOCOLS_IO_TOOLS)[number] =>
  PROTOCOLS_IO_TOOLS.find((candidate) => candidate.id === id)!
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
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('protocols.io connector', () => {
  it('maps authenticated protocol reads and parses identity and step counts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        id: 12345,
        title: 'Chromatin immunoprecipitation',
        description: 'ChIP protocol',
        doi: 'dx.doi.org/10.17504/protocols.io.test',
        url: 'https://www.protocols.io/view/chip',
        created_on: 1700000000,
        updated_on: 1700000100,
        steps: [{ step: 'Fix cells' }, { step: 'Lyse' }]
      })
    )
    const result = await call('get_protocol', { protocol_id: '12345' }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.protocols.io/api/v3/protocols/12345',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer protocols-token' })
      })
    )
    expect(result).toEqual({
      id: '12345',
      title: 'Chromatin immunoprecipitation',
      description: 'ChIP protocol',
      doi: 'dx.doi.org/10.17504/protocols.io.test',
      url: 'https://www.protocols.io/view/chip',
      created_on: 1700000000,
      updated_on: 1700000100,
      step_count: 2
    })
  })

  it('maps run pagination and parses run records with missing optional fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        runs: [
          { id: 7, protocol_id: 12345, title: 'Run A', started_at: '2026-10-01T08:00:00Z' },
          { id: 8, protocol_id: 12345, title: 'Run B', notes: 'partial' }
        ],
        next_page: 3
      })
    )
    await expect(
      call('list_protocol_runs', { protocol_id: '12345', page: 2, page_size: 25 }, fetchImpl)
    ).resolves.toEqual({
      runs: [
        {
          id: '7',
          protocol_id: '12345',
          title: 'Run A',
          started_at: '2026-10-01T08:00:00Z',
          completed_at: null,
          notes: null,
          status: null
        },
        {
          id: '8',
          protocol_id: '12345',
          title: 'Run B',
          started_at: null,
          completed_at: null,
          notes: 'partial',
          status: null
        }
      ],
      next_page: 3
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.protocols.io/api/v3/protocols/12345/runs?page=2&page_size=25'
    )
  })

  it('maps write-back run creation and updates without retrying mutations', async () => {
    expect(
      PROTOCOLS_IO_TOOLS.filter((candidate) => candidate.approvalClass === 'write-back').map(
        (candidate) => candidate.id
      )
    ).toEqual(['create_run', 'update_run'])
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 7, protocol_id: 12345, title: 'Run A' }))
      .mockResolvedValueOnce(
        jsonRes({ id: 7, protocol_id: 12345, title: 'Run A revised', status: 'complete' })
      )

    await call(
      'create_run',
      {
        protocol_id: '12345',
        title: 'Run A',
        started_at: '2026-10-01T08:00:00Z',
        notes: 'Started'
      },
      fetchImpl
    )
    await call(
      'update_run',
      { protocol_id: '12345', run_id: '7', title: 'Run A revised', status: 'complete' },
      fetchImpl
    )

    expect(fetchImpl.mock.calls[0]).toEqual([
      'https://www.protocols.io/api/v3/protocols/12345/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'Run A',
          started_at: '2026-10-01T08:00:00Z',
          notes: 'Started'
        })
      })
    ])
    expect(fetchImpl.mock.calls[1]).toEqual([
      'https://www.protocols.io/api/v3/protocols/12345/runs/7',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Run A revised', status: 'complete' })
      })
    ])
  })

  it('fails closed on missing OAuth, malformed payloads, and HTTP failures', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(tool('get_protocol'), { protocol_id: '1' }, {})
    ).rejects.toThrow(/connector_unauthenticated/)
    await expect(
      call('get_protocol', { protocol_id: '1' }, vi.fn().mockResolvedValue(jsonRes({ id: 1 })))
    ).rejects.toThrow(/missing protocol title/)
    await expect(
      call('list_protocol_runs', { protocol_id: '1' }, vi.fn().mockResolvedValue(jsonRes({}, 429)))
    ).rejects.toThrow(/HTTP 429/)
  })
})
