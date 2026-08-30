import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  AgentHomeSkillView,
  CreateSkillRequest,
  DeleteSkillRequest,
  ImportSkillRequest,
  ImportSkillResult,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  ImportSkillZipRequest,
  GitHubTokenStatus,
  PreviewGitHubSkillRequest,
  PreviewAgentHomeSkillRequest,
  PreviewSkillZipRequest,
  ScanRepoRequest,
  SkillPackageFileInfo,
  SkillReferenceInfo,
  ScanRepoResult,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SkillBundlePreviewResult,
  SkillDetailView,
  SkillImportPreviewContent,
  SkillSource,
  SkillView,
  UpdateSkillRequest
} from '../../shared/settings'
import { DEFAULT_AGENT_FRAMEWORK_ID, type AgentFrameworkId } from '../agent-framework'
import { codeBuddyStorageDir } from '../agent-framework/codebuddy'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import {
  createAuthenticatedGitHubFetch,
  isGitHubRateLimitResponse,
  parseGitHubRepo,
  parseGitHubSkillUrl,
  searchGitHubSkillRepositories,
  type FetchLike
} from '../skills/github-import'
import { decodeBoundedBase64, SKILL_IMPORT_LIMITS } from '../skills/import-limits'
import {
  ClaudeCodeSkillMaterializer,
  OS_SKILL_PREFIX,
  type SkillMaterializationOptions
} from '../skills/materializer'
import { netFetch } from '../skills/net-fetch'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { readSkillFile } from '../skills/skill-files'
import { buildSkillExportArchive, type SkillExportArchive } from '../skills/export'
import {
  SAFE_SKILL_DIRECTORY_NAME,
  UserSkillRepository,
  isReservedSkillName
} from '../skills/user-skill-repository'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'
import { encryptKey, maskKey, tryDecryptKey } from './crypto'
import {
  RegisteredSkillHelperCatalog,
  type RegisteredHelperScope,
  type RegisteredSkillPackage,
  validateRegisteredSkillPackages
} from '../skills/registered-helper-catalog'

type SkillCatalogEntry = {
  name: string
  description: string
  path: string
  source?: 'connector'
}
type AdditionalSkillCatalogEntry = Omit<SkillCatalogEntry, 'path' | 'description'> & {
  directory: string
  description?: string
}
type AdditionalSkillCatalogEntries =
  | readonly AdditionalSkillCatalogEntry[]
  | ((
      settings: StoredSettings
    ) => readonly AdditionalSkillCatalogEntry[] | Promise<readonly AdditionalSkillCatalogEntry[]>)
type AgentHomeSkillDir = { source: AgentHomeSkillSource; dir: string }
type DiscoveredAgentHomeSkill = {
  skill: AgentHomeSkillView
  realPath: string
  aliases: AgentHomeSkillRef[]
  fallbackAliases: AgentHomeSkillRef[]
  matchedFallbackDirectoryNames: Set<string>
  identityMigration?: {
    skill: AgentHomeSkillRef
    options: NonNullable<Parameters<UserSkillRepository['importAgentHomeSkill']>[2]>
  }
}

const log = createLogger('skills')

type SkillCatalogModuleOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir?: string
  userCodexDir?: string
  userAgentsDir?: string
  skillRegistry?: SkillRegistry
  userSkills?: UserSkillRepository
  githubFetch?: FetchLike
  authorizeRegisteredHelper?: (
    skillId: string,
    scope: RegisteredHelperScope | undefined
  ) => boolean | Promise<boolean>
}

// Owns the installed Skill catalog and its filesystem rules. SettingsService remains a compatibility
// facade for existing Electron, Web, CLI, IPC, runtime, and Specialist callers.
class SkillCatalogModule {
  private readonly skillRegistry: SkillRegistry
  private readonly userSkills: UserSkillRepository
  private readonly githubFetch: FetchLike
  private readonly registeredHelpers: RegisteredSkillHelperCatalog
  private readonly failedAgentHomeIdentityMigrationPaths = new Set<string>()
  private userSkillCatalogRead: Promise<BundledSkill[]> | undefined

  constructor(private readonly options: SkillCatalogModuleOptions) {
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.userSkills =
      options.userSkills ??
      new UserSkillRepository(options.storageRoot, undefined, async (list) =>
        this.validatePromotedRegisteredHelpers(await list())
      )
    this.githubFetch = options.githubFetch ?? netFetch
    this.registeredHelpers = new RegisteredSkillHelperCatalog({
      storageRoot: options.storageRoot,
      packages: () => this.registeredHelperPackages(),
      trustedBuiltinPackages: async () =>
        this.registeredHelperPackagesFromCatalog(await this.skillRegistry.list()),
      authorize: async ({ skillId }, scope) => {
        if (options.authorizeRegisteredHelper) {
          return options.authorizeRegisteredHelper(skillId, scope)
        }
        const isSpecialistScope = scope?.allowedSkillIds !== undefined
        if (isSpecialistScope) {
          return Boolean(scope?.allowedSkillIds?.includes(skillId))
        }
        const disabled = new Set(
          (await this.options.repository.getSettings()).disabledSkillIds ?? []
        )
        // A trusted Specialist scope may force-load a globally disabled Skill. Main Agent requests
        // have no allowedSkillIds and continue to honor global enablement.
        return !disabled.has(skillId)
      }
    })
  }

