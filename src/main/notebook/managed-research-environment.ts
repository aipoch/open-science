import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { gte } from 'semver'
import serviceAdapterSource from './node-local-service-preload.mjs?raw'
import {
  compareResearchReproductionArchiveEntries,
  type ResearchReproductionArchiveEntry
} from '../../shared/research-reproduction'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { defaultFileDurability } from '../storage/file-durability'
import {
  createManagedOutputAuthority,
  type ManagedOutputAuthority
} from './managed-output-authority'
import {
  createManagedEnvironmentDirectory,
  removeManagedEnvironmentDirectory,
  verifyManagedEnvironmentDirectory
} from './managed-environment-directory'
import {
  createManagedShellExecutionCapability,
  type ManagedShellExecutionCapability
} from './managed-shell-execution'
import {
  prepareResearchMaterials,
  type PrepareResearchMaterialOptions,
  type ResearchMaterialAuthority
} from './research-materials'
import { getNotebookDataRoot } from './repository'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const absolutePath = z
  .string()
  .max(4096)
  .refine(
    (path) => isAbsolute(path) && normalize(path) === path && !path.includes('\0'),
    'Expected a canonical absolute path.'
  )
const sourceSchema = z
  .object({
    projectId: identity,
    sessionId: identity,
    identity: z.string().min(1).max(4096),
    title: z.string().max(4096).optional()
  })
  .strict()
const versionSchema = z
  .object({
    versionId: identity,
    sourceIdentity: z.string().min(1).max(4096),
    filename: z.string().max(4096),
    sha256: checksum,
    sizeBytes: z.number().int().nonnegative(),
    contentAvailable: z.boolean().optional(),
    descriptor: z.boolean().optional(),
    materialKey: z.string().max(512).optional(),
    restorePath: z.string().max(4096).optional()
  })
  .strict()
const entrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), path: z.string().max(4096) }).strict(),
  z
    .object({
      type: z.literal('file'),
      path: z.string().max(4096),
      sizeBytes: z.number().int().nonnegative(),
      sha256: checksum
    })
    .strict()
])
const directorySchema = z
  .object({
    nonce: z.string().uuid(),
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative()
  })
  .strict()
const runtimeSchema = z
  .object({
    kind: z.literal('node'),
    executable: absolutePath,
    version: z.string().regex(/^v?\d+\.\d+\.\d+(?:[-+].+)?$/),
    sha256: checksum,
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.string().min(1).max(64),
    readOnlyRoots: z.array(absolutePath).min(1).max(32)
  })
  .strict()
const scopeSchema = z.object({ projectId: identity, sessionId: identity }).strict()
const collectionSchema = z
  .object({ collectionId: checksum, executionInvocationId: identity })
  .strict()
