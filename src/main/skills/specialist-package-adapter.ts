import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import type { SpecialistPackageSkillPlan } from '../../shared/specialist-package'
import type { SpecialistPackageSkillPort } from '../specialist/package/skill-port'
import { writeDurableJsonFile } from '../storage/durable-json-file'
import { parseSkillDocument } from './frontmatter'
import { type SkillMutationOwner, skillMutationOwnerFor } from './skill-mutation-owner'

const SAFE_DIRECTORY_NAME = /^[a-z0-9-]+$/

export const SPECIALIST_PACKAGE_SKILL_METADATA = '.specialist-package.json'

type PackageSkillMetadata = {
  id: string
  version: string
  contentHash: string
  standalone: boolean
  ownerIds: string[]
  transactionId?: string
}

type SkillStorageSource = 'imported' | 'personal'

type SkillTransactionLocation = {
  directoryName: string
  source: SkillStorageSource
  // Written under the mutation lock before any rename, never inferred during recovery.
  hadLive?: boolean
  contentHash?: string
}

type PackageSkillTransaction = {
  version?: 2
  mode: 'install' | 'delete'
  locations: Map<string, SkillTransactionLocation>
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )

const readMetadata = async (directory: string): Promise<PackageSkillMetadata | undefined> => {
  try {
    const value = JSON.parse(
      await readFile(join(directory, SPECIALIST_PACKAGE_SKILL_METADATA), 'utf8')
    ) as PackageSkillMetadata
    return value &&
      typeof value.id === 'string' &&
      SAFE_DIRECTORY_NAME.test(value.id) &&
      typeof value.version === 'string' &&
      typeof value.contentHash === 'string' &&
      typeof value.standalone === 'boolean' &&
      Array.isArray(value.ownerIds) &&
      value.ownerIds.every((owner) => typeof owner === 'string')
      ? value
      : undefined
  } catch {
    return undefined
  }
}

const readTransaction = async (root: string): Promise<PackageSkillTransaction> => {
  const value = JSON.parse(await readFile(join(root, 'transaction.json'), 'utf8')) as {
    version?: unknown
    mode?: unknown
    skills?: unknown
    skillIds?: unknown
  }
  if (value.version !== undefined && value.version !== 2)
    throw new Error('Unknown Skill transaction version.')
  if (
    value.version === 2 &&
    (!Array.isArray(value.skills) ||
      !['install', 'delete'].includes(String(value.mode)) ||
      value.skills.some(
        (skill) =>
          !skill ||
          typeof skill !== 'object' ||
          typeof skill.localId !== 'string' ||
          !SAFE_DIRECTORY_NAME.test(skill.localId) ||
          typeof skill.directoryName !== 'string' ||
          !SAFE_DIRECTORY_NAME.test(skill.directoryName) ||
          !['personal', 'imported'].includes(skill.source) ||
          (skill.hadLive !== undefined && typeof skill.hadLive !== 'boolean') ||
          (skill.contentHash !== undefined &&
            (typeof skill.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(skill.contentHash)))
      ) ||
      new Set(value.skills.map((skill) => skill.localId)).size !== value.skills.length)
  )
    throw new Error('Invalid Skill transaction journal; preserve it for repair.')
  const locations = new Map<string, SkillTransactionLocation>()
  if (Array.isArray(value.skills)) {
    for (const skill of value.skills) {
      if (
        typeof skill === 'object' &&
        skill !== null &&
        'localId' in skill &&
        'directoryName' in skill &&
        typeof skill.localId === 'string' &&
        typeof skill.directoryName === 'string' &&
        SAFE_DIRECTORY_NAME.test(skill.localId) &&
        SAFE_DIRECTORY_NAME.test(skill.directoryName)
      ) {
        locations.set(skill.localId, {
          directoryName: skill.directoryName,
          source: 'source' in skill && skill.source === 'imported' ? 'imported' : 'personal',
          ...('hadLive' in skill && typeof skill.hadLive === 'boolean'
            ? { hadLive: skill.hadLive }
            : {}),
          ...('contentHash' in skill && typeof skill.contentHash === 'string'
            ? { contentHash: skill.contentHash }
            : {})
        })
      }
    }
  }
  // Transactions written before local IDs and directory names diverged only stored skillIds.
  if (Array.isArray(value.skillIds)) {
    for (const id of value.skillIds) {
      if (typeof id === 'string' && SAFE_DIRECTORY_NAME.test(id) && !locations.has(id)) {
        locations.set(id, { directoryName: id, source: 'personal' })
      }
    }
  }
  return {
    ...(value.version === 2 ? { version: 2 as const } : {}),
    mode: value.mode === 'delete' ? 'delete' : 'install',
    locations
  }
}

