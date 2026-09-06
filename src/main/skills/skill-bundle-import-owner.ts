import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type {
  SkillBundlePreview,
  SkillBundlePreviewResult,
  SkippedSkill
} from '../../shared/settings'
import { SKILL_IMPORT_LIMITS, isAppOwnedSkillRootFile } from '../../shared/skill-import-limits'
import {
  fetchSkillFiles,
  fetchSkillPreview,
  parseGitHubSkillUrl,
  parseGitHubRepo,
  scanRepoForSkills,
  type FetchLike,
  type FetchedSkillFile,
  type GitHubFetchOptions,
  type ScannedSkill
} from './github-import'
import { parseSkillDocument } from './frontmatter'
import { canonicalSkillDocument } from './skill-document-name'
import { selectSkillManifestRoots } from './skill-bundle-paths'
import { inspectSkillPackage } from './skill-package-inspection'
import { extractZip, extractZipLenient } from './zip-extract'
import type { SkillPackageTransactionOwner } from './skill-package-transaction-owner'
import type { ImportOutcome, ParsedSkillPreview } from './user-skill-import-contracts'
import { UserSkillStore, normalizeSkillName, parseUserSkillId } from './user-skill-store'

type SkillRoot = { subPath: string; files: FetchedSkillFile[] }
type SkillDiscovery = { roots: SkillRoot[]; skipped: SkippedSkill[] }

// Installation identity excludes the pinned revision; package paths remain case-sensitive.
const githubSourceKey = (url: string): string | undefined => {
  const location = parseGitHubSkillUrl(url)
  return location
    ? JSON.stringify([location.owner.toLowerCase(), location.repo.toLowerCase(), location.path])
    : undefined
}

const assertOrdinarySkillFiles = (files: readonly FetchedSkillFile[]): void => {
  for (const file of files) {
    if (isAppOwnedSkillRootFile(file.relativePath)) {
      throw new Error(`Skill import may not include the reserved file ${file.relativePath}.`)
    }
  }
}

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

const canonicalImportedSkillDocument = (content: Buffer, name: string): Buffer => {
  return Buffer.from(canonicalSkillDocument(content.toString('utf8'), name), 'utf8')
}

const findSkillRoots = (entries: { path: string; content: Buffer }[]): SkillRoot[] => {
  const roots = selectSkillManifestRoots(entries.map((entry) => entry.path))
  return roots.map((subPath) => {
    const prefix = subPath === '' ? '' : `${subPath}/`
    const files = entries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ relativePath: entry.path.slice(prefix.length), content: entry.content }))
    return { subPath, files }
  })
}

const isNestedArchive = (path: string): boolean => /\.(zip|skill)$/i.test(path)

