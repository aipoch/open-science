import { cp, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { SkillReference, SkillSource } from '../../shared/settings'
import {
  frontmatterBlock,
  serializePersonalSkillDocument
} from '../../shared/personal-skill-document'
import { createLogger } from '../logger'
import type { BundledSkill } from './registry'
import { readSkillFile } from './skill-files'
import {
  decodeBoundedBase64,
  getBoundedBase64ByteLength,
  SKILL_IMPORT_LIMITS
} from './import-limits'
import { inspectSkillPackage } from './skill-package-inspection'
import {
  SOURCE_MANIFEST,
  type SkillPackageTransactionOwner
} from './skill-package-transaction-owner'
import { readSpecialistPackageSkillMetadata } from './specialist-package-adapter'
import type { UserSkillCompatibilityIndex } from './user-skill-compatibility-index'
import { SAFE_SKILL_NAME, SKILL_NAME_MAX_LENGTH, assertUsableSkillName } from './skill-name'
import { readSkillHelperDescriptors } from './registered-helper-catalog'

const log = createLogger('skills')

export const USER_SOURCES: ReadonlyArray<Extract<SkillSource, 'imported' | 'personal'>> = [
  'imported',
  'personal'
]

export type UserSkillSource = (typeof USER_SOURCES)[number]

export const SAFE_SKILL_DIRECTORY_NAME = /^[a-z0-9-]+$/

export { frontmatterBlock }
export {
  SAFE_SKILL_NAME,
  assertUsableSkillName,
  isReservedSkillName,
  isUsableSkillName,
  normalizeSkillName
} from './skill-name'

export const parseUserSkillId = (
  id: string
): { source: UserSkillSource; directoryName: string } | null => {
  for (const source of USER_SOURCES) {
    const prefix = `${source}-`
    if (id.startsWith(prefix)) {
      const directoryName = id.slice(prefix.length)
      if (SAFE_SKILL_DIRECTORY_NAME.test(directoryName)) return { source, directoryName }
    }
  }
  return null
}

export type WriteSkillInput = {
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
  references?: SkillReference[]
}

type ValidatePackage = (staging: string) => Promise<void>
type PreparedSkillWrite = {
  document: string
  references?: Map<string, SkillReference>
}

const packageFileSizeError = (): Error => new Error('Skill package contains an oversized file.')

const packageTotalSizeError = (): Error => new Error('Skill package exceeds the total size limit.')

const prepareSkillWrite = (input: WriteSkillInput): PreparedSkillWrite => {
  const document = serializePersonalSkillDocument(input)
  const documentBytes = Buffer.byteLength(document, 'utf8')
  if (documentBytes > SKILL_IMPORT_LIMITS.maxFileBytes) throw packageFileSizeError()
  if (input.references === undefined) return { document }

  const references = new Map<string, SkillReference>()
  for (const reference of input.references) {
    const name = reference.path.split(/[\\/]/).pop() ?? ''
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) continue
    references.set(name, reference)
  }

  if (references.size + 1 > SKILL_IMPORT_LIMITS.maxFiles) {
    throw new Error('Skill package has too many files.')
  }

  let totalBytes = documentBytes
  for (const reference of references.values()) {
    if (reference.dataBase64 === undefined) continue
    totalBytes += getBoundedBase64ByteLength(reference.dataBase64, SKILL_IMPORT_LIMITS.maxFileBytes)
    if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) throw packageTotalSizeError()
  }

  return { document, references }
}

// Owns the writable User Skill catalog and Personal Skill lifecycle. Import policy remains in the
// repository facade, which uses the store's path/catalog primitives inside the same transaction.
export class UserSkillStore {
  constructor(
    private readonly storageRoot: string,
    private readonly transactions: SkillPackageTransactionOwner,
    private readonly compatibilityIndex: UserSkillCompatibilityIndex
  ) {}

  sourceDir(source: UserSkillSource): string {
    return join(this.storageRoot, 'skills', source)
  }

  skillDirectory(source: UserSkillSource, directoryName: string): string {
    return join(this.sourceDir(source), directoryName)
  }

  // Hidden transaction directories never surface as package directory names or Skill ids.
  async listDirectoryNames(source: UserSkillSource): Promise<string[]> {
    try {
      return (await readdir(this.sourceDir(source))).filter((entry) => SAFE_SKILL_NAME.test(entry))
    } catch {
      return []
    }
  }

  async list(): Promise<BundledSkill[]> {
    return this.transactions.runRecovered(() => this.listSkillsLocked())
  }

