import { createHash } from 'node:crypto'

import {
  DEFAULT_BUNDLED_SKILL_VERSION,
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type PackageDiagnostic,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistPackageManifestV1,
  type SpecialistPackagePayload,
  type SpecialistPackageSkillPlan,
  type SpecialistPackageSource,
  type SpecialistPackageValidationPlan,
  type SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import { parseSkillDocument } from '../../../shared/skill-frontmatter'
import {
  validateSpecialistDescription,
  validateSpecialistDisplayName,
  validateSpecialistPublicName,
  validateSpecialistSystemPrompt
} from '../../../shared/specialist'

export type SpecialistPackageFile = { path: string; bytes: Uint8Array }

const decoder = new TextDecoder('utf-8', { fatal: true })
const SAFE_ID = /^[a-z0-9-]+$/
const SAFE_SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_ID_PREFIXES = ['os-', 'mcp-'] as const
const isSafeContributionId = (value: string): boolean =>
  SAFE_ID.test(value) && !RESERVED_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
const isSafeSkillName = (value: string): boolean =>
  SAFE_SKILL_NAME.test(value) && !RESERVED_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const diagnostic = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  path: string,
  relatedId?: string
): void => {
  diagnostics.push({ severity: 'error', code, message, path, ...(relatedId ? { relatedId } : {}) })
}

const warning = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  path: string,
  relatedId?: string
): void => {
  diagnostics.push({
    severity: 'warning',
    code,
    message,
    path,
    ...(relatedId ? { relatedId } : {})
  })
}

const parseNameList = (
  value: Record<string, unknown>,
  field: 'skill_ids' | 'connector_ids',
  diagnosticField: 'skillIds' | 'connectorIds',
  diagnostics: PackageDiagnostic[]
): string[] | undefined => {
  if (!Array.isArray(value[field])) {
    diagnostic(
      diagnostics,
      `specialist.${diagnosticField}-invalid`,
      `${field} must be an array of names.`,
      'specialist.json'
    )
    return undefined
  }
  const names: string[] = []
  let valid = true
  for (const item of value[field]) {
    if (typeof item !== 'string' || !item.trim()) {
      valid = false
      diagnostic(
        diagnostics,
        `specialist.${diagnosticField}-entry-invalid`,
        `${field} may contain only non-empty string names.`,
        'specialist.json'
      )
      continue
    }
    if (names.includes(item)) {
      valid = false
      diagnostic(
        diagnostics,
        `specialist.${diagnosticField}-duplicate`,
        `${field} must not contain duplicate names.`,
        'specialist.json'
      )
      continue
    }
    names.push(item)
  }
  return valid ? names : undefined
}

const parseJson = (
  file: SpecialistPackageFile,
  diagnostics: PackageDiagnostic[]
): unknown | undefined => {
  try {
    return JSON.parse(decoder.decode(file.bytes)) as unknown
  } catch {
    diagnostic(
      diagnostics,
      'package.json-invalid',
      'The file must contain valid UTF-8 JSON.',
      file.path
    )
    return undefined
  }
}

