import { app, dialog, shell } from 'electron'
import { readDevSession, relaunchWithDevSession } from './dev-runtime-session'
import { resolveLocale } from '../shared/locale'
import { DesktopBackendStartupError } from './backend-startup'
import { credentialRecoveryMessage } from './credential-identity/recovery'
import { createNativeI18n } from './locale/main-process-messages'

// Retry is available only after our own launch handle has confirmed process exit. Relaunch the
// shell as well so credential failure latches and partially installed startup handlers are fresh.
export async function recoverDesktopBackendStartup(
  error: DesktopBackendStartupError
): Promise<void> {
  const languages = app.getPreferredSystemLanguages()
  const i18n = createNativeI18n(resolveLocale('system', languages))
  const translate = i18n.t.bind(i18n)
  const detail = error.credentialFailure
    ? credentialRecoveryMessage(error.credentialFailure, languages)
    : error.canRetry
      ? translate(
          'The backend stopped before startup completed. Check the logs, resolve the cause, and retry.'
        )
      : translate(
          'The backend did not finish starting. It may still be running. Check the logs before quitting; no process will be terminated automatically.'
        )
  const retryIndex = error.canRetry ? 0 : -1
  const logsIndex = error.canRetry ? 1 : 0
  const quitIndex = error.canRetry ? 2 : 1
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Open-Science',
      message: translate('Open-Science could not start the backend.'),
      detail: `${detail}\n\nSTARTUP_STAGE: ${error.stage}`,
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
    if (response === retryIndex)
      relaunchWithDevSession(readDevSession(!app.isPackaged && import.meta.env.DEV), () =>
        app.relaunch()
      )
    app.exit(1)
    return
  }
}
