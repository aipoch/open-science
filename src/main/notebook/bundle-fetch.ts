import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { md5File } from './provisioner-runtime'
import type { EnvSpec, FetchedBundle, ProvisionProgress } from './provisioner'
import { pkgsCache } from './runtime-paths'

// Injected CDN access so the fetch orchestration unit-tests without real network. cdnBase comes from
// app config (OPEN_SCIENCE_ENV_CDN_BASE), never hardcoded here; download writes a URL to a dest path.
export type BundleFetchDeps = {
  cdnBase: string
  version: number
  download: (url: string, destPath: string) => Promise<void>
  // md5 hex of a file; injectable for tests, defaults to the streaming md5File.
  md5?: (path: string) => Promise<string>
}

// One package referenced by an @EXPLICIT lock line `<url>#<md5>`.
type LockEntry = { filename: string; md5: string }

// Parses lock text into package entries (URL lines only).
const parseLock = (lockText: string): LockEntry[] =>
  lockText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .map((line) => {
      const [url, md5] = line.split('#')
      return { filename: url.slice(url.lastIndexOf('/') + 1), md5: md5 ?? '' }
    })

// Fetches the bundle (normalized @EXPLICIT lock + referenced tarballs) for one env into the pkgs
// cache, verifying each tarball's md5 from the lock (spec §5). Returns the local lock path, or
// undefined when no lock is published for this (version, env) so the caller can fall back to an
// online create.
export const fetchBundle = async (
  root: string,
  spec: EnvSpec,
  deps: BundleFetchDeps,
  onProgress: (p: ProvisionProgress) => void
): Promise<FetchedBundle | undefined> => {
  const lockUrl = `${deps.cdnBase}/${deps.version}/${spec.name}.lock`
  const lockPath = join(root, `${spec.name}.lock`)
  try {
    await deps.download(lockUrl, lockPath)
  } catch {
    return undefined
  }

  const entries = parseLock(readFileSync(lockPath, 'utf8'))
  const cache = pkgsCache(root)
  mkdirSync(cache, { recursive: true })
  const md5Of = deps.md5 ?? md5File

  // A tarball download failure or checksum mismatch means the CDN bundle is incomplete/corrupt for
  // this env. Treat it as "bundle unavailable": drop the just-written lock (so no later run mistakes a
  // half-fetched bundle for a complete one) and return undefined, letting the chain fall through to the
  // next adapter and ultimately an online create. Already-cached tarballs are harmless — online create
  // re-fetches what it needs.
  try {
    let done = 0
    for (const entry of entries) {
      const dest = join(cache, entry.filename)
      await deps.download(`${deps.cdnBase}/${deps.version}/pkgs/${entry.filename}`, dest)
      if (entry.md5) {
        const actual = await md5Of(dest)
        if (actual !== entry.md5) {
          throw new Error(
            `checksum mismatch for ${entry.filename}: expected ${entry.md5}, got ${actual}`
          )
        }
      }
      done += 1
      onProgress({
        phase: `fetch-${spec.language}`,
        message: `Downloaded ${done}/${entries.length} packages`,
        progress: 0.1 + 0.3 * (done / Math.max(entries.length, 1))
      })
    }
  } catch (err) {
    console.warn(
      `[bundle-fetch] ${spec.name}: CDN bundle unavailable (${(err as Error).message}); ` +
        `falling back to online create`
    )
    rmSync(lockPath, { force: true })
    return undefined
  }
  return { lockPath }
}
