import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { SkillBundlePreview, SkillReference, SkillSource } from '../../shared/settings'
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
import { extractZip } from './zip-extract'

const log = createLogger('skills')

// User skills live in writable app storage, one subdir per skill, grouped by source. Bundled (featured)
// skills stay read-only in resources and are handled by SkillRegistry instead.
const USER_SOURCES: ReadonlyArray<Extract<SkillSource, 'imported' | 'personal'>> = [
  'imported',
  'personal'
]

// Only lowercase slugs so a skill id maps 1:1 to a safe directory name.
const SAFE_SLUG = /^[a-z0-9-]+$/

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

// Reads the `name:` value from a SKILL.md frontmatter block, if present.
const frontmatterName = (text: string): string | undefined => {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!match) return undefined
  return /^name:\s*(.*)$/m.exec(match[1])?.[1].trim() || undefined
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

  // Lists every personal + imported skill, skipping any dir whose SKILL.md is missing/unreadable.
  async list(): Promise<BundledSkill[]> {
    const skills: BundledSkill[] = []

    for (const source of USER_SOURCES) {
      const dir = this.sourceDir(source)
      let slugs: string[] = []
      try {
        slugs = await readdir(dir)
      } catch {
        continue
      }

      for (const slug of slugs) {
        if (!SAFE_SLUG.test(slug)) continue
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

  // Returns one user skill's SKILL.md body (frontmatter stripped).
  async body(id: string): Promise<string> {
    const parsed = parseUserSkillId(id)
    if (!parsed) throw new Error(`Not a user skill id: ${id}`)

    return (await readSkillFile(this.skillDir(parsed.source, parsed.slug))).body
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

    await rm(this.skillDir(parsed.source, parsed.slug), { recursive: true, force: true })
  }

  // Imports a single skill directory from a public GitHub URL, deduplicating against prior imports of
  // the same source: an unchanged re-import is a no-op, a changed one refreshes the files in place, and
  // a new source (or a same-name skill from a different source) is imported as a fresh slug.
  async importFromGitHub(url: string, fetchImpl?: FetchLike): Promise<ImportOutcome> {
    const location = parseGitHubSkillUrl(url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    const files = await fetchSkillFiles(location, fetcher)
    const signature = signatureOf(files)
    const base = toSlug(location.path.split('/').filter(Boolean).pop() ?? location.repo) || 'skill'

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
  }

  // Finds an already-imported skill whose recorded source URL matches, for dedup.
  private async findImportedSlugByUrl(url: string): Promise<string | undefined> {
    let slugs: string[] = []
    try {
      slugs = await readdir(this.sourceDir('imported'))
    } catch {
      return undefined
    }

    for (const slug of slugs) {
      const source = await this.readSource(slug)
      if (source?.url === url) return slug
    }
    return undefined
  }

  // Parses a bundle for a confirm-before-import preview: extracts it, reads the SKILL.md frontmatter,
  // lists the files, flags whether the identical bundle was already imported, and — when its name
  // collides with exactly one existing imported skill of different content — offers that skill's id as
  // a replace target. Writes nothing.
  async previewZip(zip: Buffer): Promise<SkillBundlePreview[]> {
    const roots = findSkillRoots(extractZip(zip))
    if (roots.length === 0) throw new Error('The bundle must contain a SKILL.md.')

    const previews: SkillBundlePreview[] = []
    for (const root of roots) {
      const skillMd = root.files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
      const { fields } = parseFrontmatter(skillMd.content.toString('utf8'))
      const name = fields.name?.trim()
      if (!name) throw new Error("The bundle's SKILL.md needs a name in its frontmatter.")

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
    }

    return previews
  }

  // The id of the single imported skill sharing this display name, or undefined when there is none or
  // the name is ambiguous (more than one). Only imported skills are replace targets — never a
  // personal/featured skill that happens to share a name.
  private async replaceableImportedId(name: string): Promise<string | undefined> {
    const target = name.trim().toLowerCase()
    const matches = (await this.list()).filter(
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
    const roots = findSkillRoots(extractZip(zip))
    if (roots.length === 0) throw new Error('The bundle must contain a SKILL.md.')

    const root = this.selectRoot(roots, options.subPath)
    const files = root.files
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
    const signature = signatureOf(files)

    if (options.replaceId !== undefined) {
      const parsed = parseUserSkillId(options.replaceId)
      if (
        !parsed ||
        parsed.source !== 'imported' ||
        !(await this.slugTaken('imported', parsed.slug))
      ) {
        throw new Error(`Not an imported skill to replace: ${options.replaceId}`)
      }
      await this.writeImported(parsed.slug, files, '', signature)
      return { status: 'updated', id: `imported-${parsed.slug}` }
    }

    const existingSlug = await this.findImportedSlugBySignature(signature)
    if (existingSlug) {
      return { status: 'unchanged', id: `imported-${existingSlug}` }
    }

    const name = frontmatterName(skillMd.content.toString('utf8'))
    const base = toSlug(name ?? 'skill') || 'skill'
    const slug = await this.uniqueSlug('imported', base)
    await this.writeImported(slug, files, '', signature)
    return { status: 'imported', id: `imported-${slug}` }
  }

  // Finds an imported skill whose recorded content signature matches, for zip dedup.
  private async findImportedSlugBySignature(signature: string): Promise<string | undefined> {
    let slugs: string[] = []
    try {
      slugs = await readdir(this.sourceDir('imported'))
    } catch {
      return undefined
    }

    for (const slug of slugs) {
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

    const [found, index] = await Promise.all([
      scanRepoForSkills(repo, fetcher),
      this.importedIndex()
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
    let dirs: string[] = []
    try {
      dirs = await readdir(this.sourceDir('imported'))
    } catch {
      return { urls, slugs }
    }

    for (const slug of dirs) {
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

    // Containment gate for every import source (zip, GitHub, ...): resolve every target and confirm it
    // stays inside the skill directory BEFORE touching disk. Validating up front — rather than per
    // file mid-write — means a crafted relative path can't leave the prior copy deleted or a new copy
    // half-written; the whole import is rejected before the destructive rm.
    const root = resolve(dir)
    const targets = files.map((file) => {
      const target = resolve(dir, file.relativePath)
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`Refusing to write skill file outside its directory: ${file.relativePath}`)
      }
      return { target, content: file.content }
    })

    await rm(dir, { recursive: true, force: true })
    for (const { target, content } of targets) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }

    await writeFile(join(dir, SOURCE_MANIFEST), JSON.stringify({ url, signature }, null, 2), 'utf8')
  }

  // Finds a slug not yet taken under the source, appending -2, -3, ... on collision.
  private async uniqueSlug(source: (typeof USER_SOURCES)[number], base: string): Promise<string> {
    let slugs: string[] = []
    try {
      slugs = await readdir(this.sourceDir(source))
    } catch {
      slugs = []
    }
    const taken = new Set(slugs)

    if (!taken.has(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
  }

  // Whether a slug's directory already exists under the source.
  private async slugTaken(source: (typeof USER_SOURCES)[number], slug: string): Promise<boolean> {
    try {
      const slugs = await readdir(this.sourceDir(source))
      return slugs.includes(slug)
    } catch {
      return false
    }
  }

  // Writes a SKILL.md with a minimal frontmatter block (name/description) followed by the body.
  private async writeSkill(
    source: (typeof USER_SOURCES)[number],
    slug: string,
    input: WriteSkillInput
  ): Promise<void> {
    const dir = this.skillDir(source, slug)
    await mkdir(dir, { recursive: true })

    const frontmatter = [
      '---',
      `name: ${input.name}`,
      `description: ${input.description}`,
      '---'
    ].join('\n')
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

export { UserSkillRepository, parseUserSkillId, toSlug }
