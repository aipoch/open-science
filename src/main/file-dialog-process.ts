import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BaseWindow } from 'electron'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  FILE_DIALOG_HELPER_ARG,
  FILE_DIALOG_PROFILE_ENV,
  parseFileDialogResult,
  type FileDialogRequest,
  type FileDialogResult
} from './file-dialog-protocol'

class NativeFileDialogError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message)
    this.name = 'NativeFileDialogError'
  }
}

const activeParents = new WeakSet<BaseWindow>()

export async function showFileDialogInHelper(
  request: FileDialogRequest,
  parent?: BaseWindow,
  signal?: AbortSignal
): Promise<FileDialogResult> {
  signal?.throwIfAborted()
  if (parent?.isDestroyed())
    throw new NativeFileDialogError(
      'caller-unavailable',
      'Desktop command window is no longer available.'
    )
  if (parent && activeParents.has(parent))
    throw new NativeFileDialogError('dialog-already-open', 'A native file dialog is already open.')
  const log = createLogger('native-file-dialog')
  // Windows common-dialog edit controls can crash inside third-party IME callbacks.
  // Keep text entry in Chromium while retaining the helper as a process-level safety net.
  const presentation =
    process.platform === 'win32' &&
    (request.kind === 'save' ||
      (request.kind === 'open' &&
        request.options.properties?.includes('openDirectory') &&
        !request.options.properties?.includes('openFile') &&
        !request.options.properties?.includes('multiSelections')))
      ? 'html'
      : 'native'
  const operationId = randomUUID()
  const operation = startDiagnosticOperation(log, {
    operation: 'native-file-dialog',
    operationId,
    fields: {
      kind: request.kind,
      platform: process.platform,
      isolated: true,
      presentation,
      parented: false,
      parentPid: process.pid
    }
  })
  let profile: string | undefined
  let shuttingDown = false
  const wasEnabled = parent?.isEnabled() ?? false
  if (parent) activeParents.add(parent)
  try {
    profile = mkdtempSync(join(app.getPath('temp'), 'open-science-file-dialog-'))
    // A BrowserWindow cannot cross processes. Disable only the invoking window for the lifetime
    // of the helper and restore it on every terminal path; the helper owns the selection window.
    if (wasEnabled) parent?.setEnabled(false)
    const env: NodeJS.ProcessEnv = { ...process.env, [FILE_DIALOG_PROFILE_ENV]: profile }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(
      process.execPath,
      [
        ...(!app.isPackaged ? [app.getAppPath()] : []),
        FILE_DIALOG_HELPER_ARG,
        `--lang=${app.getLocale()}`
      ],
      { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }
    )
    const result = await new Promise<FileDialogResult>((resolve, reject) => {
      let settled = false
      let ready = false
      let selection: FileDialogResult | undefined
      let exitTimeout: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(startupTimeout)
        clearTimeout(dialogTimeout)
        clearTimeout(exitTimeout)
        signal?.removeEventListener('abort', abort)
        parent?.removeListener('closed', closed)
        app.removeListener('will-quit', quit)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        if (error) reject(error)
        else resolve(selection!)
      }
      const abort = (): void =>
        finish(new NativeFileDialogError('cancelled', 'Native file dialog was cancelled.'))
      const closed = (): void =>
        finish(
          new NativeFileDialogError(
            'caller-unavailable',
            'Desktop command window is no longer available.'
          )
        )
      const quit = (): void => {
        shuttingDown = true
        finish(new NativeFileDialogError('application-shutdown', 'Application is shutting down.'))
      }
      const startupTimeout = setTimeout(
        () =>
          finish(
            new NativeFileDialogError('startup-timeout', 'Native file dialog helper did not start.')
          ),
        15_000
      )
      const dialogTimeout = setTimeout(
        () => finish(new NativeFileDialogError('dialog-timeout', 'Native file dialog timed out.')),
        300_000
      )
      signal?.addEventListener('abort', abort, { once: true })
      parent?.once('closed', closed)
      app.once('will-quit', quit)
      child.once('spawn', () => operation.phase('helper-started', { helperPid: child.pid }))
      child.on('error', (error: NodeJS.ErrnoException) => {
        operation.phase('helper-error', { helperPid: child.pid, errorCode: error.code })
        finish(new NativeFileDialogError('spawn-error', 'Native file dialog helper could not run.'))
      })
      child.once('disconnect', () => {
        // IPC commonly closes before the process exit event. Preserve the native exit code in
        // diagnostics instead of prematurely classifying a crash as a transport failure.
        if (!settled && !exitTimeout)
          exitTimeout = setTimeout(
            () =>
              finish(
                new NativeFileDialogError(
                  'ipc-disconnected',
                  'Native file dialog helper disconnected.'
                )
              ),
            5_000
          )
      })
      child.on('message', (message: unknown) => {
        if (settled) return
        const raw = message as { type?: string; result?: unknown; errorCode?: unknown } | null
        if (raw?.type === 'ready' && !ready) {
          ready = true
          clearTimeout(startupTimeout)
          operation.phase('show-dialog', { helperPid: child.pid })
          child.send(
            {
              ...request,
              type: 'show',
              presentation,
              operationId,
              crashDumpsPath: app.getPath('crashDumps'),
              appVersion: app.getVersion()
            },
            (error) => {
              if (error)
                finish(
                  new NativeFileDialogError(
                    'ipc-disconnected',
                    'Native file dialog helper disconnected.'
                  )
                )
            }
          )
        } else if (
          raw?.type === 'selection-error' &&
          ready &&
          typeof raw.errorCode === 'string' &&
          /^[A-Z_]{2,32}$|^selection-failed$/.test(raw.errorCode)
        ) {
          operation.phase('selection-rejected', { helperPid: child.pid, errorCode: raw.errorCode })
        } else if (raw?.type === 'result' && ready && !selection) {
          try {
            selection = parseFileDialogResult(request.kind, raw.result)
            exitTimeout = setTimeout(
              () =>
                finish(
                  new NativeFileDialogError(
                    'exit-timeout',
                    'Native file dialog helper did not exit.'
                  )
                ),
              5_000
            )
          } catch {
            finish(
              new NativeFileDialogError(
                'invalid-result',
                'Native file dialog helper returned an invalid selection.'
              )
            )
          }
        } else
          finish(new NativeFileDialogError('helper-error', 'Native file dialog helper failed.'))
      })
      child.once('exit', (exitCode, exitSignal) => {
        operation.phase('helper-exited', { helperPid: child.pid, exitCode, exitSignal })
        // Wait for clean exit even after a result: heap corruption can surface during teardown.
        if (!settled)
          finish(
            exitCode === 0 && selection
              ? undefined
              : new NativeFileDialogError(
                  'unexpected-exit',
                  'Native file dialog helper exited unexpectedly.'
                )
          )
      })
      if (signal?.aborted) abort()
    })
    if (result.canceled) operation.cancel()
    else operation.complete()
    return result
  } catch (error) {
    if (signal?.aborted) operation.cancel()
    else
      operation.fail(error, {
        reason: error instanceof NativeFileDialogError ? error.reason : 'helper-setup-failed'
      })
    throw error
  } finally {
    if (parent) {
      activeParents.delete(parent)
      if (!parent.isDestroyed() && wasEnabled) {
        parent.setEnabled(true)
        if (!signal?.aborted && !shuttingDown) parent.focus()
      }
    }
    if (profile)
      void rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() =>
        log.warn('helper profile cleanup deferred', { operationId })
      )
  }
}
