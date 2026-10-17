import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Logger } from '@aipoch/diagnostics/node'
import type { NativeTranslator } from '../locale/main-process-messages'

export interface WindowsInstallProgress {
  cancel(): void
}

// Fixed, bounded UTF-16 protocol shared with the native helper; no command string interpolation.
export function encodeWindowsProgressConfig(parentPid: number, fields: string[]): Buffer {
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid > 0xffffffff ||
    fields.length !== 9
  )
    throw new Error('Invalid update handoff configuration')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0x3150554f)
  header.writeUInt32LE(parentPid, 4)
  return Buffer.concat([
    header,
    ...fields.flatMap((value) => {
      if (!value || value.length > 32768 || value.includes('\0'))
        throw new Error('Invalid update handoff text')
      const length = Buffer.alloc(4)
      length.writeUInt32LE(value.length)
      return [length, Buffer.from(value, 'utf16le')]
    })
  ])
}

// Cache the exact signed binary outside the installation so replacement cannot lock it. This is
// a reusable versioned resource, not an attempt temp file. Never execute a mismatched cache entry.
async function cacheHelper(
  source: string,
  cacheDirectory: string,
  applicationPath: string
): Promise<{ helper: string; directory: string }> {
  await mkdir(cacheDirectory, { recursive: true })
  const cache = await realpath(cacheDirectory)
  const installation = await realpath(dirname(applicationPath))
  const offset = relative(installation, cache)
  if (offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)))
    throw new Error('Update progress cache must be outside the installation')
  const bytes = await readFile(source)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = join(cache, digest)
  await mkdir(directory, { recursive: true })
  const destination = join(directory, 'open-science-update-progress.exe')
  try {
    await writeFile(destination, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (
    !(await lstat(destination)).isFile() ||
    createHash('sha256')
      .update(await readFile(destination))
      .digest('hex') !== digest
  )
    throw new Error('Cached update progress executable does not match the installed resource')
  return { helper: destination, directory: cache }
}

export async function startWindowsInstallProgress(options: {
  installerPath: string
  applicationPath: string
  helperPath: string
  cacheDirectory: string
  logDirectory: string
  translate: NativeTranslator
  log: Logger
}): Promise<WindowsInstallProgress> {
  const cached = await cacheHelper(
    options.helperPath,
    options.cacheDirectory,
    options.applicationPath
  )
  const helper = cached.helper
  const directory = await mkdtemp(join(cached.directory, 'attempt-'))
  const token = randomUUID()
  const cancelPath = join(directory, 'cancel')
  const logPath = join(options.logDirectory, `update-handoff-${token}.jsonl`)
  let child: ChildProcess | undefined
  const cancel = (): void => writeFileSync(cancelPath, token, { encoding: 'utf8' })
  try {
    await mkdir(options.logDirectory, { recursive: true })
    const configuration = join(directory, 'config.bin')
    await writeFile(
      configuration,
      encodeWindowsProgressConfig(process.pid, [
        token,
        process.execPath,
        options.applicationPath,
        options.installerPath,
        logPath,
        options.translate('Installing the Open-Science update…'),
        options.translate('Opening the updated Open-Science…'),
        options.translate('The Open-Science update could not finish.'),
        options.translate('Close update window')
      ]),
      { flag: 'wx' }
    )
    const launched = spawn(helper, [configuration], {
      cwd: directory,
      detached: true,
      // This is a GUI-subsystem executable. STARTF_USESHOWWINDOW/SW_HIDE would suppress its first
      // ShowWindow call, including the actual window whose readiness we must acknowledge.
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH: undefined }
    })
    child = launched
    await new Promise<void>((resolve, reject) => {
      let stdout = '',
        stderr = '',
        settled = false
      const timer = setTimeout(
        () => finish(new Error('Update progress window did not become visible')),
        20_000
      )
      const onError = (error: Error): void => finish(error)
      const onExit = (code: number | null): void =>
        finish(new Error(`Update progress exited before readiness (${code}): ${stderr}`))
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
      launched.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-8192)
      })
      launched.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (stdout.length > 4096) {
          finish(new Error('Oversized update progress acknowledgement'))
          return
        }
        if (!stdout.includes('\n')) return
        try {
          const ready = JSON.parse(stdout.trim()) as {
            token?: string
            pid?: number
            visible?: boolean
          }
          if (ready.token !== token || ready.pid !== launched.pid || ready.visible !== true)
            throw new Error('Invalid update progress readiness acknowledgement')
          options.log.info('Windows update progress window ready', {
            ...ready,
            logPath,
            directory,
            helper
          })
          finish()
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    return { cancel }
  } catch (error) {
    if (child?.pid && child.exitCode === null) cancel()
    else await rm(directory, { recursive: true, force: true })
    throw error
  }
}
