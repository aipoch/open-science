import type { TFunction } from 'i18next'

import type { PackageMirror } from '../../../../shared/mirror'

export { MIRROR_HELP_URL } from '../../../../shared/mirror'

// True when any field exposed by this panel is set. cranMirror is
// intentionally excluded from the UI-facing check: this panel only exposes conda/pip; R's CRAN
// mirror is configured elsewhere (Plan C).
export const isMirrorConfigured = (mirror: PackageMirror | undefined): boolean =>
  Boolean(mirror && (mirror.condaChannel || mirror.pypiIndex || mirror.caBundle))

// Summarize configured preferences without claiming which automatic candidate is active.
// Host names and the user's own mirror URLs are config values, so only the sentence around them
// is translated.
export const mirrorStatusText = (mirror: PackageMirror | undefined, t: TFunction): string => {
  if (!isMirrorConfigured(mirror)) {
    return t('Automatic mirror selection')
  }
  const parts = [mirror!.condaChannel, mirror!.pypiIndex].filter(Boolean)
  if (parts.length === 0) return t('Automatic mirror selection · Custom CA bundle configured')
  return t('Fetching packages from {{hosts}}', { hosts: parts.join(' , ') })
}
