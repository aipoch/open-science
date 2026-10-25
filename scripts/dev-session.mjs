/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { hasDevEntry, inspectDevProcess, signalDevProcess } from './dev-process-identity.mjs'

const sessionRegistration = z.object({
  secret: z.string(),
  sessionId: z.string().uuid(),
  workspaceRoot: z.string(),
  pid: z.number().int().positive()
})
const registration = z.discriminatedUnion('kind', [
  sessionRegistration.extend({ kind: z.literal('desktop') }).strict(),
  sessionRegistration
    .extend({
      kind: z.enum(['spawn', 'backend']),
      buildId: z.string().uuid(),
      configRoot: z.string(),
      generation: z.string().uuid().optional()
    })
    .strict()
])
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A dev-only supervisor. No owner state is persisted and no existing runtime is adopted.
export async function createDevSession({
  root,
  graceMs = 30_000,
  settleMs = 5000,
  inspect = inspectDevProcess,
  log = console.error
}) {
  const workspaceRoot = await realpath(root)
  const sessionId = randomUUID()
  const secret = randomBytes(32).toString('hex')
  const members = new Map()
  const desktops = new Map()
  const sockets = new Set()
  const pending = new Set()
  let stopping
  let admissions = Promise.resolve()
  let closed = false
  const readCleanExit = async (member) => {
    try {
      const receipt = JSON.parse(
        await readFile(join(member.configRoot, 'runtime-exit.json'), 'utf8')
      )
      return (
        receipt.pid === member.pid &&
        receipt.generation === member.generation &&
        receipt.outcome === 'clean'
      )
    } catch {
      return false
    }
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(10_000, () => socket.destroy())
    let buffer = ''
    const receive = (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 8192) return socket.destroy()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.off('data', receive)
      // Spawn and backend notifications can arrive together. Serialize admission so neither
      // can merge against a stale member while OS identity/receipt inspection is awaiting.
      const accept = admissions
        .then(async () => {
          const item = registration.parse(JSON.parse(buffer.slice(0, newline)))
          const supplied = Buffer.from(item.secret)
          if (
            supplied.length !== secret.length ||
            !timingSafeEqual(supplied, Buffer.from(secret)) ||
            item.sessionId !== sessionId ||
            item.workspaceRoot !== workspaceRoot ||
            item.pid === process.pid
          )
            throw new Error('Invalid development backend registration.')
          const identity = await inspect(item.pid)
          if (
            !identity ||
            !hasDevEntry(
              identity,
              item.kind === 'desktop' ? workspaceRoot : join(workspaceRoot, 'out/backend/index.cjs')
            )
          )
            throw new Error('Cannot prove development backend identity.')
          const key = `${item.pid}:${identity.birth}`
          if (item.kind === 'desktop') {
            desktops.set(key, { pid: item.pid, birth: identity.birth, socket })
          } else {
            const previous = members.get(key)
            if (
              previous &&
              (previous.birth !== identity.birth ||
                previous.configRoot !== item.configRoot ||
                previous.buildId !== item.buildId)
            )
              throw new Error('Development backend identity changed during registration.')
            if (item.kind === 'backend' && !item.generation)
              throw new Error('Missing development runtime generation.')
            // Backend registration can beat the desktop's post-spawn registration. Never replace
            // its lifetime connection with the short-lived spawn notification.
            if (!previous || item.kind === 'backend') {
              const member = {
                ...item,
                secret: undefined,
                birth: identity.birth,
                socket
              }
              // The next generation still has not initialized its runtime. Capture the previous
              // generation's receipt before that shared path can be overwritten by its successor.
              for (const old of members.values()) {
                if (
                  old.configRoot === item.configRoot &&
                  old.completedClean === undefined &&
                  (await inspect(old.pid))?.birth !== old.birth
                )
                  old.completedClean = await readCleanExit(old)
              }
              members.set(key, member)
            }
          }
          if (item.kind !== 'desktop') {
            const build = JSON.parse(
              await readFile(join(root, 'out/backend/dev-build.json'), 'utf8')
            )
            if (build.buildId !== item.buildId || build.workspaceRoot !== workspaceRoot)
              throw new Error('Development backend build is no longer current.')
          }
          socket.setTimeout(0)
          // A registration racing teardown is retained for verification but never admitted.
          if (stopping || closed) socket.end('stop\n')
          else socket.write('ready\n')
        })
        .catch(() => {
          // Never log parser input: the registration carries the private session capability.
          log('[dev] Backend registration rejected: invalid process identity, build, or session.')
          socket.destroy()
        })
      admissions = accept
      pending.add(accept)
      void accept.finally(() => pending.delete(accept))
    }
    socket.on('data', receive)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const alive = async (member) => (await inspect(member.pid))?.birth === member.birth
  const waitForMembers = async (deadline) => {
    while (Date.now() < deadline) {
      await Promise.all([...pending])
      if (!(await Promise.all([...members.values()].map(alive))).some(Boolean)) return
      await delay(50)
    }
  }
  const stop = () =>
    (stopping ??= (async () => {
      const deadline = Date.now() + graceMs
      // Stop accepting before awaiting anything. An authenticated in-flight registration is
      // still added above and receives stop, so startup cannot escape the final sweep.
      server.close()
      await Promise.all([...pending])
      for (const desktop of desktops.values()) {
        if (!desktop.socket.destroyed) desktop.socket.write('stop\n')
        else await signalDevProcess(desktop.pid, desktop.birth, 'SIGTERM', inspect)
      }
      // Do not dispose the backend underneath Electron's renderer flush. If Electron exits
      // early after failed preparation, use the remaining shared budget for backend disposal.
      while (Date.now() < deadline) {
        if (!(await Promise.all([...desktops.values()].map(alive))).some(Boolean)) break
        await delay(50)
      }
      for (const member of members.values()) member.socket.write('stop\n')
      await waitForMembers(deadline)
      let clean = true
      for (const desktop of desktops.values()) {
        if (await alive(desktop)) {
          clean = false
          log(
            `[dev] Desktop ${desktop.pid} exceeded shutdown deadline; terminating the verified process.`
          )
          await signalDevProcess(desktop.pid, desktop.birth, 'SIGKILL', inspect)
        }
      }
      for (const member of members.values()) {
        if (await alive(member)) {
          clean = false
          log(
            `[dev] Backend ${member.pid} exceeded shutdown deadline; terminating the verified process.`
          )
          await signalDevProcess(member.pid, member.birth, 'SIGKILL', inspect)
        }
      }
      const settleDeadline = Date.now() + settleMs
      await waitForMembers(settleDeadline)
      while (
        Date.now() < settleDeadline &&
        (await Promise.all([...desktops.values()].map(alive))).some(Boolean)
      )
        await delay(50)
      if ((await Promise.all([...desktops.values()].map(alive))).some(Boolean))
        throw new Error('Development desktop is still running.')
      for (const member of members.values()) {
        if (await alive(member))
          throw new Error(`Development backend ${member.pid} is still running.`)
        // Probe the existing kernel-backed ownership lock without deleting or replacing it.
        const lock = join(member.configRoot, '.open-science-runtime.sqlite')
        const info = await lstat(lock).catch((error) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
          throw new Error('Unsafe runtime lock file during development shutdown verification.')
        if (info) {
          const database = new DatabaseSync(lock)
          try {
            // Kernel process enumeration can stop reporting a dying process slightly before
            // its file locks are released. Verify that release within the same settle budget.
            while (true) {
              try {
                database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK')
                break
              } catch (error) {
                if (![5, 6].includes(error.errcode) || Date.now() >= settleDeadline) throw error
                await delay(50)
              }
            }
          } finally {
            database.close()
          }
        }
        clean &&= member.completedClean ?? (await readCleanExit(member))
      }
      return { clean, stopped: members.size }
    })().finally(() => {
      closed = true
      for (const socket of sockets) socket.destroy()
      server.close()
    }))
  return {
    environment: JSON.stringify({ sessionId, workspaceRoot, secret, port: server.address().port }),
    stop
  }
}
