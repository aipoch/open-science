import '../assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { resolveLocaleFromTags } from '../../../shared/locale'
import { MigrationProgress } from './migration-progress'

// Initialize only translations and the isolated progress surface, never the normal app bootstrap.
initI18n(resolveLocaleFromTags(navigator.languages))
const theme = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', theme.matches)
}
applyTheme()
theme.addEventListener('change', applyTheme)
createRoot(document.getElementById('root')!).render(
  <MigrationProgress bridge={window.migrationProgress} />
)
