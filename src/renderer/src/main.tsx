// Node-global shim (process/global) must run before any lazy Ketcher chunk loads.
import './lib/node-globals-shim'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installStreamdown } from '@/components/streamdown/install-streamdown'

// Install before React renders so Streamdown hooks work on first interaction.
installStreamdown()

// Swallow file drops that miss an explicit dropzone: without this, Electron navigates the whole window
// to the dropped file (file://…), tearing down the app. Dropzones call stopPropagation/preventDefault
// themselves, so this only catches strays.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
