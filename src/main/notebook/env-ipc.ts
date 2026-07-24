import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import { BrowserWindow, ipcMain } from 'electron'

import type { NotebookLanguage } from '../../shared/notebook'
import { createLogger, errorLogFields } from '../logger'
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

const log = createLogger('notebook-env')

type LoggedRuntimeOperation = 'provision' | 'repair'

type RuntimeLogContext = {
  operation: LoggedRuntimeOperation
  language: NotebookLanguage
  root: string
  operationId: string
}

const redactRuntimeLogText = (value: string): string =>
  value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl)
        url.username = ''
        url.password = ''
        url.pathname = url.pathname.replace(
          /\/(t|token|auth|api[_-]?key|secret|password)\/[^/]+/gi,
          '/$1/[redacted]'
        )
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
        url.hash = ''
        return url.toString()
      } catch {
        return rawUrl
      }
    })
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)[^\s,"'&]+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')

const redactRuntimeLogValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactRuntimeLogText(value)
  if (Array.isArray(value)) return value.map(redactRuntimeLogValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactRuntimeLogValue(nested)])
  )
}

const runtimeErrorLogFields = (error: unknown): Record<string, unknown> =>
  redactRuntimeLogValue(errorLogFields(error)) as Record<string, unknown>

const logRuntimeInfo = (message: string, fields: Record<string, unknown>): void => {
  try {
    log.info(message, redactRuntimeLogValue(fields) as Record<string, unknown>)
  } catch {
    // Diagnostics are best-effort and must not interrupt provisioning or progress delivery.
  }
}

const logRuntimeFailure = (context: RuntimeLogContext, startedAt: number, error: unknown): void => {
  try {
    log.error('runtime operation failed', {
      ...runtimeErrorLogFields(error),
      ...context,
      durationMs: Date.now() - startedAt
    })
  } catch {
    // Diagnostics must never replace the provisioning error returned to the renderer.
  }
}

const runLoggedRuntimeOperation = async (
  operation: LoggedRuntimeOperation,
  language: NotebookLanguage,
  root: string,
  run: (onProgress: (progress: ProvisionProgress) => void) => Promise<void>,
  broadcast: (progress: ProvisionProgress) => void
): Promise<void> => {
  const context: RuntimeLogContext = { operation, language, root, operationId: randomUUID() }
  const startedAt = Date.now()
  let lastPhase: string | undefined
  let lastReconnectAttempt: number | undefined
  logRuntimeInfo('runtime operation started', context)

  const onProgress = (progress: ProvisionProgress): void => {
    broadcast(progress)
    const reconnectAttempt =
      progress.download?.phase === 'reconnecting' ? progress.download.attempt : undefined
    const phaseChanged = progress.phase !== lastPhase
    const reconnectChanged =
      reconnectAttempt !== undefined && reconnectAttempt !== lastReconnectAttempt
    lastPhase = progress.phase
    if (reconnectAttempt !== undefined) lastReconnectAttempt = reconnectAttempt
    if (!phaseChanged && !reconnectChanged) return

    logRuntimeInfo('runtime operation progress', {
      ...context,
      phase: progress.phase,
      message: progress.message,
      progress: progress.progress,
      ...(progress.download ? { download: progress.download } : {})
    })
  }

  try {
    await run(onProgress)
    logRuntimeInfo('runtime operation completed', {
      ...context,
      durationMs: Date.now() - startedAt,
      lastPhase
    })
  } catch (error) {
    logRuntimeFailure(context, startedAt, error)
    throw error
  }
}

// A small delegating surface so IPC behavior tests run without Electron wiring.
export type NotebookEnvHandlers = {
  status: () => Promise<ProvisionStatus>
  provision: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
  repair: (lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void) => Promise<void>
  cancel: (language?: NotebookLanguage) => void
}

// The provisioner shares a single `provisioning` flag across python/R (A3 review carry-forward), so
// two concurrent provision/upgrade/repair calls would race that flag. Wraps a RuntimeProvisioner so
// every provisioning-affecting call is chained behind an in-flight promise: a call that arrives while
// one is still running waits for it to settle (success or failure) before starting its own run,
// instead of firing a conflicting run in parallel. `status` passes through unserialized (read-only).
// Brands a serialized wrapper so serializeProvisioner is IDEMPOTENT. The provisioner is wrapped at
// three sites (main/ipc.ts, registerNotebookEnvIpcHandlers, createNotebookEnvHandlers); without this,
// each layer would own a SEPARATE queue + pending map, and a request queued at the OUTERMOST layer
// would not yet exist in an inner layer's pending set — so cancel() routed inward would be dropped as
// "idle" and never reach the provisioner. Collapsing to one wrapper gives one queue and one pending
// map, so cancel(lang) sees the same in-flight state the provision was enqueued into.
const SERIALIZED = Symbol('serializedProvisioner')

