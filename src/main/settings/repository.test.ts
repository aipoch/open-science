import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sanitizeSettings } from './document-codec'
import { CONNECTOR_RESOURCE_LIMITS } from './connector-resource-limits'
import { SettingsDocumentStore } from './document-store'
import { SettingsRepository } from './repository'
import type { StoredCustomMcpServer, StoredProvider } from './types'
import { skillMutationOwnerFor } from '../skills/skill-mutation-owner'
import { envDirectoryName } from '../notebook/runtime-paths'

// Capture the warn calls the repository makes through createLogger. vi.hoisted runs before the
// module's top-level code so the vi.mock factory can reference the same spy instance.
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
const { warn: warnSpy } = loggerMock
vi.mock('../logger', () => ({
  createLogger: () => loggerMock
}))

beforeEach(() => {
  warnSpy.mockClear()
})

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-'))
  return storageRoot
}

const provider = (overrides: Partial<StoredProvider> = {}): StoredProvider => ({
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://g/v1',
  model: 'm',
  keyRef: 'enc:abc',
  keyMask: 'sk-…abcd',
  ...overrides
})

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('settings repository', () => {
  it('commits framework, Reviewer, and Subagent routing as one validated mutation', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    const fixed = {
      mode: 'fixed' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high' as const
    }

    await repository.setAgentRouting(
      { framework: 'opencode', reviewer: fixed, subagent: fixed },
      (candidate) => candidate
    )
    await expect(repository.getSettings()).resolves.toMatchObject({
      agentFrameworkId: 'opencode',
      reviewerModel: fixed,
      subagentModel: fixed
    })

    await expect(
      repository.setAgentRouting({ framework: 'codex', reviewer: { mode: 'inherit' } }, () => {
        throw new Error('routing is unavailable')
      })
    ).rejects.toThrow('routing is unavailable')
    await expect(repository.getSettings()).resolves.toMatchObject({
      agentFrameworkId: 'opencode',
      reviewerModel: fixed,
      subagentModel: fixed
    })
  })

  it('defaults legacy and malformed Subagent model settings to dynamic inheritance', () => {
    expect(sanitizeSettings({ providers: [] }).subagentModel).toEqual({ mode: 'inherit' })
    expect(
      sanitizeSettings({
        providers: [],
        subagentModel: { mode: 'fixed', providerId: 'p1', model: '', reasoningEffort: 'high' }
      }).subagentModel
    ).toEqual({ mode: 'inherit' })
  })

  it('preserves a structurally valid fixed Subagent model when its provider is unavailable', () => {
    expect(
      sanitizeSettings({
        providers: [],
        subagentModel: {
          mode: 'fixed',
          providerId: 'removed-provider',
          model: 'removed-model',
          reasoningEffort: 'high'
        }
      }).subagentModel
    ).toEqual({
      mode: 'fixed',
      providerId: 'removed-provider',
      model: 'removed-model',
      reasoningEffort: 'high'
    })
  })

  it('atomically replaces the complete Subagent model configuration', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setSubagentModel({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'max'
    })
    await expect(repository.getSettings()).resolves.toMatchObject({
      subagentModel: {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'max'
      }
    })

    await repository.setSubagentModel({ mode: 'inherit' })
    await expect(repository.getSettings()).resolves.toMatchObject({
      subagentModel: { mode: 'inherit' }
    })
  })

  it('retains the committed Subagent model when authoritative validation rejects a stale write', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.setSubagentModel({ mode: 'inherit' })

    await expect(
      repository.setSubagentModel(
        { mode: 'fixed', providerId: 'gone', model: 'gone-model', reasoningEffort: 'default' },
        () => {
          throw new Error('refresh catalog')
        }
      )
    ).rejects.toThrow('refresh catalog')

    await expect(repository.getSettings()).resolves.toMatchObject({
      subagentModel: { mode: 'inherit' }
    })
  })

  it('defaults and atomically persists the Reviewer model policy', async () => {
    expect(sanitizeSettings({ providers: [] }).reviewerModel).toEqual({ mode: 'inherit' })

    const repository = new SettingsRepository(await createStorageRoot())
    await repository.setReviewerModel({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'reviewer-model',
      reasoningEffort: 'high'
    })

    await expect(repository.getSettings()).resolves.toMatchObject({
      reviewerModel: {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'reviewer-model',
        reasoningEffort: 'high'
      }
    })

    await repository.setReviewerModel({ mode: 'inherit' })
    await expect(repository.getSettings()).resolves.toMatchObject({
      reviewerModel: { mode: 'inherit' }
    })
  })

  it('defaults, validates, and atomically persists the Vision model selection', async () => {
    expect(sanitizeSettings({ providers: [] }).visionModel).toBeUndefined()
    expect(
      sanitizeSettings({
        providers: [],
        visionModel: {
          providerId: 'provider-a',
          model: '',
          reasoningEffort: 'high'
        }
      }).visionModel
    ).toBeUndefined()

    const repository = new SettingsRepository(await createStorageRoot())
    await repository.setVisionModel({
      providerId: 'provider-a',
      model: 'vision-model',
      reasoningEffort: 'high'
    })

    await expect(repository.getSettings()).resolves.toMatchObject({
      visionModel: {
        providerId: 'provider-a',
        model: 'vision-model',
        reasoningEffort: 'high'
      }
    })

    await repository.setVisionModel(undefined)
    await expect(repository.getSettings()).resolves.not.toHaveProperty('visionModel')
  })

  it('keeps only an existing Claude subscription provider as the preferred mode', () => {
    const providers = [
      {
        id: 'builtin-claude-isolated',
        type: 'claude-isolated',
        name: 'Claude subscription'
      }
    ]

    expect(
      sanitizeSettings({
        claudeSubscriptionProviderId: 'builtin-claude-isolated',
        providers
      }).claudeSubscriptionProviderId
    ).toBe('builtin-claude-isolated')
    expect(
      sanitizeSettings({
        claudeSubscriptionProviderId: 'builtin-claude-shared',
        providers
      }).claudeSubscriptionProviderId
    ).toBeUndefined()
    expect(
      sanitizeSettings({
        claudeSubscriptionProviderId: 'unknown',
        providers
      }).claudeSubscriptionProviderId
    ).toBeUndefined()
  })

  it('remembers the most recently upserted Claude subscription mode', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(
      provider({
        id: 'builtin-claude-shared',
        type: 'claude-shared',
        name: 'Claude subscription'
      })
    )
    await repository.upsertProvider(
      provider({
        id: 'builtin-claude-isolated',
        type: 'claude-isolated',
        name: 'Claude subscription'
      })
    )

    await expect(repository.getSettings()).resolves.toMatchObject({
      claudeSubscriptionProviderId: 'builtin-claude-isolated'
    })
  })

  it('remembers the last activated Claude mode after switching to another provider', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(
      provider({
        id: 'builtin-claude-isolated',
        type: 'claude-isolated',
        name: 'Claude subscription'
      })
    )
    await repository.upsertProvider(
      provider({
        id: 'builtin-claude-shared',
        type: 'claude-shared',
        name: 'Claude subscription'
      })
    )
    await repository.upsertProvider(provider())

    await repository.setActiveProvider('builtin-claude-isolated')
    await repository.setActiveProvider('p1')

    await expect(new SettingsRepository(root).getSettings()).resolves.toMatchObject({
      activeProviderId: 'p1',
      claudeSubscriptionProviderId: 'builtin-claude-isolated'
    })
  })

  it('migrates two legacy Codex subscription cards into one active-mode provider', () => {
    const settings = sanitizeSettings({
      activeProviderId: 'builtin-codex-isolated',
      providers: [
        { id: 'builtin-codex-shared', type: 'codex-shared', name: 'Existing Codex profile' },
        { id: 'builtin-codex-isolated', type: 'codex-isolated', name: 'Open Science Codex login' }
      ]
    })

    expect(settings.providers).toEqual([
      expect.objectContaining({
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexAuthMode: 'isolated',
        name: 'Codex subscription'
      })
    ])
    expect(settings.activeProviderId).toBe('builtin-codex-subscription')
  })

  it('migrates a legacy shared Codex provider to the isolated runtime form', () => {
    const settings = sanitizeSettings({
      activeProviderId: 'builtin-codex-shared',
      providers: [
        {
          id: 'builtin-codex-shared',
          type: 'codex-shared',
          name: 'Existing Codex profile',
          lastValidatedAt: 1710000000000,
          lastValidationFailure: { at: 1710000000001, category: 'auth' },
          expiresAt: 1710000000002
        }
      ]
    })

    expect(settings.providers).toEqual([
      expect.objectContaining({
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexAuthMode: 'isolated',
        name: 'Codex subscription'
      })
    ])
    expect(settings.providers[0].lastValidatedAt).toBeUndefined()
    expect(settings.providers[0].lastValidationFailure).toBeUndefined()
    expect(settings.providers[0].expiresAt).toBeUndefined()
    expect(settings.activeProviderId).toBe('builtin-codex-subscription')
  })

  it('migrates an ambiguous normalized Codex subscription as isolated', () => {
    const settings = sanitizeSettings({
      activeProviderId: 'builtin-codex-subscription',
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          name: 'Codex subscription'
        }
      ]
    })

    expect(settings.providers).toEqual([
      expect.objectContaining({
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexAuthMode: 'isolated',
        name: 'Codex subscription'
      })
    ])
    expect(settings.activeProviderId).toBe('builtin-codex-subscription')
  })

  it('preserves an explicit imported mode on a normalized Codex subscription', () => {
    const settings = sanitizeSettings({
      activeProviderId: 'builtin-codex-subscription',
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          codexAuthMode: 'imported',
          name: 'Codex subscription'
        }
      ]
    })

    expect(settings.providers[0]).toMatchObject({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexAuthMode: 'imported'
    })
  })

  it('sanitizes the main-only Codex Auto HTTPS preference', () => {
    const valid = sanitizeSettings({
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          name: 'Codex subscription',
          codexAutoUseHttps: true
        }
      ]
    })
    expect(valid.providers[0].codexAutoUseHttps).toBe(true)

    const invalid = sanitizeSettings({
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          name: 'Codex subscription',
          codexAutoUseHttps: 'true'
        }
      ]
    })
    expect(invalid.providers[0].codexAutoUseHttps).toBeUndefined()
  })

  it('atomically remembers HTTPS only while the preference remains Auto', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexTransport: 'auto',
      name: 'Codex subscription'
    })

    await expect(repository.rememberCodexAutoHttpsFallback()).resolves.toBe(true)
    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBe(true)
    await expect(repository.rememberCodexAutoHttpsFallback()).resolves.toBe(false)

    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...stored,
      codexTransport: 'https',
      codexAutoUseHttps: undefined
    })
    await expect(repository.rememberCodexAutoHttpsFallback()).resolves.toBe(false)
    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBeUndefined()
  })

  it('preserves learned Auto HTTPS when a stale full-provider update lands afterward', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexTransport: 'auto',
      name: 'Codex subscription'
    })
    const staleProvider = (await repository.getSettings()).providers[0]

    await repository.rememberCodexAutoHttpsFallback()
    await repository.upsertProvider({ ...staleProvider, lastValidatedAt: 123 })

    expect((await repository.getSettings()).providers[0]).toMatchObject({
      codexTransport: 'auto',
      codexAutoUseHttps: true,
      lastValidatedAt: 123
    })
  })

  it('returns empty settings when nothing is stored yet', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await expect(repository.getSettings()).resolves.toEqual({ version: 2, providers: [] })
  })

  it('writes settings.json atomically and reads it back', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider(provider())

    const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
      version: number
    }
    expect(raw.version).toBe(2)

    const settings = await repository.getSettings()
    expect(settings.claude).toEqual({ resolvedPath: '/bin/claude', version: '2.1.0' })
    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0]).toMatchObject({ id: 'p1', keyRef: 'enc:abc' })
  })

  it('persists the agent framework + opencode path across a sanitized read', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setAgentFramework('opencode')
    await repository.setOpencodeInfo('/usr/local/bin/opencode', '1.18.3')

    // sanitizeSettings must not strip these fields on read-back, or the selector can never switch.
    const settings = await repository.getSettings()
    expect(settings.agentFrameworkId).toBe('opencode')
    expect(settings.opencodePath).toBe('/usr/local/bin/opencode')
    expect(settings.opencodeVersion).toBe('1.18.3')
  })

  it('persists the CodeBuddy selection and path across a sanitized read and reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setAgentFramework('codebuddy')
    await repository.setCodeBuddyInfo('/opt/homebrew/bin/codebuddy', '2.138.0')

    expect(await repository.getSettings()).toMatchObject({
      agentFrameworkId: 'codebuddy',
      codebuddyPath: '/opt/homebrew/bin/codebuddy',
      codebuddyVersion: '2.138.0'
    })
    await expect(new SettingsRepository(root).getSettings()).resolves.toMatchObject({
      agentFrameworkId: 'codebuddy',
      codebuddyPath: '/opt/homebrew/bin/codebuddy',
      codebuddyVersion: '2.138.0'
    })
  })

  it('persists the reasoning effort across a sanitized read and a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setReasoningEffort('high')

    // sanitizeSettings must not strip the level on read-back, or the selector can never switch.
    expect((await repository.getSettings()).reasoningEffort).toBe('high')

    // A fresh repository on the same storage dir models an app restart: the level is read back.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.reasoningEffort).toBe('high')
  })

  it.each(['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'keeps the %s reasoning effort on load',
    (effort) => {
      expect(sanitizeSettings({ reasoningEffort: effort }).reasoningEffort).toBe(effort)
    }
  )

  it('drops an unknown reasoning effort on load', () => {
    expect(sanitizeSettings({ reasoningEffort: 'ultra' }).reasoningEffort).toBeUndefined()
    expect(sanitizeSettings({ reasoningEffort: 42 }).reasoningEffort).toBeUndefined()
    expect(sanitizeSettings({}).reasoningEffort).toBeUndefined()
  })

  it('persists the notifications preference across a sanitized read and a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setNotificationsEnabled(false)

    // sanitizeSettings must not strip the flag on read-back, or the toggle can never switch.
    expect((await repository.getSettings()).notificationsEnabled).toBe(false)

    // A fresh repository on the same storage dir models an app restart: the flag is read back.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.notificationsEnabled).toBe(false)
  })

  it.each([true, false])('keeps the %s notifications preference on load', (enabled) => {
    expect(sanitizeSettings({ notificationsEnabled: enabled }).notificationsEnabled).toBe(enabled)
  })

  it('drops a non-boolean notifications preference on load', () => {
    expect(sanitizeSettings({ notificationsEnabled: 'yes' }).notificationsEnabled).toBeUndefined()
    expect(sanitizeSettings({ notificationsEnabled: 1 }).notificationsEnabled).toBeUndefined()
    expect(sanitizeSettings({}).notificationsEnabled).toBeUndefined()
  })

  it('persists the system-notification content opt-in across a sanitized reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setShowNotificationContent(true)

    expect((await repository.getSettings()).showNotificationContent).toBe(true)
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.showNotificationContent).toBe(true)
    expect(
      sanitizeSettings({ showNotificationContent: 'yes' }).showNotificationContent
    ).toBeUndefined()
  })

  it('persists the conversation Skill import preference across a sanitized read and a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setConversationSkillImportEnabled(false)

    expect((await repository.getSettings()).conversationSkillImportEnabled).toBe(false)
    expect((await new SettingsRepository(root).getSettings()).conversationSkillImportEnabled).toBe(
      false
    )
  })

  it.each([true, false])('keeps the %s conversation Skill import preference on load', (enabled) => {
    expect(
      sanitizeSettings({ conversationSkillImportEnabled: enabled }).conversationSkillImportEnabled
    ).toBe(enabled)
  })

  it('drops a non-boolean conversation Skill import preference on load', () => {
    expect(
      sanitizeSettings({ conversationSkillImportEnabled: 'yes' }).conversationSkillImportEnabled
    ).toBeUndefined()
    expect(
      sanitizeSettings({ conversationSkillImportEnabled: 1 }).conversationSkillImportEnabled
    ).toBeUndefined()
    expect(sanitizeSettings({}).conversationSkillImportEnabled).toBeUndefined()
  })

  it('persists, sanitizes, and clears the close action preference', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setClosePreference('minimize')
    expect((await new SettingsRepository(root).getSettings()).closePreference).toBe('minimize')
    expect(sanitizeSettings({ closePreference: 'invalid' }).closePreference).toBeUndefined()

    await repository.setClosePreference(undefined)
    expect((await repository.getSettings()).closePreference).toBeUndefined()
  })

  it('persists and sanitizes the locale preference without defaulting an absent field', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    expect(sanitizeSettings({}).localePreference).toBeUndefined()
    expect(sanitizeSettings({ localePreference: 'de' }).localePreference).toBe('de')
    expect(sanitizeSettings({ localePreference: 'es' }).localePreference).toBe('es')
    expect(sanitizeSettings({ localePreference: 'ko' }).localePreference).toBe('ko')
    expect(sanitizeSettings({ localePreference: 'system' }).localePreference).toBe('system')

    await repository.setLocalePreference('de')
    expect((await new SettingsRepository(root).getSettings()).localePreference).toBe('de')
  })

  it('serializes startup locale and runtime settings writes through one document store', async () => {
    const root = await createStorageRoot()
    const store = new SettingsDocumentStore(root)
    const startupRepository = new SettingsRepository(store)
    const runtimeRepository = new SettingsRepository(store)

    await Promise.all([
      startupRepository.setLocalePreference('zh-Hant'),
      runtimeRepository.setNotificationsEnabled(false)
    ])

    await expect(store.read()).resolves.toMatchObject({
      localePreference: 'zh-Hant',
      notificationsEnabled: false
    })
  })

  it('persists, sanitizes, and clears the project files filter preference', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setProjectFilesFilter({ sourceMode: 'local', localRootId: 'root-1' })
    expect((await new SettingsRepository(root).getSettings()).projectFilesFilter).toEqual({
      sourceMode: 'local',
      localRootId: 'root-1'
    })
    expect(
      sanitizeSettings({ projectFilesFilter: { sourceMode: 'remote' } }).projectFilesFilter
    ).toBeUndefined()
    expect(sanitizeSettings({ projectFilesFilter: 'local' }).projectFilesFilter).toBeUndefined()
    expect(
      sanitizeSettings({ projectFilesFilter: { sourceMode: 'artifacts', optionId: 4 } })
        .projectFilesFilter
    ).toEqual({ sourceMode: 'artifacts' })

    await repository.setProjectFilesFilter(undefined)
    expect((await repository.getSettings()).projectFilesFilter).toBeUndefined()
  })

  it('persists the app icon variant across a sanitized read and a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setAppIconVariant('dark')

    // sanitizeSettings must not strip the variant on read-back, or the picker can never switch.
    expect((await repository.getSettings()).appIconVariant).toBe('dark')

    // A fresh repository on the same storage dir models an app restart: the variant is read back.
    expect((await new SettingsRepository(root).getSettings()).appIconVariant).toBe('dark')
  })

  it.each(['light', 'dark'] as const)('keeps the %s app icon variant on load', (variant) => {
    expect(sanitizeSettings({ appIconVariant: variant }).appIconVariant).toBe(variant)
  })

  it('drops an unknown app icon variant on load', () => {
    expect(sanitizeSettings({ appIconVariant: 'sparkle' }).appIconVariant).toBeUndefined()
    expect(sanitizeSettings({ appIconVariant: 3 }).appIconVariant).toBeUndefined()
    expect(sanitizeSettings({}).appIconVariant).toBeUndefined()
  })

  it.each(['ask', 'auto', 'full'] as const)(
    'keeps the %s default permission profile on load',
    (profile) => {
      expect(sanitizeSettings({ defaultPermissionProfile: profile }).defaultPermissionProfile).toBe(
        profile
      )
    }
  )

  it('drops an invalid default permission profile on load', () => {
    expect(
      sanitizeSettings({ defaultPermissionProfile: 'unsafe' }).defaultPermissionProfile
    ).toBeUndefined()
    expect(
      sanitizeSettings({ defaultPermissionProfile: 1 }).defaultPermissionProfile
    ).toBeUndefined()
    expect(sanitizeSettings({}).defaultPermissionProfile).toBeUndefined()
  })

  it('persists the default permission profile across a sanitized read and reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setDefaultPermissionProfile('full')

    expect((await repository.getSettings()).defaultPermissionProfile).toBe('full')
    expect((await new SettingsRepository(root).getSettings()).defaultPermissionProfile).toBe('full')
  })

  it('persists the Codex adapter and paired native runtime across a sanitized read', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setAgentFramework('codex')
    await repository.setCodexInfo({
      resolvedPath: '/data/codex-acp/dist/index.js',
      version: '1.1.4',
      nativePath: '/data/codex-acp/vendor/codex',
      nativeVersion: '0.144.6'
    })

    expect(await repository.getSettings()).toMatchObject({
      agentFrameworkId: 'codex',
      codex: {
        resolvedPath: '/data/codex-acp/dist/index.js',
        version: '1.1.4',
        nativePath: '/data/codex-acp/vendor/codex',
        nativeVersion: '0.144.6'
      }
    })
  })

  it('replaces a provider in place on upsert by id', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider({ name: 'First' }))
    await repository.upsertProvider(provider({ name: 'Renamed' }))

    const settings = await repository.getSettings()
    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0].name).toBe('Renamed')
  })

  it('rejects a conditional provider upsert queued after deletion', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.upsertProvider(provider({ name: 'Original' }))
    const staleProvider = (await repository.getSettings()).providers[0]

    const deleting = repository.deleteProvider(staleProvider.id)
    const updating = repository.upsertProvider(
      provider({ id: 'destination', name: 'Stale edit' }),
      staleProvider.id
    )

    await expect(deleting).resolves.toMatchObject({ providers: [] })
    await expect(updating).rejects.toThrow('Provider no longer exists.')
    await expect(repository.getSettings()).resolves.toMatchObject({ providers: [] })
  })

  it('rejects a custom server update queued after deletion', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    const server: StoredCustomMcpServer = {
      id: 'custom-server',
      name: 'custom-server',
      displayName: 'Custom server',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      trustedAt: 1
    }
    await repository.addCustomServer(server)
    const staleServer = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    if (!staleServer) throw new Error('Expected custom server fixture')

    const deleting = repository.removeCustomServer(server.id)
    const updating = repository.updateCustomServer(server.id, {
      ...staleServer,
      displayName: 'Stale edit'
    })

    await expect(deleting).resolves.toMatchObject({ connectors: { customMcpServers: [] } })
    await expect(updating).rejects.toThrow(`Unknown custom connector: ${server.id}`)
    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('keeps provider order stable when an existing provider is updated in place', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider({ id: 'p1', name: 'One' }))
    await repository.upsertProvider(provider({ id: 'p2', name: 'Two' }))
    await repository.upsertProvider(provider({ id: 'p3', name: 'Three' }))

    // Editing p1 (or recording a test result on it) must not move it to the end of the list.
    await repository.upsertProvider(provider({ id: 'p1', name: 'One (edited)' }))

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['p1', 'p2', 'p3'])
    expect(settings.providers[0].name).toBe('One (edited)')
  })

  it('clears the active pointer when the active provider is deleted', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1')
    expect((await repository.getSettings()).activeProviderId).toBe('p1')

    await repository.deleteProvider('p1')
    const settings = await repository.getSettings()
    expect(settings.providers).toEqual([])
    expect(settings.activeProviderId).toBeUndefined()
  })

  it('atomically resets every affected scenario while deleting a provider', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)
    const fixed = {
      mode: 'fixed' as const,
      providerId: 'p1',
      model: 'm',
      reasoningEffort: 'high' as const
    }

    await repository.upsertProvider(provider())
    await repository.setSubagentModel(fixed)
    await repository.setReviewerModel(fixed)
    await repository.setSessionDetailsModel(fixed)
    await repository.setVisionModel(fixed)

    const settings = await repository.deleteProvider('p1', 'inherit')

    expect(settings).toMatchObject({
      providers: [],
      subagentModel: { mode: 'inherit' },
      reviewerModel: { mode: 'inherit' },
      sessionDetailsModel: { mode: 'inherit', reasoningEffort: 'high' }
    })
    expect(settings.visionModel).toBeUndefined()
    await expect(new SettingsRepository(root).getSettings()).resolves.toMatchObject({
      providers: [],
      subagentModel: { mode: 'inherit' },
      reviewerModel: { mode: 'inherit' },
      sessionDetailsModel: { mode: 'inherit', reasoningEffort: 'high' }
    })
  })

  it('resets references to either Claude subscription record when deleting the collapsed card', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.upsertClaudeIsolatedProvider({ keyRef: 'enc:claude' })
    await repository.setReviewerModel({
      mode: 'fixed',
      providerId: 'builtin-claude-shared',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'high'
    })

    const settings = await repository.deleteProvider('builtin-claude-isolated', 'inherit')

    expect(settings.providers).toEqual([])
    expect(settings.reviewerModel).toEqual({ mode: 'inherit' })
  })

  it('ignores an active pointer that references an unknown provider', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('does-not-exist')

    expect((await repository.getSettings()).activeProviderId).toBeUndefined()
  })

  it('drops unknown fields and invalid providers on load', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 1,
        activeProviderId: 'p1',
        claude: { resolvedPath: '/bin/claude', junk: 'drop' },
        providers: [
          { id: 'p1', type: 'custom', name: 'Ok', secretPlaintext: 'should not persist' },
          { id: 'p2', type: 'not-a-type', name: 'Bad' },
          { type: 'custom', name: 'No id' }
        ]
      }),
      'utf8'
    )

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['p1'])
    expect(settings.providers[0]).not.toHaveProperty('secretPlaintext')
    expect(settings.claude).toEqual({ resolvedPath: '/bin/claude' })
  })

  it('keeps only positive whole-number custom model limits without changing their semantics', () => {
    const base = { id: 'p1', type: 'custom', name: 'Gateway' }

    const fields = ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const
    for (const field of fields) {
      expect(
        sanitizeSettings({ providers: [{ ...base, [field]: 64_000 }] }).providers[0][field]
      ).toBe(64_000)
      for (const invalid of [0, -1, 1.5, Number.NaN, '200000']) {
        expect(
          sanitizeSettings({ providers: [{ ...base, [field]: invalid }] }).providers[0][field]
        ).toBeUndefined()
      }
    }
  })

  it('keeps only a known custom-model reasoning effort preset', () => {
    const base = { id: 'p1', type: 'custom', name: 'Gateway' }

    expect(
      sanitizeSettings({ providers: [{ ...base, reasoningEffortPreset: 'none-high' }] })
        .providers[0].reasoningEffortPreset
    ).toBe('none-high')
    expect(
      sanitizeSettings({ providers: [{ ...base, reasoningEffortPreset: 'unsupported' }] })
        .providers[0].reasoningEffortPreset
    ).toBe('unsupported')
    expect(
      sanitizeSettings({ providers: [{ ...base, reasoningEffortPreset: 'dynamic' }] }).providers[0]
        .reasoningEffortPreset
    ).toBeUndefined()
  })

  it('keeps only a known custom-model reasoning effort transport', () => {
    const base = { id: 'p1', type: 'custom', name: 'Gateway' }

    expect(
      sanitizeSettings({ providers: [{ ...base, reasoningEffortTransport: 'deepseek' }] })
        .providers[0].reasoningEffortTransport
    ).toBe('deepseek')
    expect(
      sanitizeSettings({ providers: [{ ...base, reasoningEffortTransport: 'guessed' }] })
        .providers[0].reasoningEffortTransport
    ).toBeUndefined()
    expect(
      sanitizeSettings({
        providers: [
          {
            ...base,
            type: 'official',
            vendorId: 'deepseek',
            reasoningEffortTransport: 'openrouter'
          }
        ]
      }).providers[0].reasoningEffortTransport
    ).toBeUndefined()
  })

  it('round-trips a recorded validation failure across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(
      provider({
        lastValidatedAt: 1716999999999,
        lastValidatedTarget: { model: 'model-a', endpoint: 'anthropic' },
        lastValidationFailure: {
          at: 1717000000000,
          category: 'model-not-found',
          status: 404,
          message: 'nope',
          target: { model: 'model-b', endpoint: 'anthropic' }
        }
      })
    )

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.providers[0].lastValidatedTarget).toEqual({
      model: 'model-a',
      endpoint: 'anthropic'
    })
    expect(reloaded.providers[0].lastValidationFailure).toEqual({
      at: 1717000000000,
      category: 'model-not-found',
      status: 404,
      message: 'nope',
      target: { model: 'model-b', endpoint: 'anthropic' }
    })
  })

  it('round-trips an incompatible validation failure across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(
      provider({
        lastValidationFailure: {
          at: 1717000000000,
          category: 'incompatible',
          message: 'Not compatible with Claude Code: it needs /v1/messages.'
        }
      })
    )

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.providers[0].lastValidationFailure).toEqual({
      at: 1717000000000,
      category: 'incompatible',
      message: 'Not compatible with Claude Code: it needs /v1/messages.'
    })
  })

  it('round-trips a server-error validation failure across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(
      provider({
        lastValidationFailure: {
          at: 1717000000000,
          category: 'server-error',
          status: 503,
          message: 'Service temporarily unavailable'
        }
      })
    )

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.providers[0].lastValidationFailure).toEqual({
      at: 1717000000000,
      category: 'server-error',
      status: 503,
      message: 'Service temporarily unavailable'
    })
  })

  it('drops a malformed validation failure (bad category or missing timestamp) on load', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'a',
            type: 'custom',
            name: 'A',
            lastValidationFailure: { at: 1, category: 'bogus' }
          },
          { id: 'b', type: 'custom', name: 'B', lastValidationFailure: { category: 'auth' } }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['a', 'b'])
    expect(settings.providers[0].lastValidationFailure).toBeUndefined()
    expect(settings.providers[1].lastValidationFailure).toBeUndefined()
  })

  it('serializes concurrent mutations without losing writes', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await Promise.all([
      repository.upsertProvider(provider({ id: 'p1', name: 'One' })),
      repository.upsertProvider(provider({ id: 'p2', name: 'Two' })),
      repository.upsertProvider(provider({ id: 'p3', name: 'Three' }))
    ])

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id).sort()).toEqual(['p1', 'p2', 'p3'])
  })

  it('enforces the custom Connector capacity inside concurrent appends', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    const server = (index: number): StoredCustomMcpServer => ({
      id: `capacity-${index}`,
      name: `capacity-${index}`,
      displayName: `Capacity ${index}`,
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      trustedAt: 1
    })

    await Promise.all(
      Array.from({ length: CONNECTOR_RESOURCE_LIMITS.customServers - 1 }, (_, index) =>
        repository.addCustomServer(server(index))
      )
    )
    const results = await Promise.allSettled([
      repository.addCustomServer(server(CONNECTOR_RESOURCE_LIMITS.customServers - 1)),
      repository.addCustomServer(server(CONNECTOR_RESOURCE_LIMITS.customServers))
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect((await repository.getSettings()).connectors?.customMcpServers).toHaveLength(
      CONNECTOR_RESOURCE_LIMITS.customServers
    )
  })

  it('preserves concurrent mutations from Settings and legacy Compute callers', async () => {
    const store = new SettingsDocumentStore(await createStorageRoot())
    const settings = new SettingsRepository(store)
    const legacyCompute = new SettingsRepository(store)

    await Promise.all([
      settings.upsertProvider(provider({ id: 'p-settings' })),
      legacyCompute.addComputeGrant({
        projectId: 'project-1',
        operation: 'submit_job',
        providerId: 'ssh:cluster'
      })
    ])

    await expect(settings.getSettings()).resolves.toMatchObject({
      providers: [expect.objectContaining({ id: 'p-settings' })],
      computeGrants: [
        { projectId: 'project-1', operation: 'submit_job', providerId: 'ssh:cluster' }
      ]
    })
  })

  it('stamps onboardingCompletedAt once and is idempotent', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    const first = await repository.markOnboardingComplete(1000)
    expect(first.onboardingCompletedAt).toBe(1000)

    // A second call must not overwrite or move the existing timestamp.
    const second = await repository.markOnboardingComplete(2000)
    expect(second.onboardingCompletedAt).toBe(1000)
  })

  it('preserves onboardingCompletedAt across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.markOnboardingComplete(1234)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.onboardingCompletedAt).toBe(1234)
  })

  it('preserves compute bookmarks across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setComputeBookmarks('ssh:cluster', ['/scratch/project', '/data/results'])
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toMatchObject({
      computeBookmarks: { 'ssh:cluster': ['/scratch/project', '/data/results'] }
    })

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.computeBookmarks).toEqual({
      'ssh:cluster': ['/scratch/project', '/data/results']
    })

    await new SettingsRepository(root).setNotificationsEnabled(false)
    await expect(new SettingsRepository(root).getSettings()).resolves.toMatchObject({
      computeBookmarks: { 'ssh:cluster': ['/scratch/project', '/data/results'] },
      notificationsEnabled: false
    })
  })

  it('stamps pathsNormalizedAt once, is idempotent, and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.markPathsNormalized(1000)
    expect(first.pathsNormalizedAt).toBe(1000)

    // A second call must not overwrite or move the existing timestamp.
    const second = await repository.markPathsNormalized(2000)
    expect(second.pathsNormalizedAt).toBe(1000)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.pathsNormalizedAt).toBe(1000)
  })

  it('sets dataRoot with an idempotent onboarding marker and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.setDataRoot({
      dataRoot: '/mnt/data-a',
      onboardingCompletedAt: 1000
    })
    expect(first.dataRoot).toBe('/mnt/data-a')
    expect(first.onboardingCompletedAt).toBe(1000)

    // dataRoot moves, but the one-time onboarding marker keeps its original timestamp.
    const second = await repository.setDataRoot({
      dataRoot: '/mnt/data-b',
      onboardingCompletedAt: 2000
    })
    expect(second.dataRoot).toBe('/mnt/data-b')
    expect(second.onboardingCompletedAt).toBe(1000)

    // getSettings reads through sanitizeSettings, which normalizes the stored path (backslashes on
    // Windows), so compare against the platform-normalized form rather than the literal.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.dataRoot).toBe(normalize('/mnt/data-b'))
  })

  it('relocates disabled managed runtime IDs atomically and idempotently with dataRoot', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)
    const previousDataRoot = join(root, 'data-a')
    const dataRoot = join(root, 'data-b')
    const runtimeId = (
      targetDataRoot: string,
      language: 'python' | 'r',
      environment: string
    ): string => {
      const prefix = join(
        targetDataRoot,
        'runtime',
        'envs',
        envDirectoryName(environment, process.platform)
      )
      if (process.platform !== 'win32')
        return join(prefix, 'bin', language === 'python' ? 'python' : 'R')
      return language === 'python'
        ? join(prefix, 'python.exe')
        : join(prefix, 'Lib', 'R', 'bin', 'R.exe')
    }
    const externalPython = join(root, 'external', 'python')
    const previousPython = runtimeId(previousDataRoot, 'python', 'default-python')
    const relocatedPython = runtimeId(dataRoot, 'python', 'default-python')
    const previousR = runtimeId(previousDataRoot, 'r', 'analysis')
    const relocatedR = runtimeId(dataRoot, 'r', 'analysis')

    await repository.setRuntimeEnablement('python', () => ({
      enabled: { [previousPython]: false, [externalPython]: false },
      installAuthorized: { [previousPython]: true, [externalPython]: false }
    }))
    await repository.setRuntimeEnablement('r', () => ({
      enabled: { [previousR]: false },
      installAuthorized: { [previousR]: true }
    }))

    const first = await repository.setDataRoot({ dataRoot, previousDataRoot })
    expect(first.notebookRuntimeEnablement).toEqual({
      python: {
        enabled: {
          [previousPython]: false,
          [relocatedPython]: false,
          [externalPython]: false
        },
        installAuthorized: { [previousPython]: true, [externalPython]: false }
      },
      r: {
        enabled: { [previousR]: false, [relocatedR]: false },
        installAuthorized: { [previousR]: true }
      }
    })

    const retried = await repository.setDataRoot({ dataRoot, previousDataRoot })
    expect(retried.notebookRuntimeEnablement).toEqual(first.notebookRuntimeEnablement)
    await expect(new SettingsRepository(root).getSettings()).resolves.toMatchObject({
      dataRoot: normalize(dataRoot),
      notebookRuntimeEnablement: first.notebookRuntimeEnablement
    })
  })

  it('sanitizeSettings drops a relative dataRoot and keeps only an absolute, normalized one', () => {
    // A relative dataRoot (corrupt or hand-edited settings.json) must be dropped so the data tree
    // never resolves against process.cwd(); initDataRoot then falls back to the default.
    expect(sanitizeSettings({ dataRoot: 'relative/path' }).dataRoot).toBeUndefined()
    expect(sanitizeSettings({ dataRoot: './OpenScience' }).dataRoot).toBeUndefined()

    // Whitespace-only is not a path.
    expect(sanitizeSettings({ dataRoot: '   ' }).dataRoot).toBeUndefined()

    // Build an absolute path with platform-correct roots so isAbsolute holds on POSIX and Windows.
    const absolute = isAbsolute('/mnt/data') ? '/mnt/data' : `C:${sep}mnt${sep}data`
    // Surrounding whitespace is trimmed, then the path is kept.
    expect(sanitizeSettings({ dataRoot: `  ${absolute} ` }).dataRoot).toBe(normalize(absolute))

    // A redundant separator AND a trailing separator collapse to the canonical no-trailing-slash form.
    const messy = `${absolute}${sep}${sep}x${sep}`
    expect(sanitizeSettings({ dataRoot: messy }).dataRoot).toBe(normalize(`${absolute}${sep}x`))
  })

  it('never strips a trailing separator past a filesystem root', () => {
    // A drive/filesystem root ("C:\" on Windows, "/" on POSIX) must survive intact: stripping its
    // trailing separator would turn an absolute path into a drive-relative one.
    const rootPath = isAbsolute('C:\\') ? 'C:\\' : '/'
    expect(sanitizeSettings({ dataRoot: rootPath }).dataRoot).toBe(normalize(rootPath))
  })

  it('stamps legacyDataMovePromptDismissedAt once, is idempotent, and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.markLegacyDataMovePromptDismissed(1000)
    expect(first.legacyDataMovePromptDismissedAt).toBe(1000)

    // Answering again must never move the timestamp — the prompt stays dismissed for good.
    const second = await repository.markLegacyDataMovePromptDismissed(2000)
    expect(second.legacyDataMovePromptDismissedAt).toBe(1000)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.legacyDataMovePromptDismissedAt).toBe(1000)
  })
})