const parseManifest = (
  value: unknown,
  diagnostics: PackageDiagnostic[]
): SpecialistPackageManifestV1 | undefined => {
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      'manifest.object-required',
      'Manifest must be a JSON object.',
      'manifest.json'
    )
    return undefined
  }

  const allowedFields = new Set(['schema_version', 'id', 'version', 'exported_with_app_version'])
  if (Object.keys(value).some((key) => !allowedFields.has(key))) {
    diagnostic(
      diagnostics,
      'manifest.field-forbidden',
      'Manifest may contain only application-generated package metadata; dependency declarations are not supported.',
      'manifest.json'
    )
  }
  if (value.schema_version !== SPECIALIST_PACKAGE_SCHEMA_VERSION) {
    diagnostic(
      diagnostics,
      'manifest.schema-version-unsupported',
      'Package schema_version must be 1.',
      'manifest.json'
    )
  }
  const id = typeof value.id === 'string' && isSafeContributionId(value.id) ? value.id : undefined
  if (!id) diagnostic(diagnostics, 'manifest.id-invalid', 'Package ID is invalid.', 'manifest.json')
  const version =
    typeof value.version === 'string' && SEMVER.test(value.version) ? value.version : undefined
  if (!version) {
    diagnostic(
      diagnostics,
      'manifest.version-invalid',
      'Package version must be SemVer.',
      'manifest.json'
    )
  }
  const exportedWithAppVersion =
    typeof value.exported_with_app_version === 'string' &&
    SEMVER.test(value.exported_with_app_version)
      ? value.exported_with_app_version
      : undefined
  if (!exportedWithAppVersion) {
    diagnostic(
      diagnostics,
      'manifest.exported-app-version-invalid',
      'exported_with_app_version must be SemVer.',
      'manifest.json'
    )
  }
  if (
    value.schema_version !== SPECIALIST_PACKAGE_SCHEMA_VERSION ||
    !id ||
    !version ||
    !exportedWithAppVersion ||
    Object.keys(value).some((key) => !allowedFields.has(key))
  ) {
    return undefined
  }
  return {
    schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
    id,
    version,
    exported_with_app_version: exportedWithAppVersion
  }
}

const parsePayload = (
  value: unknown,
  diagnostics: PackageDiagnostic[]
): SpecialistPackagePayload | undefined => {
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      'specialist.object-required',
      'Specialist payload must be a JSON object.',
      'specialist.json'
    )
    return undefined
  }
  const allowedFields = new Set([
    'name',
    'display_name',
    'description',
    'system_prompt',
    'skill_ids',
    'connector_ids'
  ])
  const identityFields = ['id', 'version'].filter((key) => key in value)
  const presentationFields = ['icon_key', 'color_key'].filter((key) => key in value)
  const capabilityFields = ['capability_mode', 'full_access', 'selected_capabilities'].filter(
    (key) => key in value
  )
  if (identityFields.length) {
    diagnostic(
      diagnostics,
      'specialist.identity-field-forbidden',
      'Specialist identity and package version belong only in manifest.json.',
      'specialist.json'
    )
  }
  if (presentationFields.length) {
    diagnostic(
      diagnostics,
      'specialist.presentation-field-forbidden',
      'icon_key and color_key are chosen in the Specialist configuration page and cannot be imported.',
      'specialist.json'
    )
  }
  if (capabilityFields.length) {
    diagnostic(
      diagnostics,
      'specialist.capability-field-forbidden',
      'Capabilities are chosen in the Specialist configuration page and cannot be imported.',
      'specialist.json'
    )
  }
  if ('enabled' in value) {
    diagnostic(
      diagnostics,
      'specialist.enabled-field-forbidden',
      'Imported Specialists remain disabled until setup is saved; packages cannot control this state.',
      'specialist.json'
    )
  }
  const knownForbidden = new Set([
    ...identityFields,
    ...presentationFields,
    ...capabilityFields,
    ...('enabled' in value ? ['enabled'] : [])
  ])
  if (Object.keys(value).some((key) => !allowedFields.has(key) && !knownForbidden.has(key))) {
    diagnostic(
      diagnostics,
      'specialist.field-forbidden',
      'specialist.json contains an unsupported field.',
      'specialist.json'
    )
  }

  const name = typeof value.name === 'string' && value.name.trim() ? value.name : undefined
  if (!name) {
    diagnostic(
      diagnostics,
      'specialist.name-invalid',
      'Specialist name is invalid.',
      'specialist.json'
    )
  } else if (validateSpecialistPublicName(name)) {
    diagnostic(
      diagnostics,
      'specialist.name-invalid',
      validateSpecialistPublicName(name)!,
      'specialist.json'
    )
  }
  if (value.display_name !== undefined) {
    if (
      typeof value.display_name !== 'string' ||
      validateSpecialistDisplayName(value.display_name)
    ) {
      diagnostic(
        diagnostics,
        'specialist.display-name-invalid',
        typeof value.display_name === 'string'
          ? validateSpecialistDisplayName(value.display_name)!
          : 'Specialist display name must be a string.',
        'specialist.json'
      )
    }
  }
  const description = typeof value.description === 'string' ? value.description : undefined
  if (
    description === undefined ||
    !description.trim() ||
    validateSpecialistDescription(description)
  ) {
    diagnostic(
      diagnostics,
      'specialist.description-invalid',
      description === undefined
        ? 'Specialist description must be a string.'
        : !description.trim()
          ? 'Specialist description must be non-empty.'
          : validateSpecialistDescription(description)!,
      'specialist.json'
    )
  }
  const systemPrompt = typeof value.system_prompt === 'string' ? value.system_prompt : undefined
  if (
    systemPrompt === undefined ||
    !systemPrompt.trim() ||
    validateSpecialistSystemPrompt(systemPrompt)
  ) {
    diagnostic(
      diagnostics,
      'specialist.system-prompt-invalid',
      systemPrompt === undefined
        ? 'Specialist system prompt must be a string.'
        : !systemPrompt.trim()
          ? 'Specialist system prompt must be non-empty.'
          : validateSpecialistSystemPrompt(systemPrompt)!,
      'specialist.json'
    )
  }
  const skillIds = parseNameList(value, 'skill_ids', 'skillIds', diagnostics)
  const connectorIds = parseNameList(value, 'connector_ids', 'connectorIds', diagnostics)
  if (
    !name ||
    description === undefined ||
    !description.trim() ||
    systemPrompt === undefined ||
    !systemPrompt.trim() ||
    skillIds === undefined ||
    connectorIds === undefined ||
    (value.display_name !== undefined &&
      (typeof value.display_name !== 'string' ||
        !!validateSpecialistDisplayName(value.display_name))) ||
    Object.keys(value).some((key) => !allowedFields.has(key)) ||
    !!validateSpecialistDescription(description) ||
    !!validateSpecialistSystemPrompt(systemPrompt)
  ) {
    return undefined
  }
  return {
    name,
    ...(typeof value.display_name === 'string' ? { displayName: value.display_name } : {}),
    description,
    systemPrompt,
    skillIds,
    connectorIds
  }
}

