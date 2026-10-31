import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  createReadStream,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { retryFileReplacement } from '@aipoch/durable-files'
import { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from '../runtime-startup-options'
import {
  acquireNativeInstallationUpdate,
  advanceNativeInstallationUpdate,
  claimNativeInstallationUpdateRecovery,
  readNativeInstallationUpdate,
  releaseNativeInstallationUpdate,
  type InstallationLocation
} from './installation-protection'
import { isWindowsInstallationWriterActive } from './windows-installation-processes'

// electron-builder's UUID.v5(com.aipoch.open-science, its NSIS namespace). The installer owns
// this same mutex through its last write and launch; probing it never grants write authority.
export const WINDOWS_INSTALLER_MUTEX = 'a65c5229-0b29-5716-a0fe-d8755e62f3ca'

export const WINDOWS_UPDATE_OPERATION_ARG = '--open-science-update-operation='
const operationIdSchema = z.string().uuid()
const installerUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  })
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
    installerUrl: installerUrlSchema.optional(),
    installerSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
  input: Parameters<typeof createWindowsUpdateRequest>[1],
  admission?: { installerSha512: string; stateRoot?: string }
): Promise<WindowsUpdateHandoff> {
  if (admission) await verifyWindowsUpdateInstaller(input.installerPath, admission.installerSha512)
  const { directory, request } = await createWindowsUpdateRequest(appData, input)
  const location: InstallationLocation = {
    installationRoot: dirname(request.applicationPath),
    ...(admission?.stateRoot ? { stateRoot: admission.stateRoot } : {})
  }
  if (admission) {
    try {
      // electron-updater owns its cache lifetime. Keep the verified full package with this
      // operation until ready, so interruption does not discard the only repair material.
      request.installerPath = join(directory, 'installer.exe')
      await copyFile(input.installerPath, request.installerPath, 1 /* COPYFILE_EXCL */)
      await verifyWindowsUpdateInstaller(request.installerPath, admission.installerSha512)
      if (request.installerUrl) {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(request.installerPath)) hash.update(chunk)
        request.installerSha256 = hash.digest('hex')
      }
      await writeWindowsUpdateFile(join(directory, 'request.json'), JSON.stringify(request))
      await writeWindowsUpdateFile(
        join(directory, 'bound-request.json'),
        windowsUpdateBoundRequest(request)
      )
      acquireNativeInstallationUpdate(location, {
        operationId: request.operationId,
        handoffDirectory: directory,
        targetVersion: request.targetVersion,
        installerSha512: admission.installerSha512,
        requestSha256: windowsUpdateRequestBinding(request)
      })
    } catch (error) {
      await rm(directory, { recursive: true })
      throw error
    }
  }
  let recoveryDirectory: string | undefined
  if (admission) {
    try {
      recoveryDirectory = await windowsInstallationRecoveryDirectory(
        appData,
        request.applicationPath
      )
      await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
    } catch (error) {
      releaseNativeInstallationUpdate(location, request.operationId)
      await rm(directory, { recursive: true })
      throw error
    }
  }
  let handedOff = false
  const receipt = (stage: string): void => {
    const destination = join(directory, `${stage}.receipt`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, windowsUpdateReceipt(request.operationId, stage), {
        flag: 'wx',
        mode: 0o600,
        flush: true
      })
      renameSync(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  return {
    operationId: request.operationId,
    handoff() {
      if (admission) advanceNativeInstallationUpdate(location, request.operationId)
      handedOff = true
      if (admission && recoveryDirectory) {
        const destination = join(recoveryDirectory, 'update.ini')
        const temporary = `${destination}.${randomUUID()}.tmp`
        try {
          writeFileSync(
            temporary,
            windowsRecoveryIni(request, directory, admission.installerSha512),
            {
              flag: 'wx',
              mode: 0o600,
              flush: true
            }
          )
          renameSync(temporary, destination)
        } finally {
          rmSync(temporary, { force: true })
        }
      }
      receipt('handoff')
    },
    cancel() {
      // An installer may already be running after submission; retain its lease and never
      // claim it was cancelled. Pre-submission failures can use the existing aborted state.
      receipt(handedOff ? 'unconfirmed' : 'aborted')
      if (admission && !handedOff) {
        if (recoveryDirectory) rmSync(join(recoveryDirectory, 'update.ini'), { force: true })
        releaseNativeInstallationUpdate(location, request.operationId)
      }
    }
  }
}

export function windowsUpdateBoundRequest(request: WindowsUpdateRequest): string {
  return JSON.stringify({
    schema: request.schema,
    operationId: request.operationId,
    targetVersion: request.targetVersion,
    applicationPath: request.applicationPath,
    installerPath: request.installerPath,
    ...(request.installerUrl ? { installerUrl: request.installerUrl } : {}),
    ...(request.installerSha256 ? { installerSha256: request.installerSha256 } : {}),
    profilePath: request.profilePath,
    startupOptions: runtimeStartupOptionsSchema.parse(request.startupOptions)
  })
}
export function windowsUpdateRequestBinding(request: WindowsUpdateRequest): string {
  return createHash('sha256').update(windowsUpdateBoundRequest(request)).digest('hex')
}

export async function windowsInstallationRecoveryDirectory(
  appData: string,
  applicationPath: string
): Promise<string> {
  const installationRoot = await realpath(dirname(applicationPath))
  // realpath supplies filesystem casing. Fold ASCII only: JavaScript and .NET disagree on
  // Unicode lowercasing (for example İ), which would otherwise select different recovery roots.
  const identity = installationRoot.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const key = createHash('sha256').update(identity).digest('hex')
  return join(await selectHandoffRoot(appData, applicationPath), 'Installations', key)
}

/** Keep newly pinned taskbar entries on the same durable entry as the installer shortcuts. */
export async function windowsInstallationRelaunchCommand(
  appData: string,
  applicationPath: string
): Promise<string | undefined> {
  const launcher = await windowsInstallationLauncherPath(appData, applicationPath)
  return launcher ? `"${launcher}" --open-science-launch` : undefined
}

async function windowsInstallationLauncherPath(
  appData: string,
  applicationPath: string
): Promise<string | undefined> {
  const directory = await windowsInstallationRecoveryDirectory(appData, applicationPath)
  const contents = await readFile(join(directory, 'launch.ini')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  )
  if (!contents) return undefined
  if (contents[0] !== 0xff || contents[1] !== 0xfe)
    throw new Error('Invalid installation launch metadata encoding')
  const lines = contents.subarray(2).toString('utf16le').split(/\r?\n/)
  const values = new Map<string, string>()
  for (const line of lines) {
    const match = /^(applicationPath|launcherPath)=(.*)$/.exec(line)
    if (!match) continue
    if (values.has(match[1])) throw new Error('Ambiguous installation launch metadata')
    values.set(match[1], match[2])
  }
  const launcher = values.get('launcherPath')
  if (
    !launcher ||
    !sameWindowsPath(values.get('applicationPath') ?? '', applicationPath) ||
    !sameWindowsPath(dirname(launcher), directory) ||
    !/^setup-[a-f0-9]{64}\.exe$/i.test(basename(launcher)) ||
    /["\r\n\0]/.test(launcher)
  )
    throw new Error('Invalid installation launch metadata')
  if (
    !(await lstat(launcher)).isFile() ||
    !sameWindowsPath(await realpath(launcher), join(await realpath(directory), basename(launcher)))
  )
    throw new Error('Invalid persistent installation entry')
  return launcher
}

function windowsRecoveryIni(
  request: WindowsUpdateRequest,
  directory: string,
  sha512: string
): Buffer {
  const values = {
    operationId: request.operationId,
    applicationPath: request.applicationPath,
    installerPath: request.installerPath,
    ...(request.installerUrl ? { installerUrl: request.installerUrl } : {}),
    ...(request.installerSha256 ? { installerSha256: request.installerSha256 } : {}),
    sha512Hex: Buffer.from(sha512, 'base64').toString('hex'),
    requestPath: join(directory, 'bound-request.json'),
    requestSha256: windowsUpdateRequestBinding(request)
  }
  if (Object.values(values).some((value) => /[\r\n\0]/.test(value)))
    throw new Error('Invalid Windows update recovery value')
  const text =
    '[update]\r\n' +
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\r\n`)
      .join('')
  // GetPrivateProfileStringW (NSIS ReadINIStr) requires the UTF-16 BOM for Unicode paths.
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

const startRecoveryInstaller = (path: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    // The persistent NSIS entry takes a fixed launch flag; no shell is involved.
    const child = spawn(path, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

/** Returns true when startup must yield to the original owner or the existing NSIS installer.
 * It resumes only the package and configuration already authorized by the update operation. */
export async function resumeInterruptedWindowsUpdate(
  options: SuccessorIdentity,
  startInstaller: (path: string, args: string[]) => Promise<void> = startRecoveryInstaller
): Promise<boolean> {
  const location = {
    installationRoot: dirname(options.applicationPath),
    stateRoot: options.stateRoot
  }
  const admission = readNativeInstallationUpdate(location)
  if (!admission) return false
  const directory = await findHandoffDirectory(options.appData, admission.operationId)
  const request = await readWindowsUpdateRequest(directory, admission.operationId)
  if (
    !sameWindowsPath(directory, admission.handoffDirectory) ||
    !sameWindowsPath(request.applicationPath, options.applicationPath) ||
    request.targetVersion !== admission.targetVersion ||
    admission.requestSha256 !== windowsUpdateRequestBinding(request)
  )
    throw new Error('The interrupted update does not match its authorized operation')
  if (
    options.version === request.targetVersion &&
    (await hasReceipt(directory, request.operationId, 'installed'))
  )
    return false // The normal successor resolver verifies settlement and reopens admission.
  const release = claimNativeInstallationUpdateRecovery(location, request.operationId)
  if (!release) return true // Original owner is still saving/stopping; never steal its operation.
  let submitted = false
  try {
    const bound = await readFile(join(directory, 'bound-request.json'))
    if (createHash('sha256').update(bound).digest('hex') !== admission.requestSha256)
      throw new Error('The interrupted update request changed')
    const launcher = await windowsInstallationLauncherPath(options.appData, request.applicationPath)
    if (!launcher) throw new Error('The persistent update recovery entry is unavailable')
    const recoveryDirectory = await windowsInstallationRecoveryDirectory(
      options.appData,
      request.applicationPath
    )
    await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
    advanceNativeInstallationUpdate(location, request.operationId)
    await writeWindowsUpdateFile(
      join(recoveryDirectory, 'update.ini'),
      windowsRecoveryIni(request, directory, admission.installerSha512)
    )
    // Ordinary startup and missing-executable recovery must share the same serialized owner.
    // The persistent NSIS entry waits for writers, re-fetches if needed, rechecks the operation,
    // and submits the existing installer. Do not race it with a second JS recovery downloader.
    await startInstaller(launcher, ['--open-science-launch'])
    submitted = true
    // Retain admission's kernel lease until this startup process exits. NSIS takes its existing
    // installer mutex before it writes; concurrent recovery can never create a second writer.
    return true
  } finally {
    if (!submitted) release()
  }
}

// The digest is from the checksum/signature-verified download, never from a directory scan.
// Recheck before stopping; the persistent NSIS entry checks this same digest during recovery.
export async function verifyWindowsUpdateInstaller(path: string, expected: string): Promise<void> {
  if (Buffer.from(expected, 'base64').length !== 64)
    throw new Error('Invalid update installer digest')
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error('Invalid update installer file')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('base64') !== expected)
    throw new Error('The update installer changed after verification')
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

function findHandoffDirectory(appData: string, operationId: string): string {
  const matches: string[] = []
  for (const root of windowsUpdateHandoffRoots(appData)) {
    try {
      const directory = join(root, operationId)
      lstatSync(directory)
      if (!lstatSync(root).isDirectory()) throw new Error('Invalid update handoff storage')
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
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600, flush: true })
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
    | 'targetVersion'
    | 'applicationPath'
    | 'installerPath'
    | 'installerUrl'
    | 'installerSha256'
    | 'profilePath'
    | 'startupOptions'
  >
): Promise<{ directory: string; request: WindowsUpdateRequest }> {
  const request = requestSchema.parse({
    targetVersion: input.targetVersion,
    applicationPath: input.applicationPath,
    installerPath: input.installerPath,
    installerUrl: input.installerUrl,
    installerSha256: input.installerSha256,
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

export function readWindowsUpdateRequest(
  directory: string,
  operationId: string
): WindowsUpdateRequest {
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid update operation directory')
  const path = join(directory, 'request.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid update operation request')
  const request = requestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
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
  stateRoot?: string
}

function hasReceipt(directory: string, operationId: string, stage: string): boolean {
  const path = join(directory, `${stage}.receipt`)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 128) throw new Error('Invalid update receipt')
    if (readFileSync(path, 'utf8') !== windowsUpdateReceipt(operationId, stage))
      throw new Error('Invalid update receipt')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// The installer may finish while the first successor fails before ready. An ordinary launch
// has no operation argv, but can still restore that exact installed target's original profile.
// Discovery is confined to the same fixed lease roots used by NSIS; it never executes a package.
function readPendingInstallationIndex(options: SuccessorIdentity): Buffer | undefined {
  // Ordinary first startup must reach profile/key initialization before yielding to Chromium.
  // Merely checking for recovery must neither create storage nor schedule filesystem work.
  const installation = realpathSync.native(dirname(options.applicationPath))
  const identity = installation.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const key = createHash('sha256').update(identity).digest('hex')
  let bytes: Buffer | undefined
  for (const root of windowsUpdateHandoffRoots(options.appData)) {
    try {
      if (!lstatSync(root).isDirectory()) throw new Error('Invalid update handoff storage')
      const offset = relative(installation, realpathSync.native(root))
      if (!(isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`))) continue
      const path = join(root, 'Installations', key, 'update.ini')
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 32_768) throw new Error('Invalid update recovery index')
      const candidate = readFileSync(path)
      if (bytes) throw new Error('Ambiguous update recovery index')
      bytes = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return bytes
}

