import { join } from 'node:path'

import { createLogger } from '../logger'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'
import {
  createEmptySpecialists,
  SPECIALISTS_FILE_VERSION,
  type SpecialistImportBaseline,
  type SpecialistOrigin,
  type StoredSpecialist,
  type StoredSpecialists
} from './types'
import type {
  SpecialistCapabilityMode,
  SpecialistDocumentIntegrity,
  SpecialistDocumentIntegrityIssue,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig,
  ConnectorToolRule
} from '../../shared/specialist'

const SPECIALISTS_FILE = 'specialists.json'

const log = createLogger('specialist.repository')

export class SpecialistIdConflictError extends Error {
  constructor(readonly specialistId: string) {
    super(`Specialist with id ${specialistId} already exists.`)
    this.name = 'SpecialistIdConflictError'
  }
}

export class SpecialistDocumentDegradedError extends Error {
  readonly code = 'SPECIALIST_DOCUMENT_DEGRADED' as const

  constructor(readonly integrity: Extract<SpecialistDocumentIntegrity, { status: 'degraded' }>) {
    super(
      'Specialist data contains records that cannot be safely rewritten. Repair the file first.'
    )
    this.name = 'SpecialistDocumentDegradedError'
  }
}

// ---------------------------------------------------------------------------
// Sanitization helpers (untrusted disk data → safe in-memory shapes)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const asBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const isStoredSpecialistRevision = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key))

const isExactStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const CONNECTOR_TOOL_RULE_KEYS = new Set([
  'connectorId',
  'includedMethods',
  'excludedMethods',
  'includeToolsPattern',
  'excludeToolsPattern'
])

const connectorToolRuleWouldLoseData = (value: unknown): boolean => {
  if (!isRecord(value) || !hasOnlyKeys(value, CONNECTOR_TOOL_RULE_KEYS)) return true
  if (typeof value.connectorId !== 'string' || !value.connectorId) return true
  if (value.includedMethods !== undefined && !isExactStringArray(value.includedMethods)) return true
  if (value.excludedMethods !== undefined && !isExactStringArray(value.excludedMethods)) return true
  if (value.includeToolsPattern !== undefined && typeof value.includeToolsPattern !== 'string') {
    return true
  }
  return value.excludeToolsPattern !== undefined && typeof value.excludeToolsPattern !== 'string'
}

const FULL_ACCESS_KEYS = new Set(['excludedSkillIds', 'excludedConnectorIds', 'connectorTools'])
const SELECTED_KEYS = new Set(['skillIds', 'connectorIds', 'connectorTools'])

const capabilityConfigWouldLoseData = (
  value: unknown,
  allowed: ReadonlySet<string>,
  stringArrayKeys: readonly string[]
): boolean => {
  if (value === undefined) return false
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) return true
  for (const key of stringArrayKeys) {
    if (value[key] !== undefined && !isExactStringArray(value[key])) return true
  }
  return (
    value.connectorTools !== undefined &&
    (!Array.isArray(value.connectorTools) ||
      value.connectorTools.some(connectorToolRuleWouldLoseData))
  )
}

const IMPORT_BASELINE_KEYS = new Set([
  'importedAt',
  'archiveDigest',
  'contentDigest',
  'packageContentDigest',
  'packageVersion'
])
const SPECIALIST_KEYS = new Set([
  'id',
  'name',
  'displayName',
  'description',
  'systemPrompt',
  'iconKey',
  'colorKey',
  'enabled',
  'setupPending',
  'capabilityMode',
  'fullAccess',
  'selectedCapabilities',
  'revision',
  'packageVersion',
  'origin',
  'ownedSkillIds',
  'importBaseline'
])

