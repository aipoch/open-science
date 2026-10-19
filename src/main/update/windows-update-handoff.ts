import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { retryFileReplacement } from '@aipoch/durable-files'
import { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from '../runtime-startup-options'

export const WINDOWS_UPDATE_OPERATION_ARG = '--open-science-update-operation='
const operationIdSchema = z.string().uuid()
const requestSchema = z
  .object({
    schema: z.literal(1),
    operationId: operationIdSchema,
    createdAt: z.number().int().nonnegative(),
    parentPid: z.number().int().positive(),
    helperPid: z.number().int().positive().optional(),
    successorPid: z.number().int().positive().optional(),
    targetVersion: z.string().min(1),
    applicationPath: z.string().refine(isAbsolute),
    installerPath: z.string().refine(isAbsolute),
    profilePath: z.string().refine(isAbsolute),
    startupOptions: runtimeStartupOptionsSchema
  })
  .strict()
export type WindowsUpdateRequest = z.infer<typeof requestSchema>

export interface WindowsUpdateHandoff {
  readonly operationId: string
  handoff(): void
  cancel(): void
}

// Prepare only the configuration lease. The signed NSIS installer owns installation UI,
// errors and successor launch; no detached presentation process is needed.
export async function prepareWindowsUpdateHandoff(
  appData: string,
  input: Parameters<typeof createWindowsUpdateRequest>[1]
): Promise<WindowsUpdateHandoff> {
  const { directory, request } = await createWindowsUpdateRequest(appData, input)
  let handedOff = false
  const receipt = (stage: string): void => {
    const destination = join(directory, `${stage}.receipt`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, windowsUpdateReceipt(request.operationId, stage), {
        flag: 'wx',
        mode: 0o600
      })
      renameSync(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  return {
    operationId: request.operationId,
    handoff() {
      receipt('handoff')
      handedOff = true
    },
    cancel() {
      // An installer may already be running after submission; retain its lease and never
      // claim it was cancelled. Pre-submission failures can use the existing aborted state.
      receipt(handedOff ? 'unconfirmed' : 'aborted')
    }
  }
}

// NSIS uses this same current-user app-data root. Never accept a receipt path from argv.
export const windowsUpdateHandoffRoot = (appData: string): string =>
  join(appData, 'Open-Science', 'UpdateHandoffs')

// Keep the original root first for existing installations and configuration leases.
// NSIS, uninstall and diagnostics use these same two fixed current-user locations.
const windowsUpdateHandoffRoots = (appData: string): string[] => [
  windowsUpdateHandoffRoot(appData),
  join(appData, 'Open-Science-UpdateHandoffs')
]

async function selectHandoffRoot(appData: string, applicationPath: string): Promise<string> {
  const installation = await realpath(dirname(applicationPath))
  for (const root of windowsUpdateHandoffRoots(appData)) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory()) throw new Error('Invalid update handoff storage')
    const offset = relative(installation, await realpath(root))
    if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return root
  }
  throw new Error('Update handoff storage must be outside the installation')
}

async function findHandoffDirectory(appData: string, operationId: string): Promise<string> {
  const matches: string[] = []
  for (const root of windowsUpdateHandoffRoots(appData)) {
    try {
      const directory = join(root, operationId)
      await lstat(directory)
      if (!(await lstat(root)).isDirectory()) throw new Error('Invalid update handoff storage')
      matches.push(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (matches.length !== 1) throw new Error('Missing or ambiguous update operation directory')
  return matches[0]
}

export const windowsUpdateOperation = (args: readonly string[]): string | undefined => {
  const values = args.filter((arg) => arg.startsWith(WINDOWS_UPDATE_OPERATION_ARG))
  if (!values.length) return undefined
  if (values.length !== 1) throw new Error('Ambiguous update operation')
  return operationIdSchema.parse(values[0].slice(WINDOWS_UPDATE_OPERATION_ARG.length))
}

export async function writeWindowsUpdateFile(
  path: string,
  contents: string | Buffer
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    // Windows readers can briefly deny replacement; retain the complete old file until publication.
    await retryFileReplacement(() => rename(temporary, path))
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function createWindowsUpdateRequest(
  appData: string,
  input: Pick<
    WindowsUpdateRequest,
    'targetVersion' | 'applicationPath' | 'installerPath' | 'profilePath' | 'startupOptions'
  >
): Promise<{ directory: string; request: WindowsUpdateRequest }> {
  const request = requestSchema.parse({
    targetVersion: input.targetVersion,
    applicationPath: input.applicationPath,
    installerPath: input.installerPath,
    profilePath: input.profilePath,
    startupOptions: input.startupOptions,
    schema: 1,
    operationId: randomUUID(),
    createdAt: Date.now(),
    parentPid: process.pid
  })
  const root = await selectHandoffRoot(appData, input.applicationPath)
  const directory = join(root, request.operationId)
  await mkdir(directory, { mode: 0o700 })
  try {
    await writeWindowsUpdateFile(join(directory, 'request.json'), JSON.stringify(request))
    return { directory, request }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function readRequest(directory: string, operationId: string): Promise<WindowsUpdateRequest> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid update operation directory')
  const path = join(directory, 'request.json')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid update operation request')
  const request = requestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (request.operationId !== operationId) throw new Error('Update operation identity mismatch')
  return request
}

export const windowsUpdateReceipt = (operationId: string, stage: string): string =>
  `${operationId}\r\n${stage}\r\n`

const sameWindowsPath = (left: string, right: string): boolean =>
  resolve(left).replaceAll('\\', '/').toLowerCase() ===
  resolve(right).replaceAll('\\', '/').toLowerCase()

type SuccessorIdentity = {
  appData: string
  args: readonly string[]
  version: string
  applicationPath: string
}

async function readInstalledRequest(
  options: SuccessorIdentity
): Promise<{ request: WindowsUpdateRequest; directory: string } | undefined> {
  const operationId = windowsUpdateOperation(options.args)
  if (!operationId) return undefined
  const directory = await findHandoffDirectory(options.appData, operationId)
  const request = await readRequest(directory, operationId)
  if (
    request.targetVersion !== options.version ||
    !sameWindowsPath(request.applicationPath, options.applicationPath) ||
    !sameWindowsPath(request.profilePath, request.startupOptions.profilePath)
  )
    throw new Error(
      'Updated application does not match the requested version, installation or profile'
    )
  const path = join(directory, 'installed.receipt')
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.size > 128 ||
    (await readFile(path, 'utf8')) !== windowsUpdateReceipt(operationId, 'installed')
  )
    throw new Error('The installer completion receipt is unavailable or invalid')
  return { request, directory }
}

// Restore the same configuration before selecting Chromium's profile or credential store.
// This does not bypass the normal startup credential and data checks.
export async function resolveWindowsUpdateStartup(
  options: SuccessorIdentity
): Promise<{ startupOptions: RuntimeStartupOptions; confirmed: boolean } | undefined> {
  const installed = await readInstalledRequest(options)
  if (!installed) return undefined
  const { request, directory } = installed
  // Electron relaunch retains argv. Keep this configuration lease while that successor lives,
  // including startup repair, so later relaunches can consume the same operation safely.
  request.successorPid = process.pid
  await writeWindowsUpdateFile(join(directory, 'request.json'), JSON.stringify(request))
  const readyPath = join(directory, 'ready.receipt')
  const confirmed = await lstat(readyPath)
    .then(async (stat) => {
      if (
        !stat.isFile() ||
        stat.size > 128 ||
        (await readFile(readyPath, 'utf8')) !== windowsUpdateReceipt(request.operationId, 'ready')
      )
        throw new Error('Invalid successor readiness receipt')
      return true
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
  // The original data assertion applies once, to the update. Later normal relaunches may follow a
  // user-committed data-folder migration and must read current settings rather than the old root.
  return { startupOptions: request.startupOptions, confirmed }
}

// This is presentation evidence, not installation authorization or a replacement for signature checks.
export async function acknowledgeWindowsUpdateReady(
  options: SuccessorIdentity & {
    profilePath: string
    waitForPresentation: () => Promise<void>
    verifyReady: (startupOptions: RuntimeStartupOptions) => Promise<void>
  }
): Promise<boolean> {
  const installed = await readInstalledRequest(options)
  if (!installed) return false
  const { request, directory } = installed
  if (!sameWindowsPath(request.profilePath, options.profilePath))
    throw new Error(
      'Updated application does not match the requested version, installation or profile'
    )
  await options.waitForPresentation()
  await options.verifyReady(request.startupOptions)
  await writeWindowsUpdateFile(
    join(directory, 'ready.receipt'),
    windowsUpdateReceipt(request.operationId, 'ready')
  )
  return true
}

const processMayBeAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// Exact UUID requests prove the scope; live/PID-reused processes and unknown files are preserved.
// A crashed installer with no terminal evidence is retained for diagnosis, never treated as success.
export async function cleanupWindowsUpdateHandoffs(appData: string): Promise<void> {
  for (const root of windowsUpdateHandoffRoots(appData)) {
    await cleanupWindowsUpdateHandoffRoot(root)
  }
}

async function cleanupWindowsUpdateHandoffRoot(root: string): Promise<void> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat?.isDirectory()) return
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  for (const entry of entries) {
    if (!entry.isDirectory() || !operationIdSchema.safeParse(entry.name).success) continue
    const directory = join(root, entry.name)
    try {
      const request = await readRequest(directory, entry.name)
      if (
        processMayBeAlive(request.parentPid) ||
        (request.helperPid && processMayBeAlive(request.helperPid)) ||
        (request.successorPid && processMayBeAlive(request.successorPid))
      )
        continue
      const files = await readdir(directory, { withFileTypes: true })
      const owned =
        /^(?:request\.json|config\.bin|helper\.exe|cancel|(?:accepted|installing|installed|failed|ready|closed|aborted|handoff|unconfirmed)\.receipt)(?:\.[0-9a-f-]{36}\.tmp|\.tmp)?$/
      if (files.some((file) => !file.isFile() || !owned.test(file.name))) continue
      const closed = await readFile(join(directory, 'closed.receipt'), 'utf8').catch(() => '')
      // Legacy helpers must confirm their own closure. Native-only attempts have no helper
      // and are judged by installer/successor receipts plus the owner liveness checks above.
      if (request.helperPid && closed !== windowsUpdateReceipt(request.operationId, 'closed'))
        continue
      const receipt = async (stage: string): Promise<boolean> =>
        (await readFile(join(directory, `${stage}.receipt`), 'utf8').catch(() => '')) ===
        windowsUpdateReceipt(request.operationId, stage)
      if ((await receipt('installed')) && (await receipt('ready'))) {
        // Electron can relaunch between two live PIDs while another profile runs cleanup. Preserve
        // the small configuration record until explicit uninstall; only discard the mapped helper
        // and its binary launch input after every recorded owner is gone.
        await rm(join(directory, 'helper.exe'), { force: true })
        await rm(join(directory, 'config.bin'), { force: true })
        continue
      }
      if (!(await receipt('aborted')) && !(await receipt('failed'))) continue
      await rm(directory, { recursive: true })
    } catch {
      /* Preserve unreadable, unowned or busy resources; a later startup can retry. */
    }
  }
}

// Use the application's own window events, not a process/window snapshot, so the readiness receipt
// confirms actual presentation as well as backend/data health.
export function waitForWindowsUpdateWindow(
  window:
    | {
        isDestroyed(): boolean
        isVisible(): boolean
        once(event: 'show' | 'closed', listener: () => void): unknown
        removeListener(event: 'show' | 'closed', listener: () => void): unknown
      }
    | undefined
): Promise<void> {
  if (!window || window.isDestroyed())
    return Promise.reject(new Error('Updated application window is unavailable'))
  if (window.isVisible()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.removeListener('show', shown)
      window.removeListener('closed', closed)
      if (error) reject(error)
      else resolve()
    }
    const shown = (): void => finish()
    const closed = (): void =>
      finish(new Error('Updated application window closed before presentation'))
    window.once('show', shown)
    window.once('closed', closed)
  })
}
