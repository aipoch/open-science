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
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  isOwnedPosixProcessGroupAlive,
  terminateOwnedPosixProcessGroupById,
  type ProcessTreeKillResult
} from '../process-tree'
import { readProcessStartToken } from './operation-recovery'
import { bootTokenProvesReboot, isValidBootToken, readBootToken } from './operation-journal'

const OWNER_TOKEN_ENV = 'OPEN_SCIENCE_KERNEL_OWNER_TOKEN'
const RECORD_VERSION = 1

type KernelProcessSpawnScope = Readonly<{
  laneKey: string
  processKey: string
  kernelEpochId: string
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
  commandIdentityMarker?: string
  bootToken?: string
}

type KernelProcessSpawnIntent = Readonly<{
  path: string
  activePath: (pid: number) => string
  record: KernelProcessRecord
}>

type KernelProcessReceipt = Readonly<{
  path: string
  receiptId: string
}>

type KernelProcessProbe = 'dead' | 'owned' | 'reused' | 'unknown'

type KernelProcessRecoveryController = Readonly<{
  probe(record: Readonly<KernelProcessRecord>): Promise<KernelProcessProbe>
  terminate(record: Readonly<KernelProcessRecord>): Promise<ProcessTreeKillResult>
}>

type KernelProcessLifecycleOwnerOptions = Readonly<{
  storageRoot: string
  ownerInstanceId?: string
  platform?: NodeJS.Platform
  controller?: KernelProcessRecoveryController
  readBootToken?: () => string | undefined
}>

const isPositivePid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const recordFilePrefix = (scope: KernelProcessSpawnScope): string =>
  createHash('sha256').update(`${scope.laneKey}\0${scope.processKey}`).digest('hex')

const writeRecordSync = (path: string, record: KernelProcessRecord): void => {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  const file = openSync(temporary, 'r')
  try {
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  renameSync(temporary, path)
}

const decodeRecord = (contents: string): KernelProcessRecord | undefined => {
  try {
    const value = JSON.parse(contents) as Partial<KernelProcessRecord>
    if (
      value.version !== RECORD_VERSION ||
      typeof value.receiptId !== 'string' ||
      typeof value.ownerInstanceId !== 'string' ||
      typeof value.ownerToken !== 'string' ||
      typeof value.platform !== 'string' ||
      typeof value.laneKey !== 'string' ||
      typeof value.processKey !== 'string' ||
      typeof value.kernelEpochId !== 'string' ||
      typeof value.spawnedAt !== 'number' ||
      !Number.isFinite(value.spawnedAt) ||
      (value.pid !== undefined && !isPositivePid(value.pid)) ||
      (value.processStartToken !== undefined && typeof value.processStartToken !== 'string') ||
      (value.commandIdentityMarker !== undefined &&
        typeof value.commandIdentityMarker !== 'string') ||
      (value.bootToken !== undefined && !isValidBootToken(value.bootToken))
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
    return capture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${record.pid}").CommandLine`
    ])
  }
  return capture('ps', ['eww', '-p', String(record.pid), '-o', 'command='])
}

const terminateWindowsPid = async (pid: number): Promise<ProcessTreeKillResult> => {
  await capture('taskkill.exe', ['/pid', String(pid), '/T', '/F'])
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!pidIsAlive(pid)) return { reaped: true }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  return { reaped: false }
}

