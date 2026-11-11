import { app, crashReporter, dialog } from 'electron'
import { isAbsolute } from 'node:path'
import { FILE_DIALOG_PROFILE_ENV, isFileDialogHelperRequest } from './file-dialog-protocol'

export async function runFileDialogHelper(): Promise<void> {
  const profile = process.env[FILE_DIALOG_PROFILE_ENV]
  if (!process.send || !process.connected || !profile || !isAbsolute(profile)) {
    app.exit(1)
    return
  }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.disableHardwareAcceleration()
  // The inherited IPC channel also owns the helper lifetime if the desktop is killed.
  process.once('disconnect', () => app.exit(0))
  const watchdog = setTimeout(() => app.exit(1), 310_000)
  watchdog.unref()
  await app.whenReady()
  process.once('message', async (raw: unknown) => {
    if (!isFileDialogHelperRequest(raw)) {
      app.exit(1)
      return
    }
    try {
      // Retain local dumps outside the disposable profile; never upload diagnostic data.
      app.setPath('crashDumps', raw.crashDumpsPath)
      crashReporter.start({
        productName: 'Open-Science',
        companyName: 'AIPOCH',
        uploadToServer: false,
        compress: false,
        extra: {
          appVersion: raw.appVersion,
          role: 'file-dialog-helper',
          operationId: raw.operationId
        }
      })
      if (process.platform === 'darwin') app.focus({ steal: true })
      const result =
        raw.kind === 'save'
          ? await dialog.showSaveDialog(raw.options)
          : await dialog.showOpenDialog(raw.options)
      process.send?.({ type: 'result', result }, () => app.exit(0))
    } catch {
      // A native crash cannot reach this catch. The desktop observes its exit independently.
      process.send?.({ type: 'error' }, () => app.exit(1))
    }
  })
  process.send({ type: 'ready' }, (error) => {
    if (error) app.exit(1)
  })
}
