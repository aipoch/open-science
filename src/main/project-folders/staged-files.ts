import { isProjectInternalRecordPath } from '../../shared/project-internal-records'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { defaultFileDurability, writeDurableJsonFile } from '@aipoch/durable-files'
import type {
  ProjectFolderChange,
  ProjectFolderChangeApproval,
  ProjectFolderChangeScope,
  ProjectFolderChangePage,
  ProjectFolderChangePreview,
  ProjectFolderFilePreview
} from '../../shared/project-folder-changes'
import { bindStorageRoot, type StorageRootBinding } from '../storage/root-binding'

export class ProjectFolderConflictError extends Error {
  constructor(readonly relativePath: string) {
    super(`Project folder file changed while preparing or reviewing changes: ${relativePath}`)
    this.name = 'ProjectFolderConflictError'
  }
}

type FileVersion = {
  checksum: string
  size: number
  identity: string
  links: number
  mode: number
  ctimeMs: number
}
export type ProjectFolderDeliveryBaseline = {
  checksum: string
  size: number
  identity: string
  rootIdentity: string
}
type CreatedFileRecord = Pick<
  ProjectFolderDeliveryBaseline,
  'rootIdentity' | 'identity' | 'checksum'
>

type Receipt = {
  version: 1
  createdAt?: number
  updatedAt?: number
  change: ProjectFolderChange
  root: string
  rootIdentity: string
  originalIdentity?: string
  originalMode?: number
  originalCtimeMs?: number
  originalCreatedFile?: 'verified' | 'unverified'
  artifactDelivery?: true
  appliedIdentity?: string
  appliedCtimeMs?: number
  commitState?: 'applying' | 'reverting'
}
type StagedInput = { path: string; version: FileVersion }
export type ProjectFolderStage = Readonly<{
  projectId: string
  sessionId: string
  runId: string
  folder: string
  directory: string
  inputs: readonly StagedInput[]
}>

type Options = {
  storageRoot: string
  onChanged?: (scope: ProjectFolderChangeScope) => void
  // Original files always require this callback, independently of the general permission profile.
  approve: ProjectFolderChangeApproval
  authorizeCreatedFile: ProjectFolderChangeApproval
}

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code
const identity = (info: Awaited<ReturnType<typeof stat>>): string =>
  `${info.dev}:${info.ino}:${info.birthtimeMs}`
const inside = (root: string, path: string): boolean => {
  for (let current = path; ; current = dirname(current)) {
    if (current === root) return true
    if (dirname(current) === current) return false
  }
}
const safeId = (id: string): string => {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Project folder scope identity.')
  return id
}
const safeRelative = (path: string, writing = true): string => {
  const parts = path.split(process.platform === 'win32' ? /[\\/]/ : /\//)
  if (
    isProjectInternalRecordPath(path) ||
    isAbsolute(path) ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || (writing && part.toLowerCase() === '.git')
    ) ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    (process.platform === 'win32' && parts.some((part) => /[:*?"<>|]|[. ]$/.test(part)))
  )
    throw new Error('Project folder path must be a safe relative file path.')
  return parts.join(sep)
}

function textPage(buffer: Buffer): { text: string; binary: boolean; bytes: number } {
  if (buffer.includes(0)) return { text: '', binary: true, bytes: buffer.length }
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim++) {
    const bytes = buffer.length - trim
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)),
        binary: false,
        bytes
      }
    } catch {
      /* A page may end partway through a multibyte character. */
    }
  }
  return { text: '', binary: true, bytes: buffer.length }
}

