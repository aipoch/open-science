import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'

const fetchRpc = (
  connection: { endpoint: string; socketPath?: string },
  init: RequestInit
): Promise<Response> => fetchLocalRpc(connection, init, 'Notebook user input RPC')

describe('NotebookLocalRpcServer user input bridge', () => {
  let server: NotebookLocalRpcServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('routes a session-bound MCP choice through the final ACP session id', async () => {
    const requestUserInput = vi.fn().mockResolvedValue({ action: 'answered', answer: 'Minimal' })
    server = new NotebookLocalRpcServer(
      { execute: async () => ({}), shutdown: async () => ({}) } as never,
      {
        requestUserInput
      }
    )
    const connection = await server.issueSessionConnection(
      'pre-session-alias',
      'project-1',
      'root-frame-pre-session-alias'
    )
    server.registerSessionAlias('pre-session-alias', 'session-1')

    const response = await fetchRpc(connection, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'requestUserInput',
        params: {
          sessionId: 'forged-session',
          questions: [
            {
              question: 'Which implementation should I use?',
              header: 'Approach',
              options: [
                { label: 'Minimal', description: 'Make the smallest focused change.' },
                { label: 'Expanded', description: 'Include optional extensions.' }
              ]
            },
            {
              question: 'Which output should I produce?',
              header: 'Output',
              options: [{ label: 'Notebook' }, { label: 'Report' }]
            }
          ]
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: { action: 'answered', answer: 'Minimal' }
    })
    expect(requestUserInput).toHaveBeenCalledWith({
      sessionId: 'session-1',
      questions: [
        {
          question: 'Which implementation should I use?',
          header: 'Approach',
          options: [
            { label: 'Minimal', description: 'Make the smallest focused change.' },
            { label: 'Expanded', description: 'Include optional extensions.' }
          ]
        },
        {
          question: 'Which output should I produce?',
          header: 'Output',
          options: [{ label: 'Notebook' }, { label: 'Report' }]
        }
      ]
    })
  })

  it('returns the runtime pending acknowledgement to the MCP client', async () => {
    const requestUserInput = vi.fn().mockResolvedValue({ action: 'pending' })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      requestUserInput
    })
    const connection = await server.issueSessionConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )

    const response = await fetchRpc(connection, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'requestUserInput',
        params: {
          sessionId: 'session-1',
          questions: [
            {
              question: 'Which implementation should I use?',
              options: [{ label: 'Minimal' }, { label: 'Expanded' }]
            }
          ]
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: { action: 'pending' } })
    expect(requestUserInput).toHaveBeenCalledOnce()
  })

  it('routes a delegated choice only through its capability-bound Frame and Attempt owner', async () => {
    const mainRequestUserInput = vi.fn()
    const delegatedRequestUserInput = vi.fn().mockResolvedValue({ action: 'pending' })
    server = new NotebookLocalRpcServer(
      { execute: async () => ({}), shutdown: async () => ({}) } as never,
      {
        requestUserInput: mainRequestUserInput,
        delegatedWorkService: {
          delegate: vi.fn(),
          requestUserInput: delegatedRequestUserInput
        }
      }
    )
    const connection = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'child-frame',
      attemptId: 'child-attempt',
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'child-runtime',
      promptMessageId: 'child-prompt',
      workspaceCwd: '/workspace/child-frame',
      isAttemptWritable: () => true
    })

    const rpcRequest = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'requestUserInput',
        params: {
          sessionId: 'forged-session',
          project_id: 'forged-project',
          frame_id: 'forged-frame',
          attempt_id: 'forged-attempt',
          questions: [
            {
              question: 'Which implementation should I use?',
              options: [{ label: 'Minimal' }, { label: 'Expanded' }]
            }
          ]
        }
      })
    }
    const response = await fetchRpc(connection, rpcRequest)
    const retry = await fetchRpc(connection, rpcRequest)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: { action: 'pending' } })
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toEqual({ result: { action: 'pending' } })
    expect(mainRequestUserInput).not.toHaveBeenCalled()
    expect(delegatedRequestUserInput).toHaveBeenCalledTimes(2)
    expect(delegatedRequestUserInput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        session: { projectId: 'project-1', sessionId: 'session-1' },
        frameId: 'child-frame',
        attemptId: 'child-attempt',
        role: 'delegate',
        originMessageId: 'child-prompt',
        toolInvocationId: expect.stringMatching(/^delegated-question:/)
      }),
      {
        sessionId: 'session-1',
        questions: [
          {
            question: 'Which implementation should I use?',
            options: [{ label: 'Minimal' }, { label: 'Expanded' }]
          }
        ]
      },
      expect.stringMatching(/^delegated-question:/)
    )
    expect(delegatedRequestUserInput.mock.calls[1][2]).toBe(
      delegatedRequestUserInput.mock.calls[0][2]
    )
    await connection.revoke()
  })

  it('rejects user-choice requests made with the server-wide token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      requestUserInput: vi.fn()
    })
    const connection = await server.ensureStarted()

    const response = await fetchRpc(connection, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'requestUserInput',
        params: {
          sessionId: 'forged-session',
          question: 'Which implementation should I use?',
          options: [{ label: 'A' }, { label: 'B' }]
        }
      })
    })

    expect(response.status).toBe(401)
  })
})
