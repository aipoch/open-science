import { existsSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/repository'
import type { NotebookLanguage } from '../../shared/notebook'
import { caBundleEnv, installArgv, resolveMicromamba } from './micromamba'
import { withSharedCacheLock } from './pkgs-cache-lock'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pipBin,
  pythonBin,
  rBin,
  rLibraryDir,
  rScriptBin,
  resolveEnvName,
  runtimeRoot
} from './runtime-paths'

export type InstallRequest = {
  language: NotebookLanguage
  packages: string[]
  usePip?: boolean
  channels?: string[]
  environment?: string
  // Which action to run against the env; defaults to 'install' (fully backward compatible).
  operation?: 'install' | 'uninstall'
  // Injected by the MCP bridge from the connection context (mcp-server injects sessionId into every
  // notebook tool call). Lets managePackages consult THIS session's runtime binding so an install into
  // a bound external env is gated on that env's per-env install authorization. Absent -> managed path.
  sessionId?: string
  // workspaceCwd/projectName travel on every notebook RPC call too (the local RPC requires
  // workspaceCwd; mcp-server injects both). managePackages uses them to ensureSession() — loading and
  // rehydrating persisted runtime bindings — BEFORE resolving the binding, so the FIRST install after
  // an app restart (session not yet in memory) still sees the persisted binding instead of silently
  // targeting the default env.
  workspaceCwd?: string
  projectName?: string
}
// method records which installer actually ran: conda (micromamba), pip, or cran (R install.packages
// fallback) — useful to verify the path taken, especially when conda falls back.
export type InstallResult = {
  ok: boolean
  needsRestart: boolean
  log: string
  method?: 'conda' | 'pip' | 'cran'
  // Absolute env prefix the packages were installed into (<dataRoot>/runtime/envs/<env>), so the
  // UI/agent can see the concrete, env-scoped install location. Set on every real install outcome.
  prefix?: string
  error?: string
}

// One spawned install command's outcome; injected so tests never launch micromamba/pip/R.
export type SpawnResult = { code: number; stdout: string; stderr: string }
export type InstallSpawn = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  // Invoked with the spawned installer's PID so the caller can journal it for crash-recovery
  // supervision (a killed installer survivor is reaped before reconciling). Test spawns ignore it.
  onChild?: (pid: number) => void
) => Promise<SpawnResult>

// condaChannel/pypiIndex/cranMirror are resolved PackageMirror values (see shared/mirror.ts);
// integration passes the effectiveMirror() output, this module stays mirror-shape agnostic.
export type InstallDeps = {
  spawn: InstallSpawn
  micromamba?: string
  storageRoot?: string
  condaChannel?: string
  pypiIndex?: string
  cranMirror?: string
  // PEM CA bundle path (enterprise TLS proxy); exported into every install subprocess's env so
  // conda/pip/R HTTPS verification trusts it.
  caBundle?: string
  // Injected for tests to check a named env's interpreter without touching real disk.
  pathExists?: (path: string) => boolean
  // Set for an EXTERNAL (BYO) runtime: install with THIS interpreter's own pip (`<command> [args] -m
  // pip install …`) instead of the app-managed prefix. The bundled micromamba never touches a foreign
  // environment. Absent -> managed install into the app prefix (today's behavior).
  interpreter?: { command: string; args?: string[] }
  // Invoked with each spawned installer's PID so the caller (managePackages) can journal it for
  // crash-recovery supervision of a surviving installer after a hard quit.
  onChild?: (pid: number) => void
}

const DEFAULT_CONDA_CHANNEL = 'conda-forge'
// bioconda carries bioinformatics tools + the bioconductor-* R packages; it's designed to sit BELOW
// conda-forge in strict priority, so we always append it after the primary channel for installs.
const BIOCONDA_CHANNEL = 'bioconda'
const DEFAULT_CRAN_MIRROR = 'https://cloud.r-project.org'

