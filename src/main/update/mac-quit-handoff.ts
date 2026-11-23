import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function socketPath(version: string): string {
  const id = createHash('sha256')
    .update(process.execPath)
    .update('\0')
    .update(version)
    .digest('hex')
  return join(tmpdir(), `os-update-${process.getuid!()}`, `${id.slice(0, 20)}.sock`)
}

export const MAC_HANDOFF_ACK_TIMEOUT_MS = 2500

export async function macQuitHandoff(
  mode: 'watch' | 'reopen',
  version: string,
  args: string[],
  launchRequest?: () => Promise<{ args: string[]; urls: string[] }>
): Promise<boolean> {
  const path = socketPath(version)
  if (mode === 'reopen' && !existsSync(path)) return false
  const directory = dirname(path)
  try {
    if (mode === 'watch') mkdirSync(directory, { recursive: true, mode: 0o700 })
    const owner = lstatSync(directory)
    if (!owner.isDirectory() || owner.uid !== process.getuid!() || (owner.mode & 0o077) !== 0)
      return false
  } catch {
    return false
  }
  const child = spawn(
    join(process.resourcesPath, 'node-runtime/node'),
    [
      join(process.resourcesPath, 'mac-quit-handoff.cjs'),
      mode,
      path,
      process.execPath,
      String(process.pid),
      ...args
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  return new Promise((resolve) => {
    let settled = false
    const finish = (armed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.connected) child.disconnect()
      child.unref()
      resolve(armed)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, MAC_HANDOFF_ACK_TIMEOUT_MS)
    child.once('error', () => finish(false))
    child.once('exit', () => finish(false))
    child.once('message', async (message) => {
      if (message !== 'armed' || !launchRequest) return finish(message === 'armed')
      try {
        let previous: string | undefined
        // Re-snapshot after the IPC write to include launches received while it was in flight.
        for (;;) {
          const request = await launchRequest()
          const snapshot = JSON.stringify(request)
          if (snapshot === previous) break
          await new Promise<void>((sent, reject) =>
            child.send(request, (error) => (error ? reject(error) : sent()))
          )
          previous = snapshot
        }
        finish(true)
      } catch {
        finish(false)
      }
    })
  })
}
