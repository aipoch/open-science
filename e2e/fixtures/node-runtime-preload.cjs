'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit source E2E preload. */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
if (!root) throw new Error('The Node runtime fixture requires an isolated source E2E profile.')
if (process.versions.electron) {
  if (require('electron').app.isPackaged) throw new Error('Source fixture cannot run packaged.')
  const Module = require('node:module')
  const load = Module._load
  const wrapped = new WeakMap()
  Module._load = function (...args) {
    const exports = Reflect.apply(load, this, args)
    if (typeof exports?.createElectronCloseConfirm === 'function') {
      if (!wrapped.has(exports)) {
        const create = exports.createElectronCloseConfirm
        wrapped.set(exports, {
          ...exports,
          createElectronCloseConfirm: (...options) => {
            globalThis.__openScienceNativeQuitFixture = {
              confirm: create(() => undefined, options[1], options[2]),
              translate: options[2]
            }
            return create(...options)
          }
        })
      }
      return wrapped.get(exports)
    }
    return exports
  }
  // Playwright consumes NODE_OPTIONS on Electron launch. Propagate to the ordinary child explicitly.
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(__filename)}`
} else {
  if (process.platform === 'darwin') require('./mock-node-credentials.cjs')
  const fs = require('node:fs/promises')
  const statfs = fs.statfs
  fs.statfs = async (...args) => {
    const stats = await statfs(...args)
    let available
    try {
      available = Number(readFileSync(join(root, 'e2e-available-disk-bytes'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return stats
    }
    if (!Number.isSafeInteger(available) || available < 0)
      throw new Error('Invalid E2E disk budget.')
    stats.bavail = typeof stats.bavail === 'bigint' ? BigInt(available) : available
    stats.bsize = typeof stats.bsize === 'bigint' ? 1n : 1
    return stats
  }
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
