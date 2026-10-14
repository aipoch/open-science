import { systemBootIdentity } from '../system-boot-identity'
import { cancelDebSystemdGate, type DebSystemdGate } from './deb-systemd-gate'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { installationFs } from './installation-filesystem'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  inspectInstallationProcesses,
  inspectInstallationProcessesAsync
} from './installation-occupancy'
import { UpdateLifecycleError, type UpdateRecoveryStatus } from '../../shared/update'
import { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from '../runtime-startup-options'

const {
  createReadStream,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = installationFs
const { readdir, readlink, realpath, stat } = installationFs.promises

export type InstallationLocation = { installationRoot: string; stateRoot?: string }
export type InstallationRuntime = {
  pid: number
  generation: string
  configRoot: string
  role?: 'helper'
  owner?: { pid: number; generation: string; configRoot: string }
}
export type InstallationManifest = { version: string; files: Record<string, string> }
export type InstallationUpdateRecord = {
  schema: 1
  operationId: string
  installationRoot: string
  targetVersion: string
  bootIdentity?: string
  phase: 'preparing' | 'stopping' | 'stopped' | 'handoff'
  startupOptions: RuntimeStartupOptions
  runtime: InstallationRuntime
  oldManifest: InstallationManifest
  targetManifest?: InstallationManifest
  stoppedClean?: boolean
  preparedDebGate?: DebSystemdGate
  executor?: {
    channel: 'supervised-mac' | 'supervised-appimage' | 'supervised-deb'
    directory: string
    requestSha256: string
  }
}

const installationStartupTicketSchema = z
  .object({
    schema: z.literal(1),
    intent: z.enum(['cancel', 'complete']),
    operationId: z.string().min(1),
    installationRoot: z.string().refine(isAbsolute),
    startupOptions: runtimeStartupOptionsSchema,
    manifest: z
      .object({ version: z.string().min(1), files: z.record(z.string(), z.string()) })
      .strict()
  })
  .strict()
export type InstallationStartupTicket = z.infer<typeof installationStartupTicketSchema>
function readStartupTicket(directory: string): InstallationStartupTicket | undefined {
  const path = join(directory, 'verified-startup.json')
  if (!existsSync(path)) return undefined
  try {
    return installationStartupTicketSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (cause) {
    throw new UpdateLifecycleError(
      'install-failed',
      'The verified startup configuration cannot be read.',
      undefined,
      { cause }
    )
  }
}
/** Configuration survives marker removal and a crash before the first successful data read. */
export function inspectInstallationStartup(
  location: InstallationLocation
): InstallationStartupTicket | undefined {
  return coordinated(location, (directory) => {
    const ticket = readStartupTicket(directory)
    if (
      ticket &&
      (ticket.installationRoot !== realpathSync(location.installationRoot) ||
        !verifyInstallationManifest(location.installationRoot, ticket.manifest))
    )
      throw new UpdateLifecycleError(
        'install-failed',
        'The verified startup installation has changed.'
      )
    return ticket
  })
}
export function completeInstallationStartup(
  location: InstallationLocation,
  operationId: string
): void {
  coordinated(location, (directory) => {
    const ticket = readStartupTicket(directory)
    if (!ticket || ticket.operationId !== operationId)
      throw new UpdateLifecycleError(
        'install-failed',
        'The verified startup operation has changed.'
      )
    if (!verifyInstallationManifest(location.installationRoot, ticket.manifest))
      throw new UpdateLifecycleError(
        'install-failed',
        'The verified startup installation has changed.'
      )
    rmSync(join(directory, 'verified-startup.json'))
  })
}

// This location is shared across config roots and is deliberately outside replacement resources.
export { installationRootForEntry } from '../../../packages/open-science/installation-startup.cjs'
import { reapStaleRegistrations } from '../../../packages/open-science/installation-startup.cjs'
export function installationStateDirectory(location: InstallationLocation): string {
  // Resolve existing parents too: recovery must find the record when resources are missing.
  let root = resolve(location.installationRoot)
  let suffix = ''
  while (!existsSync(root)) {
    suffix = join(root.slice(dirname(root).length + 1), suffix)
    root = dirname(root)
  }
  const canonical = resolve(realpathSync(root), suffix)
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
  return join(
    location.stateRoot ??
      process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT ??
      (process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
        ? join(process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT, 'installations')
        : join(homedir(), '.open-science', 'installations')),
    key
  )
}
function acquireLock(path: string): () => void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE')
  } catch (cause) {
    db.close()
    throw new UpdateLifecycleError(
      'installation-busy',
      'Installation coordination is busy.',
      undefined,
      { cause }
    )
  }
  let closed = false
  return () => {
    if (!closed) {
      closed = true
      db.close()
    }
  }
}
function coordinated<T>(location: InstallationLocation, run: (directory: string) => T): T {
  const directory = installationStateDirectory(location)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const unlock = acquireLock(join(directory, 'coordinator.sqlite'))
  try {
    return run(directory)
  } finally {
    unlock()
  }
}
function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  // Windows cannot open a directory handle through Node; the file itself is still flushed.
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
}
function readRecord(directory: string): InstallationUpdateRecord | undefined {
  const path = join(directory, 'update-in-progress.json')
  if (!existsSync(path)) return undefined
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as InstallationUpdateRecord
    if (
      record.schema !== 1 ||
      !record.operationId ||
      !record.installationRoot ||
      !record.oldManifest ||
      !['preparing', 'stopping', 'stopped', 'handoff'].includes(record.phase)
    )
      throw new Error('Invalid update record')
    runtimeStartupOptionsSchema.parse(record.startupOptions)
    if (
      !Number.isInteger(record.runtime?.pid) ||
      !record.runtime.generation ||
      !isAbsolute(record.runtime.configRoot)
    )
      throw new Error('Invalid runtime identity')
    if (!isAbsolute(record.installationRoot) || typeof record.targetVersion !== 'string')
      throw new Error('Invalid installation identity')
    const allowed = new Set([
      'schema',
      'operationId',
      'installationRoot',
      'targetVersion',
      'phase',
      'startupOptions',
      'runtime',
      'oldManifest',
      'targetManifest',
      'stoppedClean',
      'executor',
      'preparedDebGate',
      'bootIdentity'
    ])
    if (Object.keys(record).some((key) => !allowed.has(key)))
      throw new Error('Unexpected recovery data')
    if (record.preparedDebGate) {
      const gate = record.preparedDebGate
      if (
        !/^[a-f0-9-]{36}$/.test(gate.nonce) ||
        gate.unit !== `open-science-install-${gate.nonce}.service` ||
        gate.stateDirectory !== `/var/lib/open-science-updates/${gate.nonce}` ||
        !/^[a-f0-9]{64}$/.test(gate.binding) ||
        !isAbsolute(gate.directory) ||
        relative(directory, gate.directory).startsWith('..') ||
        Object.keys(gate).some(
          (key) =>
            !['nonce', 'unit', 'directory', 'stateDirectory', 'binding', 'bootIdentity'].includes(
              key
            )
        )
      )
        throw new Error('Invalid prepared package gate')
    }
    return record
  } catch (cause) {
    throw new UpdateLifecycleError(
      'install-failed',
      'The installation recovery record cannot be read.',
      undefined,
      { cause }
    )
  }
}
export function inspectInstallationUpdate(
  location: InstallationLocation
): InstallationUpdateRecord | undefined {
  return coordinated(location, readRecord)
}
export function assertInstallationStartupAllowed(
  installationRoot: string,
  stateRoot?: string
): void {
  coordinated({ installationRoot, stateRoot }, (directory) => {
    if (readRecord(directory))
      throw new UpdateLifecycleError(
        'installation-busy',
        'An installation update requires recovery before starting a service.'
      )
  })
}
// Registration and update admission use the same lock. The lifetime lock is never deleted: stale
// registrations are detected by acquiring their kernel lock, without trusting PID reuse or a timer.
export function registerInstallationRuntime(
  options: InstallationLocation & Omit<InstallationRuntime, 'pid'> & { pid?: number }
): { release(): void } {
  return coordinated(options, (directory) => {
    if (readRecord(directory))
      throw new UpdateLifecycleError('installation-busy', 'An installation update is in progress.')
    reapStaleRegistrations(directory)
    const id = randomUUID()
    const helperToken = randomUUID()
    const unlock = acquireLock(join(directory, `${id}.sqlite`))
    try {
      atomicWrite(join(directory, `${id}.json`), {
        pid: options.pid ?? process.pid,
        generation: options.generation,
        configRoot: options.configRoot,
        helperTokenHash: createHash('sha256').update(helperToken).digest('hex')
      })
    } catch (error) {
      unlock()
      throw error
    }
    // Agent homes may be isolated; helpers must still validate against this installation's leases.
    process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT = resolve(dirname(directory))
    process.env.OPEN_SCIENCE_INSTALLATION_OWNER = JSON.stringify({
      pid: options.pid ?? process.pid,
      generation: options.generation,
      configRoot: options.configRoot,
      token: helperToken
    })
    const bootstrap = (globalThis as unknown as Record<symbol, { release(): void } | undefined>)[
      Symbol.for('open-science.installation-bootstrap')
    ]
    bootstrap?.release()
    return { release: unlock }
  })
}
function occupants(directory: string): InstallationRuntime[] {
  const live: InstallationRuntime[] = []
  reapStaleRegistrations(directory)
  for (const name of readdirSync(directory).filter((name) => /^[\da-f-]{36}\.json$/.test(name))) {
    let unlock: (() => void) | undefined
    try {
      unlock = acquireLock(join(directory, name.replace(/\.json$/, '.sqlite')))
    } catch (error) {
      if (!(error instanceof UpdateLifecycleError)) throw error
      try {
        const runtime = JSON.parse(
          readFileSync(join(directory, name), 'utf8')
        ) as InstallationRuntime
        if (!Number.isInteger(runtime.pid) || !runtime.generation || !runtime.configRoot)
          throw new Error('Invalid registration')
        live.push(runtime)
      } catch (cause) {
        throw new UpdateLifecycleError(
          'installation-busy',
          'Installation occupancy is unknown.',
          undefined,
          { cause }
        )
      }
    } finally {
      unlock?.()
    }
  }
  return live
}
export function captureInstallationManifest(
  installationRoot: string,
  version: string
): InstallationManifest {
  const root = realpathSync(installationRoot)
  const files: Record<string, string> = {}
  if (statSync(root).isFile())
    return {
      version,
      files: { '@image': createHash('sha256').update(readFileSync(root)).digest('hex') }
    }
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        const canonical = realpathSync(path)
        const rel = relative(root, canonical)
        if (
          rel.startsWith('..') ||
          isAbsolute(rel) ||
          (!entry.isSymbolicLink() && !statSync(path).isFile())
        )
          throw new Error('Installation contains an unsupported external link or file.')
        files[relative(root, path)] = entry.isSymbolicLink()
          ? `symlink:${readlinkSync(path)}`
          : createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  walk(root)
  if (!Object.keys(files).length) throw new Error('Installation is empty.')
  return { version, files }
}
export function verifyInstallationManifest(
  installationRoot: string,
  expected: InstallationManifest
): boolean {
  try {
    const actual = captureInstallationManifest(installationRoot, expected.version)
    return (
      Object.keys(actual.files).length === Object.keys(expected.files).length &&
      Object.entries(expected.files).every(([path, hash]) => actual.files[path] === hash)
    )
  } catch {
    return false
  }
}
export function installationRecoveryStatus(record: InstallationUpdateRecord): UpdateRecoveryStatus {
  return {
    operationId: record.operationId,
    phase: record.phase,
    runtime:
      record.phase === 'preparing' ? 'running' : record.stoppedClean ? 'stopped-clean' : 'unknown',
    installation: record.phase === 'handoff' ? 'unknown' : 'unchanged',
    canCancel: record.phase !== 'handoff',
    canRetryInstall: record.phase === 'stopped' && record.stoppedClean === true,
    canRecover: true
  }
}
export function beginInstallationUpdate(
  options: InstallationLocation & {
    targetVersion: string
    currentVersion: string
    startupOptions: RuntimeStartupOptions
    runtime: InstallationRuntime
    targetManifest?: InstallationManifest
    currentManifest?: InstallationManifest
    preparedDebGate?: DebSystemdGate
    inspectProcesses?: (root: string) => number[]
    allowedProcessIds?: number[]
  }
): InstallationUpdateRecord {
  return coordinated(options, (directory) => {
    if (readRecord(directory) || readStartupTicket(directory))
      throw new UpdateLifecycleError(
        'installation-busy',
        'An installation update already requires recovery.'
      )
    const registered = occupants(directory)
    const ownHelper = (runtime: InstallationRuntime): boolean =>
      isOwnedInstallationHelper(runtime, options.runtime)
    const helperPids = new Set(registered.filter(ownHelper).map((runtime) => runtime.pid))
    const processPids = (options.inspectProcesses ?? inspectInstallationProcesses)(
      realpathSync(options.installationRoot)
    )
    if (
      processPids.some(
        (pid) =>
          pid !== process.pid &&
          pid !== options.runtime.pid &&
          !helperPids.has(pid) &&
          !options.allowedProcessIds?.includes(pid)
      )
    )
      throw new UpdateLifecycleError(
        'installation-busy',
        'Another process is using this installation.'
      )
    const others = registered.filter(
      (runtime) =>
        !ownHelper(runtime) &&
        (runtime.pid !== options.runtime.pid ||
          runtime.generation !== options.runtime.generation ||
          runtime.configRoot !== options.runtime.configRoot)
    )
    if (others.length)
      throw new UpdateLifecycleError(
        'installation-busy',
        'Another service is using this installation.'
      )
    const record: InstallationUpdateRecord = {
      schema: 1,
      operationId: randomUUID(),
      installationRoot: realpathSync(options.installationRoot),
      targetVersion: options.targetVersion,
      phase: 'preparing',
      bootIdentity: systemBootIdentity(),
      startupOptions: runtimeStartupOptionsSchema.parse(options.startupOptions),
      runtime: {
        pid: options.runtime.pid,
        generation: options.runtime.generation,
        configRoot: options.runtime.configRoot
      },
      oldManifest:
        options.currentManifest ??
        captureInstallationManifest(options.installationRoot, options.currentVersion),
      ...(options.targetManifest ? { targetManifest: options.targetManifest } : {}),
      ...(options.preparedDebGate ? { preparedDebGate: options.preparedDebGate } : {})
    }
    atomicWrite(join(directory, 'update-in-progress.json'), record)
    return record
  })
}
export function advanceInstallationUpdate(
  location: InstallationLocation,
  operationId: string,
  phase: InstallationUpdateRecord['phase'],
  stoppedClean?: boolean
): InstallationUpdateRecord {
  return coordinated(location, (directory) => {
    const record = readRecord(directory)
    if (!record || record.operationId !== operationId)
      throw new UpdateLifecycleError('install-failed', 'The installation operation has changed.')
    const phases = ['preparing', 'stopping', 'stopped', 'handoff']
    if (phases.indexOf(phase) !== phases.indexOf(record.phase) + 1)
      throw new UpdateLifecycleError('install-failed', 'Invalid installation phase transition.')
    if (phase === 'stopped' && stoppedClean !== true)
      throw new UpdateLifecycleError(
        'runtime-stop-unclean',
        'Service shutdown was not confirmed clean.'
      )
    if (
      phase === 'handoff' &&
      (!record.targetManifest || record.targetManifest.version !== record.targetVersion)
    )
      throw new UpdateLifecycleError(
        'install-failed',
        'A verified target installation manifest is required before installer handoff.'
      )
    if (phase === 'handoff' && (!record.stoppedClean || occupants(directory).length))
      throw new UpdateLifecycleError('installation-busy', 'Services still hold this installation.')
    const next = { ...record, phase, ...(stoppedClean === undefined ? {} : { stoppedClean }) }
    atomicWrite(join(directory, 'update-in-progress.json'), next)
    return next
  })
}
// Checking never starts an installer and never clears the protection. A trusted target manifest
// must originate from the verified downloaded package, not from the installation being checked.
export function checkInstallationResult(
  location: InstallationLocation
): 'unchanged' | 'verified' | 'incomplete' {
  return coordinated(location, (directory) => {
    const record = readRecord(directory)
    if (!record)
      throw new UpdateLifecycleError('install-failed', 'No installation operation is available.')
    if (record.phase === 'handoff') assertInstallationExecutorSettled(record)
    if (
      record.targetManifest &&
      record.targetManifest.version === record.targetVersion &&
      verifyInstallationManifest(location.installationRoot, record.targetManifest)
    )
      return 'verified'
    return verifyInstallationManifest(location.installationRoot, record.oldManifest)
      ? 'unchanged'
      : 'incomplete'
  })
}
export function finishInstallationRecovery(
  location: InstallationLocation,
  operationId: string,
  intent: 'cancel' | 'complete'
): RuntimeStartupOptions {
  return coordinated(location, (directory) => {
    const record = readRecord(directory)
    if (!record || record.operationId !== operationId)
      throw new UpdateLifecycleError('install-failed', 'The installation operation has changed.')
    if (intent === 'complete' && record.phase !== 'handoff')
      throw new UpdateLifecycleError(
        'install-failed',
        'Only a settled installer handoff can complete an update.'
      )
    if (
      record.phase === 'handoff' &&
      assertInstallationExecutorSettled(record) !==
        (intent === 'complete' ? 'installed' : 'rolled-back')
    )
      throw new UpdateLifecycleError(
        'install-failed',
        'The installer has already received this operation.'
      )
    if (record.preparedDebGate && record.phase !== 'handoff')
      throw new UpdateLifecycleError(
        'install-failed',
        'Package gate cancellation requires asynchronous verification.'
      )
    const expected = intent === 'cancel' ? record.oldManifest : record.targetManifest
    if (
      !expected ||
      (intent === 'complete' && expected.version !== record.targetVersion) ||
      !verifyInstallationManifest(location.installationRoot, expected)
    )
      throw new UpdateLifecycleError(
        'install-failed',
        'Installation integrity could not be verified.'
      )
    if (intent === 'complete' && occupants(directory).length)
      throw new UpdateLifecycleError('installation-busy', 'Services still hold this installation.')
    // Write and fsync the successor before removing protection: any crash leaves either the
    // update record or this verified ticket carrying the same reviewed configuration.
    atomicWrite(join(directory, 'verified-startup.json'), {
      schema: 1,
      intent,
      operationId,
      installationRoot: record.installationRoot,
      startupOptions: record.startupOptions,
      manifest: expected
    } satisfies InstallationStartupTicket)
    rmSync(join(directory, 'update-in-progress.json'))
    return record.startupOptions
  })
}

