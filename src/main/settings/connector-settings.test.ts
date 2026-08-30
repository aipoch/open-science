import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AddCustomServerRequest, ConnectorsSnapshot } from '../../shared/settings'

const keychain = vi.hoisted(() => ({ available: true }))

// Reversible fake safeStorage so secrets can be encrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plaintext: string) => {
      if (!keychain.available) throw new Error('Encryption is unavailable')
      return Buffer.from(`cipher:${plaintext}`, 'utf8')
    },
    decryptString: (buffer: Buffer) => {
      if (!keychain.available) throw new Error('Encryption is unavailable')
      return buffer.toString('utf8').slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { ConnectorSettingsModule } = await import('./connector-settings')
const { CustomServerIdConflictError } = await import('./custom-server-identity')
const { SettingsRepository } = await import('./repository')
const { ALL_CONNECTOR_IDS } = await import('../connectors/registry')

// Exercises the durable Connector owner against a real on-disk repository.
describe('ConnectorSettingsModule', () => {
  let dir: string
  let service: InstanceType<typeof ConnectorSettingsModule>
  let repository: InstanceType<typeof SettingsRepository>
  const addCustomServer = (
    request: Omit<AddCustomServerRequest, 'displayName'> & { displayName?: string }
  ): Promise<ConnectorsSnapshot> =>
    service.addCustomServer({ ...request, displayName: request.displayName ?? request.name })

  beforeEach(async () => {
    keychain.available = true
    dir = await mkdtemp(join(tmpdir(), 'osci-svc-connectors-'))
    repository = new SettingsRepository(dir)
    service = new ConnectorSettingsModule(repository)
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists every bundled connector, all enabled and not auto-allowed by default', async () => {
    const snapshot = await service.listConnectors()

    expect(snapshot.connectors).toHaveLength(ALL_CONNECTOR_IDS.length)
    expect(snapshot.connectors.every((c) => c.enabled)).toBe(true)
    expect(snapshot.connectors.every((c) => !c.autoAllow)).toBe(true)
    expect(snapshot.customServers).toEqual([])
    expect(snapshot.ncbi).toEqual({ contactEmail: undefined, hasApiKey: false })
    expect(snapshot.openAlex).toEqual({ hasApiKey: false })
  })

  it('disables and re-enables one connector', async () => {
    let snapshot = await service.setConnectorEnabled({ id: 'chemistry', enabled: false })
    expect(snapshot.connectors.find((c) => c.id === 'chemistry')?.enabled).toBe(false)
    // Others stay enabled.
    expect(snapshot.connectors.find((c) => c.id === 'pubmed')?.enabled).toBe(true)

    snapshot = await service.setConnectorEnabled({ id: 'chemistry', enabled: true })
    expect(snapshot.connectors.find((c) => c.id === 'chemistry')?.enabled).toBe(true)
  })

  it('toggles connector auto-allow (skip approvals)', async () => {
    const snapshot = await service.setConnectorAutoAllow({ id: 'biomart', autoAllow: true })
    expect(snapshot.connectors.find((c) => c.id === 'biomart')?.autoAllow).toBe(true)
  })

  it('returns connector detail with tools defaulting to allow', async () => {
    const detail = await service.getConnectorDetail('chemistry')

    expect(detail.id).toBe('chemistry')
    expect(detail.tools.length).toBeGreaterThan(0)
    expect(detail.tools.every((t) => t.permission === 'allow')).toBe(true)
    expect(detail.tools[0].id).toBe(`chemistry/${detail.tools[0].method}`)
  })

  it('cycles a tool through block, ask, and back to allow', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id

    const blocked = await service.setToolPermission({ toolId, permission: 'block' })
    expect(blocked.tools.find((t) => t.id === toolId)?.permission).toBe('block')

    const asked = await service.setToolPermission({ toolId, permission: 'ask' })
    expect(asked.tools.find((t) => t.id === toolId)?.permission).toBe('ask')

    const allowed = await service.setToolPermission({ toolId, permission: 'allow' })
    expect(allowed.tools.find((t) => t.id === toolId)?.permission).toBe('allow')
  })

  it('never keeps a tool in both ask and blocked sets', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id

    await service.setToolPermission({ toolId, permission: 'ask' })
    await service.setToolPermission({ toolId, permission: 'block' })
    const c = await service.getConnectors()
    expect(c?.askToolIds ?? []).not.toContain(toolId)
    expect(c?.blockedToolIds ?? []).toContain(toolId)
  })

  it('treats block as stronger than ask when reading inconsistent stored policy', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id
    await repository.setToolPolicy(toolId, true, false)
    await repository.setToolBlocked(toolId, true)

    const detail = await service.getConnectorDetail('chemistry')

    expect(detail.tools.find((tool) => tool.id === toolId)?.permission).toBe('block')
  })

  it('stores contact email and reports hasApiKey without exposing the key', async () => {
    const snapshot = await service.setNcbiCredentials({
      contactEmail: 'me@lab.org',
      apiKey: 'secret-key'
    })

    expect(snapshot.ncbi.contactEmail).toBe('me@lab.org')
    expect(snapshot.ncbi.hasApiKey).toBe(true)
    // The raw key never appears in the renderer snapshot.
    expect(JSON.stringify(snapshot)).not.toContain('secret-key')
  })

  it('preserves an omitted NCBI key and clears an explicit empty key', async () => {
    await service.setNcbiCredentials({ contactEmail: 'first@lab.org', apiKey: 'secret-key' })

    let snapshot = await service.setNcbiCredentials({ contactEmail: 'second@lab.org' })
    expect(snapshot.ncbi).toEqual({ contactEmail: 'second@lab.org', hasApiKey: true })

    snapshot = await service.setNcbiCredentials({ contactEmail: 'second@lab.org', apiKey: '' })
    expect(snapshot.ncbi).toEqual({ contactEmail: 'second@lab.org', hasApiKey: false })
  })

  it('does not report undecryptable credentials as configured', async () => {
    await service.setNcbiCredentials({ apiKey: 'ncbi-secret' })
    await service.setOpenAlexCredential({ apiKey: 'openalex-secret' })
    await addCustomServer({
      name: 'local-secrets',
      transport: 'stdio',
      command: 'example-mcp',
      env: { API_TOKEN: 'local-secret', DAMAGED_TOKEN: 'damaged-secret' }
    })
    await addCustomServer({
      name: 'remote-secrets',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer remote-secret' }
    })
    await addCustomServer({
      name: 'oauth-secrets',
      transport: 'streamable_http',
      url: 'https://example.com/oauth-mcp',
      oauth: {
        authorizationServerUrl: 'https://example.com/oauth',
        clientId: 'registered-client',
        clientSecret: 'client-secret'
      }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.find(
      ({ name }) => name === 'local-secrets'
    )
    await repository.updateCustomServer(stored!.id, {
      ...stored!,
      envRefs: { ...stored!.envRefs, DAMAGED_TOKEN: 'not-a-key-ref' }
    })
    expect(
      (await service.listConnectors()).customServers.find(({ name }) => name === 'local-secrets')
    ).toMatchObject({ hasEnv: false, enabled: false, availability: 'credential_unavailable' })

    keychain.available = false
    const snapshot = await service.listConnectors()

    expect({
      ncbi: snapshot.ncbi.hasApiKey,
      openAlex: snapshot.openAlex?.hasApiKey,
      localEnv: snapshot.customServers.find(({ name }) => name === 'local-secrets')?.hasEnv,
      remoteHeaders: snapshot.customServers.find(({ name }) => name === 'remote-secrets')
        ?.hasHeaders,
      oauthClientSecret: snapshot.customServers.find(({ name }) => name === 'oauth-secrets')?.oauth
        ?.hasClientSecret
    }).toEqual({
      ncbi: false,
      openAlex: false,
      localEnv: false,
      remoteHeaders: false,
      oauthClientSecret: false
    })
  })

  it('encrypts OpenAlex at rest and exposes only configured state', async () => {
    let snapshot = await service.setOpenAlexCredential({ apiKey: 'openalex-secret' })
    expect(snapshot.openAlex).toEqual({ hasApiKey: true })
    expect(JSON.stringify(snapshot)).not.toContain('openalex-secret')

    const raw = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(raw).not.toContain('openalex-secret')
    expect(JSON.parse(raw).connectors.openAlexApiKeyRef).toMatch(/^enc:/)

    snapshot = await service.setOpenAlexCredential({ apiKey: '' })
    expect(snapshot.openAlex).toEqual({ hasApiKey: false })
  })

  it('validates an OpenAlex key without persisting or returning the secret', async () => {
    const openAlexFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const validatingService = new ConnectorSettingsModule(repository, openAlexFetch)

    const result = await validatingService.validateOpenAlexCredential({
      apiKey: 'openalex-secret'
    })

    expect(result).toEqual({ valid: true })
    const requestUrl = openAlexFetch.mock.calls[0]?.[0]
    expect(requestUrl).toBeInstanceOf(URL)
    expect((requestUrl as URL).origin).toBe('https://api.openalex.org')
    expect((requestUrl as URL).pathname).toBe('/rate-limit')
    expect((requestUrl as URL).searchParams.get('api_key')).toBe('openalex-secret')
    expect(JSON.stringify(result)).not.toContain('openalex-secret')
    expect((await repository.getSettings()).connectors?.openAlexApiKeyRef).toBeUndefined()
  })

  it('accepts a rate-limited OpenAlex key as valid', async () => {
    const rateLimitedService = new ConnectorSettingsModule(
      repository,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }))
    )

    await expect(
      rateLimitedService.validateOpenAlexCredential({ apiKey: 'rate-limited-key' })
    ).resolves.toEqual({ valid: true })
  })

  it('classifies rejected, malformed, and unavailable OpenAlex validation attempts', async () => {
    const rejectedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }))
    const rejectedService = new ConnectorSettingsModule(repository, rejectedFetch)
    await expect(
      rejectedService.validateOpenAlexCredential({ apiKey: 'rejected-key' })
    ).resolves.toEqual({ valid: false, reason: 'rejected' })

    await expect(
      rejectedService.validateOpenAlexCredential({ apiKey: 'contains spaces' })
    ).resolves.toEqual({ valid: false, reason: 'invalid-format' })
    expect(rejectedFetch).toHaveBeenCalledTimes(1)

    const unavailableService = new ConnectorSettingsModule(
      repository,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    )
    await expect(
      unavailableService.validateOpenAlexCredential({ apiKey: 'openalex-key' })
    ).resolves.toEqual({ valid: false, reason: 'unavailable' })
  })

  it('throws for an unknown connector id', async () => {
    await expect(service.getConnectorDetail('nope')).rejects.toThrow(/Unknown connector/)
  })

  it('adds, toggles, and removes a local (stdio) custom server', async () => {
    let snapshot = await addCustomServer({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      description: 'Memory server'
    })
    expect(snapshot.customServers).toHaveLength(1)
    const added = snapshot.customServers[0]
    expect(added).toMatchObject({
      name: 'my-mem',
      displayName: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      description: 'Memory server'
    })
    expect(added.id).toBe('my-mem')

    snapshot = await service.setCustomServerEnabled({ id: added.id, enabled: false })
    expect(snapshot.customServers[0].enabled).toBe(false)

    await repository.setConnectorAutoAllow(added.name, true)
    await repository.setToolPolicy(`${added.name}/lookup`, true, false)
    const prunePermissions = vi.fn(async (serverId: string) => {
      expect(serverId).toBe(added.id)
      const persisted = (await repository.getSettings()).connectors
      expect(persisted?.customMcpServers ?? []).toEqual([])
      expect(persisted?.pendingCustomServerDeletionIds).toEqual([added.id])
    })
    snapshot = await service.removeCustomServer({ id: added.id }, prunePermissions)
    expect(snapshot.customServers).toEqual([])
    expect(prunePermissions).toHaveBeenCalledOnce()
    const afterRemoval = (await repository.getSettings()).connectors
    expect(afterRemoval?.autoAllowIds).not.toContain(added.name)
    expect(afterRemoval?.askToolIds ?? []).not.toContain(`${added.name}/lookup`)
    expect(afterRemoval?.pendingCustomServerDeletionIds).toBeUndefined()
  })

  it('retains a deletion journal and reserves its ID when permission pruning fails', async () => {
    const added = await addCustomServer({
      name: 'recoverable-delete',
      transport: 'stdio',
      command: 'npx'
    })
    const id = added.customServers[0].id

    await expect(
      service.removeCustomServer({ id }, async () => {
        throw new Error('grant cleanup failed')
      })
    ).rejects.toThrow('grant cleanup failed')

    const persisted = (await repository.getSettings()).connectors
    expect(persisted?.customMcpServers ?? []).toEqual([])
    expect(persisted?.pendingCustomServerDeletionIds).toEqual([id])
    expect((await service.listConnectors()).reservedCustomServerIds).toEqual([id])
    await expect(
      service.addCustomServer({
        id,
        name: 'replacement',
        displayName: 'Replacement',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use')

    const replacement = await service.addCustomServer({
      name: id,
      displayName: 'Replacement',
      transport: 'stdio',
      command: 'npx'
    })
    expect(replacement.customServers[0].id).not.toBe(id)
    expect(replacement.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    const retryCleanup = vi.fn(async () => undefined)
    const retried = await service.removeCustomServer({ id }, retryCleanup)
    expect(retryCleanup).toHaveBeenCalledWith(id)
    expect(retried.reservedCustomServerIds).toEqual([])
    expect(retried.customServers).toEqual(replacement.customServers)
  })

  it('uses a valid user-provided custom server ID', async () => {
    const snapshot = await service.addCustomServer({
      id: 'research-memory',
      name: 'my-mem',
      displayName: 'My memory',
      transport: 'stdio',
      command: 'npx'
    })

    expect(snapshot.customServers[0].id).toBe('research-memory')
  })

  it('falls back to a UUID when the inferred custom server ID is reserved', async () => {
    const snapshot = await service.addCustomServer({
      name: 'mcp-research',
      displayName: 'MCP Research',
      transport: 'stdio',
      command: 'npx'
    })

    expect(snapshot.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('falls back to a UUID when an inferred ID loses a repository race', async () => {
    const persist = vi.spyOn(repository, 'addCustomServer')
    persist.mockRejectedValueOnce(new CustomServerIdConflictError())

    const snapshot = await service.addCustomServer({
      name: 'rna-reviewer',
      displayName: 'RNA reviewer',
      transport: 'stdio',
      command: 'npx'
    })

    expect(persist).toHaveBeenCalledTimes(2)
    expect(snapshot.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('rejects invalid or already-used custom server IDs', async () => {
    await expect(
      service.addCustomServer({
        id: 'hello ee',
        name: 'first-server',
        displayName: 'First server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID may only contain lowercase letters, numbers, and hyphens.')

    await service.addCustomServer({
      id: 'research-memory',
      name: 'second-server',
      displayName: 'Second server',
      transport: 'stdio',
      command: 'npx'
    })
    await expect(
      service.addCustomServer({
        id: 'research-memory',
        name: 'third-server',
        displayName: 'Third server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use.')

    await expect(
      service.addCustomServer({
        id: 'second-server',
        name: 'fourth-server',
        displayName: 'Fourth server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use.')
    await expect(
      service.addCustomServer({
        id: 'fifth-server',
        name: 'research-memory',
        displayName: 'Fifth server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('already exists')
  })

  it('advertises only safe custom Connector Skills from the successful materialization projection', async () => {
    await addCustomServer({
      name: 'custom-catalog',
      transport: 'stdio',
      command: 'example-mcp'
    })

    expect(await service.provisionedConnectorSkillNames()).not.toContain('mcp-custom-catalog')

    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [
        'mcp-custom-catalog',
        'mcp-custom-catalog',
        'mcp-second',
        'mcp-pubmed',
        'mcp-../../escape',
        'mcp-UPPER'
      ],
      availability: () => undefined,
      isRefreshing: () => false
    })

    expect(await service.provisionedConnectorSkillNames()).toContain('mcp-custom-catalog')
    expect(
      service.connectorSkillNames({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: [...ALL_CONNECTOR_IDS]
      })
    ).toEqual(['mcp-custom-catalog', 'mcp-second'])
    expect(
      service.connectorSkillCatalogEntries({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: [...ALL_CONNECTOR_IDS]
      })
    ).toEqual([
      { directory: 'mcp-custom-catalog', name: 'mcp-custom-catalog', source: 'connector' },
      { directory: 'mcp-second', name: 'mcp-second', source: 'connector' }
    ])
  })

  it('projects runtime availability separately from logical enablement', async () => {
    const added = await addCustomServer({
      name: 'offline-server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const id = added.customServers[0].id
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [],
      availability: (serverId) => (serverId === id ? 'unavailable' : undefined),
      isRefreshing: () => false
    })

    const [server] = (await service.listConnectors()).customServers

    expect(server).toMatchObject({ id, enabled: true, availability: 'unavailable' })

    const [disabled] = (await service.setCustomServerEnabled({ id, enabled: false })).customServers
    expect(disabled).toMatchObject({ id, enabled: false })
    expect(disabled.availability).toBeUndefined()
  })

  it('does not block listing while the current runtime refresh is still pending', async () => {
    const added = await addCustomServer({
      name: 'late-offline-server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const id = added.customServers[0].id
    const runtimeProjection = {
      materializedSkillNames: () => [],
      availability: () => undefined,
      isRefreshing: () => true
    }
    service.setCustomServerRuntimeProjectionProvider(runtimeProjection)

    const [server] = (await service.listConnectors()).customServers

    expect(server).toMatchObject({ id, enabled: true, checking: true })
  })

  it('projects checking only for the custom server currently being refreshed', async () => {
    const first = await service.addCustomServer({
      name: 'refreshing-server',
      displayName: 'Refreshing server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const refreshingId = first.customServers[0].id
    const second = await service.addCustomServer({
      name: 'settled-server',
      displayName: 'Settled server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const settledId = second.customServers.find((server) => server.id !== refreshingId)!.id
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [],
      availability: () => undefined,
      isRefreshing: (serverId) => serverId === refreshingId
    })

    const servers = (await service.listConnectors()).customServers

    expect(servers.find((server) => server.id === refreshingId)).toMatchObject({ checking: true })
    expect(servers.find((server) => server.id === settledId)?.checking).toBeUndefined()
  })

  it('rejects duplicate and built-in custom connector names', async () => {
    await addCustomServer({
      name: 'example-server',
      transport: 'stdio',
      command: 'example-mcp'
    })

    await expect(
      addCustomServer({
        name: 'example-server',
        displayName: 'Another label',
        transport: 'stdio',
        command: 'another-mcp'
      })
    ).rejects.toThrow('already exists')
    await expect(
      addCustomServer({ name: 'chemistry', transport: 'stdio', command: 'example-mcp' })
    ).rejects.toThrow('reserved by a built-in connector')
  })

  it('separates the display name from the immutable invocation name', async () => {
    const snapshot = await addCustomServer({
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    })

    expect(snapshot.customServers[0]).toMatchObject({
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E'
    })
    await expect(
      addCustomServer({
        name: 'example-oauth-e2e',
        displayName: 'Another display name',
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('already exists')
  })

  it('allows display labels to match stored local IDs', async () => {
    const existing = await addCustomServer({
      name: 'stable-route',
      displayName: 'legacy-route',
      transport: 'stdio',
      command: 'example-mcp'
    })

    const added = await addCustomServer({
      name: 'legacy-route',
      displayName: existing.customServers[0].id,
      transport: 'stdio',
      command: 'example-mcp'
    })
    expect(added.customServers.map((server) => server.name)).toEqual(
      expect.arrayContaining(['legacy-route', 'stable-route'])
    )
  })

  it('fails closed when a legacy Connector derives a bundled route', async () => {
    await repository.addCustomServer({
      id: 'legacy-reserved-route',
      name: 'Chemistry!',
      transport: 'stdio',
      enabled: true,
      command: 'legacy-command'
    } as never)

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers[0]).toMatchObject({
      name: 'chemistry',
      displayName: 'Chemistry!',
      enabled: false,
      availability: 'unavailable'
    })
  })

  it('fails closed when legacy Connectors derive the same route', async () => {
    await repository.addCustomServer({
      id: 'legacy-duplicate-a',
      name: 'Duplicate MCP',
      transport: 'stdio',
      enabled: true,
      command: 'first-command'
    } as never)
    await repository.addCustomServer({
      id: 'legacy-duplicate-b',
      name: 'Duplicate-MCP!',
      transport: 'stdio',
      enabled: true,
      command: 'second-command'
    } as never)

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers).toHaveLength(2)
    expect(snapshot.customServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: false, availability: 'unavailable' }),
        expect.objectContaining({ enabled: false, availability: 'unavailable' })
      ])
    )
  })

  it('exports only credential names and validates imports against installed connectors', async () => {
    const snapshot = await addCustomServer({
      id: 'internal-export-id',
      name: 'example-export',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/research-mcp'],
      env: { API_TOKEN: 'must-not-export' }
    })

    const result = await service.buildCustomServerTemplateExport(snapshot.customServers[0].id)
    expect(result.preview).toMatchObject({ ready: true, connectorId: snapshot.customServers[0].id })
    expect(result.contents).toContain('API_TOKEN')
    expect(result.contents).not.toContain('must-not-export')
    expect(result.contents).not.toContain('internal-export-id')

    const imported = await service.previewCustomServerTemplateImport(result.contents!)
    expect(imported.ready).toBe(false)
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-name'
    )
  })

  it('adds a remote (streamable_http) custom server with a url', async () => {
    const snapshot = await addCustomServer({
      name: 'remote-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' }
    })
    expect(snapshot.customServers[0]).toMatchObject({
      name: 'remote-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp'
    })
  })

  it('stores OAuth configuration publicly and OAuth state encrypted', async () => {
    const snapshot = await addCustomServer({
      name: 'oauth-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      oauth: {
        authorizationServerUrl: 'https://example.com/oauth',
        scopes: ['openid', 'profile']
      }
    })
    const id = snapshot.customServers[0].id
    expect(snapshot.customServers[0].enabled).toBe(false)
    expect(snapshot.customServers[0].oauth).toEqual({
      authorizationServerUrl: 'https://example.com/oauth',
      scopes: ['openid', 'profile'],
      hasTokens: false,
      hasClientSecret: false
    })
    expect(snapshot.customServers[0].availability).toBe('unauthenticated')
    await expect(service.setCustomServerEnabled({ id, enabled: true })).rejects.toThrow('Sign in')

    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'oauth-access', token_type: 'Bearer' }
    })
    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).not.toContain('oauth-access')
    expect(storedJson).toContain('oauthRef')

    const resolved = (await service.getConnectors())?.customMcpServers?.[0]
    expect(resolved?.oauthState?.tokens?.access_token).toBe('oauth-access')
    const connected = (await service.listConnectors()).customServers[0]
    expect(connected.oauth?.hasTokens).toBe(true)
    expect(connected.availability).toBeUndefined()
    expect(connected.enabled).toBe(false)

    const enabled = await service.setCustomServerEnabled({ id, enabled: true })
    expect(enabled.customServers[0].enabled).toBe(true)
  })

  it('stores a pre-registered client secret as an encrypted ref and applies explicit edit semantics', async () => {
    const added = await addCustomServer({
      name: 'oauth-static',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        clientSecret: 'local-client-secret',
        redirectUri: 'http://127.0.0.1:8080/callback'
      }
    })
    const id = added.customServers[0].id

    expect(added.customServers[0].oauth).toEqual({
      authorizationServerUrl: 'https://auth.example.test',
      clientId: 'registered-client',
      redirectUri: 'http://127.0.0.1:8080/callback',
      hasTokens: false,
      hasClientSecret: true
    })
    expect(JSON.stringify(added)).not.toContain('local-client-secret')
    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('oauthClientSecretRef')
    expect(storedJson).toContain('registered-client')
    expect(storedJson).toContain('http://127.0.0.1:8080/callback')
    expect(storedJson).not.toContain('local-client-secret')
    expect((await service.getConnectors())?.customMcpServers?.[0].oauthClientSecret).toBe(
      'local-client-secret'
    )
    const exported = await service.buildCustomServerTemplateExport(id)
    expect(exported.contents).not.toContain('local-client-secret')
    expect(JSON.parse(exported.contents!).schema_version).toBe(1)
    expect(JSON.parse(exported.contents!).oauth).toEqual({
      authorization_server_url: 'https://auth.example.test',
      client_id: 'registered-client',
      redirect_uri: 'http://127.0.0.1:8080/callback'
    })
    expect(JSON.parse(exported.contents!).required_secrets).toEqual({
      oauth_client_secret: true
    })

    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'static-token', token_type: 'Bearer' }
    })
    await service.updateCustomServer({
      id,
      displayName: 'Renamed static client',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback'
      }
    })
    let stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeDefined()
    expect(stored?.oauthRef).toBeDefined()

    const cleared = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback',
        clientSecret: null
      }
    })
    stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
    expect(cleared.customServers[0].oauth?.hasClientSecret).toBe(false)
  })

  it('requires an authorization-server URL for a pre-registered client', async () => {
    await expect(
      addCustomServer({
        name: 'oauth-static-without-issuer',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { clientId: 'registered-client' }
      })
    ).rejects.toThrow('Authorization server URL is required')
  })

  it('requires a pre-registered client ID for a redirect URI', async () => {
    await expect(
      addCustomServer({
        name: 'oauth-redirect-without-client',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { redirectUri: 'http://127.0.0.1:8080/callback' }
      })
    ).rejects.toThrow('OAuth redirect URI requires a pre-registered client ID.')
  })

  it('clears a saved client secret when its bound authorization-server issuer changes', async () => {
    const added = await addCustomServer({
      name: 'oauth-static-issuer-change',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth-one.example.test',
        clientId: 'registered-client',
        clientSecret: 'issuer-bound-secret'
      }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'issuer-token', token_type: 'Bearer' }
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth-two.example.test',
        clientId: 'registered-client'
      }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
    expect(updated.customServers[0]).toMatchObject({
      enabled: false,
      oauth: { hasClientSecret: false, hasTokens: false }
    })
  })

  it('clears OAuth credentials when the remote endpoint changes', async () => {
    const added = await addCustomServer({
      name: 'oauth-endpoint',
      transport: 'streamable_http',
      url: 'https://one.example/mcp',
      oauth: { scopes: ['openid'] }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'endpoint-token', token_type: 'Bearer' }
    })
    await service.setCustomServerEnabled({ id, enabled: true })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://two.example/mcp'
    })

    expect(updated.customServers[0]).toMatchObject({
      url: 'https://two.example/mcp',
      enabled: false,
      availability: 'unauthenticated',
      oauth: { hasTokens: false }
    })
    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthRef).toBeUndefined()
  })

  it('clears OAuth when switching a remote Connector to local transport', async () => {
    const added = await addCustomServer({
      name: 'oauth-to-local',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: { scopes: ['openid'] }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'remote-token', token_type: 'Bearer' }
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'stdio',
      command: 'local-command'
    })

    expect(updated.customServers[0]).toMatchObject({
      transport: 'stdio',
      command: 'local-command'
    })
    expect(updated.customServers[0].oauth).toBeUndefined()
    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauth).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
  })

  it('keeps OAuth and static-header authentication mutually exclusive', async () => {
    await expect(
      addCustomServer({
        name: 'invalid-auth',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer stale' },
        oauth: { scopes: ['openid'] }
      })
    ).rejects.toThrow('OAuth and static headers cannot be configured together')

    const added = await addCustomServer({
      name: 'switch-auth',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer static' }
    })
    await service.updateCustomServer({
      id: added.customServers[0].id,
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: {},
      oauth: { scopes: ['openid'] }
    })

    const stored = (await service.getConnectors())?.customMcpServers?.[0]
    expect(stored?.oauth).toEqual({ scopes: ['openid'] })
    expect(stored?.headers).toBeUndefined()
    expect(stored?.headerRefs).toBeUndefined()
  })

  it('rejects credential-bearing arguments when adding a custom server', async () => {
    await expect(
      addCustomServer({
        name: 'unsafe-arguments',
        transport: 'stdio',
        command: 'example-mcp',
        args: ['--token=plaintext-secret']
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it.each([
    'https://user:plaintext-secret@mcp.example.test',
    'https://mcp.example.test?api_key=plaintext-secret'
  ])('rejects a credential-bearing URL when updating a custom server', async (url) => {
    const added = await addCustomServer({
      name: 'unsafe-url-update',
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })

    await expect(
      service.updateCustomServer({
        id: added.customServers[0].id,
        transport: 'streamable_http',
        url
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]?.url).toBe(
      'https://mcp.example.test'
    )
  })

  it('rejects an invalid custom server (stdio without a command)', async () => {
    await expect(addCustomServer({ name: 'bad', transport: 'stdio' })).rejects.toThrow(
      /Invalid custom connector/
    )
  })

  it('does not expose custom-server env or header secrets in the view', async () => {
    const snapshot = await addCustomServer({
      name: 'secretful',
      transport: 'stdio',
      command: 'run',
      env: { TOKEN: 'super-secret' }
    })
    expect(JSON.stringify(snapshot)).not.toContain('super-secret')
    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).not.toContain('super-secret')
    expect(storedJson).toContain('envRefs')
    expect(storedJson).toContain('enc:')
  })

  it('redacts credential-bearing fields from historical custom-server views', async () => {
    await repository.addCustomServer({
      id: 'legacy-args-secret',
      name: 'legacy-args-secret',
      displayName: 'Legacy args secret',
      transport: 'stdio',
      command: 'example-mcp',
      args: ['--token=legacy-plaintext-secret'],
      enabled: true
    })
    await repository.addCustomServer({
      id: 'legacy-url-secret',
      name: 'legacy-url-secret',
      displayName: 'Legacy URL secret',
      transport: 'streamable_http',
      url: 'https://mcp.example.test?api_key=legacy-plaintext-secret',
      enabled: true
    })

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers).toEqual([
      expect.objectContaining({
        name: 'legacy-args-secret',
        args: undefined,
        enabled: false,
        availability: 'credential_unavailable'
      }),
      expect.objectContaining({
        name: 'legacy-url-secret',
        url: undefined,
        enabled: false,
        availability: 'credential_unavailable'
      })
    ])
    expect(JSON.stringify(snapshot)).not.toContain('legacy-plaintext-secret')

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('legacy-plaintext-secret')
  })

  it('migrates legacy plaintext custom-server secrets when secure storage is available', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
      displayName: 'Legacy',
      transport: 'streamable_http',
      enabled: true,
      url: 'https://example.test/mcp',
      env: { TOKEN: 'legacy-env-secret' },
      headers: { Authorization: 'legacy-header-secret' }
    })

    const server = (await service.getConnectors())?.customMcpServers?.[0]
    expect(server?.env).toEqual({ TOKEN: 'legacy-env-secret' })
    expect(server?.headers).toEqual({ Authorization: 'legacy-header-secret' })

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).not.toContain('legacy-env-secret')
    expect(storedJson).not.toContain('legacy-header-secret')
    expect(storedJson).toContain('envRefs')
    expect(storedJson).toContain('headerRefs')
  })

  it('does not fail a legacy secret read when deletion wins the migration race', async () => {
    await repository.addCustomServer({
      id: 'legacy-race',
      name: 'legacy-race',
      displayName: 'Legacy race',
      transport: 'stdio',
      enabled: true,
      command: 'legacy-command',
      env: { TOKEN: 'legacy-secret' }
    })
    const readSettings = repository.getSettings.bind(repository)
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(async () => {
      const staleSettings = await readSettings()
      await repository.removeCustomServer('legacy-race')
      return staleSettings
    })

    await expect(service.getConnectors()).resolves.toMatchObject({
      customMcpServers: [expect.objectContaining({ id: 'legacy-race' })]
    })
    expect((await readSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('keeps legacy secrets readable but rejects new secret writes without secure storage', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
      displayName: 'Legacy',
      transport: 'stdio',
      enabled: true,
      command: 'old-command',
      env: { TOKEN: 'keep-me' }
    })
    keychain.available = false

    expect((await service.getConnectors())?.customMcpServers?.[0]?.env).toEqual({
      TOKEN: 'keep-me'
    })
    await service.updateCustomServer({
      id: 'legacy',
      transport: 'stdio',
      command: 'new-command'
    })
    await expect(
      addCustomServer({
        name: 'new-secret',
        transport: 'stdio',
        command: 'run',
        env: { TOKEN: 'must-not-persist' }
      })
    ).rejects.toThrow(/secure credential storage is unavailable/i)

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('keep-me')
    expect(storedJson).toContain('new-command')
    expect(storedJson).not.toContain('must-not-persist')
  })

  it('edits a custom server, keeping its name and preserving omitted env', async () => {
    const added = await addCustomServer({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'old'],
      env: { TOKEN: 'keep-me' }
    })
    const id = added.customServers[0].id

    // Change command/args but omit env — the stored secret env must be preserved.
    const updated = await service.updateCustomServer({
      id,
      transport: 'stdio',
      command: 'node',
      args: ['server.js']
    })
    const view = updated.customServers.find((s) => s.id === id)
    expect(view?.name).toBe('my-mem') // name is immutable
    expect(view?.command).toBe('node')
    expect(view?.args).toEqual(['server.js'])

    const stored = (await service.getConnectors())?.customMcpServers?.find((s) => s.id === id)
    expect(stored?.env).toEqual({ TOKEN: 'keep-me' })
  })

  it('invalidates remembered authority before persisting a security-sensitive server edit', async () => {
    const added = await addCustomServer({
      name: 'mutable-endpoint',
      transport: 'stdio',
      command: 'old-command',
      args: ['serve']
    })
    const id = added.customServers[0].id
    const commit = vi.fn()
    const rollback = vi.fn()
    const invalidate = vi.fn(async (serverId: string) => {
      const stored = (await service.getConnectors())?.customMcpServers?.find(
        (server) => server.id === serverId
      )
      expect(stored?.command).toBe('old-command')
      return { commit, rollback }
    })

    await service.updateCustomServer(
      {
        id,
        transport: 'streamable_http',
        url: 'https://new.example/mcp',
        headers: { Authorization: 'Bearer replacement' }
      },
      invalidate
    )

    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith(id)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ id, url: 'https://new.example/mcp' })
    expect(rollback).not.toHaveBeenCalled()
    const stored = (await service.getConnectors())?.customMcpServers?.find(
      (server) => server.id === id
    )
    expect(stored?.transport).toBe('streamable_http')
    expect(stored?.url).toBe('https://new.example/mcp')
  })

  it('keeps grants for display-only edits and fails closed when invalidation fails', async () => {
    const added = await addCustomServer({
      name: 'stable-endpoint',
      description: 'Before',
      transport: 'stdio',
      command: 'stable-command'
    })
    const id = added.customServers[0].id
    const invalidate = vi.fn().mockResolvedValue(undefined)

    await service.updateCustomServer(
      {
        id,
        description: 'After',
        transport: 'stdio',
        command: 'stable-command'
      },
      invalidate
    )
    expect(invalidate).not.toHaveBeenCalled()

    invalidate.mockRejectedValueOnce(new Error('grant cleanup failed'))
    await expect(
      service.updateCustomServer(
        {
          id,
          description: 'After',
          transport: 'stdio',
          command: 'replacement-command'
        },
        invalidate
      )
    ).rejects.toThrow('grant cleanup failed')

    const stored = (await service.getConnectors())?.customMcpServers?.find(
      (server) => server.id === id
    )
    expect(stored?.description).toBe('After')
    expect(stored?.command).toBe('stable-command')
  })

  it('rolls back the custom-server security barrier when persistence fails', async () => {
    const added = await addCustomServer({
      name: 'rollback-endpoint',
      transport: 'stdio',
      command: 'old-command'
    })
    const id = added.customServers[0].id
    const commit = vi.fn()
    const rollback = vi.fn()
    vi.spyOn(repository, 'updateCustomServer').mockRejectedValueOnce(new Error('write failed'))

    await expect(
      service.updateCustomServer({ id, transport: 'stdio', command: 'new-command' }, async () => ({
        commit,
        rollback
      }))
    ).rejects.toThrow('write failed')

    expect(commit).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('rejects editing an unknown custom server', async () => {
    await expect(
      service.updateCustomServer({ id: 'nope', transport: 'stdio', command: 'x' })
    ).rejects.toThrow(/Unknown custom connector/)
  })
})