const directoryHash = async (directory: string): Promise<string> => {
  const files: Array<{ path: string; bytes: Buffer }> = []
  const visit = async (current: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === SPECIALIST_PACKAGE_SKILL_METADATA || entry.name === '.source.json')
        continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(current, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
        throw new Error('Unsafe Skill filesystem entry.')
      }
      if (metadata.isDirectory()) await visit(path, relative)
      else if (metadata.isFile()) files.push({ path: relative, bytes: await readFile(path) })
    }
  }
  await visit(directory)
  const hash = createHash('sha256')
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export class UserSkillSpecialistPackageAdapter implements SpecialistPackageSkillPort {
  private readonly personalRoot: string
  private readonly transactionRoot: string
  private readonly mutationOwner: SkillMutationOwner
  private readonly mutationReleases = new Map<string, () => void>()

  constructor(
    storageRoot: string,
    mutationOwner: SkillMutationOwner = skillMutationOwnerFor(storageRoot)
  ) {
    this.personalRoot = join(storageRoot, 'skills', 'personal')
    this.transactionRoot = join(storageRoot, 'specialist-package-skill-transactions')
    this.mutationOwner = mutationOwner
  }

  runMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutationOwner.runExclusive(operation)
  }

  async beginMutation(
    transactionId: string,
    _specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void> {
    if (!SAFE_DIRECTORY_NAME.test(transactionId) || this.mutationReleases.has(transactionId)) {
      throw new Error('Invalid package transaction identity.')
    }
    const release = await this.mutationOwner.acquire()
    try {
      const live = await this.snapshot()
      for (const skill of skills) {
        const localId = skill.localId ?? skill.id
        const current = live.find((candidate) => candidate.id === localId)
        if (skill.disposition === 'install') {
          if (
            current ||
            (await this.findSkillDirectory(localId)) ||
            (await exists(join(this.personalRoot, skill.id)))
          ) {
            throw new Error(`Skill ${skill.id} changed after preview.`)
          }
          continue
        }
        if (skill.disposition === 'reuse-owned' || skill.disposition === 'reuse-standalone') {
          if (
            !current ||
            current.version !== skill.version ||
            current.contentHash !== skill.contentHash ||
            (skill.disposition === 'reuse-standalone' &&
              (current.standalone === false || current.ownerIds.length > 0)) ||
            (skill.disposition === 'reuse-owned' &&
              (current.standalone !== false || current.ownerIds.length === 0))
          ) {
            throw new Error(`Skill ${skill.id} changed after preview.`)
          }
        }
        if (skill.disposition === 'replace-existing' || skill.disposition === 'reuse-existing') {
          if (
            !current ||
            current.version !== skill.conflict?.installedVersion ||
            current.contentHash !== skill.conflict.installedContentHash
          ) {
            throw new Error(`Skill ${skill.id} changed after preview.`)
          }
        }
      }
      this.mutationReleases.set(transactionId, release)
    } catch (error) {
      release()
      throw error
    }
  }

  async endMutation(transactionId: string): Promise<void> {
    const release = this.mutationReleases.get(transactionId)
    this.mutationReleases.delete(transactionId)
    release?.()
  }

  runInMutationContext<T>(transactionId: string, operation: () => Promise<T>): Promise<T> {
    if (!SAFE_DIRECTORY_NAME.test(transactionId) || !this.mutationReleases.has(transactionId)) {
      throw new Error('Skill mutation lock is not held for this transaction.')
    }
    return this.mutationOwner.runWithHeldLockContext(operation)
  }

  async snapshot(): Promise<PackageSkillMetadata[]> {
    const result: PackageSkillMetadata[] = []
    for (const source of ['imported', 'personal'] as const) {
      const root = join(dirname(this.personalRoot), source)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (!SAFE_DIRECTORY_NAME.test(entry)) continue
        const directory = join(root, entry)
        const metadata = await readMetadata(directory)
        try {
          if (metadata) {
            const document = parseSkillDocument(await readFile(join(directory, 'SKILL.md'), 'utf8'))
            result.push({
              id: metadata.id,
              version: document.metadata.version?.trim() ?? metadata.version,
              contentHash: await directoryHash(directory),
              standalone: metadata.standalone,
              ownerIds: metadata.ownerIds
            })
          } else {
            result.push({
              id: `${source}-${entry}`,
              version: '0.1.0',
              contentHash: await directoryHash(directory),
              standalone: true,
              ownerIds: []
            })
          }
        } catch {
          // An unreadable Skill cannot be reused, but must not block unrelated packages.
        }
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  }

  async exportSnapshot(skillIds: readonly string[]): Promise<
    Array<{
      localId: string
      name: string
      version: string
      contentHash: string
      files: Array<{ path: string; bytes: Uint8Array }>
    }>
  > {
    const requested = new Set(skillIds)
    const result: Array<{
      localId: string
      name: string
      version: string
      contentHash: string
      files: Array<{ path: string; bytes: Uint8Array }>
    }> = []
    for (const source of ['imported', 'personal'] as const) {
      const root = join(dirname(this.personalRoot), source)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (!SAFE_DIRECTORY_NAME.test(entry)) continue
        const directory = join(root, entry)
        const beforeMetadata = await readMetadata(directory)
        const localId = beforeMetadata?.id ?? `${source}-${entry}`
        if (!requested.has(localId)) continue
        const name = entry
        const beforeHash = await directoryHash(directory)
        const files: Array<{ path: string; bytes: Uint8Array }> = []
        const visit = async (current: string, prefix = ''): Promise<void> => {
          for (const child of (await readdir(current, { withFileTypes: true })).sort(
            (left, right) => left.name.localeCompare(right.name)
          )) {
            if (child.name === SPECIALIST_PACKAGE_SKILL_METADATA || child.name === '.source.json') {
              continue
            }
            const relative = prefix ? `${prefix}/${child.name}` : child.name
            const absolute = join(current, child.name)
            const metadata = await lstat(absolute)
            if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
              throw new Error('Unsafe Skill filesystem entry.')
            }
            if (metadata.isDirectory()) await visit(absolute, relative)
            else if (metadata.isFile()) {
              files.push({ path: relative, bytes: new Uint8Array(await readFile(absolute)) })
            }
          }
        }
        await visit(directory)
        files.sort((left, right) => left.path.localeCompare(right.path))
        const afterHash = await directoryHash(directory)
        const afterMetadata = await readMetadata(directory)
        if (
          beforeHash !== afterHash ||
          JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)
        ) {
          throw new Error('Skill changed during export. Preview again and retry.')
        }
        const skillDocument = files.find((file) => file.path === 'SKILL.md')
        const version = skillDocument
          ? parseSkillDocument(
              new TextDecoder().decode(skillDocument.bytes)
            ).metadata.version?.trim()
          : undefined
        result.push({
          localId,
          name,
          version: version ?? beforeMetadata?.version ?? '0.1.0',
          contentHash: afterHash,
          files
        })
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  async prepare(
    transactionId: string,
    specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void> {
    if (!SAFE_DIRECTORY_NAME.test(transactionId) || !SAFE_DIRECTORY_NAME.test(specialistId)) {
      throw new Error('Invalid package transaction identity.')
    }
    const root = this.transactionDir(transactionId)
    await rm(root, { recursive: true, force: true })
    try {
      await mkdir(root, { recursive: true })
      const locations = new Map(
        await Promise.all(
          skills.map(async (skill) => {
            const localId = skill.localId ?? skill.id
            const existingDirectory = await this.findSkillDirectory(localId)
            return [
              localId,
              {
                directoryName: existingDirectory ? basename(existingDirectory) : skill.id,
                source:
                  existingDirectory && dirname(existingDirectory) !== this.personalRoot
                    ? ('imported' as const)
                    : ('personal' as const),
                existingDirectory
              }
            ] as const
          })
        )
      )
      await writeFile(
        join(root, 'transaction.json'),
        `${JSON.stringify({
          version: 2,
          mode: 'install',
          skills: skills
            .map((skill) => {
              const localId = skill.localId ?? skill.id
              const location = locations.get(localId)!
              return {
                localId,
                directoryName: location.directoryName,
                source: location.source
              }
            })
            .sort((left, right) => left.localId.localeCompare(right.localId))
        })}\n`,
        { flag: 'wx' }
      )
      for (const skill of skills) {
        if (!SAFE_DIRECTORY_NAME.test(skill.id)) throw new Error('Invalid bundled Skill ID.')
        const localId = skill.localId ?? skill.id
        if (!SAFE_DIRECTORY_NAME.test(localId)) throw new Error('Invalid local Skill ID.')
        const staging = join(root, 'staging', localId)
        const stagingRoot = resolve(staging)
        const existingDirectory =
          locations.get(localId)?.existingDirectory ?? join(this.personalRoot, skill.id)
        if (skill.disposition === 'reuse-owned') {
          // Reuse preserves the current tree; only ownership metadata changes.
          await mkdir(dirname(staging), { recursive: true })
          await cp(existingDirectory, staging, { recursive: true, errorOnExist: true })
          if ((await directoryHash(staging)) !== skill.contentHash) {
            throw new Error(`Skill ${skill.id} changed after preview.`)
          }
        } else await mkdir(staging, { recursive: true })
        for (const file of skill.disposition === 'reuse-owned' ? [] : skill.filesToInstall) {
          const target = resolve(staging, file.path)
          if (
            target === stagingRoot ||
            !target.startsWith(stagingRoot + sep) ||
            file.path === SPECIALIST_PACKAGE_SKILL_METADATA
          ) {
            throw new Error('Unsafe bundled Skill path.')
          }
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.bytes, { flag: 'wx' })
        }
        const existing = await readMetadata(existingDirectory)
        const ownerIds = [...new Set([...(existing?.ownerIds ?? []), specialistId])].sort()
        const metadata: PackageSkillMetadata = {
          id: localId,
          transactionId,
          version: skill.version,
          contentHash: skill.contentHash,
          standalone:
            skill.disposition === 'replace-existing' ? false : (existing?.standalone ?? false),
          ownerIds
        }
        await writeFile(
          join(staging, SPECIALIST_PACKAGE_SKILL_METADATA),
          `${JSON.stringify(metadata)}\n`,
          { flag: skill.disposition === 'reuse-owned' ? 'w' : 'wx' }
        )
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async prepareDeletion(
    transactionId: string,
    specialistId: string,
    ownedSkillIds: readonly string[],
    deleteSkillIds: readonly string[]
  ): Promise<void> {
    if (!SAFE_DIRECTORY_NAME.test(transactionId) || !SAFE_DIRECTORY_NAME.test(specialistId)) {
      throw new Error('Invalid package transaction identity.')
    }
    const affected = [...new Set([...ownedSkillIds, ...deleteSkillIds])].sort()
    const deleting = new Set(deleteSkillIds)
    const root = this.transactionDir(transactionId)
    await rm(root, { recursive: true, force: true })
    try {
      await mkdir(root, { recursive: true })
      const transactionSkills = await Promise.all(
        affected.map(async (id) => {
          if (!SAFE_DIRECTORY_NAME.test(id)) throw new Error('Invalid affected Skill ID.')
          const live = await this.findSkillDirectory(id)
          if (!live) {
            if (deleting.has(id)) throw new Error(`Selected Skill ${id} is no longer installed.`)
            return undefined
          }
          const metadata = await readMetadata(live)
          if (!deleting.has(id) && (!metadata || !metadata.ownerIds.includes(specialistId))) {
            return undefined
          }
          return {
            localId: id,
            directoryName: basename(live),
            source:
              dirname(live) === this.personalRoot ? ('personal' as const) : ('imported' as const),
            live,
            metadata
          }
        })
      )
      const affectedTransactionSkills = transactionSkills.filter(
        (skill): skill is NonNullable<typeof skill> => skill !== undefined
      )
      await writeFile(
        join(root, 'transaction.json'),
        `${JSON.stringify({
          version: 2,
          mode: 'delete',
          skills: affectedTransactionSkills.map(({ localId, directoryName, source }) => ({
            localId,
            directoryName,
            source
          }))
        })}\n`,
        { flag: 'wx' }
      )
      for (const { localId: id, live, metadata } of affectedTransactionSkills) {
        if (deleting.has(id)) continue
        if (!metadata) throw new Error(`Owned Skill ${id} has no ownership metadata.`)
        const staging = join(root, 'staging', id)
        await mkdir(dirname(staging), { recursive: true })
        await cp(live, staging, { recursive: true, errorOnExist: true })
        const ownerIds = metadata.ownerIds.filter((ownerId) => ownerId !== specialistId).sort()
        await writeFile(
          join(staging, SPECIALIST_PACKAGE_SKILL_METADATA),
          `${JSON.stringify({
            ...metadata,
            transactionId,
            ownerIds,
            standalone: metadata.standalone || ownerIds.length === 0
          })}\n`,
          'utf8'
        )
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async commit(transactionId: string): Promise<void> {
    const root = this.transactionDir(transactionId)
    const stagingRoot = join(root, 'staging')
    const transaction = await readTransaction(root)
    const locations = transaction.locations
    for (const [id, location] of locations) {
      if (location.hadLive !== undefined)
        throw new Error('Skill commit already started; recover it first.')
      const staging = join(stagingRoot, id)
      location.hadLive = await exists(
        join(dirname(this.personalRoot), location.source, location.directoryName)
      )
      if (await exists(staging)) location.contentHash = await directoryHash(staging)
      else if (transaction.mode === 'install') throw new Error('Skill preparation is incomplete.')
    }
    await writeDurableJsonFile(
      join(root, 'transaction.json'),
      JSON.stringify({
        version: 2,
        mode: transaction.mode,
        skills: [...locations].map(([localId, location]) => ({ localId, ...location }))
      })
    )
    await mkdir(this.personalRoot, { recursive: true })
    await mkdir(join(root, 'backup'), { recursive: true })
    for (const [id, { directoryName, source }] of [...locations].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const live = join(dirname(this.personalRoot), source, directoryName)
      const backup = join(root, 'backup', id)
      const staging = join(stagingRoot, id)
      if (await exists(live)) await rename(live, backup)
      if (await exists(staging)) await rename(staging, live)
    }
  }

  async rollback(transactionId: string): Promise<void> {
    await this.recover(transactionId, 'rollback')
  }

  async recover(transactionId: string | undefined, outcome: 'commit' | 'rollback'): Promise<void> {
    if (transactionId === undefined) {
      let transactions: string[] = []
      try {
        transactions = await readdir(this.transactionRoot)
      } catch {
        return
      }
      for (const id of transactions.filter((entry) => SAFE_DIRECTORY_NAME.test(entry))) {
        await this.recover(id, 'rollback')
      }
      return
    }
    const root = this.transactionDir(transactionId)
    const stagingRoot = join(root, 'staging')
    const backupRoot = join(root, 'backup')
    const locations = new Map<string, SkillTransactionLocation>()
    let mode: 'install' | 'delete' = 'install'
    let version: 2 | undefined
    try {
      const transaction = await readTransaction(root)
      mode = transaction.mode
      version = transaction.version
      for (const [id, location] of transaction.locations) locations.set(id, location)
    } catch (error) {
      // A damaged journal is not an empty transaction. Preserve all evidence for repair.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const directory of [stagingRoot, backupRoot]) {
      try {
        for (const id of await readdir(directory)) {
          if (SAFE_DIRECTORY_NAME.test(id) && !locations.has(id)) {
            locations.set(id, { directoryName: id, source: 'personal' })
          }
        }
      } catch {
        // A missing phase directory is an expected durable state.
      }
    }
    if (outcome === 'rollback') {
      for (const [id, { directoryName, source, hadLive, contentHash }] of [...locations].sort(
        ([left], [right]) => left.localeCompare(right)
      )) {
        const live = join(dirname(this.personalRoot), source, directoryName)
        const staging = join(stagingRoot, id)
        const backup = join(backupRoot, id)
        const hasLive = await exists(live)
        const assertPromotedByThisTransaction = async (): Promise<void> => {
          if (
            (await readMetadata(live))?.transactionId !== transactionId ||
            !contentHash ||
            (await directoryHash(live)) !== contentHash
          ) {
            throw new Error(
              `Skill ${id} cannot be safely rolled back; preserve the transaction for repair.`
            )
          }
        }
        if (await exists(backup)) {
          if (version === 2 && hasLive) await assertPromotedByThisTransaction()
          await rm(live, { recursive: true, force: true })
          await mkdir(dirname(live), { recursive: true })
          await rename(backup, live)
        } else if (mode !== 'delete' && !(await exists(staging)) && hasLive) {
          if (version !== 2) {
            throw new Error(
              `Legacy Skill transaction ${transactionId} is ambiguous; preserve it for repair.`
            )
          }
          if (hadLive === false) {
            await assertPromotedByThisTransaction()
            await rm(live, { recursive: true, force: true })
          }
          // No commit intent means preparation never reached the first swap. hadLive=true
          // without a backup also covers an original already restored by a previous recovery.
        }
      }
    } else {
      for (const [id, { directoryName, source }] of [...locations].sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        const live = join(dirname(this.personalRoot), source, directoryName)
        const staging = join(stagingRoot, id)
        const backup = join(backupRoot, id)
        if (await exists(staging)) {
          if ((await exists(live)) && !(await exists(backup))) await rename(live, backup)
          await mkdir(dirname(live), { recursive: true })
          await rename(staging, live)
        }
        await rm(backup, { recursive: true, force: true })
      }
    }
    await rm(root, { recursive: true, force: true })
  }

  private transactionDir(transactionId: string): string {
    if (!SAFE_DIRECTORY_NAME.test(transactionId)) {
      throw new Error('Invalid package transaction identity.')
    }
    return join(this.transactionRoot, transactionId)
  }

  private async findSkillDirectory(id: string): Promise<string | undefined> {
    for (const source of ['imported', 'personal'] as const) {
      const root = join(dirname(this.personalRoot), source)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch {
        continue
      }
      for (const entry of entries
        .filter((candidate) => SAFE_DIRECTORY_NAME.test(candidate))
        .sort()) {
        const directory = join(root, entry)
        const metadata = await readMetadata(directory)
        if (metadata?.id === id || (!metadata && `${source}-${entry}` === id)) return directory
      }
    }
    return undefined
  }
}

export { readMetadata as readSpecialistPackageSkillMetadata }