describe('sanitizeSettings notebookRuntimeEnablement', () => {
  it('round-trips a valid per-language enablement (both maps)', () => {
    const result = sanitizeSettings({
      version: 2,
      providers: [],
      notebookRuntimeEnablement: {
        python: {
          enabled: { '/usr/bin/python3': true, '/opt/py/bin/python': false },
          installAuthorized: { '/usr/bin/python3': true }
        },
        r: { enabled: { '/usr/bin/R': true }, installAuthorized: {} }
      }
    })
    expect(result.notebookRuntimeEnablement).toEqual({
      python: {
        enabled: { '/usr/bin/python3': true, '/opt/py/bin/python': false },
        installAuthorized: { '/usr/bin/python3': true }
      },
      r: { enabled: { '/usr/bin/R': true }, installAuthorized: {} }
    })
  })

  it('drops non-boolean values and non-object maps, keeping only clean boolean entries', () => {
    const result = sanitizeSettings({
      version: 2,
      providers: [],
      notebookRuntimeEnablement: {
        python: {
          enabled: { '/a': true, '/b': 'yes', '/c': 1 },
          installAuthorized: 'nope'
        }
      }
    })
    expect(result.notebookRuntimeEnablement).toEqual({
      python: { enabled: { '/a': true }, installAuthorized: {} }
    })
  })

  it('drops an entry that sanitizes to empty and the whole field when nothing survives', () => {
    const result = sanitizeSettings({
      version: 2,
      providers: [],
      notebookRuntimeEnablement: {
        python: { enabled: { '/a': 42 }, installAuthorized: { '/b': 'x' } },
        r: 'garbage'
      }
    })
    expect(result.notebookRuntimeEnablement).toBeUndefined()
  })
})

