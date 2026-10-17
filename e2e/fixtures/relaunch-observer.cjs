'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated source Electron process observer. */
const { app } = require('electron')
const { readFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
const capability = process.env.OPEN_SCIENCE_E2E_RELAUNCH_CAPABILITY
if (!root || !/^[a-f0-9-]{36}$/.test(capability || '') || app.isPackaged)
  throw new Error('Relaunch observer requires isolated source Electron.')
let recorded = false
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Executable CommonJS cannot use TypeScript return annotations.
const recordIdentity = () => {
  if (recorded) return
  recorded = true
  appendFileSync(join(root, 'fixture-desktop-pids'), `${process.pid}\n`)
  appendFileSync(
    join(root, 'fixture-desktop-identities.jsonl'),
    JSON.stringify({
      pid: process.pid,
      argv: process.argv,
      configRoot: process.env.OPEN_SCIENCE_CONFIG_ROOT,
      environmentUserData: process.env.OPEN_SCIENCE_USER_DATA,
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      isPackaged: app.isPackaged
    }) + '\n'
  )
}
if (app.isReady()) recordIdentity()
else app.once('ready', recordIdentity)
setInterval(() => {
  try {
    const request = JSON.parse(readFileSync(join(root, 'fixture-quit-pid'), 'utf8'))
    if (request.pid === process.pid && request.capability === capability) app.quit()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}, 100).unref()
