import { execFile } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

import type { NotebookLanguage } from '../../shared/notebook'
import type { DiscoveredInterpreter, EnvProvenance } from '../../shared/notebook-runtime'
import { probeInterpreterVersion } from './python-command'
import { parseRVersion, rHasJsonlite } from './r-command'
import { condaActivatedPath, DEFAULT_PY_ENV, DEFAULT_R_ENV, pythonBin, rBin } from './runtime-paths'

export type { DiscoveredInterpreter, EnvProvenance }

const execFileAsync = promisify(execFile)

// Shared options for every discovery subprocess: a hard timeout so a wedged tool (a hung conda, a
// stuck interpreter, an unresponsive `which`) can NEVER hang environment discovery, and windowsHide so
// no console window flashes. NB: discovery never uses shell:true — execFile passes argv directly, so a
// path with spaces (C:\Program Files\…) or shell metacharacters is safe and cannot inject.
const PROBE_TIMEOUT_MS = 10_000
const PROBE_EXEC_OPTS = { timeout: PROBE_TIMEOUT_MS, windowsHide: true } as const
// Upper bound on concurrent interpreter probes so a machine with many envs doesn't spawn a burst of
// subprocesses / exhaust file descriptors; fast enough to keep discovery responsive.
const PROBE_CONCURRENCY = 8
const isWin = (): boolean => process.platform === 'win32'

// Injectable so discovery is unit-testable without a real machine. The real defaults enumerate PATH,
// common install dirs, pyenv, conda/mamba envs, and the app's own runtime/envs.
export type DiscoveryDeps = {
  // Absolute candidate interpreter paths for a language, across all sources (may contain dupes/misses;
  // the orchestrator realpath-dedupes and drops non-existent ones).
  candidatePaths: (language: NotebookLanguage) => Promise<string[]>
  // `<interp> --version` → version string (e.g. "3.12.4" / "4.4.1"), or undefined if it doesn't run.
  probeVersion: (interpreterPath: string, language: NotebookLanguage) => Promise<string | undefined>
  // Whether an R interpreter can actually back the kernel loop (jsonlite + protocol). Python
  // runnability is derived from a valid Python-3 version instead.
  rRunnable: (interpreterPath: string) => Promise<boolean>
  // Resolve a path to its canonical form for identity/dedup; tolerate a missing path (return as-is).
  realpath: (p: string) => string
  // App runtime root (<storageRoot>/runtime); used to classify provenance of an interpreter by whether
  // it lives under runtime/envs and whether it is a default (app-managed) vs a named (agent-created) env.
  runtimeRoot: string
}

const safeRealpath = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Interpreter basenames per language and platform.
const interpreterNames = (language: NotebookLanguage): string[] => {
  if (language === 'python') return isWin() ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  return isWin() ? ['R.exe', 'Rscript.exe'] : ['R', 'Rscript']
}

// `which -a <name>` (POSIX) / `where <name>` (Windows) → existing absolute paths, best-effort.
const whichAll = async (name: string): Promise<string[]> => {
  try {
    const { stdout } = isWin()
      ? await execFileAsync('where', [name], PROBE_EXEC_OPTS)
      : await execFileAsync('which', ['-a', name], PROBE_EXEC_OPTS)
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line))
  } catch {
    return []
  }
}