// Production callers use the async path so large signed bundles do not freeze progress/cancel UI.
export async function captureInstallationManifestAsync(
  installationRoot: string,
  version: string,
  signal?: AbortSignal
): Promise<InstallationManifest> {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  signal.throwIfAborted()
  const root = await realpath(installationRoot)
  const files: Record<string, string> = {}
  if ((await stat(root)).isFile()) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(root, { signal })) hash.update(chunk)
    return { version, files: { '@image': hash.digest('hex') } }
  }
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const canonical = await realpath(path)
      const rel = relative(root, canonical)
      if (
        rel.startsWith('..') ||
        isAbsolute(rel) ||
        (!entry.isSymbolicLink() && !(await stat(path)).isFile())
      )
        throw new Error('Unsupported installation link or file.')
      if (entry.isSymbolicLink()) {
        files[relative(root, path)] = `symlink:${await readlink(path)}`
        continue
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
      files[relative(root, path)] = hash.digest('hex')
    }
  }
  await walk(root)
  if (!Object.keys(files).length) throw new Error('Installation is empty.')
  return { version, files }
}
export async function beginInstallationUpdateAsync(
  options: Parameters<typeof beginInstallationUpdate>[0],
  signal?: AbortSignal
): Promise<InstallationUpdateRecord> {
  const currentManifest = await captureInstallationManifestAsync(
    options.installationRoot,
    options.currentVersion,
    signal
  )
  signal?.throwIfAborted()
  const processIds = options.inspectProcesses
    ? options.inspectProcesses(options.installationRoot)
    : await inspectInstallationProcessesAsync(options.installationRoot, signal)
  signal?.throwIfAborted()
  return beginInstallationUpdate({
    ...options,
    currentManifest,
    inspectProcesses: () => processIds
  })
}

