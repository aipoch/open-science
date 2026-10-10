import { afterEach, describe, it, expect, vi } from 'vitest'
import { delimiter } from 'node:path'
import { buildTransport as createTransport } from '@aipoch/connector-mcp-client'
import { mcpHostDependencies } from './mcp-host-dependencies'
import { configureTestElectronHost } from '../../../test/runtime-host'
const buildTransport: typeof createTransport = (config, auth, deps) =>
  createTransport(config, auth, { ...mcpHostDependencies, ...deps })
import { EXTRA_PATH_DIRS } from '../settings/shell-path'
const { netFetch } = vi.hoisted(() => ({ netFetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: netFetch } }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  netFetch.mockReset()
})

describe('host MCP transport wiring', () => {
  const stdioTransportEnvironment = (env?: Record<string, string>): Record<string, string> => {
    const transport = buildTransport({
      id: 'srv-stdio',
      name: 'stdio-server',
      transport: 'stdio',
      command: 'npx',
      env
    }) as unknown as { _serverParams: { env?: Record<string, string> } }

    return transport._serverParams.env ?? {}
  }

  it('augments the stdio PATH while preserving explicitly configured environment values', () => {
    const childEnv = stdioTransportEnvironment({ CUSTOM_API_KEY: 'configured-secret' })
    const pathDirs = childEnv?.PATH?.split(delimiter) ?? []

    expect(pathDirs).toEqual(expect.arrayContaining(EXTRA_PATH_DIRS))
    expect(childEnv?.CUSTOM_API_KEY).toBe('configured-secret')
  })

  it('keeps an explicitly configured stdio PATH ahead of the augmented directories', () => {
    const customPath = '/custom/bin'
    const pathDirs = stdioTransportEnvironment({ PATH: customPath }).PATH?.split(delimiter) ?? []

    expect(pathDirs[0]).toBe(customPath)
    expect(pathDirs).toEqual(expect.arrayContaining(EXTRA_PATH_DIRS))
  })

  it('routes streamable HTTP requests through the configured Electron proxy session', async () => {
    const directFetch = vi.fn().mockRejectedValue(new Error('direct path unavailable'))
    vi.stubGlobal('fetch', directFetch)
    netFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = buildTransport({
      id: 'srv-http',
      name: 'http-server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })

    await transport.start()
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    expect(netFetch).toHaveBeenCalledWith(
      'https://mcp.example.test/',
      expect.objectContaining({ method: 'POST' })
    )
    expect(directFetch).not.toHaveBeenCalled()
    await transport.close()
  })
})

await configureTestElectronHost(await import('electron'))

it('connects the shared credential policy before stderr reaches the host logger', () => {
  const warn = vi.fn()
  const transport = buildTransport(
    { id: 'policy', name: 'fixture', transport: 'stdio', command: 'unused' },
    undefined,
    { logger: { warn } }
  ) as import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  ;(transport.stderr as import('node:stream').Writable).write(
    'HTTP 429 Authorization: Bearer opaque-secret\n'
  )
  const output = JSON.stringify(warn.mock.calls)
  expect(output).toContain('HTTP 429')
  expect(output).not.toContain('opaque-secret')
})