// conda/mamba env prefixes, best-effort: `conda env list --json`, else scan common install roots.
const listCondaPrefixes = async (): Promise<string[]> => {
  const prefixes = new Set<string>()
  for (const bin of ['conda', 'mamba', 'micromamba']) {
    try {
      const { stdout } = await execFileAsync(bin, ['env', 'list', '--json'], PROBE_EXEC_OPTS)
      const parsed = JSON.parse(stdout) as { envs?: unknown }
      if (Array.isArray(parsed.envs)) {
        for (const env of parsed.envs) if (typeof env === 'string') prefixes.add(env)
      }
      break
    } catch {
      // try the next tool
    }
  }
  // Scan known conda/mamba/micromamba install ROOTS directly — essential in a packaged GUI app where
  // conda itself isn't on PATH (so `env list` above found nothing). Each root's base prefix + every
  // dir under its envs/ is a candidate; a non-existent root is simply skipped.
  const home = homedir()
  // Home-based roots exist on every platform (installers default to the user profile).
  const homeRoots = ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', 'micromamba'].map((d) =>
    join(home, d)
  )
  // Plus per-platform SYSTEM install locations.
  const systemRoots = isWin()
    ? [
        'C:\\ProgramData\\miniconda3',
        'C:\\ProgramData\\anaconda3',
        'C:\\ProgramData\\miniforge3',
        'C:\\miniconda3',
        'C:\\anaconda3',
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'miniconda3'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'anaconda3')
      ]
    : process.platform === 'darwin'
      ? [
          '/opt/miniconda3',
          '/opt/anaconda3',
          '/opt/homebrew/anaconda3',
          '/opt/homebrew/Caskroom/miniconda/base',
          '/opt/homebrew/Caskroom/miniforge/base'
        ]
      : [
          '/opt/conda', // common in Linux/Docker images
          '/opt/miniconda3',
          '/opt/anaconda3',
          '/usr/local/miniconda3',
          '/usr/local/anaconda3'
        ]
  const roots = [...homeRoots, ...systemRoots]
  for (const root of roots) {
    if (existsSync(root)) prefixes.add(root)
    const envsDir = join(root, 'envs')
    try {
      for (const name of readdirSync(envsDir)) prefixes.add(join(envsDir, name))
    } catch {
      // no envs dir
    }
  }
  return [...prefixes]
}

// Windows `py -0p`: the launcher lists installed pythons; each line ends with the interpreter path.
// Best-effort (parsing is loose; on-device verification pending).
const pyLauncherPaths = async (): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync('py', ['-0p'], PROBE_EXEC_OPTS)
    return stdout
      .split('\n')
      .map((line) => {
        const match = line.match(/([A-Za-z]:\\[^\s*]+python\.exe)\s*$/i)
        return match ? match[1] : undefined
      })
      .filter((p): p is string => p !== undefined && existsSync(p))
  } catch {
    return []
  }
}

// The interpreter path for a language inside a conda-style env prefix.
const prefixInterpreter = (prefix: string, language: NotebookLanguage): string =>
  language === 'python'
    ? isWin()
      ? join(prefix, 'python.exe')
      : join(prefix, 'bin', 'python')
    : rBin(prefix)

// A conda-forge Windows R interpreter lives at <prefix>\Lib\R\bin\R[script].exe and depends on
// DLLs in <prefix>\Library\bin. Return only that interpreter's own prefix: external CRAN R paths do
// not match this layout, and an external conda R must never receive the app-managed prefix.
export const windowsCondaPrefixForR = (
  interpreterPath: string,
  platform: NodeJS.Platform = process.platform
): string | undefined => {
  if (platform !== 'win32') return undefined
  const normalized = win32.normalize(interpreterPath)
  const match = normalized.match(/^(.*)\\Lib\\R\\bin\\R(?:script)?\.exe$/i)
  return match?.[1]
}