const storedSpecialistWouldLoseData = (value: Record<string, unknown>): boolean => {
  if (!hasOnlyKeys(value, SPECIALIST_KEYS)) return true
  for (const key of ['displayName', 'iconKey', 'colorKey', 'packageVersion'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return true
  }
  if (value.setupPending !== undefined && typeof value.setupPending !== 'boolean') return true
  if (value.revision !== undefined && !isStoredSpecialistRevision(value.revision)) return true
  if (
    value.origin !== undefined &&
    value.origin !== 'local' &&
    value.origin !== 'imported' &&
    value.origin !== 'marketplace'
  ) {
    return true
  }
  if (value.ownedSkillIds !== undefined && !isExactStringArray(value.ownedSkillIds)) return true
  if (
    capabilityConfigWouldLoseData(value.fullAccess, FULL_ACCESS_KEYS, [
      'excludedSkillIds',
      'excludedConnectorIds'
    ]) ||
    capabilityConfigWouldLoseData(value.selectedCapabilities, SELECTED_KEYS, [
      'skillIds',
      'connectorIds'
    ])
  ) {
    return true
  }
  if (value.importBaseline !== undefined) {
    if (!isRecord(value.importBaseline)) return true
    if (
      !hasOnlyKeys(value.importBaseline, IMPORT_BASELINE_KEYS) ||
      sanitizeImportBaseline(value.importBaseline) === undefined
    ) {
      return true
    }
    for (const key of ['packageContentDigest', 'packageVersion'] as const) {
      if (
        value.importBaseline[key] !== undefined &&
        typeof value.importBaseline[key] !== 'string'
      ) {
        return true
      }
    }
  }
  return false
}

const sanitizeImportBaseline = (v: unknown): SpecialistImportBaseline | undefined => {
  if (!isRecord(v)) return undefined
  const importedAt = asString(v.importedAt)
  const archiveDigest = asString(v.archiveDigest)
  const contentDigest = asString(v.contentDigest)
  if (!importedAt || !archiveDigest || !contentDigest) return undefined
  const packageVersion = asString(v.packageVersion)
  const packageContentDigest = asString(v.packageContentDigest)
  return {
    importedAt,
    archiveDigest,
    contentDigest,
    ...(packageContentDigest ? { packageContentDigest } : {}),
    ...(packageVersion ? { packageVersion } : {})
  }
}

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
  const setupPending = asBoolean(v.setupPending) ?? false
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

  const revision = isStoredSpecialistRevision(v.revision) ? v.revision : 1
  const specialist: StoredSpecialist = {
    id,
    name,
    displayName,
    description,
    systemPrompt,
    enabled,
    setupPending,
    capabilityMode: capabilityModeRaw,
    fullAccess: sanitizeFullAccessConfig(v.fullAccess),
    selectedCapabilities: sanitizeSelectedConfig(v.selectedCapabilities),
    revision,
    packageVersion: asString(v.packageVersion) ?? '0.1.0',
    origin: (v.origin === 'imported' || v.origin === 'marketplace'
      ? v.origin
      : 'local') satisfies SpecialistOrigin,
    ownedSkillIds: asStringArray(v.ownedSkillIds)
  }
  const importBaseline = sanitizeImportBaseline(v.importBaseline)
  if (specialist.origin !== 'local' && importBaseline) specialist.importBaseline = importBaseline
  const iconKey = asString(v.iconKey)
  const colorKey = asString(v.colorKey)
  if (iconKey) specialist.iconKey = iconKey
  if (colorKey) specialist.colorKey = colorKey
  return specialist
}

const sanitizeSpecialistsWithIntegrity = (
  v: unknown
): {
  document: StoredSpecialists
  integrity: SpecialistDocumentIntegrity
} => {
  const issues: SpecialistDocumentIntegrityIssue[] = []
  if (!isRecord(v)) {
    return {
      document: createEmptySpecialists(),
      integrity: { status: 'degraded', issues: [{ code: 'document-invalid' }] }
    }
  }
  if (!hasOnlyKeys(v, new Set(['version', 'specialists'])) || !Array.isArray(v.specialists)) {
    issues.push({ code: 'document-invalid' })
  }
  if (v.version !== 1 && v.version !== SPECIALISTS_FILE_VERSION) {
    issues.push({ code: 'version-unsupported' })
  }
  // Detect old experimental feat/specialist schema (kebab-case agentId) and ignore it.
  if (Array.isArray(v.specialists)) {
    const first = v.specialists[0]
    if (isRecord(first) && typeof first.agentId === 'string' && /[a-z]/.test(first.agentId)) {
      log.warn('ignoring old experimental specialist schema (kebab-case agentId detected)')
      return {
        document: createEmptySpecialists(),
        integrity: { status: 'degraded', issues: [{ code: 'legacy-schema-unsupported' }] }
      }
    }
  }
  const specialists: StoredSpecialist[] = []
  if (Array.isArray(v.specialists)) {
    v.specialists.forEach((candidate, recordIndex) => {
      const sanitized = sanitizeStoredSpecialist(candidate)
      if (!sanitized) {
        issues.push({ code: 'record-invalid', recordIndex })
        return
      }
      specialists.push(sanitized)
      if (isRecord(candidate) && storedSpecialistWouldLoseData(candidate)) {
        issues.push({ code: 'record-sanitized', recordIndex })
      }
    })
  }
  return {
    document: { version: SPECIALISTS_FILE_VERSION, specialists },
    integrity: issues.length > 0 ? { status: 'degraded', issues } : { status: 'ok' }
  }
}

