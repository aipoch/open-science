import '../assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { resolveLocaleFromTags } from '../../../shared/locale'
import { MigrationProgress } from './migration-progress'

// Initialize only translations and the isolated progress surface, never the normal app bootstrap.
const initialLocale = resolveLocaleFromTags(navigator.languages)
const theme = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', theme.matches)
}
applyTheme()
theme.addEventListener('change', applyTheme)
const mount = (): void => {
  createRoot(document.getElementById('root')!).render(
    <MigrationProgress bridge={window.migrationProgress} />
  )
}
// The helper has no application bootstrap: prepare its own catalog before the first paint.
void Promise.resolve(prepareI18nLocale(initialLocale))
  .then(() => initI18n(initialLocale))
  .catch(() => initI18n('en'))
  .then(mount)
