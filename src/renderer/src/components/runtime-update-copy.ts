import type { TFunction } from 'i18next'

export const runtimeUpdateCopy = (
  id: string,
  t: TFunction,
  unknownOccupancy = false
): { title: string; description: string } => {
  switch (id) {
    case 'S04':
      return {
        title: t('Tasks are still running'),
        description: t('Wait for active tasks to finish, or stop them before updating.')
      }
    case 'S06':
      return {
        title: t('Another Open-Science is using the service'),
        description: t(
          'Finish your work in the other app and quit it from its application menu, then recheck.'
        )
      }
    case 'S07':
      return {
        title: t('Application files are in use'),
        description: t(
          'Stop the other service from the app or terminal that started it, then recheck.'
        )
      }
    case 'S08':
      return {
        title: t('Cannot preserve the service settings'),
        description: t(
          'The service settings cannot be safely preserved. The service is unchanged; manage it through its original installation.'
        )
      }
    case 'S09':
      return {
        title: t('Service shutdown is not confirmed'),
        description: t(
          'The service did not stop within 15 seconds. The update has not been installed. Recover the app before continuing.'
        )
      }
    case 'S10':
      return {
        title: t('Ready to continue installation'),
        description: t(
          'The service stopped normally. Installation has not started. Cancelling will restore the service before returning to your work.'
        )
      }
    case 'S11':
      return {
        title: t('Normal shutdown could not be confirmed'),
        description: t(
          'The service exited, but not all work is confirmed saved. Installation is paused until the app can recover safely.'
        )
      }
    case 'S12':
      return {
        title: t('The service has not recovered'),
        description: t(
          'Previous background operations have not been confirmed finished. The update has not continued.'
        )
      }
    case 'S13':
      return {
        title: t('Installation result is unknown'),
        description: t(
          'Recover the app to check the installation. An unverified installation cannot be started or installed again here.'
        )
      }
    case 'S14':
      return {
        title: t('Application files are incomplete'),
        description: t(
          'Repair the app through its original installation method, then recover the app to check the result. Keep your configuration and data folders.'
        )
      }
    case 'S20':
      return {
        title: t('Preparing update…'),
        description: t('Checking unfinished tasks and whether the update can be installed.')
      }
    case 'S21':
      return {
        title: t('Stopping the service…'),
        description: t(
          'Installation starts only after shutdown has finished and its result is confirmed.'
        )
      }
    case 'S22':
      return {
        title: t('Preparing installation…'),
        description: t(
          'The service stopped normally. Installation conditions are being checked again.'
        )
      }
    case 'S23':
      return {
        title: t('Installing update…'),
        description: t(
          'Installation has started and cannot be cancelled. The app will reopen after installation.'
        )
      }
    case 'S24':
      return {
        title: t('Cancelling update…'),
        description: t(
          'The service must recover before returning to your work. Interrupted tasks will not restart automatically.'
        )
      }
    case 'S31':
      return {
        title: t('Service stopped; installation is blocked'),
        description: unknownOccupancy
          ? t(
              'The service stopped, but installation conditions could not be confirmed. Recover the app before continuing.'
            )
          : t(
              'Other services are using the application files. Installation has not started. Recover the app before addressing the other services.'
            )
      }
    case 'S32':
      return {
        title: t('Manual update required'),
        description: t(
          'This installation method does not support protected in-app updates. The app and service are unchanged. Update through the original installation method.'
        )
      }
    case 'S33':
      return {
        title: t('Update conditions are unknown'),
        description: t(
          'Application files could not be verified for replacement. The service has not been stopped. Continue working or recheck later.'
        )
      }
    case 'S34':
      return {
        title: t('A previous operation is still finishing'),
        description: t(
          'Wait for the previous shutdown or update operation to finish, then recheck. This attempt has not stopped the service.'
        )
      }
    default:
      return {
        title: t('Ready to install'),
        description: t(
          'The update is downloaded. Tasks and installation conditions will be checked again before the app closes to install it.'
        )
      }
  }
}
