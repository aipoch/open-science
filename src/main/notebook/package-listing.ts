import { execFile } from 'node:child_process'
import { dirname, win32 } from 'node:path'
import { promisify } from 'node:util'

import type { DiscoveredInterpreter, EnvPackage } from '../../shared/notebook-runtime'
import { packageToolFor } from '../../shared/notebook-runtime'
import { rscriptFor, windowsCondaPrefixForR } from './environment-discovery'
import { listArgv, micromambaSpawnEnv, resolveMicromamba } from './micromamba'
import type { MicromambaRunner } from './windows-micromamba-runner'
import { condaActivatedPath } from './runtime-paths'

// Read-only package inventory for one DISCOVERED environment (Settings → Runtimes "Packages"
// dialog). Dispatch reuses the package-operation writer mapping (packageToolFor): app-owned conda
// envs (app-managed AND agent-created) are inventoried with the bundled micromamba, the user's own
// Python with its own pip, and the user's own R with its Rscript. Listing never mutates the env, so
// the install-authorization gate does not apply: an unauthorized user-own env is still listed
// read-only.

// Which tool inventories the env — packageToolFor keyed on ownership, with provenance standing in
// for the managed/external source: app-managed and agent-created envs both live under the app
// runtime root (app-owned); only the user's own interpreters are external.
export const packageListingVia = (
  env: Pick<DiscoveredInterpreter, 'language' | 'provenance'>
): 'micromamba' | 'pip' | 'r-library' => packageToolFor(env.language, env.provenance !== 'user-own')

// The conda env prefix containing an interpreter, derived from the interpreter's own path (the same
// layout runtime-paths' pythonBin/rBin generate): Unix <prefix>/bin/<python|R>, Windows python.exe at
// the prefix root and conda R under <prefix>\Lib\R\bin. Returns undefined when the path does not
// match the expected layout (the caller then cannot use micromamba against it).
export const condaPrefixFromInterpreter = (
  interpreterPath: string,
  language: DiscoveredInterpreter['language'],
  platform: NodeJS.Platform = process.platform
): string | undefined => {
  if (language === 'r' && platform === 'win32') {
    return windowsCondaPrefixForR(interpreterPath, platform)
  }
  // Path semantics follow the SIMULATED platform (tests exercise win32 on POSIX hosts).
  const dir = platform === 'win32' ? win32.dirname : dirname
  const binDir = dir(interpreterPath)
  if (platform === 'win32') return binDir
  // Unix interpreters live in <prefix>/bin — the prefix is two levels up.
  return dir(binDir)
}

// Parses `micromamba list --json`: an array of {name, version, build, channel} objects. Throws on
// invalid JSON or a non-array payload; entries without string name/version are skipped rather than
// failing the whole listing.
export const parseMicromambaListJson = (stdout: string): EnvPackage[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('micromamba list did not return valid JSON.')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('micromamba list returned an unexpected shape (expected a JSON array).')
  }
  const packages: EnvPackage[] = []
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (typeof entry?.name !== 'string' || typeof entry?.version !== 'string') continue
    packages.push({
      name: entry.name,
      version: entry.version,
      ...(typeof entry.build === 'string' ? { build: entry.build } : {}),
      ...(typeof entry.channel === 'string' ? { channel: entry.channel } : {})
    })
  }
  return packages
}

// Parses `<python> -m pip list --format=json`: an array of {name, version} objects.
export const parsePipListJson = (stdout: string): EnvPackage[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('pip list did not return valid JSON.')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('pip list returned an unexpected shape (expected a JSON array).')
  }
  const packages: EnvPackage[] = []
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (typeof entry?.name !== 'string' || typeof entry?.version !== 'string') continue
    packages.push({ name: entry.name, version: entry.version })
  }
  return packages
}

// Parses the tab-separated `Package\tVersion` lines emitted by rListPackagesArgs. installed.packages()
// reports one row per library path a package is visible in, so duplicates are collapsed keeping the
// first (the active library's) row.
export const parseRPackageList = (stdout: string): EnvPackage[] => {
  const seen = new Set<string>()
  const packages: EnvPackage[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tab = trimmed.indexOf('\t')
    if (tab <= 0) continue
    const name = trimmed.slice(0, tab)
    const version = trimmed.slice(tab + 1).trim()
    if (!name || !version || seen.has(name)) continue
    seen.add(name)
    packages.push({ name, version })
  }
  return packages
}