// Default real enumeration: PATH + common dirs + pyenv + conda envs + the app's own runtime/envs, plus
// any manually-added interpreter paths from the Settings catalog (so a picked interpreter that is not
// on PATH / in a conda root still surfaces as a card). `manualPaths` is a sync getter over a settings
// snapshot; a missing/failed lookup contributes nothing.
export const defaultCandidatePaths =
  (runtimeRoot: string, manualPaths?: (language: NotebookLanguage) => string[]) =>
  async (language: NotebookLanguage): Promise<string[]> => {
    const names = interpreterNames(language)
    const found = new Set<string>()

    // Targeted probes of KNOWN interpreter locations — never a recursive filesystem walk. A packaged
    // GUI app inherits a minimal PATH (not the user's shell), so `which` alone finds almost nothing;
    // we must also check the well-known install dirs, framework versions, and conda roots directly, or
    // a user's real R / Python / conda envs go undetected. Each is an existsSync of a specific path.

    // Manually-added interpreters from the Settings catalog.
    for (const p of manualPaths?.(language) ?? []) found.add(p)

    // On PATH (`which -a` / `where`) — the happy path when launched from a shell.
    for (const name of names) for (const p of await whichAll(name)) found.add(p)

    // Well-known install bin dirs (Homebrew, /usr/local, /usr/bin) — reached even without a shell PATH.
    const commonBinDirs = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
    for (const dir of commonBinDirs)
      for (const name of names) {
        const p = join(dir, name)
        if (existsSync(p)) found.add(p)
      }

    // macOS framework installs (python.org Python, CRAN R): one interpreter per versioned Resources dir.
    const frameworkGlobs =
      language === 'python'
        ? '/Library/Frameworks/Python.framework/Versions'
        : '/Library/Frameworks/R.framework/Versions'
    try {
      for (const ver of readdirSync(frameworkGlobs)) {
        const p = prefixInterpreter(
          join(frameworkGlobs, ver, language === 'r' ? 'Resources' : ''),
          language
        )
        if (existsSync(p)) found.add(p)
      }
    } catch {
      // no framework dir
    }

    // pyenv versions (python only): pyenv shims are rarely on a GUI app's PATH.
    if (language === 'python') {
      const versionsDir = join(homedir(), '.pyenv', 'versions')
      try {
        for (const ver of readdirSync(versionsDir)) {
          const p = join(versionsDir, ver, 'bin', 'python')
          if (existsSync(p)) found.add(p)
        }
      } catch {
        // no pyenv
      }
    }

    // conda / mamba / micromamba envs: `env list --json` when a tool is reachable, else the conda-root
    // scan inside listCondaPrefixes (so envs are found even when conda itself is off the GUI PATH).
    for (const prefix of await listCondaPrefixes()) {
      const p = prefixInterpreter(prefix, language)
      if (existsSync(p)) found.add(p)
    }

    // Windows Python launcher: `py -0p` lists installed interpreters' paths.
    if (language === 'python' && isWin()) for (const p of await pyLauncherPaths()) found.add(p)

    // Windows CRAN R standard installations: check Program Files and user-local directories for versioned
    // R installs (R-x.y.z). CRAN R doesn't register with a launcher like Python's `py`, so we enumerate
    // the standard install roots directly. Each version may have 64-bit (bin/x64/R.exe, most common) or
    // fallback (bin/R.exe) layouts.
    if (language === 'r' && isWin()) {
      const home = homedir()
      const programFiles = [
        process.env.ProgramFiles ?? 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs')
      ]
      for (const installRoot of programFiles) {
        const rRoot = join(installRoot, 'R')
        let entries: string[]
        try {
          entries = await readdir(rRoot)
        } catch (err: unknown) {
          // Discovery is best-effort: absorb all errors and continue. ENOENT/EACCES/EPERM are expected
          // on locked-down corporate machines, but unexpected errors (EIO, ENOTDIR, EMFILE) can also
          // occur (e.g., network-mapped Program Files with dropped shares). Log unexpected codes for
          // observability but do not reject the entire Promise.all that would block Python discovery too.
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
            console.warn('[cran-r] unexpected error scanning', rRoot, code)
          }
          continue
        }
        for (const ver of entries) {
          // Match R-x.y.z or R-x.y.z-suffix (e.g., R-4.2.0-ucrt for CRAN's UCRT builds)
          if (!/^R-\d+\.\d+\.\d+(-\w+)?$/.test(ver)) continue
          // Try 64-bit first (standard since R 4.2), then fallback to bin/R.exe.
          const candidates = [
            join(rRoot, ver, 'bin', 'x64', 'R.exe'),
            join(rRoot, ver, 'bin', 'R.exe')
          ]
          for (const p of candidates) {
            try {
              await access(p)
              found.add(p)
              break
            } catch {
              // Candidate doesn't exist, try next
            }
          }
        }
      }
    }

    // The app's own envs under runtime/envs: the default(s) AND any agent-created named env, so a conda
    // env the agent made with manage_environments is discovered and therefore bindable. Scan every
    // subdir for THIS language's interpreter; classify() labels default -> app-managed, named ->
    // agent-created.
    const appEnvsDir = join(runtimeRoot, 'envs')
    try {
      for (const name of readdirSync(appEnvsDir)) {
        const prefix = join(appEnvsDir, name)
        const p = language === 'python' ? pythonBin(prefix) : rBin(prefix)
        if (existsSync(p)) found.add(p)
      }
    } catch {
      // No runtime/envs dir yet (first run) — nothing app-owned to add.
    }

    // R and Rscript are two binaries of ONE R install; collapse to a single card (the R binary). The
    // launcher/probe derives the sibling Rscript when needed (see rscriptFor), so nothing is lost.
    return collapseRscript([...found])
  }

