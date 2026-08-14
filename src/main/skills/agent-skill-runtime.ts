import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'

import { prepareSkillRuntimeEnvironment } from './agent-skill-runtime-environment'

type AgentSkillRuntimeLifecycle = Readonly<{
  sessionId: string
  agentFrameId: string
  runtimeSegmentId: string
}>

type AgentSkillRuntimeScope = Readonly<{
  kind: 'main' | 'specialist' | 'subagent'
}>

type AgentSkillRuntimeFile = Readonly<{
  path: string
  content: string | Uint8Array
  mode?: number
}>

type AgentSkillRuntimeSkillBase = Readonly<{
  id: string
  name: string
  description: string
  revision: string
}>

type AgentSkillRuntimePackageSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'package'
    sourceDir: string
    overrides?: readonly AgentSkillRuntimeFile[]
  }>

type AgentSkillRuntimeGeneratedSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'generated'
    files: readonly AgentSkillRuntimeFile[]
  }>

type AgentSkillRuntimeSkill = AgentSkillRuntimePackageSkill | AgentSkillRuntimeGeneratedSkill

type AgentSkillRuntimeInput = Readonly<{
  storageRoot: string
  lifecycle: AgentSkillRuntimeLifecycle
  scope: AgentSkillRuntimeScope
  skills: readonly AgentSkillRuntimeSkill[]
}>

type AgentSkillRuntimeLeaseSkill = Readonly<{
  id: string
  name: string
  description: string
  packageRoot: string
  skillDocumentPath: string
  packageRevision: string
}>

type AgentSkillRuntimeCatalog = Readonly<{
  catalogRevision: string
  projectionRoot: string
  discoveryRoot: string
  skills: readonly AgentSkillRuntimeLeaseSkill[]
}>

type AgentSkillRuntimeLease = AgentSkillRuntimeCatalog &
  Readonly<{
    cacheRoot: string
    tempRoot: string
    env: Readonly<Record<string, string>>
    release(): Promise<void>
  }>

type AgentSkillRuntimeForkInput = Readonly<{
  lifecycle: AgentSkillRuntimeLifecycle
  scope: AgentSkillRuntimeScope
}>

type AgentSkillRuntimeOptions = Readonly<{
  beforeAuthorizeCatalog?: (catalogRoot: string) => Promise<void>
}>

// Keep rebuildable Agent runtime state under the application's established runtime boundary. Data
// migration and rollback releases already treat storageRoot/runtime as non-authoritative cache/state.
const runtimeRoot = (storageRoot: string): string =>
  join(storageRoot, 'runtime', 'agent-skills', 'v1')

// These registries protect live trees owned by any AgentSkillRuntime in this Electron process while
// opportunistic cleanup removes crash leftovers. The on-disk owner is only a cleanup hint, never an
// authorization source.
const activeLeaseRoots = new Set<string>()
const activeBuildRoots = new Set<string>()

// Existing bundled Connector identities use underscores (for example mcp-clinical_trials), while
// user-authored Skills use hyphens. Both separators are filesystem-safe; path separators, dots,
// empty segments, and other punctuation remain rejected.
const SAFE_SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*$/

