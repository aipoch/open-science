import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { SkillRegistry } = await import('../skills/registry')

let storageRoot: string
let repository: InstanceType<typeof SettingsRepository>

const createService = (
  detectResult = { found: true, path: '/bin/claude', version: '2.1.0' },
  options: {
    userClaudeDir?: string
    executeClaudeProbe?: (executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>
  } = {}
): InstanceType<typeof SettingsService> =>
  new SettingsService({
    repository,
    storageRoot,
    // Point at a non-existent user Claude dir so tests never read the real ~/.claude for local auth.
    userClaudeDir: options.userClaudeDir ?? join(storageRoot, 'no-user-claude'),
    executeClaudeProbe: options.executeClaudeProbe,
    detectDeps: {
      env: {},
      homePath: '/home',
      platform: 'linux',
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
  it('tests Local Claude in the implicit default config when auth is OS-store-only', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, { executeClaudeProbe: probe })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

    const result = await service.validateProvider({ draft: { type: 'claude-default' } })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(probe).toHaveBeenCalledOnce()
    const probeEnv = probe.mock.calls[0][1]
    // No portable token/credentials fixture exists, so Claude must be allowed to use its native login.
    expect(Object.hasOwn(probeEnv, 'CLAUDE_CONFIG_DIR')).toBe(false)
  })

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

  it('records the failure (not lastValidatedAt) for a saved provider on failure', async () => {
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

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth' })
    expect(stored.lastValidationFailure?.at).toBeGreaterThan(0)
  })

  it('clears a recorded failure once a later validation succeeds', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 })
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    fetchMock.mockResolvedValue({ status: 200 })
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidationFailure).toBeUndefined()
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
  })

  it('drops a recorded failure when credentials change on edit', async () => {
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

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    // Editing with a new key changes credentials, so the stale failure is dropped (re-test needed).
    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', key: 'k2' })

    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeUndefined()
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
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot)
    })
    // Custom providers always use the bearer token variable, never x-api-key.
    expect(config.envOverrides.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("uses Claude's implicit default config for a local provider with OS-store-only auth", async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local' }))
      .providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()

    // No portable auth fixture exists, so the explicit app config is removed. This lets Claude Code
    // reuse native credential stores that are available only in its implicit default context.
    expect(config.envOverrides.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(config.envOverrides.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(config.envOverrides.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('injects the local login (~/.claude token) for a local provider at spawn time', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-user-claude-'))
    await mkdir(userClaudeDir, { recursive: true })
    await writeFile(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-user', ANTHROPIC_BASE_URL: 'https://gw' } })
    )

    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir,
      detectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        isExecutable: () => Promise.resolve(true),
        getVersion: () => Promise.resolve('2.1.0'),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local' }))
      .providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()
    await rm(userClaudeDir, { recursive: true, force: true })

    expect(config.envOverrides.ANTHROPIC_AUTH_TOKEN).toBe('sk-user')
    expect(config.envOverrides.ANTHROPIC_BASE_URL).toBe('https://gw')
  })

  it('throws a clear error when no active provider is configured', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    await expect(service.resolveActiveSpawnConfig()).rejects.toThrow(/active model provider/i)
  })
})

describe('SettingsService: official vendors', () => {
  it('stores vendor/region + key and exposes the vendor catalog in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'official',
      name: 'MiniMax',
      vendorId: 'minimax',
      region: 'china',
      key: 'sk-mm'
    })

    const view = snapshot.providers[0]
    expect(view).toMatchObject({
      type: 'official',
      vendorId: 'minimax',
      region: 'china',
      hasKey: true
    })
    // Catalog comes from the registry, not the user; base URL is not stored on the record.
    expect(view.models).toContain('MiniMax-M3[1m]')
    expect(view.baseUrl).toBeUndefined()

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-mm')
  })

  it('rejects an official provider with no vendor or no key', async () => {
    const service = createService()

    await expect(
      service.upsertProvider({ type: 'official', name: 'No vendor', key: 'k' })
    ).rejects.toThrow(/vendor is required/i)
    await expect(
      service.upsertProvider({ type: 'official', name: 'No key', vendorId: 'deepseek' })
    ).rejects.toThrow(/api key is required/i)

    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not store a per-official model; the catalog + global selection cover it', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // No model is persisted on the provider; the composer/selector picks from the registry catalog.
    expect(created.model).toBeUndefined()
    expect(created.models).toContain('glm-5.2')
  })

  it('activates a chosen catalog model, falling back to the default for an unknown one', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // A model in the catalog is honored.
    let snapshot = await service.setActiveProvider(created.id, 'glm-4.7')
    expect(snapshot.activeModel).toBe('glm-4.7')

    // An unknown model falls back to the vendor's first catalog entry.
    snapshot = await service.setActiveProvider(created.id, 'not-a-model')
    expect(snapshot.activeModel).toBe('glm-5.2')

    // No model given also defaults to the first catalog entry.
    snapshot = await service.setActiveProvider(created.id)
    expect(snapshot.activeModel).toBe('glm-5.2')
  })

  it('builds spawn env from the registry base URL and the active model', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'sk-ds'
      })
    ).providers[0]
    await service.setActiveProvider(created.id, 'deepseek-v4-flash')

    const config = await service.resolveActiveSpawnConfig()

    expect(config.envOverrides).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-ds',
      ANTHROPIC_MODEL: 'deepseek-v4-flash'
    })
  })

  it('refreshes models from the vendor and persists them over the bundled catalog', async () => {
    const service = createService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'deepseek-v5' }, { id: 'deepseek-v4-pro' }] })
      })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    // Before refresh the view exposes the bundled catalog.
    expect(created.models).toContain('deepseek-v4-pro')
    expect(created.models).not.toContain('deepseek-v5')

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: true, models: ['deepseek-v5', 'deepseek-v4-pro'] })

    // The fetched list now backs the provider view (and persists).
    const view = (await service.getSettingsView()).providers[0]
    expect(view.models).toEqual(['deepseek-v5', 'deepseek-v4-pro'])
  })

  it('reports a refresh failure without changing the bundled catalog', async () => {
    const service = createService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401, json: () => Promise.resolve({}) })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: false, category: 'auth' })

    // Catalog unchanged.
    expect((await service.getSettingsView()).providers[0].models).toContain('deepseek-v4-pro')
  })

  it('hides refresh for a vendor without a model-list endpoint', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no model-list endpoint/i)
  })

  it('validates an official draft against the vendor endpoint', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds' }
    })

    expect(result.ok).toBe(true)
    // The probe hits the registry base URL (+ the client's /v1/messages suffix).
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })
})

