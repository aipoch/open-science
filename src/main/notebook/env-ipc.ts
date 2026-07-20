import { BrowserWindow, ipcMain } from 'electron'

import type { NotebookLanguage } from '../../shared/notebook'
import {
  planStartupAction,
  type ProvisionProgress,
  type ProvisionStatus,
  type RuntimeProvisioner
} from './provisioner'
// NOTE: DEFAULT_ENV_VERSION is imported into provisioner.ts but not re-exported from it (brief's
// example code imports it `from './provisioner'`, which resolves to `undefined` at runtime under
// vitest's transpile-only mode — a real type error under `tsc` that transpile-only silently allows
// through). Sourcing it from its actual home, runtime-paths.ts, instead of touching provisioner.ts
// (out of this task's scope).
import { DEFAULT_ENV_VERSION, DEFAULT_PY_ENV, envPrefix, readReadyMarker } from './runtime-paths'
import { existsSync } from 'node:fs'

// A small delegating surface so IPC behavior tests run without Electron wiring.
export type NotebookEnvHandlers = {
  status: () => ProvisionStatus
  provision: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
  repair: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
  cancel: () => void
}

// The provisioner shares a single `provisioning` flag across python/R (A3 review carry-forward), so
// two concurrent provision/upgrade/repair calls would race that flag. Wraps a RuntimeProvisioner so
// every provisioning-affecting call is chained behind an in-flight promise: a call that arrives while
// one is still running waits for it to settle (success or failure) before starting its own run,
// instead of firing a conflicting run in parallel. `status` passes through unserialized (read-only).
export const serializeProvisioner = (provisioner: RuntimeProvisioner): RuntimeProvisioner => {
  let inFlight: Promise<void> = Promise.resolve()

  const serialize = (run: () => Promise<void>): Promise<void> => {
    const next = inFlight.then(run, run)
    // Swallow rejections in the chain tracker itself (each caller still awaits `next` and sees the real
    // error) so one failed run doesn't permanently poison the queue for later callers.
    inFlight = next.catch(() => undefined)
    return next
  }

  return {
    status: () => provisioner.status(),
    provisionPython: (onProgress) => serialize(() => provisioner.provisionPython(onProgress)),
    provisionR: (onProgress) => serialize(() => provisioner.provisionR(onProgress)),
    upgradeIfNeeded: (onProgress) => serialize(() => provisioner.upgradeIfNeeded(onProgress)),
    repair: (lang, onProgress) => serialize(() => provisioner.repair(lang, onProgress)),
    restoreRelocatedEnvs: (onProgress) =>
      serialize(() => provisioner.restoreRelocatedEnvs(onProgress)),
    // cancel is NOT serialized — it must interrupt the in-flight run immediately, not queue behind it.
    cancel: () => provisioner.cancel()
  }
}

export const createNotebookEnvHandlers = (provisioner: RuntimeProvisioner): NotebookEnvHandlers => {
  const serialized = serializeProvisioner(provisioner)
  return {
    status: () => serialized.status(),
    provision: (lang, onProgress) =>
      lang === 'r' ? serialized.provisionR(onProgress) : serialized.provisionPython(onProgress),
    repair: (lang, onProgress) => serialized.repair(lang, onProgress),
    cancel: () => serialized.cancel()
  }
}

