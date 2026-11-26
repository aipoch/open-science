import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  isOwnedPosixProcessGroupAlive,
  terminateOwnedPosixProcessGroupById,
  type ProcessTreeKillResult
} from '../process-tree'
import { windowsProcessCommandLine, windowsProcessIsAlive } from '../windows-process-query'
import {
  hasSystemRestarted,
  isStableBootIdentity,
  readWindowsBootObservation,
  type WindowsBootObservation
} from '../system-boot-identity'
import { reapWindowsOwnedJob } from '../process-tree-windows'
import {
  createDarwinKernelRecovery,
  type DarwinRecoveryIdentity
} from './kernel-process-recovery.darwin'
import {
  readProcessStartToken,
  bootTokenProvesReboot,
  isValidBootToken,
  readBootToken
} from './kernel-process-identity'

const OWNER_TOKEN_ENV = 'OPEN_SCIENCE_KERNEL_OWNER_TOKEN'
const RECORD_VERSION = 1

type KernelProcessSpawnScope = Readonly<{
  laneKey: string
  processKey: string
  kernelEpochId: string
}>

type WindowsProcessTreeProof = Readonly<{
  path: string
  token: string
  requestPath: string
}>

type KernelProcessRecord = KernelProcessSpawnScope & {
  version: typeof RECORD_VERSION
  receiptId: string
  ownerInstanceId: string
  ownerToken: string
  platform: NodeJS.Platform
  spawnedAt: number
  pid?: number
  processStartToken?: string
  posixBirthToken?: string
  commandIdentityMarker?: string
  bootToken?: string
  windowsProcessTreeProof?: WindowsProcessTreeProof
  windowsJobName?: string
  windowsBootObservation?: WindowsBootObservation
  darwinRecoveryProcesses?: DarwinRecoveryIdentity[]
}

type KernelProcessSpawnIntent = Readonly<{
  path: string
  activePath: (pid: number) => string
  record: KernelProcessRecord
}>

type KernelProcessReceipt = Readonly<{
  path: string
  receiptId: string
  laneKey: string
}>

type KernelProcessProbe = 'dead' | 'owned' | 'reused' | 'unknown'

const SCOPED_RECOVERY_CACHE_MAX = 256

type ScopedRecoveryResult = Readonly<{
  directoryMtimeMs: number | undefined
}>

type DeferredRecovery =
  | { reason: 'invalid-receipt' | 'receipt-changed' | 'cleanup-failed' }
  | { reason: 'unverified-process'; probe: 'unknown' | 'reused' }
  | { reason: 'termination-unconfirmed'; probe: 'owned'; reaped: false }

type RecoveryDiagnostic = Readonly<
  DeferredRecovery & {
    lane?: string
    processKey?: string
    kernelEpochId?: string
    receiptId?: string
  }
>

type KernelProcessRecoveryController = Readonly<{
  probe(
    record: Readonly<KernelProcessRecord>,
    checkpoint?: (identities: DarwinRecoveryIdentity[]) => void
  ): Promise<KernelProcessProbe>
  terminate(
    record: Readonly<KernelProcessRecord>,
    checkpoint?: (identities: DarwinRecoveryIdentity[]) => void
  ): Promise<ProcessTreeKillResult>
}>

type KernelProcessRecoveryOptions = Readonly<{
  // A valid receipt identifies its exact lane/process/epoch. When this is enabled, an unverified
  // receipt fences only that same epoch. Background scans keep and report unresolved receipts.
  allowUnverifiedReceipts?: boolean
  // Scoped recovery only needs to verify receipts that could fence this lane. Omit this for the
  // strict global recovery used before environment mutation.
  targetLaneKey?: string
}>

type KernelProcessLifecycleOwnerOptions = Readonly<{
  storageRoot: string
  ownerInstanceId?: string
  platform?: NodeJS.Platform
  controller?: KernelProcessRecoveryController
  readBootToken?: () => string | undefined
  readWindowsBootObservation?: typeof readWindowsBootObservation
  onRecoveryDeferred?: (diagnostic: RecoveryDiagnostic) => void
}>