// The bioconda channel matching the primary: if the primary is a conda-forge mirror URL, point
// bioconda at the SAME mirror host (…/conda-forge/ → …/bioconda/) so a firewalled user isn't pushed
// back onto public bioconda; otherwise use the plain "bioconda" channel name.
const biocondaChannelFor = (primary: string): string =>
  /^https?:\/\//.test(primary) && primary.includes('conda-forge')
    ? primary.replace(/conda-forge/g, 'bioconda')
    : BIOCONDA_CHANNEL

// Conda install channels: the agent's explicit list wins; otherwise the primary channel (mirror
// override or conda-forge) followed by its matching bioconda, deduped, so bioconductor-*/bio tools
// resolve from the same host.
const condaInstallChannels = (primary: string, requested: string[] | undefined): string[] =>
  requested && requested.length > 0
    ? requested
    : [...new Set([primary, biocondaChannelFor(primary)])]

// The env's OWN R package library. R install/remove pin lib= here so a conda R env's fronted user
// library (e.g. ~/Library/R/x.y/library, which .libPaths() may front) can never receive or lose
// packages: the op is provably confined to the env. Platform-aware via rLibraryDir (Unix lib/ vs Win Lib\).
const envRLibrary = (prefix: string): string => rLibraryDir(prefix)

// R conda naming, shared by R install and R uninstall so both target the exact same conda names.
// conda-forge uses r-<pkg>; Bioconductor packages live on bioconda as bioconductor-<pkg>. Leave an
// already-namespaced name (r-*/bioconductor-*) untouched so a Bioconductor package can be targeted
// directly; otherwise assume a CRAN package and add the r- prefix.
const rCondaNames = (packages: string[]): string[] =>
  packages.map((pkg) =>
    pkg.startsWith('r-') || pkg.startsWith('bioconductor-') ? pkg : `r-${pkg}`
  )

// micromamba reports missing packages ("packages to remove not found in the environment", or a
// per-package "is not installed") on a remove of something it doesn't manage. That's the signal that
// the package was installed via CRAN install.packages(), so R uninstall falls back to remove.packages().
const condaReportsNotManaged = (log: string): boolean => /not (found|installed)/i.test(log)

