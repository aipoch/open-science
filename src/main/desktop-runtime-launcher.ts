import { runtimeStartupOptionsSchema } from './desktop-runtime-info'
import { DesktopRuntimeStartupError } from './desktop-startup-recovery'
import {
  isRuntimeProcessAlive,
  RuntimeStopError,
  waitForRuntimeStopped
} from './runtime-stop-confirmation'
import {
  defaultLegacyTerminationDeps,
  terminateVerifiedLegacyRuntime,
  type LegacyTerminationDeps
} from './legacy-service-termination'
import { randomUUID } from 'node:crypto'
import {
  backendStartupStatusSchema,
  DesktopBackendStartupError,
  type BackendStartupStatus
} from './backend-startup'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DesktopEndpoint } from './desktop-connection'
import {
  removeCredentialInventory,
  writeCredentialInventory
} from './credential-identity/inventory-handoff'

const ownerSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.string().uuid(),
    pid: z.number().int().positive(),
    host: z.enum(['node', 'electron']),
    port: z.number().int().min(1).max(65535),
    desktop: z
      .object({
        path: z.string().min(1),
        generation: z.string().uuid(),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().min(1)
      })
      .strict()
      .optional()
  })
  .strict()

/** The recorded runtime is alive but already stopping; it must never be adopted. */
export class DesktopRuntimeStoppingError extends Error {
  constructor(
    readonly pid: number,
    readonly generation: string
  ) {
    super('The running Open-Science server is already shutting down.')
    this.name = 'DesktopRuntimeStoppingError'
  }
}

export type DesktopBackendLaunch = { endpoint: DesktopEndpoint; startedProcess?: ChildProcess }

