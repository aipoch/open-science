'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit source E2E preload. */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
if (!root) throw new Error('The Node runtime fixture requires an isolated source E2E profile.')
if (process.versions.electron) {
  if (require('electron').app.isPackaged) throw new Error('Source fixture cannot run packaged.')
  // Playwright consumes NODE_OPTIONS on Electron launch. Propagate to the ordinary child explicitly.
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(__filename)}`
} else {
  if (process.platform === 'darwin') require('./mock-node-credentials.cjs')
  const undici = require('undici')
  const fetch = undici.fetch
  undici.fetch = (input, init) => {
    let origin
    try {
      origin = readFileSync(join(root, 'e2e-marketplace-origin'), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!origin) return fetch(input, init)
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Invalid E2E route.')
    const url = String(input)
    return fetch(url.startsWith(origin + '/') ? url : `${origin}/${encodeURIComponent(url)}`, init)
  }
}
