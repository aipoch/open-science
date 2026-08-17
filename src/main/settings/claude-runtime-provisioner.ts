import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { ALL_CONNECTOR_IDS } from '../connectors/registry'
import { parseFrontmatter } from '../skills/frontmatter'
import { isUsableSkillName } from '../skills/skill-name'

const CLAUDE_PRIVATE_PROFILE_DIR = 'claude'
const CLAUDE_SKILL_RUNTIME_SEGMENTS = ['runtime-support', 'agent-skills', 'claude'] as const
const PROJECTION_FORMAT_VERSION = 'v1'
const LEGACY_MANAGED_SKILL_PREFIX = 'os-'

// Open Science is a single-instance desktop application. On the first provision for one storage
// root, revisions inherited from a previous process can therefore be removed safely. The resolved
// promise remains registered for this process so later provisions retain every revision that an
// active session in this process may still have mounted. This is deliberately not a multi-process
// lease protocol: running two application processes against one storage root is unsupported.
const currentProcessRevisionGc = new Map<string, Promise<void>>()
const legacyCleanupFlights = new Map<string, Promise<void>>()

type ClaudeSkillProjection = Readonly<{
  root: string
  revision: string
}>

export type ClaudeRuntimeAssets = Readonly<{
  privateProfileDir: string
  settingsPath: string
  privateSettings: Readonly<Record<string, unknown>>
  skillProjection: ClaudeSkillProjection
}>

export type ProvisionClaudeRuntimeInput = Readonly<{
  storageRoot: string
  provisionPrivateProfile?: (
    privateProfileDir: string
  ) => Promise<Readonly<Record<string, unknown>> | void>
  materializeProjection: (stagingProjectionRoot: string) => Promise<void>
}>

/** The stable root for every version of the app-owned Claude Skill projection format. */
export const getClaudeSkillRuntimeRoot = (storageRoot: string): string =>
  join(storageRoot, ...CLAUDE_SKILL_RUNTIME_SEGMENTS)

/** The directory containing content-addressed Skill projection revisions for the current format. */
export const getClaudeSkillProjectionRevisionsDir = (storageRoot: string): string =>
  join(getClaudeSkillRuntimeRoot(storageRoot), PROJECTION_FORMAT_VERSION)

const assertDisjointRoots = (privateRoot: string, projectionRoot: string): void => {
  const privateToProjection = relative(privateRoot, projectionRoot)
  const projectionToPrivate = relative(projectionRoot, privateRoot)
  const isInside = (value: string): boolean =>
    value === '' || (!value.startsWith('..') && value !== '..')

  if (isInside(privateToProjection) || isInside(projectionToPrivate)) {
    throw new Error('Claude private profile and Skill projection roots must not overlap.')
  }
}

const setTreeWritable = async (root: string): Promise<void> => {
  const rootMetadata = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!rootMetadata || rootMetadata.isSymbolicLink()) return

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  await chmod(root, 0o755)
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await setTreeWritable(path)
    else if (!entry.isSymbolicLink()) await chmod(path, 0o644)
  }
}

const removeTree = async (path: string): Promise<void> => {
  await setTreeWritable(path)
  await rm(path, { recursive: true, force: true })
}

const ensureRealDirectory = async (path: string, label: string): Promise<void> => {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!metadata) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  // Re-read even when this call created it: another provision may have won EEXIST, and validation
  // must apply to the object that is actually at the path after that race.
  const directory = await lstat(path)
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link or file.`)
  }
}

const garbageCollectPriorProcessRevisions = async (storageRoot: string): Promise<void> => {
  await mkdir(storageRoot, { recursive: true })
  let managedPath = storageRoot
  for (const segment of [...CLAUDE_SKILL_RUNTIME_SEGMENTS, PROJECTION_FORMAT_VERSION]) {
    managedPath = join(managedPath, segment)
    const metadata = await lstat(managedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!metadata) await mkdir(managedPath)
    const directory = metadata ?? (await lstat(managedPath))
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error(
        `Claude Skill runtime path must be a real directory, not a symbolic link or file: ${managedPath}`
      )
    }
  }

  const revisionsDir = managedPath
  const entries = await readdir(revisionsDir)
  await Promise.all(entries.map((entry) => removeTree(join(revisionsDir, entry))))
}

const prepareCurrentProcessRevisionRoot = (storageRoot: string): Promise<void> => {
  const key = resolve(storageRoot)
  const existing = currentProcessRevisionGc.get(key)
  if (existing) return existing

  const task = garbageCollectPriorProcessRevisions(storageRoot).catch((error) => {
    if (currentProcessRevisionGc.get(key) === task) currentProcessRevisionGc.delete(key)
    throw error
  })
  currentProcessRevisionGc.set(key, task)
  return task
}

const assertTreeContainsNoSymlinks = async (root: string): Promise<void> => {
  const metadata = await lstat(root)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to migrate legacy Claude Skills through symbolic link: ${root}`)
  }
  if (!metadata.isDirectory()) return

  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    await assertTreeContainsNoSymlinks(join(root, entry.name))
  }
}