  registeredHelperCatalog(): Pick<
    RegisteredSkillHelperCatalog,
    'resolve' | 'protectedDirectories' | 'refresh'
  > {
    return this.registeredHelpers
  }

  private async refreshRegisteredHelpers(): Promise<void> {
    await this.registeredHelpers.refresh()
  }

  private async registeredHelperPackages(): Promise<readonly RegisteredSkillPackage[]> {
    return this.registeredHelperPackagesFromCatalog(await this.catalog())
  }

  private async registeredHelperPackagesFromCatalog(
    skills: readonly BundledSkill[]
  ): Promise<readonly RegisteredSkillPackage[]> {
    const installed = skills
      .filter((skill) => skill.helpers?.length)
      .map((skill) => ({
        skillId: skill.id,
        origin: skill.source === 'featured' ? ('builtin' as const) : skill.source,
        packageRoot: skill.sourceDir,
        helpers: [...(skill.helpers ?? [])]
      }))
    return installed
  }

  private async validatePromotedRegisteredHelpers(user: readonly BundledSkill[]): Promise<void> {
    const featured = await this.skillRegistry.list()
    await validateRegisteredSkillPackages(
      await this.registeredHelperPackagesFromCatalog(this.mergeCatalog(featured, user))
    )
  }

  private async authenticatedGitHubFetch(): Promise<FetchLike> {
    const settings = await this.options.repository.getSettings()
    return createAuthenticatedGitHubFetch(this.githubFetch, tryDecryptKey(settings.githubTokenRef))
  }

  async getGitHubTokenStatus(): Promise<GitHubTokenStatus> {
    const settings = await this.options.repository.getSettings()
    const configured = Boolean(settings.githubTokenRef && tryDecryptKey(settings.githubTokenRef))
    return {
      configured,
      ...(configured && settings.githubTokenMask ? { mask: settings.githubTokenMask } : {})
    }
  }

  async saveGitHubToken(token: string): Promise<GitHubTokenStatus> {
    const trimmed = token.trim()
    const response = await createAuthenticatedGitHubFetch(
      this.githubFetch,
      trimmed,
      {}
    )('https://api.github.com/rate_limit', {
      headers: { 'User-Agent': 'open-science', Accept: 'application/vnd.github+json' }
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('GitHub rejected this token. Check that it is valid and try again.')
      }
      if (isGitHubRateLimitResponse(response)) {
        throw new Error('GitHub token verification was rate-limited. Wait a moment and try again.')
      }
      if (response.status === 403) {
        throw new Error(
          'GitHub forbids this token from accessing the API. Check its permissions and organization access, then try again.'
        )
      }
      throw new Error(`GitHub token verification failed (${response.status}). Try again.`)
    }

    await this.options.repository.setGitHubToken(encryptKey(trimmed), maskKey(trimmed))
    return this.getGitHubTokenStatus()
  }

  async removeGitHubToken(): Promise<GitHubTokenStatus> {
    await this.options.repository.setGitHubToken(undefined, undefined)
    return { configured: false }
  }

  private async catalog(): Promise<BundledSkill[]> {
    const [featured, user] = await Promise.all([this.skillRegistry.list(), this.listUserSkills()])
    return this.mergeCatalog(featured, user)
  }

  private mergeCatalog(
    featured: readonly BundledSkill[],
    user: readonly BundledSkill[]
  ): BundledSkill[] {
    const bundledNames = new Set(featured.map((skill) => skill.name))
    const bundledIds = new Set(featured.map((skill) => skill.id))
    const userIdCounts = new Map<string, number>()
    for (const skill of user) userIdCounts.set(skill.id, (userIdCounts.get(skill.id) ?? 0) + 1)
    const eligibleUserSkills = user.filter((skill) => {
      const reason = isReservedSkillName(skill.name)
        ? 'reserved prefix (os- or mcp-)'
        : bundledNames.has(skill.name)
          ? 'bundled Skill name'
          : bundledIds.has(skill.id)
            ? 'bundled Skill id'
            : (userIdCounts.get(skill.id) ?? 0) > 1
              ? 'duplicate user Skill id'
              : undefined
      if (!reason) return true
      log.warn('skipping user Skill with protected identity', {
        source: skill.source,
        id: skill.id,
        name: skill.name,
        reason
      })
      return false
    })
    const newestByName = new Map<string, BundledSkill>()
    for (const skill of [...featured, ...eligibleUserSkills]) {
      const existing = newestByName.get(skill.name)
      if (!existing || this.isNewerSkill(skill, existing)) newestByName.set(skill.name, skill)
    }
    return [...newestByName.values()]
  }

