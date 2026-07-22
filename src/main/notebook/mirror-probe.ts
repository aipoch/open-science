import type { PackageMirror } from '../../shared/mirror'
import { CURATED_MIRRORS, effectiveMirror } from './mirror'

// A candidate mirror bundle + cheap URLs to measure both required conda channels. Public endpoints
// only (no secrets). The repodata URLs are HEAD-ed so no body is downloaded.
export type MirrorCandidate = {
  name: string
  mirror: PackageMirror
  probeUrl: string
  biocondaProbeUrl: string
}

const condaRepodata = (base: string): string =>
  `${base}anaconda/cloud/conda-forge/noarch/repodata.json`
const biocondaRepodata = (base: string): string =>
  `${base}anaconda/cloud/bioconda/noarch/repodata.json`

export const MIRROR_CANDIDATES: MirrorCandidate[] = [
  {
    name: 'public',
    mirror: {},
    probeUrl: 'https://conda.anaconda.org/conda-forge/noarch/repodata.json',
    biocondaProbeUrl: 'https://conda.anaconda.org/bioconda/noarch/repodata.json'
  },
  {
    name: 'tuna',
    mirror: { ...CURATED_MIRRORS.cn },
    probeUrl: condaRepodata('https://mirrors.tuna.tsinghua.edu.cn/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.tuna.tsinghua.edu.cn/')
  },
  {
    name: 'ustc',
    mirror: {
      condaChannel: 'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/',
      pypiIndex: 'https://mirrors.ustc.edu.cn/pypi/web/simple',
      cranMirror: 'https://mirrors.ustc.edu.cn/CRAN/'
    },
    probeUrl: condaRepodata('https://mirrors.ustc.edu.cn/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.ustc.edu.cn/')
  },
  {
    name: 'aliyun',
    mirror: {
      condaChannel: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge/',
      pypiIndex: 'https://mirrors.aliyun.com/pypi/simple',
      cranMirror: 'https://mirrors.aliyun.com/CRAN/'
    },
    probeUrl: condaRepodata('https://mirrors.aliyun.com/'),
    biocondaProbeUrl: biocondaRepodata('https://mirrors.aliyun.com/')
  }
]

// Measures one URL's latency (ms), rejecting on error/timeout. Injectable so the selection logic is
// testable without network.
export type LatencyProbe = (url: string, timeoutMs: number) => Promise<number>

const defaultProbe: LatencyProbe = async (url, timeoutMs) => {
  const started = Date.now()
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`probe failed ${res.status}`)
  return Date.now() - started
}

export type ProbeDeps = {
  probe?: LatencyProbe
  candidates?: MirrorCandidate[]
  timeoutMs?: number
}

// Probes every candidate's conda-forge and bioconda channels in parallel. A candidate is reachable only
// when both respond; its score is the slower response because both channels are required for installs.
// Returns undefined when no complete candidate responds (caller then falls back to the locale default).
export const pickFastestMirror = async (
  deps: ProbeDeps = {}
): Promise<PackageMirror | undefined> => {
  const probe = deps.probe ?? defaultProbe
  const candidates = deps.candidates ?? MIRROR_CANDIDATES
  const timeoutMs = deps.timeoutMs ?? 2500

  const timed = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const [condaMs, biocondaMs] = await Promise.all([
          probe(candidate.probeUrl, timeoutMs),
          probe(candidate.biocondaProbeUrl, timeoutMs)
        ])
        return { candidate, ms: Math.max(condaMs, biocondaMs) }
      } catch {
        return undefined
      }
    })
  )
  const reachable = timed.filter(
    (entry): entry is { candidate: MirrorCandidate; ms: number } => entry !== undefined
  )
  if (reachable.length === 0) return undefined
  reachable.sort((a, b) => a.ms - b.ms)
  return { ...reachable[0].candidate.mirror }
}

// Memoized once-per-process probe: the winning mirror is measured on first need and reused, so an
// install/provision never re-probes. Reset between tests via resetAutoMirrorCache.
let cached: Promise<PackageMirror | undefined> | undefined
export const resetAutoMirrorCache = (): void => {
  cached = undefined
}
const resolveAutoMirror = (deps?: ProbeDeps): Promise<PackageMirror | undefined> => {
  if (!cached) cached = pickFastestMirror(deps)
  return cached
}

// Effective mirror WITH the speed probe: a user-configured override always wins (no probe); otherwise
// use the fastest-probed mirror; if the probe finds nothing reachable, fall back to the sync locale
// default (effectiveMirror). Kept separate from the sync effectiveMirror so non-probing callers and
// existing tests are unaffected.
export const effectiveMirrorAsync = async (
  configured: PackageMirror | undefined,
  locale: string,
  deps?: ProbeDeps
): Promise<PackageMirror> => {
  const hasAny =
    configured && (configured.condaChannel || configured.pypiIndex || configured.cranMirror)
  // Configured channel override already carries any caBundle it was given.
  if (hasAny) return configured!
  // Otherwise use the probed/locale mirror, but always preserve a configured caBundle (e.g. a
  // caBundle-only config behind an enterprise TLS proxy still gets the fastest-probed channel).
  const probed = await resolveAutoMirror(deps)
  const base = probed ?? effectiveMirror(undefined, locale)
  return configured?.caBundle ? { ...base, caBundle: configured.caBundle } : base
}