const reasonFromError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, '') || 'unreadable'
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

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
  const addRoot = (subPath: string, rootFiles: FetchedSkillFile[]): void => {
    let unique = subPath
    for (let n = 2; used.has(unique); n += 1) unique = `${subPath}#${n}`
    used.add(unique)
    roots.push({ subPath: unique, files: rootFiles })
  }

  const looseRoots = findSkillRoots(files.filter((file) => !isNestedArchive(file.path)))
  const rootPrefixes = looseRoots.map((root) => ({
    root,
    prefix: root.subPath === '' ? '' : `${root.subPath}/`
  }))

  const standaloneArchives: typeof files = []
  for (const archive of files.filter((file) => isNestedArchive(file.path))) {
    const owner = rootPrefixes.find(({ prefix }) => archive.path.startsWith(prefix))
    if (owner) {
      owner.root.files.push({
        relativePath: archive.path.slice(owner.prefix.length),
        content: archive.content
      })
    } else {
      standaloneArchives.push(archive)
    }
  }

  for (const { root, prefix } of rootPrefixes) {
    const droppedFile = outerSkips.find(
      (entry) => entry.path === root.subPath || entry.path.startsWith(prefix)
    )
    if (droppedFile) {
      skipped.push({
        source: root.subPath || 'skill',
        reason: `contains a file that couldn't be imported (${droppedFile.reason})`
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

  for (const archive of standaloneArchives) {
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

  if (roots.length > SKILL_IMPORT_LIMITS.maxSkillsPerBundle) {
    for (const dropped of roots.splice(SKILL_IMPORT_LIMITS.maxSkillsPerBundle)) {
      skipped.push({
        source: dropped.subPath || 'skill',
        reason: `bundle has more than ${SKILL_IMPORT_LIMITS.maxSkillsPerBundle} skills`
      })
    }
  }

  return { roots: roots.sort((left, right) => left.subPath.localeCompare(right.subPath)), skipped }
}

// Owns GitHub and ZIP discovery, preview, deduplication and import. Remote/archive work stays outside
// the shared filesystem lock; recovery through promotion remains one transaction per operation.
export class SkillBundleImportOwner {
  constructor(
    private readonly store: UserSkillStore,
    private readonly transactions: SkillPackageTransactionOwner
  ) {}

  async importFromGitHub(
    url: string,
    fetchImpl?: FetchLike,
    reservedNames: readonly string[] = [],
    options: GitHubFetchOptions = {}
  ): Promise<ImportOutcome> {
    const location = parseGitHubSkillUrl(url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    const files = await fetchSkillFiles(location, fetcher, options)
    assertOrdinarySkillFiles(files)
    const signature = signatureOf(files)
    const preview = parsedSkillPreview(
      files
        .find((file) => file.relativePath.toLowerCase() === 'skill.md')!
        .content.toString('utf8'),
      files.map((file) => file.relativePath),
      location.path.split('/').filter(Boolean).pop() ?? location.repo
    )
    const baseName = normalizeSkillName(preview.name) || 'skill'

    return this.transactions.runMutationRecovered(async () => {
      const existingDirectoryName = await this.findImportedDirectoryNameByUrl(url)
      if (existingDirectoryName) {
        const existing = await this.transactions.readImportedSource(existingDirectoryName)
        if (
          existing?.signature === signature &&
          (await this.installedMatches(existingDirectoryName, files))
        ) {
          return { status: 'unchanged', id: `imported-${existingDirectoryName}` }
        }
        await this.writeImported(existingDirectoryName, files, url, signature)
        return { status: 'updated', id: `imported-${existingDirectoryName}` }
      }

      const name = await this.store.uniqueImportedName(baseName, reservedNames)
      await this.writeImported(name, files, url, signature)
      return { status: 'imported', id: `imported-${name}` }
    })
  }

  async previewGitHubSkill(
    url: string,
    fetchImpl?: FetchLike,
    options: GitHubFetchOptions = {}
  ): Promise<ParsedSkillPreview> {
    const location = parseGitHubSkillUrl(url)
    if (!location) throw new Error('Not a recognizable GitHub URL.')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    const { skillMd, files } = await fetchSkillPreview(location, fetcher, options)
    const fallbackName = location.path.split('/').filter(Boolean).pop() ?? location.repo
    return parsedSkillPreview(skillMd.toString('utf8'), files, fallbackName)
  }

  async previewZip(zip: Buffer): Promise<SkillBundlePreviewResult> {
    const { roots, skipped } = discoverSkillRoots(zip)
    return this.transactions.runRecovered(async () => {
      const previews: SkillBundlePreview[] = []
      let previewContentBytes = 0
      for (const root of roots) {
        try {
          const skillMd = root.files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
          const previewContentUnavailable =
            previewContentBytes + skillMd.content.length >
            SKILL_IMPORT_LIMITS.maxPreviewContentBytes
          const parsed = parseSkillDocument(skillMd.content.toString('utf8'))
          const name = parsed.name?.trim()
          if (!name) {
            skipped.push({ source: root.subPath || 'skill', reason: 'SKILL.md has no name' })
            continue
          }

          assertOrdinarySkillFiles(root.files)
          const existing = await this.findImportedDirectoryNameBySignature(signatureOf(root.files))
          const alreadyImported =
            existing !== undefined && (await this.installedMatches(existing, root.files))
          const replaceableId = alreadyImported ? undefined : await this.replaceableImportedId(name)

          if (!previewContentUnavailable) previewContentBytes += skillMd.content.length
          previews.push({
            name,
            description: previewContentUnavailable ? '' : (parsed.description ?? ''),
            metadata: previewContentUnavailable ? {} : parsed.metadata,
            body: previewContentUnavailable ? '' : parsed.body,
            previewError: previewContentUnavailable
              ? `SKILL.md preview content exceeds the ${mb(SKILL_IMPORT_LIMITS.maxPreviewContentBytes)} cumulative limit. You can still import it.`
              : undefined,
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

  async importFromZip(
    zip: Buffer,
    options: { subPath?: string; replaceId?: string; reservedNames?: readonly string[] } = {}
  ): Promise<ImportOutcome> {
    const { roots } = discoverSkillRoots(zip)
    if (roots.length === 0) throw new Error('The bundle must contain a SKILL.md.')
    const root = this.selectRoot(roots, options.subPath)
    return this.transactions.runMutationRecovered(() =>
      this.writeRootLocked(root, options.replaceId, options.reservedNames)
    )
  }

  async importFromZipBatch(
    zip: Buffer,
    items: { subPath: string; replaceId?: string }[],
    reservedNames: readonly string[] = []
  ): Promise<{ subPath: string; outcome?: ImportOutcome; error?: string }[]> {
    const { roots } = discoverSkillRoots(zip)
    const bySubPath = new Map(roots.map((root) => [root.subPath, root]))

    return this.transactions.runMutationRecovered(async () => {
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
            outcome: await this.writeRootLocked(root, item.replaceId, reservedNames)
          })
        } catch (error) {
          results.push({ subPath: item.subPath, error: reasonFromError(error) })
        }
      }
      return results
    })
  }

  async scanRepo(
    repoInput: string,
    fetchImpl?: FetchLike,
    options: GitHubFetchOptions = {}
  ): Promise<(ScannedSkill & { alreadyImported: boolean; installedId?: string })[]> {
    const repo = parseGitHubRepo(repoInput)
    if (!repo) throw new Error('Not a recognizable GitHub repo (owner/repo or a github.com URL).')

    const fetcher = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetcher) throw new Error('No fetch implementation available.')

    const [found, index] = await Promise.all([
      scanRepoForSkills(repo, fetcher, options),
      this.transactions.runRecovered(() => this.importedIndex())
    ])
    return found.map((skill) => {
      const matches = index.filter((entry) => entry.sourceKey === githubSourceKey(skill.url))
      const installed = matches.length === 1 ? matches[0] : undefined
      return {
        ...skill,
        alreadyImported:
          installed !== undefined &&
          parseGitHubSkillUrl(installed.url)?.ref === parseGitHubSkillUrl(skill.url)?.ref,
        ...(installed ? { installedId: `imported-${installed.directoryName}` } : {})
      }
    })
  }

  private async findImportedDirectoryNameByUrl(url: string): Promise<string | undefined> {
    const matches = (await this.importedIndex()).filter(
      (entry) => entry.sourceKey === githubSourceKey(url)
    )
    if (matches.length > 1) {
      throw new Error(
        'Multiple installed Skills match this GitHub source. Resolve the duplicate imports before updating.'
      )
    }
    return matches[0]?.directoryName
  }

  private async replaceableImportedId(name: string): Promise<string | undefined> {
    const target = normalizeSkillName(name)
    const matches = (await this.store.listSkillsLocked()).filter(
      (skill) => skill.source === 'imported' && skill.name.trim().toLowerCase() === target
    )
    return matches.length === 1 ? matches[0].id : undefined
  }

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

  private async writeRootLocked(
    root: SkillRoot,
    replaceId?: string,
    reservedNames: readonly string[] = []
  ): Promise<ImportOutcome> {
    const files = root.files
    assertOrdinarySkillFiles(files)
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
    const signature = signatureOf(files)

    if (replaceId !== undefined) {
      const parsed = parseUserSkillId(replaceId)
      if (
        !parsed ||
        parsed.source !== 'imported' ||
        !(await this.store.directoryNameTaken('imported', parsed.directoryName))
      ) {
        throw new Error(`Not an imported skill to replace: ${replaceId}`)
      }
      await this.writeImported(parsed.directoryName, files, '', signature)
      return { status: 'updated', id: `imported-${parsed.directoryName}` }
    }

    const existingDirectoryName = await this.findImportedDirectoryNameBySignature(signature)
    if (existingDirectoryName) {
      if (await this.installedMatches(existingDirectoryName, files)) {
        return { status: 'unchanged', id: `imported-${existingDirectoryName}` }
      }
      const existing = await this.transactions.readImportedSource(existingDirectoryName)
      await this.writeImported(existingDirectoryName, files, existing?.url ?? '', signature)
      return { status: 'updated', id: `imported-${existingDirectoryName}` }
    }

    const name = parseSkillDocument(skillMd.content.toString('utf8')).name?.trim()
    const baseName = normalizeSkillName(name ?? 'skill') || 'skill'
    const assignedName = await this.store.uniqueImportedName(baseName, reservedNames)
    await this.writeImported(assignedName, files, '', signature)
    return { status: 'imported', id: `imported-${assignedName}` }
  }

  private async findImportedDirectoryNameBySignature(
    signature: string
  ): Promise<string | undefined> {
    for (const directoryName of await this.store.listDirectoryNames('imported')) {
      const source = await this.transactions.readImportedSource(directoryName)
      if (source?.signature === signature) return directoryName
    }
    return undefined
  }

  private async importedIndex(): Promise<
    Array<{ directoryName: string; url: string; sourceKey: string }>
  > {
    const entries: Array<{ directoryName: string; url: string; sourceKey: string }> = []
    for (const directoryName of await this.store.listDirectoryNames('imported')) {
      const source = await this.transactions.readImportedSource(directoryName)
      const sourceKey = source?.url ? githubSourceKey(source.url) : undefined
      if (source?.url && sourceKey) entries.push({ directoryName, url: source.url, sourceKey })
    }
    return entries
  }

  // Compare the actual normalized installation, not its historical source receipt. Inspection
  // bounds reads and rejects symlinks/unsupported entries; a broken copy is repairable by reimport.
  private async installedMatches(
    directoryName: string,
    files: readonly FetchedSkillFile[]
  ): Promise<boolean> {
    try {
      const installed = await inspectSkillPackage(
        this.store.skillDirectory('imported', directoryName)
      )
      if (installed.length !== files.length) return false
      const byPath = new Map(installed.map((file) => [file.relativePath, file]))
      for (const file of files) {
        const target = byPath.get(file.relativePath)
        if (!target) return false
        const expected =
          file.relativePath.toLowerCase() === 'skill.md'
            ? canonicalImportedSkillDocument(file.content, directoryName)
            : file.content
        if (
          target.size !== expected.length ||
          !(await readFile(target.absolutePath)).equals(expected)
        )
          return false
      }
      return true
    } catch {
      return false
    }
  }

  private async writeImported(
    directoryName: string,
    files: FetchedSkillFile[],
    url: string,
    signature: string
  ): Promise<void> {
    await this.store.assertOrdinaryReplacement('imported', directoryName)
    const dir = this.store.skillDirectory('imported', directoryName)
    const root = resolve(dir)
    const seen = new Set<string>()
    for (const file of files) {
      const target = resolve(dir, file.relativePath)
      if (target === root || !target.startsWith(root + sep)) {
        throw new Error(`Refusing to write skill file outside its directory: ${file.relativePath}`)
      }
      if (isAppOwnedSkillRootFile(file.relativePath)) {
        throw new Error(`Skill import may not include the reserved file ${file.relativePath}.`)
      }
      if (seen.has(target)) {
        throw new Error(`Duplicate file path in skill import: ${file.relativePath}`)
      }
      seen.add(target)
    }
    for (const target of seen) {
      for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
        if (seen.has(parent)) {
          throw new Error('Conflicting file and directory at the same path in skill import.')
        }
      }
    }

    const staged = await this.transactions.stage('imported', directoryName, async (staging) => {
      for (const file of files) {
        const target = join(staging, file.relativePath)
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(
            target,
            file.relativePath.toLowerCase() === 'skill.md'
              ? canonicalImportedSkillDocument(file.content, directoryName)
              : file.content,
            { flag: 'wx' }
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
              `Conflicting file paths in skill import (collision at ${file.relativePath}).`
            )
          }
          throw error
        }
      }
      await this.transactions.writeSourceManifest(staging, { url, signature })
    })
    await this.transactions.promote(staged)
  }
}
