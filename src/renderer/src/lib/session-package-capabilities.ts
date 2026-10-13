import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

export const sessionPackageImportAvailable = (): boolean =>
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' &&
  Boolean(window.api?.sessions?.importPackage)
