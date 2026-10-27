import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

// Local Web may import because it can stage an uploaded package; remote Web stays hidden.
export const sessionPackageImportAvailable = (): boolean =>
  Boolean(window.api?.sessions?.importPackage) &&
  (document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'local')
