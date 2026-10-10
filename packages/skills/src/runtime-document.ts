import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKILL_IMPORT_LIMITS } from './skill-import-limits'
import { parseFrontmatter } from './skill-frontmatter'
const SAFE_PROJECTED_SKILL_NAME = /^(?=.{1,128}$)[a-z0-9]+[a-z0-9_-]*$/
const SKILL_CATALOG_READ_CHUNK_BYTES = 64 * 1024
const MAX_SKILL_CATALOG_DESCRIPTION_LENGTH = 1024
const MAX_ADVERTISED_SKILL_COUNT = 256
const MAX_SKILL_CATALOG_SCHEMA_BYTES = 64 * 1024
const SKILL_CATALOG_SCHEMA_RESERVED_BYTES = 2 * 1024
type SkillRuntimeEnvironment = Readonly<{
  root: string
  skillsDirectory?: string
  allowedNames?: ReadonlySet<string>
}>

type SkillRuntimeCatalogEntry = Readonly<{
  name: string
  description: string
}>

type SkillRuntimeCatalog = Readonly<{
  entries: readonly SkillRuntimeCatalogEntry[]
  truncated: boolean
}>

const requireRealDirectory = async (path: string, label: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} is not a real directory.`)
  }
}

// The directory is supplied by the app, never by tool arguments. Validate every component so a
// projection link cannot turn an otherwise contained directory into an arbitrary filesystem read.
const skillCatalogDirectory = async (environment: SkillRuntimeEnvironment): Promise<string> => {
  const root = resolve(environment.root)
  const directory = environment.skillsDirectory ?? join(root, '.claude', 'skills')
  const relation = relative(root, directory)
  if (
    !isAbsolute(directory) ||
    !relation ||
    isAbsolute(relation) ||
    relation.split(sep).includes('..')
  ) {
    throw new Error('Skill catalog must be inside its runtime root.')
  }
  await requireRealDirectory(root, 'Skill projection')
  let current = root
  for (const part of relation.split(sep)) {
    current = join(current, part)
    await requireRealDirectory(current, 'Skill projection catalog')
  }
  return current
}

const readSkillCatalogFrontmatter = async (path: string, size: number): Promise<string> => {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    const delimiters = [Buffer.from('\n---\n'), Buffer.from('\r\n---\r\n')]
    const overlapBytes = Math.max(...delimiters.map((delimiter) => delimiter.length)) - 1
    let tail = Buffer.alloc(0)
    let offset = 0
    let frontmatterEnd: number | undefined

    while (offset < size) {
      const buffer = Buffer.alloc(Math.min(SKILL_CATALOG_READ_CHUNK_BYTES, size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      chunks.push(chunk)
      const probe = Buffer.concat([tail, chunk])
      for (const delimiter of delimiters) {
        const delimiterOffset = probe.indexOf(delimiter)
        if (delimiterOffset >= 0) {
          frontmatterEnd = offset - tail.length + delimiterOffset + delimiter.length
          break
        }
      }
      offset += bytesRead
      if (frontmatterEnd !== undefined) break
      if (offset === bytesRead && !probe.subarray(0, 4).toString('utf8').startsWith('---')) break
      tail = probe.subarray(Math.max(0, probe.length - overlapBytes))
    }

    const document = Buffer.concat(chunks)
    return document.subarray(0, frontmatterEnd ?? document.length).toString('utf8')
  } finally {
    await handle.close()
  }
}

const readSkillRuntimeCatalog = async (
  environment: SkillRuntimeEnvironment
): Promise<SkillRuntimeCatalog> => {
  const skillsDir = await skillCatalogDirectory(environment)

  const entries = await readdir(skillsDir, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const catalog: SkillRuntimeCatalogEntry[] = []
  const discoveryBudget = MAX_SKILL_CATALOG_SCHEMA_BYTES - SKILL_CATALOG_SCHEMA_RESERVED_BYTES
  let catalogBytes = 0
  for (const entry of entries) {
    const directoryName = entry.name
    if (!SAFE_PROJECTED_SKILL_NAME.test(directoryName) || directoryName.includes('..')) {
      continue
    }

    const skillDir = join(skillsDir, directoryName)
    const skillMetadata = await lstat(skillDir)
    if (skillMetadata.isSymbolicLink() || !skillMetadata.isDirectory()) continue
    const documentPath = join(skillDir, 'SKILL.md')
    const documentMetadata = await lstat(documentPath).catch(() => undefined)
    if (
      !documentMetadata ||
      documentMetadata.isSymbolicLink() ||
      !documentMetadata.isFile() ||
      documentMetadata.size > SKILL_IMPORT_LIMITS.maxFileBytes
    ) {
      continue
    }

    const { fields } = parseFrontmatter(
      await readSkillCatalogFrontmatter(documentPath, documentMetadata.size)
    )
    const name = fields.name
    if (
      !SAFE_PROJECTED_SKILL_NAME.test(name) ||
      (environment.allowedNames && !environment.allowedNames.has(name)) ||
      fields['disable-model-invocation']?.toLowerCase() === 'true' ||
      (directoryName !== name && !directoryName.startsWith('os-'))
    ) {
      continue
    }
    const description = (fields.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SKILL_CATALOG_DESCRIPTION_LENGTH)
    if (!description) continue
    const skill = { name, description }
    const nextBytes = Buffer.byteLength(
      JSON.stringify({ type: 'string', const: name, description }),
      'utf8'
    )
    if (
      catalog.length >= MAX_ADVERTISED_SKILL_COUNT ||
      catalogBytes + nextBytes > discoveryBudget
    ) {
      return { entries: catalog, truncated: true }
    }
    catalog.push(skill)
    catalogBytes += nextBytes
  }
  return { entries: catalog, truncated: false }
}

const parseSkillArguments = (serialized: string): string[] => {
  const values: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false

  for (const character of serialized.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) {
        values.push(current)
        current = ''
      }
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current) values.push(current)
  return values
}

const applySkillArguments = (document: string, serialized = ''): string => {
  const positional = parseSkillArguments(serialized)
  let consumed = false
  const substitute = (value: string): string => {
    consumed = true
    return value
  }
  let rendered = document
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) =>
      substitute(positional[Number(index)] ?? '')
    )
    .replace(/\$ARGUMENTS\b/g, () => substitute(serialized))
    .replace(/\$(\d+)\b/g, (_match, index: string) => substitute(positional[Number(index)] ?? ''))

  const namedArguments = parseFrontmatter(document)
    .fields.arguments?.split(/[\s,]+/)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
  for (const [index, name] of (namedArguments ?? []).entries()) {
    rendered = rendered.replace(
      new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
      () => substitute(positional[index] ?? '')
    )
  }

  return serialized && !consumed ? `${rendered.trimEnd()}\n\nARGUMENTS: ${serialized}` : rendered
}

const readSkillDocument = async (
  environment: SkillRuntimeEnvironment,
  requestedName: string,
  args?: string
): Promise<{ document: string; skillDir: string }> => {
  const name = requestedName.trim()
  if (!SAFE_PROJECTED_SKILL_NAME.test(name) || name.includes('..')) {
    throw new Error(`Unknown skill: ${requestedName}`)
  }
  if (environment.allowedNames && !environment.allowedNames.has(name)) {
    throw new Error(`Unknown skill: ${name}`)
  }

  try {
    const skillsDir = await skillCatalogDirectory(environment)
    const candidates = [name, ...(await readdir(skillsDir))]
    let skillDir: string | undefined
    let documentPath: string | undefined
    let documentMetadata: Awaited<ReturnType<typeof lstat>> | undefined
    for (const directoryName of [...new Set(candidates)]) {
      if (!SAFE_PROJECTED_SKILL_NAME.test(directoryName) || directoryName.includes('..')) continue
      const candidateDir = join(skillsDir, directoryName)
      try {
        await requireRealDirectory(candidateDir, 'Skill package')
        const candidatePath = join(candidateDir, 'SKILL.md')
        const candidateMetadata = await lstat(candidatePath)
        if (
          candidateMetadata.isSymbolicLink() ||
          !candidateMetadata.isFile() ||
          candidateMetadata.size > SKILL_IMPORT_LIMITS.maxFileBytes
        ) {
          continue
        }
        // Agent-facing projections may be supplied by CodeBuddy without frontmatter. Preserve the
        // existing direct-directory contract; frontmatter is required only for namespaced lookup.
        if (directoryName === name) {
          skillDir = candidateDir
          documentPath = candidatePath
          documentMetadata = candidateMetadata
          break
        }
        const { fields } = parseFrontmatter(
          await readSkillCatalogFrontmatter(candidatePath, candidateMetadata.size)
        )
        if (fields.name !== name || (directoryName !== name && !directoryName.startsWith('os-'))) {
          continue
        }
        skillDir = candidateDir
        documentPath = candidatePath
        documentMetadata = candidateMetadata
        break
      } catch {
        continue
      }
    }
    if (!skillDir || !documentPath || !documentMetadata) throw new Error('Skill not found.')
    return {
      document: applySkillArguments(await readFile(documentPath, 'utf8'), args),
      skillDir
    }
  } catch {
    throw new Error(`Unknown skill: ${name}`)
  }
}

const loadSkillDocument = async (
  environment: SkillRuntimeEnvironment,
  requestedName: string,
  args?: string
): Promise<string> => {
  const { document, skillDir } = await readSkillDocument(environment, requestedName, args)
  return `Base directory for this skill: ${skillDir}\n\n${document.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)}`
}

const loadSkillDocumentContent = async (
  environment: SkillRuntimeEnvironment,
  requestedName: string,
  args?: string
): Promise<string> => (await readSkillDocument(environment, requestedName, args)).document

export {
  readSkillRuntimeCatalog,
  parseSkillArguments,
  applySkillArguments,
  loadSkillDocument,
  loadSkillDocumentContent
}
export type { SkillRuntimeEnvironment, SkillRuntimeCatalog, SkillRuntimeCatalogEntry }