  async withSkillReadLock<T>(
    id: string,
    read: (skill: BundledSkill) => Promise<T>
  ): Promise<T | undefined> {
    return this.transactions.runRecovered(async () => {
      const skill = (await this.listSkillsLocked()).find((entry) => entry.id === id)
      return skill ? read(skill) : undefined
    })
  }

  // Call only while the shared transaction owner is already locked and recovered.
  async listSkillsLocked(): Promise<BundledSkill[]> {
    const candidates: Array<{
      source: UserSkillSource
      directoryName: string
      sourceDir: string
      fields: Record<string, string>
      updatedAt: string
      packageId?: string
    }> = []

    for (const source of USER_SOURCES) {
      for (const directoryName of await this.listDirectoryNames(source)) {
        const sourceDir = this.skillDirectory(source, directoryName)

        try {
          const { fields } = await readSkillFile(sourceDir)
          const packageMetadata = await readSpecialistPackageSkillMetadata(sourceDir)
          candidates.push({
            source,
            directoryName,
            sourceDir,
            fields,
            updatedAt: (await stat(join(sourceDir, 'SKILL.md'))).mtime.toISOString(),
            packageId: packageMetadata?.id
          })
        } catch (error) {
          log.warn('skipping user skill with unreadable SKILL.md', {
            source,
            directoryName,
            error
          })
        }
      }
    }

    const compatibilityBySourceDir = new Map(
      (await this.compatibilityIndex.scan(candidates.map((candidate) => candidate.sourceDir))).map(
        (result) => [result.sourceDir, result]
      )
    )
    const skills: BundledSkill[] = []
    for (const candidate of candidates) {
      const compatibility = compatibilityBySourceDir.get(candidate.sourceDir)
      if (!compatibility || 'error' in compatibility) {
        log.warn('skipping user skill with unreadable package content', {
          source: candidate.source,
          directoryName: candidate.directoryName,
          error: compatibility && 'error' in compatibility ? compatibility.error : undefined
        })
        continue
      }
      const { source, directoryName, sourceDir, fields, updatedAt, packageId } = candidate
      skills.push({
        id: packageId ?? `${source}-${directoryName}`,
        // Writable Skill directories predate the explicit id/name model. The safe directory segment
        // is the canonical invocation/export name; legacy frontmatter remains display metadata until
        // an ordinary write or export normalizes the package bytes.
        name: directoryName,
        displayName: fields.displayname || fields.name || directoryName,
        description: fields.description ?? '',
        source,
        updatedAt,
        sourceDir,
        compatibility: compatibility.compatibility,
        author: fields.author,
        license: fields.license,
        thirdParty: fields['third-party'] ?? fields['third_party'] ?? fields.thirdparty,
        helpers: await readSkillHelperDescriptors(sourceDir)
      })
    }

    return skills
  }

  async resolveSkillId(id: string): Promise<{ source: UserSkillSource; directoryName: string }> {
    const conventional = parseUserSkillId(id)
    if (conventional) return conventional
    for (const source of USER_SOURCES) {
      for (const directoryName of await this.listDirectoryNames(source)) {
        const metadata = await readSpecialistPackageSkillMetadata(
          this.skillDirectory(source, directoryName)
        )
        if (metadata?.id === id) return { source, directoryName }
      }
    }
    throw new Error(`Not a user skill id: ${id}`)
  }

  async body(id: string): Promise<string> {
    return this.transactions.runRecovered(async () => {
      const parsed = await this.resolveSkillId(id)
      return (await readSkillFile(this.skillDirectory(parsed.source, parsed.directoryName))).body
    })
  }

  async createPersonal(
    input: WriteSkillInput,
    reservedNames: readonly string[] = []
  ): Promise<string> {
    const name = input.name.trim()
    assertUsableSkillName(name)
    const prepared = prepareSkillWrite({ ...input, name })

    return this.transactions.runRecovered(async () => {
      if (await this.skillNameTaken(name, reservedNames)) {
        throw new Error(`A skill named "${name}" already exists.`)
      }

      const staged = await this.transactions.stage('personal', name, async (staging) => {
        await mkdir(staging, { recursive: true })
        await this.writeSkillDirectory(staging, prepared)
        await inspectSkillPackage(staging)
      })
      await this.transactions.promote(staged)
      return `personal-${name}`
    }, ['personal'])
  }

