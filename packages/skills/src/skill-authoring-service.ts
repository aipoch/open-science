import type { SkillHelperValidator } from './registered-helper-catalog'
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { skillMutationOwnerFor, type SkillMutationOwner } from './skill-mutation-owner'
import { isSkillPackageIgnoredPath, SKILL_IMPORT_LIMITS } from './skill-import-limits'
import { parseSkillDocument } from './frontmatter'
import type { BundledSkill } from './registry'
import {
  inspectSkillPackage,
  validateSkillPackage,
  type SkillValidationIssue
} from './skill-package-inspection'
import { SAFE_SKILL_NAME, assertUsableSkillName, parseUserSkillId } from './user-skill-repository'
import { isUnsafeSkillArchivePath } from './zip-extract'

export type SkillAuthoringCatalog = {
  list(): Promise<BundledSkill[]>
  withSkillRead<T>(id: string, read: (skill: BundledSkill) => Promise<T>): Promise<T | undefined>
  publishPersonalDirectory(name: string, sourcePath: string, overwrite: boolean): Promise<string>
  deletePublished(id: string): Promise<void>
}

type SkillAuthoringServiceOptions = {
  storageRoot: string
  validateHelper?: SkillHelperValidator
  catalog: SkillAuthoringCatalog
}

type ReadInput = { name: string; path?: string }
type EditInput = ReadInput & { content: string; oldString?: string }
type PublishInput = { name: string; overwrite?: boolean }
export type SkillDeletionTarget = Readonly<{
  name: string
  origin: SkillAuthoringOrigin
  id: string
}>

type SkillAuthoringOrigin = 'draft' | BundledSkill['source']

export type SkillAuthoringSummary = Readonly<{
  id: string
  name: string
  displayName: string
  description: string
  origin: SkillAuthoringOrigin
  editable: boolean
}>

export type SkillAuthoringReadResult = Readonly<{
  name: string
  origin: SkillAuthoringOrigin
  path: string
  content: string
  files?: string[]
}>

export type SkillAuthoringValidationResult = Readonly<{
  valid: boolean
  name: string
  origin: SkillAuthoringOrigin
  errors: SkillValidationIssue[]
  warnings: SkillValidationIssue[]
}>

type SkillAuthoringEditResult = Readonly<{
  status: 'edited'
  name: string
  path: string
  origin: 'draft'
}>

type SkillAuthoringPublishResult = Readonly<{
  status: 'published'
  id: string
  name: string
  origin: 'personal'
}>

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

const safeRelativePath = (value: unknown, fallback?: string): string => {
  const path = asString(value) ?? fallback
  if (!path || isUnsafeSkillArchivePath(path)) throw new Error('unsafe path')
  if (path.split('/').length - 1 > SKILL_IMPORT_LIMITS.maxDepth) {
    throw new Error('path is nested too deeply')
  }
  return path
}

const readBoundedText = async (path: string): Promise<string> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('path is not a regular file')
  if (metadata.size > SKILL_IMPORT_LIMITS.maxFileBytes) throw new Error('file is too large')
  return readFile(path, 'utf8')
}

const readPackageText = async (root: string, relativePath: string): Promise<string> => {
  let current = resolve(root)
  const parts = relativePath.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error('path contains a symbolic link')
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error('path parent is not a directory')
    }
  }
  return readBoundedText(current)
}

const personalSkillName = (skill: BundledSkill): string | undefined => {
  const parsed = parseUserSkillId(skill.id)
  return parsed?.source === 'personal' ? parsed.directoryName : undefined
}

const explicitDraftName = (reference: string): string | undefined => {
  if (!reference.startsWith('draft-')) return undefined
  const name = reference.slice('draft-'.length)
  return SAFE_SKILL_NAME.test(name) ? name : undefined
}

/** Owns draft files and authoring invariants. The caller owns transport and approval policy. */
export class SkillAuthoringService {
  private readonly draftsRoot: string
  private readonly mutations: SkillMutationOwner

  constructor(private readonly options: SkillAuthoringServiceOptions) {
    this.draftsRoot = join(options.storageRoot, 'skills', 'drafts')
    this.mutations = skillMutationOwnerFor(this.draftsRoot)
  }

