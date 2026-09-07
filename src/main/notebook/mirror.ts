import { CURATED_MIRRORS, type PackageMirror } from '../../shared/mirror'

export { CURATED_MIRRORS, MIRROR_HELP_URL } from '../../shared/mirror'

// Cheap synchronous locale fallback for call sites that cannot use the asynchronous speed probe: a
// Chinese locale gets the CN mirror default; everyone else uses public hosts (empty overrides).
const isCnLocale = (locale: string): boolean => /^zh\b/i.test(locale) || /-CN$/i.test(locale)

export function resolveMirror(locale: string): PackageMirror {
  return isCnLocale(locale) ? { ...CURATED_MIRRORS.cn } : {}
}

// The mirror actually used by the provisioner/package-manager: any user-configured field wins;
// otherwise fall back to the region default. cloud.r-project.org (the CRAN default when cranMirror
// is unset) is applied by Plan C's package-manager, not here.
export function effectiveMirror(
  configured: PackageMirror | undefined,
  locale: string
): PackageMirror {
  const hasAny =
    configured &&
    (configured.condaChannel ||
      configured.pypiIndex ||
      configured.cranMirror ||
      configured.caBundle)
  return hasAny ? configured! : resolveMirror(locale)
}
