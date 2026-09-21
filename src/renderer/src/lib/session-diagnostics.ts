import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

export const sessionDiagnosticsAvailable = (): boolean =>
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' &&
  typeof window.api?.sessions?.inspectDiagnostics === 'function' &&
  typeof window.api?.sessions?.exportDiagnostics === 'function' &&
  typeof window.api?.sessions?.cancelDiagnostics === 'function'
