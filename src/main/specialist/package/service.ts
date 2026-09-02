import { createHash, randomUUID } from 'node:crypto'
import { strToU8 } from 'fflate'

import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  specialistPackageReportFromPreview,
  type PackageDiagnostic,
  type SpecialistPackageReport,
  type SpecialistPackageCandidatePreview,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistDeletePreview,
  type SpecialistDeleteRequest,
  type SpecialistDeleteResult,
  type SpecialistPackageInstallRequest,
  type SpecialistPackageInstallResult,
  type SpecialistPackageSkillConflictResolution,
  type SpecialistExportPreview,
  type SpecialistExportRequest,
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type SpecialistPackageValidationPlan
} from '../../../shared/specialist-package'
import {
  validateSpecialistDescription,
  validateSpecialistSystemPrompt
} from '../../../shared/specialist'
import { parseSkillDocument } from '../../../shared/skill-frontmatter'
import { createLogger } from '../../logger'
import type { SpecialistOrigin, StoredSpecialist, StoredSpecialists } from '../types'
import { SpecialistRepository } from '../repository'
import { validateSpecialistZip } from './zip-adapter'
import { compareSemver } from './semver'
import { buildDeterministicSpecialistZip } from './contribution-template'
import {
  specialistContentModifiedSinceImport,
  specialistLegacyPayloadContentHash
} from './validator'
import {
  SpecialistPackageRecoveryError,
  SpecialistPackageRevisionConflictError,
  SpecialistPackageRollbackError,
  SpecialistPackageTransaction
} from './transaction'
import type { SpecialistPackageSkillPort, SpecialistPackageSkillSnapshot } from './skill-port'
import type { MarketplaceOperationCoordinator } from '../marketplace/operation-coordinator'

const CANDIDATE_TTL_MS = 10 * 60 * 1000
const log = createLogger('specialist.package.service')

class SpecialistDeleteSelectionError extends Error {
  constructor(readonly code: 'protected-skill' | 'stale-preview') {
    super(`Specialist Skill deletion selection is ${code}.`)
  }
}

const fallbackSkillDisplayName = (id: string): string =>
  id.replace(/^(?:personal|imported)-/, '') || id

type Candidate = {
  plan?: Readonly<SpecialistPackageValidationPlan>
  expiresAt: number
  archiveDigest: string
  archiveBytes: Uint8Array
  overwrite?: { id: string; expectedRevision: number }
  report: SpecialistPackageReport
  ownerId?: number
  origin: SpecialistOrigin
}

type SpecialistPackageServiceOptions = {
  storageDir: string
  repository: SpecialistRepository
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  token?: () => string
  now?: () => Date
  onCommitted?: () => void
  onSpecialistDeleted?: (specialistId: string) => Promise<void>
  onSkillsDeleted?: (skillIds: readonly string[]) => Promise<void>
  onResourcesDeleted?: (specialistId: string, skillIds: readonly string[]) => Promise<void>
  marketplaceOperationCoordinator?: MarketplaceOperationCoordinator
  skillPort?: SpecialistPackageSkillPort
}

const specialistExportProfileDiagnostics = (
  specialist: Pick<StoredSpecialist, 'description' | 'systemPrompt'>
): PackageDiagnostic[] => {
  const diagnostics: PackageDiagnostic[] = []
  const descriptionError = !specialist.description.trim()
    ? 'Complete the Specialist description before exporting a package.'
    : validateSpecialistDescription(specialist.description)
  if (descriptionError) {
    diagnostics.push({
      severity: 'error',
      code: 'specialist.description-invalid',
      message: descriptionError
    })
  }
  const systemPromptError = !specialist.systemPrompt.trim()
    ? 'Complete the Specialist system prompt before exporting a package.'
    : validateSpecialistSystemPrompt(specialist.systemPrompt)
  if (systemPromptError) {
    diagnostics.push({
      severity: 'error',
      code: 'specialist.system-prompt-invalid',
      message: systemPromptError
    })
  }
  return diagnostics
}

export const specialistExportFileName = (
  displayName: string,
  version: string,
  fallbackId: string
): string => {
  const fileStem = (displayName || fallbackId)
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
  const identity = fileStem || fallbackId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `open-science-specialist-${identity || 'export'}-v${version}.zip`
}

