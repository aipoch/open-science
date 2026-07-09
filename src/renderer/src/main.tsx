import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installStreamdown } from '@/components/streamdown/install-streamdown'

// Install before React renders so Streamdown hooks work on first interaction.
installStreamdown()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
