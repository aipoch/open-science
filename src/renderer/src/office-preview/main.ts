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

const openOfficeFind = (): boolean => {
  const open = document.querySelector<HTMLButtonElement>(
    '.spreadsheet-review-find-open, .pptx-review-find-open'
  )
  if (!open) return false
  if (open.hidden) {
    document
      .querySelector<HTMLInputElement>('.spreadsheet-review-find-input, .pptx-review-find-input')
      ?.focus()
  } else {
    open.click()
  }
  return true
}

// The cross-site frame uses structured messages; no Electron API is exposed inside the runtime.
const bridge = createOfficePreviewFrameBridge({ runtimeWindow: window, sessionId })
bridge.onFind(() => {
  openOfficeFind()
})
window.addEventListener(
  'keydown',
  (event) => {
    if (
      event.key.toLowerCase() !== 'f' ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.shiftKey
    ) {
      return
    }
    if (openOfficeFind()) event.preventDefault()
  },
  true
)
const disconnect = connectOfficePreviewRuntime({
  bridge,
  container,
  runPreview: runOfficePreview
})

window.addEventListener('beforeunload', () => {
  bridge.dispose()
  void disconnect()
})
