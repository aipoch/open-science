import type { TFunction } from 'i18next'

import type { ProvisionProgressEvent } from '../../../../shared/notebook-env'

export const provisionProgressText = (
  t: TFunction,
  event: ProvisionProgressEvent | undefined
): string => {
  if (!event) return ''
  switch (event.code) {
    case 'legacy-package-removed':
      return t('Removed a legacy package blocked by the Windows path limit.')
    case 'environment-create':
      return t('Creating {{environment}} environment…', { environment: event.environment })
    case 'python-ready':
      return t('Python environment ready')
    case 'r-ready':
      return t('R environment ready')
    case 'updating-default-packages':
      return t('Updating default packages…')
    case 'updating-r-packages':
      return t('Updating R packages…')
    case 'default-environments-updated':
      return t('Default environments updated')
    case 'restoring-environment':
      return t('Restoring {{environment}}…', { environment: event.environment })
    case 'runtime-restored':
      return t('Runtime restored')
    case 'environment-ready':
      return t('{{environment}} ready', { environment: event.environment })
    case 'preparing-packages':
      return t('Preparing {{environment}} packages…', { environment: event.environment })
    case 'retrying-short-cache':
      return t('Retrying {{environment}} with the short Windows package cache…', {
        environment: event.environment
      })
    case 'repairing-windows-crash':
      return t('Repairing {{environment}} after a Windows runtime crash…', {
        environment: event.environment
      })
    case 'repairing-package-cache':
      return t('Repairing {{environment}} package cache…', { environment: event.environment })
    case 'verifying-interpreter':
      return t('Verifying {{environment}} interpreter…', { environment: event.environment })
    case 'verifying-packages':
      return t('Verifying {{completed}}/{{total}} packages…', {
        completed: event.completed,
        total: event.total
      })
    case 'fetching-runtime-manifest':
      return t('Fetching managed runtime manifest…')
    case 'downloading-python-runtime':
      return t('Downloading managed Python runtime')
    case 'downloading-r-runtime':
      return t('Downloading managed R runtime')
    case 'runtime-downloaded':
      return t('Downloaded {{file}}', { file: event.file })
    case 'runtime-pack-unavailable':
      return t('Managed runtime pack unavailable')
    default:
      return event satisfies never
  }
}