// One-liner emitting installed.packages() as tab-separated name/version lines. Tab-separated rather
// than JSON so the listing does not depend on jsonlite being installed in the target env.
export const rListPackagesArgs = (): string[] => [
  '-e',
  'ip <- installed.packages(); writeLines(paste(ip[, "Package"], ip[, "Version"], sep = "\t"))'
]

// Same shape as environment-discovery's DiscoveryExec: bounded timeout + windowsHide on every
// subprocess, execFile (no shell) so paths with spaces/metacharacters are safe.
export type ListPackagesExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>

export type ListEnvPackagesDeps = {
  // Injectable for tests; defaults to execFile.
  exec?: ListPackagesExec
  // Resolved micromamba binary (micromamba dispatch only); defaults to resolveMicromamba().
  micromamba?: string
  // Production injects the shared prepared runner; explicit strings stay authoritative for isolated
  // tests and callers.
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  // The app runtime root (<dataRoot>/runtime) — micromamba's --root-prefix and spawn env.
  runtimeRoot?: string
  platform?: NodeJS.Platform
  // Bounded subprocess timeout; 15s matches the R probe timeouts in r-command.ts.
  timeoutMs?: number
}

const execFileAsync = promisify(execFile)

const defaultExec: ListPackagesExec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], options)
  return { stdout: String(stdout), stderr: String(stderr) }
}

// A Windows conda R needs its env's Library\bin DLLs on PATH to start (see environment-discovery's
// probeOptions); POSIX needs nothing extra.
const condaRSpawnEnv = (
  interpreterPath: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv | undefined => {
  const prefix = windowsCondaPrefixForR(interpreterPath, platform)
  return prefix
    ? { ...process.env, PATH: condaActivatedPath(prefix, process.env.PATH, platform) }
    : undefined
}

const failureMessage = (tool: string, env: DiscoveredInterpreter, error: unknown): Error => {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Could not list packages in ${env.label} (${tool} failed: ${detail})`)
}

// Lists the installed packages of one discovered environment, dispatching on packageListingVia.
// Throws (never partial-lists) when the tool fails or its output can't be parsed.
export const listEnvPackages = async (
  env: DiscoveredInterpreter,
  deps: ListEnvPackagesDeps = {}
): Promise<EnvPackage[]> => {
  const exec = deps.exec ?? defaultExec
  const platform = deps.platform ?? process.platform
  const options = { timeout: deps.timeoutMs ?? 15_000, windowsHide: true }
  const via = packageListingVia(env)

  if (via === 'micromamba') {
    if (!deps.runtimeRoot) throw new Error('Could not list packages: no runtime root configured.')
    const prefix = condaPrefixFromInterpreter(env.interpreterPath, env.language, platform)
    if (!prefix) {
      throw new Error(`Could not derive the conda env prefix from ${env.interpreterPath}.`)
    }
    let stdout: string
    try {
      const mm =
        deps.micromamba !== undefined
          ? deps.micromamba
          : deps.micromambaRunner
            ? await deps.micromambaRunner.resolve()
            : resolveMicromamba()
      if (!mm) throw new Error('micromamba not found.')
      const argv = listArgv(mm, deps.runtimeRoot, prefix)
      ;({ stdout } = await exec(argv[0], argv.slice(1), {
        ...options,
        env: micromambaSpawnEnv(deps.runtimeRoot)
      }))
    } catch (error) {
      throw failureMessage('micromamba', env, error)
    }
    return parseMicromambaListJson(stdout)
  }

  if (via === 'pip') {
    let stdout: string
    try {
      ;({ stdout } = await exec(
        env.interpreterPath,
        ['-m', 'pip', 'list', '--format=json'],
        options
      ))
    } catch (error) {
      throw failureMessage('pip', env, error)
    }
    return parsePipListJson(stdout)
  }

  // r-library: the env's own Rscript (the R binary's sibling) so the listing reflects THAT env's
  // library, not whatever R happens to be on PATH.
  const rscript = rscriptFor(env.interpreterPath)
  let stdout: string
  try {
    ;({ stdout } = await exec(rscript, rListPackagesArgs(), {
      ...options,
      env: condaRSpawnEnv(rscript, platform)
    }))
  } catch (error) {
    throw failureMessage('Rscript', env, error)
  }
  return parseRPackageList(stdout)
}