// Real spawn wrapper collecting stdout/stderr and the exit code; replaced by an injected spawn in tests.
const defaultSpawn: InstallSpawn = (command, args, env, onChild) =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    if (child.pid !== undefined) onChild?.(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${String(error)}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

// Flattens one command's output into a single log string for the agent to read as install facts.
const mergeLog = (result: SpawnResult): string =>
  [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n')

// The default (managed) envs are ADDITIVE-ONLY (foundation "default-environment restrictions"): a spec may be a bare
// package name or a bare name pinned to an exact `==version`, and nothing else. This regex rejects
// version RANGES (>=, <, ~=, !=, commas), git/VCS/URL/local specs (contain +, :, /, @), EXTRAS
// (`pkg[extra]`), wildcards, whitespace, and anything that begins with `-` (so unsafe pip flags such as
// `--force-reinstall` are refused too, since they arrive as package tokens).
const DEFAULT_ADDITIVE_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(==[A-Za-z0-9][A-Za-z0-9.+!_-]*)?$/
// The first requested spec that is not additive-only, or undefined when every spec is allowed.
const firstNonAdditiveSpec = (packages: string[]): string | undefined =>
  packages.find((pkg) => !DEFAULT_ADDITIVE_SPEC.test(pkg.trim()))

// Installs packages into the global default environments from the trusted main process (spec §3.1/§8).
// The kernel never installs; this is the only install entry point. Python picks up a newly-installed
// package on its next import (sys.path rescan), so needsRestart stays false there. R is different: a
// live R session that already attached a package or a dependency won't see the new install, and
// compiled packages hold DLL/.so handles — so an R install/uninstall returns needsRestart:true and the
// caller surfaces a restart prompt. The kernel is never auto-restarted (that would drop session state).
export async function installPackages(
  req: InstallRequest,
  deps: Partial<InstallDeps> = {}
): Promise<InstallResult> {
  // Every install subprocess inherits the parent env plus the CA-bundle vars (no-op when unset), so a
  // custom corporate CA is trusted by conda/pip/R. Wrapping here keeps every run() call site 2-arg.
  const baseSpawn = deps.spawn ?? defaultSpawn
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...caBundleEnv(deps.caBundle) }
  const run: InstallSpawn = (command, args) => baseSpawn(command, args, spawnEnv, deps.onChild)

  if (req.packages.length === 0) {
    return { ok: false, needsRestart: false, log: '', error: 'No packages requested.' }
  }

  // Universal anti-injection guard (ALL envs, install and uninstall). `req.packages` is agent-supplied
  // and gets appended verbatim to pip / micromamba / R argv, so a token that starts with `-` could
  // smuggle an OPTION (`--index-url http://evil`, `--target /escape`, `-c http://evil`, `-e git+…`)
  // that bypasses the pinned mirror/CA and the overlay containment. No legitimate package specifier
  // begins with `-` (names, `name==1.2`, `pkg[extra]`, `git+https://…`, wheel URLs all pass), so reject
  // any such token. The default-env additive gate below is stricter still.
  const flagLike = req.packages.find((pkg) => pkg.trim().startsWith('-'))
  if (flagLike) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      error:
        `"${flagLike}" is not a valid package specifier — options/flags cannot be passed as ` +
        `packages. Use the channels / usePip parameters for install options.`
    }
  }

  let envName: string
  try {
    envName = resolveEnvName(req.language, req.environment)
  } catch (error) {
    return { ok: false, needsRestart: false, log: '', error: (error as Error).message }
  }

  const storageRoot =
    deps.storageRoot ??
    process.env.OPEN_SCIENCE_STORAGE_ROOT ??
    join(homedir(), PROD_SESSION_DIR_NAME)
  const root = runtimeRoot(storageRoot)
  const channels = condaInstallChannels(deps.condaChannel ?? DEFAULT_CONDA_CHANNEL, req.channels)
  const prefix = envPrefix(root, envName)
  // micromamba install/remove extract into and mutate the SHARED pkgs cache (<root>/runtime/pkgs), so
  // they must hold the shared cache lock — otherwise a concurrent corrupt-cache repair (which takes the
  // cache EXCLUSIVE and removes incomplete extractions) could delete a package dir mid-install. pip and
  // CRAN write only into the env prefix, so they use `run` directly, unlocked. Keyed by `root` — the
  // same key materialize/create/upgrade use — so every cache writer serializes against repair.
  const runConda: InstallSpawn = (command, args) =>
    withSharedCacheLock(root, () => run(command, args))

  // External (BYO) runtime: install with the selected interpreter's OWN pip — never the bundled
  // micromamba against a foreign env, and never the app-managed prefix. Handled FIRST (above the
  // named-env existence check, which is about managed prefixes and would wrongly reject an external
  // interpreter) and only for installs — external uninstall is disabled and would fall through to the
  // managed uninstall path, so it is refused here as defense-in-depth even though the caller also gates
  // it upstream.
  if (deps.interpreter) {
    if (req.operation === 'uninstall') {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error: 'Uninstalling from an external environment is not supported.'
      }
    }
    const { command, args = [] } = deps.interpreter
    const pipArgs = [
      ...args,
      '-m',
      'pip',
      'install',
      ...(deps.pypiIndex ? ['-i', deps.pypiIndex] : []),
      ...req.packages
    ]
    const result = await run(command, pipArgs)
    return {
      ok: result.code === 0,
      needsRestart: false,
      log: mergeLog(result),
      method: 'pip',
      error: result.code === 0 ? undefined : 'pip install failed.'
    }
  }

  // Only named (non-default) envs are gated on existence — default envs' readiness is handled
  // upstream by the provisioner, and installs into them must proceed exactly as before.
  const isDefaultEnv = envName === DEFAULT_PY_ENV || envName === DEFAULT_R_ENV
  if (!isDefaultEnv) {
    const pathExists = deps.pathExists ?? existsSync
    const exists =
      req.language === 'python'
        ? pathExists(pythonBin(prefix))
        : pathExists(rBin(prefix)) || pathExists(rScriptBin(prefix))
    if (!exists) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `Environment "${envName}" does not exist. Create it first with ` +
          `manage_environments(action:"create", language:"${req.language}", name:"${envName}").`
      }
    }
  }

  // Managed default-env policy gate (foundation "default-environment restrictions"). deps.interpreter (external/BYO) has
  // already returned above, so reaching here with isDefaultEnv means the app-managed default env: it is
  // additive-only, so uninstall is refused and only bare-name / name==version installs are allowed —
  // the platform-maintained baseline must stay intact. Named/managed-create envs are unrestricted.
  if (isDefaultEnv) {
    if (req.operation === 'uninstall') {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `The default "${envName}" environment is additive-only, so uninstalling is not allowed. ` +
          `Create a dedicated environment with manage_environments(action:"create", language:"${req.language}") ` +
          `if you need to remove or downgrade packages.`
      }
    }
    const bad = firstNonAdditiveSpec(req.packages)
    if (bad) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `The default "${envName}" environment is additive-only: only a bare package name or an ` +
          `exact "name==version" pin is accepted. "${bad}" (a version range, git/URL spec, extras, ` +
          `or flag) is not — create a dedicated environment with manage_environments(action:"create") ` +
          `to install it.`
      }
    }
  }

  if (req.operation === 'uninstall') {
    return uninstallPackages(req, deps, run, runConda, root, prefix)
  }

  if (req.language === 'python') {
    if (req.usePip) {
      const pip = pipBin(prefix)
      const args = ['install', ...(deps.pypiIndex ? ['-i', deps.pypiIndex] : []), ...req.packages]
      const result = await run(pip, args)
      return {
        ok: result.code === 0,
        needsRestart: false,
        log: mergeLog(result),
        method: 'pip',
        prefix,
        error: result.code === 0 ? undefined : 'pip install failed.'
      }
    }

    const mm = deps.micromamba ?? resolveMicromamba()
    if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }
    const argv = installArgv(mm, root, prefix, channels, req.packages, isDefaultEnv)
    const result = await runConda(argv[0], argv.slice(1))
    return {
      ok: result.code === 0,
      needsRestart: false,
      log: mergeLog(result),
      method: 'conda',
      prefix,
      error: result.code === 0 ? undefined : 'conda install failed.'
    }
  }

  // language === 'r': prefer conda, fall back to CRAN install.packages into the env R library.
  // Conda naming is shared with R uninstall via rCondaNames (r-<pkg> / bioconductor-<pkg>).
  const mm = deps.micromamba ?? resolveMicromamba()
  if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }

  const condaPkgs = rCondaNames(req.packages)
  const argv = installArgv(mm, root, prefix, channels, condaPkgs, isDefaultEnv)
  const conda = await runConda(argv[0], argv.slice(1))
  if (conda.code === 0) {
    return { ok: true, needsRestart: true, log: mergeLog(conda), method: 'conda', prefix }
  }

  const cran = deps.cranMirror ?? DEFAULT_CRAN_MIRROR
  const vector = req.packages.map((pkg) => JSON.stringify(pkg)).join(', ')
  // Pin install.packages to the env's own R library with an explicit lib=, rather than letting it write
  // into .libPaths()[1] (which a conda R env can front with the user's global R library). dir.create
  // ensures the lib exists before install; the reported prefix is that exact env-scoped location.
  const rLib = envRLibrary(prefix)
  const script =
    `dir.create(${JSON.stringify(rLib)}, recursive=TRUE, showWarnings=FALSE); ` +
    `install.packages(c(${vector}), lib=${JSON.stringify(rLib)}, repos=${JSON.stringify(cran)})`
  const fallback = await run(rScriptBin(prefix), ['-e', script])
  const ok = fallback.code === 0
  return {
    ok,
    needsRestart: ok,
    log: `${mergeLog(conda)}\n${mergeLog(fallback)}`,
    method: 'cran',
    prefix: rLib,
    error: ok ? undefined : 'conda and CRAN install both failed.'
  }
}

