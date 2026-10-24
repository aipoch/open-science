import { describe, it, expect, vi } from 'vitest'
import { OpenScienceClient } from './index.mjs'
describe('research Replay SDK', () => {
  it('offers only read and view methods and preserves exact bounded selection requests', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: null }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'test',
      fetch
    })
    const inputs = {
      open: { target: { projectId: 'p', sessionId: 's' } },
      read: { viewerId: 'v', query: { kind: 'steps', offset: 20, limit: 10 } },
      select: { viewerId: 'v', position: { branchId: 'b', stepId: 's', timeMs: 25 } },
      selection: { viewerId: 'v', selectionId: 'saved' },
      revoke: { viewerId: 'v' }
    }
    expect(Object.isFrozen(client.replays)).toBe(true)
    expect(Object.keys(client.replays)).toEqual(Object.keys(inputs))
    for (const [method, input] of Object.entries(inputs)) {
      await expect(client.replays[method](input)).resolves.toBeNull()
      expect(fetch).toHaveBeenLastCalledWith(
        `http://127.0.0.1:44100/api/v1/replays/${method}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
          headers: expect.objectContaining({ authorization: 'Bearer test' })
        })
      )
    }
  })
  it('keeps archived state selectors separate from the original research step and reads the same selection back', async () => {
    const selected = {
      selectionId: 'saved-state',
      observation: {
        recordingId: 'archive',
        stepKey: 'observation-0',
        record: { observedAt: 1185 }
      }
    }
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: selected }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'test',
      fetch
    })
    const request = {
      viewerId: 'viewer',
      position: {
        branchId: 'branch',
        stepId: 'original-notebook-step',
        timeMs: 40000,
        observation: { recordingId: 'archive-descriptor', stepKey: 'observation-0' }
      }
    }
    expect(await client.replays.select(request)).toEqual(selected)
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/replays/select'),
      expect.objectContaining({ body: JSON.stringify(request) })
    )
    expect(
      await client.replays.selection({ viewerId: 'viewer', selectionId: selected.selectionId })
    ).toEqual(selected)
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/replays/selection'),
      expect.objectContaining({
        body: JSON.stringify({ viewerId: 'viewer', selectionId: 'saved-state' })
      })
    )
  })
  it('rejects missing receiver scope and unbound reads before transport', () => {
    const fetch = vi.fn(),
      client = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 'test', fetch })
    expect(() => client.replays.open({ target: { projectId: 'p' } })).toThrow(
      'receiving Project and Session'
    )
    expect(() => client.replays.selection({})).toThrow('viewer ID')
    expect(() => client.replays.read(null)).toThrow('object request')
    expect(fetch).not.toHaveBeenCalled()
  })
})
