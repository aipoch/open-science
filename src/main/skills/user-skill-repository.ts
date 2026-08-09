import { createHash } from 'node:crypto'
import { cp, lstat, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type {
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  SkillBundlePreviewResult
} from '../../shared/settings'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import type { FetchLike, ScannedSkill } from './github-import'
import { parseSkillDocument } from './frontmatter'
import type { BundledSkill } from './registry'
import {
  SkillBundleImportOwner,
  type ImportOutcome,
  type ParsedSkillPreview
} from './skill-bundle-import-owner'
import {
  SOURCE_MANIFEST,
  SkillPackageTransactionOwner,
  type SkillMutationOwner,
  type StagedSkillPackage
} from './skill-package-transaction-owner'
import {
  SAFE_SLUG,
  UserSkillStore,
  assertUsableSlug,
  frontmatterBlock,
  parseUserSkillId,
  toSlug,
  type WriteSkillInput
} from './user-skill-store'

export type { ImportOutcome } from './skill-bundle-import-owner'

type ImportedAgentHomeIdentitySnapshot = {
  importedSlug: string
  agentHome: AgentHomeSkillRef
  signature: string
}

const agentHomeKey = (skill: AgentHomeSkillRef): string => `${skill.source}:${skill.slug}`

type AgentHomeTreeEntry =
  | { kind: 'directory'; relativePath: string; mode: number }
  | { kind: 'file'; path: string; relativePath: string; mode: number; size: number }

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

const parsedSkillPreview = (
  raw: string,
  files: string[],
  fallbackName: string
): ParsedSkillPreview => {
  const { name: frontmatterName, description = '', metadata, body } = parseSkillDocument(raw)
  return {
    name: frontmatterName?.trim() || fallbackName,
    description,
    metadata,
    body,
    files: [...files].sort()
  }
}

// Reads and writes user-authored (personal) and imported skills under `<storageRoot>/skills/`.
class UserSkillRepository {
  private readonly transactions: SkillPackageTransactionOwner
  private readonly store: UserSkillStore
  private readonly bundleImports: SkillBundleImportOwner

  constructor(storageRoot: string, mutationOwner?: SkillMutationOwner) {
    this.transactions = new SkillPackageTransactionOwner(storageRoot, mutationOwner)
    this.store = new UserSkillStore(storageRoot, this.transactions)
    this.bundleImports = new SkillBundleImportOwner(this.store, this.transactions)
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
    return this.store.publishPersonalDirectory(
      requestedSlug,
      sourcePath,
      overwrite,
      async (staging) => {
        const entries = await this.inspectAgentHomeSkill(staging)
        if (!entries.some((entry) => entry.kind === 'file' && entry.relativePath === 'SKILL.md')) {
          throw new Error('A published Skill must contain SKILL.md at its root.')
        }
      }
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
  private async importedAgentHomeSignatures(): Promise<
    Map<string, { importedSlug: string; signature?: string }>
  > {
    const signatures = new Map<string, { importedSlug: string; signature?: string }>()
    for (const slug of await this.store.listSlugs('imported')) {
      const source = await this.transactions.readImportedSource(slug)
      if (source?.agentHome) {
        signatures.set(agentHomeKey(source.agentHome), {
          importedSlug: slug,
          signature: source.signature
        })
      }
    }
    return signatures
  }

  private async fallbackImportedSignatures(
    candidateSlugs: ReadonlySet<string>
  ): Promise<Map<string, string>> {
    const signatures = new Map<string, string>()
    for (const slug of await this.store.listSlugs('imported')) {
      if (!candidateSlugs.has(slug)) continue
      if ((await this.transactions.readImportedSource(slug))?.agentHome) continue
      try {
        signatures.set(
          slug,
          await this.signatureOfAgentHomeSkill(this.store.skillDir('imported', slug), {
            skipSourceManifest: true
          })
        )
      } catch {
        // A malformed imported tree cannot safely stand in for an installed skill. Leave it as an
        // independent record so a healthy same-slug installed skill remains importable.
      }
    }
    return signatures
  }

  // Matches source identities and legacy records against a caller-resolved directory. Settings uses
  // this only after realpath containment succeeds, allowing safe root aliases to share one canonical
  // signature without weakening nested-symlink rejection. Metadata-less records match by both slug
  // and content, so an unrelated GitHub/ZIP import cannot suppress a local installed skill.
  async matchImportedAgentHomeSkills(
    candidates: readonly {
      sourcePath: string
      canonical: AgentHomeSkillRef
      aliases: readonly AgentHomeSkillRef[]
    }[]
  ): Promise<
    {
      identityImported: boolean
      identityMigrationNeeded: boolean
      matchedIdentitySignature?: string
      matchedImportedIdentity?: ImportedAgentHomeIdentitySnapshot
      fallbackAliases: AgentHomeSkillRef[]
    }[]
  > {
    const candidateSlugs = new Set(
      candidates.flatMap((candidate) => candidate.aliases.map((alias) => alias.slug))
    )
    const [imported, fallbackSignatures] = await Promise.all([
      this.importedAgentHomeSignatures(),
      this.fallbackImportedSignatures(candidateSlugs)
    ])

    return Promise.all(
      candidates.map(async ({ sourcePath, canonical, aliases }) => {
        const identityRecords = aliases.flatMap((alias) => {
          const record = imported.get(agentHomeKey(alias))
          return typeof record?.signature === 'string' ? [{ alias, ...record }] : []
        })
        const fallbackAliases = aliases.filter((alias) => fallbackSignatures.has(alias.slug))
        if (identityRecords.length === 0 && fallbackAliases.length === 0) {
          return {
            identityImported: false,
            identityMigrationNeeded: false,
            matchedIdentitySignature: undefined,
            matchedImportedIdentity: undefined,
            fallbackAliases: []
          }
        }

        try {
          const signature = await this.signatureOfAgentHomeSkill(sourcePath)
          const matchingIdentities: (typeof identityRecords)[number][] = []
          for (const record of identityRecords) {
            if (record.signature !== signature) continue
            try {
              const importedSignature = await this.signatureOfAgentHomeSkill(
                this.store.skillDir('imported', record.importedSlug),
                { skipSourceManifest: true }
              )
              if (importedSignature === signature) matchingIdentities.push(record)
            } catch {
              // A missing or malformed imported tree cannot be migrated automatically. Leave the
              // discovered row selectable so a deliberate import can repair it.
            }
          }
          const canonicalKey = agentHomeKey(canonical)
          const canonicalMatched = matchingIdentities.some(
            ({ alias }) => agentHomeKey(alias) === canonicalKey
          )
          const migrationMatch = canonicalMatched ? undefined : matchingIdentities[0]
          return {
            identityImported: matchingIdentities.length > 0,
            identityMigrationNeeded: migrationMatch !== undefined,
            matchedIdentitySignature: matchingIdentities.length > 0 ? signature : undefined,
            matchedImportedIdentity: migrationMatch
              ? {
                  importedSlug: migrationMatch.importedSlug,
                  agentHome: migrationMatch.alias,
                  signature
                }
              : undefined,
            fallbackAliases: fallbackAliases.filter(
              (alias) => fallbackSignatures.get(alias.slug) === signature
            )
          }
        } catch {
          return {
            identityImported: false,
            identityMigrationNeeded: false,
            matchedIdentitySignature: undefined,
            matchedImportedIdentity: undefined,
            fallbackAliases: []
          }
        }
      })
    )
  }

  private async findImportedSlugByAgentHome(
    skill: AgentHomeSkillRef,
    aliases: readonly AgentHomeSkillRef[]
  ): Promise<string | undefined> {
    const acceptedKeys = new Set([skill, ...aliases].map(agentHomeKey))
    for (const slug of await this.store.listSlugs('imported')) {
      const source = await this.transactions.readImportedSource(slug)
      if (source?.agentHome && acceptedKeys.has(agentHomeKey(source.agentHome))) {
        return slug
      }
    }
    return undefined
  }

  private async findFallbackImportedSlug(
    fallbackSlugs: ReadonlySet<string>,
    sourceSignature: string
  ): Promise<string | undefined> {
    for (const slug of await this.store.listSlugs('imported')) {
      if (!fallbackSlugs.has(slug)) continue
      if ((await this.transactions.readImportedSource(slug))?.agentHome) continue
      try {
        const importedSignature = await this.signatureOfAgentHomeSkill(
          this.store.skillDir('imported', slug),
          { skipSourceManifest: true }
        )
        if (importedSignature === sourceSignature) return slug
      } catch {
        // A malformed metadata-less record is not a safe fallback match.
      }
    }
    return undefined
  }

  // One structural inspection path serves installed-skill scan signatures, import validation, and
  // candidate previews. It never follows symlinks, emits archive-style relative paths on every OS,
  // and enforces the shared depth/count/size caps before any caller reads file contents.
  private async inspectAgentHomeSkill(
    root: string,
    options: { skipSourceManifest?: boolean } = {}
  ): Promise<AgentHomeTreeEntry[]> {
    const entries: AgentHomeTreeEntry[] = []
    let declaredTotal = 0
    let fileCount = 0

    const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
      const dirStat = await lstat(dir)
      if (dirStat.isSymbolicLink()) {
        throw new Error('Refusing to read an agent-home Skill containing a symbolic link.')
      }
      if (!dirStat.isDirectory()) throw new Error('Agent-home Skill source must be a directory.')
      if (depth > SKILL_IMPORT_LIMITS.maxDepth) {
        throw new Error(`Agent-home Skill exceeds the maximum directory depth.`)
      }
      entries.push({ kind: 'directory', relativePath: prefix, mode: dirStat.mode & 0o777 })

      const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      for (const entry of children) {
        const path = join(dir, entry.name)
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const entryStat = await lstat(path)
        if (entryStat.isSymbolicLink()) {
          throw new Error('Refusing to read an agent-home Skill containing a symbolic link.')
        }
        if (entryStat.isDirectory()) {
          await visit(path, relativePath, depth + 1)
          continue
        }
        if (!entryStat.isFile()) {
          throw new Error(`Agent-home Skill contains an unsupported filesystem entry.`)
        }
        if (relativePath === SOURCE_MANIFEST) {
          if (options.skipSourceManifest) continue
          throw new Error(`Skill import may not include the reserved file ${SOURCE_MANIFEST}.`)
        }
        if (fileCount >= SKILL_IMPORT_LIMITS.maxFiles) {
          throw new Error(`Agent-home Skill has more than ${SKILL_IMPORT_LIMITS.maxFiles} files.`)
        }
        if (entryStat.size > SKILL_IMPORT_LIMITS.maxFileBytes) {
          throw new Error(
            `Agent-home Skill contains a file over ${mb(SKILL_IMPORT_LIMITS.maxFileBytes)}.`
          )
        }
        declaredTotal += entryStat.size
        if (declaredTotal > SKILL_IMPORT_LIMITS.maxTotalBytes) {
          throw new Error(`Agent-home Skill exceeds ${mb(SKILL_IMPORT_LIMITS.maxTotalBytes)}.`)
        }
        fileCount += 1
        entries.push({
          kind: 'file',
          path,
          relativePath,
          mode: entryStat.mode & 0o777,
          size: entryStat.size
        })
      }
    }

    await visit(root, '', 0)
    return entries
  }

  // Hashes one installed-skill tree without following symlinks. Paths use archive-style `/`
  // separators so the same tree has the same identity on Windows and POSIX; directory entries and
  // portable permission bits are included because cp preserves empty directories and executable
  // scripts. Applying the shared per-skill caps also bounds local scan reads.
  private async signatureOfAgentHomeSkill(
    root: string,
    options: { skipSourceManifest?: boolean } = {}
  ): Promise<string> {
    const entries = await this.inspectAgentHomeSkill(root, options)

    const hash = createHash('sha256')
    let actualTotal = 0
    for (const entry of entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      hash.update(entry.kind)
      hash.update('\0')
      hash.update(entry.relativePath)
      hash.update('\0')
      hash.update(entry.mode.toString(8))
      hash.update('\0')
      if (entry.kind === 'directory') continue

      const content = await readFile(entry.path)
      if (content.length > SKILL_IMPORT_LIMITS.maxFileBytes) {
        throw new Error(
          `Agent-home Skill contains a file over ${mb(SKILL_IMPORT_LIMITS.maxFileBytes)}.`
        )
      }
      actualTotal += content.length
      if (actualTotal > SKILL_IMPORT_LIMITS.maxTotalBytes) {
        throw new Error(`Agent-home Skill exceeds ${mb(SKILL_IMPORT_LIMITS.maxTotalBytes)}.`)
      }
      hash.update(content)
      hash.update('\0')
    }
    return hash.digest('hex')
  }

  // Copies a local installed skill into a sibling staging directory, validates the copied snapshot,
  // and records both its stable source identity and content signature. The caller decides whether
  // that snapshot is unchanged or should be promoted over the live imported copy.
  private async stageAgentHomeSkill(
    slug: string,
    sourcePath: string,
    skill: AgentHomeSkillRef
  ): Promise<StagedSkillPackage & { signature: string }> {
    let signature = ''
    const staged = await this.transactions.stage('imported', slug, async (staging) => {
      await cp(sourcePath, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (entry) => {
          if (resolve(entry) === resolve(sourcePath, SOURCE_MANIFEST)) {
            throw new Error(`Skill import may not include the reserved file ${SOURCE_MANIFEST}.`)
          }
          if ((await lstat(entry)).isSymbolicLink()) {
            throw new Error(`Refusing to import an agent-home Skill containing a symbolic link.`)
          }
          return true
        }
      })
      signature = await this.signatureOfAgentHomeSkill(staging)
      await this.transactions.writeSourceManifest(staging, { signature, agentHome: skill })
    })
    return { ...staged, signature }
  }

  // Lists the skill directories under a machine-level agent home (typically ~/.claude/skills/).
  // A candidate must be a safe-slug directory with a readable SKILL.md; arbitrary sibling folders
  // are not import choices. Frontmatter supplies the displayed name/description, while the directory
  // name remains the stable slug. Hidden transaction directories are ignored.
  async listAgentHomeSkills(
    homeSkillsDir: string,
    source: AgentHomeSkillSource
  ): Promise<
    {
      slug: string
      name: string
      description: string
      path: string
      alreadyImported: boolean
    }[]
  > {
    let entries: string[] = []

    try {
      entries = (await readdir(homeSkillsDir, { withFileTypes: true }))
        .filter(
          (entry) => (entry.isDirectory() || entry.isSymbolicLink()) && SAFE_SLUG.test(entry.name)
        )
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      // A missing agent home just means "nothing to import"; surface other errors so a corrupt
      // permissions state can't silently hide skills the user expects to see.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []

      throw error
    }

    // Cross-check existing source identities once (rather than per row) so the "already imported"
    // badge distinguishes same-slug skills discovered in different global sources.
    const importedSkills = await this.importedAgentHomeSignatures()

    const out: {
      slug: string
      name: string
      description: string
      path: string
      alreadyImported: boolean
    }[] = []
    for (const slug of entries) {
      const path = join(homeSkillsDir, slug)
      let name = slug
      let description = ''

      try {
        const parsed = parseSkillDocument(await readFile(join(path, 'SKILL.md'), 'utf8'))
        if (parsed.name) name = parsed.name
        if (parsed.description !== undefined) description = parsed.description
      } catch {
        continue
      }

      const key = agentHomeKey({ source, slug })
      let alreadyImported = false
      if (importedSkills.has(key)) {
        try {
          alreadyImported =
            importedSkills.get(key)?.signature === (await this.signatureOfAgentHomeSkill(path))
        } catch {
          // Keep a readable row selectable. Import performs the same validation and reports a
          // per-item error, rather than one malformed installed tree hiding the rest of the scan.
          alreadyImported = false
        }
      }

      out.push({
        slug,
        name,
        description,
        path,
        alreadyImported
      })
    }

    return out
  }

  // Reads a selected installed skill for preview without copying it. The same structural limits and
  // symlink policy as import apply before SKILL.md is returned, while only renderer-safe relative file
  // names and parsed content leave this repository interface.
  async previewAgentHomeSkill(root: string): Promise<ParsedSkillPreview> {
    const entries = await this.inspectAgentHomeSkill(root)
    const files = entries.filter(
      (entry): entry is Extract<AgentHomeTreeEntry, { kind: 'file' }> => entry.kind === 'file'
    )
    const skillMd = files.find((file) => file.relativePath === 'SKILL.md')
    if (!skillMd) throw new Error('Agent-home Skill must contain a SKILL.md.')
    const previewTooLarge = (): never => {
      throw new Error(
        `Agent-home Skill preview exceeds the ${mb(SKILL_IMPORT_LIMITS.maxPreviewContentBytes)} limit.`
      )
    }
    if (skillMd.size > SKILL_IMPORT_LIMITS.maxPreviewContentBytes) previewTooLarge()
    const raw = await readFile(skillMd.path, 'utf8')
    if (Buffer.byteLength(raw) > SKILL_IMPORT_LIMITS.maxPreviewContentBytes) previewTooLarge()

    return parsedSkillPreview(
      raw,
      files.map((file) => file.relativePath),
      basename(root)
    )
  }

  // Imports a single agent-home skill by copying its source subtree under the imported-skill store.
  // The copy preserves the directory layout (SKILL.md + references/) so the skill is byte-for-byte
  // the same shape Open Science would have produced from a fresh in-app edit. Suffix allocation
  // mirrors importFromZip: the same source identity is unchanged, while a same-name skill from a
  // different source gets `-2`, `-3`, ... appended and never clobbers an existing record.
  async importAgentHomeSkill(
    sourcePath: string,
    skill: AgentHomeSkillRef,
    options: {
      aliases?: readonly AgentHomeSkillRef[]
      fallbackSlugs?: readonly string[]
      expectedSignature?: string
      expectedImportedIdentity?: ImportedAgentHomeIdentitySnapshot
    } = {}
  ): Promise<ImportOutcome> {
    const requestedSlug = skill.slug
    if (!SAFE_SLUG.test(requestedSlug)) {
      throw new Error(`Refusing to import agent-home skill with unsafe slug: ${requestedSlug}`)
    }

    // Stat the source up front so a missing path fails loudly instead of leaving a half-copied
    // destination behind. The caller (IPC layer) is expected to pass paths that came from
    // listAgentHomeSkills, so ENOENT here is a real bug, not a benign race.
    try {
      await stat(sourcePath)
    } catch (error) {
      throw new Error(
        `Agent-home skill path is not available: ${sourcePath} (${String((error as NodeJS.ErrnoException).code ?? error)})`
      )
    }

    return this.transactions.runRecovered(async () => {
      const existingSlug = await this.findImportedSlugByAgentHome(skill, options.aliases ?? [])
      const slug = existingSlug ?? (await this.store.uniqueSlug('imported', requestedSlug))
      const staged = await this.stageAgentHomeSkill(slug, sourcePath, skill)
      try {
        if (options.expectedImportedIdentity) {
          const expected = options.expectedImportedIdentity
          const current = await this.transactions.readImportedSource(expected.importedSlug)
          let currentTreeSignature: string | undefined
          try {
            currentTreeSignature = await this.signatureOfAgentHomeSkill(
              this.store.skillDir('imported', expected.importedSlug),
              { skipSourceManifest: true }
            )
          } catch {
            // Report every missing or malformed expected record as the same stale-scan condition.
          }
          if (
            existingSlug !== expected.importedSlug ||
            !current?.agentHome ||
            agentHomeKey(current.agentHome) !== agentHomeKey(expected.agentHome) ||
            current.signature !== expected.signature ||
            currentTreeSignature !== expected.signature
          ) {
            throw new Error('Imported skill changed during canonical identity migration.')
          }
        }
        if (options.expectedSignature && staged.signature !== options.expectedSignature) {
          throw new Error('Installed skill changed during canonical identity migration.')
        }
        if (!existingSlug) {
          const fallbackSlug = await this.findFallbackImportedSlug(
            new Set(options.fallbackSlugs ?? []),
            staged.signature
          )
          if (fallbackSlug) {
            await this.transactions.discard(staged)
            return { status: 'unchanged', id: `imported-${fallbackSlug}` }
          }
        }

        const existing = existingSlug
          ? await this.transactions.readImportedSource(existingSlug)
          : null
        const identityUnchanged =
          existing?.agentHome && agentHomeKey(existing.agentHome) === agentHomeKey(skill)
        if (existingSlug && identityUnchanged && existing.signature === staged.signature) {
          await this.transactions.discard(staged)
          return { status: 'unchanged', id: `imported-${existingSlug}` }
        }

        await this.transactions.promote(staged)
        return {
          status: existingSlug ? 'updated' : 'imported',
          id: `imported-${slug}`
        }
      } catch (error) {
        await this.transactions.discard(staged)
        throw error
      }
    })
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