// Drops a `Rscript` candidate when its sibling `R` (same dir) is also a candidate, so a detected R
// installation surfaces as one environment, not a duplicate R + Rscript pair. A lone Rscript with no
// sibling R is kept (still a usable R runtime). Exported for unit tests.
export const collapseRscript = (paths: string[]): string[] => {
  const set = new Set(paths)
  return paths.filter((p) => {
    const base = p.split(/[/\\]/).pop() ?? ''
    if (!/^Rscript(\.exe)?$/i.test(base)) return true
    const siblingR = p.replace(
      /Rscript(\.exe)?$/i,
      (_m, ext: string | undefined) => `R${ext ?? ''}`
    )
    return !set.has(siblingR)
  })
}

// Classifies an interpreter by whether it lives under runtime/envs (app-owned) and, if so, whether it
// is a default (app-managed) or a named env (agent-created); anything else is the user's own.
const classify = (interpreterPath: string, runtimeRoot: string): EnvProvenance => {
  const envsRoot = safeRealpath(join(runtimeRoot, 'envs'))
  const real = safeRealpath(interpreterPath)
  if (!real.startsWith(envsRoot + '/') && !real.startsWith(envsRoot + '\\')) return 'user-own'
  const rest = real.slice(envsRoot.length + 1)
  const envName = rest.split(/[/\\]/)[0]
  return envName === DEFAULT_PY_ENV ||
    envName === DEFAULT_R_ENV ||
    envName.startsWith(`${DEFAULT_PY_ENV}-`) ||
    envName.startsWith(`${DEFAULT_R_ENV}-`)
    ? 'app-managed'
    : 'agent-created'
}

const condaEnvName = (interpreterPath: string): string | undefined => {
  const parts = safeRealpath(interpreterPath).split(/[/\\]/)
  const idx = parts.lastIndexOf('envs')
  return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : undefined
}

