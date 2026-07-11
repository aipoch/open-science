import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ClaudeInfo, ProviderType } from '../../shared/settings'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { createEmptySettings, type StoredProvider, type StoredSettings } from './types'

const SETTINGS_FILE = 'settings.json'

const PROVIDER_TYPES = new Set<ProviderType>(['custom', 'claude-default'])

// Checks for plain JSON objects so untrusted settings payloads can be sanitized safely.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

// Rebuilds claude metadata from allowed fields only.
const sanitizeClaudeInfo = (value: unknown): ClaudeInfo | undefined => {
  if (!isRecord(value)) return undefined

  const info: ClaudeInfo = {}
  const resolvedPath = asString(value.resolvedPath)
  const version = asString(value.version)

  if (resolvedPath) info.resolvedPath = resolvedPath
  if (version) info.version = version

  return Object.keys(info).length > 0 ? info : undefined
}

// Rebuilds one provider record, dropping unknown fields and records missing required identity.
const sanitizeProvider = (value: unknown): StoredProvider | undefined => {
  if (!isRecord(value)) return undefined

  const id = asString(value.id)
  const type = asString(value.type) as ProviderType | undefined
  const name = asString(value.name)

  if (!id || !type || !PROVIDER_TYPES.has(type) || name === undefined) return undefined

  const provider: StoredProvider = { id, type, name }
  const baseUrl = asString(value.baseUrl)
  const model = asString(value.model)
  const keyRef = asString(value.keyRef)
  const keyMask = asString(value.keyMask)
  const lastValidatedAt = asNumber(value.lastValidatedAt)

  if (baseUrl) provider.baseUrl = baseUrl
  if (model) provider.model = model
  if (keyRef) provider.keyRef = keyRef
  if (keyMask) provider.keyMask = keyMask
  if (lastValidatedAt !== undefined) provider.lastValidatedAt = lastValidatedAt

  return provider
}

// Rebuilds the whole settings document, keeping activeProviderId only when it points at a provider.
const sanitizeSettings = (value: unknown): StoredSettings => {
  if (!isRecord(value)) return createEmptySettings()

  const providers = Array.isArray(value.providers)
    ? value.providers
        .map(sanitizeProvider)
        .filter((provider): provider is StoredProvider => !!provider)
    : []
  const settings: StoredSettings = {
    version: SETTINGS_FILE_VERSION,
    providers
  }
  const claude = sanitizeClaudeInfo(value.claude)
  const activeProviderId = asString(value.activeProviderId)

  if (claude) settings.claude = claude
  if (activeProviderId && providers.some((provider) => provider.id === activeProviderId)) {
    settings.activeProviderId = activeProviderId
  }

  const onboardingCompletedAt = asNumber(value.onboardingCompletedAt)

  if (onboardingCompletedAt !== undefined) {
    settings.onboardingCompletedAt = onboardingCompletedAt
  }

  return settings
}

// Owns durable reads/writes of the single settings.json document. Writes are serialized through a
// queue and made atomic (temp + rename); an unreadable file falls back to empty settings so the app
// still boots into onboarding. All secret handling lives above this layer (crypto.ts / service.ts);
// the repository only persists whatever records it is given.
class SettingsRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0

  constructor(private readonly storageDir: string) {}

  private get settingsPath(): string {
    return join(this.storageDir, SETTINGS_FILE)
  }

  // Reads and sanitizes the settings document, returning empty settings when nothing is stored yet.
  async getSettings(): Promise<StoredSettings> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')

      return sanitizeSettings(JSON.parse(raw) as unknown)
    } catch {
      return createEmptySettings()
    }
  }

  // Inserts or replaces a provider by id, then returns the persisted document.
  async upsertProvider(provider: StoredProvider): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const providers = settings.providers.filter((existing) => existing.id !== provider.id)

      providers.push(provider)

      return { ...settings, providers }
    })
  }

  // Removes a provider and clears the active pointer when it referenced the removed provider.
  async deleteProvider(id: string): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const providers = settings.providers.filter((provider) => provider.id !== id)
      const activeProviderId =
        settings.activeProviderId === id ? undefined : settings.activeProviderId

      return { ...settings, providers, activeProviderId }
    })
  }

  // Sets (or clears) the single active provider pointer, ignoring ids that do not exist.
  async setActiveProvider(id: string | undefined): Promise<StoredSettings> {
    return this.mutate((settings) => {
      if (id !== undefined && !settings.providers.some((provider) => provider.id === id)) {
        return settings
      }

      return { ...settings, activeProviderId: id }
    })
  }

  // Records the detected claude executable metadata for later spawns.
  async setClaudeInfo(claude: ClaudeInfo): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, claude }))
  }

  // Stamps the onboarding-completed time exactly once; later calls leave the first value intact.
  async markOnboardingComplete(timestamp: number): Promise<StoredSettings> {
    return this.mutate((settings) =>
      settings.onboardingCompletedAt === undefined
        ? { ...settings, onboardingCompletedAt: timestamp }
        : settings
    )
  }

  // Serializes a read-modify-write cycle so concurrent callers cannot clobber each other.
  private mutate(update: (settings: StoredSettings) => StoredSettings): Promise<StoredSettings> {
    const run = this.saveQueue.then(async () => {
      const current = await this.getSettings()
      const next = update(current)

      await this.writeSettings(next)

      return next
    })

    // Keep the queue chained even when a write rejects so later mutations still run.
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  // Writes through a unique temp file, then atomically replaces settings.json.
  private async writeSettings(settings: StoredSettings): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })

    this.writeSequence += 1
    const temporaryPath = `${this.settingsPath}.${Date.now()}-${this.writeSequence}.tmp`

    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.settingsPath)
  }
}

export { SettingsRepository, sanitizeSettings }
