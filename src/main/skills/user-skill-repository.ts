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
import type { FetchLike, ScannedSkill } from './github-import'
import type { BundledSkill } from './registry'
import { SkillBundleImportOwner } from './skill-bundle-import-owner'
import {
  SkillPackageTransactionOwner,
  type SkillMutationOwner
} from './skill-package-transaction-owner'
import type { ImportOutcome, ParsedSkillPreview } from './user-skill-import-contracts'
import {
  SAFE_SLUG,
  UserSkillStore,
  assertUsableSlug,
  frontmatterBlock,
  parseUserSkillId,
  toSlug,
  type WriteSkillInput
} from './user-skill-store'

export type { ImportOutcome } from './user-skill-import-contracts'

// Reads and writes user-authored (personal) and imported skills under `<storageRoot>/skills/`.
class UserSkillRepository {
  private readonly transactions: SkillPackageTransactionOwner
  private readonly store: UserSkillStore
  private readonly bundleImports: SkillBundleImportOwner
  private readonly agentHomeSkills: AgentHomeSkillOwner

  constructor(storageRoot: string, mutationOwner?: SkillMutationOwner) {
    this.transactions = new SkillPackageTransactionOwner(storageRoot, mutationOwner)
    this.store = new UserSkillStore(storageRoot, this.transactions)
    this.bundleImports = new SkillBundleImportOwner(this.store, this.transactions)
    this.agentHomeSkills = new AgentHomeSkillOwner(this.store, this.transactions)
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

  // Creates a personal skill, returning its new id. With an explicit `requestedSlug`, that slug is
  // used verbatim (validated, and rejected if already taken); otherwise a slug is derived from the
  // name and collisions get a numeric suffix.
  async createPersonal(input: WriteSkillInput, requestedSlug?: string): Promise<string> {
    return this.store.createPersonal(input, requestedSlug)
  }

  // Publishes an app-authored draft as a complete Personal Skill package. Unlike the form editor,
  // this path preserves arbitrary safe files (scripts/, assets/, nested references, and so on).
  // The source is validated and copied into a sibling staging directory before the live package is
  // swapped, so a failed copy or replace never exposes a partial Skill.
  async publishPersonalDirectory(
    requestedSlug: string,
    sourcePath: string,
    overwrite = false
  ): Promise<string> {
    return this.store.publishPersonalDirectory(requestedSlug, sourcePath, overwrite, (staging) =>
      this.agentHomeSkills.validatePublishedSkillPackage(staging)
    )
  }

  // Rewrites an existing personal skill's SKILL.md in place.
  async updatePersonal(id: string, input: WriteSkillInput): Promise<void> {
    return this.store.updatePersonal(id, input)
  }

  // Deletes a personal or imported skill directory.
  async delete(id: string, guard?: (skillId: string) => Promise<void>): Promise<void> {
    return this.store.delete(id, guard)
  }

  async importFromGitHub(url: string, fetchImpl?: FetchLike): Promise<ImportOutcome> {
    return this.bundleImports.importFromGitHub(url, fetchImpl)
  }

  async previewGitHubSkill(url: string, fetchImpl?: FetchLike): Promise<ParsedSkillPreview> {
    return this.bundleImports.previewGitHubSkill(url, fetchImpl)
  }

  async previewZip(zip: Buffer): Promise<SkillBundlePreviewResult> {
    return this.bundleImports.previewZip(zip)
  }

  async importFromZip(
    zip: Buffer,
    options: { subPath?: string; replaceId?: string } = {}
  ): Promise<ImportOutcome> {
    return this.bundleImports.importFromZip(zip, options)
  }

  async importFromZipBatch(
    zip: Buffer,
    items: { subPath: string; replaceId?: string }[]
  ): Promise<{ subPath: string; outcome?: ImportOutcome; error?: string }[]> {
    return this.bundleImports.importFromZipBatch(zip, items)
  }

  async scanRepo(
    repoInput: string,
    fetchImpl?: FetchLike
  ): Promise<(ScannedSkill & { alreadyImported: boolean })[]> {
    return this.bundleImports.scanRepo(repoInput, fetchImpl)
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
  SAFE_SLUG,
  UserSkillRepository,
  assertUsableSlug,
  frontmatterBlock,
  parseUserSkillId,
  toSlug
}