function findPendingInstalledOperation(options: SuccessorIdentity): string | undefined {
  // A different installation's damaged historical lease must never block this ordinary launch.
  // Use only this installation's fixed recovery index instead of scanning all user operations.
  const bytes = readPendingInstallationIndex(options)
  if (!bytes) return undefined
  if (bytes.length > 32_768 || bytes[0] !== 0xff || bytes[1] !== 0xfe)
    throw new Error('Invalid update recovery index')
  const operations = bytes
    .subarray(2)
    .toString('utf16le')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('operationId='))
  if (operations.length !== 1) throw new Error('Ambiguous update recovery index')
  const operationId = operationIdSchema.parse(operations[0].slice('operationId='.length))
  const directory = findHandoffDirectory(options.appData, operationId)
  const request = readWindowsUpdateRequest(directory, operationId)
  if (!sameWindowsPath(request.applicationPath, options.applicationPath))
    throw new Error('Update recovery installation mismatch')
  if (
    request.targetVersion !== options.version ||
    !hasReceipt(directory, operationId, 'installed') ||
    hasReceipt(directory, operationId, 'ready') ||
    hasReceipt(directory, operationId, 'aborted')
  )
    return undefined
  return operationId
}

function readInstalledRequest(
  options: SuccessorIdentity
): { request: WindowsUpdateRequest; directory: string } | undefined {
  const operationId = windowsUpdateOperation(options.args) ?? findPendingInstalledOperation(options)
  if (!operationId) return undefined
  const directory = findHandoffDirectory(options.appData, operationId)
  const request = readWindowsUpdateRequest(directory, operationId)
  if (
    request.targetVersion !== options.version ||
    !sameWindowsPath(request.applicationPath, options.applicationPath) ||
    !sameWindowsPath(request.profilePath, request.startupOptions.profilePath)
  )
    throw new Error(
      'Updated application does not match the requested version, installation or profile'
    )
  const path = join(directory, 'installed.receipt')
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.size > 128 ||
    readFileSync(path, 'utf8') !== windowsUpdateReceipt(operationId, 'installed')
  )
    throw new Error('The installer completion receipt is unavailable or invalid')
  return { request, directory }
}

