import { statSync } from 'node:fs'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeSelection } from '../../shared/notebook-runtime'
import { findPythonCommand, probeInterpreterVersion, type PythonCommand } from './python-command'
import { probeRExternal } from './r-command'
import type { DetectionResult, EnvironmentAdapter } from './runtime-registry'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix, pythonBin, rScriptBin } from './runtime-paths'

// Concrete adapters behind the Runtime Registry. Detection only (readiness/survey); interpreter
// resolution for execution and package writes is threaded through the executor seam / package plan.
// Everything is dependency-injected so the registry is unit-testable without spawning interpreters.

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// --- Managed (default python/r conda env) ------------------------------------------------------

export type ManagedAdapterDeps = {
  // The app runtime root (<storageRoot>/runtime); read lazily so a data-root switch is picked up.
  runtimeRoot: () => string
  // Optional version probe for a built managed interpreter (kept injectable / off by default so
  // detection stays cheap and synchronous-ish).
  probeVersion?: (bin: string, language: NotebookLanguage) => Promise<string | undefined>
}

export const createManagedAdapter = (deps: ManagedAdapterDeps): EnvironmentAdapter => ({
  source: 'managed',
  async detect(language: NotebookLanguage): Promise<DetectionResult> {
    const prefix = envPrefix(deps.runtimeRoot(), language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV)
    // Report the interpreter the executor actually LAUNCHES: Rscript for R (not `R`), python for
    // Python — so a resolvedInterpreter built from this path spawns the right binary.
    const bin = language === 'r' ? rScriptBin(prefix) : pythonBin(prefix)
    const detected = isFile(bin)
    return {
      detected,
      // A built managed env is runnable by construction: its bundle ships the kernel-protocol deps
      // (incl. R's jsonlite). Not built yet -> not runnable, but downloadable via onboarding/Settings.
      runnable: detected,
      interpreterPath: detected ? bin : undefined,
      version: detected ? await deps.probeVersion?.(bin, language) : undefined,
      detail: detected ? undefined : 'Managed environment is not built yet.'
    }
  }
})

// --- External (the foundation's registered-venv tier: user's own interpreter) ------------------

export type ExternalAdapterDeps = {
  // Probe a Python interpreter — the selected path when given, else auto-detect a system Python.
  probePython: (interpreterPath: string | undefined) => Promise<DetectionResult>
  // Probe R readiness (Rscript + jsonlite + protocol) — path optional.
  probeR: (interpreterPath: string | undefined) => Promise<DetectionResult>
}

export const createExternalAdapter = (deps: ExternalAdapterDeps): EnvironmentAdapter => ({
  source: 'external',
  async detect(
    language: NotebookLanguage,
    selection: RuntimeSelection | undefined
  ): Promise<DetectionResult> {
    const path = selection?.source === 'external' ? selection.interpreterPath : undefined
    return language === 'r' ? deps.probeR(path) : deps.probePython(path)
  }
})

// Default external probes wired to the real detectors (injectable for tests). A selected path is
// VERSION-validated, not just existence-checked — a file that exists but is python2 / not python must
// not report runnable. Auto-detect (no path) uses findPythonCommand and preserves the launcher's
// selection args (e.g. Windows `py -3`). Python's kernel loop needs only the stdlib, so a valid
// Python 3 == runnable; R additionally requires jsonlite + a protocol probe (probeRExternal), so
// "Rscript found" is never enough.
export type DefaultExternalDepsOverrides = {
  probeVersion?: (command: string, args: string[]) => Promise<string | undefined>
  findPython?: () => Promise<PythonCommand | undefined>
}

export const defaultExternalAdapterDeps = (
  overrides: DefaultExternalDepsOverrides = {}
): ExternalAdapterDeps => {
  const probeVersion =
    overrides.probeVersion ?? ((command, args) => probeInterpreterVersion(command, args))
  const findPython = overrides.findPython ?? findPythonCommand
  return {
    probePython: async (interpreterPath) => {
      if (interpreterPath) {
        if (!isFile(interpreterPath)) {
          return {
            detected: false,
            runnable: false,
            detail: 'Interpreter not found at the selected path.'
          }
        }
        const version = await probeVersion(interpreterPath, [])
        return version
          ? { detected: true, runnable: true, interpreterPath, version }
          : {
              detected: true,
              runnable: false,
              interpreterPath,
              detail: 'The selected file is not a runnable Python 3 interpreter.'
            }
      }
      const found = await findPython()
      if (!found) return { detected: false, runnable: false, detail: 'No system Python 3 found.' }
      const version = await probeVersion(found.command, found.baseArgs)
      return {
        detected: true,
        runnable: version !== undefined,
        interpreterPath: found.command,
        interpreterArgs: found.baseArgs,
        version,
        detail: version === undefined ? 'Detected Python did not report a version.' : undefined
      }
    },
    probeR: async () => {
      const r = await probeRExternal()
      return { detected: r.detected, runnable: r.runnable, version: r.version, detail: r.detail }
    }
  }
}