export const serializeProvisioner = (provisioner: RuntimeProvisioner): RuntimeProvisioner => {
  // Already serialized (wrapped by an outer call): return as-is so re-wrapping is a no-op and there is
  // exactly one queue + one pending map for the whole chain.
  if ((provisioner as { [SERIALIZED]?: true })[SERIALIZED]) return provisioner

  let inFlight: Promise<void> = Promise.resolve()
  // Per-language COUNT of in-flight provisions (running OR queued behind the chain). A count, not a Set:
  // two same-language requests must both be tracked, or the first to settle would delete the language
  // while the second is still pending and a later cancel would be wrongly dropped as idle. This is the
  // only layer that sees the queue, so it's where "No-op when idle" lives: cancel(lang) forwards only
  // when count>0. Incremented synchronously when a language provision is requested (before it queues),
  // decremented when that run settles.
  const pending = new Map<NotebookLanguage, number>()
  const retain = (language: NotebookLanguage): void => {
    pending.set(language, (pending.get(language) ?? 0) + 1)
  }
  const release = (language: NotebookLanguage): void => {
    const next = (pending.get(language) ?? 0) - 1
    if (next <= 0) pending.delete(language)
    else pending.set(language, next)
  }

  const serialize = (run: () => Promise<void>): Promise<void> => {
    const next = inFlight.then(run, run)
    // Swallow rejections in the chain tracker itself (each caller still awaits `next` and sees the real
    // error) so one failed run doesn't permanently poison the queue for later callers.
    inFlight = next.catch(() => undefined)
    return next
  }

  const serializeLanguage = (
    language: NotebookLanguage,
    run: () => Promise<void>
  ): Promise<void> => {
    retain(language)
    return serialize(() => run().finally(() => release(language)))
  }

  const wrapped: RuntimeProvisioner = {
    status: () => provisioner.status(),
    provisionPython: (onProgress) =>
      serializeLanguage('python', () => provisioner.provisionPython(onProgress)),
    provisionR: (onProgress) => serializeLanguage('r', () => provisioner.provisionR(onProgress)),
    upgradeIfNeeded: (onProgress) => serialize(() => provisioner.upgradeIfNeeded(onProgress)),
    // repair runs per-LANGUAGE (serializeLanguage, not plain serialize) so it bumps the pending count
    // and cancel(lang) — the Cancel button shown during a Reset — actually forwards instead of being
    // dropped as idle. A Reset that can't be cancelled would be a locked, un-abortable state.
    repair: (lang, onProgress, opts) =>
      serializeLanguage(lang, () => provisioner.repair(lang, onProgress, opts)),
    restoreRelocatedEnvs: (onProgress) =>
      serialize(() => provisioner.restoreRelocatedEnvs(onProgress)),
    // cancel is NOT serialized — it must interrupt the in-flight run immediately, not queue behind it.
    // No-op when the language is idle (count 0); otherwise forward so the provisioner aborts a running
    // run or arms a one-shot skip for a queued one. `undefined` (global cancel) always forwards.
    cancel: (language) => {
      if (language !== undefined && (pending.get(language) ?? 0) === 0) return
      provisioner.cancel(language)
    }
  }
  ;(wrapped as { [SERIALIZED]?: true })[SERIALIZED] = true
  return wrapped
}

