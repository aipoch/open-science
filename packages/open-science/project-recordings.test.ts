import { describe, expect, it, vi } from 'vitest'
import { OpenScienceClient } from './index.mjs'

describe('project recording SDK facade', () => {
  it('sends authenticated bounded controls and receiver-only reads without starting a browser itself', async () => {
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
    const target = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
    const requests = {
      inspect: { viewerId: 'viewer' },
      start: { viewerId: 'viewer', request: { requestId: 'r1', sourceViewId: 'desktop-viewer' } },
      status: { viewerId: 'viewer' },
      pause: { viewerId: 'viewer', request: { requestId: 'r2', recordingId: 'recording' } },
      resume: { viewerId: 'viewer', request: { requestId: 'r3', recordingId: 'recording' } },
      stop: { viewerId: 'viewer', request: { requestId: 'r4', recordingId: 'recording' } },
      read: { target },
      openRecorded: { target },
      selectMoment: { viewerId: 'recorded-viewer', offsetMs: 1500 },
      selection: { viewerId: 'recorded-viewer' }
    }
    expect(Object.isFrozen(client.projectRecordings)).toBe(true)
    expect(Object.keys(client.projectRecordings)).toEqual(Object.keys(requests))
    for (const [method, value] of Object.entries(requests)) {
      await expect(client.projectRecordings[method](value)).resolves.toBeNull()
      expect(fetch).toHaveBeenLastCalledWith(
        `http://127.0.0.1:44100/api/v1/project-recordings/${method}`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: 'Bearer test' }),
          body: JSON.stringify(value)
        })
      )
    }
  })
  it('rejects paths, arbitrary URLs, ambiguous selection time, and unbound controls', () => {
    const fetch = vi.fn()
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'test',
      fetch
    })
    for (const [method, value] of [
      ['start', { viewerId: 'viewer', request: { requestId: 'r', url: 'http://evil' } }],
      ['start', { viewerId: 'viewer', request: {} }],
      ['stop', { viewerId: 'viewer', request: { requestId: 'r' } }],
      ['inspect', { viewerId: 'viewer', path: '/private' }],
      ['selectMoment', { viewerId: 'viewer', offsetMs: -1 }],
      ['selectMoment', { viewerId: 'viewer', offsetMs: 1.5 }],
      [
        'read',
        {
          target: {
            projectId: 'p',
            sessionId: 's',
            artifactId: 'a',
            versionId: 'v',
            url: 'http://evil'
          }
        }
      ]
    ] as const)
      expect(() => client.projectRecordings[method](value)).toThrow('Project recording requires')
    expect(fetch).not.toHaveBeenCalled()
  })
})
