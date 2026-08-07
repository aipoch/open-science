import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const { SettingsRepository } = await import('./repository')
const { ALL_CONNECTOR_IDS } = await import('../connectors/registry')

// Exercises the durable Connector owner against a real on-disk repository.
describe('ConnectorSettingsModule', () => {
  let dir: string
  let service: InstanceType<typeof ConnectorSettingsModule>
  let repository: InstanceType<typeof SettingsRepository>

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

  it('throws for an unknown connector id', async () => {
    await expect(service.getConnectorDetail('nope')).rejects.toThrow(/Unknown connector/)
  })

  it('adds, toggles, and removes a local (stdio) custom server', async () => {
    let snapshot = await service.addCustomServer({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      description: 'Memory server'
    })
    expect(snapshot.customServers).toHaveLength(1)
    const added = snapshot.customServers[0]
    expect(added).toMatchObject({
      slug: 'my-mem',
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      description: 'Memory server'
    })
    expect(added.id).toBeTruthy()

    snapshot = await service.setCustomServerEnabled({ id: added.id, enabled: false })
    expect(snapshot.customServers[0].enabled).toBe(false)

    await repository.setConnectorAutoAllow(added.slug, true)
    await repository.setToolPolicy(`${added.slug}/lookup`, true, false)
    snapshot = await service.removeCustomServer({ id: added.id })
    expect(snapshot.customServers).toEqual([])
    const afterRemoval = (await repository.getSettings()).connectors
    expect(afterRemoval?.autoAllowIds).not.toContain(added.slug)
    expect(afterRemoval?.askToolIds ?? []).not.toContain(`${added.slug}/lookup`)
  })

  it('advertises custom Connector Skills only from the successful materialization projection', async () => {
    await service.addCustomServer({
      name: 'custom-catalog',
      transport: 'stdio',
      command: 'example-mcp'
    })

    expect(await service.provisionedConnectorSkillNames()).not.toContain('mcp-custom-catalog')

    service.setMaterializedCustomSkillNamesProvider(() => ['mcp-custom-catalog'])

    expect(await service.provisionedConnectorSkillNames()).toContain('mcp-custom-catalog')
  })

  it('rejects duplicate and built-in custom connector names', async () => {
    await service.addCustomServer({
      name: 'example-server',
      transport: 'stdio',
      command: 'example-mcp'
    })

    await expect(
      service.addCustomServer({
        name: ' Example-Server ',
        transport: 'stdio',
        command: 'another-mcp'
      })
    ).rejects.toThrow('already exists')
    await expect(
      service.addCustomServer({ name: 'Chemistry', transport: 'stdio', command: 'example-mcp' })
    ).rejects.toThrow('reserved by a built-in connector')
  })

  it('separates the display name from the immutable host.mcp Connector ID', async () => {
    const snapshot = await service.addCustomServer({
      name: 'Example OAuth E2E',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    })

    expect(snapshot.customServers[0]).toMatchObject({
      name: 'Example OAuth E2E',
      slug: 'example-oauth-e2e'
    })
    await expect(
      service.addCustomServer({
        name: 'Another display name',
        slug: 'example-oauth-e2e',
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('already exists')
  })

  it('rejects IDs and names that overlap an installed Connector legacy alias', async () => {
    const existing = await service.addCustomServer({
      name: 'legacy-route',
      slug: 'stable-route',
      transport: 'stdio',
      command: 'example-mcp'
    })

    await expect(
      service.addCustomServer({
        name: 'Different name',
        slug: 'legacy-route',
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('conflicts with an existing Connector alias')
    await expect(
      service.addCustomServer({
        name: 'Another name',
        slug: existing.customServers[0].id,
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('conflicts with an existing Connector alias')
    await expect(
      service.addCustomServer({
        name: 'stable-route',
        slug: 'new-route',
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('conflicts with an existing Connector identity')
  })

  it('fails closed when a legacy Connector derives a bundled route', async () => {
    await repository.addCustomServer({
      id: 'legacy-reserved-route',
      name: 'Chemistry!',
      transport: 'stdio',
      enabled: true,
      command: 'legacy-command'
    })

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers[0]).toMatchObject({
      slug: 'chemistry',
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
    })
    await repository.addCustomServer({
      id: 'legacy-duplicate-b',
      name: 'Duplicate-MCP!',
      transport: 'stdio',
      enabled: true,
      command: 'second-command'
    })

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
    const snapshot = await service.addCustomServer({
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
    expect(result.contents).not.toContain(snapshot.customServers[0].id)

    const imported = await service.previewCustomServerTemplateImport(result.contents!)
    expect(imported.ready).toBe(false)
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-name'
    )
  })

  it('adds a remote (streamable_http) custom server with a url', async () => {
    const snapshot = await service.addCustomServer({
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
    const snapshot = await service.addCustomServer({
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
      hasTokens: false
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

  it('clears OAuth credentials when the remote endpoint changes', async () => {
    const added = await service.addCustomServer({
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
    const added = await service.addCustomServer({
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
      service.addCustomServer({
        name: 'invalid-auth',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer stale' },
        oauth: { scopes: ['openid'] }
      })
    ).rejects.toThrow('OAuth and static headers cannot be configured together')

    const added = await service.addCustomServer({
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

  it('rejects an invalid custom server (stdio without a command)', async () => {
    await expect(service.addCustomServer({ name: 'bad', transport: 'stdio' })).rejects.toThrow(
      /Invalid custom connector/
    )
  })

  it('does not expose custom-server env or header secrets in the view', async () => {
    const snapshot = await service.addCustomServer({
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

  it('migrates legacy plaintext custom-server secrets when secure storage is available', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
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

  it('keeps legacy secrets readable but rejects new secret writes without secure storage', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
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
      service.addCustomServer({
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
    const added = await service.addCustomServer({
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
    const added = await service.addCustomServer({
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
    const added = await service.addCustomServer({
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
    const added = await service.addCustomServer({
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