const assertSafeRuntimeFilePath = (path: string, source: 'generated' | 'override'): void => {
  const segments = path.split(/[\\/]/)
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Refusing to project an unsafe ${source} file path: ${path}`)
  }
}

const chmodProjectionTree = async (directory: string): Promise<void> => {
  const applyMode = async (path: string, targetMode: number): Promise<void> => {
    try {
      await chmod(path, targetMode)
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  }

  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) await chmodProjectionTree(child)
    else {
      const metadata = await lstat(child)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Refusing to project a Skill package containing a non-regular file.')
      }
      await applyMode(child, (metadata.mode & 0o111) !== 0 ? 0o555 : 0o444)
    }
  }
  await applyMode(directory, 0o555)
}

const removeProjectionTree = async (directory: string): Promise<void> => {
  const makeDirectoriesWritable = async (path: string): Promise<void> => {
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return
    await chmod(path, 0o700).catch((error) => {
      if (process.platform !== 'win32') throw error
    })
    for (const entry of await readdir(path)) await makeDirectoriesWritable(join(path, entry))
  }
  await makeDirectoriesWritable(directory)
  await rm(directory, { recursive: true, force: true })
}

type CatalogTreeEntry = Readonly<{
  path: string
  kind: 'directory' | 'file'
  mode?: number
  digest?: string
}>

type RuntimeBlueprintPackageSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'package'
    sourceDir: string
    sourceSnapshot: readonly CatalogTreeEntry[]
    overrides: readonly AgentSkillRuntimeFile[]
  }>

type RuntimeBlueprintGeneratedSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'generated'
    files: readonly AgentSkillRuntimeFile[]
  }>

type RuntimeBlueprintSkill = RuntimeBlueprintPackageSkill | RuntimeBlueprintGeneratedSkill
type RuntimeBlueprintPackageSeed = Omit<RuntimeBlueprintPackageSkill, 'sourceSnapshot'>
type RuntimeBlueprintSkillSeed = RuntimeBlueprintPackageSeed | RuntimeBlueprintGeneratedSkill

type RuntimeBlueprint = Readonly<{
  runtimeRoot: string
  catalogRevision: string
  tree: readonly CatalogTreeEntry[]
  skills: readonly RuntimeBlueprintSkill[]
}>

const catalogTreeSnapshot = async (root: string): Promise<readonly CatalogTreeEntry[]> => {
  const entries: CatalogTreeEntry[] = []
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error('Refusing to project a Skill package containing a symbolic link.')
    }
    const mode = process.platform === 'win32' ? undefined : metadata.mode & 0o7777
    if (metadata.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory', mode })
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath === '.' ? name : `${relativePath}/${name}`)
      }
      return
    }
    if (!metadata.isFile()) {
      throw new Error('Refusing to project a Skill package containing a non-regular file.')
    }
    const bytes = await readFile(path)
    entries.push({
      path: relativePath,
      kind: 'file',
      mode,
      digest: createHash('sha256').update(bytes).digest('hex')
    })
  }
  await visit(root, '.')
  return entries
}

const sameSnapshot = (
  left: readonly CatalogTreeEntry[],
  right: readonly CatalogTreeEntry[]
): boolean => JSON.stringify(left) === JSON.stringify(right)

const writeRuntimeFiles = async (
  packageRoot: string,
  files: readonly AgentSkillRuntimeFile[]
): Promise<void> => {
  for (const file of files) {
    const target = join(packageRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, file.mode === undefined ? {} : { mode: file.mode })
    if (file.mode !== undefined) {
      await chmod(target, (file.mode & 0o111) !== 0 ? 0o755 : 0o644).catch((error) => {
        if (process.platform !== 'win32') throw error
      })
    }
  }
}

const catalogRevision = (
  skills: readonly (AgentSkillRuntimeSkill | RuntimeBlueprintSkill)[],
  tree: readonly CatalogTreeEntry[]
): string => {
  const entries = skills
    .map(({ kind, id, name, description, revision }) => ({
      kind,
      id,
      name,
      description,
      revision
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return `sha256:${createHash('sha256').update(JSON.stringify({ entries, tree })).digest('hex')}`
}

const writeOwner = async (
  root: string,
  owner: Readonly<Record<string, unknown>>
): Promise<void> => {
  await writeFile(
    join(root, 'owner.json'),
    `${JSON.stringify({ version: 2, processId: process.pid, ...owner })}\n`,
    'utf8'
  )
}

const staleOwnerState = async (
  root: string,
  expectedKind: 'blueprint-build' | 'runtime-lease'
): Promise<'alive' | 'dead' | 'unknown'> => {
  try {
    const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')) as {
      version?: unknown
      kind?: unknown
      processId?: unknown
    }
    // Older rollback releases use a different owner shape. Preserve anything we cannot identify as
    // one of our rebuildable v2 trees rather than disrupting a concurrently running older app.
    if (
      owner.version !== 2 ||
      owner.kind !== expectedKind ||
      !Number.isSafeInteger(owner.processId) ||
      (owner.processId as number) <= 0
    ) {
      return 'unknown'
    }
    try {
      process.kill(owner.processId as number, 0)
      return 'alive'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive'
    }
  } catch {
    return 'unknown'
  }
}

const cleanupCrashLeftovers = async (
  parent: string,
  activeRoots: ReadonlySet<string>,
  expectedKind: 'blueprint-build' | 'runtime-lease'
): Promise<void> => {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const root = join(parent, entry.name)
    if (activeRoots.has(root)) continue
    if (!entry.isDirectory() || (await staleOwnerState(root, expectedKind)) !== 'dead') continue
    await removeProjectionTree(root).catch(() => undefined)
  }
}

const cloneRuntimeFile = (file: AgentSkillRuntimeFile): AgentSkillRuntimeFile =>
  Object.freeze({
    path: file.path,
    content: typeof file.content === 'string' ? file.content : new Uint8Array(file.content),
    mode: file.mode
  })

const materializeBlueprint = async (
  projectionRoot: string,
  skills: readonly RuntimeBlueprintSkill[]
): Promise<void> => {
  await mkdir(join(projectionRoot, '.claude-plugin'), { recursive: true })
  await mkdir(join(projectionRoot, 'skills'), { recursive: true })
  await writeFile(
    join(projectionRoot, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'open-science-agent-skills' })}\n`,
    'utf8'
  )

  for (const skill of skills) {
    const packageRoot = join(projectionRoot, 'skills', `os-${skill.id}`)
    await mkdir(packageRoot, { recursive: true })
    if (skill.kind === 'generated') {
      await writeRuntimeFiles(packageRoot, skill.files)
    } else {
      const sourceBeforeCopy = await catalogTreeSnapshot(skill.sourceDir)
      if (!sameSnapshot(sourceBeforeCopy, skill.sourceSnapshot)) {
        throw new Error(
          'Refusing to project an Agent Skill runtime after its source package changed.'
        )
      }
      await cp(skill.sourceDir, packageRoot, {
        recursive: true,
        force: true,
        filter: async (path) => {
          if ((await lstat(path)).isSymbolicLink()) {
            throw new Error('Refusing to project a Skill package containing a symbolic link.')
          }
          return true
        }
      })
      const sourceAfterCopy = await catalogTreeSnapshot(skill.sourceDir)
      if (!sameSnapshot(sourceAfterCopy, skill.sourceSnapshot)) {
        throw new Error(
          'Refusing to project an Agent Skill runtime after its source package changed.'
        )
      }
      await writeRuntimeFiles(packageRoot, skill.overrides)
    }
    const skillDocument = await lstat(join(packageRoot, 'SKILL.md')).catch(() => undefined)
    if (!skillDocument?.isFile() || skillDocument.isSymbolicLink()) {
      throw new Error(`Refusing to project Skill "${skill.name}" without a regular SKILL.md.`)
    }
  }
  await chmodProjectionTree(projectionRoot)
}

