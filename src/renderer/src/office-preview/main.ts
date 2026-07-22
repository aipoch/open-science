import '../assets/main.css'
import './office-preview.css'

import { connectOfficePreviewRuntime } from './office-preview-controller'
import { runOfficePreview } from './office-preview-runtime'

const container = document.getElementById('office-preview-root')
if (!(container instanceof HTMLDivElement)) {
  throw new Error('Office preview root is unavailable')
}

const disconnect = connectOfficePreviewRuntime({
  bridge: window.officePreviewRuntime,
  container,
  runPreview: runOfficePreview
})

window.addEventListener('beforeunload', () => {
  void disconnect()
})
