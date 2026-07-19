import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { dump as dumpYaml } from 'js-yaml'

import type {
  SkillBundlePreview,
  SkillBundlePreviewResult,
  SkillReference,
  SkillSource,
  SkippedSkill
} from '../../shared/settings'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { createLogger } from '../logger'
import {
  fetchSkillFiles,
  parseGitHubSkillUrl,
  parseGitHubRepo,
  scanRepoForSkills,
  type FetchLike,
  type FetchedSkillFile,
  type ScannedSkill
} from './github-import'
import { parseFrontmatter } from './frontmatter'
import type { BundledSkill } from './registry'
import { readSkillFile } from './skill-files'
import { extractZip, extractZipLenient } from './zip-extract'

const log = createLogger('skills')

// User skills live in writable app storage, one subdir per skill, grouped by source. Bundled (featured)
// skills stay read-only in resources and are handled by SkillRegistry instead.
const USER_SOURCES: ReadonlyArray<Extract<SkillSource, 'imported' | 'personal'>> = [
  'imported',
  'personal'
]

// Only lowercase slugs so a skill id maps 1:1 to a safe directory name.
const SAFE_SLUG = /^[a-z0-9-]+$/

// A transaction directory left by an in-progress replace (see writeImported): `.<slug>.import-<id>`
// holds the staged new copy, `.<slug>.backup-<id>` the previous copy moved aside during the swap.
// Both are hidden (leading dot) so they can never be a valid slug, and doRecoverImportedTransactions()
// finalizes or rolls them back if a crash left them behind.
const TRANSACTION_DIR = /^\.([a-z0-9-]+)\.(import|backup)-(.+)$/

// A sortable transaction generation: a fixed-width millisecond timestamp (lexical order == time order)
// plus a uuid for uniqueness. Recovery restores the newest backup when more than one exists for a slug.
const nextGeneration = (): string => `${Date.now().toString().padStart(15, '0')}-${randomUUID()}`

// Reserved id namespaces a user-authored skill may not claim: `os-` is the app's own materialized
// prefix and `mcp-` is reserved for MCP-provided skills.
const RESERVED_SLUG_PREFIXES = ['os-', 'mcp-'] as const

// Validates a user-chosen slug, throwing a user-facing error for empty, unsafe, or reserved values.
const assertUsableSlug = (slug: string): void => {
  if (!slug) throw new Error('Skill ID is required.')
  if (!SAFE_SLUG.test(slug)) {
    throw new Error('Skill ID may only contain lowercase letters, numbers, and hyphens.')
  }
  if (RESERVED_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) {
    throw new Error(`Skill ID may not start with ${RESERVED_SLUG_PREFIXES.join(' or ')}.`)
  }
}

// Builds a filesystem-safe slug from a display name (e.g. "My Skill!" -> "my-skill").
const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

// Serializes the SKILL.md frontmatter block from arbitrary user values. A hand-rolled emitter kept
// getting subtle YAML edge cases wrong (type coercion of `true`/`123`, trailing-newline handling,
// leading spaces), so this delegates to js-yaml: it quotes or block-escapes each value as needed so
// every field round-trips LOSSLESSLY and always as a string through any conformant YAML parser. The
// leading `---`/trailing `---` document markers are added by the caller. `lineWidth: -1` disables line
// folding so long descriptions aren't rewrapped (which would not be byte-lossless).
const frontmatterBlock = (fields: { name: string; description: string }): string =>
  dumpYaml(fields, { lineWidth: -1 })

// A skill id is `<source>-<slug>`; parse it back to its source + slug (null for bundled/unknown ids).
const parseUserSkillId = (
  id: string
): { source: (typeof USER_SOURCES)[number]; slug: string } | null => {
  for (const source of USER_SOURCES) {
    const prefix = `${source}-`
    if (id.startsWith(prefix)) {
      const slug = id.slice(prefix.length)
      if (SAFE_SLUG.test(slug)) return { source, slug }
    }
  }
  return null
}

type WriteSkillInput = {
  name: string
  description: string
  body: string
  references?: SkillReference[]
}

// Result of an import: whether it was newly imported, refreshed from an upstream change, or a no-op
// because the same source was already imported unchanged.
export type ImportOutcome = { status: 'imported' | 'unchanged' | 'updated'; id: string }

// Records the origin + content signature of an imported skill so re-imports can be deduplicated.
const SOURCE_MANIFEST = '.source.json'

// Content signature over every file (sorted by path) used to detect upstream changes on re-import.
const signatureOf = (files: FetchedSkillFile[]): string => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

