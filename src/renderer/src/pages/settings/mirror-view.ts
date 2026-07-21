import type { PackageMirror } from '../../../../shared/mirror'

export { MIRROR_HELP_URL } from '../../../../shared/mirror'

// True when any mirror field is set (conda channel or PyPI index). cranMirror is
// intentionally excluded from the UI-facing check: this panel only exposes conda/pip; R's CRAN
// mirror is configured elsewhere (Plan C).
export const isMirrorConfigured = (mirror: PackageMirror | undefined): boolean =>
  Boolean(mirror && (mirror.condaChannel || mirror.pypiIndex || mirror.caBundle))

// Default state copy matches the mockup exactly; configured state summarizes the active hosts.
export const mirrorStatusText = (mirror: PackageMirror | undefined): string => {
  if (!isMirrorConfigured(mirror)) {
    return 'Not configured — packages come from the public hosts (conda.anaconda.org, pypi.org)'
  }
  const parts = [mirror!.condaChannel, mirror!.pypiIndex].filter(Boolean)
  return `Fetching packages from ${parts.join(' , ')}`
}
