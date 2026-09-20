import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type {
  SkillReplacementPreview,
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
import { createTwoFilesPatch } from 'diff'
import {
  readSpecialistPackageSkillMetadata,
  specialistSkillContentHash
} from './specialist-package-adapter'
import type { BundledSkill } from './registry'
import { canonicalSkillDocument } from './skill-document-name'
import { selectSkillManifestRoots } from './skill-bundle-paths'
import { inspectSkillPackage } from './skill-package-inspection'
import { extractZip, extractZipLenient } from './zip-extract'
import type { SkillPackageTransactionOwner } from './skill-package-transaction-owner'
import type { ImportOutcome, ParsedSkillPreview } from './user-skill-import-contracts'
import type {
  SkillMarketplaceInstallation,
  SkillMarketplaceConflictReason,
  SkillMarketplaceUpdateImpact,
  SkillMarketplaceUpdatePreview
} from '../../shared/skill-marketplace'
import {
  marketplaceContentDigest,
  marketplaceReceiptSchema,
  type MarketplacePackage,
  type MarketplaceReceipt
} from './marketplace-package'
import {
  UserSkillStore,
  isUsableSkillName,
  normalizeSkillName,
  parseUserSkillId
} from './user-skill-store'

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

export class MarketplaceInstallConflict extends Error {
  constructor(
    message = 'Marketplace installation conflicts with local content',
    readonly reason: SkillMarketplaceConflictReason = 'installation-unverifiable'
  ) {
    super(message)
  }
}

type MarketplaceImpactReader = (id: string) => Promise<SkillMarketplaceUpdateImpact>
type MarketplaceTarget = {
  skill: BundledSkill & { source: 'personal' | 'imported' }
  files: FetchedSkillFile[]
  digest: string
  fingerprint: string
  metadata?: NonNullable<Awaited<ReturnType<typeof readSpecialistPackageSkillMetadata>>>
  receipt?: MarketplaceReceipt
  impact: SkillMarketplaceUpdateImpact
}

const newerStableVersion = (offered: string, installed: string): boolean => {
  const schema = marketplaceReceiptSchema.shape.version
  if (!schema.safeParse(offered).success || !schema.safeParse(installed).success) return false
  const left = offered.split('+')[0].split('.').map(BigInt)
  const right = installed.split('+')[0].split('.').map(BigInt)
  const different = left.findIndex((value, index) => value !== right[index])
  return different >= 0 && left[different] > right[different]
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
  private readonly marketplacePreviews = new Map<
    string,
    {
      expiresAt: number
      id: string
      release: string
      fingerprint: string
      completedFingerprint?: string
      localSkillId: string
    }
  >()

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

    const fallbackName = location.path.split('/').filter(Boolean).pop() ?? location.repo
    const existing = await this.transactions.runRecovered(() =>
      this.findImportedDirectoryNameByUrl(url)
    )
    if (!existing) {
      const { skillMd, files } = await fetchSkillPreview(location, fetcher, options)
      return parsedSkillPreview(skillMd.toString('utf8'), files, fallbackName)
    }
    // Updating needs actual bytes, including resources; a directory listing cannot identify edits.
    const files = await fetchSkillFiles(location, fetcher, options)
    assertOrdinarySkillFiles(files)
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md')!
    return this.transactions.runRecovered(async () => ({
      ...parsedSkillPreview(
        skillMd.content.toString('utf8'),
        files.map((file) => file.relativePath),
        fallbackName
      ),
      replacement: await this.replacementPreview(existing, files)
    }))
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
          const replaceableId = alreadyImported
            ? undefined
            : existing
              ? `imported-${existing}`
              : await this.replaceableImportedId(name)

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
            ...(replaceableId
              ? {
                  replacement: await this.replacementPreview(
                    parseUserSkillId(replaceableId)!.directoryName,
                    root.files
                  )
                }
              : {}),
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

  async marketplaceInstallation(
    id: string,
    offeredVersion: string,
    reservedNames: readonly string[],
    localSkills?: readonly BundledSkill[]
  ): Promise<SkillMarketplaceInstallation> {
    if (!isUsableSkillName(id)) return { kind: 'conflict', reason: 'invalid-name' }
    return this.transactions.runRecovered(async () => {
      try {
        const target = await this.marketplaceTarget(id, reservedNames, undefined, localSkills)
        if (target) {
          const { skill, receipt, digest, metadata } = target
          if (!receipt) return { kind: 'conflict', reason: 'name-taken', localSkillId: skill.id }
          if (receipt.installedContentSha256 !== digest)
            return { kind: 'conflict', reason: 'local-content-changed', localSkillId: skill.id }
          const requiresPreview = skill.source === 'personal' || Boolean(metadata)
          return {
            kind: 'installed',
            version: receipt.version,
            canUpdate: newerStableVersion(offeredVersion, receipt.version),
            ...(requiresPreview
              ? {
                  localSkillId: skill.id,
                  requiresPreview: true,
                  protected: Boolean(metadata?.ownerIds.length)
                }
              : {})
          }
        }
        if (await this.marketplaceNameTaken(id, reservedNames))
          return { kind: 'conflict', reason: 'name-taken' }
        return { kind: 'not-installed' }
      } catch (error) {
        return {
          kind: 'conflict',
          reason:
            error instanceof MarketplaceInstallConflict ? error.reason : 'installation-unverifiable'
        }
      }
    })
  }

  private async marketplaceTarget(
    id: string,
    reservedNames: readonly string[],
    readImpact?: MarketplaceImpactReader,
    localSkills?: readonly BundledSkill[]
  ): Promise<MarketplaceTarget | undefined> {
    if (!isUsableSkillName(id)) throw new MarketplaceInstallConflict(undefined, 'invalid-name')
    if (reservedNames.some((name) => name.toLowerCase() === id))
      throw new MarketplaceInstallConflict(undefined, 'name-taken')
    const matches = (localSkills ?? (await this.store.listSkillsLocked())).filter(
      (skill) => skill.name.toLowerCase() === id
    )
    if (matches.length > 1)
      throw new MarketplaceInstallConflict(undefined, 'installation-unverifiable')
    const match = matches[0]
    if (!match) return undefined
    if (match.source !== 'personal' && match.source !== 'imported')
      throw new MarketplaceInstallConflict()
    const skill = { ...match, source: match.source }
    const dir = this.store.skillDirectory(skill.source, skill.name)
    if (
      (await readdir(dir)).some(
        (name) =>
          isAppOwnedSkillRootFile(name) &&
          name !== '.source.json' &&
          name !== '.specialist-package.json'
      )
    )
      throw new MarketplaceInstallConflict()

    const readMarker = async (name: string): Promise<string | undefined> => {
      const path = join(dir, name)
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.nlink > 1 || info.size > 65536)
          throw new MarketplaceInstallConflict()
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    }
    const sourceRaw = await readMarker('.source.json')
    const metadataRaw = await readMarker('.specialist-package.json')
    const metadata =
      metadataRaw === undefined ? undefined : await readSpecialistPackageSkillMetadata(dir)
    if (metadataRaw !== undefined && (!metadata || metadata.id !== skill.id))
      throw new MarketplaceInstallConflict()
    let receipt: MarketplaceReceipt | undefined
    if (sourceRaw !== undefined) {
      let record: { marketplace?: unknown }
      try {
        record = JSON.parse(sourceRaw)
      } catch {
        throw new MarketplaceInstallConflict()
      }
      if (!record || typeof record !== 'object') throw new MarketplaceInstallConflict()
      if (record.marketplace !== undefined) {
        const parsed = marketplaceReceiptSchema.safeParse(record.marketplace)
        if (!parsed.success || parsed.data.id !== id) throw new MarketplaceInstallConflict()
        receipt = parsed.data
      }
    }
    const files = await Promise.all(
      (await inspectSkillPackage(dir)).map(async (file) => ({
        relativePath: file.relativePath,
        content: await readFile(file.absolutePath)
      }))
    )
    const digest = marketplaceContentDigest(files)
    const supplied = readImpact
      ? await readImpact(skill.id)
      : { mainEnabled: false, specialists: [] }
    const specialists = new Map(supplied.specialists.map((item) => [item.id, item]))
    for (const ownerId of metadata?.ownerIds ?? [])
      if (!specialists.has(ownerId)) specialists.set(ownerId, { id: ownerId, name: ownerId })
    const impact = {
      mainEnabled: supplied.mainEnabled,
      specialists: [...specialists.values()].sort((a, b) => a.id.localeCompare(b.id))
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          id: skill.id,
          source: skill.source,
          name: skill.name,
          digest,
          sourceRaw,
          metadataRaw,
          impact
        })
      )
      .digest('hex')
    return { skill, files, digest, fingerprint, metadata, receipt, impact }
  }

  async previewMarketplaceUpdate(
    pkg: MarketplacePackage,
    reservedNames: readonly string[],
    readImpact?: MarketplaceImpactReader
  ): Promise<SkillMarketplaceUpdatePreview> {
    return this.transactions.runRecovered(async () => {
      const target = await this.marketplaceTarget(pkg.receipt.id, reservedNames, readImpact)
      if (!target) throw new MarketplaceInstallConflict(undefined, 'name-taken')
      this.assertMarketplaceRelease(pkg, target.receipt)
      const incoming = pkg.files.map((file) => ({
        ...file,
        content:
          file.relativePath.toLowerCase() === 'skill.md'
            ? canonicalImportedSkillDocument(file.content, target.skill.name)
            : file.content
      }))
      const before = new Map(target.files.map((file) => [file.relativePath, file.content]))
      const added: string[] = [],
        modified: string[] = [],
        removed: string[] = []
      const differences: SkillMarketplaceUpdatePreview['differences'] = []
      let budget = 128 * 1024
      const difference = (path: string, oldBytes: Buffer, newBytes: Buffer): void => {
        let patch: string | undefined
        if (
          oldBytes.length + newBytes.length <= 32768 &&
          !oldBytes.includes(0) &&
          !newBytes.includes(0)
        ) {
          const oldText = oldBytes.toString('utf8'),
            newText = newBytes.toString('utf8')
          if (Buffer.from(oldText).equals(oldBytes) && Buffer.from(newText).equals(newBytes)) {
            const result = createTwoFilesPatch(
              path,
              path,
              oldText,
              newText,
              'Installed',
              'Marketplace',
              { context: 3, timeout: 25, maxEditLength: 4000 }
            )
            if (result && Buffer.byteLength(result) <= budget) {
              patch = result
              budget -= Buffer.byteLength(result)
            }
          }
        }
        differences.push({ path, ...(patch === undefined ? {} : { patch }) })
      }
      for (const file of incoming) {
        const old = before.get(file.relativePath)
        if (!old) added.push(file.relativePath)
        else if (!old.equals(file.content)) modified.push(file.relativePath)
        if (!old || !old.equals(file.content))
          difference(file.relativePath, old ?? Buffer.alloc(0), file.content)
        before.delete(file.relativePath)
      }
      for (const [path, bytes] of before) {
        removed.push(path)
        difference(path, bytes, Buffer.alloc(0))
      }
      const token = randomUUID()
      for (const [key, value] of this.marketplacePreviews)
        if (value.expiresAt < Date.now()) this.marketplacePreviews.delete(key)
      while (this.marketplacePreviews.size >= 20)
        this.marketplacePreviews.delete(this.marketplacePreviews.keys().next().value!)
      this.marketplacePreviews.set(token, {
        id: pkg.receipt.id,
        release: JSON.stringify(pkg.receipt),
        fingerprint: target.fingerprint,
        expiresAt: Date.now() + 10 * 60_000,
        localSkillId: target.skill.id
      })
      return {
        token,
        localSkillId: target.skill.id,
        displayName: target.skill.displayName,
        source: target.skill.source,
        ...(target.receipt || target.metadata
          ? { installedVersion: target.receipt?.version ?? target.metadata?.version }
          : {}),
        localChanges: target.receipt
          ? target.receipt.installedContentSha256 === target.digest
            ? 'unchanged'
            : 'modified'
          : 'unknown',
        ...target.impact,
        added: added.sort(),
        modified: modified.sort(),
        removed: removed.sort(),
        differences
      }
    })
  }

  private assertMarketplaceRelease(pkg: MarketplacePackage, current?: MarketplaceReceipt): void {
    marketplaceReceiptSchema.omit({ installedContentSha256: true }).parse(pkg.receipt)
    if (marketplaceContentDigest(pkg.files) !== pkg.receipt.contentSha256)
      throw new Error('Marketplace content changed before installation')
    assertOrdinarySkillFiles(pkg.files)
    if (
      current &&
      (current.version === pkg.receipt.version
        ? current.contentSha256 !== pkg.receipt.contentSha256 ||
          current.descriptorSha256 !== pkg.receipt.descriptorSha256
        : !newerStableVersion(pkg.receipt.version, current.version))
    )
      throw new MarketplaceInstallConflict(undefined, 'release-mismatch')
  }

  async installMarketplace(
    pkg: MarketplacePackage,
    expectedVersion: string | null,
    reservedNames: readonly string[],
    updateToken?: string,
    readImpact?: MarketplaceImpactReader,
    withImpactLock?: <T>(operation: () => Promise<T>) => Promise<T>
  ): Promise<ImportOutcome> {
    if (!isUsableSkillName(pkg.receipt.id)) {
      throw new MarketplaceInstallConflict(
        'Marketplace installation conflicts with local name rules'
      )
    }
    return this.transactions.runMutationRecovered(async () => {
      if (updateToken !== undefined) {
        const update = async (): Promise<ImportOutcome> => {
          const preview = this.marketplacePreviews.get(updateToken)
          if (
            !preview ||
            preview.expiresAt < Date.now() ||
            preview.id !== pkg.receipt.id ||
            preview.release !== JSON.stringify(pkg.receipt)
          )
            throw new MarketplaceInstallConflict(undefined, 'version-changed')
          const target = await this.marketplaceTarget(pkg.receipt.id, reservedNames, readImpact)
          if (!target || target.skill.id !== preview.localSkillId)
            throw new MarketplaceInstallConflict(undefined, 'version-changed')
          if (preview.completedFingerprint === target.fingerprint)
            return { id: target.skill.id, status: 'unchanged' }
          if (target.fingerprint !== preview.fingerprint)
            throw new MarketplaceInstallConflict(undefined, 'version-changed')
          this.assertMarketplaceRelease(pkg, target.receipt)
          const guard = async (): Promise<void> => {
            const current = await this.marketplaceTarget(pkg.receipt.id, reservedNames, readImpact)
            if (current?.fingerprint !== preview.fingerprint)
              throw new MarketplaceInstallConflict(undefined, 'version-changed')
          }
          await this.writeImported(
            target.skill.name,
            pkg.files,
            '',
            signatureOf(pkg.files),
            pkg.receipt,
            { source: target.skill.source, metadata: target.metadata, guard }
          )
          // Receipt promotion has committed. A subsequent read failure must not report a failed write.
          preview.completedFingerprint = await this.marketplaceTarget(
            pkg.receipt.id,
            reservedNames,
            readImpact
          ).then(
            (current) => current?.fingerprint,
            () => undefined
          )
          return { id: target.skill.id, status: 'updated' }
        }
        return withImpactLock ? withImpactLock(update) : update()
      }
      const receipt = marketplaceReceiptSchema
        .omit({ installedContentSha256: true })
        .parse(pkg.receipt)
      const { id } = receipt
      const source = await this.transactions.readImportedSource(id)
      const existing = source?.marketplace
      const conflict = (reason: SkillMarketplaceConflictReason): never => {
        throw new MarketplaceInstallConflict(undefined, reason)
      }
      if (existing) {
        await this.store.assertOrdinaryReplacement('imported', id).catch(() => {
          throw new MarketplaceInstallConflict(undefined, 'name-taken')
        })
        if (
          existing.id !== id ||
          (await this.installedDigest(id).catch(() => '')) !== existing.installedContentSha256
        )
          conflict('local-content-changed')
        // Repeated delivery after a successful install is safe only for the exact same release.
        if (
          existing.version === receipt.version &&
          existing.contentSha256 === receipt.contentSha256 &&
          existing.descriptorSha256 === receipt.descriptorSha256
        )
          return { status: 'unchanged', id: `imported-${id}` }
        if (
          expectedVersion !== existing.version ||
          !newerStableVersion(receipt.version, existing.version)
        )
          conflict(expectedVersion !== existing.version ? 'version-changed' : 'release-mismatch')
      } else if (expectedVersion !== null || (await this.marketplaceNameTaken(id, reservedNames)))
        conflict(expectedVersion !== null ? 'version-changed' : 'name-taken')
      if (marketplaceContentDigest(pkg.files) !== receipt.contentSha256)
        throw new Error('Marketplace content changed before installation')
      await this.writeImported(id, pkg.files, '', signatureOf(pkg.files), receipt)
      return { status: existing ? 'updated' : 'imported', id: `imported-${id}` }
    })
  }

  private async marketplaceNameTaken(
    id: string,
    reservedNames: readonly string[]
  ): Promise<boolean> {
    return (
      reservedNames.some((name) => name.toLowerCase() === id) ||
      (await this.store.directoryNameTaken('imported', id)) ||
      (await this.store.listSkillsLocked()).some((skill) => skill.name.toLowerCase() === id)
    )
  }

  private async installedDigest(id: string): Promise<string> {
    const files = await inspectSkillPackage(this.store.skillDirectory('imported', id))
    return marketplaceContentDigest(
      await Promise.all(
        files.map(async (file) => ({
          relativePath: file.relativePath,
          content: await readFile(file.absolutePath)
        }))
      )
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

  private async replacementPreview(
    directoryName: string,
    files: readonly FetchedSkillFile[]
  ): Promise<SkillReplacementPreview> {
    const source = await this.transactions.readImportedSource(directoryName)
    const location = source?.url ? parseGitHubSkillUrl(source.url) : undefined
    const preview: SkillReplacementPreview = {
      targetId: `imported-${directoryName}`,
      ...(location
        ? {
            sourceLabel: `github.com/${location.owner}/${location.repo}${location.ref ? `@${location.ref}` : ''}/${location.path}`
          }
        : {}),
      added: [],
      modified: [],
      removed: []
    }
    try {
      const installed = await inspectSkillPackage(
        this.store.skillDirectory('imported', directoryName)
      )
      const byPath = new Map(installed.map((file) => [file.relativePath, file]))
      for (const file of files) {
        const target = byPath.get(file.relativePath)
        if (!target) preview.added.push(file.relativePath)
        else {
          const expected =
            file.relativePath.toLowerCase() === 'skill.md'
              ? canonicalImportedSkillDocument(file.content, directoryName)
              : file.content
          if (
            target.size !== expected.length ||
            !(await readFile(target.absolutePath)).equals(expected)
          ) {
            preview.modified.push(file.relativePath)
          }
          byPath.delete(file.relativePath)
        }
      }
      preview.removed = [...byPath.keys()]
      preview.added.sort()
      preview.modified.sort()
      preview.removed.sort()
      return preview
    } catch {
      return { ...preview, added: [], modified: [], removed: [], comparisonUnavailable: true }
    }
  }

  private async writeImported(
    directoryName: string,
    files: FetchedSkillFile[],
    url: string,
    signature: string,
    marketplace?: Omit<MarketplaceReceipt, 'installedContentSha256'>,
    replacement?: {
      source: 'personal' | 'imported'
      metadata?: MarketplaceTarget['metadata']
      guard: () => Promise<void>
    }
  ): Promise<void> {
    const source = replacement?.source ?? 'imported'
    if (!replacement) await this.store.assertOrdinaryReplacement(source, directoryName)
    const dir = this.store.skillDirectory(source, directoryName)
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

    const staged = await this.transactions.stage(source, directoryName, async (staging) => {
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
      const installedContentSha256 =
        marketplace &&
        marketplaceContentDigest(
          files.map((file) => ({
            ...file,
            content:
              file.relativePath.toLowerCase() === 'skill.md'
                ? canonicalImportedSkillDocument(file.content, directoryName)
                : file.content
          }))
        )
      if (replacement?.metadata) {
        await writeFile(
          join(staging, '.specialist-package.json'),
          JSON.stringify({
            ...replacement.metadata,
            version: marketplace!.version,
            contentHash: await specialistSkillContentHash(staging)
          }),
          { flag: 'wx' }
        )
      }
      await this.transactions.writeSourceManifest(staging, {
        url,
        signature,
        ...(marketplace
          ? { marketplace: { ...marketplace, installedContentSha256: installedContentSha256! } }
          : {})
      })
    })
    try {
      await replacement?.guard()
      await this.transactions.promote(staged)
    } catch (error) {
      await this.transactions.discard(staged)
      throw error
    }
  }
}