async function fileVersion(path: string): Promise<FileVersion | undefined> {
  let before: Awaited<ReturnType<typeof stat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('Project folder change must target a regular file.')
  const hash = createHash('sha256')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (identity(await handle.stat()) !== identity(before))
      throw new ProjectFolderConflictError(path)
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
  } finally {
    await handle.close()
  }
  const after = await lstat(path)
  if (
    identity(before) !== identity(after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new ProjectFolderConflictError(path)
  return {
    checksum: hash.digest('hex'),
    size: after.size,
    identity: identity(after),
    links: after.nlink,
    mode: after.mode & 0o7777,
    ctimeMs: after.ctimeMs
  }
}

async function safePath(
  root: string,
  relativePath: string,
  createParents = false,
  allowMissingParents = false
): Promise<string> {
  const parts = safeRelative(relativePath).split(sep)
  let current = root
  for (const segment of parts.slice(0, -1)) {
    current = join(current, segment)
    if (createParents)
      await mkdir(current).catch((error: unknown) => {
        if (!hasCode(error, 'EEXIST')) throw error
      })
    const metadata = await lstat(current).catch((error: unknown) => {
      if (allowMissingParents && hasCode(error, 'ENOENT')) return undefined
      throw error
    })
    if (!metadata) return join(root, ...parts)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('Project folder parent path is unsafe.')
  }
  const result = join(current, parts.at(-1)!)
  const parent = await realpath(current)
  if (!inside(root, parent)) throw new Error('Project folder path escapes its root.')
  return result
}

// Copy, verify and sync independently: hardlinks are never used for inputs, candidates or backups.
async function durableCopy(
  source: string,
  destination: string,
  expected: string,
  preserveMetadata = false
): Promise<void> {
  const reserved = await open(destination, 'wx', 0o600)
  await reserved.close()
  try {
    if (preserveMetadata && process.platform !== 'win32') {
      await promisify(execFile)('/bin/cp', ['-p', source, destination])
    } else await copyFile(source, destination)
    if (preserveMetadata && process.platform === 'win32') {
      await promisify(execFile)(
        resolveWindowsPowerShellExecutable(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ErrorActionPreference="Stop"; Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); $acl=Get-Acl -LiteralPath $env:OPEN_SCIENCE_ACL_SOURCE; Set-Acl -LiteralPath $env:OPEN_SCIENCE_ACL_TARGET -AclObject $acl; if ((Get-Acl -LiteralPath $env:OPEN_SCIENCE_ACL_TARGET).Sddl -ne $acl.Sddl) { throw "File access control could not be preserved" }'
        ],
        {
          env: {
            ...process.env,
            OPEN_SCIENCE_ACL_SOURCE: source,
            OPEN_SCIENCE_ACL_TARGET: destination
          },
          windowsHide: true
        }
      )
    }
    await chmod(destination, 0o600)
    const copied = await fileVersion(destination)
    if (copied?.checksum !== expected) throw new ProjectFolderConflictError(source)
    await defaultFileDurability.syncFile(destination)
    await defaultFileDurability.syncDirectory(dirname(destination))
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
}

export class ProjectFolderStagedFiles {
  private lastReceiptTime = 0
  private readonly storage: StorageRootBinding
  private readonly history: StorageRootBinding
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly stages = new WeakMap<
    ProjectFolderStage,
    { folder: StorageRootBinding; directory: StorageRootBinding; preparation?: StorageRootBinding }
  >()
  constructor(private readonly options: Options) {
    this.storage = bindStorageRoot(options.storageRoot)
    this.history = bindStorageRoot(join(this.storage.path, 'project-folder-history'))
  }

  private scopeRoot(scope: ProjectFolderChangeScope): string {
    return join(
      this.storage.path,
      'project-folder-history',
      'changes',
      safeId(scope.projectId),
      safeId(scope.sessionId)
    )
  }
  private receiptRoot(scope: ProjectFolderChangeScope, id: string): string {
    return join(this.scopeRoot(scope), safeId(id))
  }
  private async ensureScope(scope: ProjectFolderChangeScope): Promise<void> {
    await this.storage.verify()
    await this.history.prepare((path) => mkdir(path, { mode: 0o700 }))
    await chmod(this.history.path, 0o700)
    await safePath(
      this.history.path,
      join('changes', safeId(scope.projectId), safeId(scope.sessionId), 'placeholder'),
      true
    )
  }
  private receiptRelative(scope: ProjectFolderChangeScope, id: string): string {
    return join(
      'changes',
      safeId(scope.projectId),
      safeId(scope.sessionId),
      safeId(id),
      'receipt.json'
    )
  }
  private async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(projectId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation)
    this.queues.set(projectId, pending)
    try {
      return await pending
    } finally {
      if (this.queues.get(projectId) === pending) this.queues.delete(projectId)
    }
  }
  private async writeReceipt(scope: ProjectFolderChangeScope, receipt: Receipt): Promise<void> {
    await this.ensureScope(scope)
    this.lastReceiptTime = Math.max(
      Date.now(),
      this.lastReceiptTime + 1,
      (receipt.updatedAt ?? 0) + 1
    )
    receipt.createdAt ??= this.lastReceiptTime
    receipt.updatedAt = this.lastReceiptTime
    const receiptPath = await safePath(
      this.history.path,
      this.receiptRelative(scope, receipt.change.id),
      true
    )
    await writeDurableJsonFile(receiptPath, `${JSON.stringify(receipt)}\n`)
    try {
      this.options.onChanged?.({ projectId: scope.projectId, sessionId: scope.sessionId })
    } catch (error) {
      createLogger('project-folders').warn(
        'Project folder change notification failed',
        diagnosticErrorFields(error)
      )
    }
  }
  private async readReceipt(scope: ProjectFolderChangeScope, id: string): Promise<Receipt> {
    await this.storage.verify()
    await this.history.verify()
    const path = await safePath(this.history.path, this.receiptRelative(scope, id))
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
      throw new Error('Project folder receipt is unsafe.')
    const receipt: Receipt = JSON.parse(await readFile(path, 'utf8'))
    if (
      receipt.version !== 1 ||
      receipt.change.id !== id ||
      receipt.change.projectId !== scope.projectId ||
      receipt.change.sessionId !== scope.sessionId
    )
      throw new Error('Project folder change does not belong to this scope.')
    safeRelative(receipt.change.relativePath)
    return receipt
  }

  private createdFileRecordPath(scope: ProjectFolderChangeScope, relativePath: string): string {
    return join(
      'created',
      safeId(scope.projectId),
      createHash('sha256').update(relativePath).digest('hex') + '.json'
    )
  }

  private async readCreatedFile(
    scope: ProjectFolderChangeScope,
    relativePath: string
  ): Promise<Partial<CreatedFileRecord> | undefined> {
    try {
      const path = await safePath(
        this.history.path,
        this.createdFileRecordPath(scope, relativePath),
        false,
        true
      )
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
        return undefined
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      // Missing or unreadable proof requires review for ordinary writes and deletes.
      if (!hasCode(error, 'ENOENT'))
        createLogger('project-folders').warn(
          'Project folder created file proof could not be read',
          diagnosticErrorFields(error)
        )
      return undefined
    }
  }

  private async rememberCreatedFile(
    scope: ProjectFolderChangeScope,
    receipt: Receipt,
    fileIdentity: string,
    checksum: string
  ): Promise<void> {
    try {
      const path = await safePath(
        this.history.path,
        this.createdFileRecordPath(scope, receipt.change.relativePath),
        true
      )
      const record: CreatedFileRecord = {
        rootIdentity: receipt.rootIdentity,
        identity: fileIdentity,
        checksum
      }
      await writeDurableJsonFile(path, JSON.stringify(record))
    } catch (error) {
      // The mutation and its receipt are already durable. Missing proof requires review next time.
      createLogger('project-folders').warn(
        'Project folder created file proof could not be saved',
        diagnosticErrorFields(error)
      )
    }
  }

  async describeInputs(
    folder: string,
    cwd: string,
    paths: readonly string[]
  ): Promise<import('../../shared/project-folder-changes').ProjectFolderRunInput[]> {
    const root = await realpath(folder)
    const inputs: import('../../shared/project-folder-changes').ProjectFolderRunInput[] = []
    for (const path of [...new Set(paths)].slice(0, 10_000)) {
      try {
        const target = await realpath(resolve(cwd, path))
        if (!inside(root, target) || isProjectInternalRecordPath(relative(root, target))) continue
        const metadata = await stat(target)
        if (metadata.isFile())
          inputs.push({
            relativePath: relative(root, target).split(sep).join('/'),
            sizeBytes: metadata.size,
            frozen: false
          })
      } catch {
        /* Unavailable or dynamic inputs do not prevent ordinary code execution. */
      }
    }
    return inputs
  }

  async stageForRun(
    input: ProjectFolderChangeScope & {
      runId: string
      folder: string
      directory: string
      paths: readonly string[]
      outputs?: readonly string[]
      relativeCwd?: string
    }
  ): Promise<ProjectFolderStage> {
    await this.storage.verify()
    const base = await realpath(input.directory)
    if (!inside(this.storage.path, base))
      throw new Error('Project preparation must remain in managed storage.')
    const relativePath = join(
      '.project-preparations',
      `${safeId(input.runId)}-${randomUUID()}`,
      'data',
      'placeholder'
    )
    const placeholder = await safePath(base, relativePath, true)
    const preparation = bindStorageRoot(dirname(dirname(placeholder)))
    try {
      const stage = await this.stage({ ...input, directory: dirname(placeholder) })
      this.stages.get(stage)!.preparation = preparation
      if (input.relativeCwd) {
        const cwd = await safePath(stage.folder, input.relativeCwd)
        if (!(await lstat(cwd)).isDirectory())
          throw new Error('Project working directory is unsafe.')
        await safePath(stage.directory, join(input.relativeCwd, 'placeholder'), true)
      }
      for (const output of input.outputs ?? []) {
        const parent = dirname(safeRelative(output))
        if (parent === '.') continue
        const sourceParent = await realpath(join(stage.folder, parent)).catch((error: unknown) => {
          if (hasCode(error, 'ENOENT')) return undefined
          throw error
        })
        if (!sourceParent) continue
        if (!inside(stage.folder, sourceParent) || !(await stat(sourceParent)).isDirectory())
          throw new Error('Project output parent is unsafe.')
        await safePath(stage.directory, output, true)
      }
      return stage
    } catch (error) {
      await preparation.verify()
      await rm(preparation.path, { recursive: true, force: true })
      throw error
    }
  }

  async releaseStage(stage: ProjectFolderStage): Promise<void> {
    const preparation = this.stages.get(stage)?.preparation
    if (!preparation) return
    await this.storage.verify()
    await preparation.verify()
    await rm(preparation.path, { recursive: true, force: true })
    this.stages.delete(stage)
  }

  async stage(
    input: ProjectFolderChangeScope & {
      runId: string
      folder: string
      directory: string
      paths: readonly string[]
    }
  ): Promise<ProjectFolderStage> {
    await this.storage.verify()
    const folder = await realpath(input.folder)
    const directory = await realpath(input.directory)
    if (
      !inside(this.storage.path, directory) ||
      inside(this.storage.path, folder) ||
      inside(folder, this.storage.path)
    )
      throw new Error('Project folder staging requires separate user and managed directories.')
    const folderBinding = bindStorageRoot(folder)
    const stageBinding = bindStorageRoot(directory)
    const manifestRoot = this.scopeRoot(input)
    await this.ensureScope(input)
    const manifestPath = join(manifestRoot, 'inputs.json')
    const previous: Array<{ path: string; folder: string; directory: string; checksum: string }> =
      await readFile(manifestPath, 'utf8').then(
        (text) => JSON.parse(text),
        (error: unknown) => {
          if (hasCode(error, 'ENOENT')) return []
          throw error
        }
      )
    const next = previous.slice()
    const inputs: StagedInput[] = []
    for (const path of new Set(input.paths)) {
      await folderBinding.verify()
      await stageBinding.verify()
      const source = await safePath(folder, path)
      const version = await fileVersion(source)
      if (!version) throw new Error(`Project folder input does not exist: ${path}`)
      const destination = await safePath(directory, path, true)
      const existing = await fileVersion(destination)
      if (existing && (existing.identity === version.identity || existing.links > 1))
        throw new Error('Project folder staging must not share a mutable file identity.')
      const prior = previous.find(
        (entry) => entry.path === path && entry.folder === folder && entry.directory === directory
      )
      if (existing && !prior && existing.checksum !== version.checksum)
        throw new ProjectFolderConflictError(path)
      if (existing && prior && prior.checksum !== version.checksum) {
        // Preserve uncommitted candidate work; a source refresh cannot silently erase it.
        if (existing.checksum !== prior.checksum) throw new ProjectFolderConflictError(path)
        const temporary = join(dirname(destination), `.open-science-${randomUUID()}.tmp`)
        await durableCopy(source, temporary, version.checksum)
        await stageBinding.verify()
        await safePath(directory, path)
        if ((await fileVersion(destination))?.checksum !== existing.checksum)
          throw new ProjectFolderConflictError(path)
        await rename(temporary, destination)
        await defaultFileDurability.syncDirectory(dirname(destination))
      } else if (!existing) await durableCopy(source, destination, version.checksum)
      const index = next.findIndex((entry) => entry.path === path)
      const record = { path, folder, directory, checksum: version.checksum }
      if (index < 0) next.push(record)
      else next[index] = record
      if ((await fileVersion(source))?.checksum !== version.checksum)
        throw new ProjectFolderConflictError(path)
      inputs.push({ path, version })
    }
    await this.storage.verify()
    await writeDurableJsonFile(manifestPath, JSON.stringify(next))
    const stage: ProjectFolderStage = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      folder,
      directory,
      inputs
    }
    this.stages.set(stage, { folder: folderBinding, directory: stageBinding })
    return stage
  }

  async prepareMutation(
    input: ProjectFolderChangeScope & {
      runId: string
      folder: string
      relativePath: string
      operation: 'write' | 'delete'
      content?: Uint8Array
      copyContent?: (destination: string) => Promise<void>
      replacementBaseline?: ProjectFolderDeliveryBaseline | null
    }
  ): Promise<ProjectFolderChange | undefined> {
    const relativePath = safeRelative(input.relativePath)
    const requestId = randomUUID()
    const directory = join(this.scopeRoot(input), 'requests', requestId, 'data')
    await this.storage.verify()
    await this.ensureScope(input)
    await safePath(
      this.history.path,
      join(
        'changes',
        safeId(input.projectId),
        safeId(input.sessionId),
        'requests',
        requestId,
        'data',
        'placeholder'
      ),
      true
    )
    const requestRoot = bindStorageRoot(dirname(directory))
    try {
      const stage = await this.stage({ ...input, directory, paths: [] })
      if (input.operation === 'write') {
        const destination = await safePath(directory, relativePath, true)
        if (input.copyContent) await input.copyContent(destination)
        else {
          if (input.content === undefined)
            throw new Error('Project folder write content is required.')
          await writeFile(destination, input.content, { flag: 'wx' })
        }
      }
      return await this.prepare(stage, relativePath, input.operation, input.replacementBaseline)
    } finally {
      try {
        await this.storage.verify()
        await requestRoot.verify()
        await rm(requestRoot.path, { recursive: true, force: true })
      } catch (error) {
        createLogger('project-folders').warn(
          'Could not remove a project folder request stage',
          diagnosticErrorFields(error)
        )
      }
    }
  }

  // Observes only: inspecting a missing output must never recreate it or its parent directories.
  async inspectDeliveryTarget(
    folder: string,
    relativePath: string
  ): Promise<ProjectFolderDeliveryBaseline | undefined> {
    const root = await realpath(folder)
    const version = await fileVersion(await safePath(root, relativePath, false, true))
    return version ? { ...version, rootIdentity: identity(await stat(root)) } : undefined
  }

  async prepare(
    stage: ProjectFolderStage,
    path: string,
    operation: 'write' | 'delete',
    replacementBaseline?: ProjectFolderDeliveryBaseline | null
  ): Promise<ProjectFolderChange | undefined> {
    return this.serialized(stage.projectId, async () => {
      await this.storage.verify()
      const bindings = this.stages.get(stage)
      if (!bindings) throw new Error('Unknown Project folder stage.')
      await bindings.folder.verify()
      await bindings.directory.verify()
      const relativePath = safeRelative(path)
      const target = await safePath(stage.folder, relativePath, false, true)
      const original = await fileVersion(target)
      const initial = stage.inputs.find((input) => input.path === path)?.version
      if (
        initial &&
        (original?.checksum !== initial.checksum || original.identity !== initial.identity)
      )
        throw new ProjectFolderConflictError(path)
      const candidate =
        operation === 'write'
          ? await fileVersion(await safePath(stage.directory, relativePath))
          : undefined
      if (operation === 'write' && !candidate) return undefined
      if (!original && operation === 'delete') return undefined
      const rootIdentity = identity(await stat(stage.folder))
      const baselineMatches = Boolean(
        original &&
        replacementBaseline &&
        original.checksum === replacementBaseline.checksum &&
        original.size === replacementBaseline.size &&
        original.identity === replacementBaseline.identity &&
        rootIdentity === replacementBaseline.rootIdentity
      )
      if (
        original?.checksum === candidate?.checksum &&
        (replacementBaseline === undefined || baselineMatches)
      )
        return undefined
      const id = randomUUID()
      const root = this.receiptRoot(stage, id)
      await this.ensureScope(stage)
      await safePath(this.history.path, this.receiptRelative(stage, id), true)
      if (candidate)
        await durableCopy(
          await safePath(stage.directory, relativePath),
          join(root, 'candidate'),
          candidate.checksum
        )
      const created = original ? await this.readCreatedFile(stage, relativePath) : undefined
      const originalCreatedFile =
        original &&
        created?.rootIdentity === rootIdentity &&
        created?.identity === original.identity
          ? created.checksum === original.checksum
            ? 'verified'
            : 'unverified'
          : undefined
      const change: ProjectFolderChange = {
        id,
        projectId: stage.projectId,
        sessionId: stage.sessionId,
        runId: stage.runId,
        relativePath,
        operation: operation === 'delete' ? 'delete' : original ? 'replace' : 'create',
        ...(original ? { originalChecksum: original.checksum } : {}),
        ...(candidate
          ? { candidateChecksum: candidate.checksum, candidateSizeBytes: candidate.size }
          : {}),
        requiresConfirmation: Boolean(
          original &&
          !(replacementBaseline === undefined
            ? originalCreatedFile === 'verified'
            : baselineMatches)
        ),
        state: 'prepared'
      }
      await this.writeReceipt(stage, {
        version: 1,
        change,
        root: stage.folder,
        rootIdentity,
        originalIdentity: original?.identity,
        originalMode: original?.mode,
        originalCtimeMs: original?.ctimeMs,
        originalCreatedFile,
        artifactDelivery: replacementBaseline !== undefined ? true : undefined
      })
      return change
    })
  }

  async apply(
    scope: ProjectFolderChangeScope,
    id: string,
    signal?: AbortSignal,
    permissionPrompts?: 'none',
    currentFolder?: string,
    beforeMutation?: () => Promise<void>
  ): Promise<ProjectFolderChange> {
    return this.serialized(scope.projectId, async () => {
      const receipt = await this.readReceipt(scope, id)
      await this.rebindReceipt(scope, receipt, currentFolder)
      if (receipt.change.state !== 'prepared' || receipt.commitState)
        throw new Error('Project folder change is not awaiting approval.')
      const binding = bindStorageRoot(receipt.root)
      const target = await safePath(receipt.root, receipt.change.relativePath, false, true)
      const assertOriginal = async (): Promise<void> => {
        signal?.throwIfAborted()
        await beforeMutation?.()
        await binding.verify()
        if (identity(await stat(receipt.root)) !== receipt.rootIdentity)
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        const current = await fileVersion(target)
        signal?.throwIfAborted()
        if (
          current?.checksum !== receipt.change.originalChecksum ||
          current?.identity !== receipt.originalIdentity ||
          (receipt.originalMode !== undefined && current?.mode !== receipt.originalMode) ||
          (receipt.originalCtimeMs !== undefined && current?.ctimeMs !== receipt.originalCtimeMs)
        )
          throw new ProjectFolderConflictError(receipt.change.relativePath)
      }
      await assertOriginal()
      signal?.throwIfAborted()
      // Older prepared receipts authorized existing files using identity alone.
      if (
        receipt.change.originalChecksum &&
        !receipt.change.requiresConfirmation &&
        !receipt.artifactDelivery &&
        receipt.originalCreatedFile !== 'verified'
      ) {
        receipt.change = { ...receipt.change, requiresConfirmation: true }
        await this.writeReceipt(scope, receipt)
      }
      const approve = receipt.change.requiresConfirmation
        ? this.options.approve
        : this.options.authorizeCreatedFile
      if (!(await approve(receipt.change, signal, permissionPrompts))) {
        receipt.change = { ...receipt.change, state: 'rejected' }
        await this.writeReceipt(scope, receipt)
        return receipt.change
      }
      signal?.throwIfAborted()
      await assertOriginal()
      await safePath(receipt.root, receipt.change.relativePath, true)
      const transactionRoot = this.receiptRoot(scope, id)
      if (receipt.change.originalChecksum) {
        const backup = join(transactionRoot, 'backup')
        const existing = await fileVersion(backup)
        if (existing && existing.checksum !== receipt.change.originalChecksum)
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        if (!existing) await durableCopy(target, backup, receipt.change.originalChecksum, true)
      }
      await assertOriginal()
      receipt.commitState = 'applying'
      await this.writeReceipt(scope, receipt)
      const applied = await this.replaceTarget(
        receipt,
        transactionRoot,
        target,
        'candidate',
        assertOriginal
      )
      receipt.appliedIdentity = applied?.identity
      receipt.appliedCtimeMs = applied?.ctimeMs
      receipt.change = { ...receipt.change, state: 'applied' }
      receipt.commitState = undefined
      await this.writeReceipt(scope, receipt)
      if (
        applied &&
        receipt.change.candidateChecksum &&
        (!receipt.change.requiresConfirmation || receipt.originalCreatedFile)
      ) {
        await this.rememberCreatedFile(
          scope,
          receipt,
          applied.identity,
          receipt.change.candidateChecksum
        )
      }
      return receipt.change
    })
  }

  private async replaceTarget(
    receipt: Receipt,
    transactionRoot: string,
    target: string,
    source: 'candidate' | 'backup',
    verify?: () => Promise<void>
  ): Promise<Pick<FileVersion, 'identity' | 'ctimeMs'> | undefined> {
    const expected =
      source === 'candidate' ? receipt.change.candidateChecksum : receipt.change.originalChecksum
    if (!expected) {
      await safePath(receipt.root, receipt.change.relativePath, false, true)
      await verify?.()
      await rm(target, { force: true })
      await defaultFileDurability.syncDirectory(dirname(target))
      return undefined
    }
    const temporary = join(dirname(target), `.open-science-${randomUUID()}.tmp`)
    try {
      const backup = join(transactionRoot, 'backup')
      if (receipt.originalMode !== undefined) {
        await durableCopy(backup, temporary, receipt.change.originalChecksum!, true)
        const content = await open(
          join(transactionRoot, source),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        )
        const output = await open(temporary, 'r+')
        try {
          await output.truncate(0)
          for await (const chunk of content.createReadStream({ autoClose: false }))
            await output.writeFile(chunk)
          await output.sync()
        } finally {
          await content.close()
          await output.close()
        }
        if ((await fileVersion(temporary))?.checksum !== expected)
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        await chmod(temporary, receipt.originalMode)
        await defaultFileDurability.syncFile(temporary)
      } else await durableCopy(join(transactionRoot, source), temporary, expected)
      // The destination name can be changed externally after rename, and on Windows the
      // creation time can change during rename. Observe the installed file by its open handle.
      const installed = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!(await installed.stat()).isFile())
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        await safePath(receipt.root, receipt.change.relativePath, false, true)
        await verify?.()
        await rename(temporary, target)
        const metadata = await installed.stat()
        await defaultFileDurability.syncDirectory(dirname(target))
        return { identity: identity(metadata), ctimeMs: metadata.ctimeMs }
      } finally {
        await installed.close()
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async revert(
    scope: ProjectFolderChangeScope,
    id: string,
    currentFolder?: string
  ): Promise<ProjectFolderChange> {
    return this.serialized(scope.projectId, async () => {
      const receipt = await this.readReceipt(scope, id)
      await this.rebindReceipt(scope, receipt, currentFolder)
      if (receipt.change.state !== 'applied' || receipt.commitState)
        throw new Error('Project folder change cannot be reverted.')
      const target = await safePath(receipt.root, receipt.change.relativePath, false, true)
      if (identity(await stat(receipt.root)) !== receipt.rootIdentity)
        throw new ProjectFolderConflictError(receipt.change.relativePath)
      const assertApplied = async (): Promise<void> => {
        const current = await fileVersion(target)
        if (
          current?.checksum !== receipt.change.candidateChecksum ||
          (receipt.appliedIdentity !== undefined &&
            current?.identity !== receipt.appliedIdentity) ||
          (receipt.appliedCtimeMs !== undefined && current?.ctimeMs !== receipt.appliedCtimeMs)
        )
          throw new ProjectFolderConflictError(receipt.change.relativePath)
      }
      await assertApplied()
      receipt.commitState = 'reverting'
      await this.writeReceipt(scope, receipt)
      const restored = await this.replaceTarget(
        receipt,
        this.receiptRoot(scope, id),
        target,
        'backup',
        async () => {
          if (identity(await stat(receipt.root)) !== receipt.rootIdentity)
            throw new ProjectFolderConflictError(receipt.change.relativePath)
          await assertApplied()
        }
      )
      receipt.change = { ...receipt.change, state: 'reverted' }
      receipt.commitState = undefined
      await this.writeReceipt(scope, receipt)
      if (restored && receipt.change.originalChecksum && receipt.originalCreatedFile === 'verified')
        await this.rememberCreatedFile(
          scope,
          receipt,
          restored.identity,
          receipt.change.originalChecksum
        )
      return receipt.change
    })
  }

  private async rebindReceipt(
    scope: ProjectFolderChangeScope,
    receipt: Receipt,
    currentFolder?: string
  ): Promise<void> {
    if (currentFolder === undefined) return
    const folder = await realpath(currentFolder)
    if (identity(await stat(folder)) !== receipt.rootIdentity)
      throw new ProjectFolderConflictError(receipt.change.relativePath)
    if (folder !== receipt.root) {
      receipt.root = folder
      await this.writeReceipt(scope, receipt)
    }
  }

  // A crash between the filesystem commit and the receipt update never replays a mutation.
  // Reconcile only exact known hashes; an independently changed file requires manual recovery.
  async recover(
    scope: ProjectFolderChangeScope,
    id: string,
    currentFolder?: string
  ): Promise<ProjectFolderChange> {
    return this.serialized(scope.projectId, async () => {
      const receipt = await this.readReceipt(scope, id)
      await this.rebindReceipt(scope, receipt, currentFolder)
      if (!receipt.commitState) return receipt.change
      if (identity(await stat(receipt.root)) !== receipt.rootIdentity)
        throw new ProjectFolderConflictError(receipt.change.relativePath)
      const target = await safePath(receipt.root, receipt.change.relativePath, false, true)
      const checksum = (await fileVersion(target))?.checksum
      if (
        checksum !== receipt.change.originalChecksum &&
        checksum !== receipt.change.candidateChecksum
      )
        throw new ProjectFolderConflictError(receipt.change.relativePath)
      const state =
        receipt.commitState === 'applying'
          ? checksum === receipt.change.candidateChecksum
            ? 'applied'
            : 'prepared'
          : checksum === receipt.change.originalChecksum
            ? 'reverted'
            : 'applied'
      receipt.change = { ...receipt.change, state }
      receipt.commitState = undefined
      await this.writeReceipt(scope, receipt)
      return receipt.change
    })
  }

  async list(
    scope: ProjectFolderChangeScope,
    options: { afterId?: string; limit?: number } = {}
  ): Promise<ProjectFolderChangePage> {
    await this.storage.verify()
    const limit = Math.max(
      1,
      Math.min(200, Number.isSafeInteger(options.limit) ? options.limit! : 50)
    )
    const historyExists = await lstat(this.history.path).then(
      () => true,
      (error: unknown) => {
        if (hasCode(error, 'ENOENT')) return false
        throw error
      }
    )
    if (!historyExists) return { changes: [] }
    await this.history.verify()
    await safePath(
      this.history.path,
      join('changes', safeId(scope.projectId), safeId(scope.sessionId), 'placeholder'),
      false,
      true
    )
    const entries = await readdir(this.scopeRoot(scope), { withFileTypes: true }).catch(
      (error: unknown) => {
        if (hasCode(error, 'ENOENT')) return []
        throw error
      }
    )
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
        .map(async (entry) => ({
          id: entry.name,
          receipt: await this.readReceipt(scope, entry.name)
        }))
    )
    records.sort(
      (left, right) =>
        (right.receipt.updatedAt ?? right.receipt.createdAt ?? 0) -
          (left.receipt.updatedAt ?? left.receipt.createdAt ?? 0) || right.id.localeCompare(left.id)
    )
    const ids = records.map((record) => record.id)
    const after = options.afterId === undefined ? -1 : ids.indexOf(safeId(options.afterId))
    if (options.afterId !== undefined && after < 0)
      throw new Error('Unknown Project folder history cursor.')
    const selected = ids.slice(after + 1, after + 1 + limit)
    const changes = await Promise.all(
      selected.map(async (id) => (await this.readReceipt(scope, id)).change)
    )
    return {
      changes,
      ...(after + 1 + selected.length < ids.length ? { nextId: selected.at(-1) } : {})
    }
  }

  async preview(scope: ProjectFolderChangeScope, id: string): Promise<ProjectFolderChangePreview> {
    const receipt = await this.readReceipt(scope, id)
    const preview = async (path: string): Promise<ProjectFolderFilePreview> => {
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error('Project folder preview must be a regular file.')
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat()
        if (identity(before) !== identity(entry))
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        const buffer = Buffer.alloc(Math.min(64 * 1024, before.size))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const after = await handle.stat()
        if (
          identity(after) !== identity(before) ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new ProjectFolderConflictError(receipt.change.relativePath)
        const content = buffer.subarray(0, bytesRead)
        const decoded = textPage(content)
        return {
          text: decoded.text,
          binary: decoded.binary,
          truncated: before.size > decoded.bytes,
          sizeBytes: before.size
        }
      } finally {
        await handle.close()
      }
    }
    const transactionRoot = this.receiptRoot(scope, id)
    let original: ProjectFolderFilePreview | undefined
    if (receipt.change.originalChecksum) {
      const backup = join(transactionRoot, 'backup')
      const source = await lstat(backup).then(
        () => backup,
        (error: unknown) => {
          if (hasCode(error, 'ENOENT')) return undefined
          throw error
        }
      )
      if (!source && identity(await stat(receipt.root)) !== receipt.rootIdentity)
        throw new ProjectFolderConflictError(receipt.change.relativePath)
      original = await preview(
        source ?? (await safePath(receipt.root, receipt.change.relativePath))
      )
    }
    return {
      change: receipt.change,
      ...(original ? { original } : {}),
      ...(receipt.change.candidateChecksum
        ? { candidate: await preview(join(transactionRoot, 'candidate')) }
        : {})
    }
  }

  async inspect(
    scope: ProjectFolderChangeScope,
    id: string,
    currentFolder?: string
  ): Promise<ProjectFolderChange> {
    const receipt = await this.readReceipt(scope, id)
    if (currentFolder !== undefined || receipt.commitState)
      return this.recover(scope, id, currentFolder)
    return receipt.change
  }
}
