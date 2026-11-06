import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { installationFs } from './installation-filesystem'
import { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from '../runtime-startup-options'
import { inspectMacUpdateArtifact, verifyArtifactChecksum } from './installation-artifact'
import {
  acquireNativeInstallationUpdate,
  advanceNativeInstallationUpdate,
  claimNativeInstallationUpdateRecovery,
  readNativeInstallationUpdate,
  readInstallationStartupOptions,
  releaseNativeInstallationUpdate,
  settleNativeInstallationUpdateStartup,
  verifyInstallationManifestAsync,
  type InstallationLocation,
  type InstallationManifest
} from './installation-protection'

const { copyFile, mkdir, mkdtemp, open, realpath, rename, rm } = installationFs.promises
const { readFileSync, rmSync } = installationFs
const absolutePath = z.string().refine(isAbsolute)
const requestSchema = z
  .object({
    schema: z.literal(1),
    channel: z.literal('mac-electron-updater'),
    operationId: z.string().uuid(),
    applicationPath: absolutePath,
    installerPath: absolutePath,
    installerUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      }),
    installerSha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    targetVersion: z.string().min(1),
    profilePath: absolutePath,
    startupOptions: runtimeStartupOptionsSchema,
    targetManifest: z
      .object({ version: z.string().min(1), files: z.record(z.string(), z.string()) })
      .strict()
  })
  .strict()

export type MacUpdateRequest = z.infer<typeof requestSchema>
export type MacUpdateHandoff = {
  readonly operationId: string
  handoff(): void
  cancel(): void
}
type ArtifactInspector = (
  archive: string,
  version: string,
  signal?: AbortSignal
) => Promise<InstallationManifest>
type HandoffInput = {
  installerPath: string
  installerUrl: string
  applicationPath: string
  profilePath: string
  targetVersion: string
  startupOptions: RuntimeStartupOptions
}

