import { app } from 'electron'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { FILE_DIALOG_HELPER_ARG } from './file-dialog-protocol'

// Dispatch before importing desktop startup: the helper must never acquire the application lock,
// open its profile, attach a backend, or install the main process's fatal-error handlers.
if (process.argv.includes(FILE_DIALOG_HELPER_ARG)) {
  // Suppress the helper's Dock presence before loading its GUI.
  // Accessory applications can still show and focus windows; the main app stays regular.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  void import('./file-dialog-helper')
    .then(({ runFileDialogHelper }) => runFileDialogHelper())
    .catch(() => app.exit(1))
} else {
  void import('./index').catch((error: unknown) => {
    createLogger('desktop-bootstrap').error(
      'desktop entry loading failed',
      diagnosticErrorFields(error)
    )
    app.exit(1)
  })
}
