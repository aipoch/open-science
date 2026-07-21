// Non-secret package-mirror configuration. Shared across renderer settings UI, preload, main
// settings, provisioner (A), and package-manager (C). cranMirror backs Plan C's R install.packages()
// fallback. caBundle is a filesystem path to a PEM CA bundle (enterprise TLS-inspecting proxy), not a
// secret; it is exported to the download tools (conda/pip/R) so their HTTPS verification trusts it.
export type PackageMirror = {
  condaChannel?: string
  pypiIndex?: string
  cranMirror?: string
  caBundle?: string
}

// "View available mirrors" help link target: the TUNA Anaconda mirror help page, which lists the
// real conda channel mirror source addresses (…/anaconda/cloud/conda-forge/ etc.) plus the matching
// pip/CRAN mirrors — consistent with the CN region default in main/notebook/mirror.ts. Lives in
// shared (not main/notebook/mirror.ts) so the renderer settings UI can import it without crossing
// the main/renderer boundary; main re-exports it for its existing consumers. (Kept a plain constant
// — this module loads in the renderer, where process.env isn't reliably available.)
export const MIRROR_HELP_URL = 'https://mirrors.tuna.tsinghua.edu.cn/help/anaconda/'