const isPositivePid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isWindowsBootObservation = (value: unknown): value is WindowsBootObservation => {
  if (!value || typeof value !== 'object') return false
  const observation = value as Partial<WindowsBootObservation>
  return (
    typeof observation.hostHash === 'string' &&
    /^[0-9a-f]{64}$/.test(observation.hostHash) &&
    isStableBootIdentity(observation.bootIdentity) &&
    observation.bootIdentity.startsWith('windows-boot:')
  )
}

const isWindowsProcessTreeProof = (value: unknown): value is WindowsProcessTreeProof => {
  if (typeof value !== 'object' || value === null) return false
  const proof = value as Partial<WindowsProcessTreeProof>
  return (
    typeof proof.path === 'string' &&
    typeof proof.token === 'string' &&
    proof.token.length > 0 &&
    typeof proof.requestPath === 'string' &&
    proof.requestPath === `${proof.path}.request` &&
    basename(proof.path).startsWith('.open-science-process-tree-terminated-') &&
    basename(proof.path).endsWith('.proof')
  )
}

const legacyRecordFilePrefix = (scope: KernelProcessSpawnScope): string =>
  createHash('sha256').update(`${scope.laneKey}\0${scope.processKey}`).digest('hex')

const recordFilePrefix = (scope: KernelProcessSpawnScope): string =>
  `${legacyRecordFilePrefix(scope)}.${createHash('sha256').update(scope.kernelEpochId).digest('hex')}`

const hasReceiptFilePrefix = (name: string, prefix: string): boolean =>
  name.startsWith(`${prefix}.pending.`) || name.startsWith(`${prefix}.active.`)

const recordMatchesFileName = (name: string, record: KernelProcessRecord): boolean =>
  hasReceiptFilePrefix(name, recordFilePrefix(record)) ||
  hasReceiptFilePrefix(name, legacyRecordFilePrefix(record))

const writeRecordSync = (path: string, record: KernelProcessRecord): void => {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    // Windows requires a writable handle for fsync (FlushFileBuffers).
    const file = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Preserve the original write failure; the published receipt remains authoritative.
    }
    throw error
  }
}

const decodeRecord = (contents: string): KernelProcessRecord | undefined => {
  try {
    const value = JSON.parse(contents) as Partial<KernelProcessRecord>
    if (
      value.version !== RECORD_VERSION ||
      typeof value.receiptId !== 'string' ||
      typeof value.ownerInstanceId !== 'string' ||
      typeof value.ownerToken !== 'string' ||
      (value.darwinRecoveryProcesses !== undefined &&
        (!Array.isArray(value.darwinRecoveryProcesses) ||
          !value.darwinRecoveryProcesses.every(
            (identity) =>
              identity &&
              isPositivePid(identity.pid) &&
              typeof identity.uniqueId === 'string' &&
              /^[1-9][0-9]*$/.test(identity.uniqueId)
          ))) ||
      typeof value.platform !== 'string' ||
      typeof value.laneKey !== 'string' ||
      typeof value.processKey !== 'string' ||
      typeof value.kernelEpochId !== 'string' ||
      typeof value.spawnedAt !== 'number' ||
      !Number.isFinite(value.spawnedAt) ||
      (value.pid !== undefined && !isPositivePid(value.pid)) ||
      (value.processStartToken !== undefined && typeof value.processStartToken !== 'string') ||
      (value.posixBirthToken !== undefined && typeof value.posixBirthToken !== 'string') ||
      (value.commandIdentityMarker !== undefined &&
        typeof value.commandIdentityMarker !== 'string') ||
      (value.windowsProcessTreeProof !== undefined &&
        !isWindowsProcessTreeProof(value.windowsProcessTreeProof)) ||
      (value.windowsJobName !== undefined &&
        (value.platform !== 'win32' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            value.receiptId
          ) ||
          value.windowsJobName !== `Local\\OpenScience.Notebook.${value.receiptId}`)) ||
      (value.bootToken !== undefined && !isValidBootToken(value.bootToken)) ||
      (value.windowsBootObservation !== undefined &&
        (value.platform !== 'win32' || !isWindowsBootObservation(value.windowsBootObservation)))
    ) {
      return undefined
    }
    return value as KernelProcessRecord
  } catch {
    return undefined
  }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const capture = (command: string, args: readonly string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-256 * 1024)
    })
    child.once('error', () => resolve(undefined))
    child.once('close', (code) => resolve(code === 0 ? output : undefined))
  })