const defaultController = (
  platform: NodeJS.Platform,
  currentBootToken: () => string | undefined = readBootToken
): KernelProcessRecoveryController => ({
  probe: async (record) => {
    if (record.platform !== platform) return 'dead'
    if (!record.pid) return 'unknown'

    if (platform !== 'win32') {
      const bootToken = currentBootToken()
      if (bootTokenProvesReboot(record.bootToken, bootToken)) return 'dead'
    }
    const alive = pidIsAlive(record.pid)
    if (platform !== 'win32') {
      const groupAlive = isOwnedPosixProcessGroupAlive(record.pid)
      if (!groupAlive) return 'dead'
      // Once the leader exits, its numeric group id is no longer tied to the persisted process
      // identity. A later group can reuse it during the same boot, so retain the fence rather than
      // authorizing a group signal from the number alone.
      if (!alive) return 'unknown'
    } else if (!alive) {
      return 'dead'
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
  terminate: (record) => {
    if (!record.pid) return Promise.resolve({ reaped: false })
    return platform === 'win32'
      ? terminateWindowsPid(record.pid)
      : terminateOwnedPosixProcessGroupById(record.pid)
  }
})

class KernelProcessLifecycleOwner {
  readonly ownerInstanceId: string
  private readonly directory: string
  private readonly platform: NodeJS.Platform
  private readonly controller: KernelProcessRecoveryController
  private readonly readBootToken: () => string | undefined
  private recovery: Promise<void> | undefined

  constructor(options: KernelProcessLifecycleOwnerOptions) {
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID()
    this.directory = join(options.storageRoot, 'runtime', 'kernel-processes')
    this.platform = options.platform ?? process.platform
    this.readBootToken = options.readBootToken ?? readBootToken
    this.controller = options.controller ?? defaultController(this.platform, this.readBootToken)
  }

  ensureReady(): Promise<void> {
    this.recovery ??= this.recoverRecords()
    return this.recovery
  }

  async recover(): Promise<void> {
    const recovery = this.recoverRecords()
    this.recovery = recovery
    await recovery
  }

  createOwnerToken(): string {
    return randomUUID()
  }

  beginSpawn(
    scope: KernelProcessSpawnScope,
    ownerToken = this.createOwnerToken()
  ): KernelProcessSpawnIntent {
    const prefix = recordFilePrefix(scope)
    mkdirSync(this.directory, { recursive: true })
    if (readdirSync(this.directory).some((name) => name.startsWith(`${prefix}.`))) {
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
      ...scope
    }
    writeRecordSync(path, record)
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
      commandIdentityMarker?: string
    }>
  ): KernelProcessReceipt {
    if (!isPositivePid(child.pid)) throw new Error('Kernel process did not expose a valid pid.')
    const record = {
      ...intent.record,
      pid: child.pid,
      ...(child.processStartToken ? { processStartToken: child.processStartToken } : {}),
      ...(child.commandIdentityMarker ? { commandIdentityMarker: child.commandIdentityMarker } : {})
    }
    const activePath = intent.activePath(child.pid)
    try {
      renameSync(intent.path, activePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync(activePath)) throw error
    }
    writeRecordSync(activePath, record)
    return { path: activePath, receiptId: record.receiptId }
  }

  abandonSpawn(intent: KernelProcessSpawnIntent): void {
    this.removeIfOwned(intent.path, intent.record.receiptId)
  }

  complete(receipt: KernelProcessReceipt, reaped: boolean): void {
    if (reaped) this.removeIfOwned(receipt.path, receipt.receiptId)
  }

  environment(ownerToken: string): NodeJS.ProcessEnv {
    return { [OWNER_TOKEN_ENV]: ownerToken }
  }

  private async recoverRecords(): Promise<void> {
    let names: string[]
    try {
      names = readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const blocked: string[] = []
    for (const name of names) {
      const path = join(this.directory, name)
      if (name.includes('.pending.')) {
        // The process host and recovery race through an atomic rename. Recovery winning this claim
        // guarantees the host can no longer activate or execute the kernel; a host that won first
        // has already published an active filename containing its PID.
        const cancelledPath = `${path}.cancelled-${this.ownerInstanceId}`
        try {
          renameSync(path, cancelledPath)
          rmSync(cancelledPath, { force: true })
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
      if (!record) {
        blocked.push(name)
        continue
      }
      if (record.ownerInstanceId === this.ownerInstanceId) continue
      if (!record.pid) {
        const encodedPid = name.match(/\.active\.(\d+)\./)?.[1]
        if (encodedPid && isPositivePid(Number(encodedPid))) record.pid = Number(encodedPid)
      }
      const probe = await this.controller.probe(record)
      if (probe === 'dead' || probe === 'reused') {
        this.removeIfOwned(path, record.receiptId)
        continue
      }
      if (probe === 'owned') {
        const result = await this.controller.terminate(record)
        if (result.reaped) {
          this.removeIfOwned(path, record.receiptId)
          continue
        }
      }
      blocked.push(`${record.laneKey}:${record.processKey}`)
    }
    if (blocked.length > 0) {
      throw new Error(
        `KERNEL_STARTUP_FENCE: could not prove old persistent process ownership was cleared (${blocked.join(', ')}).`
      )
    }
  }

  private removeIfOwned(path: string, receiptId: string): void {
    try {
      const current = decodeRecord(readFileSync(path, 'utf8'))
      if (current?.receiptId === receiptId) rmSync(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export { KernelProcessLifecycleOwner, OWNER_TOKEN_ENV, defaultController }
export type {
  KernelProcessLifecycleOwnerOptions,
  KernelProcessProbe,
  KernelProcessReceipt,
  KernelProcessRecord,
  KernelProcessRecoveryController,
  KernelProcessSpawnIntent,
  KernelProcessSpawnScope
}
