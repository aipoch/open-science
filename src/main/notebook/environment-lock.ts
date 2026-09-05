import { join } from 'node:path'

import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import { isSafePackageBasename } from './pack-content'
import { explicitLockArgv, normalizeExplicitLock } from './micromamba'
import { envPrefix, runtimeSubdir } from './runtime-paths'

// One app-managed conda environment the main process resolved from its own trusted state
// (discovery or relocation). `prefix` is always derived from the runtime root — never accepted
// from the renderer.
export type ManagedEnvironment = {
  name: string
  prefix: string
}

// Resolves a discovered interpreter to the managed env it lives in, or undefined when the user
// owns it or its conda env name is missing — never guess a default env for an interpreter we
// cannot place. 'app-managed' and 'agent-created' envs both sit under the app runtime root and
// are exported through the bundled micromamba; user-own interpreters (including a foreign conda
// install) stay out of scope — their packages are managed manually.
export const managedEnvironmentRef = (
  interpreter: DiscoveredInterpreter,
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform
): ManagedEnvironment | undefined => {
  if (interpreter.provenance === 'user-own' || !interpreter.condaEnv) return undefined
  const name = interpreter.condaEnv
  return { name, prefix: envPrefix(runtimeRoot, name, platform) }
}

export type ExportEnvironmentLockDeps = {
  // Resolved micromamba binary.
  mm: string
  // Runs a micromamba argv and returns stdout (for `list --explicit --md5`).
  capture: (argv: string[]) => Promise<string>
}

// Exports one managed environment prefix as a validated @EXPLICIT lock: capture, normalize,
// then require at least one package URL to survive — an empty lock is a failure, never a
// success. The @EXPLICIT marker itself is normalizeExplicitLock's contract, not re-checked here.
export const exportEnvironmentLock = async (
  env: ManagedEnvironment,
  deps: ExportEnvironmentLockDeps
): Promise<string> => {
  const raw = await deps.capture(explicitLockArgv(deps.mm, env.prefix))
  const lock = normalizeExplicitLock(raw)
  if (!/^https?:\/\//m.test(lock)) {
    throw new Error(`Could not export ${env.name}: the exported lock contains no package URLs.`)
  }
  return lock
}

// One pinned package of an @EXPLICIT lock: the URL, its cache basename, and its md5 digest.
export type ExplicitLockEntry = {
  url: string
  file: string
  md5: string
}

export type ParseExplicitLockOpts = {
  platform?: NodeJS.Platform
  arch?: string
}

// Parses + validates an @EXPLICIT lock BEFORE any restore mutation. Unlike the export direction,
// this is EXTERNAL input: every rule rejects rather than silently dropping — a dropped package
// line would silently restore a different env. Mirrors lockPackages' file/md5 rules so the seed
// layer (validateAndSeedPackIntoCache) and micromamba see exactly the entries validated here.
// ponytail: md5-only — a sha256-digest lock rejects with a clear error; supporting it needs the
// seed layer's md5File gate widened too. Upgrade there if sha256 locks ever matter.
export const parseExplicitLock = (
  lock: string,
  opts: ParseExplicitLockOpts = {}
): ExplicitLockEntry[] => {
  const lines = lock.split('\n').map((line) => line.trim())
  const first = lines.find((line) => line !== '')
  if (first !== '@EXPLICIT') {
    throw new Error('The lock is not a valid @EXPLICIT environment lock.')
  }
  const subdir = runtimeSubdir(opts.platform ?? process.platform, opts.arch ?? process.arch)
  const entries: ExplicitLockEntry[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (line === '' || line === '@EXPLICIT' || line.startsWith('#')) continue
    if (!/^https?:\/\//.test(line)) {
      throw new Error(`The lock contains an unsupported line: ${line.slice(0, 120)}`)
    }
    const hashIndex = line.indexOf('#')
    const url = hashIndex >= 0 ? line.slice(0, hashIndex) : ''
    const md5 = hashIndex >= 0 ? line.slice(hashIndex + 1) : ''
    if (/^[0-9a-f]{64}$/i.test(md5)) {
      throw new Error(
        'The lock pins sha256 digests, which restore does not support yet. ' +
          'Export the environment with micromamba md5 locks instead.'
      )
    }
    const segments = url.split('/').filter(Boolean)
    // A valid package URL is scheme/host/path/basename at minimum, and the basename must be a
    // plain conda archive (isSafePackageBasename): it becomes the download destination under the
    // staging dir, so a `\` or dot-segment must reject here — not travel through join() on Windows.
    const file = segments.at(-1) ?? ''
    if (segments.length < 3 || !isSafePackageBasename(file) || !/^[0-9a-f]{32}$/i.test(md5)) {
      throw new Error(`The lock contains a malformed package entry: ${line.slice(0, 120)}`)
    }
    // The conda URL segment before the basename is the platform subdir; anything but noarch or
    // this host's subdir means the lock was exported for another platform — reject it up front
    // instead of letting the offline create extract foreign binaries (or fail halfway).
    const packageSubdir = segments.at(-2) ?? ''
    if (packageSubdir !== 'noarch' && packageSubdir !== subdir) {
      throw new Error(
        `The lock was exported for platform "${packageSubdir}" and cannot be restored on "${subdir}".`
      )
    }
    if (seen.has(file)) {
      throw new Error(`The lock contains duplicate entries for ${file}.`)
    }
    seen.add(file)
    entries.push({ url, file, md5 })
  }
  if (entries.length === 0) {
    throw new Error('The lock contains no package URLs.')
  }
  return entries
}

export type DownloadExplicitLockDeps = {
  // Downloads one package URL to a local path. Production wires the shared resilient downloader;
  // tests inject a fake.
  download: (url: string, dest: string, signal?: AbortSignal) => Promise<void>
  md5: (path: string) => Promise<string>
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

// Downloads every lock entry into `dir` and verifies each md5. The md5 gate is what makes a
// restored env byte-identical to the exported one — a mismatched download rejects the whole
// restore before anything is seeded into the shared cache or any prefix is touched.
export const downloadExplicitLockPackages = async (
  entries: readonly ExplicitLockEntry[],
  dir: string,
  deps: DownloadExplicitLockDeps
): Promise<void> => {
  for (const [index, entry] of entries.entries()) {
    const dest = join(dir, entry.file)
    await deps.download(entry.url, dest, deps.signal)
    if ((await deps.md5(dest)).toLowerCase() !== entry.md5.toLowerCase()) {
      throw new Error(`Downloaded package failed md5 verification: ${entry.file}`)
    }
    deps.onProgress?.(index + 1, entries.length)
  }
}
