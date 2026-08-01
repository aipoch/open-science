import { readdir, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type {
  CreateSkillRequest,
  DeleteSkillRequest,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  ImportSkillZipRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  ScanRepoRequest,
  ScanRepoResult,
  SetSkillEnabledRequest,
  SkillBundlePreviewResult,
  SkillDetailView,
  SkillImportPreviewContent,
  SkillView,
  UpdateSkillRequest
} from '../../shared/settings'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { parseGitHubSkillUrl } from '../skills/github-import'
import { decodeBoundedBase64, SKILL_IMPORT_LIMITS } from '../skills/import-limits'
import { ClaudeCodeSkillMaterializer, OS_SKILL_PREFIX } from '../skills/materializer'
import { netFetch } from '../skills/net-fetch'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { readSkillFile } from '../skills/skill-files'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { provisionAppClaudeConfigDir } from './claude-config-provision'
import type { SettingsRepository } from './repository'

type SkillCatalogEntry = { name: string; description: string; path: string }
type AdditionalSkillCatalogEntry = Omit<SkillCatalogEntry, 'path'> & { directory: string }
type AdditionalSkillCatalogEntries =
  | readonly AdditionalSkillCatalogEntry[]
  | (() => Promise<readonly AdditionalSkillCatalogEntry[]>)

type SkillCatalogModuleOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir?: string
  userCodexDir?: string
  userAgentsDir?: string
  skillRegistry?: SkillRegistry
  userSkills?: UserSkillRepository
}

// Owns the installed Skill catalog and its filesystem rules. SettingsService remains a compatibility
// facade for existing Electron, Web, CLI, IPC, runtime, and Specialist callers.
class SkillCatalogModule {
  private readonly skillRegistry: SkillRegistry
  private readonly userSkills: UserSkillRepository

  constructor(private readonly options: SkillCatalogModuleOptions) {
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.userSkills = options.userSkills ?? new UserSkillRepository(options.storageRoot)
  }

  private async catalog(): Promise<BundledSkill[]> {
    const [featured, user] = await Promise.all([this.skillRegistry.list(), this.userSkills.list()])
    return [...featured, ...user]
  }

  async listSkills(): Promise<SkillView[]> {
    const [skills, settings] = await Promise.all([
      this.catalog(),
      this.options.repository.getSettings()
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])
    return skills.map((skill) => this.toSkillView(skill, disabled))
  }

  async listSpecialistSkillCatalog(): Promise<
    Array<{ id: string; frameworkName: string; displayName: string }>
  > {
    return (await this.catalog()).map((skill) => ({
      id: skill.id,
      frameworkName: skill.source === 'featured' ? skill.id : skill.name,
      displayName: skill.name
    }))
  }

  async skillsNeedingForceLoad(ids: string[]): Promise<string[]> {
    const disabled = new Set(
      (await this.options.repository.getSettings()).disabledSkillIds ?? []
    )
    return ids.filter((id) => disabled.has(id))
  }

