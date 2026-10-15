'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Node shutdown fault injection. */
if (process.versions.electron || !process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT)
  throw new Error('Runtime relaunch fault fixture requires an isolated ordinary Node process.')
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const create = http.createServer
http.createServer = (...args) => {
  const server = create(...args)
  let ownerEndpoint = false
  server.prependListener('request', (request) => {
    if (request.url === '/owner') ownerEndpoint = true
  })
  const close = server.close
  server.close = function (...closeArgs) {
    if (!ownerEndpoint) return Reflect.apply(close, this, closeArgs)
    writeFileSync(
      join(process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT, 'relaunch-control-close-stalled'),
      'stalled'
    )
    // The production Node entry now waits before closing the Desktop transport socket.
    // Keep the actual listening handle alive; the test owns this child and cleans it up.
    return this
  }
  return server
}