  async publishPersonalDirectory(
    name: string,
    sourcePath: string,
    overwrite: boolean,
    validatePackage: ValidatePackage,
    reservedNames: readonly string[] = []
  ): Promise<string> {
    const normalizedName = name.trim()
    assertUsableSkillName(normalizedName)

    return this.transactions.runRecovered(async () => {
      const [personalTaken, importedTaken] = await Promise.all([
        this.directoryNameTaken('personal', normalizedName),
        this.directoryNameTaken('imported', normalizedName)
      ])
      if (
        reservedNames.includes(normalizedName) ||
        importedTaken ||
        (!overwrite && personalTaken)
      ) {
        throw new Error(`A skill named "${normalizedName}" already exists.`)
      }

      const staged = await this.transactions.stage('personal', normalizedName, async (staging) => {
        await cp(sourcePath, staging, {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: async (entry) => {
            if ((await lstat(entry)).isSymbolicLink()) {
              throw new Error('Refusing to publish a Skill containing a symbolic link.')
            }
            if (resolve(entry) === resolve(sourcePath, SOURCE_MANIFEST)) {
              throw new Error(`Skill publish may not include the reserved file ${SOURCE_MANIFEST}.`)
            }
            return true
          }
        })
        await validatePackage(staging)
      })
      await this.transactions.promote(staged)
      return `personal-${normalizedName}`
    }, ['personal'])
  }

  async updatePersonal(id: string, input: WriteSkillInput): Promise<void> {
    const parsed = parseUserSkillId(id)
    if (!parsed || parsed.source !== 'personal') throw new Error(`Not a personal skill id: ${id}`)
    const name = parsed.directoryName
    const prepared = prepareSkillWrite(input)

    await this.transactions.runRecovered(async () => {
      const live = this.skillDirectory('personal', name)
      const staged = await this.transactions.stage('personal', name, async (staging) => {
        await cp(live, staging, {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: async (entry) => {
            if ((await lstat(entry)).isSymbolicLink()) {
              throw new Error('Refusing to update a Skill containing a symbolic link.')
            }
            return true
          }
        })
        await this.writeSkillDirectory(staging, prepared)
        await inspectSkillPackage(staging)
      })
      await this.transactions.promote(staged)
    }, ['personal'])
  }

  async delete(id: string, guard?: (skillId: string) => Promise<void>): Promise<void> {
    return this.transactions.runRecovered(async () => {
      await guard?.(id)
      const parsed = await this.resolveSkillId(id)
      const metadata = await readSpecialistPackageSkillMetadata(
        this.skillDirectory(parsed.source, parsed.directoryName)
      )
      if (metadata?.ownerIds.length) {
        throw new Error('A Specialist-owned Skill cannot be deleted directly.')
      }
      await rm(this.skillDirectory(parsed.source, parsed.directoryName), {
        recursive: true,
        force: true
      })
    })
  }

  async uniqueImportedName(
    baseName: string,
    reservedNames: readonly string[] = []
  ): Promise<string> {
    // Every import adapter allocates its destination through this boundary. Reject app-owned
    // prefixes here so a successful import can never be immediately hidden by catalog policy.
    assertUsableSkillName(baseName)
    const taken = new Set([
      ...reservedNames,
      ...(await this.listDirectoryNames('imported')),
      ...(await this.listDirectoryNames('personal'))
    ])
    if (!taken.has(baseName)) return baseName
    for (let index = 2; ; index += 1) {
      const suffix = `-${index}`
      const candidate = `${baseName.slice(0, SKILL_NAME_MAX_LENGTH - suffix.length)}${suffix}`
      if (!taken.has(candidate)) return candidate
    }
  }

  private async skillNameTaken(
    name: string,
    reservedNames: readonly string[] = []
  ): Promise<boolean> {
    if (reservedNames.includes(name)) return true
    const taken = await Promise.all(
      USER_SOURCES.map((source) => this.directoryNameTaken(source, name))
    )
    return taken.some(Boolean)
  }

  async directoryNameTaken(source: UserSkillSource, directoryName: string): Promise<boolean> {
    return (await this.listDirectoryNames(source)).includes(directoryName)
  }

  private async writeSkillDirectory(
    directory: string,
    prepared: PreparedSkillWrite
  ): Promise<void> {
    await writeFile(join(directory, 'SKILL.md'), prepared.document, 'utf8')

    if (prepared.references === undefined) return

    const refsDir = join(directory, 'references')
    let existing: string[] = []
    try {
      existing = await readdir(refsDir)
    } catch {
      existing = []
    }
    for (const name of existing) {
      if (!prepared.references.has(name)) {
        const target = join(refsDir, name)
        if ((await lstat(target)).isFile()) await rm(target, { force: true })
      }
    }

    for (const [name, reference] of prepared.references) {
      if (reference.dataBase64 === undefined) continue
      const target = join(refsDir, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(
        target,
        decodeBoundedBase64(reference.dataBase64, SKILL_IMPORT_LIMITS.maxFileBytes)
      )
    }
  }
}
