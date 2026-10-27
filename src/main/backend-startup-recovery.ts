import { app, BrowserWindow, dialog, shell } from 'electron'
import { resolveLocale } from '../shared/locale'
import { DesktopBackendStartupError, type BackendStartupStatus } from './backend-startup'
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
    if (response === retryIndex) app.relaunch()
    app.exit(1)
    return
  }
}

// Use an in-memory session: the profile must stay closed until credential validation completes.
export function createCredentialStartupNotice(): {
  update(status: BackendStartupStatus): void
  dispose(): void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let window: BrowserWindow | undefined
  let shown = false
  const dispose = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (window && !window.isDestroyed()) window.destroy()
    window = undefined
  }
  return {
    update(status) {
      if (status.stage !== 'credentials' || status.kind !== 'progress') {
        dispose()
        return
      }
      if (timer || shown) return
      timer = setTimeout(() => {
        timer = undefined
        shown = true
        const i18n = createNativeI18n(resolveLocale('system', app.getPreferredSystemLanguages()))
        const translate = i18n.t.bind(i18n)
        const title = translate('Waiting for system credential access')
        const description = translate(
          'If the system asks for authorization, respond to its prompt. Startup will continue when credential access completes. No credentials will be reset.'
        )
        const escape = (value: string): string =>
          value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        window = new BrowserWindow({
          width: 500,
          height: 300,
          title: 'Open-Science',
          show: false,
          resizable: false,
          autoHideMenuBar: true,
          webPreferences: {
            partition: 'credential-startup-notice',
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        })
        const notice = window
        notice.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        void notice
          .loadURL(
            'data:text/html;charset=utf-8,' +
              encodeURIComponent(
                `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Open-Science</title><style>:root{color-scheme:light dark}body{font:14px system-ui;margin:32px;line-height:1.6;background:Canvas;color:CanvasText}h1{font-size:18px;font-weight:600}</style></head><body><h1>${escape(title)}</h1><p role="status">${escape(description)}</p></body></html>`
              )
          )
          .then(() => {
            if (!notice.isDestroyed()) notice.showInactive()
          })
          .catch(() => {
            if (!notice.isDestroyed()) notice.destroy()
          })
      }, 1500)
    },
    dispose
  }
}
