import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { validateNotebookHelperExports } from '../notebook/python-command'

const HELPER_MANIFEST_FILE = 'open-science.json'
const HELPER_MANIFEST_SCHEMA_VERSION = 1
const HELPER_SOURCE_MAX_BYTES = 1024 * 1024
const HELPER_SOURCE_TOTAL_MAX_BYTES = 4 * 1024 * 1024
const CATALOG_BINDING_FILE = 'catalog-binding.json'
const CATALOG_BINDING_SCHEMA_VERSION = 1
const SAFE_HELPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SAFE_EXPORT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHA256_GENERATION = /^sha256:([0-9a-f]{64})$/

type RegisteredSkillOrigin = 'builtin' | 'personal' | 'imported'

type SkillHelperDescriptor = {
  id: string
  language: 'python'
  interfaceRevision: number
  implementation: string
  exports: string[]
  dependencies: string[]
}

type RegisteredSkillPackage = {
  skillId: string
  origin: RegisteredSkillOrigin
  packageRoot: string
  helpers: SkillHelperDescriptor[]
}

type RegisteredHelperScope = Readonly<{
  projectId?: string
  sessionId?: string
  allowedSkillIds?: readonly string[]
}>

type RegisteredSkillHelper = Readonly<{
  id: string
  language: 'python'
  source: string
  exports: readonly string[]
  dependencies: readonly string[]
  skillId: string
  origin: RegisteredSkillOrigin
  interfaceRevision: number
  generation: string
  digest: string
}>

type RegisteredSkillHelperCatalogOptions = {
  storageRoot: string
  packages: () => Promise<readonly RegisteredSkillPackage[]>
  trustedBuiltinPackages?: () => Promise<readonly RegisteredSkillPackage[]>
  authorize?: (
    helper: Pick<RegisteredSkillHelper, 'id' | 'skillId' | 'origin'>,
    scope: RegisteredHelperScope | undefined
  ) => boolean | Promise<boolean>
}

type PreparedHelper = Omit<RegisteredSkillHelper, 'source'> & { sourceBytes: Buffer }
type BoundHelper = Omit<RegisteredSkillHelper, 'source'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (message: string): never => {
  throw new Error(`INVALID_REGISTERED_HELPER: ${message}`)
}

const assertStableId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length > 128 || !SAFE_HELPER_ID.test(value)) {
    fail(`${field} must be a stable helper ID`)
  }
  return value as string
}

const assertLocator = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value.startsWith('../')
  ) {
    fail('implementation locator must be a normalized package-relative path')
  }
  return value as string
}

const normalizeDescriptor = (value: unknown): SkillHelperDescriptor => {
  if (!isRecord(value)) fail('helper descriptor must be an object')
  const record = value as Record<string, unknown>
  const id = assertStableId(record.id, 'helper id')
  if (record.language !== 'python') fail(`helper "${id}" has an unsupported language`)
  if (!Number.isSafeInteger(record.interfaceRevision) || Number(record.interfaceRevision) < 1) {
    fail(`helper "${id}" has an invalid Interface revision`)
  }
  const implementation = assertLocator(record.implementation)
  const rawExports = record.exports
  if (!Array.isArray(rawExports) || rawExports.length === 0) {
    fail(`helper "${id}" must declare exports`)
  }
  const exports = (rawExports as unknown[]).map((name) => {
    if (typeof name !== 'string' || !SAFE_EXPORT_NAME.test(name)) {
      fail(`helper "${id}" has an invalid export name`)
    }
    return name as string
  })
  if (new Set(exports).size !== exports.length) fail(`helper "${id}" has a duplicate export`)
  const rawDependencies = record.dependencies ?? []
  if (!Array.isArray(rawDependencies)) fail(`helper "${id}" dependencies must be an array`)
  const dependencies = (rawDependencies as unknown[]).map((dependency) =>
    assertStableId(dependency, `helper "${id}" dependency`)
  )
  if (new Set(dependencies).size !== dependencies.length) {
    fail(`helper "${id}" has a duplicate dependency`)
  }
  if (dependencies.includes(id)) fail(`helper "${id}" has a dependency cycle`)
  return {
    id,
    language: 'python',
    interfaceRevision: Number(record.interfaceRevision),
    implementation,
    exports,
    dependencies
  }
}