// The app-usable gate: on startup, maintain an already-existing managed python env (restore relocated
// envs, upgrade/repair) but do NOT eagerly provision a fresh one — that is detect-only, built lazily
// on first notebook use. R stays lazy. Never throws — a failure leaves the app usable (non-notebook
// features) and is reported via progress/status (spec §6.4).
export const runStartupGate = async (
  provisioner: RuntimeProvisioner,
  root: string,
  broadcast: (p: ProvisionProgress) => void
): Promise<void> => {
  try {
    // Rebuild any envs a data-root relocation left as offline locks BEFORE planning: a restored
    // default-python stamps the ready marker, so the plan below then reads 'ready' instead of
    // re-provisioning the pristine defaults (which would drop the user's relocated packages).
    await provisioner.restoreRelocatedEnvs(broadcast)

    const action = planStartupAction(root, DEFAULT_ENV_VERSION)
    if (action === 'ready') return
    if (action === 'upgrade') return void (await provisioner.upgradeIfNeeded(broadcast))
    if (action === 'repair') {
      // `needsRepair` also fires from a residual default-r dir with NO Python at all (an R-first user
      // whose lazy R build left default-r behind; provisionR never writes the Python marker). Repair
      // (an eager rebuild) only when Python was genuinely provisioned before — a ready marker exists,
      // or the default-python prefix is on disk (present-but-corrupt). Otherwise this is effectively a
      // first-time Python and must stay detect-only (built lazily on first use).
      const pythonWasProvisioned =
        readReadyMarker(root) !== undefined || existsSync(envPrefix(root, DEFAULT_PY_ENV))
      if (pythonWasProvisioned) {
        return void (await provisioner.repair('python', broadcast))
      }
      return
    }
    // Fresh case: detect-only — do NOT eagerly provision. upgrade/repair above still maintain an
    // already-existing managed env; a first-time env is built lazily on first notebook use
    // (ensureDefaultEnvReady), so there is nothing to provision here.
  } catch (error) {
    broadcast({
      phase: 'error',
      message: `Environment preparation failed: ${(error as Error).message}`,
      progress: 0
    })
  }
}

// Broadcasts a progress event to every live renderer window.
export const broadcastNotebookEnvProgress = (progress: ProvisionProgress): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notebook-env:progress', progress)
  }
}

// Shown when the runtime backend could not be constructed (e.g. micromamba missing — common in dev
// without a staged binary). Actionable so the renderer surfaces a real reason instead of a raw
// "No handler registered" IPC crash.
const RUNTIME_UNAVAILABLE_MESSAGE =
  'The notebook runtime is unavailable: micromamba was not found. In a packaged build it ships with the app; for development, set OPEN_SCIENCE_MICROMAMBA_BIN to a micromamba binary and restart.'

// Handlers used when no provisioner could be built: status reports "not ready, not provisioning" so the
// UI shows an actionable setup state, and provision/repair reject with a clear reason rather than the
// channel being absent entirely (which would surface as a "No handler registered" crash in the renderer).
const createUnavailableHandlers = (): NotebookEnvHandlers => ({
  status: () => ({
    pythonReady: false,
    rReady: false,
    version: DEFAULT_ENV_VERSION,
    provisioning: false
  }),
  provision: () => Promise.reject(new Error(RUNTIME_UNAVAILABLE_MESSAGE)),
  repair: () => Promise.reject(new Error(RUNTIME_UNAVAILABLE_MESSAGE)),
  cancel: () => undefined
})

// Registers the notebook-env IPC surface and kicks off the startup readiness gate. Both the gate and
// the IPC-triggered provision/repair calls share ONE serialized provisioner instance, so a renderer
// calling notebook-env:provision while the startup gate is still running queues behind it instead of
// racing the provisioner's shared `provisioning` flag.
//
// The handlers are ALWAYS registered, even when `provisioner` is undefined (the backend could not be
// built): a missing handler would make every renderer call throw "No handler registered", turning a
// recoverable "runtime not set up" state into a hard crash. With no provisioner we register the
// unavailable stubs and skip the startup gate instead.
export const registerNotebookEnvIpcHandlers = (
  provisioner: RuntimeProvisioner | undefined,
  root: string
): void => {
  const serialized = provisioner ? serializeProvisioner(provisioner) : undefined
  const handlers = serialized ? createNotebookEnvHandlers(serialized) : createUnavailableHandlers()
  ipcMain.handle('notebook-env:status', () => handlers.status())
  ipcMain.handle('notebook-env:provision', (_event, lang: NotebookLanguage) =>
    handlers.provision(lang, broadcastNotebookEnvProgress)
  )
  ipcMain.handle('notebook-env:repair', (_event, lang: NotebookLanguage) =>
    handlers.repair(lang, broadcastNotebookEnvProgress)
  )
  // Synchronous best-effort abort of an in-flight provision; returns immediately (the aborted run
  // settles on its own and broadcasts its terminal progress).
  ipcMain.handle('notebook-env:cancel', () => handlers.cancel())
  if (serialized) void runStartupGate(serialized, root, broadcastNotebookEnvProgress)
}
