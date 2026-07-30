import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger } from '../logger'
import {
  createEmptySpecialists,
  SPECIALISTS_FILE_VERSION,
  type StoredSpecialist,
  type StoredSpecialists
} from './types'
import type {
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig,
  ConnectorToolRule
} from '../../shared/specialist'

const SPECIALISTS_FILE = 'specialists.json'

const log = createLogger('specialist.repository')

// ---------------------------------------------------------------------------
// Sanitization helpers (untrusted disk data → safe in-memory shapes)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const asBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const CAPABILITY_MODES = new Set<SpecialistCapabilityMode>(['full', 'selected'])

const sanitizeConnectorToolRule = (v: unknown): ConnectorToolRule | undefined => {
  if (!isRecord(v)) return undefined
  const connectorId = asString(v.connectorId)
  if (!connectorId) return undefined
  const rule: ConnectorToolRule = { connectorId }
  const includedMethods = asStringArray(v.includedMethods)
  const excludedMethods = asStringArray(v.excludedMethods)
  const includeToolsPattern = asString(v.includeToolsPattern)
  const excludeToolsPattern = asString(v.excludeToolsPattern)
  if (includedMethods.length) rule.includedMethods = includedMethods
  if (excludedMethods.length) rule.excludedMethods = excludedMethods
  if (includeToolsPattern) rule.includeToolsPattern = includeToolsPattern
  if (excludeToolsPattern) rule.excludeToolsPattern = excludeToolsPattern
  return rule
}

const sanitizeFullAccessConfig = (v: unknown): SpecialistFullAccessConfig => {
  if (!isRecord(v)) return { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] }
  return {
    excludedSkillIds: asStringArray(v.excludedSkillIds),
    excludedConnectorIds: asStringArray(v.excludedConnectorIds),
    connectorTools: Array.isArray(v.connectorTools)
      ? v.connectorTools
          .map(sanitizeConnectorToolRule)
          .filter((r): r is ConnectorToolRule => r !== undefined)
      : []
  }
}

const sanitizeSelectedConfig = (v: unknown): SpecialistSelectedConfig => {
  if (!isRecord(v)) return { skillIds: [], connectorIds: [], connectorTools: [] }
  return {
    skillIds: asStringArray(v.skillIds),
    connectorIds: asStringArray(v.connectorIds),
    connectorTools: Array.isArray(v.connectorTools)
      ? v.connectorTools
          .map(sanitizeConnectorToolRule)
          .filter((r): r is ConnectorToolRule => r !== undefined)
      : []
  }
}

// Rebuild one stored specialist, dropping unknown or malformed records.
// Older experimental documents may only have one human-readable name. Preserve
// them as a display name and derive a durable public identifier on first write.
export const sanitizeStoredSpecialist = (v: unknown): StoredSpecialist | undefined => {
  if (!isRecord(v)) return undefined
  const id = asString(v.id)
  const legacyName = asString(v.name)
  const displayName = asString(v.displayName) ?? legacyName
  const name = legacyName
  const description = asString(v.description)
  const systemPrompt = asString(v.systemPrompt)
  const enabled = asBoolean(v.enabled)
  const capabilityModeRaw = asString(v.capabilityMode) as SpecialistCapabilityMode | undefined

  if (
    !id ||
    !name ||
    !displayName ||
    description === undefined ||
    systemPrompt === undefined ||
    enabled === undefined ||
    !capabilityModeRaw ||
    !CAPABILITY_MODES.has(capabilityModeRaw)
  ) {
    return undefined
  }

  const revision = asNumber(v.revision) ?? 1
  const specialist: StoredSpecialist = {
    id,
    name,
    displayName,
    description,
    systemPrompt,
    enabled,
    capabilityMode: capabilityModeRaw,
    fullAccess: sanitizeFullAccessConfig(v.fullAccess),
    selectedCapabilities: sanitizeSelectedConfig(v.selectedCapabilities),
    revision
  }
  const iconKey = asString(v.iconKey)
  const colorKey = asString(v.colorKey)
  if (iconKey) specialist.iconKey = iconKey
  if (colorKey) specialist.colorKey = colorKey
  return specialist
}

const sanitizeSpecialists = (v: unknown): StoredSpecialists => {
  if (!isRecord(v)) return createEmptySpecialists()
  // Detect old experimental feat/specialist schema (kebab-case agentId) and ignore it.
  if (Array.isArray(v.specialists)) {
    const first = v.specialists[0]
    if (isRecord(first) && typeof first.agentId === 'string' && /[a-z]/.test(first.agentId)) {
      log.warn('ignoring old experimental specialist schema (kebab-case agentId detected)')
      return createEmptySpecialists()
    }
  }
  // Deliberate policy: a malformed *individual* record is silently dropped rather than
  // failing the whole read.  Rationale: a single corrupt record is most likely from a
  // schema migration or manual edit gone wrong; surfacing all valid specialists is better
  // than blocking all access.  The risk of silent loss on next write is mitigated by
  // getAll() now throwing on OS-level read failures — the dangerous path (transient
  // EMFILE/EACCES producing an empty document that then gets written back) is closed.
  // If you change this policy, audit callers of sanitizeSpecialists in mutate().
  const specialists = Array.isArray(v.specialists)
    ? v.specialists
        .map(sanitizeStoredSpecialist)
        .filter((s): s is StoredSpecialist => s !== undefined)
    : []
  return { version: SPECIALISTS_FILE_VERSION, specialists }
}