const readSkillHelperDescriptors = async (
  packageRoot: string
): Promise<SkillHelperDescriptor[]> => {
  let raw: Buffer
  try {
    raw = await readFile(join(packageRoot, HELPER_MANIFEST_FILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const text = (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      return fail(`${HELPER_MANIFEST_FILE} must be UTF-8`)
    }
  })()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(`${HELPER_MANIFEST_FILE} must be valid JSON`)
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== HELPER_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(parsed.helpers)
  ) {
    fail(`${HELPER_MANIFEST_FILE} must use schemaVersion ${HELPER_MANIFEST_SCHEMA_VERSION}`)
  }
  const descriptors = (parsed as Record<string, unknown> & { helpers: unknown[] }).helpers.map(
    normalizeDescriptor
  )
  const ids = new Set<string>()
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) fail(`duplicate helper ID "${descriptor.id}" in one package`)
    ids.add(descriptor.id)
  }
  return descriptors
}

const assertContainedRegularSource = async (
  packageRoot: string,
  locator: string
): Promise<{ bytes: Buffer; source: string }> => {
  const rootMetadata = await lstat(packageRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('registered package root must be a regular directory, not a symbolic link')
  }
  const realRoot = await realpath(packageRoot)
  const parts = locator.split('/')
  let cursor = packageRoot
  for (const part of parts) {
    cursor = join(cursor, part)
    const metadata = await lstat(cursor).catch(() => undefined)
    if (!metadata) fail(`implementation locator "${locator}" does not exist`)
    if (metadata!.isSymbolicLink()) fail(`implementation "${locator}" must not be a symbolic link`)
  }
  const metadata = await lstat(cursor)
  if (!metadata.isFile() || metadata.nlink > 1) {
    fail(`implementation "${locator}" must be a regular file`)
  }
  if (metadata.size > HELPER_SOURCE_MAX_BYTES) {
    fail(`implementation "${locator}" exceeds the source size limit`)
  }
  const realSource = await realpath(cursor)
  const escaped = relative(realRoot, realSource)
  if (
    escaped === '..' ||
    escaped.startsWith(`..${sep}`) ||
    resolve(realSource) === resolve(realRoot)
  ) {
    fail(`implementation "${locator}" escapes its registered package root`)
  }
  const bytes = await readFile(realSource)
  const source = (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return fail(`implementation "${locator}" must be UTF-8`)
    }
  })()
  if (source.includes('\0')) fail(`implementation "${locator}" must be valid Python source`)
  return { bytes, source }
}