export async function verifyInstallationManifestAsync(
  installationRoot: string,
  expected: InstallationManifest,
  signal?: AbortSignal
): Promise<boolean> {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  try {
    const actual = await captureInstallationManifestAsync(
      installationRoot,
      expected.version,
      signal
    )
    return (
      Object.keys(actual.files).length === Object.keys(expected.files).length &&
      Object.entries(expected.files).every(([path, hash]) => actual.files[path] === hash)
    )
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  }
}
function unchangedSnapshot(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new UpdateLifecycleError(
      'install-failed',
      'The installation operation changed during verification.'
    )
}
export async function inspectInstallationStartupAsync(
  location: InstallationLocation,
  signal?: AbortSignal
): Promise<InstallationStartupTicket | undefined> {
  const ticket = coordinated(location, readStartupTicket)
  if (!ticket) return undefined
  // Match the writer's path spelling: native realpath expands Windows 8.3 names.
  if (
    ticket.installationRoot !== realpathSync(location.installationRoot) ||
    !(await verifyInstallationManifestAsync(location.installationRoot, ticket.manifest, signal))
  )
    throw new UpdateLifecycleError(
      'install-failed',
      'The verified startup installation has changed.'
    )
  coordinated(location, (directory) => unchangedSnapshot(readStartupTicket(directory), ticket))
  return ticket
}
export async function completeInstallationStartupAsync(
  location: InstallationLocation,
  operationId: string,
  signal?: AbortSignal
): Promise<void> {
  const ticket = await inspectInstallationStartupAsync(location, signal)
  if (!ticket || ticket.operationId !== operationId)
    throw new UpdateLifecycleError('install-failed', 'The verified startup operation has changed.')
  coordinated(location, (directory) => {
    unchangedSnapshot(readStartupTicket(directory), ticket)
    rmSync(join(directory, 'verified-startup.json'))
  })
}
export async function checkInstallationResultAsync(
  location: InstallationLocation,
  signal?: AbortSignal
): Promise<'unchanged' | 'verified' | 'incomplete'> {
  const record = inspectInstallationUpdate(location)
  if (!record)
    throw new UpdateLifecycleError('install-failed', 'No installation operation is available.')
  if (record.phase === 'handoff') assertInstallationExecutorSettled(record)
  let result: 'unchanged' | 'verified' | 'incomplete' = 'incomplete'
  if (
    record.targetManifest?.version === record.targetVersion &&
    (await verifyInstallationManifestAsync(
      location.installationRoot,
      record.targetManifest,
      signal
    ))
  )
    result = 'verified'
  else if (
    await verifyInstallationManifestAsync(location.installationRoot, record.oldManifest, signal)
  )
    result = 'unchanged'
  coordinated(location, (directory) => unchangedSnapshot(readRecord(directory), record))
  return result
}
export async function finishInstallationRecoveryAsync(
  location: InstallationLocation,
  operationId: string,
  intent: 'cancel' | 'complete',
  signal?: AbortSignal
): Promise<RuntimeStartupOptions> {
  const record = inspectInstallationUpdate(location)
  if (!record || record.operationId !== operationId)
    throw new UpdateLifecycleError('install-failed', 'The installation operation has changed.')
  if (intent === 'complete' && record.phase !== 'handoff')
    throw new UpdateLifecycleError(
      'install-failed',
      'Only a settled installer handoff can complete an update.'
    )
  if (
    record.phase === 'handoff' &&
    assertInstallationExecutorSettled(record) !==
      (intent === 'complete' ? 'installed' : 'rolled-back')
  )
    throw new UpdateLifecycleError(
      'install-failed',
      'The installer has already received this operation.'
    )
  if (record.preparedDebGate && record.phase !== 'handoff')
    await cancelDebSystemdGate(record.preparedDebGate)
  const expected = intent === 'cancel' ? record.oldManifest : record.targetManifest
  if (
    !expected ||
    (intent === 'complete' && expected.version !== record.targetVersion) ||
    !(await verifyInstallationManifestAsync(location.installationRoot, expected, signal))
  )
    throw new UpdateLifecycleError(
      'install-failed',
      'Installation integrity could not be verified.'
    )
  return coordinated(location, (directory) => {
    unchangedSnapshot(readRecord(directory), record)
    if (intent === 'complete' && occupants(directory).length)
      throw new UpdateLifecycleError('installation-busy', 'Services still hold this installation.')
    atomicWrite(join(directory, 'verified-startup.json'), {
      schema: 1,
      intent,
      operationId,
      installationRoot: record.installationRoot,
      startupOptions: record.startupOptions,
      manifest: expected
    } satisfies InstallationStartupTicket)
    rmSync(join(directory, 'update-in-progress.json'))
    return record.startupOptions
  })
}