  private isNewerSkill(candidate: BundledSkill, existing: BundledSkill): boolean {
    const candidateTime = Date.parse(candidate.updatedAt)
    const existingTime = Date.parse(existing.updatedAt)
    if (candidateTime !== existingTime) return candidateTime > existingTime
    return candidate.id.localeCompare(existing.id) > 0
  }

  private async bundledSkillNames(): Promise<string[]> {
    return (await this.skillRegistry.list()).map((skill) => skill.name)
  }

  private async managedCatalog(): Promise<BundledSkill[]> {
    return (await this.catalog()).filter((skill) => skill.exposure !== 'internal')
  }

  // Main-process adapter for host.skills. This intentionally includes internal bundled Skills so
  // /Customize can load skill-creator, while user-facing projections below use managedCatalog().
  async listHostSkills(): Promise<BundledSkill[]> {
    return this.catalog()
  }

  // Main-process observer adapter. Keeping this read on the existing repository owner avoids a
  // second production transaction facade while excluding immutable bundled packages from each
  // writable-directory reconciliation.
  async listUserSkills(): Promise<BundledSkill[]> {
    if (this.userSkillCatalogRead) return this.userSkillCatalogRead
    const read = this.userSkills.list().finally(() => {
      if (this.userSkillCatalogRead === read) this.userSkillCatalogRead = undefined
    })
    this.userSkillCatalogRead = read
    return read
  }

  async withHostSkillRead<T>(
    id: string,
    read: (skill: BundledSkill) => Promise<T>
  ): Promise<T | undefined> {
    const selected = (await this.catalog()).find((skill) => skill.id === id)
    if (!selected) return undefined
    return selected.source === 'featured'
      ? read(selected)
      : this.userSkills.withSkillReadLock(id, read)
  }

  async publishHostSkill(name: string, sourcePath: string, overwrite: boolean): Promise<string> {
    const id = await this.userSkills.publishPersonalDirectory(
      name,
      sourcePath,
      overwrite,
      await this.bundledSkillNames()
    )
    await this.refreshRegisteredHelpers()
    return id
  }

  async listSkills(): Promise<SkillView[]> {
    const [skills, settings] = await Promise.all([
      this.managedCatalog(),
      this.options.repository.getSettings()
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])
    return skills.map((skill) => this.toSkillView(skill, disabled))
  }

  async listSpecialistSkillCatalog(options: { bundledOnly?: boolean } = {}): Promise<
    Array<{
      id: string
      frameworkName: string
      displayName: string
      source: SkillSource
      mainEnabled: boolean
      available: boolean
      compatibility?: string
    }>
  > {
    const [skills, settings] = await Promise.all([
      options.bundledOnly
        ? this.skillRegistry
            .list()
            .then((entries) => entries.filter((skill) => skill.exposure !== 'internal'))
        : this.managedCatalog(),
      this.options.repository.getSettings()
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])
    return skills.map((skill) => ({
      id: skill.id,
      frameworkName: skill.name,
      displayName: skill.displayName,
      source: skill.source,
      mainEnabled: !disabled.has(skill.id),
      // Catalog entries are installed skills, so they resolve to a present entry at dispatch time.
      available: true,
      ...(skill.compatibility ? { compatibility: skill.compatibility } : {})
    }))
  }

  async skillsNeedingForceLoad(ids: string[]): Promise<string[]> {
    const disabled = new Set((await this.options.repository.getSettings()).disabledSkillIds ?? [])
    const managedIds = new Set((await this.managedCatalog()).map((skill) => skill.id))
    return ids.filter((id) => managedIds.has(id) && disabled.has(id))
  }

  async skillNudgeNamesForIds(ids: string[]): Promise<string[]> {
    const nameById = new Map((await this.managedCatalog()).map((skill) => [skill.id, skill.name]))
    return ids.map((id) => nameById.get(id)).filter((name): name is string => name !== undefined)
  }

  async codexSkillDescriptorsForIds(
    ids: string[],
    codexHome: string | undefined
  ): Promise<Array<{ name: string; path: string }>> {
    if (!codexHome || ids.length === 0) return []
    const skillsRoot = this.allowedCodexSkillsRoot(codexHome)
    if (!skillsRoot) return []
    const realRoot = await realpath(skillsRoot).catch(() => undefined)
    if (!realRoot) return []
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    const byId = new Map((await this.managedCatalog()).map((skill) => [skill.id, skill] as const))
    const descriptors: Array<{ name: string; path: string }> = []
    for (const id of [...new Set(ids)]) {
      const skill = byId.get(id)
      if (!skill) continue
      const filePath = join(skillsRoot, `${OS_SKILL_PREFIX}${skill.id}`, 'SKILL.md')
      const realFile = await realpath(filePath).catch(() => undefined)
      if (!realFile || !realFile.startsWith(rootWithSep)) continue
      descriptors.push({
        name: skill.name,
        path: filePath
      })
    }
    return descriptors
  }