type SpecialistContentHashInput = SpecialistPackagePayload & {
  capabilityMode?: 'full' | 'selected'
  fullAccess?: {
    excludedSkillIds: readonly string[]
    excludedConnectorIds: readonly string[]
    connectorTools: readonly unknown[]
  }
  selectedCapabilities?: {
    skillIds: readonly string[]
    connectorIds: readonly string[]
    connectorTools: readonly unknown[]
  }
}

export const specialistPayloadContentHash = (payload: SpecialistContentHashInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        name: payload.name,
        displayName: payload.displayName ?? payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt,
        ...(payload.skillIds === undefined
          ? {}
          : { skillIds: [...new Set(payload.skillIds)].sort() }),
        ...(payload.connectorIds === undefined
          ? {}
          : { connectorIds: [...new Set(payload.connectorIds)].sort() }),
        ...(payload.capabilityMode === undefined
          ? {}
          : {
              capabilityMode: payload.capabilityMode,
              fullAccess: payload.fullAccess,
              selectedCapabilities: payload.selectedCapabilities
            })
      })
    )
    .digest('hex')

export const specialistLegacyPayloadContentHash = (payload: SpecialistPackagePayload): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        name: payload.name,
        displayName: payload.displayName ?? payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt
      })
    )
    .digest('hex')

export const specialistContentModifiedSinceImport = (
  specialist: SpecialistContentHashInput & {
    importBaseline: { contentDigest: string; packageContentDigest?: string }
  }
): boolean =>
  specialist.importBaseline.contentDigest !==
  (specialist.importBaseline.packageContentDigest === undefined
    ? specialistLegacyPayloadContentHash(specialist)
    : specialistPayloadContentHash(specialist))

const filesContentHash = (files: readonly SpecialistPackageFile[]): string => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

