import type {
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  SkillBundlePreviewResult
} from '../../shared/settings'
import {
  AgentHomeSkillOwner,
  type AgentHomeImportOptions,
  type AgentHomeMatchCandidate,
  type AgentHomeMatchResult,
  type AgentHomeSkillSummary
} from './agent-home-skill-owner'
import type { FetchLike, GitHubFetchOptions, ScannedSkill } from './github-import'
import type { BundledSkill } from './registry'
import { SkillBundleImportOwner } from './skill-bundle-import-owner'
import {
  SkillPackageTransactionOwner,
  type SkillMutationOwner
} from './skill-package-transaction-owner'
import type { ImportOutcome, ParsedSkillPreview } from './user-skill-import-contracts'
import { UserSkillCompatibilityIndex } from './user-skill-compatibility-index'
import {
  SAFE_SKILL_DIRECTORY_NAME,
  SAFE_SKILL_NAME,
  UserSkillStore,
  assertUsableSkillName,
  frontmatterBlock,
  isReservedSkillName,
  parseUserSkillId,
  normalizeSkillName,
  type WriteSkillInput
} from './user-skill-store'

export type { ImportOutcome } from './user-skill-import-contracts'

// Reads and writes user-authored (personal) and imported skills under `<storageRoot>/skills/`.
class UserSkillRepository {
  private readonly transactions: SkillPackageTransactionOwner
  private readonly compatibilityIndex: UserSkillCompatibilityIndex
  private readonly store: UserSkillStore
  private readonly bundleImports: SkillBundleImportOwner
  private readonly agentHomeSkills: AgentHomeSkillOwner

  constructor(
    storageRoot: string,
    mutationOwner?: SkillMutationOwner,
    validatePromotion?: (list: () => Promise<BundledSkill[]>) => Promise<void>
  ) {
    this.transactions = new SkillPackageTransactionOwner(storageRoot, mutationOwner)
    this.compatibilityIndex = new UserSkillCompatibilityIndex(storageRoot)
    this.store = new UserSkillStore(storageRoot, this.transactions, this.compatibilityIndex)
    this.bundleImports = new SkillBundleImportOwner(this.store, this.transactions)
    this.agentHomeSkills = new AgentHomeSkillOwner(this.store, this.transactions)
    if (validatePromotion) {
      this.transactions.setPromotedValidator(() =>
        validatePromotion(() => this.store.listSkillsLocked())
      )
    }
  }

  // Lists every personal + imported skill, skipping any dir whose SKILL.md is missing/unreadable. The
  // whole read runs under the lock, after recovery, so it can't observe a live dir mid-swap (a rename
  // to/from a backup) and drop or duplicate an entry.
  async list(): Promise<BundledSkill[]> {
    return this.store.list()
  }

  // Keeps a user-Skill filesystem read inside the same owner lock as create, update, import, delete,
  // and transaction recovery. The callback must finish reading before it returns; sourceDir is not a
  // stable snapshot once this method settles.
  async withSkillReadLock<T>(
    id: string,
    read: (skill: BundledSkill) => Promise<T>
  ): Promise<T | undefined> {
    return this.store.withSkillReadLock(id, read)
  }

  // Returns one user skill's SKILL.md body (frontmatter stripped). Recovery + read run under the lock
  // so a concurrent replace can't rename the live dir out from under the read (transient ENOENT).
  async body(id: string): Promise<string> {
    return this.store.body(id)
  }

  // Creates a personal skill whose immutable name is also its package directory name.
  async createPersonal(
    input: WriteSkillInput,
    reservedNames: readonly string[] = []
  ): Promise<string> {
    return this.store.createPersonal(input, reservedNames)
  }

  // Publishes an app-authored draft as a complete Personal Skill package. Unlike the form editor,
  // this path preserves arbitrary safe files (scripts/, assets/, nested references, and so on).
  // The source is validated and copied into a sibling staging directory before the live package is
  // swapped, so a failed copy or replace never exposes a partial Skill.
  async publishPersonalDirectory(
    name: string,
    sourcePath: string,
    overwrite = false,
    reservedNames: readonly string[] = []
  ): Promise<string> {
    return this.store.publishPersonalDirectory(
      name,
      sourcePath,
      overwrite,
      (staging) => this.agentHomeSkills.validatePublishedSkillPackage(staging),
      reservedNames
    )
  }

  // Replaces an existing personal skill through the shared staged package transaction.
  async updatePersonal(id: string, input: WriteSkillInput): Promise<void> {
    return this.store.updatePersonal(id, input)
  }

  // Deletes a personal or imported skill directory.
  async delete(id: string, guard?: (skillId: string) => Promise<void>): Promise<void> {
    return this.store.delete(id, guard)
  }

  async importFromGitHub(
    url: string,
    fetchImpl?: FetchLike,
    reservedNames: readonly string[] = [],
    options: GitHubFetchOptions = {}
  ): Promise<ImportOutcome> {
    return this.bundleImports.importFromGitHub(url, fetchImpl, reservedNames, options)
  }

  async previewGitHubSkill(
    url: string,
    fetchImpl?: FetchLike,
    options: GitHubFetchOptions = {}
  ): Promise<ParsedSkillPreview> {
    return this.bundleImports.previewGitHubSkill(url, fetchImpl, options)
  }

  async previewZip(zip: Buffer): Promise<SkillBundlePreviewResult> {
    return this.bundleImports.previewZip(zip)
  }

  async importFromZip(
    zip: Buffer,
    options: { subPath?: string; replaceId?: string; reservedNames?: readonly string[] } = {}
  ): Promise<ImportOutcome> {
    return this.bundleImports.importFromZip(zip, options)
  }

  async importFromZipBatch(
    zip: Buffer,
    items: { subPath: string; replaceId?: string }[],
    reservedNames: readonly string[] = []
  ): Promise<{ subPath: string; outcome?: ImportOutcome; error?: string }[]> {
    return this.bundleImports.importFromZipBatch(zip, items, reservedNames)
  }

  async scanRepo(
    repoInput: string,
    fetchImpl?: FetchLike,
    options: GitHubFetchOptions = {}
  ): Promise<(ScannedSkill & { alreadyImported: boolean })[]> {
    return this.bundleImports.scanRepo(repoInput, fetchImpl, options)
  }

  async matchImportedAgentHomeSkills(
    candidates: readonly AgentHomeMatchCandidate[]
  ): Promise<AgentHomeMatchResult[]> {
    return this.agentHomeSkills.matchImportedAgentHomeSkills(candidates)
  }

  async listAgentHomeSkills(
    homeSkillsDir: string,
    source: AgentHomeSkillSource
  ): Promise<AgentHomeSkillSummary[]> {
    return this.agentHomeSkills.listAgentHomeSkills(homeSkillsDir, source)
  }

  async previewAgentHomeSkill(root: string): Promise<ParsedSkillPreview> {
    return this.agentHomeSkills.previewAgentHomeSkill(root)
  }

  async importAgentHomeSkill(
    sourcePath: string,
    skill: AgentHomeSkillRef,
    options: AgentHomeImportOptions = {}
  ): Promise<ImportOutcome> {
    return this.agentHomeSkills.importAgentHomeSkill(sourcePath, skill, options)
  }
}

export {
  SAFE_SKILL_DIRECTORY_NAME,
  SAFE_SKILL_NAME,
  UserSkillRepository,
  assertUsableSkillName,
  frontmatterBlock,
  isReservedSkillName,
  normalizeSkillName,
  parseUserSkillId
}