describe('settings repository: v2 official providers & activeModel migration', () => {
  it('backfills activeModel from the active provider when a pre-v2 file omits it', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 1,
        activeProviderId: 'p1',
        providers: [
          { id: 'p1', type: 'custom', name: 'G', baseUrl: 'https://g', model: 'legacy-m' }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.version).toBe(2)
    expect(settings.activeModel).toBe('legacy-m')
  })

  it('keeps an explicit activeModel from a v2 file', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        activeProviderId: 'p1',
        activeModel: 'glm-4.7',
        providers: [{ id: 'p1', type: 'official', name: 'GLM', vendorId: 'zhipu', keyRef: 'enc:x' }]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.activeModel).toBe('glm-4.7')
    expect(settings.providers[0]).toMatchObject({ type: 'official', vendorId: 'zhipu' })
  })

  it('drops an official provider with an unknown or missing vendor', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          { id: 'ok', type: 'official', name: 'DeepSeek', vendorId: 'deepseek', keyRef: 'enc:x' },
          { id: 'bad1', type: 'official', name: 'Bogus', vendorId: 'unknown', keyRef: 'enc:x' },
          { id: 'bad2', type: 'official', name: 'No vendor', keyRef: 'enc:x' }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['ok'])
  })

  it('clears activeModel when the active provider is deleted', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1', 'm')
    expect((await repository.getSettings()).activeModel).toBe('m')

    await repository.deleteProvider('p1')
    expect((await repository.getSettings()).activeModel).toBeUndefined()
  })

  it('does not recreate a deleted Claude provider when a late credential save arrives', async () => {
    const repository = new SettingsRepository(await createStorageRoot())
    await repository.upsertClaudeIsolatedProvider({
      keyRef: 'enc:initial',
      keyMask: 'sk-ant-…initial'
    })
    await repository.deleteProvider('builtin-claude-isolated')

    await expect(
      repository.updateClaudeIsolatedCredentialsIfExists({
        keyRef: 'enc:late',
        keyMask: 'sk-ant-…late'
      })
    ).resolves.toBe(false)
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('persists the active provider + model across a reload (app restart)', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1', 'my-model')

    // A fresh repository on the same storage dir models an app restart: the selection is read back.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.activeProviderId).toBe('p1')
    expect(reloaded.activeModel).toBe('my-model')
  })

  it('persists and clears disabledSkillIds via setSkillEnabled', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setSkillEnabled('citation-formatter', false)
    expect((await repository.getSettings()).disabledSkillIds).toEqual(['citation-formatter'])

    // Re-enabling removes the id (and drops the field when the set becomes empty).
    await repository.setSkillEnabled('citation-formatter', true)
    expect((await repository.getSettings()).disabledSkillIds).toBeUndefined()
  })

  it('persists a Skill enablement batch in the existing disabledSkillIds field', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setSkillsEnabled(['imported-a', 'personal-b', 'imported-a'], false)
    expect((await repository.getSettings()).disabledSkillIds).toEqual(['imported-a', 'personal-b'])

    await repository.setSkillsEnabled(['imported-a', 'personal-b'], true)
    expect((await repository.getSettings()).disabledSkillIds).toBeUndefined()
  })

  it('serializes Main Skill enablement with package Skill replacement', async () => {
    const root = await createStorageRoot()
    const owner = skillMutationOwnerFor(root)
    const repository = new SettingsRepository(root, (operation) => owner.runExclusive(operation))
    const release = await owner.acquire()
    let settled = false
    const update = repository.setSkillEnabled('imported-a', false).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    release()
    await expect(update).resolves.toMatchObject({ disabledSkillIds: ['imported-a'] })
  })

  it('persists and clears only the encrypted GitHub token reference and display mask', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setGitHubToken('enc:ciphertext', 'gith…oken')
    expect(await repository.getSettings()).toMatchObject({
      githubTokenRef: 'enc:ciphertext',
      githubTokenMask: 'gith…oken'
    })

    await repository.setGitHubToken(undefined, undefined)
    expect((await repository.getSettings()).githubTokenRef).toBeUndefined()
    expect((await repository.getSettings()).githubTokenMask).toBeUndefined()
    expect(
      sanitizeSettings({ githubTokenRef: 42, githubTokenMask: false }).githubTokenRef
    ).toBeUndefined()
  })

  it('drops non-string / duplicate disabledSkillIds on read', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ version: 2, providers: [], disabledSkillIds: ['a', 'a', 3, '', 'b'] }),
      'utf8'
    )

    expect((await new SettingsRepository(root).getSettings()).disabledSkillIds).toEqual(['a', 'b'])
  })

  it('persists and clears a per-language runtime enablement via setRuntimeEnablement', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    const enablement = {
      enabled: { '/usr/bin/python3': true },
      installAuthorized: { '/usr/bin/python3': false }
    }
    await repository.setRuntimeEnablement('python', () => enablement)
    expect((await repository.getSettings()).notebookRuntimeEnablement).toEqual({
      python: enablement
    })

    await repository.setRuntimeEnablement('python', () => ({
      enabled: {},
      installAuthorized: {}
    }))
    expect((await repository.getSettings()).notebookRuntimeEnablement).toBeUndefined()
  })

  it('persists, dedupes, and clears the manual-interpreter catalog via setManualInterpreters', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    // Trim + dedupe on write.
    await repository.setManualInterpreters('python', () => [
      '/opt/py/bin/python3',
      '  /opt/py/bin/python3  ',
      '/other/python'
    ])
    expect((await repository.getSettings()).notebookManualInterpreters).toEqual({
      python: ['/opt/py/bin/python3', '/other/python']
    })

    await repository.setManualInterpreters('python', () => [])
    expect((await repository.getSettings()).notebookManualInterpreters).toBeUndefined()
  })
})