  // A host can keep a multi-step operation serialized across a user decision. Reentrant calls
  // share this authoring owner; repository writes still use the root-wide repository lock.
  runMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.runExclusive(operation)
  }

  edit(input: EditInput): Promise<SkillAuthoringEditResult> {
    return this.runMutationExclusive(() => this.editDraft(input))
  }

  publish(input: PublishInput): Promise<SkillAuthoringPublishResult> {
    return this.runMutationExclusive(() => this.publishDraft(input))
  }

  private draftDir(name: string): string {
    return join(this.draftsRoot, name)
  }

  private async draftNames(): Promise<string[]> {
    try {
      return (await readdir(this.draftsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SAFE_SKILL_NAME.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  async list(): Promise<SkillAuthoringSummary[]> {
    const installed = (await this.options.catalog.list()).map((skill) => ({
      id: skill.id,
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      origin: skill.source,
      editable: skill.source === 'personal'
    }))
    const drafts = await Promise.all(
      (await this.draftNames()).map(async (draftName) => {
        let name = draftName
        let displayName = draftName
        let description = ''
        try {
          const parsed = parseSkillDocument(
            await readPackageText(this.draftDir(draftName), 'SKILL.md')
          )
          name = parsed.name?.trim() || draftName
          displayName = parsed.metadata.displayname?.trim() || name
          description = parsed.description ?? ''
        } catch {
          // An incomplete draft remains visible and editable under its stable name.
        }
        return {
          id: `draft-${draftName}`,
          name,
          displayName,
          description,
          origin: 'draft' as const,
          editable: true
        }
      })
    )
    return [...installed, ...drafts].sort((left, right) => left.name.localeCompare(right.name))
  }

  private async resolvePublished(name: string): Promise<BundledSkill | undefined> {
    const skills = await this.options.catalog.list()
    const exactIds = skills.filter((skill) => skill.id === name)
    if (exactIds.length > 1) throw new Error(`Skill id "${name}" is duplicated`)
    if (exactIds[0]) return exactIds[0]
    const matches = skills.filter((skill) => skill.name === name)
    if (matches.length > 1) throw new Error(`Skill reference "${name}" is ambiguous`)
    return matches[0]
  }

  private async readFromPackage(
    root: string,
    name: string,
    origin: SkillAuthoringOrigin,
    relativePath: string
  ): Promise<SkillAuthoringReadResult> {
    const files =
      relativePath === 'SKILL.md'
        ? (
            await inspectSkillPackage(root, {
              validateHelper: this.options.validateHelper,
              storageRoot: this.options.storageRoot
            })
          ).map(({ relativePath: path }) => path)
        : undefined
    return {
      name,
      path: relativePath,
      content: await readPackageText(root, relativePath),
      origin,
      ...(files ? { files } : {})
    }
  }

  async read(params: ReadInput): Promise<SkillAuthoringReadResult> {
    const requestedName = asString(params.name)?.trim()
    if (!requestedName) throw new Error('name is required')
    const relativePath = safeRelativePath(params.path, 'SKILL.md')
    const draftName =
      explicitDraftName(requestedName) ??
      (SAFE_SKILL_NAME.test(requestedName) ? requestedName : undefined)
    if (draftName && (await exists(this.draftDir(draftName)))) {
      return this.readFromPackage(this.draftDir(draftName), draftName, 'draft', relativePath)
    }

    const skill = await this.resolvePublished(requestedName)
    if (!skill) throw new Error(`Unknown Skill: ${requestedName}`)
    const result = await this.options.catalog.withSkillRead(skill.id, (lockedSkill) =>
      this.readFromPackage(
        lockedSkill.sourceDir,
        lockedSkill.name,
        lockedSkill.source,
        relativePath
      )
    )
    if (!result) throw new Error(`Unknown Skill: ${requestedName}`)
    return result
  }

  private async validationResult(
    sourceDir: string,
    name: string,
    origin: SkillAuthoringOrigin,
    expectedName?: string
  ): Promise<SkillAuthoringValidationResult> {
    const report = await validateSkillPackage(sourceDir, name, expectedName, {
      validateHelper: this.options.validateHelper,
      storageRoot: this.options.storageRoot
    })
    return {
      valid: report.errors.length === 0,
      name: report.name,
      origin,
      errors: report.errors,
      warnings: report.warnings
    }
  }

  async validate(params: ReadInput): Promise<SkillAuthoringValidationResult> {
    const requestedName = asString(params.name)?.trim()
    if (!requestedName) throw new Error('name is required')
    const draftName =
      explicitDraftName(requestedName) ??
      (SAFE_SKILL_NAME.test(requestedName) ? requestedName : undefined)
    if (draftName && (await exists(this.draftDir(draftName)))) {
      return this.validationResult(this.draftDir(draftName), draftName, 'draft', draftName)
    }

    const published = await this.resolvePublished(requestedName)
    if (!published) throw new Error(`Unknown Skill: ${requestedName}`)
    const result = await this.options.catalog.withSkillRead(published.id, (skill) =>
      this.validationResult(skill.sourceDir, skill.name, skill.source)
    )
    if (!result) throw new Error(`Unknown Skill: ${requestedName}`)
    return result
  }

  private async ensureDraft(name: string): Promise<{ name: string; path: string }> {
    if (!SAFE_SKILL_NAME.test(name)) {
      const existing = await this.resolvePublished(name)
      if (!existing) throw new Error('new Skill names must be lowercase hyphenated names')
      if (existing.source !== 'personal')
        throw new Error('built-in and imported Skills are read-only')
      const personalName = personalSkillName(existing)
      if (!personalName) throw new Error('personal Skill has no editable name')
      return this.seedPersonalDraft(existing, personalName)
    }

    const path = this.draftDir(name)
    if (await exists(path)) return { name, path }
    const existing = await this.resolvePublished(name)
    if (existing) {
      if (existing.source !== 'personal')
        throw new Error('built-in and imported Skills are read-only')
      return this.seedPersonalDraft(existing, personalSkillName(existing) ?? name)
    }
    assertUsableSkillName(name)
    await mkdir(path, { recursive: true })
    return { name, path }
  }

  private async seedPersonalDraft(
    skill: BundledSkill,
    name: string
  ): Promise<{ name: string; path: string }> {
    const destination = this.draftDir(name)
    if (await exists(destination)) return { name, path: destination }
    await mkdir(this.draftsRoot, { recursive: true })
    const staging = join(this.draftsRoot, `.${name}.seed-${randomUUID()}`)
    try {
      const seeded = await this.options.catalog.withSkillRead(skill.id, async (lockedSkill) => {
        await cp(lockedSkill.sourceDir, staging, {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: async (entry) => {
            if (
              isSkillPackageIgnoredPath(
                relative(lockedSkill.sourceDir, entry).replaceAll('\\', '/')
              )
            ) {
              return false
            }
            if ((await lstat(entry)).isSymbolicLink()) {
              throw new Error('refusing to draft a Skill containing a symbolic link')
            }
            return true
          }
        })
        await rename(staging, destination)
        return true
      })
      if (!seeded) throw new Error(`Unknown Skill: ${skill.id}`)
      return { name, path: destination }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async validateDraftBudget(
    root: string,
    target: string,
    nextBytes: number
  ): Promise<void> {
    const inventory = await inspectSkillPackage(root, {
      validateHelper: this.options.validateHelper,
      storageRoot: this.options.storageRoot
    })
    let count = inventory.length
    const total = inventory.reduce((sum, file) => sum + file.size, 0)
    const replacedBytes =
      inventory.find(({ absolutePath }) => resolve(absolutePath) === resolve(target))?.size ?? 0
    if (!(await exists(target))) count += 1
    if (count > SKILL_IMPORT_LIMITS.maxFiles) throw new Error('draft has too many files')
    if (total - replacedBytes + nextBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error('draft is too large')
    }
  }

  private async ensureSafeParent(root: string, relativePath: string): Promise<void> {
    const parts = relativePath.split('/').slice(0, -1)
    let current = root
    for (const part of parts) {
      current = join(current, part)
      try {
        const metadata = await lstat(current)
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error('path parent is not a safe directory')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(current)
      }
    }
  }

  private async editDraft(params: EditInput): Promise<SkillAuthoringEditResult> {
    const requestedName = asString(params.name)?.trim()
    const content = asString(params.content)
    if (!requestedName) throw new Error('name is required')
    if (content === undefined) throw new Error('content is required')
    if (Buffer.byteLength(content) > SKILL_IMPORT_LIMITS.maxFileBytes) {
      throw new Error('content is too large')
    }
    const relativePath = safeRelativePath(params.path)
    const explicitDraft = explicitDraftName(requestedName)
    const existingExplicitDraft =
      explicitDraft && (await exists(this.draftDir(explicitDraft))) ? explicitDraft : undefined
    const draft = await this.ensureDraft(existingExplicitDraft ?? requestedName)
    const target = resolve(draft.path, relativePath)
    const root = resolve(draft.path)
    if (!target.startsWith(root + sep)) throw new Error('unsafe path')
    await this.ensureSafeParent(root, relativePath)

    const hasOldString = Object.prototype.hasOwnProperty.call(params, 'oldString')
    let next = content
    if (hasOldString) {
      const oldString = asString(params.oldString)
      if (!oldString) throw new Error('oldString must be a non-empty string')
      const current = await readBoundedText(target)
      const first = current.indexOf(oldString)
      const second = first < 0 ? -1 : current.indexOf(oldString, first + 1)
      if (first < 0 || second >= 0) throw new Error('oldString must match exactly once')
      next = `${current.slice(0, first)}${content}${current.slice(first + oldString.length)}`
    } else if (await exists(target)) {
      throw new Error(`${relativePath} already exists; use oldString for an exact replacement`)
    }

    await this.validateDraftBudget(root, target, Buffer.byteLength(next))
    const temporary = join(dirname(target), `.host-skills-${randomUUID()}`)
    try {
      await writeFile(temporary, next, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return { status: 'edited', name: draft.name, path: relativePath, origin: 'draft' }
  }

  private async publishDraft(params: PublishInput): Promise<SkillAuthoringPublishResult> {
    const name = asString(params.name)?.trim()
    if (!name || !SAFE_SKILL_NAME.test(name)) throw new Error('a draft name is required')
    const overwrite = params.overwrite === true
    if (params.overwrite !== undefined && typeof params.overwrite !== 'boolean') {
      throw new Error('overwrite must be a boolean')
    }
    const draft = this.draftDir(name)
    if (!(await exists(draft))) throw new Error(`Unknown draft: ${name}`)
    const validation = await this.validationResult(draft, name, 'draft', name)
    if (!validation.valid) throw new Error(validation.errors[0]?.message ?? 'Skill is invalid')

    const id = await this.options.catalog.publishPersonalDirectory(name, draft, overwrite)
    try {
      await rm(draft, { recursive: true, force: true })
    } catch (error) {
      throw new Error(
        `Skill "${id}" was published, but draft cleanup failed. ` +
          `The draft "draft-${name}" may remain. Inspect the published Skill before any further mutation; do not republish to retry cleanup.`,
        { cause: error }
      )
    }
    return { status: 'published', id, name, origin: 'personal' }
  }

  async resolveDeletion(name: string): Promise<SkillDeletionTarget> {
    const requestedName = name.trim()
    if (!requestedName) throw new Error('name is required')
    const requestedDraft = explicitDraftName(requestedName)
    if (requestedDraft) {
      if (!(await exists(this.draftDir(requestedDraft))))
        throw new Error(`Unknown draft: ${requestedDraft}`)
      return { name: requestedDraft, origin: 'draft', id: `draft-${requestedDraft}` }
    }
    const published = await this.resolvePublished(requestedName)
    const unqualifiedDraft =
      SAFE_SKILL_NAME.test(requestedName) && (await exists(this.draftDir(requestedName)))
    if (published && published.id !== requestedName && unqualifiedDraft) {
      throw new Error(
        `ambiguous Skill name; use draft-${requestedName} or ${published.id} to choose what to delete`
      )
    }
    if (!published) {
      if (!unqualifiedDraft) throw new Error(`Unknown Skill: ${requestedName}`)
      return { name: requestedName, origin: 'draft', id: `draft-${requestedName}` }
    }
    if (published.source === 'featured') throw new Error('built-in Skills cannot be deleted')
    return { name: published.name, origin: published.source, id: published.id }
  }

  delete(name: string): Promise<SkillDeletionTarget> {
    return this.runMutationExclusive(async () => {
      const target = await this.resolveDeletion(name)
      if (target.origin === 'draft')
        await rm(this.draftDir(target.name), { recursive: true, force: true })
      else await this.options.catalog.deletePublished(target.id)
      return target
    })
  }
}