  async codexSkillCatalog(
    codexHome: string | undefined,
    additionalEntries: AdditionalSkillCatalogEntries = []
  ): Promise<SkillCatalogEntry[]> {
    if (!codexHome) return []
    const skillsRoot = this.allowedCodexSkillsRoot(codexHome)
    if (!skillsRoot) return []
    return this.projectedSkillCatalog(skillsRoot, additionalEntries)
  }

  async codeBuddySkillCatalog(
    runtimeRoot: string | undefined,
    additionalEntries: AdditionalSkillCatalogEntries = []
  ): Promise<SkillCatalogEntry[]> {
    if (
      !runtimeRoot ||
      resolve(runtimeRoot) !==
        resolve(join(codeBuddyStorageDir(this.options.storageRoot), 'skill-runtime'))
    ) {
      return []
    }
    return this.projectedSkillCatalog(join(runtimeRoot, '.claude', 'skills'), additionalEntries)
  }

  private async projectedSkillCatalog(
    skillsRoot: string,
    additionalEntries: AdditionalSkillCatalogEntries
  ): Promise<SkillCatalogEntry[]> {
    const realRoot = await realpath(skillsRoot).catch(() => undefined)
    if (!realRoot) return []
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    const [skills, settings] = await Promise.all([
      this.catalog(),
      this.options.repository.getSettings()
    ])
    const extensions =
      typeof additionalEntries === 'function'
        ? await additionalEntries(settings)
        : additionalEntries
    const disabled = new Set(settings.disabledSkillIds ?? [])
    const enabled: AdditionalSkillCatalogEntry[] = [
      ...skills
        .filter((skill) => skill.exposure === 'internal' || !disabled.has(skill.id))
        .map((skill) => ({
          directory: `${OS_SKILL_PREFIX}${skill.id}`,
          name: skill.name,
          description: skill.description
        })),
      ...extensions
    ]
    const nameCounts = new Map<string, number>()
    for (const item of enabled) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
    const result: SkillCatalogEntry[] = []
    for (const item of enabled) {
      if (nameCounts.get(item.name) !== 1) continue
      const filePath = join(skillsRoot, item.directory, 'SKILL.md')
      const realFile = await realpath(filePath).catch(() => undefined)
      if (!realFile || !realFile.startsWith(rootWithSep)) continue
      let description = item.description?.trim()
      if (!description) {
        const parsed = await readSkillFile(dirname(realFile)).catch(() => undefined)
        if (
          !parsed ||
          parsed.fields.name !== item.name ||
          (item.source !== undefined && parsed.fields.source !== item.source)
        ) {
          continue
        }
        description = parsed.fields.description?.trim()
      }
      if (!description) continue
      result.push({
        name: item.name,
        description,
        path: filePath,
        ...(item.source ? { source: item.source } : {})
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getSkillDetail(id: string): Promise<SkillDetailView> {
    const [skills, settings] = await Promise.all([
      this.managedCatalog(),
      this.options.repository.getSettings()
    ])
    const skill = skills.find((entry) => entry.id === id)
    if (!skill) throw new Error(`Unknown skill: ${id}`)

    const disabled = new Set(settings.disabledSkillIds ?? [])
    const readDetail = async (lockedSkill: BundledSkill): Promise<SkillDetailView> => {
      const packageFiles = await this.listPackageFiles(lockedSkill.sourceDir)
      const { fields, body } = await readSkillFile(lockedSkill.sourceDir)
      return {
        ...this.toSkillView(lockedSkill, disabled),
        body,
        metadata: Object.fromEntries(
          Object.entries(fields).filter(([key]) => key !== 'name' && key !== 'description')
        ),
        references: this.referencesFromPackageFiles(packageFiles),
        packageFiles
      }
    }

    if (skill.source === 'featured') return readDetail(skill)
    const detail = await this.userSkills.withSkillReadLock(id, readDetail)
    if (!detail) throw new Error(`Unknown skill: ${id}`)
    return detail
  }

  async buildSkillExport(id: string): Promise<SkillExportArchive> {
    if ((await this.skillRegistry.list()).some((entry) => entry.id === id)) {
      throw new Error('Built-in Skills cannot be exported.')
    }
    const archive = await this.userSkills.withSkillReadLock(id, buildSkillExportArchive)
    if (!archive) throw new Error(`Unknown skill: ${id}`)
    return archive
  }

  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    await this.options.repository.setSkillEnabled(request.id, request.enabled)
    return this.listSkills()
  }

  async setSkillsEnabled(request: SetSkillsEnabledRequest): Promise<SkillView[]> {
    const ids = [...new Set(request.ids)]
    const selectableIds = new Set(
      (await this.managedCatalog())
        .filter((skill) => skill.source === 'imported' || skill.source === 'personal')
        .map((skill) => skill.id)
    )
    const unsupported = ids.find((id) => !selectableIds.has(id))
    if (unsupported) throw new Error(`Skill cannot be managed in bulk: ${unsupported}`)

    await this.options.repository.setSkillsEnabled(ids, request.enabled)
    return this.listSkills()
  }

  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.createPersonal(request, await this.bundledSkillNames())
    await this.refreshRegisteredHelpers()
    return this.listSkills()
  }

  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    if ('name' in request) throw new Error('Skill name is immutable.')
    const skill = (await this.managedCatalog()).find((entry) => entry.id === request.id)
    if (!skill || skill.source !== 'personal') {
      throw new Error(`Not a personal skill id: ${request.id}`)
    }
    await this.userSkills.updatePersonal(request.id, {
      name: skill.name,
      description: request.description,
      body: request.body,
      metadata: request.metadata,
      references: request.references
    })
    await this.refreshRegisteredHelpers()
    return this.listSkills()
  }

  async deleteSkill(
    request: DeleteSkillRequest,
    guard?: (skillId: string) => Promise<void>
  ): Promise<SkillView[]> {
    await this.userSkills.delete(request.id, guard)
    await this.options.repository.setSkillEnabled(request.id, true)
    await this.refreshRegisteredHelpers()
    return this.listSkills()
  }

  async importSkill(request: ImportSkillRequest, signal?: AbortSignal): Promise<ImportSkillResult> {
    const outcome = await this.userSkills.importFromGitHub(
      request.url,
      await this.authenticatedGitHubFetch(),
      await this.bundledSkillNames(),
      { signal }
    )
    await this.refreshRegisteredHelpers()
    return { ...outcome, skills: await this.listSkills() }
  }

  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    const zip = decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    const outcome = await this.userSkills.importFromZip(zip, {
      subPath: request.subPath,
      replaceId: request.replaceId,
      reservedNames: await this.bundledSkillNames()
    })
    await this.refreshRegisteredHelpers()
    return { ...outcome, skills: await this.listSkills() }
  }

  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): Promise<ImportSkillZipBatchResult> {
    const zip = decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    const outcomes = await this.importSkillArchiveBatch(zip, request.items)
    return {
      results: outcomes.map((entry) =>
        entry.outcome
          ? { subPath: entry.subPath, ...entry.outcome }
          : { subPath: entry.subPath, error: entry.error ?? 'Import failed.' }
      ),
      skills: await this.listSkills()
    }
  }

  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult> {
    return this.previewSkillArchive(
      decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    )
  }

  async previewSkillArchive(zip: Buffer): Promise<SkillBundlePreviewResult> {
    return this.userSkills.previewZip(zip)
  }

  async importSkillArchiveBatch(
    zip: Buffer,
    items: ImportSkillZipBatchRequest['items']
  ): ReturnType<UserSkillRepository['importFromZipBatch']> {
    const outcomes = await this.userSkills.importFromZipBatch(
      zip,
      items,
      await this.bundledSkillNames()
    )
    await this.refreshRegisteredHelpers()
    return outcomes
  }

  async previewGitHubSkill(
    request: PreviewGitHubSkillRequest,
    signal?: AbortSignal
  ): Promise<SkillImportPreviewContent> {
    const location = parseGitHubSkillUrl(request.url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')
    const preview = await this.userSkills.previewGitHubSkill(
      request.url,
      await this.authenticatedGitHubFetch(),
      { signal }
    )
    const suffix = location.path ? `/${location.path}` : ''
    const revision = location.ref ? `@${location.ref}` : ''
    return {
      ...preview,
      sourceLabel: `github.com/${location.owner}/${location.repo}${revision}${suffix}`
    }
  }

  async scanRepoSkills(request: ScanRepoRequest, signal?: AbortSignal): Promise<ScanRepoResult> {
    if (parseGitHubRepo(request.repo)) {
      return {
        skills: await this.userSkills.scanRepo(
          request.repo,
          await this.authenticatedGitHubFetch(),
          { signal }
        )
      }
    }
    return {
      skills: [],
      repositories: await searchGitHubSkillRepositories(
        request.repo,
        await this.authenticatedGitHubFetch(),
        { signal }
      )
    }
  }

  async listAgentHomeSkills(): Promise<AgentHomeSkillView[]> {
    const settings = await this.options.repository.getSettings()
    const framework = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    return (await this.discoverAgentHomeSkills(this.agentHomeDirs(framework))).map(
      (item) => item.skill
    )
  }

  async migrateAgentHomeSkillIdentities(): Promise<void> {
    let discovered: DiscoveredAgentHomeSkill[]
    let reservedNames: string[]
    try {
      ;[discovered, reservedNames] = await Promise.all([
        this.discoverAgentHomeSkills(this.allAgentHomeDirs()),
        this.bundledSkillNames()
      ])
    } catch (error) {
      log.warn('Agent Home Skill identity migration scan failed', diagnosticErrorFields(error))
      return
    }

    for (const item of discovered) {
      if (!item.identityMigration) continue
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      try {
        await this.userSkills.importAgentHomeSkill(item.realPath, item.identityMigration.skill, {
          ...item.identityMigration.options,
          reservedNames
        })
        this.failedAgentHomeIdentityMigrationPaths.delete(pathKey)
      } catch (error) {
        this.failedAgentHomeIdentityMigrationPaths.add(pathKey)
        log.warn('Agent Home Skill identity migration failed', {
          source: item.identityMigration.skill.source,
          slug: item.identityMigration.skill.slug,
          ...diagnosticErrorFields(error)
        })
      }
    }
  }

  private async discoverAgentHomeSkills(
    sources: AgentHomeSkillDir[]
  ): Promise<DiscoveredAgentHomeSkill[]> {
    const scanResults = await Promise.allSettled(
      sources.map(async ({ source, dir }) => {
        const skills = await this.userSkills.listAgentHomeSkills(dir, source)
        const visible: {
          skill: AgentHomeSkillView
          realPath: string
          alias: AgentHomeSkillRef
        }[] = []
        for (const skill of skills) {
          try {
            const realPath = await this.resolveAgentHomeSkillPath(source, skill.slug, sources)
            visible.push({
              realPath,
              alias: { source, slug: skill.slug },
              skill: {
                source,
                slug: skill.slug,
                name: skill.name,
                description: skill.description,
                alreadyImported: skill.alreadyImported
              }
            })
          } catch {
            continue
          }
        }
        return visible
      })
    )
    const groups = scanResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const firstFailure = scanResults.find((result) => result.status === 'rejected')
    if (groups.every((group) => group.length === 0) && firstFailure?.status === 'rejected') {
      throw firstFailure.reason
    }

    const unique = new Map<string, DiscoveredAgentHomeSkill>()
    for (const item of groups.flat()) {
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      const existing = unique.get(pathKey)
      if (existing) {
        existing.aliases.push(item.alias)
        existing.skill.alreadyImported ||= item.skill.alreadyImported
      } else {
        unique.set(pathKey, {
          skill: item.skill,
          realPath: item.realPath,
          aliases: [item.alias],
          fallbackAliases: [],
          matchedFallbackDirectoryNames: new Set()
        })
      }
    }

    const discovered = [...unique.values()]
    try {
      const matches = await this.userSkills.matchImportedAgentHomeSkills(
        discovered.map((item) => ({
          sourcePath: item.realPath,
          canonical: { source: item.skill.source, slug: item.skill.slug },
          aliases: item.aliases
        }))
      )
      for (const [index, match] of matches.entries()) {
        const item = discovered[index]
        if (!item) continue
        item.skill.alreadyImported = match.identityImported
        item.fallbackAliases.push(...match.fallbackAliases)
        if (
          match.identityMigrationNeeded &&
          match.matchedIdentitySignature &&
          match.matchedImportedIdentity
        ) {
          item.identityMigration = {
            skill: { source: item.skill.source, slug: item.skill.slug },
            options: {
              aliases: item.aliases,
              expectedSignature: match.matchedIdentitySignature,
              expectedImportedIdentity: match.matchedImportedIdentity
            }
          }
        }
      }
    } catch {
      // Keep readable rows when compatibility matching cannot inspect malformed legacy imports.
    }

    const fallbackBySlug = new Map<
      string,
      { item: DiscoveredAgentHomeSkill; alias: AgentHomeSkillRef }[]
    >()
    for (const item of discovered) {
      if (item.skill.alreadyImported) continue
      for (const alias of item.fallbackAliases) {
        const candidates = fallbackBySlug.get(alias.slug) ?? []
        candidates.push({ item, alias })
        fallbackBySlug.set(alias.slug, candidates)
      }
    }
    for (const [fallbackSlug, candidates] of fallbackBySlug) {
      for (const candidate of candidates) {
        candidate.item.skill.alreadyImported = true
        candidate.item.matchedFallbackDirectoryNames.add(fallbackSlug)
      }
    }
    for (const item of discovered) {
      if (!item.identityMigration) continue
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      if (this.failedAgentHomeIdentityMigrationPaths.has(pathKey)) {
        item.skill.alreadyImported = false
      }
    }
    return discovered
  }

  async previewAgentHomeSkill(
    request: PreviewAgentHomeSkillRequest
  ): Promise<SkillImportPreviewContent> {
    const settings = await this.options.repository.getSettings()
    const framework = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const availableSources = this.agentHomeDirs(framework)
    const requestedSourcePath = join(
      availableSources.find((candidate) => candidate.source === request.source)?.dir ?? '',
      request.slug
    )
    const sourcePath = await this.resolveAgentHomeSkillPath(
      request.source,
      request.slug,
      availableSources
    )
    const canonical = await this.canonicalAgentHomeSkillRef(sourcePath, availableSources)
    if (!canonical) {
      throw new Error('Refusing to preview installed skill outside a top-level skill directory.')
    }
    const sourceRoot =
      canonical.source === 'agents'
        ? '~/.agents/skills'
        : canonical.source === 'claude'
          ? '~/.claude/skills'
          : '~/.codex/skills'
    const sourceLabel = `${sourceRoot}/${canonical.slug}`
    try {
      return {
        ...(await this.userSkills.previewAgentHomeSkill(sourcePath)),
        sourceLabel
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not preview the installed skill.'
      const redacted = [sourcePath, requestedSourcePath].reduce((value, hostPath) => {
        if (!hostPath) return value
        return value
          .split(`${hostPath}${sep}`)
          .join(`${sourceLabel}/`)
          .split(hostPath)
          .join(sourceLabel)
      }, message)
      throw new Error(redacted)
    }
  }

  async importAgentHomeSkills(
    request: ImportAgentHomeSkillsRequest
  ): Promise<ImportAgentHomeSkillsResult> {
    if (!request || !Array.isArray(request.skills)) {
      throw new Error('Installed skills must be an array.')
    }
    if (request.skills.length > SKILL_IMPORT_LIMITS.maxSkillsPerBundle) {
      throw new Error(
        `Cannot import more than ${SKILL_IMPORT_LIMITS.maxSkillsPerBundle} installed skills at once.`
      )
    }

    const settings = await this.options.repository.getSettings()
    const framework = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const availableSources = this.agentHomeDirs(framework)
    const discovered = await this.discoverAgentHomeSkills(availableSources).catch(
      () => [] as DiscoveredAgentHomeSkill[]
    )
    const discoveredByPath = new Map(
      discovered.map((item) => [
        process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath,
        item
      ])
    )
    const results: ImportAgentHomeSkillsResult['results'] = []

    for (const skill of request.skills) {
      const candidate =
        typeof skill === 'object' && skill !== null
          ? (skill as { source?: unknown; slug?: unknown })
          : undefined
      const ref: Partial<AgentHomeSkillRef> = {}
      if (
        candidate?.source === 'agents' ||
        candidate?.source === 'claude' ||
        candidate?.source === 'codex'
      ) {
        ref.source = candidate.source
      }
      if (typeof candidate?.slug === 'string') ref.slug = candidate.slug

      try {
        if (!ref.source || ref.slug === undefined) {
          throw new Error('Installed skill entries must include a valid source and slug.')
        }
        const validated: AgentHomeSkillRef = { source: ref.source, slug: ref.slug }
        const sourcePath = await this.resolveAgentHomeSkillPath(
          validated.source,
          validated.slug,
          availableSources
        )
        const canonical = await this.canonicalAgentHomeSkillRef(sourcePath, availableSources)
        if (!canonical) {
          throw new Error('Refusing to import installed skill outside a top-level skill directory.')
        }
        const pathKey = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
        const discoveredSkill = discoveredByPath.get(pathKey)
        const outcome = await this.userSkills.importAgentHomeSkill(sourcePath, canonical, {
          aliases: discoveredSkill?.aliases,
          fallbackDirectoryNames: discoveredSkill
            ? [...discoveredSkill.matchedFallbackDirectoryNames]
            : undefined,
          reservedNames: await this.bundledSkillNames()
        })
        results.push({ ...validated, ...outcome })
      } catch (error) {
        results.push({
          ...ref,
          error: error instanceof Error ? error.message : 'Could not import the installed skill.'
        })
      }
    }
    await this.refreshRegisteredHelpers()
    return { results, skills: await this.listSkills() }
  }

  private agentHomeDirs(framework: AgentFrameworkId): AgentHomeSkillDir[] {
    const sources = this.allAgentHomeDirs()
    if (framework === 'claude-code') {
      return sources.filter(({ source }) => source === 'agents' || source === 'claude')
    }
    if (framework === 'codex') {
      return sources.filter(({ source }) => source === 'agents' || source === 'codex')
    }
    return sources.filter(({ source }) => source === 'agents')
  }

  private allAgentHomeDirs(): AgentHomeSkillDir[] {
    return [
      {
        source: 'agents',
        dir: join(this.options.userAgentsDir ?? join(homedir(), '.agents'), 'skills')
      },
      {
        source: 'claude',
        dir: join(this.options.userClaudeDir ?? join(homedir(), '.claude'), 'skills')
      },
      {
        source: 'codex',
        dir: join(this.options.userCodexDir ?? join(homedir(), '.codex'), 'skills')
      }
    ]
  }

  private async resolveAgentHomeSkillPath(
    source: AgentHomeSkillSource,
    slug: string,
    availableSources: AgentHomeSkillDir[]
  ): Promise<string> {
    const homeSkillsDir = availableSources.find((candidate) => candidate.source === source)?.dir
    if (!homeSkillsDir) {
      throw new Error(`Installed skill source "${String(source)}" is not available.`)
    }
    if (!SAFE_SKILL_DIRECTORY_NAME.test(slug)) {
      throw new Error(`Refusing to import installed skill with unsafe slug: ${slug}`)
    }
    const lexicalCandidate = resolve(homeSkillsDir, slug)
    const candidate = await realpath(lexicalCandidate).catch(() => lexicalCandidate)
    const allowedRoots = await Promise.all(
      availableSources.map(({ dir }) => realpath(dir).catch(() => resolve(dir)))
    )
    const withinAllowedRoot = allowedRoots.some((root) => {
      const rootWithSep = root.endsWith(sep) ? root : root + sep
      return candidate === root || candidate.startsWith(rootWithSep)
    })
    if (!withinAllowedRoot) {
      throw new Error(`Refusing to import installed skill outside its source: ${slug}`)
    }
    if (!(await this.canonicalAgentHomeSkillRef(candidate, availableSources))) {
      throw new Error(
        `Refusing to import installed skill outside a top-level skill directory: ${slug}`
      )
    }
    return candidate
  }

  private async canonicalAgentHomeSkillRef(
    realSkillPath: string,
    availableSources: AgentHomeSkillDir[]
  ): Promise<AgentHomeSkillRef | undefined> {
    for (const source of availableSources) {
      const realRoot = await realpath(source.dir).catch(() => resolve(source.dir))
      const child = relative(realRoot, realSkillPath)
      if (
        child &&
        !isAbsolute(child) &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !child.includes(sep) &&
        SAFE_SKILL_DIRECTORY_NAME.test(child)
      ) {
        return { source: source.source, slug: child }
      }
    }
    return undefined
  }

  async materializeSkills(
    configRoot: string,
    disabledIds: readonly string[],
    forcedIds: ReadonlySet<string> = new Set(),
    options: SkillMaterializationOptions = {}
  ): Promise<void> {
    const disabled = new Set(disabledIds.filter((id) => !forcedIds.has(id)))
    await new ClaudeCodeSkillMaterializer().sync(
      configRoot,
      (await this.catalog()).filter(
        (skill) => skill.exposure === 'internal' || !disabled.has(skill.id)
      ),
      options
    )
  }

  private allowedCodexSkillsRoot(codexHome: string): string | undefined {
    const requested = resolve(codexHome)
    const allowed = new Set([
      resolve(codexStorageDir(this.options.storageRoot)),
      resolve(codexSubscriptionStorageDir(this.options.storageRoot))
    ])
    return allowed.has(requested) ? join(requested, 'skills') : undefined
  }

  private async listPackageFiles(sourceDir: string): Promise<SkillPackageFileInfo[]> {
    const files: SkillPackageFileInfo[] = []
    const visit = async (directory: string, parentPath: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      for (const entry of entries) {
        const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
        const absolutePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath, path)
        } else if (entry.isFile()) {
          const metadata = await lstat(absolutePath)
          if (metadata.isFile()) {
            files.push({ path, sizeBytes: metadata.size })
          }
        }
      }
    }
    await visit(sourceDir, '')
    return files
  }

  private referencesFromPackageFiles(
    packageFiles: readonly SkillPackageFileInfo[]
  ): SkillReferenceInfo[] {
    const prefix = 'references/'
    return packageFiles.flatMap((file) => {
      if (!file.path.startsWith(prefix)) return []
      const path = file.path.slice(prefix.length)
      return path.includes('/') ? [] : [{ path, sizeBytes: file.sizeBytes }]
    })
  }

  private toSkillView(skill: BundledSkill, disabled: Set<string>): SkillView {
    return {
      id: skill.id,
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      source: skill.source,
      updatedAt: skill.updatedAt,
      enabled: !disabled.has(skill.id),
      author: skill.author,
      license: skill.license,
      thirdParty: skill.thirdParty
    }
  }
}

export { SkillCatalogModule }
export type { AdditionalSkillCatalogEntry, SkillCatalogEntry, SkillCatalogModuleOptions }
