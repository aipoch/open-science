import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// R prints its version banner to stderr, e.g. "Rscript (R) version 4.4.1 (2024-06-14)" on older
// wrappers or "R scripting front-end version 4.4.1 (2024-06-14)" on newer ones. Match either shape
// (plus a bare "R version 4.4.1") and capture the dotted version so non-R output (Python, a
// shell "command not found") never looks like a valid interpreter.
const R_VERSION_PATTERN =
  /(?:\(R\)\s+version|R scripting front-end version|\bR\s+version)\s+(\d+\.\d+(?:\.\d+)?)/i

// Returns the R version string when `output` is a genuine R banner of R 3.x or 4.x+, else undefined.
// R 2.x is treated as unsupported so the kernel's language features are guaranteed.
export const parseRVersion = (output: string): string | undefined => {
  const match = output.match(R_VERSION_PATTERN)
  if (!match) return undefined
  const major = Number.parseInt(match[1], 10)
  return major >= 3 ? match[1] : undefined
}

// True when `output` reports a supported R version. Named to mirror python-command's isPython3Version.
export const isRVersion = (output: string): boolean => parseRVersion(output) !== undefined

// A resolved Rscript invocation: the executable plus any leading args. Kept structurally identical to
// PythonCommand, but R has no `py`-launcher analogue, so baseArgs is always empty today.
export type RCommand = {
  command: string
  baseArgs: string[]
}

// Rscript candidates. Unlike Python there is a single reliable entry point on every platform: the
// `Rscript` front-end on PATH resolves the real R install on both Unix and Windows (no launcher
// equivalent to Python's `py`), so the list is platform-independent.
const rCandidates = (): RCommand[] => [{ command: 'Rscript', baseArgs: [] }]

export type ResolveRDeps = {
  platform: NodeJS.Platform
  // Returns true when `<command> <baseArgs...> --version` runs and reports a supported R version.
  probe: (candidate: RCommand) => Promise<boolean>
}

// Real `<command> --version` probe. On Windows the check runs through a shell so a shimmed launcher
// still resolves; the version banner is read from both streams because R writes it to stderr.
const defaultProbe =
  (platform: NodeJS.Platform) =>
  async ({ command, baseArgs }: RCommand): Promise<boolean> => {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...baseArgs, '--version'], {
        timeout: 15_000,
        shell: platform === 'win32',
        windowsHide: true
      })

      return isRVersion(`${stdout}\n${stderr}`)
    } catch {
      return false
    }
  }

// Finds the first Rscript that answers `--version` with a supported R version. Environment setup uses
// this optional result to report Notebook R availability without making R a core startup requirement.
export const findRCommand = async (
  deps: Partial<ResolveRDeps> = {}
): Promise<RCommand | undefined> => {
  const platform = deps.platform ?? process.platform
  const probe = deps.probe ?? defaultProbe(platform)

  for (const candidate of rCandidates()) {
    if (await probe(candidate)) return candidate
  }

  return undefined
}

// Runs an arbitrary `Rscript <args>` and returns both streams. Readiness checks below inject a fake so
// tests never spawn a real process; the default targets the `Rscript` on PATH (external-R readiness).
export type RExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

export type RExecDeps = {
  platform?: NodeJS.Platform
  exec?: RExec
}

const defaultRExec =
  (platform: NodeJS.Platform): RExec =>
  async (args) => {
    const { stdout, stderr } = await execFileAsync('Rscript', args, {
      timeout: 15_000,
      shell: platform === 'win32',
      windowsHide: true
    })
    return { stdout, stderr }
  }

// True iff the `jsonlite` package can be resolved. The R kernel loop (resources/notebook/r_loop.R)
// loads jsonlite at startup, so a bare "Rscript found" is not enough for the kernel to run.
export const rHasJsonlite = async (deps: RExecDeps = {}): Promise<boolean> => {
  const exec = deps.exec ?? defaultRExec(deps.platform ?? process.platform)
  try {
    const { stdout } = await exec(['-e', 'cat(requireNamespace("jsonlite", quietly=TRUE))'])
    // requireNamespace() prints exactly "TRUE"/"FALSE" via cat(); anything else is treated as absent.
    return stdout.trim() === 'TRUE'
  } catch {
    return false
  }
}

// Minimal end-to-end check that the kernel's protocol dependency actually loads AND round-trips: load
// jsonlite and emit a tiny object, then confirm it parses back with ok:true. This catches a jsonlite
// that resolves but fails to load (broken install, ABI mismatch) — which requireNamespace alone misses.
export const rKernelProtocolProbe = async (deps: RExecDeps = {}): Promise<boolean> => {
  const exec = deps.exec ?? defaultRExec(deps.platform ?? process.platform)
  try {
    const { stdout } = await exec([
      '-e',
      'suppressMessages(library(jsonlite)); cat(toJSON(list(ok=TRUE), auto_unbox=TRUE))'
    ])
    const parsed = JSON.parse(stdout.trim()) as { ok?: unknown }
    return parsed.ok === true
  } catch {
    return false
  }
}

// External-R readiness result. `detected` means an R interpreter answered; `runnable` additionally
// requires the kernel's dependencies, so a missing jsonlite yields detected:true/runnable:false (not
// "Ready"). `detail` explains any gap for the UI.
export type RReadiness = {
  detected: boolean
  runnable: boolean
  version?: string
  detail?: string
}

export type ProbeRExternalDeps = {
  platform?: NodeJS.Platform
  // Returns the R version when Rscript answers, else undefined. Injected in tests.
  detectVersion?: () => Promise<string | undefined>
  hasJsonlite?: () => Promise<boolean>
  protocolProbe?: () => Promise<boolean>
}

const defaultDetectVersion =
  (platform: NodeJS.Platform) => async (): Promise<string | undefined> => {
    const exec = defaultRExec(platform)
    try {
      const { stdout, stderr } = await exec(['--version'])
      return parseRVersion(`${stdout}\n${stderr}`)
    } catch {
      return undefined
    }
  }

// Composes the detection + kernel-dependency checks into a single readiness verdict. Unlike Python,
// where a responding interpreter is effectively usable, R needs jsonlite present and loadable before
// the kernel loop will run — so this reports detected-but-not-runnable when only the extras are missing.
export const probeRExternal = async (deps: ProbeRExternalDeps = {}): Promise<RReadiness> => {
  const platform = deps.platform ?? process.platform
  const detectVersion = deps.detectVersion ?? defaultDetectVersion(platform)
  const hasJsonlite = deps.hasJsonlite ?? (() => rHasJsonlite({ platform }))
  const protocolProbe = deps.protocolProbe ?? (() => rKernelProtocolProbe({ platform }))

  const version = await detectVersion()
  if (!version) {
    return { detected: false, runnable: false, detail: 'Rscript was not found on PATH.' }
  }
  if (!(await hasJsonlite())) {
    return { detected: true, runnable: false, version, detail: 'jsonlite is not installed.' }
  }
  if (!(await protocolProbe())) {
    return {
      detected: true,
      runnable: false,
      version,
      detail: 'The R kernel protocol dependencies failed to load.'
    }
  }

  return { detected: true, runnable: true, version }
}
