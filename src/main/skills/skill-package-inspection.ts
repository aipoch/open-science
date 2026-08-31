import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { marked } from 'marked'

import { isSkillPackageBudgetedPath, SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { frontmatterFieldNames, parseSkillDocument } from './frontmatter'
import { isUnsafeSkillArchivePath } from './zip-extract'
import { validateSkillHelperPackage } from './registered-helper-catalog'

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export type SkillPackageFile = Readonly<{
  absolutePath: string
  relativePath: string
  size: number
}>

export type SkillValidationIssue = Readonly<{
  code: string
  path: string
  message: string
}>

type SkillPackagePolicyReason =
  | 'unsafePath'
  | 'symbolicLink'
  | 'hardLink'
  | 'unsupportedEntry'
  | 'depthLimit'
  | 'fileCountLimit'
  | 'fileSizeLimit'
  | 'totalSizeLimit'

const POLICY_DETAILS: Record<SkillPackagePolicyReason, { code: string; message: string }> = {
  unsafePath: {
    code: 'unsafePackageEntry',
    message: 'Skill package contains a path that cannot be handled safely.'
  },
  symbolicLink: {
    code: 'unsafePackageEntry',
    message: 'Skill package contains a symbolic link.'
  },
  hardLink: {
    code: 'unsafePackageEntry',
    message: 'Skill package contains a hard link.'
  },
  unsupportedEntry: {
    code: 'unsupportedPackageEntry',
    message: 'Skill package contains an unsupported filesystem entry.'
  },
  depthLimit: {
    code: 'packageDepthExceeded',
    message: 'Skill package exceeds the maximum directory depth.'
  },
  fileCountLimit: {
    code: 'packageFileCountExceeded',
    message: 'Skill package has too many files.'
  },
  fileSizeLimit: {
    code: 'packageFileSizeExceeded',
    message: 'Skill package contains an oversized file.'
  },
  totalSizeLimit: {
    code: 'packageTotalSizeExceeded',
    message: 'Skill package exceeds the total size limit.'
  }
}

export class SkillPackagePolicyError extends Error {
  readonly code: string

  constructor(
    readonly reason: SkillPackagePolicyReason,
    readonly relativePath: string
  ) {
    const details = POLICY_DETAILS[reason]
    super(details.message)
    this.name = 'SkillPackagePolicyError'
    this.code = details.code
  }

  toIssue(): SkillValidationIssue {
    return { code: this.code, path: this.relativePath || '.', message: this.message }
  }
}

export const inspectSkillPackage = async (root: string): Promise<SkillPackageFile[]> => {
  const files: SkillPackageFile[] = []
  let totalBytes = 0

  const visit = async (
    directory: string,
    relativeDirectory: string,
    depth: number
  ): Promise<void> => {
    const directoryMetadata = await lstat(directory)
    if (directoryMetadata.isSymbolicLink()) {
      throw new SkillPackagePolicyError('symbolicLink', relativeDirectory)
    }
    if (!directoryMetadata.isDirectory()) {
      throw new SkillPackagePolicyError('unsupportedEntry', relativeDirectory)
    }
    if (depth > SKILL_IMPORT_LIMITS.maxDepth) {
      throw new SkillPackagePolicyError('depthLimit', relativeDirectory)
    }

    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareText(left.name, right.name)
    )
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name
      if (!isSkillPackageBudgetedPath(relativePath)) continue
      if (isUnsafeSkillArchivePath(relativePath)) {
        throw new SkillPackagePolicyError('unsafePath', relativePath)
      }

      const absolutePath = join(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new SkillPackagePolicyError('symbolicLink', relativePath)
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath, depth + 1)
        continue
      }
      if (!metadata.isFile()) {
        throw new SkillPackagePolicyError('unsupportedEntry', relativePath)
      }
      if (metadata.nlink > 1) throw new SkillPackagePolicyError('hardLink', relativePath)

      if (metadata.size > SKILL_IMPORT_LIMITS.maxFileBytes) {
        throw new SkillPackagePolicyError('fileSizeLimit', relativePath)
      }
      if (files.length + 1 > SKILL_IMPORT_LIMITS.maxFiles) {
        throw new SkillPackagePolicyError('fileCountLimit', relativePath)
      }
      totalBytes += metadata.size
      if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
        throw new SkillPackagePolicyError('totalSizeLimit', relativePath)
      }
      files.push({ absolutePath, relativePath, size: metadata.size })
    }
  }

  await visit(root, '', 0)
  // Helper descriptors are executable package metadata. Validate the staged bytes before Personal
  // or Imported transaction owners promote them into the live catalog.
  await validateSkillHelperPackage(root)
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const validTriggerEvals = (value: unknown): boolean =>
  isRecord(value) &&
  value.schema_version === 1 &&
  value.kind === 'trigger' &&
  Array.isArray(value.cases) &&
  value.cases.every(
    (item) =>
      isRecord(item) &&
      isNonEmptyString(item.id) &&
      isNonEmptyString(item.query) &&
      typeof item.should_trigger === 'boolean'
  )

const validOutputEvals = (value: unknown): boolean =>
  isRecord(value) &&
  value.schema_version === 1 &&
  isNonEmptyString(value.skill_id) &&
  isNonEmptyString(value.source_revision) &&
  Array.isArray(value.evals) &&
  value.evals.every(
    (item) =>
      isRecord(item) &&
      isNonEmptyString(item.id) &&
      isNonEmptyString(item.prompt) &&
      isNonEmptyString(item.expected_output) &&
      isStringArray(item.files) &&
      isStringArray(item.expectations)
  )

