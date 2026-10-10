import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DesktopEndpoint } from './desktop-connection'

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

export type DesktopBackendLaunch = { endpoint: DesktopEndpoint; startedProcess?: ChildProcess }

// State files are hints only. Verify the current authenticated generation before attaching; never
// delete a lock, kill a recorded PID or restart a different generation on connection loss.
export async function discoverDesktopBackend(
  configRoot: string,
  version: string
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
  if (owner.host !== 'node' || !owner.desktop)
    throw new Error(
      'An older desktop runtime owns this data folder. Quit that application before opening this version.'
    )
  if (owner.desktop.version !== version)
    throw new Error(
      'The running Open-Science server has a different version. Stop it explicitly before opening this desktop version.'
    )
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

export async function startOrAttachDesktopBackend(options: {
  configRoot: string
  profilePath: string
  version: string
  command: string
  entry: string
  packaged: boolean
  args?: readonly string[]
  timeoutMs?: number
}): Promise<DesktopBackendLaunch> {
  const existing = await discoverDesktopBackend(options.configRoot, options.version)
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPEN_SCIENCE_CONFIG_ROOT: options.configRoot,
    OPEN_SCIENCE_USER_DATA: options.profilePath
  }
  delete env.ELECTRON_RUN_AS_NODE
  let child: ChildProcess
  let failure: Error | undefined
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
        stdio: ['ignore', file.fd, file.fd]
      }
    )
    // Spawn errors can fire before the asynchronous descriptor close settles.
    child.on('error', onError)
  } finally {
    await file.close()
  }
  child.unref()
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure
      if (
        child.signalCode ||
        (child.exitCode !== null && child.exitCode !== 0 && child.exitCode !== 75)
      )
        throw new Error(
          `Node backend exited during startup (${child.signalCode ?? child.exitCode}). See ${logs}.`
        )
      const endpoint = await discoverDesktopBackend(options.configRoot, options.version)
      if (endpoint) return { endpoint, startedProcess: child }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(
      `Node backend startup timed out. See ${logs}. A surviving server is not terminated automatically.`
    )
  } finally {
    child.off('error', onError)
  }
}