  async skillNudgeNamesForIds(ids: string[]): Promise<string[]> {
    const nameById = new Map(
      (await this.catalog()).map((skill) => [
        skill.id,
        skill.source === 'featured' ? skill.id : skill.name
      ])
    )
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
    const byId = new Map((await this.catalog()).map((skill) => [skill.id, skill] as const))
    const descriptors: Array<{ name: string; path: string }> = []
    for (const id of [...new Set(ids)]) {
      const skill = byId.get(id)
      if (!skill) continue
      const filePath = join(skillsRoot, `${OS_SKILL_PREFIX}${skill.id}`, 'SKILL.md')
      const realFile = await realpath(filePath).catch(() => undefined)
      if (!realFile || !realFile.startsWith(rootWithSep)) continue
      descriptors.push({
        name: skill.source === 'featured' ? skill.id : skill.name,
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
    const realRoot = await realpath(skillsRoot).catch(() => undefined)
    if (!realRoot) return []
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    const [skills, settings, extensions] = await Promise.all([
      this.catalog(),
      this.options.repository.getSettings(),
      typeof additionalEntries === 'function' ? additionalEntries() : additionalEntries
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])
    const enabled = [
      ...skills
        .filter((skill) => !disabled.has(skill.id))
        .map((skill) => ({
          directory: `${OS_SKILL_PREFIX}${skill.id}`,
          name: skill.source === 'featured' ? skill.id : skill.name,
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
      result.push({ name: item.name, description: item.description, path: filePath })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getSkillDetail(id: string): Promise<SkillDetailView> {
    const [skills, settings] = await Promise.all([
      this.catalog(),
      this.options.repository.getSettings()
    ])
    const skill = skills.find((entry) => entry.id === id)
    if (!skill) throw new Error(`Unknown skill: ${id}`)
    const { fields, body } = await readSkillFile(skill.sourceDir)
    return {
      ...this.toSkillView(skill, new Set(settings.disabledSkillIds ?? [])),
      body,
      metadata: Object.fromEntries(
        Object.entries(fields).filter(([key]) => key !== 'name' && key !== 'description')
      ),
      references: await this.listReferences(skill.sourceDir)
    }
  }

  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    await this.options.repository.setSkillEnabled(request.id, request.enabled)
    return this.listSkills()
  }

  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.createPersonal(request, request.slug)
    return this.listSkills()
  }

  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.updatePersonal(request.id, {
      name: request.name,
      description: request.description,
      body: request.body,
      metadata: request.metadata,
      references: request.references
    })
    return this.listSkills()
  }

  async deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]> {
    await this.userSkills.delete(request.id)
    await this.options.repository.setSkillEnabled(request.id, true)
    return this.listSkills()
  }

  async importSkill(request: ImportSkillRequest): Promise<ImportSkillResult> {
    const outcome = await this.userSkills.importFromGitHub(request.url, netFetch)
    return { ...outcome, skills: await this.listSkills() }
  }

  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    const zip = decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    const outcome = await this.userSkills.importFromZip(zip, {
      subPath: request.subPath,
      replaceId: request.replaceId
    })
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
    return this.userSkills.importFromZipBatch(zip, items)
  }

  async previewGitHubSkill(
    request: PreviewGitHubSkillRequest
  ): Promise<SkillImportPreviewContent> {
    const location = parseGitHubSkillUrl(request.url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')
    const preview = await this.userSkills.previewGitHubSkill(request.url, netFetch)
    const suffix = location.path ? `/${location.path}` : ''
    const revision = location.ref ? `@${location.ref}` : ''
    return {
      ...preview,
      sourceLabel: `github.com/${location.owner}/${location.repo}${revision}${suffix}`
    }
  }

  async scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult> {
    return { skills: await this.userSkills.scanRepo(request.repo, netFetch) }
  }

  async materializeSkills(
    configRoot: string,
    disabledIds: readonly string[],
    forcedIds: ReadonlySet<string> = new Set()
  ): Promise<void> {
    const disabled = new Set(disabledIds.filter((id) => !forcedIds.has(id)))
    await new ClaudeCodeSkillMaterializer().sync(
      configRoot,
      (await this.catalog()).filter((skill) => !disabled.has(skill.id))
    )
  }

  async provisionClaudeConfig(configDir: string, disabledSkillIds: string[]): Promise<void> {
    await provisionAppClaudeConfigDir(configDir, {
      skills: await this.catalog(),
      disabledSkillIds
    })
  }

  private allowedCodexSkillsRoot(codexHome: string): string | undefined {
    const requested = resolve(codexHome)
    const allowed = new Set([
      resolve(codexStorageDir(this.options.storageRoot)),
      resolve(codexSubscriptionStorageDir(this.options.storageRoot))
    ])
    return allowed.has(requested) ? join(requested, 'skills') : undefined
  }

  private async listReferences(sourceDir: string): Promise<{ path: string }[]> {
    try {
      return (await readdir(join(sourceDir, 'references'), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => ({ path: entry.name }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch {
      return []
    }
  }

  private toSkillView(skill: BundledSkill, disabled: Set<string>): SkillView {
    return {
      id: skill.id,
      name: skill.name,
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
export type { AdditionalSkillCatalogEntry, SkillCatalogModuleOptions }
