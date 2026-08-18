'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require('node:net')

const socket = net.createConnection(process.env.OPEN_SCIENCE_ASKPASS_SOCKET)
let response = ''
socket.setEncoding('utf8')
socket.on('connect', () => {
  socket.end(
    JSON.stringify({
      capability: process.env.OPEN_SCIENCE_ASKPASS_CAPABILITY,
      prompt: process.argv[2] || ''
    })
  )
})
socket.on('data', (chunk) => {
  response += chunk
})
socket.on('end', () => {
  try {
    const parsed = JSON.parse(response)
    if (typeof parsed.password !== 'string') process.exit(1)
    process.stdout.write(parsed.password)
  } catch {
    process.exit(1)
  }
})
socket.on('error', () => process.exit(1))
