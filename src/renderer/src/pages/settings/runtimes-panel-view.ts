import type { TFunction } from 'i18next'

import type { DiscoveredInterpreter } from '../../../../shared/notebook-runtime'

// Describers for the runtime cards. They live outside RuntimesPanel.tsx so they can be unit-tested
// directly — a .tsx module may only export components (react-refresh/only-export-components), the
// same reason uninstallDisabledHint has its own module. Each takes `t` rather than reaching for the
// i18next singleton, keeping it a pure function of (input, locale).

// Human provider/type for the card badge (provenance + conda env name), e.g. "App-managed",
// "Conda: bio", "System".
export const providerType = (env: DiscoveredInterpreter, t: TFunction): string => {
  if (env.provenance === 'app-managed') return t('App-managed')
  if (env.provenance === 'agent-created') return t('Agent-created')
  // The conda env name is the user's own label — it interpolates unchanged.
  if (env.condaEnv) return t('Conda: {{name}}', { name: env.condaEnv })
  return t('System', { context: 'runtime' })
}

// One-line readiness for a discovered env: version plus runnable/gap detail.
export const envReadyLine = (env: DiscoveredInterpreter, t: TFunction): string => {
  const version = env.version ? ` · ${env.version}` : ''
  // `detail` is a runtime-probe string from the main process, not catalog copy.
  return env.runnable ? `${t('Ready')}${version}` : `${env.detail ?? t('Not runnable')}${version}`
}

export const managedLine = (
  runnable: boolean,
  preparing: boolean,
  t: TFunction,
  message?: string
): string => {
  if (preparing) return message ?? t('Downloading managed runtime…')
  return runnable ? t('Installed and ready') : t('Managed runtime is not set up yet')
}
