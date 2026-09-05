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

export type AutomaticPackageMirrorCandidate = Readonly<{
  name: string
  mirror: PackageMirror
  probeUrl: string
  biocondaProbeUrl: string
  trustedDomains: readonly string[]
}>

const condaRepodata = (base: string): string =>
  `${base}anaconda/cloud/conda-forge/noarch/current_repodata.json`
const biocondaRepodata = (base: string): string =>
  `${base}anaconda/cloud/bioconda/noarch/current_repodata.json`

export const CURATED_MIRRORS = {
  cn: {
    condaChannel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/',
    pypiIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    cranMirror: 'https://mirrors.tuna.tsinghua.edu.cn/CRAN/'
  }
} as const

// This catalog is the source of truth for mirrors selected without an explicit user setting.
// Notebook network policy derives its trusted package-registry hosts from the same URLs.
export const AUTOMATIC_PACKAGE_MIRROR_CANDIDATES: readonly AutomaticPackageMirrorCandidate[] = [
  {
    name: 'public',
    mirror: {},
    probeUrl: 'https://conda.anaconda.org/conda-forge/noarch/current_repodata.json',
    biocondaProbeUrl: 'https://conda.anaconda.org/bioconda/noarch/current_repodata.json',
    trustedDomains: ['conda.anaconda.org']
  },
  {
    name: 'tuna',
    mirror: { ...CURATED_MIRRORS.cn },
    probeUrl: condaRepodata('https://mirrors.tuna.tsinghua.edu.cn/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.tuna.tsinghua.edu.cn/'),
    trustedDomains: ['mirrors.tuna.tsinghua.edu.cn', 'pypi.tuna.tsinghua.edu.cn']
  },
  {
    name: 'ustc',
    mirror: {
      condaChannel: 'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/',
      pypiIndex: 'https://mirrors.ustc.edu.cn/pypi/web/simple',
      cranMirror: 'https://mirrors.ustc.edu.cn/CRAN/'
    },
    probeUrl: condaRepodata('https://mirrors.ustc.edu.cn/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.ustc.edu.cn/'),
    trustedDomains: ['mirrors.ustc.edu.cn', 'mirrors.nju.edu.cn']
  },
  {
    name: 'aliyun',
    mirror: {
      condaChannel: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge/',
      pypiIndex: 'https://mirrors.aliyun.com/pypi/simple',
      cranMirror: 'https://mirrors.aliyun.com/CRAN/'
    },
    probeUrl: condaRepodata('https://mirrors.aliyun.com/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.aliyun.com/'),
    trustedDomains: ['mirrors.aliyun.com']
  }
]

export const AUTOMATIC_PACKAGE_MIRROR_DOMAINS = [
  ...new Set(AUTOMATIC_PACKAGE_MIRROR_CANDIDATES.flatMap((candidate) => candidate.trustedDomains))
]

// "View available mirrors" help link target: the TUNA Anaconda mirror help page, which lists the
// real conda channel mirror source addresses (…/anaconda/cloud/conda-forge/ etc.) plus the matching
// pip/CRAN mirrors — consistent with the CN region default in main/notebook/mirror.ts. Lives in
// shared (not main/notebook/mirror.ts) so the renderer settings UI can import it without crossing
// the main/renderer boundary; main re-exports it for its existing consumers. (Kept a plain constant
// — this module loads in the renderer, where process.env isn't reliably available.)
export const MIRROR_HELP_URL = 'https://mirrors.tuna.tsinghua.edu.cn/help/anaconda/'
