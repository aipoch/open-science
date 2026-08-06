import { describe, expect, it } from 'vitest'

import { buildConnectorTemplateExport, parseConnectorTemplate } from './connector-template'

describe('Connector configuration templates', () => {
  it('parses a credential-free stdio template', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-research',
        slug: 'example-research',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/research-mcp'],
        requiredSecrets: { environment: ['API_TOKEN'] }
      })
    )

    expect(preview).toEqual({
      ready: true,
      diagnostics: [],
      definition: {
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-research',
        slug: 'example-research',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/research-mcp'],
        requiredSecrets: { environment: ['API_TOKEN'] }
      }
    })
  })

  it('parses a remote OAuth template without requiring client-specific fields', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        oauth: { authorizationServerUrl: 'https://auth.example.test', scopes: ['openid'] }
      })
    )

    expect(preview.ready).toBe(true)
    expect(preview.definition?.oauth).toEqual({
      authorizationServerUrl: 'https://auth.example.test',
      scopes: ['openid']
    })
  })

  it('derives a safe Connector ID from a display name and accepts an explicit portable ID', () => {
    const derived = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Example OAuth E2E',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        oauth: {}
      })
    )
    expect(derived.definition?.slug).toBe('example-oauth-e2e')

    const explicit = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Example OAuth E2E',
        slug: 'example-e2e',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp'
      })
    )
    expect(explicit.definition?.slug).toBe('example-e2e')
  })

  it.each([
    [{ env: { API_TOKEN: 'secret' } }, 'Unknown field "env"'],
    [{ headers: { Authorization: 'Bearer secret' } }, 'Unknown field "headers"'],
    [{ args: ['--api-key=secret'] }, 'appears to contain a credential'],
    [{ url: 'https://mcp.example.test/mcp?token=secret' }, 'credential-like query parameter']
  ])('rejects secret-bearing or unknown fields', (extra, message) => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-server',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        ...extra
      })
    )

    expect(preview.ready).toBe(false)
    expect(preview.diagnostics.some((item) => item.message.includes(message))).toBe(true)
  })

  it('rejects credential query fields without blocking ordinary field names', () => {
    const credential = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-secret-query',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp?token_key=secret'
      })
    )
    expect(credential.diagnostics.map((item) => item.code)).toContain(
      'connector-template.url-secret'
    )

    const ordinary = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-ordinary-query',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp?monkey=capuchin&postcode=100000'
      })
    )
    expect(ordinary.ready).toBe(true)
  })

  it('accepts local paths with portability warnings', () => {
    const local = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-server',
        transport: 'stdio',
        command: 'node',
        args: ['/Users/example/bin/server.mjs', '--stdio']
      })
    )

    expect(local.ready).toBe(true)
    expect(local.diagnostics).toContainEqual({
      severity: 'warning',
      code: 'connector-template.local-argument',
      message: 'args[0] uses a local path and may need to be changed on another computer.',
      path: 'args[0]'
    })

    const localCommand = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-command',
        transport: 'stdio',
        command: '/opt/example/bin/server'
      })
    )
    expect(localCommand.ready).toBe(true)
    expect(localCommand.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'connector-template.local-command',
        path: 'command'
      })
    )
  })

  it('rejects conflicting OAuth headers and installed names', () => {
    const oauthHeaders = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { scopes: ['openid'] },
        requiredSecrets: { headers: ['Authorization'] }
      })
    )
    expect(oauthHeaders.diagnostics.map((item) => item.code)).toContain(
      'connector-template.oauth-headers'
    )

    const remoteEnvironment = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        requiredSecrets: { environment: ['API_TOKEN'] }
      })
    )
    expect(remoteEnvironment.diagnostics.map((item) => item.code)).toContain(
      'connector-template.remote-environment'
    )

    const duplicate = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Example Server',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingNames: ['example server'] }
    )
    expect(duplicate.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-name'
    )

    const duplicateSlug = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Different display name',
        slug: 'example-server',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingSlugs: ['example-server'] }
    )
    expect(duplicateSlug.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-slug'
    )

    const legacyAliasCollision = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Different display name',
        slug: 'legacy-route',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingIds: ['installed-uuid'], existingNames: ['legacy-route'] }
    )
    expect(legacyAliasCollision.diagnostics.map((item) => item.code)).toContain(
      'connector-template.identity-conflict'
    )

    const uuidAliasCollision = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'Different display name',
        slug: 'installed-uuid',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingIds: ['installed-uuid'] }
    )
    expect(uuidAliasCollision.diagnostics.map((item) => item.code)).toContain(
      'connector-template.identity-conflict'
    )
  })

  it('exports only secret names and produces a stable digest', () => {
    const result = buildConnectorTemplateExport({
      id: 'local-id',
      slug: 'example-server',
      name: 'example-server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      environmentNames: ['API_TOKEN']
    })

    expect(result.preview).toMatchObject({
      ready: true,
      connectorId: 'local-id',
      suggestedFileName: 'open-science-connector-example-server.json'
    })
    expect(result.preview.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.contents).toContain('"environment": [')
    expect(result.contents).not.toContain('local-id')
    expect(result.contents).not.toContain('secret')
  })
})
