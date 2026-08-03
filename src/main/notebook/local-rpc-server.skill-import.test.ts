import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('NotebookLocalRpcServer Skill import bridge', () => {
  it('routes an MCP Skill import request through the final conversation id', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint } = await server.ensureStarted()

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: {
          sessionId: 'pre-session-alias',
          turnToken: '00000000-0000-4000-8000-000000000001',
          attachmentUri: 'file:///managed/session/demo.skill'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: {
        status: 'imported',
        skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
      }
    })
    expect(request).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnToken: '00000000-0000-4000-8000-000000000001',
      attachmentUri: 'file:///managed/session/demo.skill'
    })
  })

  it('routes a GitHub Skill import through the active conversation', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'cancelled', skills: [] })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint } = await server.ensureStarted()
    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: 'pre-session-alias', githubUrl }
      })
    })

    expect(response.status).toBe(200)
    expect(request).toHaveBeenCalledWith({ sessionId: 'session-1', githubUrl })

    const mixedSourceResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: {
          sessionId: 'pre-session-alias',
          githubUrl,
          turnToken: '00000000-0000-4000-8000-000000000001',
          attachmentUri: 'file:///managed/session/demo.skill'
        }
      })
    })
    expect(mixedSourceResponse.status).toBe(500)
    expect(request).toHaveBeenCalledOnce()
  })
})
