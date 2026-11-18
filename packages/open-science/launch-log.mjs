/* eslint-disable @typescript-eslint/explicit-function-return-type -- Typed by launch-log.d.mts for TypeScript callers. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Socket } from 'node:net'

// Ship the same dependency-free reader with npm and inside Electron's ASAR. Ordinary Node
// can run this source even when it cannot open the launching application's ASAR paths.
const readerSource = `
  const { writeSync } = require('node:fs')
  const control = new (require('node:net').Socket)({fd: 3})
  let request = '', lease
  control.setEncoding('utf8')
  control.on('error', () => control.destroy())
  control.on('data', chunk => {
    request += chunk
    if (request.length > 16384) { control.destroy(); return }
    if (!request.includes('\\n')) return
    control.removeAllListeners('data')
    try {
      const {entryPath, bootstrapPath, owner, stateRoot, appImage, appDir} = JSON.parse(request)
      if (appImage && appDir) { process.env.APPIMAGE = appImage; process.env.APPDIR = appDir }
      lease = require(bootstrapPath).protectInstallationStartup(entryPath, owner.configRoot, stateRoot, owner)
      control.end('registered\\n')
    } catch { control.end('failed\\n') }
  })
  // A failed/legacy backend never adopts the control pipe. Keep draining its diagnostics until EOF.
  control.on('end', () => control.destroy())
  process.stdin.on('end', () => { control.destroy(); lease?.release() })
  let remaining = 5 * 1024 * 1024
  process.stdin.on('data', chunk => {
    const length = Math.min(chunk.length, remaining)
    try {
      for (let offset = 0; offset < length;) {
        const written = writeSync(1, chunk, offset, length - offset)
        if (!written) { remaining = 0; break }
        remaining -= written
        offset += written
      }
    } catch {
      remaining = 0
    }
  })
`

/** Pass input/control to the backend, then destroy both launcher copies after spawn. */
export async function startLaunchLogReader(node, fileDescriptor, serviceLauncher) {
  const args = ['--input-type=commonjs', '-e', readerSource]
  const reader = spawn(serviceLauncher ?? node, serviceLauncher ? [node, ...args] : args, {
    detached: true,
    windowsHide: true,
    // Do not load backend hooks, inspectors or coverage collectors in the reader.
    env: { SystemRoot: process.env.SystemRoot },
    stdio: ['pipe', fileDescriptor, 'ignore', 'pipe']
  })
  await once(reader, 'spawn')
  const closed = new Promise((resolve) => reader.once('close', resolve))
  reader.unref()
  return { input: reader.stdin, control: reader.stdio[3], closed }
}

/** Called after registration, before readiness. Only the inherited private pipe conveys authority. */
export async function bindLaunchLogReader({ entryPath, bootstrapPath }) {
  const fd = process.env.OPEN_SCIENCE_LAUNCH_LOG_PIPE
  delete process.env.OPEN_SCIENCE_LAUNCH_LOG_PIPE
  if (fd === undefined) return
  if (fd !== '4') throw new Error('Invalid launch-log control descriptor.')
  const request =
    JSON.stringify({
      entryPath,
      bootstrapPath,
      owner: JSON.parse(process.env.OPEN_SCIENCE_INSTALLATION_OWNER),
      stateRoot: process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT,
      appImage: process.env.APPIMAGE,
      appDir: process.env.APPDIR
    }) + '\n'
  const control = new Socket({ fd: 4 })
  try {
    const registered = new Promise((resolve, reject) => {
      let reply = ''
      control.setEncoding('utf8')
      control.on('data', (chunk) => {
        reply += chunk
        if (reply === 'registered\n') resolve()
        else if (reply.length > 32 || reply.includes('\n'))
          reject(new Error('Launch-log ownership was rejected.'))
      })
      control.once('error', reject)
      control.once('end', () => reject(new Error('Launch-log ownership channel closed.')))
      control.setTimeout(5000, () => reject(new Error('Launch-log ownership timed out.')))
    })
    control.write(request)
    await registered
  } finally {
    control.destroy()
  }
}
