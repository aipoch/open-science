import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { Logger } from '@aipoch/diagnostics/node'
import type { NativeTranslator } from '../locale/main-process-messages'
import { runtimeStartupOptionsSchema } from '../runtime-startup-options'

const requestSchema = z
  .object({
    operationId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    parentPid: z.number().int().positive(),
    applicationPath: z.string().refine(isAbsolute),
    profilePath: z.string().refine(isAbsolute),
    targetVersion: z.string().min(1),
    startupOptions: runtimeStartupOptionsSchema
  })
  .strict()
const rootFor = (profilePath: string): string => join(profilePath, 'mac-update-handoff')
const lifetimeMs = 10 * 60_000

function writeState(directory: string, operationId: string, phase: string): void {
  const temporary = join(directory, 'state.tmp')
  try {
    writeFileSync(temporary, JSON.stringify({ operationId, phase }), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(directory, 'state.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
}

async function readOwnedJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOOP')
        throw new Error('Invalid update presentation file', { cause: error })
      throw error
    }
  )
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022 || info.size > 65536)
      throw new Error('Invalid update presentation file')
    return JSON.parse(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
}

// Receipts only dismiss presentation; they never authorize installation or change startup settings.
export async function acknowledgeMacUpdateReady(options: {
  profilePath: string
  applicationPath: string
  version: string
  waitForPresentation: () => Promise<void>
  verifyReady: (startup: z.infer<typeof runtimeStartupOptionsSchema>) => Promise<void>
}): Promise<boolean> {
  const root = rootFor(await realpath(options.profilePath))
  try {
    const id = z
      .string()
      .uuid()
      .parse(await readOwnedJson(join(root, 'active.json')))
    const directory = join(root, id)
    const request = requestSchema.parse(await readOwnedJson(join(directory, 'request.json')))
    const expected = { operationId: id, phase: 'handoff' }
    if (
      JSON.stringify(await readOwnedJson(join(directory, 'state.json'))) !==
      JSON.stringify(expected)
    )
      return false
    if (
      request.parentPid === process.pid ||
      Date.now() - request.createdAt > lifetimeMs ||
      request.createdAt > Date.now()
    )
      return false
    if (
      request.operationId !== id ||
      request.targetVersion !== options.version ||
      request.applicationPath !== (await realpath(options.applicationPath)) ||
      request.profilePath !== (await realpath(options.profilePath))
    )
      throw new Error(
        'Updated application does not match the requested version, installation or profile'
      )
    await options.waitForPresentation()
    await options.verifyReady(request.startupOptions)
    // A newer attempt or a user-dismissed helper must not receive an older readiness result.
    if ((await readOwnedJson(join(root, 'active.json'))) !== id) return false
    if (
      JSON.stringify(await readOwnedJson(join(directory, 'state.json'))) !==
      JSON.stringify(expected)
    )
      return false
    writeState(directory, id, 'ready')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function startMacInstallProgress(options: {
  helperPath: string
  applicationPath: string
  profilePath: string
  targetVersion: string
  startupOptions: z.infer<typeof runtimeStartupOptionsSchema>
  translate: NativeTranslator
  log: Logger
}): Promise<{ operationId: string; handoff(): void; cancel(): void }> {
  const request = requestSchema.parse({
    operationId: randomUUID(),
    createdAt: Date.now(),
    parentPid: process.pid,
    applicationPath: await realpath(options.applicationPath),
    profilePath: await realpath(options.profilePath),
    targetVersion: options.targetVersion,
    startupOptions: options.startupOptions
  })
  const root = rootFor(request.profilePath)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error('Update presentation storage must be private')
  const installation = dirname(dirname(dirname(request.applicationPath)))
  const offset = relative(installation, await realpath(root))
  if (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
    throw new Error('Update presentation storage must be outside the installation')
  const directory = join(root, request.operationId)
  await mkdir(directory, { mode: 0o700 })
  let child: ChildProcess | undefined
  let handedOff = false
  const cancel = (): void => {
    try {
      writeState(directory, request.operationId, handedOff ? 'unconfirmed' : 'cancelled')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    await copyFile(options.helperPath, join(directory, 'progress'), constants.COPYFILE_EXCL)
    writeFileSync(join(directory, 'request.json'), JSON.stringify(request), {
      flag: 'wx',
      mode: 0o600
    })
    writeState(directory, request.operationId, 'prepared')
    const config = {
      ...request,
      installing: options.translate('Updating Open-Science…'),
      version: options.translate('Updating to version {{version}}', {
        version: request.targetVersion
      }),
      reopening: options.translate(
        'Open-Science will reopen automatically when the update is ready.'
      ),
      unconfirmed: options.translate(
        'The update status could not be confirmed. Closing this window does not stop installation.'
      ),
      close: options.translate('Hide this window'),
      closeHelp: options.translate('Hiding this window does not stop the update.')
    }
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config), {
      flag: 'wx',
      mode: 0o600
    })
    const launched = spawn(join(directory, 'progress'), [join(directory, 'config.json')], {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH: undefined,
        OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256: undefined
      }
    })
    child = launched
    launched.once('exit', () => {
      void rm(directory, { recursive: true, force: true }).catch((error) =>
        options.log.warn('Update presentation cleanup deferred', error)
      )
    })
    await new Promise<void>((resolve, reject) => {
      let output = '',
        errors = '',
        settled = false
      const timer = setTimeout(
        () => finish(new Error('Update progress window did not become visible')),
        20_000
      )
      const onError = (error: Error): void => finish(error)
      const onExit = (): void =>
        finish(new Error(`Update progress exited before readiness: ${errors}`))
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        launched.removeListener('error', onError)
        launched.removeListener('exit', onExit)
        launched.stdout.destroy()
        launched.stderr.destroy()
        launched.unref()
        if (error) reject(error)
        else resolve()
      }
      launched.once('error', onError)
      launched.once('exit', onExit)
      launched.stderr.on('data', (bytes) => {
        errors = (errors + String(bytes)).slice(-4096)
      })
      launched.stdout.on('data', (bytes) => {
        output += String(bytes)
        if (output.length > 4096)
          return finish(new Error('Oversized update progress acknowledgement'))
        if (!output.includes('\n')) return
        try {
          const result = JSON.parse(output.trim())
          if (
            result.operationId !== request.operationId ||
            result.pid !== launched.pid ||
            result.visible !== true
          )
            throw new Error('Invalid update progress acknowledgement')
          finish()
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    const active = join(root, `${request.operationId}.tmp`)
    writeFileSync(active, JSON.stringify(request.operationId), { flag: 'wx', mode: 0o600 })
    renameSync(active, join(root, 'active.json'))
    options.log.info('macOS update progress window ready', {
      operationId: request.operationId,
      helperPid: launched.pid
    })
    return {
      operationId: request.operationId,
      cancel,
      handoff: () => {
        try {
          writeState(directory, request.operationId, 'handoff')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        handedOff = true
      }
    }
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) cancel()
    else await rm(directory, { recursive: true, force: true })
    throw error
  }
}