const sanitizeSpecialists = (v: unknown): StoredSpecialists =>
  sanitizeSpecialistsWithIntegrity(v).document

// ---------------------------------------------------------------------------
// Repository class
// ---------------------------------------------------------------------------

// Owns durable reads/writes of specialists.json. Uses atomic write (tmp + rename)
// and serializes concurrent mutations through a queue — identical to SettingsRepository.
export class SpecialistRepository {
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storageDir: string) {}

  private get filePath(): string {
    return join(this.storageDir, SPECIALISTS_FILE)
  }

  async getAll(): Promise<StoredSpecialists> {
    return (await this.getAllWithIntegrity()).document
  }

  async getAllWithIntegrity(): Promise<{
    document: StoredSpecialists
    integrity: SpecialistDocumentIntegrity
  }> {
    try {
      const result = await readDurableJsonFile(this.filePath, (contents) =>
        sanitizeSpecialistsWithIntegrity(JSON.parse(contents) as unknown)
      )
      return result.status === 'found'
        ? result.value
        : { document: createEmptySpecialists(), integrity: { status: 'ok' } }
    } catch (err) {
      const parseFailure = err instanceof SyntaxError
      log.error(
        parseFailure
          ? 'failed to parse specialists file — aborting to prevent data loss'
          : 'failed to read specialists file — aborting to prevent data loss',
        {
          code: parseFailure ? 'specialists-json-invalid' : (err as NodeJS.ErrnoException).code
          // intentionally omitting file contents — systemPrompt must not reach the log
        }
      )
      throw err
    }
  }

  // Insert a new specialist (caller supplies a fully-formed record).
  async insert(specialist: StoredSpecialist): Promise<StoredSpecialists> {
    return this.mutate((doc) => {
      // Check uniqueness of id and name.
      if (doc.specialists.some((s) => s.id === specialist.id)) {
        throw new SpecialistIdConflictError(specialist.id)
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
      if (patch.name !== undefined && patch.name !== current.name) {
        throw new Error('Specialist name is immutable.')
      }
      const updated: StoredSpecialist = {
        ...current,
        ...patch,
        id, // id is immutable
        name: current.name,
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
      if (enabled && doc.specialists[index].setupPending) {
        throw new Error('Complete Specialist setup before enabling it.')
      }
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

  // Package transactions use this narrow document swap after journaling their before/after state.
  async replaceAll(doc: StoredSpecialists): Promise<void> {
    const run = this.saveQueue.then(async () => {
      await this.readWritableDocument()
      await this.write(doc)
    })
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Atomically replaces the document only when no owner mutation has changed it
  // since the caller took its snapshot. Package transactions use this after their
  // asynchronous preparation work so a successful ProfileService mutation can
  // never be overwritten by a stale whole-document snapshot.
  async replaceAllIfUnchanged(
    expected: StoredSpecialists,
    replacement: StoredSpecialists
  ): Promise<void> {
    const run = this.saveQueue.then(async () => {
      const current = await this.readWritableDocument()
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error('Specialist document changed during package transaction.')
      }
      await this.write(replacement)
    })
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Serializes mutations so concurrent callers cannot clobber each other.
  private mutate(fn: (doc: StoredSpecialists) => StoredSpecialists): Promise<StoredSpecialists> {
    const run = this.saveQueue.then(async () => {
      const current = await this.readWritableDocument()
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

  private async readWritableDocument(): Promise<StoredSpecialists> {
    const snapshot = await this.getAllWithIntegrity()
    if (snapshot.integrity.status === 'degraded') {
      throw new SpecialistDocumentDegradedError(snapshot.integrity)
    }
    return snapshot.document
  }

  private async write(doc: StoredSpecialists): Promise<void> {
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(doc, null, 2)}\n`)
  }
}

export {
  sanitizeStoredSpecialist as sanitizeSpecialist,
  sanitizeSpecialists,
  sanitizeSpecialistsWithIntegrity
}
