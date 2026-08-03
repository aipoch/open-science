import { createHash, randomUUID } from 'node:crypto'
import { strToU8 } from 'fflate'

import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  specialistPackageReportFromPreview,
  type SpecialistPackageReport,
  type SpecialistPackageCandidatePreview,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistDeletePreview,
  type SpecialistDeleteRequest,
  type SpecialistDeleteResult,
  type SpecialistPackageInstallRequest,
  type SpecialistPackageInstallResult,
  type SpecialistExportPreview,
  type SpecialistExportRequest,
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type SpecialistPackageValidationPlan
} from '../../../shared/specialist-package'
import { parseSkillDocument } from '../../../shared/skill-frontmatter'
import { createLogger } from '../../logger'
import type { StoredSpecialist } from '../types'
import { SpecialistRepository } from '../repository'
import { validateSpecialistZip } from './zip-adapter'
import { compareSemver } from './semver'
import { buildDeterministicSpecialistZip } from './contribution-template'
import { specialistPayloadContentHash } from './validator'
import {
  SpecialistPackageRecoveryError,
  SpecialistPackageRevisionConflictError,
  SpecialistPackageRollbackError,
  SpecialistPackageTransaction
} from './transaction'
import type { SpecialistPackageSkillPort } from './skill-port'

const CANDIDATE_TTL_MS = 10 * 60 * 1000
const log = createLogger('specialist.package.service')

type Candidate = {
  plan?: Readonly<SpecialistPackageValidationPlan>
  expiresAt: number
  archiveDigest: string
  installable: boolean
  archiveBytes: Uint8Array
  overwrite?: { id: string; expectedRevision: number }
  report: SpecialistPackageReport
}

type SpecialistPackageServiceOptions = {
  storageDir: string
  repository: SpecialistRepository
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  readPackageGuide?: () => Promise<string>
  token?: () => string
  now?: () => Date
  onCommitted?: () => void
  skillPort?: SpecialistPackageSkillPort
}

const inferredAppRange = (version: string): string => {
  const major = Number(version.split('.')[0] ?? 0)
  return `>=${version} <${major + 1}.0.0`
}

export const specialistExportFileName = (
  displayName: string,
  version: string,
  fallbackId: string
): string => {
  const slug = (displayName || fallbackId)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  const identity = slug || fallbackId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `open-science-specialist-${identity || 'export'}-v${version}.zip`
}

const normalizeExportedSkillDocument = (
  bytes: Uint8Array,
  id: string,
  version: string
): Uint8Array => {
  const document = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!document.hasFrontmatter) throw new Error(`Skill ${id} has no frontmatter.`)
  const metadata = Object.entries(document.metadata)
    .filter(([key]) => key !== 'version')
    .sort(([left], [right]) => left.localeCompare(right))
  const fields = [
    `name: ${JSON.stringify(id)}`,
    ...(document.description === undefined
      ? []
      : [`description: ${JSON.stringify(document.description)}`]),
    `version: ${JSON.stringify(version)}`,
    ...metadata.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  ]
  return strToU8(`---\n${fields.join('\n')}\n---\n${document.body}`)
}

const referencedSkillIds = (
  specialist: StoredSpecialist,
  catalogSkillIds: readonly string[]
): readonly string[] =>
  specialist.capabilityMode === 'selected'
    ? specialist.selectedCapabilities.skillIds
    : catalogSkillIds.filter((id) => !specialist.fullAccess.excludedSkillIds.includes(id))

export class SpecialistSkillDeletionProtectedError extends Error {
  readonly code = 'protected-skill' as const

  constructor(
    readonly skillId: string,
    readonly specialistIds: readonly string[],
    readonly reason: 'builtin' | 'owned' | 'referenced'
  ) {
    super(
      reason === 'builtin'
        ? `Builtin Skill ${skillId} cannot be deleted.`
        : `Skill ${skillId} is still ${reason} by ${specialistIds.join(', ')}.`
    )
    this.name = 'SpecialistSkillDeletionProtectedError'
  }
}