const removeLegacyManagedSkills = async (privateProfileDir: string): Promise<void> => {
  const skillsDir = join(privateProfileDir, 'skills')
  const rootMetadata = await lstat(skillsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!rootMetadata) return
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      'Legacy Claude Skills root must be a real directory, not a symbolic link or file.'
    )
  }
  const entries = await readdir(skillsDir, { withFileTypes: true })
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error('Refusing to migrate a legacy Claude Skill represented by a symbolic link.')
  }

  const bundledConnectorIds = new Set(ALL_CONNECTOR_IDS.map((id) => id.toLowerCase()))
  const isManagedConnectorSkill = async (entry: (typeof entries)[number]): Promise<boolean> => {
    const match = /^mcp-(.+)$/.exec(entry.name)
    if (!match || !entry.isDirectory()) return false
    if (bundledConnectorIds.has(match[1].toLowerCase())) return true

    try {
      const documentPath = join(skillsDir, entry.name, 'SKILL.md')
      const documentMetadata = await lstat(documentPath)
      if (documentMetadata.isSymbolicLink()) {
        throw new Error(
          `Refusing to inspect a legacy Connector Skill through symbolic link: ${documentPath}`
        )
      }
      if (!documentMetadata.isFile()) return false
      const document = await readFile(documentPath, 'utf8')
      const { fields } = parseFrontmatter(document)
      return fields.name === entry.name && fields.source === 'connector'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof Error && error.message.includes('symbolic link')) throw error
      return false
    }
  }

  const ownership = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      managed:
        entry.name.startsWith(LEGACY_MANAGED_SKILL_PREFIX) || (await isManagedConnectorSkill(entry))
    }))
  )
  await Promise.all(
    ownership
      .filter(({ managed }) => managed)
      .map(({ entry }) => assertTreeContainsNoSymlinks(join(skillsDir, entry.name)))
  )
  await Promise.all(
    ownership
      .filter(({ managed }) => managed)
      .map(({ entry }) => removeTree(join(skillsDir, entry.name)))
  )
}

const migrateLegacyManagedSkills = (privateProfileDir: string): Promise<void> => {
  const key = resolve(privateProfileDir)
  const existing = legacyCleanupFlights.get(key)
  if (existing) return existing

  const task = removeLegacyManagedSkills(privateProfileDir).finally(() => {
    if (legacyCleanupFlights.get(key) === task) legacyCleanupFlights.delete(key)
  })
  legacyCleanupFlights.set(key, task)
  return task
}

const assertCompleteProjection = async (projectionRoot: string): Promise<void> => {
  const rootEntries = await readdir(projectionRoot, { withFileTypes: true })
  const unexpectedRootEntry = rootEntries.find((entry) => entry.name !== '.claude')
  if (unexpectedRootEntry) {
    throw new Error(
      `Claude Skill projection cannot contain root component: ${unexpectedRootEntry.name}`
    )
  }

  const claudeDir = join(projectionRoot, '.claude')
  const claudeDirMetadata = await lstat(claudeDir).catch(() => null)
  if (!claudeDirMetadata?.isDirectory()) {
    throw new Error('Claude Skill projection must contain a real .claude directory.')
  }
  const claudeEntries = await readdir(claudeDir)
  if (claudeEntries.length !== 1 || claudeEntries[0] !== 'skills') {
    throw new Error('Claude Skill projection .claude directory must contain only skills.')
  }

  const skillsDir = join(claudeDir, 'skills')
  const skills = await lstat(skillsDir).catch(() => null)
  if (!skills?.isDirectory()) {
    throw new Error('Claude Skill projection must contain a real .claude/skills directory.')
  }

  const skillEntries = await readdir(skillsDir, { withFileTypes: true })
  for (const entry of skillEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Claude Skill projection entry must be a real Skill directory: ${entry.name}`)
    }
    const documentPath = join(skillsDir, entry.name, 'SKILL.md')
    const documentMetadata = await lstat(documentPath).catch(() => null)
    if (!documentMetadata?.isFile() || documentMetadata.isSymbolicLink()) {
      throw new Error(`Claude Skill projection entry must contain SKILL.md: ${entry.name}`)
    }
    const { fields } = parseFrontmatter(await readFile(documentPath, 'utf8'))
    const canonicalName =
      fields.source === 'connector'
        ? /^mcp-(?=.{1,128}$)[a-z0-9]+[a-z0-9_-]*$/.test(entry.name)
        : isUsableSkillName(entry.name)
    if (!canonicalName || fields.name !== entry.name) {
      throw new Error(
        `Claude Skill projection entry must use its canonical frontmatter name: ${entry.name}`
      )
    }
  }
}

const hashProjection = async (root: string): Promise<string> => {
  const hash = createHash('sha256')

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))

    for (const entry of entries) {
      const path = join(directory, entry.name)
      const projectedPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const metadata = await lstat(path)

      if (metadata.isSymbolicLink()) {
        throw new Error(`Claude Skill projection cannot contain symbolic links: ${projectedPath}`)
      }
      if (metadata.isDirectory()) {
        hash.update(`directory\0${projectedPath}\0`)
        await visit(path, projectedPath)
        continue
      }
      if (!metadata.isFile()) {
        throw new Error(`Claude Skill projection contains an unsupported entry: ${projectedPath}`)
      }

      hash.update(`file\0${projectedPath}\0${metadata.mode & 0o111 ? 'executable' : 'regular'}\0`)
      hash.update(await readFile(path))
      hash.update('\0')
    }
  }

  await visit(root, '')
  return hash.digest('hex')
}

const setTreeReadOnly = async (root: string, rootMode: 0o555 | 0o755 = 0o555): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await setTreeReadOnly(path)
      continue
    }
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Claude Skill projection cannot contain symbolic links: ${path}`)
    }
    await chmod(path, metadata.mode & 0o111 ? 0o555 : 0o444)
  }
  await chmod(root, rootMode)
}