const receiptSchema = scopeSchema
  .extend({
    schemaVersion: z.literal(1),
    environmentId: checksum,
    requestId: identity,
    fingerprint: checksum,
    source: sourceSchema,
    runtime: runtimeSchema,
    state: z.enum(['preparing', 'ready', 'releasing', 'cleanup-pending', 'released', 'failed']),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    directoryNonce: z.string().uuid(),
    directory: directorySchema.optional(),
    outputNonce: z.string().uuid(),
    outputDirectory: directorySchema.optional(),
    releaseRequested: z.boolean().optional(),
    pendingCollection: collectionSchema.optional(),
    discardedCollections: z
      .array(collectionSchema.extend({ discardedAt: z.number().int().nonnegative() }).strict())
      .max(1000)
      .optional(),
    prepared: z
      .object({
        source: sourceSchema,
        inputs: z.array(versionSchema).max(1000),
        entries: z.array(entrySchema).max(10000),
        totalBytes: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    activeExecution: z
      .object({
        executionInvocationId: identity,
        socket: z
          .object({
            runId: identity,
            suffix: z.string().regex(/^[a-zA-Z0-9]{6}$/),
            nonce: z.string().uuid(),
            directory: directorySchema.optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    error: z.string().max(4096).optional()
  })
  .strict()

export type ManagedResearchEnvironment = z.infer<typeof receiptSchema>
export type ManagedResearchScope = z.infer<typeof scopeSchema>
export type ManagedResearchRuntime = z.infer<typeof runtimeSchema>
type EnvironmentReference = ManagedResearchScope & { environmentId: string }
type MaterialSelection = Omit<PrepareResearchMaterialOptions, 'stagingDirectory' | 'signal'>
export type PrepareManagedResearchEnvironment = ManagedResearchScope & {
  requestId: string
  authority: ResearchMaterialAuthority
  materials: MaterialSelection
  runtime: ManagedResearchRuntime
  signal?: AbortSignal
}
export type ManagedEnvironmentExecution = EnvironmentReference & {
  executionInvocationId: string
  collectionId?: string
  /** Main keeps the output fence until Artifact publication has been durably acknowledged. */
  retainCollection?: boolean
  environment?: Readonly<Record<string, string>>
  /** Trusted Main policy; unavailable in public execution schemas. */
  confinement?: import('./managed-shell-execution').ManagedShellExecutionPolicy['confinement']
  privateEnvironment?: Readonly<Record<string, string>>
  secretValues?: readonly string[]
  localServicePort?: number
  /** Trusted observers only; neither callback nor proof comes from the public request payload. */
  onOutput?: import('./managed-shell-execution').ManagedShellExecutionPolicy['onOutput']
  serviceProof?: import('./managed-shell-execution').ManagedServiceProof
  onServiceAllocated?: (service: { runId: string; socketPath: string; signal: AbortSignal }) => void
  signal?: AbortSignal
}
export type ManagedEnvironmentExecutionContext = Readonly<{
  capability: ManagedShellExecutionCapability
  inputRoot: string
  workRoot: string
  outputRoot: string
  runtime: ManagedResearchRuntime
  receipt: ManagedResearchEnvironment
  signal: AbortSignal
  /** Output publication may finish after a verified execution cancellation. */
  publicationSignal: AbortSignal
  createOutputAuthority(operationId: string): ManagedOutputAuthority
}>
export type ManagedEnvironmentCollection = EnvironmentReference & {
  collectionId: string
  operationId: string
  /** Main keeps the output fence until Artifact publication has been durably acknowledged. */
  retainCollection?: boolean
  signal?: AbortSignal
}
export type ManagedEnvironmentCollectionContext = Readonly<{
  outputRoot: string
  receipt: ManagedResearchEnvironment
  signal: AbortSignal
  authority: ManagedOutputAuthority
}>
export type ManagedResearchEnvironmentDependencies = {
  dataRoot: string
  /** Main selects a trusted independent runtime and rechecks its bytes before every dispatch. */
  verifyRuntime(runtime: ManagedResearchRuntime): Promise<void>
  /** Must be the existing Notebook owner, including unknown admission/crash windows. */
  stopExecution(scope: ManagedResearchScope & { executionInvocationId: string }): Promise<{
    verified: boolean
  }>
  /** Canonical short directory; production macOS composition uses /private/tmp. */
  socketRoot: string
  now?: () => number
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
export const getManagedResearchEnvironmentId = (
  scope: ManagedResearchScope & { requestId: string }
): string => {
  scopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId })
  identity.parse(scope.requestId)
  return hash(canonical([scope.projectId, scope.sessionId, scope.requestId]))
}
const environmentId = getManagedResearchEnvironmentId
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const MAX_RECEIPT_BYTES = 32 * 1024 ** 2

/** A trusted application cancellation, distinguishable from execution or cleanup failures. */
export class ManagedEnvironmentCancelledError extends Error {
  constructor() {
    super('Managed environment execution was cancelled before dispatch.')
    this.name = 'ManagedEnvironmentCancelledError'
  }
}

/** Owns material directories and socket directories, never processes or a second Notebook runtime. */
export class ManagedResearchEnvironmentOwner {
  private readonly operations = new Map<string, Promise<void>>()
  private readonly live = new Map<string, { controller: AbortController; settled: Promise<void> }>()
  private readonly shutdown = new AbortController()
  private closed = false
  private quiescing = false
  private cancellationGeneration = 0
  private readonly releaseGenerations = new Map<string, number>()
  private readonly storage: string
  private readonly records: string

  constructor(private readonly dependencies: ManagedResearchEnvironmentDependencies) {
    this.storage = join(absolutePath.parse(dependencies.dataRoot), 'research-environments')
    this.records = join(this.storage, 'receipts')
    absolutePath.parse(dependencies.socketRoot)
  }

  private root(id: string): string {
    return join(this.storage, checksum.parse(id))
  }
  private recordPath(id: string): string {
    return join(this.records, checksum.parse(id) + '.json')
  }
  private outputContainer(receipt: ManagedResearchEnvironment): string {
    return join(
      getNotebookDataRoot(this.dependencies.dataRoot, receipt.projectId, receipt.sessionId),
      'managed-execution',
      receipt.environmentId
    )
  }

  private async prepareOutputParent(receipt: ManagedResearchEnvironment): Promise<void> {
    // Create only the application Notebook hierarchy. Inspect each existing ancestor before
    // descending; a symlink must never redirect allocation into unrelated user storage.
    const parents: string[] = []
    let path = dirname(this.outputContainer(receipt))
    while (path !== this.dependencies.dataRoot) {
      if (dirname(path) === path) throw new Error('Managed output is outside the data root.')
      parents.unshift(path)
      path = dirname(path)
    }
    for (const parent of parents) {
      try {
        await mkdir(parent, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await lstat(parent)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (await realpath(parent)) !== parent
      )
        throw new Error('Managed output ancestor is not application-owned storage.')
    }
  }

  private async removeDirectories(receipt: ManagedResearchEnvironment): Promise<void> {
    if (receipt.pendingCollection)
      throw new Error('Managed execution outputs are awaiting collection; preserving them.')
    await removeManagedEnvironmentDirectory(this.outputContainer(receipt), receipt.outputDirectory)
    await removeManagedEnvironmentDirectory(this.root(receipt.environmentId), receipt.directory)
  }
  private now(): number {
    return (this.dependencies.now ?? Date.now)()
  }

  private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.operations.set(id, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.operations.get(id) === tail) this.operations.delete(id)
    }
  }

  private decode(text: string, id: string): ManagedResearchEnvironment {
    const result = receiptSchema.safeParse(JSON.parse(text))
    if (!result.success || result.data.environmentId !== id || environmentId(result.data) !== id) {
      throw new DurableJsonRecoveryBarrierError('Invalid managed research environment receipt.')
    }
    return result.data
  }

  private async read(id: string): Promise<ManagedResearchEnvironment | undefined> {
    await this.checkStorage(false)
    const result = await readDurableJsonFile(
      this.recordPath(id),
      (text) => this.decode(text, id),
      {},
      { maxBytes: MAX_RECEIPT_BYTES }
    )
    return result.status === 'found' ? result.value : undefined
  }

  private async write(receipt: ManagedResearchEnvironment): Promise<void> {
    await this.checkStorage(false)
    receipt.updatedAt = this.now()
    const text = JSON.stringify(receiptSchema.parse(receipt))
    if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES)
      throw new Error('Environment receipt is too large.')
    await writeDurableJsonFile(this.recordPath(receipt.environmentId), text)
  }

  private async checkStorage(create: boolean): Promise<void> {
    if ((await realpath(this.dependencies.dataRoot)) !== this.dependencies.dataRoot) {
      throw new Error('Managed environment data root must be canonical.')
    }
    for (const path of [this.storage, this.records]) {
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      let stat
      try {
        stat = await lstat(path)
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
        (await realpath(path)) !== path
      ) {
        throw new Error('Managed environment storage is not private owned storage.')
      }
    }
  }

  private async require(scope: EnvironmentReference): Promise<ManagedResearchEnvironment> {
    scopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId })
    const receipt = await this.read(scope.environmentId)
    if (
      !receipt ||
      receipt.projectId !== scope.projectId ||
      receipt.sessionId !== scope.sessionId
    ) {
      throw new Error('Managed environment does not belong to this Session.')
    }
    return receipt
  }

  /** Main-only intent recovery: absence is distinct from an invalid receipt; never prepares or executes. */
  async lookupPrepared(
    scope: ManagedResearchScope & { requestId: string }
  ): Promise<ManagedResearchEnvironment | undefined> {
    const id = getManagedResearchEnvironmentId(scope)
    const receipt = await this.read(id)
    if (!receipt) return undefined
    if (
      receipt.projectId !== scope.projectId ||
      receipt.sessionId !== scope.sessionId ||
      receipt.requestId !== scope.requestId
    )
      throw new Error('Managed environment receipt does not match its preparation intent.')
    return structuredClone(receipt)
  }

  async get(scope: EnvironmentReference): Promise<ManagedResearchEnvironment> {
    return structuredClone(await this.require(scope))
  }

  async prepare(request: PrepareManagedResearchEnvironment): Promise<ManagedResearchEnvironment> {
    const scope = scopeSchema.parse({ projectId: request.projectId, sessionId: request.sessionId })
    identity.parse(request.requestId)
    const runtime = runtimeSchema.parse(request.runtime)
    const source = sourceSchema.parse(request.authority.source)
    if (source.projectId !== scope.projectId)
      throw new Error('Cross-project material access is unavailable.')
    // All material selection is explicit and frozen before awaiting any I/O.
    const materials = structuredClone(request.materials)
    const authority: ResearchMaterialAuthority = {
      source,
      versions: structuredClone(request.authority.versions),
      readVersion: request.authority.readVersion.bind(request.authority)
    }
    const id = environmentId({ ...scope, requestId: request.requestId })
    const fingerprint = hash(
      canonical({ source, runtime, materials, versions: authority.versions })
    )
    return this.exclusive(id, async () => {
      if (this.closed || this.quiescing) throw new Error('Managed environments are closed.')
      request.signal?.throwIfAborted()
      const existing = await this.read(id)
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error('Environment request conflicts with its earlier contents.')
        if (existing.state !== 'ready' || existing.activeExecution) {
          throw new Error(
            'Environment request is not ready; inspect or release it before using a new request.'
          )
        }
        await this.verifyInputs(existing)
        return structuredClone(existing)
      }
      await this.dependencies.verifyRuntime(runtime)
      await this.checkStorage(true)
      const receipt: ManagedResearchEnvironment = {
        schemaVersion: 1,
        ...scope,
        requestId: request.requestId,
        environmentId: id,
        fingerprint,
        source,
        runtime,
        state: 'preparing',
        createdAt: this.now(),
        updatedAt: this.now(),
        directoryNonce: randomUUID(),
        outputNonce: randomUUID()
      }
      // The intent is durable before mkdir, including a nonce that cannot be supplied by materials.
      await this.write(receipt)
      try {
        receipt.directory = await createManagedEnvironmentDirectory(
          this.root(id),
          receipt.directoryNonce
        )
        await this.write(receipt)
        for (const child of ['staging', 'work']) {
          await mkdir(join(this.root(id), child), { mode: 0o700 })
        }
        await mkdir(join(this.root(id), 'work', 'tmp'), { mode: 0o700 })
        await this.prepareOutputParent(receipt)
        receipt.outputDirectory = await createManagedEnvironmentDirectory(
          this.outputContainer(receipt),
          receipt.outputNonce
        )
        await this.write(receipt)
        await mkdir(join(this.outputContainer(receipt), 'files'), { mode: 0o700 })
        receipt.prepared = await prepareResearchMaterials(authority, {
          ...materials,
          stagingDirectory: join(this.root(id), 'staging'),
          signal: request.signal
        })
        request.signal?.throwIfAborted()
        await rename(join(this.root(id), 'staging'), join(this.root(id), 'inputs'))
        await defaultFileDurability.syncDirectory(this.root(id))
        receipt.state = 'ready'
        await this.write(receipt)
        return structuredClone(receipt)
      } catch (error) {
        try {
          await this.removeDirectories(receipt)
          receipt.state = 'failed'
        } catch {
          receipt.state = 'cleanup-pending'
        }
        receipt.error = 'Material preparation did not complete.'
        await this.write(receipt)
        throw error
      }
    })
  }

  private async verifyInputs(receipt: ManagedResearchEnvironment): Promise<void> {
    if (
      !receipt.directory ||
      !receipt.outputDirectory ||
      !receipt.prepared ||
      !(await verifyManagedEnvironmentDirectory(
        this.root(receipt.environmentId),
        receipt.directory
      )) ||
      !(await verifyManagedEnvironmentDirectory(
        this.outputContainer(receipt),
        receipt.outputDirectory
      ))
    ) {
      throw new Error('Prepared environment is unavailable.')
    }
    const root = join(this.root(receipt.environmentId), 'inputs')
    const observed: ResearchReproductionArchiveEntry[] = []
    let totalBytes = 0
    const visit = async (relative: string): Promise<void> => {
      const path = relative ? join(root, relative) : root
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('Prepared input contains a symbolic link.')
      if (stat.isDirectory()) {
        if (relative) observed.push({ type: 'directory', path: relative })
        if (observed.length > 20000) throw new Error('Prepared input contains too many paths.')
        for (const name of await readdir(path)) await visit(relative ? relative + '/' + name : name)
      } else if (stat.isFile() && stat.nlink === 1) {
        const expected = receipt.prepared!.entries.find((entry) => entry.path === relative)
        if (expected?.type !== 'file' || expected.sizeBytes !== stat.size) {
          throw new Error('Prepared input has changed.')
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const digest = createHash('sha256')
        let count = 0
        try {
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            count += (chunk as Buffer).length
            if (count > expected.sizeBytes)
              throw new Error('Prepared input grew during verification.')
            digest.update(chunk)
          }
        } finally {
          await file.close()
        }
        totalBytes += count
        observed.push({
          type: 'file',
          path: relative,
          sizeBytes: count,
          sha256: digest.digest('hex')
        })
      } else {
        throw new Error('Prepared input contains an unsupported filesystem entry.')
      }
    }
    await visit('')
    if (
      totalBytes !== receipt.prepared.totalBytes ||
      compareResearchReproductionArchiveEntries(receipt.prepared.entries, observed).status !==
        'matched'
    ) {
      throw new Error('Prepared input inventory no longer matches the verified materials.')
    }
    for (const path of [
      join(this.root(receipt.environmentId), 'work'),
      join(this.root(receipt.environmentId), 'work/tmp'),
      join(this.outputContainer(receipt), 'files')
    ]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
        throw new Error('Managed execution directory has changed.')
      }
    }
    await this.dependencies.verifyRuntime(receipt.runtime)
  }

  private socketPath(receipt: ManagedResearchEnvironment): string {
    const socket = receipt.activeExecution?.socket
    if (!socket) throw new Error('No managed socket intent exists.')
    const path = join(
      this.dependencies.socketRoot,
      'os-service-' + socket.runId + '-' + socket.suffix
    )
    if (Buffer.byteLength(join(path, 'service.sock')) > 103)
      throw new Error('Managed service socket path is too long.')
    return path
  }

  private async stopAndCleanSocket(
    receipt: ManagedResearchEnvironment,
    retainedInvocationId?: string
  ): Promise<void> {
    const active = receipt.activeExecution
    if (active && retainedInvocationId && active.executionInvocationId !== retainedInvocationId)
      throw new Error('Retained collection does not belong to the active execution.')
    const executionInvocationId = active?.executionInvocationId ?? retainedInvocationId
    if (!executionInvocationId) return
    const proof = await this.dependencies.stopExecution({
      projectId: receipt.projectId,
      sessionId: receipt.sessionId,
      executionInvocationId
    })
    if (!proof.verified)
      throw new Error('Execution cleanup is not verified; preserving environment resources.')
    if (active?.socket) {
      await removeManagedEnvironmentDirectory(this.socketPath(receipt), active.socket.directory)
    }
    if (active) {
      delete receipt.activeExecution
      await this.write(receipt)
    }
  }

  async withExecution<T>(
    request: ManagedEnvironmentExecution,
    execute: (context: ManagedEnvironmentExecutionContext) => Promise<T>
  ): Promise<T> {
    identity.parse(request.executionInvocationId)
    const collectionId =
      request.collectionId === undefined ? undefined : checksum.parse(request.collectionId)
    const retainCollection = z.boolean().parse(request.retainCollection ?? false)
    if (retainCollection && !collectionId)
      throw new Error('Retained execution requires an exact collection identity.')
    const reference = {
      ...scopeSchema.parse({ projectId: request.projectId, sessionId: request.sessionId }),
      environmentId: checksum.parse(request.environmentId)
    }
    if (this.closed || this.quiescing) throw new Error('Managed environments are closed.')
    // Capture before joining the queue. Releasing a live execution must cancel earlier queued
    // work too, including work that has not yet acquired a validated receipt or process owner.
    const generation = this.cancellationGeneration
    const releaseGeneration = this.releaseGenerations.get(reference.environmentId) ?? 0
    const assertAdmission = (): void => {
      request.signal?.throwIfAborted()
      if (
        this.closed ||
        this.quiescing ||
        generation !== this.cancellationGeneration ||
        releaseGeneration !== (this.releaseGenerations.get(reference.environmentId) ?? 0)
      )
        throw new ManagedEnvironmentCancelledError()
    }
    return this.exclusive(reference.environmentId, async () => {
      assertAdmission()
      const receipt = await this.require(reference)
      assertAdmission()
      if (receipt.pendingCollection)
        throw new Error(
          'Managed execution outputs are awaiting collection; collect or discard them first.'
        )
      if (
        collectionId &&
        receipt.discardedCollections?.some((entry) => entry.collectionId === collectionId)
      )
        throw new Error(
          'Managed execution collection was explicitly discarded and cannot be reused.'
        )
      if (receipt.state !== 'ready' || receipt.activeExecution || receipt.releaseRequested)
        throw new Error('Managed environment is not ready.')
      await this.verifyInputs(receipt)
      assertAdmission()
      const controller = new AbortController()
      // Process cancellation and publication have different lifetimes. After the process owner
      // proves termination, the original turn may still collect bounded partial outputs.
      const publication = new AbortController()
      const signal = AbortSignal.any([
        controller.signal,
        this.shutdown.signal,
        ...(request.signal ? [request.signal] : [])
      ])
      signal.throwIfAborted()
      const inputRoot = join(this.root(receipt.environmentId), 'inputs')
      const workRoot = join(this.root(receipt.environmentId), 'work')
      const outputRoot = join(this.outputContainer(receipt), 'files')
      let serviceAdapter: string | undefined
      if (request.serviceProof) {
        if (request.localServicePort === undefined)
          throw new Error('An interactive service requires its declared local service port.')
        // The application-owned adapter is outside all workload write roots. Never replace or
        // trust an adapter from imported materials; the selected version is part of this runtime.
        serviceAdapter = join(this.root(receipt.environmentId), 'service-adapter.mjs')
        let handle: Awaited<ReturnType<typeof open>> | undefined
        try {
          handle = await open(
            serviceAdapter,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o400
          )
          await handle.writeFile(serviceAdapterSource)
          await handle.sync()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existing = await open(serviceAdapter, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const stat = await existing.stat()
            if (
              !stat.isFile() ||
              stat.size !== Buffer.byteLength(serviceAdapterSource) ||
              hash(await existing.readFile('utf8')) !== hash(serviceAdapterSource)
            )
              throw new Error('The managed service adapter has changed.')
          } finally {
            await existing.close()
          }
        } finally {
          await handle?.close()
        }
      }
      const environment: Record<string, string> = {
        PATH:
          dirname(receipt.runtime.executable) +
          (process.platform === 'win32' ? ';' : ':') +
          '/usr/bin:/bin',
        HOME: workRoot,
        TMPDIR: join(workRoot, 'tmp'),
        OPEN_SCIENCE_INPUT_DIR: inputRoot,
        OPEN_SCIENCE_OUTPUT_DIR: outputRoot,
        OPEN_SCIENCE_NODE: receipt.runtime.executable,
        // Node's built-in fetch does not otherwise honor the controlled HTTP(S) proxy.
        // Older runtimes must use an explicit application proxy adapter; never allow direct TCP.
        ...(request.confinement && gte(receipt.runtime.version, '24.5.0')
          ? { NODE_USE_ENV_PROXY: '1' }
          : {}),
        ...(serviceAdapter
          ? {
              NODE_OPTIONS: `--import=${pathToFileURL(serviceAdapter).href}`,
              OPEN_SCIENCE_SERVICE_ADAPTER_SHA256: hash(serviceAdapterSource)
            }
          : {})
      }
      for (const [key, value] of Object.entries(request.environment ?? {})) {
        if (/^(?:OPEN_SCIENCE_|NODE_|DYLD_|LD_)/.test(key) || key in environment) {
          throw new Error('Managed environment runtime-control variables cannot be overridden.')
        }
        environment[key] = value
      }
      if (request.localServicePort !== undefined && process.platform !== 'darwin') {
        throw new Error('Managed local services currently require native macOS.')
      }
      const capability = createManagedShellExecutionCapability({
        projectId: receipt.projectId,
        sessionId: receipt.sessionId,
        executionInvocationId: request.executionInvocationId,
        cwd: workRoot,
        outputRoot,
        environment,
        ...(request.confinement ? { confinement: request.confinement } : {}),
        ...(request.privateEnvironment ? { privateEnvironment: request.privateEnvironment } : {}),
        ...(request.secretValues ? { secretValues: request.secretValues } : {}),
        filesystem: {
          readOnlyRoots: [
            inputRoot,
            ...receipt.runtime.readOnlyRoots,
            ...(serviceAdapter ? [serviceAdapter] : [])
          ],
          readWriteRoots: [workRoot, outputRoot]
        },
        fingerprint: receipt.fingerprint,
        signal,
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
        ...(request.localServicePort === undefined
          ? {}
          : {
              localService: {
                logicalPort: request.localServicePort,
                ...(request.serviceProof ? { proof: request.serviceProof } : {}),
                prepareSocket: async ({ runId }): Promise<string> => {
                  identity.parse(runId)
                  signal.throwIfAborted()
                  if (!receipt.activeExecution || receipt.activeExecution.socket)
                    throw new Error('A socket was already allocated.')
                  receipt.activeExecution.socket = {
                    runId,
                    suffix: randomBytes(3).toString('hex'),
                    nonce: randomUUID()
                  }
                  const path = this.socketPath(receipt)
                  await this.write(receipt)
                  receipt.activeExecution.socket.directory =
                    await createManagedEnvironmentDirectory(
                      path,
                      receipt.activeExecution.socket.nonce
                    )
                  await this.write(receipt)
                  signal.throwIfAborted()
                  const socketPath = join(path, 'service.sock')
                  request.onServiceAllocated?.({ runId, socketPath, signal })
                  return socketPath
                }
              }
            })
      })
      receipt.activeExecution = { executionInvocationId: request.executionInvocationId }
      if (collectionId)
        receipt.pendingCollection = {
          collectionId,
          executionInvocationId: request.executionInvocationId
        }
      await this.write(receipt)
      let resolveSettled!: () => void
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
      this.live.set(receipt.environmentId, { controller, settled })
      let result: T | undefined
      let succeeded = false
      let executionError: unknown
      let dispatched = false
      try {
        // Cancellation can arrive while the durable intent is being written, before live exists.
        assertAdmission()
        signal.throwIfAborted()
        dispatched = true
        result = await execute({
          capability,
          inputRoot,
          workRoot,
          outputRoot,
          runtime: receipt.runtime,
          receipt: structuredClone(receipt),
          signal,
          publicationSignal: publication.signal,
          createOutputAuthority: (operationId): ManagedOutputAuthority =>
            createManagedOutputAuthority({
              projectId: receipt.projectId,
              sessionId: receipt.sessionId,
              operationId: identity.parse(operationId),
              outputRoot,
              signal: publication.signal
            })
        })
        succeeded = true
      } catch (error) {
        executionError = error
      }
      controller.abort(new Error('Managed environment execution has settled.'))
      publication.abort(new Error('Managed environment output collection has settled.'))
      try {
        if (dispatched) {
          await this.stopAndCleanSocket(receipt)
          if (succeeded && collectionId && !retainCollection) {
            await this.clearPendingCollection(receipt)
          }
        } else {
          // The callback has never received its capability, so no Notebook dispatch is possible.
          // Clear our own intent without inventing a Run or asking for nonexistent process proof.
          delete receipt.activeExecution
          if (collectionId) delete receipt.pendingCollection
          await this.write(receipt)
        }
      } catch (error) {
        receipt.state = 'cleanup-pending'
        receipt.error = 'Execution resources could not be safely released.'
        await this.write(receipt)
        if (!succeeded) {
          throw new AggregateError(
            [executionError, error],
            'Execution and resource cleanup failed.'
          )
        }
        throw error
      } finally {
        this.live.delete(receipt.environmentId)
        resolveSettled()
      }
      if (!succeeded) throw executionError
      return result as T
    })
  }

  private async verifyCollectionDirectories(receipt: ManagedResearchEnvironment): Promise<string> {
    if (
      !receipt.directory ||
      !receipt.outputDirectory ||
      !(await verifyManagedEnvironmentDirectory(
        this.root(receipt.environmentId),
        receipt.directory
      )) ||
      !(await verifyManagedEnvironmentDirectory(
        this.outputContainer(receipt),
        receipt.outputDirectory
      ))
    )
      throw new Error('Retained collection directory ownership is unavailable; preserving it.')
    const outputRoot = join(this.outputContainer(receipt), 'files')
    const stat = await lstat(outputRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(outputRoot)) !== outputRoot)
      throw new Error('Retained collection output directory has changed.')
    return outputRoot
  }

  /** A new publication lease for retained bytes, never a resumed execution or runtime grant. */
  async withCollection<T>(
    request: ManagedEnvironmentCollection,
    collect: (context: ManagedEnvironmentCollectionContext) => Promise<T>
  ): Promise<T> {
    const reference = {
      ...scopeSchema.parse({ projectId: request.projectId, sessionId: request.sessionId }),
      environmentId: checksum.parse(request.environmentId)
    }
    const collectionId = checksum.parse(request.collectionId)
    const operationId = identity.parse(request.operationId)
    const retainCollection = z.boolean().parse(request.retainCollection ?? false)
    const generation = this.cancellationGeneration
    const releaseGeneration = this.releaseGenerations.get(reference.environmentId) ?? 0
    const assertAdmission = (): void => {
      request.signal?.throwIfAborted()
      if (
        this.closed ||
        this.quiescing ||
        generation !== this.cancellationGeneration ||
        releaseGeneration !== (this.releaseGenerations.get(reference.environmentId) ?? 0)
      )
        throw new ManagedEnvironmentCancelledError()
    }
    assertAdmission()
    return this.exclusive(reference.environmentId, async () => {
      assertAdmission()
      const receipt = await this.require(reference)
      if (receipt.pendingCollection?.collectionId !== collectionId)
        throw new Error('Retained collection does not match this managed environment.')
      if (receipt.discardedCollections?.some((entry) => entry.collectionId === collectionId))
        throw new Error('Retained collection was explicitly discarded.')
      if (!['ready', 'cleanup-pending', 'releasing'].includes(receipt.state))
        throw new Error('Managed environment is unavailable for output collection.')
      let outputRoot: string
      try {
        // Even if activeExecution was already cleared, ask the original Notebook owner again.
        await this.stopAndCleanSocket(receipt, receipt.pendingCollection.executionInvocationId)
        outputRoot = await this.verifyCollectionDirectories(receipt)
      } catch (error) {
        receipt.state = 'cleanup-pending'
        receipt.error =
          'Retained output collection requires verified stopped execution and owned directories.'
        await this.write(receipt)
        throw error
      }
      assertAdmission()
      receipt.state = 'ready'
      delete receipt.error
      await this.write(receipt)
      assertAdmission()
      const controller = new AbortController()
      const signal = AbortSignal.any([
        controller.signal,
        this.shutdown.signal,
        ...(request.signal ? [request.signal] : [])
      ])
      let resolveSettled!: () => void
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
      this.live.set(receipt.environmentId, { controller, settled })
      try {
        const authority = createManagedOutputAuthority({
          ...reference,
          operationId,
          outputRoot,
          signal
        })
        const result = await collect({
          outputRoot,
          receipt: structuredClone(receipt),
          signal,
          authority
        })
        signal.throwIfAborted()
        if (!retainCollection) await this.clearPendingCollection(receipt)
        return result
      } finally {
        controller.abort(new Error('Managed environment output collection has settled.'))
        this.live.delete(receipt.environmentId)
        resolveSettled()
      }
    })
  }

  private async clearPendingCollection(receipt: ManagedResearchEnvironment): Promise<void> {
    const pending = receipt.pendingCollection
    delete receipt.pendingCollection
    try {
      await this.write(receipt)
    } catch (error) {
      // A subsequent cleanup-error write must not erase the retention fence after a failed commit.
      receipt.pendingCollection = pending
      throw error
    }
  }

  /** Main acknowledges durable publication and completes an already requested release. */
  async acknowledgeCollection(
    scope: EnvironmentReference & { collectionId: string }
  ): Promise<ManagedResearchEnvironment> {
    const reference = {
      ...scopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId }),
      environmentId: checksum.parse(scope.environmentId)
    }
    const collectionId = checksum.parse(scope.collectionId)
    return this.exclusive(reference.environmentId, async () => {
      const receipt = await this.require(reference)
      if (!receipt.pendingCollection) return structuredClone(receipt)
      if (receipt.pendingCollection.collectionId !== collectionId)
        throw new Error('Retained collection does not match this managed environment.')
      await this.stopAndCleanSocket(receipt, receipt.pendingCollection.executionInvocationId)
      if (receipt.releaseRequested) {
        // Recover a crash between acknowledgment and cleanup as a release, never a reusable root.
        receipt.state = 'releasing'
        await this.write(receipt)
      }
      await this.clearPendingCollection(receipt)
      if (receipt.releaseRequested) {
        try {
          await this.removeDirectories(receipt)
          receipt.state = 'released'
          delete receipt.error
        } catch {
          receipt.state = 'cleanup-pending'
          receipt.error = 'Environment cleanup requires verified ownership and stopped execution.'
        }
        await this.write(receipt)
      }
      return structuredClone(receipt)
    })
  }

  private async discardPendingCollection(receipt: ManagedResearchEnvironment): Promise<void> {
    const pending = receipt.pendingCollection
    if (!pending) return
    const discarded = receipt.discardedCollections ?? []
    const previous = discarded.find(({ collectionId }) => collectionId === pending.collectionId)
    if (previous && previous.executionInvocationId !== pending.executionInvocationId)
      throw new Error('Discarded collection identity conflicts with its retained execution.')
    if (!previous) {
      if (discarded.length >= 1000)
        throw new Error('Managed environment discard history is full; preserving outputs.')
      receipt.discardedCollections = [...discarded, { ...pending, discardedAt: this.now() }]
      // Record explicit loss before removing the retention fence. Either crash state is safe.
      await this.write(receipt)
    }
    await this.clearPendingCollection(receipt)
  }

  async discardCollection(
    scope: EnvironmentReference & { collectionId: string }
  ): Promise<ManagedResearchEnvironment> {
    const reference = {
      ...scopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId }),
      environmentId: checksum.parse(scope.environmentId)
    }
    const collectionId = checksum.parse(scope.collectionId)
    return this.exclusive(reference.environmentId, async () => {
      const receipt = await this.require(reference)
      if (
        !receipt.pendingCollection &&
        receipt.discardedCollections?.some((entry) => entry.collectionId === collectionId)
      )
        return structuredClone(receipt)
      if (receipt.pendingCollection?.collectionId !== collectionId)
        throw new Error('Retained collection does not match this managed environment.')
      await this.stopAndCleanSocket(receipt, receipt.pendingCollection.executionInvocationId)
      await this.discardPendingCollection(receipt)
      return structuredClone(receipt)
    })
  }

  async release(scope: EnvironmentReference): Promise<ManagedResearchEnvironment> {
    return this.releaseEnvironment(scope, false)
  }

  private async releaseEnvironment(
    scope: EnvironmentReference,
    discardOutputs: boolean
  ): Promise<ManagedResearchEnvironment> {
    // Validate before cancellation: another Session cannot stop a guessed environment handle.
    await this.require(scope)
    this.releaseGenerations.set(
      scope.environmentId,
      (this.releaseGenerations.get(scope.environmentId) ?? 0) + 1
    )
    this.live
      .get(scope.environmentId)
      ?.controller.abort(new Error('Managed environment was released.'))
    return this.exclusive(scope.environmentId, async () => {
      const receipt = await this.require(scope)
      if (receipt.state === 'released') return structuredClone(receipt)
      receipt.releaseRequested = true
      receipt.state = 'releasing'
      await this.write(receipt)
      try {
        await this.stopAndCleanSocket(receipt, receipt.pendingCollection?.executionInvocationId)
        if (discardOutputs) await this.discardPendingCollection(receipt)
        if (receipt.pendingCollection) {
          // Releasing process resources does not authorize losing uncollected research output.
          receipt.state = 'ready'
        } else {
          await this.removeDirectories(receipt)
          receipt.state = 'released'
        }
        delete receipt.error
      } catch {
        receipt.state = 'cleanup-pending'
        receipt.error = 'Environment cleanup requires verified ownership and stopped execution.'
      }
      await this.write(receipt)
      return structuredClone(receipt)
    })
  }

  private async list(): Promise<ManagedResearchEnvironment[]> {
    await this.checkStorage(false)
    await recoverDurableJsonDirectory(
      this.records,
      (path, text) => this.decode(text, basename(path, '.json')),
      {},
      { maxBytes: MAX_RECEIPT_BYTES }
    )
    let names: string[]
    try {
      names = await readdir(this.records)
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const receipts: ManagedResearchEnvironment[] = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const receipt = await this.read(name.slice(0, -5))
      if (receipt) receipts.push(receipt)
    }
    return receipts
  }

  async recover(): Promise<void> {
    for (const snapshot of await this.list()) {
      await this.exclusive(snapshot.environmentId, async () => {
        // Collection/release may have advanced while recovery was waiting for the same owner lock.
        const receipt = await this.require(snapshot)
        if (this.live.has(receipt.environmentId)) return
        if (
          receipt.state === 'ready' &&
          !receipt.activeExecution &&
          (!receipt.releaseRequested || receipt.pendingCollection)
        )
          return
        if (receipt.state === 'released' || receipt.state === 'failed') return
        try {
          await this.stopAndCleanSocket(receipt, receipt.pendingCollection?.executionInvocationId)
          // A preparation interrupted before publication is discarded, never resumed or executed.
          if (receipt.pendingCollection) {
            await this.verifyCollectionDirectories(receipt)
            receipt.state = 'ready'
          } else if (receipt.state !== 'ready' || receipt.releaseRequested) {
            await this.removeDirectories(receipt)
            receipt.state = 'released'
          }
          delete receipt.error
        } catch {
          receipt.state = 'cleanup-pending'
          receipt.error = 'Interrupted environment requires verified cleanup.'
        }
        await this.write(receipt)
      })
    }
  }

  async releaseSession(scope: ManagedResearchScope): Promise<void> {
    scopeSchema.parse(scope)
    for (const receipt of await this.list()) {
      if (receipt.projectId !== scope.projectId || receipt.sessionId !== scope.sessionId) continue
      if ((await this.releaseEnvironment(receipt, true)).state !== 'released')
        throw new Error('Session environment cleanup is pending.')
    }
  }

  /** Invoke behind the existing Project deletion fence, while Notebook still owns stop proof. */
  async releaseProject(projectId: string): Promise<void> {
    identity.parse(projectId)
    for (const receipt of await this.list()) {
      if (receipt.projectId !== projectId) continue
      if ((await this.releaseEnvironment(receipt, true)).state !== 'released')
        throw new Error('Project environment cleanup is pending.')
    }
  }

  /** The caller closes admission and drains Session operations first. Failed cleanup blocks the
   * storage move; inode-bound material directories must never be copied as reusable environments.
   * This does not permanently close the owner, so a cancelled move can admit fresh preparation.
   */
  async prepareForDataRootHandoff(): Promise<void> {
    await Promise.all([...this.operations.values()])
    for (const receipt of await this.list()) {
      const released = await this.release(receipt)
      if (released.pendingCollection)
        throw new Error(
          'Managed execution outputs must be collected or explicitly discarded before moving data.'
        )
      if (released.state !== 'released')
        throw new Error('Managed environment cleanup must complete before moving data.')
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.shutdown.abort(new Error('Managed environments are closing.'))
    const live = [...this.live.values()]
    for (const execution of live)
      execution.controller.abort(new Error('Managed environments are closing.'))
    await Promise.all(live.map((execution) => execution.settled))
    await Promise.all([...this.operations.values()])
    await this.recover()
    if ((await this.list()).some((receipt) => receipt.state === 'cleanup-pending')) {
      throw new Error('Managed environment cleanup is pending.')
    }
  }

  /** Drain current work for a reversible application handoff; composition holds new admission. */
  async quiesce(): Promise<void> {
    this.quiescing = true
    this.cancellationGeneration += 1
    try {
      for (const execution of this.live.values())
        execution.controller.abort(new Error('Managed environments are quiescing.'))
      await Promise.all([...this.operations.values()])
      await this.recover()
      if ((await this.list()).some((receipt) => receipt.state === 'cleanup-pending'))
        throw new Error('Managed environment cleanup is pending.')
    } finally {
      this.quiescing = false
    }
  }
}