describe('settings repository: unknown provider type on load (claude-default removal)', () => {
  // This is the upgrade-path guarantee #346 makes: an existing install with a stored
  // claude-default provider (and possibly an activeProviderId / activeModel pointing at it) must
  // come up cleanly on the next launch, with the unknown provider dropped, the active pointers
  // cleared, and a WARN log so the user can see what happened.

  const writeRawSettings = async (root: string, payload: object): Promise<void> => {
    await writeFile(join(root, 'settings.json'), JSON.stringify(payload), 'utf8')
  }

  it('drops a stored claude-default provider at load and logs a WARN with the unknown id+type', async () => {
    // The repository's `log` is a module-scoped const created via createLogger. We can't reach it
    // directly, so the test mocks the logger module at the top of the file and asserts the
    // repository called `warn` with the unknown id + type. The dedicated log-format tests in
    // logger.test.ts cover the formatting pipeline; this test pins the repository's call site.
    const { warn: warnSpy } = loggerMock
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await writeRawSettings(root, {
      version: 1,
      providers: [
        { id: 'p-custom', type: 'custom', name: 'Custom' },
        // claude-shared is a real, supported type: it must survive the allowlist, not be dropped.
        { id: 'builtin-claude-shared', type: 'claude-shared', name: 'Claude subscription' },
        { id: 'p-removed', type: 'claude-default', name: 'Old Local Claude' }
      ]
    })

    const settings = await repository.getSettings()
    expect(settings.providers.map((p) => p.id)).toEqual(['p-custom', 'builtin-claude-shared'])
    // One warn call for the dropped record, carrying id + type so an operator reading the log can
    // identify which provider was discarded.
    expect(warnSpy).toHaveBeenCalledWith(
      'dropping stored provider with unknown type',
      expect.objectContaining({ id: 'p-removed', type: 'claude-default' })
    )
  })

  it('clears activeProviderId and activeModel when the active provider is the dropped one', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await writeRawSettings(root, {
      version: 1,
      activeProviderId: 'p-removed',
      activeModel: 'claude-sonnet-4-5',
      providers: [
        {
          id: 'p-removed',
          type: 'claude-default',
          name: 'Old Local Claude',
          model: 'claude-sonnet-4-5'
        }
      ]
    })

    const settings = await repository.getSettings()

    // The dropped provider's id is no longer in the list, so the active pointer must be cleared.
    expect(settings.providers.find((p) => p.id === 'p-removed')).toBeUndefined()
    expect(settings.activeProviderId).toBeUndefined()
    // activeModel must follow the activeProviderId: a stale model without a provider is a half-state
    // the composer can pick up.
    expect(settings.activeModel).toBeUndefined()
  })

  it('keeps activeProviderId when the active provider survives the drop', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await writeRawSettings(root, {
      version: 1,
      activeProviderId: 'p-survives',
      activeModel: 'gpt-4o',
      providers: [
        { id: 'p-survives', type: 'custom', name: 'Survives', model: 'gpt-4o' },
        { id: 'p-removed', type: 'claude-default', name: 'Old Local Claude' }
      ]
    })

    const settings = await repository.getSettings()

    expect(settings.activeProviderId).toBe('p-survives')
    expect(settings.activeModel).toBe('gpt-4o')
    expect(settings.providers.find((p) => p.id === 'p-removed')).toBeUndefined()
  })
})
