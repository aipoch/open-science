import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execPath } from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Reversible fake safeStorage so provider keys can be encrypted/decrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const decoded = buffer.toString('utf8')

      if (!decoded.startsWith('cipher:')) throw new Error('bad ciphertext')

      return decoded.slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', isPackaged: false }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')
const { getIsolatedClaudeConfigDir } = await import('./provider-env')

let storageRoot: string
let repository: InstanceType<typeof SettingsRepository>

const createService = (
  detectResult = { found: true, path: '/bin/claude', version: '2.1.0' }
): InstanceType<typeof SettingsService> =>
  new SettingsService({
    repository,
    storageRoot,
    detectDeps: {
      env: {},
      homePath: '/home',
      isExecutable: () => Promise.resolve(true),
      getVersion: () => Promise.resolve(detectResult.version),
      resolveNpmBinDirs: () => Promise.resolve([])
    }
  })

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-service-'))
  repository = new SettingsRepository(storageRoot)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('SettingsService: providers', () => {
  it('encrypts the key on upsert and never exposes plaintext in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      key: 'sk-super-secret'
    })

    const view = snapshot.providers[0]
    expect(view.hasKey).toBe(true)
    expect(view.maskedKey).toBe('sk-s…cret')
    expect(JSON.stringify(view)).not.toContain('sk-super-secret')

    // The stored record holds ciphertext, not the plaintext key.
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-super-secret')
  })

  it('keeps the stored key when an edit omits a new key', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k1'
      })
    ).providers[0]

    await service.upsertProvider({ id: created.id, type: 'custom', name: 'Renamed' })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.name).toBe('Renamed')
    expect(stored.keyRef).toBeDefined()
  })

  it('rejects an incomplete custom provider and never persists it', async () => {
    const service = createService()

    // Missing base URL / model / key each block the save with a clear error.
    await expect(
      service.upsertProvider({ type: 'custom', name: 'No base URL', model: 'm', key: 'k' })
    ).rejects.toThrow(/base url is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No model',
        baseUrl: 'https://g/v1',
        key: 'k'
      })
    ).rejects.toThrow(/model is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No key',
        baseUrl: 'https://g/v1',
        model: 'm'
      })
    ).rejects.toThrow(/api key is required/i)

    // None of the rejected drafts reached disk.
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('allows a claude-default provider with no key or base URL', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({ type: 'claude-default', name: 'Local Claude' })

    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]).toMatchObject({ type: 'claude-default', hasKey: false })
    expect(snapshot.providers[0].baseUrl).toBeUndefined()
  })
})

describe('SettingsService: validation', () => {
  it('records lastValidatedAt for a saved provider on success', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it('does not record validation on failure', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: false, category: 'auth' })
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeUndefined()
  })
})

describe('SettingsService: preflight & spawn config', () => {
  it('gates on a detected claude and a validated active provider', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))

    // Seed an existing executable path so the launch re-check passes.
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // Before validation/activation the provider gate is closed.
    expect(await service.getPreflight()).toMatchObject({
      claudeReady: true,
      activeProviderReady: false
    })

    await service.validateProvider({ providerId: created.id })
    await service.setActiveProvider(created.id)

    expect(await service.getPreflight()).toEqual({ claudeReady: true, activeProviderReady: true })
  })

  it('builds spawn env from the active provider with the decrypted key', async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'm',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()

    expect(config.executablePath).toBe(execPath)
    expect(config.envOverrides).toMatchObject({
      // A user-supplied trailing /v1 is normalized away; the client appends /v1/messages itself.
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_MODEL: 'm',
      CLAUDE_CONFIG_DIR: getIsolatedClaudeConfigDir(storageRoot)
    })
    // Custom providers always use the bearer token variable, never x-api-key.
    expect(config.envOverrides.ANTHROPIC_API_KEY).toBeUndefined()
    // Custom providers restrict the session to the isolated "user" settings scope so the user's global
    // ~/.claude project/local settings can't override the injected endpoint.
    expect(config.settingSources).toEqual(['user'])
  })

  it('leaves settingSources unset for a claude-default provider (reuses user settings)', async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({ type: 'claude-default', name: 'Local' })
    ).providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()

    expect(config.settingSources).toBeUndefined()
  })

  it('throws a clear error when no active provider is configured', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    await expect(service.resolveActiveSpawnConfig()).rejects.toThrow(/active model provider/i)
  })
})
