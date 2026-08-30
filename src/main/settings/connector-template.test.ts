import { describe, expect, it, vi } from 'vitest'

import {
  buildConnectorTemplateExport,
  parseConnectorTemplate,
  type ConnectorTemplateSource
} from './connector-template'

describe('Connector configuration templates', () => {
  it('parses a credential-free stdio template', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-research',
        display_name: 'Example Research',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/research-mcp'],
        required_secrets: { environment: ['API_TOKEN'] }
      })
    )

    expect(preview).toEqual({
      ready: true,
      diagnostics: [],
      definition: {
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'example-research',
        displayName: 'Example Research',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/research-mcp'],
        requiredSecrets: { environment: ['API_TOKEN'] }
      }
    })
  })

  it('imports multiple MCP client servers without importing credential values', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        mcpServers: {
          'local-search': {
            command: 'npx',
            args: ['-y', '@example/search-mcp'],
            env: { API_TOKEN: 'must-not-be-imported' }
          },
          'Remote Search': {
            type: 'streamable-http',
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer must-not-be-imported' }
          }
        }
      })
    )

    expect(preview.ready).toBe(true)
    expect(preview.sourceFormat).toBe('mcp-client')
    expect(preview.definitions).toEqual([
      expect.objectContaining({
        name: 'local-search',
        displayName: 'local-search',
        transport: 'stdio',
        requiredSecrets: { environment: ['API_TOKEN'] }
      }),
      expect.objectContaining({
        name: 'remote-search',
        displayName: 'Remote Search',
        transport: 'streamable_http',
        requiredSecrets: { headers: ['Authorization'] }
      })
    ])
    expect(JSON.stringify(preview)).not.toContain('must-not-be-imported')
    expect(preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'connector-template.normalized-name',
        'connector-template.secret-values-excluded'
      ])
    )
  })

  it('recognizes MCP Registry manifests without treating them as client configuration', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: 'io.example/search',
        packages: [{ registryType: 'npm', identifier: '@example/search' }]
      })
    )

    expect(preview).toMatchObject({
      ready: false,
      diagnostics: [{ code: 'connector-template.registry-manifest' }]
    })
  })

  it('rejects an MCP client entry whose explicit transport conflicts with its fields', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        mcpServers: {
          broken: { type: 'stdio', url: 'https://mcp.example.test/mcp' }
        }
      })
    )

    expect(preview.ready).toBe(false)
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'connector-template.transport-fields' })
    )
  })

  it('parses a remote OAuth template without requiring client-specific fields', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        display_name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        oauth: { authorization_server_url: 'https://auth.example.test', scopes: ['openid'] }
      })
    )

    expect(preview.ready).toBe(true)
    expect(preview.definition?.oauth).toEqual({
      authorizationServerUrl: 'https://auth.example.test',
      scopes: ['openid']
    })
  })

  it('requires a pre-registered client ID for redirect_uri', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'redirect-without-client',
        display_name: 'Redirect without client',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        oauth: { redirect_uri: 'http://127.0.0.1:8080/callback' }
      })
    )

    expect(preview.ready).toBe(false)
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'connector-template.oauth-redirect-uri-client',
        path: 'oauth.redirect_uri'
      })
    )
  })

  it('requires an explicit stable name separate from the display name', () => {
    const valid = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-oauth-e2e',
        display_name: 'Example OAuth E2E',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp',
        oauth: {}
      })
    )
    expect(valid.definition).toMatchObject({
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E'
    })

    const invalid = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'Example OAuth E2E',
        display_name: 'Example OAuth E2E',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp'
      })
    )
    expect(invalid.diagnostics.map((item) => item.code)).toContain('connector-template.name')
  })

  it('rejects legacy camelCase field names', () => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'open-science.connector',
        name: 'legacy-template',
        displayName: 'Legacy Template',
        transport: 'stdio',
        command: 'legacy-mcp'
      })
    )

    expect(preview.ready).toBe(false)
    expect(preview.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'connector-template.unknown-field',
          path: 'schemaVersion'
        }),
        expect.objectContaining({ code: 'connector-template.unknown-field', path: 'displayName' })
      ])
    )
  })

  it.each([
    [{ env: { API_TOKEN: 'secret' } }, 'Unknown field "env"'],
    [{ headers: { Authorization: 'Bearer secret' } }, 'Unknown field "headers"'],
    [{ args: ['--api-key=secret'] }, 'appears to contain a credential'],
    [{ args: ['--header', 'Authorization: Bearer secret'] }, 'appears to contain a credential'],
    [
      { args: ['--header', 'Authorization:', 'Bearer', 'secret'] },
      'appears to contain a credential'
    ],
    [{ args: ['--auth-token', 'secret'] }, 'appears to contain a credential'],
    [
      { args: ['--endpoint', 'https://mcp.example.test/mcp?auth_token=secret'] },
      'appears to contain a credential'
    ],
    [{ url: 'https://mcp.example.test/mcp?token=secret' }, 'credential-like query parameter']
  ])('rejects secret-bearing or unknown fields', (extra, message) => {
    const preview = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-server',
        display_name: 'example-server',
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
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-secret-query',
        display_name: 'example-secret-query',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp?token_key=secret'
      })
    )
    expect(credential.diagnostics.map((item) => item.code)).toContain(
      'connector-template.url-secret'
    )

    const ordinary = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-ordinary-query',
        display_name: 'example-ordinary-query',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/mcp?monkey=capuchin&postcode=100000'
      })
    )
    expect(ordinary.ready).toBe(true)
  })

  it('accepts local paths with portability warnings', () => {
    const local = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-server',
        display_name: 'example-server',
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
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-command',
        display_name: 'example-command',
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
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        display_name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { scopes: ['openid'] },
        required_secrets: { headers: ['Authorization'] }
      })
    )
    expect(oauthHeaders.diagnostics.map((item) => item.code)).toContain(
      'connector-template.oauth-headers'
    )

    const remoteEnvironment = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-remote',
        display_name: 'example-remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        required_secrets: { environment: ['API_TOKEN'] }
      })
    )
    expect(remoteEnvironment.diagnostics.map((item) => item.code)).toContain(
      'connector-template.remote-environment'
    )

    const duplicate = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'example-server',
        display_name: 'Another display label',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingNames: ['example-server'] }
    )
    expect(duplicate.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-name'
    )

    const reusedDisplayName = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'different-route',
        display_name: 'example-server',
        transport: 'stdio',
        command: 'example-mcp'
      }),
      { existingNames: ['example-server'] }
    )
    expect(reusedDisplayName.ready).toBe(true)
  })

  it('exports only secret names and produces a stable digest', () => {
    const source: ConnectorTemplateSource = {
      id: 'local-id',
      name: 'example-server',
      displayName: 'Example Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      environmentNames: ['API_TOKEN']
    }
    const result = buildConnectorTemplateExport(source)

    expect(result.preview).toMatchObject({
      ready: true,
      connectorId: 'local-id',
      suggestedFileName: 'open-science-connector-example-server.json'
    })
    expect(result.preview.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(buildConnectorTemplateExport(source).preview.digest).toBe(result.preview.digest)
    expect(
      buildConnectorTemplateExport({ ...source, description: 'Changed' }).preview.digest
    ).not.toBe(result.preview.digest)
    expect(JSON.parse(result.contents!)).toEqual({
      schema_version: 1,
      kind: 'open-science.connector',
      name: 'example-server',
      display_name: 'Example Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      required_secrets: { environment: ['API_TOKEN'] }
    })
    expect(result.contents).not.toContain('local-id')
    expect(JSON.parse(result.mcpClientContents!)).toEqual({
      mcpServers: {
        'example-server': {
          command: 'npx',
          args: ['-y', '@example/mcp'],
          env: { API_TOKEN: '${API_TOKEN}' }
        }
      }
    })
    expect(result.preview.mcpClientDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.preview.mcpClientSuggestedFileName).toBe('mcp-example-server.json')
  })

  it('withholds both export formats when historical arguments contain split credentials', () => {
    const result = buildConnectorTemplateExport({
      id: 'unsafe-id',
      name: 'unsafe-server',
      displayName: 'Unsafe Server',
      transport: 'stdio',
      command: 'example-mcp',
      args: ['--header', 'Authorization:', 'Bearer', 'plaintext-secret']
    })

    expect(result.preview).toMatchObject({
      ready: false,
      connectorId: 'unsafe-id',
      diagnostics: [expect.objectContaining({ code: 'connector-template.argument-secret' })]
    })
    expect(result.preview.digest).toBeUndefined()
    expect(result.preview.suggestedFileName).toBeUndefined()
    expect(result.preview.mcpClientDigest).toBeUndefined()
    expect(result.preview.mcpClientSuggestedFileName).toBeUndefined()
    expect(result.contents).toBeUndefined()
    expect(result.mcpClientContents).toBeUndefined()
  })

  it('exports remote MCP client transport labels and excludes OAuth state', () => {
    const result = buildConnectorTemplateExport({
      id: 'remote-id',
      name: 'remote-search',
      displayName: 'Remote Search',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/mcp',
      oauth: { scopes: ['openid'] }
    })

    expect(JSON.parse(result.mcpClientContents!)).toEqual({
      mcpServers: {
        'remote-search': {
          type: 'http',
          url: 'https://mcp.example.test/mcp'
        }
      }
    })
    expect(result.preview.mcpClientDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'connector-template.mcp-oauth-excluded' })
    )
  })

  it('invalidates an export preview when the process-local cache resets', async () => {
    const source: ConnectorTemplateSource = {
      id: 'local-id',
      name: 'example-server',
      displayName: 'Example Server',
      transport: 'stdio',
      command: 'npx'
    }
    const digest = buildConnectorTemplateExport(source).preview.digest

    vi.resetModules()
    const freshModule = await import('./connector-template')

    expect(freshModule.buildConnectorTemplateExport(source).preview.digest).not.toBe(digest)
  })

  it('bounds the process-local export preview cache', () => {
    const source: ConnectorTemplateSource = {
      id: 'local-id',
      name: 'example-server',
      displayName: 'Example Server',
      transport: 'stdio',
      command: 'npx'
    }
    const digest = buildConnectorTemplateExport(source).preview.digest

    for (let index = 0; index < 64; index += 1) {
      buildConnectorTemplateExport({ ...source, description: `Preview ${index}` })
    }

    expect(buildConnectorTemplateExport(source).preview.digest).not.toBe(digest)
  })

  it('exports OAuth field names in snake_case', () => {
    const result = buildConnectorTemplateExport({
      id: 'remote-id',
      name: 'example-remote',
      displayName: 'Example Remote',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/mcp',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        scopes: ['openid'],
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback'
      },
      hasOAuthClientSecret: true
    })

    const exported = JSON.parse(result.contents!)
    expect(exported.schema_version).toBe(1)
    expect(exported.oauth).toEqual({
      authorization_server_url: 'https://auth.example.test',
      scopes: ['openid'],
      client_id: 'registered-client',
      redirect_uri: 'http://127.0.0.1:8080/callback'
    })
    expect(exported.required_secrets).toEqual({ oauth_client_secret: true })
    expect(exported.oauth).not.toHaveProperty('client_secret')

    expect(parseConnectorTemplate(result.contents!).definition).toMatchObject({
      schemaVersion: 1,
      oauth: {
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback'
      },
      requiredSecrets: { oauthClientSecret: true }
    })
  })

  it('imports pre-registered OAuth fields as optional schema v1 additions', () => {
    const extended = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'static-oauth',
        display_name: 'Static OAuth',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: {
          authorization_server_url: 'https://auth.example.test',
          client_id: 'registered-client',
          redirect_uri: 'http://127.0.0.1:8080/callback'
        }
      })
    )
    expect(extended).toMatchObject({
      ready: true,
      definition: {
        schemaVersion: 1,
        oauth: {
          clientId: 'registered-client',
          redirectUri: 'http://127.0.0.1:8080/callback'
        }
      }
    })

    const legacy = parseConnectorTemplate(
      JSON.stringify({
        schema_version: 1,
        kind: 'open-science.connector',
        name: 'legacy-oauth',
        display_name: 'Legacy OAuth',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { scopes: ['openid'] }
      })
    )
    expect(legacy).toMatchObject({ ready: true, definition: { schemaVersion: 1 } })
  })
})
