import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Logger } from '@aipoch/diagnostics/node'
import type { NativeTranslator } from '../locale/main-process-messages'
import type { RuntimeStartupOptions } from '../runtime-startup-options'
import {
  createWindowsUpdateRequest,
  writeWindowsUpdateFile,
  windowsUpdateReceipt
} from './windows-update-handoff'

export interface WindowsInstallProgress {
  readonly operationId: string
  handoff(): void
  // Dismisses presentation after an aborted handoff; never cancels or terminates an installer.
  cancel(): void
}

// Fixed, bounded UTF-16 protocol shared with the native helper; no command string interpolation.
export function encodeWindowsProgressConfig(parentPid: number, fields: string[]): Buffer {
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid > 0xffffffff ||
    fields.length !== 10
  )
    throw new Error('Invalid update handoff configuration')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0x3250554f)
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

export async function startWindowsInstallProgress(options: {
  installerPath: string
  applicationPath: string
  helperPath: string
  appData: string
  profilePath: string
  targetVersion: string
  startupOptions: RuntimeStartupOptions
  logDirectory: string
  translate: NativeTranslator
  log: Logger
}): Promise<WindowsInstallProgress> {
  const { directory, request } = await createWindowsUpdateRequest(options.appData, options)
  const token = request.operationId
  const helper = join(directory, 'helper.exe')
  const cancelPath = join(directory, 'cancel')
  const logPath = join(options.logDirectory, `update-handoff-${token}.jsonl`)
  let child: ChildProcess | undefined
  let handedOff = false
  const receipt = (stage: string): void => {
    const file = join(directory, `${stage}.receipt`)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, windowsUpdateReceipt(token, stage), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  const cancel = (): void => {
    const temporary = join(directory, `cancel.${randomUUID()}.tmp`)
    try {
      if (handedOff) {
        receipt('unconfirmed')
        return
      }
      receipt('aborted')
      writeFileSync(temporary, token, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, cancelPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  try {
    const installation = await realpath(dirname(options.applicationPath))
    const offset = relative(installation, await realpath(directory))
    if (offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)))
      throw new Error('Update progress storage must be outside the installation')
    // Each attempt owns its own complete helper copy. A failed write cannot poison later attempts.
    await writeWindowsUpdateFile(helper, await readFile(options.helperPath))
    await mkdir(options.logDirectory, { recursive: true })
    const configuration = join(directory, 'config.bin')
    await writeWindowsUpdateFile(
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
        options.translate('Close update window'),
        options.translate(
          'The update status could not be confirmed. Closing this window does not stop installation.'
        )
      ])
    )
    const launched = spawn(helper, [configuration], {
      cwd: directory,
      detached: true,
      // This is a GUI-subsystem executable. STARTF_USESHOWWINDOW/SW_HIDE would suppress its first
      // ShowWindow call, including the actual window whose readiness we must acknowledge.
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH: undefined,
        OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256: undefined
      }
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
    request.helperPid = launched.pid
    await writeWindowsUpdateFile(join(directory, 'request.json'), JSON.stringify(request))
    return {
      operationId: token,
      cancel,
      handoff: () => {
        receipt('handoff')
        handedOff = true
      }
    }
  } catch (error) {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) cancel()
      else await rm(directory, { recursive: true, force: true })
    } catch (cleanupError) {
      options.log.warn('Update presentation cleanup deferred', cleanupError)
    }
    throw error
  }
}