// State files are hints only. Verify the current authenticated generation before attaching; never
// delete a lock, kill a recorded PID or restart a different generation on connection loss.
export async function discoverDesktopBackend(
  configRoot: string,
  version: string,
  terminationDeps?: Partial<LegacyTerminationDeps>
): Promise<DesktopEndpoint | undefined> {
  let owner: z.infer<typeof ownerSchema>
  let token: string
  try {
    owner = ownerSchema.parse(
      JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    )
    token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return undefined
    throw error
  }
  let proof: unknown
  try {
    const response = await fetch(`http://127.0.0.1:${owner.port}/owner`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-open-science-runtime-generation': owner.generation
      },
      signal: AbortSignal.timeout(1500),
      redirect: 'error'
    })
    if (!response.ok) return undefined
    proof = await response.json()
  } catch {
    return undefined
  }
  if (
    !proof ||
    typeof proof !== 'object' ||
    !('generation' in proof) ||
    !('pid' in proof) ||
    proof.generation !== owner.generation ||
    proof.pid !== owner.pid
  )
    return undefined
  if ('stopping' in proof && proof.stopping === true && owner.desktop)
    throw new DesktopRuntimeStoppingError(owner.pid, owner.desktop.generation)
  if (owner.host !== 'node' || !owner.desktop) {
    // An older Electron-hosted (or desktop-less) owner has no startup proof to compare. Stopping it
    // relies on the process identity checks alone; the authenticated owner response above only
    // establishes that the recorded generation and PID are current.
    const recheck = async (): Promise<void> => {
      await discoverDesktopBackend(configRoot, version, terminationDeps)
    }
    throw new DesktopRuntimeStartupError(
      {
        reason: 'legacy-service',
        desktopVersion: version,
        pid: owner.pid,
        canStop: true,
        canRecover: true
      },
      'An older Open-Science app is running. It must be closed before opening this version.',
      () =>
        terminateVerifiedLegacyRuntime(
          {
            configRoot,
            generation: owner.generation,
            pid: owner.pid,
            kind: owner.host === 'electron' ? 'electron' : 'node'
          },
          terminationDeps
        ),
      recheck
    )
  }
  // A service that predates startup-option proofs is legacy even when its version string matches.
  const startup = z
    .object({
      desktopGeneration: z.literal(owner.desktop.generation),
      startupOptions: runtimeStartupOptionsSchema
    })
    .safeParse(proof)
  const startupOptions =
    startup.success && startup.data.startupOptions.configRoot === configRoot
      ? startup.data.startupOptions
      : undefined
  if (owner.desktop.version !== version || !startupOptions) {
    const legacy = !startupOptions
    const issue = {
      reason: legacy ? ('legacy-service' as const) : ('version-mismatch' as const),
      desktopVersion: version,
      runtimeVersion: owner.desktop.version,
      pid: owner.pid,
      canStop: true,
      canRecover: legacy
    }
    throw new DesktopRuntimeStartupError(
      issue,
      'The running Open-Science server has a different version. Stop it explicitly before opening this desktop version.',
      async () => {
        // The service may have exited while its confirmation was open. Confirm the
        // released directory and, for modern services, the exact clean-exit receipt.
        // Never signal a PID read from the state file.
        if (!isRuntimeProcessAlive(owner.pid)) {
          const lease = await waitForRuntimeStopped({
            configRoot,
            generation: owner.desktop!.generation,
            pid: owner.pid,
            requireCleanExit: !legacy
          })
          lease.release()
          return
        }
        // A button may remain open for minutes: authenticate the exact owner again before acting.
        // An unreachable control endpoint is not an identity change; the verified fallback decides.
        let current: { pid?: unknown; generation?: unknown; startupOptions?: unknown } | undefined
        try {
          const response = await fetch(`http://127.0.0.1:${owner.port}/owner`, {
            headers: {
              authorization: `Bearer ${token}`,
              'x-open-science-runtime-generation': owner.generation
            },
            signal: AbortSignal.timeout(1500),
            redirect: 'error'
          })
          current = response.ok ? await response.json() : undefined
        } catch {
          current = undefined
        }
        if (current && (current.pid !== owner.pid || current.generation !== owner.generation))
          throw new DesktopRuntimeStartupError(
            {
              ...issue,
              reason: legacy ? 'legacy-service' : 'startup-recovery-required',
              canStop: false
            },
            'The running server changed. Check again to verify its identity.',
            undefined,
            legacy
              ? async () => {
                  await discoverDesktopBackend(configRoot, version, terminationDeps)
                }
              : undefined
          )
        if (current && JSON.stringify(current.startupOptions) !== JSON.stringify(startupOptions))
          throw new DesktopRuntimeStartupError(
            {
              ...issue,
              reason: legacy ? 'legacy-service' : 'startup-recovery-required',
              canStop: false
            },
            'The server configuration changed. Check again to verify it.',
            undefined,
            legacy
              ? async () => {
                  await discoverDesktopBackend(configRoot, version, terminationDeps)
                }
              : undefined
          )
        const graceful = async (): Promise<void> => {
          if (!current) throw new Error('The server control endpoint is unavailable.')
          // The owner endpoint is distinct from the Web service port. Start Web through its
          // authenticated control endpoint, then bind shutdown to that process's service record.
          const started = await fetch(`http://127.0.0.1:${owner.port}/web/start?port=0`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'x-open-science-runtime-generation': owner.generation
            },
            signal: AbortSignal.timeout(5000),
            redirect: 'error'
          })
          if (!started.ok)
            throw new Error(
              `The server refused the Web control request (HTTP ${started.status}). The verified process fallback decides next.`
            )
          const service = z
            .object({ pid: z.literal(owner.pid), port: z.number().int().min(1).max(65535) })
            .parse(JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8')))
          const stopped = await fetch(`http://127.0.0.1:${service.port}/api/shutdown`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
            redirect: 'error'
          })
          if (!stopped.ok)
            throw new Error(
              `The server did not accept the shutdown request (HTTP ${stopped.status}).`
            )
          await stopped.arrayBuffer()
          const lease = await waitForRuntimeStopped({
            configRoot,
            generation: owner.desktop!.generation,
            pid: owner.pid,
            // Legacy CLI shutdown predates clean-exit receipts. This user-confirmed startup
            // transition waits for process exit and directory release, not installation authority.
            requireCleanExit: !legacy
          })
          lease.release()
        }
        try {
          await graceful()
        } catch (error) {
          // Only a legacy service may be force-stopped: it has no clean-exit receipt to protect.
          if (!legacy) throw error
          await terminateVerifiedLegacyRuntime(
            { configRoot, generation: owner.desktop!.generation, pid: owner.pid },
            terminationDeps
          )
        }
      },
      legacy
        ? async () => {
            await discoverDesktopBackend(configRoot, version, terminationDeps)
          }
        : undefined,
      startupOptions
    )
  }
  return owner.desktop
}

