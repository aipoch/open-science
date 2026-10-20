import type { TFunction } from 'i18next'

export const runtimeUpdateCopy = (
  id: string,
  t: TFunction,
  unknownOccupancy = false
): { title: string; description: string } => {
  switch (id) {
    case 'S25':
    case 'S29':
      return {
        title: t('Checking…'),
        description: t('Checking whether the app can safely continue. Please wait.')
      }
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
        title: t('The app cannot update automatically'),
        description: t(
          'The update cannot keep your current settings. Cancel to continue working, or check again after updating Open-Science separately.'
        )
      }
    case 'S09':
      return {
        title: t('The app has not finished closing'),
        description: t(
          'The app did not finish closing. The update has not started. Check and reopen the app before trying to update again.'
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
        title: t('Some work may not have been saved'),
        description: t(
          'The update is paused. Check and reopen the app, then review your tasks. Interrupted tasks will not restart automatically.'
        )
      }
    case 'S12':
      return {
        title: t('The app is not ready to reopen'),
        description: t(
          'Previous operations have not finished or their results could not be checked. The update is paused. Wait a moment, then check again.'
        )
      }
    case 'S13':
      return {
        title: t('Installation result is unknown'),
        description: t(
          'Wait for the installer to finish, then check the installation. The app will reopen only after verification succeeds.'
        )
      }
    case 'S14':
      return {
        title: t('Application files are incomplete'),
        description: t(
          'Reinstall Open-Science using its installer or package manager, then check the installation. This button checks files; it does not repair them. Keep your configuration and data folders.'
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
          'Installation has started and cannot be cancelled. This may take a few minutes. If your system asks for permission, approve the update to continue. The app will reopen when installation finishes.'
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
              'The update cannot start yet. Check and reopen the app before trying to update again.'
            )
          : t(
              'Application files are still in use. The update has not started. Check and reopen the app to continue working.'
            )
      }
    case 'S32':
      return {
        title: t('Manual update required'),
        description: t(
          'Update Open-Science using its installer or package manager, then check again. You can cancel to continue working with this version.'
        )
      }
    case 'S33':
      return {
        title: t('Update conditions are unknown'),
        description: t(
          'Application files could not be verified for replacement. The service has not been stopped. Continue working or recheck later.'
        )
      }
    case 'S35':
      return {
        title: t('Update preparation failed'),
        description: t(
          'The app is still open. Resolve the problem and try again, or cancel to continue working.'
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