const planBundledSkills = (
  packageFiles: readonly SpecialistPackageFile[],
  catalog: SpecialistPackageCatalogSnapshot,
  diagnostics: PackageDiagnostic[]
): SpecialistPackageSkillPlan[] => {
  const skillFiles = packageFiles.filter(
    (file) => file.path === 'skills' || file.path.startsWith('skills/')
  )
  const roots = new Set<string>()
  for (const file of skillFiles) {
    const segments = file.path.split('/')
    if (segments.length < 3 || !segments[1]) {
      warning(
        diagnostics,
        'skill.path-noncanonical',
        'Bundled Skill files must use skills/<skill-name>/<file>.',
        file.path
      )
      continue
    }
    roots.add(segments[1])
  }

  const plans: SpecialistPackageSkillPlan[] = []
  for (const id of [...roots].sort()) {
    const root = `skills/${id}`
    if (!isSafeSkillName(id)) {
      warning(
        diagnostics,
        'skill.id-invalid',
        'Bundled Skill directory names must be safe canonical Skill names.',
        root,
        id
      )
      continue
    }
    const prefix = `${root}/`
    const files = packageFiles
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }))
      .sort((left, right) => {
        if (left.path === 'SKILL.md') return -1
        if (right.path === 'SKILL.md') return 1
        return left.path.localeCompare(right.path)
      })
    const document = files.find((file) => file.path === 'SKILL.md')
    if (!document) {
      warning(
        diagnostics,
        'skill.document-missing',
        'A bundled Skill must contain SKILL.md.',
        root,
        id
      )
      continue
    }
    let skillDocument: ReturnType<typeof parseSkillDocument> | undefined
    try {
      skillDocument = parseSkillDocument(decoder.decode(document.bytes))
    } catch {
      warning(
        diagnostics,
        'skill.document-invalid',
        'SKILL.md must contain valid UTF-8 text.',
        `${root}/SKILL.md`,
        id
      )
      continue
    }
    if (skillDocument.name?.trim() !== id) {
      warning(
        diagnostics,
        'skill.name-mismatch',
        'SKILL.md frontmatter name must exactly match its directory Skill name.',
        `${root}/SKILL.md`,
        id
      )
      continue
    }
    const declaredVersion = skillDocument.metadata.version?.trim()
    if (declaredVersion !== undefined && !SEMVER.test(declaredVersion)) {
      warning(
        diagnostics,
        'skill.version-invalid',
        'SKILL.md frontmatter version must be SemVer when present.',
        `${root}/SKILL.md`,
        id
      )
      continue
    }
    if (files.some((file) => file.path.startsWith('scripts/'))) {
      warning(
        diagnostics,
        'skill.executable-content-present',
        'This Skill contains scripts. Preview and validation do not execute them.',
        root,
        id
      )
    }
    const version = declaredVersion ?? DEFAULT_BUNDLED_SKILL_VERSION
    const contentHash = filesContentHash(files)
    const existing = catalog.skills.find((skill) => (skill.name ?? skill.id) === id)
    let disposition: SpecialistPackageSkillPlan['disposition'] = 'install'
    let reason: string | undefined
    if (existing) {
      const existingVersion = existing.version ?? DEFAULT_BUNDLED_SKILL_VERSION
      if (existing.builtin) {
        disposition = 'reuse-builtin'
        reason = 'The local builtin Skill is read-only and will be reused.'
      } else if (existingVersion !== version || existing.contentHash !== contentHash) {
        disposition = 'conflict'
        reason = 'The installed Skill version or normalized content differs.'
        warning(diagnostics, 'skill.existing-conflict', reason, root, id)
      } else if (existing.standalone !== false && !existing.ownerIds?.length) {
        disposition = 'reuse-standalone'
        reason = 'An identical standalone Skill is already installed.'
      } else {
        disposition = 'reuse-owned'
        reason = 'An identical Specialist-owned Skill is already installed.'
      }
    }
    plans.push({
      id,
      localId: existing?.id ?? `personal-${id}`,
      version,
      disposition,
      files: files.map((file) => file.path),
      ...(reason ? { reason } : {}),
      ...(disposition === 'conflict'
        ? {
            conflict: {
              localId: existing!.id,
              installedVersion: existing!.version ?? DEFAULT_BUNDLED_SKILL_VERSION,
              installedContentHash: existing!.contentHash ?? '',
              mainEnabled: existing!.mainEnabled ?? false,
              specialists: (existing!.specialistIds ?? []).map((specialistId) => ({
                id: specialistId,
                name:
                  catalog.specialists?.find((specialist) => specialist.id === specialistId)?.name ??
                  specialistId
              }))
            }
          }
        : {}),
      contentHash,
      filesToInstall: files
    })
  }
  return plans
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  if (ArrayBuffer.isView(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export const validateSpecialistPackage = (
  files: readonly SpecialistPackageFile[],
  catalog: SpecialistPackageCatalogSnapshot,
  source: SpecialistPackageSource
): SpecialistPackageValidationResult => {
  const diagnostics: PackageDiagnostic[] = []
  const isNoise = (path: string): boolean =>
    path === '.DS_Store' ||
    path.endsWith('/.DS_Store') ||
    path === 'Thumbs.db' ||
    path.startsWith('__MACOSX/')
  const packageFiles = files.filter((file) => !isNoise(file.path))
  for (const file of files.filter((candidate) => isNoise(candidate.path))) {
    diagnostics.push({
      severity: 'info',
      code: 'package.metadata-noise-ignored',
      message: 'Known archive metadata was ignored.',
      path: file.path
    })
  }
  for (const file of packageFiles) {
    if (
      /(?:^|\/)(?:scripts?\/|[^/]+\.(?:sh|bash|zsh|fish|ps1|bat|cmd|exe|com|msi|app|dll|so|dylib|py|pl|rb|js|mjs|cjs))$/i.test(
        file.path
      )
    ) {
      warning(
        diagnostics,
        'package.executable-content-present',
        'The package contains script or executable content; preview never executes it.',
        file.path
      )
    }
  }
  const manifestFile = packageFiles.find((file) => file.path === 'manifest.json')
  const specialistFile = packageFiles.find((file) => file.path === 'specialist.json')
  if (!manifestFile) {
    diagnostic(
      diagnostics,
      'package.required-file-missing',
      'The package must contain manifest.json.',
      'manifest.json'
    )
  }
  if (!specialistFile) {
    diagnostic(
      diagnostics,
      'package.required-file-missing',
      'The package must contain specialist.json.',
      'specialist.json'
    )
  }
  const manifest = manifestFile
    ? parseManifest(parseJson(manifestFile, diagnostics), diagnostics)
    : undefined
  const payload = specialistFile
    ? parsePayload(parseJson(specialistFile, diagnostics), diagnostics)
    : undefined

  if (
    payload &&
    (catalog.protectedSpecialistNames ?? []).some(
      (name) => name.trim().toLowerCase() === payload.name.trim().toLowerCase()
    )
  ) {
    diagnostic(
      diagnostics,
      'specialist.name-protected',
      'The Specialist name is reserved and cannot be contributed.',
      'specialist.json',
      payload.name
    )
  }
  if (
    manifest &&
    payload &&
    (catalog.specialists ?? []).some(
      (specialist) =>
        specialist.id !== manifest.id &&
        specialist.name.trim().toLowerCase() === payload.name.trim().toLowerCase()
    )
  ) {
    diagnostic(
      diagnostics,
      'specialist.name-duplicate',
      'The Specialist name is already in use.',
      'specialist.json',
      payload.name
    )
  }
  if (manifest && catalog.protectedSpecialistIds.includes(manifest.id)) {
    diagnostic(
      diagnostics,
      'specialist.id-protected',
      'The Specialist ID is reserved and cannot be contributed.',
      'manifest.json',
      manifest.id
    )
  }
  if (
    source === 'builtin' &&
    packageFiles.some((file) => file.path === 'skills' || file.path.startsWith('skills/'))
  ) {
    diagnostic(
      diagnostics,
      'builtin.bundled-skills-forbidden',
      'Builtin Specialist packages cannot bundle Skills.',
      'skills'
    )
  }

  const skillPlans = planBundledSkills(packageFiles, catalog, diagnostics)
  const bundledSkillIds = skillPlans.map((skill) => skill.id)
  const bundledSkillLocalIdByName = new Map(
    skillPlans.map((skill) => [skill.id, skill.localId ?? skill.id] as const)
  )
  const skillIdByName = new Map(
    catalog.skills.map((skill) => [skill.name ?? skill.id, skill.id] as const)
  )
  const catalogSkillIds = new Set(catalog.skills.map((skill) => skill.id))
  const declaredSkillIds = [...new Set(payload?.skillIds ?? [])]
  const skillIds = [
    ...new Set(
      [...declaredSkillIds, ...bundledSkillIds].flatMap((name) => {
        const localId = skillIdByName.get(name) ?? (catalogSkillIds.has(name) ? name : undefined)
        const bundledLocalId = bundledSkillLocalIdByName.get(name)
        if (localId || bundledLocalId) return [localId ?? bundledLocalId!]
        warning(
          diagnostics,
          'specialist.skill-unavailable',
          'The referenced Skill is not available on this installation and was ignored.',
          'specialist.json',
          name
        )
        return []
      })
    )
  ]
  const connectorIdByName = new Map<string, string>()
  for (const id of catalog.connectorIds) {
    // Accept legacy/local package references without changing the portable export contract. Custom
    // Connector UUIDs remain local IDs after validation; current packages still export `name`.
    connectorIdByName.set(id, id)
    connectorIdByName.set(catalog.connectorAliases?.[id] ?? id, id)
  }
  for (const [legacyAlias, localId] of Object.entries(catalog.connectorAliases ?? {})) {
    if (catalog.connectorIds.includes(localId)) connectorIdByName.set(legacyAlias, localId)
  }
  const connectorIds = [
    ...new Set(
      [...new Set(payload?.connectorIds ?? [])].flatMap((name) => {
        const id = connectorIdByName.get(name)
        if (id) return [id]
        warning(
          diagnostics,
          'specialist.connector-unavailable',
          'The referenced Connector is not available on this installation and was ignored.',
          'specialist.json',
          name
        )
        return []
      })
    )
  ]
  const builtinSkillIds = skillIds.filter((id) =>
    catalog.skills.some((skill) => skill.id === id && skill.builtin)
  )
  const summary =
    manifest && payload
      ? {
          id: manifest.id,
          version: manifest.version,
          name: payload.name,
          description: payload.description,
          source,
          bundledSkillIds,
          requiredSkillIds: skillIds,
          builtinSkillIds,
          connectorIds,
          skills: skillPlans.map((skill) => ({
            id: skill.id,
            version: skill.version,
            disposition: skill.disposition,
            files: skill.files,
            ...(skill.reason ? { reason: skill.reason } : {}),
            ...(skill.conflict ? { conflict: skill.conflict } : {})
          }))
        }
      : undefined
  if (diagnostics.some((item) => item.severity === 'error') || !manifest || !payload) {
    return { preview: { ...(summary ? { summary } : {}), diagnostics, installable: false } }
  }
  const plan: SpecialistPackageValidationPlan = {
    specialistId: manifest.id,
    packageVersion: manifest.version,
    source,
    contentHash: createHash('sha256')
      .update(
        JSON.stringify({
          payloadDigest: specialistPayloadContentHash({ ...payload, skillIds, connectorIds }),
          skills: skillPlans.map(({ id, version, contentHash }) => ({ id, version, contentHash }))
        })
      )
      .digest('hex'),
    manifest,
    payload,
    skillIds,
    connectorIds,
    skills: skillPlans
  }
  deepFreeze(plan)
  return {
    preview: {
      summary,
      diagnostics,
      installable: !skillPlans.some((skill) => skill.disposition === 'conflict')
    },
    plan
  }
}