export function desktopBackendPaths(options: {
  applicationPath: string
  resourcesPath: string
  packaged: boolean
}): { command: string; entry: string } {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  return options.packaged
    ? {
        command: join(options.resourcesPath, 'node-runtime', executable),
        entry: join(options.resourcesPath, 'backend', 'out', 'backend', 'index.cjs')
      }
    : {
        command: join(
          options.applicationPath,
          'out',
          'node-runtime',
          `${process.platform}-${process.arch}`,
          executable
        ),
        entry: join(options.applicationPath, 'out', 'backend', 'index.cjs')
      }
}

const OWNERSHIP_RELEASE_WAIT_MS = 20_000
const MAX_OWNERSHIP_RESPAWNS = 2

// A stopping runtime is waited out; if it does not exit, only an identity-verified runtime is stopped.
async function settleStoppingRuntime(
  configRoot: string,
  stopping: DesktopRuntimeStoppingError,
  options: { waitMs: number; terminationDeps?: Partial<LegacyTerminationDeps> }
): Promise<void> {
  try {
    const lease = await waitForRuntimeStopped({
      configRoot,
      generation: stopping.generation,
      pid: stopping.pid,
      requireCleanExit: false,
      timeoutMs: options.waitMs
    })
    lease.release()
  } catch (error) {
    if (!(error instanceof RuntimeStopError)) throw error
    await terminateVerifiedLegacyRuntime(
      { configRoot, generation: stopping.generation, pid: stopping.pid },
      options.terminationDeps
    )
  }
}

async function discoverOrWaitForStop(
  configRoot: string,
  version: string,
  options: { waitMs: number; terminationDeps?: Partial<LegacyTerminationDeps> }
): Promise<DesktopEndpoint | undefined> {
  try {
    return await discoverDesktopBackend(configRoot, version, options.terminationDeps)
  } catch (error) {
    if (!(error instanceof DesktopRuntimeStoppingError)) throw error
    await settleStoppingRuntime(configRoot, error, options)
    return discoverDesktopBackend(configRoot, version, options.terminationDeps)
  }
}

