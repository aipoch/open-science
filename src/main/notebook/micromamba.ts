import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/repository'

// Injected environment so resolution is unit-testable without touching the real process layout. All
// fields optional; omitted ones fall back to process defaults.
export type MicromambaDeps = {
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
  home?: string
}

// The micromamba executable file name for the current platform.
const micromambaName = (): string =>
  process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Resolves the micromamba binary (contract §3). Order: OPEN_SCIENCE_MICROMAMBA_BIN override →
// packaged resource (process.resourcesPath) → <storageRoot>/runtime/micromamba/bin → PATH. Returns
// undefined when none resolve. The storage-root fallback reuses the production session dir name
// (PROD_SESSION_DIR_NAME, i.e. ~/.open-science) since this module stays electron-free and cannot
// see the dev/prod choice made by resolveStorageRoot; dev builds rely on the env override or PATH.
export const resolveMicromamba = (deps: MicromambaDeps = {}): string | undefined => {
  const env = deps.env ?? process.env
  const name = micromambaName()

  const override = env.OPEN_SCIENCE_MICROMAMBA_BIN
  if (override && isFile(override)) return override

  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  if (resourcesPath) {
    const bundled = join(resourcesPath, name)
    if (isFile(bundled)) return bundled
  }

  const home = deps.home ?? env.HOME ?? env.USERPROFILE
  if (home) {
    const runtimeBin = join(home, PROD_SESSION_DIR_NAME, 'runtime', 'micromamba', 'bin', name)
    if (isFile(runtimeBin)) return runtimeBin
  }

  const pathVar = env.PATH ?? env.Path
  if (pathVar) {
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue
      if (isFile(join(dir, name))) return join(dir, name)
    }
  }

  return undefined
}

// micromamba create -p <prefix> --file <lock> --offline -y --root-prefix <root>
// Offline clone from a bundled/CDN @EXPLICIT lock; hard-links tarballs from the pkgs cache, no network.
export const createFromLockArgv = (
  mm: string,
  root: string,
  prefix: string,
  lock: string
): string[] => [
  mm,
  'create',
  '-p',
  prefix,
  '--file',
  lock,
  '--offline',
  '-y',
  '--root-prefix',
  root
]

// Expands a channel list into repeated `-c <channel>` flags, in order. micromamba/mamba use strict
// channel priority left-to-right, so the caller lists the highest-priority channel first (e.g.
// conda-forge before bioconda).
const channelArgs = (channels: string[]): string[] => channels.flatMap((c) => ['-c', c])

// Env vars that make the package-download tools trust a custom CA bundle (an enterprise TLS-inspecting
// proxy re-signs HTTPS with a private CA). One PEM path fans out to every tool's own variable —
// micromamba/conda (CONDA_SSL_VERIFY, SSL_CERT_FILE), pip (PIP_CERT), the requests/urllib stack
// (REQUESTS_CA_BUNDLE), and R's libcurl (CURL_CA_BUNDLE). Empty when no bundle is configured, so the
// caller can spread it into a spawn env unconditionally.
export const caBundleEnv = (caBundle?: string): NodeJS.ProcessEnv =>
  caBundle
    ? {
        CONDA_SSL_VERIFY: caBundle,
        SSL_CERT_FILE: caBundle,
        REQUESTS_CA_BUNDLE: caBundle,
        PIP_CERT: caBundle,
        CURL_CA_BUNDLE: caBundle
      }
    : {}

// micromamba create --root-prefix <root> --prefix <prefix> -y -c <ch...> <pkgs...>
// Online fallback (dev / no bundle): solves against the channels and downloads packages.
export const createFromPackagesArgv = (
  mm: string,
  root: string,
  prefix: string,
  channels: string[],
  pkgs: string[]
): string[] => [
  mm,
  'create',
  '--root-prefix',
  root,
  '--prefix',
  prefix,
  '-y',
  ...channelArgs(channels),
  ...pkgs
]

// micromamba install --root-prefix <root> --prefix <prefix> -y -c <ch...> <pkgs...>
// Additive install into an existing env — the upgrade path preserves user packages (spec §6.3).
export const installArgv = (
  mm: string,
  root: string,
  prefix: string,
  channels: string[],
  pkgs: string[]
): string[] => [
  mm,
  'install',
  '--root-prefix',
  root,
  '--prefix',
  prefix,
  '-y',
  ...channelArgs(channels),
  ...pkgs
]

// Normalizes raw `micromamba list --explicit --md5` output into a valid @EXPLICIT lock. The raw
// output lacks the @EXPLICIT header and includes comment/title lines; feeding it to
// `create --file --offline` as-is silently degrades to an online solve and errors (spec §2.5). We
// emit the @EXPLICIT marker followed by only the package URL lines (`<url>#<md5>`).
export const normalizeExplicitLock = (rawListExplicit: string): string => {
  const urlLines = rawListExplicit
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
  return [`@EXPLICIT`, ...urlLines].join('\n') + '\n'
}
