'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit source E2E preload. */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
if (!root) throw new Error('The Node runtime fixture requires an isolated source E2E profile.')
if (process.versions.electron) {
  const { app } = require('electron')
  if (app.isPackaged) throw new Error('Source fixture cannot run packaged.')
  if (process.platform === 'linux') {
    // Playwright's Electron loader overrides argv with password-store=basic. Restore the
    // explicitly selected test vault before application credential preflight runs.
    if (!process.argv.includes('--password-store=gnome-libsecret'))
      throw new Error('Linux source fixture requires an explicit Secret Service backend.')
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
  if (process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME === '1') {
    // Electron resolves the Windows home through the OS, ignoring USERPROFILE. Override only
    // this isolated source fixture before application bootstrap can discover user state.
    const { dirname, resolve } = require('node:path')
    const { mkdirSync } = require('node:fs')
    const fixtureHome = join(dirname(root), 'isolated home')
    if (resolve(process.env.USERPROFILE || '') !== resolve(fixtureHome))
      throw new Error('Acceptance home does not match the isolated fixture.')
    mkdirSync(fixtureHome, { recursive: true })
    app.setPath('home', fixtureHome)
    for (const [key, value] of [
      ['appData', process.env.APPDATA],
      ['cache', process.env.LOCALAPPDATA],
      ['downloads', join(fixtureHome, 'Downloads')]
    ]) {
      if (!value || !resolve(value).startsWith(resolve(fixtureHome) + require('node:path').sep))
        throw new Error('Acceptance OS path escaped the isolated home.')
      mkdirSync(value, { recursive: true })
      app.setPath(key, value)
    }
  }
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
  // Relaunched Electron also inherits NODE_OPTIONS before its app API exists. The wrapper
  // skips that early phase without caching this module, so explicit Electron setup still runs.
  const childPreload = join(__dirname, 'node-runtime-child-preload.cjs')
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(childPreload)}`
} else {
  require('./session-outcome-preload.cjs')
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
