import { describe, expect, it } from 'vitest'

import { PRE_REGISTERED_PERMISSION_IDENTITIES } from '../permission-grants/identity-catalog'
import { appMcpServerAliases, resolveCanonicalMcpToolIdentity } from './app-mcp-names'

const APP_MCP_CODEC_CASES = PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool.flatMap((key) => {
  const identity = key.slice('mcp:'.length)
  const separator = identity.indexOf('/')
  const server = identity.slice(0, separator)
  const tool = identity.slice(separator + 1)
  const safeServer = server.replace(/[^a-zA-Z0-9_]/g, '_')
  return [
    [server, `mcp__${safeServer}__${tool}`, identity],
    [server, `mcp.${server}.${tool}`, identity],
    [server, `${safeServer}_${tool}`, identity]
  ] as const
})

describe('resolveCanonicalMcpToolIdentity', () => {
  it.each([
    'mcp__open-science-notebook__notebook_execute',
    'mcp.open-science-notebook.notebook_execute',
    'open_science_notebook_notebook_execute'
  ])('normalizes a configured framework alias %s', (reportedName) => {
    expect(resolveCanonicalMcpToolIdentity(reportedName, ['open-science-notebook'])).toBe(
      'open-science-notebook/notebook_execute'
    )
  })

  it('does not turn an unregistered Claude MCP prefix into durable identity', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__reported-only__dangerous_tool', [])
    ).toBeUndefined()
  })

  it.each(APP_MCP_CODEC_CASES)(
    'maps every registered app MCP identity from %s using provider name %s',
    (server, reportedName, identity) => {
      expect(resolveCanonicalMcpToolIdentity(reportedName, [server])).toBe(identity)
    }
  )

  it('normalizes framework-safe aliases for configured dynamic servers', () => {
    expect(appMcpServerAliases('custom-server')).toEqual(['custom-server', 'custom_server'])
    expect(resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('mcp.custom_server.lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('custom_server_lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
  })

  it('rejects a sanitized dynamic server alias when configured names collide', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', [
        'custom-server',
        'custom_server'
      ])
    ).toBeUndefined()
  })
})
