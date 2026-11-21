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

export async function macQuitHandoff(
  mode: 'watch' | 'reopen',
  version: string,
  args: string[]
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
    const finish = (armed: boolean): void => {
      clearTimeout(timer)
      if (child.connected) child.disconnect()
      child.unref()
      resolve(armed)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 2500)
    child.once('error', () => finish(false))
    child.once('exit', () => finish(false))
    child.once('message', (message) => finish(message === 'armed'))
  })
}
