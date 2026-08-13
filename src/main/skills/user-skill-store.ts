import { cp, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { dump as dumpYaml } from 'js-yaml'

import type { SkillReference, SkillSource } from '../../shared/settings'
import { createLogger } from '../logger'
import type { BundledSkill } from './registry'
import { readSkillFile } from './skill-files'
import {
  SOURCE_MANIFEST,
  type SkillPackageTransactionOwner
} from './skill-package-transaction-owner'
import { readSpecialistPackageSkillMetadata } from './specialist-package-adapter'

const log = createLogger('skills')

export const USER_SOURCES: ReadonlyArray<Extract<SkillSource, 'imported' | 'personal'>> = [
  'imported',
  'personal'
]

export type UserSkillSource = (typeof USER_SOURCES)[number]

export const SAFE_SKILL_DIRECTORY_NAME = /^[a-z0-9-]+$/

export const SAFE_SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX_LENGTH = 64
const RESERVED_SKILL_NAME_PREFIXES = ['os-', 'mcp-'] as const

export const assertUsableSkillName = (name: string): void => {
  if (!name) throw new Error('Skill name is required.')
  if (!SAFE_SKILL_NAME.test(name) || name.length > SKILL_NAME_MAX_LENGTH) {
    throw new Error('Skill name must use up to 64 lowercase letters, numbers, and single hyphens.')
  }
  if (RESERVED_SKILL_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`Skill name may not start with ${RESERVED_SKILL_NAME_PREFIXES.join(' or ')}.`)
  }
}

export const normalizeSkillName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

export const frontmatterBlock = (fields: Record<string, string>): string =>
  dumpYaml(fields, { lineWidth: -1 })

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

// Owns the writable User Skill catalog and Personal Skill lifecycle. Import policy remains in the
// repository facade, which uses the store's path/catalog primitives inside the same transaction.
export class UserSkillStore {
  constructor(
    private readonly storageRoot: string,
    private readonly transactions: SkillPackageTransactionOwner
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
      return (await readdir(this.sourceDir(source))).filter((entry) =>
        SAFE_SKILL_DIRECTORY_NAME.test(entry)
      )
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
    const skills: BundledSkill[] = []

    for (const source of USER_SOURCES) {
      for (const directoryName of await this.listDirectoryNames(source)) {
        const skillDirectory = this.skillDirectory(source, directoryName)

        try {
          const { fields } = await readSkillFile(skillDirectory)
          const packageMetadata = await readSpecialistPackageSkillMetadata(skillDirectory)
          const updatedAt = (await stat(join(skillDirectory, 'SKILL.md'))).mtime.toISOString()

          skills.push({
            id: packageMetadata?.id ?? `${source}-${directoryName}`,
            // Writable Skill directories predate the explicit id/name model. The safe directory
            // segment is the canonical invocation/export name; legacy frontmatter remains display
            // metadata until an ordinary write or export normalizes the package bytes.
            name: directoryName,
            displayName: fields.displayname || fields.name || directoryName,
            description: fields.description ?? '',
            source,
            updatedAt,
            sourceDir: skillDirectory,
            author: fields.author,
            license: fields.license,
            thirdParty: fields['third-party'] ?? fields['third_party'] ?? fields.thirdparty
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
    return this.transactions.runExclusive(async () => {
      const name = input.name.trim()
      assertUsableSkillName(name)
      if (await this.skillNameTaken(name, reservedNames)) {
        throw new Error(`A skill named "${name}" already exists.`)
      }
      await this.writeSkill('personal', name, { ...input, name })
      return `personal-${name}`
    })
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
    await this.transactions.runExclusive(() => this.writeSkill('personal', name, input))
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

  private async writeSkill(
    source: UserSkillSource,
    directoryName: string,
    input: WriteSkillInput
  ): Promise<void> {
    const dir = this.skillDirectory(source, directoryName)
    await mkdir(dir, { recursive: true })

    const metadata = Object.fromEntries(
      Object.entries(input.metadata ?? {}).filter(
        ([key, value]) =>
          key.toLowerCase() !== 'name' &&
          key.toLowerCase() !== 'description' &&
          /^[A-Za-z0-9_-]+$/.test(key) &&
          typeof value === 'string'
      )
    )
    const displayName = metadata.displayname
    delete metadata.displayname
    const frontmatter = `---\n${frontmatterBlock({
      name: input.name,
      description: input.description,
      ...(displayName ? { displayName } : {}),
      ...metadata
    })}---`
    await writeFile(join(dir, 'SKILL.md'), `${frontmatter}\n\n${input.body.trimStart()}`, 'utf8')

    if (input.references === undefined) return

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
