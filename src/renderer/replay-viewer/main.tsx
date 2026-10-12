import '../src/assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '../src/i18n'
import { applyHtmlLang, resolveInitialLocale } from '../src/lib/locale-preference'
import { applyTheme, resolveInitialTheme } from '../src/lib/theme'
import { ApplicationErrorBoundary } from '../src/components/application-error-boundary'
import { ViewerApp } from './ViewerApp'
import { ReplayViewerClient } from './client'

applyTheme(resolveInitialTheme())
const client = new ReplayViewerClient()
// Each viewer has an isolated HTTP origin, so it cannot read the desktop shell's language cache.
// Resolve Main's desktop preference before loading the catalog and painting either Replay mode.
void client
  .initialLocale(resolveInitialLocale(), AbortSignal.timeout(3000))
  .then(async (locale) => {
    try {
      await prepareI18nLocale(locale)
    } catch {
      // English source copy has no catalog dependency. A failed locale chunk must not prevent
      // mounting the normal observation/error surface.
      locale = 'en'
    }
    initI18n(locale)
    applyHtmlLang(locale)
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ApplicationErrorBoundary>
          <ViewerApp client={client} />
        </ApplicationErrorBoundary>
      </StrictMode>
    )
  })
