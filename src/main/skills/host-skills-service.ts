import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { TrustedCallingSession } from '../../shared/agents-contract'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { frontmatterFieldNames, parseSkillDocument } from './frontmatter'
import type { BundledSkill } from './registry'
import { SAFE_SKILL_NAME, assertUsableSkillName, parseUserSkillId } from './user-skill-repository'
import { isUnsafeSkillArchivePath } from './zip-extract'

export type HostSkillsCatalog = {
  list(): Promise<BundledSkill[]>
  withSkillRead<T>(id: string, read: (skill: BundledSkill) => Promise<T>): Promise<T | undefined>
  publishPersonalDirectory(name: string, sourcePath: string, overwrite: boolean): Promise<string>
  deletePublished(id: string): Promise<void>
}

type HostSkillsServiceOptions = {
  storageRoot: string
  catalog: HostSkillsCatalog
  approveDelete?: (
    request: { name: string; origin: 'draft' | BundledSkill['source'] },
    context: TrustedCallingSession
  ) => Promise<boolean>
  onPublishedSkillsChanged?: () => Promise<void> | void
}

type Params = Record<string, unknown>

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

const personalDirectoryName = (skill: BundledSkill): string | undefined =>
  parseUserSkillId(skill.id)?.slug

const explicitDraftName = (reference: string): string | undefined => {
  if (!reference.startsWith('draft-')) return undefined
  const name = reference.slice('draft-'.length)
  return SAFE_SKILL_NAME.test(name) ? name : undefined
}

class HostSkillsCallError extends Error {
  constructor(operation: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(
      `host.skills.${operation}: ${message.replace(/(['"])(?:[A-Za-z]:\\|\/)[^'"]+\1/g, '<path>')}`
    )
    this.name = 'HostSkillsCallError'
  }
}