const normalizeExportedSkillDocument = (
  bytes: Uint8Array,
  id: string,
  version?: string
): Uint8Array => {
  const document = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!document.hasFrontmatter) throw new Error(`Skill ${id} has no frontmatter.`)
  const metadata = Object.entries(document.metadata)
    .filter(([key]) => key !== 'displayname' && key !== 'version')
    .sort(([left], [right]) => left.localeCompare(right))
  const fields = [
    `name: ${JSON.stringify(id)}`,
    ...(document.description === undefined
      ? []
      : [`description: ${JSON.stringify(document.description)}`]),
    ...(version === undefined ? [] : [`version: ${JSON.stringify(version)}`]),
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

const effectiveSpecialistSkillIds = (
  specialist: StoredSpecialist,
  catalog: SpecialistPackageCatalogSnapshot
): readonly string[] =>
  referencedSkillIds(
    specialist,
    catalog.skills.map((skill) => skill.id)
  )

const effectiveSpecialistConnectorIds = (
  specialist: StoredSpecialist,
  catalog: SpecialistPackageCatalogSnapshot
): readonly string[] => {
  const canonical = (id: string): string => catalog.connectorAliases?.[id] ?? id
  if (specialist.capabilityMode === 'selected') {
    return [...new Set(specialist.selectedCapabilities.connectorIds.map(canonical))]
  }

  const excluded = new Set(specialist.fullAccess.excludedConnectorIds.map(canonical))
  return [...new Set(catalog.connectorIds.map(canonical).filter((name) => !excluded.has(name)))]
}

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

class SpecialistPackageImpactConflictError extends Error {}

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
      options.skillPort,
      (specialistId, skillIds) => this.cleanupDeletedRelationships(specialistId, skillIds)
    )
    this.token = options.token ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async recover(): Promise<void> {
    await this.transaction.recover()
  }

  withRecoveryBarrier<T>(operation: () => Promise<T>): Promise<T> {
    return this.transaction.withRecoveryBarrier(operation)
  }

  private async validationCatalog(): Promise<SpecialistPackageCatalogSnapshot> {
    const [catalog, document] = await Promise.all([
      this.options.catalog(),
      this.options.repository.getAll()
    ])
    const catalogSkillIds = catalog.skills.map((skill) => skill.id)
    return {
      ...catalog,
      skills: catalog.skills.map((skill) => ({
        ...skill,
        specialistIds: document.specialists
          .filter((specialist) =>
            referencedSkillIds(specialist, catalogSkillIds).includes(skill.id)
          )
          .map((specialist) => specialist.id)
          .sort()
      })),
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
      .filter((skill) => associated.has(skill.id) && !skill.builtin)
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
        if (skill.mainEnabled) reasons.push({ code: 'main-enabled', specialistIds: [] })
        if (otherOwners.length > 0) {
          reasons.push({ code: 'shared-owner', specialistIds: otherOwners })
        }
        if (otherReferences.length > 0) {
          reasons.push({ code: 'referenced', specialistIds: otherReferences })
        }
        const deletable = reasons.length === 0
        return {
          id: skill.id,
          displayName: skill.displayName?.trim() || fallbackSkillDisplayName(skill.id),
          source: skill.source ?? 'personal',
          kind: deletable ? ('exclusive' as const) : (reasons[0]?.code ?? 'referenced'),
          deletable,
          reasons
        }
      })
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
      )
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

  private async cleanupDeletedRelationships(
    specialistId: string,
    skillIds: readonly string[]
  ): Promise<void> {
    let failure: unknown
    for (const cleanup of [
      {
        run: () => this.options.onSpecialistDeleted?.(specialistId),
        message: 'post-delete Marketplace provenance cleanup failed',
        code: 'package-delete-marketplace-provenance-cleanup-failed'
      },
      {
        run: () => this.options.onSkillsDeleted?.(skillIds),
        message: 'post-delete Skill settings cleanup failed',
        code: 'package-delete-skill-settings-cleanup-failed'
      },
      {
        run: () => this.options.onResourcesDeleted?.(specialistId, skillIds),
        message: 'post-delete Tag cleanup failed',
        code: 'package-delete-tag-cleanup-failed'
      }
    ]) {
      try {
        await cleanup.run()
      } catch (error) {
        failure ??= error
        log.warn(cleanup.message, { code: cleanup.code, specialistId, error })
      }
    }
    if (failure) throw failure
  }

  private notifyDeleteCommitted(specialistId: string): void {
    try {
      this.options.onCommitted?.()
    } catch {
      log.warn('post-delete Specialist catalog refresh failed', {
        code: 'package-delete-refresh-failed',
        specialistId
      })
    }
  }

  async deleteSpecialist(request: SpecialistDeleteRequest): Promise<SpecialistDeleteResult> {
    const operation = (): Promise<SpecialistDeleteResult> => this.deleteSpecialistExclusive(request)
    return this.options.marketplaceOperationCoordinator
      ? this.options.marketplaceOperationCoordinator.runExclusive(operation)
      : operation()
  }

  private async deleteSpecialistExclusive(
    request: SpecialistDeleteRequest
  ): Promise<SpecialistDeleteResult> {
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
    try {
      await this.transaction.deleteSpecialist(
        request.id,
        request.expectedRevision,
        selected,
        async () => {
          const locked = await this.previewSpecialistDelete({ id: request.id })
          if (locked.expectedRevision !== request.expectedRevision) {
            throw new SpecialistPackageRevisionConflictError()
          }
          const lockedDeletable = new Set(
            locked.skills.filter((skill) => skill.deletable).map((skill) => skill.id)
          )
          const lockedProtectedSelection = selected.find((id) => !lockedDeletable.has(id))
          if (lockedProtectedSelection) {
            throw new SpecialistDeleteSelectionError(
              previewedDeletable.has(lockedProtectedSelection) ? 'stale-preview' : 'protected-skill'
            )
          }
        }
      )
    } catch (error) {
      if (error instanceof SpecialistPackageRecoveryError) {
        this.notifyDeleteCommitted(request.id)
      }
      return {
        status: 'failed',
        code:
          error instanceof SpecialistPackageRecoveryError
            ? 'recovery-failed'
            : error instanceof SpecialistPackageRevisionConflictError
              ? 'revision-conflict'
              : error instanceof SpecialistPackageRollbackError
                ? 'rollback-failed'
                : error instanceof SpecialistDeleteSelectionError
                  ? error.code
                  : 'commit-failed'
      }
    } finally {
      this.deletePreviews.delete(request.id)
    }
    this.notifyDeleteCommitted(request.id)
    return { status: 'deleted' }
  }

  async preview(
    archiveBytes: Uint8Array,
    ownerId?: number,
    options?: { origin?: SpecialistOrigin }
  ): Promise<SpecialistPackageCandidatePreview> {
    // One renderer window owns one active preview. Selecting another archive invalidates only that
    // renderer's prior capability so another window can finish its own confirmation flow.
    this.clearCandidates(ownerId)
    const catalog = await this.validationCatalog()
    const result = validateSpecialistZip(archiveBytes, catalog)
    const token = this.token()
    const diagnostics = [...result.preview.diagnostics]
    let overwrite: SpecialistPackageCandidatePreview['overwrite']
    let installable = result.preview.installable
    let governanceBlocked = false
    const origin = options?.origin ?? 'imported'
    let overwriteTarget: Candidate['overwrite']
    if (result.plan) {
      const existing = (await this.options.repository.getAll()).specialists.find(
        (specialist) => specialist.id === result.plan?.specialistId
      )
      if (existing) {
        if (existing.origin === 'marketplace' && origin !== 'marketplace') {
          diagnostics.push({
            severity: 'error',
            code: 'specialist.overwrite-marketplace-managed',
            message:
              'Marketplace-managed Specialists can only be updated from their Marketplace source.',
            relatedId: existing.id
          })
          installable = false
          governanceBlocked = true
        }
        overwrite = {
          id: existing.id,
          target: 'custom',
          currentVersion: existing.packageVersion,
          incomingVersion: result.plan.packageVersion,
          modifiedSinceImport:
            existing.origin === 'imported' &&
            existing.importBaseline !== undefined &&
            specialistContentModifiedSinceImport({
              ...existing,
              importBaseline: existing.importBaseline
            }),
          hasImportBaseline: existing.origin !== 'local' && existing.importBaseline !== undefined
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
        const baseline = existing.importBaseline
        const baselineContentDigest = baseline?.packageContentDigest ?? baseline?.contentDigest
        const incomingContentDigest = baseline?.packageContentDigest
          ? result.plan.contentHash
          : specialistLegacyPayloadContentHash(result.plan.payload)
        const contentChanged =
          baselineContentDigest !== undefined && baselineContentDigest !== incomingContentDigest
        if (contentChanged && versionOrder === 0) {
          diagnostics.push({
            severity: 'error',
            code: 'specialist.overwrite-content-without-version-bump',
            message: 'Package content changed without a higher version.',
            relatedId: existing.id
          })
          installable = false
          governanceBlocked = true
        }
        if (contentChanged && versionOrder !== undefined && versionOrder < 0) {
          diagnostics.push({
            severity: 'error',
            code: 'specialist.overwrite-content-downgrade',
            message:
              'Changed package content must use a version higher than the installed version.',
            relatedId: existing.id
          })
          installable = false
          governanceBlocked = true
        }
      }
    }
    this.candidates.set(token, {
      plan: governanceBlocked ? undefined : result.plan,
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      archiveDigest: createHash('sha256').update(archiveBytes).digest('hex'),
      archiveBytes: Uint8Array.from(archiveBytes),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(overwriteTarget ? { overwrite: overwriteTarget } : {}),
      origin,
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

    const requestedSkillIds = effectiveSpecialistSkillIds(specialist, catalog)
    const skills = [...new Set(requestedSkillIds)]
      .map((id) => {
        const builtin = catalog.builtinSkills.find((candidate) => candidate.id === id)
        if (builtin) {
          return {
            id,
            version: builtin.appVersion,
            kind: 'builtin' as const,
            selected: false,
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
    const selectedSkills = skills
    const connectorIds = effectiveSpecialistConnectorIds(specialist, catalog)
    const diagnostics: PackageDiagnostic[] = []
    if (selectedSkills.some((skill) => skill.kind === 'referenced')) {
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
      specialistContentModifiedSinceImport({
        ...specialist,
        importBaseline: specialist.importBaseline
      })
    ) {
      diagnostics.push({
        severity: 'warning',
        code: 'specialist.export-version-unchanged',
        message: `Content changed but the package version remains ${specialist.packageVersion}.`
      })
    }
    diagnostics.push(...specialistExportProfileDiagnostics(specialist))
    const includedSkillIds = selectedSkills
      .filter((skill) => skill.selected)
      .map((skill) => skill.id)
    if (!diagnostics.some((item) => item.severity === 'error')) {
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
      skills: selectedSkills,
      connectorIds,
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
    const profileDiagnostics = specialistExportProfileDiagnostics(specialist)
    if (profileDiagnostics.length) {
      throw new Error(profileDiagnostics.map((item) => item.message).join(' '))
    }

    const requestedSkillIds = effectiveSpecialistSkillIds(specialist, catalog)
    const builtinIds = new Set(catalog.builtinSkills.map((skill) => skill.id))
    const connectorIds = effectiveSpecialistConnectorIds(specialist, catalog)
    const requested = new Set(requestedSkillIds)
    if (request.includedSkillIds.some((id) => !requested.has(id))) {
      throw new Error('Export selection contains a Skill the Specialist does not reference.')
    }
    if (request.includedSkillIds.some((id) => builtinIds.has(id))) {
      throw new Error('Featured Skills are references and cannot be bundled.')
    }
    const includedUserSkillIds = request.includedSkillIds.filter((id) => !builtinIds.has(id))
    if (includedUserSkillIds.length > 0 && !this.options.skillPort?.exportSnapshot) {
      throw new Error('Skill export snapshot is unavailable.')
    }
    const userSkillSnapshots = includedUserSkillIds.length
      ? await this.options.skillPort!.exportSnapshot!(includedUserSkillIds)
      : []
    if (
      userSkillSnapshots.length !== includedUserSkillIds.length ||
      includedUserSkillIds.some((id) => !userSkillSnapshots.some((skill) => skill.localId === id))
    ) {
      throw new Error('A referenced Skill changed during export. Preview again and retry.')
    }
    const skillNameByLocalId = new Map(
      catalog.skills.map((skill) => [skill.id, skill.name ?? skill.id])
    )
    for (const snapshot of userSkillSnapshots) {
      const catalogName = skillNameByLocalId.get(snapshot.localId)
      if (catalogName !== undefined && catalogName !== snapshot.name) {
        throw new Error('A selected Skill changed during export. Preview again and retry.')
      }
      skillNameByLocalId.set(snapshot.localId, snapshot.name)
    }
    const packageSkillNames = requestedSkillIds.map((id) => skillNameByLocalId.get(id) ?? id)
    if (new Set(packageSkillNames).size !== packageSkillNames.length) {
      throw new Error('Referenced Skills have duplicate names. Preview again and retry.')
    }
    const included = new Set(request.includedSkillIds)
    const bundledSkillSnapshots: SpecialistPackageSkillSnapshot[] = userSkillSnapshots.filter(
      (skill) => included.has(skill.localId)
    )

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
      exported_with_app_version: catalog.appVersion
    }
    const payload = {
      name: specialist.name,
      ...(specialist.displayName ? { display_name: specialist.displayName } : {}),
      description: specialist.description,
      system_prompt: specialist.systemPrompt,
      skill_ids: [...new Set(requestedSkillIds.map((id) => skillNameByLocalId.get(id) ?? id))],
      connector_ids: connectorIds
    }
    const files: Record<string, Uint8Array> = {
      'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      'specialist.json': strToU8(`${JSON.stringify(payload, null, 2)}\n`)
    }
    for (const skill of bundledSkillSnapshots) {
      for (const file of skill.files) {
        files[`skills/${skill.name}/${file.path}`] =
          file.path === 'SKILL.md'
            ? normalizeExportedSkillDocument(file.bytes, skill.name, skill.version)
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
    compressedBytes: number,
    ownerId?: number
  ): Promise<SpecialistPackageCandidatePreview> {
    this.clearCandidates(ownerId)
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
      archiveBytes: new Uint8Array(),
      ...(ownerId === undefined ? {} : { ownerId }),
      report: specialistPackageReportFromPreview(preview),
      origin: 'imported'
    })
    return { candidateToken: token, ...preview }
  }

  report(candidateToken: unknown, ownerId?: number): SpecialistPackageReport | undefined {
    if (typeof candidateToken !== 'string') return undefined
    const candidate = this.candidates.get(candidateToken)
    return candidate && candidate.ownerId === ownerId ? candidate.report : undefined
  }

  candidateNewSkillIds(candidateToken: unknown, ownerId?: number): readonly string[] | undefined {
    if (typeof candidateToken !== 'string') return undefined
    const candidate = this.candidates.get(candidateToken)
    return candidate && candidate.ownerId === ownerId
      ? candidate.plan?.skills
          .filter((skill) => skill.disposition === 'install')
          .map((skill) => skill.localId ?? skill.id)
      : undefined
  }

  async install(
    request: SpecialistPackageInstallRequest,
    ownerId?: number,
    options?: { activateAfterInstall?: boolean; origin?: SpecialistOrigin }
  ): Promise<SpecialistPackageInstallResult> {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (key) => !['candidateToken', 'confirmOverwrite', 'skillConflictResolutions'].includes(key)
      ) ||
      typeof request.candidateToken !== 'string' ||
      !request.candidateToken ||
      (request.confirmOverwrite !== undefined && request.confirmOverwrite !== true) ||
      !this.validSkillConflictResolutions(request.skillConflictResolutions)
    ) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    const candidate = this.candidates.get(request.candidateToken)
    if (!candidate || candidate.ownerId !== ownerId) {
      return { status: 'failed', code: 'stale-candidate' }
    }
    if (candidate.expiresAt <= this.now().getTime()) {
      this.candidates.delete(request.candidateToken)
      return { status: 'failed', code: 'candidate-expired' }
    }
    if (!candidate.plan) {
      return { status: 'failed', code: 'candidate-not-installable' }
    }
    const previewConflicts = candidate.plan.skills.filter(
      (skill) => skill.disposition === 'conflict'
    )
    const resolutions = new Map(
      (request.skillConflictResolutions ?? []).map((resolution) => [
        resolution.skillId,
        resolution.resolution
      ])
    )
    if (
      resolutions.size !== (request.skillConflictResolutions?.length ?? 0) ||
      [...resolutions.keys()].some((id) => !previewConflicts.some((skill) => skill.id === id))
    ) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    if (previewConflicts.some((skill) => !resolutions.has(skill.id))) {
      return { status: 'failed', code: 'skill-conflict-resolution-required' }
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
      if (!liveValidation.plan) return { status: 'failed', code: 'candidate-not-installable' }
      const liveConflicts = liveValidation.plan.skills.filter(
        (skill) => skill.disposition === 'conflict'
      )
      if (
        liveConflicts.length !== previewConflicts.length ||
        liveConflicts.some((skill) => {
          const preview = previewConflicts.find((candidate) => candidate.id === skill.id)
          return (
            !preview ||
            preview.conflict?.localId !== skill.conflict?.localId ||
            preview.conflict?.installedVersion !== skill.conflict?.installedVersion ||
            preview.conflict?.installedContentHash !== skill.conflict?.installedContentHash ||
            preview.conflict?.mainEnabled !== skill.conflict?.mainEnabled ||
            preview.conflict?.specialists.map(({ id }) => id).join('\0') !==
              skill.conflict?.specialists.map(({ id }) => id).join('\0')
          )
        })
      ) {
        return { status: 'failed', code: 'stale-candidate' }
      }
      const resolvedPlan: SpecialistPackageValidationPlan = {
        ...liveValidation.plan,
        skills: liveValidation.plan.skills.flatMap((skill) => {
          if (skill.disposition !== 'conflict') return [skill]
          return [
            {
              ...skill,
              disposition:
                resolutions.get(skill.id) === 'use-incoming'
                  ? ('replace-existing' as const)
                  : ('reuse-existing' as const)
            }
          ]
        })
      }
      specialist = await this.transaction.install(
        resolvedPlan,
        this.now(),
        candidate.archiveDigest,
        candidate.overwrite
          ? { expectedRevision: candidate.overwrite.expectedRevision }
          : undefined,
        (document) => this.assertApprovedImpact(resolvedPlan, document),
        { ...options, origin: candidate.origin }
      )
    } catch (error) {
      return {
        status: 'failed',
        code:
          error instanceof SpecialistPackageRecoveryError
            ? 'recovery-failed'
            : error instanceof SpecialistPackageImpactConflictError
              ? 'stale-candidate'
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

  cancel(candidateToken: unknown, ownerId?: number): void {
    if (typeof candidateToken !== 'string') return
    if (this.candidates.get(candidateToken)?.ownerId === ownerId) {
      this.candidates.delete(candidateToken)
    }
  }

  dispose(ownerId?: number): void {
    this.clearCandidates(ownerId)
    if (ownerId === undefined) this.deletePreviews.clear()
  }

  private clearCandidates(ownerId?: number): void {
    for (const [token, candidate] of this.candidates) {
      if (candidate.ownerId === ownerId) this.candidates.delete(token)
    }
  }

  private validSkillConflictResolutions(
    value: unknown
  ): value is readonly SpecialistPackageSkillConflictResolution[] | undefined {
    return (
      value === undefined ||
      (Array.isArray(value) &&
        value.every(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            Object.keys(item).every((key) => key === 'skillId' || key === 'resolution') &&
            Object.keys(item).length === 2 &&
            'skillId' in item &&
            typeof item.skillId === 'string' &&
            'resolution' in item &&
            (item.resolution === 'use-installed' || item.resolution === 'use-incoming')
        ))
    )
  }

  private async assertApprovedImpact(
    plan: SpecialistPackageValidationPlan,
    document: Readonly<StoredSpecialists>
  ): Promise<void> {
    const replacements = plan.skills.filter(
      (skill) => skill.disposition === 'replace-existing' && skill.conflict
    )
    if (replacements.length === 0) return
    const catalog = await this.options.catalog()
    for (const skill of replacements) {
      const localId = skill.localId ?? skill.id
      const current = catalog.skills.find((candidate) => candidate.id === localId)
      const actualSpecialistIds = document.specialists
        .filter((specialist) => referencedSkillIds(specialist, [localId]).includes(localId))
        .map((specialist) => specialist.id)
        .sort()
      const approvedSpecialistIds = skill.conflict!.specialists.map(({ id }) => id).sort()
      if (
        (current?.mainEnabled ?? false) !== skill.conflict!.mainEnabled ||
        actualSpecialistIds.join('\0') !== approvedSpecialistIds.join('\0')
      ) {
        throw new SpecialistPackageImpactConflictError()
      }
    }
  }
}
