/* eslint-disable @typescript-eslint/explicit-function-return-type -- Typed by launch-log.d.mts for TypeScript callers. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// Ship the same dependency-free reader with npm and inside Electron's ASAR. Ordinary Node
// can run this source even when it cannot open the launching application's ASAR paths.
const readerSource = `
  const { writeSync } = require('node:fs')
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

/** The caller passes input as both backend descriptors and destroys its own copy after spawn. */
export async function startLaunchLogReader(node, fileDescriptor, serviceLauncher) {
  const args = ['--input-type=commonjs', '-e', readerSource]
  const reader = spawn(serviceLauncher ?? node, serviceLauncher ? [node, ...args] : args, {
    detached: true,
    windowsHide: true,
    // Do not load backend hooks, inspectors or coverage collectors in the reader.
    env: { SystemRoot: process.env.SystemRoot },
    stdio: ['pipe', fileDescriptor, 'ignore']
  })
  await once(reader, 'spawn')
  const closed = new Promise((resolve) => reader.once('close', resolve))
  reader.unref()
  return { input: reader.stdin, closed }
}
