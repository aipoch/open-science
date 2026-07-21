import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { RuntimeSelection } from '../../shared/notebook-runtime'
import { caBundleEnv } from './micromamba'

const execFileAsync = promisify(execFile)

// Overlay venvs live under a `venvs/` sibling of `envs/` so an app-owned overlay for a user's own
// interpreter is namespaced away from the managed conda envs and never collides with an env name.
export const overlayVenvDir = (runtimeRoot: string, slug: string): string =>
  join(runtimeRoot, 'venvs', slug)

// A venv's interpreter layout differs by OS and, on Windows, from a conda prefix: `python -m venv`
// puts python.exe under Scripts\ (not the prefix root). Read the platform at call time so tests can
// mock process.platform.
export const overlayPythonBin = (venvDir: string): string =>
  process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')

// True when the overlay's interpreter is a regular file on disk; tolerate stat errors (missing dir).
export const overlayExists = (venvDir: string): boolean => {
  try {
    return statSync(overlayPythonBin(venvDir)).isFile()
  } catch {
    return false
  }
}

// Injectable subprocess runner so tests can assert the argv without spawning a real interpreter.
export type CreateOverlayDeps = {
  run: (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>
}

// Default runner: create the overlay via the base interpreter's own venv module. windowsHide keeps a
// console window from flashing; 120s covers a cold venv bootstrap (ensurepip) on a slow disk.
const defaultRun = async (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<void> => {
  await execFileAsync(command, args, { timeout: 120_000, windowsHide: true, env })
}

export type OverlayProtocolOptions = {
  pypiIndex?: string
  caBundle?: string
}

const PROTOCOL_PROBE =
  'import json, matplotlib; print(json.dumps({"protocol": 1, "matplotlib": matplotlib.__version__}))'

// The protocol floor for an app-owned BYO overlay. Probe first so an existing overlay can reuse a
// matplotlib supplied by --system-site-packages; only a missing floor invokes pip and writes into the
// overlay. A registered external interpreter (appOwnedOverlay:false) never passes through here.
export const ensureOverlayProtocolFloor = async (
  overlayPython: string,
  deps: CreateOverlayDeps = { run: defaultRun },
  options: OverlayProtocolOptions = {}
): Promise<void> => {
  const env = { ...process.env, ...caBundleEnv(options.caBundle) }
  try {
    await deps.run(overlayPython, ['-c', PROTOCOL_PROBE], env)
  } catch {
    await deps.run(
      overlayPython,
      [
        '-m',
        'pip',
        'install',
        ...(options.pypiIndex ? ['-i', options.pypiIndex] : []),
        'matplotlib'
      ],
      env
    )
    // A zero exit from pip is not sufficient proof that the overlay can run the notebook protocol
    // (broken wheels/import paths can still fail). Persisting a selection is allowed only after the
    // same probe succeeds against the installed result.
    await deps.run(overlayPython, ['-c', PROTOCOL_PROBE], env)
  }
}

export type AppOwnedExternalSelection = Extract<RuntimeSelection, { source: 'external' }> & {
  appOwnedOverlay: true
}

// Fully prepares an app-owned BYO runtime before it may be persisted: create/reuse the isolated
// overlay, establish the Python notebook protocol floor, then return the interpreter that cells use.
export const prepareExternalPythonRuntime = async (
  selection: AppOwnedExternalSelection,
  runtimeRoot: string,
  options: OverlayProtocolOptions = {},
  deps: CreateOverlayDeps = { run: defaultRun }
): Promise<string> => {
  const venvDir = overlayVenvDir(
    runtimeRoot,
    slugForInterpreter(selection.interpreterPath, selection.interpreterArgs)
  )
  const overlayPython = await createOverlayVenv(
    selection.interpreterPath,
    venvDir,
    deps,
    selection.interpreterArgs
  )
  await ensureOverlayProtocolFloor(overlayPython, deps, options)
  return overlayPython
}

// Creates an app-owned overlay venv on top of the user's own interpreter with
// --system-site-packages, so their heavy site packages stay visible while our installs land only in
// the overlay. Idempotent: an existing overlay interpreter short-circuits the subprocess. Returns the
// overlay's python bin either way. `baseArgs` carries any interpreter-selection flags the base needs
// (e.g. the Windows `py` launcher's `-3`), prepended before `-m venv` so a launcher base still works.
export const createOverlayVenv = async (
  baseInterpreter: string,
  venvDir: string,
  deps: CreateOverlayDeps = { run: defaultRun },
  baseArgs: string[] = []
): Promise<string> => {
  if (overlayExists(venvDir)) return overlayPythonBin(venvDir)
  try {
    await deps.run(baseInterpreter, [...baseArgs, '-m', 'venv', '--system-site-packages', venvDir])
  } catch (error) {
    // `python -m venv` creates the interpreter symlink EARLY and bootstraps pip (ensurepip) LAST, so a
    // failed/timed-out build can leave a dir with python but no pip. overlayExists() only checks the
    // interpreter, so a leftover partial would be treated as ready on the next run — cells would run
    // but package installs would fail with a confusing pip-missing error and no way to self-heal.
    // Remove the partial build so the next first-use retries cleanly. (A hard process kill mid-build
    // can't run this; that rare case still needs a manual overlay delete.)
    await rm(venvDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return overlayPythonBin(venvDir)
}

// Deterministic, filesystem-safe slug for an interpreter selection: a short sha256 hex prefix over the
// interpreter path AND its launcher args. The args matter — a bare launcher like `py` selects different
// interpreters by arg (`py -3.11` vs `py -3.12`), so hashing the path alone would collide two distinct
// runtimes onto ONE overlay venv. Hex is inherently path-safe; the same (path, args) always maps to the
// same overlay dir across runs.
export const slugForInterpreter = (interpreterPath: string, args: string[] = []): string =>
  createHash('sha256')
    .update([interpreterPath, ...args].join('\n'))
    .digest('hex')
    .slice(0, 16)
