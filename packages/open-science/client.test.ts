import { describe, expect, it, vi } from 'vitest'

import { OpenScienceClient } from './index.mjs'

const response = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('OpenScienceClient', () => {
  it('starts and waits for a run through the authenticated versioned API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(202, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'running',
            startedAt: 1,
            artifacts: []
          }
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'running',
            startedAt: 1,
            artifacts: []
          }
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'completed',
            startedAt: 1,
            completedAt: 2,
            output: 'Done',
            artifacts: []
          }
        })
      )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch,
      sleep: vi.fn().mockResolvedValue(undefined)
    })

    const started = await client.startRun({ project: 'project-1', prompt: 'Research this.' })
    const completed = await client.waitForRun(started.id)

    expect(completed).toMatchObject({ status: 'completed', output: 'Done' })
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:44100/api/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' })
      })
    )
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('surfaces stable API errors without including the authentication token', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(404, {
        error: { code: 'project_not_found', message: 'Project not found: missing' }
      })
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'do-not-leak',
      fetch
    })

    await expect(client.listSessions('missing')).rejects.toMatchObject({
      code: 'project_not_found',
      status: 404,
      message: 'Project not found: missing'
    })
    await expect(client.listSessions('missing')).rejects.not.toThrow('do-not-leak')
  })
})
