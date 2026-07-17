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
import { DEFAULT_ENV_VERSION } from './runtime-paths'

// A small delegating surface so IPC behavior tests run without Electron wiring.
export type NotebookEnvHandlers = {
  status: () => ProvisionStatus
  provision: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
  repair: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
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
      serialize(() => provisioner.restoreRelocatedEnvs(onProgress))
  }
}

export const createNotebookEnvHandlers = (provisioner: RuntimeProvisioner): NotebookEnvHandlers => {
  const serialized = serializeProvisioner(provisioner)
  return {
    status: () => serialized.status(),
    provision: (lang, onProgress) =>
      lang === 'r' ? serialized.provisionR(onProgress) : serialized.provisionPython(onProgress),
    repair: (lang, onProgress) => serialized.repair(lang, onProgress)
  }
}

// The app-usable gate: on startup, drive python readiness (spec §6). python is the gate; R stays
// lazy. Never throws — a failure leaves the app usable (non-notebook features) and is reported via
// progress/status (spec §6.4).
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
    if (action === 'repair') return void (await provisioner.repair('python', broadcast))
    await provisioner.provisionPython(broadcast)
  } catch (error) {
    broadcast({
      phase: 'error',
      message: `Environment preparation failed: ${(error as Error).message}`,
      progress: 0
    })
  }
}

// Broadcasts a progress event to every live renderer window.
const broadcastProgress = (progress: ProvisionProgress): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notebook-env:progress', progress)
  }
}

// Registers the notebook-env IPC surface and kicks off the startup readiness gate. Both the gate and
// the IPC-triggered provision/repair calls share ONE serialized provisioner instance, so a renderer
// calling notebook-env:provision while the startup gate is still running queues behind it instead of
// racing the provisioner's shared `provisioning` flag.
export const registerNotebookEnvIpcHandlers = (
  provisioner: RuntimeProvisioner,
  root: string
): void => {
  const serialized = serializeProvisioner(provisioner)
  const handlers = createNotebookEnvHandlers(serialized)
  ipcMain.handle('notebook-env:status', () => handlers.status())
  ipcMain.handle('notebook-env:provision', (_event, lang: NotebookLanguage) =>
    handlers.provision(lang, broadcastProgress)
  )
  ipcMain.handle('notebook-env:repair', (_event, lang: NotebookLanguage) =>
    handlers.repair(lang, broadcastProgress)
  )
  void runStartupGate(serialized, root, broadcastProgress)
}