const collectMarkdownHrefs = (value: unknown, hrefs: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectMarkdownHrefs(item, hrefs)
    return
  }
  if (!isRecord(value)) return
  if ((value.type === 'link' || value.type === 'image') && typeof value.href === 'string') {
    hrefs.push(value.href)
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectMarkdownHrefs(child, hrefs)
  }
}

const localMarkdownTarget = (sourcePath: string, rawHref: string): string | undefined => {
  let href = rawHref.trim()
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim()
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//'))
    return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return undefined
  href = href.split(/[?#]/, 1)[0] ?? ''
  if (!href) return undefined
  try {
    href = decodeURIComponent(href)
  } catch {
    return undefined
  }
  const target = posix.normalize(posix.join(posix.dirname(sourcePath), href))
  return !target || target === '.' || isUnsafeSkillArchivePath(target) ? undefined : target
}

const compareIssues = (left: SkillValidationIssue, right: SkillValidationIssue): number => {
  for (const key of ['path', 'code', 'message'] as const) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  return 0
}

const sortedUniqueIssues = (issues: SkillValidationIssue[]): SkillValidationIssue[] => {
  const unique = new Map(
    issues.map((issue) => [`${issue.path}\0${issue.code}\0${issue.message}`, issue])
  )
  return [...unique.values()].sort(compareIssues)
}

export type SkillPackageValidation = Readonly<{
  name: string
  files: string[]
  errors: SkillValidationIssue[]
  warnings: SkillValidationIssue[]
}>

export const validateSkillPackage = async (
  root: string,
  packageName: string,
  expectedName?: string
): Promise<SkillPackageValidation> => {
  let inventory: SkillPackageFile[]
  try {
    inventory = await inspectSkillPackage(root)
  } catch (error) {
    if (!(error instanceof SkillPackagePolicyError)) throw error
    return { name: packageName, files: [], errors: [error.toIssue()], warnings: [] }
  }

  const files = inventory.map(({ relativePath }) => relativePath)
  const byPath = new Map(inventory.map((file) => [file.relativePath, file]))
  const errors: SkillValidationIssue[] = []
  const warnings: SkillValidationIssue[] = []
  const skillFile = byPath.get('SKILL.md')
  if (!skillFile) {
    errors.push({
      code: 'missingSkillDocument',
      path: 'SKILL.md',
      message: 'Skill package must contain SKILL.md at its root.'
    })
  } else {
    const skillDocument = await readFile(skillFile.absolutePath, 'utf8')
    const parsed = parseSkillDocument(skillDocument)
    if (!parsed.name?.trim() || !parsed.description?.trim()) {
      errors.push({
        code: 'missingRequiredFrontmatter',
        path: 'SKILL.md',
        message: 'SKILL.md requires name and description frontmatter.'
      })
    } else {
      const fieldNames = frontmatterFieldNames(skillDocument).sort()
      if (
        (fieldNames.length !== 2 && fieldNames.length !== 3) ||
        fieldNames[0] !== 'description' ||
        (fieldNames.length === 3 && fieldNames[1] !== 'displayname') ||
        fieldNames.at(-1) !== 'name'
      ) {
        errors.push({
          code: 'invalidFrontmatterFields',
          path: 'SKILL.md',
          message: 'SKILL.md frontmatter may only contain name, displayName, and description.'
        })
      } else if (expectedName && parsed.name.trim() !== expectedName) {
        errors.push({
          code: 'nameMismatch',
          path: 'SKILL.md',
          message: 'SKILL.md name must match the draft name.'
        })
      }
    }
    if (!parsed.body.trim()) {
      warnings.push({
        code: 'emptyBody',
        path: 'SKILL.md',
        message: 'SKILL.md has no instruction body.'
      })
    }
  }

  const fileSet = new Set(files)
  for (const file of inventory.filter(({ relativePath }) =>
    relativePath.toLowerCase().endsWith('.md')
  )) {
    const hrefs: string[] = []
    collectMarkdownHrefs(marked.lexer(await readFile(file.absolutePath, 'utf8')), hrefs)
    for (const href of hrefs) {
      const target = localMarkdownTarget(file.relativePath, href)
      if (target && !fileSet.has(target)) {
        warnings.push({
          code: 'missingLocalLink',
          path: file.relativePath,
          message: `Local Markdown target does not exist: ${target}.`
        })
      }
    }
  }

  for (const [path, isValid, code] of [
    ['trigger-evals.json', validTriggerEvals, 'invalidTriggerEvals'],
    ['evals/evals.json', validOutputEvals, 'invalidOutputEvals']
  ] as const) {
    const file = byPath.get(path)
    if (!file) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file.absolutePath, 'utf8'))
    } catch {
      errors.push({ code: 'invalidJson', path, message: `${path} must contain valid JSON.` })
      continue
    }
    if (!isValid(parsed)) {
      errors.push({
        code,
        path,
        message: `${path} does not match the supported version 1 structure.`
      })
    }
  }

  return {
    name: packageName,
    files,
    errors: sortedUniqueIssues(errors),
    warnings: sortedUniqueIssues(warnings)
  }
}
