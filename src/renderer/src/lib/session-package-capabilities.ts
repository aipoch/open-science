import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

const isWebEventSurface = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.hasAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)

const isRemoteWebSurface = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true' &&
  document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'local'

// Local Web may import because it can stage an uploaded package; remote Web stays hidden.
export const sessionPackageImportAvailable = (): boolean =>
  Boolean(window.api?.sessions?.importPackage) && !isRemoteWebSurface()

// Organization cases use LOCAL IPC routes: available in Electron desktop and Local Web, hidden in Remote Web.
export const orgCaseSharingAvailable = (): boolean =>
  Boolean(window.api?.sessions?.orgCasesList) && !isRemoteWebSurface()

// Lab server and account settings are only configurable in the desktop app (LabPanel blocks Web).
export const labSettingsAvailable = (): boolean => !isWebEventSurface()
