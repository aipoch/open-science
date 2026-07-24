import '../assets/main.css'
import './office-preview.css'

import { connectOfficePreviewRuntime } from './office-preview-controller'
import { createOfficePreviewFrameBridge } from './office-preview-frame-bridge'
import { runOfficePreview } from './office-preview-runtime'

const container = document.getElementById('office-preview-root')
if (!(container instanceof HTMLDivElement)) {
  throw new Error('Office preview root is unavailable')
}

const sessionId = new URL(window.location.href).searchParams.get('sessionId')
if (!sessionId) throw new Error('Office preview session is unavailable')

// The cross-site frame uses structured messages; no Electron API is exposed inside the runtime.
const bridge = createOfficePreviewFrameBridge({ runtimeWindow: window, sessionId })
const disconnect = connectOfficePreviewRuntime({
  bridge,
  container,
  runPreview: runOfficePreview
})

window.addEventListener('beforeunload', () => {
  bridge.dispose()
  void disconnect()
})