const assertTreeReadOnly = async (root: string, allowWritableRoot = false): Promise<void> => {
  const metadata = await lstat(root)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Claude Skill projection revision cannot be a symbolic link: ${root}`)
  }
  if (!allowWritableRoot && metadata.mode & 0o222) {
    throw new Error(`Claude Skill projection is not read-only: ${root}`)
  }
  if (!metadata.isDirectory()) return

  const entries = await readdir(root)
  await Promise.all(entries.map((entry) => assertTreeReadOnly(join(root, entry))))
}

/**
 * Provisions the private Claude profile and publishes an immutable, content-addressed Skill project
 * root for Claude's `--add-dir` discovery. The materializer writes only to a unique staging
 * directory; callers never need to coordinate concurrent provisions or know the physical layout.
 */
export const provisionClaudeRuntime = async (
  input: ProvisionClaudeRuntimeInput
): Promise<ClaudeRuntimeAssets> => {
  const privateProfileDir = join(input.storageRoot, CLAUDE_PRIVATE_PROFILE_DIR)
  const revisionsDir = getClaudeSkillProjectionRevisionsDir(input.storageRoot)
  assertDisjointRoots(privateProfileDir, revisionsDir)

  await prepareCurrentProcessRevisionRoot(input.storageRoot)
  await ensureRealDirectory(privateProfileDir, 'Claude private profile')
  const privateSettings = (await input.provisionPrivateProfile?.(privateProfileDir)) ?? {}

  const stagingProjectionRoot = join(revisionsDir, `.staging-${randomUUID()}`)
  await mkdir(stagingProjectionRoot)

  let revision: string
  try {
    await input.materializeProjection(stagingProjectionRoot)
    await assertCompleteProjection(stagingProjectionRoot)
    revision = await hashProjection(stagingProjectionRoot)
    // macOS 14 rejects renaming a directory whose own mode is 0555. Seal every descendant before
    // publication, but keep the staging container writable until the atomic rename completes. The
    // returned projection is not exposed to a session until the container is sealed below.
    await setTreeReadOnly(stagingProjectionRoot, 0o755)
    await assertTreeReadOnly(stagingProjectionRoot, true)

    const publishedRoot = join(revisionsDir, revision)
    try {
      await rename(stagingProjectionRoot, publishedRoot)
      await chmod(publishedRoot, 0o555)
      await assertTreeReadOnly(publishedRoot)
    } catch (error) {
      // Platforms disagree on the error for renaming over an existing non-empty/read-only directory
      // (EEXIST/ENOTEMPTY on Linux, EACCES on macOS). The content-derived destination is the arbiter:
      // only an already-published directory for this exact revision makes the failure idempotent.
      const existing = await lstat(publishedRoot).catch(() => null)
      if (existing?.isSymbolicLink()) {
        throw new Error(
          `Claude Skill projection revision cannot be a symbolic link: ${publishedRoot}`
        )
      }
      if (!existing?.isDirectory()) throw error
      await assertCompleteProjection(publishedRoot)
      if ((await hashProjection(publishedRoot)) !== revision) {
        throw new Error(`Claude Skill projection revision ${revision} has conflicting content.`)
      }
      await setTreeReadOnly(publishedRoot)
      await assertTreeReadOnly(publishedRoot)
      await removeTree(stagingProjectionRoot)
    }

    await migrateLegacyManagedSkills(privateProfileDir)

    return {
      privateProfileDir,
      settingsPath: join(privateProfileDir, 'settings.json'),
      privateSettings,
      skillProjection: { root: publishedRoot, revision }
    }
  } catch (error) {
    await removeTree(stagingProjectionRoot).catch(() => undefined)
    throw error
  }
}
