/* eslint-disable @typescript-eslint/no-require-imports -- Unpacked Electron helper. */
const { createServer } = require('node:net')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

// Only a private, authenticated loopback control channel. No filesystem or application RPC is
// exposed. TCP avoids Unix socket path-length limits for deeply nested worktrees/TMPDIRs.
exports.openStartupChannel = async ({ directory, token }, callbacks) => {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid startup channel identity')
  const sockets = new Set()
  let owner
  let closing = false
  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => {
      if (socket !== owner) socket.destroy()
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      sockets.delete(socket)
      if (socket === owner && !closing) callbacks.disconnected()
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 65536) return socket.destroy()
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return socket.destroy()
        }
        if (message?.token !== token || (owner && owner !== socket)) return socket.destroy()
        if (!['progress', 'focus', 'complete', 'failed'].includes(message.type))
          return socket.destroy()
        owner = socket
        socket.setTimeout(0)
        const command = { ...message }
        delete command.token
        callbacks.message(command)
        if (!socket.destroyed) socket.write('{"ack":true}\n')
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  writeFileSync(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: server.address().port, pid: process.pid }),
    {
      mode: 0o600
    }
  )
  return {
    close() {
      closing = true
      for (const socket of sockets) socket.destroy()
      server.close()
    }
  }
}
