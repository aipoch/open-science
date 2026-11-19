import { app, dialog, shell } from 'electron'
import { dirname, isAbsolute, join } from 'node:path'
import { readFileWithinLimit } from '@aipoch/durable-files'
import { resolveLocale } from '../shared/locale'
import { DesktopBackendStartupError } from './backend-startup'
import { credentialRecoveryMessage } from './credential-identity/recovery'
import { createNativeI18n } from './locale/main-process-messages'
import { SETTINGS_RESOURCE_LIMITS } from './settings/settings-resource-limits'
import { isDataDirectoryUnavailable } from './storage/data-directory-availability'

// The launcher creates its logs in the selected config root's logs directory. Look up the
// current selection locally so user paths never enter the startup status or its telemetry.
async function unavailableDataDirectory(
  error: DesktopBackendStartupError
): Promise<string | undefined> {
  if (!error.dataDirectoryUnavailable || !error.canRetry) return undefined
  try {
    const contents = await readFileWithinLimit(
      join(dirname(error.logs), 'settings.json'),
      SETTINGS_RESOURCE_LIMITS.documentBytes
    )
    const path: unknown = JSON.parse(contents)?.dataRoot
    if (typeof path === 'string' && isAbsolute(path) && (await isDataDirectoryUnavailable(path)))
      return path
  } catch {
    // The saved selection may have changed since the child failed.
  }
  return undefined
}

// Retry is available only after our own launch handle has confirmed process exit. Relaunch the
// shell as well so credential failure latches and partially installed startup handlers are fresh.
export async function recoverDesktopBackendStartup(
  error: DesktopBackendStartupError
): Promise<void> {
  const languages = app.getPreferredSystemLanguages()
  const i18n = createNativeI18n(resolveLocale('system', languages))
  const translate = i18n.t.bind(i18n)
  const path = await unavailableDataDirectory(error)
  const genericDetail = error.credentialFailure
    ? credentialRecoveryMessage(error.credentialFailure, languages)
    : error.canRetry
      ? translate(
          'The backend stopped before startup completed. Check the logs, resolve the cause, and retry.'
        )
      : translate(
          'The backend did not finish starting. It may still be running. Check the logs before quitting; no process will be terminated automatically.'
        )
  let detail = `${genericDetail}\n\nSTARTUP_STAGE: ${error.stage}`
  if (path) {
    const instruction =
      process.platform === 'win32'
        ? translate(
            'Check the drive letter, reconnect the data drive, then select “Retry startup”.'
          )
        : translate('Reconnect the drive containing this folder, then select “Retry startup”.')
    detail = `${path}\n\n${instruction}`
  }
  const retryIndex = error.canRetry ? 0 : -1
  const logsIndex = error.canRetry ? 1 : 0
  const quitIndex = error.canRetry ? 2 : 1
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Open-Science',
      message: path
        ? translate('The configured data folder is unavailable.')
        : translate('Open-Science could not start the backend.'),
      detail,
      buttons: [
        ...(error.canRetry ? [translate('Retry startup')] : []),
        translate('Open startup logs'),
        translate('Quit', { context: 'verb', ns: 'common' })
      ],
      defaultId: error.canRetry ? retryIndex : logsIndex,
      cancelId: quitIndex,
      noLink: true
    })
    if (response === logsIndex) {
      const failure = await shell.openPath(error.logs)
      if (failure)
        await dialog.showMessageBox({
          type: 'error',
          title: 'Open-Science',
          message: translate('Could not open the logs folder.'),
          detail: error.logs
        })
      continue
    }
    if (response === retryIndex) app.relaunch()
    app.exit(1)
    return
  }
}
