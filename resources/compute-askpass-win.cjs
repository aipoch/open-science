'use strict'

// Windows OpenSSH starts SSH_ASKPASS as an executable and passes the prompt as argv[1]. Running the
// app executable in Electron Node mode makes Node interpret that prompt as its script path, so this
// preload completes the one-shot named-pipe exchange synchronously and exits before script loading.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path')

let descriptor
let response = ''
let password
const buffer = Buffer.allocUnsafe(4096)

try {
  const socketPath = process.env.OPEN_SCIENCE_ASKPASS_SOCKET
  const capability = process.env.OPEN_SCIENCE_ASKPASS_CAPABILITY
  const promptArgument = process.argv[1] || ''
  const prompt = path.isAbsolute(promptArgument)
    ? path.relative(process.cwd(), promptArgument)
    : promptArgument

  if (!socketPath || !capability || !prompt) throw new Error('Missing askpass capability.')

  descriptor = fs.openSync(socketPath, 'r+')
  const request = Buffer.from(JSON.stringify({ capability, prompt }), 'utf8')
  let written = 0
  while (written < request.length) {
    written += fs.writeSync(descriptor, request, written, request.length - written)
  }
  request.fill(0)

  for (;;) {
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, null)
    if (size === 0) break
    response += buffer.subarray(0, size).toString('utf8')
    buffer.fill(0, 0, size)
  }

  const parsed = JSON.parse(response)
  if (typeof parsed.password !== 'string') throw new Error('Password unavailable.')
  password = parsed.password
} catch {
  password = undefined
} finally {
  buffer.fill(0)
  response = ''
  if (descriptor !== undefined) fs.closeSync(descriptor)
}

if (password === undefined) process.exit(1)
fs.writeSync(process.stdout.fd, password)
password = ''
process.exit(0)
