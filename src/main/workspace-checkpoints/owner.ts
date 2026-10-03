// Workspace file checkpoints are a sidecar substrate: they never modify artifact provenance,
// notebook execution, or the Prisma schema, and they bind immutable manifests to message branches.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import type { PersistedConversationGraph } from '../../shared/conversation-graph'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

const CHECKPOINT_VERSION = 1

type WorkspaceCheckpointTrigger = 'turn-boundary' | 'explicit'

type WorkspaceCheckpointFileEntry = Readonly<{
  kind: 'file'
  path: string
  contentId: string
  checksum: string
  sizeBytes: number
}>

type WorkspaceCheckpointReferenceEntry = Readonly<{
  kind: 'reference'
  path: string
  sizeBytes: number
  mtimeMs: number
  ctimeMs: number
}>

type WorkspaceCheckpointEntry = WorkspaceCheckpointFileEntry | WorkspaceCheckpointReferenceEntry

type WorkspaceCheckpointBinding = Readonly<{
  branchId: string
  agentFrameId: string
  headMessageId?: string
  branchUpdatedAt: number
  revision: string
}>

type WorkspaceCheckpointManifest = Readonly<{
  version: typeof CHECKPOINT_VERSION
  id: string
  sessionId: string
  trigger: WorkspaceCheckpointTrigger
  createdAt: number
  binding: WorkspaceCheckpointBinding
  entries: readonly WorkspaceCheckpointEntry[]
}>

type WorkspaceCheckpointCaptureResult = Readonly<{
  checkpoint: WorkspaceCheckpointManifest
  graph: PersistedConversationGraph
}>

type WorkspaceCheckpointPreviewChange =
  'add' | 'modify' | 'delete' | 'unchanged' | 'reference' | 'reference-changed'

type WorkspaceCheckpointPreviewEntry = Readonly<{
  path: string
  kind: WorkspaceCheckpointEntry['kind'] | 'file'
  change: WorkspaceCheckpointPreviewChange
}>

type WorkspaceCheckpointRestorePreview = Readonly<{
  checkpointId: string
  sessionId: string
  branchId: string
  entries: readonly WorkspaceCheckpointPreviewEntry[]
  previewToken: string
  restoreable: boolean
}>

type WorkspaceCheckpointRestoreRequest = WorkspaceCheckpointCaptureRequest &
  Readonly<{
    previewToken: string
    confirm?: boolean
  }>

type WorkspaceCheckpointRestoreResult = Readonly<{
  checkpointId: string
  restored: true
}>

type WorkspaceCheckpointRestoreMutation = Readonly<{
  checkpointId: string
  path: string
}>

type WorkspaceCheckpointRestoreHooks = Readonly<{
  afterMutation?: (mutation: WorkspaceCheckpointRestoreMutation) => void | Promise<void>
}>

type WorkspaceCheckpointOwnerOptions = Readonly<{
  checkpointRoot: string
  maxBlobBytes?: number
  now?: () => number
  restoreHooks?: WorkspaceCheckpointRestoreHooks
}>

type DirectoryEntry = Readonly<{
  name: string
  isDirectory(): boolean
  isFile(): boolean
}>

type WorkspaceCheckpointRestoreJournal = Readonly<{
  version: 1
  id: string
  checkpointId: string
  sessionId: string
  workspaceRoot: string
  createdAt: number
}>

type WorkspaceCheckpointCaptureRequest = Readonly<{
  graph: PersistedConversationGraph
  sessionId: string
  branchId: string
  workspaceRoot: string
}>

const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024
const CHECKPOINT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

// Resolve every existing symlink in the path while still allowing the final directories to be created
// later. This keeps storage-containment checks based on the filesystem target, not the lexical path.
const canonicalizePotentialPath = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (!isMissing(error)) throw error
    const info = await lstat(absolute).catch((lstatError: unknown) => {
      if (isMissing(lstatError)) return undefined
      throw lstatError
    })
    if (info?.isSymbolicLink()) {
      return canonicalizePotentialPath(resolve(dirname(absolute), await readlink(absolute)))
    }
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await canonicalizePotentialPath(parent), basename(absolute))
  }
}

const pathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
}

const toPosixPath = (path: string): string => path.split(sep).join('/')

const assertActiveMessageBranch = (graph: PersistedConversationGraph, branchId: string): void => {
  const activeFrame = graph.frames.find((frame) => frame.id === graph.activeFrameId)
  if (!activeFrame || activeFrame.activeBranchId !== branchId) {
    throw new Error('Workspace checkpoint requires the active Message Branch.')
  }
}

const assertBranchBinding = (
  graph: PersistedConversationGraph,
  branchId: string
): WorkspaceCheckpointBinding => {
  assertActiveMessageBranch(graph, branchId)
  const activeFrame = graph.frames.find((frame) => frame.id === graph.activeFrameId)!
  const branch = graph.branches.find((candidate) => candidate.id === branchId)
  if (!branch || branch.agentFrameId !== activeFrame.id) {
    throw new Error(`Conversation branch not found: ${branchId}`)
  }
  const revision = sha256(
    JSON.stringify([
      branch.id,
      branch.agentFrameId,
      branch.parentBranchId ?? null,
      branch.forkMessageId ?? null,
      branch.forkActivityId ?? null,
      branch.supersededMessageId ?? null,
      branch.headMessageId ?? null,
      branch.updatedAt
    ])
  )
  return {
    branchId: branch.id,
    agentFrameId: branch.agentFrameId,
    ...(branch.headMessageId ? { headMessageId: branch.headMessageId } : {}),
    branchUpdatedAt: branch.updatedAt,
    revision
  }
}

const bindCheckpoint = (
  graph: PersistedConversationGraph,
  branchId: string,
  checkpointId: string
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const branch = next.branches.find((candidate) => candidate.id === branchId)
  if (!branch) throw new Error(`Conversation branch not found: ${branchId}`)
  branch.workspaceCheckpointId = checkpointId
  return next
}

const blobPath = (blobRoot: string, checksum: string): string => {
  if (!CHECKSUM_PATTERN.test(checksum)) throw new Error('Invalid workspace checkpoint checksum.')
  return join(blobRoot, checksum.slice(0, 2), checksum)
}

const blobLocks = new Map<string, Promise<void>>()

const withBlobLock = async <Result>(
  destination: string,
  operation: () => Promise<Result>
): Promise<Result> => {
  const previous = blobLocks.get(destination) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  blobLocks.set(destination, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (blobLocks.get(destination) === tail) blobLocks.delete(destination)
  }
}

const publishBlob = async (
  source: string,
  destination: string,
  sizeBytes: number,
  checksum: string
): Promise<void> =>
  withBlobLock(destination, async () => {
    try {
      const existing = await stat(destination)
      if (
        existing.isFile() &&
        existing.size === sizeBytes &&
        (await sha256File(destination)) === checksum
      ) {
        return
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await copyFile(source, temporary)
      if (
        (await stat(temporary)).size !== sizeBytes ||
        (await sha256File(temporary)) !== checksum
      ) {
        throw new Error('Workspace checkpoint blob publication did not match its source.')
      }
      await rm(destination, { force: true })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  })

type WorkspaceInspection = Readonly<{
  kind: 'file' | 'reference'
  path: string
  absolutePath: string
  sizeBytes: number
  mtimeMs: number
  ctimeMs: number
}>

const inspectWorkspace = async (
  workspaceRoot: string
): Promise<Map<string, WorkspaceInspection>> => {
  const canonicalRoot = resolve(workspaceRoot)
  const rootInfo = await lstat(canonicalRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Workspace checkpoint root must be a regular directory.')
  }
  const entries = new Map<string, WorkspaceInspection>()
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const absolutePath = join(directory, child.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        throw new Error(`Workspace checkpoint does not follow symbolic links: ${absolutePath}`)
      }
      if (info.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`Workspace checkpoint only supports regular files: ${absolutePath}`)
      }
      const relativePath = toPosixPath(relative(canonicalRoot, absolutePath))
      entries.set(relativePath, {
        kind: 'file',
        path: relativePath,
        absolutePath,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      })
    }
  }
  await visit(canonicalRoot)
  return entries
}