export async function startOrAttachDesktopBackend(options: {
  configRoot: string
  profilePath: string
  version: string
  command: string
  entry: string
  packaged: boolean
  args?: readonly string[]
  credentialInventory?: readonly Buffer[]
  credentialInventoryCapturedAt?: number
  timeoutMs?: number
  // Bounds for waiting out a stopping runtime or a lock still held after exit 75.
  ownershipWaitMs?: number
  terminationDeps?: Partial<LegacyTerminationDeps>
  respawnAttempt?: number
  onStatus?: (status: BackendStartupStatus & { elapsedMs: number }) => void
}): Promise<DesktopBackendLaunch> {
  const wait = {
    waitMs: options.ownershipWaitMs ?? OWNERSHIP_RELEASE_WAIT_MS,
    terminationDeps: options.terminationDeps
  }
  const existing = await discoverOrWaitForStop(options.configRoot, options.version, wait)
  if (existing) return { endpoint: existing }
  await Promise.all([access(options.command), access(options.entry)])
  const logs = join(options.configRoot, 'logs')
  await mkdir(logs, { recursive: true, mode: 0o700 })
  const file = await open(
    join(logs, `desktop-backend-${process.pid}-${Date.now()}.log`),
    'wx',
    0o600
  )
  // The explicit config root must not make Node select a different credential profile.
  const attemptId = randomUUID()
  let credentialInventoryPath: string | undefined
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPEN_SCIENCE_CONFIG_ROOT: options.configRoot,
    OPEN_SCIENCE_USER_DATA: options.profilePath,
    OPEN_SCIENCE_STARTUP_ATTEMPT: attemptId
  }
  // A direct backend/CLI process may inherit a stale handoff path from its parent. Never let a
  // launch without a fresh snapshot read or remove that unrelated file.
  delete env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
  delete env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256
  if (options.credentialInventory) {
    credentialInventoryPath = join(options.configRoot, `.credential-inventory-${attemptId}.json`)
    try {
      env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256 = await writeCredentialInventory({
        path: credentialInventoryPath,
        attemptId,
        configRoot: options.configRoot,
        profilePath: options.profilePath,
        ciphertexts: options.credentialInventory,
        capturedAt: options.credentialInventoryCapturedAt
      })
    } catch (error) {
      await file.close()
      await removeCredentialInventory(credentialInventoryPath)
      throw error
    }
    env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = credentialInventoryPath
  }
  delete env.ELECTRON_RUN_AS_NODE
  let child: ChildProcess
  let failure: Error | undefined
  let status: BackendStartupStatus | undefined
  const startedAt = Date.now()
  const onMessage = (message: unknown): void => {
    const result = backendStartupStatusSchema.safeParse(message)
    if (result.success && result.data.attemptId === attemptId && status?.kind !== 'failed') {
      status = result.data
      try {
        options.onStatus?.({ ...status, elapsedMs: Date.now() - startedAt })
      } catch {
        /* Diagnostics must not change the launch outcome. */
      }
    }
  }
  const onError = (error: Error): void => {
    failure = error
  }
  try {
    child = spawn(
      options.command,
      [
        options.entry,
        ...(!options.packaged ? ['--development'] : []),
        ...(options.args ?? []),
        '--desktop',
        '--serve'
      ],
      {
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', file.fd, file.fd, 'ipc']
      }
    )
    // Spawn errors can fire before the asynchronous descriptor close settles.
    child.on('error', onError)
    child.on('message', onMessage)
  } catch (error) {
    await file.close()
    if (credentialInventoryPath) await removeCredentialInventory(credentialInventoryPath)
    throw error
  }
  await file.close()
  child.unref()
  child.channel?.unref()
  const deadline = startedAt + (options.timeoutMs ?? 60_000)
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure
      if (child.exitCode === 75) {
        // RuntimeOwnershipConflict: another process holds the data directory. Wait for it to either
        // publish a usable endpoint or release the lock, then spawn once more instead of idling.
        const lockHeld = options.terminationDeps?.lockHeld ?? defaultLegacyTerminationDeps.lockHeld
        const releaseDeadline = Date.now() + wait.waitMs
        while (Date.now() < releaseDeadline) {
          const endpoint = await discoverOrWaitForStop(options.configRoot, options.version, wait)
          if (endpoint) return { endpoint }
          if (!lockHeld(options.configRoot)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const attempt = options.respawnAttempt ?? 0
        if (lockHeld(options.configRoot) || attempt >= MAX_OWNERSHIP_RESPAWNS)
          throw new DesktopBackendStartupError(
            `The data folder is still owned by another process (exit 75). See ${logs}.`,
            status?.stage ?? 'bootstrap',
            true,
            logs,
            status
          )
        if (options.credentialInventory !== undefined)
          throw new DesktopBackendStartupError(
            'Credential inventory cannot be reused after an ownership conflict; restart the desktop for a fresh snapshot.',
            status?.stage ?? 'bootstrap',
            true,
            logs,
            status
          )
        return startOrAttachDesktopBackend({ ...options, respawnAttempt: attempt + 1 })
      }
      if (child.signalCode || child.exitCode !== null)
        throw new DesktopBackendStartupError(
          `Node backend exited during startup (${child.signalCode ?? child.exitCode}). See ${logs}.`,
          status?.stage ?? 'bootstrap',
          true,
          logs,
          status
        )
      const endpoint = await discoverOrWaitForStop(options.configRoot, options.version, wait)
      if (endpoint && status?.kind !== 'failed') return { endpoint, startedProcess: child }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new DesktopBackendStartupError(
      `Node backend startup timed out. See ${logs}. A surviving server is not terminated automatically.`,
      status?.stage ?? 'bootstrap',
      false,
      logs,
      status
    )
  } finally {
    child.off('message', onMessage)
    if (child.connected) child.disconnect()
    child.off('error', onError)
    if (credentialInventoryPath) await removeCredentialInventory(credentialInventoryPath)
  }
}