export async function advanceInstallationUpdateAsync(
  location: InstallationLocation,
  operationId: string,
  phase: InstallationUpdateRecord['phase'],
  stoppedClean?: boolean,
  options: {
    allowedProcessIds?: number[]
    signal?: AbortSignal
    inspectProcesses?: (root: string, signal?: AbortSignal) => Promise<number[]>
  } = {}
): Promise<InstallationUpdateRecord> {
  if (phase === 'handoff') {
    const processIds = await (options.inspectProcesses ?? inspectInstallationProcessesAsync)(
      location.installationRoot,
      options.signal
    )
    if (processIds.some((pid) => pid !== process.pid && !options.allowedProcessIds?.includes(pid)))
      throw new UpdateLifecycleError(
        'installation-busy',
        'Another process is using this installation.'
      )
  }
  options.signal?.throwIfAborted()
  return advanceInstallationUpdate(location, operationId, phase, stoppedClean)
}

/** Read-only occupancy preflight; it neither acquires update admission nor stops any service. */
export async function inspectInstallationAvailability(
  options: InstallationLocation & {
    runtime?: InstallationRuntime
    allowedProcessIds?: number[] | (() => number[])
    inspectProcesses?: typeof inspectInstallationProcessesAsync
  },
  signal?: AbortSignal
): Promise<void> {
  let processes: number[]
  try {
    processes = await (options.inspectProcesses ?? inspectInstallationProcessesAsync)(
      options.installationRoot,
      signal
    )
  } catch (cause) {
    signal?.throwIfAborted()
    throw new UpdateLifecycleError(
      'installation-busy',
      'Installation occupancy could not be verified.',
      {
        phase: 'preparing',
        runtime: 'running',
        installation: 'unchanged',
        canCancel: true,
        canRecover: false,
        canRetryInstall: false,
        detail: 'occupancy-unknown'
      },
      { cause }
    )
  }
  signal?.throwIfAborted()
  coordinated(options, (directory) => {
    const allowedProcessIds =
      typeof options.allowedProcessIds === 'function'
        ? options.allowedProcessIds()
        : options.allowedProcessIds
    const bootstrap = (
      globalThis as typeof globalThis & {
        [key: symbol]:
          | {
              identity?: InstallationRuntime & { installationRoot: string }
              isHeld?: () => boolean
            }
          | undefined
      }
    )[Symbol.for('open-science.installation-bootstrap')]
    const ownBootstrap = (candidate: InstallationRuntime): boolean =>
      !!(
        allowedProcessIds?.includes(process.pid) &&
        bootstrap?.isHeld?.() &&
        bootstrap.identity?.installationRoot === realpathSync(options.installationRoot) &&
        candidate.pid === process.pid &&
        candidate.pid === bootstrap.identity.pid &&
        candidate.generation === bootstrap.identity.generation &&
        candidate.configRoot === bootstrap.identity.configRoot
      )
    const registered = occupants(directory)
    const helperPids = new Set(
      registered
        .filter((candidate) => isOwnedInstallationHelper(candidate, options.runtime))
        .map((candidate) => candidate.pid)
    )
    const others = registered.filter(
      (candidate) =>
        !ownBootstrap(candidate) &&
        !isOwnedInstallationHelper(candidate, options.runtime) &&
        (candidate.pid !== options.runtime?.pid ||
          candidate.generation !== options.runtime?.generation ||
          candidate.configRoot !== options.runtime?.configRoot)
    )
    if (
      others.length ||
      processes.some(
        (pid) =>
          pid !== process.pid &&
          pid !== options.runtime?.pid &&
          !helperPids.has(pid) &&
          !allowedProcessIds?.includes(pid)
      )
    )
      throw new UpdateLifecycleError(
        'installation-busy',
        'Another process is using this installation.',
        {
          phase: 'preparing',
          runtime: 'running',
          installation: 'unchanged',
          canCancel: true,
          canRecover: false,
          canRetryInstall: false,
          detail: 'other-runtime'
        }
      )
  })
}

