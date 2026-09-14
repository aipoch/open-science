import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type StartupPresenter = {
  update: (phase: string) => void
  focus: () => void
  complete: () => void
  fail: (error: string) => void
}

// Constructed before spawnSync; connects only after the offline worker has committed and handed
// off its disposable UI. No Electron readiness, user profile, logger or database dependency here.
export function prepareStartupPresenter(): {
  environment: string
  attach: () => StartupPresenter
  cleanup: () => void
} {
  const directory = mkdtempSync(join(tmpdir(), 'open-science-startup-'))
  const token = randomBytes(32).toString('hex')
  let socket: Socket | undefined
  let settled = false
  const cleanup = (): void => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Disposable endpoint metadata only; an OS-held temporary file must not break startup.
    }
  }
  return {
    environment: JSON.stringify({ directory, token }),
    cleanup,
    attach() {
      const { port } = JSON.parse(readFileSync(join(directory, 'endpoint.json'), 'utf8'))
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid startup progress endpoint')
      socket = connect(port, '127.0.0.1')
      // The helper owns disconnect diagnostics. Its failure must never become an unhandled
      // socket error or prevent the normal actionable renderer from being revealed.
      socket.on('error', () => socket?.destroy())
      socket.on('close', cleanup)
      socket.resume()
      const send = (command: object): void => {
        if (!settled && socket && !socket.destroyed)
          socket.write(JSON.stringify({ ...command, token }) + '\n')
      }
      send({ type: 'progress', phase: 'startup-runtime' })
      return {
        update: (phase) => send({ type: 'progress', phase }),
        focus: () => send({ type: 'focus' }),
        complete() {
          send({ type: 'complete' })
          settled = true
          socket?.end()
          cleanup()
        },
        fail(error) {
          send({ type: 'failed', error: error.slice(0, 12000) })
          settled = true
          socket?.end()
          cleanup()
        }
      }
    }
  }
}
