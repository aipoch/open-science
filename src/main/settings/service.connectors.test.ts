import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Reversible fake safeStorage so the NCBI key can be encrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')
const { ALL_CONNECTOR_IDS } = await import('../connectors/registry')

// Exercises the connector surface of SettingsService against a real on-disk repository.
describe('SettingsService connectors', () => {
  let dir: string
  let service: InstanceType<typeof SettingsService>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-svc-connectors-'))
    service = new SettingsService({ repository: new SettingsRepository(dir) })
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
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      description: 'Memory server'
    })
    expect(added.id).toBeTruthy()

    snapshot = await service.setCustomServerEnabled({ id: added.id, enabled: false })
    expect(snapshot.customServers[0].enabled).toBe(false)

    snapshot = await service.removeCustomServer({ id: added.id })
    expect(snapshot.customServers).toEqual([])
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

  it('rejects editing an unknown custom server', async () => {
    await expect(
      service.updateCustomServer({ id: 'nope', transport: 'stdio', command: 'x' })
    ).rejects.toThrow(/Unknown custom connector/)
  })
})