// Owns the complete conversational Skill lifecycle behind the single host.skills dispatcher seam.
// Draft storage, exact replacement, package validation, approval, and published read-back stay here;
// the RPC transport only supplies authenticated session context and the catalog adapter remains the
// authority for installed Skills and Specialist deletion guards.
export class HostSkillsService {
  private readonly draftsRoot: string
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: HostSkillsServiceOptions) {
    this.draftsRoot = join(options.storageRoot, 'skills', 'drafts')
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async dispatch(request: unknown, context: TrustedCallingSession = {}): Promise<unknown> {
    const op =
      request && typeof request === 'object' && 'op' in request
        ? asString((request as { op: unknown }).op)
        : undefined
    const paramsValue =
      request && typeof request === 'object' && 'params' in request
        ? (request as { params?: unknown }).params
        : undefined
    const params: Params =
      paramsValue && typeof paramsValue === 'object' && !Array.isArray(paramsValue)
        ? (paramsValue as Params)
        : {}

    try {
      if (op === 'list') return await this.list()
      if (op === 'read') return await this.read(params)
      if (op === 'validate') return await this.validate(params)
      if (op === 'edit') return await this.mutate(() => this.edit(params))
      if (op === 'publish') return await this.mutate(() => this.publish(params))
      if (op === 'delete') return await this.mutate(() => this.delete(params, context))
      throw new Error('Unknown operation')
    } catch (error) {
      throw new HostSkillsCallError(op ?? 'unknown', error)
    }
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

  private async list(): Promise<unknown[]> {
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
          origin: 'draft',
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

  private async read(params: Params): Promise<unknown> {
    const requestedName = asString(params.name)?.trim()
    if (!requestedName) throw new Error('name is required')
    const relativePath = safeRelativePath(params.path, 'SKILL.md')
    const draftName =
      explicitDraftName(requestedName) ??
      (SAFE_SKILL_NAME.test(requestedName) ? requestedName : undefined)
    if (draftName && (await exists(this.draftDir(draftName)))) {
      return {
        name: draftName,
        path: relativePath,
        content: await readPackageText(this.draftDir(draftName), relativePath),
        origin: 'draft'
      }
    }

    const skill = await this.resolvePublished(requestedName)
    if (!skill) throw new Error(`Unknown Skill: ${requestedName}`)
    const result = await this.options.catalog.withSkillRead(skill.id, async (lockedSkill) => ({
      name: lockedSkill.name,
      path: relativePath,
      content: await readPackageText(lockedSkill.sourceDir, relativePath),
      origin: lockedSkill.source
    }))
    if (!result) throw new Error(`Unknown Skill: ${requestedName}`)
    return result
  }

  private async validatePackage(sourceDir: string, expectedName?: string): Promise<string> {
    const skillDocument = await readPackageText(sourceDir, 'SKILL.md')
    const parsed = parseSkillDocument(skillDocument)
    if (!parsed.name?.trim() || !parsed.description?.trim()) {
      throw new Error('SKILL.md requires name and description frontmatter')
    }
    const fieldNames = frontmatterFieldNames(skillDocument).sort()
    if (
      (fieldNames.length !== 2 && fieldNames.length !== 3) ||
      fieldNames[0] !== 'description' ||
      (fieldNames.length === 3 && fieldNames[1] !== 'displayname') ||
      fieldNames.at(-1) !== 'name'
    ) {
      throw new Error('SKILL.md frontmatter may only contain name, displayName, and description')
    }
    const name = parsed.name.trim()
    if (expectedName && name !== expectedName)
      throw new Error('SKILL.md name must match the draft name')
    return name
  }

  private async validate(params: Params): Promise<unknown> {
    const requestedName = asString(params.name)?.trim()
    if (!requestedName) throw new Error('name is required')
    const draftName =
      explicitDraftName(requestedName) ??
      (SAFE_SKILL_NAME.test(requestedName) ? requestedName : undefined)
    if (draftName && (await exists(this.draftDir(draftName)))) {
      const name = await this.validatePackage(this.draftDir(draftName), draftName)
      return { valid: true, name, origin: 'draft' }
    }

    const published = await this.resolvePublished(requestedName)
    if (!published) throw new Error(`Unknown Skill: ${requestedName}`)
    const name = await this.options.catalog.withSkillRead(published.id, (skill) =>
      this.validatePackage(skill.sourceDir)
    )
    if (!name) throw new Error(`Unknown Skill: ${requestedName}`)
    return { valid: true, name, origin: published.source }
  }

  private async ensureDraft(name: string): Promise<{ name: string; path: string }> {
    if (!SAFE_SKILL_NAME.test(name)) {
      const existing = await this.resolvePublished(name)
      if (!existing) throw new Error('new Skill names must be lowercase hyphenated names')
      if (existing.source !== 'personal')
        throw new Error('built-in and imported Skills are read-only')
      const directoryName = personalDirectoryName(existing)
      if (!directoryName) throw new Error('personal Skill has no editable package name')
      return this.seedPersonalDraft(existing, directoryName)
    }

    const path = this.draftDir(name)
    if (await exists(path)) return { name, path }
    const existing = await this.resolvePublished(name)
    if (existing) {
      if (existing.source !== 'personal')
        throw new Error('built-in and imported Skills are read-only')
      return this.seedPersonalDraft(existing, personalDirectoryName(existing) ?? name)
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
    let count = 0
    let total = 0
    let replacedBytes = 0
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > SKILL_IMPORT_LIMITS.maxDepth) throw new Error('draft is nested too deeply')
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        const metadata = await lstat(path)
        if (metadata.isSymbolicLink()) throw new Error('draft contains a symbolic link')
        if (entry.isDirectory()) {
          await visit(path, depth + 1)
        } else if (entry.isFile()) {
          count += 1
          total += metadata.size
          if (resolve(path) === resolve(target)) replacedBytes = metadata.size
        }
      }
    }
    await visit(root, 0)
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

  private async edit(params: Params): Promise<unknown> {
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

    const hasOldString = Object.prototype.hasOwnProperty.call(params, 'old_string')
    let next = content
    if (hasOldString) {
      const oldString = asString(params.old_string)
      if (!oldString) throw new Error('old_string must be a non-empty string')
      const current = await readBoundedText(target)
      const first = current.indexOf(oldString)
      const second = first < 0 ? -1 : current.indexOf(oldString, first + oldString.length)
      if (first < 0 || second >= 0) throw new Error('old_string must match exactly once')
      next = `${current.slice(0, first)}${content}${current.slice(first + oldString.length)}`
    } else if (await exists(target)) {
      throw new Error(`${relativePath} already exists; use old_string for an exact replacement`)
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

  private async publish(params: Params): Promise<unknown> {
    const name = asString(params.name)?.trim()
    if (!name || !SAFE_SKILL_NAME.test(name)) throw new Error('a draft name is required')
    const overwrite = params.overwrite === true
    if (params.overwrite !== undefined && typeof params.overwrite !== 'boolean') {
      throw new Error('overwrite must be a boolean')
    }
    const draft = this.draftDir(name)
    if (!(await exists(draft))) throw new Error(`Unknown draft: ${name}`)
    await this.validatePackage(draft, name)

    const id = await this.options.catalog.publishPersonalDirectory(name, draft, overwrite)
    await rm(draft, { recursive: true, force: true })
    await this.options.onPublishedSkillsChanged?.()
    return { status: 'published', id, name, origin: 'personal' }
  }

  private async delete(params: Params, context: TrustedCallingSession): Promise<unknown> {
    const requestedName = asString(params.name)?.trim()
    if (!requestedName) throw new Error('name is required')

    const requestedDraft = explicitDraftName(requestedName)
    if (requestedDraft) {
      if (!(await exists(this.draftDir(requestedDraft)))) {
        throw new Error(`Unknown draft: ${requestedDraft}`)
      }
      const approved = await this.options.approveDelete?.(
        { name: requestedDraft, origin: 'draft' },
        context
      )
      if (!approved) return { status: 'declined', operation: 'delete' }
      await rm(this.draftDir(requestedDraft), { recursive: true, force: true })
      return { status: 'deleted', operation: 'delete', name: requestedDraft }
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
      if (!unqualifiedDraft) {
        throw new Error(`Unknown Skill: ${requestedName}`)
      }
      const approved = await this.options.approveDelete?.(
        { name: requestedName, origin: 'draft' },
        context
      )
      if (!approved) return { status: 'declined', operation: 'delete' }
      await rm(this.draftDir(requestedName), { recursive: true, force: true })
      return { status: 'deleted', operation: 'delete', name: requestedName }
    }
    if (published?.source === 'featured') throw new Error('built-in Skills cannot be deleted')

    const publicName = published.name
    const approved = await this.options.approveDelete?.(
      { name: publicName, origin: published.source },
      context
    )
    if (!approved) return { status: 'declined', operation: 'delete' }
    await this.options.catalog.deletePublished(published.id)
    await this.options.onPublishedSkillsChanged?.()
    return { status: 'deleted', operation: 'delete', name: publicName }
  }
}