// Discovers every interpreter for a language, deduped by real path, each probed for version +
// runnability and classified by provenance. The orchestration is pure over the injected deps.
export const discoverInterpreters = async (
  language: NotebookLanguage,
  deps: DiscoveryDeps
): Promise<DiscoveredInterpreter[]> => {
  // Dedup by real path FIRST, then probe unique candidates with BOUNDED concurrency. Each probe spawns
  // subprocesses (a `--version` probe, plus a jsonlite probe for R); serial made discovery scale with
  // the number of interpreters (slow with many conda envs), but an unbounded Promise.all over dozens of
  // candidates would fan out too many processes/file descriptors at once. A small worker pool keeps it
  // fast without a spawn storm. Order is preserved (results written back at each candidate's index).
  const seen = new Set<string>()
  const unique: { path: string; envId: string }[] = []
  for (const path of await deps.candidatePaths(language)) {
    const envId = deps.realpath(path)
    if (seen.has(envId)) continue
    seen.add(envId)
    unique.push({ path, envId })
  }

  const probe = async ({
    path,
    envId
  }: {
    path: string
    envId: string
  }): Promise<DiscoveredInterpreter> => {
    const version = await deps.probeVersion(path, language)
    const provenance = classify(path, deps.runtimeRoot)
    const conda = condaEnvName(path)
    let runnable: boolean
    let detail: string | undefined
    if (language === 'python') {
      runnable = version !== undefined
      if (!runnable) detail = 'Not a runnable Python 3'
    } else {
      const versioned = version !== undefined
      runnable = versioned && (await deps.rRunnable(path))
      if (!versioned) detail = 'R did not run'
      else if (!runnable) detail = 'Needs jsonlite'
    }
    return {
      language,
      provenance,
      envId,
      interpreterPath: path,
      label: conda ? `conda: ${conda}` : path,
      version,
      runnable,
      condaEnv: conda,
      detail
    }
  }

  const results = new Array<DiscoveredInterpreter>(unique.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < unique.length; i = next++) {
      results[i] = await probe(unique[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, unique.length) }, () => worker())
  )
  return results
}

// The env's Rscript sits beside its R (…/bin/R → …/bin/Rscript); used to probe jsonlite in THAT env,
// and (exported) to launch an EXTERNAL R binding's kernel loop, which needs Rscript, not the R binary.
export const rscriptFor = (rInterpreterPath: string): string =>
  rInterpreterPath.replace(/R(\.exe)?$/, (_m, ext: string | undefined) => `Rscript${ext ?? ''}`)

// Real dependencies for a live machine: python version via the (python-3-validating) probe, R version
// via parseRVersion, R runnability via jsonlite probed through the env's OWN Rscript, and the standard
// enumerators. Enumeration is standard-location-only (see defaultCandidatePaths) — never a disk walk.
type DiscoveryExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>

type DefaultDiscoveryRuntimeDeps = {
  platform?: NodeJS.Platform
  exec?: DiscoveryExec
}

export const defaultDiscoveryDeps = (
  runtimeRoot: string,
  manualPaths?: (language: NotebookLanguage) => string[],
  runtimeDeps: DefaultDiscoveryRuntimeDeps = {}
): DiscoveryDeps => {
  const platform = runtimeDeps.platform ?? process.platform
  const exec: DiscoveryExec =
    runtimeDeps.exec ??
    (async (file, args, options) => {
      const { stdout, stderr } = await execFileAsync(file, [...args], options)
      return { stdout: String(stdout), stderr: String(stderr) }
    })
  const probeOptions = (
    interpreterPath: string,
    timeout = PROBE_TIMEOUT_MS
  ): { timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv } => {
    const prefix = windowsCondaPrefixForR(interpreterPath, platform)
    return prefix
      ? {
          timeout,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: condaActivatedPath(prefix, process.env.PATH, platform)
          }
        }
      : { timeout, windowsHide: true }
  }
  return {
    candidatePaths: defaultCandidatePaths(runtimeRoot, manualPaths),
    probeVersion: async (interpreterPath, language) => {
      if (language === 'python') return probeInterpreterVersion(interpreterPath)
      try {
        // No shell: execFile runs the interpreter directly, so a path with spaces/metacharacters is
        // handled safely (shell:true would break "C:\Program Files\…" and allow injection).
        const { stdout, stderr } = await exec(
          interpreterPath,
          ['--version'],
          probeOptions(interpreterPath)
        )
        return parseRVersion(`${stdout}\n${stderr}`)
      } catch {
        return undefined
      }
    },
    rRunnable: (rInterpreterPath) =>
      rHasJsonlite({
        exec: async (args) => {
          // No shell (see probeVersion): Rscript is run directly with a static arg vector.
          const rscript = rscriptFor(rInterpreterPath)
          return exec(rscript, args, probeOptions(rscript, 15_000))
        }
      }),
    realpath: safeRealpath,
    runtimeRoot
  }
}