// One skill root inside an archive: the directory prefix holding a SKILL.md, plus that skill's files
// re-based so SKILL.md sits at their root.
type SkillRoot = { subPath: string; files: FetchedSkillFile[] }

// Discovers every skill root in an extracted archive so a multi-skill bundle can be imported piecewise.
// A root is any directory directly holding a SKILL.md (case-insensitive) at 1-3 path segments (root,
// `*/SKILL.md`, or `*/*/SKILL.md`); deeper SKILL.md files are ignored. A root nested under a shallower
// one is dropped so a single skill is never counted twice. Archive paths always use forward slashes.
const findSkillRoots = (entries: { path: string; content: Buffer }[]): SkillRoot[] => {
  const candidates = new Set<string>()
  for (const entry of entries) {
    const segments = entry.path.split('/')
    if (segments[segments.length - 1].toLowerCase() !== 'skill.md') continue
    if (segments.length > 3) continue
    candidates.add(segments.slice(0, -1).join('/'))
  }

  // Keep only the shallowest root on each branch: a candidate under another (or under the archive
  // root '') is that skill's own file, not a separate skill.
  const all = [...candidates]
  const roots = all.filter(
    (subPath) =>
      !all.some((other) => other !== subPath && (other === '' || subPath.startsWith(`${other}/`)))
  )

  return roots
    .map((subPath) => {
      const prefix = subPath === '' ? '' : `${subPath}/`
      const files = entries
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ relativePath: entry.path.slice(prefix.length), content: entry.content }))
      return { subPath, files }
    })
    .sort((a, b) => a.subPath.localeCompare(b.subPath))
}

// True for an archive entry that is itself a skill bundle (a .zip / .skill nested inside the upload).
const isNestedArchive = (path: string): boolean => /\.(zip|skill)$/i.test(path)

// Strips the electron/main wrapper off an error so only the human-readable tail is shown as a reason.
const reasonFromError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, '') || 'unreadable'
}

// Rounds a byte count to whole MB for a user-facing size-limit reason.
const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

// Checks one skill's files against the PER-SKILL caps, returning a plain-English reason if it violates
// them (else null). The outer bundle walk uses generous bundle-wide caps, so a loose (directly-visible)
// skill root — which never goes through the strict extractZip path a nested archive does — must be
// re-validated here, otherwise a single-skill upload could sneak in an oversized file or total.
const perSkillCapReason = (files: FetchedSkillFile[]): string | null => {
  if (files.length > SKILL_IMPORT_LIMITS.maxFiles) {
    return `skill has more than ${SKILL_IMPORT_LIMITS.maxFiles} files`
  }
  if (files.some((file) => file.content.length > SKILL_IMPORT_LIMITS.maxFileBytes)) {
    return `contains a file over ${mb(SKILL_IMPORT_LIMITS.maxFileBytes)}`
  }
  const total = files.reduce((sum, file) => sum + file.content.length, 0)
  if (total > SKILL_IMPORT_LIMITS.maxTotalBytes) {
    return `skill exceeds ${mb(SKILL_IMPORT_LIMITS.maxTotalBytes)}`
  }
  return null
}

// The outcome of scanning a bundle: the skill roots we can import, plus the ones we skipped and why.
type SkillDiscovery = { roots: SkillRoot[]; skipped: SkippedSkill[] }

