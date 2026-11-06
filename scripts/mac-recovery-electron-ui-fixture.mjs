/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { cleanupOwnedFixture } from './fixtures/mac-recovery-entry/cleanup-owned.mjs'

const require = createRequire(import.meta.url)
const { createWrapper } = require('../build/mac-recovery-package.cjs')
const native = require('@aipoch/process-tree-native')
const project = dirname(dirname(fileURLToPath(import.meta.url)))
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mac-recovery-electron-ui-')))
const runtime = join(root, 'source/Electron.app')
const wrapper = join(root, 'Applications/Open-Science.app')
const runtimeRoot = join(root, 'runtimes')
const stateRoot = join(root, 'installations')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const installed = join(runtimeRoot, hash(wrapper), 'Open-Science.app')
const state = join(stateRoot, hash(installed))
const owned = new Map()
const run = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' })
const evidence = { root, wrapper, runtime: installed, profiles: [], dock: undefined }
function retain(pid) {
  const identity = native.getDarwinProcess(pid)
  if (!identity) return
  const executablePath = native.getDarwinProcessExecutable(pid, identity.uniqueId)
  if (executablePath?.startsWith(root + '/')) owned.set(pid, { identity, executablePath })
}
async function waitFor(path) {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, 'utf8'))
    await pause(25)
  }
  throw new Error(
    `Electron UI proof did not arrive; events=${fs.existsSync(join(state, 'mac-runtime-output.log')) ? fs.readFileSync(join(state, 'mac-runtime-output.log'), 'utf8') : 'no runtime output'}`
  )
}
try {
  fs.mkdirSync(dirname(runtime), { recursive: true })
  run('/bin/cp', ['-c', '-R', join(project, 'node_modules/electron/dist/Electron.app'), runtime])
  const info = join(runtime, 'Contents/Info.plist')
  for (const command of [
    `Set :CFBundleIdentifier com.aipoch.fixture.electron.${process.pid}`,
    'Set :CFBundleShortVersionString 1.0.8',
    'Add :LSUIElement bool true'
  ])
    run('/usr/libexec/PlistBuddy', ['-c', command, info])
  const scheme = `open-science-entry-fixture-${process.pid}`
  for (const command of [
    'Add :CFBundleURLTypes array',
    'Add :CFBundleURLTypes:0 dict',
    'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
    `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${scheme}`
  ])
    run('/usr/libexec/PlistBuddy', ['-c', command, info])
  const resources = join(runtime, 'Contents/Resources')
  fs.copyFileSync(join(project, 'build/icon.png'), join(resources, 'fixture-icon.png'))
  const addon = join(
    resources,
    'app.asar.unpacked/node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
  )
  fs.mkdirSync(dirname(addon), { recursive: true })
  fs.copyFileSync(
    join(project, 'packages/process-tree-native/build/Release/process_tree_native.node'),
    addon
  )
  run('/usr/bin/codesign', ['--force', '--sign', '-', addon])
  const app = join(resources, 'app')
  fs.mkdirSync(app)
  fs.writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'open-science-ui-fixture', version: '1.0.8', main: 'main.cjs' })
  )
  fs.writeFileSync(
    join(app, 'main.cjs'),
    String.raw`
const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs'); const path = require('node:path')
app.setPath('userData', process.env.OPEN_SCIENCE_USER_DATA)
let window, action = 0, quitCancelled = false; const messages = []
const receipt = process.env.OPEN_SCIENCE_MAC_UI_RECEIPT
function publish() { if (!window) return; fs.writeFileSync(receipt, JSON.stringify({pid:process.pid, ppid:process.ppid, profile:app.getPath('userData'), argv:process.argv, windowVisible:window.isVisible(), menuLabels:Menu.getApplicationMenu().items.map(x=>x.label), action, messages, quitCancelled, dockVisible:app.dock.isVisible()})) }
app.on('before-quit', (event) => {if (process.env.OPEN_SCIENCE_MAC_UI_CANCEL_QUIT === '1' && !fs.existsSync(process.env.OPEN_SCIENCE_MAC_UI_ALLOW_QUIT)) {event.preventDefault();quitCancelled=true;publish()}})
app.on('open-file', (event, file) => {event.preventDefault(); messages.push({kind:'file',value:file}); publish()})
app.on('open-url', (event, url) => {event.preventDefault(); messages.push({kind:'url',value:url}); publish()})
app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Open-Science',submenu:[{role:'quit'}]},{label:'Fixture',submenu:[{id:'fixture-action',label:'Fixture action',accelerator:'CommandOrControl+Shift+K',click(){action++;publish()}}]}]))
  app.dock.setIcon(path.join(process.resourcesPath,'fixture-icon.png'))
  window = new BrowserWindow({width:480,height:260,show:true})
  await window.loadURL('data:text/html,<title>Open-Science entry UI fixture</title><h1>Entry fixture</h1>')
  window.show(); window.focus();
  Menu.getApplicationMenu().getMenuItemById('fixture-action').click()
  publish()
  setTimeout(()=>app.quit(), 20000)
})
`
  )
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', runtime])
  await createWrapper({
    runtime,
    wrapper,
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    identity: '-',
    fixture: true
  })
  for (const profile of ['first', 'second']) {
    const profilePath = join(root, profile)
    const receipt = join(root, `${profile}.json`)
    const settings = {
      OPEN_SCIENCE_MAC_RUNTIME_ROOT: runtimeRoot,
      OPEN_SCIENCE_INSTALLATION_STATE_ROOT: stateRoot,
      OPEN_SCIENCE_USER_DATA: profilePath,
      OPEN_SCIENCE_MAC_UI_RECEIPT: receipt,
      OPEN_SCIENCE_MAC_UI_CANCEL_QUIT: profile === 'first' ? '1' : '0',
      OPEN_SCIENCE_MAC_UI_ALLOW_QUIT: join(root, 'allow-quit'),
      OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NO_DIALOG: '1'
    }
    const args = ['-n', wrapper]
    for (const [key, value] of Object.entries(settings)) args.push('--env', `${key}=${value}`)
    args.push('--args', '--entry-ui-profile', profile)
    run('/usr/bin/open', args)
    const proof = await waitFor(receipt)
    retain(proof.pid)
    retain(proof.ppid)
    assert.equal(proof.profile, profilePath)
    assert.equal(proof.windowVisible, true)
    assert.deepEqual(proof.menuLabels, ['Open-Science', 'Fixture'])
    assert.equal(proof.action, 1)
    assert.equal(proof.dockVisible, false)
    assert.ok(proof.argv.includes(profile))
    evidence.profiles.push(proof)
  }
  assert.notEqual(evidence.profiles[0].pid, evidence.profiles[1].pid)
  const before = fs
    .readFileSync(join(state, 'mac-entry-events.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean).length
  run('/usr/bin/open', [wrapper]) // The same LaunchServices reopen event as an already-running Dock entry.
  await pause(500)
  const after = fs
    .readFileSync(join(state, 'mac-entry-events.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean).length
  assert.equal(after, before)
  evidence.reopenFocusedExistingRuntime = true
  const document = join(root, 'entry-fixture.science')
  fs.writeFileSync(document, 'native file forwarding fixture')
  run('/usr/bin/open', ['-a', wrapper, document])
  const url = `${scheme}://original-entry/document`
  run('/usr/bin/open', ['-a', wrapper, url])
  const forwardDeadline = Date.now() + 5000
  let forwarded = []
  while (Date.now() < forwardDeadline) {
    forwarded = ['first', 'second'].flatMap(
      (profile) => JSON.parse(fs.readFileSync(join(root, `${profile}.json`), 'utf8')).messages
    )
    if (
      forwarded.some(
        (message) => message.kind === 'file' && fs.realpathSync(message.value) === document
      ) &&
      forwarded.some((message) => message.kind === 'url' && message.value === url)
    )
      break
    await pause(25)
  }
  assert.ok(
    forwarded.some(
      (message) => message.kind === 'file' && fs.realpathSync(message.value) === document
    )
  )
  assert.ok(forwarded.some((message) => message.kind === 'url' && message.value === url))
  evidence.forwarded = forwarded
  evidence.dock = JSON.parse(
    run('/usr/bin/swift', [
      join(project, 'scripts/fixtures/mac-recovery-entry/dock-entry-probe.swift'),
      wrapper
    ])
  )
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', wrapper])
  const appControl = join(project, 'scripts/fixtures/mac-recovery-entry/app-control.swift')
  run('/usr/bin/swift', [appControl, wrapper, installed, 'terminate-wrapper'])
  const quitDeadline = Date.now() + 5000
  let cancelled
  while (Date.now() < quitDeadline) {
    cancelled = JSON.parse(fs.readFileSync(join(root, 'first.json'), 'utf8'))
    if (cancelled.quitCancelled) break
    await pause(25)
  }
  assert.equal(cancelled.quitCancelled, true)
  const afterCancelledQuit = JSON.parse(run('/usr/bin/swift', [appControl, wrapper, installed]))
  assert.ok(afterCancelledQuit.some((app) => app.bundlePath === wrapper))
  assert.ok(afterCancelledQuit.some((app) => app.pid === cancelled.pid))
  evidence.quitCancelledPreservedWrapper = afterCancelledQuit
  fs.writeFileSync(join(root, 'allow-quit'), 'yes')
  run('/usr/bin/swift', [appControl, wrapper, installed, 'terminate-wrapper'])
  await pause(800)
  assert.deepEqual(JSON.parse(run('/usr/bin/swift', [appControl, wrapper, installed])), [])
  evidence.acceptedQuitClosedRuntimeAndWrapper = true
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  await cleanupOwnedFixture(root)
  fs.rmSync(root, { recursive: true, force: true })
}