describe('SettingsService: onboarding', () => {
  it('marks onboarding complete and surfaces it in the snapshot', async () => {
    const service = createService()

    const snapshot = await service.markOnboardingComplete()
    expect(snapshot.onboardingCompletedAt).toBeTypeOf('number')

    // The persisted value is visible on a fresh read too.
    const view = await service.getSettingsView()
    expect(view.onboardingCompletedAt).toBe(snapshot.onboardingCompletedAt)
  })
})

describe('SettingsService: skills', () => {
  // Seeds a bundled-skills root with one "demo" skill + manifest for an injectable registry.
  const seedBundle = async (): Promise<string> => {
    const bundle = await mkdtemp(join(tmpdir(), 'os-skills-bundle-'))
    await mkdir(join(bundle, 'demo'), { recursive: true })
    await writeFile(
      join(bundle, 'demo', 'SKILL.md'),
      ['---', 'name: demo', 'description: A demo skill.', '---', '', 'demo body'].join('\n'),
      'utf8'
    )
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
        ]
      }),
      'utf8'
    )
    return bundle
  }

  const createSkillService = async (): Promise<InstanceType<typeof SettingsService>> =>
    new SettingsService({
      repository,
      storageRoot,
      userClaudeDir: join(storageRoot, 'no-user-claude'),
      skillRegistry: new SkillRegistry(await seedBundle())
    })

  it('lists skills with enabled reflecting disabledSkillIds and returns detail body', async () => {
    const service = await createSkillService()

    let skills = await service.listSkills()
    expect(skills).toEqual([
      expect.objectContaining({
        id: 'demo',
        name: 'Demo',
        description: 'A demo skill.',
        enabled: true
      })
    ])

    skills = await service.setSkillEnabled({ id: 'demo', enabled: false })
    expect(skills[0].enabled).toBe(false)

    const detail = await service.getSkillDetail('demo')
    expect(detail.body).toContain('demo body')
  })

  it('creates, edits, and deletes a personal skill alongside featured skills', async () => {
    const service = await createSkillService()

    let skills = await service.createSkill({
      name: 'My Skill',
      description: 'Mine.',
      body: '# Mine'
    })
    // Featured (demo) + the new personal skill, both enabled by default.
    expect(skills.map((skill) => skill.id).sort()).toEqual(['demo', 'personal-my-skill'])
    const personal = skills.find((skill) => skill.id === 'personal-my-skill')
    expect(personal).toMatchObject({ source: 'personal', enabled: true })

    const detail = await service.getSkillDetail('personal-my-skill')
    expect(detail.body).toContain('# Mine')

    skills = await service.updateSkill({
      id: 'personal-my-skill',
      name: 'My Skill',
      description: 'Edited.',
      body: '# Edited'
    })
    expect(skills.find((skill) => skill.id === 'personal-my-skill')?.description).toBe('Edited.')

    skills = await service.deleteSkill({ id: 'personal-my-skill' })
    expect(skills.map((skill) => skill.id)).toEqual(['demo'])
  })
})