// Discovers every importable skill in an uploaded bundle, resilient to individual failures. Direct
// SKILL.md roots (a plain skill dir, or a bundle of sibling skill dirs) are found as before; any entry
// that is itself a .zip/.skill is unpacked ONE level deeper and its root(s) surfaced under a subPath
// namespaced by the FULL archive path (so a nested `alpha.zip` can't collide with a loose `alpha/`
// dir). An entry that's too large, unreadable, holds no SKILL.md, or (for a loose root) violates the
// per-skill caps is recorded as skipped rather than failing the whole bundle. Nesting beyond one
// archive level is not followed, which bounds recursion. subPaths are made unique so preview rows,
// renderer keys, and batch-import selection never alias two different skills onto one key.
const discoverSkillRoots = (zip: Buffer): SkillDiscovery => {
  const skipped: SkippedSkill[] = []
  const { files, skipped: outerSkips } = extractZipLenient(zip, {
    maxFiles: SKILL_IMPORT_LIMITS.maxBundleEntries,
    maxFileBytes: SKILL_IMPORT_LIMITS.maxSkillArchiveBytes,
    maxTotalBytes: SKILL_IMPORT_LIMITS.maxBundleBytes,
    maxDepth: SKILL_IMPORT_LIMITS.maxDepth
  })
  for (const entry of outerSkips) skipped.push({ source: entry.path, reason: entry.reason })

  const roots: SkillRoot[] = []
  const used = new Set<string>()
  // Claims a unique subPath (suffixing on the rare clash) so no two roots ever share one key.
  const addRoot = (subPath: string, rootFiles: FetchedSkillFile[]): void => {
    let unique = subPath
    for (let n = 2; used.has(unique); n += 1) unique = `${subPath}#${n}`
    used.add(unique)
    roots.push({ subPath: unique, files: rootFiles })
  }

  // Loose (non-archive) top-level files form ordinary roots — but they must still satisfy the per-skill
  // caps, and a root whose content the lenient walk had to drop is rejected (importing it would produce
  // a silently-partial skill).
  const looseSkips = outerSkips.filter((entry) => !isNestedArchive(entry.path)).map((e) => e.path)
  for (const root of findSkillRoots(files.filter((file) => !isNestedArchive(file.path)))) {
    const prefix = root.subPath === '' ? '' : `${root.subPath}/`
    if (looseSkips.some((path) => path === root.subPath || path.startsWith(prefix))) {
      skipped.push({
        source: root.subPath || 'skill',
        reason: 'contains a file too large to import'
      })
      continue
    }
    const violation = perSkillCapReason(root.files)
    if (violation) {
      skipped.push({ source: root.subPath || 'skill', reason: violation })
      continue
    }
    addRoot(root.subPath, root.files)
  }

  // Each nested archive is its own bundle: unpack it under the strict per-skill caps (extractZip throws
  // on any cap violation, so the whole inner skill is skipped, never partially imported).
  for (const archive of files.filter((file) => isNestedArchive(file.path))) {
    let innerRoots: SkillRoot[]
    try {
      innerRoots = findSkillRoots(extractZip(archive.content))
    } catch (error) {
      skipped.push({ source: archive.path, reason: reasonFromError(error) })
      continue
    }
    if (innerRoots.length === 0) {
      skipped.push({ source: archive.path, reason: 'no SKILL.md found' })
      continue
    }
    for (const root of innerRoots) {
      addRoot(root.subPath === '' ? archive.path : `${archive.path}/${root.subPath}`, root.files)
    }
  }

  // Bound the candidate count so a pathological archive of tiny skills can't flood the checklist.
  if (roots.length > SKILL_IMPORT_LIMITS.maxSkillsPerBundle) {
    for (const dropped of roots.splice(SKILL_IMPORT_LIMITS.maxSkillsPerBundle)) {
      skipped.push({
        source: dropped.subPath || 'skill',
        reason: `bundle has more than ${SKILL_IMPORT_LIMITS.maxSkillsPerBundle} skills`
      })
    }
  }

  return { roots: roots.sort((a, b) => a.subPath.localeCompare(b.subPath)), skipped }
}

// Reads and writes user-authored (personal) and imported skills under `<storageRoot>/skills/`.
class UserSkillRepository {
  constructor(private readonly storageRoot: string) {}

  private sourceDir(source: (typeof USER_SOURCES)[number]): string {
    return join(this.storageRoot, 'skills', source)
  }

  private skillDir(source: (typeof USER_SOURCES)[number], slug: string): string {
    return join(this.sourceDir(source), slug)
  }

  // Lists the valid skill slugs under a source, ignoring hidden entries — in particular the
  // `.import-`/`.backup-` transaction dirs, which must never be surfaced as slugs or skill ids.
  private async listSlugs(source: (typeof USER_SOURCES)[number]): Promise<string[]> {
    try {
      return (await readdir(this.sourceDir(source))).filter((entry) => SAFE_SLUG.test(entry))
    } catch {
      return []
    }
  }

