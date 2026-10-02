import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ConnectorCredentials } from '../types'
import { LABARCHIVES_TOOLS } from './labarchives'

const credentials: ConnectorCredentials = {
  labArchives: {
    accessKeyId: 'akid-test',
    accessPassword: 'secret-test',
    apiBaseUrl: 'https://api.labarchives.com'
  }
}
const tool = (id: string): (typeof LABARCHIVES_TOOLS)[number] =>
  LABARCHIVES_TOOLS.find((candidate) => candidate.id === id)!
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

const xml = (body: string, status = 200): Response => new Response(body, { status })

const epoch = '<response><epoch>1700000000000</epoch></response>'
const notebookInfo =
  '<response><notebook id="123.4" name="Lab Notebook" is-default="true" /></response>'
const entries =
  '<response><entries><entry id="987.6" name="Experiment 1" created="2026-10-01" /></entries></response>'

describe('LabArchives connector', () => {
  it('signs a read request and parses notebook metadata from XML', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(xml(epoch))
      .mockResolvedValueOnce(xml(notebookInfo))
    const result = await call('get_notebook_info', { uid: '42', nbid: '123.4' }, fetchImpl)

    const request = new URL(String(fetchImpl.mock.calls[1][0]))
    expect(request.origin + request.pathname).toBe(
      'https://api.labarchives.com/api/notebooks/notebook_info'
    )
    expect(request.searchParams.get('uid')).toBe('42')
    expect(request.searchParams.get('nbid')).toBe('123.4')
    expect(request.searchParams.get('akid')).toBe('akid-test')
    expect(request.searchParams.get('expires')).toBe('1700000000000')
    const signature = request.searchParams.get('sig')!
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(signature).not.toContain('%')
    const epochRequest = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(epochRequest.pathname).toBe('/api/utilities/epoch_time')
    expect(epochRequest.searchParams.get('akid')).toBe('akid-test')
    expect(epochRequest.searchParams.has('accessPassword')).toBe(false)
    expect(result).toEqual({
      notebooks: [{ id: '123.4', name: 'Lab Notebook', is_default: true }]
    })
  })

  it('parses notebook entries and strips unknown XML attributes', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(xml(epoch)).mockResolvedValueOnce(xml(entries))
    const result = await call('list_entries', { uid: '42', nbid: '123.4' }, fetchImpl)

    expect(result).toEqual({
      entries: [{ id: '987.6', name: 'Experiment 1', created: '2026-10-01' }]
    })
  })

  it('maps create_entry as a non-retried signed write-back', async () => {
    expect(
      LABARCHIVES_TOOLS.filter((candidate) => candidate.approvalClass === 'write-back').map(
        (candidate) => candidate.id
      )
    ).toEqual(['create_entry'])
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(xml(epoch))
      .mockResolvedValueOnce(
        xml('<response><entry id="987.6" name="New result" created="2026-10-01" /></response>')
      )

    const result = await call(
      'create_entry',
      { uid: '42', nbid: '123.4', name: 'New result', content: 'Result body' },
      fetchImpl
    )

    expect(fetchImpl.mock.calls[0][0]).toContain('/api/utilities/epoch_time')
    expect(fetchImpl.mock.calls[1][0]).toContain('/api/entries/create_entry')
    expect(fetchImpl.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/x-www-form-urlencoded' })
      })
    )
    expect(String(fetchImpl.mock.calls[1][1].body)).toContain('name=New+result')
    expect(result).toEqual({ id: '987.6', name: 'New result', created: '2026-10-01' })
  })

  it('fails closed without credentials, on malformed XML, and on HTTP errors', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('list_entries'),
        { uid: '42', nbid: '1' },
        {}
      )
    ).rejects.toThrow(/connector_unauthenticated/)
    await expect(
      call(
        'get_notebook_info',
        { uid: '42', nbid: '1' },
        vi.fn().mockResolvedValueOnce(xml(epoch)).mockResolvedValueOnce(xml('<response/>'))
      )
    ).rejects.toThrow(/notebook/)
    await expect(
      call('get_notebook_info', { uid: '42', nbid: '1' }, vi.fn().mockResolvedValue(xml('', 429)))
    ).rejects.toThrow(/HTTP 429/)
  })
})
