import { createConnection } from 'node:net'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const devIdentitySchema = z.object({
  sessionId: z.string().uuid(),
  buildId: z.string().uuid(),
  workspaceRoot: z.string().min(1)
})
export type DevRuntimeIdentity = z.infer<typeof devIdentitySchema>
const sessionSchema = z.object({
  sessionId: z.string().uuid(),
  workspaceRoot: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secret: z.string().regex(/^[a-f0-9]{64}$/)
})
export type DevSession = z.infer<typeof sessionSchema>

// Consume before application code can pass process.env to unrelated subprocesses. Each host
// explicitly forwards the private value only to its backend; release builds discard it.
const inheritedSession = process.env.OPEN_SCIENCE_DEV_SESSION
delete process.env.OPEN_SCIENCE_DEV_SESSION

export function readDevSession(enabled: boolean, value = inheritedSession): DevSession | undefined {
  if (!enabled || !value) return undefined
  try {
    return sessionSchema.parse(JSON.parse(value))
  } catch {
    // Parser errors can quote the input, which contains the private session capability.
    throw new Error('Invalid development runner session metadata.')
  }
}

export async function expectedDevIdentity(
  session: DevSession,
  entry: string
): Promise<DevRuntimeIdentity> {
  const build = devIdentitySchema
    .omit({ sessionId: true })
    .parse(JSON.parse(await readFile(join(dirname(entry), 'dev-build.json'), 'utf8')))
  if (
    build.workspaceRoot !== session.workspaceRoot ||
    (await realpath(entry)) !== join(session.workspaceRoot, 'out/backend/index.cjs')
  )
    throw new Error('The development backend build belongs to a different worktree.')
  return { ...build, sessionId: session.sessionId }
}

export function assertDevRuntimeIdentity(actual: unknown, expected: DevRuntimeIdentity): void {
  const parsed = devIdentitySchema.safeParse(actual)
  if (
    !parsed.success ||
    parsed.data.sessionId !== expected.sessionId ||
    parsed.data.buildId !== expected.buildId ||
    parsed.data.workspaceRoot !== expected.workspaceRoot
  )
    throw new Error(
      'The running backend belongs to another development session or build. Stop its owning command before restarting npm run dev.'
    )
}

/** A runner connection is a lifetime lease, separate from Desktop attachment and startup IPC. */
export async function joinDevSession(options: {
  session: DevSession
  build: { buildId: string; workspaceRoot: string }
  configRoot: string
  generation?: string
  backendPid?: number
  stop(): Promise<void>
}): Promise<{ identity: DevRuntimeIdentity; close(): void }> {
  const { session, build } = options
  if (session.workspaceRoot !== build.workspaceRoot)
    throw new Error('The development backend build belongs to a different worktree.')
  const identity = { ...build, sessionId: session.sessionId }
  const socket = createConnection({ host: '127.0.0.1', port: session.port })
  let intentionalClose = false
  let shutdown: Promise<void> | undefined
  const stop = (): void => {
    if (intentionalClose || shutdown) return
    // Also bound cleanup if the runner itself disappeared. The runner independently observes
    // process death and can escalate a stuck event loop while it is still alive.
    if (!options.backendPid) {
      const deadline = setTimeout(() => process.exit(1), 30_000)
      deadline.unref()
    }
    shutdown = options.stop().catch(() => {
      process.exitCode = 1
    })
    // Keep the deadline until actual process exit: completed disposal can leave active handles.
  }
  socket.on('error', stop)
  socket.on('close', stop)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Development runner registration timed out.'))
    }, 5000)
    let received = ''
    const failed = (): void => {
      clearTimeout(timer)
      reject(new Error('The development runner stopped before backend registration.'))
    }
    socket.once('close', failed)
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          ...identity,
          secret: session.secret,
          kind: options.backendPid ? 'spawn' : 'backend',
          pid: options.backendPid ?? process.pid,
          desktopPid: options.backendPid ? process.pid : undefined,
          configRoot: options.configRoot,
          generation: options.generation
        }) + '\n'
      )
    })
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (received.length > 1024) {
        socket.destroy()
        return
      }
      let newline: number
      while ((newline = received.indexOf('\n')) >= 0) {
        const message = received.slice(0, newline)
        received = received.slice(newline + 1)
        if (message === 'ready') {
          clearTimeout(timer)
          socket.off('close', failed)
          socket.unref()
          resolve()
        } else if (message === 'stop') stop()
        else socket.destroy()
      }
    })
  })
  return {
    identity,
    close() {
      intentionalClose = true
      socket.destroy()
    }
  }
}