// ---------------------------------------------------------------------------
// Repository class
// ---------------------------------------------------------------------------

// Owns durable reads/writes of specialists.json. Uses atomic write (tmp + rename)
// and serializes concurrent mutations through a queue — identical to SettingsRepository.
export class SpecialistRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0

  constructor(private readonly storageDir: string) {}

  private get filePath(): string {
    return join(this.storageDir, SPECIALISTS_FILE)
  }

  async getAll(): Promise<StoredSpecialists> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (err) {
      // ENOENT is the normal first-run state — return an empty document.
      // Any other OS error (EMFILE, EACCES, truncated read, etc.) must propagate so
      // that mutate() aborts rather than silently overwriting a store we could not read.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptySpecialists()
      }
      log.error('failed to read specialists file — aborting to prevent data loss', {
        path: this.filePath,
        code: (err as NodeJS.ErrnoException).code
        // intentionally omitting file contents — systemPrompt must not reach the log
      })
      throw err
    }

    // JSON.parse failure (truncated write, disk corruption) must also propagate.
    // We do not return empty here because the file exists but is unreadable — a
    // subsequent write would permanently destroy every specialist the file contained.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (err) {
      log.error('failed to parse specialists file — aborting to prevent data loss', {
        path: this.filePath
        // intentionally omitting raw content — systemPrompt must not reach the log
      })
      throw err
    }

    return sanitizeSpecialists(parsed)
  }

  // Insert a new specialist (caller supplies a fully-formed record).
  async insert(specialist: StoredSpecialist): Promise<StoredSpecialists> {
    return this.mutate((doc) => {
      // Check uniqueness of id and name.
      if (doc.specialists.some((s) => s.id === specialist.id)) {
        throw new Error(`Specialist with id ${specialist.id} already exists.`)
      }
      if (doc.specialists.some((s) => s.name === specialist.name)) {
        throw new Error(`Specialist with name "${specialist.name}" already exists.`)
      }
      return { ...doc, specialists: [...doc.specialists, specialist] }
    })
  }

  // Replace an existing specialist by id (revision must match expectedRevision).
  async update(
    id: string,
    patch: Partial<StoredSpecialist>,
    expectedRevision: number
  ): Promise<StoredSpecialists> {
    return this.mutate((doc) => {
      const index = doc.specialists.findIndex((s) => s.id === id)
      if (index < 0) throw new Error(`Specialist ${id} not found.`)
      const current = doc.specialists[index]
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Revision conflict: expected ${expectedRevision}, found ${current.revision}.`
        )
      }
      // Name uniqueness when renaming.
      if (patch.name && patch.name !== current.name) {
        if (doc.specialists.some((s) => s.id !== id && s.name === patch.name)) {
          throw new Error(`Specialist with name "${patch.name}" already exists.`)
        }
      }
      const updated: StoredSpecialist = {
        ...current,
        ...patch,
        id, // id is immutable
        revision: current.revision + 1
      }
      const specialists = [...doc.specialists]
      specialists[index] = updated
      return { ...doc, specialists }
    })
  }

  // Toggle enabled without revision check (simple toggle).
  async setEnabled(id: string, enabled: boolean): Promise<StoredSpecialists> {
    return this.mutate((doc) => {
      const index = doc.specialists.findIndex((s) => s.id === id)
      if (index < 0) throw new Error(`Specialist ${id} not found.`)
      const specialists = [...doc.specialists]
      specialists[index] = {
        ...specialists[index],
        enabled,
        revision: specialists[index].revision + 1
      }
      return { ...doc, specialists }
    })
  }

  // Delete a specialist by id.
  async delete(id: string, expectedRevision?: number): Promise<StoredSpecialists> {
    return this.mutate((doc) => {
      const current = doc.specialists.find((s) => s.id === id)
      if (!current) throw new Error(`Specialist ${id} not found.`)
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(
          `Revision conflict: expected ${expectedRevision}, found ${current.revision}.`
        )
      }
      return { ...doc, specialists: doc.specialists.filter((s) => s.id !== id) }
    })
  }

  // Serializes mutations so concurrent callers cannot clobber each other.
  private mutate(fn: (doc: StoredSpecialists) => StoredSpecialists): Promise<StoredSpecialists> {
    const run = this.saveQueue.then(async () => {
      const current = await this.getAll()
      const next = fn(current)
      await this.write(next)
      return next
    })
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async write(doc: StoredSpecialists): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })
    this.writeSequence += 1
    const tmp = `${this.filePath}.${Date.now()}-${this.writeSequence}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }
}

export { sanitizeStoredSpecialist as sanitizeSpecialist, sanitizeSpecialists }