function binding(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeDurably(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

/** The production writer remains electron-updater/Squirrel. This only owns admission and
 * durable recovery material outside the replaced bundle; it never replaces application files. */
export async function prepareMacUpdateHandoff(
  appData: string,
  input: HandoffInput,
  admission: {
    installerSha512: string
    stateRoot?: string
    signal?: AbortSignal
    inspectArtifact?: ArtifactInspector
  }
): Promise<MacUpdateHandoff> {
  const signal = admission.signal
    ? AbortSignal.any([admission.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  const applicationPath = await realpath(input.applicationPath)
  const profilePath = await realpath(input.profilePath)
  const startupOptions = runtimeStartupOptionsSchema.parse(input.startupOptions)
  if ((await realpath(startupOptions.profilePath)) !== profilePath)
    throw new Error('The update profile does not match its startup configuration.')
  // Do not create, migrate, copy or delete configuration/scientific data during admission.
  for (const path of [startupOptions.configRoot, startupOptions.dataRoot]) await realpath(path)
  await verifyArtifactChecksum(input.installerPath, admission.installerSha512, signal)
  const root = join(appData, 'mac-update-handoffs')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'operation-'))
  const location: InstallationLocation = {
    installationRoot: applicationPath,
    stateRoot: admission.stateRoot
  }
  let admitted = false
  try {
    const installerPath = join(directory, 'update.zip')
    await copyFile(input.installerPath, installerPath, installationFs.constants.COPYFILE_EXCL)
    // Rehash the retained copy, not just electron-updater's independently managed cache path.
    await verifyArtifactChecksum(installerPath, admission.installerSha512, signal)
    const targetManifest = await (admission.inspectArtifact ?? inspectMacUpdateArtifact)(
      installerPath,
      input.targetVersion,
      signal
    )
    if (targetManifest.version !== input.targetVersion)
      throw new Error('The update target manifest has changed.')
    const request = requestSchema.parse({
      ...input,
      schema: 1,
      channel: 'mac-electron-updater',
      operationId: randomUUID(),
      applicationPath,
      profilePath,
      installerPath,
      installerSha512: admission.installerSha512,
      startupOptions: { ...startupOptions, profilePath },
      targetManifest
    })
    const bytes = JSON.stringify(request)
    await writeDurably(join(directory, 'request.json'), bytes)
    acquireNativeInstallationUpdate(location, {
      channel: 'mac-electron-updater',
      operationId: request.operationId,
      handoffDirectory: directory,
      targetVersion: request.targetVersion,
      installerSha512: request.installerSha512,
      requestSha256: binding(bytes)
    })
    admitted = true
    let handedOff = false
    let cancelled = false
    return {
      operationId: request.operationId,
      handoff() {
        if (cancelled) throw new Error('The Mac update admission was cancelled before handoff.')
        advanceNativeInstallationUpdate(location, request.operationId)
        handedOff = true
      },
      cancel() {
        // After Squirrel submission an error cannot prove that its writer never ran.
        if (handedOff || cancelled) return
        releaseNativeInstallationUpdate(location, request.operationId)
        cancelled = true
        rmSync(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    if (admitted) {
      const record = readNativeInstallationUpdate(location)
      if (record) releaseNativeInstallationUpdate(location, record.operationId)
    }
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Read-only, so the original profile can be selected before Desktop opens any database.
 * Reading the record grants no authority to launch, clear a marker, or run an installer. */
export function readMacUpdateStartupOptions(
  location: InstallationLocation
): RuntimeStartupOptions | undefined {
  const record = readNativeInstallationUpdate(location)
  // A crash after native admission settled can leave only the verified startup ticket.
  // Read its original profile synchronously before the first await opens default Electron storage.
  if (!record) return readInstallationStartupOptions(location)
  if (record?.channel !== 'mac-electron-updater') return undefined
  return readBoundRequest(record).startupOptions
}

function readBoundRequest(
  record: NonNullable<ReturnType<typeof readNativeInstallationUpdate>>
): MacUpdateRequest {
  const bytes = readFileSync(join(record.handoffDirectory, 'request.json'))
  if (binding(bytes) !== record.requestSha256)
    throw new Error('The original Mac update request has changed.')
  const request = requestSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (
    request.operationId !== record.operationId ||
    request.applicationPath !== record.installationRoot ||
    request.targetVersion !== record.targetVersion ||
    request.installerSha512 !== record.installerSha512 ||
    request.installerPath !== join(record.handoffDirectory, 'update.zip') ||
    request.targetManifest.version !== record.targetVersion ||
    request.startupOptions.profilePath !== request.profilePath
  )
    throw new Error('The original Mac update identity does not match its installation record.')
  return request
}

export type MacUpdateRecovery =
  | { state: 'none' | 'busy' }
  | {
      state: 'ready'
      request: MacUpdateRequest
      settleBeforeLaunch(): void
      completeAfterReady(): Promise<void>
      dispose(): void
    }
  | { state: 'resume'; request: MacUpdateRequest; handoff(): void; dispose(): void }

/** Only an executable intact enough to enter Desktop can call this handler. It deliberately
 * makes no claim to repair the missing CFBundleExecutable/whole-bundle entry gap. */
export async function recoverMacUpdateHandoff(
  location: InstallationLocation,
  options: {
    runningVersion: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    verifyManifest?: typeof verifyInstallationManifestAsync
    inspectArtifact?: ArtifactInspector
  }
): Promise<MacUpdateRecovery> {
  const record = readNativeInstallationUpdate(location)
  if (record?.channel !== 'mac-electron-updater') return { state: 'none' }
  const release = claimNativeInstallationUpdateRecovery(location, record.operationId)
  if (!release) return { state: 'busy' }
  let retained = false
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  try {
    const request = readBoundRequest(record)
    const verify = options.verifyManifest ?? verifyInstallationManifestAsync
    if (
      options.runningVersion === request.targetVersion &&
      (await verify(record.installationRoot, request.targetManifest, signal))
    ) {
      retained = true
      let settled = false
      return {
        state: 'ready',
        request,
        dispose: release,
        settleBeforeLaunch() {
          settleNativeInstallationUpdateStartup(location, record.operationId, {
            startupOptions: request.startupOptions,
            manifest: request.targetManifest
          })
          settled = true
          release()
        },
        async completeAfterReady() {
          // Caller invokes only after the original profile, real window and backend are ready.
          // Revalidate at publication; the record itself is never evidence of completion.
          if (
            !settled ||
            !(await verify(
              record.installationRoot,
              request.targetManifest,
              AbortSignal.timeout(120_000)
            ))
          )
            throw new Error('The target installation changed before readiness was confirmed.')
          // The durable startup ticket owns cache cleanup, including retries after process exit.
          release()
        }
      }
    }
    await ensureMacRecoveryArtifact(request, { signal, fetchImpl: options.fetchImpl })
    const inspected = await (options.inspectArtifact ?? inspectMacUpdateArtifact)(
      request.installerPath,
      request.targetVersion,
      signal
    )
    if (binding(JSON.stringify(inspected)) !== binding(JSON.stringify(request.targetManifest)))
      throw new Error('The recovered package does not match the original target application.')
    retained = true
    return {
      state: 'resume',
      request,
      dispose: release,
      handoff() {
        advanceNativeInstallationUpdate(location, record.operationId)
      }
    }
  } finally {
    if (!retained) release()
  }
}

/** Reacquire the exact original URL, never query a moving latest feed. A bounded failure
 * leaves the request/marker intact so a subsequent authorized recovery can continue. */
export async function ensureMacRecoveryArtifact(
  request: Pick<MacUpdateRequest, 'installerPath' | 'installerUrl' | 'installerSha512'>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<'reused' | 'downloaded'> {
  const signal = options.signal ?? AbortSignal.timeout(120_000)
  try {
    await verifyArtifactChecksum(request.installerPath, request.installerSha512, signal)
    return 'reused'
  } catch (error) {
    signal.throwIfAborted()
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(error instanceof Error && error.message.includes('checksum has changed'))
    )
      throw error
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    const temporary = `${request.installerPath}.${randomUUID()}.download`
    try {
      const response = await (options.fetchImpl ?? fetch)(request.installerUrl, {
        signal,
        redirect: 'error'
      })
      if (!response.ok || !response.body)
        throw new Error(`Original update package download failed (${response.status}).`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          await file.writeFile(chunk)
        }
        await file.sync()
      } finally {
        await file.close()
      }
      await verifyArtifactChecksum(temporary, request.installerSha512, signal)
      await rename(temporary, request.installerPath)
      return 'downloaded'
    } catch (error) {
      signal.throwIfAborted()
      lastError = error
    } finally {
      await rm(temporary, { force: true })
    }
  }
  throw new Error('The original update package could not be recovered after three attempts.', {
    cause: lastError
  })
}