export function bindInstallationExecutor(
  location: InstallationLocation,
  operationId: string,
  executor: NonNullable<InstallationUpdateRecord['executor']>
): void {
  coordinated(location, (directory) => {
    const record = readRecord(directory)
    if (
      !record ||
      record.operationId !== operationId ||
      record.phase !== 'handoff' ||
      record.executor
    )
      throw new UpdateLifecycleError(
        'install-failed',
        'The installation executor cannot be assigned to this operation.'
      )
    atomicWrite(join(directory, 'update-in-progress.json'), { ...record, executor })
  })
}
export function assertInstallationExecutorSettled(
  record: InstallationUpdateRecord
): 'installed' | 'rolled-back' {
  if (!record.executor)
    throw new UpdateLifecycleError(
      'install-failed',
      'The installation executor has not provided completion evidence.',
      installationRecoveryStatus(record)
    )
  let unlock: (() => void) | undefined
  try {
    unlock = acquireLock(join(record.executor.directory, 'executor.sqlite'))
    const requestBytes = readFileSync(join(record.executor.directory, 'request.json'))
    if (createHash('sha256').update(requestBytes).digest('hex') !== record.executor.requestSha256)
      throw new Error('Installation request changed')
    const receipt = JSON.parse(readFileSync(join(record.executor.directory, 'result.json'), 'utf8'))
    if (
      receipt.operationId !== record.operationId ||
      receipt.requestSha256 !== record.executor.requestSha256 ||
      !['installed', 'rolled-back'].includes(receipt.outcome)
    )
      throw new Error('Unsettled installation receipt')
    // The lifetime lock is kernel-released only after all synchronous replacement/rollback writes
    // and the durable result. The executor never releases it early or mutates after result.json.
    return receipt.outcome
  } catch (cause) {
    throw new UpdateLifecycleError(
      'install-failed',
      'The installation executor has not settled; startup remains protected.',
      installationRecoveryStatus(record),
      { cause }
    )
  } finally {
    unlock?.()
  }
}

function isOwnedInstallationHelper(
  candidate: InstallationRuntime,
  runtime?: InstallationRuntime
): boolean {
  return (
    !!runtime &&
    candidate.role === 'helper' &&
    candidate.owner?.pid === runtime.pid &&
    candidate.owner.generation === runtime.generation &&
    candidate.owner.configRoot === runtime.configRoot &&
    candidate.configRoot === runtime.configRoot
  )
}
