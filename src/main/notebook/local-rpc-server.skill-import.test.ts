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
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
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
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')
    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: 'another-session', githubUrl }
      })
    })

    expect(response.status).toBe(200)
    expect(request).toHaveBeenCalledWith({ sessionId: 'session-1', githubUrl })

    const mixedSourceResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
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
    expect(mixedSourceResponse.status).toBe(400)
    expect(request).toHaveBeenCalledOnce()
  })

  it('rejects shared and out-of-scope RPC capabilities', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'cancelled', skills: [] })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    const connection = await server.issueSkillImportConnection('session-1')
    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'

    const sharedTokenResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: 'session-1', githubUrl }
      })
    })
    const outOfScopeResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'listRuntimes', params: {} })
    })
    connection.release?.()
    const releasedTokenResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'skillImport', params: { githubUrl } })
    })

    expect(sharedTokenResponse.status).toBe(401)
    expect(outOfScopeResponse.status).toBe(403)
    expect(releasedTokenResponse.status).toBe(401)
    expect(request).not.toHaveBeenCalled()
  })
})