  // Serializes transaction recovery and the writeImported swap so neither observes the other's
  // intermediate on-disk state, and lets every public operation trigger a fresh recovery pass.
  private lock: Promise<unknown> = Promise.resolve()
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    // Chain the next waiter on completion regardless of outcome, so one failure can't wedge the lock.
    this.lock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Finalizes any imported-skill replace that a crash interrupted, so the swap is failure-atomic across
  // process restarts (a plain two-step rename leaves a window with no live dir). Called at the start of
  // every public operation, INSIDE that operation's runExclusive critical section — not memoized — so a
  // backup left by a failed rollback, or a transient recovery error, is retried on the next operation.
  // For each slug: if a `.backup-` exists and the live dir is gone, the newest backup is restored (the
  // interrupted replace is rolled back, and a failed restore rejects the operation) and any older
  // backups discarded; a backup whose live dir is present, and every staged `.import-` dir, are dropped.
  private async doRecoverImportedTransactions(): Promise<void> {
    const dir = this.sourceDir('imported')
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      // A missing dir just means nothing to recover. Any other error (permission, I/O) must block the
      // operation rather than be swallowed — proceeding could act on an un-recovered/inconsistent state.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const backupsBySlug = new Map<string, { entry: string; generation: string }[]>()
    const stagings: string[] = []
    for (const entry of entries) {
      const match = TRANSACTION_DIR.exec(entry)
      if (!match) continue
      if (match[2] === 'backup') {
        const list = backupsBySlug.get(match[1]) ?? []
        list.push({ entry, generation: match[3] })
        backupsBySlug.set(match[1], list)
      } else {
        stagings.push(entry)
      }
    }

    for (const [slug, backups] of backupsBySlug) {
      const live = join(dir, slug)
      const liveExists = await stat(live).then(
        () => true,
        () => false
      )
      // Newest generation first, so if we must restore we pick the most recent previous copy.
      backups.sort((a, b) => b.generation.localeCompare(a.generation))
      for (let index = 0; index < backups.length; index += 1) {
        const path = join(dir, backups[index].entry)
        if (index === 0 && !liveExists) {
          // The live dir is gone and this backup is the only copy — a failed restore would lose the
          // skill, so reject the whole operation rather than logging and letting the caller proceed on
          // a missing skill (which a later recovery could otherwise "resurrect").
          try {
            await rename(path, live)
          } catch (error) {
            throw new Error(
              `Failed to recover interrupted skill import for "${slug}" from backup ${backups[index].entry}: ${String(error)}`
            )
          }
          log.warn('recovered interrupted skill import from backup', { slug })
        } else {
          // Superseded/leftover backup: best-effort cleanup, safe to ignore on failure.
          await rm(path, { recursive: true, force: true }).catch((error) =>
            log.warn('failed to remove leftover skill backup', {
              entry: backups[index].entry,
              error
            })
          )
        }
      }
    }

    // Discard any staged (uncommitted) copies left behind.
    for (const entry of stagings) {
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => {})
    }
  }

  // Lists every personal + imported skill, skipping any dir whose SKILL.md is missing/unreadable. The
  // whole read runs under the lock, after recovery, so it can't observe a live dir mid-swap (a rename
  // to/from a backup) and drop or duplicate an entry.
  async list(): Promise<BundledSkill[]> {
    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()
      return this.listSkillsInternal()
    })
  }

  // The listing itself, without acquiring the lock or running recovery — call only from within a
  // critical section that has already recovered (avoids re-entrant locking / deadlock).
  private async listSkillsInternal(): Promise<BundledSkill[]> {
    const skills: BundledSkill[] = []

    for (const source of USER_SOURCES) {
      for (const slug of await this.listSlugs(source)) {
        const skillDir = this.skillDir(source, slug)

        try {
          const { fields } = await readSkillFile(skillDir)
          const updatedAt = (await stat(join(skillDir, 'SKILL.md'))).mtime.toISOString()

          skills.push({
            id: `${source}-${slug}`,
            name: fields.name || slug,
            description: fields.description ?? '',
            source,
            updatedAt,
            sourceDir: skillDir,
            author: fields.author,
            license: fields.license,
            thirdParty: fields['third-party'] ?? fields['third_party'] ?? fields.thirdparty
          })
        } catch (error) {
          log.warn('skipping user skill with unreadable SKILL.md', { source, slug, error })
        }
      }
    }

    return skills
  }

  // Returns one user skill's SKILL.md body (frontmatter stripped). Recovery + read run under the lock
  // so a concurrent replace can't rename the live dir out from under the read (transient ENOENT).
  async body(id: string): Promise<string> {
    const parsed = parseUserSkillId(id)
    if (!parsed) throw new Error(`Not a user skill id: ${id}`)

    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()
      return (await readSkillFile(this.skillDir(parsed.source, parsed.slug))).body
    })
  }

  // Creates a personal skill, returning its new id. With an explicit `requestedSlug`, that slug is
  // used verbatim (validated, and rejected if already taken); otherwise a slug is derived from the
  // name and collisions get a numeric suffix.
  async createPersonal(input: WriteSkillInput, requestedSlug?: string): Promise<string> {
    if (requestedSlug !== undefined) {
      const slug = requestedSlug.trim()
      assertUsableSlug(slug)
      if (await this.slugTaken('personal', slug)) {
        throw new Error(`A skill with ID "${slug}" already exists.`)
      }
      await this.writeSkill('personal', slug, input)

      return `personal-${slug}`
    }

    const base = toSlug(input.name) || 'skill'
    const slug = await this.uniqueSlug('personal', base)
    await this.writeSkill('personal', slug, input)

    return `personal-${slug}`
  }

  // Rewrites an existing personal skill's SKILL.md in place.
  async updatePersonal(id: string, input: WriteSkillInput): Promise<void> {
    const parsed = parseUserSkillId(id)
    if (!parsed || parsed.source !== 'personal') throw new Error(`Not a personal skill id: ${id}`)

    await this.writeSkill('personal', parsed.slug, input)
  }

  // Deletes a personal or imported skill directory.
  async delete(id: string): Promise<void> {
    const parsed = parseUserSkillId(id)
    if (!parsed) throw new Error(`Not a user skill id: ${id}`)

    return this.runExclusive(async () => {
      // Recover first, so a skill left only in a crash backup is restored to its live dir and then
      // actually removed here — otherwise a later recovery would "resurrect" the deleted skill.
      await this.doRecoverImportedTransactions()
      await rm(this.skillDir(parsed.source, parsed.slug), { recursive: true, force: true })
    })
  }

  // Imports a single skill directory from a public GitHub URL, deduplicating against prior imports of
  // the same source: an unchanged re-import is a no-op, a changed one refreshes the files in place, and
  // a new source (or a same-name skill from a different source) is imported as a fresh slug.
  async importFromGitHub(url: string, fetchImpl?: FetchLike): Promise<ImportOutcome> {
    const location = parseGitHubSkillUrl(url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    // Fetch over the network OUTSIDE the lock (it's slow); everything that touches disk — recovery,
    // dedup, slug allocation, and the swap — runs in one critical section so two concurrent imports
    // can't both claim the same slug and clobber each other.
    const files = await fetchSkillFiles(location, fetcher)
    const signature = signatureOf(files)
    const base = toSlug(location.path.split('/').filter(Boolean).pop() ?? location.repo) || 'skill'

    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()

      // If a prior import from the exact same URL exists, either skip (unchanged) or refresh (changed).
      const existingSlug = await this.findImportedSlugByUrl(url)
      if (existingSlug) {
        const existing = await this.readSource(existingSlug)
        if (existing?.signature === signature) {
          return { status: 'unchanged', id: `imported-${existingSlug}` }
        }
        await this.writeImported(existingSlug, files, url, signature)
        return { status: 'updated', id: `imported-${existingSlug}` }
      }

      // A brand-new source; take a free slug (a same-name skill from a different repo gets a suffix).
      const slug = await this.uniqueSlug('imported', base)
      await this.writeImported(slug, files, url, signature)
      return { status: 'imported', id: `imported-${slug}` }
    })
  }

  // Finds an already-imported skill whose recorded source URL matches, for dedup. Only real slugs are
  // scanned, so a hidden transaction dir can never be returned as a (bogus) slug.
  private async findImportedSlugByUrl(url: string): Promise<string | undefined> {
    for (const slug of await this.listSlugs('imported')) {
      const source = await this.readSource(slug)
      if (source?.url === url) return slug
    }
    return undefined
  }

  // Parses a bundle for a confirm-before-import preview: extracts it, reads the SKILL.md frontmatter,
  // lists the files, flags whether the identical bundle was already imported, and — when its name
  // collides with exactly one existing imported skill of different content — offers that skill's id as
  // a replace target. Writes nothing.
  async previewZip(zip: Buffer): Promise<SkillBundlePreviewResult> {
    const { roots, skipped } = discoverSkillRoots(zip)

    // Recovery + all dedup reads run under the lock so the alreadyImported/replaceable computation
    // reflects a consistent, fully-recovered view of the imported dir.
    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()

      const previews: SkillBundlePreview[] = []
      // A root that can't be parsed into a valid preview (no name, bad frontmatter) is skipped with a
      // reason instead of failing the whole bundle — so the importable skills still come through.
      for (const root of roots) {
        try {
          const skillMd = root.files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
          const { fields } = parseFrontmatter(skillMd.content.toString('utf8'))
          const name = fields.name?.trim()
          if (!name) {
            skipped.push({ source: root.subPath || 'skill', reason: 'SKILL.md has no name' })
            continue
          }

          const alreadyImported = Boolean(
            await this.findImportedSlugBySignature(signatureOf(root.files))
          )
          const replaceableId = alreadyImported ? undefined : await this.replaceableImportedId(name)

          previews.push({
            name,
            description: fields.description ?? '',
            files: root.files.map((file) => file.relativePath).sort(),
            alreadyImported,
            replaceableId,
            subPath: root.subPath
          })
        } catch (error) {
          skipped.push({ source: root.subPath || 'skill', reason: reasonFromError(error) })
        }
      }

      return { previews, skipped }
    })
  }

  // The id of the single imported skill sharing this display name, or undefined when there is none or
  // the name is ambiguous (more than one). Only imported skills are replace targets — never a
  // personal/featured skill that happens to share a name.
  private async replaceableImportedId(name: string): Promise<string | undefined> {
    const target = name.trim().toLowerCase()
    // Non-locking listing: this is only ever called from within a critical section that has already
    // recovered, so it must not re-acquire the lock (which would deadlock).
    const matches = (await this.listSkillsInternal()).filter(
      (skill) => skill.source === 'imported' && skill.name.trim().toLowerCase() === target
    )
    return matches.length === 1 ? matches[0].id : undefined
  }

  // Picks the skill root to import from a multi-root bundle: by explicit subPath when given, else the
  // sole root — a bundle with several roots requires the caller to disambiguate with a subPath.
  private selectRoot(roots: SkillRoot[], subPath?: string): SkillRoot {
    if (subPath !== undefined) {
      const match = roots.find((root) => root.subPath === subPath)
      if (!match) throw new Error(`The bundle has no skill at "${subPath}".`)
      return match
    }
    if (roots.length > 1) {
      throw new Error('The bundle contains multiple skills; specify which one to import.')
    }
    return roots[0]
  }

  // Imports a .zip / .skill bundle that contains a SKILL.md. `subPath` selects one skill from a bundle
  // holding several. With `replaceId`, the selected skill overwrites that already-imported skill in
  // place. Otherwise it dedups by content signature (re-importing the same bundle is a no-op) and a
  // bundle whose name is already taken gets a suffixed slug.
  async importFromZip(
    zip: Buffer,
    options: { subPath?: string; replaceId?: string } = {}
  ): Promise<ImportOutcome> {
    const { roots } = discoverSkillRoots(zip)
    if (roots.length === 0) throw new Error('The bundle must contain a SKILL.md.')

    const root = this.selectRoot(roots, options.subPath)

    // Recovery, dedup, slug allocation and the swap share one critical section (see importFromGitHub).
    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()
      return this.writeRootLocked(root, options.replaceId)
    })
  }

  // Imports several skills from ONE bundle in a single pass: the bundle is discovered once and the
  // whole batch runs under one critical section (one recovery, no per-skill re-extraction of a large
  // upload). Each requested subPath is imported independently — a failure on one is captured as an
  // error for that item and does not abort the rest. Returns one result per requested item.
  async importFromZipBatch(
    zip: Buffer,
    items: { subPath: string; replaceId?: string }[]
  ): Promise<{ subPath: string; outcome?: ImportOutcome; error?: string }[]> {
    const { roots } = discoverSkillRoots(zip)
    const bySubPath = new Map(roots.map((root) => [root.subPath, root]))

    return this.runExclusive(async () => {
      await this.doRecoverImportedTransactions()

      const results: { subPath: string; outcome?: ImportOutcome; error?: string }[] = []
      for (const item of items) {
        const root = bySubPath.get(item.subPath)
        if (!root) {
          results.push({
            subPath: item.subPath,
            error: `The bundle has no skill at "${item.subPath}".`
          })
          continue
        }
        try {
          results.push({
            subPath: item.subPath,
            outcome: await this.writeRootLocked(root, item.replaceId)
          })
        } catch (error) {
          results.push({ subPath: item.subPath, error: reasonFromError(error) })
        }
      }
      return results
    })
  }

  // Writes one discovered skill root: replaces `replaceId` in place when given, else dedups by content
  // signature (a re-import of the same bytes is a no-op) and allocates a fresh (possibly suffixed) slug.
  // MUST be called from within a runExclusive critical section that has already recovered.
  private async writeRootLocked(root: SkillRoot, replaceId?: string): Promise<ImportOutcome> {
    const files = root.files
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
    const signature = signatureOf(files)

    if (replaceId !== undefined) {
      const parsed = parseUserSkillId(replaceId)
      if (
        !parsed ||
        parsed.source !== 'imported' ||
        !(await this.slugTaken('imported', parsed.slug))
      ) {
        throw new Error(`Not an imported skill to replace: ${replaceId}`)
      }
      await this.writeImported(parsed.slug, files, '', signature)
      return { status: 'updated', id: `imported-${parsed.slug}` }
    }

    const existingSlug = await this.findImportedSlugBySignature(signature)
    if (existingSlug) {
      return { status: 'unchanged', id: `imported-${existingSlug}` }
    }

    // CRLF-aware name extraction (from #181) inside #170's operation-level critical section.
    const name = parseFrontmatter(skillMd.content.toString('utf8')).fields.name?.trim()
    const base = toSlug(name ?? 'skill') || 'skill'
    const slug = await this.uniqueSlug('imported', base)
    await this.writeImported(slug, files, '', signature)
    return { status: 'imported', id: `imported-${slug}` }
  }

  // Finds an imported skill whose recorded content signature matches, for zip dedup.
  private async findImportedSlugBySignature(signature: string): Promise<string | undefined> {
    for (const slug of await this.listSlugs('imported')) {
      const source = await this.readSource(slug)
      if (source?.signature === signature) return slug
    }
    return undefined
  }

  // Scans a GitHub repo for skill directories, marking which are already imported (by source URL).
  async scanRepo(
    repoInput: string,
    fetchImpl?: FetchLike
  ): Promise<(ScannedSkill & { alreadyImported: boolean })[]> {
    const repo = parseGitHubRepo(repoInput)
    if (!repo) throw new Error('Not a recognizable GitHub repo (owner/repo or a github.com URL).')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    // Scan over the network outside the lock; build the imported index under the lock, after recovery.
    const [found, index] = await Promise.all([
      scanRepoForSkills(repo, fetcher),
      this.runExclusive(async () => {
        await this.doRecoverImportedTransactions()
        return this.importedIndex()
      })
    ])

    // Mark a candidate as already imported when its exact source URL matches, or when its name matches
    // an existing import (an imported slug's base is toSlug(folder name), which equals the scanned name
    // slugified) — so the same skill from a different URL/ref/fork is still flagged.
    return found.map((skill) => ({
      ...skill,
      alreadyImported: index.urls.has(skill.url) || index.slugs.has(toSlug(skill.name))
    }))
  }

  // The source URLs and slugs of already-imported skills, for scan dedup marking (by URL or by name).
  private async importedIndex(): Promise<{ urls: Set<string>; slugs: Set<string> }> {
    const urls = new Set<string>()
    const slugs = new Set<string>()

    // listSlugs ignores hidden entries, so a transaction dir's .source.json is never read as an
    // already-imported source even if recovery couldn't clean it up.
    for (const slug of await this.listSlugs('imported')) {
      slugs.add(slug)
      const source = await this.readSource(slug)
      if (source?.url) urls.add(source.url)
    }
    return { urls, slugs }
  }

  private async readSource(slug: string): Promise<{ url?: string; signature?: string } | null> {
    try {
      const raw = await readFile(join(this.skillDir('imported', slug), SOURCE_MANIFEST), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, string>)
        : null
    } catch {
      return null
    }
  }

  // Writes an imported skill's files (replacing any prior copy) plus its source manifest.
  private async writeImported(
    slug: string,
    files: FetchedSkillFile[],
    url: string,
    signature: string
  ): Promise<void> {
    const dir = this.skillDir('imported', slug)
    const root = resolve(dir)

    // Validate the whole file set against the FINAL directory before touching disk. Every target must
    // stay inside the skill dir, none may BE the dir itself (an empty/`.` path), none may collide with
    // the internal source manifest, no two may be exact duplicates, and none may be a path-prefix of
    // another (a file `a` and a dir `a/b` can't both exist). A bundle failing any of these is rejected.
    const manifestTarget = resolve(dir, SOURCE_MANIFEST)
    const seen = new Set<string>()
    for (const file of files) {
      const target = resolve(dir, file.relativePath)
      if (target === root || !target.startsWith(root + sep)) {
        throw new Error(`Refusing to write skill file outside its directory: ${file.relativePath}`)
      }
      if (target === manifestTarget) {
        throw new Error(`Skill import may not include the reserved file ${SOURCE_MANIFEST}.`)
      }
      if (seen.has(target)) {
        throw new Error(`Duplicate file path in skill import: ${file.relativePath}`)
      }
      seen.add(target)
    }
    for (const a of seen) {
      for (const b of seen) {
        if (a !== b && b.startsWith(a + sep)) {
          throw new Error('Conflicting file and directory at the same path in skill import.')
        }
      }
    }

    // Stage the new copy in a sibling dir, then swap it in with a backup so the operation is atomic on
    // failure. Files are written with the `wx` flag so a filesystem-equivalent collision (e.g. SKILL.md
    // vs skill.md on a case-insensitive volume) fails loudly in staging rather than silently
    // overwriting. Swap order: move the old dir to a backup, move staging into place, then drop the
    // backup — so if the final rename throws (or the process dies) the previous skill is still on disk
    // and is rolled back, never lost.
    const parent = dirname(dir)
    const stem = basename(dir)
    const generation = nextGeneration()
    const staging = join(parent, `.${stem}.import-${generation}`)
    const backup = join(parent, `.${stem}.backup-${generation}`)
    // Build the whole new copy in staging first; any failure here discards staging and never touches
    // the live skill.
    try {
      await mkdir(staging, { recursive: true })
      for (const file of files) {
        const target = join(staging, file.relativePath)
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(target, file.content, { flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
              `Conflicting file paths in skill import (collision at ${file.relativePath}).`
            )
          }
          throw error
        }
      }
      await writeFile(join(staging, SOURCE_MANIFEST), JSON.stringify({ url, signature }, null, 2), {
        flag: 'wx'
      })
    } catch (buildError) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw buildError
    }

    // Swap: move the old copy aside to the backup, move staging into place, then drop the backup. This
    // runs inside the caller's operation-level critical section (recovery + dedup + slug + swap share
    // one runExclusive), so it must NOT re-acquire the lock here — that would deadlock. If a crash
    // lands between the two renames, recovery restores the backup on the next operation.
    try {
      const hadExisting = await stat(dir).then(
        () => true,
        () => false
      )
      if (hadExisting) await rename(dir, backup) // may throw; live dir untouched, staging cleaned below

      try {
        await rename(staging, dir)
      } catch (swapError) {
        if (hadExisting) {
          try {
            await rename(backup, dir)
          } catch (rollbackError) {
            // Rollback failed too: keep the backup on disk (recovery restores it next run) and
            // surface both errors rather than swallowing them.
            throw new Error(
              `Skill replace failed to swap and could not roll back; the previous copy is preserved at ${basename(backup)} and will be restored on the next operation. swap error: ${String(swapError)}; rollback error: ${String(rollbackError)}`
            )
          }
        }
        throw swapError
      }

      // New copy is in place; drop the backup last so nothing is deleted until the swap succeeded. A
      // leftover backup (rm failure) is harmless — recovery removes it once the live dir is present.
      if (hadExisting) await rm(backup, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      // Any swap failure leaves staging behind; discard it (the backup, if any, is intentionally kept).
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  // Finds a slug not yet taken under the source, appending -2, -3, ... on collision.
  private async uniqueSlug(source: (typeof USER_SOURCES)[number], base: string): Promise<string> {
    const taken = new Set(await this.listSlugs(source))

    if (!taken.has(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
  }

  // Whether a slug's directory already exists under the source.
  private async slugTaken(source: (typeof USER_SOURCES)[number], slug: string): Promise<boolean> {
    return (await this.listSlugs(source)).includes(slug)
  }

  // Writes a SKILL.md with a minimal frontmatter block (name/description) followed by the body.
  private async writeSkill(
    source: (typeof USER_SOURCES)[number],
    slug: string,
    input: WriteSkillInput
  ): Promise<void> {
    const dir = this.skillDir(source, slug)
    await mkdir(dir, { recursive: true })

    // js-yaml.dump already ends with a newline, so the closing fence follows directly.
    const frontmatter = `---\n${frontmatterBlock({ name: input.name, description: input.description })}---`
    const contents = `${frontmatter}\n\n${input.body.trimStart()}`

    await writeFile(join(dir, 'SKILL.md'), contents, 'utf8')

    // Reconcile the references/ dir to the desired set when references are provided (an array — even
    // empty — reconciles; `undefined` leaves the dir untouched). A reference with `dataBase64` is
    // written (created or replaced); one without it is an existing file to keep as-is. Any file not in
    // the desired set is removed, so the editor's removals delete the file on disk.
    if (input.references !== undefined) {
      const refsDir = join(dir, 'references')
      const desired = new Map<string, SkillReference>()
      for (const reference of input.references) {
        const name = reference.path.split(/[\\/]/).pop() ?? ''
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) continue
        desired.set(name, reference)
      }

      let existing: string[] = []
      try {
        existing = await readdir(refsDir)
      } catch {
        existing = []
      }
      for (const name of existing) {
        if (!desired.has(name)) await rm(join(refsDir, name), { recursive: true, force: true })
      }

      for (const [name, reference] of desired) {
        if (reference.dataBase64 === undefined) continue
        const target = join(refsDir, name)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(reference.dataBase64, 'base64'))
      }
    }
  }
}

export { UserSkillRepository, parseUserSkillId, toSlug, frontmatterBlock }
