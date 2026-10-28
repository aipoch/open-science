import type { WebContents } from 'electron'
import { createObservationNativeHost } from './native-host'
import { captureElectronObservationView } from '../run-observation/electron-capture'
import { startElectronSurfaceRecording } from '../browser-recordings/electron-surface-driver'
import { desktopObservationFrameRegistry } from '../replay-viewer/desktop-frame-registry'

/** Install only in Electron. The backend imports bridge.ts, never this native implementation. */
export function createDesktopObservationNativeHandler(options: {
  documentFor(clientId: string): WebContents | undefined
}): ReturnType<typeof createObservationNativeHost> {
  return createObservationNativeHost({
    ...options,
    frames: desktopObservationFrameRegistry,
    capture: captureElectronObservationView,
    startDriver: startElectronSurfaceRecording
  })
}