const sourceDigest = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const generationDigest = (
  skillId: string,
  origin: RegisteredSkillOrigin,
  helpers: readonly { descriptor: SkillHelperDescriptor; digest: string }[]
): string =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        skillId,
        origin,
        helpers: helpers.map(({ descriptor, digest }) => ({ ...descriptor, digest }))
      })
    )
    .digest('hex')}`

const preparePackage = async (entry: RegisteredSkillPackage): Promise<PreparedHelper[]> => {
  const skillId = assertStableId(entry.skillId, 'Skill identity')
  if (!['builtin', 'personal', 'imported'].includes(entry.origin)) {
    fail(`Skill "${skillId}" has an invalid origin`)
  }
  const helpers = entry.helpers
    .map(normalizeDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id))
  const loaded: Array<{
    descriptor: SkillHelperDescriptor
    bytes: Buffer
    digest: string
  }> = []
  for (const descriptor of helpers) {
    const { bytes, source } = await assertContainedRegularSource(
      entry.packageRoot,
      descriptor.implementation
    )
    await validateNotebookHelperExports(descriptor.id, source, descriptor.exports, {
      trustedSource: entry.origin === 'builtin'
    })
    loaded.push({ descriptor, bytes, digest: sourceDigest(bytes) })
  }
  const generation = generationDigest(skillId, entry.origin, loaded)
  return loaded.map(({ descriptor, bytes, digest }) => ({
    id: descriptor.id,
    language: 'python',
    sourceBytes: bytes,
    exports: Object.freeze([...descriptor.exports]),
    dependencies: Object.freeze([...descriptor.dependencies]),
    skillId,
    origin: entry.origin,
    interfaceRevision: descriptor.interfaceRevision,
    generation,
    digest
  }))
}

const assertDependencyGraph = (
  helpers: ReadonlyMap<string, Pick<RegisteredSkillHelper, 'id' | 'dependencies'>>
): void => {
  for (const helper of helpers.values()) {
    for (const dependency of helper.dependencies) {
      if (!helpers.has(dependency)) {
        fail(`helper "${helper.id}" has unknown dependency "${dependency}"`)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) fail(`helper dependency cycle includes "${id}"`)
    visiting.add(id)
    for (const dependency of helpers.get(id)?.dependencies ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of helpers.keys()) visit(id)
}

const validateSkillHelperPackage = async (packageRoot: string): Promise<void> => {
  const helpers = await readSkillHelperDescriptors(packageRoot)
  await preparePackage({ skillId: 'staged-skill', origin: 'personal', packageRoot, helpers })
}

const prepareRegisteredSkillPackages = async (
  packages: readonly RegisteredSkillPackage[]
): Promise<Map<string, PreparedHelper>> => {
  const prepared = new Map<string, PreparedHelper>()
  let totalBytes = 0
  for (const entry of packages) {
    for (const helper of await preparePackage(entry)) {
      if (prepared.has(helper.id)) fail(`duplicate helper ID "${helper.id}" in registered catalog`)
      totalBytes += helper.sourceBytes.byteLength
      if (totalBytes > HELPER_SOURCE_TOTAL_MAX_BYTES) {
        fail('registered helper catalog exceeds the total source size limit')
      }
      prepared.set(helper.id, helper)
    }
  }
  assertDependencyGraph(prepared)
  return prepared
}

const validateRegisteredSkillPackages = async (
  packages: readonly RegisteredSkillPackage[]
): Promise<void> => {
  await prepareRegisteredSkillPackages(packages)
}

class RegisteredSkillHelperCatalog {
  private snapshot: Promise<ReadonlyMap<string, RegisteredSkillHelper>> | undefined

  constructor(private readonly options: RegisteredSkillHelperCatalogOptions) {}

  // This is the only transaction that trusts the mutable Skill catalog. Callers invoke it after a
  // validated create/import/update, or after the catalog observer reports a source change. Runtime
  // resolution and cold-start restoration never consult those mutable package bytes.
  async refresh(): Promise<void> {
    const previous = this.snapshot
    try {
      const next = await this.buildSnapshotFromPackages()
      await this.persistBinding(next)
      this.snapshot = Promise.resolve(next)
    } catch (error) {
      this.snapshot = previous
      throw error
    }
  }

  protectedDirectories(): readonly string[] {
    return [join(this.options.storageRoot, 'registered-skill-generations')]
  }

  generationRoot(generation: string): string {
    const match = SHA256_GENERATION.exec(generation)
    if (!match?.[1]) throw new Error('Invalid registered helper generation')
    return join(this.options.storageRoot, 'registered-skill-generations', match[1])
  }

  async resolve(
    id: string,
    scope?: RegisteredHelperScope
  ): Promise<RegisteredSkillHelper | undefined> {
    if (!SAFE_HELPER_ID.test(id) || id.length > 128) return undefined
    const helper = (await this.readSnapshot()).get(id)
    if (!helper) return undefined
    if (this.options.authorize && !(await this.options.authorize(helper, scope))) {
      throw new Error(`HELPER_NOT_AUTHORIZED: helper "${id}" is not authorized in this Skill scope`)
    }
    return helper
  }

  private readSnapshot(): Promise<ReadonlyMap<string, RegisteredSkillHelper>> {
    if (!this.snapshot) {
      const read = this.restoreOrCreateSnapshot().catch((error) => {
        if (this.snapshot === read) this.snapshot = undefined
        throw error
      })
      this.snapshot = read
    }
    return this.snapshot
  }

  private async restoreOrCreateSnapshot(): Promise<ReadonlyMap<string, RegisteredSkillHelper>> {
    const restored = await this.restoreBinding()
    if (restored) return this.reconcileTrustedBuiltins(restored)

    // A missing binding is the first-registration case. Once one exists, restoreBinding verifies
    // the app-owned generation and fails closed instead of rebuilding from Personal/Imported
    // sources. Only refresh() can replace that durable trust decision.
    const created = await this.buildSnapshotFromPackages()
    await this.persistBinding(created)
    return created
  }

  private async reconcileTrustedBuiltins(
    restored: ReadonlyMap<string, RegisteredSkillHelper>
  ): Promise<ReadonlyMap<string, RegisteredSkillHelper>> {
    if (!this.options.trustedBuiltinPackages) return restored

    const packages = await this.options.trustedBuiltinPackages()
    for (const entry of packages) {
      if (entry.origin !== 'builtin') {
        fail('startup reconciliation accepts only trusted Built-in packages')
      }
    }

    // Prepare Built-ins independently, but validate dependencies only after combining them with the
    // restored non-Built-in snapshot. A Built-in may depend on an explicitly registered Personal or
    // Imported helper without granting startup permission to reread that helper's mutable source.
    const prepared = new Map<string, PreparedHelper>()
    for (const entry of packages) {
      for (const helper of await preparePackage(entry)) {
        if (prepared.has(helper.id))
          fail(`duplicate helper ID "${helper.id}" in registered catalog`)
        prepared.set(helper.id, helper)
      }
    }

    const next = new Map<string, RegisteredSkillHelper>()
    for (const helper of restored.values()) {
      if (helper.origin !== 'builtin') next.set(helper.id, helper)
    }
    for (const helper of prepared.values()) {
      if (next.has(helper.id)) fail(`duplicate helper ID "${helper.id}" in registered catalog`)
      next.set(helper.id, await this.materializeRegisteredHelper(helper))
    }
    this.assertSnapshot(next)

    if (this.sameBinding(restored, next)) return restored
    await this.persistBinding(next)
    return next
  }

  private bindingPath(): string {
    return join(this.options.storageRoot, 'registered-skill-generations', CATALOG_BINDING_FILE)
  }

  private async restoreBinding(): Promise<ReadonlyMap<string, RegisteredSkillHelper> | undefined> {
    const raw = await readFile(this.bindingPath()).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch {
      return fail('registered helper catalog binding is invalid')
    }
    if (!isRecord(parsed)) fail('registered helper catalog binding is invalid')
    const binding = parsed as Record<string, unknown>
    if (
      binding.schemaVersion !== CATALOG_BINDING_SCHEMA_VERSION ||
      !Array.isArray(binding.helpers)
    ) {
      fail('registered helper catalog binding is invalid')
    }

    const snapshot = new Map<string, RegisteredSkillHelper>()
    for (const value of binding.helpers as unknown[]) {
      const helper = this.normalizeBoundHelper(value)
      if (snapshot.has(helper.id)) fail(`duplicate helper ID "${helper.id}" in catalog binding`)
      const sourcePath = join(this.generationRoot(helper.generation), helper.id, 'source.py')
      const sourceBytes = await readFile(sourcePath).catch(() => undefined)
      if (!sourceBytes || sourceDigest(sourceBytes) !== helper.digest) {
        fail(`immutable generation mismatch for helper "${helper.id}"`)
      }
      let source: string
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
      } catch {
        return fail(`immutable generation source for helper "${helper.id}" must be UTF-8`)
      }
      snapshot.set(helper.id, Object.freeze({ ...helper, source }))
    }
    assertDependencyGraph(snapshot)
    return snapshot
  }

  private normalizeBoundHelper(value: unknown): BoundHelper {
    if (!isRecord(value)) fail('registered helper catalog binding entry is invalid')
    const record = value as Record<string, unknown>
    const id = assertStableId(record.id, 'helper id')
    const skillId = assertStableId(record.skillId, 'Skill identity')
    if (record.language !== 'python') fail(`helper "${id}" has an unsupported language`)
    if (!['builtin', 'personal', 'imported'].includes(String(record.origin))) {
      fail(`Skill "${skillId}" has an invalid origin`)
    }
    if (!Number.isSafeInteger(record.interfaceRevision) || Number(record.interfaceRevision) < 1) {
      fail(`helper "${id}" has an invalid Interface revision`)
    }
    const generation = record.generation
    if (typeof generation !== 'string' || !SHA256_GENERATION.test(generation)) {
      fail(`helper "${id}" has an invalid generation`)
    }
    const digest = record.digest
    if (typeof digest !== 'string' || !SHA256_GENERATION.test(digest)) {
      fail(`helper "${id}" has an invalid digest`)
    }
    const descriptor = normalizeDescriptor({
      id,
      language: record.language,
      interfaceRevision: record.interfaceRevision,
      implementation: 'source.py',
      exports: record.exports,
      dependencies: record.dependencies
    })
    return {
      id,
      skillId,
      origin: record.origin as RegisteredSkillOrigin,
      language: 'python',
      interfaceRevision: descriptor.interfaceRevision,
      exports: Object.freeze([...descriptor.exports]),
      dependencies: Object.freeze([...descriptor.dependencies]),
      generation: generation as string,
      digest: digest as string
    }
  }

  private async persistBinding(
    snapshot: ReadonlyMap<string, RegisteredSkillHelper>
  ): Promise<void> {
    const root = join(this.options.storageRoot, 'registered-skill-generations')
    await mkdir(root, { recursive: true })
    const staging = join(root, `.catalog-binding-${randomUUID()}.json`)
    const helpers = [...snapshot.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((helper) => ({
        id: helper.id,
        language: helper.language,
        exports: helper.exports,
        dependencies: helper.dependencies,
        skillId: helper.skillId,
        origin: helper.origin,
        interfaceRevision: helper.interfaceRevision,
        generation: helper.generation,
        digest: helper.digest
      }))
    try {
      await writeFile(
        staging,
        JSON.stringify({ schemaVersion: CATALOG_BINDING_SCHEMA_VERSION, helpers }),
        { flag: 'wx', mode: 0o600 }
      )
      await rename(staging, this.bindingPath())
    } finally {
      await rm(staging, { force: true })
    }
  }

  private async buildSnapshotFromPackages(): Promise<ReadonlyMap<string, RegisteredSkillHelper>> {
    const prepared = await prepareRegisteredSkillPackages(await this.options.packages())

    const snapshot = new Map<string, RegisteredSkillHelper>()
    for (const helper of prepared.values()) {
      snapshot.set(helper.id, await this.materializeRegisteredHelper(helper))
    }
    return snapshot
  }

  private async materializeRegisteredHelper(
    helper: PreparedHelper
  ): Promise<RegisteredSkillHelper> {
    const root = await this.materialize(helper)
    const source = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(join(root, 'source.py'))
    )
    return this.registeredHelper(helper, source)
  }

  private registeredHelper(helper: PreparedHelper, source: string): RegisteredSkillHelper {
    return Object.freeze({
      id: helper.id,
      language: helper.language,
      source,
      exports: helper.exports,
      dependencies: helper.dependencies,
      skillId: helper.skillId,
      origin: helper.origin,
      interfaceRevision: helper.interfaceRevision,
      generation: helper.generation,
      digest: helper.digest
    })
  }

  private assertSnapshot(snapshot: ReadonlyMap<string, RegisteredSkillHelper>): void {
    let totalBytes = 0
    for (const helper of snapshot.values()) {
      totalBytes += Buffer.byteLength(helper.source)
      if (totalBytes > HELPER_SOURCE_TOTAL_MAX_BYTES) {
        fail('registered helper catalog exceeds the total source size limit')
      }
    }
    assertDependencyGraph(snapshot)
  }

  private sameBinding(
    left: ReadonlyMap<string, RegisteredSkillHelper>,
    right: ReadonlyMap<string, RegisteredSkillHelper>
  ): boolean {
    if (left.size !== right.size) return false
    for (const [id, helper] of left) {
      const candidate = right.get(id)
      if (
        !candidate ||
        candidate.skillId !== helper.skillId ||
        candidate.origin !== helper.origin ||
        candidate.interfaceRevision !== helper.interfaceRevision ||
        candidate.generation !== helper.generation ||
        candidate.digest !== helper.digest ||
        candidate.language !== helper.language ||
        candidate.exports.length !== helper.exports.length ||
        candidate.exports.some((value, index) => value !== helper.exports[index]) ||
        candidate.dependencies.length !== helper.dependencies.length ||
        candidate.dependencies.some((value, index) => value !== helper.dependencies[index])
      ) {
        return false
      }
    }
    return true
  }

  private async materialize(helper: PreparedHelper): Promise<string> {
    const generationRoot = this.generationRoot(helper.generation)
    const root = join(generationRoot, helper.id)
    const sourcePath = join(root, 'source.py')
    const existing = await readFile(sourcePath).catch(() => undefined)
    if (existing) {
      if (sourceDigest(existing) !== helper.digest) {
        fail(`immutable generation mismatch for helper "${helper.id}"`)
      }
      return root
    }

    await mkdir(generationRoot, { recursive: true })
    const staging = join(generationRoot, `.staging-${randomUUID()}`)
    await mkdir(staging)
    try {
      await writeFile(join(staging, 'source.py'), helper.sourceBytes, { flag: 'wx', mode: 0o400 })
      await writeFile(
        join(staging, 'snapshot.json'),
        JSON.stringify({
          id: helper.id,
          skillId: helper.skillId,
          origin: helper.origin,
          language: helper.language,
          interfaceRevision: helper.interfaceRevision,
          exports: helper.exports,
          dependencies: helper.dependencies,
          generation: helper.generation,
          digest: helper.digest
        }),
        { flag: 'wx', mode: 0o400 }
      )
      await rename(staging, root).catch(async (error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    const materialized = await readFile(sourcePath).catch(() => undefined)
    if (!materialized || sourceDigest(materialized) !== helper.digest) {
      fail(`immutable generation mismatch for helper "${helper.id}"`)
    }
    return root
  }
}

export {
  HELPER_MANIFEST_FILE,
  RegisteredSkillHelperCatalog,
  readSkillHelperDescriptors,
  validateRegisteredSkillPackages,
  validateSkillHelperPackage
}
export type {
  RegisteredHelperScope,
  RegisteredSkillHelper,
  RegisteredSkillOrigin,
  RegisteredSkillPackage,
  SkillHelperDescriptor
}
