import {
  AUTOMATIC_PACKAGE_MIRROR_CANDIDATES,
  type AutomaticPackageMirrorCandidate,
  type PackageMirror
} from '../../shared/mirror'
import { netFetchStandard } from '../skills/net-fetch'

// A candidate mirror bundle + cheap URLs to measure both required conda channels. Public endpoints
// only (no secrets). The repodata URLs are HEAD-ed so no body is downloaded.
export type MirrorCandidate = AutomaticPackageMirrorCandidate
export const MIRROR_CANDIDATES = AUTOMATIC_PACKAGE_MIRROR_CANDIDATES

// Measures one URL's latency (ms), rejecting on error/timeout. Injectable so the selection logic is
// testable without network.
export type LatencyProbe = (
  url: string,
  timeoutMs: number,
  trustedDomains: readonly string[]
) => Promise<number>

const defaultProbe: LatencyProbe = async (url, timeoutMs, trustedDomains) => {
  const started = Date.now()
  const res = await netFetchStandard(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`probe failed ${res.status}`)
  const finalHostname = new URL(res.url || url).hostname.toLowerCase()
  if (!trustedDomains.some((domain) => domain.toLowerCase() === finalHostname)) {
    throw new Error(`probe redirected to untrusted host ${finalHostname}`)
  }
  return Date.now() - started
}

export type ProbeDeps = {
  probe?: LatencyProbe
  candidates?: MirrorCandidate[]
  timeoutMs?: number
}

// Probes every candidate's conda-forge and bioconda channels in parallel. A candidate is reachable only
// when both respond; its score is the slower response because both channels are required for installs.
// Returns undefined when no complete candidate responds (caller then uses the public indexes).
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
          probe(candidate.probeUrl, timeoutMs, candidate.trustedDomains),
          probe(candidate.biocondaProbeUrl, timeoutMs, candidate.trustedDomains)
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

// Memoize a successful once-per-process probe while still coalescing concurrent attempts. A failed
// attempt is not sticky: startup can race network readiness, so the next install must be able to
// probe again after connectivity recovers. Reset between tests via resetAutoMirrorCache.
let cached: Promise<PackageMirror | undefined> | undefined
export const resetAutoMirrorCache = (): void => {
  cached = undefined
}
const resolveAutoMirror = (deps?: ProbeDeps): Promise<PackageMirror | undefined> => {
  if (!cached) {
    const attempt = pickFastestMirror(deps)
    cached = attempt
    void attempt.then(
      (result) => {
        if (result === undefined && cached === attempt) cached = undefined
      },
      () => {
        if (cached === attempt) cached = undefined
      }
    )
  }
  return cached
}

// Effective mirror WITH the speed probe: a user-configured override always wins (no probe); otherwise
// use the fastest-probed mirror; if the probe finds nothing reachable, use the public indexes rather
// than reviving a locale mirror that the probe just rejected.
export const effectiveMirrorAsync = async (
  configured: PackageMirror | undefined,
  _locale: string,
  deps?: ProbeDeps
): Promise<PackageMirror> => {
  const hasAny =
    configured && (configured.condaChannel || configured.pypiIndex || configured.cranMirror)
  // Configured channel override already carries any caBundle it was given.
  if (hasAny) return configured!
  // Otherwise use the probed/public mirror, but always preserve a configured caBundle (e.g. a
  // caBundle-only config behind an enterprise TLS proxy still gets the fastest-probed channel).
  const probed = await resolveAutoMirror(deps)
  const base = probed ?? {}
  return configured?.caBundle ? { ...base, caBundle: configured.caBundle } : base
}