const processEvidence = async (
  record: Readonly<KernelProcessRecord>,
  platform: NodeJS.Platform
): Promise<string | undefined> => {
  if (!record.pid) return undefined
  if (platform === 'linux') {
    try {
      return readFileSync(`/proc/${record.pid}/environ`, 'utf8')
    } catch {
      return undefined
    }
  }
  if (platform === 'win32') {
    try {
      return windowsProcessCommandLine(record.pid)
    } catch {
      // Unreadable evidence keeps the startup fence closed; see the caller.
      return undefined
    }
  }
  return capture('ps', ['eww', '-p', String(record.pid), '-o', 'command='])
}

const proofFileConfirmsWindowsProcessTreeReaped = (proof: WindowsProcessTreeProof): boolean => {
  try {
    const value = JSON.parse(readFileSync(proof.path, 'utf8')) as Record<string, unknown>
    if (
      value.version !== 1 ||
      value.token !== proof.token ||
      (value.processState !== 'never-started' && value.processState !== 'started-and-reaped')
    )
      return false
    return true
  } catch {
    return false
  }
}

const requestWindowsProcessTreeReap = async (proof: WindowsProcessTreeProof): Promise<boolean> => {
  if (proofFileConfirmsWindowsProcessTreeReaped(proof)) return true
  try {
    writeFileSync(proof.requestPath, proof.token, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
  }
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (proofFileConfirmsWindowsProcessTreeReaped(proof)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return false
}

const defaultController = (
  platform: NodeJS.Platform,
  currentBootToken: () => string | undefined = readBootToken
): KernelProcessRecoveryController => ({
  probe: async (record, checkpoint) => {
    if (record.platform !== platform) return 'dead'
    // New hosts are atomically created inside this exact Job before they can activate a receipt.
    // Its identity survives the proof publisher; a missing Job proves there are no members left.
    if (record.windowsJobName) {
      return (await reapWindowsOwnedJob(record.windowsJobName).catch(() => false))
        ? 'dead'
        : 'unknown'
    }
    if (!record.pid) return 'unknown'

    if (platform !== 'win32') {
      const bootToken = currentBootToken()
      if (bootTokenProvesReboot(record.bootToken, bootToken)) return 'dead'
    }
    if (platform === 'darwin') {
      return createDarwinKernelRecovery().probe({ ...record, pid: record.pid }, checkpoint)
    }
    let alive: boolean
    if (platform === 'win32') {
      // Exited intermediate parents disappear from snapshots even if their children survive.
      const proof = record.windowsProcessTreeProof
      if (!proof) return 'unknown'
      try {
        alive = windowsProcessIsAlive(record.pid) && pidIsAlive(record.pid)
      } catch {
        alive = pidIsAlive(record.pid)
      }
      if (!alive) return (await requestWindowsProcessTreeReap(proof)) ? 'dead' : 'unknown'
    } else {
      alive = pidIsAlive(record.pid)
    }
    if (platform !== 'win32') {
      const groupAlive = isOwnedPosixProcessGroupAlive(record.pid)
      if (!groupAlive) return 'dead'
      // Once the leader exits, its numeric group id is no longer tied to the persisted process
      // identity. A later group can reuse it during the same boot, so retain the fence rather than
      // authorizing a group signal from the number alone.
      if (!alive) return 'unknown'
    }

    if (record.processStartToken !== undefined) {
      const current = readProcessStartToken(record.pid)
      if (current !== undefined && current !== record.processStartToken) return 'reused'
    }
    const evidence = await processEvidence(record, platform)
    if (evidence?.includes(`${OWNER_TOKEN_ENV}=${record.ownerToken}`)) return 'owned'
    if (record.commandIdentityMarker && evidence?.includes(record.commandIdentityMarker)) {
      return 'owned'
    }
    // Missing identity evidence is not proof that the PID was reused: ps/CIM output can be
    // truncated or unavailable under tighter host permissions. Only a start-token mismatch above
    // proves reuse. Keep the startup fence closed rather than risk clearing or killing an unrelated
    // process from ambiguous evidence.
    return 'unknown'
  },
  terminate: (record, checkpoint) => {
    const pid = record.pid
    if (!pid) return Promise.resolve({ reaped: false })
    if (platform === 'darwin') {
      return checkpoint
        ? createDarwinKernelRecovery().terminate({ ...record, pid }, checkpoint)
        : Promise.resolve({ reaped: false })
    }
    if (platform === 'win32') {
      const proof = record.windowsProcessTreeProof
      // The recorded PID can be reused while the legacy supervisor answers the reap request.
      // Require its workload proof and the outer host's exit before settling the receipt.
      return proof
        ? requestWindowsProcessTreeReap(proof).then((reaped) => ({
            reaped: reaped && !pidIsAlive(pid)
          }))
        : Promise.resolve({ reaped: false })
    }
    return terminateOwnedPosixProcessGroupById(pid, undefined, undefined, record.posixBirthToken, {
      name: OWNER_TOKEN_ENV,
      value: record.ownerToken
    })
  }
})

class KernelProcessLifecycleOwner {
  readonly ownerInstanceId: string
  private readonly directory: string
  private readonly platform: NodeJS.Platform
  private readonly controller: KernelProcessRecoveryController
  private readonly readBootToken: () => string | undefined
  private readonly readWindowsBootObservation: typeof readWindowsBootObservation
  private readonly onRecoveryDeferred: KernelProcessLifecycleOwnerOptions['onRecoveryDeferred']
  private readonly reportedDeferredRecoveries = new Map<string, DeferredRecovery['reason']>()
  private readonly pendingReceiptIds = new Set<string>()
  private recovery: Promise<void> | undefined
  private scopedRecoveryTail: Promise<void> = Promise.resolve()
  private readonly scopedRecoveries = new Map<string, Promise<void>>()
  private readonly scopedRecoveryResults = new Map<string, ScopedRecoveryResult>()
  private readonly invalidatedScopedRecoveries = new Set<string>()

  constructor(options: KernelProcessLifecycleOwnerOptions) {
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID()
    this.directory = join(options.storageRoot, 'runtime', 'kernel-processes')
    this.platform = options.platform ?? process.platform
    this.readBootToken = options.readBootToken ?? readBootToken
    this.readWindowsBootObservation =
      options.readWindowsBootObservation ?? readWindowsBootObservation
    this.controller = options.controller ?? defaultController(this.platform, this.readBootToken)
    this.onRecoveryDeferred = options.onRecoveryDeferred
  }

  hasReceipts(): boolean {
    try {
      return readdirSync(this.directory).some((name) => name.endsWith('.json'))
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  hasReceiptsForEnvironment(
    environment: string,
    {
      previousOwnerOnly = false,
      activeEpochIds
    }: { previousOwnerOnly?: boolean; activeEpochIds?: ReadonlySet<string> } = {}
  ): boolean {
    const normalizeEnvironment = (name: string): string => {
      if (this.platform === 'win32') return name.toLowerCase().replace(/\.+$/u, '')
      if (this.platform === 'darwin') return name.toLowerCase()
      return name
    }
    const target = normalizeEnvironment(environment)
    try {
      for (const name of readdirSync(this.directory)) {
        if (!name.endsWith('.json')) continue
        const record = decodeRecord(readFileSync(join(this.directory, name), 'utf8'))
        // An unreadable or mismatched receipt cannot rule out ownership of this prefix.
        if (!record || !recordMatchesFileName(name, record)) return true
        if (
          record.ownerInstanceId === this.ownerInstanceId &&
          (previousOwnerOnly || activeEpochIds?.has(record.kernelEpochId))
        ) {
          continue
        }
        if (record.processKey === 'repl') continue
        const [kind, nameInReceipt] = record.processKey.split(':', 2)
        if ((kind !== 'python' && kind !== 'r') || !nameInReceipt) return true
        if (normalizeEnvironment(nameInReceipt) === target) return true
      }
      return false
    } catch (error) {
      // An intent can become active while reading the ledger. Only absence of the directory itself
      // establishes that no receipt can remain.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(this.directory)
    }
  }

  ensureReady(): Promise<void> {
    if (this.recovery) return this.recovery
    const recovery = this.recoverRecords().then(() => undefined)
    this.recovery = recovery
    void recovery.catch(() => {
      if (this.recovery === recovery) this.recovery = undefined
    })
    return recovery
  }

  ensureReadyForLane(laneKey: string): Promise<void> {
    const cached = this.scopedRecoveryResults.get(laneKey)
    if (cached && cached.directoryMtimeMs === this.receiptDirectoryMtimeMs()) {
      this.scopedRecoveryResults.delete(laneKey)
      this.scopedRecoveryResults.set(laneKey, cached)
      return Promise.resolve()
    }
    this.scopedRecoveryResults.delete(laneKey)
    const existing = this.scopedRecoveries.get(laneKey)
    if (existing) return existing
    // Session admission may happen concurrently for several lanes. Serialize the filesystem scan,
    // while sharing duplicate callers for the same lane.
    const queued = this.scopedRecoveryTail.then(async () => {
      const directoryMtimeBefore = this.receiptDirectoryMtimeMs()
      const settled = await this.recoverRecords({
        allowUnverifiedReceipts: true,
        targetLaneKey: laneKey
      })
      const directoryMtimeAfter = this.receiptDirectoryMtimeMs()
      if (
        settled &&
        directoryMtimeBefore === directoryMtimeAfter &&
        !this.invalidatedScopedRecoveries.delete(laneKey)
      ) {
        this.rememberScopedRecovery(laneKey, directoryMtimeAfter)
      }
    })
    this.scopedRecoveryTail = queued.catch(() => undefined)
    this.scopedRecoveries.set(laneKey, queued)
    void queued
      .finally(() => {
        if (this.scopedRecoveries.get(laneKey) === queued) this.scopedRecoveries.delete(laneKey)
        if (!this.scopedRecoveries.has(laneKey)) this.invalidatedScopedRecoveries.delete(laneKey)
      })
      .catch(() => undefined)
    return queued
  }

  async recover(options: KernelProcessRecoveryOptions = {}): Promise<void> {
    const recovery = this.recoverRecords(options).then(() => undefined)
    // Tolerant startup recovery must not satisfy a later strict ensureReady() call used by
    // environment mutation. Same-epoch admission remains fenced by beginSpawn().
    if (!options.allowUnverifiedReceipts) this.recovery = recovery
    try {
      await recovery
    } catch (error) {
      if (this.recovery === recovery) this.recovery = undefined
      throw error
    }
  }

  createOwnerToken(): string {
    return randomUUID()
  }

  beginSpawn(
    scope: KernelProcessSpawnScope,
    ownerToken = this.createOwnerToken(),
    windowsProcessTreeProof?: WindowsProcessTreeProof,
    ownWindowsJob = false
  ): KernelProcessSpawnIntent {
    this.invalidateLaneRecovery(scope.laneKey)
    const prefix = recordFilePrefix(scope)
    const legacyPrefix = legacyRecordFilePrefix(scope)
    mkdirSync(this.directory, { recursive: true })
    // Unpublished .tmp writes cannot authorize a host; recovery only reads published JSON receipts.
    const fenced = readdirSync(this.directory).some((name) => {
      if (!name.endsWith('.json')) return false
      if (name.startsWith(`${prefix}.`)) return true
      if (!hasReceiptFilePrefix(name, legacyPrefix)) return false
      try {
        const record = decodeRecord(readFileSync(join(this.directory, name), 'utf8'))
        return (
          record?.laneKey === scope.laneKey &&
          record.processKey === scope.processKey &&
          record.kernelEpochId === scope.kernelEpochId
        )
      } catch {
        // An unreadable legacy receipt has no verified epoch. Leave it to background recovery.
        return false
      }
    })
    if (fenced) {
      throw new Error(
        `KERNEL_STARTUP_FENCE: ${scope.processKey} still has durable process ownership.`
      )
    }
    const receiptId = randomUUID()
    const path = join(this.directory, `${prefix}.pending.${receiptId}.json`)
    const bootToken = this.platform === 'linux' ? this.readBootToken() : undefined
    const record: KernelProcessRecord = {
      version: RECORD_VERSION,
      receiptId,
      ownerInstanceId: this.ownerInstanceId,
      ownerToken,
      platform: this.platform,
      spawnedAt: Date.now(),
      ...(bootToken ? { bootToken } : {}),
      ...(windowsProcessTreeProof ? { windowsProcessTreeProof } : {}),
      ...(ownWindowsJob && this.platform === 'win32'
        ? { windowsJobName: `Local\\OpenScience.Notebook.${receiptId}` }
        : {}),
      ...scope
    }
    writeRecordSync(path, record)
    this.pendingReceiptIds.add(receiptId)
    return {
      path,
      activePath: (pid) => join(this.directory, `${prefix}.active.${pid}.${receiptId}.json`),
      record
    }
  }

  recordSpawned(
    intent: KernelProcessSpawnIntent,
    child: Readonly<{
      pid: number
      processStartToken?: string
      posixBirthToken?: string
      commandIdentityMarker?: string
    }>
  ): KernelProcessReceipt {
    this.invalidateLaneRecovery(intent.record.laneKey)
    if (!isPositivePid(child.pid)) throw new Error('Kernel process did not expose a valid pid.')
    const activePath = intent.activePath(child.pid)
    try {
      renameSync(intent.path, activePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync(activePath)) throw error
    }
    const published = decodeRecord(readFileSync(activePath, 'utf8'))
    if (
      !published ||
      published.receiptId !== intent.record.receiptId ||
      (published.pid !== undefined && published.pid !== child.pid) ||
      (published.posixBirthToken !== undefined &&
        child.posixBirthToken !== undefined &&
        published.posixBirthToken !== child.posixBirthToken)
    )
      throw new Error('Kernel process ownership receipt identity changed.')
    const birthToken = child.posixBirthToken ?? published.posixBirthToken
    if (['linux', 'darwin'].includes(intent.record.platform) && !birthToken)
      throw new Error('Kernel process birth identity could not be confirmed.')
    const record = {
      ...intent.record,
      pid: child.pid,
      ...(child.processStartToken ? { processStartToken: child.processStartToken } : {}),
      ...(birthToken ? { posixBirthToken: birthToken } : {}),
      ...(child.commandIdentityMarker ? { commandIdentityMarker: child.commandIdentityMarker } : {})
    }
    writeRecordSync(activePath, record)
    this.pendingReceiptIds.delete(record.receiptId)
    return { path: activePath, receiptId: record.receiptId, laneKey: record.laneKey }
  }

  abandonSpawn(intent: KernelProcessSpawnIntent): void {
    this.invalidateLaneRecovery(intent.record.laneKey)
    this.pendingReceiptIds.delete(intent.record.receiptId)
    this.removeIfOwned(intent.path, intent.record.receiptId)
  }

  complete(receipt: KernelProcessReceipt, reaped: boolean): void {
    if (!reaped) return
    this.invalidateLaneRecovery(receipt.laneKey)
    let proof: WindowsProcessTreeProof | undefined
    try {
      const record = decodeRecord(readFileSync(receipt.path, 'utf8'))
      if (record?.receiptId === receipt.receiptId) proof = record.windowsProcessTreeProof
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.removeIfOwned(receipt.path, receipt.receiptId)) {
      removeWindowsProcessTreeProof(proof)
    }
  }

  environment(ownerToken: string): NodeJS.ProcessEnv {
    return { [OWNER_TOKEN_ENV]: ownerToken }
  }

  private invalidateLaneRecovery(laneKey: string): void {
    this.scopedRecoveryResults.delete(laneKey)
    if (this.scopedRecoveries.has(laneKey)) this.invalidatedScopedRecoveries.add(laneKey)
  }

  private rememberScopedRecovery(laneKey: string, directoryMtimeMs: number | undefined): void {
    this.scopedRecoveryResults.delete(laneKey)
    this.scopedRecoveryResults.set(laneKey, { directoryMtimeMs })
    while (this.scopedRecoveryResults.size > SCOPED_RECOVERY_CACHE_MAX) {
      const oldest = this.scopedRecoveryResults.keys().next().value
      if (oldest === undefined) return
      this.scopedRecoveryResults.delete(oldest)
    }
  }

  private receiptDirectoryMtimeMs(): number | undefined {
    try {
      return statSync(this.directory).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async recoverRecords(options: KernelProcessRecoveryOptions = {}): Promise<boolean> {
    let names: string[]
    try {
      names = readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
    const blocked: string[] = []
    let settled = true
    const defer = (name: string, reason: DeferredRecovery, record?: KernelProcessRecord): void => {
      settled = false
      if (options.allowUnverifiedReceipts) this.reportDeferredRecovery(name, reason, record)
      else blocked.push(record ? `${record.laneKey}:${record.processKey}` : name)
    }
    let bootObservation: ReturnType<typeof readWindowsBootObservation> | undefined
    const currentWindowsBoot = (): ReturnType<typeof readWindowsBootObservation> =>
      (bootObservation ??= this.readWindowsBootObservation())
    for (const name of names) {
      const path = join(this.directory, name)
      if (name.includes('.pending.')) {
        let pendingRecord: KernelProcessRecord | undefined
        try {
          pendingRecord = decodeRecord(readFileSync(path, 'utf8'))
        } catch (error) {
          // The host may have atomically promoted this intent after the directory snapshot.
          // Its active receipt still fences same-epoch admission in beginSpawn().
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          pendingRecord = undefined
        }
        const ownedIntent =
          pendingRecord && recordMatchesFileName(name, pendingRecord) ? pendingRecord : undefined
        if (ownedIntent && options.allowUnverifiedReceipts) {
          if (
            options.targetLaneKey !== undefined &&
            ownedIntent.laneKey !== options.targetLaneKey
          ) {
            continue
          }
          if (
            ownedIntent.ownerInstanceId === this.ownerInstanceId &&
            this.pendingReceiptIds.has(ownedIntent.receiptId)
          ) {
            // Tolerant lane recovery can run while this owner is between beginSpawn() and the
            // atomic pending-to-active promotion. Leave this live intent for the host to publish.
            continue
          }
        }
        // The process host and recovery race through an atomic rename. Recovery winning this claim
        // guarantees the host can no longer activate or execute the kernel; a host that won first
        // has already published an active filename containing its PID.
        const cancelledPath = `${path}.cancelled-${this.ownerInstanceId}`
        try {
          renameSync(path, cancelledPath)
          if (ownedIntent) {
            rmSync(cancelledPath, { force: true })
            removeWindowsProcessTreeProof(ownedIntent.windowsProcessTreeProof)
          } else {
            // Preserve the malformed intent for diagnosis outside the active JSON ledger.
            this.reportDeferredRecovery(name, { reason: 'invalid-receipt' })
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        continue
      }
      let record: KernelProcessRecord | undefined
      try {
        record = decodeRecord(readFileSync(path, 'utf8'))
      } catch {
        record = undefined
      }
      if (!record || !recordMatchesFileName(name, record)) {
        defer(name, { reason: 'invalid-receipt' })
        continue
      }
      if (record.ownerInstanceId === this.ownerInstanceId) continue
      if (
        options.allowUnverifiedReceipts &&
        options.targetLaneKey !== undefined &&
        record.laneKey !== options.targetLaneKey
      ) {
        continue
      }

      try {
        const outcome = await this.recoverActiveReceipt(name, path, record, currentWindowsBoot)
        if (outcome) defer(name, outcome, record)
        else this.reportedDeferredRecoveries.delete(name)
      } catch (error) {
        if (!options.allowUnverifiedReceipts) throw error
        defer(name, { reason: 'cleanup-failed' }, record)
      }
    }
    if (blocked.length > 0) {
      throw new Error(
        `KERNEL_STARTUP_FENCE: could not prove old persistent process ownership was cleared (${blocked.join(', ')}).`
      )
    }
    return settled
  }

  private reportDeferredRecovery(
    name: string,
    outcome: DeferredRecovery,
    record?: KernelProcessRecord
  ): void {
    if (!this.onRecoveryDeferred || this.reportedDeferredRecoveries.get(name) === outcome.reason)
      return
    this.reportedDeferredRecoveries.delete(name)
    this.reportedDeferredRecoveries.set(name, outcome.reason)
    if (this.reportedDeferredRecoveries.size > SCOPED_RECOVERY_CACHE_MAX) {
      const oldest = this.reportedDeferredRecoveries.keys().next().value
      if (oldest !== undefined) this.reportedDeferredRecoveries.delete(oldest)
    }
    this.onRecoveryDeferred({
      ...outcome,
      ...(record && {
        lane: record.laneKey,
        processKey: record.processKey,
        kernelEpochId: record.kernelEpochId,
        receiptId: record.receiptId
      })
    })
  }

  private async recoverActiveReceipt(
    name: string,
    path: string,
    record: KernelProcessRecord,
    currentWindowsBoot: typeof readWindowsBootObservation
  ): Promise<DeferredRecovery | undefined> {
    const settle = (): DeferredRecovery | undefined => {
      if (!this.removeIfOwned(path, record.receiptId)) return { reason: 'receipt-changed' }
      removeWindowsProcessTreeProof(record.windowsProcessTreeProof)
      return undefined
    }
    const legacyWindows =
      this.platform === 'win32' && record.platform === 'win32' && !record.windowsJobName
    if (legacyWindows && record.windowsBootObservation) {
      const current = await currentWindowsBoot()
      if (
        current?.hostHash === record.windowsBootObservation.hostHash &&
        hasSystemRestarted(record.windowsBootObservation.bootIdentity, current.bootIdentity)
      ) {
        return settle()
      }
    }
    if (!record.pid) {
      const encodedPid = name.match(/\.active\.(\d+)\./)?.[1]
      if (encodedPid && isPositivePid(Number(encodedPid))) record.pid = Number(encodedPid)
    }
    const checkpoint = (identities: DarwinRecoveryIdentity[]): void => {
      // Remember uncertain associated members even if ownership cannot yet authorize a signal.
      if (decodeRecord(readFileSync(path, 'utf8'))?.receiptId !== record.receiptId) {
        throw new Error('Kernel recovery receipt changed before checkpoint.')
      }
      record.darwinRecoveryProcesses = identities
      writeRecordSync(path, record)
    }
    const probe = await (this.platform === 'darwin'
      ? this.controller.probe(record, checkpoint)
      : this.controller.probe(record))
    if (
      probe === 'dead' ||
      (probe === 'reused' &&
        (record.platform !== 'win32' ||
          !record.windowsProcessTreeProof ||
          (await requestWindowsProcessTreeReap(record.windowsProcessTreeProof))))
    ) {
      return settle()
    }
    if (probe === 'owned') {
      const result = await (this.platform === 'darwin'
        ? this.controller.terminate(record, checkpoint)
        : this.controller.terminate(record))
      if (result.reaped) return settle()
    }
    if (legacyWindows && !record.windowsBootObservation) {
      const current = await currentWindowsBoot()
      if (current) this.checkpointWindowsBoot(path, record, current)
    }
    return probe === 'owned'
      ? { reason: 'termination-unconfirmed', probe, reaped: false }
      : { reason: 'unverified-process', probe }
  }

  private checkpointWindowsBoot(
    path: string,
    record: KernelProcessRecord,
    observation: WindowsBootObservation
  ): void {
    // A concurrent scan can settle or update the receipt while the OS query is in flight.
    // Preserve the first observation and never recreate a removed record.
    try {
      const latest = decodeRecord(readFileSync(path, 'utf8'))
      if (
        latest?.receiptId === record.receiptId &&
        latest.ownerToken === record.ownerToken &&
        !latest.windowsJobName &&
        !latest.windowsBootObservation
      ) {
        writeRecordSync(path, { ...latest, windowsBootObservation: observation })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private removeIfOwned(path: string, receiptId: string): boolean {
    try {
      const current = decodeRecord(readFileSync(path, 'utf8'))
      if (current?.receiptId !== receiptId) return false
      const hostPid = current.pid ?? Number(basename(path).match(/\.active\.(\d+)\./)?.[1])
      if (isPositivePid(hostPid)) {
        // A stopped host may have been interrupted before renaming its updated receipt.
        // Remove its matching temporary receipt first so an interrupted cleanup can retry.
        const temporary = `${path}.${hostPid}.tmp`
        try {
          const pending = decodeRecord(readFileSync(temporary, 'utf8'))
          if (
            pending?.receiptId === receiptId &&
            pending.ownerToken === current.ownerToken &&
            pending.pid === hostPid
          ) {
            rmSync(temporary, { force: true })
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      rmSync(path, { force: true })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }
}

const removeWindowsProcessTreeProof = (proof: WindowsProcessTreeProof | undefined): void => {
  if (!proof) return
  rmSync(proof.path, { force: true })
  rmSync(proof.requestPath, { force: true })
}

export { KernelProcessLifecycleOwner, OWNER_TOKEN_ENV, defaultController }
export type {
  KernelProcessRecoveryOptions,
  KernelProcessLifecycleOwnerOptions,
  KernelProcessProbe,
  KernelProcessReceipt,
  KernelProcessRecord,
  KernelProcessRecoveryController,
  KernelProcessSpawnIntent,
  KernelProcessSpawnScope,
  WindowsProcessTreeProof
}