class AgentSkillRuntime {
  private readonly authorizedCatalogs = new WeakMap<object, RuntimeBlueprint>()

  constructor(private readonly options: AgentSkillRuntimeOptions = {}) {}

  async acquire(input: AgentSkillRuntimeInput): Promise<AgentSkillRuntimeLease> {
    this.validateInput(input)
    const blueprint = await this.buildBlueprint(input)
    return this.createLease(blueprint, { lifecycle: input.lifecycle, scope: input.scope })
  }

  async fork(
    catalog: AgentSkillRuntimeCatalog,
    input: AgentSkillRuntimeForkInput
  ): Promise<AgentSkillRuntimeLease> {
    const blueprint = this.authorizedCatalogs.get(catalog)
    if (!blueprint) {
      throw new Error('Refusing to fork an Agent Skill runtime from an unauthorized catalog.')
    }
    return this.createLease(blueprint, input)
  }

  private validateInput(input: AgentSkillRuntimeInput): void {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const skill of input.skills) {
      if (!SAFE_SKILL_NAME.test(skill.id)) {
        throw new Error(`Refusing to project a Skill with an unsafe Skill id: ${skill.id}`)
      }
      if (ids.has(skill.id)) {
        throw new Error(`Refusing to project a duplicate Skill id: ${skill.id}`)
      }
      if (!SAFE_SKILL_NAME.test(skill.name)) {
        throw new Error(`Refusing to project a Skill with an unsafe Skill name: ${skill.name}`)
      }
      if (names.has(skill.name)) {
        throw new Error(`Refusing to project a duplicate Skill name: ${skill.name}`)
      }
      const runtimeFiles = skill.kind === 'generated' ? skill.files : (skill.overrides ?? [])
      for (const file of runtimeFiles) {
        assertSafeRuntimeFilePath(file.path, skill.kind === 'generated' ? 'generated' : 'override')
      }
      ids.add(skill.id)
      names.add(skill.name)
    }
  }

  private async buildBlueprint(input: AgentSkillRuntimeInput): Promise<RuntimeBlueprint> {
    // Clone every caller-owned byte array before the first await. Package hashing can take long
    // enough for a caller to otherwise mutate a generated file or override while acquisition is
    // still in flight.
    const skillSeeds: readonly RuntimeBlueprintSkillSeed[] = input.skills.map((skill) =>
      Object.freeze(
        skill.kind === 'generated'
          ? {
              kind: 'generated' as const,
              id: skill.id,
              name: skill.name,
              description: skill.description,
              revision: skill.revision,
              files: Object.freeze(skill.files.map(cloneRuntimeFile))
            }
          : {
              kind: 'package' as const,
              id: skill.id,
              name: skill.name,
              description: skill.description,
              revision: skill.revision,
              sourceDir: skill.sourceDir,
              overrides: Object.freeze((skill.overrides ?? []).map(cloneRuntimeFile))
            }
      )
    )
    const root = runtimeRoot(input.storageRoot)
    const buildsRoot = join(root, 'staging')
    const buildRoot = join(buildsRoot, randomUUID())
    const projectionRoot = join(buildRoot, 'projection')
    activeBuildRoots.add(buildRoot)
    try {
      await mkdir(buildRoot, { recursive: true })
      await writeOwner(buildRoot, { kind: 'blueprint-build' })
      await cleanupCrashLeftovers(buildsRoot, activeBuildRoots, 'blueprint-build')
      const skills = await Promise.all(
        skillSeeds.map(async (skill): Promise<RuntimeBlueprintSkill> => {
          if (skill.kind === 'generated') return skill
          return Object.freeze({
            kind: 'package',
            id: skill.id,
            name: skill.name,
            description: skill.description,
            revision: skill.revision,
            sourceDir: skill.sourceDir,
            sourceSnapshot: Object.freeze(await catalogTreeSnapshot(skill.sourceDir)),
            overrides: skill.overrides
          })
        })
      )
      await materializeBlueprint(projectionRoot, skills)
      const tree = await catalogTreeSnapshot(projectionRoot)
      return Object.freeze({
        runtimeRoot: root,
        catalogRevision: catalogRevision(skills, tree),
        tree: Object.freeze(tree),
        skills: Object.freeze(skills)
      })
    } finally {
      activeBuildRoots.delete(buildRoot)
      await removeProjectionTree(buildRoot).catch(() => undefined)
    }
  }

  private async createLease(
    blueprint: RuntimeBlueprint,
    input: AgentSkillRuntimeForkInput
  ): Promise<AgentSkillRuntimeLease> {
    const ownerId = randomUUID()
    const leasesRoot = join(blueprint.runtimeRoot, 'leases')
    const leaseRoot = join(leasesRoot, ownerId)
    const projectionRoot = join(leaseRoot, 'projection')
    activeLeaseRoots.add(leaseRoot)
    try {
      await mkdir(leaseRoot, { recursive: true })
      await writeOwner(leaseRoot, {
        kind: 'runtime-lease',
        ownerId,
        lifecycle: input.lifecycle,
        scope: input.scope,
        catalogRevision: blueprint.catalogRevision
      })
      await cleanupCrashLeftovers(leasesRoot, activeLeaseRoots, 'runtime-lease')
      await materializeBlueprint(projectionRoot, blueprint.skills)
      const projectedSnapshot = await catalogTreeSnapshot(projectionRoot)
      if (!sameSnapshot(projectedSnapshot, blueprint.tree)) {
        throw new Error('Agent Skill runtime projection differs from its authorized blueprint.')
      }

      const discoveryRoot = join(projectionRoot, 'skills')
      const projectedSkills = blueprint.skills.map((skill) => {
        const packageRoot = join(discoveryRoot, `os-${skill.id}`)
        return Object.freeze({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          packageRoot,
          skillDocumentPath: join(packageRoot, 'SKILL.md'),
          packageRevision: skill.revision
        })
      })
      const environment = await prepareSkillRuntimeEnvironment(leaseRoot)
      const catalog = Object.freeze({
        catalogRevision: blueprint.catalogRevision,
        projectionRoot,
        discoveryRoot,
        skills: Object.freeze(projectedSkills)
      })
      await this.options.beforeAuthorizeCatalog?.(projectionRoot)
      const authorizedSnapshot = await catalogTreeSnapshot(projectionRoot).catch(() => {
        throw new Error('Agent Skill runtime projection changed before authorization.')
      })
      if (!sameSnapshot(authorizedSnapshot, blueprint.tree)) {
        throw new Error('Agent Skill runtime projection changed before authorization.')
      }

      let released = false
      let releaseInFlight: Promise<void> | undefined
      const lease = Object.freeze({
        ...catalog,
        cacheRoot: environment.env.XDG_CACHE_HOME!,
        tempRoot: environment.env.TMPDIR!,
        env: environment.env,
        release: (): Promise<void> => {
          if (released) return Promise.resolve()
          if (releaseInFlight) return releaseInFlight
          releaseInFlight = removeProjectionTree(leaseRoot)
            .then(() => {
              activeLeaseRoots.delete(leaseRoot)
              this.authorizedCatalogs.delete(lease)
              released = true
            })
            .finally(() => {
              releaseInFlight = undefined
            })
          return releaseInFlight
        }
      })
      this.authorizedCatalogs.set(catalog, blueprint)
      this.authorizedCatalogs.set(lease, blueprint)
      return lease
    } catch (error) {
      activeLeaseRoots.delete(leaseRoot)
      await removeProjectionTree(leaseRoot).catch(() => undefined)
      throw error
    }
  }
}

export { AgentSkillRuntime }
export type {
  AgentSkillRuntimeInput,
  AgentSkillRuntimeCatalog,
  AgentSkillRuntimeForkInput,
  AgentSkillRuntimeLease,
  AgentSkillRuntimeLeaseSkill,
  AgentSkillRuntimeLifecycle,
  AgentSkillRuntimeFile,
  AgentSkillRuntimeGeneratedSkill,
  AgentSkillRuntimePackageSkill,
  AgentSkillRuntimeSkill,
  AgentSkillRuntimeScope
}