// Restore the same configuration before selecting Chromium's profile or credential store.
// This does not bypass the normal startup credential and data checks.
export function prepareWindowsUpdateStartup(
  options: SuccessorIdentity
):
  | { startupOptions: RuntimeStartupOptions; confirmed: boolean; settle(): Promise<void> }
  | undefined {
  const installed = readInstalledRequest(options)
  if (!installed) return undefined
  const { request, directory } = installed
  const location = {
    installationRoot: dirname(options.applicationPath),
    stateRoot: options.stateRoot
  }
  const admission = readNativeInstallationUpdate(location)
  if (admission) {
    if (
      admission.operationId !== request.operationId ||
      admission.targetVersion !== options.version ||
      !sameWindowsPath(admission.handoffDirectory, directory) ||
      admission.requestSha256 !== windowsUpdateRequestBinding(request)
    )
      throw new Error('The installed update does not match its authorized operation')
  }
  let confirmed: boolean
  try {
    confirmed = hasReceipt(directory, request.operationId, 'ready')
  } catch {
    throw new Error('Invalid successor readiness receipt')
  }
  // The original data assertion applies once, to the update. Later normal relaunches may follow a
  // user-committed data-folder migration and must read current settings rather than the old root.
  return {
    startupOptions: request.startupOptions,
    confirmed,
    // The caller must select this profile and finish synchronous credential preflight before
    // invoking settle: yielding earlier lets Chromium initialize a different OSCrypt key.
    async settle() {
      const current = readWindowsUpdateRequest(directory, request.operationId)
      if (windowsUpdateRequestBinding(current) !== windowsUpdateRequestBinding(request))
        throw new Error('The installed update changed during credential preflight')
      // Publish successor identity before reopening admission, so ordinary-entry observers can
      // join this startup. Keep the writer fence until its original kernel mutex is released.
      current.successorPid = process.pid
      await writeWindowsUpdateFile(join(directory, 'request.json'), JSON.stringify(current))
      if (admission) {
        const deadline = Date.now() + 30_000
        while (await isWindowsInstallationWriterActive(WINDOWS_INSTALLER_MUTEX)) {
          if (Date.now() >= deadline) throw new Error('The update installer has not finished')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        releaseNativeInstallationUpdate(location, request.operationId, 'installed')
      }
    }
  }
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
  const recoveryDirectory = await windowsInstallationRecoveryDirectory(
    options.appData,
    options.applicationPath
  )
  const recoveryPath = join(recoveryDirectory, 'update.ini')
  const recovery = await readFile(recoveryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  })
  if (
    recovery
      .subarray(2)
      .toString('utf16le')
      .split(/\r?\n/)
      .includes(`operationId=${request.operationId}`)
  )
    await rm(recoveryPath)
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
      const request = await readWindowsUpdateRequest(directory, entry.name)
      if (
        processMayBeAlive(request.parentPid) ||
        (request.helperPid && processMayBeAlive(request.helperPid)) ||
        (request.successorPid && processMayBeAlive(request.successorPid))
      )
        continue
      const files = await readdir(directory, { withFileTypes: true })
      const owned =
        /^(?:request\.json|bound-request\.json|installer\.exe|installer-recovery\.exe(?:\.part(?:\.meta)?)?|config\.bin|helper\.exe|cancel|(?:accepted|installing|installed|failed|ready|closed|aborted|handoff|unconfirmed)\.receipt)(?:\.[0-9a-f-]{36}\.tmp|\.tmp)?$/
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
        // the small configuration record until explicit uninstall. The operation's repair package
        // is no longer needed after ready; persistent shortcut packages live in a separate directory.
        await rm(join(directory, 'installer.exe'), { force: true })
        for (const suffix of ['', '.part', '.part.meta'])
          await rm(join(directory, `installer-recovery.exe${suffix}`), { force: true })
        await rm(join(directory, 'helper.exe'), { force: true })
        await rm(join(directory, 'config.bin'), { force: true })
        continue
      }
      const aborted = await receipt('aborted')
      if (!aborted && !(await receipt('failed'))) continue
      // A failed native install may have partially replaced the application. Preserve its only
      // verified repair package and binding until recovery succeeds or explicit uninstall.
      if (
        !aborted &&
        files.some((file) => file.name === 'bound-request.json' || file.name === 'installer.exe')
      )
        continue
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
