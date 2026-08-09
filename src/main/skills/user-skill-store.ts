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

// Only lowercase slugs so a skill id maps 1:1 to a safe directory name.
export const SAFE_SLUG = /^[a-z0-9-]+$/

const RESERVED_SLUG_PREFIXES = ['os-', 'mcp-'] as const

export const assertUsableSlug = (slug: string): void => {
  if (!slug) throw new Error('Skill ID is required.')
  if (!SAFE_SLUG.test(slug)) {
    throw new Error('Skill ID may only contain lowercase letters, numbers, and hyphens.')
  }
  if (RESERVED_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) {
    throw new Error(`Skill ID may not start with ${RESERVED_SLUG_PREFIXES.join(' or ')}.`)
  }
}

export const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

export const frontmatterBlock = (fields: Record<string, string>): string =>
  dumpYaml(fields, { lineWidth: -1 })

export const parseUserSkillId = (id: string): { source: UserSkillSource; slug: string } | null => {
  for (const source of USER_SOURCES) {
    const prefix = `${source}-`
    if (id.startsWith(prefix)) {
      const slug = id.slice(prefix.length)
      if (SAFE_SLUG.test(slug)) return { source, slug }
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

  skillDir(source: UserSkillSource, slug: string): string {
    return join(this.sourceDir(source), slug)
  }

  // Hidden transaction directories never surface as slugs or skill ids.
  async listSlugs(source: UserSkillSource): Promise<string[]> {
    try {
      return (await readdir(this.sourceDir(source))).filter((entry) => SAFE_SLUG.test(entry))
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
      for (const slug of await this.listSlugs(source)) {
        const skillDir = this.skillDir(source, slug)

        try {
          const { fields } = await readSkillFile(skillDir)
          const packageMetadata = await readSpecialistPackageSkillMetadata(skillDir)
          const updatedAt = (await stat(join(skillDir, 'SKILL.md'))).mtime.toISOString()

          skills.push({
            id: packageMetadata?.id ?? `${source}-${slug}`,
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

  async resolveSkillId(id: string): Promise<{ source: UserSkillSource; slug: string }> {
    const conventional = parseUserSkillId(id)
    if (conventional) return conventional
    for (const source of USER_SOURCES) {
      for (const slug of await this.listSlugs(source)) {
        const metadata = await readSpecialistPackageSkillMetadata(this.skillDir(source, slug))
        if (metadata?.id === id) return { source, slug }
      }
    }
    throw new Error(`Not a user skill id: ${id}`)
  }

  async body(id: string): Promise<string> {
    return this.transactions.runRecovered(async () => {
      const parsed = await this.resolveSkillId(id)
      return (await readSkillFile(this.skillDir(parsed.source, parsed.slug))).body
    })
  }

  async createPersonal(input: WriteSkillInput, requestedSlug?: string): Promise<string> {
    return this.transactions.runExclusive(async () => {
      if (requestedSlug !== undefined) {
        const slug = requestedSlug.trim()
        assertUsableSlug(slug)
        if (await this.slugTaken('personal', slug)) {
          throw new Error(`A skill with ID "${slug}" already exists.`)
        }
        await this.writeSkill('personal', slug, input)
        return `personal-${slug}`
      }

      const slug = await this.uniqueSlug('personal', toSlug(input.name) || 'skill')
      await this.writeSkill('personal', slug, input)
      return `personal-${slug}`
    })
  }

  async publishPersonalDirectory(
    requestedSlug: string,
    sourcePath: string,
    overwrite: boolean,
    validatePackage: ValidatePackage
  ): Promise<string> {
    const slug = requestedSlug.trim()
    assertUsableSlug(slug)

    return this.transactions.runRecovered(async () => {
      if (!overwrite && (await this.slugTaken('personal', slug))) {
        throw new Error(`A skill with ID "${slug}" already exists.`)
      }

      const staged = await this.transactions.stage('personal', slug, async (staging) => {
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
      return `personal-${slug}`
    }, ['personal'])
  }

  async updatePersonal(id: string, input: WriteSkillInput): Promise<void> {
    const parsed = parseUserSkillId(id)
    if (!parsed || parsed.source !== 'personal') throw new Error(`Not a personal skill id: ${id}`)
    await this.transactions.runExclusive(() => this.writeSkill('personal', parsed.slug, input))
  }

  async delete(id: string, guard?: (skillId: string) => Promise<void>): Promise<void> {
    return this.transactions.runRecovered(async () => {
      await guard?.(id)
      const parsed = await this.resolveSkillId(id)
      const metadata = await readSpecialistPackageSkillMetadata(
        this.skillDir(parsed.source, parsed.slug)
      )
      if (metadata?.ownerIds.length) {
        throw new Error('A Specialist-owned Skill cannot be deleted directly.')
      }
      await rm(this.skillDir(parsed.source, parsed.slug), { recursive: true, force: true })
    })
  }

  async uniqueSlug(source: UserSkillSource, base: string): Promise<string> {
    const taken = new Set(await this.listSlugs(source))
    if (!taken.has(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
  }

  async slugTaken(source: UserSkillSource, slug: string): Promise<boolean> {
    return (await this.listSlugs(source)).includes(slug)
  }

  private async writeSkill(
    source: UserSkillSource,
    slug: string,
    input: WriteSkillInput
  ): Promise<void> {
    const dir = this.skillDir(source, slug)
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
    const frontmatter = `---\n${frontmatterBlock({
      name: input.name,
      description: input.description,
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
