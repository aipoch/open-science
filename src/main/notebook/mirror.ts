import type { PackageMirror } from '../../shared/mirror'

export { MIRROR_HELP_URL } from '../../shared/mirror'

// Curated public mirror table (region-auto default, D10). Centralized here rather than scattered so
// it is easy to audit and later move to a build var. Public endpoints only — no secrets.
export const CURATED_MIRRORS = {
  cn: {
    condaChannel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/',
    pypiIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    cranMirror: 'https://mirrors.tuna.tsinghua.edu.cn/CRAN/'
  }
} as const

// Cheap locale heuristic: a Chinese locale gets the CN mirror default; everyone else uses public
// hosts (empty overrides). A more precise speed-based pick is future work (spec §9, §16).
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