export const createNotebookEnvHandlers = (
  provisioner: RuntimeProvisioner,
  // Awaited before a UI-triggered provision/repair so recovery's prefix cleanup can't race a rebuild
  // the user just kicked off. Optional so existing behavior tests construct handlers unchanged.
  waitForRecovery?: () => Promise<void>,
  // Throws if the default env for a language is recovery-blocked (an unknown-liveness orphan may still
  // be writing its prefix), so a UI provision/repair refuses instead of materializing over a live env.
  // Checked AFTER waitForRecovery, so the blocked set is populated. Optional for existing tests.
  assertProvisionAllowed?: (language: NotebookLanguage) => void
): NotebookEnvHandlers => {
  const serialized = serializeProvisioner(provisioner)
  const afterRecovery = async (
    language: NotebookLanguage,
    run: () => Promise<void>
  ): Promise<void> => {
    if (waitForRecovery) await waitForRecovery()
    assertProvisionAllowed?.(language)
    await run()
  }
  return {
    // AWAIT recovery before reading status: recovery populates the blocked-prefix set (and hence
    // status.*RecoveryBlocked) asynchronously. A renderer that reads status before recovery settles
    // would see blocked=false and never surface Reset — the startup gate produces no progress event for
    // an already-ready env, so there is no other signal that would later correct it.
    status: async () => {
      if (waitForRecovery) await waitForRecovery()
      return serialized.status()
    },
    provision: (lang, onProgress) =>
      afterRecovery(lang, () =>
        lang === 'r' ? serialized.provisionR(onProgress) : serialized.provisionPython(onProgress)
      ),
    // A UI-triggered repair is the EXPLICIT user recovery / Reset: it awaits recovery for ordering but
    // does NOT assertProvisionAllowed (that would refuse a blocked runtime — the whole point of Reset is
    // to clear the block), and it force-clears the quarantine before rebuilding. Auto/startup repair
    // (runStartupGate) calls the provisioner directly without force and stays gated by the block.
    repair: async (lang, onProgress) => {
      if (waitForRecovery) await waitForRecovery()
      await serialized.repair(lang, onProgress, { force: true })
    },
    cancel: (language) => serialized.cancel(language)
  }
}

// The app-usable gate: on startup, maintain an already-existing managed python env (restore relocated
// envs, upgrade/repair) but do NOT eagerly provision a fresh one — that is detect-only, built lazily
// on first notebook use. R stays lazy. Never throws — a failure leaves the app usable (non-notebook
// features) and is reported via progress/status (spec §6.4).
export const runStartupGate = async (
  provisioner: RuntimeProvisioner,
  root: string,
  broadcast: (p: ProvisionProgress) => void,
  // Awaited BEFORE any prefix-touching maintenance (restore/upgrade/repair) so crash recovery has
  // finished reconciling first. Otherwise recovery could delete a prefix this gate is mid-rebuild on
  // (or vice-versa). Optional: when unset (tests) the gate runs as before.
  waitForRecovery?: () => Promise<void>
): Promise<void> => {
  try {
    // Let crash recovery settle before touching any prefix — its cleanup/verify must not race the
    // restore/upgrade/repair below.
    if (waitForRecovery) await waitForRecovery()
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
  status: () =>
    Promise.resolve({
      pythonReady: false,
      rReady: false,
      version: DEFAULT_ENV_VERSION,
      provisioning: false
    }),
  provision: () => Promise.reject(new Error(RUNTIME_UNAVAILABLE_MESSAGE)),
  repair: () => Promise.reject(new Error(RUNTIME_UNAVAILABLE_MESSAGE)),
  cancel: () => undefined // unavailable backend: no in-flight run to cancel (language ignored)
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
  root: string,
  // Awaited before the startup gate and any UI provision/repair touches a prefix, so crash recovery
  // (kicked off in the caller BEFORE this registration) finishes reconciling first. Optional so the
  // "no provisioner" path and existing tests keep their signatures.
  waitForRecovery?: () => Promise<void>,
  // Throws if the default env for a language is recovery-blocked, so UI provision/repair refuses rather
  // than materializing over a prefix an unknown-liveness orphan may still hold.
  assertProvisionAllowed?: (language: NotebookLanguage) => void
): void => {
  const serialized = provisioner ? serializeProvisioner(provisioner) : undefined
  const handlers = serialized
    ? createNotebookEnvHandlers(serialized, waitForRecovery, assertProvisionAllowed)
    : createUnavailableHandlers()
  ipcMain.handle('notebook-env:status', () => handlers.status())
  ipcMain.handle('notebook-env:provision', (_event, lang: NotebookLanguage) =>
    runLoggedRuntimeOperation(
      'provision',
      lang,
      root,
      (onProgress) => handlers.provision(lang, onProgress),
      (progress) => broadcastNotebookEnvProgress({ ...progress, scope: lang })
    )
  )
  ipcMain.handle('notebook-env:repair', (_event, lang: NotebookLanguage) =>
    runLoggedRuntimeOperation(
      'repair',
      lang,
      root,
      (onProgress) => handlers.repair(lang, onProgress),
      (progress) => broadcastNotebookEnvProgress({ ...progress, scope: lang })
    )
  )
  // Synchronous best-effort abort of an in-flight provision; returns immediately (the aborted run
  // settles on its own and broadcasts its terminal progress).
  ipcMain.handle('notebook-env:cancel', (_event, language?: NotebookLanguage) =>
    handlers.cancel(language)
  )
  if (serialized)
    void runStartupGate(serialized, root, broadcastNotebookEnvProgress, waitForRecovery)
}