// micromamba remove --root-prefix <root> --prefix <prefix> -y <pkgs...>. Env-scoped removal mirroring
// installArgv's shape (micromamba.ts is out of scope, so the argv is built inline here).
const removeArgv = (mm: string, root: string, prefix: string, pkgs: string[]): string[] => [
  mm,
  'remove',
  '--root-prefix',
  root,
  '--prefix',
  prefix,
  '-y',
  ...pkgs
]

// Removes packages from the SAME per-env prefix installs target, so removal never reaches
// system/global packages. Shares the env-name/prefix resolution and non-existent-env rejection with
// the install path (done by the caller before dispatch). Python removal keeps needsRestart false (a
// dropped module stays importable in memory until restart, the caller's choice); R removal returns
// true, mirroring R install — a live R session holds the removed package's namespace/DLL.
async function uninstallPackages(
  req: InstallRequest,
  deps: Partial<InstallDeps>,
  run: InstallSpawn,
  // Cache-locked spawner for micromamba remove (mutates the shared pkgs cache); pip uninstall stays on
  // `run` (env-prefix only). See the runConda note in installPackages.
  runConda: InstallSpawn,
  root: string,
  prefix: string
): Promise<InstallResult> {
  if (req.language === 'python') {
    if (req.usePip) {
      const pip = pipBin(prefix)
      const result = await run(pip, ['uninstall', '-y', ...req.packages])
      return {
        ok: result.code === 0,
        needsRestart: false,
        log: mergeLog(result),
        method: 'pip',
        prefix,
        error: result.code === 0 ? undefined : 'pip uninstall failed.'
      }
    }

    const mm = deps.micromamba ?? resolveMicromamba()
    if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }
    const argv = removeArgv(mm, root, prefix, req.packages)
    const result = await runConda(argv[0], argv.slice(1))
    return {
      ok: result.code === 0,
      needsRestart: false,
      log: mergeLog(result),
      method: 'conda',
      prefix,
      error: result.code === 0 ? undefined : 'conda remove failed.'
    }
  }

  // language === 'r': mirror the R install path — attempt a conda/micromamba removal first (a package
  // installed via conda/bioconda must be removed via conda, or the env's conda metadata is left
  // inconsistent), and fall back to remove.packages() only when micromamba reports the package isn't
  // conda-managed (a CRAN-only install.packages() result). Both paths are env-scoped and return
  // needsRestart:true, since a live R session holds a removed package's namespace/DLL.
  const mm = deps.micromamba ?? resolveMicromamba()
  if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }

  const condaPkgs = rCondaNames(req.packages)
  const argv = removeArgv(mm, root, prefix, condaPkgs)
  const conda = await runConda(argv[0], argv.slice(1))
  if (conda.code === 0) {
    return { ok: true, needsRestart: true, log: mergeLog(conda), method: 'conda', prefix }
  }

  // A conda remove that failed for any reason OTHER than the package not being in the env is a real
  // error (e.g. a broken env); surface it rather than masking it with a CRAN attempt.
  const condaLog = mergeLog(conda)
  if (!condaReportsNotManaged(condaLog)) {
    return {
      ok: false,
      needsRestart: false,
      log: condaLog,
      method: 'conda',
      prefix,
      error: 'conda remove failed.'
    }
  }

  // Not conda-managed → CRAN install. remove.packages is pinned to the env's own R library with an
  // explicit lib=, so the removal can never reach the user's global R library that .libPaths() might
  // front. The reported prefix is that exact env-scoped location.
  const vector = req.packages.map((pkg) => JSON.stringify(pkg)).join(', ')
  const rLib = envRLibrary(prefix)
  const script = `remove.packages(c(${vector}), lib=${JSON.stringify(rLib)})`
  const fallback = await run(rScriptBin(prefix), ['-e', script])
  const ok = fallback.code === 0
  return {
    ok,
    needsRestart: ok,
    log: `${condaLog}\n${mergeLog(fallback)}`,
    method: 'cran',
    prefix: rLib,
    error: ok ? undefined : 'R remove.packages failed.'
  }
}