const buildRestorePreview = async (
  checkpoint: WorkspaceCheckpointManifest,
  workspaceRoot: string
): Promise<WorkspaceCheckpointRestorePreview> => {
  const current = await inspectWorkspace(workspaceRoot)
  const entries = await diffCheckpoint(checkpoint.entries, current)
  const previewToken = sha256(
    JSON.stringify({ checkpointId: checkpoint.id, entries, current: [...current.entries()].sort() })
  )
  return {
    checkpointId: checkpoint.id,
    sessionId: checkpoint.sessionId,
    branchId: checkpoint.binding.branchId,
    entries,
    previewToken,
    restoreable: entries.every((entry) => entry.change !== 'reference-changed')
  }
}

const resolveWorkspaceEntryPath = (workspaceRoot: string, entryPath: string): string => {
  if (
    !entryPath ||
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    entryPath === '..' ||
    entryPath.startsWith('../') ||
    entryPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Workspace checkpoint entry path is invalid: ${entryPath}`)
  }
  const target = resolve(workspaceRoot, ...entryPath.split('/'))
  if (!pathInside(workspaceRoot, target)) {
    throw new Error(`Workspace checkpoint entry escapes its containment root: ${entryPath}`)
  }
  return target
}

const validateCheckpointBlobs = async (
  checkpointRoot: string,
  checkpoint: WorkspaceCheckpointManifest
): Promise<void> => {
  for (const entry of checkpoint.entries) {
    if (entry.kind === 'reference') continue
    const source = blobPath(join(checkpointRoot, 'content', 'blobs'), entry.checksum)
    let sourceInfo
    try {
      sourceInfo = await stat(source)
    } catch (error) {
      if (isMissing(error)) throw new Error(`Workspace checkpoint blob is missing: ${entry.path}`)
      throw error
    }
    if (
      !sourceInfo.isFile() ||
      sourceInfo.size !== entry.sizeBytes ||
      (await sha256File(source)) !== entry.checksum
    ) {
      throw new Error(`Workspace checkpoint blob is invalid: ${entry.path}`)
    }
  }
}

const diffCheckpoint = async (
  target: readonly WorkspaceCheckpointEntry[],
  current: ReadonlyMap<string, WorkspaceInspection>
): Promise<WorkspaceCheckpointPreviewEntry[]> => {
  const targetPaths = new Set(target.map((entry) => entry.path))
  const changes: WorkspaceCheckpointPreviewEntry[] = []
  for (const entry of target) {
    const currentEntry = current.get(entry.path)
    if (!currentEntry) {
      changes.push({
        path: entry.path,
        kind: entry.kind,
        change: entry.kind === 'reference' ? 'reference-changed' : 'add'
      })
      continue
    }
    if (entry.kind === 'reference') {
      changes.push({
        path: entry.path,
        kind: 'reference',
        change:
          currentEntry.sizeBytes === entry.sizeBytes &&
          currentEntry.mtimeMs === entry.mtimeMs &&
          currentEntry.ctimeMs === entry.ctimeMs
            ? 'reference'
            : 'reference-changed'
      })
      continue
    }
    const checksum = await sha256File(currentEntry.absolutePath)
    changes.push({
      path: entry.path,
      kind: 'file',
      change:
        currentEntry.sizeBytes === entry.sizeBytes && checksum === entry.checksum
          ? 'unchanged'
          : 'modify'
    })
  }
  for (const path of current.keys()) {
    if (!targetPaths.has(path)) changes.push({ path, kind: 'file', change: 'delete' })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

const collectEntries = async (
  workspaceRoot: string,
  blobRoot: string,
  maxBlobBytes: number
): Promise<WorkspaceCheckpointEntry[]> => {
  const canonicalRoot = resolve(workspaceRoot)
  const rootInfo = await lstat(canonicalRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Workspace checkpoint root must be a regular directory.')
  }
  const entries: WorkspaceCheckpointEntry[] = []
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const absolutePath = join(directory, child.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        throw new Error(`Workspace checkpoint does not follow symbolic links: ${absolutePath}`)
      }
      if (info.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`Workspace checkpoint only supports regular files: ${absolutePath}`)
      }
      const relativePath = toPosixPath(relative(canonicalRoot, absolutePath))
      if (
        !relativePath ||
        relativePath.startsWith('/') ||
        relativePath === '..' ||
        relativePath.startsWith('../')
      ) {
        throw new Error(`Workspace checkpoint path escapes its containment root: ${absolutePath}`)
      }
      if (info.size > maxBlobBytes) {
        entries.push({
          kind: 'reference',
          path: relativePath,
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs
        })
        continue
      }
      const checksum = await sha256File(absolutePath)
      const destination = blobPath(blobRoot, checksum)
      await publishBlob(absolutePath, destination, info.size, checksum)
      entries.push({
        kind: 'file',
        path: relativePath,
        contentId: `sha256:${checksum}:${info.size}`,
        checksum,
        sizeBytes: info.size
      })
    }
  }
  await visit(canonicalRoot)
  return entries
}

const restoreJournalPath = (checkpointRoot: string, sessionId: string, id: string): string =>
  join(checkpointRoot, 'restores', sha256(sessionId), `${id}.json`)

const decodeRestoreJournal = (contents: string): WorkspaceCheckpointRestoreJournal => {
  const value = JSON.parse(contents) as Partial<WorkspaceCheckpointRestoreJournal>
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !CHECKPOINT_ID_PATTERN.test(value.id) ||
    typeof value.checkpointId !== 'string' ||
    !CHECKPOINT_ID_PATTERN.test(value.checkpointId) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.workspaceRoot !== 'string' ||
    !value.workspaceRoot ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    throw new Error('Workspace checkpoint restore journal is invalid.')
  }
  return value as WorkspaceCheckpointRestoreJournal
}

const loadCheckpointById = async (
  checkpointRoot: string,
  sessionId: string,
  checkpointId: string
): Promise<WorkspaceCheckpointManifest> => {
  if (!CHECKPOINT_ID_PATTERN.test(checkpointId)) {
    throw new Error('Workspace checkpoint identity is invalid.')
  }
  const path = join(checkpointRoot, 'manifests', sha256(sessionId), `${checkpointId}.json`)
  const checkpoint = JSON.parse(await readFile(path, 'utf8')) as WorkspaceCheckpointManifest
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.id !== checkpointId ||
    checkpoint.sessionId !== sessionId
  ) {
    throw new Error('Workspace checkpoint manifest is invalid.')
  }
  return checkpoint
}

const assertReferenceState = async (
  checkpoint: WorkspaceCheckpointManifest,
  workspaceRoot: string
): Promise<void> => {
  for (const entry of checkpoint.entries) {
    if (entry.kind !== 'reference') continue
    const path = resolveWorkspaceEntryPath(workspaceRoot, entry.path)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`Workspace checkpoint referenced file is missing: ${entry.path}`)
      }
      throw error
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== entry.sizeBytes ||
      info.mtimeMs !== entry.mtimeMs ||
      info.ctimeMs !== entry.ctimeMs
    ) {
      throw new Error(`Workspace checkpoint referenced file changed: ${entry.path}`)
    }
  }
}

const ensureWorkspaceDirectory = async (
  workspaceRoot: string,
  directory: string
): Promise<void> => {
  const root = resolve(workspaceRoot)
  const candidate = resolve(directory)
  if (!pathInside(root, candidate)) {
    throw new Error('Workspace checkpoint directory escapes its containment root.')
  }
  const relativeDirectory = relative(root, candidate)
  if (!relativeDirectory) return
  let current = root
  for (const segment of relativeDirectory.split(sep)) {
    current = join(current, segment)
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (info?.isDirectory() && !info.isSymbolicLink()) continue
    if (info) {
      await rm(current, { force: true, recursive: info.isDirectory() })
    }
    await mkdir(current)
  }
}

const applyCheckpoint = async (
  checkpointRoot: string,
  checkpoint: WorkspaceCheckpointManifest,
  workspaceRoot: string,
  hooks: WorkspaceCheckpointRestoreHooks
): Promise<void> => {
  await validateCheckpointBlobs(checkpointRoot, checkpoint)
  await assertReferenceState(checkpoint, workspaceRoot)
  const before = await inspectWorkspace(workspaceRoot)
  for (const entry of checkpoint.entries) {
    if (entry.kind === 'reference') continue
    const destination = resolveWorkspaceEntryPath(workspaceRoot, entry.path)
    const current = before.get(entry.path)
    if (
      current?.sizeBytes === entry.sizeBytes &&
      (await sha256File(destination)) === entry.checksum
    ) {
      continue
    }
    await ensureWorkspaceDirectory(workspaceRoot, dirname(destination))
    const source = blobPath(join(checkpointRoot, 'content', 'blobs'), entry.checksum)
    const temporary = `${destination}.workspace-checkpoint-${randomUUID()}.tmp`
    try {
      await copyFile(source, temporary)
      if (
        (await stat(temporary)).size !== entry.sizeBytes ||
        (await sha256File(temporary)) !== entry.checksum
      ) {
        throw new Error(`Workspace checkpoint blob does not match its manifest: ${entry.path}`)
      }
      const destinationInfo = await lstat(destination).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      await rm(destination, { force: true, recursive: destinationInfo?.isDirectory() === true })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    await hooks.afterMutation?.({ checkpointId: checkpoint.id, path: entry.path })
  }
  const targetPaths = new Set(checkpoint.entries.map((entry) => entry.path))
  const current = await inspectWorkspace(workspaceRoot)
  for (const path of current.keys()) {
    if (targetPaths.has(path)) continue
    await rm(resolveWorkspaceEntryPath(workspaceRoot, path), { force: true })
    await hooks.afterMutation?.({ checkpointId: checkpoint.id, path })
  }
}

class WorkspaceCheckpointOwner {
  private checkpointRoot: string
  private readonly maxBlobBytes: number
  private readonly now: () => number
  private readonly restoreHooks: WorkspaceCheckpointRestoreHooks
  private readonly checkpointLocks = new Map<string, Promise<unknown>>()

  constructor(options: WorkspaceCheckpointOwnerOptions) {
    this.checkpointRoot = resolve(options.checkpointRoot)
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes < 0) {
      throw new Error('Workspace checkpoint blob limit must be a non-negative safe integer.')
    }
    this.now = options.now ?? Date.now
    this.restoreHooks = options.restoreHooks ?? {}
  }

  private async assertWorkspaceSeparation(workspaceRoot: string): Promise<void> {
    const canonicalWorkspaceRoot = await canonicalizePotentialPath(workspaceRoot)
    const canonicalCheckpointRoot = await canonicalizePotentialPath(this.checkpointRoot)
    if (pathInside(canonicalWorkspaceRoot, canonicalCheckpointRoot)) {
      throw new Error(
        'Workspace checkpoint storage must be outside the workspace containment root.'
      )
    }
    this.checkpointRoot = canonicalCheckpointRoot
  }

  private async withLock<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.checkpointLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.checkpointLocks.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.checkpointLocks.get(key) === tail) this.checkpointLocks.delete(key)
    }
  }

  async recoverPendingRestores(): Promise<void> {
    const restoresRoot = join(this.checkpointRoot, 'restores')
    let sessionDirectories: DirectoryEntry[]
    try {
      sessionDirectories = await readdir(restoresRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const sessionDirectory of sessionDirectories) {
      if (!sessionDirectory.isDirectory()) continue
      const directory = join(restoresRoot, sessionDirectory.name)
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const journalPath = join(directory, entry.name)
        const journal = await readDurableJsonFile(journalPath, decodeRestoreJournal)
        if (journal.status === 'missing') continue
        await this.recoverJournal(journal.value)
      }
    }
  }

  private async recoverJournalsForSession(sessionId: string, workspaceRoot: string): Promise<void> {
    const directory = join(this.checkpointRoot, 'restores', sha256(sessionId))
    let entries: DirectoryEntry[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const journalPath = join(directory, entry.name)
      const journal = await readDurableJsonFile(journalPath, decodeRestoreJournal)
      if (journal.status === 'missing') continue
      if (resolve(journal.value.workspaceRoot) !== resolve(workspaceRoot)) continue
      await this.recoverJournalLocked(journal.value)
    }
  }

  private async recoverJournal(journal: WorkspaceCheckpointRestoreJournal): Promise<void> {
    const workspaceRoot = resolve(journal.workspaceRoot)
    await this.withLock(workspaceRoot, () => this.recoverJournalLocked(journal))
  }

  private async recoverJournalLocked(journal: WorkspaceCheckpointRestoreJournal): Promise<void> {
    const workspaceRoot = resolve(journal.workspaceRoot)
    await this.assertWorkspaceSeparation(workspaceRoot)
    const checkpoint = await loadCheckpointById(
      this.checkpointRoot,
      journal.sessionId,
      journal.checkpointId
    )
    await applyCheckpoint(this.checkpointRoot, checkpoint, workspaceRoot, this.restoreHooks)
    await rm(restoreJournalPath(this.checkpointRoot, journal.sessionId, journal.id), {
      force: true
    })
  }

  async checkpointTurnBoundary(
    request: WorkspaceCheckpointCaptureRequest
  ): Promise<WorkspaceCheckpointCaptureResult> {
    return this.capture({ ...request, trigger: 'turn-boundary' })
  }

  async checkpointExplicitly(
    request: WorkspaceCheckpointCaptureRequest
  ): Promise<WorkspaceCheckpointCaptureResult> {
    return this.capture({ ...request, trigger: 'explicit' })
  }

  async previewRestore(
    request: WorkspaceCheckpointCaptureRequest
  ): Promise<WorkspaceCheckpointRestorePreview> {
    const workspaceRoot = resolve(request.workspaceRoot)
    await this.assertWorkspaceSeparation(workspaceRoot)
    return this.withLock(workspaceRoot, async () => {
      await this.recoverJournalsForSession(request.sessionId, workspaceRoot)
      const checkpoint = await this.loadBoundCheckpoint(request)
      return buildRestorePreview(checkpoint, workspaceRoot)
    })
  }

  async restore(
    request: WorkspaceCheckpointRestoreRequest
  ): Promise<WorkspaceCheckpointRestoreResult> {
    if (request.confirm !== true) {
      throw new Error('Workspace checkpoint restore requires explicit confirmation.')
    }
    const workspaceRoot = resolve(request.workspaceRoot)
    await this.assertWorkspaceSeparation(workspaceRoot)
    return this.withLock(workspaceRoot, async () => {
      await this.recoverJournalsForSession(request.sessionId, workspaceRoot)
      const checkpoint = await this.loadBoundCheckpoint(request)
      assertActiveMessageBranch(request.graph, request.branchId)
      const preview = await buildRestorePreview(checkpoint, workspaceRoot)
      if (preview.previewToken !== request.previewToken) {
        throw new Error('Workspace preview is stale; preview the restore again.')
      }
      if (!preview.restoreable) {
        throw new Error('Workspace checkpoint has unavailable referenced files.')
      }
      await validateCheckpointBlobs(this.checkpointRoot, checkpoint)
      await assertReferenceState(checkpoint, workspaceRoot)
      const journal: WorkspaceCheckpointRestoreJournal = {
        version: 1,
        id: randomUUID(),
        checkpointId: checkpoint.id,
        sessionId: checkpoint.sessionId,
        workspaceRoot,
        createdAt: this.now()
      }
      const journalPath = restoreJournalPath(this.checkpointRoot, checkpoint.sessionId, journal.id)
      await mkdir(dirname(journalPath), { recursive: true })
      await writeDurableJsonFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
      await applyCheckpoint(this.checkpointRoot, checkpoint, workspaceRoot, this.restoreHooks)
      await rm(journalPath, { force: true })
      return { checkpointId: checkpoint.id, restored: true }
    })
  }

  private async loadBoundCheckpoint(
    request: WorkspaceCheckpointCaptureRequest
  ): Promise<WorkspaceCheckpointManifest> {
    const branch = request.graph.branches.find((candidate) => candidate.id === request.branchId)
    if (!branch) throw new Error(`Conversation branch not found: ${request.branchId}`)
    const checkpointId = branch?.workspaceCheckpointId
    if (!checkpointId || !CHECKPOINT_ID_PATTERN.test(checkpointId)) {
      throw new Error('Workspace checkpoint is not bound to the Message Branch.')
    }
    const manifestPath = join(
      this.checkpointRoot,
      'manifests',
      sha256(request.sessionId),
      `${checkpointId}.json`
    )
    const checkpoint = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as WorkspaceCheckpointManifest
    if (
      checkpoint.version !== CHECKPOINT_VERSION ||
      checkpoint.id !== checkpointId ||
      checkpoint.sessionId !== request.sessionId ||
      checkpoint.binding.branchId !== branch.id ||
      checkpoint.binding.agentFrameId !== branch.agentFrameId
    ) {
      throw new Error('Workspace checkpoint binding is stale or invalid.')
    }
    return checkpoint
  }

  private async capture(
    request: WorkspaceCheckpointCaptureRequest & { trigger: WorkspaceCheckpointTrigger }
  ): Promise<WorkspaceCheckpointCaptureResult> {
    const workspaceRoot = resolve(request.workspaceRoot)
    await this.assertWorkspaceSeparation(workspaceRoot)
    return this.withLock(workspaceRoot, async () => {
      await this.recoverJournalsForSession(request.sessionId, workspaceRoot)
      const binding = assertBranchBinding(request.graph, request.branchId)
      const entries = await collectEntries(
        workspaceRoot,
        join(this.checkpointRoot, 'content', 'blobs'),
        this.maxBlobBytes
      )
      const checkpoint: WorkspaceCheckpointManifest = {
        version: CHECKPOINT_VERSION,
        id: randomUUID(),
        sessionId: request.sessionId,
        trigger: request.trigger,
        createdAt: this.now(),
        binding,
        entries
      }
      const manifestPath = join(
        this.checkpointRoot,
        'manifests',
        sha256(request.sessionId),
        `${checkpoint.id}.json`
      )
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeDurableJsonFile(manifestPath, `${JSON.stringify(checkpoint, null, 2)}\n`)
      return { checkpoint, graph: bindCheckpoint(request.graph, request.branchId, checkpoint.id) }
    })
  }
}

export {
  CHECKPOINT_VERSION,
  WorkspaceCheckpointOwner,
  type WorkspaceCheckpointBinding,
  type WorkspaceCheckpointCaptureRequest,
  type WorkspaceCheckpointCaptureResult,
  type WorkspaceCheckpointEntry,
  type WorkspaceCheckpointFileEntry,
  type WorkspaceCheckpointManifest,
  type WorkspaceCheckpointOwnerOptions,
  type WorkspaceCheckpointReferenceEntry,
  type WorkspaceCheckpointRestoreHooks,
  type WorkspaceCheckpointRestoreMutation,
  type WorkspaceCheckpointRestorePreview,
  type WorkspaceCheckpointRestoreRequest,
  type WorkspaceCheckpointRestoreResult,
  type WorkspaceCheckpointTrigger
}
