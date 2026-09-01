import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  }
}))

const { DeviceCredentialStore, credentialReference, parseCredentialReference } =
  await import('./device-credentials')
const { assertStoredDeviceCredentialLimits } = await import('./device-credential-resource-limits')
const { encryptKey } = await import('./crypto')

describe('DeviceCredentialStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'osci-device-credentials-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('persists only encrypted static credential material in a versioned device document', async () => {
    const store = new DeviceCredentialStore(root)
    const created = await store.create({
      displayName: 'Lab API',
      kind: 'api_key',
      secret: 'raw-secret'
    })

    const raw = await readFile(join(root, 'credentials.json'), 'utf8')
    expect(raw).not.toContain('raw-secret')
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      credentials: [{ id: created.id, displayName: 'Lab API', kind: 'api_key' }]
    })
    await expect(
      store.resolveStatic(created.id, { kind: 'header', name: 'X-Api-Key' })
    ).resolves.toBe('raw-secret')
  })

  it.each([
    [
      'kind',
      { displayName: 'Invalid kind', kind: 'password', secret: 'secret' },
      /unsupported credential kind/i
    ],
    [
      'OAuth transport',
      {
        displayName: 'Invalid transport',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'websocket',
        oauth: {}
      },
      /unsupported OAuth transport/i
    ]
  ])('rejects an invalid credential %s before persistence', async (_case, request, error) => {
    const store = new DeviceCredentialStore(root)

    await expect(store.create(request as never)).rejects.toThrow(error)
    await expect(store.list()).resolves.toEqual([])
  })

  it.each([
    [{ id: 'invalid', displayName: 'Invalid', kind: 'password' }, /unsupported credential kind/i],
    [
      {
        id: 'invalid',
        displayName: 'Invalid',
        kind: 'oauth',
        transport: 'websocket'
      },
      /unsupported OAuth transport/i
    ]
  ])('rejects invalid stored credential discriminants before writing', (credential, error) => {
    expect(() => assertStoredDeviceCredentialLimits(credential as never)).toThrow(error)
  })

  it.each([
    [
      'name',
      { displayName: 'n'.repeat(129), kind: 'api_key' as const, secret: 'secret' },
      'Credential name must not exceed 128 characters.'
    ],
    [
      'secret',
      { displayName: 'Large secret', kind: 'api_key' as const, secret: 's'.repeat(16_385) },
      'Credential value must not exceed 16384 bytes.'
    ],
    [
      'scope count',
      {
        displayName: 'Many scopes',
        kind: 'oauth' as const,
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http' as const,
        oauth: { scopes: Array.from({ length: 33 }, (_, index) => `scope-${index}`) }
      },
      'OAuth scopes must not exceed 32 entries.'
    ],
    [
      'scope length',
      {
        displayName: 'Long scope',
        kind: 'oauth' as const,
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http' as const,
        oauth: { scopes: ['s'.repeat(129)] }
      },
      'OAuth scope must not exceed 128 characters.'
    ]
  ])('rejects an oversized credential %s before persistence', async (_case, request, error) => {
    const store = new DeviceCredentialStore(root)

    await expect(store.create(request)).rejects.toThrow(error)
    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects an oversized complete credential record before persistence', async () => {
    const store = new DeviceCredentialStore(root)
    const repeatedPath = '😀'.repeat(2_022)

    await expect(
      store.create({
        displayName: 'Large OAuth record',
        kind: 'oauth',
        resourceUri: `https://mcp.example.test/${repeatedPath}`,
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: `https://auth.example.test/${repeatedPath}`,
          clientId: '😀'.repeat(2_048),
          redirectUri: `http://127.0.0.1/${repeatedPath}`,
          scopes: Array.from({ length: 32 }, () => '😀'.repeat(128)),
          clientSecret: 's'.repeat(16_384)
        }
      })
    ).rejects.toThrow('Device credential must not exceed 65536 serialized bytes.')
    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects creating a credential after the durable device limit is reached', async () => {
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        version: 1,
        credentials: Array.from({ length: 128 }, (_, index) => ({
          id: `credential-${index}`,
          displayName: `Credential ${index}`,
          kind: 'api_key',
          secretRef: 'enc:ciphertext',
          createdAt: index,
          updatedAt: index
        }))
      })
    )
    const store = new DeviceCredentialStore(root)

    await expect(
      store.create({ displayName: 'Overflow', kind: 'api_key', secret: 'secret' })
    ).rejects.toThrow('Device credential limit of 128 reached.')
    await expect(store.list()).resolves.toHaveLength(128)
  })

  it('applies Bearer only to Authorization headers for token credentials', async () => {
    const store = new DeviceCredentialStore(root)
    const token = await store.create({ displayName: 'Session', kind: 'token', secret: 'abc' })

    await expect(
      store.resolveStatic(token.id, { kind: 'header', name: 'Authorization' })
    ).resolves.toBe('Bearer abc')
    await expect(store.resolveStatic(token.id, { kind: 'header', name: 'X-Token' })).resolves.toBe(
      'abc'
    )
    await expect(store.resolveStatic(token.id, { kind: 'env', name: 'TOKEN' })).resolves.toBe('abc')
  })

  it('stores OAuth config separately from encrypted mutable state', async () => {
    const store = new DeviceCredentialStore(root)
    const created = await store.create({
      displayName: 'Research OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/resource#ignored',
      transport: 'streamable_http',
      oauth: { scopes: ['read', 'read'] }
    })
    await store.saveOAuthState(created.id, {
      tokens: { access_token: 'access', token_type: 'bearer' }
    })

    const raw = await readFile(join(root, 'credentials.json'), 'utf8')
    expect(raw).not.toContain('access')
    await expect(store.resolveOAuth(created.id)).resolves.toMatchObject({
      resourceUri: 'https://mcp.example.test/resource',
      transport: 'streamable_http',
      oauth: { scopes: ['read'] },
      hasClientSecret: false,
      state: { tokens: { access_token: 'access' } }
    })
    expect(store.view((await store.list())[0]!)).toMatchObject({ status: 'connected' })
  })

  it('rejects a public HTTP OAuth resource URL before persistence', async () => {
    const store = new DeviceCredentialStore(root)

    await expect(
      store.create({
        displayName: 'Insecure OAuth',
        kind: 'oauth',
        resourceUri: 'http://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).rejects.toThrow('Remote MCP server URL must use HTTPS or loopback HTTP.')
    await expect(store.list()).resolves.toEqual([])
  })

  it.each(['http://localhost:3000/mcp', 'http://127.0.0.2:3000/mcp'])(
    'accepts a loopback HTTP OAuth resource URL: %s',
    async (resourceUri) => {
      const store = new DeviceCredentialStore(root)

      await expect(
        store.create({
          displayName: 'Local OAuth',
          kind: 'oauth',
          resourceUri,
          transport: 'streamable_http',
          oauth: {}
        })
      ).resolves.toMatchObject({ resourceUri })
    }
  )

  it.each([
    ['oversized', { tokens: { access_token: 'x'.repeat(256 * 1024), token_type: 'Bearer' } }],
    ['malformed', { tokens: [] }]
  ])('fails closed on %s decrypted OAuth state', async (_case, state) => {
    const store = new DeviceCredentialStore(root)
    const created = await store.create({
      displayName: 'Recovered OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {}
    })
    const document = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'))
    document.credentials[0].stateRef = encryptKey(JSON.stringify(state))
    await writeFile(join(root, 'credentials.json'), JSON.stringify(document))

    await expect(store.resolveOAuth(created.id)).resolves.toMatchObject({ state: undefined })
    expect(store.view((await store.list())[0]!)).toMatchObject({ status: 'disconnected' })
  })

  it.each([
    [
      'resource URL',
      {
        resourceUri: 'https://mcp.example.test/?access_token=plaintext',
        oauth: {}
      }
    ],
    [
      'client metadata URL',
      {
        resourceUri: 'https://mcp.example.test/',
        oauth: { clientMetadataUrl: 'https://user:secret@client.example.test/metadata' }
      }
    ],
    [
      'authorization server URL',
      {
        resourceUri: 'https://mcp.example.test/',
        oauth: { authorizationServerUrl: 'https://auth.example.test/?api_key=plaintext' }
      }
    ],
    [
      'redirect URI',
      {
        resourceUri: 'https://mcp.example.test/',
        oauth: { redirectUri: 'http://127.0.0.1/callback?token=plaintext' }
      }
    ]
  ])('rejects credentials embedded in an OAuth %s', async (_description, input) => {
    const store = new DeviceCredentialStore(root)

    await expect(
      store.create({
        displayName: 'Unsafe OAuth',
        kind: 'oauth',
        transport: 'streamable_http',
        ...input
      })
    ).rejects.toThrow(/cannot contain credentials/i)
  })

  it.each([
    [
      'client ID without an authorization server',
      { clientId: 'registered-client' },
      /authorization server URL is required/i
    ],
    [
      'client metadata with a pre-registered client',
      {
        clientMetadataUrl: 'https://client.example.test/metadata',
        authorizationServerUrl: 'https://auth.example.test/',
        clientId: 'registered-client'
      },
      /client metadata URL cannot be combined/i
    ],
    [
      'redirect URI without a client ID',
      { redirectUri: 'http://127.0.0.1/callback' },
      /redirect URI requires a pre-registered client ID/i
    ],
    ['client secret without a client ID', { clientSecret: 'secret' }, /client ID is required/i]
  ])('rejects an invalid OAuth registration: %s', async (_description, oauth, error) => {
    const store = new DeviceCredentialStore(root)

    await expect(
      store.create({
        displayName: 'Invalid OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth
      })
    ).rejects.toThrow(error)
    await expect(store.list()).resolves.toEqual([])
  })

  it.each([
    'https://example.test/callback',
    'http://localhost/callback',
    'http://127.0.0.1/callback#fragment'
  ])('rejects a redirect URI that the OAuth runtime cannot bind: %s', async (redirectUri) => {
    const store = new DeviceCredentialStore(root)

    await expect(
      store.create({
        displayName: 'Invalid redirect OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          redirectUri
        }
      })
    ).rejects.toThrow(/http:\/\/127\.0\.0\.1 loopback URL/i)
    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects a persisted redirect URI that the OAuth runtime cannot bind', async () => {
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: 'oauth-invalid-redirect',
            displayName: 'Invalid redirect OAuth',
            kind: 'oauth',
            resourceUri: 'https://mcp.example.test/',
            transport: 'streamable_http',
            oauth: {
              authorizationServerUrl: 'https://auth.example.test/',
              clientId: 'registered-client',
              redirectUri: 'https://example.test/callback'
            },
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )

    await expect(new DeviceCredentialStore(root).list()).rejects.toThrow(
      /http:\/\/127\.0\.0\.1 loopback URL/i
    )
  })

  it('rejects a persisted OAuth resource that is neither HTTPS nor loopback HTTP', async () => {
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: 'oauth-insecure-resource',
            displayName: 'Insecure OAuth',
            kind: 'oauth',
            resourceUri: 'http://mcp.example.test/',
            transport: 'streamable_http',
            oauth: {},
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )

    await expect(new DeviceCredentialStore(root).list()).rejects.toThrow(/HTTPS|loopback/u)
  })

  it('round-trips explicit connector references', () => {
    expect(parseCredentialReference(credentialReference('credential-id'))).toBe('credential-id')
    expect(parseCredentialReference('enc:ciphertext')).toBeUndefined()
  })
})