export class SpecialistPackageService {
  private readonly candidates = new Map<string, Candidate>()
  private readonly deletePreviews = new Map<string, SpecialistDeletePreview>()
  private readonly transaction: SpecialistPackageTransaction
  private readonly token: () => string
  private readonly now: () => Date

  constructor(private readonly options: SpecialistPackageServiceOptions) {
    this.transaction = new SpecialistPackageTransaction(
      options.storageDir,
      options.repository,
      randomUUID,
      options.skillPort
    )
    this.token = options.token ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  private async validationCatalog(): Promise<SpecialistPackageCatalogSnapshot> {
    const [catalog, document] = await Promise.all([
      this.options.catalog(),
      this.options.repository.getAll()
    ])
    return {
      ...catalog,
      specialists: document.specialists.map(({ id, name }) => ({ id, name }))
    }
  }

  async previewSpecialistDelete(request: { id: string }): Promise<SpecialistDeletePreview> {
    if (!request || typeof request.id !== 'string' || !request.id.trim()) {
      throw new Error('Specialist id must be a non-empty string.')
    }
    const [document, catalog] = await Promise.all([
      this.options.repository.getAll(),
      this.options.catalog()
    ])
    if (catalog.protectedSpecialistIds.includes(request.id)) {
      throw new Error(`Specialist ${request.id} is read-only.`)
    }
    const specialist = document.specialists.find((candidate) => candidate.id === request.id)
    if (!specialist) throw new Error(`Specialist ${request.id} not found.`)
    const catalogSkillIds = catalog.skills.map((skill) => skill.id)
    const associated = new Set([
      ...specialist.ownedSkillIds,
      ...referencedSkillIds(specialist, catalogSkillIds)
    ])
    const skills = catalog.skills
      .filter((skill) => associated.has(skill.id))
      .map((skill) => {
        const otherOwners = [...(skill.ownerIds ?? [])].filter((id) => id !== specialist.id).sort()
        const otherReferences = document.specialists
          .filter(
            (candidate) =>
              candidate.id !== specialist.id &&
              referencedSkillIds(candidate, catalogSkillIds).includes(skill.id)
          )
          .map((candidate) => candidate.id)
          .sort()
        const reasons: Array<SpecialistDeletePreview['skills'][number]['reasons'][number]> = []
        if (skill.builtin) reasons.push({ code: 'builtin', specialistIds: [] })
        else {
          if (skill.standalone) reasons.push({ code: 'standalone', specialistIds: [] })
          if (otherOwners.length > 0) {
            reasons.push({ code: 'shared-owner', specialistIds: otherOwners })
          }
          if (otherReferences.length > 0) {
            reasons.push({ code: 'referenced', specialistIds: otherReferences })
          }
        }
        const deletable = specialist.ownedSkillIds.includes(skill.id) && reasons.length === 0
        return {
          id: skill.id,
          kind: deletable ? ('owned-exclusive' as const) : (reasons[0]?.code ?? 'referenced'),
          deletable,
          reasons
        }
      })
      .sort((left, right) => left.id.localeCompare(right.id))
    const preview = {
      specialistId: specialist.id,
      specialistName: specialist.displayName ?? specialist.name,
      expectedRevision: specialist.revision,
      skills
    }
    this.deletePreviews.set(specialist.id, preview)
    return preview
  }

  async assertSkillDeletionAllowed(skillId: string): Promise<void> {
    if (typeof skillId !== 'string' || !skillId.trim()) {
      throw new Error('Skill id must be a non-empty string.')
    }
    const [document, catalog] = await Promise.all([
      this.options.repository.getAll(),
      this.options.catalog()
    ])
    const skill = catalog.skills.find((candidate) => candidate.id === skillId)
    if (!skill) return
    if (skill.builtin) throw new SpecialistSkillDeletionProtectedError(skillId, [], 'builtin')
    const owners = [...(skill.ownerIds ?? [])].sort()
    if (owners.length > 0) {
      throw new SpecialistSkillDeletionProtectedError(skillId, owners, 'owned')
    }
    const catalogSkillIds = catalog.skills.map((candidate) => candidate.id)
    const references = document.specialists
      .filter((specialist) => referencedSkillIds(specialist, catalogSkillIds).includes(skillId))
      .map((specialist) => specialist.id)
      .sort()
    if (references.length > 0) {
      throw new SpecialistSkillDeletionProtectedError(skillId, references, 'referenced')
    }
  }

  async deleteSpecialist(request: SpecialistDeleteRequest): Promise<SpecialistDeleteResult> {
    if (
      !request ||
      typeof request.id !== 'string' ||
      !request.id.trim() ||
      !Number.isInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      !Array.isArray(request.deleteSkillIds) ||
      request.deleteSkillIds.some((id) => typeof id !== 'string')
    ) {
      return { status: 'failed', code: 'protected-skill' }
    }
    const previewed = this.deletePreviews.get(request.id)
    let live: SpecialistDeletePreview
    try {
      live = await this.previewSpecialistDelete({ id: request.id })
    } catch {
      return { status: 'failed', code: 'protected-target' }
    }
    if (live.expectedRevision !== request.expectedRevision) {
      return { status: 'failed', code: 'revision-conflict' }
    }
    const selected = [...new Set(request.deleteSkillIds)]
    const liveDeletable = new Set(
      live.skills.filter((skill) => skill.deletable).map((skill) => skill.id)
    )
    const previewedDeletable = new Set(
      previewed?.skills.filter((skill) => skill.deletable).map((skill) => skill.id) ?? []
    )
    const protectedSelection = selected.find((id) => !liveDeletable.has(id))
    if (protectedSelection) {
      return {
        status: 'failed',
        code: previewedDeletable.has(protectedSelection) ? 'stale-preview' : 'protected-skill'
      }
    }
    this.deletePreviews.delete(request.id)
    try {
      await this.transaction.deleteSpecialist(request.id, request.expectedRevision, selected)
    } catch (error) {
      return {
        status: 'failed',
        code:
          error instanceof SpecialistPackageRecoveryError
            ? 'recovery-failed'
            : error instanceof SpecialistPackageRevisionConflictError
              ? 'revision-conflict'
              : error instanceof SpecialistPackageRollbackError
                ? 'rollback-failed'
                : 'commit-failed'
      }
    }
    try {
      this.options.onCommitted?.()
    } catch {
      log.warn('post-delete Specialist catalog refresh failed', {
        code: 'package-delete-refresh-failed',
        specialistId: request.id
      })
    }
    return { status: 'deleted' }
  }

  async preview(archiveBytes: Uint8Array): Promise<SpecialistPackageCandidatePreview> {
    // One renderer window owns one active preview. Selecting another archive invalidates the prior
    // capability immediately so stale confirmation buttons cannot replay it.
    this.candidates.clear()
    const catalog = await this.validationCatalog()
    const result = validateSpecialistZip(archiveBytes, catalog)
    const token = this.token()
    const diagnostics = [...result.preview.diagnostics]
    let overwrite: SpecialistPackageCandidatePreview['overwrite']
    const installable = result.preview.installable
    let overwriteTarget: Candidate['overwrite']
    if (result.plan) {
      const existing = (await this.options.repository.getAll()).specialists.find(
        (specialist) => specialist.id === result.plan?.specialistId
      )
      if (existing) {
        overwrite = {
          id: existing.id,
          target: 'custom',
          currentVersion: existing.packageVersion,
          incomingVersion: result.plan.packageVersion,
          modifiedSinceImport:
            existing.origin === 'imported' &&
            existing.importBaseline !== undefined &&
            existing.importBaseline.contentDigest !== specialistPayloadContentHash(existing),
          hasImportBaseline: existing.origin === 'imported' && existing.importBaseline !== undefined
        }
        overwriteTarget = { id: existing.id, expectedRevision: existing.revision }
        const versionOrder = compareSemver(result.plan.packageVersion, existing.packageVersion)
        if (versionOrder === 0)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-same-version',
            message: 'The incoming package has the same version as the installed Specialist.',
            relatedId: existing.id
          })
        if (versionOrder !== undefined && versionOrder < 0)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-downgrade',
            message: 'The incoming package version is lower than the installed version.',
            relatedId: existing.id
          })
        if (overwrite.modifiedSinceImport)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-local-modifications',
            message: 'Local edits differ from the imported baseline and will be replaced.',
            relatedId: existing.id
          })
        if (
          versionOrder === 0 &&
          existing.importBaseline &&
          existing.importBaseline.contentDigest !== result.plan.contentHash
        )
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-content-without-version-bump',
            message: 'Package content changed without increasing its version.',
            relatedId: existing.id
          })
      }
    }
    this.candidates.set(token, {
      plan: result.plan,
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      archiveDigest: createHash('sha256').update(archiveBytes).digest('hex'),
      installable,
      archiveBytes: Uint8Array.from(archiveBytes),
      ...(overwriteTarget ? { overwrite: overwriteTarget } : {}),
      report: specialistPackageReportFromPreview({ ...result.preview, diagnostics, installable })
    })
    return {
      candidateToken: token,
      ...result.preview,
      diagnostics,
      installable,
      ...(overwrite ? { overwrite } : {})
    }
  }

  async previewExport(specialistId: string): Promise<SpecialistExportPreview> {
    const [document, catalog] = await Promise.all([
      this.options.repository.getAll(),
      this.options.catalog()
    ])
    if (catalog.protectedSpecialistIds.includes(specialistId)) {
      throw new Error('Protected Specialists cannot be exported.')
    }
    const specialist = document.specialists.find((candidate) => candidate.id === specialistId)
    if (!specialist) throw new Error('Custom Specialist not found.')

    const requestedSkillIds =
      specialist.capabilityMode === 'selected'
        ? specialist.selectedCapabilities.skillIds
        : catalog.skills
            .filter((skill) => !specialist.fullAccess.excludedSkillIds.includes(skill.id))
            .map((skill) => skill.id)
    const skills = [...new Set(requestedSkillIds)]
      .map((id) => {
        const builtin = catalog.builtinSkills.find((candidate) => candidate.id === id)
        if (builtin) {
          return {
            id,
            version: builtin.appVersion,
            kind: 'builtin' as const,
            selected: true,
            selectable: false
          }
        }
        const skill = catalog.skills.find((candidate) => candidate.id === id)
        return {
          id,
          version: skill?.version ?? '0.1.0',
          kind: specialist.ownedSkillIds.includes(id)
            ? ('owned' as const)
            : ('referenced' as const),
          selected: specialist.ownedSkillIds.includes(id),
          selectable: true
        }
      })
      .sort((left, right) => left.id.localeCompare(right.id))
    const diagnostics: Array<{
      severity: 'error' | 'warning' | 'info'
      code: string
      message: string
    }> = []
    if (skills.some((skill) => skill.kind === 'referenced')) {
      diagnostics.push({
        severity: 'info',
        code: 'specialist.export-unbundled-skills',
        message: 'Unchecked Skills are omitted. Capabilities are selected locally after import.'
      })
    }
    if (
      specialist.origin === 'imported' &&
      specialist.importBaseline &&
      (specialist.importBaseline.packageVersion === undefined ||
        specialist.importBaseline.packageVersion === specialist.packageVersion) &&
      specialist.importBaseline.contentDigest !== specialistPayloadContentHash(specialist)
    ) {
      diagnostics.push({
        severity: 'warning',
        code: 'specialist.export-version-unchanged',
        message: `Content changed but the package version remains ${specialist.packageVersion}.`
      })
    }
    const includedSkillIds = skills
      .filter((skill) => skill.kind === 'owned')
      .map((skill) => skill.id)
    try {
      await this.export({
        specialistId: specialist.id,
        expectedRevision: specialist.revision,
        includedSkillIds
      })
    } catch {
      diagnostics.push({
        severity: 'error',
        code: 'specialist.export-validation-failed',
        message: 'The current Specialist or selected Skills contain blocking validation errors.'
      })
    }

    return {
      specialistId: specialist.id,
      name: specialist.displayName ?? specialist.name,
      version: specialist.packageVersion,
      fileName: specialistExportFileName(
        specialist.displayName ?? specialist.name,
        specialist.packageVersion,
        specialist.id
      ),
      expectedRevision: specialist.revision,
      skills,
      diagnostics,
      canExport: !diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    }
  }

  async export(request: SpecialistExportRequest): Promise<{
    fileName: string
    archiveBytes: Uint8Array
  }> {
    if (
      !request ||
      typeof request.specialistId !== 'string' ||
      !Number.isInteger(request.expectedRevision) ||
      !Array.isArray(request.includedSkillIds) ||
      request.includedSkillIds.some((id) => typeof id !== 'string') ||
      new Set(request.includedSkillIds).size !== request.includedSkillIds.length
    ) {
      throw new Error('Invalid Specialist export request.')
    }
    const [before, catalog] = await Promise.all([
      this.options.repository.getAll(),
      this.options.catalog()
    ])
    if (catalog.protectedSpecialistIds.includes(request.specialistId)) {
      throw new Error('Protected Specialists cannot be exported.')
    }
    const specialist = before.specialists.find((candidate) => candidate.id === request.specialistId)
    if (!specialist) throw new Error('Custom Specialist not found.')
    if (specialist.revision !== request.expectedRevision) {
      throw new Error('Specialist changed during export. Preview again and retry.')
    }

    const requestedSkillIds =
      specialist.capabilityMode === 'selected'
        ? specialist.selectedCapabilities.skillIds
        : catalog.skills
            .filter((skill) => !specialist.fullAccess.excludedSkillIds.includes(skill.id))
            .map((skill) => skill.id)
    const builtinIds = new Set(catalog.builtinSkills.map((skill) => skill.id))
    const portable = [...new Set(requestedSkillIds)]
      .filter((id) => !builtinIds.has(id))
      .map((id) => {
        const skill = catalog.skills.find((candidate) => candidate.id === id)
        return { id, version: skill?.version ?? '0.1.0' }
      })
      .sort((left, right) => left.id.localeCompare(right.id))
    if (request.includedSkillIds.some((id) => !portable.some((skill) => skill.id === id))) {
      throw new Error('Export selection contains a Skill the Specialist does not reference.')
    }
    if (!this.options.skillPort?.exportSnapshot && request.includedSkillIds.length > 0) {
      throw new Error('Skill export snapshot is unavailable.')
    }
    const skillSnapshots = request.includedSkillIds.length
      ? await this.options.skillPort!.exportSnapshot!(request.includedSkillIds)
      : []
    if (
      skillSnapshots.length !== request.includedSkillIds.length ||
      request.includedSkillIds.some((id) => !skillSnapshots.some((skill) => skill.id === id))
    ) {
      throw new Error('A selected Skill changed during export. Preview again and retry.')
    }

    const after = await this.options.repository.getAll()
    const live = after.specialists.find((candidate) => candidate.id === request.specialistId)
    if (!live || JSON.stringify(live) !== JSON.stringify(specialist)) {
      throw new Error('Specialist changed during export. Preview again and retry.')
    }
    const currentCatalog = await this.options.catalog()
    if (JSON.stringify(currentCatalog) !== JSON.stringify(catalog)) {
      throw new Error('The Skill catalog changed during export. Preview again and retry.')
    }

    const manifest = {
      schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
      id: specialist.id,
      version: specialist.packageVersion,
      exported_with_app_version: catalog.appVersion,
      requires_app: inferredAppRange(catalog.appVersion)
    }
    const payload = {
      name: specialist.name,
      ...(specialist.displayName ? { displayName: specialist.displayName } : {}),
      description: specialist.description,
      systemPrompt: specialist.systemPrompt
    }
    const readme = this.options.readPackageGuide
      ? await this.options.readPackageGuide()
      : 'Open Science Specialist import guide.\n'
    const files: Record<string, Uint8Array> = {
      'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      'specialist.json': strToU8(`${JSON.stringify(payload, null, 2)}\n`),
      'README.txt': strToU8(readme)
    }
    for (const skill of skillSnapshots) {
      for (const file of skill.files) {
        files[`skills/${skill.id}/${file.path}`] =
          file.path === 'SKILL.md'
            ? normalizeExportedSkillDocument(file.bytes, skill.id, skill.version)
            : file.bytes
      }
    }
    const archiveBytes = buildDeterministicSpecialistZip(files)
    const validationCatalog = {
      ...catalog,
      skills: catalog.skills.filter((skill) => !request.includedSkillIds.includes(skill.id))
    }
    const validation = validateSpecialistZip(archiveBytes, validationCatalog)
    if (!validation.preview.installable) {
      throw new Error('Specialist export has blocking validation errors.')
    }
    return {
      fileName: specialistExportFileName(
        specialist.displayName ?? specialist.name,
        specialist.packageVersion,
        specialist.id
      ),
      archiveBytes
    }
  }

  async previewOversizedArchive(
    compressedBytes: number
  ): Promise<SpecialistPackageCandidatePreview> {
    this.candidates.clear()
    const token = this.token()
    const preview = {
      diagnostics: [
        {
          severity: 'error' as const,
          code: 'package.archive-compressed-size-exceeded',
          message: 'The compressed archive exceeds the safe preview limit.',
          actual: compressedBytes,
          limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes,
          unit: 'bytes' as const
        }
      ],
      installable: false,
      archive: {
        compressedBytes,
        limits: SPECIALIST_PACKAGE_ARCHIVE_LIMITS
      }
    }
    this.candidates.set(token, {
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      archiveDigest: '',
      installable: false,
      archiveBytes: new Uint8Array(),
      report: specialistPackageReportFromPreview(preview)
    })
    return { candidateToken: token, ...preview }
  }

  report(candidateToken: unknown): SpecialistPackageReport | undefined {
    if (typeof candidateToken !== 'string') return undefined
    return this.candidates.get(candidateToken)?.report
  }

  async install(request: SpecialistPackageInstallRequest): Promise<SpecialistPackageInstallResult> {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some((key) => !['candidateToken', 'confirmOverwrite'].includes(key)) ||
      typeof request.candidateToken !== 'string' ||
      !request.candidateToken ||
      (request.confirmOverwrite !== undefined && request.confirmOverwrite !== true)
    ) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    const candidate = this.candidates.get(request.candidateToken)
    if (!candidate) return { status: 'failed', code: 'stale-candidate' }
    if (candidate.expiresAt <= this.now().getTime()) {
      this.candidates.delete(request.candidateToken)
      return { status: 'failed', code: 'candidate-expired' }
    }
    if (!candidate.installable || !candidate.plan) {
      return { status: 'failed', code: 'candidate-not-installable' }
    }
    if (candidate.overwrite && request.confirmOverwrite !== true) {
      return { status: 'failed', code: 'overwrite-confirmation-required' }
    }
    this.candidates.delete(request.candidateToken)
    let specialist: Extract<SpecialistPackageInstallResult, { status: 'installed' }>['specialist']
    try {
      const catalog = await this.validationCatalog()
      const liveValidation = validateSpecialistZip(candidate.archiveBytes, catalog)
      if (catalog.protectedSpecialistIds.includes(candidate.plan.specialistId)) {
        return { status: 'failed', code: 'protected-target' }
      }
      if (!liveValidation.preview.installable || !liveValidation.plan)
        return { status: 'failed', code: 'candidate-not-installable' }
      specialist = await this.transaction.install(
        liveValidation.plan,
        this.now(),
        candidate.archiveDigest,
        inferredAppRange(catalog.appVersion),
        candidate.overwrite ? { expectedRevision: candidate.overwrite.expectedRevision } : undefined
      )
    } catch (error) {
      return {
        status: 'failed',
        code:
          error instanceof SpecialistPackageRecoveryError
            ? 'recovery-failed'
            : error instanceof SpecialistPackageRevisionConflictError
              ? 'revision-conflict'
              : error instanceof SpecialistPackageRollbackError
                ? 'rollback-failed'
                : 'commit-failed'
      }
    }
    try {
      this.options.onCommitted?.()
    } catch {
      log.warn('post-commit Specialist package refresh failed', {
        code: 'package-refresh-failed',
        specialistId: specialist.id
      })
    }
    return { status: 'installed', specialist }
  }

  cancel(candidateToken: unknown): void {
    if (typeof candidateToken === 'string') this.candidates.delete(candidateToken)
  }

  dispose(): void {
    this.candidates.clear()
    this.deletePreviews.clear()
  }
}
