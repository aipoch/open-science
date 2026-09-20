import { describe, expect, it, vi } from 'vitest'
import { OpenScienceClient } from './index.mjs'
import { parseCliArgs, runTaskCommand } from './cli.mjs'

const cases = [
  ['listConnectors', [], '/api/v1/connectors', 'GET'],
  ['getConnector', ['a/b'], '/api/v1/connectors/a%2Fb', 'GET'],
  ['setConnectorEnabled', ['a', false], '/api/v1/connectors/a/enabled', 'PUT'],
  [
    'addConnector',
    [{ name: 'a', transport: 'stdio', command: 'node' }],
    '/api/v1/connectors',
    'POST'
  ],
  ['updateConnector', ['a', { transport: 'stdio', args: [] }], '/api/v1/connectors/a', 'PATCH'],
  ['removeConnector', ['a'], '/api/v1/connectors/a', 'DELETE'],
  ['testConnector', ['a'], '/api/v1/connectors/a/test', 'POST'],
  ['listCredentials', [], '/api/v1/credentials', 'GET'],
  [
    'createCredential',
    [{ kind: 'token', displayName: 'Token', secret: 'secret' }],
    '/api/v1/credentials',
    'POST'
  ],
  ['updateCredential', ['a', { secret: 'new-secret' }], '/api/v1/credentials/a', 'PATCH']
] as const

describe('Connector public client', () => {
  it.each(cases)('%s uses authenticated HTTP', async (method, args, path, verb) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { saved: true } })))
    const client = new OpenScienceClient({
      baseUrl: 'http://localhost:44100',
      token: 'test-token',
      fetch
    })
    await expect(client[method](...args)).resolves.toEqual({ saved: true })
    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:44100${path}`,
      expect.objectContaining({
        method: verb,
        headers: expect.objectContaining({ authorization: 'Bearer test-token' })
      })
    )
  })
})

describe('Connector CLI behavior', () => {
  it.each([
    ['list', [], 'listConnectors', []],
    ['show', ['a'], 'getConnector', ['a']],
    ['enable', ['a'], 'setConnectorEnabled', ['a', true]],
    ['disable', ['a'], 'setConnectorEnabled', ['a', false]],
    ['remove', ['a'], 'removeConnector', ['a']],
    ['test', ['a'], 'testConnector', ['a']]
  ])('%s dispatches and emits a single JSON result', async (action, ids, method, expected) => {
    const operation = vi.fn(async () => ({ id: 'a', enabled: false }))
    const log = vi.fn()
    await runTaskCommand(parseCliArgs(['connector', action, ...ids, '--json']), {
      connect: async () => ({ [method]: operation }),
      log
    })
    expect(operation).toHaveBeenCalledWith(...expected)
    expect(log.mock.calls).toEqual([[JSON.stringify({ id: 'a', enabled: false })]])
  })

  it('reads credentials from stdin without echoing them', async () => {
    const createCredential = vi.fn(async () => ({ createdCredential: { id: 'c' } }))
    const log = vi.fn()
    await runTaskCommand(parseCliArgs(['credential', 'add', '--json']), {
      connect: async () => ({ createCredential }),
      stdinIsTTY: false,
      readStdin: async () =>
        JSON.stringify({ kind: 'token', displayName: 'Token', secret: 'secret' }),
      log
    })
    expect(createCredential).toHaveBeenCalledWith({
      kind: 'token',
      displayName: 'Token',
      secret: 'secret'
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
})
